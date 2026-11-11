import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-free-auto-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const sseModelService = await import("../../src/sse/services/model.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("Option B model-free auto combo resolves by exact name before provider inference", async () => {
  await combosDb.createCombo({
    name: "ac-terminal-continuity",
    strategy: "auto",
    models: [],
    allowedProviders: ["claude", "codex", "github", "nvidia", "ollama-local"],
    same_terminal_continuity: true,
  });

  const resolved = await sseModelService.getComboForModel("ac-terminal-continuity");

  assert.ok(resolved, "the model-free continuity combo must remain visible to dispatch");
  assert.equal(resolved.name, "ac-terminal-continuity");
  assert.equal(resolved.strategy, "auto");
  assert.deepEqual(resolved.models, []);
});

test("model-free auto combo accepts the nested provider invariant", async () => {
  await combosDb.createCombo({
    name: "dynamic-invariant",
    strategy: "auto",
    models: [],
    invariant: { allowedProviders: ["codex"] },
  });

  const resolved = await sseModelService.getComboForModel("dynamic-invariant");
  assert.ok(resolved);
  assert.equal(resolved.name, "dynamic-invariant");
});

test("empty static and unbounded auto combos remain unresolvable", async () => {
  await combosDb.createCombo({
    name: "empty-priority",
    strategy: "priority",
    models: [],
    allowedProviders: ["codex"],
  });
  await combosDb.createCombo({
    name: "unbounded-auto",
    strategy: "auto",
    models: [],
  });

  assert.equal(await sseModelService.getComboForModel("empty-priority"), null);
  assert.equal(await sseModelService.getComboForModel("unbounded-auto"), null);
});

test("traditional static combos remain resolvable", async () => {
  await combosDb.createCombo({
    name: "static-priority",
    strategy: "priority",
    models: [{ provider: "codex", model: "gpt-5.5" }],
  });

  const resolved = await sseModelService.getComboForModel("static-priority");
  assert.ok(resolved);
  assert.equal(resolved.name, "static-priority");
});
