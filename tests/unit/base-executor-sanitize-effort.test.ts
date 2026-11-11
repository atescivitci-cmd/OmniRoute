import test from "node:test";
import assert from "node:assert/strict";

const { sanitizeReasoningEffortForProvider } = await import("../../open-sse/executors/base.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");

function makeLog() {
  const messages: Array<[string, string]> = [];
  return {
    info: (tag: string, msg: string) => messages.push([tag, msg]),
    messages,
  };
}

test("sanitizeReasoningEffortForProvider: xiaomi-mimo preserves xhigh by default", () => {
  const log = makeLog();
  const body = {
    model: "mimo-v2.5-pro",
    reasoning_effort: "xhigh",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "xiaomi-mimo", "mimo-v2.5-pro", log);
  assert.equal(result, body, "xhigh passes through unless the model explicitly opts out");
  assert.equal((result as any).reasoning_effort, "xhigh");
  assert.equal((result as any).model, "mimo-v2.5-pro", "other fields preserved");
  assert.equal(log.messages.length, 0);
});

test("sanitizeReasoningEffortForProvider: OpenRouter DeepSeek preserves xhigh", () => {
  const body = {
    model: "deepseek/deepseek-v4-pro",
    reasoning_effort: "xhigh",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(
    body,
    "openrouter",
    "deepseek/deepseek-v4-pro",
    null
  );
  assert.equal(result, body);
  assert.equal((result as any).reasoning_effort, "xhigh");
});

test("sanitizeReasoningEffortForProvider: explicit xhigh opt-out downgrades to high", () => {
  const log = makeLog();
  const body = {
    model: "claude-opus-4-6",
    reasoning_effort: "xhigh",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "claude", "claude-opus-4-6", log);
  assert.notEqual(result, body, "must return a new object when mutating");
  assert.equal((result as any).reasoning_effort, "high");
  assert.ok(
    log.messages.some(([tag, m]) => tag === "REASONING_SANITIZE" && /xhigh → high/.test(m)),
    "logs the downgrade"
  );
});

test("sanitizeReasoningEffortForProvider: Anthropic-compatible dynamic provider honors xhigh opt-out", () => {
  const body = {
    model: "claude-opus-4-6",
    reasoning_effort: "xhigh",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(
    body,
    "anthropic-compatible-test",
    "claude-opus-4-6",
    null
  );
  assert.notEqual(result, body, "must return a new object when mutating");
  assert.equal((result as any).reasoning_effort, "high");
});

test("sanitizeReasoningEffortForProvider: xiaomi-mimo normalizes max → xhigh by default", () => {
  const log = makeLog();
  const body = {
    model: "mimo-v2.5-pro",
    reasoning_effort: "max",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "xiaomi-mimo", "mimo-v2.5-pro", log);
  assert.equal((result as any).reasoning_effort, "xhigh");
  assert.ok(
    log.messages.some(([tag, m]) => tag === "REASONING_SANITIZE" && /max → xhigh/.test(m)),
    "logs the normalization"
  );
});

test("sanitizeReasoningEffortForProvider: Ollama Cloud preserves max", () => {
  const log = makeLog();
  const body = {
    model: "glm-5.2",
    reasoning_effort: "max",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "ollama-cloud", "glm-5.2", log);
  assert.equal(result, body, "Ollama Cloud accepts max literally");
  assert.equal((result as any).reasoning_effort, "max");
  assert.equal(log.messages.length, 0);
});

test("sanitizeReasoningEffortForProvider: Ollama Cloud preserves nested max", () => {
  const body = {
    model: "glm-5.2",
    reasoning: { effort: "max", summary: "auto" },
    input: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "ollama-cloud", "glm-5.2", null);
  assert.equal(result, body, "Ollama Cloud accepts max literally");
  assert.equal((result as any).reasoning.effort, "max");
  assert.equal((result as any).reasoning.summary, "auto");
});

test("sanitizeReasoningEffortForProvider: OpenRouter DeepSeek normalizes max → xhigh", () => {
  const log = makeLog();
  const body = {
    model: "deepseek/deepseek-v4-pro",
    reasoning_effort: "max",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(
    body,
    "openrouter",
    "deepseek/deepseek-v4-pro",
    log
  );
  assert.notEqual(result, body, "must return a new object when mutating");
  assert.equal((result as any).reasoning_effort, "xhigh");
  assert.ok(
    log.messages.some(([tag, m]) => tag === "REASONING_SANITIZE" && /max → xhigh/.test(m)),
    "logs the normalization"
  );
});

test("sanitizeReasoningEffortForProvider: OpenRouter Claude opt-out aliases downgrade max → high", () => {
  const log = makeLog();
  const body = {
    model: "anthropic/claude-opus-4.6",
    reasoning_effort: "max",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(
    body,
    "openrouter",
    "anthropic/claude-opus-4.6",
    log
  );
  assert.notEqual(result, body, "must return a new object when mutating");
  assert.equal((result as any).reasoning_effort, "high");
  assert.ok(
    log.messages.some(([tag, m]) => tag === "REASONING_SANITIZE" && /max → high/.test(m)),
    "logs the downgrade"
  );
});

test("sanitizeReasoningEffortForProvider: OpenAI-compatible Gemini normalizes max → xhigh", () => {
  const log = makeLog();
  const body = {
    model: "gemini-3.1-pro-preview",
    reasoning_effort: "max",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(
    body,
    "openai-compatible-free1",
    "gemini-3.1-pro-preview",
    log
  );
  assert.notEqual(result, body, "must return a new object when mutating");
  assert.equal((result as any).reasoning_effort, "xhigh");
  assert.ok(
    log.messages.some(([tag, m]) => tag === "REASONING_SANITIZE" && /max → xhigh/.test(m)),
    "logs the normalization"
  );
});

test("sanitizeReasoningEffortForProvider: nested OpenAI reasoning max normalizes to xhigh", () => {
  const body = {
    model: "gemini-3.1-pro-preview",
    reasoning: { effort: "max", summary: "auto" },
    input: [],
  };
  const result = sanitizeReasoningEffortForProvider(
    body,
    "openai-compatible-free1",
    "gemini-3.1-pro-preview",
    null
  );
  assert.equal((result as any).reasoning.effort, "xhigh");
  assert.equal((result as any).reasoning.summary, "auto", "other reasoning fields preserved");
  assert.equal((result as any).reasoning_effort, undefined);
});

test("sanitizeReasoningEffortForProvider: claude preserves max for Opus/Sonnet and downgrades Haiku", () => {
  const sonnetBody = {
    model: "claude-sonnet-4-6",
    reasoning_effort: "max",
    messages: [{ role: "user", content: "hi" }],
  };
  const sonnetResult = sanitizeReasoningEffortForProvider(
    sonnetBody,
    "claude",
    "claude-sonnet-4-6",
    null
  );
  assert.equal(sonnetResult, sonnetBody);
  assert.equal((sonnetResult as any).reasoning_effort, "max");

  const opusBody = {
    model: "claude-opus-4-6",
    reasoning: { effort: "max", summary: "auto" },
    input: [],
  };
  const opusResult = sanitizeReasoningEffortForProvider(
    opusBody,
    "anthropic-compatible-cc-test",
    "claude-opus-4-6",
    null
  );
  assert.equal(opusResult, opusBody);
  assert.equal((opusResult as any).reasoning.effort, "max");

  const haikuBody = {
    model: "claude-haiku-4-5-20251001",
    reasoning_effort: "max",
    messages: [{ role: "user", content: "hi" }],
  };
  const haikuResult = sanitizeReasoningEffortForProvider(
    haikuBody,
    "claude",
    "claude-haiku-4-5-20251001",
    null
  );
  assert.notEqual(haikuResult, haikuBody);
  assert.equal((haikuResult as any).reasoning_effort, "high");
});

test("sanitizeReasoningEffortForProvider: xiaomi-mimo preserves nested xhigh by default", () => {
  const body = {
    model: "mimo-v2.5-pro",
    reasoning: { effort: "xhigh", summary: "auto" },
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "xiaomi-mimo", "mimo-v2.5-pro", null);
  assert.equal(result, body);
  assert.equal((result as any).reasoning.effort, "xhigh");
  assert.equal((result as any).reasoning.summary, "auto", "other reasoning fields preserved");
});

test("sanitizeReasoningEffortForProvider: explicit xhigh opt-out preserves Responses shape", () => {
  const body = {
    model: "claude-opus-4-6",
    reasoning: { effort: "xhigh", summary: "auto" },
    input: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "claude", "claude-opus-4-6", null);
  assert.equal((result as any).reasoning.effort, "high");
  assert.equal((result as any).reasoning_effort, undefined);
});

test("sanitizeReasoningEffortForProvider: mistral/devstral strips reasoning_effort entirely", () => {
  const log = makeLog();
  const body = {
    model: "devstral-2512",
    reasoning_effort: "medium",
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "mistral", "devstral-2512", log);
  assert.equal((result as any).reasoning_effort, undefined, "reasoning_effort must be stripped");
  assert.ok(
    log.messages.some(([tag, m]) => tag === "REASONING_SANITIZE" && /removed/.test(m)),
    "logs the removal"
  );
});

test("sanitizeReasoningEffortForProvider: github/claude-opus-4.6 preserves reasoning_effort (#791)", () => {
  // Upstream PR decolua/9router#791 (port): Copilot now honors reasoning_effort
  // on Claude Opus 4.6 and Sonnet 4.6. Older Opus variants and Haiku still strip.
  const body = {
    model: "claude-opus-4-6",
    reasoning_effort: "high",
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "github", "claude-opus-4-6", null);
  assert.equal((result as any).reasoning_effort, "high");
});

test("sanitizeReasoningEffortForProvider: github/claude-opus-4.7 still strips (#791)", () => {
  const body = {
    model: "claude-opus-4.7",
    reasoning_effort: "high",
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "github", "claude-opus-4.7", null);
  assert.equal((result as any).reasoning_effort, undefined);
});

test("sanitizeReasoningEffortForProvider: rejecting providers strip max before normalization", () => {
  const mistralBody = {
    model: "devstral-2512",
    reasoning_effort: "max",
    messages: [],
  };
  const mistralResult = sanitizeReasoningEffortForProvider(
    mistralBody,
    "mistral",
    "devstral-2512",
    null
  );
  assert.equal((mistralResult as any).reasoning_effort, undefined);

  // Pre-#791: github stripped reasoning_effort entirely for every Claude model.
  // Post-#791: Opus 4.6 keeps reasoning_effort; `max` downgrades to `high`
  // because github is not Claude/CC-compatible (so supportsMax=false) and
  // the canonical Claude Opus 4.6 model opts out of xhigh.
  const githubBody = {
    model: "claude-opus-4-6",
    reasoning_effort: "max",
    messages: [],
  };
  const githubResult = sanitizeReasoningEffortForProvider(
    githubBody,
    "github",
    "claude-opus-4-6",
    null
  );
  assert.equal((githubResult as any).reasoning_effort, "high");

  // Pre-#791 strip is preserved for github Claude models that DO NOT opt in
  // (Haiku 4.5, Opus 4.7, older Sonnet, etc.).
  const githubHaiku = {
    model: "claude-haiku-4.5",
    reasoning_effort: "max",
    messages: [],
  };
  const githubHaikuResult = sanitizeReasoningEffortForProvider(
    githubHaiku,
    "github",
    "claude-haiku-4.5",
    null
  );
  assert.equal((githubHaikuResult as any).reasoning_effort, undefined);
});

test("sanitizeReasoningEffortForProvider: mistral/devstral strips reasoning object when only effort present", () => {
  const body = {
    model: "devstral-2512",
    reasoning: { effort: "medium" },
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "mistral", "devstral-2512", null);
  assert.equal((result as any).reasoning, undefined, "reasoning object dropped when emptied");
});

test("sanitizeReasoningEffortForProvider: mistral/devstral preserves reasoning when other fields remain", () => {
  const body = {
    model: "devstral-2512",
    reasoning: { effort: "medium", summary: "auto" },
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "mistral", "devstral-2512", null);
  assert.deepEqual((result as any).reasoning, { summary: "auto" });
});

test("sanitizeReasoningEffortForProvider: codex with xhigh passes through unchanged", () => {
  const body = {
    model: "gpt-5.5-xhigh",
    reasoning_effort: "xhigh",
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "codex", "gpt-5.5-xhigh", null);
  assert.equal((result as any).reasoning_effort, "xhigh");
});

test("sanitizeReasoningEffortForProvider: no-op when reasoning_effort absent", () => {
  const body = { model: "mimo-v2.5-pro", messages: [] };
  const result = sanitizeReasoningEffortForProvider(body, "xiaomi-mimo", "mimo-v2.5-pro", null);
  assert.equal(result, body, "returns original body unchanged");
});

test("sanitizeReasoningEffortForProvider: handles unknown providers as pass-through", () => {
  const body = { model: "some-model", reasoning_effort: "xhigh", messages: [] };
  const result = sanitizeReasoningEffortForProvider(body, "unknown-provider", "some-model", null);
  assert.equal(result, body);
  assert.equal((result as any).reasoning_effort, "xhigh");
});

test("sanitizeReasoningEffortForProvider: non-object body returns unchanged", () => {
  assert.equal(sanitizeReasoningEffortForProvider(null, "xiaomi-mimo", "x", null), null);
  assert.equal(sanitizeReasoningEffortForProvider("string", "xiaomi-mimo", "x", null), "string");
  const arr: unknown[] = [];
  assert.equal(sanitizeReasoningEffortForProvider(arr, "xiaomi-mimo", "x", null), arr);
});

// ── NVIDIA NIM GLM-5.2 (#7215) ─────────────────────────────────────────────

test("sanitizeReasoningEffortForProvider: NVIDIA GLM-5.2 enables thinking for active effort", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const body = { reasoning_effort: effort, messages: [] };
    const result = sanitizeReasoningEffortForProvider(
      body,
      "nvidia",
      "z-ai/glm-5.2",
      null
    ) as Record<string, unknown>;

    assert.notEqual(result, body);
    assert.equal(result.reasoning_effort, undefined);
    assert.deepEqual(result.chat_template_kwargs, { enable_thinking: true });
  }
});

test("sanitizeReasoningEffortForProvider: NVIDIA GLM-5.2 maps none to thinking off", () => {
  const result = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "none", messages: [] },
    "nvidia",
    "z-ai/glm-5.2",
    null
  ) as Record<string, unknown>;

  assert.equal(result.reasoning_effort, undefined);
  assert.deepEqual(result.chat_template_kwargs, { enable_thinking: false });
});

test("sanitizeReasoningEffortForProvider: NVIDIA GLM-5.2 maps nested reasoning.effort", () => {
  const result = sanitizeReasoningEffortForProvider(
    { reasoning: { effort: "high" }, messages: [] },
    "nvidia",
    "z-ai/glm-5.2",
    null
  ) as Record<string, unknown>;

  assert.equal(result.reasoning, undefined);
  assert.deepEqual(result.chat_template_kwargs, { enable_thinking: true });
});

test("DefaultExecutor: NVIDIA GLM-5.2 maps nested effort before unsupported-param stripping", () => {
  const result = new DefaultExecutor("nvidia").transformRequest(
    "z-ai/glm-5.2",
    {
      model: "z-ai/glm-5.2",
      reasoning: { effort: "high", summary: "auto" },
      messages: [],
    },
    false,
    {}
  ) as Record<string, unknown>;

  assert.equal(result.reasoning, undefined);
  assert.equal(result.reasoning_effort, undefined);
  assert.deepEqual(result.chat_template_kwargs, { enable_thinking: true });
});

test("DefaultExecutor: NVIDIA reasoning levels remain intact for GPT-OSS", () => {
  const result = new DefaultExecutor("nvidia").transformRequest(
    "openai/gpt-oss-120b",
    {
      model: "openai/gpt-oss-120b",
      reasoning_effort: "low",
      messages: [],
    },
    false,
    {}
  ) as Record<string, unknown>;

  assert.equal(result.reasoning_effort, "low");
  assert.equal(result.chat_template_kwargs, undefined);
});

test("sanitizeReasoningEffortForProvider: NVIDIA GLM-5.2 preserves a native thinking switch", () => {
  const result = sanitizeReasoningEffortForProvider(
    {
      reasoning_effort: "xhigh",
      chat_template_kwargs: { enable_thinking: false, custom_flag: true },
      messages: [],
    },
    "nvidia",
    "z-ai/glm-5.2",
    null
  ) as Record<string, unknown>;

  assert.equal(result.reasoning_effort, undefined);
  assert.deepEqual(result.chat_template_kwargs, {
    enable_thinking: false,
    custom_flag: true,
  });
});

test("sanitizeReasoningEffortForProvider: NVIDIA GLM-5.2 mapping is narrowly scoped", () => {
  const otherModel = { reasoning_effort: "high", messages: [] };
  const otherProvider = { reasoning_effort: "high", messages: [] };

  assert.equal(
    sanitizeReasoningEffortForProvider(otherModel, "nvidia", "z-ai/glm-5.1", null),
    otherModel
  );
  assert.equal(
    sanitizeReasoningEffortForProvider(otherProvider, "openai", "z-ai/glm-5.2", null),
    otherProvider
  );
});

// ── NVIDIA NIM Nemotron 3 Nano Omni (request-scoped native controls) ────────

const NEMOTRON_OMNI = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";

test("sanitizeReasoningEffortForProvider: Nemotron none emits native thinking off", () => {
  const body = {
    model: NEMOTRON_OMNI,
    reasoning_effort: "none",
    max_tokens: 1700,
    response_format: { type: "json_schema", json_schema: { name: "trip", schema: {} } },
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "nvidia", NEMOTRON_OMNI) as Record<
    string,
    unknown
  >;

  assert.notEqual(result, body);
  assert.equal(result.reasoning_effort, undefined);
  assert.deepEqual(result.chat_template_kwargs, { enable_thinking: false });
  assert.equal(result.thinking_token_budget, undefined, "no budget when thinking is disabled");
  assert.equal(body.reasoning_effort, "none", "caller body is not mutated");
});

test("DefaultExecutor: Nemotron none survives outbound transformation as native switch", () => {
  const result = new DefaultExecutor("nvidia").transformRequest(
    NEMOTRON_OMNI,
    {
      model: NEMOTRON_OMNI,
      reasoning_effort: "none",
      max_tokens: 1700,
      messages: [],
    },
    false,
    {}
  ) as Record<string, unknown>;

  assert.equal(result.reasoning_effort, undefined);
  assert.deepEqual(result.chat_template_kwargs, { enable_thinking: false });
  assert.equal(result.max_tokens, 1700);
});

test("DefaultExecutor: bounded Nemotron JSON reserves visible output without explicit effort", () => {
  for (const [maxTokens, expectedBudget] of [
    [1700, 340],
    [2400, 480],
  ]) {
    const result = new DefaultExecutor("nvidia").transformRequest(
      NEMOTRON_OMNI,
      {
        model: NEMOTRON_OMNI,
        max_tokens: maxTokens,
        response_format: { type: "json_schema", json_schema: { name: "trip", schema: {} } },
        messages: [],
      },
      false,
      {}
    ) as Record<string, unknown>;

    assert.equal(result.max_tokens, maxTokens);
    assert.equal(result.reasoning_budget, expectedBudget);
    assert.equal(result.thinking_token_budget, undefined);
    assert.equal(result.reasoning_effort, undefined);
    assert.equal(result.chat_template_kwargs, undefined, "documented default enables thinking");
    assert.ok(maxTokens - expectedBudget >= Math.ceil(maxTokens * 0.8));
  }
});

test("DefaultExecutor: Nemotron structured low effort retains visible output reserve", () => {
  const result = new DefaultExecutor("nvidia").transformRequest(
    NEMOTRON_OMNI,
    {
      model: NEMOTRON_OMNI,
      reasoning_effort: "low",
      max_tokens: 2000,
      response_format: { type: "json_schema", json_schema: { name: "trip", schema: {} } },
      messages: [],
    },
    false,
    {}
  ) as Record<string, unknown>;

  assert.equal(result.reasoning_effort, undefined);
  assert.deepEqual(result.chat_template_kwargs, { enable_thinking: true });
  assert.equal(result.reasoning_budget, 400);
  assert.equal(result.thinking_token_budget, undefined);
  assert.equal(result.max_tokens, 2000, "do not raise the caller's visible-output envelope");
});

test("sanitizeReasoningEffortForProvider: Nemotron preserves explicit native controls", () => {
  const body = {
    model: NEMOTRON_OMNI,
    max_tokens: 1700,
    response_format: { type: "json_object" },
    chat_template_kwargs: { enable_thinking: true, custom_flag: true },
    thinking_token_budget: 125,
    messages: [],
  };
  assert.equal(sanitizeReasoningEffortForProvider(body, "nvidia", NEMOTRON_OMNI), body);

  const explicitSwitch = {
    model: NEMOTRON_OMNI,
    max_tokens: 1700,
    response_format: { type: "json_object" },
    chat_template_kwargs: { enable_thinking: true },
    messages: [],
  };
  assert.equal(
    sanitizeReasoningEffortForProvider(explicitSwitch, "nvidia", NEMOTRON_OMNI),
    explicitSwitch
  );

  const disabled = {
    model: NEMOTRON_OMNI,
    max_tokens: 2400,
    response_format: { type: "json_schema" },
    chat_template_kwargs: { enable_thinking: false },
    messages: [],
  };
  assert.equal(sanitizeReasoningEffortForProvider(disabled, "nvidia", NEMOTRON_OMNI), disabled);
  assert.equal((disabled as Record<string, unknown>).thinking_token_budget, undefined);

  const matching = sanitizeReasoningEffortForProvider(
    {
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false, custom_flag: true },
    },
    "nvidia",
    NEMOTRON_OMNI
  ) as Record<string, unknown>;
  assert.equal(matching.reasoning_effort, undefined);
  assert.deepEqual(matching.chat_template_kwargs, {
    enable_thinking: false,
    custom_flag: true,
  });
});

