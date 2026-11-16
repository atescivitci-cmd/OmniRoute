// Cost estimate must price cached tokens at the cached rate for EVERY usage shape the call-log
// writer understands, including the nested OpenAI shapes (prompt_tokens_details /
// input_tokens_details). Before this fix computeCostFromPricing only read flat fields, so a
// Responses-API usage (translator state.usage = {input_tokens, input_tokens_details}) priced
// its whole prompt at the full input rate (measured 0.441 vs 0.0531 for 86187 prompt tokens of
// which 86180 were cache reads on claude-opus-4-8).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cache-cost-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "cache-cost-test-secret";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const callCost = await import("../../src/lib/usage/callCost.ts");
const costCalculator = await import("../../src/lib/usage/costCalculator.ts");
const tokenAccounting = await import("../../src/lib/usage/tokenAccounting.ts");
const flatRate = await import("../../src/lib/usage/flatRateProviders.ts");

const { computeCostFromPricing, extractExactCostUsd, getCodexFastCostMultiplier } = costCalculator;

type Usage = Record<string, unknown>;
type Pricing = Record<string, unknown>;

const OPUS: Pricing = { input: 5, cached: 0.5, output: 25, cache_creation: 6.25 };

// calculator signature is typed Record<string, number | undefined>; nested shapes are objects.
const cost = (
  pricing: Pricing | null,
  usage: Usage | null,
  options: Parameters<typeof computeCostFromPricing>[2] = {}
) =>
  computeCostFromPricing(
    pricing,
    usage as unknown as Parameters<typeof computeCostFromPricing>[1],
    options
  );

const near = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

// The exact figures from the measured call_logs row.
const FLAT_CLAUDE: Usage = {
  input_tokens: 86187,
  output_tokens: 401,
  cache_read_input_tokens: 86180,
};
const NESTED_PROMPT: Usage = {
  prompt_tokens: 86187,
  completion_tokens: 401,
  prompt_tokens_details: { cached_tokens: 86180 },
};
const EXPECTED_OPUS = 7 * (5 / 1e6) + 86180 * (0.5 / 1e6) + 401 * (25 / 1e6); // 0.05315...

// ---- oracle: verbatim copy of the pre-fix token math (flat fields only) -----------------------
function oldCompute(
  pricing: Pricing | null | undefined,
  tokens: Usage | null | undefined,
  options: { provider?: string | null; model?: string | null; serviceTier?: string | null } = {}
): number {
  const t = tokens as Record<string, number | undefined> | null | undefined;
  if (!t) return 0;
  const exact = extractExactCostUsd(t);
  if (exact !== null) return exact;
  if (!pricing) return 0;
  const num = (v: unknown, fb = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
  const inputPrice = num(pricing.input, 0);
  const cachedPrice = num(pricing.cached, inputPrice);
  const outputPrice = num(pricing.output, 0);
  const reasoningPrice = num(pricing.reasoning, outputPrice);
  const cacheCreationPrice = num(pricing.cache_creation, inputPrice);
  let c = 0;
  const inputTokens = t.input ?? t.prompt_tokens ?? t.input_tokens ?? 0;
  const cachedTokens = t.cacheRead ?? t.cached_tokens ?? t.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = t.cacheCreation ?? t.cache_creation_input_tokens ?? 0;
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);
  c += nonCachedInput * (inputPrice / 1_000_000);
  if (cachedTokens > 0) c += cachedTokens * (cachedPrice / 1_000_000);
  const outputTokens = t.output ?? t.completion_tokens ?? t.output_tokens ?? 0;
  c += outputTokens * (outputPrice / 1_000_000);
  const reasoningTokens = t.reasoning ?? t.reasoning_tokens ?? 0;
  if (reasoningTokens > 0) c += reasoningTokens * (reasoningPrice / 1_000_000);
  if (cacheCreationTokens > 0) c += cacheCreationTokens * (cacheCreationPrice / 1_000_000);
  return c * getCodexFastCostMultiplier(options.provider, options.model, options.serviceTier);
}

// ---- helper: observe the cache-read / cache-creation counts the calculator actually used ------
function calculatorCacheRead(usage: Usage): number {
  // cached priced at $1/token, everything else free => cost == cached token count
  return cost({ input: 0, cached: 1_000_000, output: 0, cache_creation: 0 }, usage);
}
function calculatorCacheCreation(usage: Usage): number {
  return cost({ input: 0, cached: 0, output: 0, cache_creation: 1_000_000 }, usage);
}

