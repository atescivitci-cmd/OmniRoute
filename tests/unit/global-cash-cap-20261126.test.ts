/**
 * Gateway-wide cash cap: one monthly cash total across every API key, with an optional
 * per-provider share, that only ever holds METERED accounts.
 *
 * Owner requirement (2026-11-26): $50 is the total for everything, not a per-key split; no single
 * paid provider should use more than 30% of it; subscription, free and local accounts cost no cash
 * and must keep working when the cap is reached.
 *
 * Rule under test (name-blind):
 * - The global budget is the budget with apiKeyId "__global__" (normal budget API). Its totals
 *   cover every key's cost entries.
 * - A metered connection is held when the period total >= limit, or when its provider's period
 *   spend >= limit x providerShareLimit. Connections whose cashClass is subscription, free or local
 *   are never held.
 * - If the cap cannot be read, metered connections are held (fail closed) and the status says so.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-global-cash-cap-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "global-cash-cap-secret";

const core = await import("../../src/lib/db/core.ts");
const costRules = await import("../../src/domain/costRules.ts");
const domainState = await import("../../src/lib/db/domainState.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { GLOBAL_BUDGET_ID } = await import("../../src/lib/usage/cashCost.ts");
const { setBudgetSchema } = await import("../../src/shared/validation/schemas.ts");

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

function globalCap(limit = 50, share: number | null = null) {
  costRules.setBudget(GLOBAL_BUDGET_ID, {
    monthlyLimitUsd: limit,
    resetInterval: "monthly",
    costBasis: "cash",
    providerShareLimit: share,
  });
}

// saveCostEntry(apiKeyId, list cost, timestamp, cash cost, provider)
function spend(key: string, provider: string | null, cash: number, list = cash) {
  domainState.saveCostEntry(key, list, Date.now(), cash, provider);
  costRules.invalidateCashCapCache();
}

// ── status and the formula ───────────────────────────────────────────────────

test("no global budget: nothing is ever capped", () => {
  spend("k1", "openai", 500);
  assert.equal(costRules.getCashCapStatus().active, false);
  assert.equal(costRules.isProviderCashCapped("openai"), false);
});

test("the total is summed across every key", () => {
  globalCap(50);
  spend("busola", "openai", 20);
  spend("pressed", "groq", 20);
  spend("terminal", "openai", 9);
  const s = costRules.getCashCapStatus();
  assert.equal(s.usedUsd, 49);
  assert.equal(s.capReached, false);
  assert.equal(costRules.isProviderCashCapped("openai"), false);
  spend("cammy", "mistral", 1);
  assert.equal(costRules.getCashCapStatus().capReached, true, "$50 reached across four keys");
  for (const p of ["openai", "groq", "mistral", "anything"]) {
    assert.equal(costRules.isProviderCashCapped(p), true, p);
  }
});

test("subscription and free usage (cash 0) never moves the total", () => {
  globalCap(50);
  spend("terminal", "claude", 0, 900); // $900 at list price, $0 cash
  spend("busola", "nvidia", 0, 40);
  const s = costRules.getCashCapStatus();
  assert.equal(s.usedUsd, 0);
  assert.equal(s.capReached, false);
});

test("share limit: one provider at 30% of $50 is held, others continue", () => {
  globalCap(50, 0.3);
  spend("k1", "openai", 15);
  spend("k2", "groq", 2);
  const s = costRules.getCashCapStatus();
  assert.equal(s.shareLimitUsd, 15);
  assert.equal(costRules.isProviderCashCapped("openai"), true, "openai used its $15 share");
  assert.equal(costRules.isProviderCashCapped("groq"), false);
  assert.equal(s.capReached, false);
});

test("no share limit set: a single provider may use the whole cap", () => {
  globalCap(50, null);
  spend("k1", "openai", 40);
  assert.equal(costRules.isProviderCashCapped("openai"), false);
});

test("pending (not yet flushed) spend counts, including its provider", () => {
  globalCap(10, 0.5);
  costRules.recordCost("k1", 6, 6, "openai");
  costRules.invalidateCashCapCache();
  const s = costRules.getCashCapStatus();
  assert.equal(s.usedUsd, 6);
  assert.equal(s.providerUsedUsd.openai, 6);
  assert.equal(costRules.isProviderCashCapped("openai"), true, "6 >= 50% of 10");
});

test("entries without a provider count in the total but in no provider share", () => {
  globalCap(50, 0.3);
  spend("k1", null, 30);
  const s = costRules.getCashCapStatus();
  assert.equal(s.usedUsd, 30);
  assert.deepEqual(s.providerUsedUsd, {});
  assert.equal(costRules.isProviderCashCapped("openai"), false);
});

test("the global budget summary and check use every key", () => {
  globalCap(50);
  spend("a", "openai", 12);
  spend("b", "openai", 13);
  assert.equal(costRules.checkBudget(GLOBAL_BUDGET_ID).periodUsed, 25);
  assert.equal(costRules.getCostSummary(GLOBAL_BUDGET_ID).cashCostMonth, 25);
});

test("a read failure holds metered providers and says so (fail closed)", () => {
  globalCap(50);
  core.getDbInstance().exec("DROP TABLE domain_cost_history");
  costRules.invalidateCashCapCache();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const s = costRules.getCashCapStatus();
    assert.equal(s.readError, true);
    assert.equal(costRules.isProviderCashCapped("openai"), true);
  } finally {
    console.warn = warn;
  }
});

test("status is cached briefly and refreshed after a budget change", () => {
  globalCap(50);
  const t = Date.now();
  assert.equal(costRules.getCashCapStatus(t).capReached, false);
  domainState.saveCostEntry("k", 60, t, 60, "openai"); // no explicit invalidation
  assert.equal(costRules.getCashCapStatus(t + 1000).capReached, false, "within cache window");
  assert.equal(costRules.getCashCapStatus(t + 6000).capReached, true, "after cache window");
  globalCap(100); // setBudget invalidates
  assert.equal(costRules.getCashCapStatus(t + 6100).capReached, false);
});

test("name-blind: the same numbers give the same verdict for any provider id", () => {
  globalCap(50, 0.3);
  const verdicts = ["openai", "zz-made-up", "anthropic"].map((p) => {
    costRules.resetCostData();
    globalCap(50, 0.3);
    spend("k", p, 15);
    return costRules.isProviderCashCapped(p);
  });
  assert.deepEqual(verdicts, [true, true, true]);
});

// ── settings ─────────────────────────────────────────────────────────────────

test("share limit: kept when a save omits it, cleared by null, ignored outside (0, 1)", () => {
  globalCap(50, 0.3);
  costRules.setBudget(GLOBAL_BUDGET_ID, { monthlyLimitUsd: 60, resetInterval: "monthly" });
  assert.equal(costRules.getBudget(GLOBAL_BUDGET_ID)?.providerShareLimit, 0.3);
  assert.equal(costRules.getBudget(GLOBAL_BUDGET_ID)?.costBasis, "cash");
  assert.equal(domainState.loadBudget(GLOBAL_BUDGET_ID)?.providerShareLimit, 0.3, "persisted");
  costRules.setBudget(GLOBAL_BUDGET_ID, { monthlyLimitUsd: 60, providerShareLimit: null });
  assert.equal(costRules.getBudget(GLOBAL_BUDGET_ID)?.providerShareLimit, null);
  costRules.setBudget(GLOBAL_BUDGET_ID, { monthlyLimitUsd: 60, providerShareLimit: 1 });
  assert.equal(costRules.getBudget(GLOBAL_BUDGET_ID)?.providerShareLimit, null, "1 = no limit");
});

test("budget schema accepts a share between 0 and 1 or null", () => {
  for (const v of [0, 0.3, 1, null]) {
    assert.equal(
      setBudgetSchema.safeParse({ apiKeyId: GLOBAL_BUDGET_ID, providerShareLimit: v }).success,
      true,
      String(v)
    );
  }
  for (const v of [-0.1, 1.5, "lots"]) {
    assert.equal(
      setBudgetSchema.safeParse({ apiKeyId: GLOBAL_BUDGET_ID, providerShareLimit: v }).success,
      false,
      String(v)
    );
  }
});

test("migration 142 adds the provider and share-limit columns", () => {
  const db = core.getDbInstance();
  const cols = (t: string) =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols("domain_cost_history").includes("provider"));
  assert.ok(cols("domain_budgets").includes("provider_share_limit"));
});

// ── production account selection ─────────────────────────────────────────────

async function connection(provider: string, cashClass: string | null, name: string) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `sk-${name}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: cashClass ? { cashClass } : {},
  });
}

async function pick(provider: string) {
  const r = (await auth.getProviderCredentials(provider, null, null, null)) as {
    connectionId?: string;
  } | null;
  return r?.connectionId ?? null;
}

test("selection: under the cap a metered account is used normally", async () => {
  globalCap(50);
  const paid = await connection("glm", "metered", "gcc-paid-under");
  spend("k", "glm", 10);
  assert.equal(await pick("glm"), paid.id);
});

test("selection: at the cap the metered account is skipped for the subscription one", async () => {
  globalCap(50);
  const paid = await connection("glm", "metered", "gcc-paid");
  const sub = await connection("glm", "subscription", "gcc-sub");
  spend("k", "openai", 50);
  const chosen = new Set<string | null>();
  for (let i = 0; i < 4; i++) chosen.add(await pick("glm"));
  assert.ok(chosen.has(sub.id), "the subscription account keeps serving");
  assert.ok(!chosen.has(paid.id), "the metered account is held");
});

test("selection: an account with no cash class counts as metered and is held at the cap", async () => {
  globalCap(50);
  await connection("glm", null, "gcc-unset");
  spend("k", "openai", 55);
  assert.equal(await pick("glm"), null);
});

test("selection: a free account is never held, even far past the cap", async () => {
  globalCap(50, 0.3);
  const free = await connection("glm", "free", "gcc-free");
  spend("k", "glm", 500);
  assert.equal(await pick("glm"), free.id);
});

test("selection: the share limit holds only the provider that used its share", async () => {
  globalCap(50, 0.3);
  await connection("glm", "metered", "gcc-glm-paid");
  const other = await connection("deepseek", "metered", "gcc-ds-paid");
  spend("k", "glm", 15);
  assert.equal(await pick("glm"), null, "glm used its $15 share");
  assert.equal(await pick("deepseek"), other.id, "deepseek still under its share and the total");
});
