import { isBoundedUsageHealth, type CandidateProvenance } from "./candidateProvenance.ts";
import { durableReliability } from "./durableEvidence.ts";

export interface ReliabilityEvidence {
  score: number;
  confidence: number;
  sampleCount: number;
  source: "usage_24h" | "usage_durable" | "usage_24h_class" | "runtime_process" | "neutral_prior";
  reason: "observed" | "missing_or_stale" | "insufficient_samples";
  /** usage_durable only: how far thin evidence may move health from neutral (0..1). */
  healthWeight?: number;
}

/** HTTP completion evidence is operational reliability, never answer quality. */
export function operationalReliability(
  candidate: {
    provenance?: CandidateProvenance;
    failureRate?: number;
    errorRate?: number;
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
  // usage_durable (ROUTING_DURABLE_EVIDENCE) is the same kind of bounded aggregate over 7 days with
  // decay; its sample count is already the decayed effective count.
  if (!isBoundedUsageHealth(health)) return neutral;
  const rates = [candidate.failureRate, candidate.errorRate].filter(
    (v): v is number => v !== undefined
  );
  if (!rates.length || rates.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return neutral;
  // ROUTING_DURABLE_EVIDENCE: evidence exists on the raw count (sampleCount); the estimate and its
  // confidence use the decay-weighted count, floored once evidence exists (durableEvidence.ts B).
  if (health.source === "usage_durable") {
    const durable = durableReliability({
      successRate: 1 - Math.max(...rates),
      effectiveSamples: Number(health.effectiveSampleCount ?? health.sampleCount),
    });
    return {
      score: durable.score,
      confidence: durable.confidence,
      sampleCount: health.sampleCount!,
      source: "usage_durable",
      reason: "observed",
      healthWeight: durable.healthWeight,
    };
  }
  // Bound influence of large aggregates; prior is Beta(2,2), sample confidence is separate.
  const n = Math.min(health.sampleCount!, 1000);
  const successes = n * (1 - Math.max(...rates));
  return {
    score: (2 + successes) / (4 + n),
    confidence: n / (n + 20),
    sampleCount: n,
    source: health.source as "usage_24h" | "usage_durable",
    reason: "observed",
  };
}
