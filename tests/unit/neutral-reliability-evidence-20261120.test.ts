import test from "node:test";
import assert from "node:assert/strict";

import { operationalReliability } from "../../open-sse/services/autoCombo/rankingEvidence.ts";
import { candidateProvenance } from "../../open-sse/services/autoCombo/candidateProvenance.ts";
import {
  rankFitFirstFreeCandidates,
  type FitFirstCandidate,
} from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { getConversationTieKey } from "../../open-sse/services/taskAwareRouting.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

// 2026-11-20: how OFTEN a model was used must not decide between models with the same
// observed success rate. Real operationalReliability, real rankFitFirstFreeCandidates, the
// real candidateProvenance builder and an isolated DB (tests/_setup/isolateDataDir.ts).
// No scorer is mocked. Every provider/model id below is synthetic: nothing here can be
// satisfied by a name-based rule.

test.after(() => resetDbInstance());

const NOW = Date.now();

function health(n: number, failures: number, now = NOW) {
  return {
    errorRate: n > 0 ? failures / n : 0,
    provenance: candidateProvenance({
      provider: "synprov",
      connectionId: "conn-1",
      historical: n > 0,
      historicalSamples: n,
      runtimeSamples: 0,
      runtimeLatest: null,
      quota: null,
      now,
    }),
  };
}

// ── 1. the reliability score itself ─────────────────────────────────────────

const SIZES = [1, 2, 3, 5, 10, 29, 100, 1000];

test("equal observed success rate scores equal at every sample size, including 100%", () => {
  for (const [label, rate] of [
    ["all success", 0],
    ["quarter failing", 0.25],
    ["half failing", 0.5],
    ["mostly failing", 0.75],
  ] as const) {
    // Only sizes where the rate is a whole number of failures.
    const sizes = SIZES.filter((n) => Number.isInteger(n * rate));
    const scores = sizes.map((n) => operationalReliability(health(n, n * rate), NOW).score);
    for (const s of scores) {
      assert.ok(
        Math.abs(s - scores[0]) < 1e-12,
        `${label}: score depends on sample count: n=${sizes.join(",")} -> ${scores.join(",")}`
      );
    }
  }
});

test("all-success scores are exactly the observed rate, not a volume-ramped prior", () => {
  for (const n of SIZES) {
    const r = operationalReliability(health(n, 0), NOW);
    assert.equal(r.score, 1, `n=${n} scored ${r.score}`);
    assert.equal(r.source, "usage_24h");
    assert.equal(r.reason, "observed");
    assert.equal(r.sampleCount, n);
  }
});

test("failures stay monotone: more failures never raise the score; a lower rate never outranks a higher one", () => {
  const cells: { n: number; f: number; rate: number; score: number }[] = [];
  for (let n = 1; n <= 60; n++) {
    for (let f = 0; f <= n; f++) {
      cells.push({ n, f, rate: 1 - f / n, score: operationalReliability(health(n, f), NOW).score });
    }
  }
  for (const a of cells) {
    for (const b of cells) {
      if (a.rate < b.rate - 1e-12) {
        assert.ok(
          a.score < b.score,
          `success ${a.f}/${a.n} (${a.rate}) scored ${a.score}, not below ${b.n - b.f}/${b.n} (${b.rate}) ${b.score}`
        );
      }
      if (a.n === b.n && a.f > b.f) assert.ok(a.score < b.score);
    }
  }
});

test("a single failure on a small sample is visible, and a failure streak ranks below a proven model", () => {
  const proven = operationalReliability(health(29, 0), NOW).score;
  const oneOfTwo = operationalReliability(health(2, 1), NOW).score;
  const streak = operationalReliability(health(3, 2), NOW).score;
  const oneOfOne = operationalReliability(health(1, 1), NOW).score;
  assert.ok(oneOfTwo < proven - 0.4, `1 failure in 2 hidden: ${oneOfTwo} vs ${proven}`);
  assert.ok(streak < proven - 0.5, `3-sample 2-failure streak not clearly below: ${streak}`);
  assert.ok(oneOfOne < streak);
});

