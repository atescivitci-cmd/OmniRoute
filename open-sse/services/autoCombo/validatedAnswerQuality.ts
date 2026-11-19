/** Client-validated, contract-scoped answer evidence; never an eligibility veto. */
export type AnswerQualityEvidence = { accepted: number; rejected: number; latestAt: number };
export const QUALITY_TTL_MS = 24 * 60 * 60 * 1000;
export function qualityContract(body: Record<string, any>): string | null {
  const value = body?.metadata?.omniroute_quality_contract;
  return typeof value === "string" && /^[a-z0-9_.:-]{1,100}$/.test(value) ? value : null;
}
export function qualityCandidateKey(provider: string, connectionId: string, model: string): string {
  return JSON.stringify([provider, connectionId, model]);
}
export function validatedQualityAdjustment(e: AnswerQualityEvidence | undefined, now = Date.now()) {
  if (
    !e ||
    !Number.isFinite(e.latestAt) ||
    e.latestAt > now ||
    now - e.latestAt >= QUALITY_TTL_MS ||
    !Number.isSafeInteger(e.accepted) ||
    !Number.isSafeInteger(e.rejected) ||
    e.accepted < 0 ||
    e.rejected < 0 ||
    e.accepted + e.rejected === 0
  )
    return { score: null, penalty: 0, samples: 0 };
  const n = e.accepted + e.rejected;
  // Negative evidence has a bounded ranking cost, decays, and recovers through
  // later accepted answers. An HTTP 200 alone cannot create a positive sample.
  const freshness = 1 - (now - e.latestAt) / QUALITY_TTL_MS;
  return {
    score: (1 + e.accepted) / (2 + n),
    penalty: Math.min(0.45, (0.45 * e.rejected) / (e.accepted + e.rejected + 1)) * freshness,
    samples: n,
  };
}
