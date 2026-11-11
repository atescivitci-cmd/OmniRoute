import test from "node:test";
import assert from "node:assert/strict";
import {
  accumulateLatencySample,
  buildLatencyStatsEntry,
  createLatencyBucket,
} from "../../src/lib/usage/usageHistory/helpers.ts";
import { candidateProvenance } from "../../open-sse/services/autoCombo/candidateProvenance.ts";
import { rankFitFirstFreeCandidates } from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { resolveDeadlineRoutingPolicy } from "../../open-sse/services/autoCombo/deadlineAwareRouting.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

test.after(() => resetDbInstance());
const now = Date.parse("2026-11-08T14:00:00Z");
const body = { messages: [{ role: "user", content: "Reply only: OK" }], max_tokens: 64 };
const providers = ["nvidia", "claude", "codex", "github"];
const model = "fixture-general-model";

function stats(successes: number, successfulMs = 100, failedMs = 1) {
  const bucket = createLatencyBucket("fixture", model);
  bucket.totalRequests = 10;
  bucket.successfulRequests = successes;
  for (let index = 0; index < 10; index++) {
    const success = index < successes;
    accumulateLatencySample(bucket, success ? successfulMs : failedMs, 1, success ? 5 : 0, success);
  }
  return buildLatencyStatsEntry(`fixture/${model}`, bucket, 3, 24)!;
}

function candidate(id: string, metric: ReturnType<typeof stats>, provider = "nvidia"): any {
  return {
    provider,
    model,
    modelStr: `${provider}/${model}`,
    connectionId: id,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: metric.p95LatencyMs,
    latencyStdDev: 10,
    errorRate: 1 - metric.successRate,
    latencySampleSource:
      metric.latencySampleSource === "successful" ? "successful_usage_24h" : "unqualified",
    successfulLatencySampleCount: metric.successfulLatencySampleCount,
    provenance: candidateProvenance({
      provider,
      connectionId: id,
      historical: true,
      historicalSamples: metric.totalRequests,
      runtimeSamples: 0,
      runtimeLatest: null,
      quota: null,
      now,
    }),
  };
}

function rank(candidates: any[], complexity: "light" | "standard" | "heavy" = "light") {
  return rankFitFirstFreeCandidates({
    candidates,
    body,
    zeroAdditionalCostProviders: providers,
    taskProfile: {
      source: "deterministic",
      fallbackReason: "not_configured",
      profile: { taskType: "general", complexity, requiredCapabilities: [], confidence: 1 },
    },
    now,
  });
}

test("aggregation labels fallback timing as all-attempt diagnostic evidence, with zero successes", () => {
  const result = stats(0);
  assert.equal(result.latencySampleSource, "all_attempts");
  assert.equal(result.latencySampleCount, 10);
  assert.equal(result.successfulLatencySampleCount, 0);
});

test("failed timing never alters sufficiently sampled successful latency", () => {
  const result = stats(3, 10000, 1);
  assert.equal(result.latencySampleSource, "successful");
  assert.equal(result.latencySampleCount, 3);
  assert.equal(result.successfulLatencySampleCount, 3);
  assert.equal(result.p95LatencyMs, 10000);
});

for (const complexity of ["light", "standard"] as const) {
  test(`${complexity}: fast failures never outrank reliable slower completion`, () => {
    const result = rank(
      [candidate("failed", stats(0)), candidate("working", stats(10, 10000))],
      complexity
    );
    assert.equal(result.ranked[0].candidate.connectionId, "working");
    const failed = result.ranked.find((entry) => entry.candidate.connectionId === "failed")!;
    assert.equal(failed.factors.latencyEvidence, "neutral_prior");
  });

  test(`${complexity}: three successes do not hide seven failures behind fast p95`, () => {
    const result = rank(
      [candidate("three-of-ten", stats(3)), candidate("working", stats(10, 10000))],
      complexity
    );
    assert.equal(result.ranked[0].candidate.connectionId, "working");
    // The bounded 24-hour aggregate has no ordering/sample-time proof. It must
    // not manufacture freshness for the three successes in this fixture.
    assert.equal(result.ranked[1].candidate.provenance.health.latestObservationAt, null);
  });

  test(`${complexity}: equally reliable successful candidates still prefer faster completion`, () => {
    const result = rank(
      [candidate("slow", stats(10, 10000)), candidate("fast", stats(10, 100))],
      complexity
    );
    assert.equal(result.ranked[0].candidate.connectionId, "fast");
    assert.equal(result.ranked[0].factors.latencyEvidence, "observed");
  });

  test(`${complexity}: missing latency's neutral prior cannot reward known all-failure history`, () => {
    const failed = candidate("failed", stats(0));
    delete failed.latencySampleSource;
    delete failed.successfulLatencySampleCount;
    const result = rank([failed, candidate("working", stats(10, 10000))], complexity);
    assert.equal(result.ranked[0].candidate.connectionId, "working");
  });
}

test("cold-start remains eligible with neutral operational evidence, never manufactured samples", () => {
  const cold = candidate("cold", stats(0));
  delete cold.provenance;
  delete cold.latencySampleSource;
  delete cold.successfulLatencySampleCount;
  const result = rank([cold]);
  assert.equal(result.ranked.length, 1);
  assert.equal(result.ranked[0].factors.reliability, 0.5);
  assert.equal(result.ranked[0].factors.reliabilitySampleCount, 0);
  assert.equal(result.ranked[0].factors.latencyFit, 0.5);
  assert.equal(result.ranked[0].factors.latencyEvidence, "neutral_prior");
});

