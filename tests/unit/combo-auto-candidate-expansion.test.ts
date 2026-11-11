import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression coverage for the #3322 auto-combo candidate expansion: an auto-combo
// without an explicit candidatePool broadens its eligible targets to every model
// of every active provider connection (so the router has the full pool to score).

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-expand-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const combo = await import("../../open-sse/services/combo.ts");
const providerModels = await import("../../open-sse/config/providerModels.ts");

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => resetStorage());

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test("expandAutoComboCandidatePool adds every model of an active provider when no candidatePool is set", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
    defaultModel: "gpt-4o-mini",
  });

  const expanded = await combo.expandAutoComboCandidatePool([], { config: {} });

  // It should surface at least one openai/<model> target, all well-formed.
  assert.ok(expanded.length > 0, "expected the active provider's models to be expanded in");
  const openaiTargets = expanded.filter((t) => t.provider === "openai");
  assert.ok(openaiTargets.length > 0, "expected openai targets");
  for (const t of openaiTargets) {
    assert.equal(t.kind, "model");
    assert.equal(t.modelStr, `openai/${t.modelStr.split("/").slice(1).join("/")}`);
    assert.equal(t.connectionId, null);
  }
  // Every catalog model for openai should be represented.
  const catalogIds = providerModels.getProviderModels("openai").map((m) => `openai/${m.id}`);
  assert.ok(catalogIds.length > 0);
  for (const id of catalogIds) {
    assert.ok(
      expanded.some((t) => t.modelStr === id),
      `expected expanded targets to include ${id}`
    );
  }
});

test("expandAutoComboCandidatePool is a no-op when an explicit candidatePool exists", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
    defaultModel: "gpt-4o-mini",
  });

  const seed = [
    {
      kind: "model" as const,
      stepId: "openai/gpt-4o",
      executionKey: "openai/gpt-4o",
      modelStr: "openai/gpt-4o",
      provider: "openai",
      providerId: "openai",
      connectionId: null,
      weight: 1,
      label: null,
    },
  ];
  const result = await combo.expandAutoComboCandidatePool(seed, {
    config: { auto: { candidatePool: ["openai"] } },
  });
  assert.equal(result.length, 1, "candidatePool present → no expansion");
  assert.equal(result[0].modelStr, "openai/gpt-4o");
});

test("expandAutoComboCandidatePool falls through to active connections when candidatePool is an empty array", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
    defaultModel: "gpt-4o-mini",
  });

  const expanded = await combo.expandAutoComboCandidatePool([], {
    config: { auto: { candidatePool: [] } },
  });

  // An empty candidatePool should NOT trigger early return — the function
  // should fall through and expand from active connections instead.
  assert.ok(
    expanded.length > 0,
    "expected expansion from active connections despite empty candidatePool"
  );
  const openaiTargets = expanded.filter((t) => t.provider === "openai");
  assert.ok(openaiTargets.length > 0, "expected openai targets to be expanded");
});

test("model-free auto expansion admits only explicitly allowed providers", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
    defaultModel: "gpt-4o-mini",
  });
  await providersDb.createProviderConnection({
    provider: "nvidia",
    authType: "apikey",
    name: "NVIDIA",
    apiKey: "nvapi-test",
    defaultModel: "meta/llama-3.1-8b-instruct",
  });

  const expanded = await combo.expandAutoComboCandidatePool([], {
    strategy: "auto",
    models: [],
    allowedProviders: ["openai"],
    config: {},
  });

  assert.ok(expanded.length > 0, "the allowed provider should contribute catalog models");
  assert.ok(expanded.every((entry) => entry.provider === "openai"));
  assert.ok(!expanded.some((entry) => entry.provider === "nvidia"));
});

test("model-free auto expansion uses only synced visible models when provider records exist", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
  });
  const connectionId = (connection as { id?: string }).id;
  assert.ok(connectionId);

  await modelsDb.replaceSyncedAvailableModelsForConnection("openai", connectionId, [
    { id: "gpt-4o-mini", name: "visible", source: "imported" as const },
    { id: "gpt-4o", name: "hidden", source: "imported" as const },
  ]);
  modelsDb.mergeModelCompatOverride("openai", "gpt-4o", { isHidden: true });

  const expanded = await combo.expandAutoComboCandidatePool([], {
    strategy: "auto",
    models: [],
    allowedProviders: ["openai"],
    config: {},
  });

  assert.deepEqual(
    expanded.map((entry) => entry.modelStr),
    ["openai/gpt-4o-mini"],
    "synced but hidden and unsynced static models must not enter the runtime pool"
  );
});

