/**
 * Fair, evidence-representative model selection (2026-11-21), parts A, C, D, E, F (B, exploration, was removed: see bandSelection.ts).
 *
 * Every test that depends on evidence goes through the production candidate assembly
 * (buildAutoCandidates) over seeded usage rows, then through the production ranker, in the style
 * of client-abandon-neutral-20261121.test.ts. Provider names are synthetic; where a test needs the
 * routing guard's own fallback rule it says so.
 *
 * Settings are passed to the ranker directly. ROUTING_CLASS_EVIDENCE is also set in the process
 * environment while a test assembles candidates, because assembly reads it from there.
 */
// First import: sends DATA_DIR to a throwaway directory and refuses a live data path.
import "../../scripts/tools/replayIsolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { resetDbInstance, getDbInstance } from "@/lib/db/core";
import { saveRequestUsage } from "../../src/lib/usage/usageHistory.ts";
import { runWithRequestClass } from "../../src/lib/usage/requestClassContext.ts";
import { USAGE_SOURCE_ROUTING_CANARY } from "../../src/shared/constants/usageSource.ts";
import { rankFitFirstFreeCandidates } from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import {
  fairSelectionSettings,
  type FairSelectionSettings,
} from "../../open-sse/services/autoCombo/fairSelectionSettings.ts";
import {
  deriveRequestClass,
  requestClassTier,
  approximateInputTokens,
} from "../../open-sse/services/autoCombo/requestClass.ts";
import {
  aggregateOutcomeRows,
  classReliability,
  CLASS_VERIFIED_MIN_SAMPLES,
} from "../../open-sse/services/autoCombo/classEvidence.ts";
import {
  recordContextRejection,
  getLearnedContextCap,
  learnedCapExcludes,
  parseStatedContextLimit,
  isLearnableContextRejection,
} from "../../src/lib/db/learnedContextCaps.ts";
import { evaluateContextLimit } from "../../open-sse/services/combo/contextOverrideGate.ts";

test.after(() => {
  resetDbInstance();
  delete process.env.ROUTING_CLASS_EVIDENCE;
  delete process.env.ROUTING_LEARNED_CONTEXT_CAP;
});

const OFF = fairSelectionSettings({});
const settings = (over: Partial<FairSelectionSettings>): FairSelectionSettings => ({
  ...OFF,
  ...over,
});

let seq = 0;
const ago = () => new Date(Date.now() - 1000 * ++seq).toISOString();

async function row(
  provider: string,
  model: string,
  o: {
    cls?: string | null;
    ok?: boolean;
    code?: string;
    probe?: boolean;
    out?: number;
    ms?: number;
  } = {}
) {
  const ok = o.ok !== false;
  await saveRequestUsage({
    provider,
    model,
    success: ok,
    status: ok ? "200" : "504",
    errorCode: ok ? null : (o.code ?? "upstream_error"),
    latencyMs: o.ms ?? 800,
    timeToFirstTokenMs: 100,
    tokens: { input: 10, output: ok ? (o.out ?? 5) : 0 },
    timestamp: ago(),
    requestClass: o.cls ?? null,
    source: o.probe ? USAGE_SOURCE_ROUTING_CANARY : null,
  });
}
async function rows(provider: string, model: string, n: number, o: Parameters<typeof row>[2] = {}) {
  for (let i = 0; i < n; i++) await row(provider, model, o);
}

async function assemble(targets: Array<[string, string]>) {
  const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
  return (await buildAutoCandidates(
    targets.map(([provider, model]) => ({
      kind: "model",
      provider,
      modelStr: `${provider}/${model}`,
      stepId: model,
      executionKey: model,
      connectionId: null,
    })) as never,
    "fair-selection-fixture"
  )) as never as Parameters<typeof rankFitFirstFreeCandidates>[0]["candidates"];
}

function rank(
  candidates: Awaited<ReturnType<typeof assemble>>,
  body: Record<string, unknown>,
  s: FairSelectionSettings
) {
  return rankFitFirstFreeCandidates({
    candidates,
    body,
    zeroAdditionalCostProviders: [...new Set(candidates.map((c) => c.provider))],
    settings: s,
  });
}

async function withClassEvidence<T>(fn: () => Promise<T>): Promise<T> {
  process.env.ROUTING_CLASS_EVIDENCE = "1";
  try {
    return await fn();
  } finally {
    delete process.env.ROUTING_CLASS_EVIDENCE;
  }
}

const TOOLS_BODY = (extra: Record<string, unknown> = {}) => ({
  stream: true,
  tools: [{ type: "function", function: { name: "run", parameters: { type: "object" } } }],
  messages: [{ role: "user", content: "Implement the change and run the tests." }],
  ...extra,
});
// A large prompt with no tools: class c1s (heavy tier, replay-safe class). Used where a heavy
// request must be ranked among synthetic providers, whose unknown models cannot take tools.
const HEAVY_BODY = (extra: Record<string, unknown> = {}) => ({
  stream: true,
  messages: [{ role: "user", content: "Summarise this log. ".repeat(1_600) }],
  ...extra,
});
const PLAIN_BODY = (id: string, extra: Record<string, unknown> = {}) => ({
  conversation_id: id,
  messages: [{ role: "user", content: "Explain what a mutex is." }],
  ...extra,
});

