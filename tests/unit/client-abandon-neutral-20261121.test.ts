/**
 * A client that closes a stream within seconds of starting it is not evidence about the model.
 *
 * Live (2026-11-21): a Claude terminal session's two `client_disconnected` rows (2.7 s and 3.1 s,
 * no output) counted as two failures in 48 requests. That 4% moved Claude's critical score by 0.005
 * and decided the winner between equally capable models, while the NVIDIA `client_disconnected`
 * rows were all 40 s or longer: real provider stalls that must keep counting.
 *
 * Rule under test (shared, name-blind): when the ranking asks for it
 * (`excludeClientAbandons`), a `client_disconnected` row shorter than CLIENT_ABANDON_MAX_MS is
 * counted as neither a success nor a failure. Every other row, including long
 * `client_disconnected` rows, `probe_deadline`, timeouts and provider errors, counts as before.
 * Callers that do not ask (the dashboard route, the canary's evidence counts) see no change.
 */
// First import: sends DATA_DIR to a throwaway directory and refuses a live data path.
import "../../scripts/tools/replayIsolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { resetDbInstance } from "@/lib/db/core";
import {
  getModelLatencyStats,
  saveRequestUsage,
  CLIENT_ABANDON_MAX_MS,
} from "../../src/lib/usage/usageHistory.ts";
import { isClientAbandon } from "../../src/lib/usage/usageHistory/helpers.ts";
import { operationalReliability } from "../../open-sse/services/autoCombo/rankingEvidence.ts";

test.after(() => {
  resetDbInstance();
});

let seq = 0;
async function row(
  provider: string,
  model: string,
  o: { success: boolean; latencyMs?: number; errorCode?: string | null }
) {
  await saveRequestUsage({
    provider,
    model,
    success: o.success,
    status: o.success ? "200" : o.errorCode === "client_disconnected" ? "499" : "504",
    errorCode: o.success ? null : (o.errorCode ?? "upstream_error"),
    latencyMs: o.latencyMs ?? 500,
    timeToFirstTokenMs: 100,
    tokens: { input: 1, output: o.success ? 5 : 0 },
    // distinct timestamps, so the writer's duplicate guard never merges two rows
    timestamp: new Date(Date.now() - 1000 * ++seq).toISOString(),
  });
}

async function stats(provider: string, model: string, exclude: boolean) {
  const all = await getModelLatencyStats({
    windowHours: 24,
    minSamples: 1,
    maxRows: 10000,
    provider,
    model,
    ...(exclude ? { excludeClientAbandons: true } : {}),
  });
  return all[`${provider}/${model}`];
}

test("the abandon threshold is a named constant of 10 seconds", () => {
  assert.equal(CLIENT_ABANDON_MAX_MS, 10_000);
});

test("without the option nothing changes: every failure row still counts", async () => {
  const m = "ca-default";
  for (let i = 0; i < 6; i++) await row("synp", m, { success: true });
  await row("synp", m, { success: false, errorCode: "client_disconnected", latencyMs: 2700 });
  await row("synp", m, { success: false, errorCode: "client_disconnected", latencyMs: 3100 });
  const s = await stats("synp", m, false);
  assert.equal(s.totalRequests, 8);
  assert.equal(s.successfulRequests, 6);
});

test("with the option a short client_disconnected row is neither a success nor a failure", async () => {
  const m = "ca-short";
  for (let i = 0; i < 46; i++) await row("synp", m, { success: true });
  await row("synp", m, { success: false, errorCode: "client_disconnected", latencyMs: 2680 });
  await row("synp", m, { success: false, errorCode: "client_disconnected", latencyMs: 3093 });
  const s = await stats("synp", m, true);
  assert.equal(s.totalRequests, 46, "the two aborts are not requests about the model");
  assert.equal(s.successfulRequests, 46);
  assert.equal(s.successRate, 1);
});

test("a long client_disconnected row is a stall and still counts as a failure", async () => {
  const m = "ca-long";
  for (let i = 0; i < 8; i++) await row("synq", m, { success: true });
  for (const ms of [44_986, 45_004, 66_909, 107_087]) {
    await row("synq", m, { success: false, errorCode: "client_disconnected", latencyMs: ms });
  }
  const s = await stats("synq", m, true);
  assert.equal(s.totalRequests, 12);
  assert.equal(s.successfulRequests, 8);
});

test("the boundary: just under the threshold is abandoned, the threshold itself counts", async () => {
  const m = "ca-edge";
  await row("synr", m, { success: false, errorCode: "client_disconnected", latencyMs: 9_999 });
  await row("synr", m, { success: false, errorCode: "client_disconnected", latencyMs: 10_000 });
  await row("synr", m, { success: true });
  const s = await stats("synr", m, true);
  assert.equal(s.totalRequests, 2, "9 999 ms excluded; 10 000 ms and the success counted");
  assert.equal(s.successfulRequests, 1);
});

test("only client_disconnected is neutral: other short failures keep counting", async () => {
  const m = "ca-other";
  await row("syns", m, { success: true });
  for (const code of [
    "probe_deadline",
    "routing_deadline",
    "target_timeout",
    "upstream_529",
    "stream_terminated",
  ]) {
    await row("syns", m, { success: false, errorCode: code, latencyMs: 800 });
  }
  const s = await stats("syns", m, true);
  assert.equal(s.totalRequests, 6);
  assert.equal(s.successfulRequests, 1);
});

