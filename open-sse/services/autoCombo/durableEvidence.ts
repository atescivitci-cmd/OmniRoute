/**
 * Durable, class-family-gated ranking evidence (ROUTING_DURABLE_EVIDENCE, pure, DB-free).
 *
 * Problem this solves (live, 2026-11-26): auto-combo ranking read reliability and latency from a
 * 24 h window over every row. Two flaws combined into a lock-in on the terminal combo:
 *  1. Memory: a Claude Code session that ended 24 h before the next one left no row in the window,
 *     so every Claude model fell to the neutral prior.
 *  2. Class blindness: the routing canary sends tiny chat probes (class c0s) to NVIDIA models only,
 *     so those models always had fresh 24 h evidence and won heavy TOOL requests. Each win added
 *     more terminal evidence for them.
 *
 * What it does instead (only while ROUTING_DURABLE_EVIDENCE is on and the request has a class):
 *  A. Window DURABLE_EVIDENCE_WINDOW_HOURS (7 days). Each row is weighted
 *        w = 0.5 ** (ageHours / DURABLE_EVIDENCE_HALF_LIFE_HOURS)
 *     so a row from yesterday counts half and one idle day halves, not erases, a proven model.
 *  B. Counts and weights (revised 2026-11-26 after review: deciding "has evidence" on the decayed
 *     count made memory last only about log2(n_eff / 10) days, so two idle days erased a proven
 *     model again):
 *     - WHETHER a model has evidence is decided on RAW counts of gated rows in the window:
 *       totalRequests = raw rows (an entry needs minSamples = 3, the ranking's historical signal
 *       needs 10, the same 10 the routing canary uses). A single row is never proof.
 *     - WHAT the evidence says uses the weights: the success rate is sum(w * ok) / sum(w), so
 *       recent results dominate; latency, TTFT and tokens/s are weighted means and percentiles over
 *       successful rows (all attempts when fewer than minSamples successful rows exist).
 *     - HOW SURE the ranking is uses effectiveSamples = sum(w), floored at
 *       DURABLE_MIN_CONFIDENCE_SAMPLES once at least DURABLE_THIN_EFFECTIVE_SAMPLES effective
 *       samples exist (below that the floor and the health effect ramp down linearly, so thin old
 *       evidence plus one fresh failure stays near neutral; see durableReliability). Fresh evidence
 *       gives more confidence, and idling within a few days never drops a proven model.
 *     - RECENT OVERRIDE: when the last DURABLE_RECENT_WINDOW_HOURS hold at least
 *       DURABLE_RECENT_MIN_FAILURES failures of the model, the success rate is the lower of the
 *       weighted rate and the recent rate, so a strong old record cannot hide a model that is
 *       failing right now. client_disconnected rows (a user pressing Escape on a long turn) are
 *       not in the recent window at all, and gateway errors are never read (rule F). One or two
 *       failures do not trigger it: that flipped terminal traffic away from a good model and kept
 *       it away until the rows aged out (review, 2026-11-26).
 *  F. post_processing_error rows are not read: the gateway threw after the model answered.
 *  E. Phantom success rows: before the recording fix, chatCore wrote a success row and then,
 *     about 30 ms later, a malformed_translated_response failure row for the same request. A
 *     success row followed within PHANTOM_SUCCESS_MAX_GAP_MS by such a failure for the same
 *     provider and model, with a latency within the same gap, is that phantom and is not read.
 *     Stored data is never modified. Each failure cancels at most one success row.
 *  C. Family gating: a request of family `tools` (class t*) reads only t* rows, family `chat`
 *     (class c*) only c* rows. A row with no usable class is legacy real traffic and counts for
 *     either family. A routing-canary row without a class (written by an abort or stream-failure
 *     callback, for example probe_deadline) is read as the probe class c0s, like the canary's
 *     classified rows, so its failures count exactly where its successes do.
 *  D. Size gating (2026-11-26, live: Claude Code compaction calls, class c2n, failed on a model
 *     whose only chat evidence was the canary's tiny c0s probes): a classified row also needs a
 *     size bucket >= the request's. Evidence from larger or equal requests may prove smaller ones,
 *     never the reverse. The stream flag does not matter. So a c0s probe counts only for c0*
 *     requests, and unclassified rows keep counting as in C.
 *
 * Provider-blind and model-blind: names are only map keys.
 */
