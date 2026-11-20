import test from "node:test";
import assert from "node:assert/strict";

import {
  inferFitFirstTaskType,
  rankFitFirstFreeCandidates,
} from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import {
  clearUserFitnessOverride,
  setUserFitnessOverride,
} from "../../open-sse/services/autoCombo/taskFitness.ts";

test.after(() => resetDbInstance());

function candidate(provider: string, model: string, extra: Record<string, unknown> = {}) {
  return {
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
    ...extra,
  };
}

test("the current ask outranks conflicting project context", () => {
  const result = inferFitFirstTaskType({
    messages: [
      { role: "system", content: "This project is a TypeScript implementation." },
      { role: "user", content: "Plan the product roadmap and rollout strategy." },
    ],
  });

  assert.deepEqual(result, { taskType: "planning", source: "ask" });
});

test("an ambiguous continuation uses project context", () => {
  const result = inferFitFirstTaskType({
    messages: [
      { role: "system", content: "We are debugging a Python API regression." },
      { role: "user", content: "continue" },
    ],
  });

  assert.deepEqual(result, { taskType: "debugging", source: "project" });
});

test("task fit changes the winner through evidence, not through a static vendor preference", () => {
  // Changed 2026-11-20: this test used to assert that a built-in table made codex win coding and
  // claude win planning. That table is gone (it decided between vendors by name). The winner now
  // moves only when evidence says so, here owner-set per-task fitness overrides.
  const candidates = [candidate("codex", "gpt-5.6-sol"), candidate("claude", "claude-opus-4-7")];
  const freePool = ["codex", "claude"];
  const coding = {
    messages: [{ role: "user", content: "Implement a TypeScript function and test suite." }],
  };
  const planning = { messages: [{ role: "user", content: "Plan the architecture and rollout." }] };
  const run = (body: Record<string, unknown>) =>
    rankFitFirstFreeCandidates({ candidates, body, zeroAdditionalCostProviders: freePool });
  try {
    setUserFitnessOverride("codex/gpt-5.6-sol", "coding", 0.99);
    setUserFitnessOverride("claude/claude-opus-4-7", "coding", 0.6);
    setUserFitnessOverride("codex/gpt-5.6-sol", "planning", 0.6);
    setUserFitnessOverride("claude/claude-opus-4-7", "planning", 0.99);
    const c = run(coding);
    const p = run(planning);
    assert.equal(c.taskType, "coding");
    assert.equal(c.ranked[0].candidate.provider, "codex");
    assert.equal(c.ranked[0].factors.taskFitnessSource, "user_override");
    assert.equal(p.taskType, "planning");
    assert.equal(p.ranked[0].candidate.provider, "claude");
  } finally {
    for (const t of ["coding", "planning"]) {
      clearUserFitnessOverride("codex/gpt-5.6-sol", t);
      clearUserFitnessOverride("claude/claude-opus-4-7", t);
    }
  }
});

test("unverified, quota-dead, status-dead and circuit-open candidates are excluded", () => {
  const result = rankFitFirstFreeCandidates({
    candidates: [
      candidate("claude", "claude-sonnet-4-6"),
      candidate("paid", "best-model"),
      candidate("github", "gpt-5.5", { quotaRemaining: 0 }),
      candidate("nvidia", "glm-5", { statusPenalty: true }),
      candidate("ollama-local", "qwen3.6", { circuitBreakerState: "OPEN" }),
    ],
    body: { messages: [{ role: "user", content: "Analyze this issue." }] },
    zeroAdditionalCostProviders: ["claude", "github", "nvidia", "ollama-local"],
  });

  assert.deepEqual(
    result.ranked.map((entry) => entry.candidate.provider),
    ["claude"]
  );
  assert.deepEqual(
    new Set(result.excluded.map((entry) => entry.reason)),
    new Set([
      "not_verified_zero_additional_cost",
      "quota_unavailable",
      "connection_unavailable",
      "circuit_open",
    ])
  );
});

