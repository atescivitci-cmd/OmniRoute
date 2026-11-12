import test from "node:test";
import assert from "node:assert/strict";
import { GithubExecutor } from "../../open-sse/executors/github.ts";
import { prepareUpstreamBody } from "../../open-sse/handlers/chatCore/upstreamBody.ts";
import { RequestCompatibilityError } from "../../open-sse/services/requestCompatibility.ts";
import { requestCompatibilityErrorResult } from "../../open-sse/services/requestCompatibilityResponse.ts";
import { isRequestScopedUpstreamFailure } from "../../open-sse/services/combo/comboPredicates.ts";
import {
  createRoutingAttemptGuard,
  inheritRoutingResponseState,
  isRoutingTerminal,
} from "../../open-sse/services/combo/routingAttemptSafety.ts";
import { zeroCostErrorResponse } from "../../open-sse/services/autoCombo/zeroCostAdmission.ts";
import { resolveAutoStrategyOrder } from "../../open-sse/services/combo/resolveAutoStrategy.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { setParamFilterConfig, deleteParamFilterConfig } from "../../src/lib/db/paramFilters.ts";
import { after } from "node:test";
import {
  setPayloadRulesConfig,
  resetPayloadRulesConfigForTests,
} from "../../open-sse/services/payloadRules.ts";
after(() => resetDbInstance());

const input = () => ({
  model: "claude-sonnet-4.6",
  max_tokens: 512,
  stream: false,
  messages: [{ role: "user", content: "fixture" }],
});
const inert = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
const code = (expected: string) => (error: unknown) =>
  error instanceof RequestCompatibilityError && error.code === expected;