test("sanitizeReasoningEffortForProvider: Nemotron maps active nested effort and keeps native budget", () => {
  const result = sanitizeReasoningEffortForProvider(
    {
      model: NEMOTRON_OMNI,
      reasoning: { effort: "high", summary: "auto" },
      thinking_token_budget: 64,
      messages: [],
    },
    "nvidia",
    NEMOTRON_OMNI
  ) as Record<string, unknown>;

  assert.equal(result.thinking_token_budget, 64);
  assert.deepEqual(result.chat_template_kwargs, { enable_thinking: true });
  assert.deepEqual(result.reasoning, { summary: "auto" });
});

test("sanitizeReasoningEffortForProvider: Nemotron rejects malformed or conflicting controls", () => {
  for (const body of [
    { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: true } },
    { reasoning_effort: "high", chat_template_kwargs: { enable_thinking: false } },
    { reasoning_effort: "none", thinking_token_budget: 50 },
    { chat_template_kwargs: { enable_thinking: false }, thinking_token_budget: 50 },
    { reasoning_effort: 3 },
    { reasoning_effort: "unknown" },
    { reasoning_effort: "none", reasoning: { effort: "high" } },
    { chat_template_kwargs: "disabled" },
    { output_config: "high" },
    { chat_template_kwargs: { enable_thinking: "false" } },
    { thinking_token_budget: -1 },
    { thinking_token_budget: 1.5 },
  ]) {
    assert.throws(
      () => sanitizeReasoningEffortForProvider(body, "nvidia", NEMOTRON_OMNI),
      /NVIDIA Nemotron|Conflicting explicit reasoning controls/
    );
  }
});

