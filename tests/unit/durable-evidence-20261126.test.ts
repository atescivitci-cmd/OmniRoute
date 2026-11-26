/**
 * ROUTING_DURABLE_EVIDENCE (2026-11-26): durable, class-family-gated ranking evidence.
 *
 * Live incident: a terminal combo request at 2026-11-26T03:01Z found no Claude row in the 24 h
 * window (its last tool session ended 24 h earlier), so every Claude model fell to the neutral
 * prior, while canary chat probes kept NVIDIA models "fresh" and they won heavy tool work.
 *
 * Rules under test (pure, provider-blind):
 *  - window 7 days, each row weighted 0.5 ** (ageHours / 24)
 *  - whether evidence exists is decided on RAW gated rows (an entry needs 3, a signal 10); the
 *    weights shape the success rate, and the effective count sum(w) is only the confidence
 *  - a request in family `tools` (t*) reads only t* rows; `chat` (c*) reads only c* rows
 *  - rows without a class count for either family; unclassified routing-canary rows are read as c0s
 *  - a classified row also needs a size bucket >= the request's
 *  - a success row just before a malformed failure of the same request is a phantom and dropped
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DURABLE_EVIDENCE_HALF_LIFE_HOURS,
  DURABLE_EVIDENCE_MIN_SAMPLES,
  DURABLE_EVIDENCE_WINDOW_HOURS,
  DURABLE_HEALTH_NEUTRAL_SCORE,
  DURABLE_MIN_CONFIDENCE_SAMPLES,
  aggregateDurableEvidence,
  decayWeight,
  durableHealth,
  durableReliability,
  requestClassFamily,
  type DurableEvidenceRow,
} from "../../open-sse/services/autoCombo/durableEvidence.ts";
import {
  FLAG_DURABLE_EVIDENCE,
  fairSelectionSettings,
} from "../../open-sse/services/autoCombo/fairSelectionSettings.ts";
import { USAGE_SOURCE_ROUTING_CANARY } from "../../src/shared/constants/usageSource.ts";

const NOW = Date.parse("2026-11-26T03:01:19.000Z");
const HOUR = 3_600_000;

function r(
  model: string,
  ageHours: number,
  o: {
    ok?: boolean;
    cls?: string | null;
    canary?: boolean;
    ms?: number;
    provider?: string;
    code?: string | null;
  } = {}
): DurableEvidenceRow {
  return {
    provider: o.provider ?? "p",
    model,
    success: o.ok !== false,
    latencyMs: o.ms ?? 1000,
    ttftMs: 100,
    tokensOutput: o.ok === false ? 0 : 50,
    errorCode: o.ok === false ? (o.code ?? "upstream_error") : null,
    source: o.canary ? USAGE_SOURCE_ROUTING_CANARY : null,
    requestClass: o.cls === undefined ? "t2s" : o.cls,
    timestamp: new Date(NOW - ageHours * HOUR).toISOString(),
  };
}
const many = (n: number, model: string, ageHours: number, o: Parameters<typeof r>[2] = {}) =>
  Array.from({ length: n }, () => r(model, ageHours, o));

function agg(rows: DurableEvidenceRow[], requestClass = "t2s", extra = {}) {
  return aggregateDurableEvidence(rows, { now: NOW, requestClass, ...extra });
}

test("constants: 7 day window, 24 h half-life, 3 effective samples", () => {
  assert.equal(DURABLE_EVIDENCE_WINDOW_HOURS, 168);
  assert.equal(DURABLE_EVIDENCE_HALF_LIFE_HOURS, 24);
  assert.equal(DURABLE_EVIDENCE_MIN_SAMPLES, 3);
});

test("decay: a fresh row weighs 1, one half-life 0.5, two 0.25; a future row is clamped to 1", () => {
  assert.equal(decayWeight(0), 1);
  assert.equal(decayWeight(24 * HOUR), 0.5);
  assert.equal(decayWeight(48 * HOUR), 0.25);
  assert.ok(Math.abs(decayWeight(12 * HOUR) - Math.SQRT1_2) < 1e-12);
  assert.equal(decayWeight(-5 * HOUR), 1);
  assert.equal(decayWeight(Number.NaN), 0);
});

test("family: t* is tools, c* is chat, anything else has no family", () => {
  assert.equal(requestClassFamily("t2s"), "tools");
  assert.equal(requestClassFamily("t0n"), "tools");
  assert.equal(requestClassFamily("c0s"), "chat");
  assert.equal(requestClassFamily("c2n"), "chat");
  for (const v of [null, undefined, "", "x0s", "t3s", "tools", 7]) {
    assert.equal(requestClassFamily(v), null, String(v));
  }
});

test("minSamples: one row never proves a model, however fresh", () => {
  const e = agg([r("one", 0)]);
  assert.equal(e.stats["p/one"], undefined);
});

test("minSamples: three fresh rows make an entry with three effective samples", () => {
  const e = agg(many(3, "three", 0));
  assert.equal(e.stats["p/three"].totalRequests, 3);
  assert.equal(e.stats["p/three"].successRate, 1);
  assert.equal(e.stats["p/three"].windowHours, 168);
});

test("raw counts decide existence: three old rows (30 h) are an entry of 3 with 1.26 effective", () => {
  const s = agg(many(3, "stale", 30)).stats["p/stale"];
  assert.equal(s.totalRequests, 3);
  assert.ok(Math.abs(s.effectiveSamples - 3 * 0.5 ** (30 / 24)) < 1e-6);
});

test("durability: 40 tool rows one day old stay proven (40 raw, 20 effective samples)", () => {
  const e = agg(many(40, "proven", 24));
  const s = e.stats["p/proven"];
  assert.equal(s.totalRequests, 40);
  assert.equal(s.successRate, 1);
  assert.equal(s.effectiveSamples, 20);
  assert.equal(s.rawSamples, 40);
});

test("window: a row older than 7 days is not read at all", () => {
  const e = agg([...many(5, "w", 1), ...many(50, "w", 169)]);
  assert.equal(e.stats["p/w"].rawSamples, 5);
  assert.equal(e.rowsExcluded.outsideWindow, 50);
});

test("recency: a fresh failure outweighs old successes in the weighted rate", () => {
  // 4 successes at 48 h weigh 1 in total, 1 failure and 2 successes now weigh 3
  const e = agg([...many(4, "rec", 48), r("rec", 0, { ok: false }), ...many(2, "rec", 0)]);
  const s = e.stats["p/rec"];
  // weights: 4 * 0.25 + 1 + 2 = 4; successes 1 + 2 = 3
  assert.equal(s.effectiveSamples, 4);
  assert.equal(s.successRate, 0.75);
});

test("family gating, tools request: only t* rows and unclassified real rows count", () => {
  const rows = [
    ...many(5, "g", 0, { cls: "t2s" }),
    ...many(7, "g", 0, { cls: "c0s" }), // other family
    ...many(11, "g", 0, { cls: "c0s", canary: true }), // canary chat probe
    ...many(13, "g", 0, { cls: null, canary: true }), // legacy canary row
    ...many(3, "g", 0, { cls: null }), // legacy real traffic
  ];
  const e = agg(rows, "t2s");
  assert.equal(e.family, "tools");
  assert.equal(e.stats["p/g"].rawSamples, 8);
  assert.equal(e.rowsExcluded.otherFamily, 31, "c0s rows, canary or not, and unclassified canary");
  assert.equal(e.rowsUsed, 8);
});

test("family gating, chat request: c* rows (canary probes included) and unclassified real rows", () => {
  const rows = [
    ...many(5, "g", 0, { cls: "t2s" }),
    ...many(7, "g", 0, { cls: "c0n" }),
    ...many(11, "g", 0, { cls: "c0s", canary: true }),
    ...many(13, "g", 0, { cls: null, canary: true }),
    ...many(3, "g", 0, { cls: null }),
  ];
  const e = agg(rows, "c0s");
  assert.equal(e.family, "chat");
  assert.equal(e.stats["p/g"].rawSamples, 34, "unclassified canary rows are read as c0s");
  assert.equal(e.rowsExcluded.otherFamily, 5);
});

test("canary-only model: chat probes never prove it for tool work", () => {
  const e = agg(many(60, "probed", 0, { cls: "c0s", canary: true }), "t2s");
  assert.equal(e.stats["p/probed"], undefined);
});

test("an unparseable class is treated as unclassified (a canary one as c0s)", () => {
  const e = agg(
    [...many(3, "u", 0, { cls: "zz" }), ...many(3, "u", 0, { cls: "zz", canary: true })],
    "t2s"
  );
  assert.equal(e.stats["p/u"].rawSamples, 3);
  assert.equal(e.rowsExcluded.otherFamily, 3);
});

test("client abandons are skipped only when asked", () => {
  const rows = [
    ...many(4, "ab", 0),
    r("ab", 0, { ok: false, code: "client_disconnected", ms: 2000 }),
  ];
  assert.equal(agg(rows).stats["p/ab"].rawSamples, 5);
  const e = agg(rows, "t2s", { excludeClientAbandons: true });
  assert.equal(e.stats["p/ab"].rawSamples, 4);
  assert.equal(e.rowsExcluded.clientAbandon, 1);
});

test("latency: successful rows only, weighted percentiles, sample count is effective", () => {
  const rows = [
    ...many(3, "lat", 0, { ms: 1000 }),
    ...many(3, "lat", 0, { ms: 9000, ok: false }),
    ...many(1, "lat", 0, { ms: 3000 }),
  ];
  const s = agg(rows).stats["p/lat"];
  assert.equal(s.latencySampleSource, "successful");
  assert.equal(s.successfulLatencySampleCount, 4);
  assert.equal(s.p50LatencyMs, 1000);
  assert.equal(s.p95LatencyMs, 3000);
  assert.equal(s.avgLatencyMs, 1500);
  assert.ok(s.successfulLatencySampleCount <= s.totalRequests);
});

test("latency: with too few successful samples the timing is labelled all_attempts", () => {
  const rows = [...many(5, "lat2", 0, { ok: false, ms: 4000 }), ...many(1, "lat2", 0, { ms: 900 })];
  const s = agg(rows).stats["p/lat2"];
  assert.equal(s.latencySampleSource, "all_attempts");
  assert.equal(s.successfulLatencySampleCount, 1);
});

test("provider-blind: the same rows under other names give the same numbers", () => {
  const make = (provider: string) =>
    [...many(9, "m", 10, { provider }), r("m", 2, { provider, ok: false })].map((x) => x);
  const a = agg(make("alpha")).stats["alpha/m"];
  const b = agg(make("beta")).stats["beta/m"];
  const strip = ({ provider: _p, key: _k, ...rest }: typeof a) => rest;
  assert.deepEqual(strip(a), strip(b));
});

test("flag: ROUTING_DURABLE_EVIDENCE defaults off and parses the usual spellings", () => {
  assert.equal(FLAG_DURABLE_EVIDENCE, "ROUTING_DURABLE_EVIDENCE");
  assert.equal(fairSelectionSettings({}).durableEvidence, false);
  assert.equal(fairSelectionSettings({ ROUTING_DURABLE_EVIDENCE: "0" }).durableEvidence, false);
  assert.equal(fairSelectionSettings({ ROUTING_DURABLE_EVIDENCE: "1" }).durableEvidence, true);
  assert.equal(fairSelectionSettings({ ROUTING_DURABLE_EVIDENCE: "on" }).durableEvidence, true);
});

// ── Size gating: evidence from larger or equal requests may prove smaller ones, never the reverse.

test("size, c2n request: c0s canary probes are excluded, c2n rows count, t2n rows are another family", () => {
  const rows = [
    ...many(20, "s", 0, { cls: "c0s", canary: true }),
    ...many(4, "s", 0, { cls: "c2n" }),
    ...many(3, "s", 0, { cls: "c2s" }), // stream flag does not matter
    ...many(5, "s", 0, { cls: "t2n" }),
    ...many(6, "s", 0, { cls: "c1n" }), // smaller bucket
  ];
  const e = agg(rows, "c2n");
  assert.equal(e.minSizeBucket, 2);
  assert.equal(e.stats["p/s"].rawSamples, 7);
  assert.equal(e.rowsExcluded.smallerSize, 26);
  assert.equal(e.rowsExcluded.otherFamily, 5);
});

test("size, c2n request: a model proven only by canary probes has no evidence at all", () => {
  const e = agg(many(60, "probe-only", 0, { cls: "c0s", canary: true }), "c2n");
  assert.equal(e.stats["p/probe-only"], undefined);
});

test("size, c0s request: c2n rows count (larger requests prove smaller ones)", () => {
  const e = agg(
    [...many(3, "big", 0, { cls: "c2n" }), ...many(2, "big", 0, { cls: "c0n" })],
    "c0s"
  );
  assert.equal(e.minSizeBucket, 0);
  assert.equal(e.stats["p/big"].rawSamples, 5);
  assert.equal(e.rowsExcluded.smallerSize, 0);
});

test("size, t1s request: t0s rows are excluded and t2s rows count", () => {
  const rows = [...many(8, "t", 0, { cls: "t0s" }), ...many(3, "t", 0, { cls: "t2s" })];
  const e = agg(rows, "t1s");
  assert.equal(e.stats["p/t"].rawSamples, 3);
  assert.equal(e.rowsExcluded.smallerSize, 8);
});

test("size: unclassified real rows count for any size; unclassified canary rows are c0s", () => {
  const rows = [
    ...many(3, "u2", 0, { cls: null }),
    ...many(9, "u2", 0, { cls: null, canary: true }),
  ];
  const e = agg(rows, "c2n");
  assert.equal(e.stats["p/u2"].rawSamples, 3);
  assert.equal(e.rowsExcluded.smallerSize, 9);
  // ...and for a c0s request they count, failures included, exactly like classified probes
  const c0 = agg(
    [
      ...many(8, "probe", 0, { cls: "c0s", canary: true }),
      ...many(4, "probe", 0, { cls: null, canary: true, ok: false, code: "probe_deadline" }),
    ],
    "c0s"
  ).stats["p/probe"];
  assert.equal(c0.rawSamples, 12);
  assert.ok(Math.abs(c0.successRate - 8 / 12) < 1e-9);
});

// ── Phantom success rows (rule E)

function at(model: string, iso: string, o: Parameters<typeof r>[2] & { ms?: number } = {}) {
  return { ...r(model, 0, o), timestamp: iso };
}

test("phantom: a success followed within 2 s by a malformed failure of the same model is dropped", () => {
  const rows = [
    at("ph", "2026-11-26T05:52:08.084Z", { cls: "c2n", ms: 82708 }),
    at("ph", "2026-11-26T05:52:08.117Z", {
      cls: "c2n",
      ok: false,
      code: "malformed_translated_response",
      ms: 82741,
    }),
    at("ph", "2026-11-26T05:52:23.311Z", { cls: "c2n", ms: 20888 }), // real success, kept
    at("ph", "2026-11-26T05:52:54.255Z", { cls: "c2n", ms: 44018 }), // real success, kept
  ];
  const e = agg(rows, "c2n");
  assert.equal(e.rowsExcluded.phantomSuccess, 1);
  assert.equal(e.stats["p/ph"].rawSamples, 3);
  assert.equal(e.stats["p/ph"].successfulRequests, 2);
});

test("phantom: each failure cancels one success; other models, other codes, far gaps are kept", () => {
  const fail = (model: string, iso: string, code = "malformed_translated_response") =>
    at(model, iso, { cls: "c2n", ok: false, code, ms: 1000 });
  const rows = [
    at("a", "2026-11-26T06:00:00.000Z", { cls: "c2n" }),
    at("a", "2026-11-26T06:00:00.500Z", { cls: "c2n" }),
    fail("a", "2026-11-26T06:00:01.000Z"), // cancels exactly one of the two
    at("b", "2026-11-26T06:00:00.000Z", { cls: "c2n" }),
    fail("c", "2026-11-26T06:00:00.100Z"), // other model: b's success stays
    at("d", "2026-11-26T06:00:00.000Z", { cls: "c2n" }),
    fail("d", "2026-11-26T06:00:00.100Z", "upstream_502"), // other code: stays
    at("e", "2026-11-26T06:00:00.000Z", { cls: "c2n" }),
    fail("e", "2026-11-26T06:00:03.000Z"), // 3 s later: stays
    at("f", "2026-11-26T06:00:00.000Z", { cls: "c2n", ms: 90_000 }),
    fail("f", "2026-11-26T06:00:00.100Z"), // latency 1 s vs 90 s: a different request
  ];
  const e = aggregateDurableEvidence(rows, {
    now: Date.parse("2026-11-26T06:01:00Z"),
    requestClass: "c2n",
    minSamples: 1,
  });
  assert.equal(e.rowsExcluded.phantomSuccess, 1);
  assert.equal(e.stats["p/a"].successfulRequests, 1);
  for (const m of ["b", "d", "e", "f"]) assert.equal(e.stats[`p/${m}`].successfulRequests, 1, m);
});

// ── Reliability and health of the durable source (rules B, defect 4)

test("durableReliability: idle time never drops a proven record below the confidence floor", () => {
  const fresh = durableReliability({ successRate: 1, effectiveSamples: 40 });
  const idle = durableReliability({ successRate: 1, effectiveSamples: 3.5 });
  assert.equal(idle.samples, DURABLE_MIN_CONFIDENCE_SAMPLES);
  assert.equal(idle.score, 12 / 14);
  assert.equal(idle.healthWeight, 1);
  // below 3 effective samples the floor and the health effect ramp down (thin evidence)
  const thin = durableReliability({ successRate: 1, effectiveSamples: 0.6 });
  assert.ok(Math.abs(thin.samples - 2) < 1e-9);
  assert.ok(Math.abs(thin.healthWeight - 0.2) < 1e-9);
  assert.ok(fresh.score > idle.score && idle.score > 0.8);
  assert.equal(durableReliability({ successRate: 1, effectiveSamples: 5000 }).samples, 1000);
});

test("durableHealth: neutral at 0.7, monotone, a 57% record is below an untried model", () => {
  assert.equal(DURABLE_HEALTH_NEUTRAL_SCORE, 0.7);
  assert.equal(durableHealth(0.7), 0.5);
  assert.equal(durableHealth(1), 1);
  assert.equal(durableHealth(0), 0);
  const poor = durableReliability({ successRate: 0.57, effectiveSamples: 14 }).score;
  assert.ok(durableHealth(poor) < 0.5);
  let last = -1;
  for (let x = 0; x <= 1.0001; x += 0.01) {
    const h = durableHealth(x);
    assert.ok(h >= last - 1e-12);
    last = h;
  }
});

test("no flooring: counts are raw integers and effectiveSamples is the unfloored weight sum", () => {
  // 10 rows at 30 h: sum(w) = 4.2045; a floor or ceil anywhere would show here
  const s = agg(many(10, "nf", 30)).stats["p/nf"];
  assert.equal(s.totalRequests, 10);
  assert.ok(Math.abs(s.effectiveSamples - 10 * 0.5 ** (30 / 24)) < 1e-6);
  assert.equal(s.latencySampleCount, 10);
  assert.equal(s.successfulLatencySampleCount, 10);
});

// Routing note: since the owner's light-tier decision, c0* requests rank on the 24 h path, the
// same count the canary uses, so the two agree by construction. This pins the aggregator for the
// case where light classes ever take the durable path.
test("canary consistency: 10 probe rows in 24 h (the canary's 'proven') are a signal for c0 classes", async () => {
  const { candidateProvenance, healthEvidenceHasRecentSamples } =
    await import("../../open-sse/services/autoCombo/candidateProvenance.ts");
  const { operationalReliability } =
    await import("../../open-sse/services/autoCombo/rankingEvidence.ts");
  // The canary stops at 10 rows of ANY class in 24 h; its own rows are c0s probes.
  const rows = Array.from({ length: 10 }, (_, i) =>
    r("probed", 2 * i + 1, { cls: "c0s", canary: true })
  );
  for (const cls of ["c0s", "c0n"]) {
    const s = agg(rows, cls).stats["p/probed"];
    assert.equal(s.totalRequests, 10, cls);
    const provenance = candidateProvenance({
      provider: "p",
      historical: s.totalRequests >= 10,
      historicalSamples: s.totalRequests,
      runtimeSamples: 0,
      runtimeLatest: null,
      quota: null,
      historicalSource: "usage_durable",
      historicalWindowHours: 168,
      historicalEffectiveSamples: s.effectiveSamples,
    });
    assert.equal(healthEvidenceHasRecentSamples(provenance), true, cls);
    const rel = operationalReliability({ provenance, errorRate: 1 - s.successRate });
    assert.equal(rel.source, "usage_durable");
    assert.equal(rel.reason, "observed");
  }
  // ...and, by design, they prove nothing for a larger or tool request
  assert.equal(agg(rows, "c1n").stats["p/probed"], undefined);
  assert.equal(agg(rows, "t0s").stats["p/probed"], undefined);
});

// ── Recent-window override (item A) and thin evidence (item B)

/** Health and reliability as the ranker derives them from a durable entry. */
async function ranked(e: ReturnType<typeof agg>, key: string) {
  const { candidateProvenance } =
    await import("../../open-sse/services/autoCombo/candidateProvenance.ts");
  const { operationalReliability } =
    await import("../../open-sse/services/autoCombo/rankingEvidence.ts");
  const s = e.stats[key];
  const provenance = candidateProvenance({
    provider: "p",
    historical: s.totalRequests >= 10,
    historicalSamples: s.totalRequests,
    runtimeSamples: 0,
    runtimeLatest: null,
    quota: null,
    historicalSource: "usage_durable",
    historicalWindowHours: 168,
    historicalEffectiveSamples: s.effectiveSamples,
  });
  const rel = operationalReliability({ provenance, errorRate: 1 - s.successRate });
  const health = durableHealth(rel.score, rel.healthWeight);
  // the heavy/critical weights of the ranker: health 0.07, reliability 0.05; untried = 0.5 / 0.5
  return { rel: rel.score, health, edge: 0.07 * (health - 0.5) + 0.05 * (rel.score - 0.5) };
}

