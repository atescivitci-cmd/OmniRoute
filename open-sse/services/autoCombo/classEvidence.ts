/**
 * Class-specific outcome evidence with partial pooling (pure, DB-free).
 *
 * Problem this solves (live, 2026-11-21): the ranker read ONE success rate per model over all
 * request kinds. The routing canary sends tiny content-free probes, about one a minute per
 * model, so a model that only ever answered probes looked as reliable as one that had survived
 * long tool sessions, and ties then went to whichever hash drew them.
 *
 * What it does instead:
 *  1. Outcome rows are counted per request class (see requestClass.ts), and per tier of classes
 *     (`light`: no tools and a small input; `heavy`: everything else).
 *  2. The estimate for the class being routed is a partially pooled rate:
 *        tierRate = (tierOk  + TIER_PRIOR_STRENGTH  * poolRate) / (tierN  + TIER_PRIOR_STRENGTH)
 *        cellRate = (cellOk  + CLASS_PRIOR_STRENGTH * tierRate) / (cellN  + CLASS_PRIOR_STRENGTH)
 *     where poolRate is the rate of ALL models in that tier (a shared prior, weak Beta(1,1)).
 *     A class with few samples is therefore pulled toward its tier and then toward the pool:
 *     it never looks perfect (1 of 1) or terrible (0 of 1), and it moves smoothly with every
 *     sample. No sample-count cliff exists.
 *  3. Probe rows (source routing-canary) are light-class evidence only, at PROBE_WEIGHT of a
 *     real request. They are never counted for a heavy request.
 *  3b. A tier is used only when the pool holds CLASS_TIER_MIN_REAL_ROWS real rows of it
 *     (tierCovered); otherwise the old evidence stays.
 *  4. Rows without a class (written before the class existed, or while writing is off) that are
 *     not probes are read as heavy-tier evidence (LEGACY_ROW_CLASS), so the class evidence works
 *     the moment it is switched on, from the 24 h of rows already stored. When there is no row at
 *     all the caller keeps the old evidence.
 *  6. A candidate with few samples in the request's tier can only be LOWERED by that, never
 *     raised: its score blends toward min(score, 0.5) with weight 1 - tierSamples / 5, so an
 *     untried model never outranks a verified one on reliability alone, and the step is smooth.
 *  5. Optional outcome quality: a success that produced no output tokens counts as
 *     EMPTY_SUCCESS_FAILURE_WEIGHT of a failure.
 *
 * Provider-blind and model-blind by construction: nothing here reads a name except as a map key.
 */
import { USAGE_SOURCE_ROUTING_CANARY } from "../../../src/shared/constants/usageSource.ts";
import { isClientAbandon } from "../../../src/lib/usage/usageHistory/helpers.ts";
import { PROBE_REQUEST_CLASS, requestClassTier, type RequestClassTier } from "./requestClass.ts";

/**
 * Real (non-probe) rows a tier needs in the whole pool before class evidence is used for a request
 * of that tier. Below it the request keeps the old evidence and the decision says
 * "insufficient_coverage:<tier>". This stops a tier that has only probes, or only rows that were
 * written before the class existed, from steering traffic: rows without a class are read as heavy,
 * so the light tier is covered only by rows that were actually written with a light class.
 */
export const CLASS_TIER_MIN_REAL_ROWS = 20;
/** Class assigned to a non-probe row that has none (see aggregateOutcomeRows). */
export const LEGACY_ROW_CLASS = "c1n";
/** Pseudo-samples that pull a thin class toward its tier rate. */
export const CLASS_PRIOR_STRENGTH = 10;
/**
 * Pseudo-samples used instead when the observed rate is BELOW the prior it is pulled toward: bad
 * news is shrunk less than good news, so a few failures are not smoothed away by a good pool.
 */
export const DOWNSIDE_PRIOR_STRENGTH = 4;
/** Pseudo-samples that pull a thin tier toward the pool rate. */
export const TIER_PRIOR_STRENGTH = 10;
/** Weighted tier samples needed before a candidate counts as verified for a request's tier. */
export const CLASS_VERIFIED_MIN_SAMPLES = 5;
/** A probe row counts as this fraction of a real request, and only for the light tier. */
export const PROBE_WEIGHT = 0.5;
/** A "success" with zero output tokens counts as this much of a failure (outcome quality). */
export const EMPTY_SUCCESS_FAILURE_WEIGHT = 0.5;
export interface OutcomeRow {
  provider: string;
  model: string;
  success: boolean;
  errorCode?: string | null;
  latencyMs?: number | null;
  tokensOutput?: number | null;
  source?: string | null;
  requestClass?: string | null;
}

export interface Cell {
  /** Weighted number of requests. */
  n: number;
  /** Weighted number of successes (an empty success counts as less than one). */
  ok: number;
}

export interface ModelClassEvidence {
  cells: Map<string, Cell>;
  tiers: Record<RequestClassTier, Cell>;
}

export interface PoolClassEvidence {
  byModel: Map<string, ModelClassEvidence>;
  poolTier: Record<RequestClassTier, Cell>;
  /**
   * Real (non-probe) rows per tier. A tier with fewer than CLASS_TIER_MIN_REAL_ROWS is not
   * covered: class evidence is not used for a request of that tier (see tierCovered).
   */
  realRows: Record<RequestClassTier, number>;
  /** Rows that carried a usable class. Zero means the evidence has nothing to say yet. */
  classifiedRows: number;
}

