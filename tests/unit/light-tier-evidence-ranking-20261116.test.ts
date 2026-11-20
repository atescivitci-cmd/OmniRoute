import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { candidateProvenance } from "../../open-sse/services/autoCombo/candidateProvenance.ts";
import {
  rankFitFirstFreeCandidates,
  type FitFirstCandidate,
  type FitFirstFactors,
} from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import {
  LIGHT_LATENCY_NEUTRAL_MS,
  LIGHT_SHIFT_TO_LATENCY,
  LIGHT_SHIFT_TO_RELIABILITY,
  latencyEvidenceFit,
  lightEvidenceWeights,
} from "../../open-sse/services/autoCombo/lightEvidenceProfile.ts";
import {
  clearUserFitnessOverride,
  setUserFitnessOverride,
} from "../../open-sse/services/autoCombo/taskFitness.ts";
import {
  clearModelsDevCapabilities,
  saveModelsDevCapabilities,
} from "../../src/lib/modelsDevSync.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

// Everything here is synthetic: ids are prov-x/model-y, never real catalog names. The
// owner's rule is "let the selector select": no id, family or provider text may decide
// an outcome, and test 8 plus the source scan below guard that.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTO_DIR = path.resolve(HERE, "../../open-sse/services/autoCombo");
const REPO = path.resolve(HERE, "../..");
const BASE_REF = "80f01f4b6e"; // the installed gateway build (pre-change)
const FLAG = "ROUTING_LIGHT_BY_ASK";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const PROVIDERS = ["prov-a", "prov-b", "prov-c", "prov-q"];
const LEGACY_LIGHT = {
  task: 0.32,
  complexity: 0.28,
  health: 0.08,
  quota: 0.07,
  reliability: 0.2,
  latency: 0.05,
};

type Level = "light" | "standard" | "heavy" | "critical";
const LEVELS: Level[] = ["light", "standard", "heavy", "critical"];
const body = { messages: [{ role: "user", content: "Reply only: OK" }], max_tokens: 64 };

let baseline: { rankFitFirstFreeCandidates: typeof rankFitFirstFreeCandidates };
const baselineFile = path.join(AUTO_DIR, "__baseline_fitFirstPolicy_20261116.tmp.ts");

test.before(async () => {
  const source = execFileSync(
    "git",
    ["show", `${BASE_REF}:open-sse/services/autoCombo/fitFirstPolicy.ts`],
    { cwd: REPO, encoding: "utf8" }
  );
  assert.ok(source.includes("export function rankFitFirstFreeCandidates"));
  fs.writeFileSync(baselineFile, source);
  baseline = await import(pathToFileURL(baselineFile).href);
});

test.after(() => {
  fs.rmSync(baselineFile, { force: true });
  clearModelsDevCapabilities();
  resetDbInstance();
});

function withFlag<T>(on: boolean, fn: () => T): T {
  const previous = process.env[FLAG];
  if (on) process.env[FLAG] = "1";
  else delete process.env[FLAG];
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  }
}

interface CandSpec {
  provider?: string;
  model: string;
  id?: string;
  /** Measured successful p95 (ms) with `n` successful samples; omit for unmeasured. */
  p95?: number;
  n?: number;
  /** Total historical samples (reliability evidence); defaults to n. */
  total?: number;
  err?: number;
  quota?: number;
  circuit?: "CLOSED" | "HALF_OPEN" | "OPEN";
  rawP95?: number;
}

function cand(spec: CandSpec): FitFirstCandidate {
  const provider = spec.provider ?? "prov-a";
  const n = spec.n ?? 0;
  const total = Math.max(spec.total ?? n, n);
  const measured = spec.p95 !== undefined && n >= 3;
  return {
    provider,
    model: spec.model,
    modelStr: `${provider}/${spec.model}`,
    connectionId: spec.id ?? `conn-${spec.model}`,
    quotaRemaining: spec.quota ?? 100,
    quotaTotal: 100,
    circuitBreakerState: spec.circuit ?? "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: spec.rawP95 ?? spec.p95 ?? 1500,
    latencyStdDev: 10,
    errorRate: spec.err ?? 0.05,
    latencySampleSource: measured ? "successful_usage_24h" : "unqualified",
    successfulLatencySampleCount: n,
    provenance: candidateProvenance({
      provider,
      connectionId: spec.id ?? `conn-${spec.model}`,
      historical: total > 0,
      historicalSamples: total,
      runtimeSamples: 0,
      runtimeLatest: null,
      quota: null,
      now: NOW,
    }),
  };
}

