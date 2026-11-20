import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as taskAwareRoutingNs from "../../open-sse/services/taskAwareRouting.ts";
import {
  classifyTask,
  getConversationTieKey,
  modelPowerScore,
  scoreModelForTask,
  TASK_LEVEL_WEIGHT,
  type TaskLevel,
} from "../../open-sse/services/taskAwareRouting.ts";
import {
  inferRequiredCapabilities,
  rankFitFirstFreeCandidates,
  type FitFirstCandidate,
} from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import * as taskFitness from "../../open-sse/services/autoCombo/taskFitness.ts";
import * as capabilityStrengthNs from "../../open-sse/services/capabilityStrength.ts";
import type { TaskProfileResolution } from "../../open-sse/services/autoCombo/taskProfile.ts";
import { candidateProvenance } from "../../open-sse/services/autoCombo/candidateProvenance.ts";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import {
  clearModelsDevCapabilities,
  saveModelsDevCapabilities,
} from "../../src/lib/modelsDevSync.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

// Looked up through namespaces so this file can also be run against code that predates them
// (the new symbols are then undefined and the tests that need them fail, instead of the whole
// file failing to load).
const { capabilityDemandForTask } = taskAwareRoutingNs;
const {
  CONTEXT_HEADROOM,
  DEFAULT_OUTPUT_DEMAND_TOKENS,
  demandedCapabilityStrength,
  deriveCapabilityDemand,
  NEUTRAL_DEMAND,
} = capabilityStrengthNs;

// 2026-11-20, owner decision: capability credit saturates at what THIS request needs. Every
// candidate whose verified capabilities cover the demand gets the same task fitness and the same
// complexity fit whatever larger spec it has; only a real shortfall lowers it, continuously.
// Real scorer, real ranker, real capability resolver, isolated DB (tests/_setup/isolateDataDir.ts).
// Capabilities are injected through the synced capability table, so the only thing that can
// differ between two candidates is what a test changes on purpose.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const LEVELS: TaskLevel[] = ["light", "standard", "heavy", "critical"];

