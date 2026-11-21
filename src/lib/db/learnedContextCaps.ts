import { getDbInstance } from "./core";
import { fairSelectionSettings } from "../../../open-sse/services/autoCombo/fairSelectionSettings";

/**
 * Observed context limits (ROUTING_LEARNED_CONTEXT_CAP).
 *
 * The catalog's context numbers are unverified and can be wrong in either direction (live,
 * 2026-11-21: a catalog model answered 400 "prompt is too long" for a request the catalog said
 * fit). When a provider rejects a request as too long, the size it rejected is a fact about that
 * provider and model, so it is recorded and later requests at or above it are not sent there.
 *
 * One rule for every provider and model; nothing here reads a name except as the key.
 *  - Only a clear "too long for the context" rejection is learned (LEARNABLE_CONTEXT_REJECTION),
 *    narrower than the shared overflow matcher, which also matches output-token validation text.
 *  - Rate, quota and image wording is never learned (NOT_A_CONTEXT_LIMIT), because those limits
 *    are about time or bytes, not the model's context.
 *  - The cap is the limit the provider stated when its message names one (and it is below the
 *    rejected size), else the smallest rejected size. A cap with no stated limit is enforced only
 *    after LEARNED_CAP_MIN_REJECTIONS rejections, so one odd rejection excludes nothing.
 *  - The key is provider, model AND connection (an account tier changes the limit).
 *  - A later success at or above the cap size drops it, so a cap can loosen as well as tighten,
 *    and it expires after LEARNED_CAP_TTL_MS.
 *  - Reads are single primary-key lookups and never throw.
 */

export const LEARNED_CAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A rejection of fewer estimated tokens than this teaches nothing reliable without a stated limit. */
export const LEARNED_CAP_MIN_TOKENS = 2048;

export const LEARNED_CAP_MIN_REJECTIONS = 2;

/** Wording that names a rate, quota, size-in-bytes or image limit: never a context limit. */
export const NOT_A_CONTEXT_LIMIT =
  /per[- ]?(?:minute|min|second|day|hour)|\b(?:tpm|rpm|tpd|rpd)\b|rate[- ]?limit|requests? per|tokens per (?:minute|request|second|day)|per request for your tier|\b(?:image|images|file|attachment|payload)\b[^.\n]{0,40}\b(?:mb|kb|bytes?|size)\b|\b\d+\s?(?:mb|kb)\b|quota/i;

export const LEARNABLE_CONTEXT_REJECTION =
  /\b(?:prompt|input|request|context)\b[^.\n]{0,60}\b(?:too long|too large|exceeds?|exceeded)\b|context[_ ]length[_ ]exceeded|maximum context length|exceeds? the (?:model'?s )?(?:maximum )?context|context window (?:of|is|limit)|too many (?:input )?tokens/i;

const STATED_LIMIT_PATTERNS = [
  /maximum context length is (\d[\d,]*)/i,
  /context (?:length|window) (?:of|is|limit(?: is)?)\s*(\d[\d,]*)/i,
  /limit(?: is| of)?\s*(\d[\d,]*)\s*tokens/i,
  /(\d[\d,]*)\s*token (?:context )?limit/i,
  /(?:tokens?|inputs?)[^.\n]{0,40}must be\s*<=\s*(\d[\d,]*)/i,
];

export function isLearnableContextRejection(status: number, message: string): boolean {
  const text = String(message ?? "");
  if (status !== 400 || NOT_A_CONTEXT_LIMIT.test(text)) return false;
  return LEARNABLE_CONTEXT_REJECTION.test(text) || /must be\s*<=\s*\d/.test(text);
}

/** The limit a provider named in its rejection text, or null. Bounded to sane values. */
export function parseStatedContextLimit(message: string): number | null {
  const text = String(message ?? "").slice(0, 4000);
  for (const pattern of STATED_LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(value) && value >= 1024 && value <= 20_000_000) return value;
  }
  return null;
}

export interface LearnedContextCap {
  provider: string;
  model: string;
  connectionId: string;
  rejectedTokens: number;
  statedLimitTokens: number | null;
  rejections: number;
  updatedAt: string;
}