test("a client_disconnected row with no recorded duration counts: nothing shows it was short", async () => {
  const { getDbInstance } = await import("../../src/lib/db/core.ts");
  const m = "ca-null";
  const db = getDbInstance();
  const at = () => new Date(Date.now() - 1000 * ++seq).toISOString();
  const ins = db.prepare(
    `INSERT INTO usage_history (provider, model, tokens_input, tokens_output, status, success, latency_ms, ttft_ms, error_code, timestamp)
     VALUES (?, ?, 1, 0, ?, ?, ?, 0, ?, ?)`
  );
  ins.run("synt", m, "499", 0, null, "client_disconnected", at());
  ins.run("synt", m, "499", 0, null, "client_disconnected", at());
  ins.run("synt", m, "200", 1, 400, null, at());
  const s = await stats("synt", m, true);
  assert.equal(s.totalRequests, 3, "rows with NULL duration are not shown to be short");
  assert.equal(s.successfulRequests, 1);
});

test("isClientAbandon: blank, null and boolean durations are not abandons; numbers follow the threshold", () => {
  for (const v of [null, undefined, "", true, false, [], "abc", Number.NaN, -1, 10_000, 44_986]) {
    assert.equal(isClientAbandon("client_disconnected", v), false, `${String(v)}`);
  }
  for (const v of [0, 1, 2680, 9999, 9999.9, "3000"]) {
    assert.equal(isClientAbandon("client_disconnected", v), true, `${String(v)}`);
  }
  assert.equal(isClientAbandon("probe_deadline", 100), false);
  assert.equal(isClientAbandon(null, 100), false);
});

test("the rule is provider-blind: the same rows give the same stats for every provider", async () => {
  const out: number[][] = [];
  for (const provider of ["synu", "synv", "synw"]) {
    const m = "ca-blind";
    for (let i = 0; i < 10; i++) await row(provider, m, { success: true });
    await row(provider, m, { success: false, errorCode: "client_disconnected", latencyMs: 3000 });
    await row(provider, m, { success: false, errorCode: "client_disconnected", latencyMs: 60_000 });
    const s = await stats(provider, m, true);
    out.push([s.totalRequests, s.successfulRequests]);
  }
  assert.deepEqual(out[0], [11, 10]);
  assert.deepEqual(out[1], out[0]);
  assert.deepEqual(out[2], out[0]);
});

// End to end through the production candidate assembly: Claude's live shape, 46 ok + 2 short aborts.
// The option is gated by ROUTING_CLIENT_ABANDON_NEUTRAL (default off, the 171b40a behaviour). The
// scores below are the 171b40a Beta(2,2) reliability, (2 + successes) / (4 + n).

async function assembled(provider: string, model: string) {
  const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
  const [c] = await buildAutoCandidates(
    [
      {
        kind: "model",
        provider,
        modelStr: `${provider}/${model}`,
        stepId: model,
        executionKey: model,
        connectionId: null,
      },
    ] as never,
    "client-abandon-fixture"
  );
  return c as unknown as Parameters<typeof operationalReliability>[0];
}

async function withAbandonSetting<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  if (on) process.env.ROUTING_CLIENT_ABANDON_NEUTRAL = "1";
  try {
    return await fn();
  } finally {
    delete process.env.ROUTING_CLIENT_ABANDON_NEUTRAL;
  }
}

test("production assembly: with the setting on, two short client aborts in 48 requests are not evidence", async () => {
  const m = "ca-assembly-live";
  for (let i = 0; i < 46; i++) await row("synx", m, { success: true });
  await row("synx", m, { success: false, errorCode: "client_disconnected", latencyMs: 2680 });
  await row("synx", m, { success: false, errorCode: "client_disconnected", latencyMs: 3093 });
  const on = await withAbandonSetting(true, async () =>
    operationalReliability(await assembled("synx", m), Date.now())
  );
  assert.equal(on.source, "usage_24h");
  assert.equal(on.sampleCount, 46);
  assert.equal(on.score, 48 / 50, "Beta(2,2) of 46 of 46");
  const off = await withAbandonSetting(false, async () =>
    operationalReliability(await assembled("synx", m), Date.now())
  );
  assert.equal(off.sampleCount, 48, "default: every row counts, exactly as before");
  assert.equal(off.score, (2 + 46) / 52, "default: the two aborts lower the score");
});

test("production assembly: stalls recorded as long client_disconnected rows still lower the score", async () => {
  const m = "ca-assembly-stall";
  for (let i = 0; i < 8; i++) await row("synx", m, { success: true });
  for (const ms of [45_004, 66_909]) {
    await row("synx", m, { success: false, errorCode: "client_disconnected", latencyMs: ms });
  }
  const r = await withAbandonSetting(true, async () =>
    operationalReliability(await assembled("synx", m), Date.now())
  );
  assert.equal(r.sampleCount, 10);
  assert.equal(r.score, 10 / 14);
});
