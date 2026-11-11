import test from "node:test";
import assert from "node:assert/strict";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import {
  noThinkingIntent,
  noThinkingHandling,
} from "../../open-sse/services/reasoningEffortCompatibility.ts";
import {
  filterTargetsByRequestCompatibility,
  computeCompatRejectedTargets,
  describeCapabilityFilterExhaustion,
} from "../../open-sse/services/combo/comboStructure.ts";
import { rankFitFirstFreeCandidates } from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import { sanitizeReasoningEffortForProvider } from "../../open-sse/executors/base/reasoningEffort.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { setParamFilterConfig, deleteParamFilterConfig } from "../../src/lib/db/paramFilters.ts";
import { handleComboChat } from "../../open-sse/services/combo.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { replaceSyncedAvailableModelsForConnection } from "../../src/lib/db/models.ts";
import { sanitizeRequestForResolvedTarget } from "../../open-sse/services/targetRequestSanitizer.ts";

import { prepareUpstreamBody } from "../../open-sse/handlers/chatCore/upstreamBody.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import {
  setPayloadRulesConfig,
  clearPayloadRulesConfigOverride,
} from "../../open-sse/services/payloadRules.ts";

const NEMO = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const GLM = "z-ai/glm-5.2";
const GLM53 = "z-ai/glm-5.3-flash";
const MINI = "minimaxai/minimax-m3.1-flash";
const OMIT = "fixture-proven-nonthinking";
const UNKNOWN = "fixture-unknown";
const registry = getRegistryEntry("nvidia")!;
const gh = getRegistryEntry("github")!;
const log = { info() {}, warn() {}, error() {}, debug() {} };
const target = (model: string) => ({ provider: "nvidia", model, modelStr: `nvidia/${model}` });
const body = {
  messages: [{ role: "user", content: "Analyze the quoted product rate" }],
  reasoning_effort: "none",
  max_tokens: 2000,
  response_format: {
    type: "json_schema",
    json_schema: { name: "rates", schema: { type: "object" } },
  },
};

test.before(() => {
  registry.models.push({
    id: OMIT,
    name: "Offline endpoint fixture",
    supportsReasoning: false,
    supportedThinkingEfforts: ["none"],
    reasoningEffortNoneHandling: "omit",
  });
  gh.models.push({
    id: OMIT,
    name: "Offline alias fixture",
    supportsReasoning: false,
    supportedThinkingEfforts: ["none"],
    reasoningEffortNoneHandling: "omit",
  });
});
test.after(() => {
  registry.models.splice(
    registry.models.findIndex((m) => m.id === OMIT),
    1
  );
  gh.models.splice(
    gh.models.findIndex((m) => m.id === OMIT),
    1
  );
  deleteParamFilterConfig("nvidia");
  resetDbInstance();
});

test("exact endpoint metadata distinguishes documented modes and provider aliases", () => {
  assert.equal(noThinkingHandling("nvidia", NEMO), "native");
  assert.equal(noThinkingHandling("nvidia", GLM), "native");
  assert.equal(noThinkingHandling("nvidia", GLM53), null);
  assert.equal(noThinkingHandling("nvidia", MINI), null);
  assert.equal(noThinkingHandling("nvidia", UNKNOWN), null);
  assert.equal(noThinkingHandling("openai", NEMO), null);
  assert.equal(noThinkingHandling("gh", OMIT), "omit");
  assert.deepEqual(getResolvedModelCapabilities(`nvidia/${GLM53}`).supportedThinkingEfforts, [
    "low",
    "high",
    "max",
  ]);
});

test("canonical synced declarations are reused only for the exact provider/model and consistent active connections", async () => {
  const model = "fixture-synced-native-none";
  const a = await createProviderConnection({
    provider: "github",
    authType: "apikey",
    name: "offline-effort-A",
    apiKey: "offline-fixture-only",
    isActive: true,
  });
  await replaceSyncedAvailableModelsForConnection("github", a.id, [
    { id: model, name: model, supportedThinkingEfforts: ["none", "low"] },
  ]);
  assert.equal(noThinkingHandling("gh", model), "native");
  assert.equal(noThinkingHandling("nvidia", model), null);
  const b = await createProviderConnection({
    provider: "github",
    authType: "apikey",
    name: "offline-effort-B",
    apiKey: "offline-fixture-only",
    isActive: true,
  });
  await replaceSyncedAvailableModelsForConnection("github", b.id, [
    { id: model, name: model, supportedThinkingEfforts: ["low"] },
  ]);
  assert.equal(
    noThinkingHandling("github", model),
    null,
    "different account declarations cannot be unioned optimistically"
  );
});

