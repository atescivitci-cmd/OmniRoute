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
 * Lift fully representable text-only system records, including after ordinary
 * content-bearing user/assistant turns (Claude Code appends deferred tool catalogs).
 * Empty/directive/unknown records remain ordering barriers; do not hoist across
 * their potentially position-dependent semantics.
 * Unknown content or message-level semantics leave the entire body unchanged;
 * this narrow protocol adaptation is not a general validator or content filter.
 */
export function normalizeClaudeSafeguardsInitialSystem(body: UnknownRecord): UnknownRecord {
  const normalized = structuredClone(body);
  if (!Array.isArray(normalized.messages)) return normalized;

  const messages = normalized.messages;
  const lifted: UnknownRecord[] = [];
  const retained: unknown[] = [];
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

  // Do not move system text across opaque future directives or malformed blocks.
  // These checks recognize ordinary history; they never prune or rewrite it.
  const ordinaryContent = (content: unknown): boolean => {
    if (typeof content === "string") return content.length > 0;
    if (!Array.isArray(content) || content.length === 0) return false;
    return content.every((block) => {
      if (!isRecord(block)) return false;
      switch (block.type) {
        case "text":
          return typeof block.text === "string" && block.text.length > 0;
        case "image":
        case "document":
          return isRecord(block.source);
        case "thinking":
          return typeof block.thinking === "string" && typeof block.signature === "string";
        case "redacted_thinking":
          return typeof block.data === "string";
        case "tool_use":
          return (
            typeof block.id === "string" && typeof block.name === "string" && isRecord(block.input)
          );
        case "tool_result":
          return (
            typeof block.tool_use_id === "string" &&
            (block.content === undefined ||
              typeof block.content === "string" ||
              Array.isArray(block.content))
          );
        default:
          return false;
      }
    });
  };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isRecord(message)) {
      retained.push(...messages.slice(index));
      break;
    }
    const content = message.content;
    const emptyContent =
      content === undefined || content === "" || (Array.isArray(content) && content.length === 0);
    if (message.role !== "system") {
      retained.push(message);
      const ordinaryTurn =
        (message.role === "user" || message.role === "assistant") &&
        ordinaryContent(content) &&
        Object.keys(message).every((key) => key === "role" || key === "content");
      if (!ordinaryTurn) {
        retained.push(...messages.slice(index + 1));
        break;
      }
      continue;
    }
    if (emptyContent) {
      retained.push(...messages.slice(index));
      break;
    }
    // Removing this message would lose semantics that cannot be represented by system text.
    if (Object.keys(message).some((key) => key !== "role" && key !== "content")) return normalized;
    const blocks = textBlocks(content);
    if (!blocks || blocks.length === 0) return normalized;
    lifted.push(...blocks);
  }
  if (lifted.length === 0) return normalized;

  const existing = normalized.system;
  const existingBlocks = existing === undefined ? [] : textBlocks(existing);
  if (!existingBlocks) return normalized;
  normalized.system = [...existingBlocks, ...lifted];
  normalized.messages = retained;
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
