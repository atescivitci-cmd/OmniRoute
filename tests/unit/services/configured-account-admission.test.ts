import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "configured-account-admission-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "synthetic-test-only";
const { runWithHostedTrialUsage, captureConfiguredAccountPolicy } =
  await import("../../../open-sse/services/autoCombo/hostedTrialUsage.ts");
const {
  hasCurrentCostAdmission,
  hasCurrentZeroCostAdmission,
  executeWithZeroCostAdmission,
  assertFinalCostDispatch,
  ZeroCostAdmissionError,
} = await import("../../../open-sse/services/autoCombo/zeroCostAdmission.ts");
const { getDbInstance } = await import("../../../src/lib/db/core.ts");
const { rankFitFirstFreeCandidates } =
  await import("../../../open-sse/services/autoCombo/fitFirstPolicy.ts");
const db = getDbInstance();
for (const provider of ["claude", "codex", "github", "nvidia"]) {
  db.prepare(
    "INSERT INTO provider_connections(id,provider,auth_type,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)"
  ).run("fixture-" + provider, provider, "oauth", "fixture", "fixture");
}
const combo = (providers = ["claude", "codex", "github", "nvidia"], configured = true) => ({
  name: "fixture",
  allowedProviders: providers,
  config: {
    selectionPolicy: "fit-first-free",
    localFallbackPolicy: "last",
    ...(configured ? { costAdmissionMode: "configured-accounts" } : {}),
  },
});
const request = (provider = "claude", extra = {}) => ({
  provider,
  model: "synthetic-model",
  connectionId: "fixture-" + provider,
  body: { messages: [{ role: "user", content: "synthetic only" }] },
  ...extra,
});
test("strict default denies cloud admission; explicit stored policy admits each active scoped account without claiming free", async () => {
  assert.equal(await hasCurrentCostAdmission(request()), false);
  await runWithHostedTrialUsage(combo(), async () => {
    for (const provider of ["claude", "codex", "github", "nvidia"])
      assert.equal(await hasCurrentCostAdmission(request(provider)), true);
    assert.equal(await hasCurrentZeroCostAdmission(request()), false);
    assert.equal(
      await hasCurrentCostAdmission(request("claude", { connectionId: "fixture-codex" })),
      false
    );
    assert.equal(
      await hasCurrentCostAdmission(request("claude", { connectionId: "unknown" })),
      false
    );
  });
});
test("caller body cannot enable configured policy, and nested scopes cannot widen or replace strict parents", async () => {
  assert.equal(
    await hasCurrentCostAdmission(
      request("claude", { body: { costAdmissionMode: "configured-accounts" } })
    ),
    false
  );
  await runWithHostedTrialUsage(combo(["claude"], false), () =>
    runWithHostedTrialUsage(combo(), async () =>
      assert.equal(await hasCurrentCostAdmission(request()), false)
    )
  );
  await runWithHostedTrialUsage(combo(["claude"]), () =>
    runWithHostedTrialUsage(combo(), async () => {
      assert.equal(await hasCurrentCostAdmission(request()), true);
      assert.equal(await hasCurrentCostAdmission(request("codex")), false);
    })
  );
  await runWithHostedTrialUsage(combo(), () =>
    runWithHostedTrialUsage(combo(["claude"], false), async () =>
      assert.equal(await hasCurrentCostAdmission(request()), false)
    )
  );
});
test("final dispatch rechecks active account, provider and selected account scope", async () => {
  await runWithHostedTrialUsage(combo(), async () => {
    const policy = captureConfiguredAccountPolicy();
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.providers));
    let sent = 0;
    await executeWithZeroCostAdmission(
      true,
      ["fixture-claude"],
      "claude",
      { model: "synthetic-model", body: {}, credentials: { connectionId: "fixture-claude" } },
      async () => {
        await assertFinalCostDispatch(request(), {});
        sent++;
        await assert.rejects(assertFinalCostDispatch(request("codex"), {}), ZeroCostAdmissionError);
        db.prepare("UPDATE provider_connections SET is_active=0 WHERE id=?").run("fixture-claude");
        await assert.rejects(assertFinalCostDispatch(request(), {}), ZeroCostAdmissionError);
      },
      policy
    );
    assert.equal(sent, 1);
    db.prepare("UPDATE provider_connections SET is_active=1 WHERE id=?").run("fixture-claude");
    await assert.rejects(
      executeWithZeroCostAdmission(
        true,
        [],
        "claude",
        { model: "synthetic-model", body: {}, credentials: { connectionId: "fixture-claude" } },
        async () => {
          throw Error("must not dispatch");
        }
      ),
      ZeroCostAdmissionError
    );
  });
});
test("configured cost mode leaves task scoring and quota admission intact", () => {
  const candidate = (provider: string) => ({
    provider,
    model: "synthetic",
    modelStr: provider + "/synthetic",
    connectionId: "fixture-" + provider,
    quotaRemaining: 100,
    quotaTotal: 100,
    statusPenalty: false,
    circuitBreakerState: "CLOSED",
    taskFitness: { general: 1 },
    p95LatencyMs: 100,
    costPer1MTokens: 0,
  });
  const decision = rankFitFirstFreeCandidates({
    candidates: [
      candidate("claude"),
      candidate("codex"),
      { ...candidate("github"), quotaRemaining: 0 },
    ],
    body: { messages: [{ role: "user", content: "hello" }] },
    zeroAdditionalCostProviders: ["claude", "codex", "github"],
    configuredAccounts: true,
  });
  assert.ok(decision.ranked.some((row) => row.candidate.provider === "claude"));
  assert.ok(decision.ranked.some((row) => row.candidate.provider === "codex"));
  assert.ok(
    decision.excluded.some((row) => row.provider === "github" && row.reason === "quota_unavailable")
  );
});

