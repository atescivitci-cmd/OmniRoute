/**
 * modelIntelligence.ts — DB domain module for model task-fitness scores.
 *
 * Persists per-model intelligence from arena ELO, models.dev tier rankings,
 * and user overrides. Resolution chain: user_override → arena_elo → models_dev_tier.
 *
 * @see Migration 097_model_intelligence.sql
 */

import { getDbInstance, rowToCamel } from "./core";

// ──────────────── Types ────────────────

export interface ModelIntelligenceEntry {
  model: string;
  source: string;
  category: string;
  score: number;
  eloRaw: number | null;
  confidence: string | null;
  syncedAt: string;
  expiresAt: string | null;
  votes?: number;
  rank?: number;
}

// ──────────────── Helpers ────────────────

function rowToEntry(row: Record<string, unknown>): ModelIntelligenceEntry {
  const camel = rowToCamel(row) ?? {};
  return {
    model: String(camel.model ?? ""),
    source: String(camel.source ?? ""),
    category: String(camel.category ?? ""),
    score: typeof camel.score === "number" ? camel.score : 0,
    eloRaw: typeof camel.eloRaw === "number" ? camel.eloRaw : null,
    confidence: typeof camel.confidence === "string" ? camel.confidence : null,
    syncedAt: String(camel.syncedAt ?? ""),
    expiresAt: typeof camel.expiresAt === "string" ? camel.expiresAt : null,
  };
}

// ──────────────── CRUD ────────────────

export function getModelIntelligence(model: string, category: string): ModelIntelligenceEntry | null {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT * FROM model_intelligence
       WHERE model = ? AND category = ?
         AND source IN ('user_override', 'arena_elo', 'models_dev_tier')
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
       ORDER BY CASE source
         WHEN 'user_override' THEN 1
         WHEN 'arena_elo' THEN 2
         WHEN 'models_dev_tier' THEN 3
       END
       LIMIT 1`
    )
    .get(model, category) as Record<string, unknown> | undefined;

  return row ? rowToEntry(row) : null;
}

export function getModelIntelligenceBySource(
  model: string,
  source: string,
  category: string
): ModelIntelligenceEntry | null {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT * FROM model_intelligence
       WHERE model = ? AND source = ? AND category = ?
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`
    )
    .get(model, source, category) as Record<string, unknown> | undefined;

  return row ? rowToEntry(row) : null;
}

export function upsertModelIntelligence(entry: Omit<ModelIntelligenceEntry, "syncedAt">): void {
  const db = getDbInstance();

  db.prepare(
    `INSERT OR REPLACE INTO model_intelligence
       (model, source, category, score, elo_raw, confidence, synced_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`
  ).run(
    entry.model,
    entry.source,
    entry.category,
    entry.score,
    entry.eloRaw ?? null,
    entry.confidence ?? null,
    entry.expiresAt ?? null
  );
}

export function deleteModelIntelligence(model: string, source: string, category: string): boolean {
  const db = getDbInstance();
  const result = db
    .prepare(
      `DELETE FROM model_intelligence
       WHERE model = ? AND source = ? AND category = ?`
    )
    .run(model, source, category);
  return (result.changes ?? 0) > 0;
}

export function deleteExpiredIntelligence(source?: string): number {
  const db = getDbInstance();
  const conditions = ["expires_at IS NOT NULL", "datetime(expires_at) < datetime('now')"];
  const params: unknown[] = [];

  if (source) {
    conditions.push("source = ?");
    params.push(source);
  }

  const where = conditions.join(" AND ");
  const result = db
    .prepare(`DELETE FROM model_intelligence WHERE ${where}`)
    .run(...params);
  return result.changes ?? 0;
}

export function deleteModelIntelligenceBySource(source: string): number {
  const db = getDbInstance();
  const result = db
    .prepare(`DELETE FROM model_intelligence WHERE source = ?`)
    .run(source);
  return result.changes ?? 0;
}