test("sanitizeReasoningEffortForProvider: Nemotron budget is scoped to bounded JSON", () => {
  const ordinary = { model: NEMOTRON_OMNI, max_tokens: 1700, messages: [] };
  const unbounded = {
    model: NEMOTRON_OMNI,
    response_format: { type: "json_object" },
    messages: [],
  };
  const otherModel = {
    model: "nvidia/other-model",
    max_tokens: 1700,
    response_format: { type: "json_object" },
    messages: [],
  };
  const otherProvider = { ...otherModel, model: NEMOTRON_OMNI };

  assert.equal(sanitizeReasoningEffortForProvider(ordinary, "nvidia", NEMOTRON_OMNI), ordinary);
  assert.equal(sanitizeReasoningEffortForProvider(unbounded, "nvidia", NEMOTRON_OMNI), unbounded);
  assert.equal(
    sanitizeReasoningEffortForProvider(otherModel, "nvidia", otherModel.model),
    otherModel
  );
  assert.equal(
    sanitizeReasoningEffortForProvider(otherProvider, "openai", NEMOTRON_OMNI),
    otherProvider
  );
});

test("DefaultExecutor: other NVIDIA models retain their reasoning effort and JSON budget", () => {
  const result = new DefaultExecutor("nvidia").transformRequest(
    "nvidia/other-model",
    {
      model: "nvidia/other-model",
      reasoning_effort: "none",
      max_tokens: 1700,
      response_format: { type: "json_schema" },
      messages: [],
    },
    false,
    {}
  ) as Record<string, unknown>;

  assert.equal(result.reasoning_effort, "none");
  assert.equal(result.chat_template_kwargs, undefined);
  assert.equal(result.thinking_token_budget, undefined);
  assert.equal(result.max_tokens, 1700);
});

