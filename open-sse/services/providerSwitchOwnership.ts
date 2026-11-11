// ── CLAUDE_SESSION_AFFINITY_V2 — CENTRALIZED FORK OWNERSHIP (2026-08-30) ────────────────
// Codex audit 2, Blocker 4.
//
// The previous design scattered rollbackFork calls across hand-enumerated terminal
// branches. That was the defect, not the count: I claimed six terminal exits, Codex found
// at least four more (combo.ts:1075-1077 client disconnect during retry delay, :1519-1534
// upstream 499, :1576-1592 input-bound failure, :1661-1702 body-specific 400), and the
// dispatch itself can throw. Any future branch added to a ~1600-line function would silently
// leak a PREPARED fork again.
//
// This module removes the enumeration entirely. `runWithProviderSwitchFork` owns the fork
// across the dispatch: every terminal outcome -- accepted success, rejected success
// (quality), any non-ok result, a thrown error, an abort/cancellation, or a timeout --
// resolves the fork to COMMITTED or ROLLED_BACK exactly once, enforced in `finally`.
// A caller CANNOT return from the dispatch region with the fork still PREPARED.
//
// Notification is fire-and-forget-free: commit enqueues a durable outbox row inside the
// commit transaction (providerSwitchMaintenance.commitForkAndEnqueueNotification); actual
// delivery is the background worker's job. Nothing here awaits delivery, so the user's
// terminal response is never gated.
import type { ProviderSwitchForkRecord } from "../../src/lib/db/providerSwitchForkTypes.ts";

export type ForkOutcome = { kind: "COMMITTED" } | { kind: "ROLLED_BACK"; errorCode: string };

/** Persistence seam. The real wiring passes the DB-backed implementations. */
export interface ForkOwnershipStore {
  /** Persist PREPARED. Called once, before dispatch. */
  persistPrepared: (record: ProviderSwitchForkRecord) => void;
  /** PREPARED -> COMMITTED, plus the durable notification enqueue, in ONE transaction. */
  commit: (forkId: string, nowIso: string) => boolean;
  /** PREPARED -> ROLLED_BACK. */
  rollback: (forkId: string, nowIso: string, errorCode: string) => boolean;
}

export interface RunWithForkArgs<TResult> {
  /**
   * The PREPARED fork and the body to dispatch. Null means no provider switch is
   * happening on this attempt -- `dispatch` still runs, untouched, and no fork
   * bookkeeping occurs at all. This keeps the non-switch path (the overwhelming
   * majority of requests) completely free of fork logic.
   */
  fork: { record: ProviderSwitchForkRecord } | null;
  store: ForkOwnershipStore;
  now: () => string;
  /** The real dispatch. Whatever it returns or throws is passed through untouched. */
  dispatch: () => Promise<TResult>;
  /**
   * Classify a dispatch RESULT as an accepted success or a rejection. This is what makes
   * quality-rejected 200s, 499s, input-bound failures and body-specific 400s roll back
   * without needing a branch per case: they are all just "not accepted".
   */
  classify: (result: TResult) => ForkOutcome;
  /** Map a thrown error to an error code. Defaults to the error's name/message. */
  classifyError?: (err: unknown) => string;
  /** Optional: report a bookkeeping failure without disturbing the dispatch result. */
  onBookkeepingError?: (stage: string, err: unknown) => void;
}

function defaultErrorCode(err: unknown): string {
  if (err instanceof Error) {
    // AbortError / TimeoutError carry meaningful names; prefer them over a message.
    if (err.name && err.name !== "Error") return err.name.toUpperCase();
    return err.message.slice(0, 200) || "UNKNOWN_ERROR";
  }
  return String(err).slice(0, 200) || "UNKNOWN_ERROR";
}

/**
 * Own a provider-switch fork across a dispatch.
 *
 * Guarantees, all enforced structurally rather than by branch enumeration:
 *   1. If `fork` is non-null, PREPARED is persisted before `dispatch` is invoked.
 *   2. Exactly one of commit/rollback is attempted, exactly once.
 *   3. `finally` asserts resolution: if neither ran (an impossible control path, a
 *      classify() that itself threw), the fork is rolled back as UNRESOLVED rather than
 *      left PREPARED.
 *   4. Bookkeeping NEVER changes what the caller sees. A DB failure while committing or
 *      rolling back is reported via onBookkeepingError and swallowed; the dispatch's own
 *      result or exception propagates unchanged. A notification concern must never break
 *      a user's request.
 */
