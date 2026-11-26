/**
 * Challenger findings on the quality-score feed (be8b09b): D8 response checks, D9 loud staleness
 * and persisted failures, retry backoff, D12 manual sync independent of the Arena feed.
 */
import "../../scripts/tools/replayIsolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDbInstance, resetDbInstance } from "@/lib/db/core";
import {
  QUALITY_SOURCE,
  _resetQualityScoreSyncState,
  fetchLeaderboardCategory,
  getQualityScoreSyncStatus,
  leaderboardPageUrl,
  manualQualitySync,
  nextQualitySyncDelayMs,
  parseLeaderboardPage,
  syncQualityScores,
  type FetchLike,
} from "../../src/lib/qualityScoreSync.ts";
import { readQualitySyncState } from "../../src/lib/db/modelIntelligence.ts";

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

type Mutate = (
  category: string,
  rows: Array<Record<string, unknown>>,
  offset: number
) => {
  rows?: Array<Record<string, unknown>>;
  total?: number;
  partial?: boolean;
  delayMs?: number;
};
function server(mutate: Mutate = () => ({})): FetchLike {
  return async (url) => {
    const params = new URL(url).searchParams;
    const category = /'([^']+)'/.exec(params.get("where") ?? "")?.[1] ?? "";
    const offset = Number(params.get("offset"));
    const length = Number(params.get("length"));
    const all = SNAPSHOT.categories[category] ?? [];
    const m = mutate(category, all, offset);
    if (m.delayMs) await new Promise((resolve) => setTimeout(resolve, m.delayMs));
    const rows = m.rows ?? all;
    const body = {
      features: PAGE.features,
      rows: rows
        .slice(offset, offset + length)
        .map((row, i) => ({ row_idx: offset + i, row, truncated_cells: [] })),
      num_rows_total: m.total ?? rows.length,
      num_rows_per_page: length,
      partial: m.partial ?? false,
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}
const stored = () =>
  Number(
    (
      getDbInstance()
        .prepare("SELECT COUNT(*) AS n FROM model_intelligence WHERE source = ?")
        .get(QUALITY_SOURCE) as { n: number }
    ).n
  );
async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    return { value: await fn(), errors };
  } finally {
    console.error = original;
  }
}

test("D8: the request has no orderby (dataset row order is fixed); rows must keep row order", async () => {
  assert.equal(new URL(leaderboardPageUrl("coding", 0)).searchParams.get("orderby"), null);
  await assert.rejects(
    fetchLeaderboardCategory("coding", async (url) => {
      const json = JSON.parse(await (await server()(url)).text());
      json.rows = json.rows.map((r: { row_idx: number }, i: number) => ({
        ...r,
        row_idx: 1000 - i,
      }));
      return { ok: true, status: 200, text: async () => JSON.stringify(json) };
    }),
    /out of row order/
  );
});

test("D8: a partial page is refused", () => {
  assert.throws(() => parseLeaderboardPage({ ...PAGE, partial: true }, "coding"), /partial/);
});

test("D8: a truncated category (fewer rows than num_rows_total) is refused", async () => {
  await assert.rejects(
    fetchLeaderboardCategory(
      "coding",
      server(() => ({ total: 999 }))
    ),
    /returned \d+ of 999 rows/
  );
});

test("D8: mixed publish dates are refused", async () => {
  await assert.rejects(
    fetchLeaderboardCategory(
      "coding",
      server((_c, rows) => ({
        rows: rows.map((r, i) => (i === 3 ? { ...r, leaderboard_publish_date: "2026-10-01" } : r)),
      }))
    ),
    /mixes publish dates/
  );
});

test("D8: a duplicated model name across pages is refused", async () => {
  await assert.rejects(
    fetchLeaderboardCategory(
      "coding",
      server((_c, rows) => ({ rows: rows.map((r, i) => (i === 5 ? rows[4] : r)) }))
    ),
    /repeats/
  );
});

