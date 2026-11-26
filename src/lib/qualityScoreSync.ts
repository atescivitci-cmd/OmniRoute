/**
 * qualityScoreSync.ts — per-task model quality scores from the official LMArena leaderboard.
 *
 * Why: the Arena feed in arenaEloSync.ts (api.wulong.dev) returns HTTP 404 for every leaderboard
 * since at least 2026-11-18 (its index lists no leaderboards), so `model_intelligence` emptied as
 * its 7-day rows expired and every routing candidate fell back to the same capability-derived
 * fitness. This feed replaces it as the quality source for ROUTING_QUALITY_FIRST.
 *
 * Source (verified 2026-11-26 with keyless GET requests):
 *   https://datasets-server.huggingface.co/filter
 *     ?dataset=lmarena-ai/leaderboard-dataset&config=text&split=latest
 *     &where="category"='<category>'&orderby="rank"&offset=<n>&length=100
 *   Response: { features, rows: [{ row_idx, row, truncated_cells }], num_rows_total,
 *               num_rows_per_page, partial }
 *   row fields used: model_name (display name, e.g. "Claude Opus 4.7", "GPT-5.6 Sol (xHigh)"),
 *   organization, rating (Bradley-Terry Elo), vote_count, rank, category,
 *   leaderboard_publish_date. Also present and unused: license, rating_lower, rating_upper,
 *   variance. The dataset is the LMArena team's own published export of arena.ai/leaderboard;
 *   anonymous access is rate limited by Hugging Face, so one sync makes about 30 page requests
 *   sequentially, once a day.
 *
 * Leaderboard category -> routing task category (rows are stored under the task category):
 *   overall               -> default (the ranker's "general" task)
 *   coding                -> coding, debugging
 *   hard_prompts          -> analysis, planning, review
 *   math                  -> math
 *   creative_writing      -> creative
 *   instruction_following -> documentation
 *
 * Normalisation (unchanged from arenaEloSync): per category, score = 0.4 + 0.58 x
 * (rating - min) / (max - min), so 0.4 is the weakest listed model and 0.98 the strongest.
 * Rows are written under source "lmarena" with no expiry. The base ranker (flag off) reads only
 * the "arena_elo" source, so this feed changes nothing unless ROUTING_QUALITY_FIRST is on.
 *
 * Keys: each leaderboard row is stored under the normalised keys of qualityModelKey.ts (exact,
 * canonical, dated, without organisation). Several rows on one key (effort variants of one
 * model) are averaged; when any of them names the plain model (no variant), only those count.
 *
 * Failure handling: a sync replaces the source's rows in one transaction only after every
 * category was fetched and validated. A failed sync keeps the last good rows (never expires them),
 * logs at error level and is visible in getQualityScoreSyncStatus() (state "failing"/"stale",
 * data age in hours) and in each routing decision (qualityAgeHours / qualityStale).
 */

import { isArenaEloSyncEnabled } from "@/shared/utils/featureFlags";

import {
  ageHours,
  QUALITY_STALE_AFTER_HOURS,
} from "../../open-sse/services/autoCombo/qualityAge.ts";
import { leaderboardRowKeys } from "../../open-sse/services/autoCombo/qualityModelKey.ts";
import {
  getModelIntelligenceSourceSummary,
  replaceModelIntelligenceBySource,
  type ModelIntelligenceEntry,
} from "./db/modelIntelligence";

// ─── Configuration ───────────────────────────────────────

export const QUALITY_SOURCE = "lmarena";
export const LMARENA_DATASET = "lmarena-ai/leaderboard-dataset";
export const LMARENA_FILTER_URL = "https://datasets-server.huggingface.co/filter";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_CATEGORY = 20;
const MIN_ROWS_PER_CATEGORY = 20;
const FETCH_TIMEOUT_MS = 30_000;
export { ageHours, QUALITY_STALE_AFTER_HOURS };

export const QUALITY_CATEGORY_PLAN: ReadonlyArray<{ category: string; tasks: string[] }> = [
  { category: "overall", tasks: ["default"] },
  { category: "coding", tasks: ["coding", "debugging"] },
  { category: "hard_prompts", tasks: ["analysis", "planning", "review"] },
  { category: "math", tasks: ["math"] },
  { category: "creative_writing", tasks: ["creative"] },
  { category: "instruction_following", tasks: ["documentation"] },
];

const HIGH_CONFIDENCE_VOTES = 5000;
const MEDIUM_CONFIDENCE_VOTES = 1000;

const parsedInterval = parseInt(process.env.QUALITY_SCORE_SYNC_INTERVAL || "86400", 10);
const SYNC_INTERVAL_MS =
  Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval * 1000 : 86_400_000;

// ─── Types ───────────────────────────────────────────────

