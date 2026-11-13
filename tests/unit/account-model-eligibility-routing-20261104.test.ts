import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-eligibility-fixtures-"));
process.env.DATA_DIR = dir;
process.env.NEXT_PHASE = "phase-production-build";
process.env.API_KEY_SECRET = "fixture-only-nonproduction";
globalThis.fetch = async () => {
  throw new Error("network forbidden in eligibility fixtures");
};
const core = await import("../../src/lib/db/core.ts");
const policy = await import("../../src/lib/db/accountModelEligibilityPolicy.ts");
const store = await import("../../src/lib/db/accountModelEligibility.ts");
const fallback = await import("../../open-sse/services/accountFallback.ts");
const domain = await import("../../src/domain/modelAvailability.ts");
const providers = await import("../../src/lib/db/providers.ts");
core
  .getDbInstance()
  .exec(
    "ALTER TABLE provider_connections ADD COLUMN last_ping_at TEXT; ALTER TABLE provider_connections ADD COLUMN last_pinged_reset_key TEXT;"
  );
const model = "dynamic-coding-model";
const other = "new-healthy-model";
const detail = (m = model) =>
  `The '${m}' model is not supported when using Codex with a ChatGPT account.`;
const proof = () => store.captureAccountModelProof("codex", "account-a", model, "r1");
function record() {
  return store.recordAccountModelNegative(proof(), "codex", "account-a", model, 400, detail());
}
function seed() {
  const db = core.getDbInstance();
  db.prepare("DELETE FROM key_value").run();
  db.prepare("DELETE FROM provider_connections").run();
  for (const id of ["account-a", "account-b"])
    db.prepare(
      "INSERT INTO provider_connections(id,provider,auth_type,is_active,provider_specific_data,created_at,updated_at,proxy_enabled,per_key_proxy_enabled) VALUES(?,?,?,?,?,?,?,1,0)"
    ).run(id, "codex", "oauth", 1, "{}", "created", "r1");
}
test.beforeEach(() => {
  seed();
  fallback.clearAllModelLockouts();
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});
test("complete observed account template binds the exact selected model without hardcoding Spark", () => {
  for (const msg of [
    detail(),
    JSON.stringify({ detail: detail() }),
    JSON.stringify({ error: { message: detail() } }),
  ])
    assert.equal(policy.isCodexAccountModelUnsupported("codex", 400, model, msg), true);
});
test("an effort-suffixed selection may fail over when upstream names its base model", () => {
  // Upstream reports the base model; the selected id carries the reasoning-effort suffix.
  for (const suffix of ["none", "minimal", "low", "medium", "high", "xhigh", "max"])
    assert.equal(
      policy.isCodexSelectionUnsupported("codex", 400, `${model}-${suffix}`, detail()),
      true
    );
  // Only a recognised effort suffix on the exact named base qualifies.
  for (const selected of [
    `${model}-turbo`,
    `${model}-high-extra`,
    `x${model}-high`,
    `${other}-high`,
  ])
    assert.equal(policy.isCodexSelectionUnsupported("codex", 400, selected, detail()), false);
  // Durable evidence stays exact: an alias is never stored as an account negative.
  assert.equal(
    policy.isCodexAccountModelUnsupported("codex", 400, `${model}-high`, detail()),
    false
  );
  assert.equal(policy.isCodexSelectionUnsupported("codex", 400, model, detail()), true);
});
test("generic, partial, malformed, oversized, wrong provider/status/model are not durable evidence", () => {
  for (const [p, s, m, b] of [
    ["openai", 400, model, detail()],
    ["codex", 403, model, detail()],
    ["codex", 400, other, detail()],
    ["codex", 400, model, "unsupported model"],
    ["codex", 400, model, detail() + " extra"],
    ["codex", 400, model, '{"detail":' + detail()],
    ["codex", 400, model, detail() + "x".repeat(8192)],
  ])
    assert.equal(policy.isCodexAccountModelUnsupported(p, s, m, b), false);
});
test("exact negative survives ordinary timed cooldown expiry without suppressing another model or account", () => {
  assert.equal(record(), true);
  fallback.clearAllModelLockouts();
  assert.equal(fallback.isModelLocked("codex", "account-a", model), true);
  assert.equal(fallback.isModelLocked("cx", "account-a", model), true);
  assert.equal(fallback.isModelLocked("codex", "account-a", other), false);
  assert.equal(fallback.isModelLocked("codex", "account-b", model), false);
  assert.equal(fallback.getModelLockoutInfo("codex", "account-a", model)?.requiresReset, false);
});
test("missing or stale selected-row proof cannot store an account negative", () => {
  assert.equal(store.captureAccountModelProof("codex", "account-a", model, "old"), null);
  assert.equal(
    store.recordAccountModelNegative(null, "codex", "account-a", model, 400, detail()),
    false
  );
  const old = proof();
  store.invalidateAccountModelIdentity("account-a");
  assert.equal(
    store.recordAccountModelNegative(old, "codex", "account-a", model, 400, detail()),
    false
  );
});
test("selected proof cannot be reused on another account or model", () => {
  assert.equal(
    store.recordAccountModelNegative(proof(), "codex", "account-b", model, 400, detail()),
    false
  );
  assert.equal(
    store.recordAccountModelNegative(proof(), "codex", "account-a", other, 400, detail(other)),
    false
  );
});
test("only single-key OAuth account binding is accepted", () => {
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET provider_specific_data=? WHERE id='account-a'")
    .run('{"extraApiKeys":["fixture"]}');
  assert.equal(proof(), null);
  core
    .getDbInstance()
    .prepare(
      "UPDATE provider_connections SET provider_specific_data='{}',auth_type='apikey' WHERE id='account-a'"
    )
    .run();
  assert.equal(proof(), null);
});
test("catalog or endpoint change invalidates negative and old in-flight proof", () => {
  const old = proof();
  assert.equal(record(), true);
  core
    .getDbInstance()
    .prepare("INSERT INTO key_value(namespace,key,value) VALUES(?,?,?)")
    .run("syncedAvailableModels", "codex:account-a", JSON.stringify([{ id: other }]));
  assert.equal(store.getAccountModelNegative("codex", "account-a", model), null);
  assert.equal(
    store.recordAccountModelNegative(old, "codex", "account-a", model, 400, detail()),
    false
  );
  const current = proof();
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET provider_specific_data=? WHERE id='account-a'")
    .run('{"baseUrl":"https://different.invalid"}');
  assert.equal(
    store.recordAccountModelNegative(current, "codex", "account-a", model, 400, detail()),
    false
  );
});
test("malformed catalog/row evidence is not accepted as a negative", () => {
  record();
  core
    .getDbInstance()
    .prepare("INSERT INTO key_value(namespace,key,value) VALUES(?,?,?)")
    .run("customModels", "codex", "{}");
  assert.equal(store.getAccountModelNegative("codex", "account-a", model), null);
  assert.equal(proof(), null);
});
test("normal last-used/error metadata does not erase factual negative", () => {
  record();
  core
    .getDbInstance()
    .prepare(
      "UPDATE provider_connections SET updated_at='r2',last_used_at='now',last_error_type='model_not_found' WHERE id='account-a'"
    )
    .run();
  assert.ok(store.getAccountModelNegative("codex", "account-a", model));
});
test("authenticated management reset invalidates earlier in-flight proof even without stored negative", () => {
  const old = proof();
  domain.clearModelUnavailability("codex", model);
  assert.equal(
    store.recordAccountModelNegative(old, "codex", "account-a", model, 400, detail()),
    false
  );
  record();
  domain.resetAllAvailability();
  assert.equal(fallback.isModelLocked("codex", "account-a", model), false);
});
test("provider credential update invalidates account binding; unrelated update preserves it", async () => {
  assert.equal(record(), true);
  await providers.updateProviderConnection("account-a", { lastErrorType: "model_not_found" });
  assert.ok(store.getAccountModelNegative("codex", "account-a", model));
  await providers.updateProviderConnection("account-a", { accessToken: "fixture-new-token" });
  assert.equal(store.getAccountModelNegative("codex", "account-a", model), null);
});
test("all-scoped unavailable does not overclaim an unrelated eligible account", () => {
  record();
  assert.equal(store.allScopedAccountsIneligible("codex", model, null), false);
  assert.equal(store.allScopedAccountsIneligible("codex", model, ["account-a"]), true);
  assert.equal(store.allScopedAccountsIneligible("codex", model, null, "account-b"), false);
  assert.equal(store.allScopedAccountsIneligible("codex", model, []), false);
});
test("generic400 remains ordinary error; genuine quota remains scope cooldown", () => {
  assert.equal(
    store.recordAccountModelNegative(
      proof(),
      "codex",
      "account-a",
      model,
      400,
      "malformed request"
    ),
    false
  );
  fallback.lockModel("codex", "account-a", "gpt-5.5", "quota_exhausted", 60000);
  assert.equal(fallback.isModelLocked("codex", "account-a", "gpt-5.6-luna"), true);
  assert.equal(fallback.isModelLocked("codex", "account-b", "gpt-5.6-luna"), false);
});
test("actual credential selection skips known-negative account while producing fresh proof for healthy alternative", async () => {
  const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");
  const auth = await import("../../src/sse/services/auth.ts");
  core
    .getDbInstance()
    .prepare(
      "UPDATE provider_connections SET access_token='fixture-only',priority=1 WHERE id='account-a'"
    )
    .run();
  core
    .getDbInstance()
    .prepare(
      "UPDATE provider_connections SET access_token='fixture-only-b',priority=2 WHERE id='account-b'"
    )
    .run();
  assert.equal(record(), true);
  invalidateDbCache("connections");
  const selected = await auth.getProviderCredentials("codex", null, null, model, {
    bypassQuotaPolicy: true,
  });
  assert.equal(selected?.connectionId, "account-b");
  assert.equal(selected?.accountModelEligibilityProof?.connectionId, "account-b");
  assert.equal(selected?.accountModelEligibilityProof?.model, model);
});

