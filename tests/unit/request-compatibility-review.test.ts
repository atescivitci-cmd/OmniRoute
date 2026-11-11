// Independent synthetic caller-boundary probes. Require dedicated temporary
// storage before importing the real modules; every transport is replaced.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Own a distinct scratch directory even under a combined parallel test run.
const reviewDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compatibility-review-"));
process.env.DATA_DIR = reviewDataDir;

const { GithubExecutor } = await import("../../open-sse/executors/github.ts");
const { getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");
const { resolveRequestCompatibilityTarget } =
  await import("../../open-sse/services/requestCompatibilityTarget.ts");
const { RequestCompatibilityError } =
  await import("../../open-sse/services/requestCompatibility.ts");
const { noThinkingHandling } =
  await import("../../open-sse/services/reasoningEffortCompatibility.ts");
const { setPayloadRulesConfig, clearPayloadRulesConfigOverride } =
  await import("../../open-sse/services/payloadRules.ts");
const registry = getRegistryEntry("github")!;
const fixtureModel = "fixture-native-nonthinking-review";
registry.models.push({
  id: fixtureModel,
  name: "Independent native nonthinking fixture",
  targetFormat: "claude",
  supportsReasoning: false,
  supportedThinkingEfforts: ["none"],
  reasoningEffortNoneHandling: "omit",
});
after(() => {
  const index = registry.models.findIndex((model) => model.id === fixtureModel);
  if (index !== -1) registry.models.splice(index, 1);
  clearPayloadRulesConfigOverride();
  resetDbInstance();
  fs.rmSync(reviewDataDir, { recursive: true, force: true });
});

const body = () => ({
  model: "claude-sonnet-4.6",
  messages: [{ role: "user", content: "  fixture\r\n" }],
  max_tokens: 128,
  stream: false,
});

async function captureExecute(model: string, inputBody: Record<string, unknown>) {
  const executor = new GithubExecutor();
  executor.needsRefresh = () => false;
  executor.buildHeaders = () => ({});
  const originalFetch = globalThis.fetch;
  const wires: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, options) => {
    wires.push(JSON.parse(String(options?.body)));
    return Response.json({ ok: true });
  };
  try {
    const result = await executor.execute({
      model,
      body: inputBody,
      stream: false,
      credentials: {},
      skipUpstreamRetry: true,
    });
    return { result, wires };
  } catch (error) {
    return { error, wires };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("review: default-format native GitHub dispatch preserves ordinary protocol data", async () => {
  const input = body();
  const before = structuredClone(input);
  const outcome = await captureExecute("claude-sonnet-4.6", input);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.wires.length, 1);
  assert.deepEqual(outcome.wires[0].messages, input.messages);
  assert.deepEqual(input, before);
});

for (const carrier of ["output_config", "thinking"] as const) {
  test(
    "review: qualified native no-thinking omission preserves meaning for " + carrier,
    async () => {
      assert.equal(noThinkingHandling("github", fixtureModel), "omit");
      const input = {
        ...body(),
        model: fixtureModel,
        reasoning_effort: "none",
        [carrier]: carrier === "output_config" ? { effort: "none" } : { type: "disabled" },
      };
      const before = structuredClone(input);
      const outcome = await captureExecute(fixtureModel, input);
      assert.equal(
        outcome.error,
        undefined,
        "qualified no-thinking semantic mapping must remain admissible"
      );
      assert.equal(outcome.wires.length, 1);
      assert.equal(Object.hasOwn(outcome.wires[0], carrier), false);
      assert.equal(Object.hasOwn(outcome.wires[0], "reasoning_effort"), false);
      assert.deepEqual(outcome.wires[0].messages, before.messages);
      assert.deepEqual(input, before);
    }
  );
}

test("review: payload filter cannot erase messages before native executor capture", async () => {
  setPayloadRulesConfig({
    default: [],
    override: [],
    defaultRaw: [],
    filter: [{ models: [{ name: "claude-sonnet-4.6" }], params: ["messages"] }],
  });
  const input = body();
  const before = structuredClone(input);
  try {
    await assert.rejects(
      prepareUpstreamBody({
        translatedBody: input,
        modelToCall: "claude-sonnet-4.6",
        provider: "github",
        targetFormat: "claude",
        credentials: null,
      }),
      (error: unknown) =>
        error instanceof RequestCompatibilityError && error.code === "request_integrity_mismatch"
    );
    assert.deepEqual(input, before);
  } finally {
    clearPayloadRulesConfigOverride();
  }
});

test("review: unknown active context continuation rejects before mock transport", async () => {
  const input = {
    ...body(),
    messages: [
      { role: "assistant", content: "prior" },
      { role: "user", content: "continue" },
    ],
    context_management: { edits: [{ type: "future-edit", keep: "all" }] },
  };
  const outcome = await captureExecute("claude-sonnet-4.6", input);
  assert.ok(outcome.error instanceof RequestCompatibilityError);
  assert.equal(outcome.error.code, "request_context_management_unavailable");
  assert.equal(outcome.wires.length, 0);
});

test("review: explicit wire override wins over registry default in target assessment", () => {
  assert.equal(
    resolveRequestCompatibilityTarget(body(), "github", "claude-sonnet-4.6", "openai-responses")
      .contextManagement,
    "unknown"
  );
  assert.equal(
    resolveRequestCompatibilityTarget(body(), "github", "claude-sonnet-4.6").contextManagement,
    "unsupported"
  );
});

for (const carrier of ["output_config", "output_format"] as const)
  test(
    "review: real handler refuses unsupported native " + carrier + " before capture",
    async () => {
      const originalFetch = globalThis.fetch;
      const wires: Record<string, unknown>[] = [];
      globalThis.fetch = async (_url, options) => {
        wires.push(JSON.parse(String(options?.body)));
        return Response.json({
          id: "fixture-message",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4.6",
          content: [{ type: "text", text: "{}" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      };
      try {
        const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
        const { getExecutor } = await import("../../open-sse/executors/index.ts");
        const executor = getExecutor("github");
        const originalRefresh = executor.needsRefresh;
        const originalHeaders = executor.buildHeaders;
        executor.needsRefresh = () => false;
        executor.buildHeaders = () => ({});
        const format = { type: "json_schema", schema: { type: "object", required: ["fixture"] } };
        const input = { ...body(), [carrier]: carrier === "output_config" ? { format } : format };
        const before = structuredClone(input);
        try {
          const result = await handleChatCore({
            body: input,
            modelInfo: { provider: "github", model: "claude-sonnet-4.6" },
            credentials: {},
            clientRawRequest: { endpoint: "/v1/messages", headers: {} },
            cachedSettings: {},
            log: { info() {}, warn() {}, debug() {}, error() {} },
            skipUpstreamRetry: true,
          } as never);
          const response = result instanceof Response ? result : result.response;
          assert.equal(wires.length, 0, "unsupported schema must be refused before dispatch");
          assert.equal(
            response.status,
            422,
            "unsupported required output control must refuse clearly"
          );
          assert.deepEqual(await response.json(), {
            error: {
              type: "invalid_request_error",
              code: "request_required_control_unsupported",
              message: "Selected target cannot preserve required request features.",
            },
          });
          assert.deepEqual(input, before);
        } finally {
          executor.needsRefresh = originalRefresh;
          executor.buildHeaders = originalHeaders;
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