for (const [label, extra, expected] of [
  [
    "active context",
    { context_management: { edits: [{ type: "future_edit_20990101" }] } },
    "request_context_management_unavailable",
  ],
  [
    "excess tools",
    {
      tools: Array.from({ length: 129 }, (_, i) => ({
        name: "f" + i,
        input_schema: { type: "object" },
      })),
    },
    "request_tool_limit_exceeded",
  ],
  [
    "erased adaptive control",
    { thinking: { type: "adaptive" } },
    "request_required_control_unsupported",
  ],
] as const)
  test("actual executor refuses " + label + " with zero transport sends", async () => {
    const executor = new GithubExecutor();
    executor.needsRefresh = () => false;
    const originalFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = async () => {
      sends++;
      return Response.json({ ok: true });
    };
    const body = { ...input(), ...extra };
    const before = structuredClone(body);
    try {
      await assert.rejects(
        executor.execute({ model: "claude-sonnet-5", body, stream: false, credentials: {} }),
        code(expected)
      );
      assert.equal(sends, 0);
      assert.deepEqual(body, before);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

test("actual executor emits one lossless native request after exact fresh hint adaptation", async () => {
  const executor = new GithubExecutor();
  executor.needsRefresh = () => false;
  executor.buildHeaders = () => ({});
  const originalFetch = globalThis.fetch;
  const inputBody = { ...input(), context_management: inert, system: "  exact\r\n", tools: [] };
  const before = structuredClone(inputBody);
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, opts) => {
    sent.push(JSON.parse(String(opts?.body)));
    return Response.json({ ok: true });
  };
  try {
    await executor.execute({
      model: "claude-sonnet-4.6",
      body: inputBody,
      stream: false,
      credentials: {},
      skipUpstreamRetry: true,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].context_management, undefined);
    for (const field of ["messages", "system", "tools"])
      assert.deepEqual(sent[0][field], inputBody[field]);
    assert.deepEqual(inputBody, before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("final serialized native guard catches mutations beyond transform preflight", async () => {
  class CorruptingExecutor extends GithubExecutor {
    transformRequest(...args: Parameters<GithubExecutor["transformRequest"]>) {
      const body = super.transformRequest(...args);
      body.messages[0].content = "changed";
      return body;
    }
  }
  const executor = new CorruptingExecutor();
  executor.needsRefresh = () => false;
  executor.buildHeaders = () => ({});
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    return Response.json({ ok: true });
  };
  try {
    await assert.rejects(
      executor.execute({
        model: "claude-sonnet-4.6",
        body: input(),
        stream: false,
        credentials: {},
      }),
      code("request_integrity_mismatch")
    );
    assert.equal(sends, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("common body preparation preserves signed native fields without input mutation", async () => {
  const body = {
    ...input(),
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: " fixture\r\n", signature: "fixture-signature" }],
      },
      { role: "user", content: "Continue." },
    ],
    tools: [{ name: "fixture", input_schema: { type: "object" } }],
    thinking: { type: "enabled", budget_tokens: 1024 },
  };
  const before = structuredClone(body);
  const result = await prepareUpstreamBody({
    translatedBody: body,
    modelToCall: "claude-sonnet-4.6",
    provider: "github",
    targetFormat: "claude",
    credentials: null,
  });
  for (const field of ["messages", "tools", "thinking"])
    assert.deepEqual(result[field], body[field]);
  assert.deepEqual(body, before);
});

test("configured filter cannot erase native protected control after compatibility planning", async () => {
  setParamFilterConfig("github", { block: ["thinking"], allow: [] });
  try {
    await assert.rejects(
      prepareUpstreamBody({
        translatedBody: { ...input(), thinking: { type: "enabled", budget_tokens: 1024 } },
        modelToCall: "claude-sonnet-4.6",
        provider: "github",
        targetFormat: "claude",
        credentials: null,
      }),
      (e: unknown) => e instanceof RequestCompatibilityError
    );
  } finally {
    deleteParamFilterConfig("github");
  }
});

test("known tool admission limit remains enforced as refusal even with generic bypass", async () => {
  const body = { ...input(), tools: Array.from({ length: 201 }, (_, i) => ({ name: "f" + i })) };
  await assert.rejects(
    prepareUpstreamBody({
      translatedBody: body,
      modelToCall: "fixture",
      provider: "grok-cli",
      targetFormat: "claude",
      credentials: null,
      bypassDefaultToolLimit: true,
    }),
    code("request_tool_limit_exceeded")
  );
  assert.equal(body.tools.length, 201);
});

test("payload overrides cannot reintroduce unsupported context edits", async () => {
  setPayloadRulesConfig({
    override: [
      {
        models: [{ name: "claude-sonnet-4.6", protocol: "claude" }],
        params: { context_management: { edits: [{ type: "future_edit_20990101" }] } },
      },
    ],
  });
  try {
    await assert.rejects(
      prepareUpstreamBody({
        translatedBody: input(),
        modelToCall: "claude-sonnet-4.6",
        provider: "github",
        targetFormat: "claude",
        credentials: null,
      }),
      code("request_context_management_unavailable")
    );
  } finally {
    resetPayloadRulesConfigForTests();
  }
});

test("payload filters cannot drop native tool/history data", async () => {
  setPayloadRulesConfig({
    filter: [{ models: [{ name: "claude-sonnet-4.6", protocol: "claude" }], params: ["tools"] }],
  });
  const body = { ...input(), tools: [{ name: "fixture", input_schema: { type: "object" } }] };
  try {
    await assert.rejects(
      prepareUpstreamBody({
        translatedBody: body,
        modelToCall: "claude-sonnet-4.6",
        provider: "github",
        targetFormat: "claude",
        credentials: null,
      }),
      code("request_integrity_mismatch")
    );
    assert.equal(body.tools.length, 1);
  } finally {
    resetPayloadRulesConfigForTests();
  }
});

test("native preflight classification advances only an ordinary re-admitted target", async () => {
  let gates = 0;
  const body = input();
  const guard = createRoutingAttemptGuard({ body, limit: 3 });
  const run = guard.wrap(async (_body, target) => {
    gates++;
    if (target === "github/a")
      return requestCompatibilityErrorResult(
        new RequestCompatibilityError("request_context_management_unavailable")
      ).response;
    return Response.json({ ok: true });
  });
  const first = await run(body, "github/a");
  assert.equal(first.status, 422);
  assert.equal(isRoutingTerminal(first), false);
  const second = await run(body, "claude/b");
  assert.equal(second.status, 200);
  assert.equal(gates, 2);
});

test("response wrapper retains locally proved nondispatch but wire code alone cannot grant it", async () => {
  for (const trusted of [false, true]) {
    let calls = 0;
    const body = input();
    const guard = createRoutingAttemptGuard({ body, limit: 3 });
    const run = guard.wrap(async () => {
      calls++;
      if (calls > 1) return Response.json({ ok: true });
      const source = trusted
        ? requestCompatibilityErrorResult(
            new RequestCompatibilityError("request_integrity_mismatch")
          ).response
        : Response.json({ error: { code: "request_integrity_mismatch" } }, { status: 422 });
      return inheritRoutingResponseState(
        source,
        new Response(source.body, { status: source.status, headers: source.headers })
      );
    });
    await run(body, "github/a");
    await run(body, "claude/b");
    assert.equal(calls, trusted ? 2 : 1);
  }
});

test("real local cost failures and execution uncertainty remain terminal", async () => {
  for (const failure of [
    () => zeroCostErrorResponse(503, "fixture", { code: "zero_cost_admission_unavailable" }),
    () =>
      Response.json(
        {
          error: {
            code: "request_integrity_mismatch",
            details: { execution_outcome: "uncertain" },
          },
        },
        { status: 503 }
      ),
  ]) {
    let calls = 0;
    const body = input();
    const run = createRoutingAttemptGuard({ body, limit: 3 }).wrap(async () => {
      calls++;
      return failure();
    });
    assert.equal(isRoutingTerminal(await run(body, "github/a")), true);
    await run(body, "claude/b");
    assert.equal(calls, 1);
  }
});

test("request-local preflight failures never signal provider health failures", () => {
  for (const code of [
    "request_context_management_unavailable",
    "request_tool_limit_exceeded",
    "request_required_control_unsupported",
    "request_integrity_mismatch",
  ])
    assert.equal(isRequestScopedUpstreamFailure({ code }), true);
});

test("actual auto resolver filters incompatible target before model availability/ranking", async () => {
  const targets = [
    ["github", "claude-sonnet-5"],
    ["claude", "claude-sonnet-4-6"],
  ].map(([provider, model], i) => ({
    kind: "model",
    provider,
    model,
    modelStr: provider + "/" + model,
    stepId: "s" + i,
    executionKey: provider + ">" + model,
    connectionId: null,
    providerId: null,
    weight: 1,
    label: null,
  }));
  const seen: string[] = [];
  const body = {
    ...input(),
    context_management: { edits: [{ type: "future_edit_20990101" }] },
  };
  const result = await resolveAutoStrategyOrder({
    orderedTargets: targets,
    body,
    combo: {
      id: "compat-fixture",
      name: "compat-fixture",
      strategy: "auto",
      autoConfig: {
        candidatePool: ["github", "claude"],
        selectionPolicy: "fit-first-free",
        zeroAdditionalCostProviders: ["github", "claude"],
        explorationRate: 0,
      },
    },
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    buildAutoCandidates: async () =>
      targets.map((t) => ({
        ...t,
        quotaRemaining: 100,
        quotaTotal: 100,
        circuitBreakerState: "CLOSED",
        costPer1MTokens: 1,
        p95LatencyMs: 100,
        latencyStdDev: 10,
        errorRate: 0,
      })),
    isModelAvailable: async (model) => {
      seen.push(model);
      return true;
    },
  } as never);
  assert.ok("orderedTargets" in result);
  if ("orderedTargets" in result)
    assert.deepEqual(
      result.orderedTargets.map((t) => t.provider),
      ["claude"]
    );
  assert.deepEqual(seen, ["claude/claude-sonnet-4-6"]);
});

test("auto resolver routes a history-trim request to a non-native target when native is unavailable", async () => {
  const targets = [
    ["github", "claude-sonnet-5"],
    ["claude", "claude-sonnet-4-6"],
  ].map(([provider, model], i) => ({
    kind: "model",
    provider,
    model,
    modelStr: provider + "/" + model,
    stepId: "s" + i,
    executionKey: provider + ">" + model,
    connectionId: null,
    providerId: null,
    weight: 1,
    label: null,
  }));
  const seen: string[] = [];
  const body = {
    ...input(),
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
  };
  const result = await resolveAutoStrategyOrder({
    orderedTargets: targets,
    body,
    combo: {
      id: "compat-fixture",
      name: "compat-fixture",
      strategy: "auto",
      autoConfig: {
        candidatePool: ["github", "claude"],
        selectionPolicy: "fit-first-free",
        zeroAdditionalCostProviders: ["github", "claude"],
        explorationRate: 0,
      },
    },
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    buildAutoCandidates: async () =>
      targets.map((t) => ({
        ...t,
        quotaRemaining: 100,
        quotaTotal: 100,
        circuitBreakerState: "CLOSED",
        costPer1MTokens: 1,
        p95LatencyMs: 100,
        latencyStdDev: 10,
        errorRate: 0,
      })),
    isModelAvailable: async (model) => {
      seen.push(model);
      return !model.startsWith("claude/");
    },
  } as never);
  assert.ok("orderedTargets" in result);
  if ("orderedTargets" in result)
    assert.deepEqual(
      result.orderedTargets.map((t) => t.provider),
      ["github"]
    );
  assert.deepEqual(seen.sort(), ["claude/claude-sonnet-4-6", "github/claude-sonnet-5"]);
});
