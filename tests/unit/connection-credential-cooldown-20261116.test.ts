/**
 * Connection-level cooldown after a credential-rejection 400.
 *
 * Measured 2026-11-16: two leftover test connections answered every request with HTTP 400
 * "Authorization header is badly formatted". The router advanced past them inside one request
 * but remembered nothing, so every later request paid for the dead connections again.
 *
 * Contract under test: an upstream 400 whose text matches isCredentialRejectionText cools THAT
 * connection (rateLimitedUntil in the future, exponential backoff, hard cap) through the existing
 * markAccountUnavailable path. It is never terminal, never a provider circuit-breaker failure,
 * and recovers lazily on expiry / clearAccountError / a passing test. Nothing else changes.
 *
 * The harness pins DATA_DIR to a throwaway temp dir; ~/.omniroute is never opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHeaders } from "../../open-sse/utils/headers.ts";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("connection-credential-cooldown");
const {
  BaseExecutor,
  buildOpenAIResponse,
  buildRequest,
  combosDb,
  core,
  handleChat,
  resetStorage,
} = harness;
const { seedConnection, settingsDb } = harness;
assert.equal(process.env.DATA_DIR, harness.TEST_DATA_DIR, "DATA_DIR must be the harness temp dir");

const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { classifyProviderError } = await import("../../open-sse/services/errorClassifier.ts");
const { getConnectionStatusQuotaCutoffReason } =
  await import("../../open-sse/services/combo/comboPredicates.ts");
const { filterResilienceBlockedCandidates } =
  await import("../../open-sse/services/autoCombo/resilienceCandidateFilter.ts");
const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
const { getCircuitBreaker } = await import("../../src/shared/utils/circuitBreaker.ts");
const { selectRecoverableConnections } = await import("../../src/lib/quota/connectionRecovery.ts");

const BAD_TEXT = "Authorization header is badly formatted";
const BASE_MS = 30_000;
const CAP_MS = 600_000;
const EXPECTED_SCHEDULE_MS = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000];

type Conn = Record<string, unknown> & {
  id: string;
  rateLimitedUntil?: string | null;
  backoffLevel?: number;
  testStatus?: string;
  lastErrorType?: string | null;
  lastError?: string | null;
  errorCode?: number | null;
  isActive?: boolean;
};

async function getConn(id: string): Promise<Conn> {
  return (await providersDb.getProviderConnectionById(id)) as Conn;
}

function cooldownLeftMs(conn: Conn): number {
  return conn.rateLimitedUntil ? new Date(conn.rateLimitedUntil).getTime() - Date.now() : 0;
}

/** Expire the cooldown exactly like the passage of time does: the instant moves into the past. */
async function expire(id: string) {
  await providersDb.updateProviderConnection(id, {
    rateLimitedUntil: new Date(Date.now() - 1000).toISOString(),
  });
}

function reject(id: string, provider = "github", text = BAD_TEXT, isCombo = false) {
  return auth.markAccountUnavailable(id, 400, text, provider, "gpt-4o", null, { isCombo });
}

async function twoGithub() {
  const bad = (await providersDb.createProviderConnection({
    provider: "github",
    authType: "apikey",
    name: "gh-bad",
    apiKey: "ghp-bad",
    isActive: true,
    testStatus: "active",
    priority: 1,
  })) as Conn;
  const good = (await providersDb.createProviderConnection({
    provider: "github",
    authType: "apikey",
    name: "gh-good",
    apiKey: "ghp-good",
    isActive: true,
    testStatus: "active",
    priority: 2,
  })) as Conn;
  return { bad, good };
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
});
test.afterEach(() => {
  BaseExecutor.RETRY_CONFIG.delayMs = harness.originalRetryDelayMs;
});
test.after(async () => {
  await harness.cleanup();
});

// ---- classification -------------------------------------------------------------------------

test("classifyProviderError never labels a connection credential_rejected (only the cooldown branch writes it)", () => {
  for (const status of [400, 401, 403, 429, 500]) {
    assert.notEqual(
      classifyProviderError(status, BAD_TEXT, "github"),
      "credential_rejected",
      String(status)
    );
  }
});

// ---- cooldown recorded ----------------------------------------------------------------------