// Execute the actual production availability, retry and dispatch conditions.
// Mutating any gate back to the strict resolver must reject this configured account.
const ts = (await import("typescript")).default;
const vm = await import("node:vm");
const chatPath = new URL("../../../src/sse/handlers/chat.ts", import.meta.url);
const chatSource = ts.createSourceFile(
  chatPath.pathname,
  fs.readFileSync(chatPath, "utf8"),
  ts.ScriptTarget.Latest,
  true
);
const conditions: string[] = [];
function visit(node: import("typescript").Node) {
  if (
    ts.isIfStatement(node) &&
    node.expression.getText(chatSource).includes("hasCurrentCostAdmission(")
  )
    conditions.push(node.expression.getText(chatSource));
  ts.forEachChild(node, visit);
}
visit(chatSource);
const { selectedConnectionIsInScope } =
  await import("../../../open-sse/services/autoCombo/zeroCostAdmission.ts");
test("all four real production gates honor configured accounts and still reject revoked accounts", async () => {
  assert.equal(conditions.length, 4);
  await runWithHostedTrialUsage(combo(), async () => {
    const context = () => ({
      hasCurrentCostAdmission,
      hasCurrentZeroCostAdmission,
      selectedConnectionIsInScope,
      target: { connectionId: "fixture-claude" },
      allowedConnections: ["fixture-claude"],
      runtimeOptions: { requireZeroCostAdmission: true, forcedConnectionId: "fixture-claude" },
      provider: "claude",
      model: "synthetic-model",
      resolvedModel: "synthetic-model",
      effectiveModel: "synthetic-model",
      credentials: { connectionId: "fixture-claude" },
      refreshedCredentials: { connectionId: "fixture-claude" },
      body: {},
      requestBody: {},
    });
    const blocked = async (expression: string) => {
      const box = context();
      const js = ts.transpileModule("globalThis.result=(async()=>Boolean(" + expression + "))();", {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      vm.runInNewContext(js, box);
      return (box as typeof box & { result: Promise<boolean> }).result;
    };
    for (const expression of conditions) {
      assert.equal(await blocked(expression), false);
      assert.equal(
        await blocked(
          expression.replaceAll("hasCurrentCostAdmission(", "hasCurrentZeroCostAdmission(")
        ),
        true
      );
    }
    db.prepare("UPDATE provider_connections SET is_active=0 WHERE id=?").run("fixture-claude");
    for (const expression of conditions) assert.equal(await blocked(expression), true);
    db.prepare("UPDATE provider_connections SET is_active=1 WHERE id=?").run("fixture-claude");
  });
});