// ── Native DeepSeek (api.deepseek.com) ───────────────────────────────────────
// DeepSeek V4 thinking mode accepts reasoning_effort ONLY as {high, max}. The
// internal OmniRoute scale (low|medium|high|xhigh, xhigh = top) must be mapped
// onto DeepSeek's native vocabulary so the client's requested effort is honored
// instead of silently dropped to the default. This is the INVERSE of the
// OpenRouter-DeepSeek path, whose normalized API expects xhigh, not max.

test("sanitizeReasoningEffortForProvider: native deepseek maps xhigh → max", () => {
  const log = makeLog();
  const body = {
    model: "deepseek-v4-pro",
    reasoning_effort: "xhigh",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "deepseek", "deepseek-v4-pro", log);
  assert.notEqual(result, body, "must return a new object when mutating");
  assert.equal((result as any).reasoning_effort, "max");
  assert.equal((result as any).model, "deepseek-v4-pro", "other fields preserved");
  assert.ok(
    log.messages.some(([tag, m]) => tag === "REASONING_SANITIZE" && /xhigh → max/.test(m)),
    "logs the xhigh → max mapping"
  );
});

test("sanitizeReasoningEffortForProvider: native deepseek preserves max", () => {
  const log = makeLog();
  const body = {
    model: "deepseek-v4-flash",
    reasoning_effort: "max",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "deepseek", "deepseek-v4-flash", log);
  assert.equal(result, body, "max is DeepSeek's native top tier — passes through unchanged");
  assert.equal((result as any).reasoning_effort, "max");
  assert.equal(log.messages.length, 0);
});

