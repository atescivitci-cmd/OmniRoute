/**
 * Replays of the 2026-11-26 terminal routing failures through the production candidate assembly
 * (combo.ts buildAutoCandidates) and the production ranker (rankFitFirstFreeCandidates).
 *
 * Fixtures are real usage_history rows read from the live database (only provider, model, success,
 * latency, request class, source, timestamp and, for the c2n fixture, the malformed error code).
 * Timestamps are shifted so the decision time plus an idle period is "now"; no row is added.
 *
 *  - t2s (03:01:19Z): a Claude Code tool request went to NVIDIA because Claude's tool rows were just
 *    over 24 h old and the canary's chat probes kept NVIDIA "fresh".
 *  - c2n (05:55Z and 06:05Z): Claude Code compaction calls (no tools, over 32k, non-stream) went to
 *    mistral-large and failed as malformed_translated_response. The phantom success row the old
 *    recorder wrote before each such failure is in the fixture, as it is stored live.
 *
 * Goal under test (flag on): a model proven for the class over the last week stays ahead of models
 * with no evidence for that class and of models with a poor record, now and after 24 h and 48 h
 * without traffic.
 */
// First import: sends DATA_DIR to a throwaway directory and refuses a live data path.
import "../../scripts/tools/replayIsolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDbInstance, resetDbInstance } from "@/lib/db/core";
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
type Fixture = { decisionAt: string; laterDecisionAt?: string; rows: FixtureRow[] };

const readFixture = (name: string): Fixture =>
  JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "../fixtures/routing", name), "utf8")
  ) as Fixture;
const T2S = readFixture("terminal-lockin-20261126.json");
const C2N = readFixture("terminal-c2n-20261126.json");

const CLAUDE = ["claude", "claude-opus-4-8"] as const;
const MISTRAL = ["nvidia", "mistralai/mistral-large-4-1t-a52b"] as const;
const HOUR = 3_600_000;

test.after(() => {
  resetDbInstance();
  delete process.env.ROUTING_DURABLE_EVIDENCE;
});

