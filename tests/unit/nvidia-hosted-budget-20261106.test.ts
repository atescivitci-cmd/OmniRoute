import test from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { normalizeNvidiaHostedReasoningBudget } from "../../open-sse/executors/base/reasoningEffort.ts";
import { noThinkingIntent } from "../../open-sse/services/reasoningEffortCompatibility.ts";
const MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const base = {
  model: MODEL,
  messages: [{ role: "user", content: "Analyze the quoted rate" }],
  max_tokens: 2000,
  response_format: {
    type: "json_schema",
    json_schema: { name: "rate", schema: { type: "object" } },
  },
};
const exec = new DefaultExecutor("nvidia");

test("actual hosted low wire uses documented reasoning_budget and never self-hosted field", async () => {
  const old = globalThis.fetch;
  let wire: any;
  let url: string = "";
  try {
    globalThis.fetch = async (input, init) => {
      url = String(input);
      wire = JSON.parse(String(init?.body));
      return new Response("{}");
    };
    await exec.execute({
      model: MODEL,
      body: { ...base, reasoning_effort: "low" },
      stream: false,
      credentials: { apiKey: "offline-only" },
    });
    assert.equal(url, URL);
    assert.equal(wire.reasoning_budget, 400);
    assert.equal(wire.thinking_token_budget, undefined);
    assert.equal(wire.max_tokens, 2000);
    assert.deepEqual(wire.chat_template_kwargs, { enable_thinking: true });
  } finally {
    globalThis.fetch = old;
  }
});

test("None stays thinking off without adding either budget", () => {
  const out = exec.transformRequest(MODEL, { ...base, reasoning_effort: "none" }, false, {}) as any;
  assert.deepEqual(out.chat_template_kwargs, { enable_thinking: false });
  assert.equal(out.reasoning_budget, undefined);
  assert.equal(out.thinking_token_budget, undefined);
});

test("hosted mapping is exact model/provider/resolved endpoint only", () => {
  const input = { thinking_token_budget: 400 };
  assert.deepEqual(normalizeNvidiaHostedReasoningBudget(input, "nvidia", MODEL, URL), {
    reasoning_budget: 400,
  });
  for (const [provider, model, url] of [
    ["openai", MODEL, URL],
    ["nvidia", "nvidia/nemotron-3-super-120b-a12b", URL],
    ["nvidia", MODEL, "http://127.0.0.1:8000/v1/chat/completions"],
    ["nvidia", MODEL, "https://integrate.api.nvidia.com.example.com/v1/chat/completions"],
    ["nvidia", MODEL, "https://integrate.api.nvidia.com/v1/other"],
  ])
    assert.equal(normalizeNvidiaHostedReasoningBudget(input, provider, model, url), input);
  const custom = exec.transformRequest(MODEL, { ...base, reasoning_effort: "low" }, false, {
    providerSpecificData: { baseUrl: "http://127.0.0.1:8000/v1" },
  }) as any;
  assert.equal(custom.thinking_token_budget, 400);
  assert.equal(custom.reasoning_budget, undefined);
});

test("explicit hosted top and backward-compatible nested budgets preserve native intent", () => {
  for (const budget of [-1, 0, 1, 125, 32768]) {
    const top = exec.transformRequest(
      MODEL,
      { ...base, reasoning_effort: "low", reasoning_budget: budget },
      false,
      {}
    ) as any;
    assert.equal(top.reasoning_budget, budget);
    assert.equal(top.thinking_token_budget, undefined);
    const nested = exec.transformRequest(
      MODEL,
      {
        ...base,
        chat_template_kwargs: {
          enable_thinking: true,
          reasoning_budget: budget,
          custom_flag: true,
        },
      },
      false,
      {}
    ) as any;
    assert.deepEqual(nested.chat_template_kwargs, {
      enable_thinking: true,
      reasoning_budget: budget,
      custom_flag: true,
    });
    assert.equal(nested.reasoning_budget, undefined);
    assert.equal(nested.thinking_token_budget, undefined);
  }
  const zero = exec.transformRequest(
    MODEL,
    { ...base, reasoning_effort: "none", reasoning_budget: 0 },
    false,
    {}
  ) as any;
  assert.equal(zero.reasoning_budget, 0);
  assert.deepEqual(zero.chat_template_kwargs, { enable_thinking: false });
  assert.equal(noThinkingIntent({ reasoning_effort: "none", reasoning_budget: 0 }).conflict, false);
});

test("conflicting, malformed or out-of-range hosted budgets fail before dispatch", async () => {
  const old = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return new Response("{}");
    };
    for (const controls of [
      { reasoning_budget: 1, chat_template_kwargs: { reasoning_budget: 2 } },
      { reasoning_budget: 20, thinking_token_budget: 21 },
      { reasoning_effort: "none", reasoning_budget: 1 },
      { reasoning_effort: "none", reasoning_budget: -1 },
      { reasoning_effort: "none", chat_template_kwargs: { reasoning_budget: 100 } },
      { reasoning_budget: -2 },
      { reasoning_budget: 32769 },
      { reasoning_budget: 1.1 },
      { reasoning_budget: "400" },
      { thinking_token_budget: 32769 },
    ]) {
      await assert.rejects(
        () =>
          exec.execute({
            model: MODEL,
            body: { ...base, ...controls },
            stream: false,
            credentials: { apiKey: "offline-only" },
          }),
        /NVIDIA Nemotron|Conflicting explicit reasoning controls/
      );
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = old;
  }
});

test("legacy explicit budget retains value when normalized for hosted transport", () => {
  const input = {
    ...base,
    thinking_token_budget: 125,
    chat_template_kwargs: { enable_thinking: true },
  };
  const out = exec.transformRequest(MODEL, input, false, {}) as any;
  assert.equal(out.reasoning_budget, 125);
  assert.equal(out.thinking_token_budget, undefined);
  assert.equal(input.thinking_token_budget, 125);
  const equivalent = exec.transformRequest(
    MODEL,
    {
      ...base,
      reasoning_budget: 125,
      thinking_token_budget: 125,
      chat_template_kwargs: { enable_thinking: true, reasoning_budget: 125 },
    },
    false,
    {}
  ) as any;
  assert.equal(equivalent.reasoning_budget, 125);
  assert.equal(equivalent.chat_template_kwargs.reasoning_budget, 125);
  assert.equal(equivalent.thinking_token_budget, undefined);
});

test("NVIDIA has one URL attempt and resolved endpoint does not vary by fallback index", () => {
  assert.equal(
    exec.getFallbackCount(),
    1,
    "a future heterogeneous fallback needs attempt-specific mapping"
  );
  assert.deepEqual(exec.getBaseUrls(), [URL]);
  for (const credentials of [
    {},
    { providerSpecificData: { baseUrl: "http://127.0.0.1:8000/v1" } },
  ]) {
    const resolved = exec.buildUrl(MODEL, false, 0, credentials);
    for (const index of [1, 2])
      assert.equal(exec.buildUrl(MODEL, false, index, credentials), resolved);
  }
});
