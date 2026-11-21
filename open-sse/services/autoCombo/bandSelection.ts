/**
 * Band selection for fit-first ranking (ROUTING_TIE_BAND, needs class evidence). Pure, name-blind.
 *
 * Candidates whose score is within the band of the best, that are VERIFIED for this request's
 * class and whose class reliability is within BAND_MAX_RELIABILITY_GAP of the best, are treated as
 * equally good. The primary pick among them is the neutral conversation-stable draw (provider
 * first when ROUTING_SPREAD_TIEBREAK is on, then model), so no one provider wins every request
 * just because its score is a hair higher. A candidate that is thin on class evidence or
 * measurably less reliable is never in the band, so the band cannot send a heavy tool session to
 * a model that has only ever answered probes.
 *
 * There is deliberately no exploration here. A bounded "try a less-used model" share was built and
 * removed: it is only safe for requests whose failures can move to another target, and the one
 * signal that says which targets cannot (the routing guard's `no_safe_fallback` rule) is a provider
 * name check in routingAttemptSafety.ts. No generic, name-blind signal exists, so exploration stays
 * off rather than add a name branch to the selector.
 */

export const BAND_MAX_RELIABILITY_GAP = 0.03;

export interface ClassInfo {
  score: number;
  rate: number;
  tierSamples: number;
  verified: boolean;
}

export interface BandNote {
  kind: "band";
  bandSize: number;
}

export interface RankableEntry {
  candidate: { provider: string; model: string; connectionId?: string | null };
  factors: { score: number; classEvidence?: ClassInfo; bandSelection?: BandNote };
  tieBreaker: string;
}

/** The band of equally good, verified candidates at the head of a sorted list (may be of size 1). */
export function selectBand<T extends RankableEntry>(ranked: T[], band: number): T[] {
  if (band <= 0 || ranked.length < 2) return ranked.slice(0, 1);
  const top = ranked[0];
  const topClass = top.factors.classEvidence;
  if (!topClass) return [top];
  return ranked.filter((entry) => {
    const info = entry.factors.classEvidence;
    if (!info?.verified) return false;
    return (
      entry.factors.score >= top.factors.score - band &&
      info.score >= topClass.score - BAND_MAX_RELIABILITY_GAP
    );
  });
}

/** Move the neutral draw among the band to the front. Returns the band size (1 = no change). */
export function applyBand<T extends RankableEntry>(ranked: T[], band: number): number {
  const members = selectBand(ranked, band);
  if (members.length < 2) return members.length;
  const pick = [...members].sort((a, b) => a.tieBreaker.localeCompare(b.tieBreaker))[0];
  if (pick !== ranked[0]) {
    ranked.splice(ranked.indexOf(pick), 1);
    ranked.unshift(pick);
  }
  pick.factors.bandSelection = { kind: "band", bandSize: members.length };
  return members.length;
}
