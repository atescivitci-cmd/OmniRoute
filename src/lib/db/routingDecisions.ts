import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";

export interface RoutingDecisionRecord {
  requestId?: string | null;
  taskType: string;
  comboId: string;
  providerSelected: string;
  modelSelected: string;
  score: number;
  factors: Record<string, unknown>;
  source: string;
}

/**
 * Persist a privacy-safe routing explanation. Callers must keep prompt text and
 * credentials out of `factors`; this table is operational telemetry, not a
 * transcript store.
 */
export function recordRoutingDecision(record: RoutingDecisionRecord): number {
  const requestId = record.requestId ?? randomUUID();
  const factors = { ...record.factors, selectionId: randomUUID(), phase: "selected", outcome: "unknown" };
  const result = getDbInstance()
    .prepare(
      `INSERT INTO routing_decisions
       (request_id, task_type, combo_id, provider_selected, model_selected, score, factors_json, source, success, fallbacks_triggered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    )
    .run(
      requestId,
      record.taskType,
      record.comboId,
      record.providerSelected,
      record.modelSelected,
      record.score,
      JSON.stringify(factors),
      record.source
    );
  return Number(result.lastInsertRowid);
}

/** Correlate actual attempt-log observations without upgrading HTTP status to end_turn. */
export function recordRoutingAttempt(
  requestId: string,
  attempt: {
    traceId: string;
    provider: string | null;
    model: string | null;
    status: number;
    observedAt: string;
  }
): number {
  const db = getDbInstance();
  const rows = db.prepare(
    "SELECT id, factors_json FROM routing_decisions WHERE request_id = ? AND source = 'auto-fit-first'"
  ).all(requestId) as Array<{ id: number; factors_json: string }>;
  let updated = 0;
  for (const row of rows) {
    let factors: Record<string, unknown>;
    try { factors = JSON.parse(row.factors_json); } catch { continue; }
    if (!factors || factors.phase !== "selected") continue;
    const previous = Array.isArray(factors.attempts) ? factors.attempts : [];
    const receipt = { ...attempt, phase: "attempt_log_observed", outcome: "unknown", termination: "unknown" };
    // Repeated logging of one attempt updates its observation rather than inventing retries.
    factors.attempts = [...previous.filter(item => item?.traceId !== attempt.traceId), receipt].slice(-64);
    factors.outcome = "unknown";
    updated += db.prepare(
      "UPDATE routing_decisions SET factors_json = ?, success = NULL, fallbacks_triggered = NULL WHERE id = ?"
    ).run(JSON.stringify(factors), row.id).changes;
  }
  return updated;
}
