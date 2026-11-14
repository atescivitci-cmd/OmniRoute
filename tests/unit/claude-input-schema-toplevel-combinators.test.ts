// Anthropic rejects a tool input_schema that has oneOf, allOf or anyOf at the TOP level
// ("input_schema does not support oneOf, allOf, or anyOf at the top level"). Some MCP and client
// tools (for example a JS REPL tool) declare their arguments that way, so one such tool made the
// whole request fail with a 400. The translator must flatten the combinator into a plain object
// schema, keep nested combinators untouched, and leave ordinary schemas unchanged.
import test from "node:test";
import assert from "node:assert/strict";

const { openaiToClaudeRequest } =
  await import("../../open-sse/translator/request/openai-to-claude.ts");
const { normalizeClaudeInputSchema } =
  await import("../../open-sse/translator/helpers/claudeInputSchema.ts");

const COMBINATORS = ["oneOf", "anyOf", "allOf"];
const hasTopLevel = (s: Record<string, unknown>) => COMBINATORS.some((k) => k in s);

test("oneOf variants that only constrain required are flattened and keep base properties", () => {
  const schema = {
    type: "object",
    properties: { code: { type: "string" }, file: { type: "string" } },
    oneOf: [{ required: ["code"] }, { required: ["file"] }],
  };
  const out = normalizeClaudeInputSchema(schema);
  assert.equal(hasTopLevel(out), false);
  assert.equal(out.type, "object");
  assert.deepEqual(Object.keys(out.properties as object).sort(), ["code", "file"]);
  assert.deepEqual(out.required ?? [], []);
});

test("anyOf object variants are merged: properties unioned, required intersected", () => {
  const schema = {
    anyOf: [
      {
        type: "object",
        properties: { a: { type: "string" }, c: { type: "number" } },
        required: ["a", "c"],
      },
      {
        type: "object",
        properties: { b: { type: "string" }, c: { type: "number" } },
        required: ["b", "c"],
      },
    ],
  };
  const out = normalizeClaudeInputSchema(schema);
  assert.equal(hasTopLevel(out), false);
  assert.equal(out.type, "object");
  assert.deepEqual(Object.keys(out.properties as object).sort(), ["a", "b", "c"]);
  assert.deepEqual(out.required, ["c"]);
});

test("allOf is merged: properties unioned, required unioned", () => {
  const schema = {
    type: "object",
    allOf: [
      { properties: { a: { type: "string" } }, required: ["a"] },
      { properties: { b: { type: "string" } }, required: ["b"] },
    ],
  };
  const out = normalizeClaudeInputSchema(schema);
  assert.equal(hasTopLevel(out), false);
  assert.deepEqual(Object.keys(out.properties as object).sort(), ["a", "b"]);
  assert.deepEqual([...(out.required as string[])].sort(), ["a", "b"]);
});

test("nested combinators and ordinary schemas are left exactly as they were", () => {
  const nested = {
    type: "object",
    properties: { v: { oneOf: [{ type: "string" }, { type: "number" }] } },
    required: ["v"],
  };
  assert.deepEqual(normalizeClaudeInputSchema(nested), nested);
  const plain = { type: "object", properties: { city: { type: "string" } } };
  assert.deepEqual(normalizeClaudeInputSchema(plain), plain);
});

test("non-object variants fall back to a permissive object instead of an invalid schema", () => {
  const out = normalizeClaudeInputSchema({ oneOf: [{ type: "string" }, { type: "number" }] });
  assert.equal(hasTopLevel(out), false);
  assert.equal(out.type, "object");
});

test("the input is never mutated", () => {
  const schema = { type: "object", properties: { a: {} }, oneOf: [{ required: ["a"] }] };
  const before = JSON.stringify(schema);
  normalizeClaudeInputSchema(schema);
  assert.equal(JSON.stringify(schema), before);
});

test("translating a request with one such tool yields no top-level combinator in any tool", () => {
  const request = {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "ok_tool",
          parameters: { type: "object", properties: { x: { type: "string" } } },
        },
      },
      {
        type: "function",
        function: {
          name: "js",
          description: "run js",
          parameters: {
            type: "object",
            properties: { code: { type: "string" }, path: { type: "string" } },
            oneOf: [{ required: ["code"] }, { required: ["path"] }],
          },
        },
      },
    ],
  };
  const translated = openaiToClaudeRequest("claude-opus-4-8", request, false);
  assert.equal(translated.tools.length, 2);
  for (const tool of translated.tools)
    assert.equal(hasTopLevel(tool.input_schema), false, tool.name);
  const js = translated.tools.find((t: { name: string }) => /js$/.test(t.name));
  assert.deepEqual(Object.keys(js.input_schema.properties).sort(), ["code", "path"]);
});