/** Load the fixture rows before `decisionAt`, shifted so that decisionAt + idleHours is now. */
function load(fixture: Fixture, decisionAt: string, idleHours = 0) {
  const db = getDbInstance();
  db.prepare("DELETE FROM usage_history").run();
  const cutoff = Date.parse(decisionAt);
  const shift = Date.now() - cutoff - idleHours * HOUR;
  const insert = db.prepare(
    `INSERT INTO usage_history (provider, model, tokens_input, tokens_output, status, success,
       latency_ms, ttft_ms, error_code, source, request_class, timestamp)
     VALUES (?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const [provider, model, ok, ms, cls, source, ts, code] of fixture.rows) {
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

// Claude Code shapes: a tool session turn (t2s) and a compaction call (c2n).
const TERMINAL_BODY = {
  model: "ac-terminal-continuity",
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
  model: "ac-terminal-continuity",
  stream: false,
  max_tokens: 20000,
  messages: [
    { role: "user", content: "Summarise the conversation so far for compaction. ".repeat(3_000) },
  ],
};

const targets = () =>
  [CLAUDE, MISTRAL].map(([provider, model]) => ({
    kind: "model",
    provider,
    modelStr: `${provider}/${model}`,
    stepId: model,
    executionKey: `${provider}/${model}`,
    connectionId: null,
  })) as never;

async function assembleAndRank(flagOn: boolean, body: Record<string, unknown>) {
  if (flagOn) process.env.ROUTING_DURABLE_EVIDENCE = "1";
  else delete process.env.ROUTING_DURABLE_EVIDENCE;
  try {
    const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
    const candidates = (await buildAutoCandidates(
      targets(),
      "ac-terminal-continuity",
      null,
      undefined,
      null,
      true,
      { requestClass: deriveRequestClass(body) }
    )) as never as Parameters<typeof rankFitFirstFreeCandidates>[0]["candidates"];
    return rankFitFirstFreeCandidates({
      candidates,
      body,
      zeroAdditionalCostProviders: ["claude", "nvidia"],
      settings: fairSelectionSettings(),
    });
  } finally {
    delete process.env.ROUTING_DURABLE_EVIDENCE;
  }
}

type Decision = Awaited<ReturnType<typeof assembleAndRank>>;
const entry = (d: Decision, model: string) => d.ranked.find((e) => e.candidate.model === model)!;
const brief = (d: Decision) =>
  d.ranked.map((e) => ({
    model: e.candidate.model.split("/").pop(),
    score: Number(e.factors.score.toFixed(4)),
    health: Number(e.factors.health.toFixed(3)),
    reliability: Number(e.factors.reliability.toFixed(3)),
    raw: e.factors.reliabilitySampleCount,
    source: e.factors.reliabilitySource,
  }));

test("fixtures are the real decisions", () => {
  assert.equal(deriveRequestClass(TERMINAL_BODY), "t2s");
  assert.equal(deriveRequestClass(COMPACTION_BODY), "c2n");
  for (const f of [T2S, C2N]) {
    assert.deepEqual([...new Set(f.rows.map((r) => `${r[0]}/${r[1]}`))].sort(), [
      CLAUDE.join("/"),
      MISTRAL.join("/"),
    ]);
  }
  const malformed = C2N.rows.filter((r) => r[7] === "malformed_translated_response").length;
  assert.equal(malformed, 10, "the c2n fixture keeps the live malformed failures");
});

const CASES = [
  { name: "t2s 03:01:19Z", fixture: T2S, at: T2S.decisionAt, body: TERMINAL_BODY },
  { name: "c2n 05:55Z", fixture: C2N, at: C2N.decisionAt, body: COMPACTION_BODY },
  { name: "c2n 06:05Z", fixture: C2N, at: C2N.laterDecisionAt!, body: COMPACTION_BODY },
];

for (const c of CASES) {
  test(`replay ${c.name}, flag OFF: mistral-large wins now (reproduces the incident)`, async () => {
    load(c.fixture, c.at, 0);
    const d = await assembleAndRank(false, c.body);
    console.log(`${c.name} +0h OFF`, JSON.stringify(brief(d)));
    assert.equal(d.excluded.length, 0, JSON.stringify(d.excluded));
    assert.equal(d.ranked[0].candidate.model, MISTRAL[1]);
    assert.equal(entry(d, CLAUDE[1]).factors.evidenceWindowHours, undefined, "no new factors");
  });

  for (const idle of [0, 24, 48]) {
    test(`replay ${c.name} +${idle}h idle, flag ON: Claude's record keeps it first`, async () => {
      load(c.fixture, c.at, idle);
      const on = await assembleAndRank(true, c.body);
      load(c.fixture, c.at, idle);
      const off = await assembleAndRank(false, c.body);
      console.log(`${c.name} +${idle}h ON `, JSON.stringify(brief(on)));
      console.log(`${c.name} +${idle}h OFF`, JSON.stringify(brief(off)));
      assert.equal(on.excluded.length, 0, JSON.stringify(on.excluded));
      const claude = entry(on, CLAUDE[1]);
      const mistral = entry(on, MISTRAL[1]);
      assert.equal(on.ranked[0].candidate.model, CLAUDE[1]);
      assert.equal(claude.factors.reliabilitySource, "usage_durable");
      assert.ok(claude.factors.health > 0.5, "a proven record is healthier than no record");
      assert.ok(claude.factors.score > mistral.factors.score);
      // mistral: no evidence for the class (neutral) or a poor record (below neutral)
      assert.ok(mistral.factors.health <= 0.5, JSON.stringify(mistral.factors));
      assert.equal(claude.factors.evidenceMinSizeBucket, 2);
      assert.equal(claude.factors.evidenceWindowHours, 168);
    });
  }
}

test("c2n 06:05Z: phantom success rows are dropped, so mistral's malformed record shows", async () => {
  load(C2N, C2N.laterDecisionAt!, 0);
  const d = await assembleAndRank(true, COMPACTION_BODY);
  const mistral = entry(d, MISTRAL[1]);
  assert.equal(mistral.factors.reliabilitySource, "usage_durable");
  assert.ok(mistral.factors.reliability < 0.7, String(mistral.factors.reliability));
  assert.ok(mistral.factors.health < 0.5, String(mistral.factors.health));
  assert.ok(
    mistral.factors.evidenceRowsExcluded! >= 10,
    "the 10 phantoms are among the exclusions"
  );
});

