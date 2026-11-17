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

type Mode = "hold-headers" | "headers-silent" | "headers-trickle";

async function runAgainstRealServer(mode: Mode) {
  const startedAt = Date.now();
  let closedAfterMs: number | null = null;
  const server = http.createServer((req, res) => {
    req.on("close", () => {
      if (closedAfterMs === null) closedAfterMs = Date.now() - startedAt;
    });
    if (mode === "hold-headers") return; // never answers
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
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

for (const mode of ["hold-headers", "headers-silent", "headers-trickle"] as const) {
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
    assert.ok(
      rows[0].latency_ms < 4500,
      `${mode}: failure row written ${rows[0].latency_ms} ms after dispatch`
    );
  });
}