test("sanitizeReasoningEffortForProvider: native deepseek clamps low → high", () => {
  const body = {
    model: "deepseek-v4-pro",
    reasoning_effort: "low",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "deepseek", "deepseek-v4-pro", null);
  assert.notEqual(result, body, "must return a new object when mutating");
  assert.equal((result as any).reasoning_effort, "high", "below the {high, max} floor → high");
});

test("sanitizeReasoningEffortForProvider: native deepseek clamps medium → high", () => {
  const body = {
    model: "deepseek-v4-pro",
    reasoning_effort: "medium",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "deepseek", "deepseek-v4-pro", null);
  assert.equal((result as any).reasoning_effort, "high");
});

test("sanitizeReasoningEffortForProvider: native deepseek preserves high unchanged", () => {
  const body = {
    model: "deepseek-v4-pro",
    reasoning_effort: "high",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "deepseek", "deepseek-v4-pro", null);
  assert.equal(result, body, "high is already valid — passes through unchanged");
  assert.equal((result as any).reasoning_effort, "high");
});

test("sanitizeReasoningEffortForProvider: native deepseek maps nested reasoning.effort xhigh → max", () => {
  const body = {
    model: "deepseek-v4-pro",
    reasoning: { effort: "xhigh", summary: "auto" },
    input: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "deepseek", "deepseek-v4-pro", null);
  assert.equal((result as any).reasoning.effort, "max");
  assert.equal((result as any).reasoning.summary, "auto", "other reasoning fields preserved");
  assert.equal((result as any).reasoning_effort, undefined);
});