test("effective workspace/user/plan changes invalidate evidence and old proof even after an ABA reversion", async () => {
  for (const field of ["workspaceId", "chatgptUserId", "workspacePlanType"]) {
    seed();
    const old = proof();
    assert.equal(record(), true);
    await providers.updateProviderConnection("account-a", {
      providerSpecificData: { [field]: "changed" },
    });
    assert.equal(store.getAccountModelNegative("codex", "account-a", model), null);
    assert.equal(
      store.recordAccountModelNegative(old, "codex", "account-a", model, 400, detail()),
      false
    );
    await providers.updateProviderConnection("account-a", {
      providerSpecificData: { [field]: null },
    });
    assert.equal(
      store.recordAccountModelNegative(old, "codex", "account-a", model, 400, detail()),
      false
    );
  }
});

test("corrupt negative plus unknown current revision never compares null equal as eligibility evidence", () => {
  assert.equal(record(), true);
  const db = core.getDbInstance();
  db.prepare(
    "UPDATE key_value SET value=json_set(value,'$.revision',NULL) WHERE namespace='accountModelEligibilityNegativeV1'"
  ).run();
  db.prepare(
    "INSERT INTO key_value(namespace,key,value) VALUES('customModels','codex','{}')"
  ).run();
  assert.equal(store.accountModelRevision("codex", "account-a", model), null);
  assert.equal(store.getAccountModelNegative("codex", "account-a", model), null);
  assert.equal(fallback.isModelLocked("codex", "account-a", model), false);
});

