/**
 * Vendor-blind capability strength.
 *
 * One number in [0, 1] for "how much verified capability does this model have", built ONLY
 * from resolved capability fields (reasoning, tool calling, context window, output limit).
 * It never reads a provider id or a model name, so two models with the same resolved
 * capabilities always get the same strength, whoever made them.
 *
 * Rules every caller relies on:
 *  - Monotone: more verified capability never lowers the value.
 *  - Unknown contributes 0, never a penalty and never a guess: a field the registry could not
 *    verify (`null`) adds nothing, so a model with verified capabilities is never below an
 *    otherwise-equal model that has none.
 *  - No cliffs: context and output are continuous (log scale), not threshold steps.
 *
 * `capabilityStrength` is the ABSOLUTE, request-independent description (bigger is always more).
 * RANKING never uses it directly: it uses `demandedCapabilityStrength` below, which measures
 * coverage of what THIS request needs. Used by `modelPowerScore` / `scoreModelForTask`
 * (complexityFit) and by the capability-derived task fitness in `autoCombo/taskFitness.ts`, so
 * both factors describe the same evidence.
 */

export interface CapabilityEvidence {
  /** `true` only when verified (registry, spec or models.dev). `null` = unknown. */
  supportsThinking?: boolean | null;
  supportsTools?: boolean | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}

/** Share of the strength each verified capability can earn. Sums to 1. */
export const CAPABILITY_WEIGHTS = {
  reasoning: 0.35,
  tools: 0.1,
  context: 0.3,
  output: 0.25,
} as const;

// Log-scale anchors. Below the floor earns 0, at or above the ceiling earns the full weight.
const CONTEXT_FLOOR = 16_384;
const CONTEXT_CEIL = 1_000_000;
const OUTPUT_FLOOR = 4_096;
const OUTPUT_CEIL = 128_000;

function logFraction(value: number | null | undefined, floor: number, ceil: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= floor) return 0;
  if (value >= ceil) return 1;
  return Math.log2(value / floor) / Math.log2(ceil / floor);
}

/** True when at least one capability field is verified (known), whatever its value. */
export function hasCapabilityEvidence(caps: CapabilityEvidence | null | undefined): boolean {
  if (!caps) return false;
  return (
    typeof caps.supportsThinking === "boolean" ||
    typeof caps.supportsTools === "boolean" ||
    (typeof caps.contextWindow === "number" && caps.contextWindow > 0) ||
    (typeof caps.maxOutputTokens === "number" && caps.maxOutputTokens > 0)
  );
}

/** Verified capability strength in [0, 1]. Unknown fields add nothing. */
export function capabilityStrength(caps: CapabilityEvidence | null | undefined): number {
  if (!caps) return 0;
  const strength =
    (caps.supportsThinking === true ? CAPABILITY_WEIGHTS.reasoning : 0) +
    (caps.supportsTools === true ? CAPABILITY_WEIGHTS.tools : 0) +
    CAPABILITY_WEIGHTS.context * logFraction(caps.contextWindow, CONTEXT_FLOOR, CONTEXT_CEIL) +
    CAPABILITY_WEIGHTS.output * logFraction(caps.maxOutputTokens, OUTPUT_FLOOR, OUTPUT_CEIL);
  return Math.max(0, Math.min(1, strength));
}

// ── Demand-relative capability fit ──────────────────────────────────────────
//
// 2026-11-20: capability credit saturates at what the REQUEST needs. `capabilityStrength` above
// rewards absolute size up to fixed ceilings (1M context, 128K output), so a model with a 128K
// output cap out-scored a 65K one even for a request that needs 32K, and "biggest spec wins" was
// decided by a vendor's published numbers rather than by fit to the task. Here every candidate
// whose verified capabilities COVER the demand gets exactly the same credit, whatever larger
// spec it has, and only a real shortfall lowers it, continuously and in proportion.

/**
 * A prompt must fit in at most this share of the context window. Same constant as the -200
 * overflow penalty in `scoreModelForTask`, so full context credit starts exactly where that
 * penalty stops applying.
 */
export const CONTEXT_HEADROOM = 0.85;

