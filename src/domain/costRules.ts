/**
 * Cost Rules — Domain Layer (T-19)
 *
 * Business rules for cost management: budget thresholds,
 * scheduled reset windows, and cost summaries per API key.
 *
 * State is persisted in SQLite via domainState.ts.
 *
 * @module domain/costRules
 */

import {
  deleteAllCostData,
  deleteBudget as dbDeleteBudget,
  deleteCostEntries,
  loadAllBudgets,
  loadBudget,
  loadCostEntries,
  loadCostEntriesInRange,
  loadCostByProvider,
  loadCostTotal,
  saveBudget,
  saveBudgetResetLog,
} from "../lib/db/domainState";
import {
  discardSpendBatchEntries,
  resetSpendBatchWriterForTests,
  spendBatchWriter,
} from "@/lib/spend/batchWriter";
import {
  entryAmount,
  GLOBAL_BUDGET_ID,
  normalizeCostBasis,
  normalizeCostProvider,
  normalizeShareLimit,
  type CostBasis,
} from "@/lib/usage/cashCost";

export type BudgetResetInterval = "daily" | "weekly" | "monthly";

interface BudgetConfig {
  dailyLimitUsd?: number;
  weeklyLimitUsd?: number;
  monthlyLimitUsd?: number;
  warningThreshold?: number;
  resetInterval?: BudgetResetInterval;
  resetTime?: string;
  budgetResetAt?: number | null;
  lastBudgetResetAt?: number | null;
  warningEmittedAt?: number | null;
  warningPeriodStart?: number | null;
  /** "list" (default) counts list-price estimates; "cash" counts only real money spent. */
  costBasis?: CostBasis;
  /** Global budget only: fraction (0, 1) of the limit one metered provider may use. */
  providerShareLimit?: number | null;
}

interface NormalizedBudgetConfig {
  dailyLimitUsd: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;
  warningThreshold: number;
  resetInterval: BudgetResetInterval;
  resetTime: string;
  budgetResetAt: number | null;
  lastBudgetResetAt: number | null;
  warningEmittedAt: number | null;
  warningPeriodStart: number | null;
  costBasis: CostBasis;
  providerShareLimit: number | null;
}

interface CostEntry {
  cost: number;
  timestamp: number;
  cashCost?: number | null;
}

interface BudgetWindow {
  periodStartAt: number;
  nextResetAt: number;
}

interface SyncBudgetScheduleOptions {
  logReset?: boolean;
  persist?: boolean;
}

interface BudgetSummary {
  dailyTotal: number;
  monthlyTotal: number;
  totalEntries: number;
  budget: NormalizedBudgetConfig | null;
  totalCostToday: number;
  totalCostMonth: number;
  totalCostPeriod: number;
  activeLimitUsd: number;
  resetInterval: BudgetResetInterval | null;
  resetTime: string | null;
  budgetResetAt: number | null;
  lastBudgetResetAt: number | null;
  periodStartAt: number | null;
  nextResetAt: number | null;
  dailyLimitUsd: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;
  warningThreshold: number | null;
  /** Cost basis the period total and limit use ("list" when no budget is set). */
  costBasis: CostBasis;
  /** Real money spent (cash basis), shown next to the list totals above. */
  cashCostToday: number;
  cashCostMonth: number;
  cashCostPeriod: number;
}

const VALID_RESET_INTERVALS = new Set<BudgetResetInterval>(["daily", "weekly", "monthly"]);
const RESET_TIME_REGEX = /^(\d{2}):(\d{2})$/;

/** @type {Map<string, NormalizedBudgetConfig>} In-memory cache for budgets */
const budgets = new Map<string, NormalizedBudgetConfig>();

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toCostEntries(value: unknown): CostEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: CostEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const cost = toNumber(record.cost, Number.NaN);
    const timestamp = toNumber(record.timestamp, Number.NaN);
    if (!Number.isFinite(cost) || !Number.isFinite(timestamp)) continue;
    const cashCost = toNumber(record.cashCost, Number.NaN);
    entries.push(Number.isFinite(cashCost) ? { cost, timestamp, cashCost } : { cost, timestamp });
  }
  return entries;
}