test("a mostly failing small sample can never beat a healthy proven one", () => {
  const proven = operationalReliability(health(29, 1), NOW).score;
  for (let n = 1; n <= 12; n++) {
    for (let f = Math.ceil(n / 2); f <= n; f++) {
      const s = operationalReliability(health(n, f), NOW).score;
      assert.ok(s < proven, `${f}/${n} failing scored ${s}, not below proven 28/29 ${proven}`);
    }
  }
});

test("unobserved and stale evidence keep the neutral prior; a healthy observed RELIABILITY is above it", () => {
  const neutral = { score: 0.5, confidence: 0, sampleCount: 0, source: "neutral_prior" };
  const none = operationalReliability(health(0, 0), NOW);
  assert.deepEqual(
    {
      score: none.score,
      confidence: none.confidence,
      sampleCount: none.sampleCount,
      source: none.source,
    },
    neutral
  );
  const stale = operationalReliability(health(10, 0, NOW - 61_000), NOW);
  assert.equal(stale.source, "neutral_prior");
  assert.equal(stale.score, 0.5);
  for (const n of SIZES) {
    assert.ok(
      operationalReliability(health(n, 0), NOW).score > none.score,
      `n=${n} below unobserved`
    );
  }
});

test("the sample count stays visible as informational confidence and keeps its 1000 cap", () => {
  const r = operationalReliability(health(29, 0), NOW);
  assert.equal(r.confidence, 29 / 49);
  assert.equal(operationalReliability(health(5000, 0), NOW).sampleCount, 1000);
});

// ── 2. the ranker: replay of the live decision numbers ──────────────────────

const POOL = ["syna/zorbex-9", "synb/quillon-3", "sync/vandra-7", "synd/hexel-5", "syne/orvix-2"];
const SAMPLES: Record<string, number> = {
  "syna/zorbex-9": 29, // the proven, high-volume model
  "synb/quillon-3": 3,
  "sync/vandra-7": 1,
  "synd/hexel-5": 5,
  "syne/orvix-2": 0, // never observed
};

function cand(id: string, n: number, failures = 0): FitFirstCandidate {
  const i = id.indexOf("/");
  return {
    provider: id.slice(0, i),
    model: id.slice(i + 1),
    modelStr: id,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 0,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    ...health(n, failures),
  } as FitFirstCandidate;
}

const critical = {
  source: "interpreter" as const,
  fallbackReason: null,
  profile: {
    taskType: "general" as const,
    complexity: "critical" as const,
    requiredCapabilities: [],
    confidence: 1,
  },
};

function rank(candidates: FitFirstCandidate[], key: string, extra: Record<string, unknown> = {}) {
  const body = { messages: [{ role: "user", content: `ticket ${key}` }] };
  return rankFitFirstFreeCandidates({
    candidates,
    body,
    zeroAdditionalCostProviders: [...new Set(candidates.map((c) => c.provider))],
    conversationKey: getConversationTieKey(body, { sessionId: `session-${key}` }),
    taskProfile: critical,
    now: NOW,
    ...extra,
  });
}

const id = (d: { ranked: { candidate: FitFirstCandidate }[] }, i = 0) =>
  `${d.ranked[i].candidate.provider}/${d.ranked[i].candidate.model}`;

