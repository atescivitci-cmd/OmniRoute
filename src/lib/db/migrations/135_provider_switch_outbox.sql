-- Migration 135: Durable notification outbox for provider-switch events
--
-- Added 2026-08-30 in response to Codex's second audit (Blocker 2): writing
-- notified_at on provider_switch_forks BEFORE delivery, then calling a fire-and-forget
-- dispatcher that swallows async failures, permanently loses the notification while the
-- database records it as sent. That is a durable once-only CLAIM, not durable DELIVERY.
--
-- This table is the real outbox. A row is created PENDING in the same transaction that
-- moves its fork to COMMITTED. A background worker leases it (CLAIMED), calls an
-- AWAITABLE dispatch, and only then marks DELIVERED. A crash, rejection, or expired
-- lease returns the row to a retryable state instead of losing the event.
--
-- Honest guarantee: at-least-once delivery, deduplicated by fork_id as the idempotency
-- key. Exactly-once end-to-end would additionally require the receiver to dedupe on
-- that key -- not claimed here.
--
-- Notification-only: nothing in this table may gate, delay, or interrupt the user's
-- terminal response.

CREATE TABLE IF NOT EXISTS provider_switch_outbox (
  fork_id         TEXT PRIMARY KEY
                    REFERENCES provider_switch_forks(id) ON DELETE CASCADE,
  state           TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (state IN ('PENDING', 'CLAIMED', 'DELIVERED')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until     TEXT,
  claim_token     TEXT,   -- unguessable per-claim owner token; see providerSwitchOutbox.ts
  claimed_at      TEXT,
  delivered_at    TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Worker claim path: find eligible rows (PENDING and due, or CLAIMED with an expired
-- lease), oldest-due first.
CREATE INDEX IF NOT EXISTS idx_provider_switch_outbox_claimable
  ON provider_switch_outbox(state, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_provider_switch_outbox_lease
  ON provider_switch_outbox(state, lease_until)
  WHERE state = 'CLAIMED';