function rank(
  rankFn: typeof rankFitFirstFreeCandidates,
  candidates: FitFirstCandidate[],
  level: Level = "light",
  taskType: "general" | "coding" = "general"
) {
  return rankFn({
    candidates,
    body,
    zeroAdditionalCostProviders: PROVIDERS,
    taskProfile: {
      source: "deterministic",
      fallbackReason: "not_configured",
      profile: { taskType, complexity: level, requiredCapabilities: [], confidence: 1 },
    },
    now: NOW,
  });
}

const keyOf = (c: { provider: string; model: string }) => `${c.provider}/${c.model}`;
const project = (decision: ReturnType<typeof rankFitFirstFreeCandidates>) =>
  JSON.stringify({
    level: decision.taskLevel,
    reasons: decision.taskReasons,
    excluded: decision.excluded.map((e) => `${e.provider}/${e.model}:${e.reason}`),
    ranked: decision.ranked.map((r) => ({
      key: keyOf(r.candidate),
      connection: r.candidate.connectionId,
      factors: r.factors,
      tieBreaker: r.tieBreaker,
    })),
  });

// Deterministic PRNG so the generated pools are reproducible.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generatePool(rand: () => number): FitFirstCandidate[] {
  const size = 1 + Math.floor(rand() * 8);
  const counts = [0, 1, 2, 3, 5, 40, 500];
  return Array.from({ length: size }, (_, i) => {
    const n = counts[Math.floor(rand() * counts.length)];
    const circuitRoll = rand();
    return cand({
      provider: PROVIDERS[Math.floor(rand() * 3)],
      model: `model-${i}`,
      p95: rand() < 0.8 ? 100 + Math.floor(rand() * 20000) : undefined,
      n,
      total: n + Math.floor(rand() * 50),
      err: rand() < 0.1 ? 1 : rand() * 0.6,
      quota: rand() < 0.1 ? 0 : 10 + Math.floor(rand() * 90),
      circuit: circuitRoll < 0.05 ? "OPEN" : circuitRoll < 0.15 ? "HALF_OPEN" : "CLOSED",
    });
  });
}

// ---------------------------------------------------------------------------------------
// 1. Flag off: byte-identical to the pre-change ranker for every level.
// ---------------------------------------------------------------------------------------
test("1. flag off: ranking output identical to the base build over 500 generated pools x 4 levels", () => {
  const rand = mulberry32(20261116);
  let compared = 0;
  for (let p = 0; p < 500; p++) {
    const pool = generatePool(rand);
    for (const level of LEVELS) {
      const [actual, expected] = withFlag(false, () => [
        rank(rankFitFirstFreeCandidates, pool, level),
        rank(baseline.rankFitFirstFreeCandidates, pool, level),
      ]);
      assert.equal(actual.taskLevel, level);
      assert.equal(project(actual), project(expected), `pool ${p} level ${level}`);
      for (const r of actual.ranked) {
        assert.equal("lightProfile" in r.factors, false, "flag off must add no new fields");
      }
      compared++;
    }
  }
  assert.equal(compared, 2000);
});

// ---------------------------------------------------------------------------------------
// 2. Flag on, non-light levels: identical to base.
// ---------------------------------------------------------------------------------------
test("2. flag on, standard/heavy/critical: identical to the base build", () => {
  const rand = mulberry32(7);
  for (let p = 0; p < 200; p++) {
    const pool = generatePool(rand);
    for (const level of ["standard", "heavy", "critical"] as Level[]) {
      const [actual, expected] = withFlag(true, () => [
        rank(rankFitFirstFreeCandidates, pool, level),
        rank(baseline.rankFitFirstFreeCandidates, pool, level),
      ]);
      assert.equal(actual.taskLevel, level);
      assert.equal(project(actual), project(expected), `pool ${p} level ${level}`);
    }
  }
});