test("non-generative specialty models cannot become chat fallbacks", () => {
  const result = rankFitFirstFreeCandidates({
    candidates: [
      candidate("nvidia", "nvidia/nemotron-3.5-content-safety"),
      candidate("nvidia", "meta/llama-guard-4-12b"),
      candidate("nvidia", "nvidia/nemotron-3-embed-1b"),
      candidate("nvidia", "nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1"),
      candidate("nvidia", "z-ai/glm-5.3-flash"),
    ],
    body: { messages: [{ role: "user", content: "Summarize this message." }] },
    zeroAdditionalCostProviders: ["nvidia"],
  });

  assert.deepEqual(
    result.ranked.map((entry) => entry.candidate.model),
    ["z-ai/glm-5.3-flash"]
  );
  assert.equal(
    result.excluded.filter((entry) => entry.reason === "non_generative_specialty_model").length,
    4
  );
});

test("vision requests exclude models without confirmed vision support before ranking", () => {
  // An intentionally unregistered fixture has no confirmed vision support.
  // The previous GLM fixture acquired vision metadata in the deployed catalog.
  const unverifiedModel = "fixture-text-only";
  const result = rankFitFirstFreeCandidates({
    candidates: [candidate("nvidia", unverifiedModel), candidate("claude", "claude-sonnet-5")],
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
            { type: "text", text: "Describe this image." },
          ],
        },
      ],
    },
    zeroAdditionalCostProviders: ["nvidia", "claude"],
  });

  assert.deepEqual(result.requiredCapabilities, ["vision"]);
  assert.equal(result.ranked[0]?.candidate.provider, "claude");
  assert.equal(
    result.excluded.some(
      (entry) =>
        entry.provider === "nvidia" &&
        entry.model === unverifiedModel &&
        entry.reason === "capability_mismatch_vision"
    ),
    true
  );
});

test("catalog token price does not affect ranking inside the verified included pool", () => {
  const body = { messages: [{ role: "user", content: "Plan the architecture." }] };
  const expensiveCatalog = rankFitFirstFreeCandidates({
    candidates: [
      candidate("claude", "claude-opus-4-7", { costPer1MTokens: 999 }),
      candidate("codex", "gpt-5.6-sol", { costPer1MTokens: 0 }),
    ],
    body,
    zeroAdditionalCostProviders: ["claude", "codex"],
  });
  const reversedCatalog = rankFitFirstFreeCandidates({
    candidates: [
      candidate("claude", "claude-opus-4-7", { costPer1MTokens: 0 }),
      candidate("codex", "gpt-5.6-sol", { costPer1MTokens: 999 }),
    ],
    body,
    zeroAdditionalCostProviders: ["claude", "codex"],
  });

  // Changed 2026-11-20: the old assertion pinned the winner to claude, which only held because of
  // the removed static vendor table. The property under test is that price does not move the
  // ranking: the same candidate wins whichever way the catalog prices are assigned.
  assert.equal(
    expensiveCatalog.ranked[0].candidate.provider,
    reversedCatalog.ranked[0].candidate.provider
  );
  assert.deepEqual(
    expensiveCatalog.ranked.map((r) => r.factors.score),
    reversedCatalog.ranked.map((r) => r.factors.score)
  );
});

test("exact ties are deterministic and never depend on Math.random", () => {
  const args = {
    candidates: [candidate("alpha", "same"), candidate("beta", "same")],
    body: { messages: [{ role: "user", content: "hello" }] },
    zeroAdditionalCostProviders: ["alpha", "beta"],
  };
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    const first = rankFitFirstFreeCandidates(args).ranked.map((entry) => entry.candidate.provider);
    Math.random = () => 0.999999;
    const second = rankFitFirstFreeCandidates(args).ranked.map((entry) => entry.candidate.provider);
    assert.deepEqual(first, second);
  } finally {
    Math.random = originalRandom;
  }
});
