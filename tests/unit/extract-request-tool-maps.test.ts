// chatCore reads two different maps off a translated body, both carried on non-enumerable
// properties: the namespace identity map ({ namespace, name } values, for returning namespaced
// tool calls to the client) and the string alias map (a translator renamed a tool; maps the
// upstream name back). They must be separated, never confused, and both removed from the body.
import test from "node:test";
import assert from "node:assert/strict";

const { extractRequestToolMaps, isNamespaceIdentityMap } =
  await import("../../open-sse/translator/helpers/namespaceIdentity.ts");

const identity = () => new Map([["ns___a", { namespace: "ns", name: "_a" }]]);
const alias = () => new Map([["ns_a", "ns___a"]]);

function bodyWith(props: Record<string, unknown>) {
  const body: Record<string, unknown> = { model: "m" };
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(body, k, {
      value: v,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return body;
}

test("identity map on its own channel only", () => {
  const body = bodyWith({ _namespaceIdentityMap: identity() });
  const { identityMap, aliasMap } = extractRequestToolMaps(body);
  assert.equal(identityMap?.get("ns___a")?.namespace, "ns");
  assert.equal(aliasMap, null);
  assert.equal("_namespaceIdentityMap" in body, false);
});

test("alias map only: never reported as an identity map", () => {
  const body = bodyWith({ _toolNameMap: alias() });
  const { identityMap, aliasMap } = extractRequestToolMaps(body);
  assert.equal(identityMap, null);
  assert.equal(aliasMap?.get("ns_a"), "ns___a");
  assert.equal("_toolNameMap" in body, false);
});

test("both maps: each lands in its own slot", () => {
  const body = bodyWith({ _namespaceIdentityMap: identity(), _toolNameMap: alias() });
  const { identityMap, aliasMap } = extractRequestToolMaps(body);
  assert.ok(isNamespaceIdentityMap(identityMap));
  assert.equal(aliasMap?.get("ns_a"), "ns___a");
  assert.equal("_toolNameMap" in body || "_namespaceIdentityMap" in body, false);
});

test("legacy: an identity map left on _toolNameMap is still read as identity, not alias", () => {
  const body = bodyWith({ _toolNameMap: identity() });
  const { identityMap, aliasMap } = extractRequestToolMaps(body);
  assert.ok(isNamespaceIdentityMap(identityMap));
  assert.equal(aliasMap, null);
  assert.equal("_toolNameMap" in body, false);
});

test("neither map", () => {
  const body = { model: "m" };
  assert.deepEqual(extractRequestToolMaps(body), { identityMap: null, aliasMap: null });
  assert.deepEqual(body, { model: "m" });
});

test("alias map is returned as the same instance so a later merge (Kiro name map) extends it", () => {
  const original = alias();
  const body = bodyWith({ _toolNameMap: original });
  const { aliasMap } = extractRequestToolMaps(body);
  assert.equal(aliasMap, original);
  aliasMap?.set("truncated", "original");
  assert.equal(original.get("truncated"), "original");
});
