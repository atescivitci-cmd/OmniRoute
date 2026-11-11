import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual caller statements and callbacks with fake provider sources.
// Only transport/attempt/config helpers are real: no handler, credentials or live DB.
const previousDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-global-fallback-"));
process.env.DATA_DIR = dataDir;
const previousFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("fixture_network_forbidden");
};
const {
  createRoutingAttemptGuard,
  inheritRoutingResponseState,
  isRoutingTerminal,
  markKnownNonDispatch,
  routingFailure,
  routingGuardFor,
} = await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { buildTargetTimeoutRunner } =
  await import("../../open-sse/services/combo/targetTimeoutRunner.ts");
const { resolveComboSetupConfig, resolveComboTargetTimeoutMsForCombo } =
  await import("../../open-sse/services/comboConfig.ts");
const { resolveResilienceSettings } = await import("../../src/lib/resilience/settings.ts");
const { ComboInvariantError, validateComboInvariant } =
  await import("../../src/lib/combos/invariants.ts");
const { filterReasoningCombo } = await import("../../src/sse/handlers/reasoningRouting.ts");
const { resolveBareModelToConnectionDefault } = await import("../../open-sse/services/model.ts");
const { handleComboChat: actualHandleComboChat } = await import("../../open-sse/services/combo.ts");
const { intersectStrictConnectionScope, selectedConnectionIsInScope } =
  await import("../../open-sse/services/autoCombo/zeroCostAdmission.ts");
const { assertRoutingTransportDispatch } =
  await import("../../open-sse/services/routingTransportContext.ts");