test("every generic carrier is recognized and conflicting native/effort controls are rejected", () => {
  for (const request of [
    { reasoning_effort: "none" },
    { reasoning: { effort: "none" } },
    { output_config: { effort: "none" } },
  ]) {
    assert.equal(noThinkingIntent(request).requested, true);
    assert.equal(noThinkingIntent(request).conflict, false);
  }
  for (const request of [
    { reasoning_effort: "none", reasoning: { effort: "high" } },
    { output_config: { effort: "none" }, chat_template_kwargs: { enable_thinking: true } },
    { reasoning: { effort: "none" }, thinking: { type: "enabled" } },
    { reasoning_effort: "none", output_config: { effort: 5 } },
    { reasoning_effort: "none", thinking_token_budget: 512 },
    { reasoning_effort: "none", reasoning: "invalid" },
  ]) {
    assert.equal(noThinkingIntent(request).conflict, true);
    assert.equal(
      filterTargetsByRequestCompatibility([target(NEMO)] as any, request, log).length,
      0
    );
    assert.throws(() => sanitizeReasoningEffortForProvider(request, "nvidia", NEMO), /Conflicting/);
  }
});

test("native-only Claude disabled requests and absent-effort planner behavior are preserved", () => {
  const native = { messages: [], thinking: { type: "disabled" } };
  assert.equal(noThinkingIntent(native).requested, false);
  assert.equal(
    filterTargetsByRequestCompatibility(
      [{ provider: "claude", modelStr: "claude/claude-sonnet-4-6" }] as any,
      native,
      log
    ).length,
    1
  );
  assert.equal(sanitizeReasoningEffortForProvider(native, "claude", "claude-sonnet-4-6"), native);
  const rawUnknown = { messages: [], reasoning_effort: "none" };
  assert.equal(
    sanitizeReasoningEffortForProvider(rawUnknown, "raw-passthrough-provider", "unknown-model"),
    rawUnknown,
    "unknown direct behavior is unchanged; automatic combos fail closed separately"
  );
  const unbounded = { messages: [{ role: "user", content: "Plan a coherent trip" }] };
  assert.equal(
    filterTargetsByRequestCompatibility([target(GLM53), target(MINI)] as any, unbounded, log)
      .length,
    2
  );
});

test("two supported models remain eligible while incompatible and unknown modes fail closed", () => {
  const pool = [
    target(GLM53),
    target(UNKNOWN),
    target(NEMO),
    target(GLM),
    target(OMIT),
    target(MINI),
  ];
  assert.deepEqual(
    filterTargetsByRequestCompatibility(pool as any, body, log).map((t) => t.model),
    [NEMO, GLM, OMIT]
  );
  for (const failOpen of [false, true]) {
    assert.deepEqual(
      filterTargetsByRequestCompatibility(
        [target(GLM53), target(MINI), target(UNKNOWN)] as any,
        body,
        log,
        undefined,
        { failOpen }
      ),
      []
    );
  }
  const exhausted = describeCapabilityFilterExhaustion(
    [target(GLM53), target(UNKNOWN)] as any,
    body,
    "bounded-source"
  );
  assert.ok(exhausted?.unmet.includes("reasoning_effort_none"));
  assert.match(exhausted!.message, /reasoning effort none/);
});

test("context/vision fail-open and rejected-target fallback never resurrect none-incompatible targets", () => {
  const pool = [target(GLM53), target(UNKNOWN), target(NEMO)];
  const vision = {
    ...body,
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }],
      },
    ],
  };
  assert.deepEqual(
    filterTargetsByRequestCompatibility(pool as any, vision, log, undefined, {
      failOpen: true,
    }).map((t) => t.model),
    [NEMO]
  );
  assert.deepEqual(
    computeCompatRejectedTargets(pool as any, [], body).map((t) => t.model),
    [NEMO]
  );
  const overflow = { ...body, messages: [{ role: "user", content: "x".repeat(200000) }] };
  assert.ok(
    filterTargetsByRequestCompatibility(pool as any, overflow, log, undefined, {
      failOpen: true,
    }).every((t) => t.model === NEMO)
  );
});

test("fit-first hard eligibility uses metadata without pinning the selected provider/model", () => {
  const candidates = [GLM53, MINI, UNKNOWN, NEMO, GLM, OMIT].map((model) => ({
    ...target(model),
    quotaRemaining: 100,
    circuitBreakerState: "CLOSED" as const,
    costPer1MTokens: 0,
    p95LatencyMs: 100,
    errorRate: 0,
  }));
  const result = rankFitFirstFreeCandidates({
    candidates,
    body,
    zeroAdditionalCostProviders: ["nvidia"],
  });
  assert.deepEqual(
    new Set(result.ranked.map((r) => r.candidate.model)),
    new Set([NEMO, GLM, OMIT])
  );
  assert.equal(
    result.excluded.filter((r) => r.reason === "capability_unverified_reasoning_effort_none")
      .length,
    3
  );
});

test("final wire omits controls only for explicitly proven nonthinking endpoints after DB allowlist restore", async () => {
  const originalFetch = globalThis.fetch;
  let wire: any;
  try {
    setParamFilterConfig("nvidia", { block: ["reasoning_effort"], allow: ["reasoning_effort"] });
    const prepared = sanitizeReasoningEffortForProvider(body, "nvidia", OMIT) as any;
    assert.equal(
      prepared.reasoning_effort,
      "none",
      "preserve explicit intent until the last dispatch boundary"
    );
    globalThis.fetch = async (_input, options) => {
      wire = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          model: OMIT,
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }],
        }),
        { status: 200 }
      );
    };
    await new DefaultExecutor("nvidia").execute({
      model: OMIT,
      body: { ...body, model: OMIT },
      stream: false,
      credentials: { apiKey: "offline-fixture-only" },
    });
    assert.equal(wire.max_tokens, 2000);
    assert.equal(Object.hasOwn(wire, "reasoning_effort"), false);
    assert.equal(Object.hasOwn(wire, "chat_template_kwargs"), false);
    assert.deepEqual(wire.response_format, body.response_format);
  } finally {
    globalThis.fetch = originalFetch;
    deleteParamFilterConfig("nvidia");
  }
});