type Caps = {
  think: boolean | null;
  tools: boolean | null;
  ctx: number | null;
  out: number | null;
};
const entry = (c: Caps) => ({
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
function seed(map: Record<string, Record<string, Caps>>) {
  const out: Record<string, Record<string, ReturnType<typeof entry>>> = {};
  for (const [prov, models] of Object.entries(map)) {
    out[prov] = {};
    for (const [model, caps] of Object.entries(models)) out[prov][model] = entry(caps);
  }
  saveModelsDevCapabilities(out);
  taskFitness.invalidateFitnessCache();
}
test.after(() => {
  clearModelsDevCapabilities();
  resetDbInstance();
});

const K = 1_000;
const BIG: Caps = { think: true, tools: true, ctx: 1_000_000, out: 128_000 };
const MID: Caps = { think: true, tools: true, ctx: 256_000, out: 65_000 };
const WIDE: Caps = { think: true, tools: true, ctx: 262_000, out: 262_000 };
const GEMMA: Caps = { think: true, tools: true, ctx: 256_000, out: 16_384 };

function task(level: TaskLevel, extra: Record<string, unknown> = {}) {
  return {
    ...classifyTask({}),
    level,
    weight: TASK_LEVEL_WEIGHT[level],
    promptChars: 0,
    outputTokens: 0,
    ...extra,
  } as ReturnType<typeof classifyTask>;
}

const NOW = Date.now();
function cand(id: string, extra: Record<string, unknown> = {}): FitFirstCandidate {
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
    ...extra,
  } as FitFirstCandidate;
}
function observed(n: number, failures = 0) {
  return {
    errorRate: n ? failures / n : 0,
    provenance: candidateProvenance({
      provider: "synprov",
      connectionId: "c",
      historical: n > 0,
      historicalSamples: n,
      runtimeSamples: 0,
      runtimeLatest: null,
      quota: null,
      now: NOW,
    }),
  };
}
function profile(level: TaskLevel): TaskProfileResolution {
  return {
    source: "interpreter",
    fallbackReason: null,
    profile: {
      taskType: "general" as const,
      complexity: level,
      requiredCapabilities: [],
      confidence: 1,
    },
  };
}
function rank(
  candidates: FitFirstCandidate[],
  level: TaskLevel,
  body: Record<string, unknown> = { messages: [{ role: "user", content: "Handle the request." }] },
  key = "conv-1"
) {
  return rankFitFirstFreeCandidates({
    candidates,
    body,
    zeroAdditionalCostProviders: [...new Set(candidates.map((c) => c.provider))],
    conversationKey: getConversationTieKey(body, { sessionId: key }),
    taskProfile: profile(level),
    now: NOW,
  });
}
const idOf = (r: { candidate: FitFirstCandidate }) =>
  `${r.candidate.provider}/${r.candidate.model}`;

// ── the formula ─────────────────────────────────────────────────────────────

test("formula: context credit starts exactly where the 85% overflow rule stops penalising", () => {
  assert.equal(CONTEXT_HEADROOM, 0.85);
  const demand = { promptTokens: 85_000, outputTokens: 1_000, reasoning: false, tools: false };
  const at = (ctx: number) =>
    demandedCapabilityStrength({ contextWindow: ctx, maxOutputTokens: 1_000 }, demand);
  assert.equal(at(100_000), 1); // 85K prompt in a 100K window: exactly on the rule
  assert.ok(at(99_999) < 1);
  assert.equal(at(1_000_000), 1);
  // the overflow penalty and the credit shortfall begin at the same window
  seed({ syna: { "zz-edge": { think: true, tools: true, ctx: 100_000, out: 8_192 } } });
  const edge = (chars: number) =>
    scoreModelForTask("syna/zz-edge", task("light", { promptChars: chars }));
  assert.ok(edge(4 * 85_000) > 90);
  assert.ok(edge(4 * 85_001 + 4) < edge(4 * 85_000) - 150);
});

test("formula: output credit is proportional, half the demanded output is half that dimension", () => {
  const demand = { promptTokens: 0, outputTokens: 32_768, reasoning: false, tools: false };
  const caps = (out: number) => ({ contextWindow: 1_000_000, maxOutputTokens: out });
  const full = demandedCapabilityStrength(caps(32_768), demand);
  const half = demandedCapabilityStrength(caps(16_384), demand);
  assert.equal(full, 1);
  // weights: context 0.30 covered, output 0.25 at half => (0.30 + 0.125) / 0.55
  assert.ok(Math.abs(half - 0.425 / 0.55) < 1e-12, String(half));
  assert.equal(demandedCapabilityStrength(caps(1_000_000), demand), 1);
});

test("formula: undemanded capabilities earn nothing and cost nothing; demanded ones are all-or-nothing", () => {
  const plain = { contextWindow: 200_000, maxOutputTokens: 16_000 };
  const full = { ...plain, supportsThinking: true, supportsTools: true };
  const none = { ...plain, supportsThinking: false, supportsTools: false };
  const base = { promptTokens: 1_000, outputTokens: 4_000 };
  for (const caps of [plain, full, none]) {
    assert.equal(demandedCapabilityStrength(caps, { ...base, reasoning: false, tools: false }), 1);
  }
  const reasoning = { ...base, reasoning: true, tools: false };
  assert.equal(demandedCapabilityStrength(full, reasoning), 1);
  assert.ok(Math.abs(demandedCapabilityStrength(none, reasoning) - 0.55 / 0.9) < 1e-12);
  const toolsOnly = { ...base, reasoning: false, tools: true };
  assert.ok(Math.abs(demandedCapabilityStrength(none, toolsOnly) - 0.55 / 0.65) < 1e-12);
  // unknown fields add nothing: never above verified, never negative
  assert.ok(demandedCapabilityStrength({}, reasoning) === 0);
  assert.ok(demandedCapabilityStrength(null, reasoning) === 0);
  assert.ok(
    demandedCapabilityStrength({ contextWindow: null, maxOutputTokens: 16_000 }, toolsOnly) <
      demandedCapabilityStrength(plain, toolsOnly)
  );
});

test("formula: the neutral demand is one fixed documented demand, the same for every model", () => {
  assert.deepEqual(NEUTRAL_DEMAND, {
    promptTokens: 32_000,
    outputTokens: DEFAULT_OUTPUT_DEMAND_TOKENS,
    reasoning: false,
    tools: false,
  });
  seed({ syna: { "zz-a": BIG }, synb: { "zz-b": MID }, sync: { "zz-c": WIDE } });
  const fits = ["syna/zz-a", "synb/zz-b", "sync/zz-c"].map((m) =>
    taskFitness.getTaskFitness(m, "coding")
  );
  assert.equal(new Set(fits).size, 1, `legacy request-independent fitness differs: ${fits}`);
  assert.equal(fits[0], 0.92); // coding ceiling: the models all cover the neutral demand
});

// ── D1: saturation ──────────────────────────────────────────────────────────

const BODIES: Record<string, Record<string, unknown>> = {
  plain: { messages: [{ role: "user", content: "Handle the request." }] },
  withLimit: { messages: [{ role: "user", content: "Handle the request." }], max_tokens: 32_000 },
  toolsReasoning: {
    messages: [{ role: "user", content: "Handle the request." }],
    max_tokens: 32_000,
    tools: [{ type: "function", function: { name: "t" } }],
    thinking: { type: "enabled", budget_tokens: 8_000 },
    reasoning_effort: "high",
  },
};

for (const level of LEVELS) {
  for (const [label, body] of Object.entries(BODIES)) {
    test(`D1 @${level}/${label}: candidates that all cover the demand tie exactly on fit and final score`, () => {
      seed({ syna: { "zz-big": BIG }, synb: { "zz-mid": MID }, sync: { "zz-wide": WIDE } });
      const d = rank([cand("syna/zz-big"), cand("synb/zz-mid"), cand("sync/zz-wide")], level, body);
      const f = d.ranked.map((r) => r.factors);
      for (const x of f) {
        assert.equal(x.taskFitness, f[0].taskFitness, `${level}/${label} taskFitness`);
        assert.equal(x.complexityFit, f[0].complexityFit, `${level}/${label} complexityFit`);
        assert.equal(x.score, f[0].score, `${level}/${label} score`);
      }
      assert.equal(f[0].taskFitnessSource, "capability_derived");
      // direct scorer calls agree
      const required = new Set<string>(
        inferRequiredCapabilities(body).map((c) => (c === "tools" ? "search" : c))
      );
      const t = { ...classifyTask(body), level, weight: TASK_LEVEL_WEIGHT[level] };
      const direct = ["syna/zz-big", "synb/zz-mid", "sync/zz-wide"].map((m) =>
        scoreModelForTask(m, t, required)
      );
      assert.equal(new Set(direct).size, 1, `scoreModelForTask differs: ${direct}`);
    });
  }
}

test("D1: the lead of the larger spec is gone, so equal evidence is decided by the neutral tie-break", () => {
  seed({ syna: { "zz-big": BIG }, synb: { "zz-mid": MID }, sync: { "zz-wide": WIDE } });
  const wins = new Map<string, number>();
  const N = 150;
  for (let k = 0; k < N; k++) {
    const d = rank(
      [cand("syna/zz-big"), cand("synb/zz-mid"), cand("sync/zz-wide")],
      "critical",
      BODIES.toolsReasoning,
      `k${k}`
    );
    wins.set(idOf(d.ranked[0]), (wins.get(idOf(d.ranked[0])) ?? 0) + 1);
  }
  for (const [id, c] of wins) assert.ok(c > N * 0.2 && c < N * 0.47, `${id} ${c}/${N}`);
  assert.equal(wins.size, 3);
});

// ── D2: shortfall is continuous and monotone ────────────────────────────────

test("D2: a model short of the demanded output gets partial credit, not zero and not a cliff", () => {
  seed({ syna: { "zz-big": BIG }, synb: { "zz-gemma": GEMMA } });
  const body = { messages: [{ role: "user", content: "x" }], max_tokens: 32_000 };
  const d = rank([cand("syna/zz-big"), cand("synb/zz-gemma")], "critical", body);
  const big = d.ranked.find((r) => r.candidate.model === "zz-big")!.factors;
  const gemma = d.ranked.find((r) => r.candidate.model === "zz-gemma")!.factors;
  assert.equal(big.complexityFit, 1);
  // Task fitness carries the proportional credit: gemma covers context fully and 16384/32000 of
  // the output, so its capability strength is (0.30 + 0.25 * 16384/32000) / 0.55 of the top.
  const strength = (0.3 + 0.25 * (16_384 / 32_000)) / 0.55;
  assert.equal(big.taskFitnessSource, "capability_derived");
  // taskType "general" uses the default range, so compare through the public function instead
  const demand = capabilityDemandForTask(classifyTask(body), new Set());
  const direct = taskFitness.getTaskFitness("synb/zz-gemma", "general", demand);
  assert.equal(gemma.taskFitness, direct);
  assert.ok(gemma.taskFitness > 0.55 && gemma.taskFitness < big.taskFitness);
  assert.ok(
    Math.abs((gemma.taskFitness - 0.55) / (big.taskFitness - 0.55) - strength) < 1e-9,
    "task fitness credit is exactly the demand-relative strength"
  );
  // The existing hard penalty (-80: requested output above the model's own cap) is unchanged and
  // is applied on top of the same proportional credit in the complexity term, which therefore
  // clamps to 0 for this request; the final score still keeps gemma's proportional task credit.
  const t = { ...classifyTask(body), level: "critical" as TaskLevel, weight: 4 };
  assert.ok(Math.abs(scoreModelForTask("synb/zz-gemma", t) - (100 * strength - 80)) < 1e-9);
  assert.ok(gemma.score > 0 && gemma.score < big.score);
  assert.equal(d.ranked[0].candidate.model, "zz-big");
});

test("D2: the credit is monotone and continuous as the demanded output grows past a model's cap", () => {
  seed({ syna: { "zz-gemma": GEMMA } });
  let prev: { fit: number; fitness: number } | null = null;
  let maxStepFit = 0;
  let maxStepFitness = 0;
  for (let out = 1_000; out <= 400_000; out = Math.ceil(out * 1.01)) {
    const t = task("critical", { outputTokens: out });
    const demand = capabilityDemandForTask(t, new Set());
    const fit = demandedCapabilityStrength(getResolvedModelCapabilities("syna/zz-gemma"), demand);
    const fitness = taskFitness.getTaskFitness("syna/zz-gemma", "coding", demand);
    if (prev) {
      assert.ok(fit <= prev.fit + 1e-12, `fit rose at output ${out}`);
      assert.ok(fitness <= prev.fitness + 1e-12);
      maxStepFit = Math.max(maxStepFit, prev.fit - fit);
      maxStepFitness = Math.max(maxStepFitness, prev.fitness - fitness);
    }
    prev = { fit, fitness };
  }
  // a 1% change in the demanded output moves strength by <= 0.25/0.55 * 1% (no cliff)
  assert.ok(maxStepFit < 0.0046, `largest strength step ${maxStepFit}`);
  assert.ok(maxStepFitness < 0.0013, `largest fitness step ${maxStepFitness}`);
  assert.ok(prev!.fit > 0, "never reaches zero from output shortfall alone");
});

test("D2: more capability never lowers a score, and beyond the demand it changes nothing", () => {
  const body = { messages: [{ role: "user", content: "x" }], max_tokens: 20_000 };
  let last: { score: number; fitness: number } | null = null;
  for (const out of [2_000, 8_192, 16_384, 20_000, 32_000, 128_000, 1_000_000]) {
    for (const ctx of [8_000, 64_000, 256_000, 1_000_000]) {
      seed({ syna: { "zz-m": { think: true, tools: true, ctx, out } } });
      const t = { ...classifyTask(body), level: "heavy" as TaskLevel, weight: 3 };
      const demand = capabilityDemandForTask(t, new Set());
      const s = scoreModelForTask("syna/zz-m", t);
      const f = taskFitness.getTaskFitness("syna/zz-m", "coding", demand);
      if (out >= 20_000 && ctx >= 64_000) {
        // covers the demand: identical score whatever the larger spec
        if (last) {
          assert.equal(s, last.score, `ctx ${ctx} out ${out}`);
          assert.equal(f, last.fitness);
        }
        last = { score: s, fitness: f };
      }
    }
  }
  // monotone in each capability alone
  for (const field of ["ctx", "out"] as const) {
    let prev = -Infinity;
    for (const v of [1_000, 8_000, 32_000, 128_000, 512_000, 2_000_000]) {
      seed({
        syna: { "zz-m": { think: true, tools: true, ctx: 200_000, out: 16_000, [field]: v } },
      });
      const s = scoreModelForTask("syna/zz-m", {
        ...classifyTask(body),
        level: "heavy" as TaskLevel,
        weight: 3,
      });
      assert.ok(s >= prev - 1e-9, `${field}=${v} dropped`);
      prev = s;
    }
  }
});

// ── D3: hard requirements unchanged ─────────────────────────────────────────

test("D3: overflow, output-limit, vision, required reasoning and tools keep their hard effect", () => {
  seed({
    syna: { "zz-ok": BIG, "zz-small": { think: true, tools: true, ctx: 32_000, out: 8_192 } },
    synb: { "zz-nothink": { think: false, tools: true, ctx: 1_000_000, out: 128_000 } },
    sync: { "zz-notools": { think: true, tools: false, ctx: 1_000_000, out: 128_000 } },
  });
  const base = task("heavy", { promptChars: 40_000, outputTokens: 4_000 });
  const strength = (m: string, t: ReturnType<typeof task>, req = new Set<string>()) =>
    100 *
    demandedCapabilityStrength(getResolvedModelCapabilities(m), capabilityDemandForTask(t, req));
  assert.equal(scoreModelForTask("syna/zz-ok", base), 100);
  // prompt over 85% of the window: -200 on top of the proportional context credit
  const long = { ...base, promptChars: 4 * 32_000 };
  assert.ok(
    Math.abs(scoreModelForTask("syna/zz-small", long) - (strength("syna/zz-small", long) - 200)) <
      1e-9
  );
  // requested output above the model's own cap: -80 on top of the proportional output credit
  const wide = { ...base, outputTokens: 20_000 };
  assert.ok(
    Math.abs(scoreModelForTask("syna/zz-small", wide) - (strength("syna/zz-small", wide) - 80)) <
      1e-9
  );
  // required vision not verified: the -10000 hard miss
  assert.ok(scoreModelForTask("syna/zz-ok", base, new Set(["vision"])) <= 100 - 10_000);
  // required reasoning unverified: the -120 gate, replacing (not stacking with) the soft penalty
  const need = new Set(["reasoning"]);
  assert.ok(
    Math.abs(
      scoreModelForTask("synb/zz-nothink", task("heavy"), need) -
        (strength("synb/zz-nothink", task("heavy"), need) - 120)
    ) < 1e-9
  );
  // search (tools) is an unmet requirement when unverified: bounded -30
  const tools = scoreModelForTask("sync/zz-notools", task("heavy"), new Set(["search"]));
  assert.ok(tools < scoreModelForTask("syna/zz-ok", task("heavy"), new Set(["search"])));
  // the soft reasoning penalty on heavy/critical still applies when reasoning is not demanded
  assert.equal(
    scoreModelForTask("syna/zz-ok", task("critical")) -
      scoreModelForTask("synb/zz-nothink", task("critical")),
    15
  );
  assert.equal(
    scoreModelForTask("syna/zz-ok", task("heavy")) -
      scoreModelForTask("synb/zz-nothink", task("heavy")),
    10
  );
});

test("D3: the exclusion gate is unchanged (unverified required capabilities never reach the ranking)", () => {
  seed({
    syna: { "zz-ok": BIG },
    synb: { "zz-nothink": { think: false, tools: true, ctx: 1_000_000, out: 128_000 } },
    sync: { "zz-notools": { think: true, tools: false, ctx: 1_000_000, out: 128_000 } },
  });
  const d = rank(
    [cand("syna/zz-ok"), cand("synb/zz-nothink"), cand("sync/zz-notools")],
    "critical",
    BODIES.toolsReasoning
  );
  assert.deepEqual(d.excluded.map((e) => [e.model, e.reason]).sort(), [
    ["zz-nothink", "capability_unverified_reasoning"],
    ["zz-notools", "capability_unverified_tools"],
  ]);
  assert.equal(d.ranked.length, 1);
});

// ── D4: name and vendor blind, deterministic ────────────────────────────────

test("D4: identical capabilities score identically under any provider and model name", () => {
  const ids: Array<[string, string]> = [
    ["claude", "zz-opus-max-pro-reasoner"],
    ["codex", "zz-haiku-mini-nano-lite"],
    ["nvidia", "zz-plain-model"],
    ["github", "zz-gpt-5-ultra-coder"],
    ["prov-x", "zz-8b-turbo-flash-fast"],
  ];
  const map: Record<string, Record<string, Caps>> = {};
  for (const [p, m] of ids) (map[p] ||= {})[m] = MID;
  seed(map);
  for (const level of LEVELS) {
    for (const body of Object.values(BODIES)) {
      const t = { ...classifyTask(body), level, weight: TASK_LEVEL_WEIGHT[level] };
      const required = new Set<string>(
        inferRequiredCapabilities(body).map((c) => (c === "tools" ? "search" : c))
      );
      const demand = capabilityDemandForTask(t, required);
      const scores = ids.map(([p, m]) => [
        scoreModelForTask(`${p}/${m}`, t, required),
        taskFitness.getTaskFitness(`${p}/${m}`, "coding", demand),
        modelPowerScore(`${p}/${m}`, demand),
      ]);
      for (const s of scores) assert.deepEqual(s, scores[0]);
    }
  }
});

test("D4: 100 repeated calls and every list permutation give the same factors and winner", () => {
  seed({
    syna: { "zz-big": BIG },
    synb: { "zz-mid": MID },
    sync: { "zz-wide": WIDE },
    synd: { "zz-g": GEMMA },
  });
  const ids = ["syna/zz-big", "synb/zz-mid", "sync/zz-wide", "synd/zz-g"];
  const ref = rank(
    ids.map((i) => cand(i)),
    "critical",
    BODIES.toolsReasoning,
    "perm"
  );
  const refFactors = Object.fromEntries(ref.ranked.map((r) => [idOf(r), r.factors]));
  for (let i = 0; i < 100; i++) {
    const d = rank(
      ids.map((x) => cand(x)),
      "critical",
      BODIES.toolsReasoning,
      "perm"
    );
    assert.deepEqual(d.ranked.map(idOf), ref.ranked.map(idOf));
  }
  const perms = (a: string[]): string[][] =>
    a.length <= 1
      ? [a]
      : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
  for (const p of perms(ids)) {
    const d = rank(
      p.map((x) => cand(x)),
      "critical",
      BODIES.toolsReasoning,
      "perm"
    );
    assert.deepEqual(d.ranked.map(idOf), ref.ranked.map(idOf), `permutation ${p}`);
    for (const r of d.ranked) assert.deepEqual(r.factors, refFactors[idOf(r)]);
  }
});

test("D4: the demand code names no vendor, model family or provider", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const vendor =
    /claude|anthropic|codex|openai|gemini|gemma|nvidia|gpt|opus|sonnet|haiku|deepseek|qwen|kimi|glm|minimax|mistral|llama|mimo|grok/i;
  const src = fs.readFileSync(path.join(ROOT, "open-sse/services/capabilityStrength.ts"), "utf8");
  assert.equal(strip(src).match(vendor), null);
  const tar = fs.readFileSync(path.join(ROOT, "open-sse/services/taskAwareRouting.ts"), "utf8");
  const a = tar.indexOf("export function capabilityDemandForTask");
  assert.equal(strip(tar.slice(a, a + 900)).match(vendor), null);
});

