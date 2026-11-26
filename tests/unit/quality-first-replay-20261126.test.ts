/**
 * Replays of the 2026-11-26 terminal decisions with ROUTING_QUALITY_FIRST on, through the
 * production assembly (buildAutoCandidates) and ranker (rankFitFirstFreeCandidates).
 *
 * History: the real usage rows of the durable-evidence replays (tests/fixtures/routing), shifted so
 * the decision time is now. Pools: the live decision's winner plus its recorded alternatives
 * (routing_decisions, read-only): 03:01:19Z t2s and 05:55:40Z c2n; the light c0s case uses the
 * 03:01 pool plus the Gemini and Groq models. Quality: the recorded 2026-11-22 LMArena snapshot.
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
import { invalidateFitnessCache } from "../../open-sse/services/autoCombo/taskFitness.ts";
import { rankFitFirstFreeCandidates } from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { fairSelectionSettings } from "../../open-sse/services/autoCombo/fairSelectionSettings.ts";
import { deriveRequestClass } from "../../open-sse/services/autoCombo/requestClass.ts";

type FixtureRow = [
  string,
  string,
  number,
  number,
  string | null,
  string | null,
  string,
  (string | null)?,
];
const read = (dir: string, name: string) =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../fixtures", dir, name), "utf8"));
const T2S = read("routing", "terminal-lockin-20261126.json") as {
  decisionAt: string;
  rows: FixtureRow[];
};
const C2N = read("routing", "terminal-c2n-20261126.json") as {
  decisionAt: string;
  rows: FixtureRow[];
};
const SNAPSHOT = read("quality", "lmarena-snapshot-20261122-live-models.json") as {
  categories: Record<string, Array<Record<string, unknown>>>;
};

test.after(() => {
  for (const f of ["ROUTING_QUALITY_FIRST", "ROUTING_DURABLE_EVIDENCE"]) delete process.env[f];
  resetDbInstance();
});

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

function load(rows: FixtureRow[], decisionAt: string) {
  const db = getDbInstance();
  db.prepare("DELETE FROM usage_history").run();
  const cutoff = Date.parse(decisionAt);
  const shift = Date.now() - cutoff;
  const insert = db.prepare(
    `INSERT INTO usage_history (provider, model, tokens_input, tokens_output, status, success,
       latency_ms, ttft_ms, error_code, source, request_class, timestamp)
     VALUES (?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const [provider, model, ok, ms, cls, source, ts, code] of rows) {
      if (Date.parse(ts) >= cutoff) continue;
      insert.run(
        provider,
        model,
        ok ? 50 : 0,
        ok ? "200" : "502",
        ok,
        ms,
        ok ? null : (code ?? "upstream_error"),
        source,
        cls,
        new Date(Date.parse(ts) + shift).toISOString()
      );
    }
  })();
}

const POOL_0301 = [
  "nvidia/mistralai/mistral-large-4-1t-a52b",
  "codex/gpt-5.6-sol",
  "claude/claude-opus-4-8",
  "claude/claude-haiku-5-5",
  "claude/claude-opus-5-5",
  "nvidia/stepfun-ai/step-5-preview",
];
const POOL_0555 = [
  "nvidia/mistralai/mistral-large-4-1t-a52b",
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/minimaxai/minimax-m3.1-flash",
  "claude/claude-opus-4-7",
  "github/claude-fable-5",
];
const LIGHT_POOL = [
  ...POOL_0301,
  "gemini/gemini-3.5-flash",
  "gemini/gemini-2.5-flash",
  "groq/openai/gpt-oss-120b",
];

const TERMINAL_BODY = {
  stream: true,
  max_tokens: 32000,
  tools: [
    {
      name: "Bash",
      description: "Run a shell command",
      input_schema: { type: "object", properties: { command: { type: "string" } } },
    },
  ],
  messages: [{ role: "user", content: "Continue the refactor and run the tests. ".repeat(3_500) }],
};
const COMPACTION_BODY = {
  stream: false,
  max_tokens: 20000,
  messages: [
    { role: "user", content: "Summarise the conversation so far for compaction. ".repeat(3_000) },
  ],
};
const LIGHT_BODY = {
  stream: true,
  messages: [{ role: "user", content: "What time is it in Boston?" }],
};

async function replay(pool: string[], body: Record<string, unknown>, qualityFirst: boolean) {
  process.env.ROUTING_DURABLE_EVIDENCE = "1"; // as live
  if (qualityFirst) process.env.ROUTING_QUALITY_FIRST = "1";
  else delete process.env.ROUTING_QUALITY_FIRST;
  try {
    const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
    const settings = fairSelectionSettings();
    const targets = pool.map((id) => {
      const provider = id.slice(0, id.indexOf("/"));
      return {
        kind: "model",
        provider,
        modelStr: id,
        stepId: id,
        executionKey: id,
        connectionId: null,
      };
    });
    const candidates = (await buildAutoCandidates(
      targets as never,
      "ac-terminal-continuity",
      null,
      undefined,
      null,
      true,
      settings.durableEvidence ? { requestClass: deriveRequestClass(body) } : undefined
    )) as never as Parameters<typeof rankFitFirstFreeCandidates>[0]["candidates"];
    return rankFitFirstFreeCandidates({
      candidates,
      body,
      zeroAdditionalCostProviders: [...new Set(pool.map((id) => id.slice(0, id.indexOf("/"))))],
      settings,
    });
  } finally {
    delete process.env.ROUTING_QUALITY_FIRST;
    delete process.env.ROUTING_DURABLE_EVIDENCE;
  }
}

const CASES = [
  {
    name: "t2s 03:01:19Z",
    rows: T2S.rows,
    at: T2S.decisionAt,
    body: TERMINAL_BODY,
    pool: POOL_0301,
    cls: "t2s",
  },
  {
    name: "c2n 05:55Z",
    rows: C2N.rows,
    at: C2N.decisionAt,
    body: COMPACTION_BODY,
    pool: POOL_0555,
    cls: "c2n",
  },
  {
    name: "c0s light",
    rows: C2N.rows,
    at: C2N.decisionAt,
    body: LIGHT_BODY,
    pool: LIGHT_POOL,
    cls: "c0s",
  },
];

for (const c of CASES) {
  test(`replay ${c.name}, ROUTING_QUALITY_FIRST on: the highest task quality wins`, async () => {
    assert.equal(deriveRequestClass(c.body), c.cls);
    load(c.rows, c.at);
    const off = await replay(c.pool, c.body, false);
    load(c.rows, c.at);
    const on = await replay(c.pool, c.body, true);
    const brief = (d: typeof on) =>
      d.ranked.map(
        (e) =>
          `${e.candidate.provider}/${e.candidate.model} ${e.factors.score.toFixed(4)} ${e.factors.qualitySource ?? ""}`
      );
    console.log(`${c.name} task=${on.taskType} OFF(live flags):\n  ${brief(off).join("\n  ")}`);
    console.log(`${c.name} task=${on.taskType} ON:\n  ${brief(on).join("\n  ")}`);
    const winner = on.ranked[0].factors;
    assert.equal(winner.rankingPolicy, "quality_first");
    for (const e of on.ranked) assert.ok(e.factors.score <= winner.score);
    assert.ok(on.ranked.every((e) => e.factors.evidenceStatus === undefined));
    assert.notEqual(on.ranked[0].candidate.model, "mistralai/mistral-large-4-1t-a52b");
  });
}