function sumEntries(entries: CostEntry[], basis: CostBasis = "list"): number {
  return entries.reduce((sum, entry) => sum + entryAmount(entry, basis), 0);
}

function normalizeResetInterval(value: unknown): BudgetResetInterval {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase() as BudgetResetInterval;
    if (VALID_RESET_INTERVALS.has(normalized)) {
      return normalized;
    }
  }
  return "daily";
}

function normalizeResetTime(value: unknown): string {
  if (typeof value === "string") {
    const match = value.trim().match(RESET_TIME_REGEX);
    if (match) {
      const hours = Math.min(Math.max(parseInt(match[1], 10), 0), 23);
      const minutes = Math.min(Math.max(parseInt(match[2], 10), 0), 59);
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }
  }
  return "00:00";
}

function normalizeTimestamp(value: unknown): number | null {
  const numeric = toNumber(value, Number.NaN);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeBudgetConfig(config: BudgetConfig): NormalizedBudgetConfig {
  return {
    dailyLimitUsd: Math.max(0, toNumber(config.dailyLimitUsd)),
    weeklyLimitUsd: Math.max(0, toNumber(config.weeklyLimitUsd)),
    monthlyLimitUsd: Math.max(0, toNumber(config.monthlyLimitUsd)),
    warningThreshold: Math.min(Math.max(toNumber(config.warningThreshold, 0.8), 0), 1),
    resetInterval: normalizeResetInterval(config.resetInterval),
    resetTime: normalizeResetTime(config.resetTime),
    budgetResetAt: normalizeTimestamp(config.budgetResetAt),
    lastBudgetResetAt: normalizeTimestamp(config.lastBudgetResetAt),
    warningEmittedAt: normalizeTimestamp(config.warningEmittedAt),
    warningPeriodStart: normalizeTimestamp(config.warningPeriodStart),
    costBasis: normalizeCostBasis(config.costBasis),
    providerShareLimit: normalizeShareLimit(config.providerShareLimit),
  };
}

function getResetTimeParts(resetTime: string): [number, number] {
  const match = resetTime.match(RESET_TIME_REGEX);
  if (!match) return [0, 0];
  return [parseInt(match[1], 10), parseInt(match[2], 10)];
}

function getUtcDateMs(year: number, month: number, day: number, hours: number, minutes: number) {
  return Date.UTC(year, month, day, hours, minutes, 0, 0);
}

export function getBudgetWindow(
  resetInterval: BudgetResetInterval,
  resetTime = "00:00",
  now = Date.now()
): BudgetWindow {
  const current = new Date(now);
  const [hours, minutes] = getResetTimeParts(normalizeResetTime(resetTime));
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const day = current.getUTCDate();

  if (resetInterval === "weekly") {
    const daysSinceMonday = (current.getUTCDay() + 6) % 7;
    const thisWeekReset = getUtcDateMs(year, month, day - daysSinceMonday, hours, minutes);
    return now >= thisWeekReset
      ? {
          periodStartAt: thisWeekReset,
          nextResetAt: getUtcDateMs(year, month, day - daysSinceMonday + 7, hours, minutes),
        }
      : {
          periodStartAt: getUtcDateMs(year, month, day - daysSinceMonday - 7, hours, minutes),
          nextResetAt: thisWeekReset,
        };
  }

  if (resetInterval === "monthly") {
    const thisMonthReset = getUtcDateMs(year, month, 1, hours, minutes);
    return now >= thisMonthReset
      ? {
          periodStartAt: thisMonthReset,
          nextResetAt: getUtcDateMs(year, month + 1, 1, hours, minutes),
        }
      : {
          periodStartAt: getUtcDateMs(year, month - 1, 1, hours, minutes),
          nextResetAt: thisMonthReset,
        };
  }

  const todayReset = getUtcDateMs(year, month, day, hours, minutes);
  return now >= todayReset
    ? {
        periodStartAt: todayReset,
        nextResetAt: getUtcDateMs(year, month, day + 1, hours, minutes),
      }
    : {
        periodStartAt: getUtcDateMs(year, month, day - 1, hours, minutes),
        nextResetAt: todayReset,
      };
}

function getActiveBudgetLimit(budget: NormalizedBudgetConfig): number {
  if (budget.resetInterval === "monthly") {
    return budget.monthlyLimitUsd > 0 ? budget.monthlyLimitUsd : budget.dailyLimitUsd;
  }
  if (budget.resetInterval === "weekly") {
    return budget.weeklyLimitUsd > 0 ? budget.weeklyLimitUsd : budget.dailyLimitUsd;
  }
  return budget.dailyLimitUsd;
}

function getBudgetWindowTotal(
  apiKeyId: string,
  periodStartAt: number,
  basis: CostBasis = "list"
): number {
  try {
    return (
      loadCostTotal(apiKeyId, periodStartAt, basis) +
      spendBatchWriter.getPendingCostTotal(apiKeyId, periodStartAt, Number.POSITIVE_INFINITY, basis)
    );
  } catch {
    return 0;
  }
}

function getBudgetWindowRangeTotal(
  apiKeyId: string,
  periodStartAt: number,
  periodEndAt: number,
  basis: CostBasis = "list"
): number {
  try {
    return (
      sumEntries(
        toCostEntries(loadCostEntriesInRange(apiKeyId, periodStartAt, periodEndAt)),
        basis
      ) + spendBatchWriter.getPendingCostTotal(apiKeyId, periodStartAt, periodEndAt, basis)
    );
  } catch {
    return 0;
  }
}

function emitBudgetWarning(
  apiKeyId: string,
  budget: NormalizedBudgetConfig,
  projectedTotal: number,
  activeLimitUsd: number,
  nextResetAt: number
) {
  const percentage =
    activeLimitUsd > 0 ? ((projectedTotal / activeLimitUsd) * 100).toFixed(1) : "0.0";
  console.warn(
    `[BudgetWarning] ${apiKeyId} reached ${percentage}% of ${budget.resetInterval} budget ($${projectedTotal.toFixed(4)} / $${activeLimitUsd.toFixed(2)}) — next reset ${new Date(nextResetAt).toISOString()}`
  );
}

function syncBudgetSchedule(
  apiKeyId: string,
  config: BudgetConfig,
  now = Date.now(),
  options: SyncBudgetScheduleOptions = {}
): NormalizedBudgetConfig {
  const normalized = normalizeBudgetConfig(config);
  const window = getBudgetWindow(normalized.resetInterval, normalized.resetTime, now);
  const resetRolled =
    normalized.lastBudgetResetAt !== null && window.periodStartAt > normalized.lastBudgetResetAt;

  if (resetRolled && options.logReset !== false) {
    const previousSpend = getBudgetWindowRangeTotal(
      apiKeyId,
      normalized.lastBudgetResetAt as number,
      window.periodStartAt,
      normalized.costBasis
    );
    try {
      saveBudgetResetLog({
        apiKeyId,
        resetInterval: normalized.resetInterval,
        previousSpend,
        resetAt: window.periodStartAt,
        nextResetAt: window.nextResetAt,
        periodStart: window.periodStartAt,
        periodEnd: window.nextResetAt,
      });
    } catch {
      // Non-fatal: budget logic still proceeds even if logging fails.
    }
  }

  const updated: NormalizedBudgetConfig = {
    ...normalized,
    budgetResetAt: window.nextResetAt,
    lastBudgetResetAt: window.periodStartAt,
    warningEmittedAt: resetRolled ? null : normalized.warningEmittedAt,
    warningPeriodStart: resetRolled ? null : normalized.warningPeriodStart,
  };

  const changed =
    normalized.budgetResetAt !== updated.budgetResetAt ||
    normalized.lastBudgetResetAt !== updated.lastBudgetResetAt ||
    normalized.warningEmittedAt !== updated.warningEmittedAt ||
    normalized.warningPeriodStart !== updated.warningPeriodStart ||
    normalized.dailyLimitUsd !== updated.dailyLimitUsd ||
    normalized.weeklyLimitUsd !== updated.weeklyLimitUsd ||
    normalized.monthlyLimitUsd !== updated.monthlyLimitUsd ||
    normalized.warningThreshold !== updated.warningThreshold ||
    normalized.resetInterval !== updated.resetInterval ||
    normalized.resetTime !== updated.resetTime ||
    normalized.costBasis !== updated.costBasis ||
    normalized.providerShareLimit !== updated.providerShareLimit;

  if (changed && options.persist !== false) {
    try {
      saveBudget(apiKeyId, updated);
    } catch {
      // Non-critical: in-memory cache still works.
    }
  }

  budgets.set(apiKeyId, updated);
  return updated;
}

/**
 * Set budget for an API key.
 *
 * @param {string} apiKeyId
 * @param {BudgetConfig} config
 */
/** Stored basis and share limit of a budget, read without the schedule sync (no log, no save). */
function currentStoredSettings(apiKeyId: string): {
  costBasis: CostBasis;
  providerShareLimit: number | null;
} {
  const cached = budgets.get(apiKeyId);
  if (cached) return { costBasis: cached.costBasis, providerShareLimit: cached.providerShareLimit };
  try {
    const stored = loadBudget(apiKeyId);
    return {
      costBasis: normalizeCostBasis(stored?.costBasis),
      providerShareLimit: normalizeShareLimit(stored?.providerShareLimit),
    };
  } catch {
    return { costBasis: "list", providerShareLimit: null };
  }
}

export function setBudget(apiKeyId: string, config: BudgetConfig) {
  // A save that does not mention the cost basis or the share limit (for example the dashboard
  // form) keeps the stored ones, so a cash budget is never silently switched back to list prices.
  const stored =
    config.costBasis === undefined || config.providerShareLimit === undefined
      ? currentStoredSettings(apiKeyId)
      : null;
  const costBasis =
    config.costBasis !== undefined ? normalizeCostBasis(config.costBasis) : stored!.costBasis;
  const providerShareLimit =
    config.providerShareLimit !== undefined
      ? normalizeShareLimit(config.providerShareLimit)
      : stored!.providerShareLimit;
  invalidateCashCapCache();
  return syncBudgetSchedule(apiKeyId, { ...config, costBasis, providerShareLimit }, Date.now(), {
    logReset: false,
    persist: true,
  });
}

/**
 * Get budget config for an API key.
 *
 * @param {string} apiKeyId
 * @returns {NormalizedBudgetConfig | null}
 */
export function getBudget(apiKeyId: string): NormalizedBudgetConfig | null {
  const cached = budgets.get(apiKeyId);
  if (cached) {
    return syncBudgetSchedule(apiKeyId, cached);
  }

  try {
    const fromDb = loadBudget(apiKeyId) as BudgetConfig | null;
    if (fromDb) {
      return syncBudgetSchedule(apiKeyId, fromDb);
    }
  } catch {
    // DB may not be ready.
  }

  return null;
}

/**
 * Delete budget config and recorded spend for an API key.
 *
 * @param {string} apiKeyId
 */
export function deleteBudget(apiKeyId: string) {
  budgets.delete(apiKeyId);
  discardSpendBatchEntries(apiKeyId);
  try {
    dbDeleteBudget(apiKeyId);
    deleteCostEntries(apiKeyId);
  } catch {
    // Non-critical.
  }
}

/**
 * Record a cost for an API key.
 *
 * @param {string} apiKeyId
 * @param {number} cost - Cost in USD
 */
export function recordCost(
  apiKeyId: string,
  cost: number,
  cashCost?: number,
  provider?: string
): void {
  try {
    spendBatchWriter.increment(apiKeyId, cost, Date.now(), cashCost, provider);
  } catch {
    // Non-critical.
  }
}

/**
 * Sync all budgets against the current clock so overdue resets get persisted.
 */
export function syncAllBudgetSchedules(now = Date.now()) {
  let processed = 0;
  let resetCount = 0;

  try {
    const allBudgets = loadAllBudgets();
    for (const [apiKeyId, budget] of Object.entries(allBudgets)) {
      processed += 1;
      const synced = syncBudgetSchedule(apiKeyId, budget, now, { logReset: true, persist: true });
      if (budget.lastBudgetResetAt !== synced.lastBudgetResetAt) {
        resetCount += 1;
      }
    }
  } catch {
    // Non-critical.
  }

  return { processed, resetCount };
}

/**
 * Check if an API key has remaining budget.
 *
 * @param {string} apiKeyId
 * @param {number} [additionalCost=0] - Projected cost to check
 * @returns {{ allowed: boolean, reason?: string, dailyUsed: number, dailyLimit: number, warningReached: boolean, remaining: number, periodUsed: number, activeLimitUsd: number, resetInterval: BudgetResetInterval | null, resetTime: string | null, budgetResetAt: number | null, lastBudgetResetAt: number | null, periodStartAt: number | null }}
 */
export function checkBudget(apiKeyId: string, additionalCost = 0) {
  const budget = getBudget(apiKeyId);
  if (!budget) {
    return {
      allowed: true,
      dailyUsed: 0,
      dailyLimit: 0,
      warningReached: false,
      remaining: 0,
      periodUsed: 0,
      activeLimitUsd: 0,
      resetInterval: null,
      resetTime: null,
      budgetResetAt: null,
      lastBudgetResetAt: null,
      periodStartAt: null,
    };
  }

  const window = getBudgetWindow(budget.resetInterval, budget.resetTime);
  const periodUsed = getBudgetWindowTotal(apiKeyId, window.periodStartAt, budget.costBasis);
  const projectedTotal = periodUsed + additionalCost;
  const activeLimitUsd = getActiveBudgetLimit(budget);
  const warningReached =
    activeLimitUsd > 0 && projectedTotal >= activeLimitUsd * budget.warningThreshold;
  const remaining = Math.max(activeLimitUsd - projectedTotal, 0);

  if (warningReached && budget.warningPeriodStart !== window.periodStartAt) {
    const updatedBudget = {
      ...budget,
      warningEmittedAt: Date.now(),
      warningPeriodStart: window.periodStartAt,
    };
    budgets.set(apiKeyId, updatedBudget);
    try {
      saveBudget(apiKeyId, updatedBudget);
      emitBudgetWarning(
        apiKeyId,
        updatedBudget,
        projectedTotal,
        activeLimitUsd,
        window.nextResetAt
      );
    } catch {
      // Non-critical.
    }
  }

  if (activeLimitUsd > 0 && projectedTotal > activeLimitUsd) {
    return {
      allowed: false,
      reason: `${budget.resetInterval[0].toUpperCase()}${budget.resetInterval.slice(1)} budget exceeded: $${projectedTotal.toFixed(4)} / $${activeLimitUsd.toFixed(2)}`,
      dailyUsed: periodUsed,
      dailyLimit: activeLimitUsd,
      warningReached: true,
      remaining,
      periodUsed,
      activeLimitUsd,
      resetInterval: budget.resetInterval,
      resetTime: budget.resetTime,
      budgetResetAt: window.nextResetAt,
      lastBudgetResetAt: window.periodStartAt,
      periodStartAt: window.periodStartAt,
    };
  }

  return {
    allowed: true,
    dailyUsed: periodUsed,
    dailyLimit: activeLimitUsd,
    warningReached,
    remaining,
    periodUsed,
    activeLimitUsd,
    resetInterval: budget.resetInterval,
    resetTime: budget.resetTime,
    budgetResetAt: window.nextResetAt,
    lastBudgetResetAt: window.periodStartAt,
    periodStartAt: window.periodStartAt,
  };
}

/**
 * Get daily total cost for an API key.
 *
 * @param {string} apiKeyId
 * @returns {number} Total cost today in USD
 */
export function getDailyTotal(apiKeyId: string): number {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  try {
    return (
      sumEntries(toCostEntries(loadCostEntries(apiKeyId, todayStart.getTime()))) +
      spendBatchWriter.getPendingCostTotal(apiKeyId, todayStart.getTime())
    );
  } catch {
    return 0;
  }
}

/**
 * Get cost summary for an API key.
 *
 * @param {string} apiKeyId
 * @returns {BudgetSummary}
 */
export function getCostSummary(apiKeyId: string): BudgetSummary {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const budget = getBudget(apiKeyId);
  const window = budget ? getBudgetWindow(budget.resetInterval, budget.resetTime) : null;

  try {
    const dailyEntries = [
      ...toCostEntries(loadCostEntries(apiKeyId, todayStart.getTime())),
      ...spendBatchWriter.getBufferedEntries(apiKeyId, todayStart.getTime()),
    ];
    const monthlyEntries = [
      ...toCostEntries(loadCostEntries(apiKeyId, monthStart.getTime())),
      ...spendBatchWriter.getBufferedEntries(apiKeyId, monthStart.getTime()),
    ];
    const periodEntries =
      window !== null
        ? [
            ...toCostEntries(loadCostEntries(apiKeyId, window.periodStartAt)),
            ...spendBatchWriter.getBufferedEntries(apiKeyId, window.periodStartAt),
          ]
        : [];

    const dailyTotal = sumEntries(dailyEntries);
    const monthlyTotal = sumEntries(monthlyEntries);
    const costBasis = budget?.costBasis ?? "list";
    const periodTotal = sumEntries(periodEntries, costBasis);
    const activeLimitUsd = budget ? getActiveBudgetLimit(budget) : 0;

    return {
      dailyTotal,
      monthlyTotal,
      totalEntries: monthlyEntries.length,
      budget,
      totalCostToday: dailyTotal,
      totalCostMonth: monthlyTotal,
      totalCostPeriod: periodTotal,
      activeLimitUsd,
      resetInterval: budget?.resetInterval ?? null,
      resetTime: budget?.resetTime ?? null,
      budgetResetAt: window?.nextResetAt ?? budget?.budgetResetAt ?? null,
      lastBudgetResetAt: window?.periodStartAt ?? budget?.lastBudgetResetAt ?? null,
      periodStartAt: window?.periodStartAt ?? null,
      nextResetAt: window?.nextResetAt ?? null,
      dailyLimitUsd: budget?.dailyLimitUsd ?? 0,
      weeklyLimitUsd: budget?.weeklyLimitUsd ?? 0,
      monthlyLimitUsd: budget?.monthlyLimitUsd ?? 0,
      warningThreshold: budget?.warningThreshold ?? null,
      costBasis,
      cashCostToday: sumEntries(dailyEntries, "cash"),
      cashCostMonth: sumEntries(monthlyEntries, "cash"),
      cashCostPeriod: sumEntries(periodEntries, "cash"),
    };
  } catch {
    return {
      dailyTotal: 0,
      monthlyTotal: 0,
      totalEntries: 0,
      budget,
      totalCostToday: 0,
      totalCostMonth: 0,
      totalCostPeriod: 0,
      activeLimitUsd: budget ? getActiveBudgetLimit(budget) : 0,
      resetInterval: budget?.resetInterval ?? null,
      resetTime: budget?.resetTime ?? null,
      budgetResetAt: budget?.budgetResetAt ?? null,
      lastBudgetResetAt: budget?.lastBudgetResetAt ?? null,
      periodStartAt: budget?.lastBudgetResetAt ?? null,
      nextResetAt: budget?.budgetResetAt ?? null,
      dailyLimitUsd: budget?.dailyLimitUsd ?? 0,
      weeklyLimitUsd: budget?.weeklyLimitUsd ?? 0,
      monthlyLimitUsd: budget?.monthlyLimitUsd ?? 0,
      warningThreshold: budget?.warningThreshold ?? null,
      costBasis: budget?.costBasis ?? "list",
      cashCostToday: 0,
      cashCostMonth: 0,
      cashCostPeriod: 0,
    };
  }
}

/**
 * Clear all cost data (for testing).
 */
export function resetCostData() {
  budgets.clear();
  invalidateCashCapCache();
  resetSpendBatchWriterForTests();
  try {
    deleteAllCostData();
  } catch {
    // Non-critical.
  }
}

// ──────────────── Gateway-wide cash cap ────────────────

export interface CashCapStatus {
  /** A global budget with a positive limit exists. */
  active: boolean;
  limitUsd: number;
  usedUsd: number;
  /** Month total has reached the limit: every metered provider is unavailable. */
  capReached: boolean;
  /** Per-provider limit in USD (limit x share), or null when no share limit is set. */
  shareLimitUsd: number | null;
  /** Spend per provider this period (only providers recorded on cost entries). */
  providerUsedUsd: Record<string, number>;
  /** The status could not be read; metered providers are treated as unavailable (fail closed). */
  readError: boolean;
}

const CASH_CAP_CACHE_MS = 5_000;
let cashCapCache: { at: number; status: CashCapStatus } | null = null;

const INACTIVE_CAP: CashCapStatus = {
  active: false,
  limitUsd: 0,
  usedUsd: 0,
  capReached: false,
  shareLimitUsd: null,
  providerUsedUsd: {},
  readError: false,
};

export function invalidateCashCapCache(): void {
  cashCapCache = null;
}

/**
 * Status of the gateway-wide budget (apiKeyId "__global__"): this period's spend across every
 * key against its limit, plus spend per provider against the optional share limit. Cached for a
 * few seconds because it is read during account selection.
 */
export function getCashCapStatus(now = Date.now()): CashCapStatus {
  if (cashCapCache && now - cashCapCache.at < CASH_CAP_CACHE_MS) return cashCapCache.status;
  let status: CashCapStatus;
  try {
    const budget = getBudget(GLOBAL_BUDGET_ID);
    const limitUsd = budget ? getActiveBudgetLimit(budget) : 0;
    if (!budget || limitUsd <= 0) {
      status = INACTIVE_CAP;
    } else {
      const window = getBudgetWindow(budget.resetInterval, budget.resetTime, now);
      const pending = spendBatchWriter.getBufferedEntries(GLOBAL_BUDGET_ID, window.periodStartAt);
      const usedUsd =
        loadCostTotal(GLOBAL_BUDGET_ID, window.periodStartAt, budget.costBasis) +
        pending.reduce((sum, e) => sum + entryAmount(e, budget.costBasis), 0);
      const providerUsedUsd: Record<string, number> = {};
      for (const [provider, total] of loadCostByProvider(window.periodStartAt, budget.costBasis)) {
        providerUsedUsd[provider] = total;
      }
      for (const entry of pending) {
        const provider = normalizeCostProvider(entry.provider);
        if (!provider) continue;
        providerUsedUsd[provider] =
          (providerUsedUsd[provider] || 0) + entryAmount(entry, budget.costBasis);
      }
      status = {
        active: true,
        limitUsd,
        usedUsd,
        capReached: usedUsd >= limitUsd,
        shareLimitUsd: budget.providerShareLimit ? limitUsd * budget.providerShareLimit : null,
        providerUsedUsd,
        readError: false,
      };
    }
  } catch (error) {
    console.warn(
      `[CashCap] could not read the gateway-wide budget; metered providers are held until it can be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    status = { ...INACTIVE_CAP, active: true, capReached: true, readError: true };
  }
  cashCapCache = { at: now, status };
  return status;
}

/**
 * True when a METERED connection of this provider must not be used: the gateway-wide cap is
 * reached, or this provider alone has used its share. Callers check this only for connections
 * whose cash class is metered; subscription, free and local connections cost no cash and are
 * never held by the cap.
 */
export function isProviderCashCapped(provider: string, now = Date.now()): boolean {
  const status = getCashCapStatus(now);
  if (!status.active) return false;
  if (status.capReached) return true;
  const id = normalizeCostProvider(provider);
  return (
    status.shareLimitUsd !== null &&
    !!id &&
    (status.providerUsedUsd[id] || 0) >= status.shareLimitUsd
  );
}