// ---------------------------------------------------------------------------------------
// 3. Measured latency and reliability decide between otherwise equal candidates.
// ---------------------------------------------------------------------------------------
test("3. light: better measured latency and reliability wins and the decision records why", () => {
  for (const swap of [false, true]) {
    const good = cand({ model: "model-g1", p95: 800, n: 50, total: 200, err: 0.01 });
    const poor = cand({ model: "model-g2", p95: 9000, n: 50, total: 200, err: 0.2 });
    const pool = swap ? [poor, good] : [good, poor];
    const decision = withFlag(true, () => rank(rankFitFirstFreeCandidates, pool));
    assert.equal(decision.taskLevel, "light");
    assert.equal(decision.ranked.length, 2);
    const [winner, loser] = decision.ranked;
    assert.equal(keyOf(winner.candidate), "prov-a/model-g1");
    assert.equal(keyOf(loser.candidate), "prov-a/model-g2");
    const f = winner.factors;
    assert.equal(f.lightProfile, "evidence-weighted");
    assert.equal(f.latencyEvidence, "observed");
    assert.equal(f.latencySamples, 50);
    assert.equal(f.latencyP95Ms, 800);
    assert.equal(f.reliabilityMeasured, true);
    assert.ok(f.reliabilitySampleCount > 0);
    assert.ok(f.lightWeights.complexity < LEGACY_LIGHT.complexity);
    assert.ok(f.lightWeights.latency > LEGACY_LIGHT.latency);
    assert.ok(winner.factors.latencyFit > loser.factors.latencyFit);
    assert.ok(winner.factors.score > loser.factors.score);
  }
});

test("3b. light: speed earned by failing earns no speed credit", () => {
  const quickButFlaky = cand({ model: "model-h1", p95: 250, n: 60, total: 200, err: 0.45 });
  const steady = cand({ model: "model-h2", p95: 3000, n: 60, total: 200, err: 0.01 });
  const decision = withFlag(true, () => rank(rankFitFirstFreeCandidates, [quickButFlaky, steady]));
  assert.equal(keyOf(decision.ranked[0].candidate), "prov-a/model-h2");
  assert.equal(decision.ranked.length, 2);
  // Expected time to a successful answer, not raw latency, drives the speed term.
  assert.ok(latencyEvidenceFit(250, 60, 0.55).fit < latencyEvidenceFit(250, 60).fit);
  assert.equal(latencyEvidenceFit(250, 60, 0).fit, latencyEvidenceFit(250, 60).fit);
  assert.equal(latencyEvidenceFit(250, 60, NaN).fit, latencyEvidenceFit(250, 60).fit);
  assert.equal(latencyEvidenceFit(250, 60, 7).fit, latencyEvidenceFit(250, 60).fit);
});

// ---------------------------------------------------------------------------------------
// 4. Missing evidence is neutral: not zero, not favoured.
// ---------------------------------------------------------------------------------------
test("4. light: a candidate with no evidence is neutral, neither zeroed nor favoured", () => {
  const measuredAverage = cand({ model: "model-m0", p95: 1000, n: 100, total: 100, err: 0.5 });
  const unknownA = cand({ model: "model-unk-a" });
  const unknownB = cand({ model: "model-unk-b" });
  const decision = withFlag(true, () =>
    rank(rankFitFirstFreeCandidates, [measuredAverage, unknownA, unknownB])
  );
  const byKey = new Map(decision.ranked.map((r) => [keyOf(r.candidate), r]));
  for (const name of ["prov-a/model-unk-a", "prov-a/model-unk-b"]) {
    const f = byKey.get(name)!.factors;
    assert.equal(f.latencyEvidence, "neutral_prior");
    assert.equal(f.latencyFit, 0.5);
    assert.equal(f.latencySamples, 0);
    assert.equal(f.latencyP95Ms, null);
    assert.equal(f.reliability, 0.5);
    assert.equal(f.reliabilityMeasured, false);
    assert.ok(Number.isFinite(f.score) && f.score > 0);
  }
  // Two unknowns are exactly tied: unknown evidence does not separate them.
  assert.equal(
    byKey.get("prov-a/model-unk-a")!.factors.score,
    byKey.get("prov-a/model-unk-b")!.factors.score
  );
  // A measured candidate that is merely average (time to a successful answer equals the
  // neutral latency) scores the same latency and reliability as an unknown one.
  const avg = byKey.get("prov-a/model-m0")!.factors;
  assert.ok(Math.abs(avg.latencyFit - 0.5) < 1e-12);
  assert.ok(Math.abs(avg.reliability - 0.5) < 1e-12);
});

