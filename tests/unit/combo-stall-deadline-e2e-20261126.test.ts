/**
 * ROUTING_STALL_DEADLINE_MS end to end, through the production request path.
 *
 * Live 2026-11-26: a model that never answered (nvidia/z-ai/glm-5.3-flash) held every combo request
 * until the client gave up at 140 s. The combo never failed over and the model got no usage row, so
 * the "broken right now" guard never saw it. This drives the real route handler
 * (POST /v1/chat/completions and POST /v1/messages) -> handleChat -> combo -> chatCore -> the real
 * openai executor -> real fetch, against a local HTTP server standing in for the providers. Nothing
 * on the request path is mocked.
 *
 * Not covered here: the production Next.js server and HTTP socket layer in front of the route
 * handler, and real provider executors other than the generic openai one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

// Never touch a real data directory: this file writes usage rows.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-stall-deadline-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
// Stream readiness's own timeout (80 s by default) is read at module load. Keep it below the stall
// deadline so the first-event phase shows the deadline extending readiness, never shortening it.
const READINESS_MS = 500;
process.env.STREAM_READINESS_TIMEOUT_MS = String(READINESS_MS);

const { POST: postChatCompletion } = await import("../../src/app/api/v1/chat/completions/route.ts");
const { POST: postMessages } = await import("../../src/app/api/v1/messages/route.ts");
const { createProviderConnection, deleteProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { createCombo } = await import("../../src/lib/db/combos.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { resetAllCircuitBreakers, getCircuitBreaker } =
  await import("../../src/shared/utils/circuitBreaker.ts");
const { getProviderConnectionById } = await import("../../src/lib/db/providers.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");

test.after(() => {
  delete process.env.ROUTING_STALL_DEADLINE_MS;
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const DEADLINE_MS = 1500;

/** How the fake upstream treats one model. */
type Behaviour =
  | "hold-headers" // accepts the request, never sends headers (the live glm stall)
  | "headers-then-silent" // 200 + event-stream headers and a ping, then nothing
  | "slow-first-chunk" // healthy model whose first event arrives after 500 ms
  | "json-slow-body" // stream:true answered with JSON headers at once and the body after 2 s
  | "answer"; // answers at once

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-stall",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function answerStream(res: http.ServerResponse, model: string, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(chunk(model, { role: "assistant", content: "" }));
  res.write(chunk(model, { content: text }));
  res.write(chunk(model, {}, "stop"));
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-stall",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    })}\n\n`
  );
  res.end("data: [DONE]\n\n");
}

function answerJson(res: http.ServerResponse, model: string, text: string) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-stall",
      object: "chat.completion",
      created: 1,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    })
  );
}