const sourcePath = new URL("../../src/sse/handlers/chat.ts", import.meta.url);
const source = ts.createSourceFile(
  sourcePath.pathname,
  fs.readFileSync(sourcePath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);
let comboBlock: ts.Block | undefined;
function visit(node: ts.Node) {
  if (
    ts.isBlock(node) &&
    node.statements.some(
      (item) =>
        ts.isVariableStatement(item) &&
        item.declarationList.declarations.some(
          (row) => row.name.getText(source) === "comboSetupConfig"
        )
    )
  )
    comboBlock = node;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(comboBlock, "actual combo caller block must exist");
const statements = [...comboBlock.statements];
const first = statements.findIndex(
  (item) =>
    ts.isVariableStatement(item) &&
    item.declarationList.declarations.some((row) => row.name.getText(source) === "comboSetupConfig")
);
const last = statements.findIndex(
  (item) => ts.isIfStatement(item) && item.expression.getText(source) === "terminalResponse"
);
const finalReturn = statements.at(-1)!;
assert.ok(first >= 0 && last > first && ts.isReturnStatement(finalReturn));
// Retain the entire production guard/combo/fallback sequence. Omit only unrelated
// rejected-usage DB logging between that sequence and the final response wrapper.
const script = ts.transpileModule(
  `globalThis.result = (async () => {\n${statements
    .slice(first, last + 1)
    .map((item) => item.getText(source))
    .join("\n")}\n${finalReturn.getText(source)}\n})();`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;
const limitSource = fs.readFileSync(
  new URL("../../open-sse/services/combo/comboPredicates.ts", import.meta.url),
  "utf8"
);
const MAX_GLOBAL_ATTEMPTS = Number(
  limitSource.match(/export const MAX_GLOBAL_ATTEMPTS = (\d+);/)?.[1]
);
assert.ok(Number.isInteger(MAX_GLOBAL_ATTEMPTS) && MAX_GLOBAL_ATTEMPTS > 0);
const log = { info() {}, warn() {}, debug() {} };
const success = () => Response.json({ choices: [{ message: { content: "fixture" } }] });
const failure = () =>
  markKnownNonDispatch(Response.json({ error: { code: "unavailable" } }, { status: 503 }));
const uncertain = () =>
  Response.json(
    { error: { code: "transport_error", details: { execution_outcome: "uncertain" } } },
    { status: 502 }
  );
type FixtureOptions = {
  comboRun?: (options: any) => Promise<Response>;
  dispatch?: (model: string, runtime: any) => Promise<Response> | Response;
  body?: Record<string, unknown>;
  centralCost?: boolean;
  controller?: AbortController;
  settings?: Record<string, unknown>;
  config?: Record<string, unknown>;
  combo?: Record<string, unknown>;
  resolve?: (model: string) => any;
  modelAllowed?: (model: string) => boolean;
  routingRejection?: Response;
  tagScope?: (targets: any[], body: any) => any[];
  requestedConnectionId?: string;
  apiKeyInfo?: Record<string, unknown>;
};
async function fixture(options: FixtureOptions = {}) {
  const controller = options.controller ?? new AbortController();
  const calls: { model: string; args: any[]; runtime: any }[] = [];
  let owner: ReturnType<typeof createRoutingAttemptGuard> | undefined;
  const apiKeyInfo = {
    id: "fixture-key",
    allowedConnections: ["authorized-account"],
    allowedQuotas: ["fixture-quota"],
    ...options.apiKeyInfo,
  };
  const request = { signal: controller.signal };
  const context: any = {
    Date,
    AbortSignal,
    JSON,
    Number,
    createRoutingAttemptGuard,
    inheritRoutingResponseState,
    isRoutingTerminal,
    routingFailure,
    markKnownNonDispatch,
    intersectStrictConnectionScope,
    selectedConnectionIsInScope,
    buildTargetTimeoutRunner,
    resolveComboSetupConfig,
    resolveComboTargetTimeoutMsForCombo,
    resolveResilienceSettings,
    MAX_GLOBAL_ATTEMPTS,
    FETCH_TIMEOUT_MS: 600_000,
    body: options.body ?? { messages: [{ role: "user", content: "nonpersonal fixture" }] },
    combo: {
      name: "fixture-combo",
      strategy: "priority",
      models: ["source/model"],
      config: options.config ?? {},
      ...options.combo,
    },
    settings: { globalFallbackModel: "fallback/model", ...options.settings },
    request,
    apiKeyInfo,
    policy: { apiKey: "fixture-policy-key" },
    requestedConnectionId: options.requestedConnectionId ?? null,
    resolveModelOrError: async (model: string) =>
      options.resolve?.(model) ?? {
        provider: model.split("/")[0],
        model: model.split("/").slice(1).join("/"),
      },
    validateApiKeyRoutingTarget: async () => options.routingRejection ?? null,
    isModelAllowedForKey: async (_key: string, model: string) =>
      options.modelAllowed?.(model) ?? true,
    resolveProviderAlias: (provider: string) => provider,
    applyRequestTagRouting: async (targets: any[], body: any) =>
      options.tagScope?.(targets, body) ?? targets,
    log,
    reqId: "fixture-request",
    sessionId: "fixture-session",
    sessionAffinityKey: "fixture-affinity",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    telemetry: {},
    isComboLiveTest: false,
    comboPreselectedCredentials: new Map(),
    getComboCredentialCacheKey: () => "fixture-cache",
    reasoningDecision: { action: "fixture-policy" },
    reasoningIntent: { effort: "fixture-effort" },
    requestRoutingTags: { tags: ["fixture-tag"] },
    comboPromoteDeps: {},
    checkModelAvailable: async () => true,
    allCombos: [],
    relayOptions: {},
    requiresCentralCostAdmission: () => options.centralCost === true,
    promoteSuccessfulComboModel: async () => {},
    recordTelemetry: () => {},
    runWithHostedTrialUsage: (_combo: unknown, run: () => Promise<Response>) => run(),
    handleComboChat: async (input: any) => {
      const inherited = routingGuardFor(input.handleSingleModel);
      assert.ok(inherited, "actual callback must already belong to request owner");
      if (owner) {
        assert.equal(inherited, owner, "redirect must inherit the original owner");
        assert.notEqual(
          input.signal,
          controller.signal,
          "redirect keeps outer target cancellation"
        );
        assert.equal(input.settings, context.settings);
        return actualHandleComboChat(input);
      }
      owner = inherited;
      assert.equal(input.signal, controller.signal);
      assert.equal(input.apiKeyAllowedConnections, apiKeyInfo.allowedConnections);
      return options.comboRun
        ? options.comboRun(input)
        : input.handleSingleModel(input.body, "source/model");
    },
    handleSingleModelChat: async (...args: any[]) => {
      const runtime = args[7];
      assert.ok(runtime.routingAttemptToken, "actual caller must forward guard token");
      assert.equal(runtime.skipUpstreamRetry, true);
      runtime.routingAttemptToken.enter();
      assertRoutingTransportDispatch();
      assert.equal(args[3], request);
      assert.equal(args[5], apiKeyInfo);
      calls.push({ model: args[1], args, runtime });
      return (
        options.dispatch?.(args[1], runtime) ?? (args[1] === "source/model" ? failure() : success())
      );
    },
    // Deliberately replace Response identity without copying capabilities. The
    // actual caller must preserve them around these lifecycle wrappers.
    withSessionHeader: (response: Response) => new Response(response.body, response),
    withCorrelationId: (response: Response) => new Response(response.body, response),
  };
  vm.runInNewContext(script, context, { timeout: 1000 });
  const response = await context.result;
  return { response, calls, owner: owner!, controller, context };
}

test.afterEach(() => assert.equal(networkAttempts, 0, "network remains forbidden"));
test.after(() => {
  globalThis.fetch = previousFetch;
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const replaceResponse of [false, true])
  test(`uncertain actual upstream result cannot escape through global fallback (wrapped=${replaceResponse})`, async () => {
    const result = await fixture({
      dispatch: () => uncertain(),
      comboRun: async (input) => {
        const response = await input.handleSingleModel(input.body, "source/model");
        return replaceResponse ? new Response(response.body, response) : response;
      },
    });
    assert.deepEqual(
      result.calls.map((call) => call.model),
      ["source/model"]
    );
    assert.equal(result.owner.attempts(), 1);
    assert.equal(result.response.status, 502);
    assert.equal(isRoutingTerminal(result.response), true);
    await result.response.text();
  });

test("explicit terminal unsafe 503 cannot invoke global fallback", async () => {
  const result = await fixture({
    comboRun: async () => routingFailure("unsafe_local_fallback", 503),
  });
  assert.equal(result.calls.length, 0);
  assert.equal(isRoutingTerminal(result.response), true);
  await result.response.text();
});

test("safe failure retains eligible global fallback and actual callback scope/token forwarding", async () => {
  const targetController = new AbortController();
  const result = await fixture({
    comboRun: (input) =>
      input.handleSingleModel(input.body, "source/model", {
        connectionId: "authorized-account",
        allowedConnectionIds: ["authorized-account"],
        providerId: "fixture-provider",
        modelAbortSignal: targetController.signal,
      }),
  });
  assert.deepEqual(
    result.calls.map((call) => call.model),
    ["source/model", "fallback/model"]
  );
  assert.equal(result.owner.attempts(), 2);
  assert.equal(result.response.status, 200);
  assert.equal(isRoutingTerminal(result.response), true);
  const [main, fallback] = result.calls.map((call) => call.runtime);
  assert.equal(main.forcedConnectionId, "authorized-account");
  assert.equal(main.providerId, "fixture-provider");
  assert.equal(main.modelAbortSignal, targetController.signal);
  assert.deepEqual(main.allowedConnectionIds, ["authorized-account"]);
  assert.deepEqual(fallback.allowedConnectionIds, result.context.apiKeyInfo.allowedConnections);
  assert.equal(fallback.cachedSettings, result.context.settings);
  assert.equal(fallback.reasoningDecision, result.context.reasoningDecision);
  assert.equal(fallback.reasoningIntent, result.context.reasoningIntent);
  assert.equal(fallback.reasoningRequestTags, result.context.requestRoutingTags.tags);
  assert.equal(fallback.emergencyFallbackTried, true);
  assert.equal(fallback.requireFallbackModelAuthorization, true);
  assert.equal(typeof fallback.authorizeFallbackModel, "function");
  assert.equal(fallback.requireZeroCostAdmission, false);
  assert.equal(fallback.correlationId, "fixture-request");
  assert.notEqual(fallback.routingAttemptToken, main.routingAttemptToken);
  assert.equal(fallback.modelAbortSignal.aborted, false);
  result.controller.abort();
  assert.equal(fallback.modelAbortSignal.aborted, true);
  await assert.rejects(result.response.text(), { name: "AbortError" });
});

test("global fallback cannot exceed the original guarded target attempt limit", async () => {
  const result = await fixture({
    dispatch: () => failure(),
    comboRun: async (input) => {
      let response!: Response;
      for (let index = 0; index < MAX_GLOBAL_ATTEMPTS; index++)
        response = await input.handleSingleModel(input.body, `source/model-${index}`);
      return response;
    },
  });
  assert.equal(result.calls.length, MAX_GLOBAL_ATTEMPTS);
  assert.equal(result.owner.attempts(), MAX_GLOBAL_ATTEMPTS);
  assert.equal(
    result.calls.some((call) => call.model === "fallback/model"),
    false
  );
  assert.equal((await result.response.json()).error.code, "routing_attempt_limit");
  assert.equal(isRoutingTerminal(result.response), true);
});

test("cancellation between combo result and fallback dispatch sends no fallback", async () => {
  const controller = new AbortController();
  const result = await fixture({
    controller,
    comboRun: async (input) => {
      const response = await input.handleSingleModel(input.body, "source/model");
      controller.abort();
      return response;
    },
  });
  assert.equal(result.calls.length, 1);
  assert.equal(result.response.status, 499);
  assert.equal(isRoutingTerminal(result.response), true);
  assert.equal((await result.response.json()).error.code, "request_cancelled");
});

test("committed output stays terminal even when caller returns an unmarked 503 wrapper", async () => {
  const result = await fixture({
    dispatch: () => success(),
    comboRun: async (input) => {
      await (await input.handleSingleModel(input.body, "source/model")).text();
      return failure();
    },
  });
  assert.equal(result.calls.length, 1);
  assert.equal(isRoutingTerminal(result.response), true);
  await result.response.text();
});

for (const body of [
  { previous_response_id: "fixture-provider-continuation" },
  { tools: [{ type: "function", function: { name: "fixture_tool" } }] },
])
  test("provider-bound or unsafe tool failure cannot escape through global fallback", async () => {
    const result = await fixture({
      body,
      dispatch: () => Response.json({ error: { code: "unavailable" } }, { status: 503 }),
    });
    assert.equal(result.calls.length, 1);
    assert.equal(isRoutingTerminal(result.response), true);
    await result.response.text();
  });

test("central cost admission remains excluded from global fallback", async () => {
  const result = await fixture({ centralCost: true });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].runtime.requireZeroCostAdmission, true);
  await result.response.text();
});

test("fallback uncertainty is returned instead of stale combo exhaustion", async () => {
  const result = await fixture({
    dispatch: (model) => (model === "source/model" ? failure() : uncertain()),
  });
  assert.equal(result.calls.length, 2);
  assert.equal(result.response.status, 502);
  assert.equal((await result.response.json()).error.details.execution_outcome, "uncertain");
  assert.equal(isRoutingTerminal(result.response), true);
});

test("global fallback keeps the original settings-derived shared deadline", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const result = await fixture({
    settings: { comboDefaults: { comboTimeoutMs: 50, targetTimeoutMs: 0 } },
    comboRun: async (input) => {
      const response = await input.handleSingleModel(input.body, "source/model");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response;
    },
    dispatch: (model) => (model === "source/model" ? failure() : pending),
  });
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[1].runtime.modelAbortSignal.aborted, true);
  assert.equal(result.response.status, 504);
  assert.equal((await result.response.json()).error.code, "routing_deadline");
  release(success());
  await new Promise((resolve) => setImmediate(resolve));
});

