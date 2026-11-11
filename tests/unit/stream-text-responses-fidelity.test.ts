import test from "node:test";
import assert from "node:assert/strict";
import { initState } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.ts";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.ts";
import { NON_ANTHROPIC_THINKING_PLACEHOLDER as MARKER } from "../../open-sse/utils/reasoningPlaceholder.ts";

const chunk = (text: string, finish: string | null = null) => ({
  id: "chatcmpl-fidelity-responses",
  model: "synthetic-model",
  choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
});
function registryText(chunks: string[], stop = true) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const events = chunks.flatMap(
    (text) => openaiToOpenAIResponsesResponse(chunk(text), state) || []
  );
  if (stop) events.push(...openaiToOpenAIResponsesResponse(chunk("", "stop"), state));
  events.push(...openaiToOpenAIResponsesResponse(null, state));
  return events
    .filter((x) => x.event === "response.output_text.delta")
    .map((x) => x.data.delta)
    .join("");
}
async function transformerText(chunks: string[], stop = true) {
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      for (const text of chunks)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(text))}\n\n`));
      if (stop)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk("", "stop"))}\n\n`));
      controller.close();
    },
  });
  const output = await new Response(
    source.pipeThrough(createResponsesApiTransformStream(null))
  ).text();
  return output
    .split("\n\n")
    .flatMap((frame) => {
      const data = frame
        .split("\n")
        .find((x) => x.startsWith("data: "))
        ?.slice(6);
      if (!data || data === "[DONE]") return [];
      const event = JSON.parse(data);
      return event.type === "response.output_text.delta" ? [event.delta] : [];
    })
    .join("");
}

for (const [name, translate] of [
  ["registry", registryText],
  ["TransformStream", transformerText],
] as const) {
  test(`${name} preserves whitespace-only text including leading whitespace`, async () => {
    const parts = ["\n", "  ", "hello", " ", "world", "\n\n\n\n", "\t", "tail "];
    assert.equal(await translate(parts), parts.join(""));
  });
  test(`${name} removes marker at every split without losing ordinary text`, async () => {
    const text = `prefix ${MARKER} suffix\n`;
    for (let split = 0; split <= text.length; split++) {
      assert.equal(
        await translate([text.slice(0, split), text.slice(split)]),
        text.replaceAll(MARKER, ""),
        `split=${split}`
      );
    }
  });
  test(`${name} flushes unfinished marker-like text with and without a finish chunk`, async () => {
    const text = "literal (prior reasoning";
    assert.equal(await translate([text]), text);
    assert.equal(await translate([text], false), text);
  });
}