test("replay: n=29,5,3,1 all successful tie on every evidence factor; only the unobserved one differs", () => {
  const d = rank(
    POOL.map((p) => cand(p, SAMPLES[p])),
    "replay"
  );
  const by = Object.fromEntries(d.ranked.map((r) => [id({ ranked: [r] }), r.factors]));
  for (const p of POOL.slice(0, 4)) {
    assert.equal(by[p].reliability, 1, `${p} reliability`);
    assert.equal(by[p].health, 1, `${p} health`);
    assert.equal(by[p].score, by[POOL[0]].score, `${p} total score differs from the n=29 model`);
  }
  assert.equal(by[POOL[4]].reliability, 0.5);
  assert.equal(by[POOL[4]].reliabilitySource, "neutral_prior");
  assert.ok(
    by[POOL[4]].score < by[POOL[0]].score,
    "unobserved must not be promoted above observed healthy"
  );
  // factors_json fields keep their names and meaning
  assert.equal(by[POOL[1]].reliabilitySampleCount, 3);
  assert.equal(by[POOL[1]].reliabilitySource, "usage_24h");
  assert.equal(by[POOL[1]].reliabilityConfidence, 3 / 23);
  assert.equal(d.ranked[4].candidate.model, "orvix-2");
});

test("replay: the pick among the observed ties is the conversation-stable tie-break, not the sample count", () => {
  const observed = POOL.slice(0, 4);
  const wins = new Map(observed.map((p) => [p, 0]));
  const N = 200;
  for (let k = 0; k < N; k++) {
    const d = rank(
      POOL.map((p) => cand(p, SAMPLES[p])),
      String(k)
    );
    const w = id(d);
    assert.ok(observed.includes(w), `unobserved model won conversation ${k}`);
    wins.set(w, (wins.get(w) ?? 0) + 1);
    // deterministic: the same conversation always picks the same model
    assert.equal(
      id(
        rank(
          POOL.map((p) => cand(p, SAMPLES[p])),
          String(k)
        )
      ),
      w
    );
  }
  for (const [p, c] of wins) {
    assert.ok(c > N * 0.13 && c < N * 0.4, `${p} won ${c}/${N}: ${[...wins].join(" ")}`);
  }
  assert.ok(wins.get("syna/zorbex-9")! < N * 0.4, "the n=29 model must not dominate");
});

test("replay: shuffling which model has which volume does not change who wins a conversation", () => {
  // Volume is assigned to different ids; the winner follows the tie-break identity, not n.
  const ids = POOL.slice(0, 4);
  const winnersByVolume: string[] = [];
  const volumes = [29, 5, 3, 1];
  for (let rot = 0; rot < 4; rot++) {
    const cands = ids.map((p, i) => cand(p, volumes[(i + rot) % 4]));
    winnersByVolume.push(id(rank(cands, "stable-conv")));
  }
  assert.equal(new Set(winnersByVolume).size, 1, `winner moved with volume: ${winnersByVolume}`);
});

test("a failing small sample ranks below a proven healthy model and below an unobserved one", () => {
  for (const [n, f] of [
    [3, 2],
    [3, 3],
    [1, 1],
    [5, 3],
    [8, 5],
  ] as const) {
    const d = rank(
      [cand("syna/zorbex-9", 29), cand("synb/quillon-3", n, f), cand("syne/orvix-2", 0)],
      `fail-${n}-${f}`
    );
    assert.equal(id(d, 0), "syna/zorbex-9", `${f}/${n} failing beat the proven model`);
    assert.equal(id(d, 2), "synb/quillon-3", `${f}/${n} failing ranked above an unobserved model`);
  }
});

test("a single failure among small samples is still penalised against a clean small sample", () => {
  const d = rank([cand("syna/zorbex-9", 2, 1), cand("synb/quillon-3", 2, 0)], "one-failure");
  assert.equal(id(d, 0), "synb/quillon-3");
  assert.ok(d.ranked[0].factors.score > d.ranked[1].factors.score);
});