async function setup(behaviours: Record<string, Behaviour>, onRequest?: (model: string) => void) {
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  const calls: Array<{ model: string; stream: boolean; at: number }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (part) => (raw += part));
    req.on("end", () => {
      let body: { model?: string; stream?: boolean } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* not JSON */
      }
      const model = String(body.model || "");
      const stream = body.stream === true;
      calls.push({ model, stream, at: Date.now() });
      onRequest?.(model);
      const behaviour = behaviours[model] ?? "answer";
      if (behaviour === "hold-headers") return;
      if (behaviour === "headers-then-silent") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.flushHeaders();
        res.write(": ping\n\n");
        return;
      }
      const text = `answered by ${model}`;
      if (behaviour === "json-slow-body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        setTimeout(() => {
          res.end(
            JSON.stringify({
              id: "chatcmpl-stall",
              object: "chat.completion",
              created: 1,
              model,
              choices: [
                { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            })
          );
        }, DEADLINE_MS + 500);
        return;
      }
      if (behaviour === "slow-first-chunk") {
        setTimeout(
          () => (stream ? answerStream(res, model, text) : answerJson(res, model, text)),
          500
        );
        return;
      }
      if (stream) answerStream(res, model, text);
      else answerJson(res, model, text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `stall-${stamp}`,
    apiKey: `sk-stall-${stamp}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
  });
  const comboName = `stall-combo-${stamp}`;
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

function chatRequest(comboName: string, stream: boolean, signal?: AbortSignal) {
  return new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: comboName,
      stream,
      max_tokens: 16,
      messages: [{ role: "user", content: `stall probe ${comboName}` }],
    }),
    signal,
  });
}

/** Anthropic-format request like the live one (Claude Code sends stream:true and tools). */
function messagesRequest(comboName: string, signal?: AbortSignal) {
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
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      messages: [{ role: "user", content: `stall probe ${comboName}` }],
    }),
    signal,
  });
}

type UsageRow = {
  model: string;
  status: string;
  success: number;
  error_code: string | null;
  latency_ms: number;
};

async function usageRows(connectionId: string): Promise<UsageRow[]> {
  await new Promise((resolve) => setTimeout(resolve, 800)); // usage writes are not awaited
  return getDbInstance()
    .prepare(
      "SELECT model, status, success, error_code, latency_ms FROM usage_history WHERE connection_id = ? ORDER BY id"
    )
    .all(connectionId) as UsageRow[];
}

async function readAll(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function setFlag(value: string | null) {
  if (value === null) delete process.env.ROUTING_STALL_DEADLINE_MS;
  else process.env.ROUTING_STALL_DEADLINE_MS = value;
}

test("flag on, streaming, the model sends headers then nothing: cut at the deadline, recorded as 504 upstream_stalled, and the next candidate answers", async () => {
  setFlag(String(DEADLINE_MS));
  const { connectionId, comboName, calls, stop } = await setup({
    "gpt-4.1": "headers-then-silent",
    "gpt-4.1-mini": "answer",
  });
  try {
    const startedAt = Date.now();
    const response = await postChatCompletion(chatRequest(comboName, true));
    const text = await readAll(response);
    const elapsed = Date.now() - startedAt;

    assert.equal(response.status, 200, text.slice(0, 300));
    assert.match(text, /answered by gpt-4.1-mini/);
    assert.ok(
      elapsed >= DEADLINE_MS && elapsed < DEADLINE_MS + 3000,
      `failed over at the deadline, once (no same-model retry): ${elapsed} ms`
    );
    assert.deepEqual(
      calls.map((c) => c.model),
      ["gpt-4.1", "gpt-4.1-mini"],
      "the stalled model is tried once, then the next candidate"
    );
    assert.ok(
      calls.every((c) => c.stream),
      "both upstream calls stream"
    );

    const rows = await usageRows(connectionId);
    const stalledRows = rows.filter((r) => r.model === "gpt-4.1");
    assert.equal(stalledRows.length, 1, JSON.stringify(rows));
    assert.equal(stalledRows[0].status, "504");
    assert.equal(stalledRows[0].success, 0);
    assert.equal(stalledRows[0].error_code, "upstream_stalled");
    assert.ok(stalledRows[0].latency_ms >= DEADLINE_MS, JSON.stringify(stalledRows[0]));
    const healthyRows = rows.filter((r) => r.model === "gpt-4.1-mini");
    assert.equal(healthyRows.length, 1, JSON.stringify(rows));
    assert.equal(healthyRows[0].success, 1);
  } finally {
    setFlag(null);
    await stop();
  }
});

// The live glm shape: the upstream accepts the request and never sends headers. The attempt is cut
// at the deadline and recorded, but the routing replay-safety guard (routingTransportContext.ts:
// "Fetch was invoked. Abort/error does not prove remote non-execution.") refuses to send the same
// request to another model after an aborted in-flight fetch, so the client gets a fast terminal
// error instead of a failover. That guard is unchanged here on purpose.
test("flag on, streaming, the model never sends headers: cut at the deadline and recorded as 504 upstream_stalled; replay guard stops the combo (no failover)", async () => {
  setFlag(String(DEADLINE_MS));
  const { connectionId, comboName, calls, stop } = await setup({
    "gpt-4o": "hold-headers",
    "gpt-4o-mini": "answer",
  });
  try {
    const startedAt = Date.now();
    const response = await postChatCompletion(chatRequest(comboName, true));
    const text = await readAll(response);
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed >= DEADLINE_MS && elapsed < DEADLINE_MS + 3000,
      `the request ended at the deadline, not when the client gave up: ${elapsed} ms`
    );
    assert.equal(response.status, 502, text.slice(0, 300));
    assert.match(text, /execution_uncertain/);
    assert.deepEqual(
      calls.map((c) => c.model),
      ["gpt-4o"],
      "no replay to the next candidate after an aborted in-flight fetch"
    );

    const rows = await usageRows(connectionId);
    const stalledRows = rows.filter((r) => r.model === "gpt-4o");
    assert.equal(stalledRows.length, 1, JSON.stringify(rows));
    assert.equal(stalledRows[0].status, "504");
    assert.equal(stalledRows[0].success, 0);
    assert.equal(stalledRows[0].error_code, "upstream_stalled");
    assert.ok(stalledRows[0].latency_ms >= DEADLINE_MS, JSON.stringify(stalledRows[0]));

    // A stall is the model's, not the account's: the connection is not cooled down or marked
    // unavailable, and the provider breaker records no failure. (Invariant check only: behind the
    // replay guard this holds for either catch branch; the branch itself is pinned by the
    // "chatCore: a stalled attempt returns errorType stream_timeout" test below.)
    const connection = (await getProviderConnectionById(connectionId)) as Record<string, unknown>;
    const cooledUntil = connection.rateLimitedUntil
      ? Date.parse(String(connection.rateLimitedUntil))
      : 0;
    assert.ok(!(cooledUntil > Date.now()), `connection cooled down: ${JSON.stringify(connection)}`);
    assert.notEqual(connection.testStatus, "unavailable", JSON.stringify(connection));
    assert.ok(
      !connection.lastErrorType,
      `connection error recorded: ${JSON.stringify(connection)}`
    );
    const breaker = getCircuitBreaker("openai").getStatus() as Record<string, unknown>;
    assert.equal(breaker.state, "CLOSED", JSON.stringify(breaker));
    assert.ok(!Number(breaker.failureCount), `breaker failures: ${JSON.stringify(breaker)}`);
  } finally {
    setFlag(null);
    await stop();
  }
});

// The attempt result chatCore hands back to chat.ts and the combo, without the combo's replay
// guard in front (which stops on an aborted in-flight fetch whatever the result says). The stall
// must come back as errorType "stream_timeout" with a JSON 504: chat.ts returns stream_timeout
// before any account-cooldown handling, and the combo reads the JSON code to skip the same-model
// retry and the provider breaker. The generic catch would return "upstream_timeout" with an SSE
// error body instead.
test("chatCore: a stalled attempt returns errorType stream_timeout, code upstream_stalled, JSON 504", async () => {
  setFlag(String(DEADLINE_MS));
  const server = http.createServer((req) => req.resume()); // never answers
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
  try {
    const body = {
      model: "gpt-4o",
      stream: true,
      max_tokens: 16,
      messages: [{ role: "user", content: "stall probe (chatCore)" }],
    };
    const startedAt = Date.now();
    const result = (await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o", extendedContext: false },
      credentials: {
        apiKey: "sk-stall-core",
        providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: new Headers({ accept: "text/event-stream" }),
      },
      userAgent: "unit-test",
      isCombo: true,
      comboName: "stall-core-combo",
      log: silentLog,
    } as never)) as {
      success: boolean;
      status?: number;
      errorType?: string;
      errorCode?: string;
      response?: Response;
    };
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= DEADLINE_MS && elapsed < DEADLINE_MS + 3000, `${elapsed} ms`);
    assert.equal(result.success, false);
    assert.equal(result.status, 504);
    assert.equal(result.errorType, "stream_timeout");
    assert.equal(result.errorCode, "upstream_stalled");
    assert.match(result.response?.headers.get("content-type") || "", /application\/json/);
    const payload = await result.response!.json();
    assert.equal(payload.error.code, "upstream_stalled");
  } finally {
    setFlag(null);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  }
});

// A stream:true call the upstream answers with a JSON body is read whole (maybeConvertJsonBodyToSse)
// and is not watched past its headers: a JSON body legitimately arrives all at once.
test("flag on: a streaming request answered with a JSON body slower than the deadline is not cut", async () => {
  setFlag(String(DEADLINE_MS));
  const { connectionId, comboName, calls, stop } = await setup({
    "gpt-4o": "json-slow-body",
    "gpt-4o-mini": "answer",
  });
  try {
    const response = await postChatCompletion(chatRequest(comboName, true));
    const text = await readAll(response);
    assert.equal(response.status, 200, text.slice(0, 300));
    assert.match(text, /answered by gpt-4o/);
    assert.deepEqual(
      calls.map((c) => c.model),
      ["gpt-4o"]
    );
    const rows = await usageRows(connectionId);
    assert.equal(rows.filter((r) => r.success === 0).length, 0, JSON.stringify(rows));
  } finally {
    setFlag(null);
    await stop();
  }
});

// Pre-existing defect fixed alongside: a client that leaves while the first event is awaited was
// recorded as a 504 STREAM_READINESS_TIMEOUT model failure (any body read error became a timeout),
// so a few quick Escapes could get a healthy model excluded as broken. It is the client leaving.
test("flag off: a client that leaves during the first-event wait is recorded as 499 client_disconnected, not a model failure", async () => {
  setFlag(null);
  const client = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Leave shortly after the upstream has the request (headers go out at once), well inside the
  // first-event wait (READINESS_MS), so the abort lands during readiness and nowhere else.
  const { connectionId, comboName, calls, stop } = await setup(
    { o3: "headers-then-silent", "o4-mini": "answer" },
    () => {
      timer = setTimeout(() => client.abort(), 150);
    }
  );
  try {
    // Keep the Request reachable: undici's Request follows the caller's signal through a WeakRef to
    // its own AbortController, so a collected Request silently drops the client's abort (a test
    // harness artifact; a real server request is held by the socket).
    const request = chatRequest(comboName, true, client.signal);
    const response = await postChatCompletion(request);
    await readAll(response);
    assert.deepEqual(
      calls.map((c) => c.model),
      ["o3"]
    );
    const rows = await usageRows(connectionId);
    assert.ok(request.signal.aborted, "the client left");
    const modelRows = rows.filter((r) => r.model === "o3");
    assert.equal(modelRows.length, 1, JSON.stringify(rows));
    assert.equal(modelRows[0].status, "499", JSON.stringify(modelRows[0]));
    assert.equal(modelRows[0].error_code, "client_disconnected");
  } finally {
    clearTimeout(timer);
    await stop();
  }
});

// The live request shape (Anthropic /v1/messages, streaming, with tools). Even when the model sends
// headers, the replay-safety guard does not replay a tool request after a 5xx
// ("tool_replay_unqualified"), so the attempt is cut and recorded but the client gets the 504.
test("flag on, /v1/messages streaming with tools (live request shape): cut at the deadline and recorded; tool replay guard stops the combo", async () => {
  setFlag(String(DEADLINE_MS));
  const { connectionId, comboName, calls, stop } = await setup({
    "gpt-4o": "headers-then-silent",
    "gpt-4o-mini": "answer",
  });
  try {
    const startedAt = Date.now();
    const response = await postMessages(messagesRequest(comboName));
    const text = await readAll(response);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= DEADLINE_MS && elapsed < DEADLINE_MS + 3000, `${elapsed} ms`);
    assert.equal(response.status, 504, text.slice(0, 300));
    assert.match(text, /upstream_stalled/);
    assert.deepEqual(
      calls.map((c) => c.model),
      ["gpt-4o"]
    );
    const rows = await usageRows(connectionId);
    const stalledRows = rows.filter((r) => r.model === "gpt-4o");
    assert.equal(stalledRows.length, 1, JSON.stringify(rows));
    assert.equal(stalledRows[0].status, "504");
    assert.equal(stalledRows[0].error_code, "upstream_stalled");
  } finally {
    setFlag(null);
    await stop();
  }
});

test("flag on: a healthy model whose first event takes 500 ms is not cut and leaves no failure row", async () => {
  setFlag(String(DEADLINE_MS));
  const { connectionId, comboName, calls, stop } = await setup({
    "gpt-4.1-nano": "slow-first-chunk",
    "gpt-4o-mini": "answer",
  });
  try {
    const response = await postChatCompletion(chatRequest(comboName, true));
    const text = await readAll(response);
    assert.equal(response.status, 200);
    assert.match(text, /answered by gpt-4.1-nano/);
    assert.deepEqual(
      calls.map((c) => c.model),
      ["gpt-4.1-nano"]
    );
    const rows = await usageRows(connectionId);
    assert.equal(rows.filter((r) => r.success === 0).length, 0, JSON.stringify(rows));
  } finally {
    setFlag(null);
    await stop();
  }
});

// Baselines: the flag off (today's behaviour), and the flag on for a non-streaming request, where
// the upstream call does not stream and the deadline is deliberately not applied. In both the
// request only ends because the client gives up, nothing fails over, and the stalled model gets
// no usage row.
for (const [label, flag, stream, stalled, healthy] of [
  ["flag off, streaming", null, true, "o3", "o4-mini"],
  [
    "flag on, non-streaming (upstream call does not stream)",
    String(DEADLINE_MS),
    false,
    "o3-mini",
    "o1-mini",
  ],
] as const) {
  test(`${label}: no deadline, the request waits until the client gives up, no failover, no model row`, async () => {
    setFlag(flag);
    const { connectionId, comboName, calls, stop } = await setup({
      [stalled]: "hold-headers",
      [healthy]: "answer",
    });
    const clientGivesUpMs = DEADLINE_MS + 2000;
    const client = new AbortController();
    const timer = setTimeout(() => client.abort(), clientGivesUpMs);
    try {
      const startedAt = Date.now();
      // Keep the Request reachable (see the note in the client-leaves test above).
      const request = chatRequest(comboName, stream, client.signal);
      const response = await postChatCompletion(request);
      await readAll(response);
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= clientGivesUpMs - 50, `ended only when the client left: ${elapsed} ms`);
      assert.deepEqual(
        calls.map((c) => c.model),
        [stalled],
        "never failed over"
      );
      assert.equal(calls[0].stream, stream, "upstream call streams exactly when the client does");
      assert.ok(request.signal.aborted, "the client left");
      const rows = await usageRows(connectionId);
      assert.equal(
        rows.filter((r) => r.model === stalled).length,
        0,
        `no per-model row today: ${JSON.stringify(rows)}`
      );
    } finally {
      clearTimeout(timer);
      setFlag(null);
      await stop();
    }
  });
}