function aliasResolution(strategy = "priority") {
  return {
    combo: {
      name: `fixture-global-${strategy}`,
      strategy,
      models: ["openai/gpt-4o", "anthropic/claude-sonnet-4"],
      config: {
        maxRetries: 0,
        maxSetRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        disableSessionStickiness: true,
        reasoningTokenBufferEnabled: false,
        targetTimeoutMs: 0,
      },
    },
    provider: "auto",
    model: "fixture",
  };
}

test("configured fuzzy combo fallback shares owner and only charges actual leaf targets", async () => {
  const resolutions: string[] = [];
  const result = await fixture({
    settings: { globalFallbackModel: "auto/fixture" },
    resolve: (model) => {
      resolutions.push(model);
      return model === "auto/fixture" ? aliasResolution() : undefined;
    },
    dispatch: (model) => (model === "anthropic/claude-sonnet-4" ? success() : failure()),
  });
  assert.deepEqual(
    result.calls.map((call) => call.model),
    ["source/model", "openai/gpt-4o", "anthropic/claude-sonnet-4"]
  );
  assert.equal(result.owner.attempts(), 3, "alias expansion consumes no leaf attempt");
  assert.equal(result.response.status, 200);
  assert.deepEqual(resolutions, ["auto/fixture", "openai/gpt-4o", "anthropic/claude-sonnet-4"]);
  assert.ok(result.calls[1].runtime.preResolvedModel);
  await result.response.text();
});