// ───────────────────────────── A. request class and class evidence ─────────────────────────────

test("A: request class comes from tools, size and streaming only", () => {
  assert.equal(deriveRequestClass({ messages: [{ role: "user", content: "hi" }] }), "c0n");
  assert.equal(
    deriveRequestClass({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    "c0s"
  );
  assert.equal(deriveRequestClass(TOOLS_BODY()), "t0s");
  assert.equal(
    deriveRequestClass({
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "x", name: "y" }] }],
    }),
    "t0n"
  );
  const big = "x".repeat(4 * 9_000);
  assert.equal(deriveRequestClass({ messages: [{ role: "user", content: big }] }), "c1n");
  assert.equal(
    deriveRequestClass({ messages: [{ role: "user", content: big + big + big + big }] }),
    "c2n"
  );
  assert.equal(deriveRequestClass(null), null);
  assert.ok(approximateInputTokens({ system: "x".repeat(400) }) === 100);
  assert.equal(requestClassTier("c0s"), "light");
  assert.equal(requestClassTier("c1n"), "heavy");
  assert.equal(requestClassTier("t0s"), "heavy");
  assert.equal(requestClassTier("zzz"), null);
});

test("A: the class is stored on the usage row, from the argument or the request context", async () => {
  await row("cls-p", "m1", { cls: "t2s" });
  await saveRequestUsage({
    provider: "cls-p",
    model: "m1",
    success: true,
    tokens: { input: 1, output: 1 },
    timestamp: ago(),
  });
  await runWithRequestClass("c1n", () =>
    saveRequestUsage({
      provider: "cls-p",
      model: "m1",
      success: true,
      tokens: { input: 2, output: 2 },
      timestamp: ago(),
    })
  );
  const found = getDbInstance()
    .prepare("SELECT request_class AS c FROM usage_history WHERE provider = 'cls-p' ORDER BY id")
    .all() as Array<{ c: string | null }>;
  assert.deepEqual(
    found.map((r) => r.c),
    ["t2s", null, "c1n"]
  );
});

test("A: a probe success never counts for a heavy request, and counts as light evidence only", () => {
  const base = Array.from({ length: 30 }, () => ({
    provider: "pa",
    model: "m",
    success: true,
    requestClass: "t2s",
  }));
  const fails = Array.from({ length: 3 }, () => ({
    provider: "pa",
    model: "m",
    success: false,
    errorCode: "upstream_error",
    requestClass: "t2s",
  }));
  const probes = Array.from({ length: 40 }, () => ({
    provider: "pa",
    model: "m",
    success: true,
    source: USAGE_SOURCE_ROUTING_CANARY,
    requestClass: "t2s", // even a mislabelled probe is forced into the light tier
  }));
  const without = aggregateOutcomeRows([...base, ...fails]);
  const withProbes = aggregateOutcomeRows([...base, ...fails, ...probes]);
  const heavyA = classReliability(without, "pa", "m", "t2s")!;
  const heavyB = classReliability(withProbes, "pa", "m", "t2s")!;
  assert.equal(heavyA.score, heavyB.score, "probes must not move a heavy-class estimate");
  assert.equal(heavyA.tierSamples, heavyB.tierSamples);
  const lightA = classReliability(without, "pa", "m", "c0s")!;
  const lightB = classReliability(withProbes, "pa", "m", "c0s")!;
  assert.ok(lightB.tierSamples > lightA.tierSamples, "probes are light-class evidence");
});

test("A: a thin class never looks perfect or terrible and moves smoothly with each sample", () => {
  const pool = (extra: Array<Record<string, unknown>>) =>
    aggregateOutcomeRows([
      ...Array.from({ length: 90 }, () => ({
        provider: "ref",
        model: "r",
        success: true,
        requestClass: "t2s",
      })),
      ...Array.from({ length: 10 }, () => ({
        provider: "ref",
        model: "r",
        success: false,
        errorCode: "e",
        requestClass: "t2s",
      })),
      ...(extra as never[]),
    ]);
  const one = classReliability(
    pool([{ provider: "x", model: "x", success: true, requestClass: "t2s" }]),
    "x",
    "x",
    "t2s"
  )!;
  const zero = classReliability(
    pool(
      Array.from({ length: 4 }, () => ({
        provider: "x",
        model: "x",
        success: false,
        errorCode: "e",
        requestClass: "t2s",
      }))
    ),
    "x",
    "x",
    "t2s"
  )!;
  const none = classReliability(pool([]), "x", "x", "t2s")!;
  assert.ok(one.score < 1 && one.score > none.score, `1/1 ${one.score} vs unseen ${none.score}`);
  assert.ok(zero.score > 0 && zero.score < none.score, `0/4 ${zero.score} vs unseen ${none.score}`);
  const failedOnce = classReliability(
    pool([{ provider: "x", model: "x", success: false, errorCode: "e", requestClass: "t2s" }]),
    "x",
    "x",
    "t2s"
  )!;
  assert.ok(
    one.score - failedOnce.score < 0.2,
    "a single sample moves the estimate by a bounded step"
  );
  // monotone in successes at a fixed sample size
  let last = -1;
  for (let ok = 0; ok <= 8; ok++) {
    const r = aggregateOutcomeRows([
      ...Array.from({ length: ok }, () => ({
        provider: "m",
        model: "m",
        success: true,
        requestClass: "t2s",
      })),
      ...Array.from({ length: 8 - ok }, () => ({
        provider: "m",
        model: "m",
        success: false,
        errorCode: "e",
        requestClass: "t2s",
      })),
    ]);
    const s = classReliability(r, "m", "m", "t2s")!.score;
    assert.ok(s > last);
    last = s;
  }
});

