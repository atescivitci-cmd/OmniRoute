// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Launch with an isolated DATA_DIR too: import-time router initialization must
// never bind the real service database, even before these dynamic imports.
const previousDir = process.env.DATA_DIR;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eligibility-classification-"));
process.env.DATA_DIR = dir;
const previousFetch = globalThis.fetch;
let unexpectedNetwork = 0;
const forbiddenFetch = async () => {
  unexpectedNetwork++;
  throw new Error("fixture_network_forbidden");
};
globalThis.fetch = forbiddenFetch;
const { cachedModelEligibilityResponse, nvidiaFunctionRejectionResult } =
  await import("../../../open-sse/services/modelEligibilityResponse.ts");
const { NVIDIA_MODEL_NEGATIVE_CODE } =
  await import("../../../src/lib/db/nvidiaModelAvailabilityPolicy.ts");
const { ACCOUNT_MODEL_INELIGIBLE_CODE } =
  await import("../../../src/lib/db/accountModelEligibilityPolicy.ts");
const {
  LOCAL_COST_ERROR_CODES,
  zeroCostErrorResponse,
  executeWithZeroCostAdmission,
  installZeroCostEvidenceResolver,
  ZeroCostAdmissionError,
  zeroCostErrorResult,
} = await import("../../../open-sse/services/autoCombo/zeroCostAdmission.ts");
const { createRoutingAttemptGuard, routingFailure, isRoutingTerminal } =
  await import("../../../open-sse/services/combo/routingAttemptSafety.ts");
const { withSessionHeader, withCorrelationId, withSelectedConnectionHeader } =
  await import("../../../src/sse/handlers/chatHelpers.ts");
