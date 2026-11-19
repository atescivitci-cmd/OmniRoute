/**
 * The pipeline records a probe's deadline itself.
 *
 * Live, a canary probe of a slow NVIDIA model was aborted at its 45 s deadline and the upstream
 * released, but no usage row was written, so the selector got no failure evidence for it: an
 * abort before any response writes none, and the canary's own write of an explicit row never
 * reached the live database (zero ever written; the pipeline's own writes do). The pipeline now
 * records the failure for a request that carries OmniRoute's provenance tag, which only the
 * canary sets, and for nothing else: a real client that disconnects is not a provider failure.
 *
 * These tests call the chat route directly against a real local HTTP server, so the canary's
 * code is not involved and the real fetch is used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { POST as postChatCompletion } from "@/app/api/v1/chat/completions/route";
import { buildInternalChatRequest } from "@/lib/api/modelTestRunner.ts";
import { createProviderConnection } from "@/lib/db/providers";
import { getDbInstance } from "@/lib/db/core";
import { runWithUsageSource } from "@/lib/usage/usageSourceContext";
import { USAGE_SOURCE_ROUTING_CANARY } from "@/shared/constants/usageSource";

type Shape = "hold-headers" | "json-silent";

async function abortedRequest(shape: Shape, tagged: boolean) {
  const server = http.createServer((_req, res) => {
    if (shape === "hold-headers") return; // never answers
    // A provider that ignores stream:true and sends a JSON body that never arrives.
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `probe-deadline-${shape}-${tagged}`,
    apiKey: `sk-probe-deadline-${shape}-${tagged}-${Date.now()}`,
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
  try {
    setTimeout(() => client.abort(), 800);
    const call = () => postChatCompletion(request);
    const response = await Promise.race([
      (tagged ? runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, call) : call()).then(
        (r) => r,
        (error: unknown) => {
          throw new Error(`the route threw: ${String(error)}`);
        }
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the route never answered")), 6000)
      ),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 600)); // the usage write is not awaited
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
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  }
}

for (const shape of ["hold-headers", "json-silent"] as const) {
  test(`a tagged probe aborted at its deadline (${shape}) leaves exactly one probe_deadline row`, async () => {
    const { status, rows } = await abortedRequest(shape, true);
    assert.equal(status, 499);
    assert.equal(rows.length, 1, `expected one failure row: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].success, 0);
    assert.equal(rows[0].status, "504");
    assert.equal(rows[0].error_code, "probe_deadline");
    assert.equal(rows[0].source, USAGE_SOURCE_ROUTING_CANARY);
  });

  test(`a real client that disconnects (${shape}, no provenance tag) writes no usage row`, async () => {
    const { status, rows } = await abortedRequest(shape, false);
    assert.equal(status, 499);
    assert.deepEqual(rows, [], "a client disconnect is not a provider failure");
  });
}
