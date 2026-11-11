import test from "node:test";
import assert from "node:assert/strict";
import { BaseExecutor } from "../../open-sse/executors/base.ts";

class FixtureExecutor extends BaseExecutor {
  constructor(provider = "claude") {
    super(provider, {
      baseUrls: ["https://fixture.invalid/v1/messages"],
      baseUrl: "https://fixture.invalid/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
    });
  }
  transformRequest(_model: string, body: any): any {
    return { ...body, fixtureGenericTransform: true };
  }
}

function body(messages: any[], extras: Record<string, unknown> = {}): any {
  return {
    model: "fixture-model",
    safeguards: [{ type: "fixture", allow: false }],
    output_config: { effort: "high", future: { retained: true } },
    messages,
    tools: [{ name: "fixture_tool", input_schema: { type: "object" } }],
    future_request_field: { exact: ["order", "kept"] },
    ...extras,
  };
}

async function execute(input: any, provider = "claude") {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: any; serialized: string; headers: Headers }> = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/fixture\.invalid\//);
    const serialized = String(init?.body ?? "");
    calls.push({
      url: String(url),
      body: JSON.parse(serialized),
      serialized,
      headers: new Headers(init?.headers),
    });
    return new Response(
      JSON.stringify({
        type: "message",
        content: [],
        safeguard_results: [{ decision: "fixture" }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };
  try {
    const result = await new FixtureExecutor(provider).execute({
      model: "fixture-model",
      body: input,
      stream: false,
      credentials: { apiKey: "fixture-only" },
      clientHeaders: {
        "anthropic-version": "2099-01-01",
        "anthropic-beta": "fixture-beta",
        "anthropic-future-capability": "fixture-value",
      },
    });
    const response = (result as { response?: unknown }).response;
    assert.ok(response instanceof Response, "mock native executor must return a Response");
    return { result: { ...result, response }, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("native safeguards wire lifts only the initial content-bearing system prefix", async () => {
  const systemBlock = {
    type: "text",
    text: "second\n  system",
    cache_control: { type: "ephemeral" },
    future: "kept",
  };
  const rest = [
    { role: "user", content: [], directives: [{ type: "fixture-directive" }], output_config: {} },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "opaque fixture", signature: "fixture-signature" },
        { type: "tool_use", id: "tool1", name: "fixture_tool", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool1",
          content: [{ type: "text", text: "result\n  exact" }],
        },
      ],
    },
    { role: "system", content: "later system remains in its original history position" },
  ];
  const original = body(
    [
      { role: "system", content: "first system" },
      { role: "system", content: [systemBlock] },
      ...rest,
    ],
    {
      system: [{ type: "text", text: "existing\n  system", cache_control: { type: "ephemeral" } }],
    }
  );
  const before = structuredClone(original);
  const { result, calls } = await execute(original);
  assert.equal(result.response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    ...before,
    system: [...before.system, { type: "text", text: "first system" }, systemBlock],
    messages: rest,
  });
  assert.deepEqual(original, before);
  assert.equal(calls[0].headers.get("anthropic-future-capability"), "fixture-value");
  assert.deepEqual(await result.response.json(), {
    type: "message",
    content: [],
    safeguard_results: [{ decision: "fixture" }],
  });
});

test("existing string system precedes lifted prefix without changing text bytes", async () => {
  const original = body(
    [
      { role: "system", content: "\tleading\r\ntext " },
      { role: "user", content: "ask" },
    ],
    { system: "existing\n\n" }
  );
  const { calls } = await execute(original);
  assert.deepEqual(calls[0].body.system, [
    { type: "text", text: "existing\n\n" },
    { type: "text", text: "\tleading\r\ntext " },
  ]);
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "ask" }]);
});

for (const role of ["system", "user", "assistant"]) {
  for (const empty of ["absent", "string", "array"]) {
    test(`directive-only ${role} with ${empty} content is untouched and ends the liftable prefix`, async () => {
      const directive: any = {
        role,
        output_config: {},
        safeguards: [{ type: "future-fixture" }],
        directives: [{ type: "keep" }],
      };
      if (empty === "string") directive.content = "";
      if (empty === "array") directive.content = [];
      const original = body([
        directive,
        { role: "system", content: "after boundary" },
        { role: "user", content: "ask" },
      ]);
      const before = structuredClone(original);
      const { calls } = await execute(original);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].serialized, JSON.stringify(before));
      assert.deepEqual(original, before);
    });
  }
}

test("noninitial system and developer records are not hoisted by this scoped repair", async () => {
  const original = body([
    { role: "user", content: "start" },
    { role: "system", content: "later" },
    { role: "developer", content: "later developer" },
  ]);
  const { calls } = await execute(original);
  assert.equal(calls[0].serialized, JSON.stringify(original));
});

test("a directive-only system record stops lifting after an otherwise valid initial prefix", async () => {
  const rest = [
    { role: "system", content: [], directives: [{ type: "keep-empty-directive" }] },
    { role: "system", content: "later system is not part of the liftable prefix" },
    { role: "user", content: "ask" },
  ];
  const original = body([{ role: "system", content: "initial" }, ...rest]);
  const before = structuredClone(original);
  const { calls } = await execute(original);
  assert.deepEqual(calls[0].body, {
    ...before,
    system: [{ type: "text", text: "initial" }],
    messages: rest,
  });
  assert.deepEqual(original, before);
});

test("an unqualified later prefix record cannot partially commit an earlier lift", async () => {
  const original = body([
    { role: "system", content: "first valid system" },
    { role: "system", content: "second with semantics", directives: [{ type: "keep" }] },
    { role: "user", content: "ask" },
  ]);
  const before = structuredClone(original);
  const { calls } = await execute(original);
  assert.equal(calls[0].serialized, JSON.stringify(before));
  assert.deepEqual(original, before);
});

const unsupported = [
  {
    name: "mixed nontext content",
    message: {
      role: "system",
      content: [
        { type: "text", text: "text" },
        { type: "image", source: { type: "fixture" } },
      ],
    },
  },
  {
    name: "unsupported object content",
    message: { role: "system", content: { future: "fixture-private-marker" } },
  },
  {
    name: "semantic message container fields",
    message: { role: "system", content: "text", directives: [{ type: "must-not-drop" }] },
  },
  { name: "invalid text block", message: { role: "system", content: [{ type: "text", text: 7 }] } },
];
for (const item of unsupported) {
  test(`unqualified initial system is preserved without pruning: ${item.name}`, async () => {
    const original = body([item.message, { role: "user", content: "ask" }]);
    const before = structuredClone(original);
    const { result, calls } = await execute(original);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].serialized, JSON.stringify(before));
    assert.equal(result.response.status, 200); // Fake upstream response, not compatibility acceptance.
    assert.deepEqual(original, before);
  });
}

test("unqualified existing system field is preserved rather than overwritten", async () => {
  const original = body(
    [
      { role: "system", content: "initial" },
      { role: "user", content: "ask" },
    ],
    { system: { future: "must-not-drop" } }
  );
  const { result, calls } = await execute(original);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serialized, JSON.stringify(original));
  assert.equal(result.response.status, 200); // Fake upstream response, not compatibility acceptance.
});

test("GitHub safeguards-shaped input does not activate the Claude-only normalization", async () => {
  const original = body([
    { role: "system", content: "initial" },
    { role: "user", content: "ask" },
  ]);
  const { calls } = await execute(original, "github");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.fixtureGenericTransform, true);
  assert.deepEqual(calls[0].body.messages, original.messages);
});
