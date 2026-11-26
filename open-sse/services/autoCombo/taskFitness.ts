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
 * 2. Arena ELO       - DB `model_intelligence` where source='arena_elo'            (measured;
 *                      refines the capability-derived value by a bounded +/-0.06, see below)
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
  getBenchmarkModelId,
  getModelIntelligenceBySource,
  getQualityScoreByKeys,
  setUserFitnessOverrideEntry,
  deleteUserFitnessOverrideEntry,
} from "../../../src/lib/db/modelIntelligence.ts";
import { candidateQualityKeys, qualityCategoryForTask } from "./qualityModelKey.ts";
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

/**
 * Ids under which measured rows (user_override, arena_elo) are looked up, most specific first:
 * the id as given (usually `provider/model`), then the model without its leading provider
 * segment. Measured rows are written under the bare model name (arenaEloSync writes
 * `claude-opus-4-7`, never `claude/claude-opus-4-7`), while the routers look models up by their
 * provider-qualified id; trying both keeps measured evidence reachable from every path. There is
 * deliberately no last-segment fallback: a bare row named `x` must not apply to `vendor/team/x`,
 * a different model that merely ends the same way. Pure string handling, no model names.
 */
function measuredLookupIds(normalizedModel: string): string[] {
  const ids = [normalizedModel];
  const slash = normalizedModel.indexOf("/");
  if (slash > 0) ids.push(normalizedModel.slice(slash + 1));
  return [...new Set(ids.filter(Boolean))];
}

function firstMeasured(
  ids: string[],
  normalizedTask: string,
  source: string
): { score: number; id: string } | null {
  for (const id of ids) {
    const score = queryModelIntelligence(id, normalizedTask, source);
    if (score !== null) return { score, id };
  }
  return null;
}

// Arena ratings are normalised per leaderboard onto this range (arenaEloSync: 0.4 + 0.58 x rank
// position), so its midpoint is the rating of an "average" listed model.
const ARENA_RATING_MID = 0.69;
const ARENA_RATING_HALF_RANGE = 0.29;
/**
 * Largest move a rating can make to a model's fitness, either way. The best-rated model gains
 * this much over an unrated one of equal capability and the worst-rated loses this much, so the
 * full leaderboard spans 2 x 0.06 = 0.12 of fitness: enough to order models of similar verified
 * capability (capability strength 0..1 moves fitness by 0.27-0.37), too small to lift a model
 * above one with materially more verified capability (at least 0.12 / 0.37 = a third of the
 * strength range). Final-score effect at the heavy/critical task weight 0.5: at most 0.03.
 */
const ARENA_RATING_BAND = 0.06;

/**
 * A measured rating REFINES the capability-derived fitness instead of replacing it. Ratings live
 * on the leaderboard's own 0.4-0.98 scale while unrated models keep a capability-derived value on
 * a different scale, so using the raw rating as the fitness let leaderboard coverage (uneven
 * across vendors) decide: an unrated model outranked every rated model below about 0.92. Here a
 * rated model sits at its capability-derived value plus a bounded, monotone adjustment centred on
 * the leaderboard midpoint: rated-high >= unrated >= rated-low for equal capability. With no
 * capability evidence the 0.5 prior is adjusted the same way but never lifted above the lowest
 * verified fitness of the task, so a rating cannot make an unverified model outrank a verified one.
 */
function refineWithRating(rating: number, normalizedTask: string, model: string): number {
  const range = TASK_FITNESS_RANGE[normalizedTask] ?? TASK_FITNESS_RANGE.default;
  const derived = getCapabilityDerivedFitness(model, normalizedTask);
  const position = Math.max(-1, Math.min(1, (rating - ARENA_RATING_MID) / ARENA_RATING_HALF_RANGE));
  const adjustment = position * ARENA_RATING_BAND;
  if (derived === null) return Math.min(NO_EVIDENCE_FITNESS + adjustment, range.floor);
  return Math.max(0, Math.min(1, derived + adjustment));
}

