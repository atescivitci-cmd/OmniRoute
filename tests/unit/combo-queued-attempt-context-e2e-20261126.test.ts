/**
 * Live 2026-11-26 20:33Z, reproduced through the production request path: concurrent streaming
 * tool requests on ONE account whose local rate limiter queues them. Before the fix, a request
 * queued behind another ran inside the other request's async context (its routing transport
 * attempt): it failed before reaching the upstream with 503 "Routing transport attempt stopped; no
 * automatic transport replay is permitted" (row: routing_transport_replay_blocked), and it poisoned
 * the other request's attempt as well. No real upstream failure row was written, so overload
 * failover and quality-first never saw the model's real 503.
 *
 * Real route (POST /v1/messages) -> handleChat -> combo -> replay guard -> chatCore -> rate limiter
 * -> openai executor -> real fetch, against a local HTTP server. Nothing on the path is mocked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-queued-attempt-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
process.env.STREAM_READINESS_TIMEOUT_MS = "500";

const { POST: postMessages } = await import("../../src/app/api/v1/messages/route.ts");
const { createProviderConnection, deleteProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { createCombo } = await import("../../src/lib/db/combos.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
const rl = await import("../../open-sse/services/rateLimitManager.ts");

const LIVE =
  "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later. (reset after 3s)";

test.after(async () => {
  for (const key of [
    "ROUTING_OVERLOAD_FAILOVER",
    "ROUTING_STALL_DEADLINE_MS",
    "ROUTING_STALL_FAILOVER",
  ])
    delete process.env[key];
  await rl.__resetRateLimitManagerForTests();
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type Behaviour = "overloaded-slow" | "headers-then-silent" | "answer";

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-queued",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

async function setup(stalledBehaviour: Behaviour) {
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (part) => (raw += part));
    req.on("end", () => {
      const model = String(JSON.parse(raw).model || "");
      calls.push(model);
      if (model === "gpt-4o" && stalledBehaviour === "overloaded-slow") {
        // Hold the account's single rate-limit slot a moment so the other requests queue.
        setTimeout(() => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: 503, message: LIVE } }));
        }, 150);
        return;
      }
      if (model === "gpt-4o" && stalledBehaviour === "headers-then-silent") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        res.write(": ping\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk(model, { role: "assistant", content: "" }));
      res.write(chunk(model, { content: `answered by ${model}` }));
      res.write(chunk(model, {}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const make = (suffix: string) =>
    createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: `queued-${stamp}-${suffix}`,
      apiKey: `sk-queued-${stamp}-${suffix}`,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
    });
  const stalledAccount = await make("a");
  const healthyAccount = await make("b");
  // The one account behind the stalled model queues requests one at a time, like the live
  // gemini account's model-scoped limiter.
  rl.enableRateLimitProtection(String(stalledAccount.id));
  rl.refreshConnectionRateLimits(String(stalledAccount.id), { maxConcurrent: 1 });
  const comboName = `queued-combo-${stamp}`;
  await createCombo({
    name: comboName,
    strategy: "priority",
    models: [
      { model: "openai/gpt-4o", provider: "openai", connectionId: String(stalledAccount.id) },
      { model: "openai/gpt-4o-mini", provider: "openai", connectionId: String(healthyAccount.id) },
    ],
    config: { maxRetries: 1 },
  });
  const stop = async () => {
    rl.disableRateLimitProtection(String(stalledAccount.id));
    await deleteProviderConnection(String(stalledAccount.id));
    await deleteProviderConnection(String(healthyAccount.id));
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  };
  return { stalledId: String(stalledAccount.id), comboName, calls, stop };
}

function toolRequest(comboName: string, i: number) {
  return new Request("http://localhost/api/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: comboName,
      stream: true,
      max_tokens: 64,
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      messages: [{ role: "user", content: `queued probe ${i}` }],
    }),
  });
}

async function readAll(response: Response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function rowsFor(connectionId: string) {
  return getDbInstance()
    .prepare("SELECT status, error_code FROM usage_history WHERE connection_id = ? ORDER BY id")
    .all(connectionId) as Array<{ status: string; error_code: string | null }>;
}

test("flags on, 3 concurrent tool requests queued on one overloaded account: every request fails over; rows are upstream_503, never replay_blocked", async () => {
  process.env.ROUTING_OVERLOAD_FAILOVER = "1";
  process.env.ROUTING_STALL_DEADLINE_MS = "120000";
  process.env.ROUTING_STALL_FAILOVER = "1";
  const { stalledId, comboName, calls, stop } = await setup("overloaded-slow");
  try {
    const texts = await Promise.all(
      [0, 1, 2].map(async (i) => readAll(await postMessages(toolRequest(comboName, i))))
    );
    for (const text of texts) {
      assert.match(text, /answered by gpt-4o-mini/, text.slice(0, 300));
      assert.doesNotMatch(text, /Routing transport attempt stopped/);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    const rows = rowsFor(stalledId);
    assert.ok(rows.length >= 1, JSON.stringify(rows));
    assert.ok(
      rows.every((r) => r.status === "503" && r.error_code === "upstream_503"),
      `the model's rows carry its real failure: ${JSON.stringify(rows)}`
    );
    assert.ok(calls.includes("gpt-4o"));
  } finally {
    for (const key of [
      "ROUTING_OVERLOAD_FAILOVER",
      "ROUTING_STALL_DEADLINE_MS",
      "ROUTING_STALL_FAILOVER",
    ])
      delete process.env[key];
    await stop();
  }
});

test("flags off, the same concurrent requests: no request fails with a poisoned transport attempt", async () => {
  const { stalledId, comboName, stop } = await setup("overloaded-slow");
  try {
    const texts = await Promise.all(
      [0, 1, 2].map(async (i) => readAll(await postMessages(toolRequest(comboName, i))))
    );
    // Today's rules for a tool request on a 503: the request stops with the model's error. What
    // must never appear is the other request's transport attempt refusing this one.
    for (const text of texts) {
      assert.doesNotMatch(text, /Routing transport attempt stopped/, text.slice(0, 300));
      assert.match(text, /high demand/, text.slice(0, 300));
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    const rows = rowsFor(stalledId);
    assert.ok(
      rows.every((r) => r.error_code !== "routing_transport_replay_blocked"),
      JSON.stringify(rows)
    );
  } finally {
    await stop();
  }
});

// Headers, then silence past STREAM READINESS while readiness (not the stall deadline) was the
// binding bound of the first-event wait: our own abort with no model output, so it is a
// stall-failover candidate exactly like upstream_stalled. Here readiness is 500 ms and the stall
// deadline 400 ms, so max(readiness, rest of the deadline) is readiness.
for (const failover of [true, false]) {
  test(`readiness-bound first-event stall, stall failover ${failover ? "on: moves on" : "off: stops as today"}`, async () => {
    process.env.ROUTING_STALL_DEADLINE_MS = "400";
    if (failover) process.env.ROUTING_STALL_FAILOVER = "1";
    const { stalledId, comboName, calls, stop } = await setup("headers-then-silent");
    try {
      const text = await readAll(await postMessages(toolRequest(comboName, 9)));
      if (failover) {
        assert.match(text, /answered by gpt-4o-mini/, text.slice(0, 300));
        assert.deepEqual(calls, ["gpt-4o", "gpt-4o-mini"]);
      } else {
        assert.doesNotMatch(text, /answered by/, text.slice(0, 300));
        assert.deepEqual(calls, ["gpt-4o"]);
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      const rows = rowsFor(stalledId);
      assert.deepEqual(
        rows.map((r) => [r.status, r.error_code]),
        [["504", "STREAM_READINESS_TIMEOUT"]],
        JSON.stringify(rows)
      );
    } finally {
      delete process.env.ROUTING_STALL_DEADLINE_MS;
      delete process.env.ROUTING_STALL_FAILOVER;
      await stop();
    }
  });
}
