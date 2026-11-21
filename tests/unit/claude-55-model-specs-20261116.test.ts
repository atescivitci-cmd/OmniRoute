/**
 * Claude 5.5 family (Haiku 5.5 / Sonnet 5.5 / Opus 5.5) static model data, 2026-11-16.
 *
 * Facts come from the official docs (platform.claude.com model overview, pricing, effort,
 * "what's new" pages, observed 2026-11-16). Anything the docs did not state is labelled
 * "unverified" in the source and is NOT asserted here beyond the conservative value.
 *
 * The snapshot fixture was generated from the fork tip (fc04642c03) BEFORE the 5.5 entries
 * were added; the "existing entries unchanged" tests compare against it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "claude-existing-snapshot-20261116.json"), "utf8")
) as {
  specs: Record<string, unknown>;
  pricing: Record<string, Record<string, unknown>>;
  known: Record<string, unknown>;
  registry: Record<string, Array<Record<string, unknown>>>;
  defaults: Record<string, string>;
};

const { MODEL_SPECS, getModelSpec, getCanonicalModelSpecId, isAdaptiveThinkingOnly } =
  await import("../../src/shared/constants/modelSpecs.ts");
const { DEFAULT_PRICING } = await import("../../src/shared/constants/pricing/default-pricing.ts");
const { getPricingForModel } = await import("../../src/shared/constants/pricing.ts");
const { computeCostFromPricing } = await import("../../src/lib/usage/costCalculator.ts");
const { KNOWN_MODEL_PRICING, getModelPricing } =
  await import("../../open-sse/services/providerCostData.ts");
const { REGISTRY, getClaudeCodeDefaultModels } =
  await import("../../open-sse/config/providerRegistry.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { modelPowerScore, scoreModelForTask } =
  await import("../../open-sse/services/taskAwareRouting.ts");

const NEW_IDS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;

// Official per-MTok prices (platform.claude.com pricing, base tier). cached = cache read,
// cache_creation = 5-minute cache write, reasoning = output price (thinking bills as output).
const EXPECTED_PRICING: Record<(typeof NEW_IDS)[number], Record<string, number>> = {
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cached: 0.01,
    reasoning: 0.5,
    cache_creation: 0.125,
  },
  "claude-sonnet-5-5": { input: 2, output: 10, cached: 0.1, reasoning: 10, cache_creation: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cached: 0.2, reasoning: 20, cache_creation: 5 },
};

// Shared usage sample: 50k prompt tokens of which 20k are cache reads and 10k cache writes
// (so 20k fresh input), plus 4k output tokens.
const SAMPLE = { input: 50_000, cacheRead: 20_000, cacheCreation: 10_000, output: 4_000 };
// Hand computed: fresh*input + read*cached + out*output + write*cache_creation, per 1M.
const EXPECTED_COST: Record<(typeof NEW_IDS)[number], number> = {
  "claude-haiku-5-5": (20_000 * 0.1 + 20_000 * 0.01 + 4_000 * 0.5 + 10_000 * 0.125) / 1e6, // 0.00545
  "claude-sonnet-5-5": (20_000 * 2 + 20_000 * 0.1 + 4_000 * 10 + 10_000 * 2.5) / 1e6, // 0.107
  "claude-opus-5-5": (20_000 * 4 + 20_000 * 0.2 + 4_000 * 20 + 10_000 * 5) / 1e6, // 0.214
};

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${expected}, got ${actual}`);
}

// ── Specs ────────────────────────────────────────────────────────────────────

for (const id of NEW_IDS) {
  test(`${id}: spec resolves to its own entry with verified limits`, () => {
    assert.equal(getCanonicalModelSpecId(id), id);
    const spec = getModelSpec(id)!;
    assert.equal(spec.contextWindow, 1_000_000);
    assert.equal(spec.maxOutputTokens, 128_000);
    assert.equal(spec.supportsThinking, true);
    assert.equal(spec.supportsVision, true);
    assert.equal(spec.supportsTools, true);
    assert.equal(spec.adaptiveThinkingOnly, true);
    assert.equal(isAdaptiveThinkingOnly(id), true);
  });

  test(`${id}: Bedrock-style aliases resolve to the canonical entry`, () => {
    assert.equal(getCanonicalModelSpecId(`anthropic.${id}`), id);
    assert.equal(getCanonicalModelSpecId(`bedrock/us.anthropic.${id}`), id);
  });

  test(`${id}: resolved capabilities (as routing sees them)`, () => {
    const caps = getResolvedModelCapabilities(`claude/${id}`);
    assert.equal(caps.contextWindow, 1_000_000);
    assert.equal(caps.maxOutputTokens, 128_000);
    assert.equal(caps.reasoning, true);
    assert.equal(caps.toolCalling, true);
    assert.equal(caps.supportsVision, true);
  });
}

test("thinking-disabled behaviour follows the official pages", () => {
  // Sonnet 5.5: `thinking:{type:"disabled"}` returns 400 (use between_tools). Opus 5.5:
  // adaptive thinking is always on. Haiku 5.5: disabled accepted at high effort or below.
  assert.equal(MODEL_SPECS["claude-sonnet-5-5"].rejectsThinkingDisabled, true);
  assert.equal(MODEL_SPECS["claude-opus-5-5"].rejectsThinkingDisabled, true);
  assert.equal(MODEL_SPECS["claude-haiku-5-5"].rejectsThinkingDisabled, undefined);
  assert.equal(MODEL_SPECS["claude-haiku-5-5"].maxEffortWhenThinkingDisabled, "high");
});

// ── Registry ─────────────────────────────────────────────────────────────────

test("claude registry lists the 5.5 models with xhigh effort and stripped sampling params", () => {
  const models = REGISTRY.claude.models as Array<Record<string, unknown>>;
  for (const id of NEW_IDS) {
    const m = models.find((x) => x.id === id);
    assert.ok(m, `${id} missing from claude registry`);
    assert.equal(m.contextLength, 1_000_000);
    assert.equal(m.maxOutputTokens, 128_000);
    assert.equal(m.supportsXHighEffort, true); // effort docs list xhigh for all three
    assert.deepEqual(m.unsupportedParams, ["temperature", "top_p", "top_k"]);
  }
});

test("claude registry: pre-existing entries are unchanged and keep their order", () => {
  const current = (REGISTRY.claude.models as Array<Record<string, unknown>>).filter(
    (m) => !(NEW_IDS as readonly string[]).includes(m.id as string)
  );
  assert.deepEqual(current, snapshot.registry.claude);
});

test("anthropic registry is untouched", () => {
  assert.deepEqual(
    (REGISTRY.anthropic.models as Array<Record<string, unknown>>).filter((m) =>
      /claude/i.test(String(m.id))
    ),
    snapshot.registry.anthropic
  );
});

test("getClaudeCodeDefaultModels is unchanged for existing consumers", () => {
  // The 5.5 entries are appended after their older siblings on purpose: the helper takes the
  // FIRST match per family, so listing them earlier would silently repoint Claude Code's
  // ANTHROPIC_DEFAULT_*_MODEL aliases (opus, sonnet, haiku) to 5.5.
  assert.deepEqual(getClaudeCodeDefaultModels(), snapshot.defaults);
});

// ── Pricing and cost ─────────────────────────────────────────────────────────

for (const id of NEW_IDS) {
  for (const provider of ["cc", "anthropic"]) {
    test(`${id}: ${provider} default pricing matches the official base tier`, () => {
      assert.deepEqual(getPricingForModel(provider, id), EXPECTED_PRICING[id]);
    });
  }

  test(`${id}: cost for the sample usage equals the hand-computed value`, () => {
    const pricing = getPricingForModel("cc", id)!;
    near(computeCostFromPricing(pricing, SAMPLE), EXPECTED_COST[id]);
    // Cache hit must be priced at the cache-read rate, not the input rate.
    const cacheOnly = computeCostFromPricing(pricing, { input: 1_000_000, cacheRead: 1_000_000 });
    near(cacheOnly, EXPECTED_PRICING[id].cached);
  });

  test(`${id}: providerCostData exact lookup (autoCombo cost input)`, () => {
    const p = getModelPricing("cc", id);
    assert.equal(p.inputCostPer1M, EXPECTED_PRICING[id].input);
    assert.equal(p.outputCostPer1M, EXPECTED_PRICING[id].output);
    assert.equal(p.isFree, false);
  });
}

test("KNOWN LIMITATION: Haiku 5.5 over-100k tier cannot be expressed by the pricing structure", () => {
  // Official: prompts over 100k tokens bill input $0.50, output $2.50, cache read $0.05,
  // 5m write $0.625, 1h write $1. The gateway pricing record is five flat per-model fields
  // (input/output/cached/reasoning/cache_creation) with no threshold, so the base tier is
  // used for every request and long Haiku 5.5 prompts are UNDER-estimated 5x.
  const pricing = getPricingForModel("cc", "claude-haiku-5-5")!;
  assert.deepEqual(Object.keys(pricing).sort(), [
    "cache_creation",
    "cached",
    "input",
    "output",
    "reasoning",
  ]);
  const long = computeCostFromPricing(pricing, { input: 150_000, output: 1_000 });
  near(long, (150_000 * 0.1 + 1_000 * 0.5) / 1e6); // base tier, not the 0.50 / 2.50 tier
});

test("unknown-model fallbacks are unchanged", () => {
  assert.equal(getModelSpec("claude-haiku-9-9"), undefined);
  assert.equal(getModelSpec("totally-unknown-model-xyz"), undefined);
  assert.equal(getPricingForModel("cc", "claude-haiku-9-9"), null);
  assert.deepEqual(getModelPricing("cc", "claude-haiku-9-9"), {
    inputCostPer1M: 5.0,
    outputCostPer1M: 15.0,
    isFree: false,
  });
});

// ── Existing entries byte-identical vs the pre-change snapshot ───────────────

test("existing claude MODEL_SPECS entries are identical to the snapshot", () => {
  for (const [id, spec] of Object.entries(snapshot.specs)) {
    assert.deepEqual(MODEL_SPECS[id], spec, `spec changed for ${id}`);
  }
  const claudeIds = Object.keys(MODEL_SPECS).filter((k) => /claude/i.test(k));
  const added = claudeIds.filter((k) => !(k in snapshot.specs)).sort();
  assert.deepEqual(added, [...NEW_IDS].sort());
});

test("existing claude default pricing entries are identical to the snapshot", () => {
  const table = DEFAULT_PRICING as Record<string, Record<string, unknown>>;
  for (const [provider, models] of Object.entries(snapshot.pricing)) {
    for (const [id, price] of Object.entries(models)) {
      assert.deepEqual(table[provider][id], price, `${provider}/${id} pricing changed`);
    }
  }
  for (const [provider, models] of Object.entries(table)) {
    for (const id of Object.keys(models)) {
      if (!/claude/i.test(id)) continue;
      if (snapshot.pricing[provider]?.[id] !== undefined) continue;
      assert.ok(
        (NEW_IDS as readonly string[]).includes(id),
        `unexpected new claude price ${provider}/${id}`
      );
    }
  }
});

test("existing providerCostData claude entries are identical to the snapshot", () => {
  for (const [id, price] of Object.entries(snapshot.known)) {
    assert.deepEqual(KNOWN_MODEL_PRICING[id], price, `known pricing changed for ${id}`);
  }
});

// ── Routing preview expectations (what falls out; heuristics are NOT tuned) ──

const CURRENT = [
  "claude/claude-fable-5",
  "claude/claude-opus-5",
  "claude/claude-opus-4-8",
  "claude/claude-opus-4-7",
  "claude/claude-opus-4-6",
  "claude/claude-opus-4-5-20251101",
  "claude/claude-sonnet-5",
  "claude/claude-sonnet-4-6",
  "claude/claude-sonnet-4-5-20250929",
  "claude/claude-haiku-4-5-20251001",
];
const WITH_55 = [
  ...CURRENT,
  "claude/claude-opus-5-5",
  "claude/claude-sonnet-5-5",
  "claude/claude-haiku-5-5",
];

function top(models: string[], level: "light" | "standard" | "heavy" | "critical") {
  const task = { level, weight: 0, promptChars: 0, outputTokens: 0 } as never;
  return models
    .map((m, i) => ({ m, i, score: scoreModelForTask(m, task) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
}

// Changed 2026-11-20. These three tests used to pin the old name-heuristic ranking (Haiku 5.5 at
// power 69 after a -24 "haiku" malus, Opus preferred for critical by the +28 "opus" bonus, Haiku
// 4.5 winning light by closeness to a target). The power score is now built only from resolved
// capabilities, so the 5.5 models, which the registry gives the same limits as their siblings,
// score exactly like them whatever their id says.
test("power scores of the 5.5 models come from resolved specs only", () => {
  assert.equal(modelPowerScore("claude/claude-opus-5-5"), modelPowerScore("claude/claude-opus-5"));
  assert.equal(
    modelPowerScore("claude/claude-sonnet-5-5"),
    modelPowerScore("claude/claude-sonnet-5")
  );
  // Same resolved capabilities (1M context, 128k output, reasoning, tools) => same power,
  // regardless of the family word in the id.
  assert.equal(
    modelPowerScore("claude/claude-haiku-5-5"),
    modelPowerScore("claude/claude-opus-5-5")
  );
  assert.equal(modelPowerScore("claude/claude-haiku-5-5"), 150);
  // Power is demand-relative since 2026-11-20: a model whose verified window/output covers the
  // demand scores exactly like a larger one (Haiku 4.5, 200K/64K, covers the neutral demand), and
  // one that falls short of the demand scores lower, never higher.
  assert.equal(
    modelPowerScore("claude/claude-haiku-4-5-20251001"),
    modelPowerScore("claude/claude-haiku-5-5")
  );
  const bigOutput = { promptTokens: 1_000, outputTokens: 128_000, reasoning: false, tools: false };
  assert.ok(
    modelPowerScore("claude/claude-haiku-4-5-20251001", bigOutput) <
      modelPowerScore("claude/claude-haiku-5-5", bigOutput)
  );
});

test("critical and heavy: equal verified capability ties, and ties keep the listed order", () => {
  // Critical asks for power 120: every model at or above it shares the top score.
  const sufficient = (m: string) => modelPowerScore(m) >= 120;
  const critical = top(WITH_55, "critical");
  const heavy = top(WITH_55, "heavy");
  // Every full-capability model shares the top score, in list order (stable sort).
  const best = critical[0].score;
  const tops = critical.filter((r) => r.score === best).map((r) => r.m);
  assert.deepEqual(
    tops,
    WITH_55.filter((m) => sufficient(m))
  );
  assert.equal(heavy.filter((r) => r.score === heavy[0].score).length, tops.length);
  // Nothing outranks the sufficient group.
  assert.ok(critical[0].score >= critical[critical.length - 1].score);
  assert.ok(tops.includes("claude/claude-haiku-4-5-20251001"), "haiku 4.5 verifies power 125");
});

test("light: sufficiency, not size: Haiku 4.5 and the 5.5 models tie on the light ask", () => {
  const light = top(WITH_55, "light");
  const byModel = Object.fromEntries(light.map((r) => [r.m, r.score]));
  assert.equal(byModel["claude/claude-haiku-4-5-20251001"], byModel["claude/claude-haiku-5-5"]);
  assert.equal(byModel["claude/claude-haiku-5-5"], byModel["claude/claude-fable-5"]);
});
