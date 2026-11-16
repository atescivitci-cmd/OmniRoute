// @ts-nocheck
/**
 * One-retry failover for a replay-safe request whose HTTP 200 was rejected by the content-shape
 * quality validator (empty visible content, or reasoning-only exhaustion).
 *
 * Incident 2026-11-16: NVIDIA Mistral Large 4 answered a plain no-tools, stream:false chat with
 * content=null, reasoning_content=378 chars, completion_tokens=191 of which reasoning_tokens=190.
 * The attempt guard had already committed the 200, so the combo returned
 * 502 response_contract_failed without trying the next target and without a log line.
 *
 * Drives the real handleComboChat (priority and round-robin) with a stubbed single-model handler.
 * DATA_DIR is a throwaway temp dir; ~/.omniroute is never opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-only-failover-"));
process.env.DATA_DIR = dataDir;
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("fixture_network_forbidden");
};
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const {
  createRoutingAttemptGuard,
  isRoutingTerminal,
  isQualityFailoverReplayUnsafe,
  inspectReplayInput,
} = await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { clearCooldownState } = await import("../../open-sse/services/providerCooldownTracker.ts");
const { clearAllModelLockouts, getAllModelLockouts } =
  await import("../../open-sse/services/accountFallback.ts");
const dbCore = await import("../../src/lib/db/core.ts");

const REASONING_SENTINEL = "SENTINEL_REASONING_TEXT_MUST_NOT_LEAK";
const REASONING_378 = (REASONING_SENTINEL + " ").repeat(11).slice(0, 378);
assert.equal(REASONING_378.length, 378);

let warns: string[] = [];
let chain: Record<string, unknown>[] = [];
const log = {
  info(tag: string, msg: string) {
    if (tag === "ROUTING_CHAIN") chain.push(JSON.parse(msg));
  },
  warn(_tag: string, msg: string) {
    warns.push(String(msg));
  },
  error() {},
  debug() {},
};

const completion = (message: Record<string, unknown>, usage: Record<string, unknown> | null) =>
  Response.json({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    model: "fixture",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  });
// The exact production shape.
const reasoningOnly = () =>
  completion(
    { role: "assistant", content: null, refusal: null, reasoning_content: REASONING_378 },
    {
      prompt_tokens: 8496,
      completion_tokens: 191,
      completion_tokens_details: { reasoning_tokens: 190 },
    }
  );
const emptyContent = () =>
  completion({ role: "assistant", content: "" }, { prompt_tokens: 10, completion_tokens: 3 });
const answer = (text = "second target answer") =>
  completion({ role: "assistant", content: text }, { prompt_tokens: 10, completion_tokens: 4 });

const messages13 = () =>
  Array.from({ length: 13 }, (_, i) => ({
    role: i < 2 ? "system" : i % 2 ? "assistant" : "user",
    content: `fixture message ${i}`,
  }));
const plainBody = (extra: Record<string, unknown> = {}) => ({
  model: "cammy-route",
  messages: messages13(),
  max_tokens: 2024,
  temperature: 0.7,
  stream: false,
  ...extra,
});

const A = "nvidia/mistralai/mistral-large-4-1t-a52b";
const B = "openai/gpt-4o";
const C = "anthropic/claude-sonnet-4";
let seq = 0;
type Handler = (body: Record<string, unknown>, model: string) => Promise<Response>;
type OptsOverrides = {
  body?: Record<string, unknown>;
  models?: string[];
  strategy?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
};
function opts(handler: unknown, o: OptsOverrides = {}) {
  const { body, models = [A, B], strategy = "priority", config = {}, ...rest } = o;
  return {
    body: body ?? plainBody(),
    combo: {
      name: `reasoning-failover-${seq++}`,
      strategy,
      models: models.map((model) => ({ model })),
      config: {
        maxRetries: 0,
        maxSetRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        disableSessionStickiness: true,
        reasoningTokenBufferEnabled: false,
        ...config,
      },
    },
    handleSingleModel: handler,
    isModelAvailable: async () => true,
    log,
    settings: {},
    ...rest,
  };
}
// Records every upstream dispatch; `script` maps (callIndex, model) to a Response.
function recorder(script: (n: number, model: string) => Response) {
  const calls: { model: string; body: Record<string, unknown> }[] = [];
  const handler: Handler = async (b, model) => {
    calls.push({ model, body: structuredClone(b) });
    return script(calls.length, model);
  };
  return { calls, handler };
}
const errCode = async (res: Response) => (await res.clone().json())?.error?.code;

test.beforeEach(() => {
  resetAllCircuitBreakers();
  clearCooldownState();
  clearAllModelLockouts();
  networkAttempts = 0;
  warns = [];
  chain = [];
});
test.afterEach(() => assert.equal(networkAttempts, 0, "no real network permitted"));
test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  dbCore.resetDbInstance?.();
  globalThis.fetch = originalFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("(a) production shape: reasoning-only 200 fails over once; client gets the second target's 200", async () => {
  const r = recorder((n) => (n === 1 ? reasoningOnly() : answer()));
  const res = await handleComboChat(opts(r.handler));
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 200));
  assert.match(text, /second target answer/);
  assert.ok(!text.includes(REASONING_SENTINEL), "withheld first body must never reach the client");
  assert.deepEqual(
    r.calls.map((c) => c.model),
    [A, B]
  );
  const strip = ({ model: _m, ...rest }: Record<string, unknown>) => rest;
  assert.deepEqual(strip(r.calls[1].body), strip(r.calls[0].body), "identical request body");
  assert.equal(r.calls[0].body.messages.length, 13);
  assert.equal(r.calls[1].body.stream, false);
  assert.equal(isRoutingTerminal(res), true, "committed success is the guard's terminal outcome");
});

test("(a2) empty visible content (content '') also fails over once", async () => {
  const r = recorder((n) => (n === 1 ? emptyContent() : answer()));
  const res = await handleComboChat(opts(r.handler));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /second target answer/);
  assert.equal(r.calls.length, 2);
});

test("(b) second target also reasoning-only: 502 response_contract_failed after exactly 2 calls", async () => {
  const r = recorder(() => reasoningOnly());
  const res = await handleComboChat(opts(r.handler, { models: [A, B, C] }));
  assert.equal(res.status, 502);
  assert.equal(await errCode(res), "response_contract_failed");
  assert.equal(r.calls.length, 2, "one quality failover only; the third target is never tried");
  assert.equal(isRoutingTerminal(res), true);
  assert.ok(!(await res.text()).includes(REASONING_SENTINEL));
});

test("(c) same shape WITH tools in the request: unchanged 502, calls=1", async () => {
  const tools = [
    { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
  ];
  const r = recorder(() => reasoningOnly());
  const res = await handleComboChat(opts(r.handler, { body: plainBody({ tools }) }));
  assert.equal(res.status, 502);
  assert.equal(await errCode(res), "response_contract_failed");
  assert.equal(r.calls.length, 1);
});

test("(c2) tool history in messages, tool_choice or legacy functions also keep the 502", async () => {
  for (const extra of [
    { tool_choice: "auto" },
    { functions: [{ name: "f", parameters: { type: "object" } }] },
    {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function" }] },
        { role: "tool", tool_call_id: "1", content: "result" },
        { role: "user", content: "continue" },
      ],
    },
  ]) {
    const r = recorder(() => reasoningOnly());
    const res = await handleComboChat(opts(r.handler, { body: plainBody(extra) }));
    assert.equal(res.status, 502, JSON.stringify(Object.keys(extra)));
    assert.equal(await errCode(res), "response_contract_failed");
    assert.equal(r.calls.length, 1, JSON.stringify(Object.keys(extra)));
  }
});

test("(d) provider-bound request (previous_response_id / encrypted reasoning): unchanged 502", async () => {
  for (const extra of [
    { previous_response_id: "resp_fixture" },
    {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "x", encrypted_content: "opaque" },
        { role: "user", content: "continue" },
      ],
    },
  ]) {
    const r = recorder(() => reasoningOnly());
    const res = await handleComboChat(opts(r.handler, { body: plainBody(extra) }));
    assert.equal(res.status, 502, JSON.stringify(Object.keys(extra)));
    assert.equal(await errCode(res), "response_contract_failed");
    assert.equal(r.calls.length, 1, JSON.stringify(Object.keys(extra)));
  }
});

test("(e) stream:true request never takes the quality failover (single dispatch)", async () => {
  const r = recorder(() => reasoningOnly());
  const res = await handleComboChat(opts(r.handler, { body: plainBody({ stream: true }) }));
  await res.text();
  assert.equal(r.calls.length, 1, "no second dispatch for a streaming request");
  assert.ok(chain.every((e) => e.event !== "quality_failover"));
});

test("(f) other quality reasons behave exactly as before (502, calls=1)", async () => {
  const shapes: Record<string, () => Response> = {
    "unrecognized envelope": () => Response.json({ unexpected: "fixture" }),
    "error envelope in a 200": () => Response.json({ error: { message: "upstream said no" } }),
    "empty choices": () => Response.json({ choices: [] }),
    "choice without message": () => Response.json({ choices: [{ index: 0 }] }),
    "empty body": () =>
      new Response("", { status: 200, headers: { "content-type": "application/json" } }),
  };
  for (const [name, make] of Object.entries(shapes)) {
    const r = recorder(() => make());
    const res = await handleComboChat(opts(r.handler));
    assert.equal(res.status, 502, name);
    assert.equal(await errCode(res), "response_contract_failed", name);
    assert.equal(r.calls.length, 1, name);
  }
});

test("(g) control: reasoning 60% of completion with null content still forwards the 200", async () => {
  const r = recorder(() =>
    completion(
      { role: "assistant", content: null, reasoning_content: "r" },
      {
        prompt_tokens: 1,
        completion_tokens: 200,
        completion_tokens_details: { reasoning_tokens: 120 },
      }
    )
  );
  const res = await handleComboChat(opts(r.handler));
  assert.equal(res.status, 200);
  assert.equal(r.calls.length, 1);
  assert.equal(warns.length, 0);
});

test("(h) control: tool_calls plus reasoning at 99% still forwards the 200", async () => {
  const r = recorder(() =>
    completion(
      {
        role: "assistant",
        content: null,
        reasoning_content: "r",
        tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      {
        prompt_tokens: 1,
        completion_tokens: 200,
        completion_tokens_details: { reasoning_tokens: 199 },
      }
    )
  );
  const res = await handleComboChat(opts(r.handler));
  assert.equal(res.status, 200);
  assert.equal(r.calls.length, 1);
});

test("(i) attempt budget limit:1 yields the budget error, never a second dispatch", async () => {
  const r = recorder(() => reasoningOnly());
  const body = plainBody();
  const guard = createRoutingAttemptGuard({ body, limit: 1, emit: (e) => chain.push(e) });
  const res = await handleComboChat(opts(guard.wrap(r.handler), { body }));
  assert.equal(r.calls.length, 1, "the budget forbids the failover dispatch");
  assert.equal(res.status, 503);
  assert.equal(await errCode(res), "routing_attempt_limit");
});

test("(j) round-robin combo gets the same failover", async () => {
  const r = recorder((n) => (n === 1 ? reasoningOnly() : answer()));
  const res = await handleComboChat(opts(r.handler, { strategy: "round-robin" }));
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 200));
  assert.match(text, /second target answer/);
  assert.ok(!text.includes(REASONING_SENTINEL));
  assert.equal(r.calls.length, 2);
  assert.notEqual(r.calls[0].model, r.calls[1].model);
});

test("(j2) round-robin: second reasoning-only reply is the same 502 after 2 calls", async () => {
  const r = recorder(() => reasoningOnly());
  const res = await handleComboChat(
    opts(r.handler, { strategy: "round-robin", models: [A, B, C] })
  );
  assert.equal(res.status, 502);
  assert.equal(await errCode(res), "response_contract_failed");
  assert.equal(r.calls.length, 2);
});

test("(j3) round-robin: tools keep the 502 with one call", async () => {
  const tools = [
    { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
  ];
  const r = recorder(() => reasoningOnly());
  const res = await handleComboChat(
    opts(r.handler, { strategy: "round-robin", body: plainBody({ tools }) })
  );
  assert.equal(res.status, 502);
  assert.equal(await errCode(res), "response_contract_failed");
  assert.equal(r.calls.length, 1);
});

test("(k) log.warn names the reason, model, finish_reason and token counts; never content", async () => {
  for (const strategy of ["priority", "round-robin"]) {
    warns = [];
    chain = [];
    const r = recorder((n) => (n === 1 ? reasoningOnly() : answer()));
    const res = await handleComboChat(opts(r.handler, { strategy }));
    assert.equal(res.status, 200);
    await res.text();
    const line = warns.find((w) => /quality/i.test(w));
    assert.ok(line, `${strategy}: expected a quality warn, got ${JSON.stringify(warns)}`);
    assert.match(line, /reasoning_exhausted/);
    assert.ok(line.includes(`model=${r.calls[0].model}`), line);
    assert.match(line, /finish_reason=stop/);
    assert.match(line, /completion_tokens=191/);
    assert.match(line, /reasoning_tokens=190/);
    assert.match(line, /failover/i);
    for (const w of warns) {
      assert.ok(!w.includes(REASONING_SENTINEL), "no response content in the log");
      assert.ok(!w.includes("fixture message"), "no request content in the log");
    }
    const events = chain.map((e) => e.event);
    assert.ok(events.includes("quality_rejected"), JSON.stringify(events));
    assert.ok(events.includes("quality_failover"), JSON.stringify(events));
    const rejected = chain.find((e) => e.event === "quality_rejected");
    assert.equal(rejected.reason, "reasoning_exhausted");
    assert.equal(rejected.model, r.calls[0].model);
  }
});

test("(k2) the still-502 paths also warn and emit a rejection event", async () => {
  const tools = [
    { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
  ];
  for (const strategy of ["priority", "round-robin"]) {
    warns = [];
    chain = [];
    const r = recorder(() => reasoningOnly());
    const res = await handleComboChat(opts(r.handler, { strategy, body: plainBody({ tools }) }));
    assert.equal(res.status, 502);
    const line = warns.find((w) => /quality/i.test(w));
    assert.ok(line, `${strategy}: expected a quality warn, got ${JSON.stringify(warns)}`);
    assert.match(line, /reasoning_exhausted/);
    assert.match(line, /no failover|denied/i);
    for (const w of warns) assert.ok(!w.includes(REASONING_SENTINEL));
    assert.ok(chain.some((e) => e.event === "quality_rejected"));
    assert.ok(chain.some((e) => e.event === "quality_failover_denied" && e.code === "tools"));
  }
});

test("(k3) a non-content-shape rejection logs a reason class without upstream text", async () => {
  const r = recorder(() => Response.json({ error: { message: "SECRET_UPSTREAM_TEXT" } }));
  const res = await handleComboChat(opts(r.handler));
  assert.equal(res.status, 502);
  assert.ok(warns.some((w) => /quality/i.test(w)));
  for (const w of warns) assert.ok(!w.includes("SECRET_UPSTREAM_TEXT"), w);
});

test("(l) single-target combo with one reasoning-only reply: 502 as before, warn logged", async () => {
  for (const strategy of ["priority", "round-robin"]) {
    warns = [];
    const r = recorder(() => reasoningOnly());
    const res = await handleComboChat(opts(r.handler, { strategy, models: [A] }));
    assert.equal(res.status, 502, strategy);
    assert.equal(await errCode(res), "response_contract_failed", strategy);
    assert.equal(r.calls.length, 1, strategy);
    assert.ok(
      warns.some((w) => /quality/i.test(w)),
      strategy
    );
    assert.equal(isRoutingTerminal(res), true, strategy);
  }
});

test("(m) the rejected target is never retried, including across a set retry", async () => {
  const r = recorder((n, model) => (model === A ? reasoningOnly() : completion({}, null)));
  const res = await handleComboChat(
    opts(r.handler, { models: [A, B], config: { maxSetRetries: 1 } })
  );
  await res.text();
  assert.equal(
    r.calls.filter((c) => c.model === A).length,
    1,
    "the quality-rejected [model, connection] must not be dispatched again"
  );
  assert.notEqual(res.status, 200);
});

test("(n) caller body is not mutated by the failover", async () => {
  const body = plainBody();
  const before = structuredClone(body);
  const r = recorder((n) => (n === 1 ? reasoningOnly() : answer()));
  const res = await handleComboChat(opts(r.handler, { body }));
  assert.equal(res.status, 200);
  await res.text();
  assert.deepEqual(body, before);
});

test("(o) quality failover is allowed once even if a later target fails with a transport error", async () => {
  const r = recorder((n) =>
    n === 1
      ? reasoningOnly()
      : Response.json({ error: { message: "rate limited", code: "rate_limited" } }, { status: 429 })
  );
  const res = await handleComboChat(opts(r.handler, { models: [A, B] }));
  assert.equal(r.calls.length, 2);
  assert.notEqual(res.status, 200);
  assert.equal(isRoutingTerminal(res), true);
});

// ---------------------------------------------------------------------------------------------
// Fix round: replay-unsafe request surface (F1)
// ---------------------------------------------------------------------------------------------
const FN_TOOL = { type: "function", function: { name: "lookup", parameters: { type: "object" } } };
const UNSAFE: Record<string, Record<string, unknown>> = {
  "top-level mcp_servers": {
    mcp_servers: [{ type: "url", url: "https://example.test", name: "n" }],
  },
  "top-level tool_resources": { tool_resources: { file_search: { vector_store_ids: ["v"] } } },
  "top-level tool_config": { tool_config: { function_calling_config: { mode: "ANY" } } },
  "top-level toolConfig": { toolConfig: { functionCallingConfig: { mode: "ANY" } } },
  "top-level web_search_options": { web_search_options: {} },
  "top-level parallel_tool_calls": { parallel_tool_calls: true },
  "top-level parallel_tool_calls false": { parallel_tool_calls: false },
  "top-level tool_choice": { tool_choice: "auto" },
  "top-level function_call": { function_call: "auto" },
  "top-level legacy functions": { functions: [{ name: "f", parameters: { type: "object" } }] },
  "tools: function": { tools: [FN_TOOL] },
  "tools: responses mcp": {
    tools: [{ type: "mcp", server_label: "s", server_url: "https://x.test" }],
  },
  "tools: responses web_search": { tools: [{ type: "web_search" }] },
  "tools: responses file_search": { tools: [{ type: "file_search", vector_store_ids: ["v"] }] },
  "tools: responses code_interpreter": {
    tools: [{ type: "code_interpreter", container: { type: "auto" } }],
  },
  "tools: responses computer_use": { tools: [{ type: "computer_use_preview" }] },
  "tools: anthropic server tool": { tools: [{ type: "web_search_20250305", name: "web_search" }] },
  "tools: gemini declarations": { tools: [{ functionDeclarations: [{ name: "x" }] }] },
  "tools: gemini googleSearch": { tools: [{ googleSearch: {} }] },
  "history: tool_use": {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "x", input: {} }] },
    ],
  },
  "history: tool_result": {
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "r" }] },
    ],
  },
  "history: server_tool_use": {
    messages: [
      {
        role: "assistant",
        content: [{ type: "server_tool_use", id: "1", name: "web_search", input: {} }],
      },
    ],
  },
  "history: mcp_tool_use": {
    messages: [
      {
        role: "assistant",
        content: [{ type: "mcp_tool_use", id: "1", name: "x", server_name: "s" }],
      },
    ],
  },
  "history: web_search_tool_result": {
    messages: [{ role: "user", content: [{ type: "web_search_tool_result", tool_use_id: "1" }] }],
  },
  "history: function_call item": { input: [{ type: "function_call", name: "x", arguments: "{}" }] },
  "history: function_call_output item": { input: [{ type: "function_call_output", output: "x" }] },
  "history: local_shell_call": { input: [{ type: "local_shell_call", id: "1", action: {} }] },
  "history: local_shell_call_output": { input: [{ type: "local_shell_call_output", output: "x" }] },
  "history: custom_tool_call": { input: [{ type: "custom_tool_call", name: "p", input: "x" }] },
  "history: custom_tool_call_output": { input: [{ type: "custom_tool_call_output", output: "x" }] },
  "history: image_generation_call": { input: [{ type: "image_generation_call", id: "1" }] },
  "history: computer_call": { input: [{ type: "computer_call", action: {} }] },
  "history: mcp_call": { input: [{ type: "mcp_call", name: "x" }] },
  "history: web_search_call": { input: [{ type: "web_search_call", id: "1" }] },
  "history: assistant tool_calls": {
    messages: [{ role: "assistant", content: null, tool_calls: [{ id: "1", type: "function" }] }],
  },
  "history: role tool": { messages: [{ role: "tool", tool_call_id: "1", content: "r" }] },
  "history: assistant function_call": {
    messages: [{ role: "assistant", content: "x", function_call: { name: "f" } }],
  },
  "history: gemini functionCall": {
    contents: [{ role: "model", parts: [{ functionCall: { name: "x", args: {} } }] }],
  },
  "history: gemini functionResponse": {
    contents: [{ role: "user", parts: [{ functionResponse: { name: "x", response: {} } }] }],
  },
};
for (const [name, extra] of Object.entries(UNSAFE)) {
  test(`(F1) replay-unsafe request surface denies the failover: ${name}`, async () => {
    const body = plainBody(extra);
    assert.equal(isQualityFailoverReplayUnsafe(body), true);
    chain = [];
    const r = recorder(() => reasoningOnly());
    const res = await handleComboChat(opts(r.handler, { body }));
    assert.equal(res.status, 502);
    assert.equal(await errCode(res), "response_contract_failed");
    assert.equal(r.calls.length, 1, "no second dispatch");
    assert.ok(
      chain.some((e) => e.event === "quality_failover_denied" && e.code === "tools"),
      JSON.stringify(chain)
    );
  });
}
test("(F1) replay-safe surface is NOT over-denied: empty tools, null params, multimodal parts", async () => {
  const safe = [
    { tools: [] },
    { parallel_tool_calls: null },
    { tool_choice: null },
    { functions: [] },
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "https://example.test/i.png" } },
          ],
        },
      ],
    },
    { metadata: { note: "tool_use is only a word here" } },
  ];
  for (const extra of safe) {
    assert.equal(isQualityFailoverReplayUnsafe(plainBody(extra)), false, JSON.stringify(extra));
    const r = recorder((n) => (n === 1 ? reasoningOnly() : answer()));
    const res = await handleComboChat(opts(r.handler, { body: plainBody(extra) }));
    assert.equal(res.status, 200, JSON.stringify(extra));
    assert.equal(r.calls.length, 2, JSON.stringify(extra));
    await res.text();
  }
});

// ---------------------------------------------------------------------------------------------
// Fix round: streaming denial (F4 e)
// ---------------------------------------------------------------------------------------------
const sseReasoningOnly = () =>
  new Response(
    `data: ${JSON.stringify({
      id: "c",
      object: "chat.completion.chunk",
      choices: [
        { index: 0, delta: { role: "assistant", reasoning_content: "r" }, finish_reason: null },
      ],
    })}\n\n` +
      `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 191,
          completion_tokens_details: { reasoning_tokens: 190 },
        },
      })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
test("(e2) stream:true with an SSE upstream: exactly one dispatch, no quality failover", async () => {
  for (const strategy of ["priority", "round-robin"]) {
    chain = [];
    const r = recorder(() => sseReasoningOnly());
    const res = await handleComboChat(
      opts(r.handler, { strategy, body: plainBody({ stream: true }) })
    );
    await res.text();
    assert.equal(r.calls.length, 1, strategy);
    assert.ok(
      chain.every((e) => e.event !== "quality_failover"),
      strategy
    );
  }
});
test('(e3) truthy non-boolean stream values ("true", 1) never take the failover', async () => {
  for (const stream of ["true", 1]) {
    for (const strategy of ["priority", "round-robin"]) {
      chain = [];
      const r = recorder(() => reasoningOnly());
      const res = await handleComboChat(opts(r.handler, { strategy, body: plainBody({ stream }) }));
      assert.equal(res.status, 502, `${strategy} ${String(stream)}`);
      assert.equal(await errCode(res), "response_contract_failed");
      assert.equal(r.calls.length, 1, `${strategy} ${String(stream)}`);
      assert.ok(
        chain.some((e) => e.event === "quality_failover_denied" && e.code === "stream"),
        JSON.stringify(chain)
      );
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Fix round: guard-level contract (F2, F4, F5)
// ---------------------------------------------------------------------------------------------
const rejection = (extra: Record<string, unknown> = {}) => ({
  code: "reasoning_exhausted",
  reason: "reasoning consumed 190/191 tokens",
  ...extra,
});
function guardWith(body: Record<string, unknown>, guardOptions: Record<string, unknown> = {}) {
  const events: Record<string, unknown>[] = [];
  const guard = createRoutingAttemptGuard({
    body,
    limit: 10,
    emit: (e) => events.push(e),
    ...guardOptions,
  });
  const dispatched: string[] = [];
  const responses: Record<string, () => Response> = {};
  const wrapped = guard.wrap(async (_b, model, target) => {
    dispatched.push(`${model}@${(target as { connectionId?: string })?.connectionId ?? ""}`);
    return (responses[model] ?? (() => answer()))();
  });
  const send = (model: string, connectionId?: string) => wrapped(body, model, { connectionId });
  return { guard, events, dispatched, responses, send };
}
const denialOf = (events: Record<string, unknown>[]) =>
  events.find((e) => e.event === "quality_failover_denied")?.code;

test("(G1) nested guards (sharedBudget or hooks) are denied with nested_guard", async () => {
  const variants: Record<string, Record<string, unknown>> = {
    hooks: { hooks: {} },
    sharedBudget: { sharedBudget: { startedAt: Date.now(), attempts: 0, limit: 10 } },
  };
  for (const [name, guardOptions] of Object.entries(variants)) {
    const g = guardWith(plainBody(), guardOptions);
    const committed = await g.send(A);
    const verdict = g.guard.rejectCommittedForQuality(committed, rejection());
    assert.equal(verdict.failover, false, name);
    assert.equal(denialOf(g.events), "nested_guard", name);
  }
});
test("(G2) body.stream alone and quality.stream alone each deny; neither admits", async () => {
  const bodyOnly = guardWith(plainBody({ stream: "true" }));
  let committed = await bodyOnly.send(A);
  assert.equal(
    bodyOnly.guard.rejectCommittedForQuality(committed, rejection({ stream: false })).failover,
    false
  );
  assert.equal(denialOf(bodyOnly.events), "stream");

  const callerOnly = guardWith(plainBody());
  committed = await callerOnly.send(A);
  assert.equal(
    callerOnly.guard.rejectCommittedForQuality(committed, rejection({ stream: true })).failover,
    false
  );
  assert.equal(denialOf(callerOnly.events), "stream");

  const neither = guardWith(plainBody());
  committed = await neither.send(A);
  assert.equal(
    neither.guard.rejectCommittedForQuality(committed, rejection({ stream: false })).failover,
    true
  );
});
test("(G3) the failover is spent once: a second quality rejection is already_used", async () => {
  const g = guardWith(plainBody());
  let committed = await g.send(A);
  assert.equal(g.guard.rejectCommittedForQuality(committed, rejection()).failover, true);
  committed = await g.send(B);
  const second = g.guard.rejectCommittedForQuality(committed, rejection());
  assert.equal(second.failover, false);
  assert.equal(denialOf(g.events), "already_used");
});
test("(G4) rejecting without a committed response of this guard is denied", async () => {
  const g = guardWith(plainBody());
  const verdict = g.guard.rejectCommittedForQuality(answer(), rejection());
  assert.equal(verdict.failover, false);
  assert.equal(denialOf(g.events), "not_committed_here");
  assert.equal(g.dispatched.length, 0);
});
test("(G5) a non-content-shape code is denied with reason_not_content_shape", async () => {
  const g = guardWith(plainBody());
  const committed = await g.send(A);
  const verdict = g.guard.rejectCommittedForQuality(committed, {
    reason: "unrecognized_response_envelope",
  });
  assert.equal(verdict.failover, false);
  assert.equal(denialOf(g.events), "reason_not_content_shape");
});
test("(G6) the quality-rejected MODEL is not re-dispatched on any connection; others still are", async () => {
  const g = guardWith(plainBody());
  const committed = await g.send(A, "conn-1");
  assert.equal(g.guard.rejectCommittedForQuality(committed, rejection()).failover, true);
  g.dispatched.length = 0;

  const sameModelOtherConnection = await g.send(A, "conn-2");
  const sameModelSameConnection = await g.send(A, "conn-1");
  for (const r of [sameModelOtherConnection, sameModelSameConnection]) {
    assert.equal(r.status, 400);
    assert.equal(await errCode(r), "account_model_ineligible");
  }
  assert.deepEqual(g.dispatched, [], "rejected model never reaches the upstream handler");

  const other = await g.send(B, "conn-1");
  assert.equal(other.status, 200);
  assert.deepEqual(g.dispatched, [`${B}@conn-1`]);
});
test("(G7) the withheld committed body is cancelled", async () => {
  let cancelled = false;
  const g = guardWith(plainBody());
  g.responses[A] = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const committed = await g.send(A);
  assert.equal(cancelled, false);
  assert.equal(g.guard.rejectCommittedForQuality(committed, rejection()).failover, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true, "withheld first body must be released, not leaked");
});
test("(G8) exhausted failover cancels the later target's failure body and returns the 502", async () => {
  const g = guardWith(plainBody());
  g.responses[B] = () =>
    Response.json({ error: { code: "rate_limited", message: "slow down" } }, { status: 429 });
  const committed = await g.send(A);
  assert.equal(g.guard.rejectCommittedForQuality(committed, rejection()).failover, true);
  const later = await g.send(B);
  assert.equal(later.status, 429, "the guard lets the combo see the later failure first");
  const exhausted = g.guard.qualityFailoverExhausted();
  assert.equal(exhausted?.status, 502);
  assert.equal(await errCode(exhausted!), "response_contract_failed");
  // A cancelled body reads as empty; an un-cancelled one would still hold the JSON.
  const leftover = await later.text().catch(() => "");
  assert.equal(leftover, "", "the unused 429 body must be cancelled");
  assert.equal(g.guard.qualityFailoverExhausted(), null, "idempotent once stopped");
});
test("(G9) qualityFailoverExhausted is null when no failover was spent", async () => {
  const g = guardWith(plainBody());
  assert.equal(g.guard.qualityFailoverExhausted(), null);
  await g.send(A);
  assert.equal(g.guard.qualityFailoverExhausted(), null);
});

// F3 outcome table, pinned.
test("(F3) outcomes after a spent failover: 429/5xx end as 502, 400/401/403/404 pass through", async () => {
  const table: [number, number, string][] = [
    [429, 502, "response_contract_failed"],
    [503, 502, "response_contract_failed"],
    [404, 404, ""],
    [400, 400, ""],
    [401, 401, ""],
    [403, 403, ""],
  ];
  for (const [status, expected, code] of table) {
    const r = recorder((n) =>
      n === 1
        ? reasoningOnly()
        : Response.json({ error: { message: "later failure", code: "later" } }, { status })
    );
    const res = await handleComboChat(opts(r.handler));
    assert.equal(r.calls.length, 2, String(status));
    assert.equal(res.status, expected, String(status));
    if (code) assert.equal(await errCode(res), code, String(status));
    assert.equal(isRoutingTerminal(res), true, String(status));
  }
});
test("(F3) a thrown error after a spent failover is execution_uncertain", async () => {
  const r = recorder((n) => {
    if (n === 1) return reasoningOnly();
    throw new Error("socket hang up");
  });
  const res = await handleComboChat(opts(r.handler));
  assert.equal(res.status, 502);
  assert.equal(await errCode(res), "execution_uncertain");
});
test("(F3) abort after a spent failover is 499", async () => {
  const controller = new AbortController();
  const r = recorder((n) => {
    if (n === 1) return reasoningOnly();
    controller.abort();
    return answer();
  });
  const res = await handleComboChat(opts(r.handler, { signal: controller.signal })).catch((e) => e);
  if (res instanceof Response) assert.equal(res.status, 499);
  else assert.equal(res?.name, "AbortError");
});

test("(F1) the quality-failover predicate is a superset of inspectReplayInput.hasTools", () => {
  for (const [name, extra] of Object.entries(UNSAFE)) {
    const body = plainBody(extra);
    if (inspectReplayInput(body).hasTools)
      assert.equal(isQualityFailoverReplayUnsafe(body), true, name);
  }
  assert.equal(inspectReplayInput(plainBody()).hasTools, false);
  assert.equal(isQualityFailoverReplayUnsafe(plainBody()), false);
});
test("(G10) a denied rejection still cancels the committed body it was handed", async () => {
  let cancelled = false;
  const g = guardWith(plainBody({ tools: [FN_TOOL] }));
  g.responses[A] = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const committed = await g.send(A);
  const verdict = g.guard.rejectCommittedForQuality(committed, rejection());
  assert.equal(verdict.failover, false);
  assert.equal(denialOf(g.events), "tools");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
test("(F2b) a guarded quality failover does not lock the model out for other traffic", async () => {
  clearAllModelLockouts();
  const r = recorder((n) => (n === 1 ? reasoningOnly() : answer()));
  const res = await handleComboChat(
    opts(r.handler, {
      settings: { modelLockout: { enabled: true, errorCodes: [502], baseCooldownMs: 60_000 } },
    })
  );
  assert.equal(res.status, 200);
  await res.text();
  assert.deepEqual(
    getAllModelLockouts().filter((l) => JSON.stringify(l).includes("mistral-large-4")),
    []
  );
});