test("A: short client aborts are not evidence about the model; a replay-blocked terminal failure is", () => {
  const r = aggregateOutcomeRows([
    {
      provider: "p",
      model: "m",
      success: false,
      errorCode: "routing_transport_replay_blocked",
      requestClass: "t2s",
    },
    {
      provider: "p",
      model: "m",
      success: false,
      errorCode: "client_disconnected",
      latencyMs: 2000,
      requestClass: "t2s",
    },
    { provider: "p", model: "m", success: true, requestClass: "t2s" },
  ]);
  assert.equal(
    classReliability(r, "p", "m", "t2s")!.tierSamples,
    2,
    "the abort is skipped, the replay-blocked failure counts"
  );
});

test("A: production assembly, heavy request: canary probes cannot make a probe-only model look proven", async () => {
  await withClassEvidence(async () => {
    // "proven": real heavy traffic 29 of 30. "probed": only canary probes, all successful.
    await rows("fa-p", "proven", 29, { cls: "c1s" });
    await row("fa-p", "proven", { cls: "c1s", ok: false });
    await rows("fa-q", "probed", 40, { cls: "c0s", probe: true });
    const cands = await assemble([
      ["fa-p", "proven"],
      ["fa-q", "probed"],
    ]);
    const legacy = rank(cands, HEAVY_BODY(), OFF);
    const byClass = rank(cands, HEAVY_BODY(), settings({ classEvidence: true }));
    const f = (d: typeof legacy, model: string) =>
      d.ranked.find((e) => e.candidate.model === model)!.factors;
    // legacy: the probe-only model has a perfect pooled rate and the higher reliability term
    assert.ok(f(legacy, "probed").reliability > f(legacy, "proven").reliability);
    // class evidence: the probe-only model has no heavy-class sample at all
    assert.equal(f(byClass, "probed").classEvidence!.tierSamples, 0);
    assert.equal(f(byClass, "probed").classEvidence!.verified, false);
    assert.equal(f(byClass, "proven").classEvidence!.verified, true);
    assert.equal(byClass.ranked[0].candidate.model, "proven");
    assert.equal(f(byClass, "proven").reliabilitySource, "usage_24h_class");
  });
});

test("A: with no row at all the ranker keeps the old evidence", async () => {
  await withClassEvidence(async () => {
    getDbInstance().prepare("DELETE FROM usage_history").run();
    const cands = await assemble([["fb-p", "no-rows"]]);
    const on = rank(cands, HEAVY_BODY(), settings({ classEvidence: true }));
    const off = rank(cands, HEAVY_BODY(), OFF);
    assert.equal(on.ranked[0].factors.reliabilitySource, off.ranked[0].factors.reliabilitySource);
    assert.equal(on.ranked[0].factors.reliability, off.ranked[0].factors.reliability);
    assert.equal(on.ranked[0].factors.classEvidence, undefined);
  });
});

test("A: rows written before the class existed are read as heavy evidence, probes stay light", async () => {
  await withClassEvidence(async () => {
    getDbInstance().prepare("DELETE FROM usage_history").run();
    // legacy real traffic (no class): 28 of 30 succeed. Probes: 40 successes, tagged by source.
    await rows("lg-p", "m", 28);
    await rows("lg-p", "m", 2, { ok: false });
    await rows("lg-q", "m", 40, { probe: true });
    const cands = await assemble([
      ["lg-p", "m"],
      ["lg-q", "m"],
    ]);
    const heavy = rank(cands, HEAVY_BODY(), settings({ classEvidence: true }));
    const byP = (n: string) => heavy.ranked.find((e) => e.candidate.provider === n)!.factors;
    assert.equal(heavy.ranked[0].factors.classEvidenceStatus, "active");
    assert.equal(byP("lg-p").classEvidence!.verified, true);
    assert.equal(
      byP("lg-q").classEvidence!.tierSamples,
      0,
      "probes are invisible to a heavy request"
    );
    assert.equal(heavy.ranked[0].candidate.provider, "lg-p");
  });
});