test("recent override: 400 day-old successes + 10 fresh failures rank below an untried model", async () => {
  const rows = [
    ...many(400, "strong", 24),
    ...Array.from({ length: 10 }, (_, i) => r("strong", 0.05 * (i + 1), { ok: false })),
  ];
  const e = agg(rows, "t2s");
  assert.equal(e.stats["p/strong"].recentSamples, 10);
  assert.equal(e.stats["p/strong"].successRate, 0, "the recent rate (0 of 10) is lower");
  const x = await ranked(e, "p/strong");
  assert.ok(x.edge < 0, JSON.stringify(x));
});

test("recent override: a single fresh failure on a strong record does not trip it", async () => {
  const lone = agg([...many(400, "strong", 24), r("strong", 0.1, { ok: false })], "t2s");
  assert.equal(lone.stats["p/strong"].recentFailures, 1);
  assert.ok((await ranked(lone, "p/strong")).edge > 0.02);
  const mixed = agg(
    [...many(400, "strong", 24), ...many(9, "strong", 0.5), r("strong", 0.1, { ok: false })],
    "t2s"
  );
  assert.equal(mixed.stats["p/strong"].recentSamples, 10);
  assert.equal(
    mixed.stats["p/strong"].successRate,
    mixed.stats["p/strong"].weightedSuccessRate,
    "one recent failure is below the 3-failure trigger"
  );
  assert.ok((await ranked(mixed, "p/strong")).edge > 0.02);
});

