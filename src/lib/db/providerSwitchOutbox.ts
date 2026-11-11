// ── CLAUDE_SESSION_AFFINITY_V2 — DURABLE NOTIFICATION OUTBOX (2026-08-30) ───────────────
// Codex audit 2, Blocker 2. The previous design wrote notified_at BEFORE delivery and
// then called the real fire-and-forget notifyWebhookEvent, which swallows async failures
// -- a crash or rejection after that write permanently lost the notification while the
// DB recorded it as sent.
//
// This is the real outbox: PENDING -> CLAIMED (leased) -> DELIVERED, with attempts,
// backoff, lease expiry, and last_error. Delivery is AWAITED, and DELIVERED is written
// only after the dispatch resolves successfully.
//
// GUARANTEE, stated honestly: at-least-once delivery, deduplicated by fork_id as the
// idempotency key. This is NOT end-to-end exactly-once -- that additionally requires the
// receiver to dedupe on fork_id, which is outside this module's control and is not
// claimed.
//
// NOTIFICATION-ONLY: nothing here may gate, delay, or interrupt the user's terminal
// response. The worker runs on its own schedule (see providerSwitchMaintenance.ts),
// never on the request path.
import { randomUUID } from "node:crypto";
import type { DbLike } from "./providerSwitchForks.ts";

export interface OutboxRow {
  forkId: string;
  /** Owner token for THIS claim. Required to complete or fail the row. */
  claimToken: string | null;
  state: "PENDING" | "CLAIMED" | "DELIVERED";
  attempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  claimedAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
}

interface RawOutboxRow {
  fork_id: string;
  state: string;
  attempts: number;
  next_attempt_at: string;
  lease_until: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
}

function toRow(r: RawOutboxRow): OutboxRow {
  return {
    forkId: r.fork_id,
    claimToken: r.claim_token,
    state: r.state as OutboxRow["state"],
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    leaseUntil: r.lease_until,
    claimedAt: r.claimed_at,
    deliveredAt: r.delivered_at,
    lastError: r.last_error,
  };
}

/**
 * Enqueue a pending notification. MUST be called in the SAME transaction that moves the
 * fork to COMMITTED (see providerSwitchMaintenance.commitForkAndEnqueueNotification), so
 * a committed switch can never exist without its outbox row, and an outbox row can never
 * exist for a switch that did not commit.
 *
 * `INSERT OR IGNORE` on the fork_id primary key makes this idempotent: a duplicate
 * commit attempt cannot create a second notification for the same switch.
 */
