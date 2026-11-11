import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-task-fit-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network forbidden in routing task-fit fixture");
};
const { resolveTaskProfile, validateTaskProfile } =
  await import("../../open-sse/services/autoCombo/taskProfile.ts");
const { operationalReliability } =
  await import("../../open-sse/services/autoCombo/rankingEvidence.ts");
const { rankFitFirstFreeCandidates } =
  await import("../../open-sse/services/autoCombo/fitFirstPolicy.ts");
const { resolveAutoStrategyOrder } =
  await import("../../open-sse/services/combo/resolveAutoStrategy.ts");
const { resetDbInstance, getDbInstance } = await import("../../src/lib/db/core.ts");
after(() => {
  resetDbInstance();
  globalThis.fetch = originalFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const fallback = {
  taskType: "general",
  complexity: "light",
  requiredCapabilities: [],
  confidence: 0,
} as const;
const valid = {
  taskType: "planning",
  complexity: "heavy",
  requiredCapabilities: [],
  confidence: 0.9,
};
const body = { messages: [{ role: "user", content: "private-fixture-full-input" }] };
test("unconfigured interpreter is explicitly deterministic and performs no call", async () => {
  const result = await resolveTaskProfile({
    body,
    fallback: { ...fallback, requiredCapabilities: [] },
  });
  assert.equal(result.source, "deterministic");
  assert.equal(result.fallbackReason, "not_configured");
});
test("profile schema rejects unknown authority and malformed requirements", () => {
  for (const value of [
    null,
    [],
    { ...valid, provider: "paid" },
    { ...valid, confidence: NaN },
    { ...valid, confidence: 1.1 },
    { ...valid, taskType: "admin" },
    { ...valid, requiredCapabilities: ["all"] },
  ])
    assert.equal(validateTaskProfile(value), null);
  assert.deepEqual(validateTaskProfile(valid), valid);
});
test("valid interpreter gets complete copied input but cannot alter inference payload", async () => {
  const original = structuredClone(body);
  const result = await resolveTaskProfile({
    body,
    fallback: { ...fallback, requiredCapabilities: [] },
    interpreter: {
      async interpret(request) {
        assert.deepEqual(request, original);
        request.messages = [];
        return valid;
      },
    },
  });
  assert.equal(result.source, "interpreter");
  assert.deepEqual(body, original);
});
test("invalid and thrown interpreter results fall back without exception prose", async () => {
  for (const [value, reason] of [
    [{ ...valid, model: "injected" }, "invalid_profile"],
    [new Error("private-error"), "interpreter_error"],
  ] as const) {
    const result = await resolveTaskProfile({
      body,
      fallback: { ...fallback, requiredCapabilities: [] },
      interpreter: {
        async interpret() {
          if (value instanceof Error) throw value;
          return value;
        },
      },
    });
    assert.equal(result.fallbackReason, reason);
    assert.equal(JSON.stringify(result).includes("private-error"), false);
  }
});
test("stalled interpreter returns bounded fallback and signals cancellation, without retry", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const result = await resolveTaskProfile({
    body,
    fallback: { ...fallback, requiredCapabilities: [] },
    budgetMs: 5,
    interpreter: {
      async interpret(_request, options) {
        calls++;
        signal = options.signal;
        return new Promise(() => {});
      },
    },
  });
  assert.equal(result.fallbackReason, "timeout");
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});
test("expired interpretation budget causes zero calls", async () => {
  let calls = 0;
  const result = await resolveTaskProfile({
    body,
    fallback: { ...fallback, requiredCapabilities: [] },
    budgetMs: 0,
    interpreter: {
      async interpret() {
        calls++;
        return valid;
      },
    },
  });
  assert.equal(result.fallbackReason, "timeout");
  assert.equal(calls, 0);
});
test("caller cancellation during interpreter is propagated, never deterministic fallback", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Cancelled", "AbortError");
  await assert.rejects(
    resolveTaskProfile({
      body,
      fallback: { ...fallback, requiredCapabilities: [] },
      signal: controller.signal,
      interpreter: {
        async interpret() {
          controller.abort(reason);
          return valid;
        },
      },
    }),
    (error) => error === reason
  );
});
test("synchronous overdue interpreter success is not accepted before timer runs", async () => {
  const result = await resolveTaskProfile({
    body,
    fallback: { ...fallback, requiredCapabilities: [] },
    budgetMs: 1,
    interpreter: {
      async interpret() {
        const until = performance.now() + 4;
        while (performance.now() < until) {}
        return valid;
      },
    },
  });
  assert.equal(result.fallbackReason, "timeout");
});