test("a credential-rejection 400 cools that connection with the base backoff, not terminal", async () => {
  const { bad } = await twoGithub();
  const result = await reject(bad.id);
  const after = await getConn(bad.id);

  assert.ok(
    cooldownLeftMs(after) > BASE_MS - 5_000 && cooldownLeftMs(after) <= BASE_MS + 1_000,
    `cooldown ~${BASE_MS}ms, got ${cooldownLeftMs(after)}`
  );
  assert.equal(after.testStatus, "unavailable");
  assert.equal(after.lastErrorType, "credential_rejected");
  assert.equal(Number(after.errorCode), 400);
  assert.equal(Number(after.backoffLevel), 1);
  assert.equal(after.isActive, true, "never deactivated");
  assert.ok(!["banned", "expired", "credits_exhausted"].includes(String(after.testStatus)));
  assert.ok(after.lastError && /badly formatted/i.test(after.lastError));
  assert.equal(typeof result.shouldFallback, "boolean");
});

test("the next selection skips the cooled connection and serves the sibling of the same provider", async () => {
  const { bad, good } = await twoGithub();
  const before = await auth.getProviderCredentials("github");
  assert.equal(before.connectionId, bad.id, "precondition: the bad connection is preferred");

  await reject(bad.id);
  for (let i = 0; i < 5; i++) {
    const picked = await auth.getProviderCredentials("github");
    assert.equal(picked.connectionId, good.id, `selection ${i} must use the sibling`);
  }
  const goodAfter = await getConn(good.id);
  assert.equal(goodAfter.testStatus, "active", "the sibling is untouched");
  assert.ok(!goodAfter.rateLimitedUntil);
  assert.equal(
    getCircuitBreaker("github").getStatus().state,
    "CLOSED",
    "no provider breaker failure"
  );
});

test("expiry makes the connection selectable again and keeps its backoff memory", async () => {
  const { bad } = await twoGithub();
  await reject(bad.id);
  assert.notEqual((await auth.getProviderCredentials("github")).connectionId, bad.id);

  await expire(bad.id);
  const picked = await auth.getProviderCredentials("github");
  assert.equal(
    picked.connectionId,
    bad.id,
    "lazy recovery: selectable once the cooldown has passed"
  );
  const after = await getConn(bad.id);
  assert.equal(Number(after.backoffLevel), 1, "selection must not wipe the escalation level");
  assert.equal(after.lastErrorType, "credential_rejected");
});

test("repeated rejections double the cooldown up to the hard cap", async () => {
  const { bad } = await twoGithub();
  const seen: number[] = [];
  for (let i = 0; i < EXPECTED_SCHEDULE_MS.length; i++) {
    if (i > 0) {
      await expire(bad.id);
      await auth.getProviderCredentials("github"); // the real selection path runs between failures
    }
    await reject(bad.id);
    const c = await getConn(bad.id);
    seen.push(Math.round(cooldownLeftMs(c) / 1000) * 1000);
  }
  assert.deepEqual(seen, EXPECTED_SCHEDULE_MS);
  assert.ok(Math.max(...seen) <= CAP_MS);
});

test("the first success clears the cooldown state and the next failure starts again at the base", async () => {
  const { bad } = await twoGithub();
  await reject(bad.id);
  await expire(bad.id);
  await reject(bad.id);
  assert.equal(Number((await getConn(bad.id)).backoffLevel), 2);

  await expire(bad.id);
  const creds = await auth.getProviderCredentials("github");
  assert.equal(creds.connectionId, bad.id);
  await auth.clearAccountError(bad.id, creds);
  const cleared = await getConn(bad.id);
  assert.equal(cleared.testStatus, "active");
  assert.equal(Number(cleared.backoffLevel), 0);
  assert.ok(!cleared.lastError);
  assert.ok(!cleared.lastErrorType);
  assert.ok(!cleared.rateLimitedUntil);
  assert.ok(!cleared.errorCode);

  await reject(bad.id);
  assert.ok(Math.abs(cooldownLeftMs(await getConn(bad.id)) - BASE_MS) < 5_000);
});

test("a passing manual test clears the cooldown (same update the test route applies)", async () => {
  const { bad } = await twoGithub();
  await reject(bad.id);
  await providersDb.updateProviderConnection(bad.id, {
    testStatus: "active",
    lastError: null,
    lastErrorAt: null,
    lastErrorType: null,
    lastErrorSource: null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  });
  const picked = await auth.getProviderCredentials("github");
  assert.equal(picked.connectionId, bad.id);
});