test("a mostly failing model gets less speed credit than a clean one at the same latency (light tier)", () => {
  const prev = process.env.ROUTING_LIGHT_BY_ASK;
  process.env.ROUTING_LIGHT_BY_ASK = "1";
  try {
    const mk = (idStr: string, failures: number) => {
      const c = cand(idStr, 20, failures) as FitFirstCandidate & Record<string, unknown>;
      c.latencySampleSource = "successful_usage_24h";
      c.successfulLatencySampleCount = 20 - failures;
      c.p95LatencyMs = 50;
      return c;
    };
    const d = rank([mk("syna/zorbex-9", 17), mk("synb/quillon-3", 0)], "light-latency", {
      taskProfile: {
        ...critical,
        profile: { ...critical.profile, complexity: "light" as const },
      },
    });
    assert.equal(d.taskLevel, "light");
    assert.equal(id(d, 0), "synb/quillon-3");
    const failing = d.ranked.find((r) => r.candidate.model === "zorbex-9")!.factors;
    const clean = d.ranked.find((r) => r.candidate.model === "quillon-3")!.factors;
    assert.equal(failing.latencyEvidence, "observed");
    assert.ok(
      clean.latencyFit > failing.latencyFit,
      `${clean.latencyFit} vs ${failing.latencyFit}`
    );
    assert.ok(failing.reliability < 0.2 && failing.health < 0.2);
  } finally {
    if (prev === undefined) delete process.env.ROUTING_LIGHT_BY_ASK;
    else process.env.ROUTING_LIGHT_BY_ASK = prev;
  }
});

test("hard-veto and exclusion semantics are unchanged by the scoring rule", () => {
  const vetoed = cand("synb/quillon-3", 29, 29);
  vetoed.provenance!.health.errorClass = "model_unavailable";
  const d = rank([cand("syna/zorbex-9", 29), vetoed], "veto");
  assert.deepEqual(
    d.excluded.map((e) => e.reason),
    ["observed_failure_rate"]
  );
  // Below the 10-sample provenance floor a 100% failure rate is ranked, not vetoed.
  const small = cand("synb/quillon-3", 3, 3);
  small.provenance!.health.errorClass = "model_unavailable";
  const d2 = rank([cand("syna/zorbex-9", 29), small], "veto-small");
  assert.equal(d2.excluded.length, 0);
  assert.equal(id(d2, 0), "syna/zorbex-9");
});

test("the scorer reads no identifier: renaming every candidate leaves the factor values unchanged", () => {
  const a = rank(
    POOL.map((p) => cand(p, SAMPLES[p])),
    "names"
  );
  const renamed = ["synv/aaaa-1", "synw/bbbb-2", "synx/cccc-3", "syny/dddd-4", "synz/eeee-5"];
  const b = rank(
    renamed.map((p, i) => cand(p, SAMPLES[POOL[i]])),
    "names"
  );
  const pick = (d: typeof a, i: number) => ({
    r: d.ranked.find((x) => x.factors.reliabilitySampleCount === SAMPLES[POOL[i]])!.factors,
  });
  for (let i = 0; i < 5; i++) {
    assert.equal(pick(a, i).r.reliability, pick(b, i).r.reliability);
    assert.equal(pick(a, i).r.health, pick(b, i).r.health);
    assert.equal(pick(a, i).r.score, pick(b, i).r.score);
  }
});

// ── 3. health factor: continuous in the observed rate, blind to volume ──────

const healthOf = (d: ReturnType<typeof rank>, id: string) =>
  d.ranked.find((r) => `${r.candidate.provider}/${r.candidate.model}` === id)!.factors.health;
const scoreOfId = (d: ReturnType<typeof rank>, id: string) =>
  d.ranked.find((r) => `${r.candidate.provider}/${r.candidate.model}` === id)!.factors.score;

test("health is the observed success rate: continuous, monotone, no cliff at 0.5", () => {
  let prev: { rate: number; health: number; score: number } | null = null;
  let worstStep = 0;
  for (const n of [10, 100]) {
    prev = null;
    for (let f = n; f >= 0; f--) {
      const d = rank([cand("syna/zorbex-9", n, f)], `h-${n}-${f}`);
      const h = healthOf(d, "syna/zorbex-9");
      const sc = scoreOfId(d, "syna/zorbex-9");
      const rate = 1 - f / n;
      assert.ok(Math.abs(h - rate) < 1e-12, `n=${n} failures=${f}: health ${h} != rate ${rate}`);
      if (prev) {
        assert.ok(h >= prev.health, "health dropped as success rose");
        assert.ok(sc >= prev.score - 1e-12, "score dropped as success rose");
        worstStep = Math.max(worstStep, (sc - prev.score) / (rate - prev.rate));
      }
      prev = { rate, health: h, score: sc };
    }
  }
  // At critical, reliability (0.05) and health (0.07) both follow the rate: a full-range swing is
  // 0.12, so one point of success rate moves a critical score by at most 0.0012.
  assert.ok(worstStep <= 0.12 + 1e-9, `score slope ${worstStep} per unit rate`);
});

