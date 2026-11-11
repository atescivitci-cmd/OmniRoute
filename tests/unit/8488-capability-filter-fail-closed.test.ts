/**
 * #8488 — capability filters fail closed when every candidate is incompatible.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-8488-compat-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { saveModelsDevCapabilities } = await import("../../src/lib/modelsDevSync.ts");
const {
  filterTargetsByRequestCompatibility,
  describeCapabilityFilterExhaustion,
  providerSupportsEmulatedToolCalling,
} = await import("../../open-sse/services/combo/comboStructure.ts");
const { resolveAutoStrategyOrder } =
  await import("../../open-sse/services/combo/resolveAutoStrategy.ts");

function capabilityEntry(limit_context: number, overrides: Record<string, unknown> = {}) {
  return {
    tool_call: null,
    reasoning: null,
    attachment: null,
    structured_output: null,
    temperature: null,
    modalities_input: "[]",
    modalities_output: "[]",
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
    ...overrides,
  };
}

function target(provider: string, modelStr: string) {
  return {
    kind: "model" as const,
    stepId: "s1",
    executionKey: `${provider}>${modelStr}`,
    modelStr,
    provider,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  };
}

function candidateFor(entry: ReturnType<typeof target>) {
  return {
    kind: "model",
    stepId: entry.stepId,
    executionKey: entry.executionKey,
    modelStr: entry.modelStr,
    provider: entry.provider,
    model: entry.modelStr.split("/").slice(1).join("/"),
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 0,
    p95LatencyMs: 100,
    latencyStdDev: 1,
    errorRate: 0,
  };
}

const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("#8488 filter: some tool-capable targets kept (unchanged)", () => {
  saveModelsDevCapabilities({
    openai: {
      "with-tools": capabilityEntry(128000, { tool_call: true }),
      "no-tools": capabilityEntry(128000, { tool_call: false }),
    },
  });

  const kept = filterTargetsByRequestCompatibility(
    [target("openai", "openai/with-tools"), target("openai", "openai/no-tools")],
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
    log
  );
  assert.deepEqual(
    kept.map((t) => t.modelStr),
    ["openai/with-tools"]
  );
});

test("#8488 filter: zero tool-capable targets → empty (fail closed)", () => {
  saveModelsDevCapabilities({
    openai: {
      "no-tools-a": capabilityEntry(128000, { tool_call: false }),
      "no-tools-b": capabilityEntry(128000, { tool_call: false }),
    },
  });

  const targets = [target("openai", "openai/no-tools-a"), target("openai", "openai/no-tools-b")];
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
  };
  const kept = filterTargetsByRequestCompatibility(targets, body, log);
  assert.equal(kept.length, 0);

  const exhaustion = describeCapabilityFilterExhaustion(targets, body, "tools-combo");
  assert.ok(exhaustion);
  assert.match(exhaustion!.message, /supports tool calling/i);
  assert.equal(exhaustion!.terminalReason, "capability_mismatch");
  assert.ok(exhaustion!.excluded.some((e) => e.reason.includes("tools")));
});

test("#8488 filter: chatgpt-web emulation providers stay eligible for tools (#5240)", () => {
  // Registry honestly tags chatgpt-web models toolCalling:false; the prompt
  // shim is what makes tools work. Fail-closed must not hard-reject them.
  assert.equal(providerSupportsEmulatedToolCalling("chatgpt-web"), true);
  assert.equal(providerSupportsEmulatedToolCalling("cgpt-web"), true);
  assert.equal(providerSupportsEmulatedToolCalling("claude-web"), false); // toolCalling:"none"
  assert.equal(providerSupportsEmulatedToolCalling("openai"), false);

  const kept = filterTargetsByRequestCompatibility(
    [target("chatgpt-web", "chatgpt-web/gpt-5.5"), target("chatgpt-web", "chatgpt-web/o3")],
    {
      messages: [{ role: "user", content: "Use a tool." }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
    log
  );
  assert.equal(kept.length, 2);
  assert.deepEqual(
    kept.map((t) => t.modelStr),
    ["chatgpt-web/gpt-5.5", "chatgpt-web/o3"]
  );

  const exhaustion = describeCapabilityFilterExhaustion(
    [target("chatgpt-web", "chatgpt-web/gpt-5.5"), target("chatgpt-web", "chatgpt-web/o3")],
    {
      messages: [{ role: "user", content: "Use a tool." }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
    "web-cookie-tools"
  );
  assert.equal(exhaustion, null, "emulation-capable pool must not report capability_mismatch");
});

test("#8488 auto: chatgpt-web emulation survives tool pre-filter (#5240)", async () => {
  const webTarget = target("chatgpt-web", "chatgpt-web/gpt-5.5");
  const result = await resolveAutoStrategyOrder({
    orderedTargets: [webTarget] as never,
    body: {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
    combo: { id: "c1", name: "auto-web-cookie", config: {} } as never,
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: log as never,
    buildAutoCandidates: (async () => [candidateFor(webTarget)]) as never,
  });

  assert.ok(
    !("earlyResponse" in result),
    "must not 400 capability_mismatch for emulation providers"
  );
  if ("orderedTargets" in result) {
    assert.equal(result.orderedTargets.length, 1);
    assert.equal(result.orderedTargets[0].modelStr, "chatgpt-web/gpt-5.5");
  }
});

test("#8488 filter: opt-in compatFilterFailOpen restores full pool", () => {
  saveModelsDevCapabilities({
    openai: {
      "no-tools-a": capabilityEntry(128000, { tool_call: false }),
      "no-tools-b": capabilityEntry(128000, { tool_call: false }),
    },
  });

  const kept = filterTargetsByRequestCompatibility(
    [target("openai", "openai/no-tools-a"), target("openai", "openai/no-tools-b")],
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
    log,
    "Context-aware fallback",
    { failOpen: true }
  );
  assert.equal(kept.length, 2);
});

test("#8488 filter: vision with no confirmed target → empty (fail closed)", () => {
  saveModelsDevCapabilities({
    openai: {
      "text-only": capabilityEntry(128000, { attachment: false, tool_call: true }),
    },
  });

  const kept = filterTargetsByRequestCompatibility(
    [target("openai", "openai/text-only")],
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see?" },
            { type: "image_url", image_url: { url: "https://example.com/a.png" } },
          ],
        },
      ],
    },
    log
  );
  assert.equal(kept.length, 0);
});

test("#8488 auto: tool pre-filter fail closed returns early 400", async () => {
  saveModelsDevCapabilities({
    openai: {
      "no-tools": capabilityEntry(128000, { tool_call: false }),
    },
  });

  const result = await resolveAutoStrategyOrder({
    orderedTargets: [target("openai", "openai/no-tools")] as never,
    body: {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
    combo: { id: "c1", name: "auto-tools", config: {} } as never,
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: log as never,
    buildAutoCandidates: (async () => []) as never,
  });

  assert.ok("earlyResponse" in result);
  if ("earlyResponse" in result) {
    assert.equal(result.earlyResponse.status, 400);
    const body = await result.earlyResponse.json();
    assert.equal(body?.error?.code, "capability_mismatch");
    assert.match(String(body?.error?.message || ""), /supports tool calling/i);
  }
});

test("#8488 auto: tool pre-filter fail-open opt-in keeps full pool", async () => {
  saveModelsDevCapabilities({
    openai: {
      "no-tools": capabilityEntry(128000, { tool_call: false }),
    },
  });

  const noToolsTarget = target("openai", "openai/no-tools");
  const result = await resolveAutoStrategyOrder({
    orderedTargets: [noToolsTarget] as never,
    body: {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
    combo: { id: "c1", name: "auto-tools-open", config: { compatFilterFailOpen: true } } as never,
    settings: null,
    config: { compatFilterFailOpen: true },
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: log as never,
    buildAutoCandidates: (async () => [candidateFor(noToolsTarget)]) as never,
  });

  assert.ok(!("earlyResponse" in result));
  if ("orderedTargets" in result) {
    assert.equal(result.orderedTargets.length, 1);
  }
});

test("Option B model-free auto expands its bounded pool before the tool filter", async () => {
  const expandedTarget = target("codex", "codex/gpt-5.3-codex");
  const expansionInputs: string[][] = [];
  const buildInputs: string[][] = [];
  const result = await resolveAutoStrategyOrder({
    orderedTargets: [] as never,
    body: {
      messages: [{ role: "user", content: "Use the available tools." }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
    combo: {
      id: "option-b",
      name: "ac-terminal-continuity",
      strategy: "auto",
      models: [],
      allowedProviders: ["codex"],
      config: { explorationRate: 0 },
    } as never,
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: log as never,
    expandAutoCandidatePool: (async (targets: never[]) => {
      expansionInputs.push(targets.map((entry: { modelStr: string }) => entry.modelStr));
      return [expandedTarget] as never;
    }) as never,
    buildAutoCandidates: (async (targets: never[]) => {
      buildInputs.push(targets.map((entry: { modelStr: string }) => entry.modelStr));
      return [
        {
          kind: "model",
          stepId: "codex/gpt-5.3-codex",
          executionKey: "codex>codex/gpt-5.3-codex",
          modelStr: "codex/gpt-5.3-codex",
          provider: "codex",
          model: "gpt-5.3-codex",
          quotaRemaining: 100,
          quotaTotal: 100,
          circuitBreakerState: "CLOSED",
          costPer1MTokens: 0,
          p95LatencyMs: 100,
          latencyStdDev: 1,
          errorRate: 0,
        },
      ];
    }) as never,
  });

  assert.ok(!("earlyResponse" in result), "expanded tool-capable target must reach routing");
  assert.deepEqual(expansionInputs, [[]], "expansion must see the intentional empty static pool");
  assert.deepEqual(buildInputs, [["codex/gpt-5.3-codex"]]);
  if ("orderedTargets" in result) {
    assert.deepEqual(
      result.orderedTargets.map((entry) => entry.modelStr),
      ["codex/gpt-5.3-codex"]
    );
  }
});

test("#8488 auto: context pre-filter fail closed when all known limits too small", async () => {
  saveModelsDevCapabilities({
    openai: {
      tiny: capabilityEntry(100, { tool_call: true }),
    },
  });

  const hugePrompt = "x".repeat(4000); // ~1000 tokens at 4 chars/token
  const result = await resolveAutoStrategyOrder({
    orderedTargets: [target("openai", "openai/tiny")] as never,
    body: { messages: [{ role: "user", content: hugePrompt }] },
    combo: { id: "c1", name: "auto-ctx", config: {} } as never,
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: log as never,
    buildAutoCandidates: (async () => []) as never,
  });

  assert.ok("earlyResponse" in result);
  if ("earlyResponse" in result) {
    assert.equal(result.earlyResponse.status, 400);
    const body = await result.earlyResponse.json();
    assert.equal(body?.error?.code, "context_length_exceeded");
  }
});

test("oversized mixed-context auto pool preserves and pins a healthy known-window target for compression", async () => {
  const codexTarget = target("codex", "codex/gpt-5.5");
  const unknownTarget = target("nvidia", "nvidia/deepseek-ai/deepseek-v4-pro-0813");
  const buildInputs: string[][] = [];
  const hugePrompt = "x".repeat(2_000_000); // ~500k tokens; above gpt-5.5's 400k window.

  const result = await resolveAutoStrategyOrder({
    orderedTargets: [codexTarget, unknownTarget] as never,
    body: {
      messages: [{ role: "user", content: hugePrompt }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
    combo: {
      id: "compression-aware-auto",
      name: "ordinary-compression",
      strategy: "auto",
      models: [],
      same_terminal_continuity: true,
      config: { explorationRate: 0 },
    } as never,
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: log as never,
    expandAutoCandidatePool: (async () => [codexTarget, unknownTarget]) as never,
    buildAutoCandidates: (async (targets: ReturnType<typeof target>[]) => {
      buildInputs.push(targets.map((entry) => entry.modelStr));
      return targets.map(candidateFor);
    }) as never,
  });

  assert.deepEqual(
    buildInputs,
    [["codex/gpt-5.5", "nvidia/deepseek-ai/deepseek-v4-pro-0813"]],
    "raw overflow must not discard the known-window target before per-target compression"
  );
  assert.ok("orderedTargets" in result);
  if ("orderedTargets" in result) {
    assert.equal(result.orderedTargets[0].modelStr, "codex/gpt-5.5");
    assert.equal(
      result.autoUsedExplicitRouter,
      true,
      "task-aware routing must not move an unknown-window target ahead of the compression choice"
    );
  }
});

test("tools+vision overflow keeps a compressible Codex route when the raw-fit route is unavailable", async () => {
  saveModelsDevCapabilities({
    codex: {
      "gpt-5.5": capabilityEntry(272_000, { tool_call: true, attachment: true }),
    },
    nvidia: {
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": capabilityEntry(1_000_000, {
        tool_call: true,
        attachment: true,
      }),
    },
  });

  const codexTarget = target("codex", "codex/gpt-5.5");
  const rawFitTarget = target("nvidia", "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
  const buildInputs: string[][] = [];
  const hugePrompt = "x".repeat(1_800_000); // ~450k tokens: above Codex, below raw-fit target.

  const result = await resolveAutoStrategyOrder({
    orderedTargets: [codexTarget, rawFitTarget] as never,
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${hugePrompt}\nDebug the failing terminal.` },
            { type: "image_url", image_url: { url: "https://example.com/terminal.png" } },
          ],
        },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
    combo: {
      id: "compression-aware-tools-vision",
      name: "ordinary-compression",
      strategy: "auto",
      models: [],
      same_terminal_continuity: true,
      config: {
        explorationRate: 0,
        selectionPolicy: "fit-first-free",
        zeroAdditionalCostProviders: ["codex", "nvidia"],
      },
    } as never,
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: log as never,
    expandAutoCandidatePool: (async () => [codexTarget, rawFitTarget]) as never,
    buildAutoCandidates: (async (targets: ReturnType<typeof target>[]) => {
      buildInputs.push(targets.map((entry) => entry.modelStr));
      return targets.map(candidateFor);
    }) as never,
    isModelAvailable: (async (_model: string, targetEntry: ReturnType<typeof target>) =>
      targetEntry.provider === "codex") as never,
  });

  assert.deepEqual(
    buildInputs,
    [["codex/gpt-5.5", "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"]],
    "raw-fit admission must not discard a smaller route that chatCore can compress"
  );
  assert.ok("orderedTargets" in result, "the available compressible route must remain usable");
  if ("orderedTargets" in result) {
    assert.equal(result.orderedTargets[0].modelStr, "codex/gpt-5.5");
  }
});

test("compression-aware selection does not pin a larger known-window candidate with a provider status penalty", async () => {
  saveModelsDevCapabilities({
    anthropic: {
      "rate-limited-large": capabilityEntry(450_000, { tool_call: true }),
    },
  });

  const codexTarget = target("codex", "codex/gpt-5.5");
  const rateLimitedTarget = target("anthropic", "anthropic/rate-limited-large");
  const unknownTarget = target("nvidia", "nvidia/deepseek-ai/deepseek-v4-pro-0813");
  const hugePrompt = "x".repeat(2_000_000);

  const result = await resolveAutoStrategyOrder({
    orderedTargets: [rateLimitedTarget, codexTarget, unknownTarget] as never,
    body: { messages: [{ role: "user", content: hugePrompt }] },
    combo: {
      id: "compression-aware-provider-health",
      name: "ordinary-compression",
      strategy: "auto",
      models: [],
      same_terminal_continuity: true,
      config: { explorationRate: 0 },
    } as never,
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: log as never,
    expandAutoCandidatePool: (async () => [rateLimitedTarget, codexTarget, unknownTarget]) as never,
    buildAutoCandidates: (async (targets: ReturnType<typeof target>[]) =>
      targets.map((entry) => ({
        ...candidateFor(entry),
        statusPenalty: entry.provider === "anthropic",
        statusPenaltyReason: entry.provider === "anthropic" ? "rate_limited" : undefined,
      }))) as never,
  });

  assert.ok("orderedTargets" in result);
  if ("orderedTargets" in result) {
    assert.equal(
      result.orderedTargets[0].modelStr,
      "codex/gpt-5.5",
      "rate-limited providers must not win merely because their recorded window is larger"
    );
  }
});

test("compression-aware selection skips a larger known-window candidate unavailable at dispatch", async () => {
  saveModelsDevCapabilities({
    anthropic: {
      "cooling-down-large": capabilityEntry(450_000, { tool_call: true }),
    },
  });

  const codexTarget = target("codex", "codex/gpt-5.5");
  const coolingDownTarget = target("anthropic", "anthropic/cooling-down-large");
  const unknownTarget = target("nvidia", "nvidia/deepseek-ai/deepseek-v4-pro-0813");
  const hugePrompt = "x".repeat(2_000_000);

  const result = await resolveAutoStrategyOrder({
    orderedTargets: [coolingDownTarget, codexTarget, unknownTarget] as never,
    body: { messages: [{ role: "user", content: hugePrompt }] },
    combo: {
      id: "compression-aware-live-health",
      name: "ordinary-compression",
      strategy: "auto",
      models: [],
      same_terminal_continuity: true,
      config: { explorationRate: 0 },
    } as never,
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: log as never,
    expandAutoCandidatePool: (async () => [coolingDownTarget, codexTarget, unknownTarget]) as never,
    buildAutoCandidates: (async (targets: ReturnType<typeof target>[]) =>
      targets.map(candidateFor)) as never,
    isModelAvailable: (async (_model: string, targetEntry: ReturnType<typeof target>) =>
      targetEntry.provider !== "anthropic") as never,
  });

  assert.ok("orderedTargets" in result);
  if ("orderedTargets" in result) {
    assert.equal(
      result.orderedTargets[0].modelStr,
      "codex/gpt-5.5",
      "a cooling-down larger provider must not displace a live compressible Codex route"
    );
  }
});