test("a passing background probe clears it through clearConnectionErrorIfUnchanged", async () => {
  const { bad } = await twoGithub();
  await reject(bad.id);
  const snap = await getConn(bad.id);
  const cleared = await providersDb.clearConnectionErrorIfUnchanged(bad.id, {
    testStatus: snap.testStatus,
    lastErrorAt: (snap as Conn & { lastErrorAt?: string }).lastErrorAt,
    rateLimitedUntil: snap.rateLimitedUntil,
  });
  assert.equal(cleared, true);
  const after = await getConn(bad.id);
  assert.equal(after.testStatus, "active");
  assert.equal(Number(after.backoffLevel), 0);
  assert.ok(!after.rateLimitedUntil);
});

test("the proactive recovery tick does not wipe the escalation memory of a credential cooldown", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const rows = [
    {
      id: "a",
      testStatus: "unavailable",
      rateLimitedUntil: past,
      lastErrorType: "credential_rejected",
    },
    { id: "b", testStatus: "unavailable", rateLimitedUntil: past, lastErrorType: "rate_limited" },
    { id: "c", testStatus: "unavailable", rateLimitedUntil: past },
  ];
  assert.deepEqual(
    selectRecoverableConnections(rows, Date.now()).map((r) => r.id),
    ["b", "c"]
  );
});

// ---- nothing else changes -------------------------------------------------------------------

test("ordinary 400s and model/context errors cool nothing", async () => {
  for (const text of [
    "Invalid request: messages field required",
    "The model gpt-9 is not supported",
    "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens",
    "invalid authorization code",
    "bad request",
  ]) {
    await resetStorage();
    const { bad } = await twoGithub();
    await reject(bad.id, "github", text);
    const after = await getConn(bad.id);
    assert.notEqual(after.lastErrorType, "credential_rejected", text);
    assert.ok(!after.rateLimitedUntil, `no cooldown for: ${text}`);
    assert.equal(after.testStatus, "active", text);
  }
});

test("the credential text on 401 / 403 / 429 / 5xx does not take the credential-cooldown path", async () => {
  for (const status of [401, 403, 429, 500, 502, 503]) {
    await resetStorage();
    const { bad } = await twoGithub();
    await auth.markAccountUnavailable(bad.id, status, BAD_TEXT, "github", "gpt-4o", null, {
      isCombo: false,
    });
    const after = await getConn(bad.id);
    assert.notEqual(after.lastErrorType, "credential_rejected", String(status));
  }
});

test("unchanged cooldown behaviour for plain 503 and 401", async () => {
  await resetStorage();
  const mk = async (name: string) =>
    (await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name,
      apiKey: `sk-${name}`,
      isActive: true,
      testStatus: "active",
    })) as Conn;
  const a = await mk("oa-a");
  const b = await mk("oa-b");
  await auth.markAccountUnavailable(a.id, 503, "Service Unavailable", "openai", "gpt-4o", null, {
    isCombo: false,
  });
  const c503 = await getConn(a.id);
  assert.ok(cooldownLeftMs(c503) > 0, "503 still cools the connection");
  assert.notEqual(c503.lastErrorType, "credential_rejected");

  await auth.markAccountUnavailable(b.id, 401, "Unauthorized", "openai", "gpt-4o", null, {
    isCombo: false,
  });
  assert.equal((await getConn(b.id)).testStatus, "expired", "401 stays terminal-expired");
});

test("a terminal connection is never overwritten by a credential cooldown", async () => {
  for (const status of ["banned", "expired", "credits_exhausted"]) {
    await resetStorage();
    const conn = (await providersDb.createProviderConnection({
      provider: "github",
      authType: "apikey",
      apiKey: "ghp-term",
      isActive: true,
      testStatus: status,
    })) as Conn;
    await reject(conn.id);
    const after = await getConn(conn.id);
    assert.equal(after.testStatus, status);
    assert.ok(!after.rateLimitedUntil);
  }
});

test("disableCooling opts a connection out of the cooldown but records the error", async () => {
  const conn = (await providersDb.createProviderConnection({
    provider: "github",
    authType: "apikey",
    apiKey: "ghp-nocool",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { disableCooling: true },
  })) as Conn;
  await reject(conn.id);
  const after = await getConn(conn.id);
  assert.ok(!after.rateLimitedUntil);
  assert.notEqual(after.testStatus, "unavailable");
  assert.equal(Number(after.errorCode), 400);
});

