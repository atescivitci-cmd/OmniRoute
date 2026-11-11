import test from "node:test";
import assert from "node:assert/strict";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.ts";
import {
  NON_ANTHROPIC_THINKING_PLACEHOLDER as MARKER,
  stripInternalReasoningPlaceholder,
  createReasoningPlaceholderStreamState,
  stripStreamingReasoningPlaceholder,
  flushStreamingReasoningPlaceholder,
} from "../../open-sse/utils/reasoningPlaceholder.ts";

const state = () => ({ toolCalls: new Map(), _pendingXmlToolCalls: [], _xmlInvokeBuffer: "" });
const chunk = (text: string, finish: string | null = null) => ({
  id: "synthetic-text-fidelity",
  model: "synthetic-model",
  choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
});
function translate(chunks: string[]) {
  const current = state();
  const events = chunks.flatMap((text) => openaiToClaudeResponse(chunk(text), current) || []);
  events.push(...(openaiToClaudeResponse(chunk("", "stop"), current) || []));
  return {
    events,
    text: events
      .filter((x) => x.delta?.type === "text_delta")
      .map((x) => x.delta.text)
      .join(""),
  };
}

const samples: Array<[string, string[]]> = [
  ["standalone space", ["Hello", " ", "world"]],
  ["newline", ["first", "\n", "second"]],
  ["tabs and indentation", ["def f():", "\n", "\t", "return 1", "\n"]],
  ["CRLF", ["a", "\r", "\n", "b", "\r\n"]],
  ["nonbreaking space", ["hello", "\u00a0", "world"]],
  ["JSON string space", ['{"greeting":"hello', " ", 'world"}']],
  ["Python fence", ["```python", "\n", "def f():", "\n", "    ", "return 1", "\n", "```"]],
  ["CSV", ["name,count", "\n", "alpha,1", "\n", "beta,2"]],
  ["consecutive blank lines", ["a", "\n\n\n\n", "b"]],
  ["leading and trailing whitespace", [" ", "answer", "\t", "\n", "  "]],
];

for (const [name, chunks] of samples) {
  test(`Claude streaming preserves ${name}`, () => {
    const result = translate(chunks);
    assert.equal(result.text, chunks.join(""));
    assert.equal(result.events.filter((x) => x.type === "message_stop").length, 1);
  });
}

test("complete-value sanitization preserves whitespace when no marker is present", () => {
  for (const value of [" ", "\n", "\t", "\r\n", "\u00a0", "\n\n\n\n"]) {
    assert.equal(stripInternalReasoningPlaceholder(value), value);
  }
});

test("stream output is invariant under every two-part partition", () => {
  for (const original of [
    "hello world\n",
    '```python\ndef f():\n    return "hello world"\n```',
    `before ${MARKER} after`,
    `a${MARKER}${MARKER}b`,
  ]) {
    const expected = original.replaceAll(MARKER, "");
    for (let split = 0; split <= original.length; split++) {
      assert.equal(
        translate([original.slice(0, split), original.slice(split)]).text,
        expected,
        `split=${split}, input=${original}`
      );
    }
    assert.equal(translate([...original]).text, expected);
  }
});

test("unfinished marker-like text flushes before completion", () => {
  for (let length = 1; length < MARKER.length; length++) {
    const text = `literal ${MARKER.slice(0, length)}`;
    assert.equal(translate([text]).text, text);
  }
});

test("marker buffering is isolated between interleaved responses", () => {
  const a = state(),
    b = state();
  const eventsA = [...(openaiToClaudeResponse(chunk("first (prior reasoning"), a) || [])];
  const eventsB = [...(openaiToClaudeResponse(chunk("independent (pr"), b) || [])];
  eventsA.push(...(openaiToClaudeResponse(chunk(" summary unavailable) end"), a) || []));
  eventsB.push(...(openaiToClaudeResponse(chunk("", "stop"), b) || []));
  eventsA.push(...(openaiToClaudeResponse(chunk("", "stop"), a) || []));
  const visible = (events: any[]) =>
    events
      .filter((x) => x.delta?.type === "text_delta")
      .map((x) => x.delta.text)
      .join("");
  assert.equal(visible(eventsA), "first  end");
  assert.equal(visible(eventsB), "independent (pr");
});

test("stream marker filter is bounded and does not recursively erase newly joined text", () => {
  const input = "(" + MARKER + "prior reasoning summary unavailable)";
  const expected = input.replaceAll(MARKER, "");
  const current = createReasoningPlaceholderStreamState();
  let output = "";
  for (const character of input) {
    output += stripStreamingReasoningPlaceholder(character, current);
    assert.ok(current.pending.length < MARKER.length);
  }
  output += flushStreamingReasoningPlaceholder(current);
  assert.equal(output, expected);
  assert.equal(current.pending, "");
});

test("pending literal prefix emits before a structured tool block", () => {
  const current = state();
  const events = [...(openaiToClaudeResponse(chunk("literal (prior"), current) || [])];
  events.push(
    ...(openaiToClaudeResponse(
      {
        ...chunk(""),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tool-test",
                  type: "function",
                  function: { name: "synthetic_tool", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      current
    ) || [])
  );
  events.push(...(openaiToClaudeResponse(chunk("", "tool_calls"), current) || []));
  const literal = events.findIndex(
    (x) => x.delta?.type === "text_delta" && x.delta.text.includes("(prior")
  );
  const tool = events.findIndex((x) => x.content_block?.type === "tool_use");
  assert.ok(literal >= 0 && tool > literal);
});
