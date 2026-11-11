import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-managed-routing-"));
process.env.DATA_DIR = dir;
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");
const { buildAutoCandidates, handleComboChat } = await import("../../open-sse/services/combo.ts");
const { markKnownNonDispatch } =
  await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { resolveResilienceSettings } = await import("../../src/lib/resilience/settings.ts");
const { rankFitFirstFreeCandidates } =
  await import("../../open-sse/services/autoCombo/fitFirstPolicy.ts");
const { calculateFactors, quotaRankingFactor } =
  await import("../../open-sse/services/autoCombo/scoring.ts");
const { resolveAutoStrategyOrder } =
  await import("../../open-sse/services/combo/resolveAutoStrategy.ts");
const { tryPinnedModelDispatch } = await import("../../open-sse/services/combo/dispatchPrelude.ts");
const vendors = ["claude", "codex", "github", "nvidia", "ollama-local", "other-fixture"];
const log = { info() {}, warn() {}, error() {}, debug() {} };
function hardCutoffs() {
  const settings = resolveResilienceSettings(null);
  return { ...settings, quotaPreflight: { ...settings.quotaPreflight, enabled: true } };
}

function candidate(provider: string, more: any = {}) {
  return {
    provider,
    model: "same-fixture-model",
    modelStr: `${provider}/same-fixture-model`,
    stepId: provider,
    executionKey: provider,
    connectionId: `account-${provider}`,
    quotaRemaining: 0,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED" as const,
    costPer1MTokens: 0,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
    ...more,
  };
}
function rank(
  candidates: any[],
  body: any = { messages: [{ role: "user", content: "Synthetic summary" }] }
) {
  return rankFitFirstFreeCandidates({ candidates, body, zeroAdditionalCostProviders: vendors });
}