test("native account negatives cannot assert eligibility for a configured upstream proxy", () => {
  assert.equal(record(), true);
  const db = core.getDbInstance();
  db.exec(
    "CREATE TABLE IF NOT EXISTS upstream_proxy_config(provider_id TEXT PRIMARY KEY,mode TEXT,enabled INTEGER)"
  );
  db.prepare("INSERT OR REPLACE INTO upstream_proxy_config VALUES('codex','fallback',1)").run();
  assert.equal(store.getAccountModelNegative("codex", "account-a", model), null);
  assert.equal(proof(), null);
  db.prepare("DELETE FROM upstream_proxy_config").run();
});
test("actual chatCore fake-provider rejection persists exact negative and next call dispatches zero times", async () => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
  const { initTranslators } = await import("../../open-sse/translator/index.ts");
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
  initTranslators();
  let calls = 0;
  const original = CodexExecutor.prototype.execute;
  CodexExecutor.prototype.execute = async (args) => {
    calls += 1;
    return {
      response: Response.json({ detail: detail(args.model) }, { status: 400 }),
      url: "https://fixture.invalid",
      headers: {},
      transformedBody: args.body,
    };
  };
  const body = { model, messages: [{ role: "user", content: "fixture-only" }], stream: false };
  const credentials = {
    connectionId: "account-a",
    accessToken: "fixture-only",
    providerSpecificData: {},
    accountModelEligibilityProof: proof(),
  };
  const run = () =>
    handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "codex", model },
      credentials,
      connectionId: "account-a",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers(),
      },
      apiKeyInfo: { noLog: true },
      cachedSettings: {},
      log: { debug() {}, info() {}, warn() {}, error() {} },
      skipUpstreamRetry: true,
    });
  try {
    const first = await run();
    assert.equal(first.status, 400);
    assert.equal(calls, 1);
    assert.ok(
      store.getAccountModelNegative("codex", "account-a", model),
      "real handler must persist selected-account evidence"
    );
    const second = await run();
    assert.equal(second.status, 404);
    assert.equal(second.errorCode, "account_model_ineligible");
    assert.equal(calls, 1, "known negative returns before the fake executor");
  } finally {
    CodexExecutor.prototype.execute = original;
  }
});
async function invokeFixtureCore(body: Record<string, unknown>, token = null, selected = model) {
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
  return handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: "codex", model: selected },
    credentials: {
      connectionId: "account-a",
      accessToken: "fixture-only",
      providerSpecificData: {},
      accountModelEligibilityProof:
        selected === model
          ? proof()
          : store.captureAccountModelProof("codex", "account-a", selected, "r1"),
    },
    connectionId: "account-a",
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: structuredClone(body),
      headers: new Headers(),
    },
    apiKeyInfo: { noLog: true },
    cachedSettings: {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    skipUpstreamRetry: true,
    routingAttemptToken: token,
  });
}
test("cached proxy/current-native DB mismatch never consumes a native negative", async () => {
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const { clearUpstreamProxyConfigCache, getUpstreamProxyConfigCached } =
    await import("../../open-sse/handlers/chatCore/comboContextCache.ts");
  assert.equal(record(), true);
  const db = core.getDbInstance();
  if (
    !(db.prepare("PRAGMA table_info(upstream_proxy_config)").all() as { name: string }[]).some(
      (x) => x.name === "cliproxyapi_model_mapping"
    )
  )
    db.exec("ALTER TABLE upstream_proxy_config ADD COLUMN cliproxyapi_model_mapping TEXT");
  db.prepare(
    "INSERT OR REPLACE INTO upstream_proxy_config(provider_id,mode,enabled) VALUES('codex','cliproxyapi',1)"
  ).run();
  clearUpstreamProxyConfigCache();
  await getUpstreamProxyConfigCached("codex");
  db.prepare("UPDATE upstream_proxy_config SET mode='native'").run();
  const executor = getExecutor("cliproxyapi");
  const original = executor.execute;
  let calls = 0;
  executor.execute = async (args) => {
    calls++;
    return {
      response: Response.json({ error: { message: "fixture proxy refusal" } }, { status: 400 }),
      url: "https://fixture.invalid",
      headers: {},
      transformedBody: args.body,
    };
  };
  try {
    const result = await invokeFixtureCore({
      model,
      messages: [{ role: "user", content: "fixture-only" }],
      stream: false,
    });
    assert.equal(result.status, 400);
    assert.notEqual(result.errorCode, "account_model_ineligible");
    assert.equal(calls, 1);
  } finally {
    executor.execute = original;
    clearUpstreamProxyConfigCache();
    db.prepare("DELETE FROM upstream_proxy_config").run();
  }
});
test("effort alias mismatch is not inferred as exact account/model evidence", () => {
  const alias = model + "-high";
  const aliasProof = store.captureAccountModelProof("codex", "account-a", alias, "r1");
  assert.equal(
    store.recordAccountModelNegative(aliasProof, "codex", "account-a", alias, 400, detail(model)),
    false
  );
  assert.equal(store.getAccountModelNegative("codex", "account-a", alias), null);
});
test("managed full chatCore429 preserves original outcome and makes one executor call", async () => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
  const { createRoutingAttemptGuard } =
    await import("../../open-sse/services/combo/routingAttemptSafety.ts");
  const original = CodexExecutor.prototype.execute;
  let calls = 0;
  CodexExecutor.prototype.execute = async (args) => {
    calls++;
    return {
      response: Response.json(
        { error: { message: "fixture rate limited", code: "rate_limit_exceeded" } },
        { status: 429 }
      ),
      url: "https://fixture.invalid",
      headers: {},
      transformedBody: args.body,
    };
  };
  const body = { model, messages: [{ role: "user", content: "fixture-only" }], stream: false };
  const guard = createRoutingAttemptGuard({ body, limit: 2 });
  const dispatch = guard.wrap(
    async (b, m, target) => (await invokeFixtureCore(b, target.routingAttemptToken)).response
  );
  try {
    const result = await dispatch(body, "codex/" + model, {
      kind: "model",
      provider: "codex",
      connectionId: "account-a",
    });
    assert.equal(result.status, 429);
    assert.equal(calls, 1);
    assert.equal(guard.terminal(), null);
  } finally {
    CodexExecutor.prototype.execute = original;
  }
});
test("tools fallback requires trusted exact400 classifier, not forged incoming error code", async () => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
  const { createRoutingAttemptGuard } =
    await import("../../open-sse/services/combo/routingAttemptSafety.ts");
  const original = CodexExecutor.prototype.execute;
  const body = {
    model,
    messages: [{ role: "user", content: "fixture-only" }],
    tools: [
      {
        type: "function",
        function: { name: "fixtureTool", parameters: { type: "object", properties: {} } },
      },
    ],
    stream: false,
  };
  try {
    for (const exact of [true, false]) {
      seed();
      fallback.clearAllModelLockouts();
      let calls = 0;
      CodexExecutor.prototype.execute = async (args) => ({
        response: Response.json(
          exact
            ? { detail: detail(args.model) }
            : { error: { code: "account_model_ineligible", message: "generic invalid body" } },
          { status: 400 }
        ),
        url: "https://fixture.invalid",
        headers: {},
        transformedBody: args.body,
      });
      const guard = createRoutingAttemptGuard({ body, limit: 2 });
      const dispatch = guard.wrap(async (b, m, target) => {
        calls++;
        if (calls > 1) return Response.json({ ok: true });
        return (await invokeFixtureCore(b, target.routingAttemptToken)).response;
      });
      const rejected = await dispatch(body, "codex/" + model, {
        kind: "model",
        provider: "codex",
        connectionId: "account-a",
      });
      assert.equal(rejected.status, 400);
      const next = await dispatch(body, "codex/" + other, {
        kind: "model",
        provider: "codex",
        connectionId: "account-b",
      });
      assert.equal(calls, exact ? 2 : 1);
      assert.equal(next.ok, exact);
    }
  } finally {
    CodexExecutor.prototype.execute = original;
  }
});

