/**
 * ROUTING_QUALITY_BAND (with ROUTING_QUALITY_FIRST): candidates within `band` of the top task
 * quality count as equal quality and the provider-spread conversation hash picks among them.
 * Quality rows: the recorded 2026-11-22 LMArena snapshot (tests/fixtures/quality).
 */
import "../../scripts/tools/replayIsolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resetDbInstance } from "@/lib/db/core";
import { replaceModelIntelligenceBySource } from "../../src/lib/db/modelIntelligence.ts";
import {
  QUALITY_CATEGORY_PLAN,
  QUALITY_SOURCE,
  parseLeaderboardPage,
  transformQualitySnapshot,
} from "../../src/lib/qualityScoreSync.ts";
import { invalidateFitnessCache } from "../../open-sse/services/autoCombo/taskFitness.ts";
import { saveModelsDevCapabilities } from "../../src/lib/modelsDevSync.ts";
import { rankFitFirstFreeCandidates } from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { fairSelectionSettings } from "../../open-sse/services/autoCombo/fairSelectionSettings.ts";

const SNAPSHOT = JSON.parse(
  fs.readFileSync(
    path.join(
      import.meta.dirname,
      "../fixtures/quality/lmarena-snapshot-20261122-live-models.json"
    ),
    "utf8"
  )
) as { categories: Record<string, Array<Record<string, unknown>>> };

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
// Tool verdicts as the live catalog resolves them (read-only check of the live DB, 2026-11-26:
// these three resolve supportsTools = true there; the test DB has no catalog of its own).
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
  limit_context: 131_072,
  limit_input: null,
  limit_output: 32_768,
  interleaved_field: null,
};
saveModelsDevCapabilities({
  nvidia: { "moonshotai/kimi-k3.1-pro": toolRow },
  groq: { "openai/gpt-oss-120b": toolRow, "qwen/qwen3.8-27b": toolRow },
});
test.after(() => resetDbInstance());

// The terminal (t2s) pool on a coding ask, with Gemini and Groq now allowed.
const POOL = [
  "claude/claude-opus-5-5",
  "claude/claude-opus-4-8",
  "github/claude-fable-5",
  "codex/gpt-5.6-sol",
  "gemini/gemini-3.5-flash",
  "nvidia/z-ai/glm-5.3-flash",
  "nvidia/moonshotai/kimi-k3.1-pro",
  "nvidia/mistralai/mistral-large-4-1t-a52b",
  "groq/qwen/qwen3.8-27b",
  "groq/openai/gpt-oss-120b",
];
const TOOLS = [
  {
    name: "Bash",
    description: "Run a shell command",
    input_schema: { type: "object", properties: { command: { type: "string" } } },
  },
];
const codingBody = (conversation: string, turn = 0) => ({
  stream: true,
  tools: TOOLS,
  metadata: { session_id: conversation },
  messages: [
    { role: "user", content: "Implement a function that parses a CSV line." },
    ...Array.from({ length: turn }, (_, i) => [
      { role: "assistant", content: `Step ${i} done.` },
      { role: "user", content: `Now implement step ${i + 1} of the parser.` },
    ]).flat(),
  ],
});

let candidates: Parameters<typeof rankFitFirstFreeCandidates>[0]["candidates"];
async function pool() {
  if (candidates) return candidates;
  const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
  candidates = (await buildAutoCandidates(
    POOL.map((id) => ({
      kind: "model",
      provider: id.slice(0, id.indexOf("/")),
      modelStr: id,
      stepId: id,
      executionKey: id,
      connectionId: null,
    })) as never,
    "ac-terminal-continuity",
    null,
    undefined,
    null,
    true
  )) as never;
  return candidates;
}

function rank(band: number, body: Record<string, unknown>, conversationKey?: string) {
  const settings = fairSelectionSettings({
    ROUTING_QUALITY_FIRST: "1",
    ROUTING_QUALITY_BAND: String(band),
  });
  return rankFitFirstFreeCandidates({
    candidates,
    body,
    zeroAdditionalCostProviders: [...new Set(POOL.map((id) => id.slice(0, id.indexOf("/"))))],
    settings,
    ...(conversationKey !== undefined && { conversationKey }),
  });
}
const id = (e: { candidate: { provider: string; model: string } }) =>
  `${e.candidate.provider}/${e.candidate.model}`;