// ---- 1. the reproduction ----------------------------------------------------------------------
test("nested prompt_tokens_details prices cache reads at the cached rate (the measured bug)", () => {
  const flat = cost(OPUS, FLAT_CLAUDE);
  const nested = cost(OPUS, NESTED_PROMPT);
  near(flat, EXPECTED_OPUS);
  near(flat, 0.0531, 5e-5);
  near(nested, flat);
  assert.ok(nested < 0.06, `nested cost should be ~0.053, got ${nested} (full-rate bug is 0.441)`);
});

// ---- 2. Responses API shape (what the openai-responses translator puts in state.usage) --------
test("Responses API input_tokens + input_tokens_details.cached_tokens", () => {
  const usage = {
    input_tokens: 86187,
    output_tokens: 401,
    total_tokens: 86588,
    input_tokens_details: { cached_tokens: 86180 },
  };
  near(cost(OPUS, usage), EXPECTED_OPUS);
});

// ---- 3. cache creation nested -----------------------------------------------------------------
test("cache creation read from prompt_tokens_details.cache_creation_tokens", () => {
  const nested = {
    prompt_tokens: 1000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 600, cache_creation_tokens: 300 },
  };
  const flat = {
    prompt_tokens: 1000,
    completion_tokens: 100,
    cache_read_input_tokens: 600,
    cache_creation_input_tokens: 300,
  };
  near(cost(OPUS, nested), cost(OPUS, flat));
  near(
    cost(OPUS, nested),
    100 * (5 / 1e6) + 600 * (0.5 / 1e6) + 100 * (25 / 1e6) + 300 * (6.25 / 1e6)
  );
});

// ---- 4. precedence: top-level wins over nested (same as the logger) ---------------------------
test("top-level cache fields win over nested details", () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 0,
    cacheRead: 200,
    cacheCreation: 50,
    prompt_tokens_details: { cached_tokens: 900, cache_creation_tokens: 400 },
  };
  assert.equal(calculatorCacheRead(usage), 200);
  assert.equal(calculatorCacheCreation(usage), 50);
  const viaFlatNames = {
    prompt_tokens: 1000,
    cache_read_input_tokens: 200,
    prompt_tokens_details: { cached_tokens: 900 },
  };
  assert.equal(calculatorCacheRead(viaFlatNames), 200);
  // prompt_tokens_details wins over input_tokens_details when non-empty (logger behaviour)
  const both = {
    prompt_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 700 },
    input_tokens_details: { cached_tokens: 100 },
  };
  assert.equal(calculatorCacheRead(both), 700);
});

// ---- 5. malformed: cached > prompt never negative ---------------------------------------------
test("cached tokens larger than prompt tokens never produce a negative cost", () => {
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 5000, cache_creation_tokens: 7000 },
  };
  const c = cost(OPUS, usage);
  assert.ok(Number.isFinite(c) && c >= 0, `cost must be finite and non-negative, got ${c}`);
});

// ---- 6. zero / absent cache fields unchanged --------------------------------------------------
test("zero or absent cache fields price exactly as before", () => {
  const shapes: Usage[] = [
    { prompt_tokens: 1000, completion_tokens: 100 },
    { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: {} },
    { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } },
    { prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 0, cache_read_input_tokens: 0 },
    { input: 1000, output: 100 },
    {},
  ];
  for (const u of shapes) assert.equal(cost(OPUS, u), oldCompute(OPUS, u));
  near(cost(OPUS, shapes[0]), 1000 * (5 / 1e6) + 100 * (25 / 1e6));
  assert.equal(cost(OPUS, null), 0);
  assert.equal(cost(null, FLAT_CLAUDE), 0);
});

// ---- 7. exact provider-reported cost short circuit --------------------------------------------
test("provider-reported exact cost still wins, even with nested cache details", () => {
  const usage = {
    prompt_tokens: 86187,
    completion_tokens: 401,
    prompt_tokens_details: { cached_tokens: 86180 },
    cost_in_usd_ticks: 37_756_000,
  };
  assert.equal(cost(OPUS, usage), 37_756_000 / 1e10);
  assert.equal(cost(null, usage), 37_756_000 / 1e10);
});

