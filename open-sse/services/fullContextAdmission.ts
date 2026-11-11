import { estimateTokens } from "./contextManager.ts";
import { adaptBodyForCompression } from "./compression/bodyAdapter.ts";
import { OUTPUT_TOKEN_FIELDS } from "../handlers/chatCore/outputTokenBudget.ts";

/** Shared pre-dispatch estimate; no request content is removed or rewritten. */
export const estimateFullInputTokens = (requestBody: Record<string, unknown> | null | undefined) => {
    const adapted = requestBody
      ? adaptBodyForCompression(requestBody as Record<string, unknown>).body
      : null;
    const messages =
      adapted?.messages ||
      requestBody?.contents ||
      (requestBody?.request as { contents?: unknown } | undefined)?.contents ||
      (Array.isArray(requestBody?.input)
        ? requestBody.input
        : requestBody?.input && typeof requestBody.input === "object"
          ? requestBody.input
          : []);
    return (
      estimateTokens(messages as Parameters<typeof estimateTokens>[0]) +
      (Array.isArray(requestBody?.tools) ? estimateTokens(requestBody.tools) : 0) +
      estimateTokens(requestBody?.system as Parameters<typeof estimateTokens>[0]) +
      estimateTokens(requestBody?.instructions as Parameters<typeof estimateTokens>[0])
    );
  };

/** Matches the exact workflow whose chatCore path restores the complete request. */
export function retainsFullContext(comboName: string | null | undefined): boolean {
  return comboName === "ac-terminal-continuity";
}

/** Reserve the requested generation budget, respecting the same explicit model output cap
 * as final enforcement. No request budget means at least one output token must fit.
 * Invalid numeric fields are ignored just as final enforcement removes them.
 */
export function requestedOutputReserve(body: Record<string, unknown>, outputCap?: number | null): number {
  const requested = Math.max(1, ...OUTPUT_TOKEN_FIELDS.map((field) => {
    const value = body[field];
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value) : 0;
  }));
  const cap = outputCap == null ? 0 : Math.floor(outputCap);
  return cap > 0 ? Math.min(requested, cap) : requested;
}