test("A: legacy-only rows do not move light traffic: the light tier is not covered, the old evidence stays", async () => {
  await withClassEvidence(async () => {
    getDbInstance().prepare("DELETE FROM usage_history").run();
    // a heavy-looking, well proven model with 150 unclassified real rows, and a model that has
    // only ten canary probes (9 of 10): exactly the shape that flipped light chat to the probed
    // model when unclassified rows were all read as heavy.
    await rows("lc-a", "m", 148);
    await rows("lc-a", "m", 2, { ok: false });
    await rows("lc-b", "m", 9, { probe: true });
    await rows("lc-b", "m", 1, { probe: true, ok: false });
    const cands = await assemble([
      ["lc-a", "m"],
      ["lc-b", "m"],
    ]);
    const on = rank(cands, PLAIN_BODY("lc"), settings({ classEvidence: true }));
    const off = rank(cands, PLAIN_BODY("lc"), OFF);
    assert.equal(on.ranked[0].factors.classEvidenceStatus, "insufficient_coverage:light");
    assert.equal(on.ranked[0].factors.classEvidence, undefined);
    assert.deepEqual(
      on.ranked.map((e) => [e.candidate.provider, e.factors.score]),
      off.ranked.map((e) => [e.candidate.provider, e.factors.score]),
      "light ranking is exactly the old ranking until real light rows exist"
    );
    // heavy traffic IS covered (the unclassified rows are real heavy-tier evidence)
    const heavy = rank(cands, HEAVY_BODY(), settings({ classEvidence: true }));
    assert.equal(heavy.ranked[0].factors.classEvidenceStatus, "active");
    // once 20 real light rows exist the light tier is covered
    await rows("lc-a", "m", 20, { cls: "c0n" });
    const covered = rank(
      await assemble([
        ["lc-a", "m"],
        ["lc-b", "m"],
      ]),
      PLAIN_BODY("lc"),
      settings({ classEvidence: true })
    );
    assert.equal(covered.ranked[0].factors.classEvidenceStatus, "active");
  });
});

test("safety: the isolation guard refuses a symlink to a live data path and a path inside one", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fakehome-"));
  const innocent = fs.mkdtempSync(path.join(os.tmpdir(), "innocent-"));
  fs.symlinkSync(innocent, path.join(home, ".omniroute"));
  const guard = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "scripts",
    "tools",
    "replayIsolation.ts"
  );
  const run = (dataDir?: string) =>
    spawnSync("node", ["--import", "tsx/esm", "-e", `import ${JSON.stringify(guard)}`], {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: { ...process.env, HOME: home, ...(dataDir ? { DATA_DIR: dataDir } : { DATA_DIR: "" }) },
      encoding: "utf8",
    });
  assert.equal(run(innocent).status, 2, "a symlinked live dir is refused");
  assert.equal(run(path.join(home, ".omniroute", "sub")).status, 2, "a path inside it is refused");
  assert.equal(fs.readdirSync(innocent).length, 0, "nothing was written there");
  assert.equal(run().status, 0, "with DATA_DIR unset it uses a throwaway directory");
});

test("A: a model with one lucky heavy sample never outranks a verified one on reliability or health", async () => {
  await withClassEvidence(async () => {
    getDbInstance().prepare("DELETE FROM usage_history").run();
    await rows("lk-a", "m", 30, { cls: "c1s" });
    await row("lk-a", "m", { cls: "c1s", ok: false });
    await row("lk-b", "m", { cls: "c1s" });
    const cands = await assemble([
      ["lk-a", "m"],
      ["lk-b", "m"],
    ]);
    const d = rank(cands, HEAVY_BODY(), settings({ classEvidence: true }));
    const f = (n: string) => d.ranked.find((e) => e.candidate.provider === n)!.factors;
    assert.ok(f("lk-a").reliability > f("lk-b").reliability);
    assert.ok(f("lk-a").health > f("lk-b").health);
    assert.equal(d.ranked[0].candidate.provider, "lk-a");
  });
});

test("A: a model with only good light evidence never outranks a verified heavy model on reliability", async () => {
  await withClassEvidence(async () => {
    getDbInstance().prepare("DELETE FROM usage_history").run();
    await rows("vr-a", "m", 29, { cls: "c1s" });
    await rows("vr-a", "m", 1, { cls: "c1s", ok: false });
    await rows("vr-b", "m", 40, { cls: "c0s", probe: true });
    await rows("vr-c", "m", 90, { cls: "c1s" });
    const cands = await assemble([
      ["vr-a", "m"],
      ["vr-b", "m"],
      ["vr-c", "m"],
    ]);
    const d = rank(cands, HEAVY_BODY(), settings({ classEvidence: true }));
    const f = (n: string) => d.ranked.find((e) => e.candidate.provider === n)!.factors;
    assert.ok(f("vr-b").reliability <= 0.5 + 1e-9, `untried ${f("vr-b").reliability}`);
    assert.ok(f("vr-a").reliability > f("vr-b").reliability);
    assert.ok(f("vr-c").reliability > f("vr-a").reliability);
  });
});

// ───────────────────────────── C. spread tie-break and band ─────────────────────────────