test("configured combo fallback cannot refill the original attempt budget", async () => {
  const result = await fixture({
    settings: { globalFallbackModel: "auto/fixture" },
    resolve: (model) => (model === "auto/fixture" ? aliasResolution() : undefined),
    dispatch: () => failure(),
    comboRun: async (input) => {
      let response!: Response;
      for (let index = 0; index < MAX_GLOBAL_ATTEMPTS - 1; index++)
        response = await input.handleSingleModel(input.body, `source/model-${index}`);
      return response;
    },
  });
  assert.equal(result.owner.attempts(), MAX_GLOBAL_ATTEMPTS);
  assert.equal(result.calls.length, MAX_GLOBAL_ATTEMPTS);
  assert.equal(result.calls.at(-1)?.model, "openai/gpt-4o");
  assert.equal(result.response.status, 503);
  assert.equal(isRoutingTerminal(result.response), true);
  await result.response.text();
});

test("configured pipeline fallback retains distinct stages under the original budget", async () => {
  const result = await fixture({
    settings: { globalFallbackModel: "auto/fixture" },
    resolve: (model) => (model === "auto/fixture" ? aliasResolution("pipeline") : undefined),
    dispatch: (model) => (model === "source/model" ? failure() : success()),
  });
  assert.equal(result.calls.length, 3);
  assert.equal(result.owner.attempts(), 3);
  assert.equal(result.response.status, 200);
  await result.response.text();
});