export interface LeaderboardRow {
  modelName: string;
  organization: string | null;
  rating: number;
  voteCount: number;
  rank: number;
  category: string;
  publishDate: string;
}

export type LeaderboardSnapshot = Record<string, LeaderboardRow[]>;

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

export interface QualitySyncResult {
  success: boolean;
  source: typeof QUALITY_SOURCE;
  modelCount: number;
  rowCount: number;
  leaderboardPublishDate?: string;
  error?: string;
  /** On failure: rows kept from the last good sync. */
  keptRows?: number;
  keptSyncedAt?: string | null;
}

export interface QualitySyncStatus {
  source: typeof QUALITY_SOURCE;
  sourceUrl: string;
  enabled: boolean;
  /** never_synced: no rows and no success; fresh; stale: data too old; failing: last attempt failed. */
  state: "never_synced" | "fresh" | "stale" | "failing";
  stale: boolean;
  storedRows: number;
  dataSyncedAt: string | null;
  dataAgeHours: number | null;
  leaderboardPublishDate: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  intervalMs: number;
  nextSync: string | null;
}

// ─── State ───────────────────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncInProgress = false;
let lastAttemptAt: string | null = null;
let lastSuccessAt: string | null = null;
let lastError: string | null = null;
let consecutiveFailures = 0;
let leaderboardPublishDate: string | null = null;

/** Test seam: reset module state. */
export function _resetQualityScoreSyncState(): void {
  stopQualityScoreSync();
  syncInProgress = false;
  lastAttemptAt = null;
  lastSuccessAt = null;
  lastError = null;
  consecutiveFailures = 0;
  leaderboardPublishDate = null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Fetch + parse ───────────────────────────────────────

export function leaderboardPageUrl(category: string, offset: number): string {
  const params = new URLSearchParams({
    dataset: LMARENA_DATASET,
    config: "text",
    split: "latest",
    where: `"category"='${category}'`,
    orderby: `"rank"`,
    offset: String(offset),
    length: String(PAGE_SIZE),
  });
  return `${LMARENA_FILTER_URL}?${params.toString()}`;
}

/**
 * Parse one /filter page. Throws on any shape the sync cannot trust: a missing rows array, a row
 * of another category, a non-finite rating, an empty model name.
 */
export function parseLeaderboardPage(
  json: unknown,
  category: string
): { rows: LeaderboardRow[]; total: number } {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`leaderboard page for "${category}" is not an object`);
  }
  const page = json as { rows?: unknown; num_rows_total?: unknown };
  if (!Array.isArray(page.rows)) throw new Error(`leaderboard page for "${category}" has no rows`);
  const total = Number(page.num_rows_total);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`leaderboard page for "${category}" has no num_rows_total`);
  }
  const rows = page.rows.map((wrapper, index) => {
    const row = (wrapper as { row?: Record<string, unknown> } | null)?.row;
    if (!row || typeof row !== "object") {
      throw new Error(`leaderboard row ${index} for "${category}" has no row object`);
    }
    const modelName = typeof row.model_name === "string" ? row.model_name.trim() : "";
    const rating = Number(row.rating);
    const voteCount = Number(row.vote_count);
    const rank = Number(row.rank);
    if (!modelName) throw new Error(`leaderboard row ${index} for "${category}" has no model_name`);
    if (row.category !== category) {
      throw new Error(
        `leaderboard row "${modelName}" is category ${String(row.category)}, not ${category}`
      );
    }
    if (!Number.isFinite(rating) || !Number.isFinite(voteCount) || !Number.isFinite(rank)) {
      throw new Error(`leaderboard row "${modelName}" (${category}) has a non-numeric rating`);
    }
    return {
      modelName,
      organization: typeof row.organization === "string" ? row.organization : null,
      rating,
      voteCount,
      rank,
      category,
      publishDate: String(row.leaderboard_publish_date ?? "").slice(0, 10),
    };
  });
  return { rows, total };
}

export async function fetchLeaderboardCategory(
  category: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<LeaderboardRow[]> {
  const rows: LeaderboardRow[] = [];
  let total = Infinity;
  for (let page = 0; page < MAX_PAGES_PER_CATEGORY && rows.length < total; page++) {
    const url = leaderboardPageUrl(category, rows.length);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(
        `LMArena leaderboard "${category}" page ${page} returned HTTP ${response.status}${
          response.statusText ? ` ${response.statusText}` : ""
        }`
      );
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`LMArena leaderboard "${category}" page ${page} is not JSON`);
    }
    const parsed = parseLeaderboardPage(json, category);
    total = parsed.total;
    if (parsed.rows.length === 0) break;
    rows.push(...parsed.rows);
  }
  if (rows.length !== total) {
    throw new Error(`LMArena leaderboard "${category}" returned ${rows.length} of ${total} rows`);
  }
  if (rows.length < MIN_ROWS_PER_CATEGORY) {
    throw new Error(`LMArena leaderboard "${category}" has only ${rows.length} rows`);
  }
  const dates = new Set(rows.map((row) => row.publishDate));
  if (dates.size !== 1) {
    throw new Error(
      `LMArena leaderboard "${category}" mixes publish dates ${[...dates].join(", ")}`
    );
  }
  return rows;
}

