import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTask,
  getConversationTieKey,
  modelPowerScore,
  reorderByTaskWeight,
  scoreModelForTask,
  TASK_LEVEL_WEIGHT,
  type TaskLevel,
} from "../../open-sse/services/taskAwareRouting.ts";
import {
  rankFitFirstFreeCandidates,
  type FitFirstCandidate,
} from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import {
  DEFAULT_WEIGHTS,
  scorePool,
  type ProviderCandidate,
} from "../../open-sse/services/autoCombo/scoring.ts";
import { getTaskFitness } from "../../open-sse/services/autoCombo/taskFitness.ts";
import { getStrategy } from "../../open-sse/services/autoCombo/routerStrategy.ts";
import {
  clearModelsDevCapabilities,
  saveModelsDevCapabilities,
} from "../../src/lib/modelsDevSync.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

// Round 2 (2026-11-20): conversation-stable tie-break, provider-qualified legacy fitness lookup,
// neutral task-aware tie-break, soft reasoning penalty, honest evidence labels. Real scorer, real
// ranker, real capability resolver, isolated DB.

test.after(() => {
  clearModelsDevCapabilities();
  resetDbInstance();
});

type Caps = {
  think: boolean | null;
  tools: boolean | null;
  ctx: number | null;
  out: number | null;
};
const row = (c: Caps) => ({
  tool_call: c.tools,
  reasoning: c.think,
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
  limit_context: c.ctx,
  limit_input: null,
  limit_output: c.out,
  interleaved_field: null,
});
const STRONG: Caps = { think: true, tools: true, ctx: 1_000_000, out: 128_000 };

/** Install capabilities for "provider/model_id" keys the way the live sync keys them. */
function install(map: Record<string, Caps>) {
  const data: Record<string, Record<string, ReturnType<typeof row>>> = {};
  for (const [id, caps] of Object.entries(map)) {
    const i = id.indexOf("/");
    (data[id.slice(0, i)] ||= {})[id.slice(i + 1)] = row(caps);
  }
  saveModelsDevCapabilities(data);
}

function cand(id: string): FitFirstCandidate {
  const i = id.indexOf("/");
  return {
    provider: id.slice(0, i),
    model: id.slice(i + 1),
    modelStr: id,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 0,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
  } as FitFirstCandidate;
}

const task = (level: TaskLevel, extra: Record<string, unknown> = {}) =>
  ({
    ...classifyTask({}),
    level,
    weight: TASK_LEVEL_WEIGHT[level],
    promptChars: 0,
    outputTokens: 0,
    ...extra,
  }) as ReturnType<typeof classifyTask>;

function winner(ids: string[], body: Record<string, unknown>): string {
  const d = rankFitFirstFreeCandidates({
    candidates: ids.map(cand),
    body,
    zeroAdditionalCostProviders: [...new Set(ids.map((i) => i.split("/")[0]))],
    taskProfile: {
      source: "interpreter",
      fallbackReason: null,
      profile: {
        taskType: "general",
        complexity: "critical",
        requiredCapabilities: [],
        confidence: 1,
      },
    },
  });
  return `${d.ranked[0].candidate.provider}/${d.ranked[0].candidate.model}`;
}

const EQUAL = ["syna/zorbex-9", "synb/quillon-3", "sync/vandra-7", "synd/hexel-5"];

// ── 1. conversation-stable tie-break ────────────────────────────────────────

function conversation(first: string, system: string, turns: number) {
  const messages: unknown[] = [
    { role: "system", content: system },
    { role: "user", content: first },
  ];
  const bodies: Record<string, unknown>[] = [];
  for (let t = 0; t < turns; t++) {
    bodies.push({ messages: structuredClone(messages) });
    messages.push(
      { role: "assistant", content: `step ${t} done` },
      { role: "user", content: `next step ${t + 1}: please continue differently ${t * 7}` }
    );
  }
  return bodies;
}

