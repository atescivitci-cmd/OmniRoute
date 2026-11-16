/**
 * Connection-level cooldown after a credential-rejection 400: review fixes (echo resistance, credential
 * change clears, all-cooled auto pool, combo-owned attempts, retry-wait skip, log, quiet decay).
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

const harness = await createChatPipelineHarness("connection-credential-cooldown-fixes");
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

// ======================= fix round (review b3) =======================

const REAL_SHAPES = [
  "[400]: bad request: Authorization header is badly formatted",
  "bad request: Authorization header is badly formatted",
  "[400]: Authorization header is badly formatted",
  "Authorization header is badly formatted",
  "Invalid authorization header",
  "Malformed Authorization header: expected Bearer token",
];
const ECHO_SHAPES = [
  `Invalid value in messages[0].content: 'please ${BAD_TEXT}'`,
  `[400]: Invalid value ... please ${BAD_TEXT}`,
  `bad request: could not parse input "${BAD_TEXT}"`,
];

// ---- item 1: echo resistance ---------------------------------------------------------------

test("item1: real message shapes cool the connection", async () => {
  for (const text of REAL_SHAPES) {
    await resetStorage();
    const { bad } = await twoGithub();
    await reject(bad.id, "github", text);
    const after = await getConn(bad.id);
    assert.equal(after.lastErrorType, "credential_rejected", text);
    assert.ok(cooldownLeftMs(after) > 20_000, text);
  }
});

test("item1: an upstream 400 that echoes the phrase mid-message cools nothing", async () => {
  for (const text of ECHO_SHAPES) {
    await resetStorage();
    const { bad } = await twoGithub();
    await reject(bad.id, "github", text);
    const after = await getConn(bad.id);
    assert.notEqual(after.lastErrorType, "credential_rejected", text);
    assert.ok(!after.rateLimitedUntil, text);
  }
});

test("item1: a real-shaped message whose phrase is also in the request body is treated as an echo", async () => {
  const { bad } = await twoGithub();
  await auth.markAccountUnavailable(
    bad.id,
    400,
    "[400]: bad request: Authorization header is badly formatted",
    "github",
    "gpt-4o",
    null,
    {
      isCombo: false,
      requestBody: {
        messages: [
          { role: "user", content: `why does it say authorization  HEADER is badly formatted?` },
        ],
      },
    }
  );
  assert.ok(!(await getConn(bad.id)).rateLimitedUntil);
});

test("item1: a body without the phrase does not block the cooldown, and a huge body does not blow up", async () => {
  const { bad } = await twoGithub();
  const small = { messages: [{ role: "user", content: "hello" }] };
  await auth.markAccountUnavailable(
    bad.id,
    400,
    "bad request: " + BAD_TEXT,
    "github",
    "gpt-4o",
    null,
    {
      isCombo: false,
      requestBody: small,
    }
  );
  assert.ok(cooldownLeftMs(await getConn(bad.id)) > 20_000);

  await resetStorage();
  const { bad: bad2 } = await twoGithub();
  const huge = { messages: [{ role: "user", content: "x".repeat(40_000_000) }] };
  const t0 = Date.now();
  await auth.markAccountUnavailable(
    bad2.id,
    400,
    "bad request: " + BAD_TEXT,
    "github",
    "gpt-4o",
    null,
    {
      isCombo: false,
      requestBody: huge,
    }
  );
  assert.ok(Date.now() - t0 < 3_000, `scan must be bounded (took ${Date.now() - t0}ms)`);
  assert.ok(cooldownLeftMs(await getConn(bad2.id)) > 20_000);

  await resetStorage();
  const { bad: bad3 } = await twoGithub();
  const withPhrase = { messages: [{ role: "user", content: "y".repeat(2_000_000) + BAD_TEXT }] };
  await auth.markAccountUnavailable(
    bad3.id,
    400,
    "bad request: " + BAD_TEXT,
    "github",
    "gpt-4o",
    null,
    {
      isCombo: false,
      requestBody: withPhrase,
    }
  );
  assert.ok(!(await getConn(bad3.id)).rateLimitedUntil, "phrase within the scan budget is found");
});

test("item1 pipeline: a prompt that makes the upstream echo the phrase cannot cool the connection", async () => {
  await seedConnection("openai", { name: "oa-a", apiKey: "sk-echo-only" });
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  const { counts } = installFetch({
    "sk-echo-only": () =>
      json(400, {
        error: { message: `Invalid value in messages[0].content: 'please ${BAD_TEXT}'` },
      }),
  });
  for (let i = 0; i < 2; i++) {
    const res = await handleChat(
      buildRequest({
        body: {
          model: "openai/gpt-4.1-mini",
          stream: false,
          messages: [{ role: "user", content: `please ${BAD_TEXT}` }],
        },
      })
    );
    await res.text();
  }
  assert.equal(counts["sk-echo-only"], 2, "second request still reaches the upstream");
  const conn = (await providersDb.getProviderConnections({ provider: "openai" }))[0] as Conn;
  assert.notEqual(conn.lastErrorType, "credential_rejected");
  assert.ok(!conn.rateLimitedUntil);
});

// ---- item 2: credential change clears the cooldown ------------------------------------------

test("item2: changing the apiKey clears a credential cooldown; re-saving the same key does not", async () => {
  const { bad } = await twoGithub();
  await reject(bad.id);
  await providersDb.updateProviderConnection(bad.id, { apiKey: "ghp-bad", name: "gh-bad" });
  let c = await getConn(bad.id);
  assert.equal(c.lastErrorType, "credential_rejected", "same key re-saved keeps the cooldown");
  assert.ok(cooldownLeftMs(c) > 0);

  await providersDb.updateProviderConnection(bad.id, { apiKey: "ghp-new-key" });
  c = await getConn(bad.id);
  assert.ok(!c.rateLimitedUntil);
  assert.ok(!c.lastErrorType);
  assert.equal(c.testStatus, "active");
  assert.equal(Number(c.backoffLevel), 0);
  assert.equal((await auth.getProviderCredentials("github")).connectionId, bad.id);
});

test("item2: an OAuth re-auth upsert with new tokens clears; identical tokens do not", async () => {
  const first = (await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: "owner@example.test",
    accessToken: "at-1",
    refreshToken: "rt-1",
    isActive: true,
    testStatus: "active",
  })) as Conn;
  await auth.markAccountUnavailable(
    first.id,
    400,
    "bad request: " + BAD_TEXT,
    "claude",
    "m",
    null,
    {
      isCombo: false,
    }
  );
  assert.equal((await getConn(first.id)).lastErrorType, "credential_rejected");

  await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: "owner@example.test",
    accessToken: "at-1",
    refreshToken: "rt-1",
  });
  assert.equal((await getConn(first.id)).lastErrorType, "credential_rejected", "same tokens");

  await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: "owner@example.test",
    accessToken: "at-2",
    refreshToken: "rt-2",
  });
  const c = await getConn(first.id);
  assert.ok(!c.rateLimitedUntil);
  assert.ok(!c.lastErrorType);
  assert.equal(c.testStatus, "active");
  assert.equal(Number(c.backoffLevel), 0);
});

test("item2: other cooldown types and terminal statuses are untouched by a key change", async () => {
  const mk = async (name: string, extra: Record<string, unknown> = {}) =>
    (await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name,
      apiKey: `sk-${name}`,
      isActive: true,
      testStatus: "active",
      ...extra,
    })) as Conn;
  const cooled = await mk("oa-503");
  await auth.markAccountUnavailable(
    cooled.id,
    503,
    "Service Unavailable",
    "openai",
    "gpt-4o",
    null,
    {
      isCombo: false,
    }
  );
  const before = await getConn(cooled.id);
  await providersDb.updateProviderConnection(cooled.id, { apiKey: "sk-new-503" });
  const after = await getConn(cooled.id);
  assert.equal(after.rateLimitedUntil, before.rateLimitedUntil);
  assert.equal(after.testStatus, before.testStatus);
  assert.equal(after.lastErrorType, before.lastErrorType);

  for (const status of ["credits_exhausted", "banned", "expired"]) {
    const t = await mk(`oa-${status}`, {
      testStatus: status,
      lastErrorType: "credential_rejected",
      rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await providersDb.updateProviderConnection(t.id, { apiKey: `sk-changed-${status}` });
    const c = await getConn(t.id);
    assert.equal(c.testStatus, status, status);
    assert.ok(c.rateLimitedUntil, `${status} cooldown untouched`);
  }
});

// ---- item 3: every candidate credential-cooled ---------------------------------------------

test("item3: all auto candidates credential-cooled -> not hard-blocked; mixed -> cooled one blocked", async () => {
  const { resolveAutoStrategyOrder } =
    await import("../../open-sse/services/combo/resolveAutoStrategy.ts");
  const mkConn = async (name: string) =>
    (await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name,
      apiKey: `sk-${name}`,
      isActive: true,
      testStatus: "active",
    })) as Conn;
  const a = await mkConn("auto-a");
  const b = await mkConn("auto-b");
  const targets = [a, b].map((c, i) => ({
    kind: "model" as const,
    provider: "openai",
    providerId: "openai",
    modelStr: "openai/gpt-4o-mini",
    stepId: `st${i}`,
    executionKey: `st${i}`,
    connectionId: c.id,
    allowedConnectionIds: [c.id],
    weight: 1,
    label: null,
  }));
  const run = () =>
    resolveAutoStrategyOrder({
      orderedTargets: targets,
      body: { model: "t", messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "item3-auto",
        strategy: "auto",
        models: targets.map((t) => t.modelStr),
        config: {},
      },
      config: {},
      settings: null,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      resilienceSettings: { quotaPreflight: { enabled: false } } as never,
      buildAutoCandidates,
      isModelAvailable: async () => true,
      relayOptions: {},
    } as never) as Promise<{
      earlyResponse?: unknown;
      orderedTargets: Array<{ connectionId?: string | null }>;
    }>;

  await reject(a.id, "openai");
  const mixed = await run();
  assert.ok(!mixed.earlyResponse, "one healthy candidate keeps the combo routable");
  assert.equal(mixed.orderedTargets[0].connectionId, b.id, "cooled connection is not the lead");

  await reject(b.id, "openai");
  const all = await run();
  assert.ok(!all.earlyResponse, "all cooled: no misleading 429 quota-cutoff response");
  assert.ok(all.orderedTargets.length > 0);
});

// ---- item 4: combo-owned attempts never advance inside the connection loop ------------------

test("item4: shouldFallback is false for combo-owned attempts and true for direct ones", async () => {
  const { bad } = await twoGithub();
  const combo = await reject(bad.id, "github", "bad request: " + BAD_TEXT, true);
  assert.equal(combo.shouldFallback, false);
  await resetStorage();
  const { bad: bad2 } = await twoGithub();
  const direct = await reject(bad2.id, "github", "bad request: " + BAD_TEXT, false);
  assert.equal(direct.shouldFallback, true);
});

// ---- item 6: retry-wait skip needs EVERY cooling connection to be credential-cooled ----------

test("item6: credentialRejectedOnly is true only when all cooling connections are credential-cooled", async () => {
  const mk = async (name: string, prio: number) =>
    (await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name,
      apiKey: `sk-${name}`,
      isActive: true,
      testStatus: "active",
      priority: prio,
    })) as Conn;
  const a = await mk("m-a", 1);
  const b = await mk("m-b", 2);
  await reject(a.id, "openai");
  await auth.markAccountUnavailable(b.id, 503, "Service Unavailable", "openai", "gpt-4o", null, {
    isCombo: false,
  });
  const mixed = await auth.getProviderCredentials("openai");
  assert.equal(mixed.allRateLimited, true);
  assert.equal(mixed.credentialRejectedOnly, false, "mixed pair must keep the retry wait");

  await resetStorage();
  const c = await mk("m-c", 1);
  const d = await mk("m-d", 2);
  await reject(c.id, "openai");
  await reject(d.id, "openai");
  const only = await auth.getProviderCredentials("openai");
  assert.equal(only.credentialRejectedOnly, true);
});

// ---- item 7: visibility ---------------------------------------------------------------------

test("item7: the credential cooldown warning carries ids and numbers only", async () => {
  const { describeCredentialCooldown } =
    await import("../../open-sse/services/credentialRejectionCooldown.ts");
  const line = describeCredentialCooldown("github", "a1b2c3d4-0000-0000-0000", 2, 60_000);
  assert.match(line, /^credential cooldown github a1b2c3d4 level=2 cooldown=60s/);
  assert.ok(!line.includes("a1b2c3d4-0000"), "connection id is only a prefix");
});

// ---- item 5: decay after a long quiet period -------------------------------------------------

test("item5: the escalation level restarts after a long quiet period", async () => {
  const { bad } = await twoGithub();
  await reject(bad.id);
  await expire(bad.id);
  await reject(bad.id);
  assert.equal(Number((await getConn(bad.id)).backoffLevel), 2);
  // cooldown ended 25 minutes ago (> 2x the 10 minute cap) with no rejection since
  await providersDb.updateProviderConnection(bad.id, {
    rateLimitedUntil: new Date(Date.now() - 25 * 60_000).toISOString(),
  });
  await reject(bad.id);
  const c = await getConn(bad.id);
  assert.equal(Number(c.backoffLevel), 1);
  assert.ok(Math.abs(cooldownLeftMs(c) - BASE_MS) < 5_000);
});

test("pure schedule: cooldown and stored level are both bounded", async () => {
  const { credentialRejectionCooldown } =
    await import("../../open-sse/services/credentialRejectionCooldown.ts");
  assert.deepEqual(credentialRejectionCooldown(0), { cooldownMs: 30_000, newBackoffLevel: 1 });
  assert.deepEqual(credentialRejectionCooldown(4), { cooldownMs: 480_000, newBackoffLevel: 5 });
  assert.deepEqual(credentialRejectionCooldown(5), { cooldownMs: 600_000, newBackoffLevel: 5 });
  assert.deepEqual(credentialRejectionCooldown(500), { cooldownMs: 600_000, newBackoffLevel: 5 });
  assert.deepEqual(credentialRejectionCooldown(-3), { cooldownMs: 30_000, newBackoffLevel: 1 });
  assert.deepEqual(credentialRejectionCooldown(Number.NaN), {
    cooldownMs: 30_000,
    newBackoffLevel: 1,
  });
});

test("item1 pipeline: a real-shaped rejection is not remembered when the prompt contains the same phrase", async () => {
  await seedConnection("openai", { name: "oa-q", apiKey: "sk-quoted" });
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  installFetch({
    "sk-quoted": () => json(400, { error: { message: `bad request: ${BAD_TEXT}` } }),
  });
  const res = await handleChat(
    buildRequest({
      body: {
        model: "openai/gpt-4.1-mini",
        stream: false,
        messages: [{ role: "user", content: `what does "${BAD_TEXT}" mean?` }],
      },
    })
  );
  await res.text();
  const conn = (await providersDb.getProviderConnections({ provider: "openai" }))[0] as Conn;
  assert.ok(!conn.rateLimitedUntil, "phrase present in the request body: treated as an echo");
});
