/**
 * Quality-first ranking: the "broken right now" exclusion (ROUTING_QUALITY_FIRST, pure, DB-free).
 *
 * Under quality-first ranking usage history never adds to or subtracts from a score. It may only
 * EXCLUDE a model that is broken right now, and every exclusion lifts on its own:
 *   - provider circuit breaker OPEN          (excluded in rankFitFirstFreeCandidates, as on base)
 *   - model lockout / cooldown active         (accountFallback.isModelLocked; lifts with the lockout)
 *   - provider cooldown active                (only while resilience provider cooldown is enabled)
 *   - BROKEN_NOW_MIN_FAILURES or more real failures of the provider/model in the last
 *     BROKEN_NOW_WINDOW_MS (lifts when the failures age out of the window)
 *
 * A "real" failure is a failed usage row whose cause is the upstream model or provider. Not
 * counted: client disconnects (error_code client_disconnected or HTTP 499: the client left) and
 * gateway errors (post_processing_error: the gateway threw after the model answered;
 * routing_transport_replay_blocked: the gateway refused to replay). Deadlines (routing_deadline,
 * probe_deadline, upstream_stalled from ROUTING_STALL_DEADLINE_MS) count: the model did not answer
 * in time. With ROUTING_CANARY_NOT_EVIDENCE on, routing-canary rows are not read at all.
 */
import { USAGE_SOURCE_ROUTING_CANARY } from "../../../src/shared/constants/usageSource.ts";

export const BROKEN_NOW_WINDOW_MS = 30 * 60_000;
export const BROKEN_NOW_MIN_FAILURES = 3;

/** Failure codes that describe the client or the gateway, not the model. */
export const NOT_A_MODEL_FAILURE_CODES = new Set([
  "client_disconnected",
  "post_processing_error",
  "routing_transport_replay_blocked",
]);

export interface RecentOutcomeRow {
  provider: string;
  model: string;
  success: boolean;
  errorCode: string | null;
  status?: string | number | null;
  source: string | null;
  timestamp: string;
}

export function isRealModelFailure(row: RecentOutcomeRow): boolean {
  if (row.success) return false;
  if (row.errorCode && NOT_A_MODEL_FAILURE_CODES.has(row.errorCode)) return false;
  if (String(row.status ?? "") === "499") return false;
  return true;
}

/** Real failures per `provider/model` inside the window ending at `now`. */
export function countRecentRealFailures(
  rows: RecentOutcomeRow[],
  options: { now?: number; windowMs?: number; excludeRoutingCanary?: boolean } = {}
): Map<string, number> {
  const now = options.now ?? Date.now();
  const since = now - (options.windowMs ?? BROKEN_NOW_WINDOW_MS);
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (options.excludeRoutingCanary && row.source === USAGE_SOURCE_ROUTING_CANARY) continue;
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at) || at < since || at > now) continue;
    if (!isRealModelFailure(row)) continue;
    const key = `${row.provider}/${row.model}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export type BrokenNowReason =
  "broken_now_recent_failures" | "broken_now_model_lockout" | "broken_now_provider_cooldown";

export interface BrokenNow {
  reason: BrokenNowReason;
  recentRealFailures?: number;
  windowMinutes?: number;
}

export function brokenNowFor(args: {
  recentRealFailures: number;
  modelLocked: boolean;
  providerCooldown: boolean;
}): BrokenNow | null {
  if (args.modelLocked) return { reason: "broken_now_model_lockout" };
  if (args.providerCooldown) return { reason: "broken_now_provider_cooldown" };
  if (args.recentRealFailures >= BROKEN_NOW_MIN_FAILURES) {
    return {
      reason: "broken_now_recent_failures",
      recentRealFailures: args.recentRealFailures,
      windowMinutes: BROKEN_NOW_WINDOW_MS / 60_000,
    };
  }
  return null;
}
