// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-miss-quarantine-"));
process.env.DATA_DIR = dir;
delete process.env.NEXT_PHASE;
process.env.API_KEY_SECRET = "fixture-only-nonproduction";
globalThis.fetch = async () => {
  throw new Error("unexpected_network");
};
const core = await import("../../../src/lib/db/core.ts");
const quarantine = await import("../../../src/lib/db/nativeRouteMissQuarantine.ts");
const nvidia = await import("../../../src/lib/db/nvidiaModelAvailability.ts");
const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { executeChatWithBreaker, withCorrelationId } =
  await import("../../../src/sse/handlers/chatHelpers.ts");
const { clearAllModelLockouts } = await import("../../../open-sse/services/accountFallback.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { clearCooldownState } =
  await import("../../../open-sse/services/providerCooldownTracker.ts");
const {
  installZeroCostEvidenceResolver,
  executeWithZeroCostAdmission,
  ZeroCostAdmissionError,
  zeroCostErrorResult,
} = await import("../../../open-sse/services/autoCombo/zeroCostAdmission.ts");
const endpoint = "https://integrate.api.nvidia.com/v1/chat/completions";
const model = "bigcode/starcoder2-15b";
const ns = "nativeRouteMissNegativeV1";
const account = "fixture-account-a";
const log = { debug() {}, info() {}, warn() {}, error() {} };
let wires = 0,
  fallbackCalls = 0,
  costChecks: string[] = [],
  firstCodes: string[] = [];
let badUrl = false,
  blankUrl = false,
  redirected = false,
  wrongStatus = false,
  generic = false,
  uncertain = false,
  denyFallback = false;
let sequence = 0;
installZeroCostEvidenceResolver((r) => {
  costChecks.push(r.model);
  return denyFallback && r.model === "gpt-4o"
    ? null
    : {
        provider: r.provider,
        model: r.model,
        connectionId: r.connectionId,
        noAdditionalCost: true,
        request: r,
        evidenceId: "fixture",
      };
});
function seed() {
  const db = core.getDbInstance();
  db.prepare("DELETE FROM key_value").run();
  db.prepare("DELETE FROM provider_connections").run();
  for (const id of [account, "fixture-account-b"]) {
    db.prepare(
      "INSERT INTO provider_connections(id,provider,auth_type,is_active,provider_specific_data,created_at,updated_at,proxy_enabled,per_key_proxy_enabled) VALUES(?,?,?,?,?,?,?,0,0)"
    ).run(id, "nvidia", "apikey", 1, "{}", "created", "r1");
    db.prepare("INSERT INTO key_value(namespace,key,value) VALUES(?,?,?)").run(
      "syncedAvailableModels",
      "nvidia:" + id,
      JSON.stringify([{ id: model }, { id: "fixture/healthy" }])
    );
  }
}
function proof() {
  return nvidia.captureNvidiaSelectionProof("nvidia", account, model, "r1");
}
function rows() {
  return core.getDbInstance().prepare("SELECT value FROM key_value WHERE namespace=?").all(ns);
}
async function run(strictCost = false, selectedProof = proof()) {
  const body = {
    stream: false,
    max_tokens: 64,
    messages: [{ role: "user", content: "synthetic fixture only" }],
  };
  const original = structuredClone(body);
  globalThis.fetch = async () => {
    wires++;
    if (uncertain) throw new Error("fixture_transport_uncertain");
    const response = new Response(generic ? "Not Found" : "404 page not found\n", {
      status: wrongStatus ? 503 : 404,
    });
    Object.defineProperty(response, "url", {
      value: blankUrl ? "" : badUrl ? "https://wrong.invalid/" : endpoint,
    });
    Object.defineProperty(response, "redirected", { value: redirected });
    return response;
  };
  const result = await handleComboChat({
    body,
    combo: {
      name: "route-cache-fixture-" + sequence++,
      strategy: "priority",
      models: [{ model: "nvidia/" + model }, { model: "openai/gpt-4o" }],
      config: {
        maxRetries: 0,
        maxSetRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        disableSessionStickiness: true,
        reasoningTokenBufferEnabled: false,
      },
    },
    settings: {},
    log,
    isModelAvailable: async () => true,
    handleSingleModel: async (request, name, target) => {
      assert.deepEqual(request.messages, original.messages);
      if (name === "openai/gpt-4o") {
        try {
          return await executeWithZeroCostAdmission(
            true,
            [account],
            "openai",
            { model: "gpt-4o", body: request, credentials: { connectionId: account } },
            async () => {
              fallbackCalls++;
              return Response.json({
                choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
              });
            }
          );
        } catch (e) {
          if (e instanceof ZeroCostAdmissionError) return zeroCostErrorResult(e).response;
          throw e;
        }
      }
      const credentials = {
        apiKey: "fixture-only",
        connectionId: account,
        providerSpecificData: {},
        nvidiaModelAvailabilityProof: selectedProof,
      };
      const { result: actual } = await executeChatWithBreaker({
        body: structuredClone(request),
        provider: "nvidia",
        model,
        credentials,
        refreshedCredentials: credentials,
        bypassCircuitBreaker: true,
        log,
        clientRawRequest: {
          endpoint: "/v1/messages",
          body: structuredClone(request),
          headers: new Headers({ accept: "application/json" }),
        },
        apiKeyInfo: { noLog: true },
        routingAttemptToken: target.routingAttemptToken,
        skipUpstreamRetry: true,
        requireZeroCostAdmission: strictCost,
        costAdmissionConnectionIds: [account],
      });
      firstCodes.push(actual.errorCode);
      return withCorrelationId(actual.response, "fixture-correlation");
    },
  });
  assert.deepEqual(body, original);
  await result.text();
  return result;
}
test.beforeEach(() => {
  seed();
  clearAllModelLockouts();
  resetAllCircuitBreakers();
  clearCooldownState();
  wires = 0;
  fallbackCalls = 0;
  costChecks = [];
  firstCodes = [];
  badUrl = blankUrl = redirected = wrongStatus = generic = uncertain = denyFallback = false;
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});
test("verified native route miss persists and a new request skips wire while freshly admitting fallback", async () => {
  assert.equal((await run(false)).status, 200);
  assert.equal(wires, 1);
  assert.equal(rows().length, 1, "route miss must persist separately from entitlement facts");
  clearAllModelLockouts();
  assert.equal((await run(false)).status, 200);
  assert.equal(wires, 1, "a second request must skip the quarantined exact tuple");
  assert.equal(fallbackCalls, 2);
  assert.equal(firstCodes[1], "nvidia_native_route_not_found");
  assert.equal(costChecks.filter((x) => x === "gpt-4o").length, 2);
});

function selectedRouteProof(
  connectionId = account,
  selectedModel = model,
  selectedEndpoint = endpoint
) {
  const selected = nvidia.captureNvidiaSelectionProof("nvidia", connectionId, selectedModel, "r1");
  return quarantine.captureNativeRouteMissProof(
    "nvidia",
    connectionId,
    selectedModel,
    selectedEndpoint,
    selected
  );
}
function evidence(overrides = {}) {
  return {
    provider: "nvidia",
    nativeExecutor: true,
    status: 404,
    endpoint,
    responseUrl: endpoint,
    redirected: false,
    body: { _rawText: "404 page not found\n" },
    expectedModel: model,
    attemptModel: model,
    expectedConnection: account,
    attemptConnection: account,
    ...overrides,
  };
}
function record(p = selectedRouteProof(), e = evidence(), text = "404 page not found\n") {
  return quarantine.recordNativeRouteMiss(p, e, text);
}
test("cache stores only allowlisted metadata, never extra proof fields or raw error prose", () => {
  const p = selectedRouteProof();
  assert.ok(p);
  assert.equal(record({ ...p, unexpected: "SECRET_MARKER" }), true);
  const row = rows()[0].value;
  assert.equal(row.includes("SECRET_MARKER"), false);
  assert.equal(row.includes("404 page not found"), false);
  assert.equal(row.includes(endpoint), false);
  assert.deepEqual(
    Object.keys(JSON.parse(row)).sort(),
    [
      "provider",
      "connectionId",
      "endpointHash",
      "model",
      "revision",
      "capturedAt",
      "observedAt",
    ].sort()
  );
});
for (const [name, changed] of [
  ["blank actual URL", { responseUrl: "" }],
  ["foreign actual URL", { responseUrl: "https://wrong.invalid/" }],
  ["redirect", { redirected: true }],
  ["wrong selected endpoint", { endpoint: "https://wrong.invalid/" }],
  ["custom executor", { nativeExecutor: false }],
  ["wrong provider", { provider: "openai" }],
  ["wrong status", { status: 503 }],
  ["wrong selected account", { attemptConnection: "fixture-account-b" }],
  ["wrong selected model", { attemptModel: "fixture/healthy" }],
  ["generic error", { body: { _rawText: "Not Found" } }],
  [
    "body carrying committed usage",
    { body: { _rawText: "404 page not found\n", usage: { completion_tokens: 1 } } },
  ],
])
  test(name + " cannot seed durable route-miss evidence", () => {
    assert.equal(record(selectedRouteProof(), evidence(changed)), false);
    assert.equal(rows().length, 0);
  });
test("missing/stale/single-key-invalid proof cannot seed or read quarantine", () => {
  assert.equal(record(null), false);
  const old = selectedRouteProof();
  nvidia.invalidateNvidiaModelIdentity(account);
  assert.equal(record(old), false);
  assert.equal(quarantine.getNativeRouteMiss(old), null);
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET provider_specific_data=? WHERE id=?")
    .run('{"extraApiKeys":["fixture-only"]}', account);
  assert.equal(selectedRouteProof(), null);
  assert.equal(rows().length, 0);
});
test("exact account/model/endpoint isolation does not create a provider or sibling-model ban", () => {
  assert.equal(record(), true);
  assert.ok(quarantine.getNativeRouteMiss(selectedRouteProof()));
  assert.equal(quarantine.getNativeRouteMiss(selectedRouteProof("fixture-account-b")), null);
  assert.equal(selectedRouteProof(account, "fixture/healthy"), null);
  assert.equal(selectedRouteProof(account, model, "https://wrong.invalid/"), null);
});
test("reset, endpoint and exact catalog changes invalidate stored facts and in-flight proof", () => {
  for (const change of [
    () => nvidia.clearNvidiaModelNegatives(account, model),
    () => nvidia.invalidateNvidiaModelIdentity(account),
    () =>
      core
        .getDbInstance()
        .prepare("UPDATE provider_connections SET provider_specific_data=? WHERE id=?")
        .run('{"baseUrl":"https://changed.invalid/"}', account),
    () =>
      core
        .getDbInstance()
        .prepare("UPDATE key_value SET value=? WHERE namespace='syncedAvailableModels' AND key=?")
        .run(JSON.stringify([{ id: model, apiFormat: "changed" }]), "nvidia:" + account),
  ]) {
    seed();
    const old = selectedRouteProof();
    assert.equal(record(old), true);
    change();
    assert.equal(quarantine.getNativeRouteMiss(old), null);
    assert.equal(record(old), false);
    assert.equal(quarantine.getNativeRouteMiss(selectedRouteProof()), null);
  }
});
test("durable tuple survives a fresh process and SQLite reopen", () => {
  assert.equal(record(), true);
  core.resetDbInstance();
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--import",
      "./open-sse/utils/setupPolyfill.ts",
      "tests/unit/fixtures/native-route-miss-reopen-20261108.ts",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20000,
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp",
        DATA_DIR: dir,
        API_KEY_SECRET: "fixture-only-nonproduction",
        DISABLE_SQLITE_AUTO_BACKUP: "true",
        APP_LOG_TO_FILE: "false",
        OMNIROUTE_SKIP_SYSTEM_TRUST: "1",
        OMNIROUTE_SKIP_DNS_WRITE: "1",
      },
    }
  );
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /ROUTE_MISS_REOPEN:true/);
  assert.ok(quarantine.getNativeRouteMiss(selectedRouteProof()));
});
test("actual credential selection skips only account A and returns healthy B for the same model", async () => {
  assert.equal(record(), true);
  clearAllModelLockouts();
  const db = core.getDbInstance();
  for (const [id, priority] of [
    [account, 1],
    ["fixture-account-b", 2],
  ])
    db.prepare("UPDATE provider_connections SET api_key='fixture-only',priority=? WHERE id=?").run(
      priority,
      id
    );
  const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
  invalidateDbCache("connections");
  const auth = await import("../../../src/sse/services/auth.ts");
  const selected = await auth.getProviderCredentials(
    "nvidia",
    null,
    [account, "fixture-account-b"],
    model,
    { bypassQuotaPolicy: true }
  );
  assert.equal(selected?.connectionId, "fixture-account-b");
  assert.equal(selected?.nvidiaModelAvailabilityProof?.connectionId, "fixture-account-b");
  const restricted = await auth.getProviderCredentials("nvidia", null, [account], model, {
    bypassQuotaPolicy: true,
  });
  assert.notEqual(restricted?.connectionId, "fixture-account-b", "allowed scope cannot expand");
  const forced = await auth.getProviderCredentials(
    "nvidia",
    null,
    [account, "fixture-account-b"],
    model,
    { bypassQuotaPolicy: true, forcedConnectionId: account }
  );
  assert.notEqual(forced?.connectionId, "fixture-account-b", "forced scope cannot expand");
  const excluded = await auth.getProviderCredentials(
    "nvidia",
    "fixture-account-b",
    [account, "fixture-account-b"],
    model,
    { bypassQuotaPolicy: true }
  );
  assert.notEqual(excluded?.connectionId, "fixture-account-b", "excluded scope cannot expand");
});
test("expiry is bounded from dispatch capture; read and late response never renew it", (t) => {
  let now = Date.now() + 3600000;
  t.mock.method(Date, "now", () => now);
  const p = selectedRouteProof();
  assert.equal(record(p), true);
  const raw = rows()[0].value;
  now = p.capturedAt + quarantine.NATIVE_ROUTE_MISS_TTL_MS - 100;
  assert.ok(quarantine.getNativeRouteMiss(selectedRouteProof()));
  now = p.capturedAt + quarantine.NATIVE_ROUTE_MISS_TTL_MS;
  assert.equal(quarantine.getNativeRouteMiss(selectedRouteProof()), null);
  assert.equal(record(p), false);
  assert.equal(rows()[0].value, raw);
});
test("late older observations cannot replace a newer captured fact", (t) => {
  let now = Date.now() + 8000000;
  t.mock.method(Date, "now", () => now);
  const old = selectedRouteProof();
  now += 1000;
  const newer = selectedRouteProof();
  assert.equal(record(newer), true);
  const raw = rows()[0].value;
  now += 1000;
  assert.equal(record(old), false);
  assert.equal(rows()[0].value, raw);
});
test("malformed, future and mismatched stored metadata never veto eligibility", () => {
  assert.equal(record(), true);
  const raw = JSON.parse(rows()[0].value);
  for (const changed of [
    { capturedAt: "bad" },
    { capturedAt: Date.now() + 36000000 },
    { observedAt: "bad" },
    { observedAt: "9999-01-01T00:00:00.000Z" },
    { revision: "0".repeat(64) },
    { endpointHash: "0".repeat(64) },
    { connectionId: "other" },
    { model: "other" },
  ]) {
    core
      .getDbInstance()
      .prepare("UPDATE key_value SET value=? WHERE namespace=?")
      .run(JSON.stringify({ ...raw, ...changed }), ns);
    assert.equal(quarantine.getNativeRouteMiss(selectedRouteProof()), null);
  }
});
for (const strict of [false, true])
  test(
    (strict ? "strict-cost" : "provider-managed") +
      " cached skip retains fresh fallback admission and original input",
    async () => {
      assert.equal((await run(strict)).status, 200);
      clearAllModelLockouts();
      assert.equal((await run(strict)).status, 200);
      assert.equal(wires, 1);
      assert.equal(fallbackCalls, 2);
      assert.equal(costChecks.filter((x) => x === "gpt-4o").length, 2);
    }
  );
