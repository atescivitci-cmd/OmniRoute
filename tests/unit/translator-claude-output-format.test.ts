import test from "node:test";
import assert from "node:assert/strict";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.ts";

const schema = {
  type: "object",
  properties: {
    spoken_response: { type: "string" },
    preference_updates: { type: "array", items: { $ref: "#/$defs/update" } },
  },
  required: ["spoken_response"],
  additionalProperties: false,
  $defs: {
    update: {
      type: "object",
      properties: { value: { type: ["string", "null"] } },
      additionalProperties: false,
    },
  },
};
const base = () => ({
  messages: [{ role: "user", content: "Keep my light preference. Change chicken to salmon." }],
  max_tokens: 1024,
  temperature: 0.4,
  output_config: { effort: "low" },
});
const translate = (body: unknown) => claudeToOpenAIRequest("routed-model", body, false);

test("maps Anthropic JSON schema without strengthening optional fields or changing input", () => {
  const body = {
    ...base(),
    output_config: { effort: "low", format: { type: "json_schema", schema } },
  };
  const before = structuredClone(body);
  const result = translate(body);
  assert.deepEqual(result.response_format, {
    type: "json_schema",
    json_schema: { name: "response", schema },
  });
  assert.equal(
    (result.response_format as { json_schema: { schema: unknown } }).json_schema.schema,
    body.output_config.format.schema
  );
  assert.equal(
    (result.response_format as { json_schema: { strict?: boolean } }).json_schema.strict,
    undefined
  );
  assert.deepEqual(body, before);
  assert.equal(result.reasoning_effort, "low");
  assert.equal(result.max_tokens, 1024);
  assert.equal(result.reasoning_budget, undefined);
  assert.equal(result.thinking_token_budget, undefined);
});

test("absent format leaves the preexisting request shape and effort priority unchanged", () => {
  assert.deepEqual(translate({ ...base(), thinking: { type: "enabled", budget_tokens: 12000 } }), {
    model: "routed-model",
    messages: [{ role: "user", content: base().messages[0].content }],
    stream: false,
    max_tokens: 1024,
    temperature: 0.4,
    reasoning_effort: "low",
  });
});

for (const [label, format] of Object.entries({
  null: null,
  array: [],
  string: "json_schema",
  missingType: { schema },
  unknownType: { type: "json_object", schema },
  missingSchema: { type: "json_schema" },
  nullSchema: { type: "json_schema", schema: null },
  arraySchema: { type: "json_schema", schema: [] },
  stringSchema: { type: "json_schema", schema: "{}" },
  booleanSchema: { type: "json_schema", schema: true },
  unsupportedStrict: { type: "json_schema", schema, strict: true },
})) {
  test(`malformed explicit format ${label} fails with controlled 400 and no user-content echo`, () => {
    assert.throws(
      () => translate({ ...base(), output_config: { format } }),
      (error: Error & { statusCode?: number; errorType?: string }) =>
        error.statusCode === 400 &&
        error.errorType === "invalid_request_error" &&
        error.message.startsWith("output_config.format") &&
        !error.message.includes("salmon")
    );
  });
}

test("format preserves tools, cached system blocks, complete history and sampling controls", () => {
  const body = {
    ...base(),
    system: [
      { type: "text", text: "Remember mild and light.", cache_control: { type: "ephemeral" } },
    ],
    tools: [{ name: "lookup_menu", input_schema: { type: "object" } }],
    tool_choice: { type: "auto" },
    top_p: 0.8,
    stop_sequences: ["END"],
  };
  const credentials = { _preserveCacheControl: true };
  const without = claudeToOpenAIRequest("routed-model", body, true, credentials);
  const withFormat = claudeToOpenAIRequest(
    "routed-model",
    { ...body, output_config: { effort: "low", format: { type: "json_schema", schema } } },
    true,
    credentials
  );
  const { response_format, ...rest } = withFormat;
  assert.ok(response_format);
  assert.deepEqual(rest, without);
  assert.deepEqual(withFormat.messages[0].content, body.system);
});

test("full translation preserves the schema on Chat Completions and native Responses lanes", async () => {
  const { translateRequest } = await import("../../open-sse/translator/index.ts");
  const { FORMATS } = await import("../../open-sse/translator/formats.ts");
  const body = {
    ...base(),
    output_config: { effort: "low", format: { type: "json_schema", schema } },
  };
  const chat = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    "routed-model",
    structuredClone(body),
    false
  );
  assert.deepEqual(chat.response_format, {
    type: "json_schema",
    json_schema: { name: "response", schema },
  });
  const responses = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI_RESPONSES,
    "routed-model",
    structuredClone(body),
    false
  );
  assert.deepEqual(responses.text.format, { type: "json_schema", name: "response", schema });
  assert.equal(responses.text.format.strict, undefined);
  assert.equal(responses.response_format, undefined);
  assert.throws(
    () =>
      translateRequest(
        FORMATS.CLAUDE,
        FORMATS.OPENAI,
        "routed-model",
        {
          ...base(),
          output_config: { format: null },
        },
        false
      ),
    (error: Error & { statusCode?: number; errorType?: string }) =>
      error.statusCode === 400 && error.errorType === "invalid_request_error"
  );
});

// Characterization, not a proposed budget: main must resolve/requalify this
// executor coupling before releasing the restored structured-output carrier.
test("restored format currently activates the downstream implicit reasoning budget", async () => {
  const { sanitizeReasoningEffortForProvider, normalizeNvidiaHostedReasoningBudget } =
    await import("../../open-sse/executors/base/reasoningEffort.ts");
  const model = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
  const endpoint = "https://integrate.api.nvidia.com/v1/chat/completions";
  const toWire = (body: unknown) =>
    normalizeNvidiaHostedReasoningBudget(
      sanitizeReasoningEffortForProvider(body, "nvidia", model),
      "nvidia",
      model,
      endpoint
    ) as Record<string, unknown>;
  const plain = toWire(translate(base()));
  const structured = toWire(
    translate({
      ...base(),
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    })
  );
  assert.equal(plain.reasoning_budget, undefined);
  assert.equal(structured.reasoning_budget, 204);
  assert.equal(structured.max_tokens, 1024);
  assert.deepEqual(structured.response_format, {
    type: "json_schema",
    json_schema: { name: "response", schema },
  });
});