test("flag ON without a request class keeps today's evidence exactly", async () => {
  load(T2S, T2S.decisionAt, 0);
  const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
  const strip = (cs: unknown[]) =>
    JSON.parse(JSON.stringify(cs).replace(/"(evaluatedAt|acquiredAt)":"[^"]+"/g, '"$1":"-"'));
  const off = strip(await buildAutoCandidates(targets(), "x", null, undefined, null, true));
  process.env.ROUTING_DURABLE_EVIDENCE = "1";
  try {
    const noClass = strip(
      await buildAutoCandidates(targets(), "x", null, undefined, null, true, {
        requestClass: null,
      })
    );
    const noArg = strip(await buildAutoCandidates(targets(), "x", null, undefined, null, true));
    assert.deepEqual(noClass, off);
    assert.deepEqual(noArg, off);
  } finally {
    delete process.env.ROUTING_DURABLE_EVIDENCE;
  }
  const offWithClass = strip(
    await buildAutoCandidates(targets(), "x", null, undefined, null, true, {
      requestClass: "t2s",
    })
  );
  assert.deepEqual(offWithClass, off);
});

test("fail-safe: when the evidence read throws, the 24 h path is used and the decision says so", async () => {
  load(T2S, T2S.decisionAt, 0);
  const db = getDbInstance();
  const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
  // Expected 24 h result, read before the evidence table becomes unreadable.
  const expected = await buildAutoCandidates(targets(), "x", null, undefined, null, true);
  // A view that fails on the column the durable reader selects but the 24 h reader does not.
  db.exec("ALTER TABLE usage_history RENAME TO usage_history_real");
  db.exec(`CREATE VIEW usage_history AS SELECT id, provider, model, success, latency_ms, ttft_ms,
    tokens_output, error_code, timestamp FROM usage_history_real`);
  process.env.ROUTING_DURABLE_EVIDENCE = "1";
  try {
    const cands = (await buildAutoCandidates(targets(), "x", null, undefined, null, true, {
      requestClass: "t2s",
    })) as Array<{ durableEvidence?: { status: string }; errorRate: number }>;
    for (const c of cands) {
      assert.match(c.durableEvidence!.status, /^unavailable:/);
    }
    assert.deepEqual(
      cands.map((c) => c.errorRate),
      (expected as Array<{ errorRate: number }>).map((c) => c.errorRate),
      "the 24 h evidence is used unchanged"
    );
    const d = rankFitFirstFreeCandidates({
      candidates: cands as never,
      body: TERMINAL_BODY,
      zeroAdditionalCostProviders: ["claude", "nvidia"],
      settings: fairSelectionSettings(),
    });
    assert.match(d.ranked[0].factors.evidenceStatus!, /^unavailable:/);
    assert.equal(d.ranked[0].factors.evidenceWindowHours, undefined);
  } finally {
    delete process.env.ROUTING_DURABLE_EVIDENCE;
    db.exec("DROP VIEW usage_history");
    db.exec("ALTER TABLE usage_history_real RENAME TO usage_history");
  }
});

test("flag OFF: an observed 24 h candidate at about 60% reliability keeps health 1, as on base", async () => {
  const db = getDbInstance();
  db.prepare("DELETE FROM usage_history").run();
  const insert = db.prepare(
    `INSERT INTO usage_history (provider, model, tokens_input, tokens_output, status, success,
       latency_ms, ttft_ms, error_code, request_class, timestamp)
     VALUES ('syn-e', 'sixty', 0, 5, ?, ?, 800, 0, ?, 'c2n', ?)`
  );
  for (let i = 0; i < 15; i++) {
    const ok = i < 9 ? 1 : 0;
    insert.run(
      ok ? "200" : "502",
      ok,
      ok ? null : "upstream_error",
      new Date(Date.now() - (i + 1) * 60_000).toISOString()
    );
  }
  const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
  const assemble = async () =>
    (await buildAutoCandidates(
      [
        {
          kind: "model",
          provider: "syn-e",
          modelStr: "syn-e/sixty",
          stepId: "s",
          executionKey: "s",
          connectionId: null,
        },
      ] as never,
      "x",
      null,
      undefined,
      null,
      true,
      { requestClass: "c2n" }
    )) as never as Parameters<typeof rankFitFirstFreeCandidates>[0]["candidates"];
  const rank = (cands: Awaited<ReturnType<typeof assemble>>) =>
    rankFitFirstFreeCandidates({
      candidates: cands,
      body: COMPACTION_BODY,
      zeroAdditionalCostProviders: ["syn-e"],
      settings: fairSelectionSettings(),
    }).ranked[0].factors;
  const off = rank(await assemble());
  assert.equal(off.reliabilitySource, "usage_24h");
  assert.ok(Math.abs(off.reliability - (2 + 9) / (4 + 15)) < 1e-9);
  assert.equal(off.health, 1, "flag off: the base rule, health 1 below the confident-failure bar");
  process.env.ROUTING_DURABLE_EVIDENCE = "1";
  try {
    const on = rank(await assemble());
    assert.equal(on.reliabilitySource, "usage_durable");
    assert.ok(on.health < 0.5, "flag on: the same record is below an untried model");
  } finally {
    delete process.env.ROUTING_DURABLE_EVIDENCE;
  }
});

// ── Owner decision 2026-11-26 ("Keep them on NVIDIA"): light requests (no tools, size 0, c0*) keep
// today's 24 h path even with the flag on, so Busola and Cammy light chat do not move. The rule is
// keyed on the request class only (requestClassTier === "heavy"), never on a route or combo.

const LIGHT_BODIES = {
  c0s: { stream: true, messages: [{ role: "user", content: "What time is it in Boston?" }] },
  c0n: { stream: false, messages: [{ role: "user", content: "Say hi to Ates." }] },
};

// Owner decision later on 2026-11-26 ("dont delete the light chat split just switch for now to same
// logic"): the split now runs only with ROUTING_LIGHT_TIER_SPLIT=1, so these tests set it. Without it
// light requests take the durable path like every other class (quality-first-ranking-20261126.test.ts).
for (const [cls, body] of Object.entries(LIGHT_BODIES)) {
  test(`light ${cls}, flag ON with ROUTING_LIGHT_TIER_SPLIT=1: ranks exactly as flag OFF and keeps the NVIDIA pick`, async () => {
    assert.equal(deriveRequestClass(body), cls);
    process.env.ROUTING_LIGHT_TIER_SPLIT = "1";
    load(C2N, C2N.laterDecisionAt!, 0);
    const off = await assembleAndRank(false, body);
    load(C2N, C2N.laterDecisionAt!, 0);
    const on = await assembleAndRank(true, body);
    delete process.env.ROUTING_LIGHT_TIER_SPLIT;
    console.log(`light ${cls} OFF`, JSON.stringify(brief(off)));
    console.log(`light ${cls} ON `, JSON.stringify(brief(on)));
    assert.equal(off.ranked[0].candidate.provider, "nvidia", "base picks the NVIDIA model");
    const strip = (d: Decision) =>
      d.ranked.map((e) => {
        const { evidenceStatus, ...factors } = e.factors;
        return [e.candidate.provider, e.candidate.model, factors, evidenceStatus];
      });
    const a = strip(off);
    const b = strip(on);
    assert.deepEqual(
      b.map((x) => x.slice(0, 3)),
      a.map((x) => x.slice(0, 3)),
      "same order, same factors"
    );
    for (const x of b) assert.equal(x[3], "light_tier_24h");
    for (const e of on.ranked) {
      assert.notEqual(e.factors.reliabilitySource, "usage_durable");
      assert.equal(e.factors.evidenceWindowHours, undefined);
    }
  });
}

for (const [cls, body] of Object.entries({
  t0s: {
    stream: true,
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "ls" }],
  },
  c1n: { stream: false, messages: [{ role: "user", content: "Summarise this. ".repeat(2_500) }] },
  c2n: COMPACTION_BODY,
})) {
  test(`heavy ${cls}, flag ON: still uses the durable path`, async () => {
    assert.equal(deriveRequestClass(body), cls);
    load(C2N, C2N.laterDecisionAt!, 0);
    const on = await assembleAndRank(true, body);
    const claude = entry(on, CLAUDE[1]);
    assert.equal(claude.factors.evidenceStatus, "active");
    assert.equal(claude.factors.reliabilitySource, "usage_durable");
  });
}

