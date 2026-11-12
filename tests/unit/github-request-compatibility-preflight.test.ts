import test from "node:test";
import assert from "node:assert/strict";
import { GithubExecutor } from "../../open-sse/executors/github.ts";

const inert = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
const body = () => ({
  model: "claude-sonnet-5",
  messages: [{ role: "user", content: "Reply only: OK" }],
  max_tokens: 512,
  stream: true,
  tools: [],
  context_management: structuredClone(inert),
});
const hasCode = (code: string) => (error: unknown) =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === code);

test("GitHub native preflight omits only a proven inert fresh-turn context hint", () => {
  const executor = new GithubExecutor();
  const input = body(),
    before = structuredClone(input);
  const output = executor.transformRequest("claude-sonnet-5", input, true, {});
  assert.equal(Object.hasOwn(output, "context_management"), false);
  assert.deepEqual(output.messages, input.messages);
  assert.deepEqual(input, before);
});

test("GitHub native preflight omits history-trim edits rather than sending a known400", () => {
  const executor = new GithubExecutor();
  const input = {
    ...body(),
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
  };
  const before = structuredClone(input);
  const output = executor.transformRequest("claude-sonnet-5", input, true, {});
  assert.equal(Object.hasOwn(output, "context_management"), false);
  assert.deepEqual(output.messages, input.messages);
  assert.deepEqual(input, before);
});

test("GitHub native preflight refuses an unknown context edit without rewriting", () => {
  const executor = new GithubExecutor();
  const input = { ...body(), context_management: { edits: [{ type: "future_edit_20990101" }] } };
  const before = structuredClone(input);
  assert.throws(
    () => executor.transformRequest("claude-sonnet-5", input, true, {}),
    hasCode("request_context_management_unavailable")
  );
  assert.deepEqual(input, before);
});

test("GitHub native preflight omits the hint on a signed continuation and keeps the history", () => {
  const executor = new GithubExecutor();
  const input = {
    ...body(),
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "fixture", signature: "opaque-fixture-signature" }],
      },
      { role: "user", content: "Continue." },
    ],
  };
  const output = executor.transformRequest("claude-sonnet-5", input, true, {});
  assert.equal(Object.hasOwn(output, "context_management"), false);
  assert.deepEqual(output.messages, input.messages);
});

test("GitHub native preflight refuses excess declared tools without truncating them", () => {
  const executor = new GithubExecutor();
  const input = {
    ...body(),
    context_management: undefined,
    tools: Array.from({ length: 129 }, (_, index) => ({
      name: "fixture_" + index,
      input_schema: { type: "object" },
    })),
  };
  assert.throws(
    () => executor.transformRequest("claude-sonnet-5", input, true, {}),
    hasCode("request_tool_limit_exceeded")
  );
  assert.equal(input.tools.length, 129);
});

test("GitHub native preflight refuses required controls that its current param profile would erase", () => {
  const executor = new GithubExecutor();
  const input = { ...body(), context_management: undefined, thinking: { type: "adaptive" } };
  const before = structuredClone(input);
  assert.throws(
    () => executor.transformRequest("claude-sonnet-5", input, true, {}),
    hasCode("request_required_control_unsupported")
  );
  assert.deepEqual(input, before);
});
