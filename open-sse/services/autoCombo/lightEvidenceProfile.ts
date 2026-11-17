/**
 * Evidence-weighted ranking profile for `light` asks (flag: ROUTING_LIGHT_BY_ASK).
 *
 * The legacy light profile gives 0.28 of the score to a "size closeness" term and only
 * 0.05 to measured latency, so a candidate that is merely closest to a small target can
 * beat one that is measurably faster and more reliable. This module moves part of that
 * weight onto the two measurements the selector already holds: measured latency and
 * measured operational reliability.
 *
 * Design constraints, all enforced here and by tests:
 *  - No identifier, family or provider text is read anywhere in this file. Inputs are
 *    numbers (latency, sample counts, coverage) only.
 *  - Fail-open: a term only gains weight when at least one candidate in the pool has
 *    measured evidence for it. With no evidence anywhere the weights are exactly the
 *    legacy ones, so the ranking is unchanged.
 *  - The weight budget is preserved: weight moved to a measurement term is taken from
 *    the size-closeness term, so the weights still sum to the legacy total.
 *  - Unknown evidence is neutral (0.5), never zero and never favoured.
 *  - Pure and O(candidates): no I/O, no randomness.
 */

export interface LightWeights {
  task: number;
  complexity: number;
  health: number;
  quota: number;
  reliability: number;
  latency: number;
}

/**
 * Latency (ms) at which a measured candidate scores exactly the neutral prior (0.5).
 * An interactive-reply reference: a measured candidate that is merely average is neither
 * favoured nor punished against an unmeasured one; faster than this is rewarded and
 * slower is penalised.
 */
export const LIGHT_LATENCY_NEUTRAL_MS = 2000;

/**
 * Shrinkage constant: the weight given to a measurement is n / (n + K), so a thin sample
 * is pulled toward the neutral prior and a large one is trusted. At the minimum sample
 * count the measurement already counts for half.
 */
export const LIGHT_LATENCY_SHRINK_K = 3;

/** Smallest sample count at which a latency measurement is usable at all. */
export const LIGHT_LATENCY_MIN_SAMPLES = 3;

/** Sample counts above this add no further confidence. */
const LIGHT_LATENCY_MAX_SAMPLES = 1000;

/** Weight moved off the size-closeness term onto each measurement term. */
export const LIGHT_SHIFT_TO_LATENCY = 0.1;
export const LIGHT_SHIFT_TO_RELIABILITY = 0.04;

const NEUTRAL = 0.5;

export interface LatencyEvidenceFit {
  /** Score in [0, 1]. Always finite. */
  fit: number;
  /** n / (n + K) when measured, 0 when the evidence is unknown (neutral). */
  shrink: number;
  measured: boolean;
}

/**
 * Convert a measured latency into a [0, 1] fit, shrunk toward neutral by sample count.
 * Unknown, non-finite, non-positive or under-sampled input is neutral, never an error.
 *
 * `successRate`, when it is a finite value in (0, 1], turns the latency of a successful
 * answer into the expected time to a successful answer (latency / successRate), so a
 * candidate that is quick only because it often fails earns no speed credit for that.
 */
export function latencyEvidenceFit(
  p95Ms: unknown,
  samples: unknown,
  successRate?: unknown
): LatencyEvidenceFit {
  const unknown: LatencyEvidenceFit = { fit: NEUTRAL, shrink: 0, measured: false };
  if (typeof p95Ms !== "number" || !Number.isFinite(p95Ms) || p95Ms <= 0) return unknown;
  if (typeof samples !== "number" || !Number.isFinite(samples)) return unknown;
  const n = Math.min(Math.floor(samples), LIGHT_LATENCY_MAX_SAMPLES);
  if (n < LIGHT_LATENCY_MIN_SAMPLES) return unknown;
  const rate =
    typeof successRate === "number" && Number.isFinite(successRate) && successRate > 0
      ? Math.min(1, successRate)
      : 1;
  const raw = 1 / (1 + p95Ms / rate / LIGHT_LATENCY_NEUTRAL_MS);
  const shrink = n / (n + LIGHT_LATENCY_SHRINK_K);
  const fit = NEUTRAL + shrink * (raw - NEUTRAL);
  return { fit: Math.max(0, Math.min(1, fit)), shrink, measured: true };
}

export interface LightEvidenceCoverage {
  /** Candidates with a usable latency measurement. */
  latencyMeasured: number;
  /** Candidates with a usable reliability measurement. */
  reliabilityMeasured: number;
  total: number;
}

/**
 * Re-weight the legacy light profile. A measurement term gains its shift only when the
 * pool contains at least one measured candidate for it; the shift is taken from
 * `complexity`. Weights still sum to the legacy total.
 */
export function lightEvidenceWeights(
  legacy: LightWeights,
  coverage: LightEvidenceCoverage
): LightWeights {
  const toLatency = coverage.latencyMeasured > 0 ? LIGHT_SHIFT_TO_LATENCY : 0;
  const toReliability = coverage.reliabilityMeasured > 0 ? LIGHT_SHIFT_TO_RELIABILITY : 0;
  const moved = Math.min(legacy.complexity, toLatency + toReliability);
  if (moved <= 0) return { ...legacy };
  // Scale both shifts if the size term cannot supply them (never negative).
  const scale = toLatency + toReliability > 0 ? moved / (toLatency + toReliability) : 0;
  return {
    ...legacy,
    complexity: legacy.complexity - moved,
    latency: legacy.latency + toLatency * scale,
    reliability: legacy.reliability + toReliability * scale,
  };
}