const now = Date.parse("2026-11-04T12:00:00Z");
function provenance(count = 10, delta = 0): any {
  return {
    health: {
      source: "usage_24h",
      sampleCount: count,
      windowHours: 24,
      evaluatedAt: new Date(now - delta).toISOString(),
      latestObservationAt: null,
    },
  };
}
test("zero errors without samples is neutral, not perfect or answer quality", () => {
  assert.deepEqual(operationalReliability({ errorRate: 0 }, now), {
    score: 0.5,
    confidence: 0,
    sampleCount: 0,
    source: "neutral_prior",
    reason: "missing_or_stale",
  });
});
test("recent HTTP samples receive bounded Bayesian operational evidence", () => {
  const result = operationalReliability({ errorRate: 0, provenance: provenance(10) }, now);
  assert.equal(result.score, 12 / 14);
  assert.equal(result.confidence, 10 / 30);
  assert.equal(
    operationalReliability({ errorRate: 0, provenance: provenance(1000000) }, now).sampleCount,
    1000
  );
});
test("stale, future, malformed rate and unknown process lifetime observations are neutral", () => {
  for (const candidate of [
    { errorRate: 0, provenance: provenance(10, 60_001) },
    { errorRate: 0, provenance: provenance(10, -1) },
    { errorRate: NaN, provenance: provenance() },
    { errorRate: 0, failureRate: 2, provenance: provenance() },
    { errorRate: 0, provenance: { health: { ...provenance().health, source: "runtime_process" } } },
  ])
    assert.equal(operationalReliability(candidate as any, now).source, "neutral_prior");
});
test("fresh timestamp alone does not turn process-lifetime samples into a bounded window", () => {
  const p = provenance();
  p.health.source = "runtime_process";
  p.health.latestObservationAt = new Date(now).toISOString();
  // Process totals have no bounded-window proof; the scorer should not manufacture one.
  assert.equal(
    operationalReliability({ errorRate: 0.1, provenance: p }, now).source,
    "neutral_prior"
  );
});