test("concurrent failures on one connection do not double-increment or extend the cooldown", async () => {
  const { bad } = await twoGithub();
  await Promise.all([1, 2, 3, 4, 5].map(() => reject(bad.id)));
  const after = await getConn(bad.id);
  assert.equal(Number(after.backoffLevel), 1);
  assert.ok(Math.abs(cooldownLeftMs(after) - BASE_MS) < 5_000, `got ${cooldownLeftMs(after)}`);
});

test("a single-connection provider reports all-cooling with the credential marker, not a retry wait", async () => {
  const conn = (await providersDb.createProviderConnection({
    provider: "github",
    authType: "apikey",
    apiKey: "ghp-only",
    isActive: true,
    testStatus: "active",
  })) as Conn;
  await reject(conn.id);
  const picked = await auth.getProviderCredentials("github");
  assert.equal(picked.allRateLimited, true);
  assert.equal(picked.credentialRejectedOnly, true);
});

// ---- candidate filters ----------------------------------------------------------------------

test("getConnectionStatusQuotaCutoffReason flags a live credential cooldown and releases it on expiry", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(
    getConnectionStatusQuotaCutoffReason({
      testStatus: "unavailable",
      rateLimitedUntil: future,
      lastErrorType: "credential_rejected",
    }),
    "credential_rejected"
  );
  assert.equal(
    getConnectionStatusQuotaCutoffReason({
      testStatus: "unavailable",
      rateLimitedUntil: future,
      lastErrorType: "rate_limited",
    }),
    "rate_limited",
    "ordinary cooldowns keep their reason"
  );
  assert.equal(
    getConnectionStatusQuotaCutoffReason({
      testStatus: "unavailable",
      rateLimitedUntil: past,
      lastErrorType: "credential_rejected",
    }),
    undefined,
    "expired cooldown is eligible again"
  );
});

test("virtual auto/* pool: filterResilienceBlockedCandidates drops a cooled connection and keeps the sibling", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const pool = [
    { provider: "github", model: "gpt-4o", connectionId: "bad" },
    { provider: "github", model: "gpt-4o", connectionId: "good" },
  ];
  const out = filterResilienceBlockedCandidates(
    pool,
    new Map([
      ["bad", { id: "bad", rateLimitedUntil: future, testStatus: "unavailable" }],
      ["good", { id: "good", testStatus: "active" }],
    ])
  );
  assert.deepEqual(
    out.map((c) => c.connectionId),
    ["good"]
  );
});

test("stored auto combo (cammy-route): buildAutoCandidates hard-blocks a credential-cooled connection even with quota preflight off", async () => {
  const { bad, good } = await twoGithub();
  await reject(bad.id);
  const rateLimited = (await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "gh-429",
    apiKey: "ghp-429",
    isActive: true,
    testStatus: "active",
    priority: 3,
  })) as Conn;
  await auth.markAccountUnavailable(
    rateLimited.id,
    503,
    "Service Unavailable",
    "openai",
    "gpt-4o",
    null,
    {
      isCombo: false,
    }
  );

  const target = (c: Conn, i: number) => ({
    kind: "model" as const,
    provider: c === rateLimited ? "openai" : "github",
    providerId: c === rateLimited ? "openai" : "github",
    modelStr: c === rateLimited ? "openai/gpt-4o" : "github/gpt-4o",
    stepId: `s${i}`,
    executionKey: `s${i}`,
    connectionId: c.id,
    allowedConnectionIds: [c.id],
  });
  const candidates = await buildAutoCandidates(
    [target(bad, 0), target(good, 1), target(rateLimited, 2)] as never,
    "cammy-route-test",
    null,
    undefined,
    { quotaPreflight: { enabled: false } } as never
  );
  const by = new Map(candidates.map((c) => [c.connectionId, c]));
  assert.equal(
    by.get(bad.id)?.quotaCutoffBlocked,
    true,
    "credential-cooled connection is excluded"
  );
  assert.equal(by.get(bad.id)?.quotaCutoffReason, "credential_rejected");
  assert.notEqual(by.get(good.id)?.quotaCutoffBlocked, true, "sibling stays routable");
  assert.notEqual(
    by.get(rateLimited.id)?.quotaCutoffBlocked,
    true,
    "other cooldowns keep the soft penalty only"
  );
  assert.equal(by.get(rateLimited.id)?.statusPenalty, true);
});

