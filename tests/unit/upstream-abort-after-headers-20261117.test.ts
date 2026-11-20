/**
 * A caller's abort must still reach the upstream connection after the response has started.
 *
 * Live, a canary probe of a slow NVIDIA model gave up at its 45 s deadline but the upstream
 * connection stayed open for 164 s. Cause: executeWithUpstreamStartTimeout hands the fetch a
 * derived signal and, when the response headers arrived, detached the caller's abort listener
 * from it. After that a client disconnect or a probe deadline could no longer abort the fetch
 * or its body, so a provider that sends its headers and then stays silent held the connection
 * until it finally answered. Stubbed upstreams that error on abort cannot show this; the second
 * half of this file uses a real local HTTP server and the real fetch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getEventListeners } from "node:events";
import { POST as postChatCompletion } from "@/app/api/v1/chat/completions/route";
import { buildInternalChatRequest } from "@/lib/api/modelTestRunner.ts";
import { executeWithUpstreamStartTimeout } from "../../open-sse/handlers/chatCore/upstreamTimeouts.ts";
import { createProviderConnection } from "@/lib/db/providers";
import { getDbInstance } from "@/lib/db/core";
import { createDefaultRoutingEvidenceCanaryDeps } from "@/lib/services/routingEvidenceCanary.ts";

// Load the chat route before anything installs a fetch stub.
await import("@/lib/api/modelTestRunner.ts");

test("after the start succeeds, aborting the caller still aborts the signal the fetch holds", async () => {
  const caller = new AbortController();
  let upstreamSignal: AbortSignal | null = null;
  const result = await executeWithUpstreamStartTimeout({
    executor: {},
    provider: "p",
    model: "m",
    signal: caller.signal,
    abortAfterStart: true,
    execute: async (signal) => {
      upstreamSignal = signal;
      return "response started";
    },
  });
  assert.equal(result, "response started");
  assert.ok(upstreamSignal, "execute received a signal");
  assert.notEqual(upstreamSignal, caller.signal, "a derived signal, so the wrapper is active");
  assert.equal((upstreamSignal as AbortSignal).aborted, false);

  caller.abort(new Error("client gave up"));
  assert.equal(
    (upstreamSignal as AbortSignal).aborted,
    true,
    "the caller's abort must reach the fetch after the response started"
  );
});

test("without abortAfterStart the old behaviour is kept: a later abort does not reach the upstream", async () => {
  // A non-streaming request reads the body itself and still wants the result after the client
  // has gone, so it must not turn a late abort into an error outside the 499 handler.
  const caller = new AbortController();
  let upstreamSignal: AbortSignal | null = null;
  await executeWithUpstreamStartTimeout({
    executor: {},
    provider: "p",
    model: "m",
    signal: caller.signal,
    execute: async (signal) => {
      upstreamSignal = signal;
      return "ok";
    },
  });
  caller.abort();
  assert.equal((upstreamSignal as unknown as AbortSignal).aborted, false);
});

test("listeners on the caller's signal: none left by a failed start or an opt-out, one per attempt otherwise", async () => {
  const countAfter = async (abortAfterStart: boolean, fail: boolean) => {
    const caller = new AbortController();
    for (let attempt = 0; attempt < 12; attempt++) {
      await executeWithUpstreamStartTimeout({
        executor: {},
        provider: "p",
        model: "m",
        signal: caller.signal,
        abortAfterStart,
        execute: async () => {
          if (fail) throw new Error("refused");
          return "ok";
        },
      }).catch(() => undefined);
    }
    return getEventListeners(caller.signal, "abort").length;
  };
  assert.equal(await countAfter(false, false), 0, "opt-out leaves no listener");
  assert.equal(await countAfter(true, true), 0, "a failed start leaves no listener");
  assert.equal(await countAfter(true, false), 12, "one forwarding listener per successful attempt");
});

test("a failed start detaches the caller's listener and leaves nothing to abort", async () => {
  const caller = new AbortController();
  let upstreamSignal: AbortSignal | null = null;
  await assert.rejects(
    executeWithUpstreamStartTimeout({
      executor: {},
      provider: "p",
      model: "m",
      signal: caller.signal,
      execute: async (signal) => {
        upstreamSignal = signal;
        throw new Error("upstream refused");
      },
    }),
    /upstream refused/
  );
  caller.abort();
  assert.equal((upstreamSignal as unknown as AbortSignal).aborted, false);
});

test("an abort before the start still rejects with an abort error", async () => {
  const caller = new AbortController();
  const pending = executeWithUpstreamStartTimeout({
    executor: {},
    provider: "p",
    model: "m",
    signal: caller.signal,
    execute: () => new Promise<string>(() => {}),
  });
  setTimeout(() => caller.abort(), 20);
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
});

type Mode = "hold-headers" | "headers-silent" | "headers-trickle" | "json-silent";

async function runAgainstRealServer(mode: Mode) {
  const startedAt = Date.now();
  let closedAfterMs: number | null = null;
  const server = http.createServer((req, res) => {
    req.on("close", () => {
      if (closedAfterMs === null) closedAfterMs = Date.now() - startedAt;
    });
    if (mode === "hold-headers") return; // never answers
    // json-silent: a provider that ignores stream:true and answers with a plain JSON body that
    // the server reads itself, here a body that never arrives.
    res.writeHead(200, {
      "content-type": mode === "json-silent" ? "application/json" : "text/event-stream",
      "cache-control": "no-cache",
    });
    res.flushHeaders();
    if (mode === "headers-trickle") {
      const timer = setInterval(
        () => res.write('data: {"choices":[{"delta":{"reasoning_content":"t"}}]}\n\n'),
        200
      );
      res.on("close", () => clearInterval(timer));
    }
    // headers-silent: the headers are out and nothing else follows, the way a provider that
    // queues the generation behaves.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `real-net-${mode}`,
    apiKey: `sk-real-net-${mode}-${Date.now()}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
  });
  const connectionId = String(connection.id);
  try {
    const outcome = await createDefaultRoutingEvidenceCanaryDeps().runProbe({
      provider: "openai",
      model: "gpt-4o",
      modelStr: "openai/gpt-4o",
      connectionId,
      prompt: "Routing probe.",
      maxTokens: 64,
      timeoutMs: 1500,
    });
    assert.equal(outcome.ok, false, `${mode}: the probe did not complete`);
    // The server must see its connection closed shortly after the deadline, not when it answers.
    for (let i = 0; i < 40 && closedAfterMs === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const rows = getDbInstance()
      .prepare(
        "SELECT status, success, latency_ms, error_code, source FROM usage_history WHERE connection_id = ? ORDER BY id"
      )
      .all(connectionId) as Array<{
      status: string;
      success: number;
      latency_ms: number;
      error_code: string | null;
      source: string | null;
    }>;
    return { closedAfterMs, rows };
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  }
}

for (const mode of ["hold-headers", "headers-silent", "headers-trickle", "json-silent"] as const) {
  test(`real network, upstream ${mode}: the deadline closes the connection and one failure row is written`, async () => {
    const { closedAfterMs, rows } = await runAgainstRealServer(mode);
    assert.notEqual(closedAfterMs, null, `${mode}: the upstream connection was never closed`);
    assert.ok(
      (closedAfterMs as number) < 4500,
      `${mode}: upstream connection closed after ${closedAfterMs} ms (deadline 1500 ms)`
    );
    assert.equal(
      rows.length,
      1,
      `${mode}: one timeout must leave one row: ${JSON.stringify(rows)}`
    );
    assert.equal(rows[0].success, 0);
    assert.equal(rows[0].source, "routing-canary");
    // Which row it is matters: the probe's own deadline row, or the one the pipeline writes.
    const accepted: Record<Mode, string[]> = {
      "hold-headers": ["probe_deadline"],
      "headers-silent": ["STREAM_READINESS_TIMEOUT", "probe_deadline"],
      // The stream had started, so the pipeline's stream failure path ends it. It used to write a
      // 499 `client_disconnected`, which read as a client leaving (seen live on NVIDIA models);
      // a probe aborted at its own deadline is a provider failure and is recorded as one.
      "headers-trickle": ["probe_deadline"],
      // The server's own read of a JSON body is aborted and ends as a 499, which writes no
      // usage row, so the probe records its own deadline row.
      "json-silent": ["probe_deadline"],
    };
    assert.ok(
      accepted[mode].includes(String(rows[0].error_code)),
      `${mode}: unexpected failure row ${JSON.stringify(rows[0])}`
    );
    assert.ok(
      rows[0].latency_ms < 4500,
      `${mode}: failure row written ${rows[0].latency_ms} ms after dispatch`
    );
  });
}

test("a streaming client that aborts while the server reads a plain JSON body gets a 499, not an error", async () => {
  // A provider that ignores stream:true and answers with a JSON body the server reads itself.
  // That read sits outside the handler that maps an abort to a 499, so with the caller's abort
  // now reaching the upstream body it needs its own mapping. The route's own result is what is
  // checked, because a probe that has given up would swallow an escaped error.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders(); // headers, then no body
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "json-silent-route",
    apiKey: `sk-json-silent-route-${Date.now()}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
  });
  const client = new AbortController();
  const request = buildInternalChatRequest(
    {
      model: "openai/gpt-4o",
      stream: true,
      max_tokens: 16,
      messages: [{ role: "user", content: "Routing probe." }],
    },
    client.signal,
    String(connection.id)
  );
  try {
    setTimeout(() => client.abort(), 1000);
    const outcome = await Promise.race([
      postChatCompletion(request).then(
        (response) => ({ settled: "response" as const, status: response.status }),
        (error: unknown) => ({ settled: "threw" as const, status: String(error) })
      ),
      new Promise<{ settled: "hung"; status: string }>((resolve) =>
        setTimeout(() => resolve({ settled: "hung", status: "" }), 6000)
      ),
    ]);
    assert.deepEqual(
      { settled: outcome.settled, status: outcome.status },
      { settled: "response", status: 499 },
      `the route must end an aborted request as a 499 response, got ${JSON.stringify(outcome)}`
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  }
});