test("original generic none survives target sanitation and native transform before final wire", async () => {
  const originalFetch = globalThis.fetch;
  let wire: any;
  try {
    const prepared = sanitizeRequestForResolvedTarget(
      { ...body, model: NEMO },
      { provider: "nvidia", model: NEMO }
    );
    assert.equal(prepared.reasoning_effort, "none");
    globalThis.fetch = async (_input, options) => {
      wire = JSON.parse(String(options?.body));
      return new Response("{}");
    };
    await new DefaultExecutor("nvidia").execute({
      model: NEMO,
      body: prepared,
      stream: false,
      credentials: { apiKey: "offline-fixture-only" },
    });
    assert.deepEqual(wire.chat_template_kwargs, { enable_thinking: false });
    assert.equal(wire.thinking_token_budget, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dropping the native no-thinking switch after transformation cannot re-enable reasoning or dispatch", async () => {
  const originalFetch = globalThis.fetch;
  let dispatches = 0;
  try {
    setParamFilterConfig("nvidia", { block: ["chat_template_kwargs"], allow: [] });
    const prepared = sanitizeRequestForResolvedTarget(
      { ...body, model: NEMO },
      { provider: "nvidia", model: NEMO }
    );
    assert.equal(prepared.reasoning_effort, "none");
    globalThis.fetch = async () => {
      dispatches++;
      return new Response("{}");
    };
    await assert.rejects(
      () =>
        new DefaultExecutor("nvidia").execute({
          model: NEMO,
          body: prepared,
          stream: false,
          credentials: { apiKey: "offline-fixture-only" },
        }),
      /reasoning effort none was removed/
    );
    assert.equal(dispatches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    deleteParamFilterConfig("nvidia");
  }
});

test("all unknown/incompatible pools fail before any provider dispatch, including round-robin", async () => {
  for (const strategy of ["priority", "round-robin"]) {
    let dispatches = 0;
    const response = await handleComboChat({
      body,
      combo: {
        name: "effort-none-offline",
        strategy,
        models: [`nvidia/${GLM53}`, `nvidia/${UNKNOWN}`],
        config: { compatFilterFailOpen: true, maxRetries: 0 },
      },
      log,
      handleSingleModel: async () => {
        dispatches++;
        return new Response("{}");
      },
      isModelAvailable: async () => true,
    } as any);
    assert.equal(response.status, 400);
    assert.equal(dispatches, 0);
  }
});

test("original none survives configured payload removal before native transformation", async () => {
  const originalFetch = globalThis.fetch;
  let wire: any;
  const requiredNoThinking = noThinkingIntent(body).genericRequested;
  try {
    setPayloadRulesConfig({
      default: [],
      override: [],
      defaultRaw: [],
      filter: [{ models: [{ name: NEMO }], params: ["reasoning_effort"] }],
    });
    const prepared = await prepareUpstreamBody({
      translatedBody: { ...body, model: NEMO },
      modelToCall: NEMO,
      provider: "nvidia",
      targetFormat: FORMATS.OPENAI,
      credentials: null,
      requiredNoThinking,
    });
    assert.equal(prepared.reasoning_effort, "none");
    globalThis.fetch = async (_input, options) => {
      wire = JSON.parse(String(options?.body));
      return new Response("{}");
    };
    await new DefaultExecutor("nvidia").execute({
      model: NEMO,
      body: prepared,
      requiredNoThinking,
      stream: false,
      credentials: { apiKey: "offline-fixture-only" },
    });
    assert.deepEqual(wire.chat_template_kwargs, { enable_thinking: false });
    assert.equal(wire.thinking_token_budget, undefined);
    assert.equal(wire.requiredNoThinking, undefined, "trusted intent is not an upstream parameter");
  } finally {
    globalThis.fetch = originalFetch;
    clearPayloadRulesConfigOverride();
  }
});

test("native-only Claude disabled translation keeps its existing path without generic admission", async () => {
  const nativeBody = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 100,
    thinking: { type: "disabled" },
  };
  const requiredNoThinking = noThinkingIntent(nativeBody).genericRequested;
  assert.equal(requiredNoThinking, false);
  const translated = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    "fixture-unknown",
    nativeBody,
    false,
    null
  );
  const prepared = await prepareUpstreamBody({
    translatedBody: translated,
    modelToCall: "fixture-unknown",
    provider: "nvidia",
    targetFormat: FORMATS.OPENAI,
    credentials: null,
    requiredNoThinking,
  });
  assert.equal(prepared.reasoning_effort, undefined);
  assert.equal(prepared.thinking_token_budget, undefined);
});