test("R1: one conversation keeps its winner across turns while candidates and evidence are unchanged", () => {
  install(Object.fromEntries(EQUAL.map((i) => [i, STRONG])));
  for (let c = 0; c < 25; c++) {
    const winners = conversation(`Start task ${c}.`, `You are agent ${c}.`, 20).map((b) =>
      winner(EQUAL, b)
    );
    assert.equal(new Set(winners).size, 1, `conversation ${c} switched: ${winners.join(" ")}`);
  }
});

test("R1: different conversations still spread across equal candidates (about 1/N each)", () => {
  install(Object.fromEntries(EQUAL.map((i) => [i, STRONG])));
  const wins = new Map(EQUAL.map((i) => [i, 0]));
  const N = 400;
  for (let c = 0; c < N; c++) {
    const w = winner(EQUAL, conversation(`Unique task number ${c}.`, "You are an agent.", 1)[0]);
    wins.set(w, (wins.get(w) ?? 0) + 1);
  }
  for (const [id, n] of wins) {
    assert.ok(n > N * 0.15 && n < N * 0.37, `${id} won ${n}/${N}: ${[...wins].join(" ")}`);
  }
});

test("R1: the pick does not depend on list order, and survives removing a loser", () => {
  install(Object.fromEntries(EQUAL.map((i) => [i, STRONG])));
  for (let c = 0; c < 30; c++) {
    const body = conversation(`Task ${c}`, "sys", 1)[0];
    const w = winner(EQUAL, body);
    assert.equal(winner([...EQUAL].reverse(), body), w);
    assert.equal(winner([EQUAL[2], EQUAL[0], EQUAL[3], EQUAL[1]], body), w);
    const smaller = EQUAL.filter((i) => i === w || i !== EQUAL[c % 4]);
    assert.equal(winner(smaller, body), w, "removing a non-winning candidate moved the pick");
  }
});

test("R1: an explicit session id or prompt_cache_key keys the pick, whatever the messages say", () => {
  install(Object.fromEntries(EQUAL.map((i) => [i, STRONG])));
  for (const key of ["session_id", "thread_id", "conversation_id", "prompt_cache_key"]) {
    const picks = new Set<string>();
    for (let t = 0; t < 12; t++) {
      picks.add(
        winner(EQUAL, {
          [key]: "sess-42",
          messages: [{ role: "user", content: `totally different ask ${t} ${"z".repeat(t)}` }],
        })
      );
    }
    assert.equal(picks.size, 1, `${key} did not stabilise the pick`);
  }
  const bySession = new Set<string>();
  for (let s = 0; s < 40; s++) {
    bySession.add(
      winner(EQUAL, { session_id: `s-${s}`, messages: [{ role: "user", content: "x" }] })
    );
  }
  assert.ok(bySession.size >= 3, "different sessions should spread across equal candidates");
});

test("R1: a request with no conversation material still gets a deterministic, order-free pick", () => {
  install(Object.fromEntries(EQUAL.map((i) => [i, STRONG])));
  assert.equal(winner(EQUAL, {}), winner([...EQUAL].reverse(), {}));
  assert.equal(
    winner(EQUAL, { prompt: "hello there" }),
    winner([...EQUAL].reverse(), { prompt: "hello there" })
  );
});

// ── 2. provider-qualified legacy fitness lookup (scoring.ts) ────────────────

const LEGACY_IDS = [
  "claude/zz-claude-opus-4-8",
  "codex/zz-gpt-5.6-luna",
  "nvidia/nvidia/zz-nemotron-3-ultra-550b-a55b",
  "nvidia/moonshotai/zz-kimi-k3.1-pro",
  "github/zz-gpt-4o",
  "syna/zz-plain",
];

function legacyCandidate(id: string): ProviderCandidate {
  const i = id.indexOf("/");
  return {
    provider: id.slice(0, i),
    model: id.slice(i + 1),
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
  };
}