export function getTaskFitnessWithSource(
  model: string,
  taskType: string
): { score: number; source: string } {
  const normalizedModel = model.toLowerCase();
  const normalizedTask = taskType.toLowerCase();
  const ids = measuredLookupIds(normalizedModel);

  // The owner's explicit override is outright: it replaces the fitness.
  const userOverride = firstMeasured(ids, normalizedTask, "user_override");
  if (userOverride) {
    return { score: userOverride.score, source: "user_override" };
  }

  // Try arena_elo with the literal model id first (e.g. "mimo-v2.5"), then its bare form. If
  // that's a miss and the model id carries a "-free" suffix (e.g. "mimo-v2.5-free"),
  // try the un-suffixed base id so free-tier variants inherit the arena_elo
  // score of their paid counterpart. This is what operators expect: the
  // upstream's `mimo-v2.5` is benchmarked once, and `mimo-v2.5-free` should
  // pick up the same signal rather than losing every free-vs-paid comparison.
  const arenaElo = firstMeasured(ids, normalizedTask, "arena_elo");
  if (arenaElo) {
    return {
      score: refineWithRating(arenaElo.score, normalizedTask, model),
      source: "arena_elo",
    };
  }
  for (const id of ids) {
    const arenaEloBase = lookupFreeAliasArenaElo(id, normalizedTask);
    if (arenaEloBase !== null) {
      return {
        score: refineWithRating(arenaEloBase, normalizedTask, model),
        source: "arena_elo_free_alias",
      };
    }
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
  _qualityCache.clear();
}

// ─── Task quality (ROUTING_QUALITY_FIRST) ───────────────────────────────

/** Source label of the LMArena quality rows (src/lib/qualityScoreSync.ts QUALITY_SOURCE). */
export const QUALITY_SCORE_SOURCE = "lmarena";
/**
 * Quality score of a model with no quality data when nothing else is known: the midpoint of the
 * normalised leaderboard scale (0.4 weakest .. 0.98 strongest listed model). The ranker replaces it
 * with the lowest measured quality of the candidate pool (ordered after every measured candidate)
 * when the pool has measured candidates (fitFirstPolicy, qualityNeutralBasis "pool_min").
 */
export const NEUTRAL_QUALITY_SCORE = 0.69;
const QUALITY_CACHE_TTL_MS = 60_000;
const _qualityCache = new Map<string, { at: number; value: TaskQuality }>();

export interface TaskQuality {
  score: number;
  /** "user_override", "lmarena" or "neutral_no_quality_data". */
  source: string;
  /** Stored task category that was read ("default" for the general task). */
  category: string;
  /** Normalised key that matched (null for neutral / override). */
  key: string | null;
  /** How the key was found: an operator mapping, or name normalisation. */
  keySource?: "benchmark_mapping" | "name_normalisation";
  /** synced_at of the matched row (SQLite UTC), when one matched. */
  syncedAt?: string | null;
  eloRaw?: number | null;
}

/**
 * Quality score of `provider/model` for `taskType`, from verified evidence only:
 *  1. the owner's user_override row for the task (outright),
 *  2. the LMArena row for the task category, looked up by an operator benchmark mapping first
 *     (model_benchmark_mappings, source "lmarena") and then by name normalisation
 *     (qualityModelKey.ts: full id, last path segment, canonical key),
 *  3. NEUTRAL_QUALITY_SCORE.
 * The routing provider is never part of the key, so one model reached through two providers gets
 * the same score. No usage history is read.
 */
export function getTaskQualityWithSource(
  provider: string,
  model: string,
  taskType: string,
  now = Date.now()
): TaskQuality {
  const category = qualityCategoryForTask(taskType);
  const cacheKey = `${provider}\0${model}\0${category}`;
  const cached = _qualityCache.get(cacheKey);
  if (cached && now - cached.at < QUALITY_CACHE_TTL_MS) return cached.value;
  const value = resolveTaskQuality(provider, model, category, taskType);
  _qualityCache.set(cacheKey, { at: now, value });
  return value;
}

function resolveTaskQuality(
  provider: string,
  model: string,
  category: string,
  taskType: string
): TaskQuality {
  const neutral: TaskQuality = {
    score: NEUTRAL_QUALITY_SCORE,
    source: "neutral_no_quality_data",
    category,
    key: null,
  };
  const ids = measuredLookupIds(`${provider}/${model}`.toLowerCase());
  for (const task of new Set([category, String(taskType ?? "").toLowerCase()])) {
    const override = firstMeasured(ids, task, "user_override");
    if (override)
      return { score: override.score, source: "user_override", category: task, key: null };
  }
  try {
    const mapped = getBenchmarkModelId(provider, model, QUALITY_SCORE_SOURCE);
    if (mapped) {
      const row = getQualityScoreByKeys(
        [mapped, ...candidateQualityKeys(mapped)],
        category,
        QUALITY_SCORE_SOURCE
      );
      if (row) {
        return {
          score: row.score,
          source: QUALITY_SCORE_SOURCE,
          category,
          key: row.key,
          keySource: "benchmark_mapping",
          syncedAt: row.syncedAt,
          eloRaw: row.eloRaw,
        };
      }
    }
    const row = getQualityScoreByKeys(candidateQualityKeys(model), category, QUALITY_SCORE_SOURCE);
    if (row) {
      return {
        score: row.score,
        source: QUALITY_SCORE_SOURCE,
        category,
        key: row.key,
        keySource: "name_normalisation",
        syncedAt: row.syncedAt,
        eloRaw: row.eloRaw,
      };
    }
  } catch (error) {
    console.error(
      `[QUALITY_FIRST] quality lookup failed for ${provider}/${model}: ${error instanceof Error ? error.message : String(error)}`
    );
    return { ...neutral, source: "neutral_lookup_failed" };
  }
  return neutral;
}
