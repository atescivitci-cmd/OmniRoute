/**
 * chatCore failed-request usage record builder (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Pure core of handleChatCore's persistFailureUsage closure: builds the usage-history entry for a
 * failed request (zeroed tokens/timing, success:false, the unknown/undefined fallbacks, and the
 * combo-strategy gate). The handler keeps the impure parts byte-identically: it computes
 * `latencyMs` (Date.now() - startTime) and fires the fire-and-forget saveRequestUsage(...).catch().
 */

export function buildFailureUsageRecord(opts: {
  provider: string | null | undefined;
  model: string | null | undefined;
  connectionId: string | null | undefined;
  apiKeyInfo: { id?: string; name?: string } | null | undefined;
  effectiveServiceTier: string;
  isCombo: boolean;
  comboStrategy: string | null | undefined;
  statusCode: number;
  errorCode: string | null | undefined;
  latencyMs: number;
  endpoint?: string | null | undefined;
  /**
   * Usage the provider reported for a response that was received but rejected afterwards (for
   * example a 200 with no usable output). The provider billed those tokens, so the failure row
   * carries them. Absent: zeroed, as for every failure that produced no response.
   */
  tokens?: object | null;
}) {
  return {
    provider: opts.provider || "unknown",
    model: opts.model || "unknown",
    tokens:
      opts.tokens && typeof opts.tokens === "object"
        ? opts.tokens
        : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 },
    status: String(opts.statusCode),
    success: false,
    latencyMs: opts.latencyMs,
    timeToFirstTokenMs: 0,
    errorCode: opts.errorCode || String(opts.statusCode),
    timestamp: new Date().toISOString(),
    connectionId: opts.connectionId || undefined,
    apiKeyId: opts.apiKeyInfo?.id || undefined,
    apiKeyName: opts.apiKeyInfo?.name || undefined,
    serviceTier: opts.effectiveServiceTier,
    comboStrategy: opts.isCombo ? opts.comboStrategy || undefined : undefined,
    endpoint: opts.endpoint || undefined,
  };
}
