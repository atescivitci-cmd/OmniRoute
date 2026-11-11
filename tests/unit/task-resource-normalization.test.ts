import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask, getTaskSignals } from "../../open-sse/services/taskAwareRouting.ts";

const small = { messages: [{ role: "user", content: "Reply only: OK" }], max_tokens: 512 };

for (const dialect of ["messages", "input", "contents", "nested-contents"] as const) {
  test(`counts eight ${dialect} messages once`, () => {
    const messages = Array.from({ length: 8 }, () => ({ role: "user", content: "synthetic" }));
    const body =
      dialect === "nested-contents" ? { request: { contents: messages } } : { [dialect]: messages };
    assert.equal(getTaskSignals(body).messageCount, 8);
  });
}

test("a scalar Responses input is one logical message", () => {
  const signals = getTaskSignals({ input: "Reply only: OK", max_output_tokens: 512 });
  assert.equal(signals.messageCount, 1);
  assert.deepEqual(signals.resourceNormalization?.messageSources, ["input"]);
});

test("an in-memory alias of the same message array is not counted twice", () => {
  const messages = [{ role: "user", content: "Reply only: OK" }];
  const signals = getTaskSignals({ messages, input: messages });
  assert.equal(signals.messageCount, 1);
  assert.equal(signals.resourceNormalization?.messageDialectConflict, false);
});

test("scalar input beside an empty messages array remains counted and provenance is ambiguous", () => {
  const body = { messages: [], input: "Reply only: OK", max_output_tokens: 512 };
  const before = structuredClone(body);
  const signals = getTaskSignals(body);
  assert.equal(signals.messageCount, 1);
  assert.deepEqual(signals.resourceNormalization?.messageSources, ["messages", "input"]);
  assert.equal(signals.resourceNormalization?.messageDialectConflict, true);
  assert.deepEqual(body, before);
});

test("scalar input beside nonempty messages is conservatively counted without a hidden dialect choice", () => {
  const signals = getTaskSignals({
    messages: [{ role: "user", content: "one" }],
    input: "two",
    max_output_tokens: 512,
  });
  assert.equal(signals.messageCount, 2);
  assert.equal(signals.resourceNormalization?.messageDialectConflict, true);
});

const efforts = [
  ["reasoning_effort", { reasoning_effort: "high" }],
  ["reasoning.effort", { reasoning: { effort: "high" } }],
  ["output_config.effort", { thinking: { type: "adaptive" }, output_config: { effort: "high" } }],
  [
    "generationConfig.thinkingConfig.thinkingLevel",
    { generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } },
  ],
] as const;

for (const [path, fields] of efforts) {
  test(`normalizes ${path} without inventing semantic difficulty or default origin`, () => {
    const body = { ...small, ...fields };
    const before = structuredClone(body);
    const signals = getTaskSignals(body);
    assert.equal(signals.effort, "high");
    assert.equal(signals.hasExplicitReasoning, true);
    assert.equal(signals.executionPreferences?.effortStatus, "observed");
    assert.equal(signals.executionPreferences?.provenance, "wire-unattributed");
    assert.deepEqual(signals.executionPreferences?.effortSources, [{ path, value: "high" }]);
    assert.equal(classifyTask(body).level, "light");
    assert.deepEqual(body, before);
  });
}

test("absence does not become a fabricated medium/high default", () => {
  const signals = getTaskSignals(small);
  assert.equal(signals.effort, "");
  assert.equal(signals.executionPreferences?.effortStatus, "absent");
  assert.equal(signals.executionPreferences?.provenance, "not-observed");
});

test("conflicting qualitative efforts are reported instead of silently choosing a dialect", () => {
  const body = { ...small, reasoning_effort: "low", output_config: { effort: "high" } };
  const before = structuredClone(body);
  const signals = getTaskSignals(body);
  assert.equal(signals.effort, "");
  assert.equal(signals.executionPreferences?.effortStatus, "conflict");
  assert.deepEqual(signals.executionPreferences?.effortSources, [
    { path: "reasoning_effort", value: "low" },
    { path: "output_config.effort", value: "high" },
  ]);
  assert.notEqual(classifyTask(body).level, "light");
  assert.deepEqual(body, before);
});

