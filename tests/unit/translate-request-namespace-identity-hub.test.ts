// A Responses request with namespace tool groups is flattened to Chat function names, and the
// Responses->Chat step records a { flatName -> { namespace, name } } identity map. A later hub
// step (openai -> claude, ...) builds a new object and used to drop that map, so the tool call
// came back to the client without its namespace. translateRequest now carries the map to the
// final result on its own non-enumerable `_namespaceIdentityMap`, leaving `_toolNameMap` for the
// translators' string alias maps (Claude proxy_ prefix, Gemini renames).
import test from "node:test";
import assert from "node:assert/strict";

const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { isNamespaceIdentityMap } =
  await import("../../open-sse/translator/helpers/namespaceIdentity.ts");

const NS = "mcp__codex_apps__google_calendar";
const FLAT_LIST = `${NS}___list_calendars`;
const FLAT_SEARCH = `${NS}___search_events`;

function responsesBody(withNamespace = true) {
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
  const map = out._namespaceIdentityMap;
  assert.ok(map instanceof Map, "identity map is attached");
  assert.deepEqual((map as Map<string, unknown>).get(FLAT_LIST), {
    namespace: NS,
    name: "_list_calendars",
  });
  assert.deepEqual((map as Map<string, unknown>).get(FLAT_SEARCH), {
    namespace: NS,
    name: "_search_events",
  });
  assert.equal(Object.keys(out).includes("_namespaceIdentityMap"), false, "must not enumerate");
  assert.equal(JSON.stringify(out).includes("_namespaceIdentityMap"), false, "must not serialize");
}

for (const target of ["claude", "openai", "gemini", "cursor", "kiro", "antigravity"]) {
  test(`namespace identity map survives translation to ${target}`, () => {
    assertIdentity(run(target));
  });
}

test("no namespace tools yields no identity map", () => {
  for (const target of ["claude", "openai", "gemini"]) {
    const out = run(target, responsesBody(false));
    assert.equal("_namespaceIdentityMap" in out, false, target);
    assert.equal(
      isNamespaceIdentityMap(out._toolNameMap),
      false,
      `${target}: no identity map on the alias channel`
    );
  }
});

test("claude keeps its own string alias map in _toolNameMap next to the identity map", () => {
  // Without _disableToolPrefix the Claude translator prefixes tool names and carries proxy_
  // aliases on _toolNameMap. The identity map travels on its own property so neither is lost.
  const out = run("claude");
  const alias = out._toolNameMap as Map<string, unknown>;
  assert.ok(alias instanceof Map && alias.size > 0);
  assert.equal(alias.get(`proxy_${FLAT_LIST}`), FLAT_LIST);
  assert.equal(isNamespaceIdentityMap(alias), false);
  assertIdentity(out);
});

test("with the prefix disabled claude has no alias map and the identity map still arrives", () => {
  const out = run("claude", { ...responsesBody(), _disableToolPrefix: true });
  assert.equal(isNamespaceIdentityMap(out._toolNameMap), false);
  assertIdentity(out);
});
