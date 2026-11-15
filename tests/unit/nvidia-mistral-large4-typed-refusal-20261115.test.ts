// An unsupported reasoning VALUE for the exact hosted Mistral Large 4 target is a typed,
// known-non-dispatch compatibility refusal (HTTP 422) so a combo moves to the next target,
// instead of an unmarked HTTP 500 that the router must treat as a hard stop. The fail-closed
// contract is unchanged: the user's effort is never rewritten and nothing is sent upstream.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mistral-typed-refusal-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "mistral-typed-refusal-secret";

const core = await import("../../src/lib/db/core.ts");
const { mapNvidiaGlm52ReasoningParams, sanitizeReasoningEffortForProvider } =
  await import("../../open-sse/executors/base/reasoningEffort.ts");
const { RequestCompatibilityError } =
  await import("../../open-sse/services/requestCompatibility.ts");
const { sanitizeRequestForResolvedTarget } =
  await import("../../open-sse/services/targetRequestSanitizer.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { initTranslators } = await import("../../open-sse/translator/index.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");

const model = "mistralai/mistral-large-4-1t-a52b";
type Json = Record<string, unknown>;
type Result = { success?: boolean; status?: number; error?: unknown; response: Response };
const map = (body: Json, provider = "nvidia", id = model) =>
  mapNvidiaGlm52ReasoningParams(body, provider, id) as Json;
const log = { debug() {}, info() {}, warn() {}, error() {} };
const tool = {
  type: "function",
  function: { name: "echo", parameters: { type: "object", properties: {} } },
};

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("unsupported effort values and conflicting controls throw the typed compatibility error", () => {
  for (const b of [
    { reasoning_effort: "medium" },
    { reasoning: { effort: "low" } },
    { output_config: { effort: "max" } },
    { reasoning_effort: "none", thinking: { type: "adaptive" } },
    { reasoning_effort: "high", chat_template_kwargs: { enable_thinking: false } },
  ]) {
    assert.throws(
      () => map(b),
      (error: unknown) =>
        error instanceof RequestCompatibilityError &&
        error.code === "request_required_control_unsupported"
    );
  }
  assert.throws(() => map({ reasoning_effort: "medium" }), /unsupported reasoning effort/);
  assert.throws(
    () => sanitizeReasoningEffortForProvider({ reasoning_effort: "medium" }, "nvidia", model),
    RequestCompatibilityError
  );
});

test("malformed input and unenforceable budgets stay plain TypeErrors", () => {
  for (const b of [
    { reasoning: null },
    { thinking: { type: "weird" } },
    { chat_template_kwargs: { enable_thinking: 1 } },
    { thinking: { type: "enabled", budget_tokens: 1024 } },
    { reasoning_budget: 100 },
  ]) {
    assert.throws(
      () => map(b),
      (error: unknown) =>
        error instanceof TypeError && !(error instanceof RequestCompatibilityError)
    );
  }
});

test("effort is never rewritten and neighbouring routes are untouched", () => {
  for (const effort of ["none", "high"])
    assert.equal(map({ reasoning_effort: effort }).reasoning_effort, effort);
  const body = { reasoning_effort: "medium" };
  for (const [provider, id] of [
    ["mistral", model],
    ["nvidia", model + "-unknown"],
    ["openrouter", model],
  ])
    assert.equal(map(body, provider, id), body);
  assert.throws(() =>
    sanitizeRequestForResolvedTarget({ reasoning_effort: "medium" }, { provider: "nvidia", model })
  );
});

test("body preparation surfaces the typed refusal for the exact target only", async () => {
  const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");
  const prepare = (provider: string, id: string) =>
    prepareUpstreamBody({
      translatedBody: {
        model: id,
        messages: [{ role: "user", content: "x" }],
        reasoning_effort: "medium",
      },
      modelToCall: id,
      provider,
      targetFormat: "openai",
      credentials: null,
      log,
    } as unknown as Parameters<typeof prepareUpstreamBody>[0]);
  await assert.rejects(prepare("nvidia", model), RequestCompatibilityError);
  const other = await prepare("nvidia", "z-ai/glm-5.2");
  assert.ok(other);
});

async function dispatchMistral(body: Json, executed: { n: number }): Promise<Result> {
  initTranslators();
  const original = DefaultExecutor.prototype.execute;
  DefaultExecutor.prototype.execute = async (args: { body: Json }) => {
    executed.n += 1;
    return {
      response: Response.json({
        id: "ok",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      url: "https://fixture.invalid",
      headers: {},
      transformedBody: args.body,
    };
  };
  try {
    return (await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "nvidia", model },
      credentials: { connectionId: "nv-a", apiKey: "fixture-only", providerSpecificData: {} },
      connectionId: "nv-a",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers(),
      },
      apiKeyInfo: { noLog: true },
      cachedSettings: {},
      log,
      skipUpstreamRetry: true,
    })) as Result;
  } finally {
    DefaultExecutor.prototype.execute = original;
  }
}

for (const [label, extra] of [
  ["a tool request", { tools: [tool] }],
  ["a non-tool request", {}],
] as const) {
  test(`chatCore refuses medium effort as a 422 compatibility refusal for ${label}`, async () => {
    const executed = { n: 0 };
    const result = await dispatchMistral(
      {
        model: `nvidia/${model}`,
        messages: [{ role: "user", content: "fixture" }],
        reasoning_effort: "medium",
        stream: false,
        ...extra,
      },
      executed
    );
    assert.equal(result.success, false);
    assert.equal(result.status, 422);
    const payload = await result.response.json();
    assert.equal(payload.error.code, "request_required_control_unsupported");
    assert.equal(executed.n, 0, "nothing may reach the upstream");
  });

  test(`combo advances past the Mistral target to the next target for ${label}`, async () => {
    const executed = { n: 0 };
    const called: string[] = [];
    const body = {
      model: "test",
      messages: [{ role: "user", content: "fixture" }],
      reasoning_effort: "medium",
      stream: false,
      ...extra,
    };
    const response = await handleComboChat({
      body,
      combo: {
        name: "mistral-first",
        strategy: "priority",
        models: [{ model: `nvidia/${model}` }, { model: "other/fixture-model" }],
      },
      handleSingleModel: async (b: Json, modelStr: string) => {
        called.push(modelStr);
        if (modelStr.startsWith("nvidia/")) {
          const result = await dispatchMistral({ ...b, model }, executed);
          return result.response;
        }
        return Response.json({
          id: "ok",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        });
      },
      log,
      settings: {},
      allCombos: [],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(called, [`nvidia/${model}`, "other/fixture-model"]);
    assert.equal(executed.n, 0);
  });
}

test("supported effort still dispatches through chatCore", async () => {
  for (const effort of ["none", "high"]) {
    const executed = { n: 0 };
    const result = await dispatchMistral(
      {
        model: `nvidia/${model}`,
        messages: [{ role: "user", content: "fixture" }],
        reasoning_effort: effort,
        stream: false,
      },
      executed
    );
    assert.equal(result.status ?? 200, 200, JSON.stringify(result.error));
    assert.equal(executed.n, 1);
  }
});
