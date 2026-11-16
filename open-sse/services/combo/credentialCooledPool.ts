import type { AutoProviderCandidate } from "./types.ts";

/**
 * When EVERY candidate is blocked only because its connection answers a credential-rejection 400
 * (and nothing else), blocking all of them would surface a misleading "below configured quota
 * cutoffs" 429 that invites client retries. Demote them to the soft penalty instead so the real
 * attempt, and its real 400, is what the caller sees. A mixed pool is left untouched.
 */
export function demoteAllCredentialCooledCandidates(candidates: AutoProviderCandidate[]): void {
  if (
    candidates.length === 0 ||
    !candidates.every(
      (candidate) =>
        candidate.quotaCutoffBlocked === true &&
        candidate.quotaCutoffReason === "credential_rejected"
    )
  )
    return;
  for (const candidate of candidates) {
    candidate.quotaCutoffBlocked = false;
    candidate.quotaCutoffReason = undefined;
    candidate.quotaRemaining = candidate.quotaPolicyBypassed ? null : 100;
    candidate.statusPenalty = true;
    candidate.statusPenaltyReason = "credential_rejected";
  }
}
