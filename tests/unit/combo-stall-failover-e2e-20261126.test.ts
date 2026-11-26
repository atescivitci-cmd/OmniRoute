/**
 * ROUTING_STALL_FAILOVER end to end, through the production request path: the real route handler
 * (POST /v1/messages, Anthropic format with client-side tools, like Claude Code) -> handleChat ->
 * combo -> routing replay-safety guard -> chatCore -> the real openai executor -> real fetch,
 * against a local HTTP server standing in for the providers. Nothing on the request path is
 * mocked. Not covered: the Next.js server/socket layer and provider executors other than openai.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

// Never touch a real data directory: this file writes usage rows.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-stall-failover-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
// Readiness's own timeout is read at module load; keep it below the stall deadline.
process.env.STREAM_READINESS_TIMEOUT_MS = "500";

const { POST: postMessages } = await import("../../src/app/api/v1/messages/route.ts");
const { createProviderConnection, deleteProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { createCombo } = await import("../../src/lib/db/combos.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");

const DEADLINE_MS = 1500;

test.after(() => {
  delete process.env.ROUTING_STALL_DEADLINE_MS;
  delete process.env.ROUTING_STALL_FAILOVER;
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type Behaviour =
  | "hold-headers" // accepts the request, never sends headers
  | "headers-then-silent" // 200 + event-stream headers and a ping, then nothing
  | "content-then-silent" // one real content event, then nothing
  | "answer";

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-failover",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

async function setup(behaviours: Record<string, Behaviour>) {
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (part) => (raw += part));
    req.on("end", () => {
      let model = "";
      try {
        model = String(JSON.parse(raw).model || "");
      } catch {
        /* not JSON */
      }
      calls.push(model);
      const behaviour = behaviours[model] ?? "answer";
      if (behaviour === "hold-headers") return;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      if (behaviour === "headers-then-silent") {
        res.write(": ping\n\n");
        return;
      }
      if (behaviour === "content-then-silent") {
        res.write(chunk(model, { role: "assistant", content: `partial from ${model}` }));
        return;
      }
      res.write(chunk(model, { role: "assistant", content: "" }));
      res.write(chunk(model, { content: `answered by ${model}` }));
      res.write(chunk(model, {}, "stop"));
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-failover",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })}\n\n`
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `failover-${stamp}`,
    apiKey: `sk-failover-${stamp}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
  });
  const comboName = `failover-combo-${stamp}`;
  await createCombo({
    name: comboName,
    strategy: "priority",
    models: Object.keys(behaviours).map((model) => ({
      model: `openai/${model}`,
      provider: "openai",
    })),
    config: { maxRetries: 1 },
  });
  const stop = async () => {
    await deleteProviderConnection(String(connection.id));
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  };
  return { connectionId: String(connection.id), comboName, calls, stop };
}

const CLIENT_TOOL = {
  name: "read_file",
  description: "Read a file",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};
const SERVER_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 1 };

function messagesRequest(comboName: string, tools: unknown[], signal?: AbortSignal) {
  return new Request("http://localhost/api/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: comboName,
      stream: true,
      max_tokens: 64,
      tools,
      messages: [{ role: "user", content: `failover probe ${comboName}` }],
    }),
    signal,
  });
}

type UsageRow = { model: string; status: string; success: number; error_code: string | null };

async function usageRows(connectionId: string): Promise<UsageRow[]> {
  await new Promise((resolve) => setTimeout(resolve, 800)); // usage writes are not awaited
  return getDbInstance()
    .prepare(
      "SELECT model, status, success, error_code FROM usage_history WHERE connection_id = ? ORDER BY id"
    )
    .all(connectionId) as UsageRow[];
}

function callLogModels(connectionId: string): string[] {
  return (
    getDbInstance()
      .prepare("SELECT model FROM call_logs WHERE connection_id = ? ORDER BY timestamp")
      .all(connectionId) as Array<{ model: string }>
  ).map((row) => String(row.model));
}

/** Reads what arrives until the stream ends or errors (a client abort ends it with an error). */
async function readPartial(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    /* the client left */
  }
  return text;
}

async function readAll(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function setFlags(deadline: boolean, failover: boolean) {
  if (deadline) process.env.ROUTING_STALL_DEADLINE_MS = String(DEADLINE_MS);
  else delete process.env.ROUTING_STALL_DEADLINE_MS;
  if (failover) process.env.ROUTING_STALL_FAILOVER = "1";
  else delete process.env.ROUTING_STALL_FAILOVER;
}

for (const [phase, behaviour, stalled, healthy] of [
  ["headers phase (no headers)", "hold-headers", "gpt-4o", "gpt-4o-mini"],
  [
    "first-event phase (headers, then only pings)",
    "headers-then-silent",
    "gpt-4.1",
    "gpt-4.1-mini",
  ],
] as const) {
  test(`both flags on, ${phase}: the stalled target is replaced by the next one after the deadline`, async () => {
    setFlags(true, true);
    const { connectionId, comboName, calls, stop } = await setup({
      [stalled]: behaviour,
      [healthy]: "answer",
    });
    try {
      const startedAt = Date.now();
      const response = await postMessages(messagesRequest(comboName, [CLIENT_TOOL]));
      const text = await readAll(response);
      const elapsed = Date.now() - startedAt;
      assert.equal(response.status, 200, text.slice(0, 300));
      assert.match(text, new RegExp(`answered by ${healthy}`));
      assert.ok(!text.includes(`answered by ${stalled}"`), "nothing from the stalled target");
      assert.ok(
        elapsed >= DEADLINE_MS && elapsed < DEADLINE_MS + 3000,
        `answered after one stall deadline: ${elapsed} ms`
      );
      assert.deepEqual(calls, [stalled, healthy], "each target once, in combo order");

      const rows = await usageRows(connectionId);
      assert.equal(rows.length, 2, JSON.stringify(rows));
      assert.deepEqual(
        [rows[0].model, rows[0].status, rows[0].success, rows[0].error_code],
        [stalled, "504", 0, "upstream_stalled"]
      );
      assert.deepEqual([rows[1].model, rows[1].success], [healthy, 1]);
      const logged = callLogModels(connectionId);
      assert.ok(
        logged.some((m) => m.includes(stalled)) && logged.some((m) => m.includes(healthy)),
        `both attempts have call-log entries: ${JSON.stringify(logged)}`
      );
    } finally {
      setFlags(false, false);
      await stop();
    }
  });
}

