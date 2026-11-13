// Refusal diagnostics: a pre-dispatch 422 must say WHICH feature refused, without
// copying any request content. Pure fixtures; no runtime clients or operational data.
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeRequestCompatibilityRefusal,
  probeRequestCompatibility,
} from "../../open-sse/services/requestCompatibility.ts";

const SECRET = "sk-synthetic-should-never-appear-0123456789";
const target = (extra: Record<string, unknown> = {}) => ({
  provider: "synthetic-provider",
  model: "synthetic-model",
  contextManagement: "unknown" as const,
  ...extra,
});

test("names the refusal code, target and only the shape of context_management", () => {
  const body = {
    model: "alias",
    input: [{ role: "user", content: SECRET }],
    instructions: SECRET,
    context_management: { edits: [{ type: "compact_20260101", note: SECRET }] },
  };
  const t = target();
  const probe = probeRequestCompatibility(body, t);
  assert.equal(probe.ok, false);
  const d = describeRequestCompatibilityRefusal(body, t, (probe as { code: string }).code);
  assert.equal(d.code, "request_context_management_unavailable");
  assert.equal(d.provider, "synthetic-provider");
  assert.equal(d.model, "synthetic-model");
  assert.equal(d.targetContextManagement, "unknown");
  assert.deepEqual(d.contextManagement, {
    present: true,
    keys: ["edits"],
    editTypes: ["compact_20260101"],
  });
  assert.ok(d.bodyKeys.includes("context_management") && d.bodyKeys.includes("input"));
  assert.ok(!JSON.stringify(d).includes(SECRET), "diagnostics must not copy request content");
});

test("reports tool count against the target limit", () => {
  const body = {
    tools: Array.from({ length: 140 }, (_, i) => ({ type: "function", name: `t${i}` })),
  };
  const t = target({ maxTools: 128 });
  const d = describeRequestCompatibilityRefusal(body, t, "request_tool_limit_exceeded");
  assert.equal(d.toolCount, 140);
  assert.equal(d.maxTools, 128);
  assert.deepEqual(d.toolTypes, ["function"]);
});

test("lists which declared unsupported controls are present, not their values", () => {
  const body = { reasoning_effort: SECRET, thinking: { type: "enabled", budget_tokens: 9 } };
  const t = target({ unsupportedControls: ["reasoning_effort", "output_config"] });
  const d = describeRequestCompatibilityRefusal(body, t, "request_required_control_unsupported");
  assert.deepEqual(d.unsupportedControlsPresent, ["reasoning_effort"]);
  assert.deepEqual(d.unsupportedControls, ["reasoning_effort", "output_config"]);
  assert.ok(!JSON.stringify(d).includes(SECRET));
});

test("is safe on hostile or malformed input and never throws", () => {
  const weirdKey = "x".repeat(500);
  const body: Record<string, unknown> = {
    [weirdKey]: 1,
    "key with spaces": 1,
    tools: "not-an-array",
    context_management: { edits: [{ type: SECRET }, null, 7] },
  };
  const d = describeRequestCompatibilityRefusal(
    body,
    target(),
    "request_context_management_unavailable"
  );
  assert.ok(!JSON.stringify(d).includes(SECRET), "unrecognised edit types are not echoed");
  assert.deepEqual(d.contextManagement.editTypes, ["<other>"]);
  assert.ok(d.bodyKeys.every((k) => /^[a-z0-9_]{1,40}$/.test(k) || k === "<other>"));
  assert.equal(d.toolCount, null);
  const none = describeRequestCompatibilityRefusal(
    null as never,
    target(),
    "request_required_control_unsupported"
  );
  assert.equal(none.code, "request_required_control_unsupported");
});