// ── D5: demand derivation ───────────────────────────────────────────────────

const claudeCodeBody = (extra: Record<string, unknown> = {}) => ({
  system: [
    { type: "text", text: "You are an interactive CLI agent. Follow all rules. ".repeat(380) },
  ],
  messages: [{ role: "user", content: [{ type: "text", text: "Fix ticket 4471 in the repo." }] }],
  tools: Array.from({ length: 12 }, (_, i) => ({
    name: `tool_${i}`,
    description: "d",
    input_schema: { type: "object" },
  })),
  max_tokens: 32_000,
  thinking: { type: "enabled", budget_tokens: 16_000 },
  output_config: { effort: "high" },
  ...extra,
});
const demandOf = (body: Record<string, unknown>) => {
  const t = classifyTask(body);
  const required = new Set<string>(
    inferRequiredCapabilities(body).map((c) => (c === "tools" ? "search" : c))
  );
  return { t, demand: capabilityDemandForTask(t, required) };
};

test("D5: a Claude Code style body demands its prompt, 32K output, reasoning and tools", () => {
  const body = claudeCodeBody();
  const { t, demand } = demandOf(body);
  assert.ok(t.promptChars > 19_000);
  assert.equal(demand.promptTokens, Math.ceil(t.promptChars / 4));
  assert.equal(demand.outputTokens, 32_000);
  assert.equal(demand.reasoning, true, "thinking/effort on the wire is an explicit reasoning ask");
  assert.equal(demand.tools, true);
});