// ---------------------------------------------------------------------------------------
// 5. Quality evidence: higher measured quality wins at equal speed.
// ---------------------------------------------------------------------------------------
test("5. light: strictly higher measured quality evidence wins at equal speed", () => {
  setUserFitnessOverride("prov-q/model-hi", "general", 0.9);
  setUserFitnessOverride("prov-q/model-lo", "general", 0.3);
  try {
    for (const order of [0, 1]) {
      const hi = cand({ provider: "prov-q", model: "model-hi", p95: 1000, n: 30, total: 100 });
      const lo = cand({ provider: "prov-q", model: "model-lo", p95: 1000, n: 30, total: 100 });
      const unknown = cand({
        provider: "prov-q",
        model: "model-none",
        p95: 1000,
        n: 30,
        total: 100,
      });
      const decision = withFlag(true, () =>
        rank(rankFitFirstFreeCandidates, order ? [lo, unknown, hi] : [hi, unknown, lo])
      );
      const keys = decision.ranked.map((r) => keyOf(r.candidate));
      assert.equal(keys[0], "prov-q/model-hi");
      assert.equal(keys.at(-1), "prov-q/model-lo");
      const f = decision.ranked[0].factors;
      assert.equal(f.taskFitnessSource, "user_override");
      assert.equal(f.qualityEvidence, "measured");
      const none = decision.ranked.find((r) => r.candidate.model === "model-none")!.factors;
      assert.notEqual(none.qualityEvidence, "measured");
    }
  } finally {
    clearUserFitnessOverride("prov-q/model-hi", "general");
    clearUserFitnessOverride("prov-q/model-lo", "general");
  }
});

// ---------------------------------------------------------------------------------------
// 6. Demote, never remove.
// ---------------------------------------------------------------------------------------
test("6. light: a slow-on-evidence candidate is demoted to the tail and wins when alone", () => {
  const fast = cand({ model: "model-q1", p95: 600, n: 60, total: 200, err: 0.02 });
  const slow = cand({ model: "model-q2", p95: 20000, n: 60, total: 200, err: 0.02 });
  const both = withFlag(true, () => rank(rankFitFirstFreeCandidates, [slow, fast]));
  assert.deepEqual(
    both.ranked.map((r) => keyOf(r.candidate)),
    ["prov-a/model-q1", "prov-a/model-q2"]
  );
  assert.equal(both.excluded.length, 0);
  const alone = withFlag(true, () => rank(rankFitFirstFreeCandidates, [slow]));
  assert.equal(alone.ranked.length, 1);
  assert.equal(keyOf(alone.ranked[0].candidate), "prov-a/model-q2");
  assert.ok(Number.isFinite(alone.ranked[0].factors.score));
});

// ---------------------------------------------------------------------------------------
// 7. Fail-open: no measured evidence anywhere reproduces today's ranking.
// ---------------------------------------------------------------------------------------
test("7. light: empty or all-neutral evidence reproduces the base ranking exactly", () => {
  const rand = mulberry32(99);
  for (let p = 0; p < 200; p++) {
    const size = 1 + Math.floor(rand() * 6);
    const pool = Array.from({ length: size }, (_, i) =>
      cand({ provider: PROVIDERS[Math.floor(rand() * 3)], model: `model-${i}`, quota: 20 + i })
    );
    const [actual, expected] = withFlag(true, () => [
      rank(rankFitFirstFreeCandidates, pool),
      rank(baseline.rankFitFirstFreeCandidates, pool),
    ]);
    // Changed 2026-11-20: tieBreaker values are no longer compared with the base build, because
    // the tie-break seed is now conversation-stable (it was a hash of the latest ask). The
    // quotas differ per candidate, so the order and scores still have to match exactly.
    assert.deepEqual(
      actual.ranked.map((r) => [keyOf(r.candidate), r.factors.score]),
      expected.ranked.map((r) => [keyOf(r.candidate), r.factors.score]),
      `pool ${p}`
    );
    for (const r of actual.ranked) {
      assert.deepEqual(r.factors.lightWeights, LEGACY_LIGHT);
    }
  }
  const empty = withFlag(true, () => rank(rankFitFirstFreeCandidates, []));
  assert.equal(empty.ranked.length, 0);
});

