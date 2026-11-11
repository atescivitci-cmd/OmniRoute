/**
 * Internal replay sentinel used when an upstream requires non-empty reasoning content but the
 * original reasoning summary is unavailable. It is valid request scaffolding, never user-visible
 * reasoning, so response translators must suppress it before emitting client-facing events.
 */
export const NON_ANTHROPIC_THINKING_PLACEHOLDER = "(prior reasoning summary unavailable)";

export function isInternalReasoningPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.trim() === NON_ANTHROPIC_THINKING_PLACEHOLDER;
}

/**
 * Strip the internal placeholder from user-visible content. Models sometimes
 * echo the sentinel through ordinary `message.content` / `delta.content`
 * (#8081). Removes all occurrences; when a marker was present and only
 * whitespace remains, callers can skip that complete value entirely.
 *
 * IMPORTANT (#5786): this runs per-delta on the streaming path, where a delta's
 * leading/trailing spaces are meaningful (e.g. "Hello, " + "world." + " Bye.").
 * Only collapse to "" when the placeholder WAS the whole content — never trim
 * real content, or streamed deltas glue together with their spaces eaten.
 */
export function stripInternalReasoningPlaceholder(value: string): string {
  if (!value.includes(NON_ANTHROPIC_THINKING_PLACEHOLDER)) return value;
  const stripped = value.replaceAll(NON_ANTHROPIC_THINKING_PLACEHOLDER, "");
  return stripped.trim() === "" ? "" : stripped;
}

export interface ReasoningPlaceholderStreamState {
  pending: string;
}

export function createReasoningPlaceholderStreamState(): ReasoningPlaceholderStreamState {
  return { pending: "" };
}

/** Remove exact markers across text deltas without changing any other character.
 * Only an unfinished marker prefix is retained, bounded by marker.length - 1.
 * State belongs to one response/text span, never to a provider or shared module.
 */
export function stripStreamingReasoningPlaceholder(
  value: string,
  state: ReasoningPlaceholderStreamState
): string {
  const marker = NON_ANTHROPIC_THINKING_PLACEHOLDER;
  const combined = state.pending + value;
  let visible = "";
  let cursor = 0;
  let index: number;
  while ((index = combined.indexOf(marker, cursor)) !== -1) {
    visible += combined.slice(cursor, index);
    cursor = index + marker.length;
  }
  // Search the remaining RAW suffix, not text joined across a removed marker.
  // Otherwise filtering can accidentally remove a newly formed literal marker.
  const tail = combined.slice(cursor);
  let held = Math.min(tail.length, marker.length - 1);
  while (held > 0 && !marker.startsWith(tail.slice(-held))) held--;
  state.pending = held > 0 ? tail.slice(-held) : "";
  return visible + tail.slice(0, tail.length - held);
}

/** Flush a literal unfinished prefix before completion or a text/tool boundary. */
export function flushStreamingReasoningPlaceholder(state: ReasoningPlaceholderStreamState): string {
  const pending = state.pending;
  state.pending = "";
  return pending;
}
