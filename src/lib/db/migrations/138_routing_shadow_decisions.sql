-- Migration 138: routing_shadow_decisions
-- One row per task-routed request recording the decision the rule classifier made (level,
-- reasons) and the numeric signals behind it. It exists so the rule classifier can be measured
-- and, later, compared with a shadow classifier. It stores NO prompt text: only lengths,
-- counts and flags. Written only while ROUTING_SHADOW_LOG is on; rows older than 14 days are
-- pruned. Additive and idempotent: a new table, no change to existing ones.
CREATE TABLE IF NOT EXISTS routing_shadow_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  request_id TEXT,
  combo_name TEXT,
  strategy TEXT,
  rule_level TEXT NOT NULL,
  rule_reasons TEXT,
  light_by_ask INTEGER NOT NULL DEFAULT 0,
  was_level TEXT,
  prompt_chars INTEGER,
  message_count INTEGER,
  tool_count INTEGER,
  output_tokens INTEGER,
  effort TEXT,
  light_keyword INTEGER NOT NULL DEFAULT 0,
  heavy_keyword INTEGER NOT NULL DEFAULT 0,
  critical_keyword INTEGER NOT NULL DEFAULT 0,
  ask_chars INTEGER,
  user_turns INTEGER,
  ask_non_ascii INTEGER NOT NULL DEFAULT 0,
  ask_non_text INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rsd_timestamp ON routing_shadow_decisions(timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rsd_request_combo
  ON routing_shadow_decisions(request_id, combo_name)
  WHERE request_id IS NOT NULL;
