import type { CandidateProvenance } from "./candidateProvenance.ts";

export interface ReliabilityEvidence {
  score: number;
  confidence: number;
  sampleCount: number;
  source: "usage_24h" | "runtime_process" | "neutral_prior";
  reason: "observed" | "missing_or_stale";
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
  if (health.source !== "usage_24h" || health.windowHours !== 24) return neutral;
  const rates = [candidate.failureRate, candidate.errorRate].filter(
    (v): v is number => v !== undefined
  );
  if (!rates.length || rates.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return neutral;
  // Bound influence of large aggregates; prior is Beta(2,2), sample confidence is separate.
  const n = Math.min(health.sampleCount!, 1000);
  const successes = n * (1 - Math.max(...rates));
  return {
    score: (2 + successes) / (4 + n),
    confidence: n / (n + 20),
    sampleCount: n,
    source: health.source,
    reason: "observed",
  };
}
