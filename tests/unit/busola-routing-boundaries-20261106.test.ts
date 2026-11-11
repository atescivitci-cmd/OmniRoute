// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "busola-routing-boundary-"));
process.env.DATA_DIR = dir;
const originalFetch = globalThis.fetch;
let network = 0;
globalThis.fetch = async () => {
  network++;
  throw new Error("fixture_network_forbidden");
};
const { buildFixedFallbackExecute } =
  await import("../../open-sse/handlers/chatCore/fallbackWrapperExecute.ts");
const {
  createRoutingTransportAttempt,
  runWithRoutingTransportAttempt,
  assertRoutingTransportDispatch,
  stopRoutingTransportAttempt,
  getRoutingTransportOutcome,
} = await import("../../open-sse/services/routingTransportContext.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { resolveReasoningBufferedMaxTokens } =
  await import("../../open-sse/services/reasoningTokenBuffer.ts");
const { getExplicitModelOutputCap } = await import("../../src/lib/modelCapabilities.ts");
const core = await import("../../src/lib/db/core.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { clearCooldownState } = await import("../../open-sse/services/providerCooldownTracker.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
const log = { info() {}, warn() {}, error() {}, debug() {} };
const model = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const modelStr = "nvidia/" + model;
const responseFormat = {
  type: "json_schema",
  json_schema: {
    name: "fixture",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  },
};
const body = () => ({
  model: "fixture-auto-route",
  stream: false,
  max_tokens: 2000,
  reasoning_effort: "low",
  response_format: structuredClone(responseFormat),
  messages: [
    { role: "system", content: "Exact fixture policy." },
    { role: "user", content: "Nonpersonal fixture source." },
  ],
});
const valid = () =>
  Response.json({
    choices: [{ message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }],
  });
function wrapper(native, proxy) {
  return buildFixedFallbackExecute(
    { execute: native },
    { execute: proxy },
    (status) => [429, 500, 502, 503, 504].includes(status),
    "nvidia",
    log
  );
}
let seq = 0;
function comboOptions(request, handler, strategy = "priority") {
  return {
    body: request,
    combo: {
      name: "fixture-structured-" + seq++,
      strategy,
      models: [modelStr, "openai/gpt-4o"].map((model) => ({ model })),
      config: {
        maxRetries: 0,
        maxSetRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        disableSessionStickiness: true,
      },
    },
    handleSingleModel: handler,
    isModelAvailable: async () => true,
    log,
    settings: {},
  };
}
test.beforeEach(() => {
  resetAllCircuitBreakers();
  clearCooldownState();
  clearAllModelLockouts();
});
test.afterEach(() => assert.equal(network, 0));
test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  core.resetDbInstance();
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const status of [200, 429, 503])
  test(`managed native HTTP${status} returns unchanged with no nested CPA dispatch`, async () => {
    const token = createRoutingTransportAttempt();
    const input = body();
    const before = structuredClone(input);
    let nativeCalls = 0,
      cpaCalls = 0;
    const nativeResult = { response: new Response("fixture", { status }) };
    const run = wrapper(
      async (actual) => {
        nativeCalls++;
        assert.equal(actual, input);
        assertRoutingTransportDispatch();
        return nativeResult;
      },
      async () => {
        cpaCalls++;
        assertRoutingTransportDispatch();
        return { response: valid() };
      }
    );
    const result = await runWithRoutingTransportAttempt(token, () => run(input));
    assert.equal(result, nativeResult);
    assert.equal(nativeCalls, 1);
    assert.equal(cpaCalls, 0);
    assert.deepEqual(input, before);
    assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
  });
test("managed uncertainty never invokes CPA or becomes a definite refusal", async () => {
  const token = createRoutingTransportAttempt();
  let cpa = 0;
  const run = wrapper(
    async () => {
      assertRoutingTransportDispatch();
      stopRoutingTransportAttempt("execution_uncertain");
      throw new Error("fixture_native_failure");
    },
    async () => {
      cpa++;
      return { response: valid() };
    }
  );
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => run(body())),
    (error) =>
      error.code === "routing_transport_execution_uncertain" && error.execution === "unknown"
  );
  assert.equal(cpa, 0);
});
test("managed cancellation never invokes CPA", async () => {
  const controller = new AbortController();
  const token = createRoutingTransportAttempt({ signal: controller.signal });
  let cpa = 0;
  const run = wrapper(
    async () => {
      assertRoutingTransportDispatch();
      controller.abort();
      throw new Error("fixture_cancelled");
    },
    async () => {
      cpa++;
      return { response: valid() };
    }
  );
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => run(body())),
    { name: "AbortError" }
  );
  assert.equal(cpa, 0);
});
test("managed pretransport throw stays original and does not choose a bridge", async () => {
  const token = createRoutingTransportAttempt();
  const refusal = new Error("fixture_cost_refusal");
  let cpa = 0;
  const run = wrapper(
    async () => {
      throw refusal;
    },
    async () => {
      cpa++;
      return { response: valid() };
    }
  );
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => run(body())),
    (error) => error === refusal
  );
  assert.equal(cpa, 0);
  assert.equal(getRoutingTransportOutcome(token).modelDispatches, 0);
});
test("unmanaged legacy fallback and primary-error preservation are unchanged", async () => {
  let cpa = 0;
  const response = { response: valid() };
  const nativeError = new Error("fixture_primary");
  const run = wrapper(
    async () => {
      throw nativeError;
    },
    async () => {
      cpa++;
      return response;
    }
  );
  assert.equal(await run(body()), response);
  assert.equal(cpa, 1);
  await assert.rejects(
    wrapper(
      async () => {
        throw nativeError;
      },
      async () => {
        throw new Error("fixture_secondary");
      }
    )(body()),
    (error) => error === nativeError
  );
});
for (const type of ["json_schema", "json_object"])
  test(`actual DefaultExecutor preserves explicit${type} cap and reasoning effort`, () => {
    const executor = new DefaultExecutor("nvidia");
    const request = { ...body(), model, response_format: { ...responseFormat, type } };
    const before = structuredClone(request);
    const transformed = executor.transformRequest(model, request, false, {});
    assert.equal(transformed.max_tokens, 2000);
    assert.equal(transformed.reasoning_effort, "low");
    assert.deepEqual(request, before);
    const completion = { ...request, max_tokens: undefined, max_completion_tokens: 1999 };
    executor.ensureThinkingBudget(completion, model);
    assert.equal(completion.max_completion_tokens, 1999);
    assert.equal(completion.max_tokens, undefined);
  });
