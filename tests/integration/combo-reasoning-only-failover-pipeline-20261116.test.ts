/**
 * Real-pipeline coverage for the QUALITY_FAILOVER_V1 reasoning-only failover
 * (handleChat -> combo -> routing guard -> handleSingleModelChat -> chatCore -> real executors,
 * only fetch mocked). Reproduces the 2026-11-16 incident shape: a plain, non-streaming chat
 * request answered by the first target with HTTP 200, message.content = null, a 378-char
 * reasoning_content and 190 of 191 completion tokens spent on reasoning. The stub-level unit
 * tests cannot see chatCore's response rewriting, so this drives the real upstream wire shape.
 *
 * The harness pins DATA_DIR to a throwaway temp dir; ~/.omniroute is never opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHeaders } from "../../open-sse/utils/headers.ts";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("combo-reasoning-only-failover-pipeline");
const { BaseExecutor, buildOpenAIResponse, buildRequest, combosDb, handleChat, resetStorage } =
  harness;
const { seedConnection, settingsDb } = harness;
assert.equal(process.env.DATA_DIR, harness.TEST_DATA_DIR, "DATA_DIR must be the harness temp dir");

const SENTINEL = "PIPELINE_REASONING_SENTINEL";
const REASONING = (SENTINEL + " ").repeat(14).slice(0, 378);

const reasoningOnly = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl_ro",
      object: "chat.completion",
      model: "gpt-4.1-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            reasoning_content: REASONING,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 8496,
        completion_tokens: 191,
        completion_tokens_details: { reasoning_tokens: 190 },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

type Body = { max_tokens?: number; messages: { role: string; content: string }[] };
const TOOLS = [
  {
    type: "function",
    function: { name: "lookup", parameters: { type: "object", properties: {} } },
  },
];

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
});
test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = harness.originalRetryDelayMs;
});
test.after(async () => {
  await harness.cleanup();
});

async function run(opts: { tools?: boolean; stream?: boolean; secondReasoningOnly?: boolean }) {
  await seedConnection("openai", { apiKey: "sk-openai-A" });
  await seedConnection("groq", { apiKey: "sk-groq-B" });
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  await combosDb.createCombo({
    name: "ro-combo",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["openai/gpt-4.1-mini", "groq/llama-3.3-70b-versatile"],
  });
  let a = 0;
  let b = 0;
  let aBody: Body | null = null;
  let bBody: Body | null = null;
  globalThis.fetch = (async (_url: unknown, init: { headers?: unknown; body?: unknown } = {}) => {
    const h = normalizeHeaders(init.headers as Parameters<typeof normalizeHeaders>[0]);
    const parsed = typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (h.authorization === "Bearer sk-openai-A") {
      a++;
      aBody = parsed;
      return reasoningOnly();
    }
    if (h.authorization === "Bearer sk-groq-B") {
      b++;
      bBody = parsed;
      return opts.secondReasoningOnly ? reasoningOnly() : buildOpenAIResponse("served by B");
    }
    throw new Error(`unexpected upstream call ${JSON.stringify(h)}`);
  }) as typeof fetch;

  const messages = Array.from({ length: 13 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `pipeline message ${i}`,
  }));
  messages.push({ role: "user", content: "final pipeline question" });
  const res = await handleChat(
    buildRequest({
      url: "http://localhost/v1/chat/completions",
      body: {
        model: "ro-combo",
        stream: opts.stream ?? false,
        max_tokens: 1024,
        messages,
        ...(opts.tools ? { tools: TOOLS } : {}),
      },
    })
  );
  const text = await res.text();
  return { res, text, a, b, aBody, bBody };
}

const userTexts = (body: Body | null): string[] =>
  (body?.messages ?? []).filter((m) => m.role === "user").map((m) => m.content);

test("pipeline: reasoning-only 200 from target A fails over; client receives target B's 200", async () => {
  const r = await run({});
  assert.equal(r.res.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /served by B/);
  assert.ok(!r.text.includes(SENTINEL), "withheld reasoning-only body must not reach the client");
  assert.equal(r.a, 1, "target A dispatched exactly once");
  assert.equal(r.b, 1, "target B dispatched exactly once");
  assert.deepEqual(userTexts(r.bBody), userTexts(r.aBody), "same conversation reaches B");
  assert.equal(r.bBody?.messages.length, r.aBody?.messages.length);
  assert.equal(r.bBody?.max_tokens, r.aBody?.max_tokens);
});

test("pipeline: both targets reasoning-only -> 502 response_contract_failed, 2 dispatches", async () => {
  const r = await run({ secondReasoningOnly: true });
  assert.equal(r.res.status, 502, r.text.slice(0, 300));
  assert.equal(JSON.parse(r.text).error.code, "response_contract_failed");
  assert.ok(!r.text.includes(SENTINEL));
  assert.equal(r.a, 1);
  assert.equal(r.b, 1);
});

test("pipeline: same shape with tools in the request keeps the 502 and never dispatches B", async () => {
  const r = await run({ tools: true });
  assert.equal(r.res.status, 502, r.text.slice(0, 300));
  assert.equal(JSON.parse(r.text).error.code, "response_contract_failed");
  assert.equal(r.a, 1);
  assert.equal(r.b, 0, "tool-bearing requests are never replayed after a committed 200");
});

// A reasoning-only reply is a property of the MODEL. With a model-free auto combo and several
// connections of one provider, the failover must move to a DIFFERENT model, never the same model
// on the sibling connection.
for (const connections of [1, 2]) {
  for (const cfg of [{}, { fitFirstFree: { enabled: true } }]) {
    test(`pipeline: auto combo, ${connections} groq connection(s) ${JSON.stringify(cfg)}: failover picks a different model`, async () => {
      await seedConnection("groq", { apiKey: "sk-groq-1", name: "g1", priority: 1 });
      if (connections === 2)
        await seedConnection("groq", { apiKey: "sk-groq-2", name: "g2", priority: 2 });
      await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
      await combosDb.createCombo({
        name: "auto-ro",
        strategy: "auto",
        models: [],
        allowedProviders: ["groq"],
        config: { maxRetries: 0, retryDelayMs: 0, ...cfg },
      });
      const seen: { key: string; model: string }[] = [];
      globalThis.fetch = (async (
        _url: unknown,
        init: { headers?: unknown; body?: unknown } = {}
      ) => {
        const h = normalizeHeaders(init.headers as Parameters<typeof normalizeHeaders>[0]);
        const parsed = typeof init.body === "string" ? JSON.parse(init.body) : {};
        seen.push({ key: String(h.authorization), model: String(parsed.model) });
        return seen.length === 1 ? reasoningOnly() : buildOpenAIResponse("served by next model");
      }) as typeof fetch;
      const res = await handleChat(
        buildRequest({
          url: "http://localhost/v1/chat/completions",
          body: {
            model: "auto-ro",
            stream: false,
            max_tokens: 512,
            messages: [{ role: "user", content: "hello" }],
          },
        })
      );
      const text = await res.text();
      assert.equal(res.status, 200, text.slice(0, 200));
      assert.match(text, /served by next model/);
      assert.equal(seen.length, 2, JSON.stringify(seen));
      assert.notEqual(
        seen[1].model,
        seen[0].model,
        `must not re-send the same model: ${JSON.stringify(seen)}`
      );
    });
  }
}