test("cache hit cannot bypass a fallback cost refusal", async () => {
  assert.equal((await run(false)).status, 200);
  clearAllModelLockouts();
  denyFallback = true;
  assert.notEqual((await run(false)).status, 200);
  assert.equal(wires, 1);
  assert.equal(fallbackCalls, 1);
});
for (const [name, set] of [
  [
    "legacy blank URL",
    () => {
      blankUrl = true;
    },
  ],
  [
    "generic404",
    () => {
      generic = true;
    },
  ],
  [
    "uncertain execution",
    () => {
      uncertain = true;
    },
  ],
  [
    "foreign URL",
    () => {
      badUrl = true;
    },
  ],
])
  test(name + " has no durable write or extra dispatch authority", async () => {
    set();
    await run(false);
    assert.equal(rows().length, 0);
    assert.equal(wires, 1);
    if (name !== "legacy blank URL") assert.equal(fallbackCalls, 0);
  });
async function configureProfile(mode = "native") {
  const { upsertUpstreamProxyConfig } = await import("../../../src/lib/db/upstreamProxy.ts");
  await upsertUpstreamProxyConfig({ providerId: "nvidia", mode, enabled: true });
  const { clearUpstreamProxyConfigCache } =
    await import("../../../open-sse/handlers/chatCore/comboContextCache.ts");
  clearUpstreamProxyConfigCache();
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET api_key=?,priority=? WHERE id=?")
    .run("fixture-a", 1, account);
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET api_key=?,priority=? WHERE id=?")
    .run("fixture-b", 2, "fixture-account-b");
  const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
  invalidateDbCache("connections");
}
test("central fallback profile selects healthy B while noncentral proxy fallback keeps A eligible", async () => {
  await configureProfile("fallback");
  assert.equal(record(), true);
  const auth = await import("../../../src/sse/services/auth.ts");
  const noncentral = await auth.getProviderCredentials(
    "nvidia",
    null,
    [account, "fixture-account-b"],
    model,
    { bypassQuotaPolicy: true }
  );
  assert.equal(noncentral?.connectionId, account);
  const central = await auth.getProviderCredentials(
    "nvidia",
    null,
    [account, "fixture-account-b"],
    model,
    { bypassQuotaPolicy: true, centralNativeAttempt: true }
  );
  assert.equal(central?.connectionId, "fixture-account-b");
  assert.equal(
    (
      await auth.getProviderCredentials("nvidia", null, [account], model, {
        bypassQuotaPolicy: true,
        centralNativeAttempt: true,
      })
    )?.connectionId,
    undefined
  );
  assert.notEqual(
    (
      await auth.getProviderCredentials("nvidia", null, [account, "fixture-account-b"], model, {
        bypassQuotaPolicy: true,
        centralNativeAttempt: true,
        forcedConnectionId: account,
      })
    )?.connectionId,
    "fixture-account-b"
  );
  assert.notEqual(
    (
      await auth.getProviderCredentials("nvidia", "fixture-account-b", null, model, {
        bypassQuotaPolicy: true,
        centralNativeAttempt: true,
      })
    )?.connectionId,
    "fixture-account-b"
  );
});
test("central affinity does not let a quarantined pin override healthy forced B", async () => {
  await configureProfile("fallback");
  assert.equal(record(), true);
  const affinity = await import("../../../src/lib/db/sessionAccountAffinity.ts");
  affinity.upsertSessionAccountAffinity("fixture-affinity", "nvidia", account, Date.now(), 60000);
  const auth = await import("../../../src/sse/services/auth.ts");
  const selected = await auth.getProviderCredentials(
    "nvidia",
    null,
    [account, "fixture-account-b"],
    model,
    {
      bypassQuotaPolicy: true,
      centralNativeAttempt: true,
      forcedConnectionId: "fixture-account-b",
      sessionKey: "fixture-affinity",
      sessionAffinityTtlMs: 60000,
    }
  );
  assert.equal(selected?.connectionId, "fixture-account-b");
});
test("a current proxy or changed endpoint cannot inherit a native endpoint veto", async () => {
  await configureProfile("native");
  assert.equal(record(), true);
  await configureProfile("cliproxyapi");
  assert.equal(quarantine.getNativeRouteMissForAccount("nvidia", account, model, true), null);
  await configureProfile("native");
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET provider_specific_data=? WHERE id=?")
    .run('{"cliproxyapiMode":"claude-native"}', account);
  assert.equal(quarantine.getNativeRouteMissForAccount("nvidia", account, model, true), null);
});
async function productRequest(central: boolean | "auto") {
  await configureProfile("fallback");
  assert.equal(record(), true);
  const { updateSettings } = await import("../../../src/lib/db/settings.ts");
  await updateSettings({
    requestRetry: 0,
    maxRetryIntervalSec: 0,
    requireApiKey: false,
    comboFailoverEnabled: false,
  });
  const { createCombo } = await import("../../../src/lib/db/combos.ts");
  const name = "native-cache-product-" + sequence++;
  if (central)
    await createCombo({
      name,
      strategy: central === "auto" ? "auto" : "priority",
      models: ["nvidia/" + model],
      config: {
        maxRetries: 0,
        maxSetRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        disableSessionStickiness: true,
        auto:
          central === "auto"
            ? {
                selectionPolicy: "fit-first-free",
                zeroAdditionalCostProviders: ["nvidia"],
                explorationRate: 0,
              }
            : undefined,
      },
    });
  const seen: string[] = [];
  globalThis.fetch = async (_url, init = {}) => {
    seen.push(new Headers(init.headers).get("authorization") || "");
    return Response.json({
      id: "fixture",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };
  const body = {
    model: central ? name : "nvidia/" + model,
    stream: false,
    max_tokens: 16,
    messages: [{ role: "user", content: "synthetic fixture only" }],
    centralNativeAttempt: true,
    routingAttemptToken: { enter: "not-authority" },
    _omniroute: { centralNativeAttempt: true },
  };
  if (central === "auto") {
    // Equal account/model evidence uses the documented neutral request-hash tie break.
    // Choose a benign fixture whose actual pure ranker places A before B.
    const { rankFitFirstFreeCandidates } =
      await import("../../../open-sse/services/autoCombo/fitFirstPolicy.ts");
    const candidates = [account, "fixture-account-b"].map((connectionId) => ({
      provider: "nvidia",
      model,
      modelStr: "nvidia/" + model,
      connectionId,
      quotaRemaining: 100,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 1,
      p95LatencyMs: 1000,
      latencyStdDev: 100,
      errorRate: 0,
    }));
    let aFirst = false;
    for (let i = 0; i < 20; i++) {
      body.messages[0].content = "synthetic fixture only " + i;
      const ranked = rankFitFirstFreeCandidates({
        candidates,
        body,
        zeroAdditionalCostProviders: ["nvidia"],
      });
      if (ranked.ranked[0]?.candidate.connectionId === account) {
        aFirst = true;
        break;
      }
    }
    assert.equal(aFirst, true, "A-first branch must be established before the product call");
  }
  const { handleChat } = await import("../../../src/sse/handlers/chat.ts");
  const response = await handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-omniroute-central-native-attempt": "true" },
      body: JSON.stringify(body),
    })
  );
  const payload = await response.text();
  assert.equal(response.status, 200, payload);
  assert.equal(seen.length, 1, "one physical send only");
  return seen;
}
test("actual product central token discards stale A preselection and dispatches B once", async () => {
  assert.deepEqual(await productRequest(true), ["Bearer fixture-b"]);
});
test("forged client body and header flags cannot enable central native veto on noncentral proxy fallback", async () => {
  assert.deepEqual(await productRequest(false), ["Bearer fixture-a"]);
});
test("failed cache writes do not change qualified rejection or add attempts", async () => {
  core
    .getDbInstance()
    .exec(
      `CREATE TEMP TRIGGER deny_route_miss_write BEFORE INSERT ON key_value WHEN NEW.namespace='${ns}' BEGIN SELECT RAISE(ABORT,'fixture-write-denied'); END;`
    );
  try {
    assert.equal((await run()).status, 200);
    assert.equal(wires, 1);
    assert.equal(fallbackCalls, 1);
    assert.equal(rows().length, 0);
  } finally {
    core.getDbInstance().exec("DROP TRIGGER deny_route_miss_write");
  }
});
test("cache read failure grants no fallback after uncertain execution", async (t) => {
  const db = core.getDbInstance(),
    prepare = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql, ...rest) => {
    const statement = prepare(sql, ...rest);
    if (sql === "SELECT value FROM key_value WHERE namespace=? AND key=?") {
      const original = statement.get.bind(statement);
      statement.get = (namespace, ...args) => {
        if (namespace === ns) throw new Error("fixture-read-denied");
        return original(namespace, ...args);
      };
    }
    return statement;
  });
  uncertain = true;
  await run();
  assert.equal(wires, 1);
  assert.equal(fallbackCalls, 0);
});

