/**
 * Read-only replay of recorded routing decisions through the OLD and the NEW fit-first ranker.
 *
 *   node --import tsx/esm scripts/tools/replay_fair_selection.ts \
 *     --db <copy-of-storage.sqlite> [--hours 24] [--out report.json] \
 *     [--drop-rows-between <fromIso> <toIso>] [--explain]
 *
 * NEVER point --db at the live database. Make a copy first (this opens the copy read-only). The
 * ranker modules open the gateway database on import, so replayIsolation.ts (imported first) sends
 * DATA_DIR to a throwaway directory; it refuses to run if DATA_DIR is the live data directory:
 *   sqlite3 -readonly ~/.omniroute/storage.sqlite ".backup /path/scratch/live_copy.sqlite"
 *
 * What it does, per recorded routing decision in the window:
 *  1. Rebuilds the candidate pool as the logged winner plus the logged alternatives (the log keeps
 *     the top six, so the pool is at most six; a model ranked seventh or lower is invisible).
 *  2. Rebuilds the evidence the ranker would have read at that moment: the usage rows of the 24 h
 *     before the decision, from the copy. Rows with no request class are what the live rows are
 *     today; the new ranker reads them as the imputation in classEvidence.ts does.
 *  3. Rebuilds a request body of the logged shape (tools yes/no from the logged required
 *     capabilities, size from the logged task level and reasons), and treats every decision as a
 *     NEW conversation with its own request id as the conversation key.
 *  4. Ranks it with the production ranker twice: all settings off (this is the base build) and
 *     with each scenario's settings on, and records the winner of each.
 *
 * Reported per request class and per scenario: pick share by provider and by model, distinct
 * models used, the share of picks that went to a candidate with at least one failure in that
 * class in the 24 h before the decision, and the mean hindsight failure rate of the picks.
 * Fidelity check: how often the all-off replay reproduces the logged winner.
 *
 * Limits (also printed): body shape is approximate, the pool is the top six, each decision is a
 * fresh conversation (real sessions are continuity-pinned, so real spread is lower), and replayed
 * picks are not executed: exposure is predicted from recorded outcomes, not observed.
 */
import "./replayIsolation.ts";
import fs from "node:fs";
import Database from "better-sqlite3";
import { rankFitFirstFreeCandidates } from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { fairSelectionSettings } from "../../open-sse/services/autoCombo/fairSelectionSettings.ts";
import type { FairSelectionSettings } from "../../open-sse/services/autoCombo/fairSelectionSettings.ts";
import { aggregateOutcomeRows } from "../../open-sse/services/autoCombo/classEvidence.ts";
import { candidateProvenance } from "../../open-sse/services/autoCombo/candidateProvenance.ts";
import {
  deriveRequestClass,
  requestClassTier,
  PROBE_REQUEST_CLASS,
} from "../../open-sse/services/autoCombo/requestClass.ts";
import { USAGE_SOURCE_ROUTING_CANARY } from "../../src/shared/constants/usageSource.ts";
import { isClientAbandon } from "../../src/lib/usage/usageHistory/helpers.ts";

type Row = {
  ts: number;
  provider: string;
  model: string;
  success: boolean;
  errorCode: string | null;
  latencyMs: number | null;
  tokensOutput: number | null;
  source: string | null;
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dbPath = arg("db");
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("usage: --db <copy of storage.sqlite> (a COPY, never the live file)");
  process.exit(2);
}
if (/\.omniroute\/storage\.sqlite$/.test(dbPath)) {
  console.error("refusing to open the live database; pass a copy");
  process.exit(2);
}
const hours = Number(arg("hours", "24"));
const dropFrom = process.argv.includes("--drop-rows-between")
  ? Date.parse(process.argv[process.argv.indexOf("--drop-rows-between") + 1])
  : null;
const dropTo = process.argv.includes("--drop-rows-between")
  ? Date.parse(process.argv[process.argv.indexOf("--drop-rows-between") + 2])
  : null;

const db = new Database((globalThis as { __replayDbCopy?: string }).__replayDbCopy || dbPath, {
  readonly: true,
  fileMustExist: true,
});

