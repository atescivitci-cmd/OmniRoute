// Pure compatibility contract fixtures; no runtime clients or operational data.
import test from "node:test";
import assert from "node:assert/strict";
import {
  assessRequestCompatibility,
  probeRequestCompatibility,
  requireRequestCompatibility,
  assertNativeProtocolDataUnchanged,
  RequestCompatibilityError,
} from "../../open-sse/services/requestCompatibility.ts";

const hint = () => ({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
const target = (extra: Record<string, unknown> = {}) => ({
  provider: "synthetic-provider",
  model: "synthetic-model",
  contextManagement: "unsupported" as const,
  ...extra,
});
const fresh = () => ({
  model: "client-alias",
  system: "Synthetic purpose.",
  messages: [{ role: "user", content: [{ type: "text", text: "Reply only: OK" }] }],
  tools: [],
  max_tokens: 512,
  stream: true,
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
  context_management: hint(),
  metadata: { user_id: "synthetic-session" },
});
const refuseContext = (body: Record<string, unknown>) => {
  assert.deepEqual(assessRequestCompatibility(body, target()), {
    ok: false,
    code: "request_context_management_unavailable",
  });
};

test("absent context management preserves data and deep-clones accepted bodies", () => {
  const body = fresh();
  delete (body as any).context_management;
  const before = structuredClone(body);
  const plan = requireRequestCompatibility(body, target());
  assert.deepEqual(plan.body, before);
  assert.deepEqual(plan.adaptations, []);
  assert.notEqual(plan.body, body);
  (plan.body.messages as any[])[0].content[0].text = "changed clone";
  assert.deepEqual(body, before);
});

for (const mode of ["unsupported", "unknown"] as const) {
  test(mode + " target omits only an exact inert hint on a fresh text request", () => {
    const body = fresh();
    const before = structuredClone(body);
    const plan = requireRequestCompatibility(body, target({ contextManagement: mode }));
    assert.equal(Object.hasOwn(plan.body, "context_management"), false);
    assert.deepEqual(plan.adaptations, ["omit_inactive_context_management"]);
    const expected = structuredClone(before) as Record<string, unknown>;
    delete expected.context_management;
    assert.deepEqual(plan.body, expected);
    assert.deepEqual(body, before);
  });
}

test("native target preserves active context edits and every requested control exactly", () => {
  const body = {
    ...fresh(),
    context_management: {
      edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 100 } }],
    },
  };
  const plan = requireRequestCompatibility(body, target({ contextManagement: "native" }));
  assert.deepEqual(plan.body, body);
  assert.deepEqual(plan.adaptations, []);
});

test("top-level thinking execution preferences are preserved, not mistaken for history", () => {
  for (const thinking of [
    { type: "adaptive" },
    { type: "enabled", budget_tokens: 256 },
    { type: "disabled" },
  ]) {
    const body = { ...fresh(), thinking };
    const plan = requireRequestCompatibility(body, target());
    assert.deepEqual(plan.body.thinking, thinking);
    assert.deepEqual(plan.body.output_config, body.output_config);
  }
});

for (const [name, value] of [
  ["active edit", { edits: [{ type: "clear_tool_uses_20250919" }] }],
  ["different keep", { edits: [{ type: "clear_thinking_20251015", keep: "last" }] }],
  ["extra edit key", { edits: [{ type: "clear_thinking_20251015", keep: "all", extra: true }] }],
  ["extra context key", { ...hint(), additional: true }],
  ["two edits", { edits: [...hint().edits, ...hint().edits] }],
  ["empty edits", { edits: [] }],
  ["null control", null],
  ["malformed control", "clear thinking"],
] as const) {
  test("non-native target refuses " + name + " without rewriting", () => {
    const body = { ...fresh(), context_management: value };
    const before = structuredClone(body);
    refuseContext(body);
    assert.deepEqual(body, before);
  });
}

test("assistant history or multiple user turns cannot qualify as a fresh request", () => {
  for (const messages of [
    [
      { role: "user", content: "old" },
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "new" },
    ],
    [
      { role: "user", content: "old" },
      { role: "user", content: "new" },
    ],
    [{ role: "assistant", content: "prefill" }],
    [],
  ])
    refuseContext({ ...fresh(), messages });
});

test("tool/image/thinking/signed/provider-bound blocks prohibit inert-hint omission", () => {
  for (const content of [
    [{ type: "image", source: { type: "base64", data: "synthetic" } }],
    [{ type: "image_url", image_url: { url: "https://invalid.example/synthetic.png" } }],
    [{ type: "thinking", thinking: "synthetic", signature: "opaque" }],
    [{ type: "redacted_thinking", data: "opaque" }],
    [{ type: "tool_use", id: "t1", name: "read", input: {} }],
    [{ type: "tool_result", tool_use_id: "t1", content: "synthetic" }],
    [{ type: "text", text: "hello", signature: "opaque" }],
  ])
    refuseContext({ ...fresh(), messages: [{ role: "user", content }] });
});