test("R2: legacy scorePool path finds provider-keyed capabilities: identical caps => identical taskFit", () => {
  install(Object.fromEntries(LEGACY_IDS.map((i) => [i, STRONG])));
  for (const taskType of ["coding", "planning", "analysis", "review", "default"]) {
    const scored = scorePool(
      LEGACY_IDS.map(legacyCandidate),
      taskType,
      DEFAULT_WEIGHTS,
      getTaskFitness
    );
    const fits = scored.map((s) => s.factors.taskFit);
    assert.ok(Math.max(...fits) - Math.min(...fits) < 1e-12, `${taskType}: ${fits.join(",")}`);
    assert.ok(
      fits[0] > 0.6,
      `capabilities were not found (taskFit ${fits[0]} is the no-evidence prior)`
    );
    const scores = scored.map((s) => s.score);
    assert.ok(Math.max(...scores) - Math.min(...scores) < 1e-12);
  }
});

test("R2: the same holds through the rules router strategy and a stronger model still wins", () => {
  install({
    ...Object.fromEntries(LEGACY_IDS.slice(0, 4).map((i) => [i, STRONG])),
    "syna/zz-weak": { think: false, tools: true, ctx: 32_000, out: 8_192 },
  });
  const pool = [...LEGACY_IDS.slice(0, 4), "syna/zz-weak"].map(legacyCandidate);
  const decision = getStrategy("rules").select(pool, { taskType: "coding" } as never);
  assert.notEqual(`${decision.provider}/${decision.model}`, "syna/zz-weak");
});

// ── 3. task-aware reorder: neutral ties ─────────────────────────────────────

const targetFor = (id: string, i = 0) => {
  const k = id.indexOf("/");
  return {
    kind: "model" as const,
    stepId: `step-${i}`,
    executionKey: `exec-${i}`,
    modelStr: id,
    provider: id.slice(0, k),
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  };
};

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [item, ...p])
  );
}

test("R3: reorderByTaskWeight ties do not depend on list order", () => {
  install(Object.fromEntries(EQUAL.map((i) => [i, STRONG])));
  const t = task("critical");
  for (const key of [null, "conv-a", "conv-b"]) {
    const orders = new Set<string>();
    for (const perm of permutations(EQUAL)) {
      const out = reorderByTaskWeight(perm.map(targetFor), t, new Set(), { tieKey: key });
      orders.add(out.map((x) => x.modelStr).join(">"));
    }
    assert.equal(orders.size, 1, `key=${key}: ${[...orders].join(" | ")}`);
  }
});

test("R3: ties are conversation-stable and spread across conversations", () => {
  install(Object.fromEntries(EQUAL.map((i) => [i, STRONG])));
  const t = task("critical");
  const firsts = new Map(EQUAL.map((i) => [i, 0]));
  const N = 400;
  for (let c = 0; c < N; c++) {
    const key = getConversationTieKey({ messages: [{ role: "user", content: `ask ${c}` }] });
    const a = reorderByTaskWeight(EQUAL.map(targetFor), t, new Set(), { tieKey: key })[0].modelStr;
    const b = reorderByTaskWeight(EQUAL.map(targetFor), t, new Set(), { tieKey: key })[0].modelStr;
    assert.equal(a, b);
    firsts.set(a, (firsts.get(a) ?? 0) + 1);
  }
  for (const [id, n] of firsts) assert.ok(n > N * 0.15 && n < N * 0.37, `${id} first ${n}/${N}`);
});