const decisions = db
  .prepare(
    `SELECT id, request_id, created_at, task_type, provider_selected, model_selected, factors_json
     FROM routing_decisions
     WHERE source = 'auto-fit-first' AND created_at >= datetime((SELECT max(created_at) FROM routing_decisions), '-${Math.floor(hours)} hours')
     ORDER BY id`
  )
  .all() as Array<{
  id: number;
  request_id: string | null;
  created_at: string;
  task_type: string;
  provider_selected: string;
  model_selected: string;
  factors_json: string;
}>;
if (!decisions.length) {
  console.error("no routing decisions in the window");
  process.exit(1);
}
const firstTs = Date.parse(decisions[0].created_at.replace(" ", "T") + "Z");
const lastTs = Date.parse(decisions.at(-1)!.created_at.replace(" ", "T") + "Z");

const rawRows = db
  .prepare(
    `SELECT timestamp, provider, model, success, error_code, latency_ms, tokens_output, source
     FROM usage_history
     WHERE timestamp >= ? AND timestamp <= ? AND provider IS NOT NULL AND model IS NOT NULL
     ORDER BY timestamp`
  )
  .all(
    new Date(firstTs - 24 * 3600_000).toISOString(),
    new Date(lastTs + 60_000).toISOString()
  ) as Array<Record<string, unknown>>;
let rows: Row[] = rawRows.map((r) => ({
  ts: Date.parse(String(r.timestamp)),
  provider: String(r.provider),
  model: String(r.model),
  success: Number(r.success) !== 0,
  errorCode: r.error_code == null ? null : String(r.error_code),
  latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
  tokensOutput: r.tokens_output == null ? null : Number(r.tokens_output),
  source: r.source == null ? null : String(r.source),
}));
if (dropFrom !== null && dropTo !== null) {
  rows = rows.filter((r) => !(r.ts >= dropFrom && r.ts < dropTo));
}

const key = (p: string, m: string) => `${p}/${m}`;
const rowsBefore = (t: number) => rows.filter((r) => r.ts <= t && r.ts > t - 24 * 3600_000);

function percentile95(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(0.95 * v.length))];
}

/** The evidence the production assembly derives for one model from the rows before time t. */
function legacyEvidence(window: Row[], provider: string, model: string) {
  const mine = window.filter(
    (r) =>
      r.provider === provider && r.model === model && !isClientAbandon(r.errorCode, r.latencyMs)
  );
  const total = mine.length;
  const ok = mine.filter((r) => r.success);
  const lat = ok.map((r) => r.latencyMs ?? 0).filter((v) => v > 0);
  const hasLatency = total >= 10 && lat.length >= 3;
  return {
    total,
    failureRate: total ? 1 - ok.length / total : undefined,
    p95: hasLatency ? percentile95(lat) : 1500,
    successfulLatencySamples: total >= 10 ? lat.length : 0,
    hasLatency,
  };
}

type Pool = Array<{ provider: string; model: string }>;
function poolOf(d: (typeof decisions)[number]): { pool: Pool; factors: Record<string, unknown> } {
  const factors = JSON.parse(d.factors_json) as Record<string, unknown>;
  const pool: Pool = [{ provider: d.provider_selected, model: d.model_selected }];
  const alts = Array.isArray(factors.alternatives)
    ? (factors.alternatives as Array<{ provider: string; model: string }>)
    : [];
  for (const a of alts) pool.push({ provider: a.provider, model: a.model });
  return { pool, factors };
}

function bodyFor(factors: Record<string, unknown>, id: string): Record<string, unknown> {
  if (arg("body") === "light") {
    // what a small, tool-free chat request looks like (class c0s): not the logged shape
    return {
      stream: true,
      conversation_id: id,
      messages: [{ role: "user", content: "Explain what a mutex is." }],
    };
  }
  const level = String(factors.taskLevel ?? "standard");
  const caps = Array.isArray(factors.requiredCapabilities)
    ? (factors.requiredCapabilities as string[])
    : [];
  const reasons = Array.isArray(factors.taskReasons) ? (factors.taskReasons as string[]) : [];
  const chars = reasons.includes("huge-context")
    ? 120_000
    : level === "critical"
      ? 60_000
      : level === "heavy"
        ? 40_000
        : level === "light"
          ? 200
          : 12_000;
  const body: Record<string, unknown> = {
    stream: true,
    conversation_id: id,
    messages: [{ role: "user", content: "Review this log. ".repeat(Math.ceil(chars / 17)) }],
  };
  if (caps.includes("tools")) {
    body.tools = [{ type: "function", function: { name: "run", parameters: { type: "object" } } }];
  }
  return body;
}

