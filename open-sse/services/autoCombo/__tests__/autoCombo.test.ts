/**
 * Unit tests for Auto-Combo Engine (Phase 5)
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { calculateFactors, calculateScore, DEFAULT_WEIGHTS, validateWeights } from "../scoring";
import type { ProviderCandidate, ScoringWeights } from "../scoring";
import {
  getTaskFitness,
  getTaskFitnessWithSource,
  getTaskTypes,
  getModelsDevTierFitness,
  invalidateFitnessCache,
  setUserFitnessOverride,
  clearUserFitnessOverride,
} from "../taskFitness";
import { SelfHealingManager } from "../selfHealing";
import { MODE_PACKS, getModePack, getModePackNames } from "../modePacks";
import { getStrategy } from "../routerStrategy";
import type { RoutingContext } from "../routerStrategy";
import { clearModelsDevCapabilities, saveModelsDevCapabilities } from "@/lib/modelsDevSync";

const capabilityEntry = (
  limit_context: number | null,
  limit_output: number | null,
  reasoning: boolean | null,
  tool_call: boolean | null
) => ({
  tool_call,
  reasoning,
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
  limit_context,
  limit_input: null,
  limit_output,
  interleaved_field: null,
});
const STRONG = capabilityEntry(1_000_000, 128_000, true, true);
const WEAK = capabilityEntry(32_000, 8_192, false, true);
afterAll(() => clearModelsDevCapabilities());
function seedCapabilities(map: Record<string, Record<string, ReturnType<typeof capabilityEntry>>>) {
  saveModelsDevCapabilities(map);
  invalidateFitnessCache();
}

describe("Scoring", () => {
  const candidate: ProviderCandidate = {
    provider: "anthropic",
    model: "claude-sonnet",
    quotaRemaining: 80,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 3,
    p95LatencyMs: 1200,
    latencyStdDev: 120,
    errorRate: 0.02,
  };

  it("should calculate a score between 0 and 1", () => {
    const pool: ProviderCandidate[] = [
      candidate,
      {
        ...candidate,
        provider: "google",
        model: "gemini-pro",
        costPer1MTokens: 6,
        p95LatencyMs: 1800,
        latencyStdDev: 300,
        quotaRemaining: 70,
      },
    ];
    const factors = calculateFactors(candidate, pool, "coding", getTaskFitness);
    const score = calculateScore(factors, DEFAULT_WEIGHTS);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("OPEN circuit breaker should reduce score", () => {
    const unhealthyCandidate: ProviderCandidate = { ...candidate, circuitBreakerState: "OPEN" };
    const pool: ProviderCandidate[] = [candidate, unhealthyCandidate];

    const healthyFactors = calculateFactors(candidate, pool, "coding", getTaskFitness);
    const unhealthyFactors = calculateFactors(unhealthyCandidate, pool, "coding", getTaskFitness);

    const healthy = calculateScore(healthyFactors, DEFAULT_WEIGHTS);
    const unhealthy = calculateScore(unhealthyFactors, DEFAULT_WEIGHTS);
    expect(healthy).toBeGreaterThan(unhealthy);
  });

  it("should validate weights sum to 1.0", () => {
    expect(validateWeights(DEFAULT_WEIGHTS)).toBe(true);
    expect(validateWeights({ ...DEFAULT_WEIGHTS, quota: 0.5 })).toBe(false);
  });
});

describe("Task Fitness", () => {
  // Changed 2026-11-20: fitness no longer comes from a static vendor/name table or name wildcards
  // (claude-sonnet 0.95, "coder" +0.15, ...). It comes from measured rows or verified capability.
  it("should return a capability-derived fitness for a model with verified capabilities", () => {
    seedCapabilities({ "fx-prov": { "fx-strong": STRONG } });
    const result = getTaskFitnessWithSource("fx-prov/fx-strong", "coding");
    expect(result.source).toBe("capability_derived");
    expect(result.score).toBeGreaterThan(0.5);
  });

  it("should return 0.5 default for unknown model", () => {
    const score = getTaskFitness("totally-unknown-model", "coding");
    expect(score).toBe(0.5);
  });

  it("should list all task types", () => {
    const types = getTaskTypes();
    expect(types).toContain("coding");
    expect(types).toContain("review");
    expect(types).toContain("planning");
    expect(types.length).toBeGreaterThanOrEqual(6);
  });

  it("name words earn nothing: a coder-named model is not boosted over a plain one", () => {
    const coderScore = getTaskFitness("some-coder-model", "coding");
    const normalScore = getTaskFitness("some-random-model", "coding");
    expect(coderScore).toBe(normalScore);
  });

  describe("-free alias resolution (#4517)", () => {
    beforeEach(() => invalidateFitnessCache());

    it("returns the base model's arena_elo when given a -free variant", async () => {
      // The fix: getTaskFitnessWithSource strips a trailing "-free" suffix
      // and re-queries arena_elo with the base id. We seed an arena_elo
      // row directly via the DB module, look up the free variant, and
      // assert the alias path returns the base score with source
      // "arena_elo_free_alias".
      const baseId = "alias-base-test-4517";
      const freeId = "alias-base-test-4517-free";
      const { upsertModelIntelligence, deleteModelIntelligence } =
        await import("../../../../src/lib/db/modelIntelligence.ts");
      // Seed arena_elo on the base id only — no row exists for the free id.
      upsertModelIntelligence({
        model: baseId,
        source: "arena_elo",
        category: "coding",
        score: 0.42,
        eloRaw: 1500,
        confidence: "high",
        expiresAt: null,
      });
      invalidateFitnessCache();
      try {
        const result = getTaskFitnessWithSource(freeId, "coding");
        // Without the fix: result.source would be "no_capability_evidence" (0.5).
        // With the fix: result.source is "arena_elo_free_alias". Since 2026-11-20 a rating
        // refines the fitness instead of replacing it: with no capability evidence the 0.5 prior
        // moves by ((0.42 - 0.69) / 0.29) x 0.06 = -0.0559 (below the lowest verified value).
        expect(result.score).toBeCloseTo(0.5 + ((0.42 - 0.69) / 0.29) * 0.06, 5);
        expect(result.source).toBe("arena_elo_free_alias");
      } finally {
        deleteModelIntelligence(baseId, "arena_elo", "coding");
        invalidateFitnessCache();
      }
    });

    it("does not strip -free when arena_elo is present on the literal model id", () => {
      // If both "foo-free" and "foo" have arena_elo rows, the literal "foo-free"
      // wins (we never go through the alias path). This protects future
      // benchmark uploads that specifically tag free tiers.
      setUserFitnessOverride("foo-free", "coding", 0.91);
      const result = getTaskFitnessWithSource("foo-free", "coding");
      expect(result.score).toBe(0.91);
      expect(result.source).toBe("user_override");
      clearUserFitnessOverride("foo-free", "coding");
      invalidateFitnessCache();
    });

    it("ignores -free suffix only at the end of the model id", () => {
      // "free-something" must NOT be treated as a free alias of "free-something-free"
      // — the suffix must be at the end. "mimo-free-edition" is left alone.
      // We just confirm no exception is thrown and the lookup returns a number.
      const score = getTaskFitness("mimo-free-edition", "coding");
      expect(typeof score).toBe("number");
      expect(score).toBeGreaterThan(0);
    });
  });
});

describe("Self-Healing", () => {
  let healer: SelfHealingManager;

  beforeEach(() => {
    healer = new SelfHealingManager();
  });

  it("should exclude provider with low score", () => {
    const result = healer.evaluate("bad-provider", 0.1, "CLOSED");
    expect(result.excluded).toBe(true);
    expect(result.reason).toContain("below threshold");
  });

  it("should keep healthy providers", () => {
    const result = healer.evaluate("good-provider", 0.8, "CLOSED");
    expect(result.excluded).toBe(false);
  });

  it("should auto-exclude OPEN circuit breakers", () => {
    const result = healer.evaluate("broken-provider", 0.8, "OPEN");
    expect(result.excluded).toBe(true);
  });

  it("should detect incident mode when >50% providers are OPEN", () => {
    healer.updateIncidentMode(["OPEN", "OPEN", "CLOSED"]);
    expect(healer.isInIncidentMode()).toBe(true);
  });

  it("should not be in incident mode when most are CLOSED", () => {
    healer.updateIncidentMode(["CLOSED", "CLOSED", "OPEN"]);
    expect(healer.isInIncidentMode()).toBe(false);
  });

  it("should track exclusion count", () => {
    healer.evaluate("p1", 0.1, "CLOSED");
    healer.evaluate("p2", 0.1, "CLOSED");
    const status = healer.getStatus();
    expect(status.exclusionCount).toBe(2);
  });
});

describe("Mode Packs", () => {
  it("should have 6 mode packs", () => {
    // #4235 Phase B added reliability-first (for the `:reliable` tier).
    // chaos-mode added for the `auto/chaos` parallel-dispatch variant.
    expect(getModePackNames()).toHaveLength(6);
    expect(getModePackNames()).toContain("reliability-first");
    expect(getModePackNames()).toContain("chaos-mode");
  });

  it("reliability-first should prioritize health and stability", () => {
    const pack = MODE_PACKS["reliability-first"];
    expect(pack.health).toBeGreaterThan(pack.latencyInv);
    expect(pack.stability).toBeGreaterThan(pack.costInv);
  });

  it("all mode pack weights should sum to 1.0", () => {
    for (const name of getModePackNames()) {
      const pack = getModePack(name);
      if (pack) {
        const sum = Object.values(pack).reduce((a, b) => a + b, 0);
        expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
      }
    }
  });

  it("ship-fast should prioritize latency", () => {
    const pack = MODE_PACKS["ship-fast"];
    expect(pack.latencyInv).toBeGreaterThan(pack.costInv);
  });

  it("cost-saver should prioritize cost", () => {
    const pack = MODE_PACKS["cost-saver"];
    expect(pack.costInv).toBeGreaterThan(pack.latencyInv);
  });

  it("quality-first should prioritize task fit", () => {
    const pack = MODE_PACKS["quality-first"];
    expect(pack.taskFit).toBeGreaterThan(pack.costInv);
  });

  it("undefined pack should return undefined", () => {
    expect(getModePack("nonexistent")).toBeUndefined();
  });
});

describe("SLA-aware Strategy", () => {
  const pool: ProviderCandidate[] = [
    {
      provider: "fast-flaky",
      model: "fast-model",
      quotaRemaining: 100,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 2,
      p95LatencyMs: 800,
      latencyStdDev: 200,
      errorRate: 0.2,
    },
    {
      provider: "steady",
      model: "steady-model",
      quotaRemaining: 80,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 6,
      p95LatencyMs: 1400,
      latencyStdDev: 100,
      errorRate: 0.01,
    },
    {
      provider: "cheap-slow",
      model: "cheap-model",
      quotaRemaining: 100,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 0.2,
      p95LatencyMs: 3500,
      latencyStdDev: 150,
      errorRate: 0.01,
    },
  ];

  it("should prefer candidates that satisfy latency and error-rate SLOs", () => {
    const strategy = getStrategy("sla-aware");
    const result = strategy.select(pool, {
      taskType: "coding",
      sla: {
        targetP95Ms: 2000,
        maxErrorRate: 0.05,
        maxCostPer1MTokens: 10,
      },
    });

    expect(result.strategy).toBe("sla-aware");
    expect(result.provider).toBe("steady");
    expect(result.reason).toContain("p95=1400ms/2000ms");
  });

  it("should support the sla alias and soft-fallback when no candidate satisfies all SLOs", () => {
    const strategy = getStrategy("sla");
    const result = strategy.select(pool, {
      taskType: "coding",
      sla: {
        targetP95Ms: 500,
        maxErrorRate: 0.005,
        maxCostPer1MTokens: 1,
        hardConstraints: true,
      },
    });

    expect(result.strategy).toBe("sla-aware");
    expect(result.candidatesConsidered).toBe(3);
    expect(result.reason).toContain("no candidate met all SLA constraints");
  });

  it("should use pure score ranking in soft mode even when a compliant candidate exists", () => {
    const strategy = getStrategy("sla-aware");
    const softPool: ProviderCandidate[] = [
      {
        provider: "slightly-over-error",
        model: "fast-reliable-enough",
        quotaRemaining: 100,
        quotaTotal: 100,
        circuitBreakerState: "CLOSED",
        costPer1MTokens: 1,
        p95LatencyMs: 500,
        latencyStdDev: 10,
        errorRate: 0.06,
      },
      {
        provider: "compliant-but-risky",
        model: "threshold-model",
        quotaRemaining: 100,
        quotaTotal: 100,
        circuitBreakerState: "HALF_OPEN",
        costPer1MTokens: 5,
        p95LatencyMs: 2_000,
        latencyStdDev: 1_000,
        errorRate: 0.05,
      },
    ];

    const result = strategy.select(softPool, {
      taskType: "coding",
      sla: {
        targetP95Ms: 2_000,
        maxErrorRate: 0.05,
        maxCostPer1MTokens: 5,
      },
    });

    expect(result.provider).toBe("slightly-over-error");
    expect(result.reason).not.toContain("no candidate met all SLA constraints");
  });

  it("should prefer compliant candidates before score when hard constraints are enabled", () => {
    const strategy = getStrategy("sla-aware");
    const hardPool: ProviderCandidate[] = [
      {
        provider: "slightly-over-error",
        model: "fast-reliable-enough",
        quotaRemaining: 100,
        quotaTotal: 100,
        circuitBreakerState: "CLOSED",
        costPer1MTokens: 1,
        p95LatencyMs: 500,
        latencyStdDev: 10,
        errorRate: 0.06,
      },
      {
        provider: "compliant-but-risky",
        model: "threshold-model",
        quotaRemaining: 100,
        quotaTotal: 100,
        circuitBreakerState: "HALF_OPEN",
        costPer1MTokens: 5,
        p95LatencyMs: 2_000,
        latencyStdDev: 1_000,
        errorRate: 0.05,
      },
    ];

    const result = strategy.select(hardPool, {
      taskType: "coding",
      sla: {
        targetP95Ms: 2_000,
        maxErrorRate: 0.05,
        maxCostPer1MTokens: 5,
        hardConstraints: true,
      },
    });

    expect(result.provider).toBe("compliant-but-risky");
  });

  it("should give full SLO-factor credit to candidates exactly at configured thresholds", () => {
    const strategy = getStrategy("sla-aware");
    const result = strategy.select(
      [
        {
          provider: "threshold-provider",
          model: "threshold-model",
          quotaRemaining: 100,
          quotaTotal: 100,
          circuitBreakerState: "CLOSED",
          costPer1MTokens: 5,
          p95LatencyMs: 1_000,
          latencyStdDev: 50,
          errorRate: 0.1,
        },
      ],
      {
        taskType: "coding",
        sla: {
          targetP95Ms: 1_000,
          maxErrorRate: 0.1,
          maxCostPer1MTokens: 5,
        },
      }
    );

    expect(result.finalScore).toBeGreaterThan(0.9);
  });
});

describe("LKGP Strategy", () => {
  const pool: ProviderCandidate[] = [
    {
      provider: "anthropic",
      model: "claude-sonnet",
      quotaRemaining: 80,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 3,
      p95LatencyMs: 1200,
      latencyStdDev: 120,
      errorRate: 0.02,
    },
    {
      provider: "openai",
      model: "gpt-4o",
      quotaRemaining: 90,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 5,
      p95LatencyMs: 800,
      latencyStdDev: 80,
      errorRate: 0.01,
    },
  ];

  it("should fall back to rules strategy when lkgpEnabled is false", () => {
    const context: RoutingContext = {
      taskType: "coding",
      lastKnownGoodProvider: "anthropic",
      lkgpEnabled: false,
    };
    const lkgpStrategy = getStrategy("lkgp");
    const rulesStrategy = getStrategy("rules");

    const lkgpResult = lkgpStrategy.select(pool, context);
    const rulesResult = rulesStrategy.select(pool, context);

    expect(lkgpResult.strategy).toBe("rules");
    expect(lkgpResult.provider).toBe(rulesResult.provider);
  });

  it("should use LKGP provider when lkgpEnabled is true", () => {
    const context: RoutingContext = {
      taskType: "coding",
      lastKnownGoodProvider: "anthropic",
      lkgpEnabled: true,
    };
    const lkgpStrategy = getStrategy("lkgp");
    const result = lkgpStrategy.select(pool, context);

    expect(result.strategy).toBe("lkgp");
    expect(result.provider).toBe("anthropic");
  });

  it("should use LKGP provider when lkgpEnabled is undefined (default)", () => {
    const context: RoutingContext = {
      taskType: "coding",
      lastKnownGoodProvider: "openai",
    };
    const lkgpStrategy = getStrategy("lkgp");
    const result = lkgpStrategy.select(pool, context);

    expect(result.strategy).toBe("lkgp");
    expect(result.provider).toBe("openai");
  });
});

describe("Task Fitness Resolution Chain", () => {
  // Rewritten 2026-11-20. Chain: user_override > arena_elo > models_dev_tier rows >
  // capability_derived > no_capability_evidence (0.5). The static table and name wildcards
  // ("fitness_table", "wildcard_boost") were removed because they decided ranking by vendor/name.
  it("unknown models get the neutral prior, labelled as such", () => {
    expect(getTaskFitnessWithSource("totally-random-xyz", "coding")).toEqual({
      score: 0.5,
      source: "no_capability_evidence",
    });
  });

  it("vendor and family words in an id do not change the fitness of an unverified model", () => {
    for (const id of [
      "claude-sonnet",
      "claude-opus",
      "gpt-4o",
      "o3",
      "codex",
      "qwen",
      "my-coder-pro",
    ]) {
      expect(getTaskFitnessWithSource(`zz-unverified-${id}`, "coding")).toEqual({
        score: 0.5,
        source: "no_capability_evidence",
      });
    }
  });

  it("no legacy sources are emitted", () => {
    for (const id of ["claude-sonnet", "fast-model", "my-coder-pro", "my-thinking-model"]) {
      for (const task of ["coding", "planning", "analysis", "review"]) {
        const source = getTaskFitnessWithSource(`zz-${id}`, task).source;
        expect(source).not.toBe("fitness_table");
        expect(source).not.toBe("wildcard_boost");
      }
    }
  });

  it("capability-derived fitness is identical for identical capabilities, whatever the id", () => {
    seedCapabilities({
      "vendor-one": { "model-claude-opus-max": STRONG },
      "vendor-two": { "tiny-haiku-mini": STRONG },
    });
    for (const task of ["coding", "review", "planning", "analysis", "general"]) {
      expect(getTaskFitnessWithSource("vendor-one/model-claude-opus-max", task)).toEqual(
        getTaskFitnessWithSource("vendor-two/tiny-haiku-mini", task)
      );
    }
  });

  it("capability-derived fitness is monotone: stronger verified capability never scores lower", () => {
    seedCapabilities({ "vendor-m": { weak: WEAK, strong: STRONG } });
    for (const task of ["coding", "review", "planning", "analysis", "math", "general"]) {
      expect(getTaskFitness("vendor-m/strong", task)).toBeGreaterThanOrEqual(
        getTaskFitness("vendor-m/weak", task)
      );
      expect(getTaskFitness("vendor-m/weak", task)).toBeGreaterThanOrEqual(
        getTaskFitness("vendor-nodata/never-synced", task)
      );
    }
  });

  it("getTaskTypes should return task types without 'default'", () => {
    const types = getTaskTypes();
    expect(types).toContain("coding");
    expect(types).toContain("review");
    expect(types).toContain("planning");
    expect(types).not.toContain("default");
  });

  it("measured evidence outranks capability: a user override wins over capability_derived", () => {
    seedCapabilities({ "vendor-o": { strong: STRONG } });
    setUserFitnessOverride("vendor-o/strong", "coding", 0.31);
    try {
      expect(getTaskFitnessWithSource("vendor-o/strong", "coding")).toEqual({
        score: 0.31,
        source: "user_override",
      });
    } finally {
      clearUserFitnessOverride("vendor-o/strong", "coding");
      invalidateFitnessCache();
    }
  });
});

describe("Task Fitness DB Resolution Chain", () => {
  it("getModelsDevTierFitness returns null when no persisted tier row exists", () => {
    expect(getModelsDevTierFitness("zz-no-such-model", "coding")).toBeNull();
  });

  it("invalidateFitnessCache does not throw", () => {
    expect(() => invalidateFitnessCache()).not.toThrow();
  });

  it("case insensitivity: task types are lowercased before lookup", () => {
    seedCapabilities({ "vendor-c": { strong: STRONG } });
    expect(getTaskFitness("vendor-c/strong", "CODING")).toBe(
      getTaskFitness("vendor-c/strong", "coding")
    );
  });

  it("model-id case does not change a persisted override lookup", () => {
    setUserFitnessOverride("Vendor-X/Model-Y", "coding", 0.77);
    try {
      expect(getTaskFitness("vendor-x/model-y", "coding")).toBe(0.77);
      expect(getTaskFitness("VENDOR-X/MODEL-Y", "coding")).toBe(0.77);
    } finally {
      clearUserFitnessOverride("Vendor-X/Model-Y", "coding");
      invalidateFitnessCache();
    }
  });

  it("a -free variant resolves like its base id only through arena_elo, not through a name table", () => {
    expect(getTaskFitnessWithSource("claude-sonnet-free", "coding")).toEqual({
      score: 0.5,
      source: "no_capability_evidence",
    });
  });
});
