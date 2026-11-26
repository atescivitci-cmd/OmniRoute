/**
 * The quality-score feed (src/lib/qualityScoreSync.ts): LMArena leaderboard via the Hugging Face
 * datasets-server. Replaces the dead api.wulong.dev Arena feed (HTTP 404 since 2026-11-18).
 *
 * Fixtures are real responses (tests/fixtures/quality): one /filter page as returned, and the
 * 2026-11-22 leaderboard trimmed to the rows of live gateway models plus each category's extremes.
 */
import "../../scripts/tools/replayIsolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDbInstance, resetDbInstance } from "@/lib/db/core";
import {
  QUALITY_CATEGORY_PLAN,
  QUALITY_SOURCE,
  _resetQualityScoreSyncState,
  fetchLeaderboardCategory,
  getQualityScoreSyncStatus,
  leaderboardPageUrl,
  parseLeaderboardPage,
  scoreLeaderboardCategory,
  syncQualityScores,
  transformQualitySnapshot,
  type FetchLike,
} from "../../src/lib/qualityScoreSync.ts";

const FIXTURES = path.join(import.meta.dirname, "../fixtures/quality");
const PAGE = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "lmarena-filter-coding-page.json"), "utf8")
);
const SNAPSHOT = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "lmarena-snapshot-20261122-live-models.json"), "utf8")
) as { categories: Record<string, Array<Record<string, unknown>>> };

test.after(() => {
  _resetQualityScoreSyncState();
  resetDbInstance();
});

/** A fake datasets-server that pages the trimmed snapshot exactly as /filter does. */
function fakeServer(overrides: { failCategory?: string; status?: number } = {}): {
  fetch: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    const params = new URL(url).searchParams;
    const category = /'([^']+)'/.exec(params.get("where") ?? "")?.[1] ?? "";
    if (overrides.failCategory === category) {
      return {
        ok: false,
        status: overrides.status ?? 404,
        statusText: "Not Found",
        text: async () => "{}",
      };
    }
    const rows = SNAPSHOT.categories[category] ?? [];
    const offset = Number(params.get("offset"));
    const length = Number(params.get("length"));
    const body = {
      features: PAGE.features,
      rows: rows.slice(offset, offset + length).map((row, i) => ({
        row_idx: offset + i,
        row,
        truncated_cells: [],
      })),
      num_rows_total: rows.length,
      num_rows_per_page: length,
      partial: false,
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch: fetchImpl, urls };
}

function storedRows(): number {
  return Number(
    (
      getDbInstance()
        .prepare("SELECT COUNT(*) AS n FROM model_intelligence WHERE source = ?")
        .get(QUALITY_SOURCE) as { n: number }
    ).n
  );
}

test("parser: reads the recorded real /filter page", () => {
  const { rows, total } = parseLeaderboardPage(PAGE, "coding");
  assert.equal(total, 422);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => row.modelName),
    [
      "Gemini 4 Carbon (High)",
      "Gemini 4 Neon (High)",
      "Claude Opus 5.5 (High)",
      "Gemini 4 Argon (High)",
    ]
  );
  assert.equal(rows[0].organization, "google");
  assert.equal(rows[0].publishDate, "2026-11-22");
  assert.ok(rows.every((row) => Number.isFinite(row.rating) && row.rating > 1000));
  assert.ok(rows[0].rating >= rows[1].rating);
});

test("parser: rejects a page of another category, a missing rows array and a bad rating", () => {
  assert.throws(() => parseLeaderboardPage(PAGE, "math"), /category coding, not math/);
  assert.throws(() => parseLeaderboardPage({ num_rows_total: 1 }, "coding"), /no rows/);
  const bad = structuredClone(PAGE);
  bad.rows[0].row.rating = "n/a";
  assert.throws(() => parseLeaderboardPage(bad, "coding"), /non-numeric rating/);
});

test("request URL is the documented keyless datasets-server filter query", () => {
  const url = new URL(leaderboardPageUrl("coding", 200));
  assert.equal(url.origin + url.pathname, "https://datasets-server.huggingface.co/filter");
  assert.equal(url.searchParams.get("dataset"), "lmarena-ai/leaderboard-dataset");
  assert.equal(url.searchParams.get("config"), "text");
  assert.equal(url.searchParams.get("split"), "latest");
  assert.equal(url.searchParams.get("where"), `"category"='coding'`);
  assert.equal(url.searchParams.get("offset"), "200");
  assert.equal(url.searchParams.get("length"), "100");
});

test("fetch pages until num_rows_total and checks the count", async () => {
  const server = fakeServer();
  const rows = await fetchLeaderboardCategory("coding", server.fetch);
  assert.equal(rows.length, SNAPSHOT.categories.coding.length);
  assert.ok(server.urls.length >= 1);
});

