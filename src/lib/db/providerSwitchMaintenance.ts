// ── CLAUDE_SESSION_AFFINITY_V2 — LIFECYCLE / MAINTENANCE (2026-08-30) ───────────────────
// Codex audit 2, Blockers 2 and 3.
//
// Blocker 3: reconcileStalePreparedForks passed its own tests but NO production code
// called it, so orphaned PREPARED forks were never actually reconciled. This module is
// the production caller: startProviderSwitchMaintenance() is the single lifecycle entry
// point, invoked once at OmniRoute startup (see combo.ts.integration.patch.md §5 for the
// exact call site), and it owns both periodic jobs -- stale-fork reconciliation and the
// notification outbox worker.
//
// Blocker 2: commitForkAndEnqueueNotification performs the fork COMMIT and the outbox
// enqueue in ONE transaction, so a committed switch can never exist without its pending
// notification, and no notification can exist for a switch that did not commit.
//
// NOTHING here runs on the request path. The maintenance loop is a background timer; the
// user's terminal response is never gated, delayed, or interrupted by it.
import {
  markForkCommitted,
  reconcileStalePreparedForks,
  type DbLike,
} from "./providerSwitchForks.ts";
import { enqueueNotification, runOutboxOnce, type DeliverFn } from "./providerSwitchOutbox.ts";

export interface MaintenanceOptions {
  /** How often the maintenance tick runs. */
  intervalMs: number;
  /** A PREPARED fork older than this with no terminal state is considered orphaned. */
  staleForkAfterMs: number;
  /** How long a worker's claim on an outbox row is valid before another may steal it. */
  outboxLeaseMs: number;
  /** First retry delay after a failed delivery; doubles per attempt. */
  outboxBaseBackoffMs: number;
  /** Max outbox rows processed per tick, so one tick cannot run unbounded. */
  outboxMaxRowsPerTick: number;
}

export const DEFAULT_MAINTENANCE_OPTIONS: MaintenanceOptions = {
  intervalMs: 60_000,
  staleForkAfterMs: 10 * 60_000,
  outboxLeaseMs: 2 * 60_000,
  outboxBaseBackoffMs: 5_000,
  outboxMaxRowsPerTick: 50,
};

/**
 * Commit a fork AND enqueue its notification atomically (Blocker 2).
 *
 * Returns true iff this call performed the commit. The outbox row is created inside the
 * same transaction, so the two can never diverge. If the fork was not in PREPARED state
 * (a duplicate call, a retry), nothing is committed and nothing is enqueued.
 *
 * Requires db.exec for transaction control; without it the two writes could not be made
 * atomic, so this throws rather than silently degrading to the non-atomic behaviour that
 * caused the original defect.
 */
export function commitForkAndEnqueueNotification(
  db: DbLike,
  forkId: string,
  nowIso: string
): boolean {
  if (typeof db.exec !== "function") {
    throw new Error(
      "commitForkAndEnqueueNotification requires a db with exec() for transaction control"
    );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const committed = markForkCommitted(db, forkId, nowIso);
    if (!committed) {
      db.exec("ROLLBACK");
      return false;
    }
    enqueueNotification(db, forkId, nowIso);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // a rollback failure must not mask the original error
    }
    throw err;
  }
}

export interface MaintenanceTickResult {
  reconciledForks: number;
  outbox: { delivered: number; failed: number; claimed: number };
}

/**
 * One maintenance pass. Exported separately from the timer so it can be tested directly
 * AND driven by the real lifecycle -- the timer below is a thin wrapper around it.
 *
 * Errors are contained per-job: a reconciliation failure must not prevent the outbox
 * from draining, and vice versa.
 */
export async function runMaintenanceTick(
  db: DbLike,
  deliver: DeliverFn,
  opts: MaintenanceOptions,
  now: () => string,
  onError?: (job: string, err: unknown) => void
): Promise<MaintenanceTickResult> {
  let reconciledForks = 0;
  try {
    reconciledForks = reconcileStalePreparedForks(db, now(), opts.staleForkAfterMs);
  } catch (err) {
    onError?.("reconcileStalePreparedForks", err);
  }

  let outbox = { delivered: 0, failed: 0, claimed: 0 };
  try {
    outbox = await runOutboxOnce(db, deliver, {
      now,
      leaseMs: opts.outboxLeaseMs,
      baseBackoffMs: opts.outboxBaseBackoffMs,
      maxRows: opts.outboxMaxRowsPerTick,
    });
  } catch (err) {
    onError?.("runOutboxOnce", err);
  }

  return { reconciledForks, outbox };
}

export interface MaintenanceHandle {
  /**
   * Resolves when the AUTOMATIC startup tick has completed. Added 2026-08-30 after
   * Codex's third audit proved the previously-documented "immediate startup tick" did
   * not exist: schedule() only installed a timer, and the tests manufactured the
   * behaviour by calling runNow() themselves. Await this -- never runNow() -- to assert
   * startup behaviour.
   */
  started: Promise<MaintenanceTickResult>;
  /** Stop the loop and wait for an in-flight tick to finish. Idempotent. */
  stop: () => Promise<void>;
  /** Run one tick on demand (operational/manual use, NOT a stand-in for startup). */
  runNow: () => Promise<MaintenanceTickResult>;
}

/**
 * THE PRODUCTION LIFECYCLE ENTRY POINT for reconciliation and outbox delivery.
 *
 * Call once during OmniRoute startup. Genuinely runs an immediate tick itself (see
 * `started`) so a crash's orphaned forks are reconciled at boot rather than one
 * interval later, then schedules subsequent ticks.
 *
 * Concurrency: `running` guards against overlapping ticks within this process; the
 * outbox's own lease/WHERE-clause guards protect against multiple processes. The timer
 * is unref'd so it never keeps the process alive on shutdown.
 */
export function startProviderSwitchMaintenance(
  db: DbLike,
  deliver: DeliverFn,
  opts: MaintenanceOptions = DEFAULT_MAINTENANCE_OPTIONS,
  now: () => string = () => new Date().toISOString(),
  onError?: (job: string, err: unknown) => void
): MaintenanceHandle {
  let stopped = false;
  let running: Promise<MaintenanceTickResult> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<MaintenanceTickResult> => {
    if (running) return running; // never overlap ticks in this process
    running = runMaintenanceTick(db, deliver, opts, now, onError);
    try {
      return await running;
    } finally {
      running = null;
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await tick();
      } catch (err) {
        onError?.("maintenanceTick", err);
      }
      schedule();
    }, opts.intervalMs);
    // never hold the process open purely for maintenance
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  // Real automatic startup tick. Its failure must never prevent the periodic loop from
  // being scheduled, so it is caught here and surfaced via onError.
  const started: Promise<MaintenanceTickResult> = tick().catch((err) => {
    onError?.("maintenanceStartupTick", err);
    return { reconciledForks: 0, outbox: { delivered: 0, failed: 0, claimed: 0 } };
  });

  schedule();

  return {
    started,
    runNow: tick,
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        await started;
      } catch {
        // shutdown must not throw on the startup tick's failure
      }
      if (running) {
        try {
          await running;
        } catch {
          // shutdown must not throw on an in-flight tick's failure
        }
      }
    },
  };
}
