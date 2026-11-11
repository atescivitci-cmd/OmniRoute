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