/** Every category of the plan, or an error: a sync never replaces data with a partial snapshot. */
export async function fetchQualityLeaderboards(
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<LeaderboardSnapshot> {
  const snapshot: LeaderboardSnapshot = {};
  // Sequential on purpose: anonymous Hugging Face access is rate limited.
  for (const { category } of QUALITY_CATEGORY_PLAN) {
    snapshot[category] = await fetchLeaderboardCategory(category, fetchImpl);
  }
  return snapshot;
}

// ─── Transform ───────────────────────────────────────────

function confidenceFor(votes: number): "high" | "medium" | "low" {
  if (votes >= HIGH_CONFIDENCE_VOTES) return "high";
  if (votes >= MEDIUM_CONFIDENCE_VOTES) return "medium";
  return "low";
}

/**
 * Normalise one category's ratings and fold them onto model keys. Returns key -> {score, rating,
 * votes}. A key's value is the mean of its plain rows when it has any, else of all its rows.
 */
export function scoreLeaderboardCategory(
  rows: LeaderboardRow[]
): Map<string, { score: number; rating: number; votes: number }> {
  const ratings = rows.map((row) => row.rating);
  const min = Math.min(...ratings);
  const range = Math.max(...ratings) - min || 1;
  const groups = new Map<
    string,
    {
      plain: Array<{ score: number; rating: number; votes: number }>;
      all: Array<{ score: number; rating: number; votes: number }>;
    }
  >();
  const add = (
    key: string | null,
    plain: boolean,
    value: { score: number; rating: number; votes: number }
  ) => {
    if (!key) return;
    const group = groups.get(key) ?? { plain: [], all: [] };
    group.all.push(value);
    if (plain) group.plain.push(value);
    groups.set(key, group);
  };
  for (const row of rows) {
    const value = {
      score: 0.4 + 0.58 * ((row.rating - min) / range),
      rating: row.rating,
      votes: row.voteCount,
    };
    const keys = leaderboardRowKeys(row.modelName, row.organization);
    add(keys.exact, true, value);
    add(keys.canonical, keys.plain, value);
    add(keys.dated, keys.plain, value);
    for (const key of keys.withoutOrganization) add(key, keys.plain, value);
  }
  const result = new Map<string, { score: number; rating: number; votes: number }>();
  for (const [key, group] of groups) {
    const used = group.plain.length > 0 ? group.plain : group.all;
    const mean = (pick: (v: { score: number; rating: number; votes: number }) => number) =>
      used.reduce((sum, value) => sum + pick(value), 0) / used.length;
    result.set(key, {
      score: Math.round(mean((v) => v.score) * 10000) / 10000,
      rating: Math.round(mean((v) => v.rating)),
      votes: Math.min(...used.map((v) => v.votes)),
    });
  }
  return result;
}

export function transformQualitySnapshot(
  snapshot: LeaderboardSnapshot
): Array<Omit<ModelIntelligenceEntry, "syncedAt">> {
  const entries: Array<Omit<ModelIntelligenceEntry, "syncedAt">> = [];
  for (const { category, tasks } of QUALITY_CATEGORY_PLAN) {
    const rows = snapshot[category];
    if (!rows || rows.length === 0) continue;
    for (const [key, value] of scoreLeaderboardCategory(rows)) {
      for (const task of tasks) {
        entries.push({
          model: key,
          source: QUALITY_SOURCE,
          category: task,
          score: value.score,
          eloRaw: value.rating,
          confidence: confidenceFor(value.votes),
          expiresAt: null,
        });
      }
    }
  }
  return entries;
}

// ─── Sync ────────────────────────────────────────────────

/**
 * Fetch, validate, transform and atomically replace the "lmarena" rows. On any failure the last
 * good rows stay in place and the failure is logged at error level with their age.
 */
export async function syncQualityScores(
  options: { dryRun?: boolean; fetchImpl?: FetchLike } = {}
): Promise<QualitySyncResult> {
  if (syncInProgress) {
    return {
      success: false,
      source: QUALITY_SOURCE,
      modelCount: 0,
      rowCount: 0,
      error: "Quality score sync already in progress",
    };
  }
  syncInProgress = true;
  lastAttemptAt = new Date().toISOString();
  try {
    const snapshot = await fetchQualityLeaderboards(options.fetchImpl);
    const entries = transformQualitySnapshot(snapshot);
    if (entries.length === 0) throw new Error("LMArena snapshot produced no quality rows");
    const publishDate = snapshot[QUALITY_CATEGORY_PLAN[0].category]?.[0]?.publishDate ?? null;
    const modelCount = new Set(entries.map((entry) => entry.model)).size;
    if (!options.dryRun) {
      replaceModelIntelligenceBySource(QUALITY_SOURCE, entries);
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      consecutiveFailures = 0;
      leaderboardPublishDate = publishDate;
    }
    console.log(
      `[QUALITY_SYNC] ${options.dryRun ? "would store" : "stored"} ${entries.length} quality rows for ${modelCount} model keys (LMArena leaderboard ${publishDate ?? "unknown date"})`
    );
    return {
      success: true,
      source: QUALITY_SOURCE,
      modelCount,
      rowCount: entries.length,
      ...(publishDate && { leaderboardPublishDate: publishDate }),
    };
  } catch (error) {
    const message = errorMessage(error);
    if (!options.dryRun) {
      lastError = message;
      consecutiveFailures += 1;
    }
    let kept = { rows: 0, newestSyncedAt: null as string | null };
    try {
      kept = getModelIntelligenceSourceSummary(QUALITY_SOURCE);
    } catch (summaryError) {
      console.error(`[QUALITY_SYNC] could not read the kept rows: ${errorMessage(summaryError)}`);
    }
    console.error(
      `[QUALITY_SYNC] FAILED (${consecutiveFailures} in a row): ${message}. ` +
        (kept.rows > 0
          ? `Keeping ${kept.rows} last-good quality rows synced at ${kept.newestSyncedAt} (age ${ageHours(kept.newestSyncedAt)?.toFixed(1)} h).`
          : "No quality rows are stored: every candidate ranks on the neutral quality score.")
    );
    return {
      success: false,
      source: QUALITY_SOURCE,
      modelCount: 0,
      rowCount: 0,
      error: message,
      keptRows: kept.rows,
      keptSyncedAt: kept.newestSyncedAt,
    };
  } finally {
    syncInProgress = false;
  }
}

function syncEnabled(): boolean {
  try {
    return isArenaEloSyncEnabled();
  } catch (error) {
    console.error(
      `[QUALITY_SYNC] could not resolve ARENA_ELO_SYNC_ENABLED: ${errorMessage(error)}`
    );
    return process.env.ARENA_ELO_SYNC_ENABLED !== "false";
  }
}

export function getQualityScoreSyncStatus(now = Date.now()): QualitySyncStatus {
  let summary = { rows: 0, newestSyncedAt: null as string | null };
  let summaryError: string | null = null;
  try {
    summary = getModelIntelligenceSourceSummary(QUALITY_SOURCE);
  } catch (error) {
    summaryError = errorMessage(error);
  }
  const age = ageHours(summary.newestSyncedAt, now);
  const tooOld = age === null || age > QUALITY_STALE_AFTER_HOURS;
  const state: QualitySyncStatus["state"] =
    consecutiveFailures > 0 || summaryError
      ? "failing"
      : summary.rows === 0
        ? "never_synced"
        : tooOld
          ? "stale"
          : "fresh";
  return {
    source: QUALITY_SOURCE,
    sourceUrl: `${LMARENA_FILTER_URL}?dataset=${LMARENA_DATASET}&config=text&split=latest`,
    enabled: syncEnabled(),
    state,
    stale: state !== "fresh",
    storedRows: summary.rows,
    dataSyncedAt: summary.newestSyncedAt,
    dataAgeHours: age === null ? null : Math.round(age * 10) / 10,
    leaderboardPublishDate,
    lastAttemptAt,
    lastSuccessAt,
    lastError: summaryError ?? lastError,
    consecutiveFailures,
    intervalMs: SYNC_INTERVAL_MS,
    nextSync:
      syncTimer && lastAttemptAt
        ? new Date(Date.parse(lastAttemptAt) + SYNC_INTERVAL_MS).toISOString()
        : null,
  };
}

// ─── Periodic sync ───────────────────────────────────────

export function stopQualityScoreSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/**
 * Start the daily sync (first run immediately, non-blocking). Gated by the same feature flag as
 * the Arena sync (ARENA_ELO_SYNC_ENABLED, on by default). Idempotent.
 */
export async function initQualityScoreSync(): Promise<boolean> {
  if (!syncEnabled()) {
    console.log("[QUALITY_SYNC] Disabled by the ARENA_ELO_SYNC_ENABLED feature flag.");
    return false;
  }
  if (syncTimer) return true;
  const run = () => {
    syncQualityScores().catch((error) => {
      console.error(`[QUALITY_SYNC] sync threw: ${errorMessage(error)}`);
    });
  };
  run();
  syncTimer = setInterval(run, SYNC_INTERVAL_MS);
  (syncTimer as { unref?: () => void }).unref?.();
  return true;
}
