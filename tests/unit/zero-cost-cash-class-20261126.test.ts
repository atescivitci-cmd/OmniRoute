/**
 * ROUTING_ZERO_COST_BY_CASH_CLASS: zero-cost admission from the operator-set
 * providerSpecificData.cashClass of the exact active connection (free | subscription | local).
 *
 * Live finding 2026-11-26: under strict zero-cost admission (fit-first-free + localFallbackPolicy
 * "last", e.g. ac-pressed-zero-token-cost), only ollama-local and nvidia have an admission
 * resolver, so gemini and groq (cashClass "free") were refused, and the refusal was SILENT: the
 * candidates were filtered before ranking and appeared in neither the alternatives nor the
 * excluded list of the routing decision.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-cost-cash-class-"));
process.env.DATA_DIR = dir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
globalThis.fetch = async () => {
  throw new Error("network forbidden in this fixture");
};

const { hasCurrentZeroCostAdmission, zeroCostByCashClassEnabled } =
  await import("../../open-sse/services/autoCombo/zeroCostAdmission.ts");
const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
const { resolveAutoStrategyOrder } =
  await import("../../open-sse/services/combo/resolveAutoStrategy.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const db = getDbInstance();

const CONNECTIONS: Array<[string, string, Record<string, unknown> | null, number?]> = [
  ["conn-gemini", "gemini", { cashClass: "free" }],
  ["conn-groq", "groq", { cashClass: "free" }],
  ["conn-claude", "claude", { cashClass: "subscription" }],
  ["conn-ollama-like", "lmstudio", { cashClass: "local" }],
  ["conn-openai", "openai", { cashClass: "metered" }],
  ["conn-mistral", "mistral", null], // no cash class at all
  ["conn-gemini-off", "gemini", { cashClass: "free" }, 0], // inactive
];
for (const [id, provider, psd, active] of CONNECTIONS) {
  db.prepare(
    "INSERT INTO provider_connections(id,provider,auth_type,is_active,provider_specific_data,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
  ).run(id, provider, "apikey", active ?? 1, psd ? JSON.stringify(psd) : "{}", "t", "t");
}

test.after(() => {
  delete process.env.ROUTING_ZERO_COST_BY_CASH_CLASS;
  resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

const admit = (connectionId: string, provider: string, model = "some-model") =>
  hasCurrentZeroCostAdmission({
    provider,
    model,
    connectionId,
    body: { messages: [{ role: "user", content: "hi" }] },
  });

test("flag OFF (default): cash class is not read; behaviour is today's", async () => {
  delete process.env.ROUTING_ZERO_COST_BY_CASH_CLASS;
  assert.equal(zeroCostByCashClassEnabled(), false);
  for (const [id, provider] of CONNECTIONS) assert.equal(await admit(id, provider), false, id);
});

test("flag ON: free / subscription / local are admitted; metered, unlabeled and inactive are not", async () => {
  process.env.ROUTING_ZERO_COST_BY_CASH_CLASS = "1";
  try {
    assert.equal(await admit("conn-gemini", "gemini"), true);
    assert.equal(await admit("conn-groq", "groq"), true);
    assert.equal(await admit("conn-claude", "claude"), true);
    assert.equal(await admit("conn-ollama-like", "lmstudio"), true);
    assert.equal(await admit("conn-openai", "openai"), false, "metered stays refused");
    assert.equal(await admit("conn-mistral", "mistral"), false, "no cashClass = unchanged");
    assert.equal(await admit("conn-gemini-off", "gemini"), false, "inactive connection");
    assert.equal(await admit("conn-gemini", "groq"), false, "connection/provider mismatch");
  } finally {
    delete process.env.ROUTING_ZERO_COST_BY_CASH_CLASS;
  }
});

test("flag ON: a provider-specific resolver stays authoritative (a label never overrides it)", async () => {
  db.prepare(
    "INSERT INTO provider_connections(id,provider,auth_type,is_active,provider_specific_data,created_at,updated_at) VALUES(?,?,?,1,?,?,?)"
  ).run(
    "conn-nvidia-unscoped",
    "nvidia",
    "apikey",
    JSON.stringify({ cashClass: "free" }),
    "t",
    "t"
  );
  process.env.ROUTING_ZERO_COST_BY_CASH_CLASS = "1";
  try {
    // No NVIDIA trial scope is configured in this fixture, so the NVIDIA resolver refuses.
    assert.equal(await admit("conn-nvidia-unscoped", "nvidia"), false);
  } finally {
    delete process.env.ROUTING_ZERO_COST_BY_CASH_CLASS;
  }
});

// ── Through the production auto strategy (strict zero-cost: fit-first-free + local-last) ──

const POOL: Array<[string, string, string]> = [
  ["gemini", "gemini-2.5-flash", "conn-gemini"],
  ["groq", "openai/gpt-oss-120b", "conn-groq"],
  ["openai", "gpt-4o-mini", "conn-openai"],
];
async function decide() {
  const requestId = randomUUID();
  const targets = POOL.map(([provider, model, connection], i) => ({
    kind: "model" as const,
    provider,
    providerId: provider,
    modelStr: `${provider}/${model}`,
    stepId: `s${i}`,
    executionKey: `s${i}`,
    connectionId: null,
    allowedConnectionIds: [connection],
    weight: 1,
    label: null,
  }));
  const result = await resolveAutoStrategyOrder({
    orderedTargets: targets,
    body: { stream: false, messages: [{ role: "user", content: "Say hi." }] },
    combo: {
      name: "zero-cost-fixture",
      strategy: "auto",
      models: targets.map((t) => t.modelStr),
      config: {
        selectionPolicy: "fit-first-free",
        zeroAdditionalCostProviders: POOL.map(([p]) => p),
        localFallbackPolicy: "last",
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
  await new Promise((resolve) => setTimeout(resolve, 0));
  const row = db
    .prepare("SELECT provider_selected, factors_json FROM routing_decisions WHERE request_id=?")
    .get(requestId) as { provider_selected: string; factors_json: string } | undefined;
  return { result, decision: row ? { ...row, factors: JSON.parse(row.factors_json) } : null };
}

test("strict zero-cost, flag OFF: every candidate refused -> 503, nothing routed (unchanged)", async () => {
  delete process.env.ROUTING_ZERO_COST_BY_CASH_CLASS;
  const { result } = await decide();
  assert.ok("earlyResponse" in result);
  assert.equal(result.earlyResponse.status, 503);
});

test("strict zero-cost, flag ON: gemini and groq are candidates; metered openai is excluded WITH a reason", async () => {
  process.env.ROUTING_ZERO_COST_BY_CASH_CLASS = "1";
  try {
    const { result, decision } = await decide();
    assert.ok("orderedTargets" in result, JSON.stringify(result));
    const routed = result.orderedTargets.map((t) => t.provider);
    assert.ok(routed.includes("gemini") && routed.includes("groq"), routed.join(","));
    assert.ok(!routed.includes("openai"));
    assert.ok(decision, "decision recorded");
    const seen = [
      decision!.provider_selected,
      ...decision!.factors.alternatives.map((a: { provider: string }) => a.provider),
    ];
    assert.ok(seen.includes("gemini") && seen.includes("groq"), seen.join(","));
    const openai = decision!.factors.excluded.find(
      (e: { provider: string }) => e.provider === "openai"
    );
    assert.equal(openai?.reason, "zero_cost_admission_unavailable", "no longer a silent drop");
  } finally {
    delete process.env.ROUTING_ZERO_COST_BY_CASH_CLASS;
  }
});
