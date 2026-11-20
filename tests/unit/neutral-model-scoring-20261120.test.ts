import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyTask,
  modelPowerScore,
  scoreModelForTask,
  TASK_LEVEL_WEIGHT,
  type TaskLevel,
} from "../../open-sse/services/taskAwareRouting.ts";
import {
  rankFitFirstFreeCandidates,
  type FitFirstCandidate,
} from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import * as taskFitness from "../../open-sse/services/autoCombo/taskFitness.ts";
import {
  capabilityStrength,
  hasCapabilityEvidence,
} from "../../open-sse/services/capabilityStrength.ts";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import {
  clearModelsDevCapabilities,
  saveModelsDevCapabilities,
} from "../../src/lib/modelsDevSync.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

// Owner's rule (2026-11-20): every consumer shares ONE selection logic and the best fit for the
// task wins; no vendor wins by design. These tests call the real scorer, the real ranker and the
// real capability resolver against an isolated DB. Capabilities are injected through the synced
// capability table under synthetic model ids, so the only thing that can differ between two
// candidates is what the test changes on purpose.

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

const BIG: Caps = { think: true, tools: true, ctx: 1_000_000, out: 128_000 };
const MID: Caps = { think: true, tools: true, ctx: 256_000, out: 64_000 };
const SMALL: Caps = { think: false, tools: true, ctx: 32_000, out: 8_192 };

// Provider names are real vendor ids on purpose; model ids are synthetic but loaded with the
// brand and size words the old heuristics keyed on.
const SAME_CAPS_IDS: Array<[string, string]> = [
  ["claude", "zz-opus-max-pro-reasoner"],
  ["codex", "zz-haiku-mini-nano-lite"],
  ["nvidia", "zz-plain-model"],
  ["github", "zz-gpt-5-ultra-coder"],
  ["prov-x", "zz-8b-turbo-flash-fast"],
];

function seed(map: Record<string, Record<string, Caps>>) {
  const out: Record<string, Record<string, ReturnType<typeof entry>>> = {};
  for (const [prov, models] of Object.entries(map)) {
    out[prov] = {};
    for (const [model, caps] of Object.entries(models)) out[prov][model] = entry(caps);
  }
  saveModelsDevCapabilities(out);
}

test.after(() => {
  clearModelsDevCapabilities();
  resetDbInstance();
});

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

function candidate(provider: string, model: string, extra: Record<string, unknown> = {}) {
  return {
    provider,
    model,
    modelStr: `${provider}/${model}`,
    connectionId: `conn-${provider}`,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED" as const,
    costPer1MTokens: 0,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
    ...extra,
  } as FitFirstCandidate;
}

const toolsBody = (ask: string, extra: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: ask }],
  tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
  ...extra,
});

// ── P1: provider / name blindness ────────────────────────────────────────────

test("P1: identical resolved capabilities give identical power, fit and fitness whatever the ids", () => {
  seed(Object.fromEntries(SAME_CAPS_IDS.map(([p, m]) => [p, { [m]: MID }])));
  for (const [p, m] of SAME_CAPS_IDS) {
    const c = getResolvedModelCapabilities(`${p}/${m}`);
    assert.equal(c.contextWindow, MID.ctx, `${p}/${m} caps not injected`);
  }
  const ref = SAME_CAPS_IDS[0];
  const refStr = `${ref[0]}/${ref[1]}`;
  for (const [p, m] of SAME_CAPS_IDS.slice(1)) {
    const s = `${p}/${m}`;
    assert.equal(modelPowerScore(s), modelPowerScore(refStr), `power ${s} vs ${refStr}`);
    for (const level of LEVELS) {
      for (const required of [new Set<string>(), new Set(["reasoning", "search"])]) {
        assert.equal(
          scoreModelForTask(s, task(level), required),
          scoreModelForTask(refStr, task(level), required),
          `scoreModelForTask ${level} ${s} vs ${refStr}`
        );
      }
    }
    for (const type of ["coding", "planning", "review", "math", "general"]) {
      assert.deepEqual(
        taskFitness.getTaskFitnessWithSource(s, type),
        taskFitness.getTaskFitnessWithSource(refStr, type),
        `fitness ${type} ${s} vs ${refStr}`
      );
    }
  }
});

