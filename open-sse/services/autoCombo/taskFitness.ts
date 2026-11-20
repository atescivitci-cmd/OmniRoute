/**
 * Task Fitness
 *
 * Maps model x task type -> fitness score [0..1], from VERIFIED evidence only. No model-name,
 * vendor or provider table decides ranking: until 2026-11-20 a hand-written table rated
 * claude-opus 0.95 / claude-haiku 0.7 against qwen 0.78 / minimax 0.72 and gave every newer
 * model a default, which made one vendor win by design.
 *
 * Resolution chain (highest -> lowest priority):
 * 1. User override   - DB `model_intelligence` where source='user_override'        (owner's data)
 * 2. Arena ELO       - DB `model_intelligence` where source='arena_elo'            (measured)
 *                      (also resolves a `-free` variant through its base id)
 * 3. Persisted tier  - DB `model_intelligence` where source='models_dev_tier'      (synced data)
 * 4. Capability      - derived from the model's resolved capabilities (reasoning, tools,
 *                      context window, output limit) by `capabilityStrength`, interpolated
 *                      between the budget and premium tier values of the task type.
 *                      source = "capability_derived". Monotone, continuous, name-blind.
 * 5. No evidence     - neutral 0.5, source = "no_capability_evidence". Never boosted by name.
 *
 * Source labels removed on 2026-11-20: "fitness_table" (static vendor table) and
 * "wildcard_boost" (name patterns). Consumers that read `taskFitnessSource` from
 * routing_decisions.factors_json will see "capability_derived" / "no_capability_evidence"
 * instead; older rows keep the old labels.
 *
 * Observed reliability, latency and validated answer quality are separate ranking factors in
 * fitFirstPolicy and are not folded in here.
 */

import {
  getModelIntelligenceBySource,
  setUserFitnessOverrideEntry,
  deleteUserFitnessOverrideEntry,
} from "../../../src/lib/db/modelIntelligence.ts";
import { getResolvedModelCapabilities } from "../modelCapabilities.ts";
import { capabilityStrength, hasCapabilityEvidence } from "../capabilityStrength.ts";

// ─── Capability -> task fitness mapping (resolution layer 4) ────────────

/**
 * Fitness at the bottom (capability strength 0) and top (strength 1) of the capability range,
 * per task type. A model's fitness is interpolated between them by its verified capability
 * strength, so it is continuous and monotone: more verified capability never lowers it. The
 * same curve applies to every provider and model name; the task type changes only the range.
 * (The values are the former models.dev "budget" and "premium" tier rows.)
 */
const TASK_FITNESS_RANGE: Record<string, { floor: number; ceil: number }> = {
  coding: { floor: 0.65, ceil: 0.92 },
  review: { floor: 0.6, ceil: 0.93 },
  planning: { floor: 0.55, ceil: 0.94 },
  analysis: { floor: 0.58, ceil: 0.95 },
  debugging: { floor: 0.6, ceil: 0.9 },
  documentation: { floor: 0.7, ceil: 0.88 },
  math: { floor: 0.58, ceil: 0.95 },
  creative: { floor: 0.66, ceil: 0.92 },
  default: { floor: 0.55, ceil: 0.85 },
};

/** Fitness when there is no evidence at all. Below every verified floor above. */
const NO_EVIDENCE_FITNESS = 0.5;

// ─── DB access helpers ──────────────────────────────────────────────────

const _intelligenceCache = new Map<string, number | null>();