test("C: a tie is never won by the candidate with thinner class evidence", async () => {
  await withClassEvidence(async () => {
    await rows("tb-a", "m", 12, { cls: "c0n" });
    await rows("tb-b", "m", 12, { cls: "c0n" });
    await rows("tb-c", "m", 1, { cls: "c0n" });
    const cands = await assemble([
      ["tb-a", "m"],
      ["tb-b", "m"],
      ["tb-c", "m"],
    ]);
    for (let i = 0; i < 60; i++) {
      const d = rank(
        cands,
        PLAIN_BODY(`tie-${i}`),
        settings({ classEvidence: true, spreadTieBreak: true })
      );
      const top = d.ranked[0];
      // thin candidate has a lower pooled score here, so it can never lead
      assert.notEqual(top.candidate.provider, "tb-c");
    }
  });
});

test("C: spread draws the provider first: a provider listing many models does not win proportionally more", async () => {
  const mk = (provider: string, model: string) => ({
    provider,
    model,
    modelStr: `${provider}/${model}`,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED" as const,
    costPer1MTokens: 1,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
  });
  // three providers; "wide" lists 8 distinct models, the other two list one each. All exactly equal.
  const candidates = [
    ...Array.from({ length: 8 }, (_, i) => mk("wide", `model-${i}-a${i}`)),
    mk("narrow1", "only-one"),
    mk("narrow2", "only-two"),
  ];
  const share = (spread: boolean) => {
    const wins = new Map<string, number>();
    for (let i = 0; i < 600; i++) {
      const d = rankFitFirstFreeCandidates({
        candidates,
        body: PLAIN_BODY(`spread-${i}`),
        zeroAdditionalCostProviders: ["wide", "narrow1", "narrow2"],
        settings: settings({ spreadTieBreak: spread }),
      });
      const p = d.ranked[0].candidate.provider;
      wins.set(p, (wins.get(p) ?? 0) + 1);
    }
    return wins;
  };
  const legacy = share(false);
  const spread = share(true);
  assert.ok(
    (legacy.get("wide") ?? 0) > 360,
    `legacy favours the wide provider: ${legacy.get("wide")}`
  );
  for (const p of ["wide", "narrow1", "narrow2"]) {
    const n = spread.get(p) ?? 0;
    assert.ok(n > 140 && n < 260, `${p} wins ${n} of 600 with spread, expected about 200`);
  }
});

test("C: one conversation draws the same winner on every turn", async () => {
  const mk = (provider: string) => ({
    provider,
    model: "m",
    modelStr: `${provider}/m`,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED" as const,
    costPer1MTokens: 1,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
  });
  const candidates = ["s1", "s2", "s3", "s4"].map(mk);
  const turn = (n: number) =>
    rankFitFirstFreeCandidates({
      candidates,
      body: {
        conversation_id: "stable-conv",
        messages: Array.from({ length: n }, (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          content: `t${i}`,
        })),
      },
      zeroAdditionalCostProviders: ["s1", "s2", "s3", "s4"],
      settings: settings({ spreadTieBreak: true }),
    }).ranked[0].candidate.provider;
  const first = turn(1);
  for (const n of [3, 5, 9]) assert.equal(turn(n), first);
});

test("C: a candidate five points less reliable is never inside the band", async () => {
  await withClassEvidence(async () => {
    getDbInstance().prepare("DELETE FROM usage_history").run();
    await rows("b5-a", "m", 60, { cls: "c1s" });
    await rows("b5-b", "m", 57, { cls: "c1s" });
    await rows("b5-b", "m", 3, { cls: "c1s", ok: false }); // 95%
    const cands = await assemble([
      ["b5-a", "m"],
      ["b5-b", "m"],
    ]);
    for (let i = 0; i < 100; i++) {
      const d = rank(
        cands,
        HEAVY_BODY({ conversation_id: `b5-${i}` }),
        settings({ classEvidence: true, spreadTieBreak: true, tieBand: 0.02 })
      );
      assert.equal(d.ranked[0].candidate.provider, "b5-a");
    }
  });
});

test("C: band selection spreads picks among verified, equally reliable candidates and never reaches a thin or less reliable one", async () => {
  await withClassEvidence(async () => {
    await rows("bd-a", "m", 40, { cls: "c1s" });
    await rows("bd-b", "m", 40, { cls: "c1s" });
    await rows("bd-c", "m", 36, { cls: "c1s" });
    await rows("bd-c", "m", 4, { cls: "c1s", ok: false }); // 90%: measurably less reliable
    await rows("bd-d", "m", 1, { cls: "c1s" }); // thin
    const cands = await assemble([
      ["bd-a", "m"],
      ["bd-b", "m"],
      ["bd-c", "m"],
      ["bd-d", "m"],
    ]);
    const wins = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const d = rank(
        cands,
        HEAVY_BODY({ conversation_id: `band-${i}` }),
        settings({ classEvidence: true, spreadTieBreak: true, tieBand: 0.02 })
      );
      const p = d.ranked[0].candidate.provider;
      wins.set(p, (wins.get(p) ?? 0) + 1);
    }
    assert.ok(
      (wins.get("bd-a") ?? 0) > 60 && (wins.get("bd-b") ?? 0) > 60,
      JSON.stringify([...wins])
    );
    assert.equal(
      wins.get("bd-c") ?? 0,
      0,
      "a measurably less reliable candidate is outside the band"
    );
    assert.equal(wins.get("bd-d") ?? 0, 0, "a thin candidate is outside the band");
  });
});

