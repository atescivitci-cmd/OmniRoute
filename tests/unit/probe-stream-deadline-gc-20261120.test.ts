/**
 * A canary probe that stalls mid-stream is recorded as a probe deadline even after garbage
 * collection has broken the request's abort-signal link.
 *
 * Live, a probe of mistral-large stalled to the 45 s deadline and was written as 499
 * `client_disconnected` (call log "Client disconnected: cancelled"), although the pipeline relabels
 * a tagged probe that was aborted at its deadline (fork PR #37). Every short test passed. The
 * difference is time: the request the pipeline sees follows the probe's abort signal through a
 * weak reference, so after a long stall and some collections it is never marked aborted, and the
 * deadline reaches the pipeline only as the probe cancelling the response body. These tests force
 * collections during the stall, which reproduces the live row, and drive the real canary probe
 * against a real local HTTP server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import v8 from "node:v8";
import vm from "node:vm";
import { POST as postChatCompletion } from "@/app/api/v1/chat/completions/route";
import { buildInternalChatRequest } from "@/lib/api/modelTestRunner.ts";
import { createProviderConnection } from "@/lib/db/providers";
import { getDbInstance, resetDbInstance } from "@/lib/db/core";
import { createDefaultRoutingEvidenceCanaryDeps } from "@/lib/services/routingEvidenceCanary.ts";
import { USAGE_SOURCE_ROUTING_CANARY } from "@/shared/constants/usageSource";

// Forced collections without needing the --expose-gc flag on the runner.
v8.setFlagsFromString("--expose-gc");
const forceGc = vm.runInNewContext("gc") as () => void;

test.after(() => {
  resetDbInstance();
});

const ROLE_CHUNK =
  'data: {"id":"p","object":"chat.completion.chunk","created":1,"model":"gpt-4o",' +
  '"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n';
const REASONING_CHUNK =
  'data: {"id":"p","object":"chat.completion.chunk","created":1,"model":"gpt-4o",' +
  '"choices":[{"index":0,"delta":{"reasoning_content":"t"},"finish_reason":null}]}\n\n';

type Shape = "chunk-then-silent" | "reasoning-trickle";

async function startServer(shape: Shape) {
  const timers: NodeJS.Timeout[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.flushHeaders();
    if (shape === "chunk-then-silent") res.write(ROLE_CHUNK);
    if (shape === "reasoning-trickle") {
      timers.push(setInterval(() => res.write(REASONING_CHUNK), 200));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `probe-gc-${shape}-${Date.now()}`,
    apiKey: `sk-probe-gc-${shape}-${Date.now()}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
  });
  const stop = async () => {
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  };
  return { connectionId: String(connection.id), stop };
}

function usageRows(connectionId: string) {
  return getDbInstance()
    .prepare(
      "SELECT status, success, error_code, source FROM usage_history WHERE connection_id = ? ORDER BY id"
    )
    .all(connectionId) as Array<{
    status: string;
    success: number;
    error_code: string | null;
    source: string | null;
  }>;
}

for (const shape of ["chunk-then-silent", "reasoning-trickle"] as const) {
  test(`a real canary probe stalled mid-stream (${shape}) is a probe_deadline row after collections`, async () => {
    const { connectionId, stop } = await startServer(shape);
    const gcTimer = setInterval(forceGc, 100);
    try {
      const outcome = await createDefaultRoutingEvidenceCanaryDeps().runProbe({
        provider: "openai",
        model: "gpt-4o",
        modelStr: "openai/gpt-4o",
        connectionId,
        prompt: "Routing probe.",
        maxTokens: 64,
        timeoutMs: 6000,
      });
      assert.equal(outcome.ok, false, "the probe did not complete");
      await new Promise((resolve) => setTimeout(resolve, 1200)); // the usage write is not awaited
      const failures = usageRows(connectionId).filter((row) => row.success === 0);
      assert.equal(failures.length, 1, `expected one failure row: ${JSON.stringify(failures)}`);
      assert.equal(failures[0].error_code, "probe_deadline");
      assert.equal(failures[0].status, "504");
      assert.equal(failures[0].source, USAGE_SOURCE_ROUTING_CANARY);
    } finally {
      clearInterval(gcTimer);
      await stop();
    }
  });
}

test("a real client that cancels a started stream (no provenance tag) is still a 499, never a probe_deadline", async () => {
  const { connectionId, stop } = await startServer("chunk-then-silent");
  const gcTimer = setInterval(forceGc, 100);
  try {
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
    const response = await postChatCompletion(request);
    const reader = response.body!.getReader();
    await reader.read(); // the stream has started
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await reader.cancel(); // a consumer leaving with no reason, as the probe does
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const rows = usageRows(connectionId);
    assert.equal(
      rows.filter((row) => row.error_code === "probe_deadline").length,
      0,
      `an untagged consumer must never be labelled a probe deadline: ${JSON.stringify(rows)}`
    );
    assert.equal(
      rows.filter((row) => row.source === USAGE_SOURCE_ROUTING_CANARY).length,
      0,
      "an untagged request must not carry the canary tag"
    );
    const failures = rows.filter((row) => row.success === 0);
    assert.equal(failures.length, 1, `expected one failure row: ${JSON.stringify(rows)}`);
    assert.equal(failures[0].status, "499");
    assert.equal(failures[0].error_code, "client_disconnected");
  } finally {
    clearInterval(gcTimer);
    await stop();
  }
});