test("sanitizeReasoningEffortForProvider: OpenRouter DeepSeek still preserves xhigh (not native)", () => {
  // Regression guard: the native-deepseek mapping must NOT touch openrouter,
  // whose normalized API expects xhigh (issue earendil-works/pi#4055).
  const body = {
    model: "deepseek/deepseek-v4-pro",
    reasoning_effort: "xhigh",
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(
    body,
    "openrouter",
    "deepseek/deepseek-v4-pro",
    null
  );
  assert.equal(result, body);
  assert.equal((result as any).reasoning_effort, "xhigh");
});

// ── opencode-go DeepSeek V4 Pro effort variants (#4647) ──────────────────────
// opencode-go proxies DeepSeek with the native DeepSeek API contract, which
// accepts {high, max} literally. The OpencodeExecutor's transformRequest sets
// reasoning_effort to the variant suffix (low|medium|high|max), and the
// sanitizer must NOT rewrite `max` → `xhigh` for this provider+model combo.

test("sanitizeReasoningEffortForProvider: opencode-go DeepSeek V4 Pro preserves max", () => {
  const body = {
    model: "deepseek-v4-pro",
    reasoning_effort: "max",
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "opencode-go", "deepseek-v4-pro", null);
  assert.equal(result, body, "opencode-go DeepSeek max must pass through unchanged");
  assert.equal((result as any).reasoning_effort, "max");
});

test("sanitizeReasoningEffortForProvider: opencode-go DeepSeek V4 Pro preserves variant suffix levels", () => {
  for (const level of ["low", "medium", "high", "max"]) {
    const body = {
      model: `deepseek-v4-pro-${level}`,
      reasoning_effort: level,
      messages: [],
    };
    const result = sanitizeReasoningEffortForProvider(
      body,
      "opencode-go",
      `deepseek-v4-pro-${level}`,
      null
    );
    assert.equal(
      (result as any).reasoning_effort,
      level,
      `opencode-go deepseek-v4-pro-${level} preserves reasoning_effort=${level}`
    );
  }
});

test("sanitizeReasoningEffortForProvider: opencode-go with non-DeepSeek model still normalizes max → xhigh", () => {
  // The opt-in must be scoped to DeepSeek models on opencode-go only — other
  // opencode-go models (e.g. glm/kimi/mimo) follow the default xhigh policy.
  const body = {
    model: "mimo-v2.5-pro",
    reasoning_effort: "max",
    messages: [],
  };
  const result = sanitizeReasoningEffortForProvider(body, "opencode-go", "mimo-v2.5-pro", null);
  assert.notEqual(result, body);
  assert.equal((result as any).reasoning_effort, "xhigh");
});

test("sanitizeReasoningEffortForProvider: #7044 output_config.effort (Claude native) xhigh is downgraded, not bypassed", () => {
  const log = makeLog();
  const body = {
    model: "claude-opus-4-6",
    output_config: { effort: "xhigh" },
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "claude", "claude-opus-4-6", log);
  assert.notEqual(result, body, "must return a new object when mutating");
  assert.equal(
    (result as any).output_config.effort,
    "high",
    "xhigh downgraded to high on the output_config carrier"
  );
  assert.ok(
    !("reasoning_effort" in (result as any)),
    "no spurious reasoning_effort injected when only output_config was present"
  );
  assert.ok(
    log.messages.some(([tag, m]) => tag === "REASONING_SANITIZE" && /xhigh → high/.test(m)),
    "logs the downgrade"
  );
});

test("sanitizeReasoningEffortForProvider: #7044 output_config.effort high passes through unchanged", () => {
  const body = {
    model: "claude-opus-4-6",
    output_config: { effort: "high" },
    messages: [{ role: "user", content: "hi" }],
  };
  const result = sanitizeReasoningEffortForProvider(body, "claude", "claude-opus-4-6", null);
  assert.equal(result, body, "high is supported — body returned unchanged");
  assert.equal((result as any).output_config.effort, "high");
});