const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { handleChatCore } = await import("../../../open-sse/handlers/chatCore.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { clearCooldownState } =
  await import("../../../open-sse/services/providerCooldownTracker.ts");
const { clearAllModelLockouts } = await import("../../../open-sse/services/accountFallback.ts");
const core = await import("../../../src/lib/db/core.ts");

let denySecond = false;
let costChecks: string[] = [];
installZeroCostEvidenceResolver((request) => {
  costChecks.push(request.model);
  return denySecond && request.model === "gpt-4o"
    ? null
    : {
        provider: request.provider,
        model: request.model,
        connectionId: request.connectionId,
        noAdditionalCost: true,
        request,
        evidenceId: "synthetic-request-bound-proof",
      };
});
const codes = [NVIDIA_MODEL_NEGATIVE_CODE, ACCOUNT_MODEL_INELIGIBLE_CODE];
const missing = "Function 'fixture-function': Not found for account 'fixture-account'";
const log = { info() {}, warn() {}, error() {}, debug() {} };
const body = (tools = false) => ({
  stream: false,
  messages: [{ role: "user", content: "nonpersonal synthetic fixture" }],
  ...(tools
    ? {
        tools: [
          { type: "function", function: { name: "fixture", parameters: { type: "object" } } },
        ],
      }
    : {}),
});
const models = ["nvidia/moonshotai/kimi-k2.6", "openai/gpt-4o"];
const success = () =>
  Response.json({
    choices: [{ message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }],
  });
let sequence = 0;
function options(handleSingleModel, request = body(), extras = {}) {
  return {
    body: request,
    combo: {
      name: `eligibility-fixture-${sequence++}`,
      strategy: "priority",
      models: models.map((model) => ({ model })),
      config: {
        maxRetries: 0,
        maxSetRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        disableSessionStickiness: true,
        reasoningTokenBufferEnabled: false,
      },
    },
    handleSingleModel,
    isModelAvailable: async () => true,
    log,
    settings: {},
    ...extras,
  };
}
async function admitted(request, model, execute) {
  const [provider, ...name] = model.split("/");
  try {
    return await executeWithZeroCostAdmission(
      true,
      ["fixture-scope"],
      provider,
      { model: name.join("/"), body: request, credentials: { connectionId: "fixture-scope" } },
      execute
    );
  } catch (error) {
    if (error instanceof ZeroCostAdmissionError) return zeroCostErrorResult(error).response;
    throw error;
  }
}
function freezeHeaders(response) {
  response.headers.set = () => {
    throw new TypeError("immutable fixture headers");
  };
  return response;
}
function allHeaders(response) {
  let out = withSessionHeader(freezeHeaders(response), "fixture-session");
  out = withCorrelationId(freezeHeaders(out), "fixture-correlation");
  return withSelectedConnectionHeader(freezeHeaders(out), "fixture-scope");
}
test.beforeEach(() => {
  resetAllCircuitBreakers();
  clearCooldownState();
  clearAllModelLockouts();
  globalThis.fetch = forbiddenFetch;
  costChecks = [];
  denySecond = false;
});
test.afterEach(() => assert.equal(unexpectedNetwork, 0));
test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  core.resetDbInstance();
  globalThis.fetch = previousFetch;
  if (previousDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const code of codes) {
  test(`cached ${code} keeps its precise serialized code, static prose and clone state`, async () => {
    const guard = createRoutingAttemptGuard({ body: body(true), limit: 2 });
    let calls = 0;
    const run = guard.wrap(async () =>
      ++calls === 1 ? allHeaders(cachedModelEligibilityResponse(code)) : success()
    );
    const first = await run(body(true), models[0]);
    const serialized = await first.clone().json();
    assert.equal(serialized.error.code, code);
    assert.equal(serialized.error.type, "invalid_request_error");
    assert.doesNotMatch(JSON.stringify(serialized), /fixture-account|fixture-function/);
    assert.equal(first.headers.get("X-Correlation-Id"), "fixture-correlation");
    assert.equal((await run(body(true), models[1])).status, 200);
    assert.equal(
      calls,
      2,
      "trusted nondispatch survives all three replacement wrappers with tools"
    );
  });
  test(`actual central combo advances after cached ${code} with fresh admission`, async () => {
    let executes = 0;
    const result = await handleComboChat(
      options((request, model) =>
        admitted(request, model, async () => {
          executes++;
          return executes === 1 ? cachedModelEligibilityResponse(code) : success();
        })
      )
    );
    assert.equal(result.status, 200);
    await result.text();
    assert.equal(executes, 2);
    assert.deepEqual(costChecks, ["moonshotai/kimi-k2.6", "gpt-4o"]);
  });
}
test("actual rejection serializer recognizes complete observed JSON and never leaks account prose", async () => {
  const result = nvidiaFunctionRejectionResult(
    "nvidia",
    404,
    JSON.stringify({ status: 404, detail: missing })
  );
  assert.equal(result.errorCode, NVIDIA_MODEL_NEGATIVE_CODE);
  const payload = await result.response.json();
  assert.equal(payload.error.code, NVIDIA_MODEL_NEGATIVE_CODE);
  assert.doesNotMatch(JSON.stringify(payload), /fixture-account|fixture-function/);
});
test("untrusted, partial, generic, wrong-provider/status and oversized errors cannot create definite rejection", () => {
  for (const [provider, status, message] of [
    ["openai", 404, missing],
    ["nvidia", 400, missing],
    ["nvidia", 503, missing],
    ["nvidia", 404, "not found"],
    ["nvidia", 404, missing + " extra"],
    ["nvidia", 404, JSON.stringify({ status: 403, detail: missing })],
    ["nvidia", 404, "x".repeat(8193)],
    ["nvidia", 404, { code: NVIDIA_MODEL_NEGATIVE_CODE }],
  ])
    assert.equal(nvidiaFunctionRejectionResult(provider, status, message), null);
  assert.throws(
    () => cachedModelEligibilityResponse("zero_cost_admission_unavailable"),
    /invalid_model_eligibility_code/
  );
});
test("observed definite rejection survives cloned headers and tools, without claiming nondispatch", async () => {
  const events = [];
  const request = body(true);
  const guard = createRoutingAttemptGuard({
    body: request,
    limit: 2,
    emit: (event) => events.push(event),
  });
  let calls = 0;
  const run = guard.wrap(async (_b, _m, target) => {
    target.routingAttemptToken.enter();
    return ++calls === 1
      ? allHeaders(nvidiaFunctionRejectionResult("nvidia", 404, missing).response)
      : success();
  });
  await run(request, models[0]);
  assert.equal((await run(request, models[1])).status, 200);
  assert.equal(calls, 2);
  assert.equal(events.find((event) => event.event === "outcome").execution, "response_observed");
});
test("denied next-target admission never reaches its executor", async () => {
  denySecond = true;
  let executes = 0;
  const result = await handleComboChat(
    options((request, model) =>
      admitted(request, model, async () => {
        executes++;
        return cachedModelEligibilityResponse(NVIDIA_MODEL_NEGATIVE_CODE);
      })
    )
  );
  assert.equal((await result.json()).error.code, "zero_cost_admission_unavailable");
  assert.equal(executes, 1);
  assert.deepEqual(costChecks, ["moonshotai/kimi-k2.6", "gpt-4o"]);
});
for (const code of LOCAL_COST_ERROR_CODES)
  test(`actual combo keeps ${code} terminal`, async () => {
    let calls = 0;
    const result = await handleComboChat(
      options(async () => {
        calls++;
        return calls === 1
          ? zeroCostErrorResponse(503, "Static policy refusal", { code })
          : success();
      })
    );
    assert.equal((await result.json()).error.code, code);
    assert.equal(calls, 1);
    assert.equal(isRoutingTerminal(result), true);
  });
test("cost factory stays narrow; it does not grant eligibility or expand the allowlist", async () => {
  assert.deepEqual([...LOCAL_COST_ERROR_CODES].sort(), [
    "connection_scope_empty",
    "connection_scope_mismatch",
    "zero_cost_admission_unavailable",
  ]);
  for (const code of codes)
    assert.equal(
      (await zeroCostErrorResponse(404, "fixture", { code }).json()).error.code,
      "zero_cost_admission_unavailable"
    );
});
test("uncertain outcome cannot advance even when wire code claims eligibility", async () => {
  let calls = 0;
  const result = await handleComboChat(
    options(async () => {
      calls++;
      return Response.json(
        {
          error: { code: NVIDIA_MODEL_NEGATIVE_CODE, details: { execution_outcome: "uncertain" } },
        },
        { status: 404 }
      );
    })
  );
  assert.equal(calls, 1);
  assert.equal(result.status, 404);
});
test("cancellation after rejection cannot advance", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await handleComboChat(
    options(
      async () => {
        calls++;
        controller.abort();
        return cachedModelEligibilityResponse(NVIDIA_MODEL_NEGATIVE_CODE);
      },
      body(),
      { signal: controller.signal }
    )
  );
  assert.equal(result.status, 499);
  assert.equal(calls, 1);
});
test("committed response cannot be replayed", async () => {
  const request = body();
  const guard = createRoutingAttemptGuard({ body: request, limit: 2 });
  let calls = 0;
  const run = guard.wrap(async () => {
    calls++;
    return success();
  });
  assert.equal((await run(request, models[0])).status, 200);
  assert.equal(
    (await (await run(request, models[1])).json()).error.code,
    "response_already_committed"
  );
  assert.equal(calls, 1);
});
test("signed provider continuation still refuses cross-provider advance after trusted rejection", async () => {
  const request = { ...body(), previous_response_id: "fixture-provider-bound" };
  let calls = 0;
  const result = await handleComboChat(
    options(async () => {
      calls++;
      return cachedModelEligibilityResponse(NVIDIA_MODEL_NEGATIVE_CODE);
    }, request)
  );
  assert.equal(result.status, 404);
  assert.equal(calls, 1);
});
test("clone wrappers preserve preexisting terminal classification", async () => {
  const response = allHeaders(routingFailure("execution_uncertain"));
  assert.equal(isRoutingTerminal(response), true);
  assert.equal((await response.json()).error.code, "execution_uncertain");
});
test("production breaker wrapper preserves trusted NVIDIA404 and central owner re-admits the next target", async () => {
  const { executeChatWithBreaker } = await import("../../../src/sse/handlers/chatHelpers.ts");
  const { upsertUpstreamProxyConfig } = await import("../../../src/lib/db/upstreamProxy.ts");
  await upsertUpstreamProxyConfig({ providerId: "nvidia", mode: "fallback", enabled: true });
  const request = body(true);
  let wires = 0;
  let targets = 0;
  globalThis.fetch = async () => {
    wires++;
    return Response.json({ status: 404, title: "Not Found", detail: missing }, { status: 404 });
  };
  const result = await handleComboChat(
    options(async (b, model, target) => {
      targets++;
      if (targets > 1) return admitted(b, model, async () => success());
      const credentials = { apiKey: "nonsecret-fixture-key", connectionId: "fixture-scope", providerSpecificData: {} };
      const { result: actual } = await executeChatWithBreaker({
        body: structuredClone(b),
        provider: "nvidia",
        model: "moonshotai/kimi-k2.6",
        credentials,
        refreshedCredentials: credentials,
        bypassCircuitBreaker: true,
        log,
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(b),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "unit-test",
        routingAttemptToken: target.routingAttemptToken,
        skipUpstreamRetry: true,
        requireZeroCostAdmission: true,
        costAdmissionConnectionIds: ["fixture-scope"],
      });
      assert.equal(actual.errorCode, NVIDIA_MODEL_NEGATIVE_CODE);
      assert.equal((await actual.response.clone().json()).error.code, NVIDIA_MODEL_NEGATIVE_CODE);
      return allHeaders(actual.response);
    }, request)
  );
  assert.equal(result.status, 200);
  await result.text();
  assert.equal(wires, 1);
  assert.equal(targets, 2);
  assert.ok(costChecks.includes("moonshotai/kimi-k2.6"));
  assert.ok(costChecks.includes("gpt-4o"));
});

