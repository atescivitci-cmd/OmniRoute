/**
 * A probe aborted at its deadline AFTER the stream started is recorded as a probe deadline.
 *
 * Live, after the pipeline-side fix for a probe that never gets headers (PR #35) was installed,
 * canary probes of NVIDIA models were still written as status 499 `client_disconnected` (one at
 * exactly 45 s, the probe deadline). Those are streams that had started: the abort is finalized by
 * the stream failure path, which writes a 499 for any client close. For a request that carries
 * OmniRoute's provenance tag, which only the canary sets, and whose own signal is aborted, the
 * abort is the probe's deadline: a provider reliability failure, not a client leaving.
 *
 * These tests call the chat route directly against a real local HTTP server and the real fetch,
 * as the earlier abort tests do, so the canary's own code is not involved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { POST as postChatCompletion } from "@/app/api/v1/chat/completions/route";
import { buildInternalChatRequest } from "@/lib/api/modelTestRunner.ts";
import { createProviderConnection } from "@/lib/db/providers";
import { getDbInstance, resetDbInstance } from "@/lib/db/core";
import { runWithUsageSource } from "@/lib/usage/usageSourceContext";
import { USAGE_SOURCE_ROUTING_CANARY } from "@/shared/constants/usageSource";

// The route opens the SQLite singleton; release it and its cached state so the runner can exit
// without --test-force-exit (repo rule: DB-backed tests close their handle in test.after).
test.after(() => {
  resetDbInstance();
});

type Shape = "headers-silent" | "chunk-then-silent" | "trickle";

const CHUNK =
  'data: {"id":"probe","object":"chat.completion.chunk","created":1,"model":"gpt-4o",' +
  '"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';

async function abortedStream(shape: Shape, tagged: boolean) {
  const timers: NodeJS.Timeout[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.flushHeaders();
    if (shape === "chunk-then-silent") res.write(CHUNK);
    if (shape === "trickle") {
      res.write(CHUNK);
      timers.push(setInterval(() => res.write(": keep-alive\n\n"), 100));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `probe-stream-deadline-${shape}-${tagged}`,
    apiKey: `sk-probe-stream-deadline-${shape}-${tagged}-${Date.now()}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
  });
  const connectionId = String(connection.id);
  const client = new AbortController();
  const request = buildInternalChatRequest(
    {
      model: "openai/gpt-4o",
      stream: true,
      max_tokens: 16,
      messages: [{ role: "user", content: "Routing probe." }],
    },
    client.signal,
    connectionId
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    setTimeout(() => client.abort(), 900);
    const call = () => postChatCompletion(request);
    const response = await Promise.race([
      tagged ? runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, call) : call(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the route never answered")), 6000)
      ),
    ]);
    // Drain like a client that is still reading when the deadline fires.
    reader = response.body ? response.body.getReader() : null;
    const drain = reader
      ? reader.read().then(
          () => null,
          () => null
        )
      : null;
    await new Promise((resolve) => setTimeout(resolve, 2200)); // abort, then the unawaited write
    await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 500))]);
    const rows = getDbInstance()
      .prepare(
        "SELECT status, success, error_code, source FROM usage_history WHERE connection_id = ?"
      )
      .all(connectionId) as Array<{
      status: string;
      success: number;
      error_code: string | null;
      source: string | null;
    }>;
    return { status: response.status, rows };
  } finally {
    // An unread or half-read response stream keeps the route's timers alive and the runner open.
    await reader?.cancel().catch(() => undefined);
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  }
}

for (const shape of ["headers-silent", "chunk-then-silent", "trickle"] as const) {
  test(`a tagged probe aborted at its deadline mid-stream (${shape}) is a probe_deadline row`, async () => {
    const { status, rows } = await abortedStream(shape, true);
    // With no byte after the headers the route answers with its own 504 instead of a stream; the
    // other shapes had already started streaming.
    if (shape !== "headers-silent") assert.equal(status, 200, "the stream had started");
    const failures = rows.filter((row) => row.success === 0);
    assert.equal(failures.length, 1, `expected one failure row: ${JSON.stringify(rows)}`);
    assert.equal(failures[0].status, "504");
    // With no byte after the headers, the pipeline's own stream readiness timeout can end the
    // request first; that is already a 504 failure row and needs no relabelling.
    const accepted =
      shape === "headers-silent"
        ? ["STREAM_READINESS_TIMEOUT", "probe_deadline"]
        : ["probe_deadline"];
    assert.ok(
      accepted.includes(String(failures[0].error_code)),
      `unexpected failure row ${JSON.stringify(failures[0])}`
    );
    assert.equal(failures[0].source, USAGE_SOURCE_ROUTING_CANARY);
  });

  test(`a real client that leaves mid-stream (${shape}, no provenance tag) is not a probe_deadline`, async () => {
    const { rows } = await abortedStream(shape, false);
    assert.equal(
      rows.filter((row) => row.error_code === "probe_deadline").length,
      0,
      `an untagged request must never be labelled a probe deadline: ${JSON.stringify(rows)}`
    );
    assert.equal(
      rows.filter((row) => row.source === USAGE_SOURCE_ROUTING_CANARY).length,
      0,
      "an untagged request must not carry the canary tag"
    );
    // The untagged path is unchanged: a stream that had started and whose client left is still
    // the pipeline's 499, so the assertions above cannot pass merely because nothing was written.
    if (shape !== "headers-silent") {
      const failures = rows.filter((row) => row.success === 0);
      assert.equal(failures.length, 1, `expected one failure row: ${JSON.stringify(rows)}`);
      assert.equal(failures[0].status, "499");
      assert.equal(failures[0].error_code, "client_disconnected");
    }
  });
}