// ---------------------------------------------------------------------------------------
// 8. Name agnosticism (favouritism guard).
// ---------------------------------------------------------------------------------------
test("8a. ranking depends on signals, not on ids: swapping names swaps nothing", () => {
  const rand = mulberry32(424242);
  const nameSets = [
    ["model-alpha", "model-beta", "model-gamma"],
    ["zz-9", "aa-1", "mm-5"],
    ["x1", "y2", "z3"],
  ];
  const signals = [
    { p95: 700, n: 40, total: 120, err: 0.02 },
    { p95: 6500, n: 40, total: 120, err: 0.1 },
    {},
  ] as Partial<CandSpec>[];
  for (let round = 0; round < 30; round++) {
    const names = nameSets[Math.floor(rand() * nameSets.length)];
    const order = [0, 1, 2].sort(() => rand() - 0.5);
    const scoreBySignal = (assignment: number[]) => {
      const pool = signals.map((s, i) => cand({ ...s, model: names[assignment[i]] }));
      const decision = withFlag(true, () => rank(rankFitFirstFreeCandidates, pool));
      return signals.map((_, i) => {
        const model = names[assignment[i]];
        return decision.ranked.find((r) => r.candidate.model === model)!.factors.score;
      });
    };
    assert.deepEqual(scoreBySignal([0, 1, 2]), scoreBySignal(order), `round ${round}`);
  }
});

test("8b. the new code contains no model, family or provider names", () => {
  const banned =
    /\b(haiku|opus|sonnet|flash|mini|nano|nemotron|claude|nvidia|gpt|gemini|llama|mistral|qwen|deepseek|grok|kimi|glm|codex|anthropic|openai|github)\b/i;
  const moduleSource = fs.readFileSync(path.join(AUTO_DIR, "lightEvidenceProfile.ts"), "utf8");
  assert.equal(banned.exec(moduleSource), null, "lightEvidenceProfile.ts names a model");
  const policySource = fs.readFileSync(path.join(AUTO_DIR, "fitFirstPolicy.ts"), "utf8");
  // Glue code is delimited by the light-profile helpers it calls; scan every line that
  // touches them, plus the added lines of the diff against the installed build.
  const glue = policySource
    .split("\n")
    .filter((line) => /light|Light|qualityEvidence|latencyEvidenceFit/.test(line));
  assert.ok(glue.length > 0, "expected glue lines in fitFirstPolicy.ts");
  for (const line of glue) assert.equal(banned.exec(line), null, `names a model: ${line}`);
  const diff = execFileSync(
    "git",
    ["diff", "-U0", BASE_REF, "--", "open-sse/services/autoCombo/fitFirstPolicy.ts"],
    { cwd: REPO, encoding: "utf8" }
  );
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  assert.ok(added.length > 0, "expected an added-lines diff against the installed build");
  for (const line of added) assert.equal(banned.exec(line), null, `names a model: ${line}`);
});

// ---------------------------------------------------------------------------------------
// 9. Latency interpolation edge cases.
// ---------------------------------------------------------------------------------------
test("9. latency interpolation: sample counts 0,1,2,3,100 and hostile inputs", () => {
  for (const n of [0, 1, 2]) {
    assert.deepEqual(latencyEvidenceFit(500, n), { fit: 0.5, shrink: 0, measured: false });
  }
  const three = latencyEvidenceFit(500, 3);
  const hundred = latencyEvidenceFit(500, 100);
  assert.equal(three.measured, true);
  assert.equal(three.shrink, 0.5);
  assert.ok(hundred.shrink > 0.96 && hundred.shrink < 1);
  const raw = 1 / (1 + 500 / LIGHT_LATENCY_NEUTRAL_MS);
  // More samples move the fit from neutral toward the raw value, monotonically.
  assert.ok(three.fit > 0.5 && three.fit < hundred.fit && hundred.fit < raw);
  // Faster is better, slower is worse, and the neutral latency scores exactly neutral.
  assert.ok(latencyEvidenceFit(300, 50).fit > latencyEvidenceFit(3000, 50).fit);
  assert.equal(latencyEvidenceFit(LIGHT_LATENCY_NEUTRAL_MS, 50).fit, 0.5);
  assert.ok(latencyEvidenceFit(60000, 50).fit < 0.5);
  const hostile: unknown[] = [
    0,
    -1,
    -0,
    NaN,
    Infinity,
    -Infinity,
    "100",
    null,
    undefined,
    {},
    Number.MAX_VALUE,
    Number.MIN_VALUE,
  ];
  for (const bad of hostile) {
    for (const n of [...hostile, 0, 3, 100, 1e12]) {
      const result = latencyEvidenceFit(bad, n);
      assert.ok(Number.isFinite(result.fit) && result.fit >= 0 && result.fit <= 1);
      assert.ok(Number.isFinite(result.shrink));
    }
  }
  assert.equal(latencyEvidenceFit(500, 1e12).measured, true);
  assert.ok(latencyEvidenceFit(500, 1e12).shrink < 1);
});