test("recent override: 4 ok + 1 failure in the last 2 h does not trigger", () => {
  const s = agg([...many(400, "m", 24), ...many(4, "m", 0.5), r("m", 0.3, { ok: false })], "t2s")
    .stats["p/m"];
  assert.equal(s.recentFailures, 1);
  assert.equal(s.successRate, s.weightedSuccessRate);
});

test("recent override: a client_disconnected row is not in the recent window at all", () => {
  const s = agg(
    [
      ...many(400, "m", 24),
      ...many(4, "m", 0.5),
      // the user pressed Escape 30 s into a long turn, three times
      ...Array.from({ length: 3 }, () =>
        r("m", 0.2, { ok: false, code: "client_disconnected", ms: 30_000 })
      ),
    ],
    "t2s"
  ).stats["p/m"];
  assert.equal(s.recentSamples, 4);
  assert.equal(s.recentFailures, 0);
  assert.equal(s.successRate, s.weightedSuccessRate);
});

test("recent override: 3 fresh failures on 400 day-old successes rank below an untried model", async () => {
  const e = agg(
    [
      ...many(400, "m", 24),
      ...Array.from({ length: 3 }, (_, i) => r("m", 0.2 * (i + 1), { ok: false })),
    ],
    "t2s"
  );
  assert.equal(e.stats["p/m"].recentFailures, 3);
  assert.equal(e.stats["p/m"].successRate, 0);
  assert.ok((await ranked(e, "p/m")).edge < 0);
});

