import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// Optional source selection is for the isolated baseline/candidate comparison.
const subject = process.env.STREAM_RECHECK_SUBJECT
  ? pathToFileURL(process.env.STREAM_RECHECK_SUBJECT).href
  : new URL("../../open-sse/translator/response/openai-to-claude.ts", import.meta.url).href;
const { openaiToClaudeResponse } = await import(subject);
for (const [name, chunks] of [
  ["plain text", ["hello"]],
  ["word boundary", ["hello", " ", "world"]],
  ["line boundary", ["first", "\n", "second"]],
  ["Python indentation", ["def f():", "\n", "    ", "return 1", "\n"]],
  ["JSON string space", ['{"greeting":"hello', " ", 'world"}']],
  ["Unicode and tabs", ["a", "\u00a0", "b", "\t", "c"]],
] as Array<[string, string[]]>) {
  test(`current-baseline recheck preserves ${name}`, () => {
    const state = { toolCalls: new Map(), _pendingXmlToolCalls: [], _xmlInvokeBuffer: "" };
    const chunk = (content: string, finish: string | null = null) => ({
      id: "synthetic-recheck",
      model: "synthetic-model",
      choices: [{ index: 0, delta: { content }, finish_reason: finish }],
    });
    const events: any[] = chunks.flatMap(
      (value) => openaiToClaudeResponse(chunk(value), state) || []
    );
    events.push(...(openaiToClaudeResponse(chunk("", "stop"), state) || []));
    const actual = events
      .filter((event) => event.delta?.type === "text_delta")
      .map((event) => event.delta.text)
      .join("");
    assert.equal(actual, chunks.join(""));
  });
}