test("native StarCoder route miss advances via the production breaker wrapper", async () => {
  const { executeChatWithBreaker } = await import("../../../src/sse/handlers/chatHelpers.ts");
  const { upsertUpstreamProxyConfig } = await import("../../../src/lib/db/upstreamProxy.ts");
  await upsertUpstreamProxyConfig({ providerId: "nvidia", mode: "fallback", enabled: true });
  const request = body(true);
  let wires = 0;
  let targets = 0;
  globalThis.fetch = async () => {
    wires++;
    const response = new Response("404 page not found\n", { status: 404 });
    Object.defineProperty(response, "url", {
      value: "https://integrate.api.nvidia.com/v1/chat/completions",
    });
    return response;
  };
  const result = await handleComboChat(
    options(async (b, model, target) => {
      targets++;
      if (targets > 1) return admitted(b, model, async () => success());
      const credentials = { apiKey: "nonsecret-fixture-key", connectionId: "fixture-scope", providerSpecificData: {} };
      const { result: actual } = await executeChatWithBreaker({
        body: structuredClone(b),
        provider: "nvidia",
        model: "bigcode/starcoder2-15b",
        credentials,
        refreshedCredentials: credentials,
        bypassCircuitBreaker: true,
        log,
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(b),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "unit-test",
        routingAttemptToken: target.routingAttemptToken,
        skipUpstreamRetry: true,
        requireZeroCostAdmission: true,
        costAdmissionConnectionIds: ["fixture-scope"],
      });
      assert.equal(actual.errorCode, "nvidia_native_route_not_found");
      assert.equal((await actual.response.clone().json()).error.code, "nvidia_native_route_not_found");
      return allHeaders(actual.response);
    }, request, { combo: { ...options(() => success()).combo, models: [{model:"nvidia/bigcode/starcoder2-15b"}, {model:"openai/gpt-4o"}] } })
  );
  assert.equal(result.status, 200);
  await result.text();
  assert.equal(wires, 1);
  assert.equal(targets, 2);
  assert.ok(costChecks.includes("bigcode/starcoder2-15b"));
  assert.ok(costChecks.includes("gpt-4o"));
});

