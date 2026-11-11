import { FORMATS } from "../../translator/formats.ts";
import { isClaudeCodeCompatibleProvider } from "../../services/claudeCodeCompatible.ts";
import { getHeaderValueCaseInsensitive } from "./headers.ts";

export function shouldUseNativeCodexPassthrough({
  provider,
  sourceFormat,
  endpointPath,
}: {
  provider?: string | null;
  sourceFormat?: string | null;
  endpointPath?: string | null;
}): boolean {
  if (provider !== "codex") return false;
  if (sourceFormat !== FORMATS.OPENAI_RESPONSES) return false;
  let normalizedEndpoint = String(endpointPath || "");
  while (normalizedEndpoint.endsWith("/")) normalizedEndpoint = normalizedEndpoint.slice(0, -1);
  const segments = normalizedEndpoint.split("/");
  return segments.includes("responses");
}

/**
 * Pass `thinking` / `redacted_thinking` blocks through UNCHANGED.
 *
 * This used to rewrite every assistant thinking block to `redacted_thinking`
 * carrying a synthetic signature, on the assumption that a thinking signature is
 * bound to the auth token that produced it and would be rejected after a token /
 * model switch with 400 "Invalid signature in thinking block" (issue #2454).
 *
 * That rewrite is the actual cause of a different, far more common failure on the
 * Anthropic-native Claude OAuth passthrough:
 *
 *   400 messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
 *   latest assistant message cannot be modified. These blocks must remain as
 *   they were in the original response.
 *
 * The Messages API validates submitted thinking blocks against the original
 * response and rejects ANY modification to a genuine block — so converting
 * signed blocks to `redacted_thinking` makes multi-turn requests fail (most
 * visible on long Claude Code tool-loops). The thinking-block signature is
 * validated server-side by Anthropic and stays valid when the blocks are replayed,
 * including under a different OAuth token — verified by preserving the blocks
 * across a mid-conversation account switch with zero "Invalid signature"
 * responses. The redaction is therefore both unnecessary and the cause of the
 * regression, so valid signed blocks are returned verbatim. Unsigned blocks are
 * dropped before replay; in an open extended-thinking tool cycle the sanitizer
 * inserts the same non-empty `redacted_thinking` precursor used by the request
 * translator, before the first `tool_use`.
 */
export function redactPassthroughThinkingSignatures(
  messages: unknown,
  signature: string,
  thinking?: unknown
): unknown {
  return dropUnsignedPassthroughThinkingBlocks(messages, signature, thinking);
}

type MessageLike = {
  role?: unknown;
  content?: unknown;
};

function isUnsignedThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const { type, signature, data } = block as {
    type?: unknown;
    signature?: unknown;
    data?: unknown;
  };
  const hasText = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  if (type === "thinking") return !hasText(signature);
  if (type === "redacted_thinking") return !hasText(data);
  return false;
}

function openToolCycleAssistantIndexes(messages: MessageLike[]): Set<number> {
  const open = new Set<number>();
  if (messages.length === 0) return open;
  const last = messages[messages.length - 1];
  if (!(
    (last?.role === "user" && hasBlock(last, "tool_result")) ||
    (last?.role === "assistant" && hasBlock(last, "tool_use"))
  )) {
    return open;
  }

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && !hasBlock(message, "tool_result")) break;
    if (message?.role === "assistant" && hasBlock(message, "tool_use")) open.add(index);
  }
  return open;
}

/**
 * Remove only unsigned assistant thinking blocks. When one is removed from an
 * assistant tool-use turn that remains open and thinking is enabled, retain the
 * required precursor with the established non-empty redacted-thinking payload.
 * Never mutates the caller's messages.
 */
export function dropUnsignedPassthroughThinkingBlocks(
  messages: unknown,
  placeholderData?: string,
  thinking?: unknown
): unknown {
  if (!Array.isArray(messages)) return messages;

  const thinkingType =
    thinking && typeof thinking === "object" ? (thinking as { type?: unknown }).type : undefined;
  const thinkingEnabled = thinkingType === "enabled" || thinkingType === "adaptive";
  const openToolCycle = thinkingEnabled
    ? openToolCycleAssistantIndexes(messages as MessageLike[])
    : new Set<number>();
  let changed = false;
  const kept: unknown[] = [];

  (messages as MessageLike[]).forEach((message, index) => {
    if (
      !message ||
      message.role !== "assistant" ||
      !Array.isArray(message.content) ||
      !message.content.some(isUnsignedThinkingBlock)
    ) {
      kept.push(message);
      return;
    }

    changed = true;
    const content = message.content.filter((block) => !isUnsignedThinkingBlock(block));
    const firstToolUse = content.findIndex(
      (block) =>
        !!block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use"
    );
    if (
      openToolCycle.has(index) &&
      firstToolUse >= 0 &&
      !content.slice(0, firstToolUse).some(isThinkingBlock) &&
      typeof placeholderData === "string" &&
      placeholderData.trim().length > 0
    ) {
      content.unshift({ type: "redacted_thinking", data: placeholderData });
    }
    if (content.length > 0) kept.push({ ...message, content });
  });

  return changed ? kept : messages;
}

type ThinkingSignatureError = {
  provider?: string | null;
  status?: number | null;
  message?: string | null;
};

function isThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

function hasBlock(message: MessageLike | null | undefined, type: string): boolean {
  return (
    !!message &&
    Array.isArray(message.content) &&
    message.content.some(
      (block) => !!block && typeof block === "object" && (block as { type?: unknown }).type === type
    )
  );
}

