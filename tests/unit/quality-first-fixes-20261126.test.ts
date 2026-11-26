/**
 * Challenger findings on be8b09b (FIX-THEN-SHIP), ROUTING_QUALITY_FIRST:
 *  D1  no measured candidate -> blended fallback, no band
 *  D2  the band keeps the conversation's previous model while it is eligible and in band
 *  D3  reduced-effort ids are unrated unless the leaderboard lists that effort
 *  category: a "general" request with tools or intent "code" reads the coding leaderboard
 *  plus tests that kill the surviving mutants listed by the challenger.
 */
import "../../scripts/tools/replayIsolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDbInstance, resetDbInstance } from "@/lib/db/core";
import { replaceModelIntelligenceBySource } from "../../src/lib/db/modelIntelligence.ts";
import {
  QUALITY_CATEGORY_PLAN,
  QUALITY_SOURCE,
  parseLeaderboardPage,
  transformQualitySnapshot,
} from "../../src/lib/qualityScoreSync.ts";
import {
  getTaskQualityWithSource,
  invalidateFitnessCache,
  setUserFitnessOverride,
} from "../../open-sse/services/autoCombo/taskFitness.ts";
import {
  qualityTaskFor,
  rankFitFirstFreeCandidates,
} from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { fairSelectionSettings } from "../../open-sse/services/autoCombo/fairSelectionSettings.ts";
import { candidateQualityKeys } from "../../open-sse/services/autoCombo/qualityModelKey.ts";
import { saveModelsDevCapabilities } from "../../src/lib/modelsDevSync.ts";
import { recordModelLockoutFailure } from "../../open-sse/services/accountFallback.ts";
import { recordProviderCooldown } from "../../open-sse/services/providerCooldownTracker.ts";
import { resolveResilienceSettings } from "../../src/lib/resilience/settings.ts";

const SNAPSHOT = JSON.parse(
  fs.readFileSync(
    path.join(
      import.meta.dirname,
      "../fixtures/quality/lmarena-snapshot-20261122-live-models.json"
    ),
    "utf8"
  )
) as { categories: Record<string, Array<Record<string, unknown>>> };

function loadQuality() {
  replaceModelIntelligenceBySource(
    QUALITY_SOURCE,
    transformQualitySnapshot(
      Object.fromEntries(
        QUALITY_CATEGORY_PLAN.map(({ category }) => [
          category,
          parseLeaderboardPage(
            { rows: SNAPSHOT.categories[category].map((row) => ({ row })), num_rows_total: 0 },
            category
          ).rows,
        ])
      )
    )
  );
  invalidateFitnessCache();
}
loadQuality();
const toolRow = {
  tool_call: true,
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
  limit_output: 32_768,
  interleaved_field: null,
};
saveModelsDevCapabilities({
  "ollama-local": { "qwen3.6:27b": toolRow },
  syn: { a1: toolRow, a2: toolRow, a3: toolRow, a4: toolRow },
  synb: { b1: toolRow },
});
test.after(() => resetDbInstance());

const QF = (band = 0) =>
  fairSelectionSettings({ ROUTING_QUALITY_FIRST: "1", ROUTING_QUALITY_BAND: String(band) });
const TOOLS = [{ name: "Bash", input_schema: { type: "object" } }];
const ask = (content: string, session = "s1", tools = true) => ({
  stream: true,
  ...(tools && { tools: TOOLS }),
  metadata: { session_id: session },
  messages: [{ role: "user", content }],
});
type Cands = Parameters<typeof rankFitFirstFreeCandidates>[0]["candidates"];

async function build(
  ids: string[],
  env: Record<string, string> = {},
  resilience: unknown = null
): Promise<Cands> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
    return (await buildAutoCandidates(
      ids.map((id) => ({
        kind: "model",
        provider: id.slice(0, id.indexOf("/")),
        modelStr: id,
        stepId: id,
        executionKey: id,
        connectionId: null,
      })) as never,
      "x",
      null,
      undefined,
      resilience as never,
      true
    )) as never;
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
function rank(
  candidates: Cands,
  body: Record<string, unknown>,
  settings = QF(),
  extra: Partial<Parameters<typeof rankFitFirstFreeCandidates>[0]> = {}
) {
  return rankFitFirstFreeCandidates({
    candidates,
    body,
    zeroAdditionalCostProviders: [...new Set(candidates.map((c) => c.provider))],
    settings,
    ...extra,
  });
}
const id = (e: { candidate: { provider: string; model: string } }) =>
  `${e.candidate.provider}/${e.candidate.model}`;