test("success source, count, finite timing and bounded reliability evidence are all required", () => {
  const base = candidate("fixture", stats(10));
  for (const overrides of [
    { latencySampleSource: "all_attempts" },
    { successfulLatencySampleCount: 2 },
    { successfulLatencySampleCount: NaN },
    { successfulLatencySampleCount: 3.5 },
    { successfulLatencySampleCount: 11 },
    { p95LatencyMs: NaN },
    { p95LatencyMs: 0 },
    {
      provenance: {
        health: { ...base.provenance.health, evaluatedAt: new Date(now - 60001).toISOString() },
      },
    },
    { provenance: { health: { ...base.provenance.health, source: "runtime_process" } } },
  ]) {
    assert.equal(
      rank([{ ...base, ...overrides }]).ranked[0].factors.latencyEvidence,
      "neutral_prior"
    );
  }
});

test("large valid successful sample counts are not confused with capped reliability influence", () => {
  const sampled = candidate("many-successes", stats(10));
  sampled.provenance.health.sampleCount = 5000;
  sampled.successfulLatencySampleCount = 4000;
  assert.equal(rank([sampled]).ranked[0].factors.latencyEvidence, "observed");
});

for (const successes of [0, 3]) {
  test(`actual candidate assembly carries ${successes}-success timing provenance without failure speed`, async () => {
    const { saveRequestUsage } = await import("../../src/lib/usage/usageHistory.ts");
    const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
    const provider = "nvidia";
    const model = `latency-evidence-${successes}`;
    for (let index = 0; index < 10; index++) {
      const success = index < successes;
      await saveRequestUsage({
        provider,
        model,
        success,
        latencyMs: success ? 6000 : 1,
        timeToFirstTokenMs: success ? 1000 : 1,
        tokens: { input: 1, output: success ? 5 : 0 },
        timestamp: new Date(Date.now() - index * 1000).toISOString(),
      });
    }
    // This synthetic target has no connection or credentials in the isolated
    // fixture database; candidate construction cannot fetch quota or dispatch.
    const [assembled] = await buildAutoCandidates(
      [
        {
          kind: "model",
          provider,
          modelStr: `${provider}/${model}`,
          stepId: model,
          executionKey: model,
          connectionId: null,
        },
      ] as any,
      "fixture-latency-evidence"
    );
    assert.equal(assembled.successfulLatencySampleCount, successes);
    assert.equal(
      assembled.latencySampleSource,
      successes === 0 ? "unqualified" : "successful_usage_24h"
    );
    assert.equal(assembled.p95LatencyMs, successes === 0 ? 1500 : 6000);
    assert.equal(assembled.avgE2ELatencyMs, successes === 0 ? undefined : 6000);
    assert.equal(assembled.provenance?.health.latestObservationAt, null);
  });
}

for (const provider of providers) {
  test(`${provider}: identical factual evidence uses the same reliability-versus-speed rule`, () => {
    const result = rank([
      candidate("unreliable", stats(3), provider),
      candidate("working", stats(10, 10000), provider),
    ]);
    assert.equal(result.ranked[0].candidate.connectionId, "working");
  });
}

test("heavy requests retain zero speed influence", () => {
  const result = rank(
    [candidate("slow", stats(10, 10000)), candidate("fast", stats(10, 100))],
    "heavy"
  );
  assert.equal(result.ranked[0].factors.score, result.ranked[1].factors.score);
});

test("capability, quota, cost-pool and circuit exclusions remain authoritative", () => {
  const candidates = [
    { ...candidate("quota", stats(10)), quotaRemaining: 0 },
    { ...candidate("circuit", stats(10)), circuitBreakerState: "OPEN" },
    candidate("paid", stats(10), "not-authorized"),
  ];
  assert.deepEqual(
    new Set(rank(candidates).excluded.map((entry) => entry.reason)),
    new Set(["quota_unavailable", "circuit_open", "not_verified_zero_additional_cost"])
  );
  const vision = rankFitFirstFreeCandidates({
    candidates: [candidate("no-vision", stats(10))],
    body: {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
        },
      ],
    },
    zeroAdditionalCostProviders: providers,
    now,
  });
  assert.equal(vision.excluded[0].reason, "capability_mismatch_vision");
});

test("deadline evidence remains opt-in and cannot qualify ordinary streaming/tool conversation", () => {
  assert.equal(resolveDeadlineRoutingPolicy({}, body), null);
  assert.equal(
    resolveDeadlineRoutingPolicy(
      { deadlineAwareRouting: true, comboTimeoutMs: 65000 },
      { ...body, stream: true }
    ),
    null
  );
  assert.equal(
    resolveDeadlineRoutingPolicy(
      { deadlineAwareRouting: true, comboTimeoutMs: 65000 },
      {
        ...body,
        stream: false,
        response_format: { type: "json_object" },
        tools: [],
      }
    ),
    null
  );
  assert.equal(
    resolveDeadlineRoutingPolicy(
      { deadlineAwareRouting: true, comboTimeoutMs: 65000 },
      {
        ...body,
        stream: false,
        response_format: { type: "json_object" },
      }
    )?.deadlineMs,
    65000
  );
});