test("tools request fails over when upstream rejects the base of an effort-suffixed selection", async () => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
  const { createRoutingAttemptGuard } =
    await import("../../open-sse/services/combo/routingAttemptSafety.ts");
  const original = CodexExecutor.prototype.execute;
  const alias = model + "-high";
  const body = {
    model: alias,
    messages: [{ role: "user", content: "fixture-only" }],
    tools: [
      {
        type: "function",
        function: { name: "fixtureTool", parameters: { type: "object", properties: {} } },
      },
    ],
    stream: false,
  };
  seed();
  fallback.clearAllModelLockouts();
  let calls = 0;
  // Upstream names the base model, exactly as observed for effort-suffixed ids.
  CodexExecutor.prototype.execute = async (args) => ({
    response: Response.json({ detail: detail(model) }, { status: 400 }),
    url: "https://fixture.invalid",
    headers: {},
    transformedBody: args.body,
  });
  try {
    const guard = createRoutingAttemptGuard({ body, limit: 2 });
    const dispatch = guard.wrap(async (b, m, target) => {
      calls++;
      if (calls > 1) return Response.json({ ok: true });
      return (await invokeFixtureCore(b, target.routingAttemptToken, alias)).response;
    });
    const rejected = await dispatch(body, "codex/" + alias, {
      kind: "model",
      provider: "codex",
      connectionId: "account-a",
    });
    assert.equal(rejected.status, 400);
    const next = await dispatch(body, "codex/" + other, {
      kind: "model",
      provider: "codex",
      connectionId: "account-b",
    });
    assert.equal(calls, 2);
    assert.equal(next.ok, true);
    // The alias is still never stored as durable account evidence.
    assert.equal(store.getAccountModelNegative("codex", "account-a", alias), null);
  } finally {
    CodexExecutor.prototype.execute = original;
  }
});