// ───────────────────────────── D1 ─────────────────────────────

test("D1: with no measured candidate, quality-first falls back to the blended ranking; no band", async () => {
  const pool = [
    "nvidia/fastino/gliner2-pii",
    "nvidia/nvidia/riva-translate-4b-instruct-v2",
    "nvidia/nvidia/ising-calibration-1.5-31b",
  ];
  const c = await build(pool);
  const chat = { stream: true, messages: [{ role: "user", content: "Hello there." }] };
  const blended = rank(c, chat, fairSelectionSettings({}));
  const d = rank(c, chat, QF(0.1));
  assert.deepEqual(d.ranked.map(id), blended.ranked.map(id), "same order as the blended ranking");
  for (const e of d.ranked) {
    assert.equal(e.factors.qualityFallback, "no_measured_candidates");
    assert.equal(e.factors.rankingPolicy, undefined);
    assert.equal(e.factors.qualityBand, undefined, "no band is formed");
  }
  // And with the quality table empty, a normally measured pool falls back too.
  getDbInstance().prepare("DELETE FROM model_intelligence WHERE source = ?").run(QUALITY_SOURCE);
  invalidateFitnessCache();
  try {
    const empty = rank(
      await build(["claude/claude-opus-4-7", "groq/openai/gpt-oss-120b"]),
      chat,
      QF(0.1)
    );
    assert.ok(empty.ranked.every((e) => e.factors.qualityFallback === "no_measured_candidates"));
  } finally {
    loadQuality();
  }
});

// ───────────────────────────── D2 ─────────────────────────────

const BAND_POOL = [
  "claude/claude-opus-5-5",
  "github/claude-fable-5",
  "nvidia/z-ai/glm-5.3-flash",
  "codex/gpt-5.6-sol",
  "gemini/gemini-3.5-flash",
];
const TURNS = [
  "Continue with the next step.",
  "Debug the failing test in the parser.",
  "Review the diff before I merge it.",
  "Continue with the next step.",
];

test("D2: one conversation keeps its model across task categories while it stays in band", async () => {
  const c = await build(BAND_POOL);
  let switches = 0;
  for (let conv = 0; conv < 40; conv++) {
    const session = `conv-${conv}`;
    let prior: string | null = null;
    for (const turn of TURNS) {
      const d = rank(c, ask(turn, session), QF(0.035), { priorModel: prior });
      const winner = id(d.ranked[0]);
      if (prior) {
        const priorEntry = d.ranked.find((e) => id(e) === prior);
        if (priorEntry?.factors.qualityBandMember) {
          assert.equal(winner, prior, `${session}: kept while in band (${d.taskType})`);
          assert.equal(d.ranked[0].factors.qualityBandKeptPrior, true);
        } else {
          assert.notEqual(winner, prior, "re-picked only when the prior left the band");
          switches++;
        }
      }
      prior = winner;
    }
  }
  console.log(`D2: switches out of band across 40 conversations x 3 later turns: ${switches}`);
});

test("D2: categories differ between the turns, and a prior model outside the band is re-picked", async () => {
  const c = await build(BAND_POOL);
  const categories = TURNS.map(
    (turn) => rank(c, ask(turn, "k"), QF(0.035)).ranked[0].factors.qualityCategory
  );
  assert.ok(new Set(categories).size >= 2, `categories: ${categories}`);
  // band 0.01 holds only the top model; a prior outside it is not kept
  const d = rank(c, ask(TURNS[2], "k"), QF(0.01), { priorModel: "gemini/gemini-3.5-flash" });
  assert.notEqual(id(d.ranked[0]), "gemini/gemini-3.5-flash");
  assert.equal(d.ranked[0].factors.qualityBandKeptPrior, false);
});

