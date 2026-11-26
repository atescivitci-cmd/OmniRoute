/**
 * A malformed 200 is billed by the provider. Since the recording fix (2026-11-26) its tokens live
 * only on the failure row (success = 0, error_code malformed_translated_response), so every reader
 * that counts spend or consumed tokens on "success = 1" rows must also count that row.
 * Readers: per-key USD limits (apiKeyUsageLimits.ts), connection spend since added
 * (usageStats.ts), Antigravity local usage units (antigravity.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-billed-rows-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getConnectionSpendUsdSinceAdded } = await import("../../src/lib/usage/usageStats.ts");
const { getApiKeyUsageLimitStatus } = await import("../../src/lib/usage/apiKeyUsageLimits.ts");
const { BILLED_USAGE_ROW_SQL } = await import("../../src/shared/constants/usageSource.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function insert(o: { ok: boolean; code?: string | null; key: string; conn: string }) {
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO usage_history (provider, model, connection_id, api_key_id, tokens_input,
         tokens_output, status, success, latency_ms, ttft_ms, error_code, timestamp)
       VALUES ('openai', 'gpt-4o', ?, ?, 100000, 20000, ?, ?, 900, 100, ?, ?)`
    )
    .run(
      o.conn,
      o.key,
      o.ok ? "200" : "502",
      o.ok ? 1 : 0,
      o.code ?? null,
      new Date().toISOString()
    );
}

test("connection spend counts the billed tokens of a malformed 200, not other failures", async () => {
  insert({ ok: true, key: "k1", conn: "c1" });
  const one = (await getConnectionSpendUsdSinceAdded("openai", "c1")).costUsd;
  assert.ok(one > 0, "pricing must be known for the assertion to mean anything");
  insert({ ok: false, code: "malformed_translated_response", key: "k1", conn: "c1" });
  insert({ ok: false, code: "upstream_502", key: "k1", conn: "c1" }); // zero-token failure kind
  const after = (await getConnectionSpendUsdSinceAdded("openai", "c1")).costUsd;
  assert.ok(Math.abs(after - 2 * one) < 1e-9, `${after} vs ${2 * one}`);
});

test("per-key USD limits count the billed tokens of a malformed 200", async () => {
  insert({ ok: true, key: "k2", conn: "c2" });
  const deps = {
    getProviderConnections: async () => [],
    getProviderConnectionById: async () => null,
    getProviderLimitsCache: () => null,
    getAllProviderLimitsCache: () => ({}),
  };
  const meta = { id: "k2", usageLimitEnabled: true, dailyUsageLimitUsd: 1000 } as never;
  const one = (await getApiKeyUsageLimitStatus(meta, deps)).dailySpentUsd;
  assert.ok(one > 0);
  insert({ ok: false, code: "malformed_translated_response", key: "k2", conn: "c2" });
  const after = (await getApiKeyUsageLimitStatus(meta, deps)).dailySpentUsd;
  assert.ok(Math.abs(after - 2 * one) < 0.0001, `${after} vs ${2 * one}`);
});

test("all three readers use the shared billed-row predicate instead of success = 1", () => {
  assert.equal(
    BILLED_USAGE_ROW_SQL,
    "(success = 1 OR error_code IN ('malformed_translated_response', 'post_processing_error'))"
  );
  for (const file of [
    "src/lib/usage/apiKeyUsageLimits.ts",
    "src/lib/usage/usageStats.ts",
    "open-sse/services/usage/antigravity.ts",
  ]) {
    const src = fs.readFileSync(path.join(import.meta.dirname, "../..", file), "utf8");
    assert.ok(src.includes("BILLED_USAGE_ROW_SQL"), file);
    assert.ok(!/AND success = 1/.test(src), `${file} still filters success = 1`);
  }
});

test("a post_processing_error row (gateway threw after a billed 200) counts for spend", async () => {
  insert({ ok: true, key: "k3", conn: "c3" });
  const one = (await getConnectionSpendUsdSinceAdded("openai", "c3")).costUsd;
  insert({ ok: false, code: "post_processing_error", key: "k3", conn: "c3" });
  const after = (await getConnectionSpendUsdSinceAdded("openai", "c3")).costUsd;
  assert.ok(Math.abs(after - 2 * one) < 1e-9, `${after} vs ${2 * one}`);
});

test("connection spend: billed failure rows add tokens and cost, not requests", async () => {
  insert({ ok: true, key: "k4", conn: "c4" });
  insert({ ok: true, key: "k4", conn: "c4" });
  insert({ ok: false, code: "malformed_translated_response", key: "k4", conn: "c4" });
  insert({ ok: false, code: "upstream_502", key: "k4", conn: "c4" });
  const spend = await getConnectionSpendUsdSinceAdded("openai", "c4");
  assert.equal(spend.requests, 2, "requests count successful rows, as before");
});