test("model-free auto expansion fails closed when every recorded model is hidden", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
  });
  const connectionId = (connection as { id?: string }).id;
  assert.ok(connectionId);

  await modelsDb.replaceSyncedAvailableModelsForConnection("openai", connectionId, [
    { id: "gpt-4o-mini", name: "hidden", source: "imported" as const },
  ]);
  modelsDb.mergeModelCompatOverride("openai", "gpt-4o-mini", { isHidden: true });

  const expanded = await combo.expandAutoComboCandidatePool([], {
    strategy: "auto",
    models: [],
    allowedProviders: ["openai"],
    config: {},
  });

  assert.deepEqual(expanded, [], "all-hidden records must not trigger static-catalog fallback");
});

test("static-catalog fallback still excludes models explicitly hidden by the operator", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
  });
  const hiddenId = providerModels.getProviderModels("openai")[0]?.id;
  assert.ok(hiddenId);
  modelsDb.mergeModelCompatOverride("openai", hiddenId, { isHidden: true });

  const expanded = await combo.expandAutoComboCandidatePool([], {
    strategy: "auto",
    models: [],
    allowedProviders: ["openai"],
    config: {},
  });

  assert.ok(expanded.length > 0, "a provider with no model records may use static fallback");
  assert.ok(
    !expanded.some((entry) => entry.modelStr === `openai/${hiddenId}`),
    "an explicit hidden flag must constrain static fallback too"
  );
});

test("model-free auto expansion honors a nested provider invariant", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
    defaultModel: "gpt-4o-mini",
  });

  const expanded = await combo.expandAutoComboCandidatePool([], {
    strategy: "auto",
    models: [],
    invariant: { allowedProviders: ["openai"] },
    config: {},
  });

  assert.ok(expanded.length > 0);
  assert.ok(expanded.every((entry) => entry.provider === "openai"));
});

test("unbounded model-free auto expansion fails closed", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
    defaultModel: "gpt-4o-mini",
  });

  const expanded = await combo.expandAutoComboCandidatePool([], {
    strategy: "auto",
    models: [],
    config: {},
  });

  assert.deepEqual(expanded, []);
});

test('expandAutoComboCandidatePool is a no-op when the combo references other combos via kind:"combo-ref" entries', async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
    defaultModel: "gpt-4o-mini",
  });

  const seed = [
    {
      kind: "model" as const,
      stepId: "anthropic/claude-3-5-sonnet",
      executionKey: "anthropic/claude-3-5-sonnet",
      modelStr: "anthropic/claude-3-5-sonnet",
      provider: "anthropic",
      providerId: "anthropic",
      connectionId: null,
      weight: 1,
      label: null,
    },
  ];

  // An "auto" combo delegating to a "priority" sub-combo via a combo-ref entry:
  // expanding to every model of every active provider (openai included) would
  // defeat the point of the combo-ref constraint, so the resolved
  // eligibleTargets must be returned unchanged (#COMBO-REF).
  const result = await combo.expandAutoComboCandidatePool(seed, {
    config: {},
    models: [{ kind: "combo-ref", ref: "priority-subcombo" }],
  });

  assert.equal(result.length, 1, "combo-ref guard must prevent provider-wide expansion");
  assert.equal(result[0].modelStr, "anthropic/claude-3-5-sonnet");
  assert.ok(
    !result.some((t) => t.provider === "openai"),
    "no openai targets should have been pulled in despite an active openai connection"
  );
});

test("expandAutoComboCandidatePool is a no-op when the operator has populated models[] (no candidatePool)", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
    defaultModel: "gpt-4o-mini",
  });

  const result = await combo.expandAutoComboCandidatePool([], {
    config: {},
    models: ["openai/gpt-4o-mini"],
  });

  // When the operator has populated models[] with explicit entries
  // (whether plain strings or records), the function must return the
  // seed unchanged rather than expanding to every model of every
  // active provider (which would silently inject unapproved models).
  assert.equal(result.length, 0, "populated models[] must short-circuit provider-wide expansion");
});

test("expandAutoComboCandidatePool does not duplicate an already-present modelStr", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-test-openai",
    defaultModel: "gpt-4o-mini",
  });

  const firstCatalogId = providerModels.getProviderModels("openai")[0]?.id;
  assert.ok(firstCatalogId, "expected at least one openai catalog model");
  const existing = `openai/${firstCatalogId}`;
  const seed = [
    {
      kind: "model" as const,
      stepId: existing,
      executionKey: existing,
      modelStr: existing,
      provider: "openai",
      providerId: "openai",
      connectionId: "conn-1",
      weight: 5,
      label: "pinned",
    },
  ];

  const result = await combo.expandAutoComboCandidatePool(seed, { config: {} });
  const matches = result.filter((t) => t.modelStr === existing);
  assert.equal(matches.length, 1, "the pre-existing target must not be duplicated");
  // …and the original pinned entry (weight 5 / conn-1) is preserved, not overwritten.
  assert.equal(matches[0].connectionId, "conn-1");
  assert.equal(matches[0].weight, 5);
});
