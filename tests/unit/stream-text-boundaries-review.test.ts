import test from "node:test";
import assert from "node:assert/strict";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.ts";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.ts";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.ts";
import { initState } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { createSSEStream } from "../../open-sse/utils/stream.ts";

const chunk = (content: string, index = 0, finish: string | null = null) => ({
  id: "chatcmpl-review-boundary",
  model: "synthetic-model",
  choices: [{ index, delta: { content }, finish_reason: finish }],
});
const text = (events: any[]) =>
  events
    .filter((event) => event.delta?.type === "text_delta")
    .map((event) => event.delta.text)
    .join("");
function parseFrames(body: string): any[] {
  return body.split("\n").flatMap((line) => {
    if (!line.startsWith("data:")) return [];
    try {
      return [JSON.parse(line.slice(5).trim())];
    } catch {
      return [];
    }
  });
}
function source(chunks: any[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      chunks.forEach((value) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
      );
      controller.close();
    },
  });
}

test("review: Claude null EOF flushes a literal marker prefix once without fabricating completion", () => {
  const state = { toolCalls: new Map(), _pendingXmlToolCalls: [], _xmlInvokeBuffer: "" };
  const events = [
    ...(openaiToClaudeResponse(chunk("literal (prior"), state) || []),
    ...(openaiToClaudeResponse(null, state) || []),
    ...(openaiToClaudeResponse(null, state) || []),
  ];
  assert.equal(text(events), "literal (prior");
  assert.equal(events.filter((event) => event.type === "message_stop").length, 0);
  assert.equal(
    events.filter(
      (event) => event.type === "message_delta" && event.delta?.stop_reason === "end_turn"
    ).length,
    0
  );
});

test("review: actual OpenAI-to-Claude SSE EOF retains pending text without a fabricated successful terminal", async () => {
  const output = await new Response(
    source([chunk("literal (prior")]).pipeThrough(
      createSSEStream({
        mode: "translate",
        sourceFormat: FORMATS.CLAUDE,
        targetFormat: FORMATS.OPENAI,
        provider: "synthetic-review",
        model: "synthetic-model",
        body: { messages: [] },
      })
    )
  ).text();
  const events = parseFrames(output);
  assert.equal(text(events), "literal (prior");
  assert.equal(events.filter((event) => event.type === "message_stop").length, 0);
  assert.equal(
    events.filter(
      (event) => event.type === "message_delta" && event.delta?.stop_reason === "end_turn"
    ).length,
    0
  );
});

async function registry(chunks: any[]): Promise<any[]> {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const events = chunks.flatMap((value) => openaiToOpenAIResponsesResponse(value, state) || []);
  events.push(...openaiToOpenAIResponsesResponse(null, state));
  events.push(...openaiToOpenAIResponsesResponse(null, state));
  return events.map((event) => event.data);
}
async function transformer(chunks: any[]): Promise<any[]> {
  return parseFrames(
    await new Response(source(chunks).pipeThrough(createResponsesApiTransformStream(null))).text()
  );
}
function textByIndex(events: any[]): Record<number, string> {
  const result: Record<number, string> = {};
  for (const event of events) {
    if (event.type === "response.output_text.delta")
      result[event.output_index] = (result[event.output_index] || "") + event.delta;
  }
  return result;
}

for (const [name, run] of [
  ["registry", registry],
  ["TransformStream", transformer],
] as const) {
  test(`review: ${name} cannot create and delete a marker across independent choice indexes`, async () => {
    const events = await run([
      chunk("(prior reasoning", 0),
      chunk(" summary unavailable)", 1),
      chunk("", 0, "stop"),
    ]);
    assert.deepEqual(textByIndex(events), { 0: "(prior reasoning", 1: " summary unavailable)" });
    assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
  });
  test(`review: ${name} preserves independent pending prefixes while filtering a same-choice split marker`, async () => {
    const events = await run([
      chunk("alpha (prior reasoning", 0),
      chunk("independent (prior", 1),
      chunk(" summary unavailable) omega", 0),
    ]);
    assert.deepEqual(textByIndex(events), { 0: "alpha  omega", 1: "independent (prior" });
    assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
  });
}