test("t2s flap guard: 4 ok + 1 failure for Claude in the last 2 h keeps Claude first", async () => {
  for (const [label, failure] of [
    ["upstream failure", { code: "upstream_error", ms: 4_000 }],
    ["client_disconnected after 30 s", { code: "client_disconnected", ms: 30_000 }],
  ] as const) {
    load(T2S, T2S.decisionAt, 0);
    const insert = getDbInstance().prepare(
      `INSERT INTO usage_history (provider, model, tokens_input, tokens_output, status, success,
         latency_ms, ttft_ms, error_code, request_class, timestamp)
       VALUES ('claude', 'claude-opus-4-8', 0, ?, ?, ?, ?, 0, ?, 't2s', ?)`
    );
    for (let i = 0; i < 4; i++) {
      insert.run(
        50,
        "200",
        1,
        20_000,
        null,
        new Date(Date.now() - (i + 2) * 600_000).toISOString()
      );
    }
    insert.run(0, "502", 0, failure.ms, failure.code, new Date(Date.now() - 300_000).toISOString());
    const d = await assembleAndRank(true, TERMINAL_BODY);
    console.log(`flap ${label}`, JSON.stringify(brief(d)));
    assert.equal(d.ranked[0].candidate.model, CLAUDE[1], label);
    // no override: one failure leaves Claude's record where it was (0.93 at this decision)
    assert.ok(entry(d, CLAUDE[1]).factors.reliability > 0.9, label);
  }
});