export function enqueueNotification(db: DbLike, forkId: string, nowIso: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO provider_switch_outbox (fork_id, state, attempts, next_attempt_at)
     VALUES (?, 'PENDING', 0, ?)`
  ).run(forkId, nowIso);
}

/**
 * Atomically claim ONE eligible row with a lease, and return it.
 *
 * Eligible means: the fork is COMMITTED (Codex's explicit requirement -- a PREPARED or
 * ROLLED_BACK switch must never notify), the row is not already DELIVERED, its
 * next_attempt_at is due, AND it is either PENDING or a CLAIMED row whose lease has
 * expired (i.e. its worker died mid-delivery).
 *
 * The UPDATE's WHERE clause carries every one of those conditions, so two workers racing
 * for the same row cannot both win -- SQLite serializes the writes and the loser's
 * UPDATE matches zero rows.
 */
export function claimNextNotification(
  db: DbLike,
  nowIso: string,
  leaseMs: number
): OutboxRow | null {
  const leaseUntil = new Date(new Date(nowIso).getTime() + leaseMs).toISOString();
  const claimToken = randomUUID();
  const candidate = db
    .prepare<RawOutboxRow>(
      `SELECT o.* FROM provider_switch_outbox o
       JOIN provider_switch_forks f ON f.id = o.fork_id
       WHERE f.state = 'COMMITTED'
         AND o.state != 'DELIVERED'
         AND o.next_attempt_at <= ?
         AND (o.state = 'PENDING' OR (o.state = 'CLAIMED' AND o.lease_until <= ?))
       ORDER BY o.next_attempt_at ASC
       LIMIT 1`
    )
    .get(nowIso, nowIso);
  if (!candidate) return null;

  const claimed = db
    .prepare(
      `UPDATE provider_switch_outbox
       SET state = 'CLAIMED', claim_token = ?, claimed_at = ?, lease_until = ?, attempts = attempts + 1
       WHERE fork_id = ?
         AND state != 'DELIVERED'
         AND next_attempt_at <= ?
         AND (state = 'PENDING' OR (state = 'CLAIMED' AND lease_until <= ?))`
    )
    .run(claimToken, nowIso, leaseUntil, candidate.fork_id, nowIso, nowIso);
  if (Number(claimed.changes) !== 1) return null; // lost the race to another worker

  const row = db
    .prepare<RawOutboxRow>(`SELECT * FROM provider_switch_outbox WHERE fork_id = ?`)
    .get(candidate.fork_id)!;
  return toRow(row);
}

/**
 * Delivery confirmed. Requires the caller to still OWN the current claim.
 *
 * Codex audit 3, Blocker 2: checking only `state = 'CLAIMED'` let a worker whose lease
 * had expired complete or fail a row a DIFFERENT worker had since reclaimed, corrupting
 * the live lease. The claim token closes that: a stale worker's UPDATE matches no rows.
 * Returns false when ownership was lost -- the caller must treat that as superseded,
 * never as success.
 */
export function markDelivered(
  db: DbLike,
  forkId: string,
  nowIso: string,
  claimToken: string
): boolean {
  const r = db
    .prepare(
      `UPDATE provider_switch_outbox
       SET state = 'DELIVERED', delivered_at = ?, lease_until = NULL, claim_token = NULL, last_error = NULL
       WHERE fork_id = ? AND state = 'CLAIMED' AND claim_token = ?`
    )
    .run(nowIso, forkId, claimToken);
  return Number(r.changes) === 1;
}

/**
 * Delivery failed. Return the row to PENDING with exponential backoff so it is retried,
 * rather than losing the event. Only a CLAIMED row may be released this way.
 */
export function markDeliveryFailed(
  db: DbLike,
  forkId: string,
  nowIso: string,
  error: string,
  baseBackoffMs: number,
  claimToken: string
): boolean {
  const current = db
    .prepare<{ attempts: number }>(`SELECT attempts FROM provider_switch_outbox WHERE fork_id = ?`)
    .get(forkId);
  const attempts = current?.attempts ?? 1;
  // exponential, capped so a permanently-failing endpoint does not schedule absurdly far out
  const backoff = Math.min(baseBackoffMs * Math.pow(2, Math.max(0, attempts - 1)), 60 * 60 * 1000);
  const nextAttemptAt = new Date(new Date(nowIso).getTime() + backoff).toISOString();
  const r = db
    .prepare(
      `UPDATE provider_switch_outbox
       SET state = 'PENDING', claim_token = NULL, lease_until = NULL, next_attempt_at = ?, last_error = ?
       WHERE fork_id = ? AND state = 'CLAIMED' AND claim_token = ?`
    )
    .run(nextAttemptAt, error.slice(0, 2000), forkId, claimToken);
  return Number(r.changes) === 1;
}

export function getOutboxRow(db: DbLike, forkId: string): OutboxRow | null {
  const r = db
    .prepare<RawOutboxRow>(`SELECT * FROM provider_switch_outbox WHERE fork_id = ?`)
    .get(forkId);
  return r ? toRow(r) : null;
}

export type DeliverFn = (forkId: string) => Promise<void>;

/**
 * Process up to `maxRows` eligible notifications. Returns counts.
 *
 * `deliver` MUST be awaitable and MUST reject on failure -- passing the real
 * fire-and-forget notifyWebhookEvent directly would reintroduce exactly the bug this
 * module exists to fix. Use the package's awaitable dispatch (dispatchEvent) or a
 * wrapper that genuinely resolves only on confirmed dispatch.
 *
 * Never called from the request path.
 */
export async function runOutboxOnce(
  db: DbLike,
  deliver: DeliverFn,
  opts: {
    now: () => string;
    leaseMs: number;
    baseBackoffMs: number;
    maxRows: number;
  }
): Promise<{ delivered: number; failed: number; claimed: number; superseded: number }> {
  let delivered = 0;
  let failed = 0;
  let claimed = 0;
  let superseded = 0;

  for (let i = 0; i < opts.maxRows; i++) {
    const row = claimNextNotification(db, opts.now(), opts.leaseMs);
    if (!row) break;
    claimed++;
    const token = row.claimToken!;
    try {
      await deliver(row.forkId);
      // Ownership may have been lost while the delivery was in flight (lease expiry).
      // That is NOT a success -- record it as superseded rather than claiming delivery.
      if (markDelivered(db, row.forkId, opts.now(), token)) delivered++;
      else superseded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (markDeliveryFailed(db, row.forkId, opts.now(), msg, opts.baseBackoffMs, token)) failed++;
      else superseded++;
    }
  }
  return { delivered, failed, claimed, superseded };
}
