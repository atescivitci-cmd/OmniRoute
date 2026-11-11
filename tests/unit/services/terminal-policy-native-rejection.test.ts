// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Import-time runtime reads must bind only this disposable fixture database.
const oldDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-native-rejection-"));
process.env.DATA_DIR = dataDir;
const originalFetch = globalThis.fetch;
let unexpectedNetwork = 0;
const forbidNetwork = async () => {
  unexpectedNetwork++;
  throw new Error("fixture_network_forbidden");
};
globalThis.fetch = forbidNetwork;
const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const {
  executeChatWithBreaker,
  withSessionHeader,
  withCorrelationId,
  withSelectedConnectionHeader,
} = await import("../../../src/sse/handlers/chatHelpers.ts");
const { isRoutingTerminal, isDefiniteRoutingRejection } =
  await import("../../../open-sse/services/combo/routingAttemptSafety.ts");
const {
  executeWithZeroCostAdmission,
  installZeroCostEvidenceResolver,
  ZeroCostAdmissionError,
  zeroCostErrorResult,
} = await import("../../../open-sse/services/autoCombo/zeroCostAdmission.ts");
const { nvidiaStarCoderRouteMiss } =
  await import("../../../open-sse/services/modelEligibilityResponse.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { clearCooldownState } =
  await import("../../../open-sse/services/providerCooldownTracker.ts");
const { clearAllModelLockouts } = await import("../../../open-sse/services/accountFallback.ts");
const { upsertUpstreamProxyConfig } = await import("../../../src/lib/db/upstreamProxy.ts");
const core = await import("../../../src/lib/db/core.ts");
const endpoint = "https://integrate.api.nvidia.com/v1/chat/completions";
const scope = "synthetic-selected-account";
const log = { info() {}, warn() {}, error() {}, debug() {} };
let sequence = 0;
let denyModel = "";
let costChecks: string[] = [];
installZeroCostEvidenceResolver((request) => {
  costChecks.push(request.model);
  return request.model === denyModel
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
const requestBody = () => ({
  stream: false,
  max_tokens: 64,
  messages: [{ role: "user", content: "Reply only: OK" }],
});
const successful = () =>
  Response.json({
    choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  });
function headers(response: Response) {
  return withSelectedConnectionHeader(
    withCorrelationId(withSessionHeader(response, "synthetic-session"), "synthetic-correlation"),
    scope
  );
}
async function freshCostAdmission(request, model, execute) {
  const [provider, ...name] = model.split("/");
  try {
    return await executeWithZeroCostAdmission(
      true,
      [scope],
      provider,
      { model: name.join("/"), body: request, credentials: { connectionId: scope } },
      execute
    );
  } catch (error) {
    if (error instanceof ZeroCostAdmissionError) return zeroCostErrorResult(error).response;
    throw error;
  }
}
async function runFixture({
  strictCost = false,
  shape = "route",
  status = 404,
  wrongResponseOrigin = false,
  redirected = false,
  stream = false,
  unavailableSecond = false,
  transportThrows = false,
  firstModel = shape === "function" ? "moonshotai/kimi-k2.6" : "bigcode/starcoder2-15b",
} = {}) {
  const body = { ...requestBody(), stream };
  const originalMessages = structuredClone(body.messages);
  const events: string[] = [];
  let wires = 0,
    targets = 0,
    successfulExecutions = 0;
  const classifications: Array<{ code: unknown; definite: boolean }> = [];
  globalThis.fetch = async () => {
    wires++;
    events.push("native-wire");
    if (transportThrows) throw new Error("synthetic_transport_failure");
    const response =
      shape === "function"
        ? Response.json(
            {
              status: 404,
              title: "Not Found",
              detail: "Function 'synthetic-function': Not found for account 'synthetic-account'",
            },
            { status }
          )
        : shape === "extra"
          ? Response.json(
              {
                _rawText: "404 page not found\n",
                message: "404 page not found\n",
                usage: { completion_tokens: 1 },
              },
              { status }
            )
          : new Response(shape === "generic" ? "Not Found" : "404 page not found\n", { status });
    Object.defineProperty(response, "url", {
      value: wrongResponseOrigin ? "https://different.invalid/" : endpoint,
    });
    Object.defineProperty(response, "redirected", { value: redirected });
    return response;
  };
  const result = await handleComboChat({
    body,
    combo: {
      name: `terminal-policy-native-${sequence++}`,
      strategy: "priority",
      models: [{ model: `nvidia/${firstModel}` }, { model: "openai/gpt-4o" }],
      config: {
        maxRetries: 0,
        maxSetRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        disableSessionStickiness: true,
        reasoningTokenBufferEnabled: false,
      },
    },
    log,
    settings: {},
    isModelAvailable: async (model) => {
      events.push(`availability:${model}`);
      return !(unavailableSecond && model === "openai/gpt-4o");
    },
    handleSingleModel: async (request, model, target) => {
      targets++;
      events.push(`dispatch:${model}`);
      assert.deepEqual(
        request.messages,
        originalMessages,
        "fallback retains the complete mandatory messages"
      );
      if (model === "openai/gpt-4o")
        return freshCostAdmission(request, model, async () => {
          events.push("fresh-admission-executed");
          successfulExecutions++;
          return successful();
        });
      const credentials = {
        apiKey: "nonsecret-fixture-key",
        connectionId: scope,
        providerSpecificData: {},
      };
      const { result: actual } = await executeChatWithBreaker({
        body: structuredClone(request),
        provider: "nvidia",
        model: firstModel,
        credentials,
        refreshedCredentials: credentials,
        bypassCircuitBreaker: true,
        log,
        clientRawRequest: {
          endpoint: "/v1/messages",
          body: structuredClone(request),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "offline-terminal-policy-test",
        routingAttemptToken: target.routingAttemptToken,
        skipUpstreamRetry: true,
        requireZeroCostAdmission: strictCost,
        costAdmissionConnectionIds: [scope],
      });
      classifications.push({
        code: actual.errorCode,
        definite: isDefiniteRoutingRejection(actual.response),
      });
      return headers(actual.response);
    },
  });
  assert.deepEqual(body.messages, originalMessages);
  return { result, events, classifications, wires, targets, successfulExecutions };
}

test.beforeEach(async () => {
  globalThis.fetch = forbidNetwork;
  costChecks = [];
  denyModel = "";
  resetAllCircuitBreakers();
  clearCooldownState();
  clearAllModelLockouts();
  await upsertUpstreamProxyConfig({ providerId: "nvidia", mode: "fallback", enabled: true });
});
test.afterEach(() => assert.equal(unexpectedNetwork, 0));
test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  core.resetDbInstance();
  globalThis.fetch = originalFetch;
  if (oldDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = oldDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const strictCost of [false, true])
  for (const shape of ["route", "function"]) {
    test(`${strictCost ? "strict-cost" : "terminal provider-managed"} native ${shape} rejection advances only to newly admitted target`, async () => {
      const f = await runFixture({ strictCost, shape });
      assert.equal(f.result.status, 200);
      await f.result.text();
      assert.equal(f.wires, 1);
      assert.equal(f.targets, 2);
      assert.equal(f.successfulExecutions, 1);
      assert.equal(f.classifications[0].definite, true);
      assert.equal(
        f.classifications[0].code,
        shape === "route" ? "nvidia_native_route_not_found" : "nvidia_model_catalog_negative"
      );
      assert.ok(
        costChecks.includes("gpt-4o"),
        "fresh fallback cost admission runs independently of the failed target's policy mode"
      );
      assert.ok(
        f.events.lastIndexOf("availability:openai/gpt-4o") > f.events.indexOf("native-wire"),
        JSON.stringify(f.events)
      );
      assert.ok(
        f.events.indexOf("fresh-admission-executed") >
          f.events.lastIndexOf("availability:openai/gpt-4o"),
        JSON.stringify(f.events)
      );
      if (strictCost)
        assert.ok(
          costChecks.includes(shape === "route" ? "bigcode/starcoder2-15b" : "moonshotai/kimi-k2.6")
        );
    });
  }
for (const [name, options] of [
  ["unqualified generic404", { shape: "generic" }],
  ["different model route miss", { firstModel: "moonshotai/kimi-k2.6" }],
  ["wrong response origin", { wrongResponseOrigin: true }],
  ["redirected response", { redirected: true }],
  ["wrong response origin on streaming request", { wrongResponseOrigin: true, stream: true }],
  ["redirected response on streaming request", { redirected: true, stream: true }],
  ["503 not a definite rejection", { status: 503 }],
  ["uncertain transport", { transportThrows: true }],
] as const)
  test(`${name} never advances`, async () => {
    const f = await runFixture(options);
    assert.equal(
      f.targets,
      1,
      JSON.stringify({ events: f.events, classifications: f.classifications })
    );
    assert.equal(f.wires, 1);
    assert.equal(f.successfulExecutions, 0);
    assert.equal(isRoutingTerminal(f.result), true);
    await f.result.text();
  });

test("fresh fallback cost refusal is terminal even after a qualified rejection", async () => {
  denyModel = "gpt-4o";
  const f = await runFixture();
  assert.notEqual(f.result.status, 200);
  assert.equal(f.targets, 2);
  assert.equal(f.wires, 1);
  assert.equal(f.successfulExecutions, 0);
  assert.equal(isRoutingTerminal(f.result), true);
  assert.ok(costChecks.includes("gpt-4o"));
  await f.result.text();
});
test("strict primary cost refusal never dispatches or uses another target", async () => {
  denyModel = "bigcode/starcoder2-15b";
  const f = await runFixture({ strictCost: true });
  assert.notEqual(f.result.status, 200);
  assert.equal(f.targets, 1);
  assert.equal(f.wires, 0);
  assert.equal(f.successfulExecutions, 0);
  assert.equal(isRoutingTerminal(f.result), true);
  await f.result.text();
});
test("fallback availability refusal prevents fallback dispatch", async () => {
  const f = await runFixture({ unavailableSecond: true });
  assert.notEqual(f.result.status, 200);
  assert.equal(f.targets, 1);
  assert.equal(f.wires, 1);
  assert.equal(f.successfulExecutions, 0);
  assert.ok(f.events.includes("availability:openai/gpt-4o"));
  await f.result.text();
});

test("native route marker still requires exact executor, account, model and origin evidence", () => {
  const message = "404 page not found\n";
  const evidence = {
    provider: "nvidia",
    nativeExecutor: true,
    status: 404,
    endpoint,
    responseUrl: endpoint,
    redirected: false,
    body: { _rawText: message },
    expectedModel: "bigcode/starcoder2-15b",
    attemptModel: "bigcode/starcoder2-15b",
    expectedConnection: scope,
    attemptConnection: scope,
  };
  assert.ok(nvidiaStarCoderRouteMiss(evidence, message));
  for (const changed of [
    { nativeExecutor: false },
    { provider: "openai" },
    { redirected: true },
    { endpoint: "https://different.invalid/" },
    { responseUrl: "https://different.invalid/" },
    { attemptConnection: "different" },
    { attemptModel: "different" },
    { body: { error: message } },
    { status: 504 },
  ])
    assert.equal(nvidiaStarCoderRouteMiss({ ...evidence, ...changed }, message), null);
});

test("raw-text route miss cannot hide response usage or other JSON fields", async () => {
  const f = await runFixture({ shape: "extra" });
  assert.equal(f.targets, 1, "unqualified JSON error cannot authorize fallback");
  assert.equal(f.wires, 1);
  assert.equal(f.successfulExecutions, 0);
  assert.equal(isRoutingTerminal(f.result), true);
  await f.result.text();
});

test("route miss requires exactly the parser-owned raw-text body shape", () => {
  const message = "404 page not found\n";
  const evidence = {
    provider: "nvidia",
    nativeExecutor: true,
    status: 404,
    endpoint,
    responseUrl: endpoint,
    redirected: false,
    expectedModel: "bigcode/starcoder2-15b",
    attemptModel: "bigcode/starcoder2-15b",
    expectedConnection: scope,
    attemptConnection: scope,
  };
  for (const body of [
    { _rawText: message, usage: { completion_tokens: 1 } },
    { _rawText: message, message },
    Object.create({ _rawText: message }),
  ])
    assert.equal(nvidiaStarCoderRouteMiss({ ...evidence, body }, message), null);
});