test("R3: contracts: never removes targets, identity when already ordered, equal-identity targets keep list order, better fit still leads", () => {
  install({
    ...Object.fromEntries(EQUAL.map((i) => [i, STRONG])),
    "synz/zz-small": { think: false, tools: true, ctx: 32_000, out: 8_192 },
  });
  // 2026-11-20: the unverified-reasoning soft penalty is gone and fit is demand-relative, so the
  // small model sorts behind only where the request exceeds what it can hold: a 40K-token prompt
  // does not fit its 32K window.
  const t = task("critical", { promptChars: 4 * 40_000 });
  const targets = [...EQUAL, "synz/zz-small"].map(targetFor);
  const out = reorderByTaskWeight(targets, t, new Set(), { tieKey: "k" });
  assert.equal(out.length, targets.length);
  assert.deepEqual(new Set(out), new Set(targets));
  assert.equal(out.at(-1)?.modelStr, "synz/zz-small");
  assert.strictEqual(reorderByTaskWeight(out, t, new Set(), { tieKey: "k" }), out);
  const dup = [targetFor(EQUAL[0], 0), targetFor(EQUAL[0], 1)];
  const dupOut = reorderByTaskWeight(dup, t, new Set(), { tieKey: "k" });
  assert.equal(dupOut[0].stepId, "step-0");
  assert.strictEqual(dupOut, dup);
  // preserveInputOrder (used for `auto`, whose input is already evidence-ranked) keeps equal-fit order.
  const preserved = reorderByTaskWeight(EQUAL.map(targetFor), t, new Set(), {
    tieKey: "k",
    preserveInputOrder: true,
  });
  assert.deepEqual(
    preserved.map((x) => x.modelStr),
    EQUAL
  );
  const single = [dup[0]];
  assert.strictEqual(reorderByTaskWeight(single, t), single);
});

// ── 4. soft reasoning penalty ───────────────────────────────────────────────

const HUGE_NO_REASON: Caps = { think: false, tools: true, ctx: 1_000_000, out: 128_000 };
const SMALL_REASON: Caps = { think: true, tools: true, ctx: 64_000, out: 16_000 };
const TINY_REASON: Caps = { think: true, tools: true, ctx: 8_000, out: 4_000 };

function level(id: string, caps: Caps, lvl: TaskLevel, required = new Set<string>()) {
  install({ [id]: caps });
  return scoreModelForTask(id, task(lvl), required);
}

test("R4: reasoning the request does not demand neither rewards nor penalises (heavy/critical)", () => {
  // 2026-11-20: until now an unverified-reasoning model took a flat 10 (heavy) / 15 (critical)
  // point soft penalty even when the request never asked for reasoning, which rewarded an
  // undemanded capability. Verified, unverified and unknown reasoning now tie when the model's
  // capacity covers the demand; a request that DEMANDS reasoning (explicit control or required)
  // still prefers the model that verifies it.
  for (const lvl of ["heavy", "critical"] as TaskLevel[]) {
    install({ "syna/zz-huge": HUGE_NO_REASON, "synb/zz-small": SMALL_REASON });
    assert.equal(
      scoreModelForTask("syna/zz-huge", task(lvl)),
      scoreModelForTask("synb/zz-small", task(lvl)),
      `${lvl}: covering models tie`
    );
    const profile = {
      source: "interpreter" as const,
      fallbackReason: null,
      profile: {
        taskType: "general" as const,
        complexity: lvl,
        requiredCapabilities: [],
        confidence: 1,
      },
    };
    const rank = (body: Record<string, unknown>) =>
      rankFitFirstFreeCandidates({
        candidates: [cand("syna/zz-huge"), cand("synb/zz-small")],
        body,
        zeroAdditionalCostProviders: ["syna", "synb"],
        taskProfile: profile,
      });
    const plain = rank({ messages: [{ role: "user", content: "Handle the request." }] });
    assert.equal(plain.ranked[0].factors.score, plain.ranked[1].factors.score, `${lvl}: no reward`);
    const asked = rank({
      messages: [{ role: "user", content: "Handle the request." }],
      thinking: { type: "enabled", budget_tokens: 8000 },
    });
    assert.equal(asked.ranked[0].candidate.model, "zz-small", `${lvl}: demanded reasoning wins`);
  }
});

test("R4: the penalty is bounded: a much smaller reasoning model still loses where capacity decides", () => {
  install({ "syna/zz-huge": HUGE_NO_REASON, "synb/zz-tiny": TINY_REASON });
  assert.ok(
    scoreModelForTask("syna/zz-huge", task("critical")) >
      scoreModelForTask("synb/zz-tiny", task("critical"))
  );
  // A prompt that does not fit is still decided by the overflow penalty, not the soft term.
  const big = task("critical", { promptChars: 4 * 300_000 });
  install({ "syna/zz-huge": HUGE_NO_REASON, "synb/zz-small": SMALL_REASON });
  assert.ok(scoreModelForTask("syna/zz-huge", big) > scoreModelForTask("synb/zz-small", big));
});

