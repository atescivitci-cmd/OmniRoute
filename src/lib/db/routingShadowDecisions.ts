import { getDbInstance } from "./core";

/**
 * Rule-classifier decisions, one row per task-routed request (migration 138).
 *
 * Only lengths, counts and flags are stored. Never prompt text: the ask stays in the call
 * artifact, which this table references through `request_id` (the call log correlation id).
 */

export interface RoutingShadowDecisionInput {
  timestamp?: string;
  requestId: string | null;
  comboName: string | null;
  strategy: string | null;
  ruleLevel: string;
  ruleReasons: string[];
  /** Step of the target pipeline reached when recorded (see migration 138). */
  path: string | null;
  lightByAsk: boolean;
  wasLevel: string | null;
  promptChars: number;
  messageCount: number;
  toolCount: number;
  outputTokens: number;
  effort: string;
  lightKeyword: boolean;
  heavyKeyword: boolean;
  criticalKeyword: boolean;
  askChars: number;
  userTurns: number;
  askNonAscii: boolean;
  askNonText: boolean;
  compactedHistory: boolean;
}

export const ROUTING_SHADOW_RETENTION_DAYS = 14;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/** Insert one decision. Returns false when the (request, combo) pair was already recorded. */
export function insertRoutingShadowDecision(input: RoutingShadowDecisionInput): boolean {
  const db = getDbInstance();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO routing_shadow_decisions (
         timestamp, request_id, combo_name, strategy, rule_level, rule_reasons, path, light_by_ask,
         was_level, prompt_chars, message_count, tool_count, output_tokens, effort,
         light_keyword, heavy_keyword, critical_keyword, ask_chars, user_turns,
         ask_non_ascii, ask_non_text, compacted_history
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.timestamp ?? new Date().toISOString(),
      input.requestId,
      input.comboName,
      input.strategy,
      input.ruleLevel,
      input.ruleReasons.join(","),
      input.path,
      input.lightByAsk ? 1 : 0,
      input.wasLevel,
      input.promptChars,
      input.messageCount,
      input.toolCount,
      input.outputTokens,
      input.effort,
      input.lightKeyword ? 1 : 0,
      input.heavyKeyword ? 1 : 0,
      input.criticalKeyword ? 1 : 0,
      input.askChars,
      input.userTurns,
      input.askNonAscii ? 1 : 0,
      input.askNonText ? 1 : 0,
      input.compactedHistory ? 1 : 0
    );
  const now = Date.now();
  if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAt = now;
    pruneRoutingShadowDecisions();
  }
  return result.changes > 0;
}

const PRUNE_BATCH_ROWS = 2000;
const PRUNE_MAX_BATCHES = 5;

/**
 * Delete rows older than the retention window, in bounded batches so a long backlog (for
 * example after the flag was off for weeks and is turned on again) never blocks the process for
 * one long statement. Any remainder is removed by the next hourly prune. Returns rows removed.
 */
export function pruneRoutingShadowDecisions(
  retentionDays: number = ROUTING_SHADOW_RETENTION_DAYS,
  nowMs: number = Date.now()
): number {
  const cutoff = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const statement = getDbInstance().prepare(
    `DELETE FROM routing_shadow_decisions WHERE id IN (
       SELECT id FROM routing_shadow_decisions WHERE timestamp < ? LIMIT ${PRUNE_BATCH_ROWS}
     )`
  );
  let removed = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const changes = statement.run(cutoff).changes;
    removed += changes;
    if (changes < PRUNE_BATCH_ROWS) break;
  }
  return removed;
}

export interface RoutingShadowSummaryRow {
  comboName: string | null;
  ruleLevel: string;
  lightByAsk: number;
  requests: number;
}

/** Counts per combo, rule level and light-by-ask since a timestamp. For reports and tests. */
export function getRoutingShadowSummary(sinceIso: string): RoutingShadowSummaryRow[] {
  return getDbInstance()
    .prepare(
      `SELECT combo_name AS comboName, rule_level AS ruleLevel, light_by_ask AS lightByAsk,
              COUNT(*) AS requests
         FROM routing_shadow_decisions
        WHERE timestamp >= ?
        GROUP BY combo_name, rule_level, light_by_ask
        ORDER BY requests DESC`
    )
    .all(sinceIso) as RoutingShadowSummaryRow[];
}

/** Test seam: forget the prune throttle. */
export function __resetRoutingShadowPruneForTests(): void {
  lastPruneAt = 0;
}