const OFF = fairSelectionSettings({});
const scenarios: Array<{ name: string; settings: FairSelectionSettings; classEvidence: boolean }> =
  [
    { name: "old (all settings off = 171b40a)", settings: OFF, classEvidence: false },
    {
      name: "A class evidence",
      settings: { ...OFF, classEvidence: true },
      classEvidence: true,
    },
    {
      name: "A+C class evidence, spread, band 0.02",
      settings: { ...OFF, classEvidence: true, spreadTieBreak: true, tieBand: 0.02 },
      classEvidence: true,
    },
  ];

type Pick = {
  scenario: string;
  cls: string;
  tier: string;
  provider: string;
  model: string;
  exposed: boolean;
  hindsightFail: number;
};
const picks: Pick[] = [];
let fidelityHit = 0;
let fidelityTotal = 0;
// decisions written by the 171b40a build (the build this branch equals with every setting off)
// carry no healthRule marker; the 0540122 build wrote it
let fidelityBaseHit = 0;
let fidelityBaseTotal = 0;
const tierOfDecision = new Map<number, string>();

const windowAll = rows;
/**
 * Rows that count as "evidence about this class" for the exposure metrics: for a heavy request the
 * real client traffic (not probes), for a light request the probes (the only light-class rows that
 * exist before the class is written). Short client aborts are neutral, as in the ranking.
 */
function classRows(window: Row[], provider: string, model: string, heavy: boolean): Row[] {
  return window.filter(
    (r) =>
      r.provider === provider &&
      r.model === model &&
      (r.source === USAGE_SOURCE_ROUTING_CANARY) === !heavy &&
      !isClientAbandon(r.errorCode, r.latencyMs)
  );
}
function hindsightFailRate(
  provider: string,
  model: string,
  heavy: boolean
): { n: number; fail: number } {
  const mine = classRows(windowAll, provider, model, heavy);
  return { n: mine.length, fail: mine.filter((r) => !r.success).length };
}

for (const d of decisions) {
  const t = Date.parse(d.created_at.replace(" ", "T") + "Z");
  const { pool, factors } = poolOf(d);
  const body = bodyFor(factors, d.request_id ?? `d${d.id}`);
  const cls = deriveRequestClass(body) ?? "?";
  const tier = requestClassTier(cls) ?? "?";
  tierOfDecision.set(d.id, tier);
  const window = rowsBefore(t);
  const pools = aggregateOutcomeRows(
    window.map((r) => ({ ...r, requestClass: null })),
    { outcomeQuality: false }
  );
  const providers = [...new Set(pool.map((p) => p.provider))];

  for (const scenario of scenarios) {
    const candidates = pool.map((p) => {
      const ev = legacyEvidence(window, p.provider, p.model);
      return {
        provider: p.provider,
        model: p.model,
        modelStr: `${p.provider}/${p.model}`,
        quotaRemaining: 100,
        quotaTotal: 100,
        circuitBreakerState: "CLOSED" as const,
        costPer1MTokens: 1,
        p95LatencyMs: ev.p95,
        latencyStdDev: Math.max(10, ev.p95 * 0.1),
        latencySampleSource: ev.hasLatency
          ? ("successful_usage_24h" as const)
          : ("unqualified" as const),
        successfulLatencySampleCount: ev.successfulLatencySamples,
        errorRate: ev.total >= 10 && ev.failureRate !== undefined ? ev.failureRate : 0.05,
        // 171b40a assembly: no usageFailureRate, and the usage_24h provenance needs 10 samples
        provenance: candidateProvenance({
          provider: p.provider,
          connectionId: "replay",
          historical: ev.total >= 10,
          historicalSamples: ev.total,
          runtimeSamples: undefined,
          runtimeLatest: undefined,
          quota: null,
          now: t,
        }),
        ...(scenario.classEvidence ? { classEvidencePool: pools } : {}),
      };
    });
    const decision = rankFitFirstFreeCandidates({
      candidates: candidates as never,
      body,
      zeroAdditionalCostProviders: providers,
      settings: scenario.settings,
      now: t,
    });
    const winner = decision.ranked[0];
    if (!winner) continue;
    if (scenario.name.startsWith("old")) {
      fidelityTotal++;
      const same =
        winner.candidate.provider === d.provider_selected &&
        winner.candidate.model === d.model_selected;
      if (same) fidelityHit++;
      if (!d.factors_json.includes("healthRule")) {
        fidelityBaseTotal++;
        if (same) fidelityBaseHit++;
      }
    }
    const heavy = tier === "heavy";
    const h = hindsightFailRate(winner.candidate.provider, winner.candidate.model, heavy);
    const trailing = classRows(
      window,
      winner.candidate.provider,
      winner.candidate.model,
      heavy
    ).filter((r) => !r.success).length;
    picks.push({
      scenario: scenario.name,
      cls,
      tier,
      provider: winner.candidate.provider,
      model: winner.candidate.model,
      exposed: trailing > 0,
      hindsightFail: h.n ? h.fail / h.n : 0,
    });
  }
}

