/**
 * Content-free diagnostics for the auto strategy's pre-ranking stages.
 *
 * Targets removed by the tool-calling or context-window prefilter never reached the ranking, so
 * they appeared in neither "excluded" nor "alternatives" and a request that was too large for a
 * whole class of models (for example the native Codex models) lost them without a trace. These
 * helpers describe what was removed and flag a ranking won by a lone candidate with no evidence.
 * Output carries provider and model ids and numbers only, never request content.
 */

interface TargetLike {
  provider?: string | null;
  modelStr: string;
}

export interface PrefilterDrop {
  provider: string;
  model: string;
  reason: string;
  contextLimit?: number | null;
  requiredTokens?: number;
}

/** Targets present before a filter and absent after it (by identity). */
export function droppedTargets<T extends TargetLike>(
  before: readonly T[],
  after: readonly T[]
): T[] {
  const kept = new Set(after);
  return before.filter((target) => !kept.has(target));
}

export function describeContextDrops<T extends TargetLike>(
  dropped: readonly T[],
  limitOf: (target: T) => number | null | undefined,
  requiredOf: (target: T) => number
): PrefilterDrop[] {
  return dropped.map((target) => ({
    provider: String(target.provider ?? "unknown"),
    model: target.modelStr,
    reason: "context_window",
    contextLimit: limitOf(target) ?? null,
    requiredTokens: requiredOf(target),
  }));
}

export function describeToolFilterDrops<T extends TargetLike>(
  dropped: readonly T[]
): PrefilterDrop[] {
  return dropped.map((target) => ({
    provider: String(target.provider ?? "unknown"),
    model: target.modelStr,
    reason: "tool_calling_unsupported",
  }));
}

interface RankedLike {
  candidate: { provider?: string | null; model?: string | null };
  factors: {
    reliabilitySource?: string;
    reliabilitySampleCount?: number;
    latencyEvidence?: string;
    score: number;
  };
}

/** A ranking with exactly one candidate that has no observed reliability or latency evidence. */
export function loneUnprovenWinner(
  ranked: readonly RankedLike[]
): { provider: string; model: string; score: number; evidence: string[] } | null {
  if (ranked.length !== 1) return null;
  const only = ranked[0];
  const evidence: string[] = [];
  if (only.factors.reliabilitySource === "neutral_prior" || !only.factors.reliabilitySampleCount)
    evidence.push("reliability_neutral_prior");
  if (only.factors.latencyEvidence === "neutral_prior") evidence.push("latency_neutral_prior");
  if (evidence.length === 0) return null;
  return {
    provider: String(only.candidate.provider ?? "unknown"),
    model: String(only.candidate.model ?? "unknown"),
    score: only.factors.score,
    evidence,
  };
}
