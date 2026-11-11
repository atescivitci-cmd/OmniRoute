import test from "node:test";
import assert from "node:assert/strict";

const { sanitizeStreamingChunk, OMIT_STREAMING_CHUNK_MARKER } =
  await import("../../open-sse/handlers/responseSanitizer.ts");

const exactText = " \tfirst\r\n    second\n\n\n\n👩\u200d💻 क्\u200dष می\u200cروم\ufeff\u200b ";

test("native Claude text deltas preserve whitespace and legitimate Unicode exactly", () => {
  const input = {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: exactText },
  };
  const result = sanitizeStreamingChunk(input) as typeof input;
  assert.equal(result.delta.text, exactText);
});

test("native Claude thinking deltas preserve signed thinking text exactly", () => {
  const input = {
    type: "content_block_delta",
    index: 1,
    delta: { type: "thinking_delta", thinking: exactText },
  };
  const result = sanitizeStreamingChunk(input) as typeof input;
  assert.equal(result.delta.thinking, exactText);
});

test("native Claude text sanitization does not mutate the supplied event", () => {
  const input = {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "👩\u200d💻" },
  };
  const before = structuredClone(input);
  sanitizeStreamingChunk(input);
  assert.deepEqual(input, before);
});

test("native Claude thinking sanitization does not mutate the supplied event", () => {
  const input = {
    type: "content_block_delta",
    index: 1,
    delta: { type: "thinking_delta", thinking: "ک\u200cتاب\n\n\n" },
  };
  const before = structuredClone(input);
  sanitizeStreamingChunk(input);
  assert.deepEqual(input, before);
});

test("native Claude signature deltas remain opaque and byte-identical", () => {
  const signature = "opaque+/=\u200d\ufeff\n\n\n";
  const input = {
    type: "content_block_delta",
    index: 1,
    delta: { type: "signature_delta", signature },
  };
  const before = structuredClone(input);
  const result = sanitizeStreamingChunk(input) as typeof input;
  assert.equal(result.delta.signature, signature);
  assert.deepEqual(input, before);
});

test("native Claude chunk concatenation preserves split Unicode and whitespace", () => {
  const parts = ["  ", "👩", "\u200d", "💻", "\n\n\n", "    return 1\r\n"];
  const output = parts
    .map((text) => {
      const input = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
      return (sanitizeStreamingChunk(input) as typeof input).delta.text;
    })
    .join("");
  assert.equal(output, parts.join(""));
});

const visibleFixtures = [
  ["space and tab", " \t"],
  ["one LF", "\n"],
  ["one CRLF", "\r\n"],
  ["four LFs", "\n\n\n\n"],
  ["CRLF blank lines", "first\r\n\r\n\r\nsecond"],
  ["indented code and blank lines", "def f():\n    if True:\n        return 1\n\n\n\n"],
  ["ZWJ emoji", "👩\u200d💻"],
  ["Indic joiner", "क्\u200dष"],
  ["Persian non-joiner", "می\u200cروم"],
  ["zero-width space and BOM data", "\ufefftext\u200b"],
  ["literal agent-word spelling", "o\u200dpencode"],
  ["fenced code", "```python\ndef f():\n    return 1\n\n\n```\n"],
] as const;

for (const [name, content] of visibleFixtures) {
  test(`OpenAI visible delta preserves ${name}`, () => {
    const input = {
      id: "chatcmpl_fidelity",
      object: "chat.completion.chunk",
      model: "synthetic",
      choices: [{ index: 0, delta: { content } }],
    };
    const before = structuredClone(input);
    const result = sanitizeStreamingChunk(input) as typeof input;
    assert.equal(result.choices[0].delta.content, content);
    assert.deepEqual(input, before);
  });
}

test("OpenAI text is invariant under every two-chunk partition", () => {
  const whole = "  👩\u200d💻\n\n\n    answer\r\nمی\u200cروم ";
  for (let split = 0; split <= whole.length; split += 1) {
    const output = [whole.slice(0, split), whole.slice(split)]
      .map((content) => {
        const input = { choices: [{ index: 0, delta: { content } }] };
        return (sanitizeStreamingChunk(input) as typeof input).choices[0].delta.content;
      })
      .join("");
    assert.equal(output, whole, `partition ${split}`);
  }
});

