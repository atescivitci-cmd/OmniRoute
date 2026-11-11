// ── CLAUDE_SESSION_AFFINITY_V2 — PRODUCTION DELIVERY ADAPTER (2026-08-30) ───────────────
// Codex audit 3, Blocker 1. The outbox requires an AWAITABLE delivery function that
// REJECTS on failure. The existing dispatchEvent() cannot serve: it uses
// Promise.allSettled() and returns void even when every destination failed
// (webhookDispatcher.ts). Passing it in would silently reintroduce the fire-and-forget
// defect the outbox exists to fix.
//
// This adapter closes the loop the audit found missing:
//     fork_id -> getForkById -> buildModelSwitchNotification -> confirmed delivery
import { getForkById, type DbLike } from "./db/providerSwitchForks.ts";
import { buildModelSwitchNotification } from "@omniroute/open-sse/services/providerSwitchNotifier.ts";
import { dispatchEventConfirmed } from "./webhookDispatcher";

/**
 * Build the production DeliverFn for the provider-switch outbox.
 *
 * Rejects when the fork is missing, when the payload cannot be built (e.g. the fork is
 * not COMMITTED), or when any intended destination failed to confirm. Rejection is what
 * returns the outbox row to a retryable state, so failures are retried rather than lost.
 */
export function createProviderSwitchDeliverFn(db: DbLike): (forkId: string) => Promise<void> {
  return async (forkId: string): Promise<void> => {
    const record = getForkById(db, forkId);
    if (!record) throw new Error(`missing provider-switch fork: ${forkId}`);

    const payload = buildModelSwitchNotification(record);
    // Real event type, no `as never`. The escape hatch previously hid that
    // "model.switched" is not in the production contract, so nothing could subscribe.
    const result = await dispatchEventConfirmed(
      "combo.switched",
      payload as unknown as Record<string, unknown>
    );

    // Zero destinations is NOT success. dispatchEventConfirmed returns
    // {allDelivered:true, attempted:0} when no webhook matches, which previously marked
    // the outbox row DELIVERED while nobody was notified. Reject so the row stays
    // retryable and the ledger never claims a delivery that did not happen.
    if (result.attempted === 0) {
      throw new Error("no model-switch notification destination is configured");
    }
    if (!result.allDelivered || result.delivered !== result.attempted) {
      throw new Error(result.errors.join("; ") || "model-switch notification was not confirmed");
    }
  };
}
