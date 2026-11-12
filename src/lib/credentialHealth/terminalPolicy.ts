const TERMINAL_CREDENTIAL_STATUSES = new Set(["credits_exhausted", "banned", "expired"]);

export interface CredentialStatusSnapshot {
  testStatus?: string | null;
}

/**
 * Generic background probes establish connectivity, not usable model quota.
 * They must never reactivate a connection parked in a durable terminal state;
 * only an explicit/manual test or an authoritative quota-recovery path may do so.
 */
export function shouldSkipAutomatedCredentialProbe(
  connection: CredentialStatusSnapshot | null | undefined
): boolean {
  const status = String(connection?.testStatus || "")
    .trim()
    .toLowerCase();
  return TERMINAL_CREDENTIAL_STATUSES.has(status);
}

interface AuthRecoverySnapshot extends CredentialStatusSnapshot {
  isActive?: boolean | null;
  rateLimitedUntil?: string | null;
  errorCode?: string | number | null;
  lastErrorType?: string | null;
  lastError?: unknown;
}

/** A verified refresh proves auth recovery only, never model/quota recovery. */
export function canRecoverExpiredAuthAfterRefresh(
  connection: AuthRecoverySnapshot,
  result: {
    valid?: boolean;
    refreshed?: boolean;
    newTokens?: { accessToken?: unknown; expiresIn?: unknown; expiresAt?: unknown } | null;
  },
  nowMs = Date.now()
): boolean {
  const token = result.newTokens;
  const hasLifetime =
    (typeof token?.expiresIn === "number" &&
      Number.isFinite(token.expiresIn) &&
      token.expiresIn > 0) ||
    (typeof token?.expiresAt === "string" && Date.parse(token.expiresAt) > nowMs);
  if (
    !result.valid ||
    !result.refreshed ||
    typeof token?.accessToken !== "string" ||
    !token.accessToken.trim() ||
    !hasLifetime
  )
    return false;
  if (
    connection.testStatus !== "expired" ||
    connection.isActive === false ||
    connection.rateLimitedUntil
  )
    return false;
  const code = String(connection.errorCode ?? "").toLowerCase();
  const type = String(connection.lastErrorType ?? "").toLowerCase();
  if (
    ![
      "",
      "401",
      "expired",
      "token_expired",
      "invalid_token",
      "invalid_grant",
      "refresh_failed",
      "reauth_required",
    ].includes(code)
  )
    return false;
  if (
    ![
      "",
      "token_expired",
      "token_refresh_failed",
      "reauth_required",
      "auth_error",
      "upstream_auth_error",
    ].includes(type)
  )
    return false;
  return !/quota|rate.?limit|usage.?limit|credit|billing|bann|deactivat|permission/i.test(
    String(connection.lastError ?? "")
  );
}