// ───────────────────────────── D. learned context caps ─────────────────────────────

test("D: a too-long rejection is learned only for a clear rejection, with the stated limit when named", () => {
  assert.equal(isLearnableContextRejection(400, "prompt is too long: 135000 tokens"), true);
  assert.equal(
    isLearnableContextRejection(400, "This model's maximum context length is 32768 tokens."),
    true
  );
  assert.equal(isLearnableContextRejection(429, "prompt is too long"), false);
  assert.equal(isLearnableContextRejection(400, "max_tokens must be at least 1"), false);
  assert.equal(
    parseStatedContextLimit("maximum context length is 32,768 tokens, you requested 40000"),
    32768
  );
  assert.equal(parseStatedContextLimit("prompt is too long"), null);
});

test("D: recording does nothing while the setting is off, and the cap is enforced only in enforce mode", () => {
  delete process.env.ROUTING_LEARNED_CONTEXT_CAP;
  const rej = (
    model: string,
    required: number,
    message = "prompt is too long",
    connectionId?: string
  ) =>
    recordContextRejection({
      provider: "lc-p",
      model,
      connectionId,
      requiredTokens: required,
      status: 400,
      message,
    });
  assert.equal(rej("m", 40_000), false);
  assert.equal(getLearnedContextCap("lc-p", "m"), null);

  process.env.ROUTING_LEARNED_CONTEXT_CAP = "learn";
  assert.equal(rej("m", 40_000), true);
  assert.equal(getLearnedContextCap("lc-p", "m")!.rejectedTokens, 40_000);
  assert.equal(
    learnedCapExcludes("lc-p", "m", 50_000),
    false,
    "learn mode records but never excludes"
  );

  process.env.ROUTING_LEARNED_CONTEXT_CAP = "enforce";
  assert.equal(
    learnedCapExcludes("lc-p", "m", 50_000),
    false,
    "one unexplained rejection is not enough"
  );
  rej("m", 45_000);
  assert.equal(learnedCapExcludes("lc-p", "m", 50_000), true);
  assert.equal(
    learnedCapExcludes("lc-p", "m", 40_000),
    true,
    "the smallest rejected size is excluded"
  );
  assert.equal(learnedCapExcludes("lc-p", "m", 39_999), false);
  assert.equal(
    learnedCapExcludes("lc-p", "other-model", 50_000),
    false,
    "scoped to one provider and model"
  );
  // the cap only tightens on rejections
  rej("m", 90_000);
  assert.equal(getLearnedContextCap("lc-p", "m")!.rejectedTokens, 40_000);
  // tiny rejections without a stated limit teach nothing
  assert.equal(rej("tiny", 500), false);
  // a stated limit below the rejected size is established by one rejection
  rej("stated", 100_000, "This model's maximum context length is 65536 tokens");
  assert.equal(learnedCapExcludes("lc-p", "stated", 70_000), true);
  assert.equal(learnedCapExcludes("lc-p", "stated", 60_000), false);
  // keyed by connection: one account's cap does not apply to another account
  rej("conn", 80_000, "prompt is too long", "acct-1");
  rej("conn", 80_000, "prompt is too long", "acct-1");
  assert.equal(learnedCapExcludes("lc-p", "conn", 90_000, "acct-1"), true);
  assert.equal(learnedCapExcludes("lc-p", "conn", 90_000, "acct-2"), false);
  delete process.env.ROUTING_LEARNED_CONTEXT_CAP;
});

test("D: only real context-length rejections are learned", () => {
  const learn = (msg: string) => isLearnableContextRejection(400, msg);
  // wrong before review: rate, tier and image limits
  assert.equal(
    learn("Request too large for model `x` on tokens per minute (TPM): Limit 6000, Requested 9000"),
    false
  );
  assert.equal(
    learn("The input exceeds the rate limit of 4000 tokens per request for your tier"),
    false
  );
  assert.equal(learn("Your request exceeded model token limit: 8192 tokens per minute"), false);
  assert.equal(learn("Input image exceeds the maximum size of 5 MB"), false);
  // real context errors
  assert.equal(learn("prompt is too long: 215000 tokens > 200000 maximum"), true);
  assert.equal(
    learn(
      "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 40000"
    ),
    true
  );
  assert.equal(
    parseStatedContextLimit("`inputs` tokens + `max_new_tokens` must be <= 32768"),
    32768
  );
});

test("D: a later success at or above the cap size drops it, and a contradicting rejection clears a stale stated limit", async () => {
  process.env.ROUTING_LEARNED_CONTEXT_CAP = "enforce";
  try {
    const rej = (required: number, message: string) =>
      recordContextRejection({
        provider: "rx-p",
        model: "m",
        requiredTokens: required,
        status: 400,
        message,
      });
    rej(100_000, "maximum context length is 65536 tokens");
    assert.equal(learnedCapExcludes("rx-p", "m", 70_000), true);
    // the provider accepted a request of 80 000 input tokens: the stated limit was wrong
    await saveRequestUsage({
      provider: "rx-p",
      model: "m",
      success: true,
      tokens: { input: 80_000, output: 5 },
      timestamp: ago(),
    });
    assert.equal(getLearnedContextCap("rx-p", "m"), null);
    // a stale stated limit is cleared by a rejection at or below it
    rej(100_000, "maximum context length is 65536 tokens");
    rej(50_000, "prompt is too long");
    assert.equal(getLearnedContextCap("rx-p", "m")!.statedLimitTokens, null);
  } finally {
    delete process.env.ROUTING_LEARNED_CONTEXT_CAP;
  }
});

