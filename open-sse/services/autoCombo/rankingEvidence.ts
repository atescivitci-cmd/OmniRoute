import type { CandidateProvenance } from "./candidateProvenance.ts";

export interface ReliabilityEvidence {
  score: number;
  confidence: number;
  sampleCount: number;
  source: "usage_24h" | "runtime_process" | "neutral_prior";
  /**
   * observed: the score is the measured rate. insufficient_samples: fewer than
   * `MIN_FULL_EVIDENCE_SAMPLES` samples and nothing bad enough to lower the neutral prior.
   */
  reason: "observed" | "missing_or_stale" | "insufficient_samples";
}

/**
 * Usage-window samples needed before an observed rate can RAISE a score above the neutral prior.
 * Below it one call would make a rate 0 or 1 (a model "proven" by a single lucky request), so a
 * thin sample may only lower the score: `min(0.5, rate)`. A failing model therefore never looks
 * better than an untried one because it has too few samples, and a healthy one is simply not
 * yet promoted. Equal observed rates still score equal at every sample size for rates up to a
 * coin flip; above it the score is the rate from this many samples on (an accepted, documented
 * cold-start premium, see docs/routing/AUTO-COMBO.md).
 */
export const MIN_FULL_EVIDENCE_SAMPLES = 3;

/**
 * HTTP completion evidence is operational reliability, never answer quality.
 *
 * `score` is the OBSERVED success rate of the bounded 24 h usage window, nothing else:
 * `1 - max(failureRate, errorRate)`. It is a function of the rate alone, so two candidates
 * with the same observed success rate (100% included) score exactly the same whether they
 * were used once or a thousand times. The previous Beta(2,2) posterior mean,
 * (2 + successes) / (4 + n), scored an all-success model 0.60 at n=1, 0.78 at n=5, 0.94 at
 * n=29 and 0.98 at n=100, so how OFTEN a model had been used decided between equally
 * reliable models, and because fit-first-free never explores, under-used models could not
 * catch up. Failures still count in full and monotonically: at a fixed sample size more
 * failures never raise the score, and a lower success rate is never ranked above a higher one.
 *
 * `confidence` (n / (n + 20)) and `sampleCount` stay as INFORMATIONAL fields (they are
 * written to routing_decisions.factors_json). They are not read by any scoring term.
 * Unobserved, stale or unbounded evidence keeps the neutral prior (0.5, confidence 0).
 * Below `MIN_FULL_EVIDENCE_SAMPLES` (3) samples the score is `min(0.5, rate)`: evidence may only
 * lower it.
 */
export function operationalReliability(
  candidate: {
    provenance?: CandidateProvenance;
    failureRate?: number;
    errorRate?: number;
    /**
     * Failure rate of the 24 h usage window, set by candidate assembly from the first sample on.
     * When present it is the only rate read here; the legacy fields stay untouched for the
     * other consumers of `errorRate`.
     */
    usageFailureRate?: number;
  },
  now = Date.now()
): ReliabilityEvidence {
  const neutral: ReliabilityEvidence = {
    score: 0.5,
    confidence: 0,
    sampleCount: 0,
    source: "neutral_prior",
    reason: "missing_or_stale",
  };
  const health = candidate.provenance?.health;
  if (!health || !Number.isSafeInteger(health.sampleCount) || (health.sampleCount ?? 0) <= 0)
    return neutral;
  const evaluated = Date.parse(health.evaluatedAt);
  if (!Number.isFinite(evaluated) || evaluated > now || now - evaluated > 60_000) return neutral;
  // Process-lifetime aggregates do not acquire a bounded window merely because
  // their latest event is recent. Use the existing bounded usage aggregate only.
  if (health.source !== "usage_24h" || health.windowHours !== 24) return neutral;
  const rates = (
    candidate.usageFailureRate !== undefined
      ? [candidate.usageFailureRate]
      : [candidate.failureRate, candidate.errorRate]
  ).filter((v): v is number => v !== undefined);
  if (!rates.length || rates.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return neutral;
  const n = Math.min(health.sampleCount!, 1000);
  const rate = Math.max(0, Math.min(1, 1 - Math.max(...rates)));
  const thin = n < MIN_FULL_EVIDENCE_SAMPLES;
  return {
    score: thin ? Math.min(0.5, rate) : rate,
    confidence: n / (n + 20),
    sampleCount: n,
    source: health.source,
    reason: thin && rate >= 0.5 ? "insufficient_samples" : "observed",
  };
}