// ---- 8. codex fast multiplier -----------------------------------------------------------------
test("codex fast multiplier is unchanged for a nested case", () => {
  const gpt: Pricing = { input: 2, cached: 0.2, output: 10 };
  const nested = {
    input_tokens: 10_000,
    output_tokens: 100,
    input_tokens_details: { cached_tokens: 9_000 },
  };
  const flat = { input_tokens: 10_000, output_tokens: 100, cached_tokens: 9_000 };
  const opts = { provider: "codex", model: "gpt-5.5", serviceTier: "fast" };
  const base = cost(gpt, nested, { provider: "codex", model: "gpt-5.5" });
  near(cost(gpt, nested, opts), base * 2.5);
  near(cost(gpt, nested, opts), cost(gpt, flat, opts));
});

// ---- 9. property test: flat usage prices identically before and after -------------------------
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: 2000 generated flat usages price identically to the pre-fix calculation", () => {
  const rnd = mulberry32(20261116);
  const FLAT_KEYS = [
    "input",
    "prompt_tokens",
    "input_tokens",
    "cacheRead",
    "cached_tokens",
    "cache_read_input_tokens",
    "cacheCreation",
    "cache_creation_input_tokens",
    "output",
    "completion_tokens",
    "output_tokens",
    "reasoning",
    "reasoning_tokens",
  ];
  const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
  const val = () => {
    const r = rnd();
    if (r < 0.15) return undefined;
    if (r < 0.2) return null;
    if (r < 0.3) return 0;
    return Math.floor(rnd() * (rnd() < 0.2 ? 500_000 : 5_000));
  };
  const price = () => (rnd() < 0.2 ? undefined : Math.round(rnd() * 3000) / 100);
  let changed = 0;
  let nestedCompared = 0;
  for (let i = 0; i < 2000; i++) {
    const usage: Usage = {};
    for (const k of FLAT_KEYS) if (rnd() < 0.45) usage[k] = val();
    const pricing: Pricing = {
      input: price(),
      cached: price(),
      output: price(),
      reasoning: price(),
      cache_creation: price(),
    };
    const options = {
      provider: pick(["claude", "codex", "cx", "openai"]),
      model: pick(["gpt-5.5", "gpt-5.4", "claude-opus-4-8"]),
      serviceTier: pick([undefined, "fast", "priority", "flex", "auto"]),
    };
    // Sprinkle nested details too; they may only matter when the flat counterpart is absent.
    const nested = rnd() < 0.35;
    if (nested) {
      usage[rnd() < 0.5 ? "prompt_tokens_details" : "input_tokens_details"] = {
        cached_tokens: val(),
        cache_creation_tokens: val(),
      };
    }
    const flatReadPresent =
      usage.cacheRead != null ||
      usage.cached_tokens != null ||
      usage.cache_read_input_tokens != null;
    const flatCreatePresent =
      usage.cacheCreation != null || usage.cache_creation_input_tokens != null;
    const details =
      (usage.prompt_tokens_details as Usage | undefined) ??
      (usage.input_tokens_details as Usage | undefined);
    const nestedMatters =
      nested &&
      ((!flatReadPresent && Number(details?.cached_tokens ?? 0) > 0) ||
        (!flatCreatePresent && Number(details?.cache_creation_tokens ?? 0) > 0));
    const before = oldCompute(pricing, usage, options);
    const after = cost(pricing, usage, options);
    if (nested && !nestedMatters) nestedCompared++;
    if (!nestedMatters) {
      assert.equal(
        after,
        before,
        `usage ${JSON.stringify(usage)} pricing ${JSON.stringify(pricing)}`
      );
    } else if (after !== before) {
      changed++;
    }
  }
  assert.ok(nestedCompared > 100, "property run must exercise flat-wins-over-nested cases");
  assert.ok(changed > 0, "property run must exercise at least one nested-only case");
});