function candidate(provider = "new-provider", model = "new-model", extra = {}): any {
  return {
    provider,
    model,
    modelStr: `${provider}/${model}`,
    stepId: `${provider}-${model}`,
    executionKey: `${provider}/${model}`,
    connectionId: `fixture-${provider}`,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 0,
    p95LatencyMs: 50,
    latencyStdDev: 0,
    errorRate: 0,
    ...extra,
  };
}
test("newly discovered model remains eligible with neutral evidence, not fabricated quality", () => {
  const result = rankFitFirstFreeCandidates({
    candidates: [candidate()],
    body,
    zeroAdditionalCostProviders: ["new-provider"],
    now,
  });
  assert.equal(result.ranked.length, 1);
  const factors = result.ranked[0].factors;
  assert.equal(factors.reliability, 0.5);
  assert.equal(factors.reliabilityConfidence, 0);
  assert.equal(factors.answerQuality, null);
  assert.equal(factors.answerQualitySource, "unavailable");
  assert.equal(factors.latencyFit, 0.5);
});
test("advisory profile cannot lower structural complexity or wire requirements", () => {
  const result = rankFitFirstFreeCandidates({
    candidates: [candidate()],
    body: {
      messages: [{ role: "user", content: "x".repeat(100001) }],
      tools: [{ type: "function" }],
    },
    zeroAdditionalCostProviders: ["new-provider"],
    taskProfile: {
      source: "interpreter",
      fallbackReason: null,
      profile: { ...fallback, requiredCapabilities: [] },
    },
  });
  assert.equal(result.taskLevel, "critical");
  assert.deepEqual(result.requiredCapabilities, ["tools"]);
  assert.equal(result.ranked.length, 0);
  assert.equal(result.excluded[0].reason, "capability_unverified_tools");
});
test("AI-added vision is checked factually and never re-admits unauthorized candidates", () => {
  const result = rankFitFirstFreeCandidates({
    candidates: [candidate(), candidate("paid", "claude-sonnet-5")],
    body,
    zeroAdditionalCostProviders: ["new-provider"],
    taskProfile: {
      source: "interpreter",
      fallbackReason: null,
      profile: { ...valid, requiredCapabilities: ["vision"] } as any,
    },
  });
  assert.equal(result.ranked.length, 0);
  assert.deepEqual(
    new Set(result.excluded.map((e) => e.reason)),
    new Set(["capability_mismatch_vision", "not_verified_zero_additional_cost"])
  );
});
test("recent reliability and task fitness remain distinct from unavailable answer quality", () => {
  const result = rankFitFirstFreeCandidates({
    candidates: [candidate("new-provider", "same", { provenance: provenance(20), errorRate: 0 })],
    body,
    zeroAdditionalCostProviders: ["new-provider"],
    now,
  });
  assert.ok(result.ranked[0].factors.reliability > 0.5);
  assert.equal(result.ranked[0].factors.answerQuality, null);
});
test("actual resolver integrates validated task profile, factual gates and privacy-safe diagnostics", async () => {
  const targets = [
    candidate("codex", "gpt-5.6-sol"),
    candidate("claude", "claude-opus-4-7"),
    candidate("paid", "imaginary"),
  ].map((c) => ({ ...c, kind: "model", weight: 1, providerId: null, label: null }));
  let calls = 0;
  const result = await resolveAutoStrategyOrder({
    orderedTargets: targets,
    body,
    combo: {
      name: "fixture-task-profile",
      strategy: "auto",
      config: {
        selectionPolicy: "fit-first-free",
        zeroAdditionalCostProviders: ["codex", "claude"],
        explorationRate: 0,
      },
    },
    settings: null,
    config: {},
    resilienceSettings: { quotaPreflight: { enabled: false } },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    relayOptions: { routingRequestId: "task-profile-fixture-request" },
    buildAutoCandidates: async () => targets,
    expandAutoCandidatePool: async (values) => values,
    isModelAvailable: async (model) => !model.startsWith("codex/"),
    taskInterpreter: {
      async interpret(request) {
        calls++;
        assert.deepEqual(request, body);
        return valid;
      },
    },
  } as any);
  assert.ok("orderedTargets" in result);
  if (!("orderedTargets" in result)) return;
  assert.deepEqual(
    result.orderedTargets.map((t) => t.provider),
    ["claude"]
  );
  assert.equal(calls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  const row = getDbInstance()
    .prepare(
      "SELECT factors_json, task_type FROM routing_decisions WHERE request_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get("task-profile-fixture-request") as any;
  assert.equal(row.task_type, "planning");
  const factors = JSON.parse(row.factors_json);
  assert.equal(factors.taskProfileSource, "interpreter");
  assert.equal(factors.taskProfileFallbackReason, null);
  assert.equal(factors.answerQualityEvidence, "unavailable");
  assert.equal(row.factors_json.includes("private-fixture-full-input"), false);
});

test("advisory complexity updates both level and weight used by actual task scorer", async () => {
  const { classifyTask, scoreModelForTask, TASK_LEVEL_WEIGHT } =
    await import("../../open-sse/services/taskAwareRouting.ts");
  const c = candidate("fixture", "gpt-4o-pro");
  const result = rankFitFirstFreeCandidates({
    candidates: [c],
    body,
    zeroAdditionalCostProviders: ["fixture"],
    taskProfile: { source: "interpreter", fallbackReason: null, profile: valid as any },
  });
  const expectedTask = {
    ...classifyTask(body),
    level: "heavy" as const,
    weight: TASK_LEVEL_WEIGHT.heavy,
  };
  assert.equal(result.taskLevel, "heavy");
  assert.equal(
    result.ranked[0].factors.complexityFit,
    Math.max(0, Math.min(1, scoreModelForTask(c.modelStr, expectedTask, new Set()) / 100))
  );
});

test("a model measured as mostly failing does not keep the full health factor", () => {
  // The health check reads the real clock, so this evidence is stamped with it.
  const live = (count: number): any => ({
    health: {
      source: "usage_24h",
      sampleCount: count,
      windowHours: 24,
      evaluatedAt: new Date().toISOString(),
      latestObservationAt: null,
    },
  });
  const result = rankFitFirstFreeCandidates({
    candidates: [
      candidate("new-provider", "failing", { errorRate: 0.98, provenance: live(115) }),
      candidate("new-provider", "working", { errorRate: 0.02, provenance: live(115) }),
      candidate("new-provider", "few-samples", { errorRate: 0.6, provenance: live(12) }),
      candidate("new-provider", "untried"),
    ],
    body,
    zeroAdditionalCostProviders: ["new-provider"],
  });
  const health = Object.fromEntries(
    result.ranked.map((entry) => [entry.candidate.model, entry.factors.health])
  );
  assert.ok(health.failing < 0.1, `failing model kept health ${health.failing}`);
  assert.equal(health.working, 1);
  assert.equal(health["few-samples"], 1, "too few samples to call a model failing");
  assert.equal(health.untried, 0.5);
  assert.ok(
    health.failing < health.untried,
    "a proven-failing model must rank below an untried one"
  );
});
