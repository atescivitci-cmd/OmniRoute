-- Migration 140: learned_context_caps
-- The context limit a provider actually enforced, learned from its own rejection of a request as
-- too long (HTTP 400 prompt too long / context_length_exceeded). One row per provider, model and connection (empty = any connection).
-- rejected_tokens is the smallest required size (estimated input plus requested output) that was
-- rejected; stated_limit_tokens is the limit the provider named in its message, when it named one.
-- Written only while ROUTING_LEARNED_CONTEXT_CAP is learn or enforce; read only when it is enforce.
-- Additive and idempotent: a new table, no change to existing ones.
CREATE TABLE IF NOT EXISTS learned_context_caps (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  connection_id TEXT NOT NULL DEFAULT '',
  rejected_tokens INTEGER NOT NULL,
  stated_limit_tokens INTEGER,
  rejections INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model, connection_id)
);