for (const [path, fields] of [
  ["thinking.budget_tokens", { thinking: { type: "enabled", budget_tokens: 4096 } }],
  [
    "generationConfig.thinkingConfig.thinkingBudget",
    { generationConfig: { thinkingConfig: { thinkingBudget: 4096 } } },
  ],
] as const) {
  test(`records ${path} as a budget, not a made-up qualitative effort`, () => {
    const signals = getTaskSignals({ ...small, max_tokens: 8192, ...fields });
    assert.equal(signals.effort, "");
    assert.equal(signals.hasExplicitReasoning, true);
    assert.equal(signals.executionPreferences?.thinkingBudgetTokens, 4096);
    assert.deepEqual(signals.executionPreferences?.thinkingBudgetSources, [{ path, value: 4096 }]);
  });
}

test("Gemini automatic thinking budget retains its sentinel meaning", () => {
  const signals = getTaskSignals({
    ...small,
    generationConfig: { thinkingConfig: { thinkingBudget: -1 } },
  });
  assert.equal(signals.executionPreferences?.thinkingBudgetTokens, null);
  assert.equal(signals.executionPreferences?.thinkingBudgetMode, "automatic");
  assert.equal(signals.effort, "");
});

test("Gemini zero thinking budget is observed as disabled rather than a positive budget", () => {
  const signals = getTaskSignals({
    ...small,
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  });
  assert.equal(signals.executionPreferences?.thinkingBudgetMode, "disabled");
  assert.equal(signals.executionPreferences?.thinkingBudgetTokens, null);
  assert.equal(signals.hasExplicitReasoning, false);
});

test("zero Gemini budget conflicts with positive qualitative effort", () => {
  const body = {
    ...small,
    generationConfig: { thinkingConfig: { thinkingLevel: "HIGH", thinkingBudget: 0 } },
  };
  const before = structuredClone(body);
  const signals = getTaskSignals(body);
  assert.equal(signals.executionPreferences?.effortStatus, "conflict");
  assert.equal(signals.executionPreferences?.thinkingBudgetMode, "disabled");
  assert.equal(signals.effort, "");
  assert.notEqual(classifyTask(body).level, "light");
  assert.deepEqual(body, before);
});

test("zero Gemini budget conflicts with an enabled Anthropic thinking mode", () => {
  const body = {
    ...small,
    thinking: { type: "enabled" },
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  };
  const before = structuredClone(body);
  const signals = getTaskSignals(body);
  assert.equal(signals.executionPreferences?.effortStatus, "conflict");
  assert.notEqual(classifyTask(body).level, "light");
  assert.deepEqual(body, before);
});

test("disabled thinking and positive effort produce a visible control conflict", () => {
  const signals = getTaskSignals({
    ...small,
    thinking: { type: "disabled" },
    output_config: { effort: "high" },
  });
  assert.equal(signals.executionPreferences?.effortStatus, "conflict");
  assert.equal(signals.effort, "");
});

test("different thinking budgets are not silently collapsed into one preference", () => {
  const signals = getTaskSignals({
    ...small,
    thinking: { type: "enabled", budget_tokens: 2048 },
    generationConfig: { thinkingConfig: { thinkingBudget: 4096 } },
  });
  assert.equal(signals.executionPreferences?.effortStatus, "conflict");
  assert.equal(signals.executionPreferences?.thinkingBudgetMode, "conflict");
  assert.equal(signals.executionPreferences?.thinkingBudgetTokens, 4096);
});

test("invalid effort and budget values are flagged without copying arbitrary values", () => {
  const signals = getTaskSignals({
    ...small,
    reasoning_effort: { private: "never-copy-this" },
    thinking: { type: "enabled", budget_tokens: "4096junk" },
  });
  assert.equal(signals.executionPreferences?.effortStatus, "invalid");
  assert.deepEqual(signals.executionPreferences?.invalidFields, [
    "reasoning_effort",
    "thinking.budget_tokens",
  ]);
  assert.equal(JSON.stringify(signals).includes("never-copy-this"), false);
  assert.notEqual(classifyTask({ ...small, reasoning_effort: {} }).level, "light");
});