export async function runWithProviderSwitchFork<TResult>(
  args: RunWithForkArgs<TResult>
): Promise<TResult> {
  const { fork, store, now, dispatch, classify } = args;
  const errorCodeOf = args.classifyError ?? defaultErrorCode;

  if (!fork) {
    // No provider switch on this attempt: nothing to own.
    return dispatch();
  }

  try {
    store.persistPrepared(fork.record);
  } catch (err) {
    // If we cannot even record the fork, do NOT fail the user's request over it --
    // dispatch normally and skip bookkeeping entirely.
    args.onBookkeepingError?.("persistPrepared", err);
    return dispatch();
  }

  let resolved = false;
  const resolve = (outcome: ForkOutcome): void => {
    if (resolved) return;
    resolved = true;
    try {
      if (outcome.kind === "COMMITTED") {
        store.commit(fork.record.id, now());
      } else {
        store.rollback(fork.record.id, now(), outcome.errorCode);
      }
    } catch (err) {
      args.onBookkeepingError?.(outcome.kind === "COMMITTED" ? "commit" : "rollback", err);
    }
  };

  try {
    const result = await dispatch();
    let outcome: ForkOutcome;
    try {
      outcome = classify(result);
    } catch (err) {
      // A classifier that throws must not leave the fork PREPARED, and must not
      // change what the caller receives.
      args.onBookkeepingError?.("classify", err);
      outcome = { kind: "ROLLED_BACK", errorCode: "CLASSIFY_FAILED" };
    }
    resolve(outcome);
    return result;
  } catch (err) {
    // Covers thrown dispatch errors, aborts, cancellations and timeouts alike.
    resolve({ kind: "ROLLED_BACK", errorCode: errorCodeOf(err) });
    throw err;
  } finally {
    // Backstop: no control path may exit this function with the fork still PREPARED.
    resolve({ kind: "ROLLED_BACK", errorCode: "UNRESOLVED" });
  }
}

/**
 * Variant for the real combo.ts shape (2026-08-30).
 *
 * In `executeTarget`, the decision to switch providers is made INSIDE the retry loop --
 * the fork does not exist when the attempt begins, and PREPARED must be persisted at the
 * moment the switch is decided (before that attempt's dispatch), not before the whole
 * target's work. So the caller persists PREPARED itself and hands us a box; our job is
 * the guarantee: whatever fork ends up in that box is resolved exactly once, no matter
 * how `run` exits.
 *
 * This wraps `executeTarget`'s ENTIRE body, so every one of its terminal exits -- the ten
 * known returns, any throw, abort, or timeout, and any branch added in future -- is
 * covered structurally rather than by enumeration.
 */
export interface ForkBox {
  /** Set by the caller at the moment PREPARED is persisted; null if no switch occurred. */
  fork: ProviderSwitchForkRecord | null;
}

export async function withGuaranteedForkResolution<TResult>(args: {
  box: ForkBox;
  store: Pick<ForkOwnershipStore, "commit" | "rollback">;
  now: () => string;
  run: () => Promise<TResult>;
  classify: (result: TResult) => ForkOutcome;
  classifyError?: (err: unknown) => string;
  onBookkeepingError?: (stage: string, err: unknown) => void;
}): Promise<TResult> {
  const errorCodeOf = args.classifyError ?? defaultErrorCode;
  let resolved = false;

  const resolve = (outcome: ForkOutcome): void => {
    const record = args.box.fork;
    if (!record || resolved) return; // no switch happened, or already resolved
    resolved = true;
    try {
      if (outcome.kind === "COMMITTED") args.store.commit(record.id, args.now());
      else args.store.rollback(record.id, args.now(), outcome.errorCode);
    } catch (err) {
      args.onBookkeepingError?.(outcome.kind === "COMMITTED" ? "commit" : "rollback", err);
    }
  };

  try {
    const result = await args.run();
    let outcome: ForkOutcome;
    try {
      outcome = args.classify(result);
    } catch (err) {
      args.onBookkeepingError?.("classify", err);
      outcome = { kind: "ROLLED_BACK", errorCode: "CLASSIFY_FAILED" };
    }
    resolve(outcome);
    return result;
  } catch (err) {
    resolve({ kind: "ROLLED_BACK", errorCode: errorCodeOf(err) });
    throw err;
  } finally {
    // Structural backstop -- see the equivalent-mutant note in the test file.
    resolve({ kind: "ROLLED_BACK", errorCode: "UNRESOLVED" });
  }
}