for (const [phase, behaviour, stalled, healthy, expectedStatus, expectedCode] of [
  ["headers phase", "hold-headers", "o3", "o4-mini", 502, "execution_uncertain"],
  ["first-event phase", "headers-then-silent", "o1", "o1-mini", 504, "upstream_stalled"],
] as const) {
  test(`stall failover OFF (deadline on), ${phase}: fast error as before, no replay`, async () => {
    setFlags(true, false);
    const { connectionId, comboName, calls, stop } = await setup({
      [stalled]: behaviour,
      [healthy]: "answer",
    });
    try {
      const startedAt = Date.now();
      const response = await postMessages(messagesRequest(comboName, [CLIENT_TOOL]));
      const text = await readAll(response);
      const elapsed = Date.now() - startedAt;
      // The failure is the old one: a 502 execution_uncertain (headers phase) or 504
      // upstream_stalled (first-event phase), as an HTTP status, or as an SSE error event when the
      // gateway's 2 s keep-alive already committed a 200 (load-dependent).
      assert.ok(
        response.status === expectedStatus ||
          (response.status === 200 && text.includes(expectedCode)),
        `${response.status} ${text.slice(0, 300)}`
      );
      assert.ok(text.includes(expectedCode), text.slice(0, 300));
      assert.doesNotMatch(text, /answered by/);
      assert.ok(elapsed < DEADLINE_MS + 3000, `${elapsed} ms`);
      assert.deepEqual(calls, [stalled], "no replay");
      const rows = await usageRows(connectionId);
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(rows[0].error_code, "upstream_stalled");
    } finally {
      setFlags(false, false);
      await stop();
    }
  });
}

test("both flags on: a request with a provider-executed (server) tool is never replayed", async () => {
  setFlags(true, true);
  const { comboName, calls, stop } = await setup({
    "gpt-4o": "headers-then-silent",
    "gpt-4o-mini": "answer",
  });
  try {
    const response = await postMessages(messagesRequest(comboName, [CLIENT_TOOL, SERVER_TOOL]));
    const text = await readAll(response);
    assert.ok(
      response.status !== 200 || text.includes("upstream_stalled"),
      `${response.status} ${text.slice(0, 300)}`
    );
    assert.doesNotMatch(text, /answered by/);
    assert.doesNotMatch(text, /answered by gpt-4o-mini/);
    assert.deepEqual(calls, ["gpt-4o"], "no replay");
  } finally {
    setFlags(false, false);
    await stop();
  }
});

test("both flags on: a stall after a content event reached the client is never replayed", async () => {
  setFlags(true, true);
  const { comboName, calls, stop } = await setup({
    "gpt-4.1": "content-then-silent",
    "gpt-4.1-mini": "answer",
  });
  const client = new AbortController();
  const timer = setTimeout(() => client.abort(), DEADLINE_MS + 1500);
  try {
    // Keep the Request reachable: undici's Request follows the caller's signal through a WeakRef.
    const request = messagesRequest(comboName, [CLIENT_TOOL], client.signal);
    const response = await postMessages(request);
    assert.equal(response.status, 200);
    const text = await readPartial(response);
    assert.ok(request.signal.aborted, "ended only because the client left");
    assert.match(text, /partial from gpt-4\.1/);
    assert.doesNotMatch(text, /answered by/);
    assert.deepEqual(calls, ["gpt-4.1"], "no replay once content was delivered");
  } finally {
    clearTimeout(timer);
    setFlags(false, false);
    await stop();
  }
});

test("both flags on: at most one stall failover per request (two stalled targets, then an answer)", async () => {
  setFlags(true, true);
  const { connectionId, comboName, calls, stop } = await setup({
    "gpt-4o": "hold-headers",
    "gpt-4.1": "headers-then-silent",
    "gpt-4o-mini": "answer",
  });
  try {
    const startedAt = Date.now();
    const response = await postMessages(messagesRequest(comboName, [CLIENT_TOOL]));
    const text = await readAll(response);
    const elapsed = Date.now() - startedAt;
    // /v1/messages commits a 200 with a gateway keep-alive ping early; the failure then arrives
    // as an error event. No model output from any target reached the client.
    assert.match(text, /upstream_stalled/, text.slice(0, 400));
    assert.doesNotMatch(text, /answered by/);
    assert.deepEqual(calls, ["gpt-4o", "gpt-4.1"], "the second stall is not replayed");
    assert.ok(elapsed < 2 * DEADLINE_MS + 3000, `bounded: ${elapsed} ms`);
    const rows = await usageRows(connectionId);
    assert.deepEqual(
      rows.map((r) => r.error_code),
      ["upstream_stalled", "upstream_stalled"]
    );
  } finally {
    setFlags(false, false);
    await stop();
  }
});
