import { FORMATS } from "../../translator/formats.ts";

type UnknownRecord = Record<string, unknown>;

export function hasServerSafeguards(
  body: unknown
): body is UnknownRecord & { safeguards: unknown } {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, "safeguards")
  );
}

export function hasSafeguardResults(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.prototype.hasOwnProperty.call(payload as UnknownRecord, "safeguard_results")
  );
}

export function supportsClaudeServerSafeguards(provider: string, targetFormat: string): boolean {
  return provider === "claude" && targetFormat === FORMATS.CLAUDE;
}

/**
 * Native Messages carries system text at the top level, not as a chat role.
 * Lift only a contiguous, fully representable initial text-only system prefix.
 * Empty/directive records end the prefix and remain untouched, regardless of role.
 * Unknown content or message-level semantics leave the entire body unchanged;
 * this narrow protocol adaptation is not a general validator or content filter.
 */
export function normalizeClaudeSafeguardsInitialSystem(body: UnknownRecord): UnknownRecord {
  const normalized = structuredClone(body);
  if (!Array.isArray(normalized.messages)) return normalized;

  const messages = normalized.messages;
  const lifted: UnknownRecord[] = [];
  let prefixLength = 0;
  const isRecord = (value: unknown): value is UnknownRecord =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const textBlocks = (content: unknown): UnknownRecord[] | null => {
    if (typeof content === "string")
      return content.length > 0 ? [{ type: "text", text: content }] : [];
    if (!Array.isArray(content)) return null;
    return content.every(
      (block) =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0
    )
      ? content
      : null;
  };

  for (const message of messages) {
    if (!isRecord(message) || message.role !== "system") break;
    const content = message.content;
    if (content === undefined || content === "" || (Array.isArray(content) && content.length === 0))
      break;
    // Removing this message would lose semantics that cannot be represented by system text.
    if (Object.keys(message).some((key) => key !== "role" && key !== "content")) return normalized;
    const blocks = textBlocks(content);
    if (!blocks || blocks.length === 0) return normalized;
    lifted.push(...blocks);
    prefixLength++;
  }
  if (prefixLength === 0) return normalized;

  const existing = normalized.system;
  const existingBlocks = existing === undefined ? [] : textBlocks(existing);
  if (!existingBlocks) return normalized;
  normalized.system = [...existingBlocks, ...lifted];
  normalized.messages = messages.slice(prefixLength);
  return normalized;
}

/**
 * Relay a native Claude safeguards response without parsing, translating, or
 * rebuilding its payload. The wrapper observes only stream lifecycle so
 * request bookkeeping can finish without changing chunk bytes or ordering.
 */
export function relayClaudeServerSafeguardsResponse(
  response: Response,
  onFinalize: () => void
): Response {
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    onFinalize();
  };
  if (!response.body) {
    finalize();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  }

  const reader = response.body.getReader();
  const relayedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finalize();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finalize();
      }
    },
  });

  return new Response(relayedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}