/** What a request needs from a model. Derived from the request body only, never from a name. */
export interface CapabilityDemand {
  /** Estimated prompt size in tokens. The window must hold it within `CONTEXT_HEADROOM`. */
  promptTokens: number;
  /** Output tokens the request asks for, or the documented default when it asks for none. */
  outputTokens: number;
  /** The request requires or explicitly asks for reasoning. Not demanded: no reward, no penalty. */
  reasoning: boolean;
  /** The request carries tools. Not demanded: no reward, no penalty. */
  tools: boolean;
}

/**
 * Output tokens assumed when the client sends no limit (Codex-style bodies, plain chat calls): a
 * standard answer. One value for every request and every model; the task level plays no part, so
 * a model is never rewarded for a size the request did not ask for. An explicit client limit
 * (`max_tokens`, `max_output_tokens`, `max_completion_tokens`) always replaces it, larger or
 * smaller.
 */
export const DEFAULT_OUTPUT_DEMAND_TOKENS = 8_192;

/**
 * Demand used when no request is available (the request-independent legacy scorer, the combo
 * inspector, `modelPowerScore` without a task): a mid-sized prompt, a standard answer, and no
 * demanded reasoning or tools. The same for every candidate. A model that covers it scores
 * full credit; one that does not scores in proportion.
 */
export const NEUTRAL_DEMAND: CapabilityDemand = {
  promptTokens: 32_000,
  outputTokens: DEFAULT_OUTPUT_DEMAND_TOKENS,
  reasoning: false,
  tools: false,
};

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Build the demand of a request from its measured signals. Garbage input (NaN, negative,
 * infinite, non-numbers) is ignored, never trusted: an unusable prompt size counts as 0 and an
 * unusable output limit falls back to the default.
 */
export function deriveCapabilityDemand(input: {
  promptChars?: unknown;
  outputTokens?: unknown;
  reasoning?: boolean;
  tools?: boolean;
}): CapabilityDemand {
  const chars = positiveNumber(input.promptChars);
  return {
    promptTokens: chars === null ? 0 : Math.ceil(chars / 4),
    outputTokens: positiveNumber(input.outputTokens) ?? DEFAULT_OUTPUT_DEMAND_TOKENS,
    reasoning: input.reasoning === true,
    tools: input.tools === true,
  };
}

/**
 * Coverage of `demand` by the model's verified capabilities, in [0, 1].
 *
 * Per demanded dimension a credit in [0, 1]:
 *  - context: min(1, window / (promptTokens / CONTEXT_HEADROOM))
 *  - output:  min(1, maxOutputTokens / outputTokens)   (half the demanded output = half credit)
 *  - reasoning, tools: 1 when verified, else 0. Only when the request demands them.
 * The result is the CAPABILITY_WEIGHTS-weighted average over the DEMANDED dimensions only
 * (context and output are always demanded), so a capability the request does not need earns
 * nothing and costs nothing. A field the registry could not verify credits 0 (unknown adds
 * nothing, as in `capabilityStrength`). Monotone: more capability never lowers it, and beyond
 * the demand it changes nothing. Continuous: no threshold steps.
 */
export function demandedCapabilityStrength(
  caps: CapabilityEvidence | null | undefined,
  demand: CapabilityDemand = NEUTRAL_DEMAND
): number {
  if (!caps) return 0;
  const windowTokens = positiveNumber(caps.contextWindow);
  const maxOutput = positiveNumber(caps.maxOutputTokens);
  const neededWindow = Math.max(0, demand.promptTokens) / CONTEXT_HEADROOM;
  const outputDemand = positiveNumber(demand.outputTokens) ?? NEUTRAL_DEMAND.outputTokens;
  const contextCredit =
    windowTokens === null ? 0 : neededWindow <= 0 ? 1 : Math.min(1, windowTokens / neededWindow);
  const outputCredit = maxOutput === null ? 0 : Math.min(1, maxOutput / outputDemand);
  let weight = CAPABILITY_WEIGHTS.context + CAPABILITY_WEIGHTS.output;
  let earned =
    CAPABILITY_WEIGHTS.context * contextCredit + CAPABILITY_WEIGHTS.output * outputCredit;
  if (demand.reasoning) {
    weight += CAPABILITY_WEIGHTS.reasoning;
    if (caps.supportsThinking === true) earned += CAPABILITY_WEIGHTS.reasoning;
  }
  if (demand.tools) {
    weight += CAPABILITY_WEIGHTS.tools;
    if (caps.supportsTools === true) earned += CAPABILITY_WEIGHTS.tools;
  }
  return Math.max(0, Math.min(1, earned / weight));
}