/**
 * Match only the Anthropic validation failure this recovery path understands.
 * Generic 400s and the separate "latest assistant message cannot be modified"
 * validation error must continue through the normal error path unchanged.
 */
export function isAnthropicThinkingSignatureError({
  provider,
  status,
  message,
}: ThinkingSignatureError): boolean {
  const isAnthropicTarget =
    provider === "claude" ||
    (typeof provider === "string" && provider.startsWith("anthropic-compatible-"));
  if (!isAnthropicTarget || status !== 400 || typeof message !== "string") return false;

  return /invalid\s+[`'\"]?signature[`'\"]?\s+in\s+[`'\"]?thinking[`'\"]?\s+block/i.test(message);
}

/**
 * Build a one-shot recovery body after Anthropic has explicitly rejected a
 * thinking signature. Historical thinking blocks are omitted, but the complete
 * active tool-use cycle is preserved verbatim: when the request ends in one or
 * more `user[tool_result]` turns, every paired assistant `tool_use` turn in that
 * still-open cycle keeps its thinking blocks. A trailing unresolved assistant
 * `tool_use` turn is protected as well.
 *
 * This helper is intentionally NOT used eagerly. Normal same-model requests must
 * retain their thinking history, cache shape, and current-model semantics.
 * Returns the original body reference when no safe recovery change is possible.
 */
export function stripHistoricalThinkingForSignatureRecovery<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.messages)) return body;

  const messages = record.messages as MessageLike[];
  const protectedAssistantIndexes = new Set<number>();
  let cursor = messages.length - 1;

  // Some internal callers can resume from an unresolved assistant tool_use.
  if (
    cursor >= 0 &&
    messages[cursor]?.role === "assistant" &&
    hasBlock(messages[cursor], "tool_use")
  ) {
    protectedAssistantIndexes.add(cursor);
    cursor -= 1;
  }

  // Walk the complete trailing tool-result chain. Interleaved thinking can span
  // several assistant/tool_result pairs, so protecting only the latest assistant
  // message is insufficient.
  while (
    cursor >= 0 &&
    messages[cursor]?.role === "user" &&
    hasBlock(messages[cursor], "tool_result")
  ) {
    cursor -= 1;
    while (cursor >= 0 && messages[cursor]?.role !== "assistant") cursor -= 1;
    if (cursor < 0 || !hasBlock(messages[cursor], "tool_use")) break;
    protectedAssistantIndexes.add(cursor);
    cursor -= 1;
  }

  let changed = false;
  const recoveredMessages = messages.map((message, index) => {
    if (
      !message ||
      message.role !== "assistant" ||
      !Array.isArray(message.content) ||
      protectedAssistantIndexes.has(index)
    ) {
      return message;
    }

    const content = message.content.filter((block) => !isThinkingBlock(block));
    if (content.length === message.content.length) return message;
    changed = true;
    return { ...message, content };
  });

  if (!changed) return body;
  return { ...record, messages: recoveredMessages } as T;
}

type SignatureRecoveryExecution<T> = {
  result: T;
  retried: boolean;
  recoveryBody: unknown | null;
};

/** Execute the normal body once, then perform at most one exact-error recovery. */
export async function executeWithAnthropicThinkingSignatureRecovery<T>(args: {
  provider?: string | null;
  body: unknown;
  execute: (body: unknown) => Promise<T>;
  getError: (
    result: T
  ) =>
    | { status?: number | null; message?: string | null }
    | null
    | Promise<{ status?: number | null; message?: string | null } | null>;
}): Promise<SignatureRecoveryExecution<T>> {
  const first = await args.execute(args.body);
  const failure = await args.getError(first);
  if (
    !failure ||
    !isAnthropicThinkingSignatureError({
      provider: args.provider,
      status: failure.status,
      message: failure.message,
    })
  ) {
    return { result: first, retried: false, recoveryBody: null };
  }

  const recoveryBody = stripHistoricalThinkingForSignatureRecovery(args.body);
  if (recoveryBody === args.body) {
    return { result: first, retried: false, recoveryBody: null };
  }

  return {
    result: await args.execute(recoveryBody),
    retried: true,
    recoveryBody,
  };
}

export function isClaudeCodeSemanticPassthroughRequest({
  provider,
  sourceFormat,
  targetFormat,
  headers,
  userAgent,
}: {
  provider?: string | null;
  sourceFormat?: string | null;
  targetFormat?: string | null;
  headers?: Record<string, unknown> | Headers | null;
  userAgent?: string | null;
}): boolean {
  const isDirectClaudeCodeProvider =
    provider === "claude" || isClaudeCodeCompatibleProvider(provider);
  if (!isDirectClaudeCodeProvider) return false;
  if (sourceFormat !== FORMATS.CLAUDE) return false;
  if (targetFormat !== FORMATS.CLAUDE) return false;

  const headerUserAgent = getHeaderValueCaseInsensitive(headers, "user-agent");
  const ua = `${userAgent || ""} ${headerUserAgent || ""}`.toLowerCase();
  if (ua.includes("claude-code") || ua.includes("claude-cli")) return true;

  const appHeader = getHeaderValueCaseInsensitive(headers, "x-app");
  if (typeof appHeader === "string" && appHeader.trim().toLowerCase() === "cli") return true;

  const sessionId = getHeaderValueCaseInsensitive(headers, "x-claude-code-session-id");
  return typeof sessionId === "string" && sessionId.trim().length > 0;
}