test("D8: a snapshot more than 30% smaller than the stored table is refused; old rows kept", async () => {
  _resetQualityScoreSyncState();
  assert.equal((await syncQualityScores({ fetchImpl: server() })).success, true);
  const before = stored();
  const keep = new Set(["overall", "coding"]);
  const { value } = await quiet(() =>
    syncQualityScores({
      fetchImpl: server((category, rows) =>
        keep.has(category) ? {} : { rows: [rows[0], rows.at(-1)!, ...rows.slice(1, 19)] }
      ),
    })
  );
  assert.equal(value.success, false);
  assert.match(value.error!, /below the stored/);
  assert.equal(stored(), before);
});

test("D9: data older than 72 h logs at error level on every attempt and reports stale", async () => {
  _resetQualityScoreSyncState();
  await syncQualityScores({ fetchImpl: server() });
  getDbInstance()
    .prepare(
      "UPDATE model_intelligence SET synced_at = datetime('now', '-80 hours') WHERE source = ?"
    )
    .run(QUALITY_SOURCE);
  const failing = server((category) => (category === "math" ? { total: 1 } : {}));
  for (let attempt = 0; attempt < 2; attempt++) {
    const { errors } = await quiet(() => syncQualityScores({ fetchImpl: failing }));
    assert.ok(
      errors.some((line) => /\[QUALITY_SYNC\] STALE: quality scores are 8\d\.\d h old/.test(line))
    );
  }
  const status = getQualityScoreSyncStatus();
  assert.equal(status.stale, true);
  assert.equal(status.consecutiveFailures, 2);
});

test("D9: the failure count is persisted and survives a restart", async () => {
  const { _reloadPersistedForTest } = await import("../../src/lib/qualityScoreSync.ts");
  _resetQualityScoreSyncState();
  _reloadPersistedForTest();
  await quiet(() => syncQualityScores({ fetchImpl: server(() => ({ partial: true })) }));
  assert.equal(readQualitySyncState()!.consecutiveFailures, 3, "2 earlier + 1 (persisted)");
  // simulate a restart: module state cleared, persisted state reloaded on the next read
  _resetQualityScoreSyncState();
  _reloadPersistedForTest();
  assert.equal(getQualityScoreSyncStatus().consecutiveFailures, 3);
  await syncQualityScores({ fetchImpl: server() });
  assert.equal(readQualitySyncState()!.consecutiveFailures, 0, "a success resets it");
});

test("retry backoff: 5, 15, 60 min after failures, then daily", () => {
  assert.equal(nextQualitySyncDelayMs(1), 5 * 60_000);
  assert.equal(nextQualitySyncDelayMs(2), 15 * 60_000);
  assert.equal(nextQualitySyncDelayMs(3), 60 * 60_000);
  assert.equal(nextQualitySyncDelayMs(4), 86_400_000);
  assert.equal(nextQualitySyncDelayMs(0), 86_400_000);
});

test("D12: a manual sync while one is running returns 409; afterwards it runs", async () => {
  _resetQualityScoreSyncState();
  const running = syncQualityScores({ fetchImpl: server(() => ({ delayMs: 30 })) });
  const conflict = await manualQualitySync({ fetchImpl: server() });
  assert.equal(conflict.httpStatus, 409);
  await running;
  const ok = await manualQualitySync({ fetchImpl: server() });
  assert.equal(ok.httpStatus, 200);
  const bad = await quiet(() =>
    manualQualitySync({ fetchImpl: server(() => ({ partial: true })) })
  );
  assert.equal(bad.value.httpStatus, 502);
});

test("D12: the route runs the quality sync independently of the Arena feed", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "../../src/app/api/intelligence/sync/route.ts"),
    "utf8"
  );
  assert.match(src, /Promise\.all\(\[\s*manualQualitySync/);
  assert.match(src, /status: 409/);
});
