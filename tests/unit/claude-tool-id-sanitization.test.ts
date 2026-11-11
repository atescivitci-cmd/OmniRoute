import assert from "node:assert/strict";
import test from "node:test";

const { prepareClaudeRequest } = await import("../../open-sse/translator/helpers/claudeHelper.ts");

function contentAt(
  body: ReturnType<typeof prepareClaudeRequest>,
  index: number
): Array<Record<string, unknown>> {
  const content = body.messages?.[index]?.content;
  assert.ok(Array.isArray(content));
  return content;
}

test("Claude request preparation sanitizes historical tool ids symmetrically", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "run" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu.bad:id", name: "Bash", input: { command: "pwd" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu.bad:id", content: "ok" }],
      },
    ],
  };

  const result = prepareClaudeRequest(
    body as Parameters<typeof prepareClaudeRequest>[0],
    "claude",
    true
  );

  assert.equal(contentAt(result, 1)[0].id, "toolu_bad_id");
  assert.equal(contentAt(result, 2)[0].tool_use_id, "toolu_bad_id");
});

test("Claude tool-id sanitization preserves valid ids and avoids collisions", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call.valid", name: "A", input: {} },
          { type: "tool_use", id: "call:valid", name: "B", input: {} },
          { type: "tool_use", id: "call_valid", name: "C", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call.valid", content: "a" },
          { type: "tool_result", tool_use_id: "call:valid", content: "b" },
          { type: "tool_result", tool_use_id: "call_valid", content: "c" },
        ],
      },
    ],
  };

  const result = prepareClaudeRequest(
    body as Parameters<typeof prepareClaudeRequest>[0],
    "claude",
    true
  );
  const uses = contentAt(result, 0);
  const results = contentAt(result, 1);

  assert.deepEqual(
    uses.map((block) => block.id),
    ["call_valid_2", "call_valid_3", "call_valid"]
  );
  assert.deepEqual(
    results.map((block) => block.tool_use_id),
    ["call_valid_2", "call_valid_3", "call_valid"]
  );
});
