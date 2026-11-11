import test from "node:test";
import assert from "node:assert/strict";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import {
  rankFitFirstFreeCandidates,
  inferFitFirstTaskType,
} from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { noThinkingHandling } from "../../open-sse/services/reasoningEffortCompatibility.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
const MODELS = [
  "minimaxai/minimax-m3.1-flash",
  "z-ai/glm-5.3-flash",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
];
const messages = [
  { role: "system", content: 'Return a JSON schema constrained object: {"type":"object"}.' },
  { role: "user", content: "PUBLIC SOURCE DATA: adult tour EUR45 per person." },
  {
    role: "user",
    content:
      "Analyze these retrieved travel product rates for this traveler, retaining source evidence and missing coverage as unknown.",
  },
];
test.after(() => resetDbInstance());
test("documented exact hosted reasoning models resolve true without inventing support elsewhere", () => {
  for (const model of MODELS)
    assert.equal(getResolvedModelCapabilities("nvidia/" + model).supportsThinking, true, model);
  assert.notEqual(
    getResolvedModelCapabilities("nvidia/unregistered-reasoning-fixture").supportsThinking,
    true
  );
});
test("generic low allows automatic selection among all qualified reasoning candidates", () => {
  const candidates = MODELS.map((model) => ({
    provider: "nvidia",
    model,
    modelStr: "nvidia/" + model,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED" as const,
    costPer1MTokens: 0,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
  }));
  const result = rankFitFirstFreeCandidates({
    candidates,
    body: { messages, reasoning_effort: "low", max_tokens: 2000 },
    zeroAdditionalCostProviders: ["nvidia"],
  });
  assert.equal(result.taskType, "analysis");
  assert.deepEqual(result.requiredCapabilities, ["reasoning"]);
  assert.deepEqual(new Set(result.ranked.map((row) => row.candidate.model)), new Set(MODELS));
  assert.equal(result.excluded.length, 0);
  assert.ok(
    result.ranked.every((row) => row.factors.answerQuality === null),
    "capability metadata is not a semantic-quality score"
  );
});
test("reasoning capability does not pretend always-thinking endpoints support None", () => {
  assert.equal(noThinkingHandling("nvidia", MODELS[0]), null);
  assert.equal(noThinkingHandling("nvidia", MODELS[1]), null);
  assert.equal(noThinkingHandling("nvidia", MODELS[2]), "native");
});
test("output contract in system does not replace the actual travel analysis ask", () => {
  assert.deepEqual(inferFitFirstTaskType({ messages }), { taskType: "analysis", source: "ask" });
});

test("qualified hosted candidates retain their documented literal low effort on final wire", async () => {
  const old = globalThis.fetch;
  const wires: Record<string, unknown>[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      wires.push(JSON.parse(String(init?.body)));
      return new Response("{}");
    };
    for (const model of MODELS.slice(0, 2))
      await new DefaultExecutor("nvidia").execute({
        model,
        body: {
          model,
          messages,
          reasoning_effort: "low",
          max_tokens: 2000,
          response_format: {
            type: "json_schema",
            json_schema: { name: "travel_rates", schema: { type: "object" } },
          },
        },
        stream: false,
        credentials: { apiKey: "offline-only" },
      });
    assert.equal(wires.length, 2);
    for (const wire of wires) {
      assert.equal(wire.reasoning_effort, "low");
      assert.equal(wire.max_tokens, 2000);
      assert.equal(wire.thinking_token_budget, undefined);
      assert.equal(wire.reasoning_budget, undefined);
    }
  } finally {
    globalThis.fetch = old;
  }
});