function summarize(scenario: string, filter: (p: Pick) => boolean) {
  const mine = picks.filter((p) => p.scenario === scenario && filter(p));
  const byModel = new Map<string, number>();
  const byProvider = new Map<string, number>();
  for (const p of mine) {
    byModel.set(key(p.provider, p.model), (byModel.get(key(p.provider, p.model)) ?? 0) + 1);
    byProvider.set(p.provider, (byProvider.get(p.provider) ?? 0) + 1);
  }
  const n = mine.length;
  const pct = (v: number) => (n ? Math.round((1000 * v) / n) / 10 : 0);
  return {
    n,
    distinctModels: byModel.size,
    shareByModel: Object.fromEntries(
      [...byModel].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v)])
    ),
    shareByProvider: Object.fromEntries(
      [...byProvider].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v)])
    ),
    picksWithFailureInClassTrailing24hPct: pct(mine.filter((p) => p.exposed).length),
    meanHindsightFailureRatePct: n
      ? Math.round((1000 * mine.reduce((s, p) => s + p.hindsightFail, 0)) / n) / 10
      : 0,
  };
}

const out: Record<string, unknown> = {
  window: {
    decisions: decisions.length,
    from: decisions[0].created_at,
    to: decisions.at(-1)!.created_at,
    usageRows: rows.length,
    droppedRowsBetween: dropFrom
      ? [arg("drop-rows-between"), process.argv[process.argv.indexOf("--drop-rows-between") + 2]]
      : null,
  },
  fidelity: {
    oldReplayReproducesLoggedWinnerPct: Math.round((1000 * fidelityHit) / fidelityTotal) / 10,
    hit: fidelityHit,
    of: fidelityTotal,
    on171b40aDecisions: { hit: fidelityBaseHit, of: fidelityBaseTotal },
  },
  logged: (() => {
    const byModel = new Map<string, number>();
    for (const d of decisions)
      byModel.set(
        key(d.provider_selected, d.model_selected),
        (byModel.get(key(d.provider_selected, d.model_selected)) ?? 0) + 1
      );
    return Object.fromEntries(
      [...byModel].map(([k, v]) => [k, Math.round((1000 * v) / decisions.length) / 10])
    );
  })(),
  scenarios: {} as Record<string, unknown>,
};
for (const s of scenarios) {
  (out.scenarios as Record<string, unknown>)[s.name] = {
    all: summarize(s.name, () => true),
    heavy: summarize(s.name, (p) => p.tier === "heavy"),
    light: summarize(s.name, (p) => p.tier === "light"),
  };
}
const outPath = arg("out");
const text = JSON.stringify(out, null, 2);
if (outPath) fs.writeFileSync(outPath, text);
console.log(text);
