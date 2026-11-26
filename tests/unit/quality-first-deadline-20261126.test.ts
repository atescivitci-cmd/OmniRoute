/**
 * ROUTING_QUALITY_FIRST and the deadline-aware reorder (Busola: deadlineAwareRouting). The reorder
 * ranks on 7-day call history, so it is skipped for a request ranked on quality and kept for a
 * request that fell back to the blended ranking (no measured candidate).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-first-deadline-"));
process.env.DATA_DIR = dir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
globalThis.fetch = async () => {
  throw new Error("network forbidden in this fixture");
};

const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
const { resolveAutoStrategyOrder } =
  await import("../../open-sse/services/combo/resolveAutoStrategy.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { setUserFitnessOverride } = await import("../../open-sse/services/autoCombo/taskFitness.ts");
const db = getDbInstance();

test.after(() => {
  delete process.env.ROUTING_QUALITY_FIRST;
  resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

const POOL = ["synq/m1", "synq/m2"];
async function decide() {
  const requestId = randomUUID();
  const targets = POOL.map((modelStr, i) => ({
    kind: "model" as const,
    provider: "synq",
    providerId: "synq",
    modelStr,
    stepId: `s${i}`,
    executionKey: `s${i}`,
    connectionId: null,
    weight: 1,
    label: null,
  }));
  const result = await resolveAutoStrategyOrder({
    orderedTargets: targets,
    body: {
      stream: false,
      max_tokens: 800,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "Plan a day in Lisbon." }],
    },
    combo: {
      name: "deadline-fixture",
      strategy: "auto",
      models: POOL,
      config: {
        selectionPolicy: "fit-first-free",
        zeroAdditionalCostProviders: ["synq"],
        deadlineAwareRouting: true,
        comboTimeoutMs: 65000,
      },
    },
    config: {},
    settings: null,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    buildAutoCandidates,
    isModelAvailable: async () => true,
    relayOptions: { routingRequestId: requestId },
  });
  assert.ok("orderedTargets" in result);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const row = db
    .prepare("SELECT factors_json FROM routing_decisions WHERE request_id=?")
    .get(requestId) as { factors_json: string };
  return JSON.parse(row.factors_json);
}

test("flag off: the deadline-aware reorder runs (trace recorded)", async () => {
  delete process.env.ROUTING_QUALITY_FIRST;
  assert.ok((await decide()).deadlineRankTrace);
});

test("quality-first, no measured candidate: blended fallback keeps the deadline reorder", async () => {
  process.env.ROUTING_QUALITY_FIRST = "1";
  const f = await decide();
  assert.equal(f.winner.qualityFallback, "no_measured_candidates");
  assert.ok(f.deadlineRankTrace);
});

test("quality-first, measured: the deadline reorder is skipped", async () => {
  process.env.ROUTING_QUALITY_FIRST = "1";
  for (const [model, score] of [
    ["synq/m1", 0.9],
    ["synq/m2", 0.8],
  ] as const) {
    for (const category of ["default", "planning"]) setUserFitnessOverride(model, category, score);
  }
  const f = await decide();
  assert.equal(f.winner.rankingPolicy, "quality_first");
  assert.equal(f.deadlineRankTrace, undefined);
  assert.equal(f.rankingPolicy, "quality_first");
});