test("multiple incompatible message dialects retain a conservative count and visible conflict", () => {
  const signals = getTaskSignals({
    messages: [{ role: "user", content: "one" }],
    contents: [{ role: "user", parts: [{ text: "two" }] }],
  });
  assert.equal(signals.messageCount, 2);
  assert.equal(signals.resourceNormalization?.messageDialectConflict, true);
});

test("equivalent output limits retain all origins without a false conflict", () => {
  const signals = getTaskSignals({
    ...small,
    max_output_tokens: 512,
    generationConfig: { maxOutputTokens: 512 },
  });
  assert.equal(signals.outputTokens, 512);
  assert.equal(signals.resourceNormalization?.outputLimitStatus, "observed");
  assert.deepEqual(signals.resourceNormalization?.outputLimitSources, [
    { path: "max_tokens", value: 512 },
    { path: "max_output_tokens", value: 512 },
    { path: "generationConfig.maxOutputTokens", value: 512 },
  ]);
});

test("conflicting output limits retain the maximum as evidence without changing the body", () => {
  const body = { ...small, max_output_tokens: 8192 };
  const before = structuredClone(body);
  const signals = getTaskSignals(body);
  assert.equal(signals.outputTokens, 8192);
  assert.equal(signals.resourceNormalization?.outputLimitStatus, "conflict");
  assert.notEqual(classifyTask(body).level, "light");
  assert.deepEqual(body, before);
});

for (const invalid of [
  "512junk",
  "512",
  512.5,
  0,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
]) {
  test(`does not coerce invalid output reserve ${String(invalid)}`, () => {
    const body = { messages: small.messages, max_tokens: invalid };
    const signals = getTaskSignals(body);
    assert.equal(signals.outputTokens, 0);
    assert.equal(signals.resourceNormalization?.outputLimitStatus, "invalid");
    assert.deepEqual(signals.resourceNormalization?.invalidOutputFields, ["max_tokens"]);
    assert.notEqual(classifyTask(body).level, "light");
  });
}

test("light wording cannot override a real large output reservation", () => {
  const result = classifyTask({
    messages: [{ role: "user", content: "Format this short reply." }],
    max_tokens: 8192,
  });
  assert.equal(result.level, "standard");
  assert.ok(result.reasons.includes("large-output"));
});

test("huge output and context floors remain critical", () => {
  assert.equal(classifyTask({ ...small, max_tokens: 32768 }).level, "critical");
  assert.equal(
    classifyTask({ messages: [{ role: "user", content: "x".repeat(100000) }], max_tokens: 512 })
      .level,
    "critical"
  );
});

test("high execution preference with a positive complex ask supports heavy classification", () => {
  const result = classifyTask({
    messages: [{ role: "user", content: "Analyze this code." }],
    reasoning_effort: "high",
    max_tokens: 512,
  });
  assert.equal(result.level, "heavy");
  assert.ok(result.reasons.includes("complex-operation-with-high-effort"));
});

test("negated complex wording and generic system instructions cannot make high alone heavy", () => {
  for (const body of [
    {
      system: "Always analyze code carefully.",
      messages: [{ role: "user", content: "Reply only: OK" }],
      reasoning_effort: "high",
      max_tokens: 512,
    },
    {
      messages: [{ role: "user", content: "Do not analyze anything. Reply only: OK" }],
      reasoning_effort: "high",
      max_tokens: 512,
    },
  ])
    assert.notEqual(classifyTask(body).level, "heavy");
});

test("normalization also accepts an immutable inference body without changing its controls", () => {
  const body = Object.freeze({
    messages: Object.freeze([Object.freeze({ role: "user", content: "Reply only: OK" })]),
    thinking: Object.freeze({ type: "adaptive" }),
    output_config: Object.freeze({ effort: "high" }),
    max_tokens: 512,
  });
  const before = JSON.stringify(body);
  assert.equal(getTaskSignals(body).effort, "high");
  assert.equal(JSON.stringify(body), before);
});