test("9b. hostile candidate values never produce NaN scores or throw", () => {
  const pool = [
    cand({ model: "model-a", p95: 500, n: 20, total: 20, rawP95: NaN }),
    cand({ model: "model-b", p95: 500, n: 20, total: 20, rawP95: -5 }),
    cand({ model: "model-c", p95: 500, n: 20, total: 20, rawP95: 0 }),
    cand({ model: "model-d", p95: 500, n: 20, total: 20, rawP95: Infinity }),
    cand({ model: "model-e", p95: 500, n: Number.NaN, total: 20 }),
    cand({ model: "model-f" }),
  ];
  const decision = withFlag(true, () => rank(rankFitFirstFreeCandidates, pool));
  assert.equal(decision.ranked.length, 6);
  for (const r of decision.ranked) {
    assert.ok(Number.isFinite(r.factors.score), keyOf(r.candidate));
    assert.ok(Number.isFinite(r.factors.latencyFit));
  }
});

test("9c. weights: budget preserved, never negative, identity without evidence", () => {
  const sum = (w: typeof LEGACY_LIGHT) => Object.values(w).reduce((a, b) => a + b, 0);
  const none = lightEvidenceWeights(LEGACY_LIGHT, {
    latencyMeasured: 0,
    reliabilityMeasured: 0,
    total: 5,
  });
  assert.deepEqual(none, LEGACY_LIGHT);
  for (const [latencyMeasured, reliabilityMeasured] of [
    [1, 0],
    [0, 1],
    [3, 3],
  ]) {
    const w = lightEvidenceWeights(LEGACY_LIGHT, {
      latencyMeasured,
      reliabilityMeasured,
      total: 5,
    });
    assert.ok(Math.abs(sum(w) - sum(LEGACY_LIGHT)) < 1e-12);
    for (const value of Object.values(w)) assert.ok(value >= 0);
    assert.equal(w.task, LEGACY_LIGHT.task);
    assert.equal(w.health, LEGACY_LIGHT.health);
    assert.equal(w.quota, LEGACY_LIGHT.quota);
  }
  const both = lightEvidenceWeights(LEGACY_LIGHT, {
    latencyMeasured: 1,
    reliabilityMeasured: 1,
    total: 1,
  });
  assert.ok(
    Math.abs(
      both.complexity -
        (LEGACY_LIGHT.complexity - LIGHT_SHIFT_TO_LATENCY - LIGHT_SHIFT_TO_RELIABILITY)
    ) < 1e-12
  );
  // A size term too small to supply the shift is never driven negative.
  const tiny = lightEvidenceWeights(
    { ...LEGACY_LIGHT, complexity: 0.05 },
    { latencyMeasured: 1, reliabilityMeasured: 1, total: 1 }
  );
  assert.ok(tiny.complexity >= 0);
  assert.ok(Math.abs(sum(tiny) - sum({ ...LEGACY_LIGHT, complexity: 0.05 })) < 1e-12);
});

