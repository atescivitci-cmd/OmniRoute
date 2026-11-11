import test from "node:test";
import assert from "node:assert/strict";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.ts";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.ts";
import { translateNonStreamingResponse } from "../../open-sse/handlers/responseTranslator.ts";
import { extractToolSchemaMap } from "../../open-sse/translator/response/openai-responses/toolSchemas.ts";
import { stripEmptyOptionalToolArgs } from "../../open-sse/translator/response/openai-responses/pureHelpers.ts";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.ts";

const agentSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    prompt: { type: "string" },
    model: { type: "string", enum: ["sonnet", "opus", "haiku", "fable"] },
    effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
    isolation: { type: "string", enum: ["worktree", "remote"] },
  },
  required: ["description", "prompt"],
};
const original = {
  description: "synthetic",
  prompt: "synthetic",
  model: null,
  effort: null,
  isolation: null,
};
const expected = { description: "synthetic", prompt: "synthetic" };
const nativeBody = (schema = agentSchema) => ({ tools: [{ name: "Agent", input_schema: schema }] });
const asArray = (value) => (value ? (Array.isArray(value) ? value : [value]) : []);

function translateEvents(args, schema, mode = "delta", name = "Agent", suppliedSchema = false) {
  const schemas = schema
    ? suppliedSchema
      ? new Map([[name, schema]])
      : extractToolSchemaMap(nativeBody(schema))
    : null;
  const state = { toolSchemas: schemas };
  const claudeState = { toolCalls: new Map() };
  const raw = typeof args === "string" ? args : JSON.stringify(args);
  const item = { type: "function_call", call_id: "synthetic_call", name, arguments: raw };
  const events = [];
  if (mode !== "completed-only")
    events.push({ type: "response.output_item.added", item: { ...item, arguments: "" } });
  if (["delta", "snapshot", "buffer-only", "abort"].includes(mode)) {
    for (let i = 0; i < raw.length; i += 7)
      events.push({ type: "response.function_call_arguments.delta", delta: raw.slice(i, i + 7) });
  }
  if (["delta", "done-only"].includes(mode))
    events.push({ type: "response.output_item.done", item });
  if (mode === "abort")
    events.push({
      type: "response.failed",
      response: { error: { code: "cancelled", message: "synthetic cancel" } },
    });
  else
    events.push({
      type: "response.completed",
      response: {
        status: "completed",
        output: mode === "buffer-only" ? [] : [item],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
  const chunks = events.flatMap((event) => asArray(openaiResponsesToOpenAIResponse(event, state)));
  const claude = chunks.flatMap((chunk) => asArray(openaiToClaudeResponse(chunk, claudeState)));
  const starts = claude.filter(
    (event) => event.type === "content_block_start" && event.content_block?.type === "tool_use"
  );
  const json = claude
    .filter((event) => event.delta?.type === "input_json_delta")
    .map((event) => event.delta.partial_json)
    .join("");
  return { starts, json, state, claude };
}

test("native Claude input_schema is extracted and cloned before transport widening", () => {
  const body = nativeBody(structuredClone(agentSchema));
  const map = extractToolSchemaMap(body)!;
  assert.equal(map.get("Agent")!.required?.length, 2);
  body.tools[0].input_schema.properties.model.enum.push(null as never);
  assert.ok(!map.get("Agent")!.properties.model.enum.includes(null));
});

test("incremental compiled path cleans nulls even when schema lookup already succeeded", () => {
  assert.deepEqual(
    JSON.parse(translateEvents(original, agentSchema, "delta", "Agent", true).json),
    expected
  );
});

test("done-only path with an available original schema retains existing omission behavior", () => {
  assert.deepEqual(
    JSON.parse(translateEvents(original, agentSchema, "done-only", "Agent", true).json),
    expected
  );
});

test("compiled helper preserves a legitimate optional nullable value", () => {
  const schema = {
    type: "object",
    properties: { note: { type: ["string", "null"] } },
    required: [],
  };
  assert.deepEqual(stripEmptyOptionalToolArgs({ note: null }, "Agent", schema), { note: null });
});

test("compiled helper preserves a required nullable default:null", () => {
  const schema = {
    type: "object",
    properties: { note: { type: ["string", "null"], default: null } },
    required: ["note"],
  };
  assert.deepEqual(stripEmptyOptionalToolArgs({ note: null }, "Agent", schema), { note: null });
});

for (const mode of ["delta", "done-only", "completed-only", "snapshot", "buffer-only"]) {
  test(`Responses→Claude ${mode}: omit only caller-disallowed optional nulls exactly once`, () => {
    const result = translateEvents(original, agentSchema, mode);
    assert.equal(result.starts.length, 1);
    assert.equal(result.starts[0].content_block.id, "synthetic_call");
    assert.deepEqual(JSON.parse(result.json), expected);
    assert.ok(result.claude.some((event) => event.type === "message_stop"));
  });
}

for (const constraint of [
  { type: ["string", "null"] },
  { enum: ["yes", null] },
  { anyOf: [{ type: "string" }, { type: "null" }] },
  { oneOf: [{ type: "string" }, { type: "null" }] },
  { type: ["string", "null"], default: null },
]) {
  test(`stream preserves explicitly allowed optional null ${JSON.stringify(constraint)}`, () => {
    const schema = {
      ...structuredClone(agentSchema),
      properties: { ...agentSchema.properties, nullable: constraint },
    };
    const result = translateEvents({ ...original, nullable: null }, schema);
    assert.deepEqual(JSON.parse(result.json), { ...expected, nullable: null });
  });
}

test("required nullable default:null is never removed", () => {
  const schema = {
    ...structuredClone(agentSchema),
    properties: { ...agentSchema.properties, note: { type: ["string", "null"], default: null } },
    required: [...agentSchema.required, "note"],
  };
  assert.deepEqual(JSON.parse(translateEvents({ ...original, note: null }, schema).json), {
    ...expected,
    note: null,
  });
  assert.deepEqual(
    stripEmptyOptionalToolArgs({ note: null }, "Required", {
      properties: schema.properties,
      required: ["note"],
    }),
    { note: null }
  );
});

test("unknown schema preserves explicit nulls and empty values", () => {
  const args = { value: null, empty: "", nested: { isolation: null }, list: [] };
  assert.deepEqual(JSON.parse(translateEvents(args, null).json), args);
});

test("required invalid null remains for client validation", () => {
  const schema = { ...agentSchema, required: [...agentSchema.required, "model"] };
  assert.deepEqual(JSON.parse(translateEvents(original, schema).json), {
    ...expected,
    model: null,
  });
});

test("valid enum arguments retain their values", () => {
  const args = { ...expected, model: "sonnet", effort: "medium", isolation: "worktree" };
  assert.deepEqual(JSON.parse(translateEvents(args, agentSchema).json), args);
});

test("nested nulls are not rewritten", () => {
  const args = { ...original, nested: { model: null } };
  assert.deepEqual(JSON.parse(translateEvents(args, agentSchema).json), {
    ...expected,
    nested: { model: null },
  });
});

test("new incremental null cleanup preserves non-null empty/default values", () => {
  const schema = {
    ...agentSchema,
    properties: {
      ...agentSchema.properties,
      note: { type: "string", default: "" },
      count: { type: "integer", default: 0 },
    },
  };
  const args = { ...original, note: "", count: 0 };
  assert.deepEqual(JSON.parse(translateEvents(args, schema).json), {
    ...expected,
    note: "",
    count: 0,
  });
});

for (const token of [
  "9007199254740993",
  "-9007199254740993",
  "1.0000000000000000001",
  "1e400",
  "1e-400",
  "-0",
]) {
  test(`streamed null cleanup preserves numeric token ${token}`, () => {
    const raw = `{"description":"synthetic","prompt":"synthetic","id":${token},"model":null}`;
    const result = translateEvents(raw, agentSchema);
    assert.ok(result.json.includes(`"id":${token}`), result.json);
    assert.ok(!result.json.includes('"model"'));
  });
  test(`nonstream null cleanup preserves numeric token ${token} on the JSON wire`, () => {
    const raw = `{"description":"synthetic","prompt":"synthetic","id":${token},"model":null}`;
    const response = translateNonStreamingResponse(
      {
        object: "response",
        id: "synthetic",
        output: [{ type: "function_call", name: "Agent", call_id: "synthetic", arguments: raw }],
      },
      "openai-responses",
      "claude",
      null,
      extractToolSchemaMap(nativeBody())
    );
    const wire = JSON.stringify(response);
    assert.ok(wire.includes(`"id":${token}`), wire);
    assert.ok(!wire.includes('"model":null'));
  });
}

test("surgical JSON edits do not resurrect duplicate-key values", () => {
  const raw = '{"description":"synthetic","prompt":"synthetic","model":"sonnet","model":null}';
  assert.equal(translateEvents(raw, agentSchema).json, raw);
});

test("lossless cleanup retains nested tokens and escaped key/value bytes", () => {
  const raw =
    '{ "description":"synthetic", "prompt":"synthetic", "nested":{"id":9007199254740993,"v":"comma,brace}\\\\"}, "\\u006dodel":null }';
  const result = translateEvents(raw, agentSchema).json;
  assert.ok(result.includes('"nested":{"id":9007199254740993,"v":"comma,brace}\\\\"}'));
  assert.ok(!result.includes("\\u006dodel"));
  assert.doesNotThrow(() => JSON.parse(result));
});

test("unresolved schema references preserve null for client validation", () => {
  const schema = {
    ...agentSchema,
    properties: { ...agentSchema.properties, external: { $ref: "#/definitions/external" } },
  };
  assert.deepEqual(JSON.parse(translateEvents({ ...original, external: null }, schema).json), {
    ...expected,
    external: null,
  });
});

test("two sequential streamed tool calls retain distinct IDs without duplicate invocation", () => {
  const state = { toolSchemas: extractToolSchemaMap(nativeBody()) };
  const client = { toolCalls: new Map() };
  const items = ["first", "second"].map((id) => ({
    type: "function_call",
    name: "Agent",
    call_id: id,
    arguments: JSON.stringify(original),
  }));
  const events = items.flatMap((item) => [
    { type: "response.output_item.added", item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", delta: item.arguments },
    { type: "response.output_item.done", item },
  ]);
  events.push({
    type: "response.completed",
    response: { status: "completed", output: items, usage: { input_tokens: 10, output_tokens: 5 } },
  } as any);
  const output = events
    .flatMap((event) => asArray(openaiResponsesToOpenAIResponse(event, state)))
    .flatMap((chunk) => asArray(openaiToClaudeResponse(chunk, client)));
  const starts = output.filter(
    (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use"
  );
  assert.deepEqual(
    starts.map((e) => e.content_block.id),
    ["first", "second"]
  );
  for (const start of starts) {
    const json = output
      .filter((e) => e.index === start.index && e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json)
      .join("");
    assert.deepEqual(JSON.parse(json), expected);
  }
});

test("plain text streaming is unchanged", () => {
  const state = { toolSchemas: extractToolSchemaMap(nativeBody()) };
  const client = { toolCalls: new Map() };
  const chunks = [
    { type: "response.output_text.delta", delta: "synthetic text" },
    {
      type: "response.completed",
      response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ].flatMap((event) => asArray(openaiResponsesToOpenAIResponse(event, state)));
  const output = chunks.flatMap((chunk) => asArray(openaiToClaudeResponse(chunk, client)));
  assert.equal(
    output
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join(""),
    "synthetic text"
  );
  assert.equal(output.filter((e) => e.content_block?.type === "tool_use").length, 0);
});

test("an aborted buffered stream does not emit a tool invocation", () => {
  const result = translateEvents(original, agentSchema, "abort");
  assert.equal(result.starts.length, 0);
  assert.equal(result.json, "");
  assert.ok(result.state.upstreamError);
});

for (const objectArgs of [false, true]) {
  test(`non-streaming Responses→Claude ${objectArgs ? "object" : "string"} args use original schema`, () => {
    const schema = {
      ...agentSchema,
      properties: { ...agentSchema.properties, note: { type: ["string", "null"], default: null } },
      required: [...agentSchema.required, "note"],
    };
    const args = { ...original, note: null };
    const response = translateNonStreamingResponse(
      {
        object: "response",
        id: "synthetic",
        model: "synthetic",
        output: [
          {
            type: "function_call",
            call_id: "synthetic_call",
            name: "Agent",
            arguments: objectArgs ? args : JSON.stringify(args),
          },
        ],
      },
      "openai-responses",
      "claude",
      null,
      extractToolSchemaMap(nativeBody(schema))
    ) as any;
    const call = response.content.find((block) => block.type === "tool_use");
    assert.equal(call.id, "synthetic_call");
    assert.deepEqual(call.input, { ...expected, note: null });
  });
}

test("compiled SSE stream prefers caller schema over transport-only nullable widening", async () => {
  let completed = 0;
  const caller = nativeBody(structuredClone(agentSchema));
  const originalSchemas = extractToolSchemaMap(caller);
  const transportSchema = structuredClone(agentSchema);
  for (const field of ["model", "effort", "isolation"]) {
    transportSchema.properties[field].type = ["string", "null"] as any;
    transportSchema.properties[field].enum.push(null as never);
  }
  const body = { tools: [{ type: "function", name: "Agent", parameters: transportSchema }] };
  const transform = createSSETransformStreamWithLogger(
    "openai-responses",
    "claude",
    "synthetic",
    null,
    null,
    "synthetic",
    null,
    body,
    () => {
      completed++;
    },
    null,
    null,
    false,
    false,
    new Set(),
    null,
    originalSchemas
  );
  const args = JSON.stringify(original);
  const item = {
    type: "function_call",
    name: "Agent",
    call_id: "synthetic_stream",
    arguments: args,
  };
  const events = [
    { type: "response.output_item.added", item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", delta: args },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
  const encoder = new TextEncoder();
  const input = new ReadableStream({
    start(controller) {
      for (const e of events)
        controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      controller.close();
    },
  });
  const text = await new Response(input.pipeThrough(transform)).text();
  const output = text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  const toolStarts = output.filter(
    (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use"
  );
  assert.equal(toolStarts.length, 1);
  const json = output
    .filter((e) => e.delta?.type === "input_json_delta")
    .map((e) => e.delta.partial_json)
    .join("");
  assert.deepEqual(JSON.parse(json), expected);
  assert.ok(output.some((e) => e.type === "message_stop"));
  assert.equal(completed, 1);
});