// ---- real pipeline --------------------------------------------------------------------------

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function installFetch(handlers: Record<string, () => Response>) {
  const counts: Record<string, number> = {};
  const bodies: Record<string, unknown[]> = {};
  globalThis.fetch = (async (_url: unknown, init: { headers?: unknown; body?: unknown } = {}) => {
    const h = normalizeHeaders(init.headers as Parameters<typeof normalizeHeaders>[0]);
    const key = Object.keys(handlers).find(
      (k) => h["x-api-key"] === k || h.authorization === `Bearer ${k}`
    );
    if (!key) throw new Error(`unexpected upstream call ${JSON.stringify(h)}`);
    counts[key] = (counts[key] ?? 0) + 1;
    (bodies[key] ??= []).push(typeof init.body === "string" ? JSON.parse(init.body) : null);
    return handlers[key]();
  }) as typeof fetch;
  return { counts, bodies };
}

const badKeyResponse = () => json(400, { error: { message: BAD_TEXT } });

test("pipeline (combo, two providers): request 1 hits the bad connection first, advances and succeeds; request 2 never attempts it", async () => {
  await seedConnection("claude", { apiKey: "sk-bad-claude" });
  await seedConnection("openai", { apiKey: "sk-good-openai" });
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  await combosDb.createCombo({
    name: "cred-cooldown-combo",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["claude/claude-3-5-sonnet-20241022", "openai/gpt-4.1-mini"],
  });
  const { counts } = installFetch({
    "sk-bad-claude": badKeyResponse,
    "sk-good-openai": () => buildOpenAIResponse("served by B"),
  });
  const ask = async () => {
    const res = await handleChat(
      buildRequest({
        body: {
          model: "cred-cooldown-combo",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        },
      })
    );
    return { res, text: await res.text() };
  };

  const r1 = await ask();
  assert.equal(r1.res.status, 200, r1.text.slice(0, 200));
  assert.match(r1.text, /served by B/);
  assert.equal(counts["sk-bad-claude"], 1, "request 1 tried the bad connection once");
  assert.equal(counts["sk-good-openai"], 1);

  const claudeConn = (await providersDb.getProviderConnections({ provider: "claude" }))[0] as Conn;
  assert.equal(claudeConn.lastErrorType, "credential_rejected");
  assert.ok(cooldownLeftMs(claudeConn) > 20_000, "the bad connection is cooling");

  const r2 = await ask();
  assert.equal(r2.res.status, 200, r2.text.slice(0, 200));
  assert.match(r2.text, /served by B/);
  assert.equal(counts["sk-bad-claude"], 1, "request 2 must NOT attempt the cooled connection");
  assert.equal(counts["sk-good-openai"], 2);

  const r3 = await ask();
  assert.equal(r3.res.status, 200);
  assert.equal(counts["sk-bad-claude"], 1);
  assert.equal(counts["sk-good-openai"], 3);
});

test("pipeline (combo, same provider, pinned connections): only the failing connection is skipped", async () => {
  const bad = (await seedConnection("openai", {
    name: "oa-bad",
    apiKey: "sk-oa-bad",
    priority: 1,
  })) as Conn;
  const good = (await seedConnection("openai", {
    name: "oa-good",
    apiKey: "sk-oa-good",
    priority: 2,
  })) as Conn;
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  await combosDb.createCombo({
    name: "cred-cooldown-pinned",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: [
      {
        kind: "model",
        providerId: "openai",
        model: "gpt-4.1-mini",
        connectionId: bad.id,
        id: "s1",
      },
      {
        kind: "model",
        providerId: "openai",
        model: "gpt-4.1-mini",
        connectionId: good.id,
        id: "s2",
      },
    ],
  });
  const { counts } = installFetch({
    "sk-oa-bad": badKeyResponse,
    "sk-oa-good": () => buildOpenAIResponse("served by good"),
  });
  const ask = async () => {
    const res = await handleChat(
      buildRequest({
        body: {
          model: "cred-cooldown-pinned",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        },
      })
    );
    return { res, text: await res.text() };
  };
  const r1 = await ask();
  assert.equal(r1.res.status, 200, r1.text.slice(0, 200));
  assert.equal(counts["sk-oa-bad"], 1);
  assert.equal((await getConn(bad.id)).lastErrorType, "credential_rejected");
  assert.ok(cooldownLeftMs(await getConn(bad.id)) > 20_000, "only the failing connection cools");
  const r2 = await ask();
  assert.equal(r2.res.status, 200, r2.text.slice(0, 200));
  assert.match(r2.text, /served by good/);
  assert.equal(counts["sk-oa-bad"], 1, "bad connection skipped on request 2");
  assert.equal(counts["sk-oa-good"], 2, "sibling keeps serving");
  assert.equal(getCircuitBreaker("openai").getStatus().state, "CLOSED");
  assert.equal((await getConn(good.id)).testStatus, "active");
});