test("negative TTL has exact boundary and rejects future, malformed and noncanonical observations", () => {
  const now = 1_800_000_000_000;
  const ttl = policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  const value = { capturedAt: now, observedAt: new Date(now).toISOString() };
  assert.equal(policy.hasFreshAccountNegativeTime(value, now + ttl - 1), true);
  assert.equal(policy.hasFreshAccountNegativeTime(value, now + ttl), false);
  for (const observedAt of [
    "invalid",
    new Date(now + 1).toISOString(),
    new Date(now - 1).toISOString(),
    "2027-01-15",
  ]) {
    assert.equal(policy.hasFreshAccountNegativeTime({ ...value, observedAt }, now), false);
  }
  for (const capturedAt of [undefined, null, NaN, Infinity, now + 1, now + 0.5, -1]) {
    assert.equal(policy.hasFreshAccountNegativeTime({ ...value, capturedAt }, now), false);
  }
  assert.equal(policy.hasFreshAccountNegativeTime(value, null), false);
});

test("evidence clock advances elapsed TTL under wall-clock rollback and refuses invalid clock readings", () => {
  let wall = 1_800_000_000_000;
  let mono = 100;
  const clock = policy.createAccountEvidenceClock(
    () => wall,
    () => mono
  );
  const start = clock()!;
  const value = { capturedAt: start, observedAt: new Date(start).toISOString() };
  wall -= 3600_000;
  mono += policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  assert.equal(clock(), start + policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS);
  assert.equal(policy.hasFreshAccountNegativeTime(value, clock()), false);
  mono -= 1;
  assert.equal(clock(), null);
  mono += 2;
  wall = NaN;
  assert.equal(clock(), null);
  wall = Infinity;
  assert.equal(clock(), null);
  wall = 1_800_000_000_000;
  mono = NaN;
  assert.equal(clock(), null);
});