for (const cancelled of [false, true])
  test(`configured combo fallback inner leaf observes deadline/cancellation (cancelled=${cancelled})`, async () => {
    const controller = new AbortController();
    let innerSignal: AbortSignal | undefined;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const result = await fixture({
      controller,
      settings: {
        globalFallbackModel: "auto/fixture",
        comboDefaults: { comboTimeoutMs: 70, targetTimeoutMs: 0 },
      },
      resolve: (model) => (model === "auto/fixture" ? aliasResolution() : undefined),
      dispatch: (model, runtime) => {
        if (model === "source/model") return failure();
        innerSignal = runtime.modelAbortSignal;
        if (cancelled) setTimeout(() => controller.abort(), 10);
        return pending;
      },
    });
    assert.equal(result.calls.length, 2);
    assert.equal(innerSignal?.aborted, true);
    assert.equal(result.response.status, cancelled ? 499 : 504);
    await result.response.text();
    release(success());
    await new Promise((resolve) => setImmediate(resolve));
  });

for (const alias of [false, true])
  test(`resolved fallback model restriction prevents dispatch (combo=${alias})`, async () => {
    const checked: string[] = [];
    const result = await fixture({
      settings: { globalFallbackModel: alias ? "auto/fixture" : "fallback/model" },
      resolve: (model) => (model === "auto/fixture" ? aliasResolution() : undefined),
      apiKeyInfo: { allowedModels: [], blockedModels: ["fallback/model", "openai/gpt-4o"] },
      modelAllowed: (model) => {
        checked.push(model);
        return false;
      },
    });
    assert.equal(result.calls.length, 1);
    assert.deepEqual(checked, [alias ? "openai/gpt-4o" : "fallback/model"]);
    assert.equal(result.response.status, 403);
    await result.response.text();
  });