test("D: the capability gate excludes a model above its learned cap, over a catalog that says it fits", () => {
  process.env.ROUTING_LEARNED_CONTEXT_CAP = "enforce";
  try {
    const caps = { maxInputTokens: 1_000_000, contextWindow: 1_000_000 };
    const need = (n: number) => ({ estimatedInputTokens: n, requiredContextTokens: n });
    assert.equal(evaluateContextLimit(caps, need(100_000), "gate-p/m"), true);
    recordContextRejection({
      provider: "gate-p",
      model: "m",
      requiredTokens: 100_000,
      status: 400,
      message: "This model's maximum context length is 65536 tokens",
    });
    assert.equal(evaluateContextLimit(caps, need(70_000), "gate-p/m"), false);
    assert.equal(
      evaluateContextLimit(caps, need(60_000), "gate-p/m"),
      true,
      "below the stated limit still fits"
    );
    assert.equal(
      evaluateContextLimit(caps, need(70_000), "gate-q/m"),
      true,
      "other models are untouched"
    );
    process.env.ROUTING_LEARNED_CONTEXT_CAP = "learn";
    assert.equal(
      evaluateContextLimit(caps, need(70_000), "gate-p/m"),
      true,
      "not enforced in learn mode"
    );
  } finally {
    delete process.env.ROUTING_LEARNED_CONTEXT_CAP;
  }
});

test("D: the rule is provider-blind: the same rejection gives the same gate for any name", () => {
  process.env.ROUTING_LEARNED_CONTEXT_CAP = "enforce";
  try {
    const verdicts = ["bl-1", "bl-2", "claude", "nvidia"].map((p) => {
      for (let i = 0; i < 2; i++)
        recordContextRejection({
          provider: p,
          model: "same",
          requiredTokens: 50_000,
          status: 400,
          message: "prompt is too long",
        });
      return [learnedCapExcludes(p, "same", 60_000), learnedCapExcludes(p, "same", 10_000)];
    });
    for (const v of verdicts) assert.deepEqual(v, [true, false]);
  } finally {
    delete process.env.ROUTING_LEARNED_CONTEXT_CAP;
  }
});

// ───────────────────────────── E. outcome quality ─────────────────────────────

test("E: a success with no output counts as a partial failure only when asked, and only with class evidence", async () => {
  const rowsIn = [
    ...Array.from({ length: 6 }, () => ({
      provider: "eq",
      model: "m",
      success: true,
      tokensOutput: 40,
      requestClass: "c1s",
    })),
    ...Array.from({ length: 6 }, () => ({
      provider: "eq",
      model: "m",
      success: true,
      tokensOutput: 0,
      requestClass: "c1s",
    })),
  ];
  const off = classReliability(aggregateOutcomeRows(rowsIn), "eq", "m", "c1s")!;
  const on = classReliability(
    aggregateOutcomeRows(rowsIn, { outcomeQuality: true }),
    "eq",
    "m",
    "c1s"
  )!;
  assert.ok(on.score < off.score, `${on.score} < ${off.score}`);
  assert.ok(off.score - on.score < 0.25, "a small weight: it never reads as a full failure");
});

test("E: production assembly: a model that returns empty successes ranks below one that does not", async () => {
  await withClassEvidence(async () => {
    process.env.ROUTING_OUTCOME_QUALITY = "1";
    try {
      await rows("eq-a", "m", 20, { cls: "c1s", out: 50 });
      await rows("eq-b", "m", 20, { cls: "c1s", out: 0 });
      const cands = await assemble([
        ["eq-a", "m"],
        ["eq-b", "m"],
      ]);
      const body = HEAVY_BODY();
      const off = rank(cands, body, settings({ classEvidence: true }));
      const on = rank(cands, body, settings({ classEvidence: true, outcomeQuality: true }));
      // assembly read ROUTING_OUTCOME_QUALITY from the environment, so both runs use the same pool;
      // the quality weighting is part of the pooled evidence
      const a = on.ranked.find((e) => e.candidate.provider === "eq-a")!.factors.reliability;
      const b = on.ranked.find((e) => e.candidate.provider === "eq-b")!.factors.reliability;
      assert.ok(a > b, `${a} > ${b}`);
      assert.equal(off.ranked.length, 2);
    } finally {
      delete process.env.ROUTING_OUTCOME_QUALITY;
    }
  });
});

// ───────────────────────────── F. defaults and provider blindness ─────────────────────────────