test("transform: min-max 0.4..0.98 per category, stored under every task category of the plan", () => {
  const snapshot = Object.fromEntries(
    QUALITY_CATEGORY_PLAN.map(({ category }) => [
      category,
      parseLeaderboardPage(
        { rows: SNAPSHOT.categories[category].map((row) => ({ row })), num_rows_total: 0 },
        category
      ).rows,
    ])
  );
  const entries = transformQualitySnapshot(snapshot);
  const tasks = new Set(entries.map((entry) => entry.category));
  assert.deepEqual([...tasks].sort(), [
    "analysis",
    "coding",
    "creative",
    "debugging",
    "default",
    "documentation",
    "math",
    "planning",
    "review",
  ]);
  for (const entry of entries) {
    assert.equal(entry.source, QUALITY_SOURCE);
    assert.equal(entry.expiresAt, null, "quality rows never expire");
    assert.ok(entry.score >= 0.4 && entry.score <= 0.98, `${entry.model} ${entry.score}`);
  }
  const overall = scoreLeaderboardCategory(snapshot.overall);
  assert.equal(Math.max(...[...overall.values()].map((v) => v.score)), 0.98);
  assert.equal(Math.min(...[...overall.values()].map((v) => v.score)), 0.4);
});

test("transform: a plain listing wins over effort variants; variants alone are averaged", () => {
  const row = (modelName: string, rating: number) => ({
    modelName,
    organization: "x",
    rating,
    voteCount: 5000,
    rank: 1,
    category: "overall",
    publishDate: "2026-11-22",
  });
  const scored = scoreLeaderboardCategory([
    row("Low Model", 1000),
    row("Top Model", 1500),
    row("Model 4.6", 1200),
    row("Model 4.6 (High)", 1400),
    row("Other 5 (High)", 1300),
    row("Other 5 (Max)", 1400),
  ]);
  const at = (rating: number) => 0.4 + 0.58 * ((rating - 1000) / 500);
  assert.equal(scored.get("model-4-6")!.score, Math.round(at(1200) * 1e4) / 1e4, "plain row only");
  assert.equal(
    scored.get("model-4-6-high")!.score,
    Math.round(at(1400) * 1e4) / 1e4,
    "exact variant"
  );
  assert.equal(
    scored.get("other-5")!.score,
    Math.round(((at(1300) + at(1400)) / 2) * 1e4) / 1e4,
    "no plain row: mean of variants"
  );
});

test("sync stores the snapshot; status is fresh", async () => {
  _resetQualityScoreSyncState();
  const result = await syncQualityScores({ fetchImpl: fakeServer().fetch });
  assert.equal(result.success, true, result.error);
  assert.equal(result.leaderboardPublishDate, "2026-11-22");
  assert.equal(storedRows(), result.rowCount);
  const status = getQualityScoreSyncStatus();
  assert.equal(status.state, "fresh");
  assert.equal(status.stale, false);
  assert.equal(status.storedRows, result.rowCount);
  assert.equal(status.consecutiveFailures, 0);
  assert.ok(status.dataAgeHours !== null && status.dataAgeHours < 1);
});

test("a failed sync keeps the last good rows, logs at error level and reports failing", async () => {
  _resetQualityScoreSyncState();
  await syncQualityScores({ fetchImpl: fakeServer().fetch });
  const before = storedRows();
  assert.ok(before > 0);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    const result = await syncQualityScores({
      fetchImpl: fakeServer({ failCategory: "math" }).fetch,
    });
    assert.equal(result.success, false);
    assert.match(result.error!, /"math" page 0 returned HTTP 404/);
    assert.equal(result.keptRows, before);
  } finally {
    console.error = original;
  }
  assert.equal(storedRows(), before, "nothing was deleted or partially replaced");
  assert.ok(
    errors.some((line) => /\[QUALITY_SYNC\] FAILED .*Keeping \d+ last-good quality rows/.test(line))
  );
  const status = getQualityScoreSyncStatus();
  assert.equal(status.state, "failing");
  assert.equal(status.stale, true);
  assert.equal(status.consecutiveFailures, 1);
  assert.match(status.lastError!, /HTTP 404/);
});

test("kept rows older than 48 h are reported stale with their age; they never expire", async () => {
  _resetQualityScoreSyncState();
  await syncQualityScores({ fetchImpl: fakeServer().fetch });
  getDbInstance()
    .prepare(
      "UPDATE model_intelligence SET synced_at = datetime('now', '-72 hours') WHERE source = ?"
    )
    .run(QUALITY_SOURCE);
  const status = getQualityScoreSyncStatus();
  assert.equal(status.state, "stale");
  assert.ok(Math.abs(status.dataAgeHours! - 72) < 0.2, String(status.dataAgeHours));
  const { getQualityScoreByKeys } = await import("../../src/lib/db/modelIntelligence.ts");
  assert.ok(
    getQualityScoreByKeys(["gpt-oss-120b"], "coding", QUALITY_SOURCE),
    "old rows still read"
  );
});

test("with no rows ever stored the status says never_synced", () => {
  _resetQualityScoreSyncState();
  getDbInstance().prepare("DELETE FROM model_intelligence WHERE source = ?").run(QUALITY_SOURCE);
  assert.equal(getQualityScoreSyncStatus().state, "never_synced");
});

test("the base resolver never reads the new source (flag-off ranking unchanged by the feed)", async () => {
  _resetQualityScoreSyncState();
  await syncQualityScores({ fetchImpl: fakeServer().fetch });
  const { getModelIntelligence } = await import("../../src/lib/db/modelIntelligence.ts");
  const { getTaskFitnessWithSource, invalidateFitnessCache } =
    await import("../../open-sse/services/autoCombo/taskFitness.ts");
  invalidateFitnessCache();
  assert.equal(getModelIntelligence("gpt-oss-120b", "coding"), null);
  assert.notEqual(getTaskFitnessWithSource("groq/openai/gpt-oss-120b", "coding").source, "lmarena");
});