test("every vendor uses the same quota bypass and neutral quota score", async (t) => {
  for (const provider of vendors)
    await t.test(provider, () => {
      const c = candidate(provider, { quotaPolicyBypassed: true });
      const r = rank([c]);
      assert.equal(r.ranked.length, 1);
      assert.equal(r.ranked[0].factors.quota, 0.5);
      assert.equal(quotaRankingFactor({ ...c, quotaRemaining: 100 }), 0.5);
      assert.equal(quotaRankingFactor({ ...c, quotaRemaining: null }), 0.5);
    });
});
test("strict included-quota admission is unchanged", () => {
  for (const provider of vendors) {
    assert.equal(rank([candidate(provider)]).excluded[0].reason, "quota_unavailable");
    assert.equal(rank([candidate(provider, { quotaRemaining: 100 })]).ranked.length, 1);
  }
});
test("bypass cannot clear real cutoff/status/circuit vetoes", () => {
  for (const extra of [
    { quotaCutoffBlocked: true },
    { statusPenalty: true },
    { circuitBreakerState: "OPEN" },
  ]) {
    const r = rank([candidate("codex", { quotaPolicyBypassed: true, ...extra })]);
    assert.equal(r.ranked.length, 0);
  }
});
test("bypass grants no new cost or capability eligibility", () => {
  const r = rank([candidate("not-authorized", { quotaPolicyBypassed: true })]);
  assert.equal(r.excluded[0].reason, "not_verified_zero_additional_cost");
  const tools = rank([candidate("other-fixture", { quotaPolicyBypassed: true })], {
    messages: [{ role: "user", content: "Synthetic tool fixture" }],
    tools: [{ type: "function", function: { name: "fixture", parameters: { type: "object" } } }],
  });
  assert.equal(tools.ranked.length, 0);
  assert.equal(tools.excluded[0].reason, "capability_unverified_tools");
});
test("generic scoring uses the same neutral quota factor", () => {
  const a = candidate("claude", { quotaPolicyBypassed: true, quotaRemaining: 0 });
  const b = candidate("codex", { quotaPolicyBypassed: true, quotaRemaining: 100 });
  assert.equal(calculateFactors(a, [a, b], "general", () => 0.5).quota, 0.5);
  assert.equal(calculateFactors(b, [a, b], "general", () => 0.5).quota, 0.5);
  assert.equal(
    calculateFactors({ ...a, quotaPolicyBypassed: false }, [a, b], "general", () => 0.5).quota,
    0
  );
});
test("actual candidate builder skips quota fetches and records unknown quota honestly", async () => {
  const targets: any[] = [];
  for (const provider of vendors) {
    const c = await providers.createProviderConnection({
      provider,
      authType: "apikey",
      name: `fixture-${provider}`,
      apiKey: "synthetic-not-a-credential",
    });
    targets.push({
      kind: "model",
      stepId: provider,
      executionKey: provider,
      modelStr: `${provider}/same-fixture-model`,
      provider,
      providerId: null,
      connectionId: c.id,
    });
  }
  invalidateDbCache("providerConnections");
  let calls = 0;
  const fetcher = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("fixture forbids network");
  };
  try {
    const out = await buildAutoCandidates(
      targets,
      "provider-managed-fixture",
      null,
      undefined,
      hardCutoffs(),
      true
    );
    assert.equal(calls, 0);
    assert.equal(out.length, vendors.length);
    for (const c of out) {
      assert.equal(c.quotaPolicyBypassed, true);
      assert.equal(c.quotaRemaining, null);
      assert.equal(c.provenance.quota.source, "unavailable");
      assert.equal(quotaRankingFactor(c), 0.5);
      assert.equal(c.quotaCutoffBlocked, false);
      assert.ok(
        targets.some((t) => t.provider === c.provider && t.connectionId === c.connectionId)
      );
    }
  } finally {
    globalThis.fetch = fetcher;
  }
});
test("strategy forwards only its trusted relay policy and leaves real status configuration enabled", async () => {
  const target: any = {
    kind: "model",
    stepId: "s",
    executionKey: "s",
    modelStr: "openai/gpt-4o",
    provider: "openai",
    providerId: null,
    connectionId: "a",
  };
  for (const bypass of [false, true]) {
    let captured: any[] = [];
    const settings = hardCutoffs();
    await resolveAutoStrategyOrder({
      orderedTargets: [target],
      body: {
        messages: [{ role: "user", content: "Synthetic request" }],
        bypassProviderQuotaPolicy: true,
        quotaPolicyBypassed: true,
      },
      combo: { id: "fixture", name: "provider-managed-fixture", config: {} } as any,
      settings: {},
      config: {},
      relayOptions: { bypassProviderQuotaPolicy: bypass },
      resilienceSettings: settings,
      log,
      expandAutoCandidatePool: async (x) => x,
      buildAutoCandidates: async (...args) => {
        captured = args;
        return [];
      },
    });
    assert.equal(captured[5], bypass);
    assert.equal(captured[4], settings);
    assert.equal(captured[4].quotaPreflight.enabled, true);
  }
});
test("actual auto resolver applies the same policy to the primary and complete fallback pool", async () => {
  const targets: any[] = vendors.map((provider) => ({
    kind: "model",
    stepId: provider,
    executionKey: provider,
    modelStr: `${provider}/same-fixture-model`,
    provider,
    providerId: null,
    connectionId: `account-${provider}`,
  }));
  for (const bypass of [false, true]) {
    const body = { messages: [{ role: "user", content: "Synthetic summary" }], max_tokens: 10 };
    const before = structuredClone(body);
    const checks: string[] = [];
    const result = await resolveAutoStrategyOrder({
      orderedTargets: targets,
      body,
      combo: {
        id: "quota-fixture",
        name: "quota-fixture",
        config: {
          auto: {
            selectionPolicy: "fit-first-free",
            zeroAdditionalCostProviders: vendors,
            explorationRate: 0,
          },
        },
      } as any,
      settings: {},
      config: {},
      relayOptions: { bypassProviderQuotaPolicy: bypass },
      resilienceSettings: hardCutoffs(),
      log,
      expandAutoCandidatePool: async (x) => x,
      isModelAvailable: async (_model, target) => {
        checks.push(target.connectionId);
        return true;
      },
      buildAutoCandidates: async (ts, _name, _session, _reset, _settings, flag) =>
        ts.map((t) =>
          candidate(t.provider, { ...t, quotaPolicyBypassed: flag, quotaRemaining: 0 })
        ) as any,
    });
    assert.deepEqual(body, before);
    assert.equal(checks.length, vendors.length);
    if (bypass) {
      assert.ok("orderedTargets" in result);
      assert.equal(result.orderedTargets.length, vendors.length);
      assert.deepEqual(new Set(result.orderedTargets.map((t) => t.provider)), new Set(vendors));
    } else {
      assert.ok("earlyResponse" in result);
      assert.equal(result.earlyResponse.status, 503);
    }
  }
});
test("terminal route admits Ollama into factual ranking despite historical pinned-fallback config", async () => {
  const targets: any[] = ["claude/claude-sonnet-4-6", "ollama-local/qwen3.6:35b-a3b"].map(
    (modelStr) => ({
      kind: "model",
      modelStr,
      provider: modelStr.split("/")[0],
      providerId: null,
      stepId: modelStr,
      executionKey: modelStr,
      connectionId: `fixture-${modelStr}`,
    })
  );
  let admitted: string[] = [];
  const result = await resolveAutoStrategyOrder({
    orderedTargets: targets,
    body: { messages: [{ role: "user", content: "Synthetic request" }], max_tokens: 10 },
    combo: {
      id: "terminal-fixture",
      name: "ac-terminal-continuity",
      config: {
        finalLocalFallbackModel: "ollama-local/qwen3.6:35b-a3b",
        auto: {
          selectionPolicy: "fit-first-free",
          zeroAdditionalCostProviders: ["claude", "ollama-local"],
          explorationRate: 0,
        },
      },
    } as any,
    settings: {},
    config: {},
    relayOptions: { bypassProviderQuotaPolicy: true },
    resilienceSettings: hardCutoffs(),
    log,
    expandAutoCandidatePool: async (x) => x,
    isModelAvailable: async () => true,
    buildAutoCandidates: async (ts, _name, _session, _reset, _settings, flag) => {
      admitted = ts.map((t) => t.modelStr);
      return ts.map((t) =>
        candidate(t.provider, {
          ...t,
          model: t.modelStr.slice(t.provider.length + 1),
          quotaPolicyBypassed: flag,
          quotaRemaining: null,
        })
      ) as any;
    },
  });
  assert.deepEqual(new Set(admitted), new Set(targets.map((t) => t.modelStr)));
  assert.ok("orderedTargets" in result);
  assert.ok(result.orderedTargets.some((t) => t.provider === "ollama-local"));
  const record = core
    .getDbInstance()
    .prepare(
      "SELECT factors_json FROM routing_decisions WHERE combo_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get("terminal-fixture") as { factors_json: string };
  assert.deepEqual(JSON.parse(record.factors_json).primaryReservations, []);
});
test("terminal wrapper cannot append a pinned model outside its admitted target pool", async () => {
  const calls: string[] = [];
  const result = await handleComboChat({
    body: { messages: [{ role: "user", content: "Synthetic request" }], max_tokens: 10 },
    combo: {
      name: "ac-terminal-continuity",
      strategy: "priority",
      allowedProviders: ["claude", "ollama-local"],
      models: [{ model: "claude/claude-sonnet-4-6" }],
      config: {
        finalLocalFallbackModel: "ollama-local/qwen3.6:35b-a3b",
        zeroAdditionalCostProviders: ["claude", "ollama-local"],
      },
    } as any,
    handleSingleModel: async (_body, model) => {
      calls.push(model);
      return markKnownNonDispatch(
        Response.json(
          { error: { code: "model_not_found", message: "Synthetic definite rejection" } },
          { status: 404 }
        )
      );
    },
    isModelAvailable: async () => true,
    log,
    settings: {},
    allCombos: [],
  });
  assert.equal(result.status, 404);
  assert.deepEqual(calls, ["claude/claude-sonnet-4-6"]);
});
test("an otherwise admitted local continuation pin is not reserved away from the common pool", async () => {
  const body = {
    messages: [
      { role: "user", content: "Synthetic task" },
      {
        role: "assistant",
        tool_calls: [
          { id: "fixture-call", type: "function", function: { name: "fixture", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "fixture-call", content: "Synthetic tool result" },
    ],
    tools: [{ type: "function", function: { name: "fixture", parameters: { type: "object" } } }],
  };
  for (const allowed of [true, false]) {
    let dispatches = 0;
    const result = await tryPinnedModelDispatch({
      body,
      pinnedModel: "ollama-local/qwen3.6:35b-a3b",
      combo: {
        name: "ac-terminal-continuity",
        strategy: "auto",
        models: [],
        allowedProviders: ["ollama-local"],
        config: {
          finalLocalFallbackModel: "ollama-local/qwen3.6:35b-a3b",
          auto: {
            selectionPolicy: "fit-first-free",
            zeroAdditionalCostProviders: allowed ? ["ollama-local"] : ["claude"],
          },
        },
      } as any,
      config: { maxComboDepth: 8 } as any,
      clientRequestedStream: false,
      isModelAvailable: async () => true,
      log,
      handleSingleModelWithTimeout: async () => {
        dispatches++;
        return Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Synthetic response" },
              finish_reason: "stop",
            },
          ],
        });
      },
    });
    assert.equal(dispatches, allowed ? 1 : 0);
    assert.equal(result?.status ?? null, allowed ? 200 : null);
  }
});
for (const mode of ["deadline", "cancel"] as const) {
  test(`common operation wrapper preserves ${mode} while availability preparation stalls`, async () => {
    let release!: (value: boolean) => void;
    let checked!: () => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      checked = resolve;
    });
    const controller = new AbortController();
    let dispatched = 0;
    const result = handleComboChat({
      body: { messages: [{ role: "user", content: "Synthetic request" }] },
      combo: {
        name: "ac-terminal-continuity",
        strategy: "priority",
        models: [{ model: "claude/claude-sonnet-4-6" }],
        config: { comboTimeoutMs: 100 },
      } as any,
      handleSingleModel: async () => {
        dispatched++;
        return Response.json({ ok: true });
      },
      isModelAvailable: async () => {
        checked();
        return gate;
      },
      signal: controller.signal,
      log,
      settings: {},
      allCombos: [],
    });
    await entered;
    if (mode === "cancel") controller.abort();
    const response = await result;
    assert.equal(response.status, mode === "cancel" ? 499 : 504);
    assert.equal(dispatched, 0);
    release(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dispatched, 0, "late preparation must not dispatch after stop");
  });
}
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});