test("actual auto fit-first account-bound A skip advances to separately admitted healthy B", async () => {
  assert.deepEqual(await productRequest("auto"), ["Bearer fixture-b"]);
});
test("all scoped native-cache refusals carry local provenance, with no widened account scope", async () => {
  await configureProfile("fallback");
  assert.equal(record(), true);
  const auth = await import("../../../src/sse/services/auth.ts");
  const refused = await auth.getProviderCredentials("nvidia", null, [account], model, {
    bypassQuotaPolicy: true,
    centralNativeAttempt: true,
  });
  assert.ok(refused, "all exact scoped cache misses need a server-owned nondispatch verdict");
  assert.equal(quarantine.isNativeRouteMissCredentialRefusal(refused), true);
  assert.equal(
    quarantine.isNativeRouteMissCredentialRefusal({ allNativeRouteMisses: true }),
    false
  );
  assert.equal(refused?.connectionId, undefined);
});
for (const [name, change] of [
  [
    "terminal auth status",
    () =>
      core
        .getDbInstance()
        .prepare("UPDATE provider_connections SET test_status='expired' WHERE id=?")
        .run("fixture-account-b"),
  ],
  [
    "model exclusion",
    () =>
      core
        .getDbInstance()
        .prepare("UPDATE provider_connections SET provider_specific_data=? WHERE id=?")
        .run(JSON.stringify({ excludedModels: [model] }), "fixture-account-b"),
  ],
  ["no accounts", () => core.getDbInstance().prepare("DELETE FROM provider_connections").run()],
])
  test(
    "mixed/no-account refusal does not inherit native-cache-only provenance: " + name,
    async () => {
      await configureProfile("fallback");
      assert.equal(record(), true);
      change();
      const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
      invalidateDbCache("connections");
      const auth = await import("../../../src/sse/services/auth.ts");
      const refused = await auth.getProviderCredentials("nvidia", null, null, model, {
        bypassQuotaPolicy: true,
        centralNativeAttempt: true,
      });
      assert.equal(quarantine.isNativeRouteMissCredentialRefusal(refused), false);
    }
  );
