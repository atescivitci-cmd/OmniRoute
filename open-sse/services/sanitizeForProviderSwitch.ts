// ── CLAUDE_SESSION_AFFINITY_V2 (2026-08-29, message-level fix 2026-08-30) ───────────────
// sanitizeForProviderSwitch: deterministic, synchronous, non-mutating. Removes ONLY
// provider-specific reasoning artifacts (thinking/redacted_thinking blocks, and
// signature/encrypted_content/reasoning_content/reasoning fields) before a request
// crosses a provider boundary. Everything else -- ordinary text, tool schemas,
// tool_use/tool_result blocks, file paths, task state -- survives untouched. This must
// run BEFORE the first cross-provider dispatch, not after a fallback already succeeded
// (combo.ts:1330-1368 calls maybeGenerateUniversalHandoff only after
// recordSessionModelUsage -- confirmed against real source 2026-08-29 -- so an async
// post-success summary cannot protect the request that needed protecting).
//
// FIXED 2026-08-30 in response to Codex's independent audit (Blocker 3, 2026-08-30):
// the message-level copy (sanitizeMessages) previously did `{ ...message }`, which
// preserves signature/encrypted_content/reasoning_content/reasoning when OmniRoute
// places those fields directly on the MESSAGE object rather than nested inside a
// content block. Only content-block-level fields (via sanitizeBlock) were being
// stripped. Now both levels strip the same four fields.
//
// Source of the vendor file this integrates into, pinned at handout time:
//   open-sse/services/contextHandoff.ts  sha256 d744f9c661d2cd2c08a0c33b6211558e3d497b52ed94809b36cb392471e18f04
export function sanitizeForProviderSwitch(body: Record<string, unknown>): Record<string, unknown> {
  const sanitizeBlock = (value: unknown): unknown | null => {
    if (!value || typeof value !== "object") return value;

    const block = value as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "";

    if (type === "thinking" || type === "redacted_thinking") {
      return null;
    }

    const {
      signature: _signature,
      encrypted_content: _encryptedContent,
      reasoning_content: _reasoningContent,
      ...safe
    } = block;

    if (Array.isArray(safe.content)) {
      safe.content = safe.content.map(sanitizeBlock).filter((item) => item !== null);
    }

    return safe;
  };

  const sanitizeMessages = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;

    return value.map((message) => {
      if (!message || typeof message !== "object") return message;

      const {
        signature: _signature,
        encrypted_content: _encryptedContent,
        reasoning_content: _reasoningContent,
        reasoning: _reasoning,
        ...next
      } = message as Record<string, unknown>;

      if (Array.isArray(next.content)) {
        next.content = next.content.map(sanitizeBlock).filter((item) => item !== null);
      }

      return next;
    });
  };

  const next = structuredClone(body);

  if ("messages" in next) {
    next.messages = sanitizeMessages(next.messages);
  }

  if ("input" in next && Array.isArray(next.input)) {
    next.input = sanitizeMessages(next.input);
  }

  delete next.reasoning;
  delete next.reasoning_content;
  delete next.encrypted_content;

  return next;
}