function queryModelIntelligence(model: string, category: string, source: string): number | null {
  const cacheKey = `${model}:${category}:${source}`;
  if (_intelligenceCache.has(cacheKey)) {
    return _intelligenceCache.get(cacheKey)!;
  }

  try {
    const entry = getModelIntelligenceBySource(model, source, category);
    if (entry) {
      _intelligenceCache.set(cacheKey, entry.score);
      return entry.score;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persisted models.dev tier row (layer 3). Null when no row exists. */
export function getModelsDevTierFitness(model: string, taskType: string): number | null {
  return queryModelIntelligence(model.toLowerCase(), taskType.toLowerCase(), "models_dev_tier");
}

/**
 * Fitness derived from the model's resolved capabilities (layer 4). Null when no capability is
 * verified. Depends only on capability values, never on the provider or model name.
 */
export function getCapabilityDerivedFitness(model: string, taskType: string): number | null {
  let caps;
  try {
    caps = getResolvedModelCapabilities(model);
  } catch {
    return null;
  }
  if (!hasCapabilityEvidence(caps)) return null;
  const range = TASK_FITNESS_RANGE[taskType.toLowerCase()] ?? TASK_FITNESS_RANGE.default;
  return range.floor + capabilityStrength(caps) * (range.ceil - range.floor);
}

// ─── Resolution chain ───────────────────────────────────────────────────

export function getTaskFitness(model: string, taskType: string): number {
  return getTaskFitnessWithSource(model, taskType).score;
}

export function getTaskFitnessWithSource(
  model: string,
  taskType: string
): { score: number; source: string } {
  const normalizedModel = model.toLowerCase();
  const normalizedTask = taskType.toLowerCase();

  const userOverride = queryModelIntelligence(normalizedModel, normalizedTask, "user_override");
  if (userOverride !== null) {
    return { score: userOverride, source: "user_override" };
  }

  // Try arena_elo with the literal model id first (e.g. "mimo-v2.5"). If that's
  // a miss and the model id carries a "-free" suffix (e.g. "mimo-v2.5-free"),
  // try the un-suffixed base id so free-tier variants inherit the arena_elo
  // score of their paid counterpart. This is what operators expect: the
  // upstream's `mimo-v2.5` is benchmarked once, and `mimo-v2.5-free` should
  // pick up the same signal rather than losing every free-vs-paid comparison.
  const arenaElo = queryModelIntelligence(normalizedModel, normalizedTask, "arena_elo");
  if (arenaElo !== null) {
    return { score: arenaElo, source: "arena_elo" };
  }
  const arenaEloBase = lookupFreeAliasArenaElo(normalizedModel, normalizedTask);
  if (arenaEloBase !== null) {
    return { score: arenaEloBase, source: "arena_elo_free_alias" };
  }

  const tierScore = getModelsDevTierFitness(normalizedModel, normalizedTask);
  if (tierScore !== null) {
    return { score: tierScore, source: "models_dev_tier" };
  }

  const derived = getCapabilityDerivedFitness(model, normalizedTask);
  if (derived !== null) {
    return { score: derived, source: "capability_derived" };
  }

  return { score: NO_EVIDENCE_FITNESS, source: "no_capability_evidence" };
}

/** Suffix used to mark free-tier model variants (e.g. "mimo-v2.5-free"). */
const FREE_SUFFIX = "-free";

/**
 * Strip a trailing "-free" suffix from the model id and re-query arena_elo.
 * Returns `null` when the original id has no "-free" suffix, when the base id
 * is identical to the original, or when no arena_elo row exists for the base.
 *
 * Examples:
 *   "mimo-v2.5-free"   → look up "mimo-v2.5"
 *   "deepseek-v4-flash-free" → look up "deepseek-v4-flash"
 *   "big-pickle"       → no "-free" suffix → return null (skip)
 */
function lookupFreeAliasArenaElo(normalizedModel: string, normalizedTask: string): number | null {
  if (!normalizedModel.endsWith(FREE_SUFFIX)) return null;
  const baseId = normalizedModel.slice(0, -FREE_SUFFIX.length);
  if (baseId.length === 0 || baseId === normalizedModel) return null;
  return queryModelIntelligence(baseId, normalizedTask, "arena_elo");
}

export function setUserFitnessOverride(model: string, category: string, score: number): void {
  try {
    setUserFitnessOverrideEntry(model.toLowerCase(), category.toLowerCase(), score);
    invalidateFitnessCache();
  } catch (err) {
    throw new Error(
      `Failed to set user fitness override for ${model}/${category}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function clearUserFitnessOverride(model: string, category: string): void {
  try {
    deleteUserFitnessOverrideEntry(model.toLowerCase(), category.toLowerCase());
    invalidateFitnessCache();
  } catch (err) {
    throw new Error(
      `Failed to clear user fitness override for ${model}/${category}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function getTaskTypes(): string[] {
  return Object.keys(TASK_FITNESS_RANGE).filter((k) => k !== "default");
}

export function invalidateFitnessCache(): void {
  _intelligenceCache.clear();
}