/** Record a too-long rejection. Does nothing unless the setting is learn or enforce. Never throws. */
export function recordContextRejection(args: {
  provider: string | null | undefined;
  model: string | null | undefined;
  connectionId?: string | null;
  requiredTokens: number;
  status: number;
  message: string;
  now?: number;
}): boolean {
  try {
    if (fairSelectionSettings().learnedContextCap === "off") return false;
    const provider = typeof args.provider === "string" ? args.provider.trim() : "";
    const model = typeof args.model === "string" ? args.model.trim() : "";
    if (!provider || !model) return false;
    if (!isLearnableContextRejection(args.status, args.message)) return false;
    const required = Math.floor(Number(args.requiredTokens));
    const stated = parseStatedContextLimit(args.message);
    if (!Number.isFinite(required) || required <= 0) return false;
    if (stated === null && required < LEARNED_CAP_MIN_TOKENS) return false;
    // A stated limit at or above the rejected size does not explain the rejection: ignore it.
    const statedLimit = stated !== null && stated < required ? stated : null;
    const at = new Date(args.now ?? Date.now()).toISOString();
    getDbInstance()
      .prepare(
        `INSERT INTO learned_context_caps (provider, model, connection_id, rejected_tokens, stated_limit_tokens, rejections, updated_at)
         VALUES (@provider, @model, @connection, @required, @stated, 1, @at)
         ON CONFLICT(provider, model, connection_id) DO UPDATE SET
           rejected_tokens = MIN(rejected_tokens, excluded.rejected_tokens),
           stated_limit_tokens = CASE
             WHEN excluded.stated_limit_tokens IS NOT NULL THEN excluded.stated_limit_tokens
             WHEN excluded.rejected_tokens <= stated_limit_tokens THEN NULL
             ELSE stated_limit_tokens END,
           rejections = rejections + 1,
           updated_at = excluded.updated_at`
      )
      .run({
        provider,
        model,
        connection: args.connectionId ?? "",
        required,
        stated: statedLimit,
        at,
      });
    return true;
  } catch {
    return false;
  }
}

/**
 * A request of `inputTokens` was accepted: a cap at or below that size was wrong, so drop it.
 * Does nothing while the setting is off. Never throws.
 */
export function relaxLearnedCap(args: {
  provider: string | null | undefined;
  model: string | null | undefined;
  connectionId?: string | null;
  inputTokens: number;
}): void {
  try {
    if (fairSelectionSettings().learnedContextCap === "off") return;
    if (!args.provider || !args.model || !(args.inputTokens > 0)) return;
    getDbInstance()
      .prepare(
        `DELETE FROM learned_context_caps
         WHERE provider = @provider AND model = @model AND connection_id = @connection
           AND COALESCE(stated_limit_tokens, rejected_tokens) <= @tokens`
      )
      .run({
        provider: args.provider,
        model: args.model,
        connection: args.connectionId ?? "",
        tokens: Math.floor(args.inputTokens),
      });
  } catch {
    /* never blocks a usage write */
  }
}

/**
 * The live (unexpired) learned cap of a provider, model and connection, or null. A cap recorded
 * with no connection applies to every connection. Never throws.
 */
export function getLearnedContextCap(
  provider: string | null | undefined,
  model: string | null | undefined,
  connectionId?: string | null,
  now = Date.now()
): LearnedContextCap | null {
  try {
    if (!provider || !model) return null;
    const row = getDbInstance()
      .prepare(
        `SELECT provider, model, connection_id, rejected_tokens, stated_limit_tokens, rejections, updated_at
         FROM learned_context_caps
         WHERE provider = ? AND model = ? AND connection_id IN (?, '')
         ORDER BY CASE WHEN connection_id = '' THEN 1 ELSE 0 END
         LIMIT 1`
      )
      .get(provider, model, connectionId ?? "") as
      | {
          provider: string;
          model: string;
          connection_id: string;
          rejected_tokens: number;
          stated_limit_tokens: number | null;
          rejections: number;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    const updated = Date.parse(row.updated_at);
    if (!Number.isFinite(updated) || now - updated > LEARNED_CAP_TTL_MS) return null;
    return {
      provider: row.provider,
      model: row.model,
      connectionId: row.connection_id,
      rejectedTokens: row.rejected_tokens,
      statedLimitTokens: row.stated_limit_tokens,
      rejections: row.rejections,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

/**
 * True when enforcement is on, the cap is established (a stated limit below the rejected size, or
 * LEARNED_CAP_MIN_REJECTIONS rejections) and a request of `requiredTokens` is above what this
 * provider, model and connection are known to reject. False while the setting is not enforce.
 */
export function learnedCapExcludes(
  provider: string | null | undefined,
  model: string | null | undefined,
  requiredTokens: number,
  connectionId?: string | null
): boolean {
  if (fairSelectionSettings().learnedContextCap !== "enforce") return false;
  if (!(requiredTokens > 0)) return false;
  const cap = getLearnedContextCap(provider, model, connectionId);
  if (!cap) return false;
  if (cap.statedLimitTokens !== null) return requiredTokens > cap.statedLimitTokens;
  if (cap.rejections < LEARNED_CAP_MIN_REJECTIONS) return false;
  return requiredTokens >= cap.rejectedTokens;
}
