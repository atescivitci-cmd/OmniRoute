import { CREDENTIAL_REJECTED_ERROR_TYPE } from "@omniroute/open-sse/services/credentialRejectionCooldown.ts";

type JsonRecord = Record<string, unknown>;

const CREDENTIAL_FIELDS = ["apiKey", "accessToken", "refreshToken", "idToken"] as const;
const TERMINAL_STATUSES = new Set(["banned", "expired", "credits_exhausted"]);

/**
 * A credential-rejection cooldown says "this connection's credential is bad". When the stored
 * credential is then replaced with a DIFFERENT value (operator fixes the key, OAuth re-auth), that
 * evidence is stale and must not keep hiding the connection for up to the cooldown cap.
 *
 * Returns the fields to clear, or an empty object when nothing applies. It only ever touches a
 * row whose lastErrorType is credential_rejected and whose status is not terminal, so every other
 * cooldown type and every terminal status is left alone. `existing` must be DECRYPTED so a
 * re-saved identical value is recognised as unchanged.
 */
export function credentialChangeRecoveryPatch(
  existing: JsonRecord,
  incoming: JsonRecord
): JsonRecord {
  if (existing.lastErrorType !== CREDENTIAL_REJECTED_ERROR_TYPE) return {};
  const status =
    typeof existing.testStatus === "string" ? existing.testStatus.trim().toLowerCase() : "";
  if (TERMINAL_STATUSES.has(status)) return {};
  const changed = CREDENTIAL_FIELDS.some((field) => {
    const next = incoming[field];
    return typeof next === "string" && next.length > 0 && next !== existing[field];
  });
  if (!changed) return {};
  return {
    rateLimitedUntil: null,
    lastError: null,
    lastErrorAt: null,
    lastErrorType: null,
    errorCode: null,
    backoffLevel: 0,
    ...(status === "unavailable" ? { testStatus: "active" } : {}),
  };
}