import { USAGE_SOURCE_ROUTING_CANARY } from "../../../src/shared/constants/usageSource.ts";
import {
  isClientAbandon,
  type ModelLatencyStatsEntry,
} from "../../../src/lib/usage/usageHistory/helpers.ts";
import { PROBE_REQUEST_CLASS, parseRequestClass } from "./requestClass.ts";

export const DURABLE_EVIDENCE_WINDOW_HOURS = 168;
export const DURABLE_EVIDENCE_HALF_LIFE_HOURS = 24;
export const DURABLE_EVIDENCE_MIN_SAMPLES = 3;
/**
 * Confidence floor, in pseudo-samples, for a model with raw evidence in the window (rule B). Equal
 * to the ranking's historical-signal threshold, so a proven model keeps at least the confidence it
 * had when it first became proven, however long it has been idle within the window.
 */
export const DURABLE_MIN_CONFIDENCE_SAMPLES = 10;
/** Effective samples at which the confidence floor applies in full (rule B). */
export const DURABLE_THIN_EFFECTIVE_SAMPLES = 3;
/** Recent window and minimum failures in it for the recent-rate override (rule B). */
export const DURABLE_RECENT_WINDOW_HOURS = 2;
export const DURABLE_RECENT_MIN_FAILURES = 3;
/** Failure codes that describe the gateway, not the model (rule F). */
const GATEWAY_ERROR_CODES = new Set(["post_processing_error"]);
/** Reliability score at which durable health is neutral (0.5); see durableHealth. */
export const DURABLE_HEALTH_NEUTRAL_SCORE = 0.7;
/** A success row this close before a malformed_translated_response failure is its phantom. */
export const PHANTOM_SUCCESS_MAX_GAP_MS = 2_000;
const MALFORMED_TRANSLATED_RESPONSE = "malformed_translated_response";

const HOUR_MS = 3_600_000;

export type EvidenceClassFamily = "tools" | "chat";

export interface DurableEvidenceRow {
  provider: string;
  model: string;
  success: boolean;
  latencyMs: number | null;
  ttftMs: number | null;
  tokensOutput: number | null;
  errorCode: string | null;
  source: string | null;
  requestClass: string | null;
  timestamp: string;
}

export interface DurableStatsEntry extends ModelLatencyStatsEntry {
  /** Decay-weighted rate; successRate is the lower of this and the recent rate (rule B). */
  weightedSuccessRate: number;
  /** Gated rows in the recent window and their plain success rate (null when none). */
  recentSamples: number;
  recentSuccessRate: number | null;
  recentFailures: number;
  /** Rows read for this model after gating (unweighted); equals totalRequests. */
  rawSamples: number;
  /** Sum of the decay weights of those rows (confidence of the estimate, see rule B). */
  effectiveSamples: number;
  halfLifeHours: number;
}

export interface DurableEvidenceExclusions {
  otherFamily: number;
  /** Same family, but from a smaller size bucket than the request (rule D). */
  smallerSize: number;
  /** Success rows recorded just before a malformed failure of the same request (rule E). */
  phantomSuccess: number;
  /** post_processing_error rows: the gateway threw after the model answered (rule F). */
  gatewayError: number;
  outsideWindow: number;
  clientAbandon: number;
}

export interface DurableEvidence {
  family: EvidenceClassFamily;
  /** Smallest size bucket a classified row may have to count (the request's own bucket). */
  minSizeBucket: 0 | 1 | 2;
  windowHours: number;
  halfLifeHours: number;
  rowsRead: number;
  rowsUsed: number;
  rowsExcluded: DurableEvidenceExclusions;
  stats: Record<string, DurableStatsEntry>;
}

/** Family of a request class: `tools` for t*, `chat` for c*, null for anything unparseable. */
export function requestClassFamily(value: unknown): EvidenceClassFamily | null {
  const parsed = parseRequestClass(value);
  if (!parsed) return null;
  return parsed.tools ? "tools" : "chat";
}

/** Exponential decay weight of a row `ageMs` old. A future row (clock skew) weighs 1. */
export function decayWeight(
  ageMs: number,
  halfLifeHours: number = DURABLE_EVIDENCE_HALF_LIFE_HOURS
): number {
  if (!Number.isFinite(ageMs) || !(halfLifeHours > 0)) return 0;
  if (ageMs <= 0) return 1;
  return 0.5 ** (ageMs / (halfLifeHours * HOUR_MS));
}