test("49, 50 and 51 failures in 100 calls sit next to each other (no cliff at a coin flip)", () => {
  const at = (f: number) => {
    const d = rank([cand("syna/zorbex-9", 100, f), cand("synb/quillon-3", 0)], `coin-${f}`);
    return { s: scoreOfId(d, "syna/zorbex-9"), h: healthOf(d, "syna/zorbex-9") };
  };
  const [a, b, c] = [at(49), at(50), at(51)];
  assert.ok(a.s > b.s && b.s > c.s, "strictly monotone");
  assert.ok(a.s - b.s < 0.002 && b.s - c.s < 0.002, `steps ${a.s - b.s} ${b.s - c.s}`);
  assert.ok(
    Math.abs(a.h - 0.51) < 1e-12 && Math.abs(b.h - 0.5) < 1e-12 && Math.abs(c.h - 0.49) < 1e-12
  );
});

test("a coin-flip model scores exactly like an unobserved one; worse than a coin flip ranks below it", () => {
  for (const n of [4, 10, 40, 500]) {
    const d = rank([cand("syna/zorbex-9", n, n / 2), cand("synb/quillon-3", 0)], `flip-${n}`);
    assert.equal(scoreOfId(d, "syna/zorbex-9"), scoreOfId(d, "synb/quillon-3"), `n=${n}`);
  }
  const worse = rank([cand("syna/zorbex-9", 40, 21), cand("synb/quillon-3", 0)], "worse");
  assert.ok(scoreOfId(worse, "syna/zorbex-9") < scoreOfId(worse, "synb/quillon-3"));
  const better = rank([cand("syna/zorbex-9", 40, 19), cand("synb/quillon-3", 0)], "better");
  assert.ok(scoreOfId(better, "syna/zorbex-9") > scoreOfId(better, "synb/quillon-3"));
});

test("health, like reliability, ignores volume at equal observed rate and keeps the neutral prior", () => {
  for (const [rate, sizes] of [
    [1, [1, 3, 10, 29, 1000]],
    [0.8, [5, 10, 100, 1000]],
    [0.5, [2, 10, 100]],
  ] as const) {
    const hs = sizes.map((n) =>
      healthOf(rank([cand("syna/zorbex-9", n, n * (1 - rate))], "v"), "syna/zorbex-9")
    );
    for (const h of hs) assert.ok(Math.abs(h - rate) < 1e-12, `rate ${rate}: ${hs}`);
  }
  assert.equal(healthOf(rank([cand("syna/zorbex-9", 0)], "u"), "syna/zorbex-9"), 0.5);
  // an open breaker still reads neutral, as before
  const open = { ...cand("syna/zorbex-9", 20), circuitBreakerState: "HALF_OPEN" as const };
  assert.equal(healthOf(rank([open], "o"), "syna/zorbex-9"), 0.5);
});

test("an observed healthy model has health at or above an unobserved one at every sample size", () => {
  for (const n of [1, 3, 9, 10, 29, 1000]) {
    const d = rank([cand("syna/zorbex-9", n, 0), cand("synb/quillon-3", 0)], `hh-${n}`);
    assert.ok(healthOf(d, "syna/zorbex-9") > healthOf(d, "synb/quillon-3"), `n=${n}`);
  }
});

// ── 4. observation gate in production candidate assembly (combo.ts) ─────────

