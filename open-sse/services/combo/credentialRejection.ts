/**
 * A 400 whose upstream text says the TARGET's own credential / authorization header is
 * malformed describes the connection, not the request: the upstream refused it at the auth
 * layer, before any processing. Routing may therefore move on to another target.
 *
 * Deliberately a small explicit list. Anything that is not unambiguous about the
 * authorization header itself (ordinary "invalid request", schema, context-length errors,
 * OAuth "authorization code" wording) must keep failing closed. No provider or model names.
 */
const CREDENTIAL_REJECTION_PATTERNS: readonly RegExp[] = [
  /\bauthorization\s+header\s+is\s+(?:badly\s+formatted|malformed|invalid)\b/i,
  /\binvalid\s+authorization\s+header\b/i,
  /\bmalformed\s+authorization\s+header\b/i,
];

const MAX_SCANNED_CHARS = 2000;

export function isCredentialRejectionText(text: unknown): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  return CREDENTIAL_REJECTION_PATTERNS.some((pattern) => pattern.test(scanned));
}
