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
 * Used by `modelPowerScore` / `scoreModelForTask` (complexityFit) and by the capability-derived
 * task fitness in `autoCombo/taskFitness.ts`, so both factors describe the same evidence.
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