test("D2: the prior model is re-picked away from when benched (broken now)", async () => {
  const c = await build(BAND_POOL);
  const first = id(rank(c, ask(TURNS[0], "b"), QF(0.035)).ranked[0]);
  const benched = c.map((cand) =>
    `${cand.provider}/${cand.model}` === first
      ? { ...cand, brokenNow: { reason: "broken_now_recent_failures" as const } }
      : cand
  );
  const d = rank(benched, ask(TURNS[1], "b"), QF(0.035), { priorModel: first });
  assert.notEqual(id(d.ranked[0]), first);
  assert.ok(d.excluded.some((e) => `${e.provider}/${e.model}` === first));
});

// ───────────────────────────── D3 ─────────────────────────────

test("D3: reduced-effort ids are unrated unless the leaderboard lists that exact effort", () => {
  for (const model of [
    "gpt-5.6-sol-low",
    "gpt-5.6-sol-minimal",
    "gpt-5.6-sol-none",
    "gpt-5.6-sol-medium",
  ]) {
    assert.ok(!candidateQualityKeys(model).includes("gpt-5-6-sol"), model);
    assert.equal(
      getTaskQualityWithSource("codex", model, "coding").source,
      "neutral_no_quality_data",
      model
    );
  }
  // higher effort and the plain id still map to the measured model
  assert.equal(getTaskQualityWithSource("codex", "gpt-5.6-sol-high", "coding").source, "lmarena");
  assert.equal(getTaskQualityWithSource("codex", "gpt-5.6-sol", "coding").source, "lmarena");
  // an exact listing of the effort is used ("GPT-5.6 Sol (xHigh)")
  assert.equal(
    getTaskQualityWithSource("codex", "gpt-5.6-sol-xhigh", "coding").key,
    "gpt-5-6-sol-xhigh"
  );
});

// ───────────────────────────── category ─────────────────────────────

test("category: a general request with tools, or with intent code, reads the coding leaderboard", async () => {
  assert.equal(qualityTaskFor("general", ["tools"], "medium"), "coding");
  assert.equal(qualityTaskFor("general", [], "code"), "coding");
  assert.equal(qualityTaskFor("general", [], "simple"), "general");
  assert.equal(
    qualityTaskFor("review", ["tools"], "code"),
    "review",
    "a specific task keeps its category"
  );
  const c = await build(["claude/claude-opus-4-7", "nvidia/z-ai/glm-5.3-flash"]);
  const withTools = rank(c, ask("Continue with the next step."));
  assert.equal(withTools.taskType, "general");
  assert.equal(withTools.ranked[0].factors.qualityCategory, "coding");
  const chat = rank(c, ask("Continue with the next step.", "s", false));
  assert.equal(chat.ranked[0].factors.qualityCategory, "default");
  const intent = rank(c, ask("Continue with the next step.", "s", false), QF(), {
    fallbackIntent: "code",
  });
  assert.equal(intent.ranked[0].factors.qualityCategory, "coding");
});

// ───────────────────────────── surviving mutants ─────────────────────────────

test("mutant: an unproven model never joins the band even when the pool minimum is inside it", async () => {
  // two measured models 0.003 apart; the unrated one sits at the pool minimum, inside a 0.1 band
  const c = await build(["claude/claude-opus-4-7", "claude/claude-opus-4-6", "groq/allam-2-7b"]);
  for (let i = 0; i < 40; i++) {
    const d = rank(c, ask("Implement a parser.", `u-${i}`, false), QF(0.1));
    const unrated = d.ranked.find((e) => e.candidate.model === "allam-2-7b")!;
    const top = d.ranked[0].factors.score;
    assert.ok(unrated.factors.score >= top - 0.1, "pool minimum is inside the band");
    assert.equal(unrated.factors.qualityBandMember, false);
    assert.equal(id(d.ranked.at(-1)!), "groq/allam-2-7b");
  }
});

test("mutant: the 24 h observed-failure veto does not apply under quality-first (only broken-now does)", async () => {
  const [c] = await build(["claude/claude-opus-4-7"]);
  const failing = {
    ...c,
    errorRate: 1,
    failureRate: 1,
    provenance: {
      ...c.provenance!,
      health: {
        ...c.provenance!.health,
        source: "usage_24h" as const,
        windowHours: 24,
        sampleCount: 40,
        evaluatedAt: new Date().toISOString(),
        errorClass: "provider_unavailable" as const,
      },
    },
  };
  const body = ask("Implement a parser.", "v", false);
  const off = rank([failing], body, fairSelectionSettings({}));
  assert.equal(off.excluded[0]?.reason, "observed_failure_rate", "base vetoes on 24 h history");
  const on = rank([failing], body, QF());
  assert.equal(on.excluded.length, 0, "quality-first: 24 h history does not exclude");
  assert.equal(on.ranked.length, 1);
});