test("D5: Codex style bodies: explicit max_output_tokens wins, none falls back to the default", () => {
  const codex = (extra: Record<string, unknown> = {}) => ({
    instructions: "You are a coding agent running in a terminal. ".repeat(400),
    input: [{ role: "user", content: [{ type: "input_text", text: "Run the tests." }] }],
    tools: [{ type: "function", name: "shell" }],
    reasoning: { effort: "medium" },
    ...extra,
  });
  assert.equal(demandOf(codex({ max_output_tokens: 12_000 })).demand.outputTokens, 12_000);
  const none = demandOf(codex()).demand;
  assert.equal(none.outputTokens, DEFAULT_OUTPUT_DEMAND_TOKENS);
  assert.equal(none.reasoning, true, "reasoning.effort medium is a required capability");
  assert.equal(none.tools, true);
  // a smaller explicit limit is honoured too (never inflated to the default)
  assert.equal(demandOf(codex({ max_output_tokens: 500 })).demand.outputTokens, 500);
  // a body with no reasoning control and no tools demands neither
  const plain = demandOf({ messages: [{ role: "user", content: "hello" }] }).demand;
  assert.equal(plain.reasoning, false);
  assert.equal(plain.tools, false);
});

test("D5: garbage, NaN, negative and huge values never produce a non-finite or negative demand", () => {
  for (const bad of [NaN, -1, 0, Infinity, -Infinity, "abc", null, undefined, {}, [], 1e300]) {
    const d = deriveCapabilityDemand({ promptChars: bad, outputTokens: bad });
    assert.ok(Number.isFinite(d.promptTokens) && d.promptTokens >= 0, `prompt ${String(bad)}`);
    assert.ok(Number.isFinite(d.outputTokens) && d.outputTokens > 0, `output ${String(bad)}`);
    if (typeof bad !== "number" || !(bad > 0 && Number.isFinite(bad))) {
      assert.equal(d.outputTokens, DEFAULT_OUTPUT_DEMAND_TOKENS);
      assert.equal(d.promptTokens, 0);
    }
    for (const caps of [{}, { contextWindow: 1_000_000, maxOutputTokens: 128_000 }]) {
      const s = demandedCapabilityStrength(caps, d);
      assert.ok(Number.isFinite(s) && s >= 0 && s <= 1, `strength ${s} for ${String(bad)}`);
    }
  }
  for (const out of [NaN, -5, "32000", 1e15, 2 ** 53, Infinity]) {
    for (const body of [{ messages: [{ role: "user", content: "x" }], max_tokens: out }]) {
      const { demand } = demandOf(body as Record<string, unknown>);
      assert.ok(Number.isFinite(demand.outputTokens) && demand.outputTokens > 0);
    }
  }
  // a huge request still gives finite, ordered credit
  seed({ syna: { "zz-a": BIG, "zz-b": GEMMA } });
  const huge = deriveCapabilityDemand({ promptChars: 1e12, outputTokens: 1e12 });
  const a = demandedCapabilityStrength(getResolvedModelCapabilities("syna/zz-a"), huge);
  const b = demandedCapabilityStrength(getResolvedModelCapabilities("syna/zz-b"), huge);
  assert.ok(a > b && b > 0 && a < 1);
});