interface Weighted {
  value: number;
  w: number;
}

interface Bucket {
  provider: string;
  model: string;
  raw: number;
  rawOk: number;
  recentRaw: number;
  recentOk: number;
  n: number;
  ok: number;
  successful: Weighted[];
  all: Weighted[];
  successfulTtft: Weighted[];
  allTtft: Weighted[];
  successfulTps: Weighted[];
  allTps: Weighted[];
}

function weightedMean(samples: Weighted[]): number {
  let sum = 0;
  let weight = 0;
  for (const s of samples) {
    sum += s.value * s.w;
    weight += s.w;
  }
  return weight > 0 ? sum / weight : 0;
}

/** Smallest value whose cumulative weight reaches p of the total (same rule as unweighted rank). */
function weightedPercentile(sorted: Weighted[], p: number): number {
  if (sorted.length === 0) return 0;
  const total = sorted.reduce((acc, s) => acc + s.w, 0);
  const target = Math.max(0, Math.min(1, p)) * total;
  let cumulative = 0;
  for (const s of sorted) {
    cumulative += s.w;
    if (cumulative >= target - 1e-12) return s.value;
  }
  return sorted[sorted.length - 1].value;
}

function weightedStdDev(samples: Weighted[], avg: number): number {
  let weight = 0;
  let acc = 0;
  for (const s of samples) {
    acc += s.w * (s.value - avg) ** 2;
    weight += s.w;
  }
  return weight > 0 ? Math.sqrt(Math.max(0, acc / weight)) : 0;
}

/**
 * Reliability of a durable entry: Beta(2,2) posterior of the weighted success rate, with the
 * effective sample count as its strength, floored at DURABLE_MIN_CONFIDENCE_SAMPLES (rule B) and
 * capped at 1000 like the 24 h path. `confidence` is n / (n + 20), the 24 h path's rule.
 */
export function durableReliability(args: { successRate: number; effectiveSamples: number }): {
  score: number;
  confidence: number;
  samples: number;
  healthWeight: number;
} {
  const effective = Number.isFinite(args.effectiveSamples) ? Math.max(0, args.effectiveSamples) : 0;
  // Thin evidence (rule B): the floor ramps in linearly up to DURABLE_THIN_EFFECTIVE_SAMPLES, so
  // the strength is continuous, and the health effect is scaled by the same ramp.
  const ramp = Math.min(1, effective / DURABLE_THIN_EFFECTIVE_SAMPLES);
  const n = Math.min(Math.max(effective, DURABLE_MIN_CONFIDENCE_SAMPLES * ramp), 1000);
  const rate = Math.max(0, Math.min(1, args.successRate));
  return {
    score: (2 + n * rate) / (4 + n),
    confidence: n / (n + 20),
    samples: n,
    healthWeight: ramp,
  };
}

/**
 * Health factor from a durable reliability score (ranking, durable source only). Piecewise linear
 * and monotone: DURABLE_HEALTH_NEUTRAL_SCORE maps to the neutral 0.5 of a model with no evidence,
 * 1 maps to 1 and 0 to 0. So a model whose estimated success rate is below about 70% (for example
 * the live 57% malformed record) ranks below an untried one, and only a good record ranks above.
 */
export function durableHealth(score: number, weight = 1): number {
  const s = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  const pivot = DURABLE_HEALTH_NEUTRAL_SCORE;
  const full = s >= pivot ? 0.5 + ((s - pivot) / (1 - pivot)) * 0.5 : (s / pivot) * 0.5;
  // Thin evidence moves health only part of the way from neutral (rule B).
  const w = Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 1));
  return 0.5 + (full - 0.5) * w;
}