test("fallback cannot escape explicit provider scope", async () => {
  const result = await fixture({ combo: { allowedProviders: ["source"] } });
  assert.equal(result.calls.length, 1);
  assert.equal((await result.response.json()).error.code, "global_fallback_provider_not_allowed");
});

test("fallback tags intersect original API account scope", async () => {
  const result = await fixture({
    body: { metadata: { tags: ["fixture-team"], tag_match_mode: "all" } },
    tagScope: (targets, input) => {
      assert.deepEqual(input.metadata.tags, ["fixture-team"]);
      assert.deepEqual(targets[0].allowedConnectionIds, ["authorized-account"]);
      return [{ ...targets[0], allowedConnectionIds: ["unrelated-account"] }];
    },
  });
  assert.equal(result.calls.length, 1);
  assert.equal((await result.response.json()).error.code, "connection_scope_empty");
});

test("eligible fallback preserves matching tags and selected account", async () => {
  const result = await fixture({
    requestedConnectionId: "authorized-account",
    body: { metadata: { tags: ["fixture-team"] } },
    tagScope: (targets) => targets,
  });
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[1].runtime.forcedConnectionId, "authorized-account");
  assert.deepEqual(result.calls[1].runtime.allowedConnectionIds, ["authorized-account"]);
  await result.response.text();
});

test("global combo authorization rejection sends no leaf", async () => {
  const result = await fixture({
    settings: { globalFallbackModel: "auto/fixture" },
    resolve: (model) => (model === "auto/fixture" ? aliasResolution() : undefined),
    routingRejection: Response.json({ error: { code: "combo_not_allowed" } }, { status: 403 }),
  });
  assert.equal(result.calls.length, 1);
  assert.equal(result.owner.attempts(), 1);
  assert.equal(result.response.status, 403);
  await result.response.text();
});

// Exercise the actual safety-net prelude as well as the outer caller above.
// A cached, internally resolved leaf must not be resolved a second time, and an
// alias discovered after leaf reservation cannot launch another retry owner.
const singleHandler = source.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "handleSingleModelChat"
)!;
const singleStatements = [...singleHandler.body!.statements];
const resolveIndex = singleStatements.findIndex(
  (item) =>
    ts.isVariableStatement(item) &&
    item.declarationList.declarations.some((row) => row.name.getText(source) === "resolved")
);
assert.ok(resolveIndex >= 0);
const resolutionScript = ts.transpileModule(
  `globalThis.result = (async () => { ${singleStatements
    .slice(resolveIndex, resolveIndex + 3)
    .map((item) => item.getText(source))
    .join("\n")} return resolved; })();`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;

test("actual guarded safety-net alias cannot allocate a fresh combo owner", async () => {
  let comboCalls = 0;
  const context: any = {
    routingFailure,
    runtimeOptions: { routingAttemptToken: { enter() {} } },
    modelStr: "auto/fixture",
    body: {},
    clientRawRequest: {},
    resolveModelOrError: async () => aliasResolution(),
    handleComboChat: async () => {
      comboCalls++;
      return success();
    },
  };
  vm.runInNewContext(resolutionScript, context, { timeout: 1000 });
  const response = await context.result;
  assert.equal(comboCalls, 0);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "guarded_combo_redirect_unresolved");
  assert.equal(isRoutingTerminal(response), true);
});