test("a Responses-API request (namespace tool carrying such a function) translated for Claude has none", async () => {
  const { translateRequest } = await import("../../open-sse/translator/index.ts");
  const body = {
    model: "claude-opus-4-8",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: [
      {
        type: "function",
        name: "exec_command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
      {
        type: "namespace",
        name: "mcp__cua_repl",
        tools: [
          {
            type: "function",
            name: "js",
            description: "run js",
            parameters: {
              type: "object",
              properties: { code: { type: "string" }, path: { type: "string" } },
              oneOf: [{ required: ["code"] }, { required: ["path"] }],
            },
          },
        ],
      },
    ],
  };
  const out = translateRequest(
    "openai-responses",
    "claude",
    "claude-opus-4-8",
    structuredClone(body),
    false,
    null,
    "claude"
  ) as {
    tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
  };
  assert.ok(out.tools.length >= 2, JSON.stringify(out.tools.map((t) => t.name)));
  for (const tool of out.tools) assert.equal(hasTopLevel(tool.input_schema), false, tool.name);
});

test("conflicting definitions of one property become anyOf so no variant turns impossible", () => {
  const schema = {
    type: "object",
    oneOf: [
      {
        properties: { kind: { const: "a" }, x: { type: "string" } },
        required: ["kind", "x"],
      },
      {
        properties: { kind: { const: "b" }, y: { type: "string" } },
        required: ["kind", "y"],
      },
    ],
  };
  const out = normalizeClaudeInputSchema(schema);
  assert.equal(hasTopLevel(out), false);
  const props = out.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(props.kind, { anyOf: [{ const: "a" }, { const: "b" }] });
  assert.deepEqual(props.x, { type: "string" });
  assert.deepEqual(out.required, ["kind"]);
  // Both original variants still validate against the flattened shape.
  const accepts = (payload: Record<string, unknown>) =>
    (out.required as string[]).every((k) => k in payload) &&
    (props.kind.anyOf as Array<{ const: string }>).some((s) => s.const === payload.kind);
  assert.equal(accepts({ kind: "a", x: "1" }), true);
  assert.equal(accepts({ kind: "b", y: "2" }), true);
});

test("equal property schemas across variants are de-duplicated, three-way conflicts keep all", () => {
  const same = normalizeClaudeInputSchema({
    anyOf: [
      { properties: { q: { type: "string" } }, required: ["q"] },
      { properties: { q: { type: "string" } }, required: ["q"] },
    ],
  });
  assert.deepEqual((same.properties as Record<string, unknown>).q, { type: "string" });
  const three = normalizeClaudeInputSchema({
    anyOf: [
      { properties: { v: { type: "string" } } },
      { properties: { v: { type: "number" } } },
      { properties: { v: { type: "string" } } },
      { properties: { v: { type: "boolean" } } },
    ],
  });
  assert.deepEqual((three.properties as Record<string, unknown>).v, {
    anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
  });
});

test("a conflict with a base property keeps the base schema as the first choice", () => {
  const out = normalizeClaudeInputSchema({
    type: "object",
    properties: { mode: { type: "string" } },
    oneOf: [{ properties: { mode: { enum: ["fast"] } } }],
  });
  assert.deepEqual((out.properties as Record<string, unknown>).mode, {
    anyOf: [{ type: "string" }, { enum: ["fast"] }],
  });
});

test("the description summarises the alternatives and keeps an existing description", () => {
  const out = normalizeClaudeInputSchema({
    type: "object",
    description: "Run code.",
    properties: { code: { type: "string" }, path: { type: "string" } },
    oneOf: [{ required: ["code"] }, { required: ["path"] }],
  });
  assert.equal(out.description, "Run code.\n\nAccepts one of: {code} | {path}");
  const bare = normalizeClaudeInputSchema({
    anyOf: [
      { properties: { a: {} }, required: ["a", "b"] },
      { properties: { c: {} }, required: ["c"] },
    ],
  });
  assert.equal(bare.description, "Accepts one of: {a, b} | {c}");
  const noSummary = normalizeClaudeInputSchema({
    type: "object",
    properties: { a: {} },
    allOf: [{ required: ["a"] }],
  });
  assert.equal(noSummary.description, undefined);
});

test("a missing type becomes object and an array type containing object collapses to object", () => {
  assert.equal(
    normalizeClaudeInputSchema({ properties: { a: { type: "string" } } }).type,
    "object"
  );
  assert.equal(
    normalizeClaudeInputSchema({ type: ["object", "null"], properties: {} }).type,
    "object"
  );
  assert.deepEqual(normalizeClaudeInputSchema({ type: ["string", "null"] }).type, [
    "string",
    "null",
  ]);
});

test("top-level not, if, then and else are removed with or without a combinator", () => {
  const keys = ["not", "if", "then", "else"];
  const plain = normalizeClaudeInputSchema({
    type: "object",
    properties: { a: { not: { type: "null" } } },
    not: { required: ["z"] },
    if: { properties: { a: { const: 1 } } },
    then: { required: ["a"] },
    else: { required: [] },
  });
  for (const k of keys) assert.equal(k in plain, false, k);
  assert.deepEqual((plain.properties as Record<string, unknown>).a, { not: { type: "null" } });
  const combined = normalizeClaudeInputSchema({
    oneOf: [{ required: ["a"], properties: { a: {} } }],
    not: {},
    if: {},
  });
  for (const k of keys) assert.equal(k in combined, false, k);
});

test("ordinary schemas pass through the translator with the extra keywords stripped", () => {
  const translated = openaiToClaudeRequest(
    "claude-opus-4-8",
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "plain_tool",
            parameters: { properties: { x: { type: "string" } }, not: { required: ["y"] } },
          },
        },
      ],
    },
    false
  );
  const schema = translated.tools[0].input_schema;
  assert.equal(schema.type, "object");
  assert.equal("not" in schema, false);
  assert.deepEqual(schema.properties, { x: { type: "string" } });
});