export interface ClassReliability {
  score: number;
  /** The partially pooled rate before thin evidence is blended down (see classReliability). */
  rate: number;
  tier: RequestClassTier;
  cellSamples: number;
  tierSamples: number;
  tierRate: number;
  poolRate: number;
  verified: boolean;
}

function emptyCell(): Cell {
  return { n: 0, ok: 0 };
}

export function emptyPoolEvidence(): PoolClassEvidence {
  return {
    byModel: new Map(),
    poolTier: { light: emptyCell(), heavy: emptyCell() },
    realRows: { light: 0, heavy: 0 },
    classifiedRows: 0,
  };
}

export function modelEvidenceKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function add(cell: Cell, weight: number, ok: number): void {
  cell.n += weight;
  cell.ok += ok;
}

/** Fold outcome rows into per-model, per-class counts. */
export function aggregateOutcomeRows(
  rows: Iterable<OutcomeRow>,
  options: { outcomeQuality?: boolean; imputeLegacyRows?: boolean } = {}
): PoolClassEvidence {
  const pool = emptyPoolEvidence();
  for (const row of rows) {
    if (!row.provider || !row.model) continue;
    // Same neutral rule as the legacy ranking evidence: a user pressing Escape is not a failure.
    if (isClientAbandon(row.errorCode, row.latencyMs)) continue;

    const probe = row.source === USAGE_SOURCE_ROUTING_CANARY;
    let cls = typeof row.requestClass === "string" ? row.requestClass : null;
    if (probe && (!cls || requestClassTier(cls) !== "light")) cls = PROBE_REQUEST_CLASS;
    // A row written before the class existed: real client traffic through this gateway is agent
    // and application traffic, so it is read as heavy-tier evidence. Its input size cannot be used
    // (failed rows record no input tokens, which would file every failure under light and every
    // success under heavy). Probes are recognised by their own source tag, never by this guess.
    if (!cls && options.imputeLegacyRows !== false) cls = LEGACY_ROW_CLASS;
    const tier = cls ? requestClassTier(cls) : null;
    if (!cls || !tier) continue;

    const weight = probe ? PROBE_WEIGHT : 1;
    let value = 0;
    if (row.success) {
      const empty = options.outcomeQuality === true && Number(row.tokensOutput ?? 1) <= 0;
      value = empty ? 1 - EMPTY_SUCCESS_FAILURE_WEIGHT : 1;
    }
    const ok = value * weight;

    const key = modelEvidenceKey(row.provider, row.model);
    let model = pool.byModel.get(key);
    if (!model) {
      model = { cells: new Map(), tiers: { light: emptyCell(), heavy: emptyCell() } };
      pool.byModel.set(key, model);
    }
    let cell = model.cells.get(cls);
    if (!cell) {
      cell = emptyCell();
      model.cells.set(cls, cell);
    }
    add(cell, weight, ok);
    add(model.tiers[tier], weight, ok);
    add(pool.poolTier[tier], weight, ok);
    pool.classifiedRows += 1;
    if (!probe) pool.realRows[tier] += 1;
  }
  return pool;
}

/** Partially pooled success estimate of one model for one request class. */
export function classReliability(
  pool: PoolClassEvidence,
  provider: string,
  model: string,
  requestClass: string
): ClassReliability | null {
  const tier = requestClassTier(requestClass);
  if (!tier) return null;
  const poolCell = pool.poolTier[tier];
  const poolRate = (poolCell.ok + 1) / (poolCell.n + 2);
  const evidence = pool.byModel.get(modelEvidenceKey(provider, model));
  const t = evidence?.tiers[tier] ?? emptyCell();
  const c = evidence?.cells.get(requestClass) ?? emptyCell();
  const kTier = t.n > 0 && t.ok / t.n < poolRate ? DOWNSIDE_PRIOR_STRENGTH : TIER_PRIOR_STRENGTH;
  const tierRate = (t.ok + kTier * poolRate) / (t.n + kTier);
  const kCell = c.n > 0 && c.ok / c.n < tierRate ? DOWNSIDE_PRIOR_STRENGTH : CLASS_PRIOR_STRENGTH;
  const pooled = (c.ok + kCell * tierRate) / (c.n + kCell);
  // Thin evidence may only lower a score: blend toward min(pooled, neutral) while the tier has
  // fewer than CLASS_VERIFIED_MIN_SAMPLES samples (what an untried model could look like is
  // decided by the pool, not by what a good light rate says about a heavy request).
  const confidence = Math.min(1, t.n / CLASS_VERIFIED_MIN_SAMPLES);
  const score = confidence * pooled + (1 - confidence) * Math.min(pooled, 0.5);
  return {
    score,
    rate: pooled,
    tier,
    cellSamples: c.n,
    tierSamples: t.n,
    tierRate,
    poolRate,
    verified: t.n >= CLASS_VERIFIED_MIN_SAMPLES,
  };
}

/**
 * Health factor on the class-evidence path: the observed class success rate itself when the
 * breaker is closed and the tier is verified, otherwise neutral. (The default path keeps its own
 * health rule; this runs only while ROUTING_CLASS_EVIDENCE is on and class rows exist.)
 */
export function classHealthFactor(
  circuitBreakerState: string | undefined,
  operational: { reason: string; score: number }
): number {
  return circuitBreakerState === "CLOSED" && operational.reason === "observed"
    ? operational.score
    : 0.5;
}

export function tierCovered(pool: PoolClassEvidence, tier: RequestClassTier): boolean {
  return pool.realRows[tier] >= CLASS_TIER_MIN_REAL_ROWS;
}
