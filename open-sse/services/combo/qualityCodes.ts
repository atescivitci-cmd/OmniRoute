// Stable machine codes for the two content-shape verdicts of validateResponseQuality.
//
// Kept in a leaf module so the attempt guard can recognise them without importing the
// validator (and without matching human-readable `reason` strings). Only these two are
// eligible for the one-retry quality failover: both mean "the upstream answered 200 but
// delivered no visible assistant output and requested no tool call", so nothing the client
// could observe or any side effect depends on the withheld response.
export const QUALITY_CODE_EMPTY_CONTENT = "empty_content";
export const QUALITY_CODE_REASONING_EXHAUSTED = "reasoning_exhausted";

export const CONTENT_SHAPE_QUALITY_CODES: ReadonlySet<string> = new Set([
  QUALITY_CODE_EMPTY_CONTENT,
  QUALITY_CODE_REASONING_EXHAUSTED,
]);

/** Counts and the finish marker only. Never message content, reasoning text or request data. */
export type QualityDiagnostics = {
  finishReason?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
};

export type QualityRejection = {
  /** Stable code; present only for the content-shape verdicts. */
  code?: string;
  /** Free-form reason. May embed upstream text for non-content-shape verdicts; log with care. */
  reason?: string;
  diagnostics?: QualityDiagnostics;
};

const classOf = (reason?: string): string =>
  (reason ?? "unknown").split(":")[0].replace(/\s+/g, "_").slice(0, 60);
const safeToken = (value?: string | null): string =>
  typeof value === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : "n/a";
const num = (value: number | null | undefined): string =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";

/**
 * One log line for a quality-rejected 200. Carries the code (or, for non-content-shape verdicts,
 * only the reason's leading class so upstream error text never reaches the log), the target, the
 * finish marker and token counts. Never response or request content.
 */
export function formatQualityRejectionLog(args: {
  quality: QualityRejection;
  provider?: string | null;
  model: string;
  outcome: string;
}): string {
  const { quality, provider, model, outcome } = args;
  const d = quality.diagnostics;
  return (
    `Quality rejection of HTTP 200 (${outcome}): reason=${quality.code ?? classOf(quality.reason)}` +
    ` provider=${provider || "unknown"} model=${model}` +
    ` finish_reason=${safeToken(d?.finishReason)} prompt_tokens=${num(d?.promptTokens)}` +
    ` completion_tokens=${num(d?.completionTokens)} reasoning_tokens=${num(d?.reasoningTokens)}`
  );
}