test("P1: ranking factors are identical for equal-capability, equal-evidence candidates", () => {
  seed(Object.fromEntries(SAME_CAPS_IDS.map(([p, m]) => [p, { [m]: BIG }])));
  const providers = SAME_CAPS_IDS.map(([p]) => p);
  for (const ask of ["Plan the rollout.", "Implement a parser and tests.", "Review this diff."]) {
    const decision = rankFitFirstFreeCandidates({
      candidates: SAME_CAPS_IDS.map(([p, m]) => candidate(p, m)),
      body: toolsBody(ask, { reasoning_effort: "high" }),
      zeroAdditionalCostProviders: providers,
    });
    assert.equal(decision.ranked.length, SAME_CAPS_IDS.length);
    const first = decision.ranked[0].factors;
    for (const r of decision.ranked) {
      assert.equal(r.factors.score, first.score, `${r.candidate.modelStr} score`);
      assert.equal(r.factors.taskFitness, first.taskFitness);
      assert.equal(r.factors.complexityFit, first.complexityFit);
      assert.equal(r.factors.taskFitnessSource, first.taskFitnessSource);
    }
  }
});

test("P1: equal candidates alternate across requests; list order and vendor never decide", () => {
  seed(Object.fromEntries(SAME_CAPS_IDS.slice(0, 3).map(([p, m]) => [p, { [m]: BIG }])));
  const trio = SAME_CAPS_IDS.slice(0, 3);
  const providers = trio.map(([p]) => p);
  const wins: Record<string, number> = {};
  const N = 300;
  for (let i = 0; i < N; i++) {
    const body = toolsBody(`Implement feature number ${i} with tests.`);
    const fwd = rankFitFirstFreeCandidates({
      candidates: trio.map(([p, m]) => candidate(p, m)),
      body,
      zeroAdditionalCostProviders: providers,
    });
    const rev = rankFitFirstFreeCandidates({
      candidates: [...trio].reverse().map(([p, m]) => candidate(p, m)),
      body,
      zeroAdditionalCostProviders: providers,
    });
    assert.equal(
      fwd.ranked[0].candidate.modelStr,
      rev.ranked[0].candidate.modelStr,
      "winner must not depend on candidate list order"
    );
    const w = fwd.ranked[0].candidate.provider;
    wins[w] = (wins[w] ?? 0) + 1;
  }
  for (const p of providers) {
    const share = (wins[p] ?? 0) / N;
    assert.ok(share > 0.22 && share < 0.45, `${p} won ${(share * 100).toFixed(0)}% of ties`);
  }
});

test("P1: name inference survives nowhere; a name alone earns nothing", () => {
  // No capability data for any of these ids.
  const names = ["zz-opus-max-pro", "zz-haiku-mini-nano", "zz-coder-thinking-fast", "zz-plain"];
  for (const level of LEVELS) {
    const scores = names.map((n) => scoreModelForTask(`nodata/${n}`, task(level)));
    assert.equal(new Set(scores).size, 1, `${level}: ${scores.join(",")}`);
  }
  for (const type of ["coding", "planning", "analysis"]) {
    const fit = names.map((n) => taskFitness.getTaskFitnessWithSource(`nodata/${n}`, type));
    assert.equal(new Set(fit.map((f) => JSON.stringify(f))).size, 1, JSON.stringify(fit));
    assert.equal(fit[0].score, 0.5);
    assert.equal(fit[0].source, "no_capability_evidence");
  }
});

test("P1: a model with verified capabilities is never ranked below an otherwise-equal model with none", () => {
  seed({
    "prov-v": {
      "v-small": { think: false, tools: false, ctx: 8_000, out: 2_000 },
      "v-tools": { think: null, tools: true, ctx: null, out: null },
      "v-mid": MID,
    },
  });
  for (const m of ["v-small", "v-tools", "v-mid"]) {
    assert.ok(hasCapabilityEvidence(getResolvedModelCapabilities(`prov-v/${m}`)), m);
    for (const level of LEVELS) {
      assert.ok(
        scoreModelForTask(`prov-v/${m}`, task(level)) >=
          scoreModelForTask("prov-none/never-synced", task(level)),
        `${m} ${level}`
      );
    }
    for (const type of ["coding", "review", "planning", "analysis", "general"]) {
      assert.ok(
        taskFitness.getTaskFitness(`prov-v/${m}`, type) >=
          taskFitness.getTaskFitness("prov-none/never-synced", type),
        `${m} fitness ${type}`
      );
    }
  }
  const d = rankFitFirstFreeCandidates({
    candidates: [
      candidate("prov-none", "never-synced"),
      candidate("prov-v", "v-small"),
      candidate("prov-v", "v-mid"),
    ],
    body: { messages: [{ role: "user", content: "Summarize the notes." }] },
    zeroAdditionalCostProviders: ["prov-none", "prov-v"],
  });
  assert.equal(d.ranked[d.ranked.length - 1].candidate.model, "never-synced");
});