/** Indexes of success rows that are phantoms of a later malformed failure (rule E). */
function phantomSuccessRows(rows: DurableEvidenceRow[]): Set<number> {
  const failures = new Map<string, Array<{ at: number; latency: number; used: boolean }>>();
  rows.forEach((row) => {
    if (row.success || row.errorCode !== MALFORMED_TRANSLATED_RESPONSE) return;
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at)) return;
    const key = `${row.provider}/${row.model}`;
    const list = failures.get(key) ?? [];
    list.push({ at, latency: Number(row.latencyMs), used: false });
    failures.set(key, list);
  });
  const phantoms = new Set<number>();
  if (failures.size === 0) return phantoms;
  rows.forEach((row, index) => {
    if (!row.success) return;
    const list = failures.get(`${row.provider}/${row.model}`);
    if (!list) return;
    const at = Date.parse(row.timestamp);
    const latency = Number(row.latencyMs);
    let best: { at: number; latency: number; used: boolean } | null = null;
    for (const failure of list) {
      const gap = failure.at - at;
      if (failure.used || gap < 0 || gap > PHANTOM_SUCCESS_MAX_GAP_MS) continue;
      if (
        Number.isFinite(latency) &&
        Number.isFinite(failure.latency) &&
        Math.abs(failure.latency - latency) > PHANTOM_SUCCESS_MAX_GAP_MS
      )
        continue;
      if (!best || failure.at < best.at) best = failure;
    }
    if (best) {
      best.used = true;
      phantoms.add(index);
    }
  });
  return phantoms;
}

function buildEntry(
  key: string,
  bucket: Bucket,
  minSamples: number,
  windowHours: number,
  halfLifeHours: number
): DurableStatsEntry | null {
  const totalRequests = bucket.raw;
  if (totalRequests < minSamples) return null;
  const successfulCount = bucket.successful.length;
  const useSuccessful = successfulCount >= minSamples;
  const base = useSuccessful ? bucket.successful : bucket.all;
  const sorted = [...base].sort((a, b) => a.value - b.value);
  const avg = weightedMean(sorted);
  const weightedSuccessRate = bucket.n > 0 ? bucket.ok / bucket.n : 0;
  const recentSuccessRate = bucket.recentRaw > 0 ? bucket.recentOk / bucket.recentRaw : null;
  const successRate =
    recentSuccessRate !== null && bucket.recentRaw - bucket.recentOk >= DURABLE_RECENT_MIN_FAILURES
      ? Math.min(weightedSuccessRate, recentSuccessRate)
      : weightedSuccessRate;
  return {
    provider: bucket.provider,
    model: bucket.model,
    key,
    totalRequests,
    successfulRequests: bucket.rawOk,
    successRate,
    latencySampleSource: useSuccessful ? "successful" : "all_attempts",
    latencySampleCount: base.length,
    successfulLatencySampleCount: successfulCount,
    avgLatencyMs: Math.round(avg),
    p50LatencyMs: Math.round(weightedPercentile(sorted, 0.5)),
    p95LatencyMs: Math.round(weightedPercentile(sorted, 0.95)),
    p99LatencyMs: Math.round(weightedPercentile(sorted, 0.99)),
    latencyStdDev: Math.round(weightedStdDev(sorted, avg)),
    windowHours,
    avgTtftMs: Math.round(weightedMean(useSuccessful ? bucket.successfulTtft : bucket.allTtft)),
    avgE2ELatencyMs: Math.round(avg),
    avgTokensPerSecond:
      Math.round(weightedMean(useSuccessful ? bucket.successfulTps : bucket.allTps) * 100) / 100,
    rawSamples: bucket.raw,
    weightedSuccessRate,
    recentSamples: bucket.recentRaw,
    recentSuccessRate,
    recentFailures: bucket.recentRaw - bucket.recentOk,
    effectiveSamples: Math.round(bucket.n * 1e6) / 1e6,
    halfLifeHours,
  };
}

/**
 * Fold outcome rows into per-model ranking evidence for one request family. The result's `stats`
 * has the same shape the 24 h path (getModelLatencyStats) returns, so the candidate assembly reads
 * it unchanged. Throws when `requestClass` has no family: the caller must keep the old path then.
 */
