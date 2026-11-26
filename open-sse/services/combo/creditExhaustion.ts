/**
 * An upstream that says the account is out of credit BEFORE producing any output (for example
 * HTTP 400 "Your credit balance is too low", HTTP 402, insufficient_quota) refused the request at
 * admission: nothing was generated and no tool ran. That is the same class as the 429 admission
 * refusal (TOOL_RATE_LIMIT_FAILOVER_V1), so routing may move on to another target with the same
 * payload.
 *
 * Deliberately a small explicit list, copied (as regexes) from the unambiguous entries of
 * CREDITS_EXHAUSTED_SIGNALS in accountFallback.ts. accountFallback is not imported here: it pulls
 * heavy modules into combo routing, and the phrases below are intentionally narrower than a
 * plain substring list. Anything that is not unambiguous (ordinary "invalid request", schema,
 * context-length, rate-limit, OAuth wording, text that merely contains "credit" in another
 * sense such as "credentials" or "credit card") must keep failing closed. No provider or model
 * names. The bare phrase "payment required" is NOT included: it is only meaningful together with
 * HTTP 402, which the status check in routingAttemptSafety.ts already handles.
 */
const CREDIT_EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /\byou(?:'|’)ve reached your additional usage limit for your plan\b/i,
  /\bcredit[ _]balance[ _](?:is[ _])?too[ _]low\b/i,
  /\binsufficient[ _]quota\b/i,
  /\bexceeded[ ]your[ ]current(?:[ ]usage)?[ ]quota\b/i,
  /\binsufficient[ _](?:account[ _])?balance\b/i,
  /\bbilling[ _]hard[ _]limit[ _](?:has[ _]been[ _])?reached\b/i,
  /\binsufficient[ _]credits?\b/i,
  /\bout[ ]of[ ]credits\b/i,
  /\bcredits[ ]exhausted\b/i,
  /\bfree[ ]tier[ ]of[ ]the[ ]model[ ]has[ ]been[ ]exhausted\b/i,
];

const MAX_SCANNED_CHARS = 2000;

export function isCreditExhaustionText(text: unknown): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  return CREDIT_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(scanned));
}

/**
 * Shared decision for "this upstream error is a credit-exhaustion admission refusal", used by
 * both the routing attempt guard and the context-pin fall-through. `value` is the parsed JSON
 * error body as the router sees it.
 *
 * Only HTTP 400 and 402 qualify. True when the error message or error.code carries credit
 * text, or for 402 when error.code is "payment_required": chatCore rewrites EVERY upstream 402
 * (empty body, text/plain, JSON with any message) into that canonical envelope, and a 402
 * Payment Required is itself a refusal at admission, before any generation. A 402 whose code is
 * anything else (for example a local gateway budget code) is not matched.
 */
export function isCreditExhaustionError(status: number, value: unknown): boolean {
  if (status !== 400 && status !== 402) return false;
  const err = (value as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  const message = err?.message;
  const code = err?.code;
  if (isCreditExhaustionText(message) || isCreditExhaustionText(code)) return true;
  return status === 402 && code === "payment_required";
}