for (const type of [
  "response.output_text.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
]) {
  test(`Responses ${type} preserves root text exactly`, () => {
    const input = {
      type,
      item_id: "msg_fidelity",
      output_index: 0,
      content_index: 0,
      delta: exactText,
    };
    const before = structuredClone(input);
    const result = sanitizeStreamingChunk(input) as typeof input;
    assert.equal(result.delta, exactText);
    assert.deepEqual(input, before);
  });
}

for (const type of [
  "response.output_text.done",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.done",
]) {
  test(`Responses ${type} preserves finalized root text exactly`, () => {
    const input = {
      type,
      item_id: "msg_fidelity",
      output_index: 0,
      content_index: 0,
      text: exactText,
    };
    const before = structuredClone(input);
    const result = sanitizeStreamingChunk(input) as typeof input;
    assert.equal(result.text, exactText);
    assert.deepEqual(input, before);
  });
}

for (const type of ["response.output_item.added", "response.output_item.done"]) {
  test(`Responses ${type} preserves visible item text`, () => {
    const input = {
      type,
      output_index: 0,
      item: {
        id: "msg_fidelity",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: exactText, annotations: [] }],
      },
    };
    const before = structuredClone(input);
    const result = sanitizeStreamingChunk(input) as typeof input;
    assert.equal(result.item.content[0].text, exactText);
    assert.deepEqual(input, before);
  });
}

test("Responses completed nested snapshot preserves visible and reasoning summary text", () => {
  const input = {
    type: "response.completed",
    response: {
      id: "resp_fidelity",
      status: "completed",
      output_text: exactText,
      output: [
        {
          id: "msg_fidelity",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: exactText }],
        },
        {
          id: "rs_fidelity",
          type: "reasoning",
          summary: [{ type: "summary_text", text: exactText }],
        },
      ],
    },
  };
  const before = structuredClone(input);
  const result = sanitizeStreamingChunk(input) as typeof input;
  assert.equal(result.response.output[0].content?.[0].text, exactText);
  assert.equal(result.response.output[1].summary?.[0].text, exactText);
  assert.equal(result.response.output_text, exactText);
  assert.deepEqual(input, before);
});

test("Responses completed top-level snapshot preserves visible output text", () => {
  const input = {
    type: "response.completed",
    output_text: exactText,
    output: [
      {
        id: "msg_fidelity",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: exactText }],
      },
    ],
  };
  const before = structuredClone(input);
  const result = sanitizeStreamingChunk(input) as typeof input;
  assert.equal(result.output[0].content[0].text, exactText);
  assert.equal(result.output_text, exactText);
  assert.deepEqual(input, before);
});

test("explicit internal commentary item events remain marked for omission", () => {
  const input = {
    type: "response.output_item.added",
    item: {
      id: "msg_internal",
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "internal scratchpad" }],
    },
  };
  const result = sanitizeStreamingChunk(input) as Record<string, unknown>;
  assert.equal(result[OMIT_STREAMING_CHUNK_MARKER], true);
  assert.equal(result.item, undefined);
});

test("completed snapshots still exclude explicitly internal commentary messages", () => {
  const result = sanitizeStreamingChunk({
    type: "response.completed",
    response: {
      output: [
        {
          id: "msg_internal",
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "internal scratchpad" }],
        },
        {
          id: "msg_final",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "answer" }],
        },
      ],
    },
  }) as { response: { output: { id: string }[]; output_text: string } };
  assert.deepEqual(
    result.response.output.map((item) => item.id),
    ["msg_final"]
  );
  assert.equal(result.response.output_text, "answer");
});

test("explicit commentary content parts remain excluded from visible messages", () => {
  const result = sanitizeStreamingChunk({
    type: "response.output_item.done",
    item: {
      id: "msg_final",
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", phase: "commentary", text: "internal scratchpad" },
        { type: "output_text", text: "answer" },
      ],
    },
  }) as { item: { content: { text: string }[] } };
  assert.deepEqual(
    result.item.content.map((part) => part.text),
    ["answer"]
  );
});

test("this visible-text change does not alter existing tool-argument cleanup", () => {
  const input = {
    type: "response.function_call_arguments.delta",
    delta: '{"command":"o\u200dpencode"}',
  };
  const result = sanitizeStreamingChunk(input) as typeof input;
  assert.equal(result.delta, '{"command":"opencode"}');
});