test("legacy unstructured reasoning default remains available", () => {
  const executor = new DefaultExecutor("nvidia");
  const request = { model, reasoning_effort: "low", max_tokens: 2000 };
  executor.ensureThinkingBudget(request, model);
  assert.equal(request.max_tokens, 4096);
});
for (const strategy of ["priority", "round-robin"])
  test(`actual${strategy} combo and executor keep the full structured request at2000`, async () => {
    const request = body(),
      before = structuredClone(request);
    let calls = 0;
    const result = await handleComboChat(
      comboOptions(
        request,
        async (actual, selected) => {
          calls++;
          assert.equal(selected, modelStr);
          assert.equal(actual.max_tokens, 2000);
          const transformed = new DefaultExecutor("nvidia").transformRequest(
            model,
            structuredClone(actual),
            false,
            {}
          );
          assert.equal(transformed.max_tokens, 2000);
          assert.deepEqual(transformed.response_format, responseFormat);
          assert.deepEqual(transformed.messages, request.messages);
          assert.equal(transformed.reasoning_effort, "low");
          return valid();
        },
        strategy
      )
    );
    assert.equal(result.status, 200);
    await result.text();
    assert.equal(calls, 1);
    assert.deepEqual(request, before);
  });
test("reasoning-only HTTP200 is rejected without dispatching a replacement answer", async () => {
  let calls = 0;
  const result = await handleComboChat(
    comboOptions(body(), async () => {
      calls++;
      return Response.json({
        choices: [
          {
            message: { role: "assistant", content: "", reasoning_content: "synthetic reasoning" },
            finish_reason: "length",
          },
        ],
        usage: { completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 2000 } },
      });
    })
  );
  assert.equal(result.status, 502);
  assert.equal((await result.json()).error.code, "response_contract_failed");
  assert.equal(calls, 1);
});

test("preserving a structured caller ceiling still applies the known smaller model cap", () => {
  const selected = "zhipu/glm-5.2";
  const cap = getExplicitModelOutputCap(selected);
  assert.ok(Number.isInteger(cap) && cap > 2000);
  assert.equal(
    resolveReasoningBufferedMaxTokens(selected, cap + 1000, { preserveExplicitLimit: true }),
    cap
  );
  assert.equal(
    resolveReasoningBufferedMaxTokens(selected, 2000, { preserveExplicitLimit: true }),
    2000
  );
});
for (const strategy of ["priority", "round-robin"])
  test(`actual ${strategy} structured request cannot bypass a known output cap`, async () => {
    const selected = "zhipu/glm-5.2";
    const cap = getExplicitModelOutputCap(selected);
    assert.ok(Number.isInteger(cap) && cap > 0);
    const request = { ...body(), max_tokens: cap + 1000 },
      before = structuredClone(request);
    let calls = 0;
    const opts = comboOptions(
      request,
      async (actual, chosen) => {
        calls++;
        assert.equal(chosen, selected);
        assert.equal(actual.max_tokens, cap);
        return valid();
      },
      strategy
    );
    opts.combo.models = [{ model: selected }];
    const result = await handleComboChat(opts);
    assert.equal(result.status, 200);
    await result.text();
    assert.equal(calls, 1);
    assert.deepEqual(request, before);
  });