export function aggregateDurableEvidence(
  rows: Iterable<DurableEvidenceRow>,
  options: {
    now: number;
    requestClass: string;
    minSamples?: number;
    windowHours?: number;
    halfLifeHours?: number;
    excludeClientAbandons?: boolean;
  }
): DurableEvidence {
  const family = requestClassFamily(options.requestClass);
  const minSizeBucket = parseRequestClass(options.requestClass)?.size ?? 0;
  if (!family)
    throw new Error(`durable evidence needs a request class, got ${options.requestClass}`);
  const minSamples = options.minSamples ?? DURABLE_EVIDENCE_MIN_SAMPLES;
  const windowHours = options.windowHours ?? DURABLE_EVIDENCE_WINDOW_HOURS;
  const halfLifeHours = options.halfLifeHours ?? DURABLE_EVIDENCE_HALF_LIFE_HOURS;
  const windowMs = windowHours * HOUR_MS;
  const excluded: DurableEvidenceExclusions = {
    otherFamily: 0,
    smallerSize: 0,
    phantomSuccess: 0,
    gatewayError: 0,
    outsideWindow: 0,
    clientAbandon: 0,
  };
  const buckets = new Map<string, Bucket>();
  let rowsRead = 0;
  let rowsUsed = 0;

  const list = [...rows];
  const phantoms = phantomSuccessRows(list);
  for (const [index, row] of list.entries()) {
    if (!row.provider || !row.model) continue;
    rowsRead += 1;
    const at = Date.parse(row.timestamp);
    const age = options.now - at;
    if (!Number.isFinite(at) || age > windowMs) {
      excluded.outsideWindow += 1;
      continue;
    }
    if (phantoms.has(index)) {
      excluded.phantomSuccess += 1;
      continue;
    }
    if (!row.success && row.errorCode && GATEWAY_ERROR_CODES.has(row.errorCode)) {
      excluded.gatewayError += 1;
      continue;
    }
    // An unclassified canary row is a probe like any other: read it as the probe class (rule C).
    const rowClass =
      requestClassFamily(row.requestClass) === null && row.source === USAGE_SOURCE_ROUTING_CANARY
        ? PROBE_REQUEST_CLASS
        : row.requestClass;
    const rowFamily = requestClassFamily(rowClass);
    if (rowFamily === null) {
      // legacy real traffic without a class: counts for every family and size (rule C)
    } else if (rowFamily !== family) {
      excluded.otherFamily += 1;
      continue;
    } else if (parseRequestClass(rowClass)!.size < minSizeBucket) {
      excluded.smallerSize += 1;
      continue;
    }
    if (options.excludeClientAbandons === true && isClientAbandon(row.errorCode, row.latencyMs)) {
      excluded.clientAbandon += 1;
      continue;
    }

    const w = decayWeight(age, halfLifeHours);
    const key = `${row.provider}/${row.model}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        provider: row.provider,
        model: row.model,
        raw: 0,
        rawOk: 0,
        recentRaw: 0,
        recentOk: 0,
        n: 0,
        ok: 0,
        successful: [],
        all: [],
        successfulTtft: [],
        allTtft: [],
        successfulTps: [],
        allTps: [],
      };
      buckets.set(key, bucket);
    }
    rowsUsed += 1;
    bucket.raw += 1;
    bucket.n += w;
    if (row.success) {
      bucket.ok += w;
      bucket.rawOk += 1;
    }
    if (age <= DURABLE_RECENT_WINDOW_HOURS * HOUR_MS && row.errorCode !== "client_disconnected") {
      bucket.recentRaw += 1;
      if (row.success) bucket.recentOk += 1;
    }

    // Same sample guards as accumulateLatencySample: no duration, no timing sample.
    const latency = Number(row.latencyMs);
    if (!(latency > 0)) continue;
    const ttft = Number(row.ttftMs);
    const tokens = Number(row.tokensOutput);
    bucket.all.push({ value: latency, w });
    if (ttft > 0) bucket.allTtft.push({ value: ttft, w });
    if (tokens > 0) bucket.allTps.push({ value: tokens / (latency / 1000), w });
    if (!row.success) continue;
    bucket.successful.push({ value: latency, w });
    if (ttft > 0) bucket.successfulTtft.push({ value: ttft, w });
    if (tokens > 0) bucket.successfulTps.push({ value: tokens / (latency / 1000), w });
  }

  const stats: Record<string, DurableStatsEntry> = {};
  for (const [key, bucket] of buckets) {
    const entry = buildEntry(key, bucket, minSamples, windowHours, halfLifeHours);
    if (entry) stats[key] = entry;
  }
  return {
    family,
    minSizeBucket,
    windowHours,
    halfLifeHours,
    rowsRead,
    rowsUsed,
    rowsExcluded: excluded,
    stats,
  };
}

/** Total rows the gating and window dropped (for the decision record). */
export function totalExcluded(excluded: DurableEvidenceExclusions): number {
  return (
    excluded.otherFamily +
    excluded.smallerSize +
    excluded.phantomSuccess +
    excluded.gatewayError +
    excluded.outsideWindow +
    excluded.clientAbandon
  );
}