// ── P2: no cliffs, monotone ─────────────────────────────────────────────────

test("P2: a verified 256K reasoning model is not cliffed out of critical by its name or size", () => {
  seed({
    nvidia: { "zz-nano-mini-lite-30b-reasoning": MID },
    claude: { "zz-opus-pro-max": BIG },
  });
  const crit = task("critical", { promptChars: 40_000, outputTokens: 8_000 });
  const required = new Set(["reasoning", "search"]);
  const nano = scoreModelForTask("nvidia/zz-nano-mini-lite-30b-reasoning", crit, required);
  const opus = scoreModelForTask("claude/zz-opus-pro-max", crit, required);
  assert.ok(nano >= 90, `capable mid model scored ${nano} on critical`);
  assert.ok(opus >= nano);
  assert.ok(opus - nano <= 10, `gap ${opus - nano}`);
});

test("P2: only a genuine unmet requirement subtracts", () => {
  seed({
    p: {
      small: SMALL,
      big: BIG,
      unknownthink: { think: null, tools: true, ctx: 1e6, out: 128_000 },
    },
  });
  const base = task("light");
  // context cannot hold the prompt
  assert.ok(
    scoreModelForTask("p/small", { ...base, promptChars: 4 * 32_000 } as never) <=
      scoreModelForTask("p/small", base) - 200
  );
  assert.equal(
    scoreModelForTask("p/big", { ...base, promptChars: 4 * 32_000 } as never),
    scoreModelForTask("p/big", base)
  );
  // output limit below the requested output
  assert.ok(
    scoreModelForTask("p/small", { ...base, outputTokens: 20_000 } as never) <=
      scoreModelForTask("p/small", base) - 80
  );
  // required reasoning not verified
  assert.ok(
    scoreModelForTask("p/unknownthink", task("heavy"), new Set(["reasoning"])) <=
      scoreModelForTask("p/unknownthink", task("heavy")) - 120
  );
  assert.equal(
    scoreModelForTask("p/big", task("heavy"), new Set(["reasoning"])),
    scoreModelForTask("p/big", task("heavy"))
  );
  // heavy/critical without a stated requirement: no reasoning cliff for a non-reasoning model
  const noThink = scoreModelForTask("p/small", task("critical"));
  assert.ok(noThink > 0, `no unmet requirement, yet ${noThink}`);
  // an oversized power is not penalised on a light task
  seed({
    p: {
      small: SMALL,
      big: BIG,
      mid: MID,
      unknownthink: { think: null, tools: true, ctx: 1e6, out: 128_000 },
    },
  });
  assert.equal(
    scoreModelForTask("p/big", task("light")),
    scoreModelForTask("p/mid", task("light"))
  );
});

test("P2: scores are monotone in every verified capability", () => {
  const steps = {
    ctx: [null, 8_000, 32_000, 128_000, 256_000, 1_000_000, 2_000_000],
    out: [null, 2_000, 8_192, 32_000, 64_000, 128_000, 300_000],
  };
  let last: Record<string, number> = {};
  const check = (label: string, key: string, value: number) => {
    if (last[key] !== undefined) assert.ok(value >= last[key] - 1e-12, `${label} dropped`);
    last[key] = value;
  };
  for (const field of ["ctx", "out"] as const) {
    last = {};
    for (const v of steps[field]) {
      const caps: Caps = { think: true, tools: true, ctx: 200_000, out: 32_000, [field]: v };
      const strength = capabilityStrength({
        supportsThinking: caps.think,
        supportsTools: caps.tools,
        contextWindow: caps.ctx,
        maxOutputTokens: caps.out,
      });
      check(`${field}=${v}`, "strength", strength);
      seed({ mono: { m: caps } });
      for (const level of LEVELS) {
        check(`${field}=${v} ${level}`, `fit-${level}`, scoreModelForTask("mono/m", task(level)));
      }
      check(`${field}=${v} fitness`, "fitness", taskFitness.getTaskFitness("mono/m", "coding"));
      check(`${field}=${v} power`, "power", modelPowerScore("mono/m"));
    }
  }
  // boolean capabilities
  const f = (think: boolean | null, tools: boolean | null) =>
    capabilityStrength({ supportsThinking: think, supportsTools: tools, contextWindow: 100_000 });
  assert.ok(f(true, true) >= f(true, null) && f(true, null) >= f(null, null));
  assert.ok(f(true, true) >= f(false, true) && f(false, true) >= f(null, true));
});

