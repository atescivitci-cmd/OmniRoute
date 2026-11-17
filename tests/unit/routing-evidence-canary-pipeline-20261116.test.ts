/**
 * Routing evidence canary, called the way production calls it.
 *
 * Only the upstream HTTP call is stubbed. Settings, connections, combos, pool expansion,
 * evidence counts, pricing, cooldown/lockout/breaker checks, the probe runner, the real chat
 * pipeline and usage recording are all the production code, on an isolated throwaway DB. This is
 * the check that the canary is wired to the selector's evidence, not merely self-consistent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createProviderConnection } from "@/lib/db/providers";
import { createCombo } from "@/lib/db/combos";
import { addCustomModel, replaceSyncedAvailableModelsForConnection } from "@/lib/db/models";
import { updateSettings } from "@/lib/db/settings";
import { getModelLatencyStats } from "@/lib/usageDb";
import { getDbInstance } from "@/lib/db/core";
import { USAGE_SOURCE_ROUTING_CANARY } from "@/shared/constants/usageSource";
import {
  createDefaultRoutingEvidenceCanaryDeps,
  createRoutingEvidenceCanaryState,
  runRoutingEvidenceCanaryTick,
} from "@/lib/services/routingEvidenceCanary.ts";

// Load the probe runner (and with it the chat route and its fetch wrapper) BEFORE the upstream
// stub is installed. The production scheduler imports it lazily; if that first import happened
// after the stub, the route's own setup would replace the stub and the probe would reach the
// real network with a dummy key.
await import("@/lib/api/modelTestRunner.ts");

const COMBO = "canary-pipeline-combo";

async function waitFor(predicate: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("canary probe flows through the real pipeline and becomes selector evidence", async () => {
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "canary-pipeline-test",
    apiKey: "sk-canary-pipeline-test",
    isActive: true,
    testStatus: "active",
  });
  const connectionId = String(connection.id);
  await createCombo({
    name: COMBO,
    strategy: "auto",
    models: [{ model: "openai/gpt-4o", provider: "openai" }],
  });

  const originalFetch = globalThis.fetch;
  const upstreamBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: unknown, init: { body?: unknown } = {}) => {
    try {
      upstreamBodies.push(JSON.parse(String(init.body)));
    } catch {
      /* not a JSON body */
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 900, completion_tokens: 2, total_tokens: 902 },
      }),
      { headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const deps = createDefaultRoutingEvidenceCanaryDeps();
    const state = createRoutingEvidenceCanaryState();

    // Default settings: nothing is enabled, so nothing is sent.
    let result = await runRoutingEvidenceCanaryTick(deps, state, Date.now, { env: {} });
    assert.equal(result.skippedAll, "disabled");
    assert.equal(upstreamBodies.length, 0);

    // Enabled but the connection is not opted in: still nothing.
    await updateSettings({
      routingCanary: { enabled: true, combos: [COMBO], connections: {} },
    });
    result = await runRoutingEvidenceCanaryTick(deps, state, Date.now, { env: {} });
    assert.equal(result.probed, 0);
    assert.equal(upstreamBodies.length, 0);

    // Opted in: one probe goes out through the real pipeline.
    await updateSettings({
      routingCanary: { enabled: true, combos: [COMBO], connections: { [connectionId]: true } },
    });
    result = await runRoutingEvidenceCanaryTick(deps, state, Date.now, { env: {} });
    assert.equal(result.probed, 1, JSON.stringify(result));
    assert.equal(result.failed, 0, JSON.stringify(result));
    assert.equal(upstreamBodies.length, 1);
    const sent = JSON.stringify(upstreamBodies[0]);
    assert.ok(sent.includes("Routing probe."), "probe prompt reached the upstream request");
    assert.ok(sent.includes("numbers from 1 to 60"));

    // The sample is recorded where the selector reads latency and reliability from.
    const recorded = await waitFor(async () => {
      const stats = await getModelLatencyStats({ windowHours: 24, minSamples: 1 });
      return (stats["openai/gpt-4o"]?.totalRequests ?? 0) >= 1;
    });
    assert.ok(recorded, "no usage_history evidence was recorded for the probed candidate");
    const stats = await getModelLatencyStats({ windowHours: 24, minSamples: 1 });
    assert.equal(stats["openai/gpt-4o"].successfulRequests >= 1, true);

    // Every row the real pipeline wrote for the probe is tagged, so reports can tell it from
    // client traffic, while the selector evidence above still counted it.
    const db = getDbInstance();
    const usageRows = db
      .prepare("SELECT source FROM usage_history WHERE connection_id = ?")
      .all(connectionId) as Array<{ source: string | null }>;
    assert.ok(usageRows.length >= 1);
    assert.deepEqual(
      usageRows.map((r) => r.source),
      usageRows.map(() => USAGE_SOURCE_ROUTING_CANARY),
      "untagged usage_history row written for a canary probe"
    );
    await waitFor(async () => {
      const n = db
        .prepare("SELECT COUNT(*) AS n FROM call_logs WHERE connection_id = ?")
        .get(connectionId) as { n: number };
      return n.n >= 1;
    });
    const logTags = db
      .prepare("SELECT source FROM call_logs WHERE connection_id = ?")
      .all(connectionId) as Array<{ source: string | null }>;
    assert.ok(logTags.length >= 1, "no call log was written for the probe");
    assert.deepEqual(
      logTags.map((r) => r.source),
      logTags.map(() => USAGE_SOURCE_ROUTING_CANARY),
      "untagged call_logs row written for a canary probe"
    );

    // Spacing keeps the very next tick from probing the same candidate again.
    result = await runRoutingEvidenceCanaryTick(deps, state, Date.now, { env: {} });
    assert.equal(result.probed, 0);
    assert.equal(upstreamBodies.length, 1);

    // The kill switch stops even an enabled, opted-in canary.
    state.lastProbeAt = {};
    result = await runRoutingEvidenceCanaryTick(deps, state, Date.now, {
      env: { ROUTING_EVIDENCE_CANARY: "off" },
    });
    assert.equal(result.skippedAll, "kill_switch");
    assert.equal(upstreamBodies.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one broken combo does not stop pool listing for the others", async () => {
  await createCombo({
    name: "canary-broken-combo",
    strategy: "priority",
    models: [{ kind: "combo-ref", comboName: "canary-does-not-exist" }],
  });
  await createCombo({
    name: "canary-good-combo",
    strategy: "priority",
    models: [{ model: "openai/gpt-4o", provider: "openai" }],
  });
  const deps = createDefaultRoutingEvidenceCanaryDeps();
  const targets = await deps.listPoolTargets(["canary-broken-combo", "canary-good-combo"]);
  assert.ok(targets.some((t) => t.modelStr.includes("gpt-4o")));
});

