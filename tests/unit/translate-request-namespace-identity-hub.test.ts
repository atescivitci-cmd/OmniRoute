// A Responses request with namespace tool groups is flattened to Chat function names and a
// non-enumerable `_toolNameMap` identity map ({ flatName -> { namespace, name } }). When the target
// needs a second hub step (openai -> claude, ...), that step builds a new object and used to drop
// the map, so the tool call came back to the client without its namespace. translateRequest must
// carry the identity map across the hub.
import test from "node:test";
import assert from "node:assert/strict";

const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { isNamespaceIdentityMap } =
  await import("../../open-sse/translator/helpers/namespaceIdentity.ts");

const NS = "mcp__codex_apps__google_calendar";
const FLAT_LIST = `${NS}___list_calendars`;
const FLAT_SEARCH = `${NS}___search_events`;

// `_disableToolPrefix` is what the gateway sets for Claude-shape upstreams that do not use the
// OAuth `proxy_` tool prefix; without it the Claude translator carries its own alias map instead.
function responsesBody(withNamespace = true, disablePrefix = true) {
  const tools: unknown[] = [
    {
      type: "function",
      name: "shell",
      description: "run a command",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    },
  ];
  if (withNamespace) {
    tools.push({
      type: "namespace",
      name: NS,
      description: "calendar",
      tools: [
        {
          type: "function",
          name: "_list_calendars",
          description: "list",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "function",
          name: "_search_events",
          description: "search",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    });
  }
  return {
    model: "m",
    ...(disablePrefix ? { _disableToolPrefix: true } : {}),
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools,
  };
}

function run(target: string, body = responsesBody()) {
  return translateRequest(
    "openai-responses",
    target,
    "some-model",
    structuredClone(body),
    false,
    null,
    target
  ) as Record<string, unknown>;
}

function assertIdentity(out: Record<string, unknown>) {
  const map = out._toolNameMap;
  assert.ok(map instanceof Map, "identity map is attached");
  assert.deepEqual((map as Map<string, unknown>).get(FLAT_LIST), {
    namespace: NS,
    name: "_list_calendars",
  });
  assert.deepEqual((map as Map<string, unknown>).get(FLAT_SEARCH), {
    namespace: NS,
    name: "_search_events",
  });
  assert.equal(Object.keys(out).includes("_toolNameMap"), false, "must not be enumerable");
  assert.equal(JSON.stringify(out).includes("_toolNameMap"), false, "must not serialize");
}

for (const target of ["claude", "openai", "cursor", "kiro"]) {
  test(`namespace identity map survives translation to ${target}`, () => {
    assertIdentity(run(target));
  });
}

test("no namespace tools yields no identity map", () => {
  for (const target of ["claude", "openai"]) {
    const out = run(target, responsesBody(false));
    assert.equal("_toolNameMap" in out, false, target);
  }
});

test("isNamespaceIdentityMap accepts only non-empty maps of {namespace,name} strings", () => {
  assert.equal(isNamespaceIdentityMap(new Map([["a", { namespace: "n", name: "x" }]])), true);
  assert.equal(isNamespaceIdentityMap(new Map()), false);
  assert.equal(isNamespaceIdentityMap(new Map([["a", "alias"]])), false);
  assert.equal(isNamespaceIdentityMap(new Map([["a", { namespace: "n" }]])), false);
  assert.equal(isNamespaceIdentityMap(new Map([["a", { namespace: 1, name: "x" }]])), false);
  assert.equal(isNamespaceIdentityMap({ a: { namespace: "n", name: "x" } }), false);
  assert.equal(isNamespaceIdentityMap(null), false);
});

test("the claude step's own string alias map is left untouched", () => {
  // With the OAuth tool prefix in use the Claude translator carries proxy_ aliases on the same
  // property; the hub must not overwrite or merge into it.
  const out = run("claude", responsesBody(true, false));
  const map = out._toolNameMap as Map<string, unknown>;
  assert.ok(map instanceof Map && map.size > 0);
  assert.equal(map.get(`proxy_${FLAT_LIST}`), FLAT_LIST);
  assert.equal(isNamespaceIdentityMap(map), false);
});