test("evidence clock preserves forward expiry and cannot revive it after wall time moves back", () => {
  let wall = 1_800_000_000_000;
  let mono = 10;
  const clock = policy.createAccountEvidenceClock(
    () => wall,
    () => mono
  );
  const capturedAt = clock()!;
  const value = { capturedAt, observedAt: new Date(capturedAt).toISOString() };
  wall += policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  assert.equal(policy.hasFreshAccountNegativeTime(value, clock()), false);
  wall -= policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  mono += 1;
  assert.equal(policy.hasFreshAccountNegativeTime(value, clock()), false);
});

test("expired stored evidence drops only the negative veto and is not deleted or silently renewed", (context) => {
  let now = Date.now() + 3_600_000;
  context.mock.method(Date, "now", () => now);
  assert.equal(record(), true);
  const captured = store.getAccountModelNegative("codex", "account-a", model)!;
  const raw = core
    .getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace='accountModelEligibilityNegativeV1'")
    .get() as { value: string };
  now = captured.capturedAt + policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS - 100;
  assert.ok(store.getAccountModelNegative("codex", "account-a", model));
  now = captured.capturedAt + policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  assert.equal(store.getAccountModelNegative("codex", "account-a", model), null);
  assert.equal(fallback.isModelLocked("codex", "account-a", model), false);
  assert.equal(store.allScopedAccountsIneligible("codex", model, ["account-a"]), false);
  assert.deepEqual(store.listAccountModelNegatives(), []);
  assert.equal(
    (
      core
        .getDbInstance()
        .prepare("SELECT value FROM key_value WHERE namespace='accountModelEligibilityNegativeV1'")
        .get() as { value: string }
    ).value,
    raw.value
  );
  // Only a newly selected proof plus a new exact observed rejection may renew it.
  assert.equal(
    store.recordAccountModelNegative(captured, "codex", "account-a", model, 400, detail()),
    false
  );
  assert.equal(record(), true);
  assert.ok(store.getAccountModelNegative("codex", "account-a", model));
});