test("settings: ROUTING_QUALITY_BAND defaults to 0 and is capped at 0.1", () => {
  assert.equal(fairSelectionSettings({}).qualityBand, 0);
  assert.equal(fairSelectionSettings({ ROUTING_QUALITY_BAND: "0.03" }).qualityBand, 0.03);
  assert.equal(fairSelectionSettings({ ROUTING_QUALITY_BAND: "5" }).qualityBand, 0.1);
  assert.equal(fairSelectionSettings({ ROUTING_QUALITY_BAND: "-1" }).qualityBand, 0);
});

test("band 0 picks the strict best for every conversation", async () => {
  await pool();
  const d0 = rank(0, codingBody("c0"));
  assert.equal(d0.taskType, "coding");
  const best = Math.max(...d0.ranked.map((e) => e.factors.score));
  for (let i = 0; i < 50; i++) {
    const d = rank(0, codingBody(`conv-${i}`));
    assert.equal(d.ranked[0].factors.score, best);
    assert.equal(id(d.ranked[0]), id(d0.ranked[0]));
    assert.equal(d.ranked[0].factors.qualityBand, undefined);
  }
});

test("band 0.03 / 0.05 spread the pick across providers for different conversations", async () => {
  await pool();
  const winners = (band: number) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const w = rank(band, codingBody(`conv-${i}`)).ranked[0].candidate.provider;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    return counts;
  };
  const at3 = winners(0.03);
  assert.ok(at3.size >= 2, JSON.stringify([...at3]));
  const at5 = winners(0.05);
  for (const provider of ["claude", "codex", "gemini", "nvidia"]) {
    assert.ok(
      (at5.get(provider) ?? 0) > 0,
      `${provider} wins some at 0.05: ${JSON.stringify([...at5])}`
    );
  }
  const d = rank(0.03, codingBody("conv-x"));
  const w = d.ranked[0].factors;
  assert.equal(w.qualityBand, 0.03);
  assert.equal(w.qualityBandMember, true);
  assert.equal(w.qualityBandWinner, id(d.ranked[0]));
  assert.ok(w.qualityBandSize! >= 2);
  const top = Math.max(...d.ranked.map((e) => e.factors.score));
  for (const e of d.ranked) {
    assert.equal(e.factors.qualityBandMember, e.factors.score >= top - 0.03 - 1e-9);
  }
});

test("one conversation keeps the same model every turn", async () => {
  await pool();
  for (let c = 0; c < 20; c++) {
    const picks = new Set<string>();
    for (let turn = 0; turn < 6; turn++)
      picks.add(id(rank(0.05, codingBody(`term-${c}`, turn)).ranked[0]));
    assert.equal(picks.size, 1, `conversation term-${c} hopped: ${[...picks]}`);
  }
});

test("an unproven (neutral) model is never in the band while a measured candidate exists", async () => {
  await pool();
  const mistral = "nvidia/mistralai/mistral-large-4-1t-a52b";
  for (const band of [0.01, 0.03, 0.05, 0.1]) {
    const d = rank(band, codingBody("n"));
    const m = d.ranked.find((e) => id(e) === mistral)!;
    assert.equal(m.factors.qualitySource, "neutral_no_quality_data");
    assert.equal(m.factors.qualityNeutralBasis, "pool_min");
    assert.equal(m.factors.qualityBandMember, false, `band ${band}`);
    assert.equal(id(d.ranked.at(-1)!), mistral, "last after every measured candidate");
  }
});

test("distribution: share per provider over 1,000 conversation ids", async () => {
  await pool();
  const d0 = rank(0, codingBody("x"));
  console.log(
    "coding pool scores:",
    d0.ranked
      .map(
        (e) =>
          `${id(e)}=${e.factors.score.toFixed(4)}${e.factors.qualitySource?.startsWith("neutral") ? "(neutral)" : ""}`
      )
      .join(", ")
  );
  console.log(
    "excluded:",
    JSON.stringify(d0.excluded.map((e) => `${e.provider}/${e.model}:${e.reason}`))
  );
  const rows: string[] = [];
  for (const band of [0, 0.02, 0.03, 0.035, 0.05]) {
    const byProvider = new Map<string, number>();
    const byModel = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const w = rank(band, codingBody(`synthetic-${i}`)).ranked[0];
      byProvider.set(w.candidate.provider, (byProvider.get(w.candidate.provider) ?? 0) + 1);
      byModel.set(id(w), (byModel.get(id(w)) ?? 0) + 1);
    }
    const pct = (m: Map<string, number>) =>
      [...m]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${(v / 10).toFixed(1)}%`)
        .join(", ");
    rows.push(`band ${band}: providers [${pct(byProvider)}] models [${pct(byModel)}]`);
  }
  console.log(`QUALITY BAND DISTRIBUTION (coding, tools, 1000 conversations)\n${rows.join("\n")}`);
});