test("actual single-model prelude consumes the internal resolved leaf without resolving again", async () => {
  let resolutions = 0;
  const resolved = { provider: "fixture-provider", model: "fixture-model" };
  const context: any = {
    runtimeOptions: { preResolvedModel: resolved },
    resolveModelOrError: async () => {
      resolutions++;
      return aliasResolution();
    },
  };
  vm.runInNewContext(resolutionScript, context, { timeout: 1000 });
  assert.equal(await context.result, resolved);
  assert.equal(resolutions, 0);
});

for (const provider of ["fallback", "other", "shared"])
  test(`global fallback must satisfy both explicit provider scopes (${provider})`, async () => {
    const allowed = provider === "shared";
    const result = await fixture({
      combo: {
        allowedProviders: ["fallback", "shared"],
        invariant: { allowedProviders: ["shared", "other"] },
      },
      settings: { globalFallbackModel: `${provider}/model` },
    });
    assert.equal(result.calls.length, allowed ? 2 : 1);
    assert.equal(result.response.status, allowed ? 200 : 403);
    await result.response.text();
  });

let effectivePrelude: ts.Statement[] | undefined;
function findEffectivePrelude(node: ts.Node) {
  if (ts.isBlock(node)) {
    const index = node.statements.findIndex(
      (item) =>
        ts.isVariableStatement(item) &&
        item.declarationList.declarations.some(
          (row) => row.name.getText(source) === "effectiveModel"
        )
    );
    if (index >= 0) effectivePrelude = [...node.statements].slice(index, index + 2);
  }
  ts.forEachChild(node, findEffectivePrelude);
}
findEffectivePrelude(singleHandler);
assert.ok(effectivePrelude && ts.isIfStatement(effectivePrelude[1]));
const effectiveScript = ts.transpileModule(
  `globalThis.result = (async () => { ${effectivePrelude.map((item) => item.getText(source)).join("\n")} return effectiveModel; })();`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;

for (const [requested, allowed, expected] of [
  ["bare-alias", false, "default-b"],
  ["bare-alias", true, "default-b"],
  ["provider/model-a", true, "model-a"],
] as const)
  test(`actual connection default rewrite rechecks final fallback model (${requested}, allowed=${allowed})`, async () => {
    const checked: string[] = [];
    const context: any = {
      runtimeOptions: {
        requireFallbackModelAuthorization: true,
        authorizeFallbackModel: async (model: string) => {
          checked.push(model);
          return allowed;
        },
      },
      Response,
      ComboInvariantError,
      validateComboInvariant,
      filterReasoningCombo,
      comboName: "fixture-combo",
      resolveBareModelToConnectionDefault,
      modelStr: requested,
      model: "model-a",
      provider: "provider",
      credentials: { defaultModel: "default-b" },
      request: {},
      routingFailure,
    };
    vm.runInNewContext(effectiveScript, context, { timeout: 1000 });
    const result = await context.result;
    assert.deepEqual(checked, [`provider/${expected}`]);
    if (allowed) assert.equal(result, expected);
    else {
      assert.equal(result.status, 403);
      assert.equal((await result.json()).error.code, "global_fallback_model_not_allowed");
    }
  });

test("safe failed fallback returns its current readable response body", async () => {
  const result = await fixture({ dispatch: () => failure() });
  assert.equal(result.calls.length, 2);
  assert.equal(result.response.status, 503);
  assert.equal(result.response.bodyUsed, false);
  assert.equal((await result.response.json()).error.code, "unavailable");
});

async function finalModelGate(
  defaultModel: string,
  runtimeOptions: Record<string, unknown>,
  provider = "fixture"
) {
  const context: any = {
    runtimeOptions: {
      requireFallbackModelAuthorization: true,
      authorizeFallbackModel: async () => true,
      ...runtimeOptions,
    },
    Response,
    ComboInvariantError,
    validateComboInvariant,
    filterReasoningCombo,
    comboName: "fixture-combo",
    resolveBareModelToConnectionDefault,
    modelStr: "bare-alias",
    model: "resolved-a",
    provider,
    credentials: { defaultModel },
    request: {},
    routingFailure,
  };
  vm.runInNewContext(effectiveScript, context, { timeout: 1000 });
  return context.result;
}

for (const model of ["gpt-4o", "gemini-pro", "claude-sonnet-4"])
  test(`actual final default model respects both family constraints (${model})`, async () => {
    const result = await finalModelGate(model, {
      fallbackModelFamilyScopes: [
        ["gpt", "claude"],
        ["claude", "gemini"],
      ],
    });
    if (model === "claude-sonnet-4") assert.equal(result, model);
    else {
      assert.equal(result.status, 403);
      assert.equal((await result.json()).error.code, "global_fallback_model_family_not_allowed");
    }
  });

test("actual reasoning gate rejects incompatible final default model", async () => {
  const result = await finalModelGate(
    "gpt-4o",
    {
      reasoningDecision: { requiresReasoning: true, targetEffort: "high", rule: { id: "fixture" } },
    },
    "openai"
  );
  assert.equal(result.status, 400);
  assert.match((await result.json()).error.message, /no compatible combo target/);
});

test("actual reasoning gate preserves a compatible final default model", async () => {
  const result = await finalModelGate(
    "gpt-5.6-sol",
    {
      reasoningDecision: { requiresReasoning: true, targetEffort: "max", rule: { id: "fixture" } },
    },
    "codex"
  );
  assert.equal(result, "gpt-5.6-sol");
});

test("headerless server-resolved policy key survives the actual final-model authorization gate", async () => {
  const result = await fixture({
    settings: { globalFallbackModel: "bare-alias" },
    resolve: () => ({ provider: "fixture-provider", model: "model-a" }),
  });
  await result.response.text();
  const runtimeOptions = result.calls[1].runtime;
  const observed: unknown[] = [];
  result.context.isModelAllowedForKey = async (key: string | null, model: string) => {
    observed.push({ key, model });
    // Match the real helper's relevant behavior: no key permits local mode.
    return key === null || model !== "fixture-provider/blocked-default-b";
  };
  let headerExtractions = 0;
  const context: any = {
    runtimeOptions,
    resolveBareModelToConnectionDefault,
    modelStr: "bare-alias",
    model: "model-a",
    provider: "fixture-provider",
    credentials: { defaultModel: "blocked-default-b" },
    request: { headers: new Headers() },
    extractApiKey: () => {
      headerExtractions++;
      return null;
    },
    // This is deliberately present to expose any regression to header-based
    // authorization in the actual gate statements extracted above.
    isModelAllowedForKey: result.context.isModelAllowedForKey,
    routingFailure,
  };
  vm.runInNewContext(effectiveScript, context, { timeout: 1000 });
  const response = await context.result;
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "global_fallback_model_not_allowed");
  assert.equal(headerExtractions, 0);
  assert.deepEqual(observed, [
    { key: result.context.policy.apiKey, model: "fixture-provider/blocked-default-b" },
  ]);
});

test("required final-model authorization fails closed without its internal callback", async () => {
  const result = await finalModelGate("gpt-4o", { authorizeFallbackModel: undefined });
  assert.equal(result.status, 403);
  assert.equal((await result.json()).error.code, "global_fallback_model_not_allowed");
});
