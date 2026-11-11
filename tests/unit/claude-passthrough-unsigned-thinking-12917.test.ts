import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.ts";
import { dropUnsignedPassthroughThinkingBlocks } from "../../open-sse/handlers/chatCore/passthroughHelpers.ts";

function makeOpenToolCycle() {
  return [
    { role: "user", content: [{ type: "text", text: "question" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "unsigned relayed reasoning" },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
  ];
}

test("enabled open tool cycle gets a non-empty precursor and keeps tool_result", () => {
  const messages = makeOpenToolCycle();
  const original = structuredClone(messages);
  const sanitized = dropUnsignedPassthroughThinkingBlocks(
    messages,
    DEFAULT_THINKING_CLAUDE_SIGNATURE,
    { type: "enabled", budget_tokens: 1024 }
  );

  assert.deepEqual(messages, original, "the input is not mutated");
  assert.deepEqual(sanitized[1].content, [
    { type: "redacted_thinking", data: DEFAULT_THINKING_CLAUDE_SIGNATURE },
    { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
  ]);
  assert.deepEqual(sanitized[2], messages[2], "the tool_result is preserved");
});

test("adaptive open tool cycle also gets the required precursor", () => {
  const sanitized = dropUnsignedPassthroughThinkingBlocks(
    makeOpenToolCycle(),
    DEFAULT_THINKING_CLAUDE_SIGNATURE,
    { type: "adaptive" }
  );

  assert.deepEqual(sanitized[1].content[0], {
    type: "redacted_thinking",
    data: DEFAULT_THINKING_CLAUDE_SIGNATURE,
  });
});

test("disabled thinking drops unsigned history without injecting a precursor", () => {
  const messages = makeOpenToolCycle();
  const sanitized = dropUnsignedPassthroughThinkingBlocks(
    messages,
    DEFAULT_THINKING_CLAUDE_SIGNATURE,
    { type: "disabled" }
  );

  assert.deepEqual(sanitized[1].content, [messages[1].content[1]]);
});

test("signed thinking and unrelated messages remain untouched", () => {
  const messages = [
    { role: "user", content: "question" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "signed", signature: "VALID_SIGNATURE" },
        { type: "text", text: "answer" },
      ],
    },
  ];

  assert.equal(dropUnsignedPassthroughThinkingBlocks(messages), messages);
});
