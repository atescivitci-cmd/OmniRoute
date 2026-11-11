import test from "node:test";
import assert from "node:assert/strict";
import {
  mapNvidiaGlm52ReasoningParams,
  sanitizeReasoningEffortForProvider,
} from "../../open-sse/executors/base/reasoningEffort.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
const model = "mistralai/mistral-large-4-1t-a52b";
const map = (body: any) => mapNvidiaGlm52ReasoningParams(body, "nvidia", model) as any;
const translate = (body: any) =>
  translateRequest("claude", "openai", model, structuredClone(body), false, null, "nvidia");
const user = { role: "user", content: "Use the echo tool." };
test.after(() => resetDbInstance());
test("exact hosted model retains native high/none and absent defaults", () => {
  for (const effort of ["high", "none"])
    assert.equal(map({ reasoning_effort: effort }).reasoning_effort, effort);
  const absent = { messages: [user] };
  assert.equal(map(absent), absent);
});
test("maps adaptive/enabled and ignored native switch to explicit supported intent without mutation", () => {
  for (const type of ["adaptive", "enabled"]) {
    const b = { thinking: { type }, output_config: { effort: "high" } };
    const before = structuredClone(b);
    assert.deepEqual(map(b), { reasoning_effort: "high" });
    assert.deepEqual(b, before);
  }
  assert.deepEqual(map({ thinking: { type: "disabled" } }), { reasoning_effort: "none" });
  assert.deepEqual(map({ chat_template_kwargs: { enable_thinking: true } }), {
    reasoning_effort: "high",
  });
  assert.deepEqual(map({ chat_template_kwargs: { enable_thinking: false } }), {
    reasoning_effort: "none",
  });
});
test("unsupported efforts, conflicts, malformed and unenforceable budgets fail closed", () => {
  for (const effort of ["low", "medium", "max", "xhigh", "minimal", "garbage"])
    assert.throws(() => map({ reasoning_effort: effort }), /unsupported reasoning effort/);
  for (const b of [
    { reasoning_effort: "none", thinking: { type: "adaptive" } },
    { reasoning_effort: "high", chat_template_kwargs: { enable_thinking: false } },
    { reasoning_effort: "high", output_config: { effort: "none" } },
  ])
    assert.throws(() => map(b), /conflicting/);
  for (const b of [
    { reasoning: null },
    { thinking: { type: "weird" } },
    { chat_template_kwargs: { enable_thinking: 1 } },
    { thinking: { type: "enabled", budget_tokens: 1024 } },
    { reasoning_budget: 100 },
  ])
    assert.throws(() => map(b));
});
test("exact provider/model scope does not alter neighboring or direct Mistral routes", () => {
  const body = { reasoning_effort: "low" };
  for (const [provider, id] of [
    ["mistral", model],
    ["nvidia", model + "-unknown"],
    ["openrouter", model],
  ])
    assert.equal(mapNvidiaGlm52ReasoningParams(body, provider, id), body);
});
test("Claude adaptive reasoning survives source conversion with and without explicit effort", () => {
  for (const body of [
    { thinking: { type: "adaptive" } },
    { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
  ]) {
    const result = translate({ model, messages: [user], max_tokens: 4096, ...body });
    assert.equal(result.reasoning_effort, "high");
  }
});
test("Claude prior reasoning and tool-result continuity remain intact", () => {
  const result = translate({
    model,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    messages: [
      user,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Actual prior reasoning." },
          { type: "tool_use", id: "call_echo", name: "echo", input: { text: "hello" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_echo", content: "fresh_result" }],
      },
    ],
  });
  const assistant = result.messages.find((x: any) => x.role === "assistant");
  assert.equal(assistant.reasoning_content, "Actual prior reasoning.");
  assert.equal(assistant.tool_calls[0].id, "call_echo");
  assert.equal(result.messages.find((x: any) => x.role === "tool").content, "fresh_result");
});
test("missing authentic reasoning is not replaced with a fabricated placeholder", () => {
  const result = translate({
    model,
    max_tokens: 4096,
    messages: [
      user,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "uncached_unique_test_call", name: "echo", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "uncached_unique_test_call",
            content: "fresh_result",
          },
        ],
      },
    ],
  });
  assert.equal(
    result.messages.find((x: any) => x.role === "assistant").reasoning_content,
    undefined
  );
});
test("final executor wire retains exact high, tools and genuine reasoning continuation", async () => {
  const old = globalThis.fetch;
  const wires: any[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      wires.push(JSON.parse(String(init?.body)));
      return new Response("{}");
    };
    const body = translate({
      model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: [
        {
          name: "echo",
          input_schema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
      messages: [
        user,
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Actual prior reasoning." },
            { type: "tool_use", id: "wire_echo", name: "echo", input: { text: "hello" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "wire_echo", content: "fresh_result" }],
        },
      ],
    });
    await new DefaultExecutor("nvidia").execute({
      model,
      body,
      stream: false,
      credentials: { apiKey: "offline-only" },
    });
    assert.equal(wires.length, 1);
    assert.equal(wires[0].reasoning_effort, "high");
    assert.equal(wires[0].chat_template_kwargs?.enable_thinking, undefined);
    assert.equal(
      wires[0].messages.find((x: any) => x.role === "assistant").reasoning_content,
      "Actual prior reasoning."
    );
    assert.equal(wires[0].tools.length, 1);
  } finally {
    globalThis.fetch = old;
  }
});
test("final sanitizer enforces exact supported effort rather than silently downgrading", () => {
  assert.throws(
    () => sanitizeReasoningEffortForProvider({ reasoning_effort: "low" }, "nvidia", model),
    /unsupported reasoning effort/
  );
  assert.equal(
    (sanitizeReasoningEffortForProvider({ reasoning_effort: "high" }, "nvidia", model) as any)
      .reasoning_effort,
    "high"
  );
});
