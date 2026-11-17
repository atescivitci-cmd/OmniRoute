/**
 * Provenance tagging for OmniRoute-generated traffic (routing evidence canary probes).
 *
 * Probes are written to usage_history by the real chat pipeline, so reports used to count them as
 * client traffic. These tests pin the contract: a request-scoped source marks every row written
 * inside it, ordinary traffic stays untagged, the marker survives module-copy boundaries, report
 * sources exclude tagged rows, and the selector's latency evidence still sees them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getDbInstance } from "@/lib/db/core";
import { runMigrations } from "@/lib/db/migrationRunner";
import { getProviderCallStats, getModelCallStats } from "@/lib/db/providerStats";
import { saveRequestUsage, getModelLatencyStats } from "@/lib/usageDb";
import { saveCallLog } from "@/lib/usage/callLogs";
import { rollupUsageHistoryBeforeDate } from "@/lib/usage/aggregateHistory";
import { getUsageStats } from "@/lib/usage/usageStats";
import { updateDatabaseSettings } from "@/lib/db/databaseSettings";
import { runWithUsageSource, getUsageSource } from "@/lib/usage/usageSourceContext";
import { buildUnifiedSource, buildPresetUnifiedSource } from "@/lib/db/usageAnalytics/sources";
import {
  EXCLUDE_ROUTING_CANARY_SQL,
  USAGE_SOURCE_ROUTING_CANARY,
} from "@/shared/constants/usageSource";

const db = () => getDbInstance();

function usageRow(model: string, extra: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    model,
    connectionId: "conn-source-test",
    tokens: { input: 100, output: 20 },
    status: "200",
    success: true,
    latencyMs: 120,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function sourceOf(model: string): Array<string | null> {
  return (
    db()
      .prepare("SELECT source FROM usage_history WHERE model = ? ORDER BY id")
      .all(model) as Array<{
      source: string | null;
    }>
  ).map((r) => r.source);
}

test("migration adds a nullable source column that defaults to ordinary traffic", () => {
  const cols = db().prepare("PRAGMA table_info(usage_history)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const source = cols.find((c) => c.name === "source");
  assert.ok(source, "usage_history.source exists");
  assert.equal(source.notnull, 0);
});

test("a row saved outside any context is ordinary traffic (source NULL)", async () => {
  await saveRequestUsage(usageRow("src-plain"));
  assert.deepEqual(sourceOf("src-plain"), [null]);
  assert.equal(getUsageSource(), null);
});

test("a row saved inside the canary context is tagged, including fire-and-forget writes", async () => {
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    // Direct write.
    await saveRequestUsage(usageRow("src-canary", { timestamp: "2026-01-01T00:00:00.001Z" }));
    // Write started without awaiting, the way the pipeline's stats helpers do it.
    void saveRequestUsage(usageRow("src-canary", { timestamp: "2026-01-01T00:00:00.002Z" }));
    // Write from a later tick and from a timer callback created inside the context.
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        void saveRequestUsage(usageRow("src-canary", { timestamp: "2026-01-01T00:00:00.003Z" }));
        resolve();
      }, 5)
    );
    await new Promise((r) => setImmediate(r));
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sourceOf("src-canary"), [
    USAGE_SOURCE_ROUTING_CANARY,
    USAGE_SOURCE_ROUTING_CANARY,
    USAGE_SOURCE_ROUTING_CANARY,
  ]);
  // The context does not leak out to the surrounding code.
  assert.equal(getUsageSource(), null);
});

test("an explicit entry.source wins over the ambient context", async () => {
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    await saveRequestUsage(usageRow("src-explicit", { source: "other-source" }));
  });
  assert.deepEqual(sourceOf("src-explicit"), ["other-source"]);
});

test("the marker is shared across separate copies of the module", async () => {
  // The canary starts from the instrumentation bundle and the pipeline runs from the route
  // bundle, so each can hold its own copy of this module. A copy-local store would never be seen.
  const copyA =
    (await import("@/lib/usage/usageSourceContext.ts?copy=a")) as typeof import("@/lib/usage/usageSourceContext");
  const copyB =
    (await import("@/lib/usage/usageSourceContext.ts?copy=b")) as typeof import("@/lib/usage/usageSourceContext");
  assert.notEqual(copyA.runWithUsageSource, copyB.runWithUsageSource, "genuinely separate copies");
  const seen = await copyA.runWithUsageSource("shared-marker", async () => {
    await new Promise((r) => setTimeout(r, 1));
    return copyB.getUsageSource();
  });
  assert.equal(seen, "shared-marker");
});

test("call logs inside the context carry the tag, and a client cannot set it", async () => {
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    await saveCallLog({ id: "cl-canary", provider: "openai", model: "src-cl", status: 200 });
  });
  // A client that sends the canary's name as its own session tag is still ordinary traffic.
  await saveCallLog({
    id: "cl-spoof",
    provider: "openai",
    model: "src-cl",
    status: 200,
    sessionTag: USAGE_SOURCE_ROUTING_CANARY,
    source: USAGE_SOURCE_ROUTING_CANARY,
  });
  await saveCallLog({ id: "cl-plain", provider: "openai", model: "src-cl", status: 200 });
  const row = (id: string) =>
    db().prepare("SELECT source, session_tag FROM call_logs WHERE id = ?").get(id) as {
      source: string | null;
      session_tag: string | null;
    };
  assert.equal(row("cl-canary").source, USAGE_SOURCE_ROUTING_CANARY);
  assert.equal(row("cl-canary").session_tag, null, "session_tag is no longer overloaded");
  assert.equal(row("cl-spoof").source, null, "client input never sets provenance");
  assert.equal(row("cl-plain").source, null);
});

test("cost by model leaves canary call logs out", async () => {
  const { getCostByModel } = await import("@/lib/usage/callCost");
  await saveCallLog({
    id: "cost-plain",
    provider: "openai",
    model: "src-cost",
    status: 200,
    tokens: { input: 1000, output: 100 },
  });
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    await saveCallLog({
      id: "cost-canary",
      provider: "openai",
      model: "src-cost",
      status: 200,
      tokens: { input: 1000, output: 100 },
    });
  });
  const rows = getCostByModel(db(), "1970-01-01T00:00:00.000Z").filter(
    (r) => r.model === "src-cost"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 1, "only the client call is counted");
});

test("endpoint usage rows leave canary rows out", async () => {
  const { getEndpointUsageRows } = await import("@/lib/db/usageAnalytics");
  const base = usageRow("src-endpoint", { endpoint: "/v1/chat/completions" });
  await saveRequestUsage({ ...base, timestamp: new Date().toISOString() });
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    await saveRequestUsage({ ...base, timestamp: new Date(Date.now() + 1000).toISOString() });
  });
  const rows = getEndpointUsageRows().filter((r) => r.model === "src-endpoint");
  assert.equal(
    rows.reduce((n, r) => n + Number(r.requests), 0),
    1
  );
});

test("the 10-minute window in usage stats leaves canary rows out", async () => {
  db().prepare("DELETE FROM usage_history").run(); // totals below must not see other tests
  // Both rows sit in the recent past: the window's upper bound is "now", so a row timestamped
  // ahead of it would be hidden by time alone and the test could not tell exclusion from that.
  const base = usageRow("src-recent");
  await saveRequestUsage({ ...base, timestamp: new Date(Date.now() - 2000).toISOString() });
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    await saveRequestUsage({ ...base, timestamp: new Date(Date.now() - 1000).toISOString() });
  });
  const stats = (await getUsageStats()) as { last10Minutes: Array<{ requests: number }> };
  const total = stats.last10Minutes.reduce((n, b) => n + Number(b.requests), 0);
  assert.ok(total >= 1, "the client row is counted");
  const withProbe = db()
    .prepare("SELECT COUNT(*) AS n FROM usage_history WHERE model = 'src-recent'")
    .get() as { n: number };
  assert.equal(withProbe.n, 2, "the probe row exists in the table");
  assert.equal(total, 1, "but is not counted in the window");
});

test("the analytics route is consistent: every section leaves canary rows out", async () => {
  db().prepare("DELETE FROM usage_history").run(); // totals below must not see other tests
  const analyticsRoute = await import("@/app/api/usage/analytics/route.ts");
  const base = usageRow("src-route", {
    apiKeyId: "key-route",
    apiKeyName: "route-key",
    endpoint: "/v1/chat/completions",
  });
  await saveRequestUsage({ ...base, timestamp: new Date().toISOString() });
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    await saveRequestUsage({
      ...base,
      tokens: { input: 5000, output: 900 },
      timestamp: new Date(Date.now() + 1000).toISOString(),
    });
  });
  const res = await analyticsRoute.GET(
    new Request("http://localhost/api/usage/analytics?range=7d")
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    summary: { totalRequests: number; totalTokens: number };
    byAccount: Array<{ requests: number; totalTokens: number }>;
    byApiKey: Array<{ requests: number; totalTokens: number }>;
    activityMap: Record<string, number>;
  };
  const clientTokens = 120;
  assert.equal(body.summary.totalRequests, 1);
  assert.equal(body.summary.totalTokens, clientTokens);
  const sum = (rows: Array<{ requests: number }>) =>
    rows.reduce((n, r) => n + Number(r.requests), 0);
  assert.equal(sum(body.byAccount), 1, "per-account rows");
  assert.equal(sum(body.byApiKey), 1, "per-API-key rows");
  const heat = Object.values(body.activityMap).reduce((n, v) => n + Number(v), 0);
  assert.equal(heat, clientTokens, "activity heatmap");
});

test("migration 137 gives each table its column from any half-present state", async () => {
  const hasSource = (table: string) =>
    (db().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
      (c) => c.name === "source"
    );
  const drop = (table: string) => {
    if (hasSource(table)) db().exec(`ALTER TABLE ${table} DROP COLUMN source`);
  };
  // The startup column repair swallows errors, so a transient failure can leave one table with
  // the column and the other without. Each state must still end with both columns and the
  // migration recorded, not lose a column because the other table's ALTER failed first.
  const states: Array<{ name: string; dropUsage: boolean; dropCalls: boolean }> = [
    { name: "only call_logs has it", dropUsage: true, dropCalls: false },
    { name: "only usage_history has it", dropUsage: false, dropCalls: true },
    { name: "neither has it", dropUsage: true, dropCalls: true },
    { name: "both have it", dropUsage: false, dropCalls: false },
  ];
  for (const state of states) {
    if (state.dropUsage) drop("usage_history");
    if (state.dropCalls) drop("call_logs");
    db().prepare("DELETE FROM _omniroute_migrations WHERE version = '137'").run();
    runMigrations(db());
    assert.equal(hasSource("usage_history"), true, `${state.name}: usage_history.source`);
    assert.equal(hasSource("call_logs"), true, `${state.name}: call_logs.source`);
    const marker = db()
      .prepare("SELECT name FROM _omniroute_migrations WHERE version = '137'")
      .get() as { name: string } | undefined;
    assert.equal(marker?.name, "usage_history_source", `${state.name}: recorded as applied`);
  }
});

test("provider page call stats leave canary calls out", async () => {
  await saveCallLog({ id: "ps-plain", provider: "ps-prov", model: "ps-model", status: 200 });
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    await saveCallLog({ id: "ps-canary", provider: "ps-prov", model: "ps-model", status: 200 });
  });
  const provider = getProviderCallStats().find((r) => r.provider === "ps-prov");
  assert.equal(provider?.totalRequests, 1);
  const model = getModelCallStats().find((r) => r.provider === "ps-prov" && r.model === "ps-model");
  assert.equal(model?.requests, 1);
});

test("report sources exclude canary rows and still run as valid SQL", async () => {
  const since = new Date(Date.now() - 3600_000).toISOString();
  await saveRequestUsage(usageRow("src-report", { timestamp: new Date().toISOString() }));
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    await saveRequestUsage(
      usageRow("src-report", {
        tokens: { input: 5000, output: 900 },
        timestamp: new Date(Date.now() + 1000).toISOString(),
      })
    );
  });

  for (const build of [buildUnifiedSource, buildPresetUnifiedSource]) {
    const { unifiedSource, unifiedParams } = build({
      sinceIso: since,
      untilIso: null,
      rawCutoffDate: new Date(Date.now() - 86400_000).toISOString().split("T")[0],
      apiKeyWhere: "",
      apiKeyParams: {},
    });
    assert.ok(unifiedSource.includes(EXCLUDE_ROUTING_CANARY_SQL), build.name);
    const row = db()
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(tokens_input),0) AS tin FROM ${unifiedSource} AS _u WHERE model = 'src-report'`
      )
      .get(unifiedParams) as { n: number; tin: number };
    assert.equal(row.n, 1, `${build.name} counts only the client row`);
    assert.equal(row.tin, 100, `${build.name} ignores the probe's tokens`);
  }

  // The usage/cost dashboard source also leaves probes out.
  const stats = (await getUsageStats()) as { byModel?: Record<string, { requests?: number }> };
  const modelEntries = Object.entries(stats.byModel ?? {}).filter(([k]) =>
    k.includes("src-report")
  );
  const totalRequests = modelEntries.reduce((n, [, v]) => n + Number(v.requests ?? 0), 0);
  assert.equal(totalRequests, 1, JSON.stringify(stats.byModel));
});

test("the usage dashboard source also excludes canary rows when aggregation is on", async () => {
  updateDatabaseSettings({ aggregation: { enabled: true } });
  try {
    await saveRequestUsage(usageRow("src-agg", { timestamp: new Date().toISOString() }));
    await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
      await saveRequestUsage(
        usageRow("src-agg", { timestamp: new Date(Date.now() + 1000).toISOString() })
      );
    });
    const stats = (await getUsageStats()) as { byModel?: Record<string, { requests?: number }> };
    const total = Object.entries(stats.byModel ?? {})
      .filter(([k]) => k.includes("src-agg"))
      .reduce((n, [, v]) => n + Number(v.requests ?? 0), 0);
    assert.equal(total, 1, JSON.stringify(stats.byModel));
  } finally {
    updateDatabaseSettings({ aggregation: { enabled: false } });
  }
});

test("daily rollups do not fold canary rows into client totals", async () => {
  const old = "2025-06-01T12:00:00.000Z";
  await saveRequestUsage(usageRow("src-rollup", { timestamp: old }));
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    await saveRequestUsage(usageRow("src-rollup", { timestamp: "2025-06-01T12:00:01.000Z" }));
  });
  await rollupUsageHistoryBeforeDate("2025-06-02");
  const summary = db()
    .prepare("SELECT total_requests FROM daily_usage_summary WHERE model = 'src-rollup'")
    .get() as { total_requests: number };
  assert.equal(summary.total_requests, 1);
});

test("the selector's latency evidence still counts canary rows", async () => {
  await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
    for (let i = 0; i < 3; i++) {
      await saveRequestUsage(
        usageRow("src-evidence", {
          latencyMs: 200 + i,
          timestamp: new Date(Date.now() + i).toISOString(),
        })
      );
    }
  });
  const stats = await getModelLatencyStats({ windowHours: 24, minSamples: 1 });
  const entry = stats["openai/src-evidence"];
  assert.ok(entry, "evidence exists for the probed model");
  assert.equal(entry.successfulRequests, 3);
});