test("late in-flight rejection cannot reset the TTL or repopulate after reset", (context) => {
  let now = Date.now() + 8_000_000;
  context.mock.method(Date, "now", () => now);
  const old = proof()!;
  now = old.capturedAt + policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  assert.equal(
    store.recordAccountModelNegative(old, "codex", "account-a", model, 400, detail()),
    false
  );
  assert.equal(store.listAccountModelNegatives().length, 0);
  const current = proof()!;
  store.clearAccountModelNegatives("account-a", model);
  assert.equal(
    store.recordAccountModelNegative(current, "codex", "account-a", model, 400, detail()),
    false
  );
});

test("reordered concurrent observations preserve the newer selected proof and cannot extend an older deadline", (context) => {
  let now = Date.now() + 12_000_000;
  context.mock.method(Date, "now", () => now);
  const earlier = proof()!;
  now = earlier.capturedAt + 1000;
  const later = proof()!;
  assert.equal(
    store.recordAccountModelNegative(later, "codex", "account-a", model, 400, detail()),
    true
  );
  const expected = store.getAccountModelNegative("codex", "account-a", model)!;
  now = later.capturedAt + 1000;
  assert.equal(
    store.recordAccountModelNegative(earlier, "codex", "account-a", model, 400, detail()),
    false
  );
  assert.deepEqual(store.getAccountModelNegative("codex", "account-a", model), expected);
  now = later.capturedAt + policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  assert.equal(
    store.recordAccountModelNegative(later, "codex", "account-a", model, 400, detail()),
    false
  );
});

test("legacy and corrupted time fields never confer current negative eligibility", () => {
  assert.equal(record(), true);
  const db = core.getDbInstance();
  const row = db
    .prepare("SELECT key,value FROM key_value WHERE namespace='accountModelEligibilityNegativeV1'")
    .get() as { key: string; value: string };
  const initial = JSON.parse(row.value);
  for (const update of [
    { capturedAt: undefined },
    { capturedAt: null },
    { observedAt: "invalid" },
    { observedAt: new Date(initial.capturedAt + 86_400_000).toISOString() },
  ]) {
    db.prepare(
      "UPDATE key_value SET value=? WHERE namespace='accountModelEligibilityNegativeV1' AND key=?"
    ).run(JSON.stringify({ ...initial, ...update }), row.key);
    assert.equal(store.getAccountModelNegative("codex", "account-a", model), null);
  }
});

test("a delayed observation expires from selection time, not response-arrival time", (context) => {
  let now = Date.now() + 16_000_000;
  context.mock.method(Date, "now", () => now);
  const selected = proof()!;
  now = selected.capturedAt + policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS - 1000;
  assert.equal(
    store.recordAccountModelNegative(selected, "codex", "account-a", model, 400, detail()),
    true
  );
  const current = store.getAccountModelNegative("codex", "account-a", model)!;
  assert.equal(Date.parse(current.observedAt) > current.capturedAt, true);
  now = selected.capturedAt + policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  assert.equal(store.getAccountModelNegative("codex", "account-a", model), null);
});

test("throwing or out-of-range clocks refuse time authority without changing existing clock state", () => {
  let fail = true;
  let wall = 1_800_000_000_000;
  let mono = 10;
  const clock = policy.createAccountEvidenceClock(
    () => {
      if (fail) throw new Error("fixture clock");
      return wall;
    },
    () => mono
  );
  assert.equal(clock(), null);
  fail = false;
  assert.equal(clock(), wall);
  wall = 8640000000000001;
  assert.equal(clock(), null);
  wall = 1_800_000_000_000;
  mono = 11;
  assert.equal(clock(), wall + 1);
});