export function listModelIntelligence(filters?: {
  source?: string;
  category?: string;
}): ModelIntelligenceEntry[] {
  const db = getDbInstance();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  if (filters?.category) {
    conditions.push("category = ?");
    params.push(filters.category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM model_intelligence ${where} ORDER BY model ASC, source ASC, category ASC`;

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function bulkUpsertModelIntelligence(entries: Array<Omit<ModelIntelligenceEntry, "syncedAt">>): number {
  if (entries.length === 0) return 0;

  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO model_intelligence
       (model, source, category, score, elo_raw, confidence, synced_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`
  );

  const upsertAll = db.transaction(() => {
    let count = 0;
    for (const entry of entries) {
      stmt.run(
        entry.model,
        entry.source,
        entry.category,
        entry.score,
        entry.eloRaw ?? null,
        entry.confidence ?? null,
        entry.expiresAt ?? null
      );
      count++;
    }
    return count;
  });

  return upsertAll();
}

/**
 * Atomically replace every row owned by one intelligence source.
 *
 * The delete and all inserts share one transaction, so a constraint or write
 * failure restores the previous source snapshot instead of leaving a partial
 * or empty catalog.
 */
export function replaceModelIntelligenceBySource(
  source: string,
  entries: Array<Omit<ModelIntelligenceEntry, "syncedAt">>
): number {
  if (!source || entries.length === 0) {
    throw new Error("MODEL_INTELLIGENCE_REPLACEMENT_EMPTY");
  }
  if (entries.some((entry) => entry.source !== source)) {
    throw new Error("MODEL_INTELLIGENCE_REPLACEMENT_SOURCE_MISMATCH");
  }

  const db = getDbInstance();
  const remove = db.prepare("DELETE FROM model_intelligence WHERE source = ?");
  const insert = db.prepare(
    `INSERT INTO model_intelligence
       (model, source, category, score, elo_raw, confidence, synced_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`
  );
  const replace = db.transaction(() => {
    remove.run(source);
    let count = 0;
    for (const entry of entries) {
      insert.run(
        entry.model,
        entry.source,
        entry.category,
        entry.score,
        entry.eloRaw ?? null,
        entry.confidence ?? null,
        entry.expiresAt ?? null
      );
      count++;
    }
    return count;
  });
  return replace();
}

export function getResolvedTaskFitness(model: string, category: string): number | null {
  const entry = getModelIntelligence(model, category);
  return entry ? entry.score : null;
}

/**
 * Write a user_override entry for a model × category combination.
 * Used by taskFitness.ts resolution chain as Layer 1 (highest priority).
 *
 * @param model - Model identifier
 * @param category - Task category
 * @param score - Fitness score [0..1]
 */
export function setUserFitnessOverrideEntry(
  model: string,
  category: string,
  score: number,
): void {
  upsertModelIntelligence({
    model: model.toLowerCase(),
    source: "user_override",
    category: category.toLowerCase(),
    score: Math.max(0, Math.min(1, score)),
    eloRaw: null,
    confidence: null,
    expiresAt: null,
  });
}

/**
 * Delete a user_override entry for a model × category combination.
 *
 * @param model - Model identifier
 * @param category - Task category
 * @returns true if an entry was deleted
 */
export function deleteUserFitnessOverrideEntry(
  model: string,
  category: string,
): boolean {
  return deleteModelIntelligence(model.toLowerCase(), "user_override", category.toLowerCase());
}

// ──────────────── Quality-first lookups (ROUTING_QUALITY_FIRST) ────────────────

export interface QualityScoreRow {
  key: string;
  score: number;
  eloRaw: number | null;
  confidence: string | null;
  syncedAt: string;
}

/**
 * First row of `source` for `category` among `keys`, in the order the keys are given. Rows of
 * this source never expire (the feed keeps its last good snapshot), so expiry is not filtered.
 */
export function getQualityScoreByKeys(
  keys: string[],
  category: string,
  source: string
): QualityScoreRow | null {
  const unique = [...new Set(keys.filter((key) => typeof key === "string" && key.length > 0))];
  if (unique.length === 0) return null;
  const db = getDbInstance();
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT model, score, elo_raw, confidence, synced_at FROM model_intelligence
       WHERE source = ? AND category = ? AND model IN (${placeholders})`
    )
    .all(source, category, ...unique) as Array<Record<string, unknown>>;
  const byKey = new Map(rows.map((row) => [String(row.model), row]));
  for (const key of unique) {
    const row = byKey.get(key);
    if (!row || typeof row.score !== "number") continue;
    return {
      key,
      score: row.score,
      eloRaw: typeof row.elo_raw === "number" ? row.elo_raw : null,
      confidence: typeof row.confidence === "string" ? row.confidence : null,
      syncedAt: String(row.synced_at ?? ""),
    };
  }
  return null;
}

/** Row count and sync-time range of one source; zero rows gives nulls. */
export function getModelIntelligenceSourceSummary(source: string): {
  rows: number;
  oldestSyncedAt: string | null;
  newestSyncedAt: string | null;
} {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(synced_at) AS oldest, MAX(synced_at) AS newest
       FROM model_intelligence WHERE source = ?`
    )
    .get(source) as { n?: number; oldest?: string | null; newest?: string | null } | undefined;
  return {
    rows: Number(row?.n ?? 0),
    oldestSyncedAt: row?.oldest ?? null,
    newestSyncedAt: row?.newest ?? null,
  };
}

/**
 * Operator-reviewed benchmark mapping for one provider model (table model_benchmark_mappings,
 * created by an earlier build on some databases and not by this fork's migrations). Returns the
 * mapped benchmark model id for `source` when an unexpired row exists, else null. A database
 * without the table has no mappings.
 */
export function getBenchmarkModelId(
  providerId: string,
  modelId: string,
  source: string
): string | null {
  const db = getDbInstance();
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_benchmark_mappings'")
    .get();
  if (!table) return null;
  const row = db
    .prepare(
      `SELECT benchmark_model_id FROM model_benchmark_mappings
       WHERE provider_id = ? AND model_id = ? AND source = ?
         AND datetime(expires_at) > datetime('now')`
    )
    .get(providerId, modelId, source) as { benchmark_model_id?: string } | undefined;
  return typeof row?.benchmark_model_id === "string" && row.benchmark_model_id
    ? row.benchmark_model_id
    : null;
}
