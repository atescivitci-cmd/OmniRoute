import { isCredentialRejectionText } from "./combo/credentialRejection.ts";

/**
 * Connection-level memory for a credential-rejection 400 (the upstream said the connection's
 * own authorization header is malformed). The failure describes the CONNECTION, so it is
 * recorded through the ordinary connection cooldown (rateLimitedUntil / backoffLevel), never
 * as a provider circuit-breaker failure and never as a terminal status.
 *
 * Schedule: base * 2^level, capped. 30 s, 60 s, 120 s, 240 s, 480 s, then 600 s. The base keeps a
 * dead connection from costing every request an attempt; the cap bounds how long a fixed or
 * re-authorized credential can stay hidden (a passing test or the first success clears it at once).
 */
export const CREDENTIAL_REJECTED_ERROR_TYPE = "credential_rejected";
export const CREDENTIAL_REJECTION_BASE_COOLDOWN_MS = 30_000;
export const CREDENTIAL_REJECTION_MAX_COOLDOWN_MS = 600_000;
// 30 s * 2^5 = 960 s already exceeds the cap, so the level never needs to grow past 5.
export const CREDENTIAL_REJECTION_MAX_LEVEL = 5;

// Stricter than the shared isCredentialRejectionText (which also drives the in-request
// advance and must stay as is): to REMEMBER a failure the phrase has to be what the upstream
// actually said, not something it quoted back. A prompt can make an upstream 400 echo request
// text ("Invalid value ... please Authorization header is badly formatted"), and that must never
// be able to cool the owner's connection. So the phrase must open the upstream message, after the
// provider prefixes seen in real logs ("[400]:", "bad request:").
const ANCHORED_PHRASES: readonly RegExp[] = [
  /^authorization\s+header\s+is\s+(?:badly\s+formatted|malformed|invalid)\b/i,
  /^invalid\s+authorization\s+header\b/i,
  /^malformed\s+authorization\s+header\b/i,
];
const MESSAGE_PREFIX =
  /^\s*(?:\[\d{3}\]|bad\s+request|invalid[_\s]request(?:_error)?|error|http\s*400|400)\s*[:-]?\s*/i;
const MAX_PREFIXES = 4;
const MAX_HEAD_CHARS = 300;

/** The phrase the upstream opened its message with, whitespace-normalised, or null. */
export function matchCredentialRejectionPhrase(upstreamText: unknown): string | null {
  if (!isCredentialRejectionText(upstreamText)) return null;
  let head = String(upstreamText).slice(0, MAX_HEAD_CHARS);
  for (let i = 0; i < MAX_PREFIXES; i++) {
    const stripped = head.replace(MESSAGE_PREFIX, "");
    if (stripped === head) break;
    head = stripped;
  }
  for (const pattern of ANCHORED_PHRASES) {
    const match = pattern.exec(head);
    if (match) return match[0].replace(/\s+/g, " ");
  }
  return null;
}

// Bound on how much request text is scanned for an echo. Only paid after a phrase matched, which
// is rare; a request larger than this is scanned up to the bound (the anchoring above is the
// primary defence, this is the second).
const MAX_ECHO_SCAN_CHARS = 4_000_000;
const MAX_ECHO_SCAN_DEPTH = 24;

/** Whether the phrase appears verbatim (case/whitespace-insensitive) in the request text. */
export function requestBodyContainsPhrase(requestBody: unknown, phrase: string): boolean {
  if (requestBody == null) return false;
  const words = phrase.split(" ").filter(Boolean);
  if (words.length === 0) return false;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(escaped.join("\\s+"), "i");
  let budget = MAX_ECHO_SCAN_CHARS;
  const visit = (value: unknown, depth: number): boolean => {
    if (budget <= 0 || depth > MAX_ECHO_SCAN_DEPTH) return false;
    if (typeof value === "string") {
      const chunk = value.length > budget ? value.slice(0, budget) : value;
      budget -= chunk.length;
      return pattern.test(chunk);
    }
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).some((item) => visit(item, depth + 1));
    }
    return false;
  };
  return visit(requestBody, 0);
}

/**
 * Whether this failure may be remembered as a credential cooldown: a 400 whose upstream message
 * opens with the explicit phrase, and whose phrase is not merely quoted from the request body.
 */
export function isCredentialRejection(
  status: number,
  upstreamText: unknown,
  requestBody?: unknown
): boolean {
  if (status !== 400) return false;
  const phrase = matchCredentialRejectionPhrase(upstreamText);
  if (!phrase) return false;
  return !requestBodyContainsPhrase(requestBody, phrase);
}

// After this long without another rejection the escalation starts over (2x the cap).
const QUIET_RESET_MS = 2 * CREDENTIAL_REJECTION_MAX_COOLDOWN_MS;

/** The level to escalate from: the stored one, or 0 after a long quiet period. */
export function credentialRejectionBaseLevel(
  storedLevel: number,
  previousCooldownEndMs: number,
  nowMs: number
): number {
  return Number.isFinite(previousCooldownEndMs) && nowMs - previousCooldownEndMs > QUIET_RESET_MS
    ? 0
    : storedLevel;
}

export function credentialRejectionCooldown(backoffLevel: number): {
  cooldownMs: number;
  newBackoffLevel: number;
} {
  const level = Number.isFinite(backoffLevel) ? Math.max(0, Math.floor(backoffLevel)) : 0;
  const bounded = Math.min(level, CREDENTIAL_REJECTION_MAX_LEVEL);
  return {
    cooldownMs: Math.min(
      CREDENTIAL_REJECTION_BASE_COOLDOWN_MS * 2 ** bounded,
      CREDENTIAL_REJECTION_MAX_COOLDOWN_MS
    ),
    newBackoffLevel: Math.min(level + 1, CREDENTIAL_REJECTION_MAX_LEVEL),
  };
}

/** Warning text for an applied credential cooldown: ids and numbers only, never upstream text. */
export function describeCredentialCooldown(
  provider: string | null,
  connectionId: string,
  level: number,
  cooldownMs: number
): string {
  return `credential cooldown ${provider ?? "unknown"} ${connectionId.slice(0, 8)} level=${level} cooldown=${Math.ceil(cooldownMs / 1000)}s — check this connection's credential or gateway-built header`;
}
