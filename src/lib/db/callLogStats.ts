import { getDbInstance } from "./core";

/**
 * Aggregation queries over `call_logs` extracted from route handlers.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/provider-metrics, /api/search/stats, and /api/v1/search/analytics routes
 * can delegate. Read-only aggregation; no writes.
 *
 * Sliced out of #3500 (call_logs cluster).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderMetricRow {
  provider: string;
  totalRequests: number;
  totalSuccesses: number;
  avgLatencyMs: number;
  lastRequestAt: string | null;
  lastErrorAt: string | null;
  lastStatus: number | null;
  lastErrorStatus: number | null;
}

export interface SearchProviderStatRow {
  provider: string;
  requests: number;
  avg_latency_ms: number;
}

export interface SearchRecentRow {
  request_summary: string | null;
  provider: string;
  timestamp: string;
}

export interface SearchAggregateStats {
  total: number;
  today: number;
  errors: number;
  avg_duration: number | null;
  cached: number;
}

export interface SearchProviderCountRow {
  provider: string;
  cnt: number;
}

// ---------------------------------------------------------------------------
// /api/provider-metrics — aggregate per-provider stats
// ---------------------------------------------------------------------------

/**
 * Returns one row per provider with call-level aggregates plus last-status
 * subselects. Excludes rows where provider is NULL or '-'.
 */
export function getProviderMetrics(): ProviderMetricRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT
          c.provider,
          COUNT(*) as totalRequests,
          SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) as totalSuccesses,
          ROUND(AVG(duration)) as avgLatencyMs,
          MAX(timestamp) as lastRequestAt,
          MAX(
            CASE
              WHEN (status IS NOT NULL AND (status < 200 OR status >= 400))
                OR error_summary IS NOT NULL
              THEN timestamp
              ELSE NULL
            END
          ) as lastErrorAt,
          (
            SELECT c2.status
            FROM call_logs c2
            WHERE c2.provider = c.provider
            ORDER BY c2.timestamp DESC, c2.id DESC
            LIMIT 1
          ) as lastStatus,
          (
            SELECT c3.status
            FROM call_logs c3
            WHERE c3.provider = c.provider
              AND (
                (c3.status IS NOT NULL AND (c3.status < 200 OR c3.status >= 400))
                OR c3.error_summary IS NOT NULL
              )
            ORDER BY c3.timestamp DESC, c3.id DESC
            LIMIT 1
          ) as lastErrorStatus
        FROM call_logs c
        WHERE c.provider IS NOT NULL AND c.provider != '-'
        GROUP BY c.provider`
    )
    .all() as ProviderMetricRow[];
}

// ---------------------------------------------------------------------------
// /api/search/stats — search provider aggregates + recent entries
// ---------------------------------------------------------------------------

/**
 * Per-provider request count and average latency for search requests.
 */
export function getSearchProviderStats(): SearchProviderStatRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
        SELECT provider, COUNT(*) as requests,
          CAST(AVG(duration) AS INTEGER) as avg_latency_ms
        FROM call_logs
        WHERE request_type = 'search'
        GROUP BY provider
      `
    )
    .all() as SearchProviderStatRow[];
}

/**
 * Most recent 10 search entries (request_summary + provider + timestamp).
 */
export function getRecentSearchLogs(): SearchRecentRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
        SELECT request_summary, provider, timestamp
        FROM call_logs
        WHERE request_type = 'search'
        ORDER BY timestamp DESC
        LIMIT 10
      `
    )
    .all() as SearchRecentRow[];
}

// ---------------------------------------------------------------------------
// /api/v1/search/analytics — aggregated search analytics
// ---------------------------------------------------------------------------

/**
 * Single-pass scalar aggregations for all search entries since `todayIso`.
 * `todayIso` is the ISO-8601 UTC start-of-day string used for the "today" count.
 */
export function getSearchAggregateStats(todayIso: string): SearchAggregateStats {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END), 0) as today,
          COALESCE(SUM(CASE WHEN status >= 400 OR error_summary IS NOT NULL THEN 1 ELSE 0 END), 0) as errors,
          AVG(CASE WHEN duration > 0 THEN duration END) as avg_duration,
          COALESCE(SUM(CASE WHEN duration > 0 AND duration < 5 THEN 1 ELSE 0 END), 0) as cached
         FROM call_logs
         WHERE request_type = 'search'`
    )
    .get(todayIso) as SearchAggregateStats | undefined;
  return row ?? { total: 0, today: 0, errors: 0, avg_duration: null, cached: 0 };
}

/**
 * Per-provider request count for search entries, ordered by count descending.
 */
