-- Migration 134: Provider-switch shadow-fork audit trail (same-terminal continuity)
-- Durable PREPARED -> COMMITTED/ROLLED_BACK state for each cross-provider switch's
-- sanitized shadow fork. No secrets or raw prompt/message content is stored here --
-- only hashes, counts, provider/model identifiers, and a short routing reason string.
-- Notification delivery is NOT tracked here. It lives in provider_switch_outbox
-- (migration 135): a notified_at column on this table would only record that delivery
-- was ATTEMPTED, not that it succeeded -- the exact defect Codex's second audit
-- identified (Blocker 2). This table records the switch; the outbox records its
-- delivery.

CREATE TABLE IF NOT EXISTS provider_switch_forks (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  combo_name      TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'PREPARED'
                    CHECK (state IN ('PREPARED', 'COMMITTED', 'ROLLED_BACK')),
  source_provider TEXT NOT NULL,
  source_model    TEXT NOT NULL,
  target_provider TEXT NOT NULL,
  target_model    TEXT NOT NULL,
  source_hash     TEXT NOT NULL,
  sanitized_hash  TEXT NOT NULL,
  message_count   INTEGER NOT NULL DEFAULT 0,
  tool_count      INTEGER NOT NULL DEFAULT 0,
  reason          TEXT NOT NULL DEFAULT '',
  prepared_at     TEXT NOT NULL,
  committed_at    TEXT,
  rolled_back_at  TEXT,
  error_code      TEXT
);

CREATE INDEX IF NOT EXISTS idx_provider_switch_forks_session
  ON provider_switch_forks(session_id, combo_name, prepared_at);

-- Recovery/reconciliation: find PREPARED rows a crashed/killed process never
-- resolved (no committed_at, no rolled_back_at), oldest first.
CREATE INDEX IF NOT EXISTS idx_provider_switch_forks_stale_prepared
  ON provider_switch_forks(state, prepared_at)
  WHERE state = 'PREPARED';
