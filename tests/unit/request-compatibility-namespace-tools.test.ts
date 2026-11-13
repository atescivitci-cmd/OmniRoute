// A Responses request may declare tool groups as `namespace` tools. Targets that receive a
// translated (non-Responses) body get every namespace expanded into standalone functions, so
// the pre-dispatch probe must count tools the way the dispatcher will send them. Otherwise a
// target is admitted at selection time and then refused after translation with
// request_tool_limit_exceeded. Pure fixtures; no runtime clients or operational data.
import test from "node:test";
import assert from "node:assert/strict";
import {
  countDispatchedTools,
  probeRequestCompatibility,
} from "../../open-sse/services/requestCompatibility.ts";
import { resolveRequestCompatibilityTarget } from "../../open-sse/services/requestCompatibilityTarget.ts";

const fn = (name: string) => ({ type: "function", name, parameters: { type: "object" } });
const ns = (name: string, n: number) => ({
  type: "namespace",
  name,
  tools: Array.from({ length: n }, (_, i) => ({ name: `t${i}`, parameters: { type: "object" } })),
});

// 12 top-level function tools + 56 namespaces of 26 sub-tools = 68 top-level, 1468 expanded.
const responsesBody = () => ({
  model: "alias",
  input: [{ role: "user", content: "synthetic" }],
  tools: [
    ...Array.from({ length: 12 }, (_, i) => fn(`f${i}`)),
    ...Array.from({ length: 56 }, (_, i) => ns(`server${i}`, 26)),
  ],
});

test("countDispatchedTools expands namespaces only when the target flattens them", () => {
  const body = responsesBody();
  assert.equal(countDispatchedTools(body.tools, false), 68);
  assert.equal(countDispatchedTools(body.tools, true), 12 + 56 * 26);
  assert.equal(countDispatchedTools("not-an-array" as never, true), 0);
  assert.equal(countDispatchedTools([{ type: "namespace" }, null, 7] as never, true), 2);
});

test("a capped target that flattens namespaces is refused before selection", () => {
  const body = responsesBody();
  const target = resolveRequestCompatibilityTarget(body, "github", "claude-opus-4.8");
  assert.equal(target.maxTools, 128);
  assert.equal(target.expandsNamespaceTools, true);
  const probe = probeRequestCompatibility(body, target);
  assert.deepEqual(probe, { ok: false, code: "request_tool_limit_exceeded" });
});

test("a Responses-native target keeps namespaces and is still admitted", () => {
  const body = responsesBody();
  const target = resolveRequestCompatibilityTarget(body, "codex", "gpt-native", "openai-responses");
  assert.equal(target.expandsNamespaceTools, false);
  assert.equal(probeRequestCompatibility(body, target).ok, true);
});

test("a high-limit target that flattens namespaces is still admitted", () => {
  const body = responsesBody();
  const target = resolveRequestCompatibilityTarget(body, "nvidia", "some-model");
  assert.equal(target.expandsNamespaceTools, true);
  assert.equal(probeRequestCompatibility(body, target).ok, true);
});

test("plain function tools under the cap are unaffected", () => {
  const body = { messages: [{ role: "user", content: "x" }], tools: [fn("a"), fn("b")] };
  const target = resolveRequestCompatibilityTarget(body, "github", "claude-opus-4.8");
  assert.equal(probeRequestCompatibility(body, target).ok, true);
});

test("a no-known-limit target that expands namespaces gets the dispatcher's default cap", () => {
  const body = responsesBody();
  const target = resolveRequestCompatibilityTarget(body, "claude", "claude-model");
  assert.equal(target.maxTools, 128);
  assert.deepEqual(probeRequestCompatibility(body, target), {
    ok: false,
    code: "request_tool_limit_exceeded",
  });
});

test("without namespace tools, a no-known-limit target keeps no planner cap", () => {
  const body = {
    messages: [{ role: "user", content: "x" }],
    tools: Array.from({ length: 200 }, (_, i) => fn(`f${i}`)),
  };
  const target = resolveRequestCompatibilityTarget(body, "claude", "claude-model");
  assert.equal(target.maxTools, null);
  assert.equal(probeRequestCompatibility(body, target).ok, true);
});