test("F: with no setting every part is off and the ranking equals the old ranking", async () => {
  const s = fairSelectionSettings({});
  assert.deepEqual(s, {
    clientAbandonNeutral: false,
    requestClassWrite: false,
    classEvidence: false,
    outcomeQuality: false,
    spreadTieBreak: false,
    tieBand: 0,
    learnedContextCap: "off",
  });
  await rows("df-a", "m", 10, { cls: "c1s" });
  await rows("df-b", "m", 10, { cls: "c1s" });
  const cands = await assemble([
    ["df-a", "m"],
    ["df-b", "m"],
  ]);
  const a = rank(cands, HEAVY_BODY(), s);
  const b = rank(cands, HEAVY_BODY(), settings({ tieBand: 0.02 }));
  assert.deepEqual(
    a.ranked.map((e) => [e.candidate.provider, e.factors.score]),
    b.ranked.map((e) => [e.candidate.provider, e.factors.score]),
    "band does nothing without class evidence"
  );
});

test("F: settings are bounded and parse the usual spellings", () => {
  const s = fairSelectionSettings({
    ROUTING_REQUEST_CLASS_WRITE: "on",
    ROUTING_CLASS_EVIDENCE: "TRUE",
    ROUTING_TIE_BAND: "9",
    ROUTING_LEARNED_CONTEXT_CAP: "Enforce",
  } as never);
  assert.equal(s.requestClassWrite, true);
  assert.equal(s.classEvidence, true);
  assert.equal(s.tieBand, 0.02);
  assert.equal(s.learnedContextCap, "enforce");
  assert.equal(fairSelectionSettings({ ROUTING_TIE_BAND: "abc" } as never).tieBand, 0);
});

test("F: provider-blind: the same rows under swapped provider names give the same ranks", async () => {
  await withClassEvidence(async () => {
    const clear = () => getDbInstance().prepare("DELETE FROM usage_history").run();
    const run = async (names: [string, string, string]) => {
      clear();
      for (const [i, n] of names.entries()) {
        const good = [40, 40, 1][i];
        await rows(n, "m", good, { cls: "c1s" });
        if (i === 1) await rows(n, "m", 4, { cls: "c1s", ok: false });
      }
      const cands = await assemble(names.map((n) => [n, "m"] as [string, string]));
      const out: Array<{ s: number; order: number[] }> = [];
      for (let i = 0; i < 40; i++) {
        const d = rank(
          cands,
          HEAVY_BODY({ conversation_id: `pb-${i}` }),
          settings({ classEvidence: true, spreadTieBreak: true, tieBand: 0.02 })
        );
        out.push({
          s: d.ranked[0].factors.score,
          order: d.ranked.map((e) => names.indexOf(e.candidate.provider)),
        });
      }
      return out;
    };
    const one = await run(["pb-aa", "pb-bb", "pb-cc"]);
    const two = await run(["zz-1", "zz-2", "zz-3"]);
    // scores identical rank by rank; only the hash-dependent pick may differ between name sets,
    // and the set of reachable first picks is the same
    for (let i = 0; i < one.length; i++) {
      assert.equal(one[i].s.toFixed(9), two[i].s.toFixed(9));
      assert.equal(one[i].order.at(-1), two[i].order.at(-1), "the same candidate ranks last");
    }
    assert.deepEqual(new Set(one.map((r) => r.order[0])), new Set(two.map((r) => r.order[0])));
  });
});

test("CLASS_VERIFIED_MIN_SAMPLES is five", () => {
  assert.equal(CLASS_VERIFIED_MIN_SAMPLES, 5);
});

// ───────────────────────────── safety: un-migrated database, visible fallback ─────────────────────────────

test("F: a usage_history table without request_class still records rows, with every setting off", async () => {
  resetDbInstance();
  const db = getDbInstance();
  db.exec("ALTER TABLE usage_history DROP COLUMN request_class");
  try {
    await saveRequestUsage({
      provider: "um-p",
      model: "m",
      success: true,
      tokens: { input: 3, output: 4 },
      timestamp: ago(),
    });
    const found = db
      .prepare("SELECT COUNT(*) AS n FROM usage_history WHERE provider = 'um-p'")
      .get() as { n: number };
    assert.equal(found.n, 1);
  } finally {
    resetDbInstance(); // reopening restores the column through the startup column repair
  }
});

test("F: when class evidence cannot be read the decision says so instead of silently using the old evidence", async () => {
  process.env.ROUTING_CLASS_EVIDENCE = "1";
  const db = getDbInstance();
  db.exec("ALTER TABLE usage_history DROP COLUMN request_class");
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    const cands = await assemble([["us-p", "m"]]);
    const d = rank(cands, PLAIN_BODY("us"), settings({ classEvidence: true }));
    assert.match(String(d.ranked[0].factors.classEvidenceStatus), /^unavailable:/);
    assert.equal(d.ranked[0].factors.classEvidence, undefined);
    assert.ok(warnings.some((w) => w.includes("class evidence unavailable")));
  } finally {
    console.warn = warn;
    delete process.env.ROUTING_CLASS_EVIDENCE;
    resetDbInstance();
  }
  // with the setting off there is no status at all
  const off = rank(await assemble([["us-p", "m"]]), PLAIN_BODY("us"), OFF);
  assert.equal(off.ranked[0].factors.classEvidenceStatus, undefined);
});
