/**
 * ROUTING_OVERLOAD_FAILOVER end to end, through the production request path: the real route handler
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-overload-failover-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";

const { POST: postMessages } = await import("../../src/app/api/v1/messages/route.ts");
const { POST: postChat } = await import("../../src/app/api/v1/chat/completions/route.ts");
const { createProviderConnection, deleteProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { createCombo } = await import("../../src/lib/db/combos.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");

// The exact body gemini/gemini-3.5-flash answered live on 2026-11-26 19:28Z (HTTP 503).
const LIVE_OVERLOAD_MESSAGE =
  "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later. (reset after 3s)";

test.after(() => {
  delete process.env.ROUTING_OVERLOAD_FAILOVER;
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type Behaviour =
  | "overloaded" // 503 with the live overload message
  | "generic-503" // 503 with no overload signal at all
  | "content-then-error" // 200 stream: one content event, then an overload error event
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

async function setup(
  behaviours: Record<string, Behaviour>,
  comboExtra: Record<string, unknown> = {}
) {
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  const calls: string[] = [];
  const bodies: string[] = [];
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
      bodies.push(raw);
      const behaviour = behaviours[model] ?? "answer";
      if (behaviour === "overloaded" || behaviour === "generic-503") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: 503,
              message: behaviour === "overloaded" ? LIVE_OVERLOAD_MESSAGE : "Service Unavailable",
            },
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      if (behaviour === "content-then-error") {
        res.write(chunk(model, { role: "assistant", content: `partial from ${model}` }));
        res.end(
          `data: ${JSON.stringify({ error: { message: LIVE_OVERLOAD_MESSAGE, code: 503 } })}\n\n`
        );
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
  // Two accounts on the same fake upstream. A 503 puts the account that received it into the
  // existing short connection cooldown (unchanged by this feature), so the next target needs an
  // account that is not cooling down, as in production where the next candidate is usually
  // another provider or account.
  const makeConnection = (suffix: string) =>
    createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: `overload-${stamp}-${suffix}`,
      apiKey: `sk-overload-${stamp}-${suffix}`,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
    });
  const connection = await makeConnection("a");
  const connectionB = await makeConnection("b");
  const comboName = `failover-combo-${stamp}`;
  await createCombo({
    name: comboName,
    strategy: "priority",
    // Each target pinned to its own account: the first target's account takes the 503 (and the
    // existing short cooldown), the next target runs on the other account.
    models: Object.keys(behaviours).map((model, index) => ({
      model: `openai/${model}`,
      provider: "openai",
      connectionId: String(index === 0 ? connection.id : connectionB.id),
    })),
    config: { maxRetries: 1 },
    ...comboExtra,
  });
  const stop = async () => {
    await deleteProviderConnection(String(connection.id));
    await deleteProviderConnection(String(connectionB.id));
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  };
  return {
    connectionIds: [String(connection.id), String(connectionB.id)],
    comboName,
    calls,
    bodies,
    stop,
  };
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

async function usageRows(connectionIds: string[]): Promise<UsageRow[]> {
  await new Promise((resolve) => setTimeout(resolve, 800)); // usage writes are not awaited
  return getDbInstance()
    .prepare(
      `SELECT model, status, success, error_code FROM usage_history WHERE connection_id IN (${connectionIds.map(() => "?").join(",")}) ORDER BY id`
    )
    .all(...connectionIds) as UsageRow[];
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

function setFlag(on: boolean) {
  if (on) process.env.ROUTING_OVERLOAD_FAILOVER = "1";
  else delete process.env.ROUTING_OVERLOAD_FAILOVER;
}

function chatToolRequest(comboName: string) {
  return new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: comboName,
      stream: true,
      max_tokens: 64,
      tools: [
        {
          type: "function",
          function: { name: "read_file", parameters: { type: "object", properties: {} } },
        },
      ],
      messages: [{ role: "user", content: `overload probe ${comboName}` }],
    }),
  });
}

for (const [route, overloaded, healthy] of [
  ["/v1/messages", "gpt-4o", "gpt-4o-mini"],
  ["/v1/chat/completions", "gpt-4.1", "gpt-4.1-mini"],
] as const) {
  test(`flag on, ${route} tool request: an overload refusal moves on to the next target`, async () => {
    setFlag(true);
    const { connectionIds, comboName, calls, stop } = await setup({
      [overloaded]: "overloaded",
      [healthy]: "answer",
    });
    try {
      const response =
        route === "/v1/messages"
          ? await postMessages(messagesRequest(comboName, [CLIENT_TOOL]))
          : await postChat(chatToolRequest(comboName));
      const text = await readAll(response);
      assert.equal(response.status, 200, text.slice(0, 300));
      assert.match(text, new RegExp(`answered by ${healthy}`));
      assert.ok(!/high demand|"type":"error"|event: error/.test(text), text.slice(0, 400));
      assert.deepEqual(calls, [overloaded, healthy], "each target once, in combo order");
      const rows = await usageRows(connectionIds);
      assert.deepEqual(
        rows.map((r) => [r.model, r.status, r.success, r.error_code]),
        [
          [overloaded, "503", 0, "upstream_503"],
          [healthy, "200", 1, null],
        ],
        JSON.stringify(rows)
      );
    } finally {
      setFlag(false);
      await stop();
    }
  });
}

test("flag OFF: the overload refusal ends the tool request with an error, as today", async () => {
  setFlag(false);
  const { comboName, calls, stop } = await setup({ o3: "overloaded", "o4-mini": "answer" });
  try {
    const response = await postMessages(messagesRequest(comboName, [CLIENT_TOOL]));
    const text = await readAll(response);
    assert.ok(response.status === 503 || /event: error/.test(text), `${response.status} ${text}`);
    assert.match(text, /high demand/);
    assert.doesNotMatch(text, /answered by/);
    assert.ok(!calls.includes("o4-mini"), JSON.stringify(calls));
  } finally {
    await stop();
  }
});

test("flag on: a generic 503 with no overload signal does not fail over", async () => {
  setFlag(true);
  const { comboName, calls, stop } = await setup({ o1: "generic-503", "o1-mini": "answer" });
  try {
    const response = await postMessages(messagesRequest(comboName, [CLIENT_TOOL]));
    const text = await readAll(response);
    assert.doesNotMatch(text, /answered by/);
    assert.ok(!calls.includes("o1-mini"), JSON.stringify(calls));
  } finally {
    setFlag(false);
    await stop();
  }
});

test("flag on: a request with a provider-executed (server) tool does not fail over", async () => {
  setFlag(true);
  const { comboName, calls, stop } = await setup({ "o3-mini": "overloaded", "gpt-4o": "answer" });
  try {
    const response = await postMessages(messagesRequest(comboName, [CLIENT_TOOL, SERVER_TOOL]));
    const text = await readAll(response);
    assert.doesNotMatch(text, /answered by/);
    assert.ok(!calls.includes("gpt-4o"), JSON.stringify(calls));
  } finally {
    setFlag(false);
    await stop();
  }
});

test("flag on: an overload error AFTER content reached the client is never failed over", async () => {
  setFlag(true);
  const { comboName, calls, stop } = await setup({
    "gpt-4.1-nano": "content-then-error",
    "gpt-4o-mini": "answer",
  });
  try {
    const response = await postMessages(messagesRequest(comboName, [CLIENT_TOOL]));
    const text = await readPartial(response);
    assert.match(text, /partial from gpt-4\.1-nano/);
    assert.doesNotMatch(text, /answered by/);
    assert.deepEqual(calls, ["gpt-4.1-nano"]);
  } finally {
    setFlag(false);
    await stop();
  }
});

// A request without tools already fails over on a 503 today, after the combo's same-model retry
// delay (the retry itself is then skipped by the account cooldown). With the flag on, the
// classified overload skips that wait. With it off nothing changes, which also pins that nothing
// is marked while the flag is off.
for (const flag of [false, true]) {
  test(`flag ${flag ? "on" : "off"}, no-tool request: ${flag ? "no" : "unchanged"} same-model retry wait before the next target`, async () => {
    setFlag(flag);
    const { comboName, calls, stop } = await setup({
      "gpt-4o": "overloaded",
      "gpt-4o-mini": "answer",
    });
    try {
      const startedAt = Date.now();
      const response = await postMessages(messagesRequest(comboName, []));
      const text = await readAll(response);
      const elapsed = Date.now() - startedAt;
      assert.match(text, /answered by gpt-4o-mini/, text.slice(0, 300));
      assert.deepEqual(calls, ["gpt-4o", "gpt-4o-mini"]);
      if (flag) assert.ok(elapsed < 1500, `no retry wait: ${elapsed} ms`);
      else assert.ok(elapsed >= 1500, `today's retry wait: ${elapsed} ms`);
    } finally {
      setFlag(false);
      await stop();
    }
  });
}