test("recent override: a model failing now (5 failures in 1 h, some successes) is caught", async () => {
  const e = agg(
    [
      ...many(400, "m", 24),
      ...many(3, "m", 0.5),
      ...Array.from({ length: 5 }, (_, i) => r("m", 0.15 * (i + 1), { ok: false })),
    ],
    "t2s"
  );
  assert.ok(Math.abs(e.stats["p/m"].successRate - 3 / 8) < 1e-9);
  assert.ok((await ranked(e, "p/m")).edge < 0);
});

test("thin evidence: 10 six-day-old successes + 1 failure today is not far below neutral", async () => {
  const e = agg([...many(10, "thin", 144), r("thin", 1, { ok: false })], "t2s");
  assert.ok(e.stats["p/thin"].effectiveSamples < 3);
  const x = await ranked(e, "p/thin");
  assert.ok(x.rel > 0.3, JSON.stringify(x));
  assert.ok(x.edge > -0.02, JSON.stringify(x));
  // the confidence floor is reached smoothly at 3 effective samples, never a jump
  const lo = durableReliability({ successRate: 1, effectiveSamples: 2.999 });
  const hi = durableReliability({ successRate: 1, effectiveSamples: 3 });
  assert.ok(Math.abs(hi.score - lo.score) < 0.01);
});

test("post_processing_error rows are the gateway's own failure, never model evidence", () => {
  const e = agg(
    [...many(5, "gw", 0), ...many(6, "gw", 0, { ok: false, code: "post_processing_error" })],
    "t2s"
  );
  assert.equal(e.stats["p/gw"].rawSamples, 5);
  assert.equal(e.stats["p/gw"].successRate, 1);
  assert.equal(e.rowsExcluded.gatewayError, 6);
});
