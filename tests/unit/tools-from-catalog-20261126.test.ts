/**
 * ROUTING_TOOLS_FROM_CATALOG: tool eligibility from the synced models.dev catalog
 * (model_capabilities, the table the capability resolver already reads).
 *
 * Gap (live, 2026-11-26): the resolver reads tool_call only from the routing provider's OWN
 * catalog rows. NVIDIA's catalog has no row for moonshotai/kimi-k3.1-pro, so supportsTools is
 * null and fit-first excludes it as capability_unverified_tools, although models.dev lists the
 * same model id with tool_call = true under other hosts. With the flag on, an UNKNOWN own-provider
 * verdict is resolved from the catalog rows of the same model id: at least one tool_call = true
 * and none false. An explicit negative (the provider's own row, registry or spec saying false;
 * any catalog row saying false) still excludes. Learned failures (lockout, 3 real failures in 30
 * minutes, tool_use_failed included) bench the model under quality-first.
 */
import "../../scripts/tools/replayIsolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { getDbInstance, resetDbInstance } from "@/lib/db/core";
import { saveModelsDevCapabilities } from "../../src/lib/modelsDevSync.ts";
import { rankFitFirstFreeCandidates } from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { fairSelectionSettings } from "../../open-sse/services/autoCombo/fairSelectionSettings.ts";
import { isRealModelFailure } from "../../open-sse/services/autoCombo/qualityFirst.ts";

const row = (tool_call: boolean | null) => ({
  tool_call,
  reasoning: true,
  attachment: false,
  structured_output: null,
  temperature: null,
  modalities_input: null,
  modalities_output: null,
  knowledge_cutoff: null,
  release_date: null,
  last_updated: null,
  status: null,
  family: null,
  open_weights: null,
  limit_context: 262_144,
  limit_input: null,
  limit_output: 65_536,
  interleaved_field: null,
});
// Own provider (synthetic "hostx") has no row for these models; other hosts list them.
saveModelsDevCapabilities({
  "other-host-a": {
    "vendor/listed-tools": row(true),
    "vendor/listed-no-tools": row(false),
    "vendor/conflicting": row(true),
  },
  "other-host-b": {
    "listed-tools": row(true),
    conflicting: row(false),
  },
  hostx: { "vendor/own-false": row(false) },
  "other-host-c": { "vendor/own-false": row(true) },
});

test.after(() => {
  delete process.env.ROUTING_TOOLS_FROM_CATALOG;
  delete process.env.ROUTING_QUALITY_FIRST;
  resetDbInstance();
});

const TOOL_BODY = {
  stream: true,
  tools: [{ name: "Bash", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "Implement a CSV parser and run the tests." }],
};
const MODELS = [
  "vendor/listed-tools",
  "vendor/listed-no-tools",
  "vendor/conflicting",
  "vendor/own-false",
  "vendor/unlisted",
];

async function decide(env: Record<string, string>) {
  for (const k of ["ROUTING_TOOLS_FROM_CATALOG", "ROUTING_QUALITY_FIRST"]) delete process.env[k];
  Object.assign(process.env, env);
  const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
  const candidates = (await buildAutoCandidates(
    MODELS.map((model) => ({
      kind: "model",
      provider: "hostx",
      modelStr: `hostx/${model}`,
      stepId: model,
      executionKey: model,
      connectionId: null,
    })) as never,
    "x",
    null,
    undefined,
    null,
    true
  )) as never as Parameters<typeof rankFitFirstFreeCandidates>[0]["candidates"];
  return rankFitFirstFreeCandidates({
    candidates,
    body: TOOL_BODY,
    zeroAdditionalCostProviders: ["hostx"],
    settings: fairSelectionSettings(),
  });
}
const reasons = (d: Awaited<ReturnType<typeof decide>>) =>
  Object.fromEntries([
    ...d.ranked.map((e) => [e.candidate.model, "eligible"]),
    ...d.excluded.map((e) => [e.model, e.reason]),
  ]);

test("flag OFF: unchanged; every model without its own-provider tool verdict is excluded", async () => {
  const r = reasons(await decide({}));
  for (const m of MODELS) assert.equal(r[m], "capability_unverified_tools", m);
});

test("flag ON: a catalog tool_call=true row makes a model eligible; a catalog false still excludes", async () => {
  const r = reasons(await decide({ ROUTING_TOOLS_FROM_CATALOG: "1" }));
  assert.equal(r["vendor/listed-tools"], "eligible", "true on other hosts, no false anywhere");
  assert.equal(r["vendor/listed-no-tools"], "capability_unverified_tools", "catalog false");
  assert.equal(r["vendor/conflicting"], "capability_unverified_tools", "any catalog false wins");
  assert.equal(r["vendor/own-false"], "capability_unverified_tools", "own-provider false wins");
  assert.equal(r["vendor/unlisted"], "capability_unverified_tools", "no evidence stays out");
});

test("flag ON + quality-first: a model with 3 tool failures in 30 min is benched", async () => {
  assert.equal(
    isRealModelFailure({
      provider: "p",
      model: "m",
      success: false,
      errorCode: "tool_use_failed",
      source: null,
      timestamp: "",
    }),
    true
  );
  assert.equal(
    isRealModelFailure({
      provider: "p",
      model: "m",
      success: false,
      errorCode: "upstream_400",
      source: null,
      timestamp: "",
    }),
    true
  );
  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO usage_history (provider, model, tokens_input, tokens_output, status, success,
       latency_ms, ttft_ms, error_code, timestamp) VALUES ('hostx', 'vendor/listed-tools', 10, 0, '400', 0, 500, 0, 'tool_use_failed', ?)`
  );
  for (let i = 0; i < 3; i++) insert.run(new Date(Date.now() - (i + 1) * 60_000).toISOString());
  try {
    const r = reasons(
      await decide({ ROUTING_TOOLS_FROM_CATALOG: "1", ROUTING_QUALITY_FIRST: "1" })
    );
    assert.equal(r["vendor/listed-tools"], "broken_now_recent_failures");
  } finally {
    db.prepare("DELETE FROM usage_history").run();
  }
});
