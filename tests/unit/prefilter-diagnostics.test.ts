// Auto-strategy prefilters used to drop targets without a trace (the context-window filter only
// logged at debug level and never listed what it removed), so a request too large for the native
// Codex models silently lost them before ranking. These tests pin the content-free diagnostics:
// provider and model ids and numbers only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-prefilter-diag-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const diag = await import("../../open-sse/services/combo/prefilterDiagnostics.ts");
const { saveModelsDevCapabilities } = await import("../../src/lib/modelsDevSync.ts");
const { resolveAutoStrategyOrder } =
  await import("../../open-sse/services/combo/resolveAutoStrategy.ts");

const t = (provider: string, modelStr: string) => ({
  kind: "model" as const,
  stepId: "s1",
  executionKey: `${provider}>${modelStr}`,
  modelStr,
  provider,
  providerId: null,
  connectionId: null,
  weight: 1,
  label: null,
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("droppedTargets returns exactly the targets removed by a filter, by identity", () => {
  const a = t("codex", "codex/gpt-5.6-terra");
  const b = t("claude", "claude/claude-opus-4-8");
  const c = t("nvidia", "nvidia/x");
  assert.deepEqual(
    diag.droppedTargets([a, b, c], [b]).map((x) => x.modelStr),
    ["codex/gpt-5.6-terra", "nvidia/x"]
  );
  assert.deepEqual(diag.droppedTargets([a, b], [a, b]), []);
});

test("context drops carry provider, model, window and required tokens, and no other content", () => {
  const a = t("codex", "codex/gpt-5.6-terra");
  const rows = diag.describeContextDrops(
    [a],
    () => 272000,
    () => 686000
  );
  assert.deepEqual(rows, [
    {
      provider: "codex",
      model: "codex/gpt-5.6-terra",
      reason: "context_window",
      contextLimit: 272000,
      requiredTokens: 686000,
    },
  ]);
});

test("a lone ranked candidate with no evidence is flagged; ranked pairs and proven winners are not", () => {
  const neutral = {
    candidate: { provider: "nvidia", model: "mistral" },
    factors: {
      reliabilitySource: "neutral_prior",
      reliabilitySampleCount: 0,
      latencyEvidence: "neutral_prior",
      score: 0.574,
    },
  };
  const proven = {
    candidate: { provider: "claude", model: "opus" },
    factors: {
      reliabilitySource: "usage_24h",
      reliabilitySampleCount: 200,
      latencyEvidence: "observed",
      score: 0.9,
    },
  };
  assert.deepEqual(diag.loneUnprovenWinner([neutral] as never), {
    provider: "nvidia",
    model: "mistral",
    score: 0.574,
    evidence: ["reliability_neutral_prior", "latency_neutral_prior"],
  });
  assert.equal(diag.loneUnprovenWinner([neutral, proven] as never), null);
  assert.equal(diag.loneUnprovenWinner([proven] as never), null);
  assert.equal(diag.loneUnprovenWinner([] as never), null);
});

test("the context-window prefilter reports what it removed, at info level", async () => {
  saveModelsDevCapabilities({
    codex: { small: { tool_call: true, limit_context: 1000 } as never },
    claude: { big: { tool_call: true, limit_context: 1_000_000 } as never },
  } as never);
  const events: Array<{ level: string; tag: string; msg: unknown }> = [];
  const log = {
    info: (tag: string, msg: unknown) => events.push({ level: "info", tag, msg }),
    warn: (tag: string, msg: unknown) => events.push({ level: "warn", tag, msg }),
    error() {},
    debug() {},
  };
  const hugePrompt = "x".repeat(40_000); // about 10k tokens
  await resolveAutoStrategyOrder({
    orderedTargets: [t("codex", "codex/small"), t("claude", "claude/big")] as never,
    body: { messages: [{ role: "user", content: hugePrompt }] },
    combo: { id: "c1", name: "ac-terminal-continuity", config: {} } as never,
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: log as never,
    buildAutoCandidates: (async () => []) as never,
  });
  const line = events.find((e) => e.tag === "COMBO" && String(e.msg).includes("prefilter_drop"));
  assert.ok(line, JSON.stringify(events.map((e) => e.msg)).slice(0, 400));
  const parsed = JSON.parse(String(line.msg));
  assert.equal(parsed.stage, "context_window");
  assert.deepEqual(
    parsed.dropped.map((d: { model: string }) => d.model),
    ["codex/small"]
  );
  assert.ok(parsed.estimatedTokens > 1000);
  assert.ok(!String(line.msg).includes("xxxx"), "no request content in the log");
});
