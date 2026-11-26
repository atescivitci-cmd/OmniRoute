/**
 * chatCore non-streaming usage-stats persistence (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501 — response-handling slice of executeProviderRequest).
 *
 * Extracted from handleChatCore's non-streaming success path: records per-request usage analytics
 * for a successful non-streaming response — an optional trace console line, the fire-and-forget
 * `saveRequestUsage` row, and the per-api-key billable-token counter. Side-effect only (no handler
 * state is mutated, nothing is returned); best-effort, every write swallows its own errors. The
 * per-request context is threaded via `ctx` so the call site stays byte-identical; behaviour is
 * unchanged.
 */

import { saveRequestUsage } from "@/lib/usageDb";
import { formatUsageLog } from "@/lib/usage/tokenAccounting";
import { COLORS } from "../../utils/stream.ts";
import { recordTokenUsage } from "../../services/tokenLimitCounter.ts";
import { computeBillableTokens } from "./upstreamTimeouts.ts";
import { type EffectiveServiceTier } from "./serviceTier.ts";

export type RecordNonStreamingUsageStatsContext = {
  traceEnabled: boolean;
  provider: string | null | undefined;
  connectionId: string | null | undefined;
  model: string | null | undefined;
  startTime: number;
  apiKeyInfo: { id?: string | null; name?: string | null } | null | undefined;
  effectiveServiceTier: EffectiveServiceTier;
  isCombo: boolean;
  comboStrategy: string | null | undefined;
  endpoint?: string | null | undefined;
  /**
   * When the provider's answer arrived. The usage row is timed from it, so a row written after the
   * response was translated and validated still records the provider latency. Default: now.
   */
  endTime?: number;
  /**
   * Skip the usage row here: the caller writes it with persistNonStreamingUsageRow once the
   * response is known to be usable, or writes the failure row instead (2026-11-26: a 200 that
   * translated into no usable output was recorded as a success AND as a failure).
   */
  deferUsageRow?: boolean;
};

function logUsageTrace(
  usage: object,
  provider: string | null | undefined,
  connectionId: string | null | undefined
): void {
  const msg = `[${new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}] 📊 [USAGE] ${provider?.toUpperCase()} | ${formatUsageLog(usage)}${connectionId ? ` | account=${connectionId.slice(0, 8)}...` : ""}`;
  console.log(`${COLORS.green}${msg}${COLORS.reset}`);
}

function persistUsageRow(usage: object, ctx: RecordNonStreamingUsageStatsContext): void {
  const { provider, connectionId, model, startTime, apiKeyInfo, effectiveServiceTier } = ctx;
  const endTime = ctx.endTime ?? Date.now();
  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: usage,
    status: "200",
    success: true,
    latencyMs: endTime - startTime,
    timeToFirstTokenMs: endTime - startTime,
    errorCode: null,
    timestamp: new Date(endTime).toISOString(),
    connectionId: connectionId || undefined,
    apiKeyId: apiKeyInfo?.id || undefined,
    apiKeyName: apiKeyInfo?.name || undefined,
    serviceTier: effectiveServiceTier,
    comboStrategy: ctx.isCombo ? ctx.comboStrategy || undefined : undefined,
    endpoint: ctx.endpoint || undefined,
  }).catch((err) => {
    console.error("Failed to save usage stats:", err.message);
  });
}

function recordBillableTokens(
  usage: object,
  apiKeyInfo: RecordNonStreamingUsageStatsContext["apiKeyInfo"],
  provider: string | null | undefined,
  model: string | null | undefined
): void {
  if (!apiKeyInfo?.id) return;
  try {
    const billable = computeBillableTokens(usage);
    if (billable > 0)
      recordTokenUsage(apiKeyInfo.id, provider || "unknown", model || "unknown", billable);
  } catch {
    // never block the response on counter recording
  }
}

export function recordNonStreamingUsageStats(
  usage: unknown,
  ctx: RecordNonStreamingUsageStatsContext
): void {
  if (!usage || typeof usage !== "object") return;

  if (ctx.traceEnabled) logUsageTrace(usage, ctx.provider, ctx.connectionId);
  if (!ctx.deferUsageRow) persistUsageRow(usage, ctx);
  recordBillableTokens(usage, ctx.apiKeyInfo, ctx.provider, ctx.model);
}

/** Write the deferred success row (see `deferUsageRow`). Same guard and fields as before. */
export function persistNonStreamingUsageRow(
  usage: unknown,
  ctx: RecordNonStreamingUsageStatsContext
): void {
  if (!usage || typeof usage !== "object") return;
  persistUsageRow(usage, ctx);
}