test("plain NVIDIA 404 requires the exact native StarCoder route and attempt identity", async () => {
  const { nvidiaStarCoderRouteMiss } = await import("../../../open-sse/services/modelEligibilityResponse.ts");
  const endpoint = "https://integrate.api.nvidia.com/v1/chat/completions";
  const model = "bigcode/starcoder2-15b";
  const message = "404 page not found\n";
  const evidence = { provider: "nvidia", nativeExecutor: true, status: 404, endpoint,
    responseUrl: endpoint, redirected: false, body: { _rawText: message }, expectedModel: model,
    attemptModel: model, expectedConnection: "fixture-scope", attemptConnection: "fixture-scope" };
  assert.equal(nvidiaStarCoderRouteMiss(evidence, message)?.response.status, 404);
  for (const change of [
    { nativeExecutor: false }, { redirected: true }, { responseUrl: "https://other.invalid/" },
    { status: 504 }, { attemptConnection: "other" }, { attemptModel: "other" },
    { expectedModel: "other", attemptModel: "other" }, { body: { error: message } },
  ]) assert.equal(nvidiaStarCoderRouteMiss({ ...evidence, ...change }, message), null);
  assert.equal(nvidiaStarCoderRouteMiss(evidence, "Not Found"), null);
});

test("single-model handler hands a trusted rejection back before account fallback", async () => {
  const { isDefiniteRoutingRejection } =
    await import("../../../open-sse/services/combo/routingAttemptSafety.ts");
  const { markDefiniteRejection } =
    await import("../../../open-sse/services/combo/routingAttemptSafety.ts");
  const source = fs.readFileSync(new URL("../../../src/sse/handlers/chat.ts", import.meta.url), "utf8");
  const dispatch = source.indexOf("routingAttemptToken: runtimeOptions.routingAttemptToken ?? null");
  const pass = source.indexOf("isDefiniteRoutingRejection(result.response)", dispatch);
  const accountFallback = source.indexOf("// 8. Fallback to next account", dispatch);
  assert.ok(dispatch >= 0 && pass > dispatch && accountFallback > pass);
  const rejection = markDefiniteRejection(Response.json({ error: { code: "fixture" } }, { status: 404 }));
  assert.equal(isDefiniteRoutingRejection(withSelectedConnectionHeader(rejection, "fixture-scope")), true);
  assert.equal(isDefiniteRoutingRejection(Response.json({ error: { code: "fixture" } }, { status: 404 })), false);
});
