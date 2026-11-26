/**
 * ROUTING_QUALITY_FIRST: auto-combo candidates ranked by task quality only; usage history may only
 * exclude a model that is broken right now. Also the two flags added with it on 2026-11-26:
 * ROUTING_LIGHT_TIER_SPLIT (the light-chat durable-evidence split, now off by default) and
 * ROUTING_CANARY_NOT_EVIDENCE (canary probe rows are not ranking evidence).
 *
 * Quality rows come from the recorded 2026-11-22 LMArena snapshot (tests/fixtures/quality); the
 * model ids are the live gateway's synced models of claude, codex, github, nvidia, gemini, groq and
 * ollama-local, captured read-only on 2026-11-26.
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
  candidateQualityKeys,
  canonicalQualityKey,
  leaderboardRowKeys,
} from "../../open-sse/services/autoCombo/qualityModelKey.ts";
import {
  NEUTRAL_QUALITY_SCORE,
  getTaskQualityWithSource,
  invalidateFitnessCache,
} from "../../open-sse/services/autoCombo/taskFitness.ts";
import { rankFitFirstFreeCandidates } from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { fairSelectionSettings } from "../../open-sse/services/autoCombo/fairSelectionSettings.ts";
import { deriveRequestClass } from "../../open-sse/services/autoCombo/requestClass.ts";
import { countRecentRealFailures } from "../../open-sse/services/autoCombo/qualityFirst.ts";

const SNAPSHOT = JSON.parse(
  fs.readFileSync(
    path.join(
      import.meta.dirname,
      "../fixtures/quality/lmarena-snapshot-20261122-live-models.json"
    ),
    "utf8"
  )
) as {
  liveModels: Record<string, string[]>;
  categories: Record<string, Array<Record<string, unknown>>>;
};

const FLAGS = [
  "ROUTING_QUALITY_FIRST",
  "ROUTING_DURABLE_EVIDENCE",
  "ROUTING_LIGHT_TIER_SPLIT",
  "ROUTING_CANARY_NOT_EVIDENCE",
];
function setFlags(flags: Record<string, boolean>) {
  for (const name of FLAGS) delete process.env[name];
  for (const [name, on] of Object.entries(flags)) if (on) process.env[name] = "1";
}

test.after(() => {
  setFlags({});
  resetDbInstance();
});

function loadQualityRows() {
  const snapshot = Object.fromEntries(
    QUALITY_CATEGORY_PLAN.map(({ category }) => [
      category,
      parseLeaderboardPage(
        { rows: SNAPSHOT.categories[category].map((row) => ({ row })), num_rows_total: 0 },
        category
      ).rows,
    ])
  );
  replaceModelIntelligenceBySource(QUALITY_SOURCE, transformQualitySnapshot(snapshot));
  invalidateFitnessCache();
}
loadQualityRows();

// ───────────────────────────── keys ─────────────────────────────

test("keys: provider ids and leaderboard names meet on one normalised key", () => {
  assert.deepEqual(candidateQualityKeys("claude-opus-4-7"), ["claude-opus-4-7"]);
  assert.equal(leaderboardRowKeys("Claude Opus 4.7").canonical, "claude-opus-4-7");
  assert.ok(candidateQualityKeys("gemini-2.5-flash").includes("gemini-2-5-flash"));
  assert.equal(leaderboardRowKeys("Gemini 2.5 Flash").canonical, "gemini-2-5-flash");
  assert.ok(candidateQualityKeys("openai/gpt-oss-120b").includes("gpt-oss-120b"));
  assert.ok(candidateQualityKeys("gpt-5.6-sol-high").includes("gpt-5-6-sol"));
  assert.ok(candidateQualityKeys("claude-opus-4.8-fast").includes("claude-opus-4-8"));
  assert.ok(candidateQualityKeys("qwen3.6:27b-q8_0").includes("qwen3-6-27b"));
  assert.equal(canonicalQualityKey("gemini-3-flash-preview"), "gemini-3-flash");
  const nv = leaderboardRowKeys("NVIDIA-Nemotron-3-Ultra-550B-A55B (NVFP4)", "nvidia");
  assert.ok(nv.withoutOrganization.includes("nemotron-3-ultra-550b-a55b"));
  assert.ok(
    candidateQualityKeys("nvidia/nemotron-3-ultra-550b-a55b").includes("nemotron-3-ultra-550b-a55b")
  );
  const dated = leaderboardRowKeys("Claude Haiku 4.5 (20251001)");
  assert.equal(dated.dated, "claude-haiku-4-5-20251001");
  assert.equal(dated.plain, true);
});

test("keys: words that name a different model are never stripped", () => {
  assert.ok(!candidateQualityKeys("gemini-2.5-flash-lite").includes("gemini-2-5-flash"));
  assert.ok(!candidateQualityKeys("gpt-4o-mini").includes("gpt-4o"));
  assert.equal(
    leaderboardRowKeys("Qwen3.8-Max").canonical,
    "qwen3-8-max",
    "a model name, not an effort"
  );
  assert.ok(candidateQualityKeys("qwen3.8-max").includes("qwen3-8-max"));
});

// ───────────────────────────── coverage ─────────────────────────────

test("coverage: every live model of the 7 providers gets a quality score or an explicit neutral", () => {
  const providers = ["claude", "codex", "github", "nvidia", "gemini", "groq", "ollama-local"];
  assert.deepEqual(Object.keys(SNAPSHOT.liveModels).sort(), [...providers].sort());
  const categories = ["default", "coding", "analysis", "math", "creative", "documentation"];
  const lines = [["provider", "model", "key", ...categories, "source"].join(" | ")];
  const sources = new Map<string, number>();
  for (const provider of providers) {
    for (const model of SNAPSHOT.liveModels[provider]) {
      const results = categories.map((c) =>
        getTaskQualityWithSource(provider, model, c === "default" ? "general" : c)
      );
      for (const r of results) {
        assert.ok(
          ["lmarena", "neutral_no_quality_data"].includes(r.source),
          `${provider}/${model} ${r.source}`
        );
        // The resolver's neutral; the ranker replaces it with the pool minimum (see the test below).
        if (r.source === "neutral_no_quality_data") assert.equal(r.score, NEUTRAL_QUALITY_SCORE);
        else assert.ok(r.score >= 0.4 && r.score <= 0.98);
      }
      const source = results[0].source;
      sources.set(source, (sources.get(source) ?? 0) + 1);
      lines.push(
        [
          provider,
          model,
          results[0].key ?? "-",
          ...results.map((r) => r.score.toFixed(3)),
          source,
        ].join(" | ")
      );
    }
  }
  console.log(`QUALITY COVERAGE REPORT (LMArena 2026-11-22)\n${lines.join("\n")}`);
  console.log("coverage by source:", JSON.stringify(Object.fromEntries(sources)));
  // Same model through two providers: one score (provider is never part of the key).
  assert.equal(
    getTaskQualityWithSource("claude", "claude-opus-5", "coding").score,
    getTaskQualityWithSource("github", "claude-opus-5", "coding").score
  );
  // Gemini and Groq are scored like everyone else.
  assert.equal(getTaskQualityWithSource("gemini", "gemini-2.5-flash", "coding").source, "lmarena");
  assert.equal(getTaskQualityWithSource("groq", "openai/gpt-oss-120b", "coding").source, "lmarena");
});

// ───────────────────────────── ranking ─────────────────────────────

const HOUR = 3_600_000;
const CODING_BODY = {
  stream: true,
  messages: [{ role: "user", content: "Implement a function that parses a CSV line." }],
};
const LIGHT_BODY = {
  stream: true,
  messages: [{ role: "user", content: "What time is it in Boston?" }],
};

function insertRows(
  provider: string,
  model: string,
  count: number,
  opts: {
    ok?: boolean;
    minutesAgo?: number;
    code?: string;
    source?: string | null;
    cls?: string;
  } = {}
) {
  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO usage_history (provider, model, tokens_input, tokens_output, status, success,
       latency_ms, ttft_ms, error_code, source, request_class, timestamp)
     VALUES (?, ?, 10, ?, ?, ?, 900, 100, ?, ?, ?, ?)`
  );
  const ok = opts.ok ?? true;
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(
        provider,
        model,
        ok ? 50 : 0,
        ok ? "200" : "502",
        ok ? 1 : 0,
        ok ? null : (opts.code ?? "upstream_error"),
        opts.source ?? null,
        opts.cls ?? "c0s",
        new Date(Date.now() - ((opts.minutesAgo ?? 5) * 60_000 + i * 1000)).toISOString()
      );
    }
  })();
}
const clearRows = () => getDbInstance().prepare("DELETE FROM usage_history").run();

type Pair = readonly [string, string];
async function assembleAndRank(pairs: Pair[], body: Record<string, unknown>) {
  const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
  const settings = fairSelectionSettings();
  const candidates = (await buildAutoCandidates(
    pairs.map(([provider, model]) => ({
      kind: "model",
      provider,
      modelStr: `${provider}/${model}`,
      stepId: `${provider}/${model}`,
      executionKey: `${provider}/${model}`,
      connectionId: null,
    })) as never,
    "quality-first-test",
    null,
    undefined,
    null,
    true,
    settings.durableEvidence ? { requestClass: deriveRequestClass(body) } : undefined
  )) as never as Parameters<typeof rankFitFirstFreeCandidates>[0]["candidates"];
  return rankFitFirstFreeCandidates({
    candidates,
    body,
    zeroAdditionalCostProviders: [...new Set(pairs.map(([p]) => p))],
    settings,
  });
}
type Decision = Awaited<ReturnType<typeof assembleAndRank>>;
const order = (d: Decision) => d.ranked.map((e) => `${e.candidate.provider}/${e.candidate.model}`);

const HIGH: Pair = ["claude", "claude-opus-4-7"];
const LOW: Pair = ["nvidia", "google/gemma-3-4b-it"];

test("flag on, identical history: the higher-quality model for the task wins", async () => {
  setFlags({ ROUTING_QUALITY_FIRST: true });
  clearRows();
  insertRows(...HIGH, 20);
  insertRows(...LOW, 20);
  const d = await assembleAndRank([LOW, HIGH], CODING_BODY);
  assert.equal(d.taskType, "coding");
  assert.equal(order(d)[0], HIGH.join("/"));
  const w = d.ranked[0].factors;
  assert.equal(w.rankingPolicy, "quality_first");
  assert.equal(w.qualitySource, "lmarena");
  assert.equal(w.qualityCategory, "coding");
  assert.equal(w.score, w.qualityScore);
  assert.equal(w.tieBreak, "spread_conversation_hash");
  assert.ok(w.qualityAgeHours !== null && w.qualityAgeHours! < 1);
  assert.equal(w.qualityStale, false);
  assert.ok(d.ranked[0].factors.score > d.ranked[1].factors.score);
  setFlags({});
});

test("flag on, 400 successes vs none: the higher-quality model still wins; history moves no score", async () => {
  setFlags({ ROUTING_QUALITY_FIRST: true, ROUTING_DURABLE_EVIDENCE: true });
  clearRows();
  insertRows(...LOW, 400);
  const d = await assembleAndRank([LOW, HIGH], CODING_BODY);
  assert.equal(order(d)[0], HIGH.join("/"));
  const low = d.ranked.find((e) => e.candidate.provider === LOW[0])!.factors;
  assert.equal(low.score, getTaskQualityWithSource(LOW[0], LOW[1], "coding").score);
  assert.equal(low.evidenceStatus, undefined, "durable evidence is off under quality-first");
  // the same pool with no history at all gives the same scores
  clearRows();
  const empty = await assembleAndRank([LOW, HIGH], CODING_BODY);
  assert.deepEqual(
    empty.ranked.map((e) => [e.candidate.model, e.factors.score]),
    d.ranked.map((e) => [e.candidate.model, e.factors.score])
  );
  setFlags({});
});

test("flag on: 3 real failures in 30 min exclude a model; it returns after the window", async () => {
  setFlags({ ROUTING_QUALITY_FIRST: true });
  clearRows();
  insertRows(...HIGH, 3, { ok: false, minutesAgo: 2 });
  const broken = await assembleAndRank([LOW, HIGH], CODING_BODY);
  assert.deepEqual(order(broken), [LOW.join("/")]);
  assert.equal(broken.excluded[0].reason, "broken_now_recent_failures");

  clearRows();
  insertRows(...HIGH, 3, { ok: false, minutesAgo: 31 });
  const later = await assembleAndRank([LOW, HIGH], CODING_BODY);
  assert.equal(order(later)[0], HIGH.join("/"), "exclusion lifted once the failures aged out");

  clearRows();
  insertRows(...HIGH, 2, { ok: false, minutesAgo: 2 });
  const two = await assembleAndRank([LOW, HIGH], CODING_BODY);
  assert.equal(order(two)[0], HIGH.join("/"), "two failures do not exclude");
  setFlags({});
});

test("flag on: client disconnects and gateway errors are not real failures", async () => {
  setFlags({ ROUTING_QUALITY_FIRST: true });
  clearRows();
  insertRows(...HIGH, 3, { ok: false, code: "client_disconnected" });
  insertRows(...HIGH, 3, { ok: false, code: "post_processing_error" });
  insertRows(...HIGH, 3, { ok: false, code: "routing_transport_replay_blocked" });
  const d = await assembleAndRank([LOW, HIGH], CODING_BODY);
  assert.equal(order(d)[0], HIGH.join("/"));
  assert.equal(d.excluded.length, 0);
  setFlags({});
});

test("flag on: Gemini and Groq compete equally (quality decides, ties use the spread hash)", async () => {
  setFlags({ ROUTING_QUALITY_FIRST: true });
  clearRows();
  const gemini: Pair = ["gemini", "gemini-2.5-flash"];
  const groq: Pair = ["groq", "openai/gpt-oss-120b"];
  const d = await assembleAndRank([groq, gemini], CODING_BODY);
  const g = getTaskQualityWithSource(...gemini, "coding").score;
  const q = getTaskQualityWithSource(...groq, "coding").score;
  console.log(`gemini-2.5-flash coding ${g}, gpt-oss-120b coding ${q}`);
  assert.equal(order(d)[0], (g >= q ? gemini : groq).join("/"));
  assert.equal(d.excluded.length, 0);
  // Order of input never matters
  const reversed = await assembleAndRank([gemini, groq], CODING_BODY);
  assert.deepEqual(order(reversed), order(d));
  // Exact quality tie between the two providers: the conversation hash decides, and history does
  // not, so 200 successes on one side do not change the winner.
  const { setUserFitnessOverride, clearUserFitnessOverride } =
    await import("../../open-sse/services/autoCombo/taskFitness.ts");
  setUserFitnessOverride(`${gemini[0]}/${gemini[1]}`, "coding", 0.8);
  setUserFitnessOverride(`${groq[0]}/${groq[1]}`, "coding", 0.8);
  try {
    const tie = await assembleAndRank([groq, gemini], CODING_BODY);
    insertRows(...groq, 200);
    insertRows(...gemini, 200, { ok: false, minutesAgo: 60 });
    const tieWithHistory = await assembleAndRank([groq, gemini], CODING_BODY);
    assert.equal(tie.ranked[0].factors.score, tie.ranked[1].factors.score);
    assert.deepEqual(order(tieWithHistory), order(tie));
    // across many conversations each provider wins some ties
    const winners = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const body = {
        ...CODING_BODY,
        messages: [{ role: "user", content: `Implement function ${i}.` }],
      };
      winners.add((await assembleAndRank([groq, gemini], body)).ranked[0].candidate.provider);
    }
    assert.deepEqual([...winners].sort(), ["gemini", "groq"]);
  } finally {
    clearUserFitnessOverride(`${gemini[0]}/${gemini[1]}`, "coding");
    clearUserFitnessOverride(`${groq[0]}/${groq[1]}`, "coding");
  }
  setFlags({});
});

test("flag on: an unproven (unrated) model sits at the pool minimum and never ties or beats a proven one", async () => {
  setFlags({ ROUTING_QUALITY_FIRST: true });
  clearRows();
  const unknown: Pair = ["groq", "allam-2-7b"];
  const mid: Pair = ["gemini", "gemini-2.5-flash"];
  const d = await assembleAndRank([unknown, LOW, HIGH, mid], CODING_BODY);
  const f = d.ranked.find((e) => e.candidate.model === unknown[1])!.factors;
  assert.equal(f.qualitySource, "neutral_no_quality_data");
  assert.equal(f.qualityNeutralBasis, "pool_min");
  // score = the weakest measured candidate's quality, and it is ordered after every measured one
  assert.equal(f.score, getTaskQualityWithSource(...LOW, "coding").score);
  assert.equal(order(d).at(-1), unknown.join("/"));
  for (let i = 0; i < 20; i++) {
    const body = { ...CODING_BODY, metadata: { session_id: `n-${i}` } };
    assert.equal(order(await assembleAndRank([unknown, LOW], body)).at(-1), unknown.join("/"));
  }
  const alone = await assembleAndRank([unknown], CODING_BODY);
  assert.equal(alone.ranked[0].factors.score, NEUTRAL_QUALITY_SCORE);
  assert.equal(alone.ranked[0].factors.qualityNeutralBasis, "scale_midpoint");
  setFlags({});
});

test("flag off: ranking is byte-identical whether or not quality rows exist", async () => {
  setFlags({});
  clearRows();
  insertRows(...LOW, 30);
  insertRows(...HIGH, 12, { ok: false, minutesAgo: 1 });
  const strip = (d: Decision) =>
    JSON.parse(JSON.stringify(d).replace(/"(evaluatedAt|acquiredAt)":"[^"]+"/g, '"$1":"-"'));
  const withRows = strip(await assembleAndRank([LOW, HIGH], CODING_BODY));
  getDbInstance().prepare("DELETE FROM model_intelligence WHERE source = ?").run(QUALITY_SOURCE);
  invalidateFitnessCache();
  const without = strip(await assembleAndRank([LOW, HIGH], CODING_BODY));
  loadQualityRows();
  assert.deepEqual(withRows, without);
  for (const e of withRows.ranked) assert.equal(e.factors.rankingPolicy, undefined);
});

test("settings: quality-first overrides durable evidence; new flags default off", () => {
  const off = fairSelectionSettings({});
  assert.equal(off.qualityFirst, false);
  assert.equal(off.lightTierSplit, false);
  assert.equal(off.canaryNotEvidence, false);
  assert.equal(fairSelectionSettings({ ROUTING_DURABLE_EVIDENCE: "1" }).durableEvidence, true);
  assert.equal(
    fairSelectionSettings({ ROUTING_DURABLE_EVIDENCE: "1", ROUTING_QUALITY_FIRST: "1" })
      .durableEvidence,
    false
  );
});

// ───────────── ROUTING_QUALITY_FIRST x ROUTING_LIGHT_TIER_SPLIT, durable evidence on (live) ─────────────

for (const qualityFirst of [false, true]) {
  for (const split of [false, true]) {
    test(`flags: DURABLE=1 QUALITY_FIRST=${Number(qualityFirst)} LIGHT_TIER_SPLIT=${Number(split)}, light c0s request`, async () => {
      setFlags({
        ROUTING_DURABLE_EVIDENCE: true,
        ROUTING_QUALITY_FIRST: qualityFirst,
        ROUTING_LIGHT_TIER_SPLIT: split,
      });
      clearRows();
      insertRows(...LOW, 20, { cls: "c0s" });
      insertRows(...HIGH, 20, { cls: "c0s" });
      assert.equal(deriveRequestClass(LIGHT_BODY), "c0s");
      const d = await assembleAndRank([LOW, HIGH], LIGHT_BODY);
      const statuses = new Set(d.ranked.map((e) => e.factors.evidenceStatus));
      const sources = new Set(d.ranked.map((e) => e.factors.reliabilitySource));
      console.log(
        `DURABLE=1 QF=${Number(qualityFirst)} SPLIT=${Number(split)}:`,
        JSON.stringify({
          statuses: [...statuses],
          sources: [...sources],
          policy: d.ranked[0].factors.rankingPolicy ?? "blended",
        })
      );
      if (qualityFirst) {
        // history does not rank; the split is irrelevant
        assert.deepEqual([...statuses], [undefined]);
        assert.ok(d.ranked.every((e) => e.factors.rankingPolicy === "quality_first"));
      } else if (split) {
        assert.deepEqual(
          [...statuses],
          ["light_tier_24h"],
          "today's split: light takes the 24 h path"
        );
        assert.ok(!sources.has("usage_durable"));
      } else {
        assert.deepEqual([...statuses], ["active"], "no split: light uses the same durable logic");
        assert.ok(sources.has("usage_durable"));
      }
    });
  }
}

// ───────────────────────────── ROUTING_CANARY_NOT_EVIDENCE ─────────────────────────────

for (const canaryOff of [false, true]) {
  test(`canary rows as evidence: ROUTING_CANARY_NOT_EVIDENCE=${Number(canaryOff)}`, async () => {
    const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
    const target = [
      {
        kind: "model",
        provider: "nvidia",
        modelStr: "nvidia/x",
        stepId: "x",
        executionKey: "x",
        connectionId: null,
      },
    ] as never;
    clearRows();
    insertRows("nvidia", "x", 15, { source: "routing-canary", cls: "c0s" });
    // 24 h path (durable off)
    setFlags({ ROUTING_CANARY_NOT_EVIDENCE: canaryOff });
    const [h24] = (await buildAutoCandidates(target, "x", null, undefined, null, true)) as Array<{
      provenance: { health: { source: string; sampleCount: number | null } };
    }>;
    // durable path
    setFlags({ ROUTING_CANARY_NOT_EVIDENCE: canaryOff, ROUTING_DURABLE_EVIDENCE: true });
    const [durable] = (await buildAutoCandidates(target, "x", null, undefined, null, true, {
      requestClass: "c0s",
    })) as Array<{
      provenance: { health: { source: string } };
      durableEvidence?: { rowsUsed?: number };
    }>;
    // class evidence path
    setFlags({ ROUTING_CANARY_NOT_EVIDENCE: canaryOff, ROUTING_CLASS_EVIDENCE: true } as never);
    process.env.ROUTING_CLASS_EVIDENCE = "1";
    const [cls] = (await buildAutoCandidates(target, "x", null, undefined, null, true)) as Array<{
      classEvidencePool?: { classifiedRows: number };
    }>;
    delete process.env.ROUTING_CLASS_EVIDENCE;
    setFlags({});
    if (canaryOff) {
      assert.equal(h24.provenance.health.source, "bootstrap", "24 h stats ignore probe rows");
      assert.equal(durable.durableEvidence?.rowsUsed, 0, "durable reader ignores probe rows");
      assert.equal(
        cls.classEvidencePool?.classifiedRows ?? 0,
        0,
        "class evidence ignores probe rows"
      );
    } else {
      assert.equal(
        h24.provenance.health.source,
        "usage_24h",
        "default: probe rows count (as live today)"
      );
      assert.equal(h24.provenance.health.sampleCount, 15);
      assert.ok((durable.durableEvidence?.rowsUsed ?? 0) >= 15);
      assert.ok((cls.classEvidencePool?.classifiedRows ?? 0) >= 15);
    }
  });
}

test("broken-now window ignores canary rows only when ROUTING_CANARY_NOT_EVIDENCE is on", () => {
  const now = Date.now();
  const rows = [0, 1, 2].map((i) => ({
    provider: "nvidia",
    model: "x",
    success: false,
    errorCode: "upstream_503",
    source: "routing-canary",
    timestamp: new Date(now - i * 60_000).toISOString(),
  }));
  assert.equal(countRecentRealFailures(rows, { now }).get("nvidia/x"), 3);
  assert.equal(
    countRecentRealFailures(rows, { now, excludeRoutingCanary: true }).get("nvidia/x"),
    undefined
  );
});
