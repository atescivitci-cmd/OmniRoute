/**
 * Cash-basis budgets: count money actually spent, not list-price estimates.
 *
 * Live (2026-11-26): every request is priced at list rates in domain_cost_history, including
 * requests served by subscription accounts (already paid for), free tiers and local models. In 7
 * days the Claude terminals alone sent ~66M input tokens through a subscription account, so a
 * $30 weekly budget on their key would block them at once although no money was spent.
 *
 * Rule under test (name-blind): each provider connection carries operator data
 * `providerSpecificData.cashClass` (subscription | free | local | metered). Cash cost is the list
 * estimate for metered connections and 0 otherwise; a connection without a valid class is metered,
 * so missing data can only over-count. A budget with costBasis "cash" sums cash cost; "list"
 * (default) behaves exactly as before. Rows written before cash cost existed count at list price.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cash-basis-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const costRules = await import("../../src/domain/costRules.ts");
const domainState = await import("../../src/lib/db/domainState.ts");
const cash = await import("../../src/lib/usage/cashCost.ts");
const { SpendBatchWriter } = await import("../../src/lib/spend/batchWriter.ts");
const { recordStreamingCost } = await import("../../open-sse/handlers/chatCore/streamingCost.ts");
const { updateProviderConnectionSchema, setBudgetSchema } =
  await import("../../src/shared/validation/schemas.ts");

async function resetStorage() {
  costRules.resetCostData();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  costRules.resetCostData();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ── cash class resolution ────────────────────────────────────────────────────

test("resolveCashClass reads only the operator field; anything else is metered", () => {
  for (const c of ["subscription", "free", "local", "metered"] as const) {
    assert.equal(cash.resolveCashClass({ cashClass: c }), c);
  }
  for (const data of [
    undefined,
    null,
    "subscription",
    {},
    { cashClass: "SUBSCRIPTION" },
    { cashClass: "paid" },
    { cashClass: 0 },
    { cashClass: null },
    { tags: ["free"] }, // a free-looking tag is not the cash class
    { routingEntitlements: [{ charge: "free" }] },
  ]) {
    assert.equal(cash.resolveCashClass(data), "metered", JSON.stringify(data));
  }
});

test("cashCostFor: metered pays the estimate, every other class pays nothing", () => {
  assert.equal(cash.cashCostFor(1.25, "metered"), 1.25);
  for (const c of ["subscription", "free", "local"] as const) {
    assert.equal(cash.cashCostFor(1.25, c), 0);
  }
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(cash.cashCostFor(bad, "metered"), 0);
  }
});

test("entryAmount: cash basis falls back to list price when cash cost is unknown", () => {
  assert.equal(cash.entryAmount({ cost: 3, cashCost: 0 }, "cash"), 0);
  assert.equal(cash.entryAmount({ cost: 3, cashCost: 1 }, "cash"), 1);
  assert.equal(cash.entryAmount({ cost: 3, cashCost: null }, "cash"), 3);
  assert.equal(cash.entryAmount({ cost: 3 }, "cash"), 3);
  assert.equal(cash.entryAmount({ cost: 3, cashCost: 0 }, "list"), 3);
});

// ── batch writer ─────────────────────────────────────────────────────────────

test("batch writer keeps cash cost within [0, list cost] and totals by basis", () => {
  const writer = new SpendBatchWriter({ flushIntervalMs: 3_600_000, maxBufferSize: 1000 });
  writer.increment("k", 2, 1000, 0); // subscription
  writer.increment("k", 3, 1001, 3); // metered
  writer.increment("k", 4, 1002); // unknown (legacy caller)
  writer.increment("k", 5, 1003, 99); // clamped down to 5
  writer.increment("k", 6, 1004, -1); // invalid: unknown, counts at list price (never $0)
  assert.equal(writer.getPendingCostTotal("k"), 20);
  assert.equal(writer.getPendingCostTotal("k", 0, Number.POSITIVE_INFINITY, "list"), 20);
  assert.equal(
    writer.getPendingCostTotal("k", 0, Number.POSITIVE_INFINITY, "cash"),
    0 + 3 + 4 + 5 + 6
  );
  const entries = writer.getBufferedEntries("k");
  assert.equal(entries[2].cashCost, undefined);
});

// ── migration ────────────────────────────────────────────────────────────────

test("migration 141 adds cash_cost and cost_basis", () => {
  const db = core.getDbInstance();
  const cols = (t: string) =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols("domain_cost_history").includes("cash_cost"));
  assert.ok(cols("domain_budgets").includes("cost_basis"));
});

// ── budgets end to end (storage + rules) ─────────────────────────────────────

test("cash budget ignores subscription spend that would block a list budget", () => {
  costRules.setBudget("terminal", {
    monthlyLimitUsd: 50,
    resetInterval: "monthly",
    costBasis: "cash",
  });
  costRules.setBudget("terminal-list", { monthlyLimitUsd: 50, resetInterval: "monthly" });

  for (const key of ["terminal", "terminal-list"]) {
    domainState.saveCostEntry(key, 400, Date.now(), 0); // subscription: big list price, no cash
    domainState.saveCostEntry(key, 12, Date.now(), 12); // metered
  }

  const cashCheck = costRules.checkBudget("terminal");
  assert.equal(cashCheck.allowed, true);
  assert.equal(cashCheck.periodUsed, 12);

  const listCheck = costRules.checkBudget("terminal-list");
  assert.equal(listCheck.allowed, false, "list basis is unchanged: it still counts list price");
  assert.equal(listCheck.periodUsed, 412);
});

test("cash budget blocks once metered spend passes the limit", () => {
  costRules.setBudget("busola", {
    monthlyLimitUsd: 10,
    resetInterval: "monthly",
    costBasis: "cash",
  });
  domainState.saveCostEntry("busola", 6, Date.now(), 6);
  assert.equal(costRules.checkBudget("busola").allowed, true);
  costRules.recordCost("busola", 5, 5); // pending (not yet flushed) entries count too
  const check = costRules.checkBudget("busola");
  assert.equal(check.allowed, false);
  assert.equal(check.periodUsed, 11);
  costRules.recordCost("busola", 100, 0); // subscription request adds nothing
  assert.equal(costRules.checkBudget("busola").periodUsed, 11);
});

test("rows written before cash cost existed count at list price under the cash basis", () => {
  costRules.setBudget("legacy", {
    monthlyLimitUsd: 50,
    resetInterval: "monthly",
    costBasis: "cash",
  });
  const db = core.getDbInstance();
  db.prepare("INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES (?, ?, ?)").run(
    "legacy",
    7,
    Date.now()
  );
  domainState.saveCostEntry("legacy", 3, Date.now(), 0);
  assert.equal(costRules.checkBudget("legacy").periodUsed, 7);
});

test("a save that omits the cost basis keeps it; an explicit one changes it", () => {
  costRules.setBudget("keep", { monthlyLimitUsd: 50, resetInterval: "monthly", costBasis: "cash" });
  costRules.setBudget("keep", { monthlyLimitUsd: 60, resetInterval: "monthly" });
  assert.equal(costRules.getBudget("keep")?.costBasis, "cash");
  assert.equal(costRules.getBudget("keep")?.monthlyLimitUsd, 60);
  // persisted: read back from the database, not the in-memory cache
  assert.equal(domainState.loadBudget("keep")?.costBasis, "cash");
  assert.equal(domainState.loadAllBudgets().keep?.costBasis, "cash");
  costRules.setBudget("keep", { monthlyLimitUsd: 60, resetInterval: "monthly", costBasis: "list" });
  assert.equal(costRules.getBudget("keep")?.costBasis, "list");
});

test("cost summary reports cash totals and uses the basis for the period total", () => {
  costRules.setBudget("sum", { monthlyLimitUsd: 50, resetInterval: "monthly", costBasis: "cash" });
  domainState.saveCostEntry("sum", 20, Date.now(), 0);
  domainState.saveCostEntry("sum", 2, Date.now(), 2);
  const summary = costRules.getCostSummary("sum");
  assert.equal(summary.costBasis, "cash");
  assert.equal(summary.totalCostToday, 22, "list totals unchanged");
  assert.equal(summary.cashCostToday, 2);
  assert.equal(summary.cashCostMonth, 2);
  assert.equal(summary.totalCostPeriod, 2, "period total follows the budget basis");
  assert.equal(summary.cashCostPeriod, 2);
});

test("name-blind: the same data gives the same cash cost for every provider", () => {
  const results = ["claude", "nvidia", "openai", "made-up-provider"].map((provider) =>
    cash.cashCostFor(5, cash.resolveCashClass({ cashClass: "subscription", provider }))
  );
  assert.deepEqual(results, [0, 0, 0, 0]);
  const unset = ["claude", "nvidia", "ollama-local"].map((provider) =>
    cash.cashCostFor(5, cash.resolveCashClass({ provider }))
  );
  assert.deepEqual(unset, [5, 5, 5], "no class set means metered, whatever the name");
});

// ── streaming path ───────────────────────────────────────────────────────────

async function streamed(cashClass?: "subscription" | "metered") {
  const recorded: Array<{ cost: number; cashCost?: number }> = [];
  recordStreamingCost({
    apiKeyId: "k",
    provider: "p",
    model: "m",
    streamUsage: { prompt_tokens: 1 },
    ...(cashClass ? { cashClass } : {}),
    calculateCost: async () => 0.5,
    recordCost: (_id, cost, cashCost) => recorded.push({ cost, cashCost }),
  });
  await new Promise((r) => setTimeout(r, 10));
  return recorded;
}

test("streaming cost records the cash cost from the connection class", async () => {
  assert.deepEqual(await streamed("subscription"), [{ cost: 0.5, cashCost: 0 }]);
  assert.deepEqual(await streamed("metered"), [{ cost: 0.5, cashCost: 0.5 }]);
  assert.deepEqual(await streamed(), [{ cost: 0.5, cashCost: 0.5 }], "omitted = metered");
});

// ── API validation ───────────────────────────────────────────────────────────

test("connection update accepts a valid cashClass or null and rejects anything else", () => {
  for (const cashClass of ["subscription", "free", "local", "metered", null]) {
    const r = updateProviderConnectionSchema.safeParse({ providerSpecificData: { cashClass } });
    assert.equal(r.success, true, String(cashClass));
  }
  for (const cashClass of ["paid", "Subscription", 1, true]) {
    const r = updateProviderConnectionSchema.safeParse({ providerSpecificData: { cashClass } });
    assert.equal(r.success, false, String(cashClass));
  }
});

test("budget schema accepts costBasis list or cash and rejects others", () => {
  assert.equal(setBudgetSchema.safeParse({ apiKeyId: "k", costBasis: "cash" }).success, true);
  assert.equal(setBudgetSchema.safeParse({ apiKeyId: "k", costBasis: "list" }).success, true);
  assert.equal(setBudgetSchema.safeParse({ apiKeyId: "k" }).success, true);
  assert.equal(setBudgetSchema.safeParse({ apiKeyId: "k", costBasis: "free" }).success, false);
});

// ── review fixes ─────────────────────────────────────────────────────────────

test("upgrade: migration 141 restores a missing column on an existing database", async () => {
  const { runMigrations } = await import("../../src/lib/db/migrationRunner.ts");
  const db = core.getDbInstance();
  costRules.setBudget("up", { monthlyLimitUsd: 5, resetInterval: "monthly", costBasis: "cash" });
  db.exec("ALTER TABLE domain_cost_history DROP COLUMN cash_cost");
  db.prepare("DELETE FROM _omniroute_migrations WHERE version = '141'").run();
  runMigrations(db as never);
  const cols = (
    db.prepare("PRAGMA table_info(domain_cost_history)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
  assert.ok(cols.includes("cash_cost"));
  assert.equal(domainState.loadBudget("up")?.costBasis, "cash", "existing basis untouched");
  const applied = db
    .prepare("SELECT COUNT(*) AS n FROM _omniroute_migrations WHERE version = '141'")
    .get() as { n: number };
  assert.equal(applied.n, 1);
});

test("setBudget without a basis writes no reset log and keeps the stored basis", () => {
  costRules.setBudget("nolog", { dailyLimitUsd: 5, costBasis: "cash" });
  const db = core.getDbInstance();
  const before = (
    db.prepare("SELECT COUNT(*) AS n FROM domain_budget_reset_logs").get() as { n: number }
  ).n;
  costRules.setBudget("nolog", { dailyLimitUsd: 6 });
  const after = (
    db.prepare("SELECT COUNT(*) AS n FROM domain_budget_reset_logs").get() as { n: number }
  ).n;
  assert.equal(after, before);
  assert.equal(costRules.getBudget("nolog")?.costBasis, "cash");
});

test("GitHub Copilot refresh keeps the rest of the connection data (cashClass)", async () => {
  const { GithubExecutor } = await import("../../open-sse/executors/github.ts");
  const ex = new GithubExecutor() as unknown as {
    refreshCopilotToken: (t: string) => Promise<unknown>;
    refreshGitHubToken: (t: string) => Promise<unknown>;
    refreshCredentials: (c: unknown) => Promise<{ providerSpecificData?: Record<string, unknown> }>;
  };
  const creds = {
    accessToken: "a",
    refreshToken: "r",
    providerSpecificData: { cashClass: "subscription", copilotToken: "old", other: 1 },
  };
  ex.refreshCopilotToken = async () => ({ token: "new", expiresAt: 9 });
  const direct = await ex.refreshCredentials(creds);
  assert.deepEqual(direct.providerSpecificData, {
    cashClass: "subscription",
    copilotToken: "new",
    copilotTokenExpiresAt: 9,
    other: 1,
  });

  let calls = 0;
  ex.refreshCopilotToken = async () => (calls++ === 0 ? null : { token: "n2", expiresAt: 10 });
  ex.refreshGitHubToken = async () => ({ accessToken: "a2", refreshToken: "r2" });
  const viaGithub = await ex.refreshCredentials(creds);
  assert.equal(viaGithub.providerSpecificData?.cashClass, "subscription");
  assert.equal(viaGithub.providerSpecificData?.copilotToken, "n2");
});

test("combined GitHub + Copilot token refresh keeps the connection cashClass", async () => {
  const tokenRefresh = await import("../../src/sse/services/tokenRefresh.ts");
  const { OAUTH_ENDPOINTS } = await import("../../open-sse/config/constants.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) =>
    new Response(
      JSON.stringify(
        String(url) === OAUTH_ENDPOINTS.github.token
          ? { access_token: "ga", refresh_token: "gr", expires_in: 60 }
          : { token: "ct", expires_at: 77 }
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  try {
    const out = (await tokenRefresh.refreshGitHubAndCopilotTokens({
      refreshToken: "x",
      providerSpecificData: { cashClass: "subscription" },
    })) as { providerSpecificData?: Record<string, unknown> };
    assert.deepEqual(out.providerSpecificData, {
      cashClass: "subscription",
      copilotToken: "ct",
      copilotTokenExpiresAt: 77,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("no-auth synthetic credentials carry the first valid cashClass", async () => {
  const { mergeNoAuthProviderSpecificData } = await import("../../src/sse/services/auth.ts");
  const hydrated: Record<string, unknown> = {};
  mergeNoAuthProviderSpecificData(hydrated, { providerSpecificData: { cashClass: "bogus" } });
  assert.equal(hydrated.cashClass, undefined);
  mergeNoAuthProviderSpecificData(hydrated, { providerSpecificData: { cashClass: "free" } });
  mergeNoAuthProviderSpecificData(hydrated, { providerSpecificData: { cashClass: "metered" } });
  assert.equal(hydrated.cashClass, "free");
});

test("recordConnectionCost uses the serving connection's class", async () => {
  const { recordConnectionCost } =
    await import("../../open-sse/handlers/chatCore/streamingCost.ts");
  const seen: Array<[number, number | undefined]> = [];
  const rec = (_k: string, cost: number, cashCost?: number) => void seen.push([cost, cashCost]);
  recordConnectionCost(rec, "k", 2, { providerSpecificData: { cashClass: "local" } });
  recordConnectionCost(rec, "k", 2, { providerSpecificData: {} });
  recordConnectionCost(rec, "k", 2, null);
  assert.deepEqual(seen, [
    [2, 0],
    [2, 2],
    [2, 2],
  ]);
});