test("unknown content blocks and alternate dialects do not gain a fresh exemption", () => {
  refuseContext({
    ...fresh(),
    messages: [{ role: "user", content: [{ type: "future_block", text: "hello" }] }],
  });
  refuseContext({ ...fresh(), input: "alternate representation" });
  refuseContext({ ...fresh(), contents: [{ role: "user", parts: [{ text: "hello" }] }] });
});

test("system content must also be text-only for the inert exemption", () => {
  refuseContext({ ...fresh(), system: [{ type: "image", source: {} }] });
  const body = { ...fresh(), system: [{ type: "text", text: "Preserve these instructions." }] };
  assert.equal(assessRequestCompatibility(body, target()).ok, true);
});

test("continuation selectors and tool declarations prevent fresh-hint omission", () => {
  for (const field of [
    "previous_response_id",
    "conversation",
    "container",
    "conversation_id",
    "thread_id",
    "response_id",
  ]) {
    refuseContext({ ...fresh(), [field]: "opaque" });
  }
  refuseContext({ ...fresh(), tools: [{ name: "read", input_schema: {} }] });
  refuseContext({ ...fresh(), tool_choice: { type: "none" } });
});

test("known tool limit refuses rather than truncating input definitions", () => {
  const tools = Array.from({ length: 129 }, (_, index) => ({
    name: "tool_" + index,
    input_schema: { type: "object" },
  }));
  const body = { messages: [{ role: "user", content: "hello" }], tools };
  const before = structuredClone(body);
  assert.deepEqual(assessRequestCompatibility(body, target({ maxTools: 128 })), {
    ok: false,
    code: "request_tool_limit_exceeded",
  });
  assert.deepEqual(body, before);
  assert.equal(
    (requireRequestCompatibility(body, target({ maxTools: 129 })).body.tools as any[]).length,
    129
  );
  assert.equal(
    (requireRequestCompatibility(body, target({ maxTools: null })).body.tools as any[]).length,
    129
  );
});

test("requested known-unsupported controls are refused, never silently stripped", () => {
  for (const thinking of [{ type: "adaptive" }, null]) {
    const body = { messages: [{ role: "user", content: "hello" }], thinking };
    assert.deepEqual(
      assessRequestCompatibility(body, target({ unsupportedControls: ["thinking"] })),
      {
        ok: false,
        code: "request_required_control_unsupported",
      }
    );
  }
  assert.equal(
    assessRequestCompatibility(
      { thinking: undefined },
      target({ unsupportedControls: ["thinking"] })
    ).ok,
    true
  );
  assert.equal(
    assessRequestCompatibility({}, target({ unsupportedControls: ["thinking"] })).ok,
    true
  );
});

test("errors carry static codes, never rejected input content", () => {
  const body = { ...fresh(), context_management: { private_value: "PRIVATE-SYNTHETIC-MARKER" } };
  assert.throws(
    () => requireRequestCompatibility(body, target()),
    (error: unknown) =>
      error instanceof RequestCompatibilityError &&
      error.code === "request_context_management_unavailable" &&
      error.message === error.code &&
      !String(error).includes("PRIVATE-SYNTHETIC-MARKER")
  );
});

test("provider/model labels do not confer fresh exemption or change preservation", () => {
  const body = { ...fresh(), context_management: { edits: [{ type: "clear_tool_uses" }] } };
  for (const provider of ["github", "claude", "nvidia", "ollama-local", "unknown"]) {
    assert.equal(assessRequestCompatibility(body, target({ provider })).ok, false);
  }
});

const protectedFields = [
  "messages",
  "system",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "context_management",
];
for (const field of protectedFields) {
  test("native integrity rejects a change to " + field + " with a static failure", () => {
    const before = { ...fresh(), tool_choice: { type: "auto" } } as Record<string, unknown>;
    const after = structuredClone(before);
    after[field] = { changed: "PRIVATE-SYNTHETIC-MARKER" };
    assert.throws(
      () => assertNativeProtocolDataUnchanged(before, after),
      (error: unknown) =>
        error instanceof RequestCompatibilityError &&
        error.code === "request_integrity_mismatch" &&
        error.message === "request_integrity_mismatch"
    );
  });
}