test("pipeline (direct, no combo): the sibling connection serves request 1 and later requests skip the dead one", async () => {
  await seedConnection("openai", { name: "oa-bad", apiKey: "sk-d-bad", priority: 1 });
  await seedConnection("openai", { name: "oa-good", apiKey: "sk-d-good", priority: 2 });
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  const { counts } = installFetch({
    "sk-d-bad": badKeyResponse,
    "sk-d-good": () => buildOpenAIResponse("served by good"),
  });
  const ask = async () => {
    const res = await handleChat(
      buildRequest({
        body: {
          model: "openai/gpt-4.1-mini",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        },
      })
    );
    return { res, text: await res.text() };
  };
  const r1 = await ask();
  assert.equal(r1.res.status, 200, r1.text.slice(0, 200));
  assert.equal(counts["sk-d-bad"], 1);
  const r2 = await ask();
  assert.equal(r2.res.status, 200, r2.text.slice(0, 200));
  assert.equal(counts["sk-d-bad"], 1, "dead connection not retried within its cooldown");
  assert.equal(counts["sk-d-good"], 2);
});

test("pipeline (direct): a lone dead connection answers 400 immediately and never waits out its cooldown", async () => {
  await seedConnection("openai", { name: "oa-bad", apiKey: "sk-lone-bad" });
  await settingsDb.updateSettings({
    requestRetry: 3,
    maxRetryIntervalSec: 90,
  });
  const { counts } = installFetch({ "sk-lone-bad": badKeyResponse });
  const ask = async () => {
    const t0 = Date.now();
    const res = await handleChat(
      buildRequest({
        body: {
          model: "openai/gpt-4.1-mini",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        },
      })
    );
    return { res, text: await res.text(), ms: Date.now() - t0 };
  };
  const r1 = await ask();
  assert.equal(r1.res.status, 400, r1.text.slice(0, 200));
  assert.ok(r1.ms < 5_000, `must not wait for the cooldown (took ${r1.ms}ms)`);
  const r2 = await ask();
  assert.equal(r2.res.status, 400, r2.text.slice(0, 200));
  assert.ok(r2.ms < 5_000, `must not wait for the cooldown (took ${r2.ms}ms)`);
  assert.equal(counts["sk-lone-bad"], 1, "second request is answered locally during the cooldown");
});

test("pipeline: user text echoing the phrase, with an ordinary upstream 400, cools nothing", async () => {
  await seedConnection("claude", { apiKey: "sk-echo-a" });
  await seedConnection("openai", { apiKey: "sk-echo-b" });
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  await combosDb.createCombo({
    name: "cred-cooldown-echo",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["claude/claude-3-5-sonnet-20241022", "openai/gpt-4.1-mini"],
  });
  const { counts } = installFetch({
    "sk-echo-a": () => json(400, { error: { message: "messages: field required" } }),
    "sk-echo-b": () => buildOpenAIResponse("served by B"),
  });
  const res = await handleChat(
    buildRequest({
      body: {
        model: "cred-cooldown-echo",
        stream: false,
        messages: [{ role: "user", content: `the error said: ${BAD_TEXT}` }],
      },
    })
  );
  await res.text();
  assert.equal(counts["sk-echo-a"], 1);
  const conns = (await providersDb.getProviderConnections({ provider: "claude" })) as Conn[];
  assert.notEqual(conns[0].lastErrorType, "credential_rejected");
  assert.ok(!conns[0].rateLimitedUntil, "an ordinary 400 never cools the connection");
  void core;
});