test("P2: the old hard cliffs are gone: no score jump between neighbouring capabilities", () => {
  let prev: number | null = null;
  let maxJump = 0;
  for (let ctx = 16_000; ctx <= 1_100_000; ctx = Math.ceil(ctx * 1.01)) {
    const s = capabilityStrength({
      supportsThinking: true,
      supportsTools: true,
      contextWindow: ctx,
    });
    if (prev !== null) maxJump = Math.max(maxJump, s - prev);
    prev = s;
  }
  assert.ok(maxJump < 0.005, `largest step ${maxJump}`);
});

// ── P3: the static vendor table does not decide ranking ─────────────────────

test("P3: no static vendor table: legacy labels and exports are gone, vendor ids earn no fitness", () => {
  assert.equal("getStaticFitnessTableScore" in taskFitness, false);
  for (const id of [
    "claude-opus-4-8",
    "claude-sonnet",
    "claude-haiku",
    "gpt-4o",
    "qwen",
    "mistral",
    "minimax-m2",
    "deepseek-r1",
    "codex",
  ]) {
    for (const type of ["coding", "review", "planning", "analysis"]) {
      const r = taskFitness.getTaskFitnessWithSource(`nodata/zz-${id}`, type);
      assert.notEqual(r.source, "fitness_table");
      assert.notEqual(r.source, "wildcard_boost");
      assert.deepEqual(r, { score: 0.5, source: "no_capability_evidence" }, id);
    }
  }
});

test("P3: fitness comes from verified capability and is the same for every vendor", () => {
  seed({
    claude: { "zz-a": BIG },
    qwen: { "zz-b": BIG },
    mistral: { "zz-c": SMALL },
  });
  const a = taskFitness.getTaskFitnessWithSource("claude/zz-a", "coding");
  const b = taskFitness.getTaskFitnessWithSource("qwen/zz-b", "coding");
  const c = taskFitness.getTaskFitnessWithSource("mistral/zz-c", "coding");
  assert.equal(a.source, "capability_derived");
  assert.deepEqual(a, b);
  assert.ok(c.score < a.score && c.score > 0.5);
});

test("P3: measured evidence still outranks capability; owner overrides still win", () => {
  seed({ "prov-o": { "zz-o": SMALL, "zz-p": BIG } });
  taskFitness.setUserFitnessOverride("prov-o/zz-o", "coding", 0.99);
  try {
    const r = taskFitness.getTaskFitnessWithSource("prov-o/zz-o", "coding");
    assert.deepEqual(r, { score: 0.99, source: "user_override" });
    const d = rankFitFirstFreeCandidates({
      candidates: [candidate("prov-o", "zz-p"), candidate("prov-o", "zz-o")],
      body: { messages: [{ role: "user", content: "Implement a TypeScript function and tests." }] },
      zeroAdditionalCostProviders: ["prov-o"],
      taskProfile: {
        source: "deterministic",
        fallbackReason: "not_configured",
        profile: {
          taskType: "coding",
          complexity: "light",
          requiredCapabilities: [],
          confidence: 1,
        },
      },
    });
    const overridden = d.ranked.find((r) => r.candidate.model === "zz-o")!;
    assert.equal(overridden.factors.taskFitnessSource, "user_override");
    assert.equal(overridden.factors.taskFitness, 0.99);
    assert.equal(
      d.ranked.find((r) => r.candidate.model === "zz-p")!.factors.taskFitnessSource,
      "capability_derived"
    );
  } finally {
    taskFitness.clearUserFitnessOverride("prov-o/zz-o", "coding");
  }
});

// ── P5 / P6 ─────────────────────────────────────────────────────────────────