test("R4: no soft penalty at any level; required reasoning takes the -120 gate with the demanded credit", () => {
  const HUGE_REASON: Caps = { ...HUGE_NO_REASON, think: true };
  for (const lvl of ["light", "standard", "heavy", "critical"] as TaskLevel[]) {
    // 2026-11-20: was 0 / 0 / 10 / 15 fit points for an unverified model; now nothing.
    assert.equal(level("syna/zz-a", HUGE_NO_REASON, lvl), level("syna/zz-a", HUGE_REASON, lvl));
    assert.equal(level("syna/zz-a", HUGE_NO_REASON, lvl), 100);
  }
  for (const lvl of ["heavy", "critical"] as TaskLevel[]) {
    const unknown = level("syna/zz-c", { ...SMALL_REASON, think: null }, lvl);
    const no = level("syna/zz-c", { ...SMALL_REASON, think: false }, lvl);
    const yes = level("syna/zz-c", { ...SMALL_REASON, think: true }, lvl);
    assert.ok(yes === no && no === unknown, `${lvl}: ${yes} ${no} ${unknown}`);
    // Required reasoning: the -120 gate, plus the demanded reasoning dimension in the strength
    // (weights ctx 0.30 + out 0.25 covered, reasoning 0.35 missing = 0.55 / 0.90).
    assert.ok(
      Math.abs(
        level("syna/zz-c", { ...SMALL_REASON, think: false }, lvl, new Set(["reasoning"])) -
          (100 * (0.55 / 0.9) - 120)
      ) < 1e-9
    );
    assert.equal(
      level("syna/zz-c", { ...SMALL_REASON, think: true }, lvl, new Set(["reasoning"])),
      yes
    );
  }
  install({ "claude/zz-opus-pro": HUGE_NO_REASON, "synq/zz-tiny-nano": HUGE_NO_REASON });
  assert.equal(modelPowerScore("claude/zz-opus-pro"), modelPowerScore("synq/zz-tiny-nano"));
  assert.equal(
    scoreModelForTask("claude/zz-opus-pro", task("critical")),
    scoreModelForTask("synq/zz-tiny-nano", task("critical"))
  );
});

// ── 5. labels ────────────────────────────────────────────────────────────────

test("R5: the light-profile evidence label says what the fitness really came from", () => {
  const prev = process.env.ROUTING_LIGHT_BY_ASK;
  process.env.ROUTING_LIGHT_BY_ASK = "1";
  try {
    install({ "syna/zz-known": STRONG });
    const d = rankFitFirstFreeCandidates({
      candidates: [
        {
          ...cand("syna/zz-known"),
          latencySampleSource: "unqualified",
          successfulLatencySampleCount: 0,
        },
        cand("synb/zz-never-synced"),
      ],
      body: { messages: [{ role: "user", content: "Reply only: OK" }], max_tokens: 64 },
      zeroAdditionalCostProviders: ["syna", "synb"],
    });
    const byModel = Object.fromEntries(d.ranked.map((r) => [r.candidate.model, r.factors]));
    if (d.taskLevel === "light") {
      assert.equal(byModel["zz-known"].qualityEvidence, "capability_derived");
      assert.equal(byModel["zz-never-synced"].qualityEvidence, "no_evidence");
    }
    assert.equal(byModel["zz-known"].taskFitnessSource, "capability_derived");
    assert.equal(byModel["zz-never-synced"].taskFitnessSource, "no_capability_evidence");
  } finally {
    if (prev === undefined) delete process.env.ROUTING_LIGHT_BY_ASK;
    else process.env.ROUTING_LIGHT_BY_ASK = prev;
  }
});
