/**
 * Settings for the fair-selection staged rollout (2026-11-21).
 *
 * Every part is OFF by default, so with nothing set the gateway behaves exactly like the build
 * that was live before this change. Each part has its own switch so a staged rollout can enable
 * them one at a time and roll back by unsetting one variable, never by reinstalling.
 *
 * Mechanism: read from the process environment at call time, like ROUTING_LIGHT_BY_ASK and
 * ROUTING_SHADOW_LOG, so selector code stays DB-free and pure in unit tests. Changing a value
 * needs a restart of the gateway process. There is NO per-provider, per-model or per-consumer
 * variant of any of these: one value applies to every request from every client.
 *
 *  ROUTING_CLIENT_ABANDON_NEUTRAL 1|0 a client closing a stream within 10 s is neither a success
 *                                     nor a failure in the ranking evidence (default: every row counts)
 *  ROUTING_REQUEST_CLASS_WRITE  1|0   write a request class on every new usage row (step 1: collect)
 *  ROUTING_CLASS_EVIDENCE       1|0   rank on class-specific, partially pooled outcome evidence
 *  ROUTING_OUTCOME_QUALITY      1|0   count a "success" with zero output tokens as a partial failure
 *                                     (only read together with ROUTING_CLASS_EVIDENCE)
 *  ROUTING_SPREAD_TIEBREAK      1|0   spread ties across providers and prefer class-verified candidates
 *  ROUTING_TIE_BAND             0..0.02  scores within this band tie (0 = only exact ties tie)
 *  ROUTING_LEARNED_CONTEXT_CAP  off|learn|enforce  learn a model's real context limit from its
 *                                     own rejections; enforce also excludes models above it
 *  ROUTING_DURABLE_EVIDENCE     1|0   auto-combo reliability/latency evidence reads 7 days with a
 *                                     24 h half-life, and only rows of the request's class family
 *                                     (tools vs chat); see autoCombo/durableEvidence.ts
 */

export const FLAG_CLIENT_ABANDON_NEUTRAL = "ROUTING_CLIENT_ABANDON_NEUTRAL";
export const FLAG_REQUEST_CLASS_WRITE = "ROUTING_REQUEST_CLASS_WRITE";
export const FLAG_CLASS_EVIDENCE = "ROUTING_CLASS_EVIDENCE";
export const FLAG_OUTCOME_QUALITY = "ROUTING_OUTCOME_QUALITY";
export const FLAG_SPREAD_TIEBREAK = "ROUTING_SPREAD_TIEBREAK";
export const FLAG_TIE_BAND = "ROUTING_TIE_BAND";
export const FLAG_LEARNED_CONTEXT_CAP = "ROUTING_LEARNED_CONTEXT_CAP";
export const FLAG_DURABLE_EVIDENCE = "ROUTING_DURABLE_EVIDENCE";

/** Hard ceiling: a mistyped value cannot turn banding into the main behaviour. */
export const MAX_TIE_BAND = 0.02;

export type LearnedContextCapMode = "off" | "learn" | "enforce";

export interface FairSelectionSettings {
  clientAbandonNeutral: boolean;
  requestClassWrite: boolean;
  classEvidence: boolean;
  outcomeQuality: boolean;
  spreadTieBreak: boolean;
  tieBand: number;
  learnedContextCap: LearnedContextCapMode;
  durableEvidence: boolean;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = String(env[name] ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function bounded(env: NodeJS.ProcessEnv, name: string, max: number): number {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, max);
}

export function fairSelectionSettings(env: NodeJS.ProcessEnv = process.env): FairSelectionSettings {
  const cap = String(env[FLAG_LEARNED_CONTEXT_CAP] ?? "")
    .trim()
    .toLowerCase();
  return {
    clientAbandonNeutral: flag(env, FLAG_CLIENT_ABANDON_NEUTRAL),
    requestClassWrite: flag(env, FLAG_REQUEST_CLASS_WRITE),
    classEvidence: flag(env, FLAG_CLASS_EVIDENCE),
    outcomeQuality: flag(env, FLAG_OUTCOME_QUALITY),
    spreadTieBreak: flag(env, FLAG_SPREAD_TIEBREAK),
    tieBand: bounded(env, FLAG_TIE_BAND, MAX_TIE_BAND),
    learnedContextCap: cap === "enforce" ? "enforce" : cap === "learn" ? "learn" : "off",
    durableEvidence: flag(env, FLAG_DURABLE_EVIDENCE),
  };
}