// ── D6: replay of the live case ─────────────────────────────────────────────

// Verified specs as synced from the registry, with the live 24 h reliability counts
// (n, successes): claude-opus-4-8 29/29, nemotron-3-ultra 13/13, minimax-m3.1-flash 12/10,
// mistral-large-4 11/8, nemotron-3-nano-omni 11/11. gemma-4-31b-it has no live samples.
const LIVE: Array<[string, Caps, number, number]> = [
  ["claude/claude-opus-4-8", { think: true, tools: true, ctx: 1_000_000, out: 128_000 }, 29, 29],
  ["nvidia/nemotron-3-ultra", { think: true, tools: true, ctx: 1_000_000, out: 65_536 }, 13, 13],
  ["mistral/mistral-large-4", { think: true, tools: true, ctx: 1_000_000, out: 262_144 }, 11, 8],
  ["minimax/minimax-m3.1-flash", { think: true, tools: true, ctx: 262_144, out: 262_144 }, 12, 10],
  ["nvidia/nemotron-3-nano-omni", { think: true, tools: true, ctx: 256_000, out: 65_536 }, 11, 11],
  ["nvidia/gemma-4-31b-it", { think: true, tools: true, ctx: 256_000, out: 16_384 }, 0, 0],
];

test("D6 replay: critical, huge context, tools, reasoning high, max_tokens 32000", () => {
  const map: Record<string, Record<string, Caps>> = {};
  for (const [id, caps] of LIVE) {
    const i = id.indexOf("/");
    (map[id.slice(0, i)] ||= {})[id.slice(i + 1)] = caps;
  }
  seed(map);
  const body = claudeCodeBody({
    system: [{ type: "text", text: "You are an interactive CLI agent. ".repeat(3_400) }],
  });
  const t = classifyTask(body);
  assert.equal(t.level, "critical");
  assert.ok(t.promptChars >= 100_000);
  const candidates = LIVE.map(([id, , n, ok]) => cand(id, observed(n, n - ok)));
  const d = rankFitFirstFreeCandidates({
    candidates,
    body,
    zeroAdditionalCostProviders: ["claude", "nvidia", "mistral", "minimax"],
    conversationKey: getConversationTieKey(body, { sessionId: "live-replay" }),
    now: NOW,
  });
  assert.equal(d.taskLevel, "critical");
  const f = Object.fromEntries(d.ranked.map((r) => [idOf(r), r.factors]));
  const covering = LIVE.filter(([, c]) => (c.out ?? 0) >= 32_000).map(([id]) => id);
  // every model whose verified specs cover the request ties on fit, whatever its larger spec
  for (const id of covering) {
    assert.equal(f[id].taskFitness, f[covering[0]].taskFitness, `${id} taskFitness`);
    assert.equal(f[id].complexityFit, f[covering[0]].complexityFit, `${id} complexityFit`);
    assert.equal(f[id].complexityFit, 1);
  }
  // the one model that falls short of 32K output is lower on both; its task fitness keeps the
  // proportional credit (complexity also takes the existing -80 output-above-cap penalty)
  const gemma = f["nvidia/gemma-4-31b-it"];
  assert.ok(gemma.complexityFit < 1);
  assert.ok(gemma.taskFitness < f[covering[0]].taskFitness);
  // with equal fit, the score gap is decided only by observed reliability, health and quota
  const evidenceOnly = (id: string) =>
    f[id].score - (f[id].taskFitness * 0.5 + f[id].complexityFit * 0.32);
  const lead = d.ranked[0];
  assert.ok(covering.includes(idOf(lead)) || idOf(lead) === "nvidia/gemma-4-31b-it");
  assert.ok(f["claude/claude-opus-4-8"].reliability === 1);
  assert.ok(f["mistral/mistral-large-4"].reliability < f["nvidia/nemotron-3-ultra"].reliability);
  assert.ok(evidenceOnly("nvidia/nemotron-3-ultra") > evidenceOnly("mistral/mistral-large-4"));
  // claude's extra spec no longer decides: ultra (13/13), nano (11/11) and claude (29/29) tie
  // exactly on every evidence factor, so the neutral tie-break chooses among them
  const perfect = [
    "claude/claude-opus-4-8",
    "nvidia/nemotron-3-ultra",
    "nvidia/nemotron-3-nano-omni",
  ];
  for (const id of perfect) assert.equal(f[id].score, f[perfect[0]].score, `${id} score`);
  const top = d.ranked.slice(0, 3).map(idOf).sort();
  assert.deepEqual(top, [...perfect].sort());
});

test("D6 replay: across conversations the tied models share the wins, not the larger spec", () => {
  const body = claudeCodeBody({
    system: [{ type: "text", text: "You are an interactive CLI agent. ".repeat(3_400) }],
  });
  const wins = new Map<string, number>();
  const N = 150;
  for (let k = 0; k < N; k++) {
    const d = rankFitFirstFreeCandidates({
      candidates: LIVE.map(([id, , n, ok]) => cand(id, observed(n, n - ok))),
      body,
      zeroAdditionalCostProviders: ["claude", "nvidia", "mistral", "minimax"],
      conversationKey: getConversationTieKey(body, { sessionId: `live-${k}` }),
      now: NOW,
    });
    wins.set(idOf(d.ranked[0]), (wins.get(idOf(d.ranked[0])) ?? 0) + 1);
  }
  const claude = wins.get("claude/claude-opus-4-8") ?? 0;
  assert.ok(claude > N * 0.1 && claude < N * 0.5, `claude won ${claude}/${N}: ${[...wins]}`);
  assert.ok(wins.size >= 2, `one model won every conversation: ${[...wins]}`);
});
