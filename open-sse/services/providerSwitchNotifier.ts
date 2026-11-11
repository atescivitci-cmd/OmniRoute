// ── CLAUDE_SESSION_AFFINITY_V2 (2026-08-29, notifier fix 2026-08-30) — CHANGE 7 ────────
// Non-blocking model-switch notification. This module now contains ONLY the pure
// payload builder:
//
//   buildModelSwitchNotification -- pure, deterministic: fork record -> payload.
//      No I/O, no timing, fully unit-testable.
//
// REMOVED 2026-08-30 (Codex audit Blocker 6): createExactlyOnceNotifier, an in-memory
// Set-based guard, used to live here. Codex correctly reproduced that it (a) forgets
// all state on process restart, permitting a second notification for a fork that had
// already been notified before the restart, and (b) marked a fork "notified" BEFORE
// `emit` completed, so a thrown emit suppressed all future retries even though nothing
// was actually delivered. That is process-local at-most-once invocation, not
// exactly-once delivery, and calling it "exactly once" was wrong.
//
// The durable replacement is `markForkNotifiedIfNotAlready` in
// ../../src/lib/db/providerSwitchForks.ts: it claims the notification via
// `UPDATE provider_switch_forks SET notified_at = ? WHERE id = ? AND notified_at IS
// NULL`, in the SAME durable table Change 3 already persists PREPARED/COMMITTED/
// ROLLED_BACK state to -- the claim survives a process restart because it lives in the
// row, not in process memory (see providerSwitchForks.db.test.ts's explicit
// process-restart simulation). The real combo.ts call site (see
// combo.ts.integration.patch.md section 2) is:
//
//   if (markForkCommitted(db, switchFork.record.id, committedAt)) {
//     if (markForkNotifiedIfNotAlready(db, switchFork.record.id, committedAt)) {
//       notifyWebhookEvent("model.switched", buildModelSwitchNotification(record));
//     }
//   }
//
// fire-and-forget, NOT awaited -- non-blocking by construction, no confirmation gate.
import type { ProviderSwitchForkRecord } from "./providerSwitchFork.ts";

export interface ModelSwitchNotificationPayload {
  // "combo.switched" is the REAL event in the production contract
  // (src/lib/webhooks/eventDescriptions.ts). "model.switched" does not exist -- I had
  // suppressed the resulting type error with `as never`, which hid the fact that no
  // subscriber could ever match. Codex audit 4, Blocker 2.
  event: "combo.switched";
  sessionId: string;
  comboName: string;
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  forkId: string;
  committedAt: string;
}

/**
 * buildModelSwitchNotification -- pure function, no I/O. Only ever called for a
 * COMMITTED fork (a switch that actually happened); throws for any other state so
 * a caller cannot accidentally notify about a PREPARED-but-not-yet-succeeded or a
 * ROLLED_BACK switch as if it were real.
 */
export function buildModelSwitchNotification(
  record: ProviderSwitchForkRecord
): ModelSwitchNotificationPayload {
  if (record.state !== "COMMITTED" || !record.committedAt) {
    throw new Error(
      `buildModelSwitchNotification: fork ${record.id} is ${record.state}, not COMMITTED -- refusing to notify about a switch that did not happen`
    );
  }
  return {
    event: "combo.switched",
    sessionId: record.sessionId,
    comboName: record.comboName,
    fromProvider: record.sourceProvider,
    fromModel: record.sourceModel,
    toProvider: record.targetProvider,
    toModel: record.targetModel,
    forkId: record.id,
    committedAt: record.committedAt,
  };
}
