/**
 * A model attempt that the routing deadline cuts leaves a failure row for that model.
 *
 * Live (Busola route, 17 to 19 Nov): 26 attempts were cut at the 65 s combo deadline. Each left a
 * call-log row ("Request aborted", 499) and NO usage row, so the router's reliability and latency
 * evidence never saw that the model stalled, and the same slow free models kept winning. A request
 * the client itself abandons must stay unrecorded (it is not the provider's failure); one that our
 * own routing deadline aborts is the provider not answering in time and must be recorded against
 * the model, like any other upstream timeout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { POST as postChatCompletion } from "@/app/api/v1/chat/completions/route";
import { createProviderConnection, deleteProviderConnection } from "@/lib/db/providers";
import { createCombo } from "@/lib/db/combos";
import { getDbInstance, resetDbInstance } from "@/lib/db/core";
import { resetAllCircuitBreakers } from "@/shared/utils/circuitBreaker";
import { clearAllModelLockouts } from "@omniroute/open-sse/services/accountFallback.ts";
import {
  createRoutingDeadlineReason,
  routingDeadlineKind,
} from "@omniroute/open-sse/services/combo/routingDeadlineReason.ts";

test.after(() => {
  resetDbInstance();
});

const ROLE_CHUNK =
  'data: {"id":"p","object":"chat.completion.chunk","created":1,"model":"gpt-4o",' +
  '"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n';

type Shape = "hold-headers" | "chunk-then-silent";

async function setup(shape: Shape, comboTimeoutMs: number, model: string) {
  // Each case starts with no breaker or lockout left over from the previous failure.
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  const server = http.createServer((req, res) => {
    req.resume();
    if (shape === "hold-headers") return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.flushHeaders();
    res.write(ROLE_CHUNK);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const stamp = `${shape}-${Date.now()}`;
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `deadline-usage-${stamp}`,
    apiKey: `sk-deadline-usage-${stamp}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
  });
  const comboName = `deadline-usage-${stamp}`;
  await createCombo({
    name: comboName,
    strategy: "auto",
    models: [{ model: `openai/${model}`, provider: "openai" }],
    config: { comboTimeoutMs, deadlineAwareRouting: true },
  });
  const stop = async () => {
    // The next case must not route to this case's closed server.
    await deleteProviderConnection(String(connection.id));
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  };
  return { connectionId: String(connection.id), comboName, stop };
}

function chatRequest(comboName: string, stream: boolean, signal?: AbortSignal) {
  return new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: comboName,
      stream,
      max_tokens: 16,
      messages: [{ role: "user", content: `Routing probe for ${comboName}` }],
    }),
    signal,
  });
}

function modelFailureRows(connectionId: string) {
  return getDbInstance()
    .prepare(
      "SELECT provider, model, status, success, error_code, latency_ms FROM usage_history WHERE connection_id = ? AND success = 0 ORDER BY id"
    )
    .all(connectionId) as Array<{
    provider: string;
    model: string;
    status: string;
    success: number;
    error_code: string | null;
    latency_ms: number | null;
  }>;
}

async function drain(response: Response) {
  try {
    return await response.text();
  } catch {
    /* the stream ends with the deadline */
    return "";
  }
}

// Before any response the deadline row is new. After the first chunk the stream path already wrote
// its own failure row (the client_disconnected finalizer) and is intentionally unchanged: the combo
// deadline can also end a healthy long stream, so it is not relabelled a provider stall.
const ACCEPTED_CODES: Record<Shape, string[]> = {
  "hold-headers": ["routing_deadline", "target_timeout"],
  "chunk-then-silent": ["client_disconnected"],
};
for (const [shape, stream, model] of [
  ["hold-headers", false, "gpt-4o"],
  ["hold-headers", true, "gpt-4o-mini"],
  ["chunk-then-silent", true, "gpt-4.1"],
] as const) {
  test(`a ${stream ? "streaming" : "non-streaming"} attempt cut by the routing deadline (${shape}) leaves one failure row for the model`, async () => {
    const { connectionId, comboName, stop } = await setup(shape, 2500, model);
    try {
      const startedAt = Date.now();
      const response = await postChatCompletion(chatRequest(comboName, stream));
      const text = await drain(response);
      const elapsed = Date.now() - startedAt;
      assert.ok(
        elapsed >= 2000 && elapsed < 9000,
        `the request ended at the routing deadline, not early or late: ${elapsed} ms, status ${response.status}, body ${text.slice(0, 200)}`
      );
      await new Promise((resolve) => setTimeout(resolve, 1200)); // the usage write is not awaited
      const failures = modelFailureRows(connectionId);
      assert.equal(
        failures.length,
        1,
        `expected one model failure row: ${JSON.stringify(failures)}`
      );
      assert.equal(failures[0].provider, "openai");
      assert.equal(failures[0].model, model);
      assert.ok(
        ACCEPTED_CODES[shape].includes(String(failures[0].error_code)),
        `unexpected failure row code: ${JSON.stringify(failures[0])}`
      );
      assert.ok(
        Number(failures[0].latency_ms) >= 2000,
        `the row records how long the attempt stalled: ${JSON.stringify(failures[0])}`
      );
    } finally {
      await stop();
    }
  });
}

test("only a reason the routing deadline created is trusted as a deadline", () => {
  assert.equal(
    routingDeadlineKind(createRoutingDeadlineReason("routing_deadline")),
    "routing_deadline"
  );
  assert.equal(
    routingDeadlineKind(createRoutingDeadlineReason("target_timeout")),
    "target_timeout"
  );
  // A client giving up, or an upstream error that merely reads like a deadline, is not one.
  assert.equal(routingDeadlineKind(new DOMException("Request cancelled", "AbortError")), null);
  assert.equal(routingDeadlineKind(new DOMException("Combo deadline", "TimeoutError")), null);
  assert.equal(routingDeadlineKind(new Error("Combo deadline")), null);
  assert.equal(routingDeadlineKind("Combo deadline"), null);
  assert.equal(routingDeadlineKind(undefined), null);
  assert.equal(routingDeadlineKind(null), null);
});