test("native integrity compares nested bytes, signatures, tool IDs and definitions", () => {
  const before = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "a\n b", signature: "sig" },
          { type: "tool_use", id: "id1", name: "read", input: { path: "a b" } },
        ],
      },
    ],
    tools: [
      { name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ],
  };
  assert.doesNotThrow(() => assertNativeProtocolDataUnchanged(before, structuredClone(before)));
  for (const mutate of [
    (body: any) => (body.messages[0].content[0].thinking = "a b"),
    (body: any) => (body.messages[0].content[0].signature = "sig2"),
    (body: any) => (body.messages[0].content[1].id = "id2"),
    (body: any) => (body.messages[0].content[1].input.path = "ab"),
    (body: any) => (body.tools[0].input_schema.properties.path.type = "number"),
  ]) {
    const after = structuredClone(before);
    mutate(after);
    assert.throws(
      () => assertNativeProtocolDataUnchanged(before, after),
      RequestCompatibilityError
    );
  }
});

test("native integrity distinguishes undefined, missing fields and nested missing keys", () => {
  assert.throws(
    () => assertNativeProtocolDataUnchanged({ thinking: undefined }, {}),
    RequestCompatibilityError
  );
  assert.throws(
    () => assertNativeProtocolDataUnchanged({}, { thinking: undefined }),
    RequestCompatibilityError
  );
  assert.throws(
    () =>
      assertNativeProtocolDataUnchanged(
        { output_config: { effort: undefined } },
        { output_config: {} }
      ),
    RequestCompatibilityError
  );
  assert.doesNotThrow(() =>
    assertNativeProtocolDataUnchanged({ thinking: undefined }, { thinking: undefined })
  );
});

test("native integrity allows routing model and unrelated transport metadata changes", () => {
  const before = {
    ...fresh(),
    model: "client-alias",
    metadata: { request: "one" },
    max_tokens: 512,
  };
  const after = {
    ...structuredClone(before),
    model: "resolved-model",
    metadata: { request: "two" },
    max_tokens: 256,
  };
  assert.doesNotThrow(() => assertNativeProtocolDataUnchanged(before, after));
});

test("ranking probe performs no structured clone and returns no request references", () => {
  const body = fresh();
  const originalClone = globalThis.structuredClone;
  globalThis.structuredClone = () => {
    throw new Error("clone forbidden in ranking probe");
  };
  try {
    const probe = probeRequestCompatibility(body, target());
    assert.deepEqual(probe, { ok: true, adaptations: ["omit_inactive_context_management"] });
    assert.equal(Object.hasOwn(probe, "body"), false);
    if (probe.ok) probe.adaptations.push("modified-test-result");
    assert.deepEqual(probeRequestCompatibility(body, target()), {
      ok: true,
      adaptations: ["omit_inactive_context_management"],
    });
  } finally {
    globalThis.structuredClone = originalClone;
  }
});

test("probe and dispatch assessment agree on validated JSON eligibility without caching", () => {
  const bodies = [
    fresh(),
    { messages: [{ role: "user", content: "hello" }] },
    { ...fresh(), context_management: { edits: [] } },
    { ...fresh(), previous_response_id: "prior" },
  ];
  for (const body of bodies) {
    const probe = probeRequestCompatibility(body, target());
    const assessed = assessRequestCompatibility(body, target());
    assert.equal(probe.ok, assessed.ok);
    if (probe.ok === false && assessed.ok === false) assert.equal(probe.code, assessed.code);
    if (probe.ok && assessed.ok) assert.deepEqual(probe.adaptations, assessed.adaptations);
  }
  const body = fresh();
  assert.equal(probeRequestCompatibility(body, target()).ok, true);
  body.messages.push({ role: "user", content: [{ type: "text", text: "second turn" }] });
  assert.equal(probeRequestCompatibility(body, target()).ok, false);
});

test("history refusal short-circuits without visiting large or opaque message bodies", () => {
  const oldMessage = Object.defineProperty({ role: "assistant" }, "content", {
    get() {
      throw new Error("history must not be walked by ranking probe");
    },
  });
  const body = { ...fresh(), messages: [oldMessage, { role: "user", content: "new" }] };
  assert.deepEqual(probeRequestCompatibility(body, target()), {
    ok: false,
    code: "request_context_management_unavailable",
  });
});

test("top-level modality and opaque carriers cannot qualify as fresh text input", () => {
  for (const key of [
    "images",
    "attachments",
    "audio",
    "signature",
    "encrypted_content",
    "tool_calls",
  ]) {
    refuseContext({ ...fresh(), [key]: "opaque" });
  }
});

test("invalid server profile limits and unsupported-control descriptors fail closed", () => {
  for (const extra of [
    { maxTools: -1 },
    { maxTools: NaN },
    { maxTools: 1.5 },
    { unsupportedControls: [""] },
    { contextManagement: "future-mode" },
  ]) {
    assert.deepEqual(assessRequestCompatibility({}, target(extra) as any), {
      ok: false,
      code: "request_required_control_unsupported",
    });
  }
});