test("default chat-capability check uses declared metadata, never names", async () => {
  await addCustomModel("openai", "canary-embed-x", "x", "manual", "embeddings", ["embeddings"]);
  await addCustomModel("openai", "canary-chat-x", "x", "manual", "chat-completions", ["chat"]);
  const deps = createDefaultRoutingEvidenceCanaryDeps();
  assert.equal(await deps.isChatCapable("openai", "canary-embed-x"), false);
  assert.equal(await deps.isChatCapable("openai", "canary-chat-x"), true);
  assert.equal(await deps.isChatCapable("openai", "gpt-4o"), true, "static chat catalog");
  assert.equal(await deps.isChatCapable("openai", "model-nobody-declared"), false);
});

test("a synced record that declares nothing is not assumed to be chat", async () => {
  await replaceSyncedAvailableModelsForConnection("openai", "canary-sync-conn", [
    { id: "canary-sync-nometa", name: "canary-sync-nometa" },
    { id: "gpt-4o", name: "gpt-4o" },
    { id: "canary-sync-chat", name: "c", supportedEndpoints: ["chat"] },
    { id: "canary-sync-speech", name: "s", supportedEndpoints: ["audio-speech"] },
  ]);
  const deps = createDefaultRoutingEvidenceCanaryDeps();
  assert.equal(await deps.isChatCapable("openai", "canary-sync-nometa"), false);
  assert.equal(
    await deps.isChatCapable("openai", "gpt-4o"),
    true,
    "declared by the static catalog"
  );
  assert.equal(await deps.isChatCapable("openai", "canary-sync-chat"), true);
  assert.equal(await deps.isChatCapable("openai", "canary-sync-speech"), false);
});

test("default probe runner returns at its deadline even while the upstream keeps streaming", async () => {
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "canary-deadline-test",
    apiKey: "sk-canary-deadline-test",
    isActive: true,
    testStatus: "active",
  });
  const original = globalThis.fetch;
  const fast = () =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }), {
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = (async () => fast()) as typeof fetch;
  const deps = createDefaultRoutingEvidenceCanaryDeps();
  const args = {
    provider: "openai",
    model: "gpt-4o",
    modelStr: "openai/gpt-4o",
    connectionId: String(connection.id),
    prompt: "Routing probe.",
    maxTokens: 64,
    timeoutMs: 10_000,
  };
  await deps.runProbe(args); // warm the pipeline

  let cancelled = false;
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval>;
    return new Response(
      new ReadableStream({
        start(controller) {
          timer = setInterval(
            () =>
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"t"}}]}\n\n')
              ),
            100
          );
        },
        cancel() {
          cancelled = true;
          clearInterval(timer);
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  }) as typeof fetch;
  try {
    const started = Date.now();
    const outcome = await deps.runProbe({ ...args, timeoutMs: 800 });
    const elapsed = Date.now() - started;
    assert.equal(outcome.ok, false, "a probe that hit its deadline is not ok");
    assert.ok(elapsed < 2_500, `probe held the caller for ${elapsed} ms (deadline 800 ms)`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(cancelled, true, "the upstream stream was left open");

    // The production probe streams and can be cancelled at its deadline. Every row the pipeline
    // writes on those paths, the warm-up success and the cut-off failure alike, must be tagged.
    const db = getDbInstance();
    const connId = String(connection.id);
    await waitFor(async () => {
      const n = db
        .prepare("SELECT COUNT(*) AS n FROM usage_history WHERE connection_id = ?")
        .get(connId) as { n: number };
      return n.n >= 2;
    }, 3000);
    const usage = db
      .prepare("SELECT success, source FROM usage_history WHERE connection_id = ?")
      .all(connId) as Array<{ success: number; source: string | null }>;
    assert.ok(usage.length >= 1, "no usage rows were written for the streaming probes");
    assert.ok(
      usage.every((r) => r.source === USAGE_SOURCE_ROUTING_CANARY),
      `untagged row on the streaming path: ${JSON.stringify(usage)}`
    );
    const logs = db
      .prepare("SELECT source FROM call_logs WHERE connection_id = ?")
      .all(connId) as Array<{ source: string | null }>;
    assert.ok(
      logs.every((r) => r.source === USAGE_SOURCE_ROUTING_CANARY),
      `untagged call log on the streaming path: ${JSON.stringify(logs)}`
    );
    console.log(
      `[tag-check] streaming path rows: usage=${usage.length} calllogs=${logs.length} failures=${usage.filter((r) => !r.success).length}`
    );
  } finally {
    globalThis.fetch = original;
  }
});