test("P5: unverified models are still excluded when the request needs the capability", () => {
  seed({
    "prov-g": {
      ok: BIG,
      "no-tools": { think: true, tools: false, ctx: 1e6, out: 128_000 },
      "no-think": { think: false, tools: true, ctx: 1e6, out: 128_000 },
    },
  });
  const d = rankFitFirstFreeCandidates({
    candidates: [
      candidate("prov-g", "ok"),
      candidate("prov-g", "no-tools"),
      candidate("prov-g", "no-think"),
      candidate("prov-g", "never-synced"),
    ],
    body: toolsBody("Refactor this module.", { reasoning_effort: "high" }),
    zeroAdditionalCostProviders: ["prov-g"],
  });
  assert.deepEqual(
    d.ranked.map((r) => r.candidate.model),
    ["ok"]
  );
  const reasons = Object.fromEntries(d.excluded.map((e) => [e.model, e.reason]));
  assert.equal(reasons["no-tools"], "capability_unverified_tools");
  assert.equal(reasons["no-think"], "capability_unverified_reasoning");
  assert.equal(reasons["never-synced"], "capability_unverified_tools");
});

test("P6: a vendor still wins where it is the only candidate whose verified capability fits", () => {
  seed({
    claude: { "zz-wide": { think: true, tools: true, ctx: 1_000_000, out: 128_000 } },
    nvidia: { "zz-narrow-a": MID, "zz-narrow-b": { ...MID, ctx: 200_000 } },
    codex: { "zz-narrow-c": { ...MID, ctx: 128_000 } },
  });
  const hugePrompt = "x".repeat(4 * 600_000); // ~600K tokens
  const d = rankFitFirstFreeCandidates({
    candidates: [
      candidate("nvidia", "zz-narrow-a"),
      candidate("nvidia", "zz-narrow-b"),
      candidate("codex", "zz-narrow-c"),
      candidate("claude", "zz-wide"),
    ],
    body: toolsBody(hugePrompt, { reasoning_effort: "high" }),
    zeroAdditionalCostProviders: ["claude", "nvidia", "codex"],
  });
  assert.equal(d.ranked[0].candidate.provider, "claude");
  assert.ok(d.ranked[0].factors.score > d.ranked[1].factors.score + 0.1);
  // ...and the same vendor does not win when a rival has equal verified capability.
  const tie = rankFitFirstFreeCandidates({
    candidates: [candidate("claude", "zz-wide"), candidate("nvidia", "zz-narrow-a")],
    body: toolsBody("Implement a parser."),
    zeroAdditionalCostProviders: ["claude", "nvidia"],
  });
  assert.ok(
    Math.abs(tie.ranked[0].factors.score - tie.ranked[1].factors.score) < 0.05,
    "a rival with enough verified capability is within evidence noise of the larger model"
  );
});

test("P6: more verified capability beats less, with the same evidence", () => {
  seed({ "prov-w": { big: BIG, mid: MID, small: SMALL } });
  const d = rankFitFirstFreeCandidates({
    candidates: [
      candidate("prov-w", "small"),
      candidate("prov-w", "mid"),
      candidate("prov-w", "big"),
    ],
    body: { messages: [{ role: "user", content: "Plan the architecture and rollout." }] },
    zeroAdditionalCostProviders: ["prov-w"],
    taskProfile: {
      source: "deterministic",
      fallbackReason: "not_configured",
      profile: {
        taskType: "planning",
        complexity: "critical",
        requiredCapabilities: [],
        confidence: 1,
      },
    },
  });
  assert.deepEqual(
    d.ranked.map((r) => r.candidate.model),
    ["big", "mid", "small"]
  );
});

// ── P4: one shared code path ────────────────────────────────────────────────

test("P4/P1: the scoring code names no vendor, model family or provider", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const vendor =
    /claude|anthropic|codex|openai|gemini|nvidia|gpt|opus|sonnet|haiku|deepseek|qwen|kimi|glm|minimax|mistral|llama|mimo|grok/i;
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const power = (() => {
    const src = read("open-sse/services/taskAwareRouting.ts");
    const a = src.indexOf("// ── Model power scoring");
    const b = src.indexOf("export function reorderByTaskWeight");
    return src.slice(a, b);
  })();
  for (const [label, src] of [
    ["taskAwareRouting power/fit", power],
    ["capabilityStrength.ts", read("open-sse/services/capabilityStrength.ts")],
    ["taskFitness.ts", read("open-sse/services/autoCombo/taskFitness.ts")],
    ["fitFirstPolicy.ts", read("open-sse/services/autoCombo/fitFirstPolicy.ts")],
  ] as const) {
    const code = strip(src);
    const hit = code.match(vendor);
    assert.equal(hit, null, `${label} mentions "${hit?.[0]}"`);
    assert.equal(/\bprovider\s*===?\s*["']/.test(code), false, `${label} branches on a provider`);
  }
});