// ---------------------------------------------------------------------------------------
// 10. Determinism and tie-break unchanged.
// ---------------------------------------------------------------------------------------
test("10. determinism: repeated runs agree and ties resolve by the unchanged tie-breaker", () => {
  const pool = [
    cand({ model: "model-a", p95: 900, n: 30, total: 90 }),
    cand({ model: "model-b", p95: 900, n: 30, total: 90 }),
    cand({ model: "model-c", p95: 900, n: 30, total: 90 }),
    cand({ model: "model-d" }),
  ];
  const runs = Array.from({ length: 5 }, () =>
    withFlag(true, () => rank(rankFitFirstFreeCandidates, [...pool].reverse()))
  );
  for (const run of runs) assert.equal(project(run), project(runs[0]));
  const tied = runs[0].ranked.filter((r) => r.candidate.model !== "model-d");
  assert.ok(tied.every((r) => r.factors.score === tied[0].factors.score));
  const tieOrder = tied.map((r) => r.tieBreaker);
  assert.deepEqual(
    tieOrder,
    [...tieOrder].sort((a, b) => a.localeCompare(b))
  );
  // Changed 2026-11-20: the tie-breaker values used to be asserted equal to the base build's.
  // The seed is now conversation-stable (explicit session id, else system prompt plus the first
  // user message), so the values differ by design; the order-follows-tieBreaker check above and
  // the conversation-stability tests in neutral-scoring-round2-20261120.test.ts replace it.
});

// ---------------------------------------------------------------------------------------
// Demonstration: a pool resembling the measured case (slow, decent success vs fast, little
// evidence). Capabilities are injected through the synced-capability table, so the
// size-closeness term differs between the two without relying on any identifier.
// ---------------------------------------------------------------------------------------
test("demo: measured-slow model versus fast model, with thin and with adequate evidence", () => {
  const entry = (limit_context: number | null, limit_output: number | null) => ({
    tool_call: true,
    reasoning: false,
    attachment: false,
    structured_output: null,
    temperature: null,
    modalities_input: null,
    modalities_output: null,
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context,
    limit_input: null,
    limit_output,
    interleaved_field: null,
  });
  // x: small declared window/output (sits near the light size target); y: large ones.
  saveModelsDevCapabilities({
    "prov-a": { "model-x": entry(32000, 8192) },
    "prov-b": { "model-y": entry(1000000, 128000) },
  });
  const slow = cand({
    provider: "prov-a",
    model: "model-x",
    p95: 9200,
    n: 40,
    total: 120,
    err: 0.08,
  });
  const row = (d: ReturnType<typeof rankFitFirstFreeCandidates>) =>
    d.ranked.map((r) => ({
      id: keyOf(r.candidate),
      score: Number(r.factors.score.toFixed(4)),
      complexityFit: Number(r.factors.complexityFit.toFixed(4)),
      latencyFit: Number(r.factors.latencyFit.toFixed(4)),
      reliability: Number(r.factors.reliability.toFixed(4)),
    }));
  const scenarios: Array<[string, FitFirstCandidate]> = [
    [
      "thin evidence (n=2)",
      cand({ provider: "prov-b", model: "model-y", p95: 900, n: 2, total: 2, err: 0 }),
    ],
    [
      "adequate (n=30)",
      cand({ provider: "prov-b", model: "model-y", p95: 900, n: 30, total: 90, err: 0.03 }),
    ],
  ];
  const winners: Record<string, [string, string]> = {};
  for (const [label, fast] of scenarios) {
    const before = withFlag(false, () => rank(rankFitFirstFreeCandidates, [slow, fast]));
    const after = withFlag(true, () => rank(rankFitFirstFreeCandidates, [slow, fast]));
    console.log("DEMO", label, "before", JSON.stringify(row(before)));
    console.log("DEMO", label, "after ", JSON.stringify(row(after)));
    assert.equal(after.ranked.length, 2);
    assert.equal(before.ranked.length, 2);
    winners[label] = [keyOf(before.ranked[0].candidate), keyOf(after.ranked[0].candidate)];
  }
  // Changed 2026-11-20: before this date the flag-off ranking preferred model-x purely because
  // its declared size sat nearer the light "target", and the flag was what let model-y overtake.
  // Fit is now sufficiency (a bigger verified model is never ranked below a smaller one), so the
  // verified-larger, measured-fast candidate leads with and without the flag.
  assert.deepEqual(winners["adequate (n=30)"], ["prov-b/model-y", "prov-b/model-y"]);
});
