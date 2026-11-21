/**
 * Pure, stateless helpers extracted from usageHistory.ts.
 * No DB access, no module-level state — safe to import anywhere.
 */

// #7879: re-export the canonical helper so existing consumers of this module
// keep importing `toNumber` from here unchanged.
export { toNumber } from "@/shared/utils/numeric";

type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function normalizeServiceTier(value: unknown): string {
  const tier = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (tier === "priority" || tier === "fast") return "priority";
  if (tier === "flex") return "flex";
  return "standard";
}

export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const bounded = Math.max(0, Math.min(1, p));
  const idx = Math.round((sortedValues.length - 1) * bounded);
  return sortedValues[idx] ?? sortedValues[sortedValues.length - 1];
}

export function stdDev(values: number[], avg: number): number {
  if (values.length <= 1) return 0;
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

export function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((acc, n) => acc + n, 0) / values.length : 0;
}

/** Resolve a positive-numeric option, falling back when unset/non-finite/<=0. */
export function resolvePositiveOption(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Per-key accumulator buckets used by getModelLatencyStats() (#6875). */
export interface LatencySampleBuckets {
  successfulLatencies: number[];
  allLatencies: number[];
  successfulTtfts: number[];
  allTtfts: number[];
  successfulTps: number[];
  allTps: number[];
}

/**
 * Push one usage_history row's latency/TTFT/tokens-per-second sample into the
 * accumulator buckets. Guards divide-by-zero by only deriving a tokens/sec
 * sample when both latencyMs and tokensOutput are positive; rows with
 * latencyMs <= 0 are skipped entirely, mirroring the pre-existing
 * allLatencies/successfulLatencies guard.
 */
export function accumulateLatencySample(
  buckets: LatencySampleBuckets,
  latencyMs: number,
  ttftMs: number,
  tokensOutput: number,
  isSuccess: boolean
): void {
  if (latencyMs <= 0) return;
  buckets.allLatencies.push(latencyMs);
  if (ttftMs > 0) buckets.allTtfts.push(ttftMs);
  if (tokensOutput > 0) buckets.allTps.push(tokensOutput / (latencyMs / 1000));
  if (!isSuccess) return;
  buckets.successfulLatencies.push(latencyMs);
  if (ttftMs > 0) buckets.successfulTtfts.push(ttftMs);
  if (tokensOutput > 0) buckets.successfulTps.push(tokensOutput / (latencyMs / 1000));
}

/** Per-provider/model accumulator for getModelLatencyStats() (#6875). */
export interface LatencyBucket extends LatencySampleBuckets {
  provider: string;
  model: string;
  totalRequests: number;
  successfulRequests: number;
}

export function createLatencyBucket(provider: string, model: string): LatencyBucket {
  return {
    provider,
    model,
    totalRequests: 0,
    successfulRequests: 0,
    successfulLatencies: [],
    allLatencies: [],
    successfulTtfts: [],
    allTtfts: [],
    successfulTps: [],
    allTps: [],
  };
}

/**
 * A `client_disconnected` row shorter than this is a client leaving, not evidence about the model.
 *
 * The streaming pipeline writes `client_disconnected` for every close before completion, whoever
 * closed it. Live (2026-11-21): a Claude terminal session's two rows lasted 2.7 s and 3.1 s with no
 * output (a user interrupt), while every NVIDIA row over seven days lasted 40 s or longer (real
 * provider stalls cut by a deadline). The ranking's reliability evidence skips the short ones
 * (`excludeClientAbandons`) so pressing Escape does not lower a model's score; long ones keep
 * counting. One threshold for every provider and model.
 */
export const CLIENT_ABANDON_MAX_MS = 10_000;

/** True for a stream a client closed within seconds of starting it (see CLIENT_ABANDON_MAX_MS). */
export function isClientAbandon(errorCode: unknown, latencyMs: unknown): boolean {
  if (errorCode !== "client_disconnected") return false;
  // A row with no recorded duration (null, undefined, blank, boolean) says nothing about how long
  // the stream ran, so it is not shown to be short: it keeps counting. (Number(null) is 0 and
  // Number("") is 0, which would otherwise read as an instant close.)
  if (typeof latencyMs !== "number" && typeof latencyMs !== "string") return false;
  if (typeof latencyMs === "string" && latencyMs.trim() === "") return false;
  const ms = typeof latencyMs === "number" ? latencyMs : Number(latencyMs);
  return Number.isFinite(ms) && ms >= 0 && ms < CLIENT_ABANDON_MAX_MS;
}

/** Aggregate view returned per provider/model key by getModelLatencyStats(). */
export interface ModelLatencyStatsEntry {
  provider: string;
  model: string;
  key: string;
  totalRequests: number;
  successfulRequests: number;
  successRate: number; // 0..1
  /** Distinguishes successful delivery timing from the legacy diagnostic fallback. */
  latencySampleSource: "successful" | "all_attempts";
  latencySampleCount: number;
  successfulLatencySampleCount: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  latencyStdDev: number;
  windowHours: number;
  /** Mean time-to-first-token (ms) across the same sample set as avgLatencyMs. */
  avgTtftMs: number;
  /**
   * End-to-end latency (ms). Aliases avgLatencyMs: usage_history has no
   * distinct second latency column beyond latency_ms/ttft_ms, so latency_ms
   * already represents the full request wall-clock time (#6875).
   */
  avgE2ELatencyMs: number;
  /** Mean output tokens/sec across successful rows (tokens_output / (latency_ms/1000)). */
  avgTokensPerSecond: number;
}

/**
 * Reduce one accumulator bucket into its final ModelLatencyStatsEntry, or
 * null when the effective sample count is below minSamples. Falls back from
 * successful-only to all-sample data for latency/TTFT/tokens-per-second
 * consistently for API diagnostics (mirrors the pre-existing avgLatencyMs
 * fallback behavior). Consumers must check latencySampleSource before treating
 * these timings as evidence of successful delivery.
 */
export function buildLatencyStatsEntry(
  key: string,
  bucket: LatencyBucket,
  minSamples: number,
  windowHours: number
): ModelLatencyStatsEntry | null {
  const useSuccessful = bucket.successfulLatencies.length >= minSamples;
  const baseLatencies = useSuccessful ? bucket.successfulLatencies : bucket.allLatencies;
  if (baseLatencies.length < minSamples) return null;

  const baseTtfts = useSuccessful ? bucket.successfulTtfts : bucket.allTtfts;
  const baseTps = useSuccessful ? bucket.successfulTps : bucket.allTps;

  const sorted = [...baseLatencies].sort((a, b) => a - b);
  const avg = mean(sorted);
  const successRate =
    bucket.totalRequests > 0 ? bucket.successfulRequests / bucket.totalRequests : 0;

  return {
    provider: bucket.provider,
    model: bucket.model,
    key,
    totalRequests: bucket.totalRequests,
    successfulRequests: bucket.successfulRequests,
    successRate,
    latencySampleSource: useSuccessful ? "successful" : "all_attempts",
    latencySampleCount: baseLatencies.length,
    successfulLatencySampleCount: bucket.successfulLatencies.length,
    avgLatencyMs: Math.round(avg),
    p50LatencyMs: Math.round(percentile(sorted, 0.5)),
    p95LatencyMs: Math.round(percentile(sorted, 0.95)),
    p99LatencyMs: Math.round(percentile(sorted, 0.99)),
    latencyStdDev: Math.round(stdDev(sorted, avg)),
    windowHours,
    avgTtftMs: Math.round(mean(baseTtfts)),
    avgE2ELatencyMs: Math.round(avg),
    avgTokensPerSecond: Math.round(mean(baseTps) * 100) / 100,
  };
}

export const MAX_PREVIEW_DEPTH = 6;
export const MAX_PREVIEW_STRING = 1200;
export const MAX_PREVIEW_ARRAY_ITEMS = 12;
export const MAX_PREVIEW_OBJECT_KEYS = 24;

export function truncatePendingPreview(value: unknown, depth = 0): unknown {
  if (depth >= MAX_PREVIEW_DEPTH) {
    return "[TRUNCATED_DEPTH]";
  }

  if (typeof value === "string") {
    return value.length > MAX_PREVIEW_STRING ? `${value.slice(0, MAX_PREVIEW_STRING)}...` : value;
  }

  if (Array.isArray(value)) {
    const preview = value
      .slice(0, MAX_PREVIEW_ARRAY_ITEMS)
      .map((item) => truncatePendingPreview(item, depth + 1));
    if (value.length > MAX_PREVIEW_ARRAY_ITEMS) {
      preview.push({ _truncatedItems: value.length - MAX_PREVIEW_ARRAY_ITEMS });
    }
    return preview;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value as JsonRecord);
  const truncatedEntries = entries
    .slice(0, MAX_PREVIEW_OBJECT_KEYS)
    .map(([key, entryValue]) => [key, truncatePendingPreview(entryValue, depth + 1)]);
  const preview = Object.fromEntries(truncatedEntries);

  if (entries.length > MAX_PREVIEW_OBJECT_KEYS) {
    preview._truncatedKeys = entries.length - MAX_PREVIEW_OBJECT_KEYS;
  }

  return preview;
}