export function getSearchProviderCounts(): SearchProviderCountRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT provider, COUNT(*) as cnt
         FROM call_logs WHERE request_type = 'search'
         GROUP BY provider ORDER BY cnt DESC`
    )
    .all() as SearchProviderCountRow[];
}

// ---------------------------------------------------------------------------
// /api/usage/analytics — fallback-rate aggregates over call_logs
// ---------------------------------------------------------------------------

export interface FallbackStatsRow {
  total: number;
  with_requested: number;
  fallback_eligible: number;
  fallbacks: number;
}

/**
 * Scalar fallback-rate stats over `call_logs` for the usage analytics endpoint.
 *
 * @param whereClause - SQL WHERE clause (may be empty string) using the same
 *                      named params as the usage_history queries.
 * @param params      - Named params object (string values).
 */
export function getFallbackStats(
  whereClause: string,
  params: Record<string, string>
): FallbackStatsRow {
  const db = getDbInstance();
  const row = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN (combo_name IS NULL OR combo_name = '') THEN 1 ELSE 0 END) as total,
        SUM(CASE WHEN requested_model IS NOT NULL AND requested_model != '' AND (combo_name IS NULL OR combo_name = '') THEN 1 ELSE 0 END) as with_requested,
        SUM(CASE
          WHEN (combo_name IS NULL OR combo_name = '')
           AND requested_model IS NOT NULL
           AND requested_model != ''
           AND model IS NOT NULL
           AND model != ''
          THEN 1 ELSE 0 END
        ) as fallback_eligible,
        SUM(CASE
          WHEN (combo_name IS NULL OR combo_name = '')
           AND requested_model IS NOT NULL
           AND requested_model != ''
           AND model IS NOT NULL
           AND model != ''
           AND LOWER(CASE WHEN instr(requested_model, '/') > 0 THEN substr(requested_model, instr(requested_model, '/') + 1) ELSE requested_model END) != LOWER(model)
          THEN 1 ELSE 0 END
        ) as fallbacks
      FROM call_logs
      ${whereClause}
    `
    )
    .get(params) as FallbackStatsRow | undefined;
  return row ?? { total: 0, with_requested: 0, fallback_eligible: 0, fallbacks: 0 };
}


/** Combo-lane outcomes have a separate typed identity; never overwrite provider metrics.
 * Only explicit combo_name provenance attributes a request to a combo. In particular,
 * provider=codex alone cannot be attributed to a combo also named codex.
 */
export function getComboRouteRecency() {
  return getDbInstance().prepare(
    `WITH explicit_times AS (
       SELECT a.id AS combo_id, a.name AS combo_name, l.id, l.timestamp, l.status,
         CASE WHEN substr(l.timestamp, -1) = 'Z' THEN 'Z'
              ELSE substr(l.timestamp, -6) END AS zone,
         CASE WHEN substr(l.timestamp, -1) = 'Z'
              THEN substr(l.timestamp, 1, length(l.timestamp) - 1)
              ELSE substr(l.timestamp, 1, length(l.timestamp) - 6) END AS body
       FROM combos a JOIN call_logs l ON l.combo_name = a.name
     ), combo_calls AS (
       SELECT *, CASE WHEN
         typeof(timestamp) = 'text'
         AND length(CAST(timestamp AS BLOB)) = length(timestamp)
         AND substr(body, 1, 19) GLOB
           '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
         AND (length(body) = 19 OR (
           length(body) BETWEEN 21 AND 23 AND substr(body, 20, 1) = '.'
           AND substr(body, 21) NOT GLOB '*[^0-9]*'))
         AND CAST(substr(body, 1, 4) AS INTEGER) BETWEEN 1 AND 9999
         AND CAST(substr(body, 6, 2) AS INTEGER) BETWEEN 1 AND 12
         AND CAST(substr(body, 9, 2) AS INTEGER) BETWEEN 1 AND
           CASE WHEN CAST(substr(body, 6, 2) AS INTEGER) IN (1,3,5,7,8,10,12) THEN 31
                WHEN substr(body, 6, 2) = '02' THEN 28 + CASE
                  WHEN CAST(substr(body, 1, 4) AS INTEGER) % 4 = 0 AND (
                    CAST(substr(body, 1, 4) AS INTEGER) % 100 != 0 OR
                    CAST(substr(body, 1, 4) AS INTEGER) % 400 = 0) THEN 1 ELSE 0 END
                ELSE 30 END
         AND CAST(substr(body, 12, 2) AS INTEGER) BETWEEN 0 AND 23
         AND CAST(substr(body, 15, 2) AS INTEGER) BETWEEN 0 AND 59
         AND CAST(substr(body, 18, 2) AS INTEGER) BETWEEN 0 AND 59
         AND (zone = 'Z' OR (
           zone != '-00:00' AND zone GLOB '[+-][0-9][0-9]:[0-9][0-9]'
           AND CAST(substr(zone, 2, 2) AS INTEGER) BETWEEN 0 AND 14
           AND CAST(substr(zone, 5, 2) AS INTEGER) BETWEEN 0 AND 59
           AND (CAST(substr(zone, 2, 2) AS INTEGER) < 14 OR substr(zone, 5, 2) = '00')))
         THEN julianday(timestamp) ELSE NULL END AS request_time
       FROM explicit_times
     ), latest AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY combo_id ORDER BY request_time DESC, id DESC
       ) AS position,
       MAX(CASE WHEN request_time IS NULL THEN 1 ELSE 0 END)
         OVER (PARTITION BY combo_id) AS invalid_timestamp
       FROM combo_calls
     )
     SELECT combo_id AS comboId, combo_name AS comboName,
            CASE WHEN invalid_timestamp = 0 THEN timestamp ELSE NULL END AS lastRequestAt,
            CASE WHEN invalid_timestamp = 0 THEN status ELSE NULL END AS lastStatus,
            CASE WHEN invalid_timestamp = 0
              THEN CAST(ROUND((request_time - 2440587.5) * 86400000) AS INTEGER)
              ELSE NULL END AS lastRequestAtMs,
            CASE WHEN invalid_timestamp = 0 THEN 'ordered'
              ELSE 'malformed_timestamp' END AS recencyReason
     FROM latest WHERE position = 1`
  ).all() as { comboId: string; comboName: string; lastRequestAt: string | null;
              recencyReason: "ordered" | "malformed_timestamp"; lastStatus: number | null; lastRequestAtMs: number | null }[];
}
