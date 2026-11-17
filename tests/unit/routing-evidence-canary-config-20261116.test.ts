/**
 * Routing evidence canary: settings schema, config resolution, cost estimate and the fixed-prompt
 * option of the shared test-body builder. No DB, network or timers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-canary-config-"));

const { resolveRoutingCanaryConfig, estimateProbeCost } =
  await import("../../src/lib/services/routingEvidenceCanary.ts");
const { buildComboTestRequestBody } = await import("../../src/lib/combos/testHealth.ts");
const schemas = await import("../../src/shared/validation/settingsSchemas.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

test.after(() => {
  resetDbInstance();
});

const settingsSchema = schemas.updateSettingsSchema ?? schemas.settingsSchema;

test("defaults are off and conservative", () => {
  const cfg = resolveRoutingCanaryConfig({});
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.connections, {});
  assert.equal(cfg.includeLocal, false);
  assert.equal(cfg.dailyBudgetUsd, 0.5);
  assert.equal(cfg.targetSamples, 10);
  assert.equal(cfg.minSpacingMinutes, 30);
  assert.equal(cfg.bucket, "small");
});

test("values are clamped and junk is ignored", () => {
  const cfg = resolveRoutingCanaryConfig({
    routingCanary: {
      enabled: "yes", // only literal true enables
      connections: { a: true, b: false, c: "true" },
      combos: ["x", "", 5],
      dailyBudgetUsd: 9999,
      targetSamples: 1,
      minSpacingMinutes: 1,
      maxProbesPerTick: 500,
      bucket: "huge",
    },
  });
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.connections, { a: true });
  assert.deepEqual(cfg.combos, ["x"]);
  assert.equal(cfg.dailyBudgetUsd, 50);
  assert.equal(cfg.targetSamples, 10);
  assert.equal(cfg.minSpacingMinutes, 5);
  assert.equal(cfg.maxProbesPerTick, 20);
  assert.equal(cfg.bucket, "small");
});

test("cost: zero price is free, unknown price is metered with a conservative default", () => {
  assert.deepEqual(estimateProbeCost({ input: 0, output: 0 }, "small"), { usd: 0, free: true });
  const unknown = estimateProbeCost(null, "small");
  assert.equal(unknown.free, false);
  assert.ok(unknown.usd > 0);
  const half = estimateProbeCost({ input: 0, output: 5 }, "small");
  assert.equal(half.free, false, "only a price of exactly zero both ways is free");
  const medium = estimateProbeCost({ input: 2, output: 10 }, "medium");
  const small = estimateProbeCost({ input: 2, output: 10 }, "small");
  assert.ok(medium.usd > small.usd * 8);
});

test("settings schema accepts a valid block and rejects out-of-range values", () => {
  assert.ok(settingsSchema, "settings schema export not found");
  const ok = settingsSchema.safeParse({
    routingCanary: {
      enabled: true,
      connections: { abc: true },
      combos: ["one"],
      dailyBudgetUsd: 0.25,
      targetSamples: 10,
      minSpacingMinutes: 30,
      maxProbesPerTick: 6,
      bucket: "medium",
    },
  });
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  for (const bad of [
    { dailyBudgetUsd: -1 },
    { dailyBudgetUsd: 51 },
    { targetSamples: 9 },
    { minSpacingMinutes: 4 },
    { maxProbesPerTick: 21 },
    { bucket: "large" },
  ]) {
    const res = settingsSchema.safeParse({ routingCanary: bad });
    assert.equal(res.success, false, JSON.stringify(bad));
  }
});

test("test-body builder: explicit prompt is used verbatim, default stays randomized", () => {
  const fixed = buildComboTestRequestBody("p/m", false, {
    stream: true,
    maxTokens: 64,
    prompt: "FIXED",
  });
  assert.equal(fixed.messages[0].content, "FIXED");
  assert.equal(fixed.max_tokens, 64);
  assert.equal(fixed.stream, true);
  const a = buildComboTestRequestBody("p/m");
  assert.notEqual(a.messages[0].content, "FIXED");
  assert.ok(typeof a.messages[0].content === "string" && a.messages[0].content.length > 0);
});
