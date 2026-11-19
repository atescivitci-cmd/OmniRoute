import { configuredAccountProviderAllowed } from "./hostedTrialUsage.ts";
import type { ZeroCostRequest } from "./zeroCostAdmission.ts";
/** Explicit operator policy permits normal account usage, not a zero-dollar guarantee.
 * Authentication, quota, budget, capabilities and ranking remain authoritative. */
export function projectConfiguredAccountAdmission(
  request: ZeroCostRequest,
  row: { id: string; provider: string; is_active: number } | undefined
): boolean {
  return (
    configuredAccountProviderAllowed(request.provider) &&
    !!row &&
    row.is_active === 1 &&
    row.id === request.connectionId &&
    row.provider === request.provider &&
    !!request.model
  );
}
export async function hasConfiguredAccountAdmission(request: ZeroCostRequest): Promise<boolean> {
  if (
    !configuredAccountProviderAllowed(request.provider) ||
    !request.connectionId ||
    !request.model
  )
    return false;
  try {
    const { getActiveCostAdmissionAccount } = await import("../../../src/lib/db/providers.ts");
    return projectConfiguredAccountAdmission(
      request,
      getActiveCostAdmissionAccount(request.connectionId, request.provider)
    );
  } catch {
    return false;
  }
}