// ---- invariant: logged cache counts == priced cache counts ------------------------------------
const SHAPES: Array<[string, Usage]> = [
  ["claude flat", FLAT_CLAUDE],
  ["claude creation flat", { input_tokens: 500, cache_creation_input_tokens: 120 }],
  ["openai flat cached_tokens", { prompt_tokens: 900, cached_tokens: 400 }],
  ["internal cacheRead/cacheCreation", { input: 900, cacheRead: 300, cacheCreation: 60 }],
  ["chat completions nested", NESTED_PROMPT],
  ["responses nested", { input_tokens: 700, input_tokens_details: { cached_tokens: 650 } }],
  [
    "nested read + creation",
    {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 600, cache_creation_tokens: 300 },
    },
  ],
  [
    "gemini translator state.usage",
    { prompt_tokens: 5000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 4000 } },
  ],
  [
    "flat beats nested",
    { prompt_tokens: 1000, cacheRead: 200, prompt_tokens_details: { cached_tokens: 900 } },
  ],
  [
    "prompt details beat input details",
    {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 700 },
      input_tokens_details: { cached_tokens: 100 },
    },
  ],
  ["empty nested", { prompt_tokens: 1000, prompt_tokens_details: {} }],
  ["no cache", { prompt_tokens: 1000, completion_tokens: 10 }],
];

test("invariant: tokenAccounting's logged cache counts equal what the calculator prices", () => {
  for (const [name, usage] of SHAPES) {
    assert.equal(
      calculatorCacheRead(usage),
      tokenAccounting.getPromptCacheReadTokens(usage),
      `cache read mismatch for shape: ${name}`
    );
    assert.equal(
      calculatorCacheCreation(usage),
      tokenAccounting.getPromptCacheCreationTokens(usage),
      `cache creation mismatch for shape: ${name}`
    );
  }
});

test("known pre-existing precedence nuance: both flat cached_tokens and cache_read_input_tokens", () => {
  // Pinned so a future change is deliberate: the calculator has always preferred cached_tokens
  // over cache_read_input_tokens when both flat fields are present; the logger prefers the latter.
  const usage = { prompt_tokens: 1000, cached_tokens: 300, cache_read_input_tokens: 500 };
  assert.equal(calculatorCacheRead(usage), 300);
  assert.equal(tokenAccounting.getPromptCacheReadTokens(usage), 500);
});

test("flat-rate zero still applies with nested cache usage", () => {
  assert.equal(flatRate.isFlatRateProvider("kimi-coding"), true);
  assert.equal(cost(OPUS, NESTED_PROMPT, { provider: "kimi-coding", flatRateAsZero: true }), 0);
  near(cost(OPUS, NESTED_PROMPT, { provider: "kimi-coding" }), EXPECTED_OPUS);
});

// ---- 10. end to end through resolveCallCost / saveCallLog on an isolated DB -------------------
test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await localDb.updatePricing({
    claude: { "claude-opus-4-8": { ...OPUS, reasoning: 25 } },
  });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("resolveCallCost: Codex-shaped nested usage is priced from the table at the corrected figure", async () => {
  const nested = await callCost.resolveCallCost("claude", "claude-opus-4-8", {
    input_tokens: 86187,
    output_tokens: 401,
    total_tokens: 86588,
    input_tokens_details: { cached_tokens: 86180 },
  });
  const flat = await callCost.resolveCallCost("claude", "claude-opus-4-8", FLAT_CLAUDE);
  assert.equal(nested.costSource, "pricing_table");
  assert.equal(flat.costSource, "pricing_table");
  near(nested.costUsd as number, EXPECTED_OPUS);
  near(nested.costUsd as number, flat.costUsd as number);
});

test("saveCallLog stores the corrected cost next to the cache-read count", async () => {
  await callLogs.saveCallLog({
    id: "cache-cost-nested-1",
    status: 200,
    model: "claude-opus-4-8",
    provider: "claude",
    tokens: NESTED_PROMPT,
    duration: 5,
    apiKeyId: null,
    apiKeyName: null,
  });
  const row = core
    .getDbInstance()
    .prepare(
      "SELECT cost_usd, cost_source, tokens_in, tokens_cache_read FROM call_logs WHERE id = ?"
    )
    .get("cache-cost-nested-1") as Record<string, number | string>;
  assert.equal(row.tokens_in, 86187);
  assert.equal(row.tokens_cache_read, 86180);
  assert.equal(row.cost_source, "pricing_table");
  near(Number(row.cost_usd), EXPECTED_OPUS);
});
