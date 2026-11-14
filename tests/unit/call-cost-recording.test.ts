// Per-call and per-model cost recording on call_logs. The recorded figure is a pricing-table
// estimate (or a provider-reported figure when the provider sends one), not a billed amount:
// subscription-backed traffic still gets a notional list price, labelled by cost_source.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-cost-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "call-cost-test-secret";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const callCost = await import("../../src/lib/usage/callCost.ts");
const schema = await import("../../src/lib/db/schemaColumns.ts");

const rowFor = (id: string) =>
  core.getDbInstance().prepare("SELECT * FROM call_logs WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;

async function save(id: string, provider: string, model: string, tokens: object, status = 200) {
  await callLogs.saveCallLog({
    id,
    status,
    model,
    provider,
    tokens,
    duration: 10,
    apiKeyId: null,
    apiKeyName: null,
  });
}

test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await localDb.updatePricing({
    claude: {
      "claude-opus-4-8": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 },
    },
  });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("resolveCallCost labels where the number came from", async () => {
  const priced = async () => 0.25;
  const free = async () => 0;
  const broken = async () => {
    throw new Error("pricing unavailable");
  };
  assert.deepEqual(
    await callCost.resolveCallCost(
      "claude",
      "m",
      { input: 10, output: 5 },
      { calculateCost: priced }
    ),
    { costUsd: 0.25, costSource: "pricing_table" }
  );
  assert.deepEqual(
    await callCost.resolveCallCost(
      "ollama-local",
      "m",
      { input: 10, output: 5 },
      { calculateCost: free }
    ),
    { costUsd: 0, costSource: "unpriced" }
  );
  assert.deepEqual(
    await callCost.resolveCallCost("claude", "m", { input: 10 }, { calculateCost: broken }),
    { costUsd: null, costSource: "unpriced" }
  );
  assert.deepEqual(await callCost.resolveCallCost("claude", "m", {}, { calculateCost: priced }), {
    costUsd: null,
    costSource: "no_usage",
  });
  assert.deepEqual(await callCost.resolveCallCost("claude", "m", null, { calculateCost: priced }), {
    costUsd: null,
    costSource: "no_usage",
  });
  const reported = await callCost.resolveCallCost(
    "xai",
    "m",
    { input: 10, output: 5, cost_in_usd_ticks: 5_000_000 },
    { calculateCost: async () => 0.0005 }
  );
  assert.equal(reported.costSource, "provider_reported");
  assert.equal(reported.costUsd, 0.0005);
});

test("the schema ensure step adds the columns to a database that lacks them", () => {
  const db = core.getDbInstance();
  db.exec("ALTER TABLE call_logs DROP COLUMN cost_usd");
  db.exec("ALTER TABLE call_logs DROP COLUMN cost_source");
  assert.equal(schema.hasColumn(db, "call_logs", "cost_usd"), false);
  schema.ensureCallLogsColumns(db);
  assert.equal(schema.hasColumn(db, "call_logs", "cost_usd"), true);
  assert.equal(schema.hasColumn(db, "call_logs", "cost_source"), true);
  schema.ensureCallLogsColumns(db); // idempotent
});

test("a successful call is stored with its cost and source", async () => {
  await save("cost-ok-1", "claude", "claude-opus-4-8", { input: 1_000_000, output: 0 });
  const row = rowFor("cost-ok-1");
  assert.equal(row.cost_source, "pricing_table");
  assert.ok(Math.abs(Number(row.cost_usd) - 1) < 1e-9, String(row.cost_usd));
});

test("a call with no usage is stored with no cost and a no_usage source", async () => {
  await save("cost-none-1", "claude", "claude-opus-4-8", {}, 500);
  const row = rowFor("cost-none-1");
  assert.equal(row.cost_usd, null);
  assert.equal(row.cost_source, "no_usage");
});

test("a model with no pricing is recorded as zero and unpriced, never silently missing", async () => {
  await save("cost-free-1", "ollama-local", "qwen3", { input: 500, output: 500 });
  const row = rowFor("cost-free-1");
  assert.equal(Number(row.cost_usd), 0);
  assert.equal(row.cost_source, "unpriced");
});

test("per-model rollup groups recorded calls by provider and model", async () => {
  await save("roll-1", "claude", "claude-opus-4-8", { input: 1_000_000, output: 0 });
  await save("roll-2", "claude", "claude-opus-4-8", { input: 2_000_000, output: 0 });
  await save("roll-3", "ollama-local", "qwen3", { input: 10, output: 10 });
  await save("roll-4", "claude", "claude-opus-4-8", {}, 500);
  const rows = callCost.getCostByModel(core.getDbInstance(), "1970-01-01T00:00:00.000Z");
  const opus = rows.find((r: { provider: string; model: string }) => r.provider === "claude");
  assert.ok(opus);
  assert.equal(opus.calls, 3);
  assert.equal(opus.costedCalls, 2);
  assert.ok(Math.abs(opus.costUsd - 3) < 1e-9, String(opus.costUsd));
  const local = rows.find((r: { provider: string }) => r.provider === "ollama-local");
  assert.ok(local);
  assert.equal(local.costUsd, 0);
});