test("mutant: local-last stays in the sort and out of the band", async () => {
  const c = await build([
    "ollama-local/qwen3.6:27b",
    "claude/claude-opus-4-7",
    "codex/gpt-5.6-sol",
  ]);
  setUserFitnessOverride("ollama-local/qwen3.6:27b", "coding", 0.99);
  try {
    for (let i = 0; i < 20; i++) {
      const d = rank(c, ask("Implement a parser.", `l-${i}`), QF(0.1), {
        localFallbackPolicy: "last",
      });
      assert.equal(id(d.ranked.at(-1)!), "ollama-local/qwen3.6:27b");
      assert.equal(d.ranked.at(-1)!.factors.qualityBandMember, false);
      assert.notEqual(id(d.ranked[0]), "ollama-local/qwen3.6:27b");
    }
  } finally {
    const { clearUserFitnessOverride } =
      await import("../../open-sse/services/autoCombo/taskFitness.ts");
    clearUserFitnessOverride("ollama-local/qwen3.6:27b", "coding");
  }
});

test("mutant: the provider-spread tie-break counts a provider once, not per listed model", async () => {
  const ids = ["syn/a1", "syn/a2", "syn/a3", "syn/a4", "synb/b1"];
  for (const m of ids) setUserFitnessOverride(m, "coding", 0.9);
  try {
    const c = await build(ids);
    let b = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      if (
        rank(c, ask("Implement a parser.", `t-${i}`), QF()).ranked[0].candidate.provider === "synb"
      )
        b++;
    }
    // spread: about 1/2; per-model hashing would give about 1/5
    assert.ok(b / n > 0.38 && b / n < 0.62, `synb share ${b / n}`);
  } finally {
    const { clearUserFitnessOverride } =
      await import("../../open-sse/services/autoCombo/taskFitness.ts");
    for (const m of ids) clearUserFitnessOverride(m, "coding");
  }
});

test("mutant: model lockout and provider cooldown are wired into the quality-first exclusion", async () => {
  recordModelLockoutFailure("claude", "", "claude-opus-4-7", "rate_limit", 429, 600_000);
  const locked = await build(["claude/claude-opus-4-7", "codex/gpt-5.6-sol"], {
    ROUTING_QUALITY_FIRST: "1",
  });
  const d = rank(locked, ask("Implement a parser."));
  assert.equal(
    d.excluded.find((e) => e.model === "claude-opus-4-7")?.reason,
    "broken_now_model_lockout"
  );

  const resilience = resolveResilienceSettings(null);
  resilience.providerCooldown = { ...resilience.providerCooldown, enabled: true };
  recordProviderCooldown("gemini", undefined, resilience);
  const cooled = await build(
    ["gemini/gemini-3.5-flash", "codex/gpt-5.6-sol"],
    { ROUTING_QUALITY_FIRST: "1" },
    resilience
  );
  const e = rank(cooled, ask("Implement a parser."));
  assert.equal(
    e.excluded.find((x) => x.provider === "gemini")?.reason,
    "broken_now_provider_cooldown"
  );
});

test("mutant: HTTP 499 rows are not real failures in the broken-now window", async () => {
  const db = getDbInstance();
  db.prepare("DELETE FROM usage_history").run();
  const insert = db.prepare(
    `INSERT INTO usage_history (provider, model, tokens_input, tokens_output, status, success,
       latency_ms, ttft_ms, error_code, timestamp) VALUES ('codex', 'gpt-5.6-sol', 1, 0, '499', 0, 9000, 0, NULL, ?)`
  );
  for (let i = 0; i < 4; i++) insert.run(new Date(Date.now() - (i + 1) * 60_000).toISOString());
  try {
    const c = await build(["codex/gpt-5.6-sol"], { ROUTING_QUALITY_FIRST: "1" });
    assert.equal(c[0].brokenNow, null);
  } finally {
    db.prepare("DELETE FROM usage_history").run();
  }
});