test("Codex lockout projections show effective remaining TTL and expire without requiring reset", (context) => {
  let now = Date.now() + 20_000_000;
  context.mock.method(Date, "now", () => now);
  assert.equal(record(), true);
  const negative = store.getAccountModelNegative("codex", "account-a", model)!;
  const until = negative.capturedAt + policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  const info = fallback.getModelLockoutInfo("codex", "account-a", model)!;
  assert.equal(info.requiresReset, false);
  assert.equal(info.until, until);
  assert.equal(info.lockedAt, negative.observedAt);
  assert.ok(info.remainingMs > 0 && info.remainingMs <= policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS);
  const listed = fallback.getAllModelLockouts().filter((entry) => entry.provider === "codex");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].requiresReset, false);
  assert.equal(listed[0].until, until);
  assert.ok(listed[0].remainingMs > 0 && listed[0].remainingMs <= info.remainingMs);
  now = negative.capturedAt - 1000;
  const rolledBack = fallback.getModelLockoutInfo("codex", "account-a", model)!;
  assert.ok(rolledBack.remainingMs <= info.remainingMs);
  now = until;
  assert.equal(fallback.getModelLockoutInfo("codex", "account-a", model), null);
  assert.equal(
    fallback.getAllModelLockouts().some((entry) => entry.provider === "codex"),
    false
  );
  assert.equal(store.getAccountModelNegativeTiming(negative), null);
});

test("expired Codex negative projection preserves an independent longer timed cooldown", (context) => {
  let now = Date.now() + 24_000_000;
  context.mock.method(Date, "now", () => now);
  assert.equal(record(), true);
  const negative = store.getAccountModelNegative("codex", "account-a", model)!;
  fallback.lockModel(
    "codex",
    "account-a",
    model,
    "not_found",
    policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS * 2
  );
  assert.equal(fallback.getAllModelLockouts().filter((entry) => entry.model === model).length, 1);
  now = negative.capturedAt + policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  const info = fallback.getModelLockoutInfo("codex", "account-a", model)!;
  assert.equal(info.reason, "not_found");
  assert.equal(info.requiresReset, undefined);
  assert.ok(info.remainingMs > 0);
  const listed = fallback.getAllModelLockouts().filter((entry) => entry.model === model);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].reason, "not_found");
  assert.ok(listed[0].until > now);
});

test("NVIDIA durable lockout projections retain their existing reset-required behavior", async (context) => {
  let now = Date.now() + 28_000_000;
  context.mock.method(Date, "now", () => now);
  const nvidia = await import("../../src/lib/db/nvidiaModelAvailability.ts");
  const db = core.getDbInstance();
  db.prepare(
    "INSERT INTO provider_connections(id,provider,auth_type,is_active,provider_specific_data,created_at,updated_at,proxy_enabled,per_key_proxy_enabled) VALUES(?,?,?,?,?,?,?,1,0)"
  ).run("nvidia-account", "nvidia", "apikey", 1, "{}", "created", "r1");
  db.prepare("INSERT INTO key_value(namespace,key,value) VALUES(?,?,?)").run(
    "syncedAvailableModels",
    "nvidia:nvidia-account",
    JSON.stringify([{ id: model }])
  );
  assert.equal(
    nvidia.recordNvidiaModelNegative(
      "nvidia-account",
      model,
      nvidia.nvidiaAvailabilityRevision("nvidia", "nvidia-account", model)
    ),
    true
  );
  now += policy.ACCOUNT_MODEL_NEGATIVE_TTL_MS * 2;
  const info = fallback.getModelLockoutInfo("nvidia", "nvidia-account", model)!;
  assert.equal(info.requiresReset, true);
  assert.equal(info.remainingMs, 0);
  const listed = fallback.getAllModelLockouts().filter((entry) => entry.provider === "nvidia");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].requiresReset, true);
  assert.equal(listed[0].remainingMs, 0);
  assert.equal(listed[0].until, 0);
});