async function assembled(n: number, failures: number, tag: string) {
  const { saveRequestUsage } = await import("../../src/lib/usage/usageHistory.ts");
  const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
  const provider = "nvidia";
  const model = `gate-${tag}-${n}-${failures}`;
  for (let i = 0; i < n; i++) {
    const success = i >= failures;
    await saveRequestUsage({
      provider,
      model,
      success,
      latencyMs: success ? 400 : 1,
      timeToFirstTokenMs: 100,
      tokens: { input: 1, output: success ? 5 : 0 },
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  const [c] = await buildAutoCandidates(
    [
      {
        kind: "model",
        provider,
        modelStr: `${provider}/${model}`,
        stepId: model,
        executionKey: model,
        connectionId: null,
      },
    ] as never,
    "gate-fixture"
  );
  return c as unknown as FitFirstCandidate;
}

test("production assembly: from 3 usage samples the observed rate is ranking evidence; 1 and 2 stay neutral", async () => {
  for (const n of [1, 2]) {
    const c = await assembled(n, 0, "lo");
    assert.equal(operationalReliability(c, Date.now()).source, "neutral_prior", `n=${n}`);
  }
  for (const n of [3, 5, 9, 10, 29]) {
    const c = await assembled(n, 0, "ok");
    const r = operationalReliability(c, Date.now());
    assert.equal(r.source, "usage_24h", `n=${n}`);
    assert.equal(r.sampleCount, n);
    assert.equal(r.score, 1);
  }
});

test("production assembly: no cliff between 9 and 10 samples, healthy or failing", async () => {
  const d = (cands: FitFirstCandidate[]) =>
    rankFitFirstFreeCandidates({
      candidates: cands,
      body: { messages: [{ role: "user", content: "x" }] },
      zeroAdditionalCostProviders: ["nvidia"],
      conversationKey: "k",
      taskProfile: critical,
      now: Date.now(),
    });
  const factors = (r: ReturnType<typeof d>, model: string) =>
    r.ranked.find((x) => x.candidate.model === model)!.factors;
  const h9 = await assembled(9, 0, "h");
  const h10 = await assembled(10, 0, "h");
  const f = d([h9, h10]);
  assert.deepEqual(
    f.excluded.map((e) => e.reason),
    []
  );
  const a = factors(f, h9.model);
  const b = factors(f, h10.model);
  assert.equal(a.reliability, b.reliability);
  assert.equal(a.health, b.health);
  assert.equal(a.score, b.score, "one extra sample must not move a healthy model's score");
  // a failing model does not climb to neutral by losing a sample: 8 of 10 failing vs 7 of 9
  const x10 = await assembled(10, 8, "x");
  const x9 = await assembled(9, 7, "x");
  const g = d([x10, x9]);
  for (const c of [x10, x9]) assert.ok(factors(g, c.model).reliability < 0.5);
  assert.ok(factors(g, x9.model).score < 0.9 * factors(f, h9.model).score);
  assert.ok(Math.abs(factors(g, x9.model).score - factors(g, x10.model).score) < 0.01);
});

test("production assembly: latency gates and the hard-veto floor are untouched by the lower rate gate", async () => {
  const { healthEvidenceHasRecentSamples, healthEvidenceSupportsHardVeto } =
    await import("../../open-sse/services/autoCombo/candidateProvenance.ts");
  for (const n of [3, 5, 9]) {
    const c = await assembled(n, 0, "lat");
    assert.equal(healthEvidenceHasRecentSamples(c.provenance), false, `n=${n} veto floor`);
    assert.equal(healthEvidenceSupportsHardVeto(c.provenance), false);
    assert.equal(c.latencySampleSource, "unqualified", `n=${n}: latency still needs 10 samples`);
    assert.equal(c.successfulLatencySampleCount, 0);
    assert.equal(c.p95LatencyMs, 1500, "bootstrap p95 until 10 samples");
  }
  const c10 = await assembled(10, 0, "lat");
  assert.equal(healthEvidenceHasRecentSamples(c10.provenance), true);
  assert.equal(c10.latencySampleSource, "successful_usage_24h");
});
