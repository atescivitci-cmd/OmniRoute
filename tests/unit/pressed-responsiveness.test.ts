import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// Set paths before loading modules with DB/legacy-migration side effects.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pressed-response-fixture-"));
process.env.DATA_DIR = dir;
process.env.HOME = dir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("network forbidden in ranking fixture");
};

const { buildAutoCandidates, handleComboChat } = await import("../../open-sse/services/combo.ts");
const { resolveAutoStrategyOrder } =
  await import("../../open-sse/services/combo/resolveAutoStrategy.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { saveCallLog } = await import("../../src/lib/usage/callLogs.ts");
const { installZeroCostEvidenceResolver } =
  await import("../../open-sse/services/autoCombo/zeroCostAdmission.ts");
const db = getDbInstance();
const comboName = "ac-pressed-zero-token-cost";
const provider = "nvidia";
const connection = "fixture-account";
const slow = "moonshotai/kimi-k2.6";
const alternatives = ["catalog/option-a", "catalog/option-b"];
const models = [slow, ...alternatives];
const body = {
  model: comboName,
  stream: false,
  messages: [{ role: "user", content: "Summarize today's order." }],
};
const targets = models.map((model, i) => ({
  kind: "model" as const,
  provider,
  providerId: provider,
  modelStr: provider + "/" + model,
  stepId: "step" + i,
  executionKey: "step" + i,
  connectionId: null,
  allowedConnectionIds: [connection],
  weight: 1,
  label: null,
}));
const denied = new Set<string>();
installZeroCostEvidenceResolver((request) =>
  denied.has(request.model)
    ? null
    : {
        ...request,
        request,
        noAdditionalCost: true,
        evidenceId: "fixture-only",
      }
);
db.prepare(
  "INSERT INTO provider_connections (id,provider,auth_type,is_active,provider_specific_data,created_at,updated_at) VALUES(?,?,?,1,'{}',?,?)"
).run(connection, provider, "apikey", "created", "rev1");
beforeEach(() => {
  db.prepare("DELETE FROM call_logs").run();
  denied.clear();
});
after(() => {
  resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(networkAttempts, 0);
});

async function resolve(
  name = comboName,
  request: Record<string, unknown> = body,
  id: string = randomUUID(),
  pool = targets
) {
  const result = await resolveAutoStrategyOrder({
    orderedTargets: pool,
    body: request,
    combo: {
      name,
      strategy: "auto",
      models: pool.map((t) => t.modelStr),
      config: {
        selectionPolicy: "fit-first-free",
        zeroAdditionalCostProviders: [provider],
        localFallbackPolicy: "last",
      },
    },
    config: {},
    settings: null,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    buildAutoCandidates,
    isModelAvailable: async () => true,
    relayOptions: { routingRequestId: id },
  });
  assert.ok("orderedTargets" in result);
  const order = result.orderedTargets.map((t) => {
    assert.equal(t.connectionId, connection);
    assert.deepEqual(t.allowedConnectionIds, [connection]);
    return t.modelStr.slice(provider.length + 1);
  });
  const decision = db
    .prepare("SELECT factors_json FROM routing_decisions WHERE request_id=?")
    .get(id) as { factors_json: string };
  return { order, factors: JSON.parse(decision.factors_json) };
}

const endTurn = {
  type: "message",
  role: "assistant",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "Confirmed." }],
};
async function observe(
  model: string,
  status: number,
  duration: number,
  daysAgo: number,
  overrides = {}
) {
  await saveCallLog({
    id: randomUUID(),
    correlationId: randomUUID(),
    timestamp: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    comboName,
    provider,
    model,
    connectionId: connection,
    method: "POST",
    path: "/v1/messages",
    status,
    duration,
    cacheSource: "upstream",
    tokens: { completion_tokens: 12 },
    requestBody: body,
    responseBody: status === 200 ? endTurn : null,
    pipelinePayloads: status === 200 ? { clientResponse: endTurn } : null,
    ...overrides,
  });
}

test("distinct Pressed selection uses recent exact-pair outcomes despite neutral native latency", async () => {
  const baseline = await resolve();
  assert.equal(baseline.order[0], slow);
  assert.equal(baseline.factors.winner.latencyEvidence, "neutral_prior");
  assert.equal(baseline.factors.winner.reliabilitySampleCount, 0);
  // Verify a sparse completion matters: use the *last* otherwise tied model.
  const fast = baseline.order[2];
  for (const daysAgo of [3, 3, 3, 3, 3, 3, 2, 2, 2, 0]) await observe(slow, 504, 302000, daysAgo);
  await observe(fast, 200, 4200, 1);
  const next = await resolve();
  console.log("fixture order", { baseline: baseline.order, observed: next.order, fast });
  assert.deepEqual(next.order, [fast, baseline.order[1], slow]);
  assert.equal(next.factors.winner.latencyEvidence, "neutral_prior");
  assert.equal(next.factors.winner.reliabilitySampleCount, 0);
  assert.equal(next.factors.winner.responsiveness.timelyResponses, 1);
  assert.deepEqual(
    next.factors.alternatives.find((a: { model: string }) => a.model === slow).responsiveness
      .deadlineMisses,
    4
  );
  assert.deepEqual((await resolve("another-free-combo")).order, baseline.order);
  assert.deepEqual((await resolve(comboName, { ...body, stream: true })).order, baseline.order);
  denied.add(fast);
  assert.ok(!(await resolve()).order.includes(fast));
});

test("unknown outcomes, unrelated pairs and out-of-window rows confer no rank", async () => {
  const baseline = await resolve();
  const fast = baseline.order[2];
  for (const override of [
    { connectionId: "another-account" },
    { connectionId: null },
    { provider: "another-provider" },
    { model: slow + "-suffix" },
    { comboName: "another-free-combo" },
    { path: "/v1/embeddings" },
    { status: 502 },
    { duration: 4200 },
    { timestamp: new Date(Date.now() + 86400000).toISOString() },
  ]) {
    for (let i = 0; i < 2; i++) await observe(slow, 504, 302000, 2, override);
  }
  for (let i = 0; i < 2; i++) await observe(slow, 504, 302000, 8);
  for (const clientResponse of [
    null,
    {},
    { ...endTurn, content: [] },
    { ...endTurn, stop_reason: null },
    { ...endTurn, stop_reason: "max_tokens" },
    { ...endTurn, stop_reason: "tool_use" },
    { ...endTurn, content: [{ type: "text", text: "   " }] },
    { ...endTurn, content: [{ type: "thinking", thinking: "private" }] },
  ]) {
    // Raw provider envelope and output-token counter both look positive.
    await observe(fast, 200, 4000, 1, { pipelinePayloads: { clientResponse } });
    assert.deepEqual((await resolve()).order, baseline.order);
  }
  assert.equal((await resolve()).factors.winner.responsiveness, undefined);
});

test("only distinct recent outcomes count; a timely completion can restore the original winner", async () => {
  const baseline = await resolve();
  const id = randomUUID();
  for (let i = 0; i < 3; i++) await observe(slow, 504, 302000, 2, { correlationId: id });
  assert.equal((await resolve(comboName, body, id)).factors.winner.responsiveness, undefined);
  assert.equal((await resolve()).factors.winner.responsiveness.deadlineMisses, 1);
  await observe(slow, 504, 302000, 1);
  assert.equal((await resolve()).order.at(-1), slow);
  await observe(slow, 200, 4200, 0);
  assert.deepEqual((await resolve()).order, baseline.order);
});

test("legacy IDs aggregate conservatively, and missing, oversized or corrupt artifacts stay neutral", async () => {
  const baseline = await resolve();
  for (let i = 0; i < 3; i++) await observe(slow, 504, 302000, 2, { correlationId: null });
  assert.equal((await resolve()).factors.winner.responsiveness.deadlineMisses, 1);
  const fast = baseline.order[2];
  for (const override of [
    { noLog: true },
    { cacheSource: "semantic" },
    { error: "failed" },
    { duration: 0 },
    { connectionId: "another-account" },
  ]) {
    await observe(fast, 200, 4200, 1, override);
  }
  for (const [column, value] of [
    ["artifact_sha256", "bad"],
    ["artifact_relpath", "../wrong.json"],
    ["artifact_size_bytes", 129 * 1024],
    ["detail_state", "missing"],
  ] as const) {
    const id = randomUUID();
    await observe(fast, 200, 4200, 1, { id });
    db.prepare(`UPDATE call_logs SET ${column} = ? WHERE id = ?`).run(value, id);
  }
  assert.deepEqual((await resolve()).order, baseline.order);
  await observe(fast, 200, 4200, 0);
  assert.deepEqual((await resolve()).order, [fast, slow, baseline.order[1]]);
});

test("model-free target pipeline selects a different catalog model for the next distinct call and stops on ambiguous dispatch", async () => {
  const glm = "z-ai/glm-5.2",
    mini = "minimaxai/minimax-m2.7",
    unknown = "meta/llama-3.2-11b-vision-instruct";
  const request = {
    ...body,
    max_tokens: 100,
    messages: [{ role: "user", content: "Analyze this order." }],
  };
  db.prepare("INSERT INTO key_value(namespace,key,value) VALUES ('syncedAvailableModels',?,?)").run(
    provider + ":" + connection,
    JSON.stringify([glm, mini, unknown].map((id) => ({ id })))
  );
  const combo = {
    name: comboName,
    strategy: "auto",
    models: [],
    allowedProviders: [provider],
    invariant: { allowedProviders: [provider] },
    config: {
      selectionPolicy: "fit-first-free",
      zeroAdditionalCostProviders: [provider],
      localFallbackPolicy: "last",
      disableSessionStickiness: true,
      maxRetries: 1,
      maxSetRetries: 1,
    },
  };
  async function dispatch(uncertain: boolean) {
    const calls: string[] = [];
    const result = await handleComboChat({
      body: structuredClone(request),
      combo,
      correlationId: randomUUID(),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      settings: {},
      isModelAvailable: async () => true,
      handleSingleModel: async (_request, model, target) => {
        assert.ok(target && "connectionId" in target);
        assert.equal(target.connectionId, connection);
        calls.push(model);
        return uncertain
          ? Response.json({ error: { message: "Gateway timeout" } }, { status: 504 })
          : Response.json({
              choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            });
      },
    });
    const resultBody = await result.json();
    assert.equal(result.status, uncertain ? 504 : 200, JSON.stringify(resultBody));
    return calls;
  }
  assert.deepEqual(await dispatch(false), [provider + "/" + glm]);
  for (const days of [3, 2, 0]) await observe(glm, 504, 302000, days);
  for (const days of [2, 1])
    await observe(mini, 200, 4200, days, { pipelinePayloads: null, responseBody: providerBody });
  const attempts = await dispatch(true);
  console.log("model-free selection after prior timeouts; ambiguous 504 dispatches:", attempts);
  assert.deepEqual(attempts, [provider + "/" + mini]);
});

test("repeated misses preserve quota boundaries and the local-last tier", async () => {
  const { rankFitFirstFreeCandidates } =
    await import("../../open-sse/services/autoCombo/fitFirstPolicy.ts");
  const { applyPressedResponsiveness } =
    await import("../../open-sse/services/autoCombo/pressedResponsiveness.ts");
  const candidates = await buildAutoCandidates(targets, comboName);
  const local = { ...candidates[0], provider: "ollama-local", modelStr: "ollama-local/" + slow };
  candidates.find((c) => c.model === alternatives[1])!.quotaRemaining = 50;
  candidates.push(local);
  for (const days of [3, 2, 0]) await observe(slow, 504, 302000, days);
  const { ranked } = rankFitFirstFreeCandidates({
    candidates,
    body,
    zeroAdditionalCostProviders: [provider, local.provider],
    localFallbackPolicy: "last",
  });
  const quotas = ranked.map((e) => e.candidate.quotaRemaining);
  await applyPressedResponsiveness(ranked, comboName, "last");
  assert.deepEqual(
    ranked.map((e) => e.candidate.quotaRemaining),
    quotas
  );
  assert.equal(ranked.at(-1)?.candidate.provider, local.provider);
  assert.ok(
    ranked.find((e) => e.candidate.model === slow && e.candidate.provider === provider)?.factors
      .responsiveness
  );
});

test("older evidence outside the 256-row slice cannot influence the winner", async () => {
  const baseline = await resolve();
  for (const days of [3, 2]) await observe(slow, 504, 302000, days);
  assert.equal((await resolve()).order.at(-1), slow);
  const insert = db.prepare(
    "INSERT INTO call_logs(id,timestamp,combo_name,status) VALUES (?,?,?,400)"
  );
  const now = new Date().toISOString();
  for (let i = 0; i < 256; i++) insert.run(randomUUID(), now, comboName);
  assert.deepEqual((await resolve()).order, baseline.order);
});

test("missing history index disables the signal without a table scan", async () => {
  const baseline = await resolve();
  for (const days of [3, 2]) await observe(slow, 504, 302000, days);
  db.exec("DROP INDEX idx_call_logs_combo_name_timestamp");
  try {
    assert.deepEqual((await resolve()).order, baseline.order);
  } finally {
    db.exec("CREATE INDEX idx_call_logs_combo_name_timestamp ON call_logs(combo_name,timestamp)");
  }
});

const providerBody = {
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Order confirmed." } }],
};
test("retained /v1/messages provider-only shape beats a slightly fitter unknown within the app deadline", async () => {
  const glm = "z-ai/glm-5.2",
    unknown = "meta/llama-3.2-11b-vision-instruct",
    mini = "minimaxai/minimax-m2.7";
  const pool = [glm, unknown, mini].map((m, i) => ({
    ...targets[i],
    modelStr: provider + "/" + m,
  }));
  const request = {
    ...body,
    max_tokens: 100,
    messages: [{ role: "user", content: "Analyze this order." }],
  };
  const select = () => resolve(comboName, request, randomUUID(), pool);
  const base = await select();
  console.log(
    "retained fixture native scores",
    base.order,
    base.factors.winner.score,
    base.factors.alternatives.map((a: { score: number }) => a.score)
  );
  assert.deepEqual(base.order, [glm, unknown, mini]);
  const observed = { pipelinePayloads: null, responseBody: providerBody };
  for (const days of [3, 3, 3, 3, 3, 3, 2, 2, 2, 0.5])
    await observe(glm, 504, 302000, days, { pipelinePayloads: null });
  await observe(glm, 200, 300218, 0, observed);
  assert.equal(
    (await select()).order[0],
    unknown,
    "demotion alone leaves the unobserved runner-up first"
  );
  for (const ms of [3100, 5300, 12700, 17500, 18000, 28000, 59000])
    await observe(mini, 200, ms, ms / 100000, observed);
  const shape = db
    .prepare("SELECT count(*) n FROM call_logs WHERE has_pipeline_details != 0")
    .get() as { n: number };
  assert.equal(shape.n, 0);
  const next = await select();
  console.log(
    "retained fixture winner and operational evidence",
    next.order,
    next.factors.winner.responsiveness
  );
  assert.deepEqual(next.order, [mini, unknown, glm]);
  assert.equal(next.factors.winner.latencyEvidence, "neutral_prior");
  assert.equal(next.factors.winner.answerQuality, null);
  assert.equal(next.factors.winner.responsiveness.timelyResponses, 4);
  assert.equal(
    next.factors.alternatives.find((a: { model: string }) => a.model === glm).responsiveness
      .deadlineMisses,
    4
  );
});

function normalized(content: unknown, message = {}, choice = {}) {
  return {
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content, ...message }, ...choice },
    ],
  };
}

test("provider-only partial, tool, reasoning and contradictory envelopes never earn a timely response", async () => {
  for (const responseBody of [
    {},
    normalized(""),
    normalized(" \u200b"),
    normalized(null, { reasoning_content: "thinking" }),
    normalized("<think>reasoning</think>"),
    normalized("<reasoning>unfinished"),
    normalized("thinking", { reasoning_content: "thinking" }),
    normalized("[MaxDepth]"),
    normalized("part [...truncated 300 chars...] tail"),
    normalized("partial", {}, { finish_reason: "length" }),
    normalized("partial", {}, { finish_reason: null }),
    normalized("partial", {}, { delta: { content: "more" } }),
    normalized("tool", { tool_calls: [{}] }),
    normalized("tool", { function_call: { name: "f" } }),
    normalized("tool", {}, { finish_reason: "tool_calls" }),
    normalized("<tool_call>...</tool_call>"),
    normalized("text", { role: "user" }),
    normalized("text", { _omniroute_truncated_keys: 2 }),
    { ...providerBody, _truncated: true },
    { ...providerBody, error: { message: "failed" } },
    { ...providerBody, model: "another/model" },
    { ...providerBody, object: "chat.completion.chunk" },
    { ...providerBody, choices: [...providerBody.choices, ...providerBody.choices] },
  ]) {
    db.prepare("DELETE FROM call_logs").run();
    await observe(slow, 200, 4100, 1, { pipelinePayloads: null, responseBody });
    assert.equal(
      (await resolve()).factors.winner.responsiveness,
      undefined,
      JSON.stringify(responseBody)
    );
  }
});

test("provider-only proof is scoped, uses a strict 18s budget, and cannot undo admission or native task fit", async () => {
  const base = await resolve(),
    model = base.order[2];
  const evidence = async () => {
    const { factors } = await resolve();
    return factors.alternatives.find((a: { model: string }) => a.model === model)?.responsiveness;
  };
  const raw = { pipelinePayloads: null, responseBody: providerBody };
  for (const mismatch of [
    { provider: "different-provider" },
    { model: model + "-other" },
    { connectionId: "another-account" },
    { comboName: "different-free-combo" },
    { connectionId: null },
    { cacheSource: "semantic" },
    { path: "/v1/responses" },
    { timestamp: new Date(Date.now() - 8 * 86400000).toISOString() },
  ]) {
    await observe(model, 200, 3500, 1, { ...raw, ...mismatch });
  }
  assert.equal(await evidence(), undefined);
  for (const ms of [17999, 18000, 59000, 300218]) {
    db.prepare("DELETE FROM call_logs").run();
    await observe(model, 200, ms, 1, raw);
    const e = await evidence();
    assert.equal(e.timelyResponses, Number(ms < 18000));
    assert.equal(e.deadlineMisses, Number(ms >= 18000));
    assert.equal(e.source, "call_logs_provider_responsiveness");
    assert.ok(ms < 18000 === e.adjustment > 0);
  }
  db.prepare("DELETE FROM call_logs").run();
  await observe(model, 200, 17999, 1, raw);
  const next = await resolve();
  assert.equal(next.order[0], slow, "sparse evidence must preserve the materially stronger fit");
  assert.equal(next.order[1], model);
  denied.add(model);
  assert.ok(!(await resolve()).order.includes(model));
});

test("hostile stored artifacts cannot lend another pair its response", async () => {
  const { CALL_LOGS_DIR, writeCallArtifact } =
    await import("../../src/lib/usage/callLogArtifacts.ts");
  assert.ok(CALL_LOGS_DIR && CALL_LOGS_DIR.startsWith(dir + path.sep));
  for (const damage of ["symlink", "oversize", "wrong-account", "wrong-combo", "partial-json"]) {
    db.prepare("DELETE FROM call_logs").run();
    const id = randomUUID();
    await observe(slow, 200, 3500, 1, { id, pipelinePayloads: null, responseBody: providerBody });
    const row = db.prepare("SELECT artifact_relpath FROM call_logs WHERE id=?").get(id) as {
      artifact_relpath: string;
    };
    const file = path.join(CALL_LOGS_DIR, row.artifact_relpath);
    if (damage === "symlink") {
      fs.renameSync(file, file + ".elsewhere");
      fs.symlinkSync(file + ".elsewhere", file);
    } else if (damage === "oversize") fs.appendFileSync(file, Buffer.alloc(129 * 1024));
    else if (damage === "partial-json") fs.writeFileSync(file, '{"choices":[');
    else {
      const borrowed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (damage === "wrong-account") borrowed.summary.connectionId = "foreign";
      else borrowed.summary.comboName = "foreign";
      const rewritten = writeCallArtifact(borrowed, row.artifact_relpath);
      assert.ok(rewritten);
      db.prepare("UPDATE call_logs SET artifact_sha256=?,artifact_size_bytes=? WHERE id=?").run(
        rewritten.sha256,
        rewritten.sizeBytes,
        id
      );
    }
    assert.equal((await resolve()).factors.winner.responsiveness, undefined, damage);
  }
});

test("slow optional storage yields to the native order", { timeout: 2000 }, async (t) => {
  const baseline = await resolve(),
    model = baseline.order[2];
  await observe(model, 200, 3500, 1, { pipelinePayloads: null, responseBody: providerBody });
  const original = fs.promises.realpath;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const mock = t.mock.method(
    fs.promises,
    "realpath",
    async (...args: Parameters<typeof original>) => {
      if (String(args[0]).startsWith(dir)) {
        started = true;
        await held;
      }
      return Reflect.apply(original, fs.promises, args);
    }
  );
  try {
    assert.deepEqual((await resolve()).order, baseline.order);
    assert.equal(started, true);
  } finally {
    mock.mock.restore();
    release();
  }
});

test("detail reads stop at eight even when the stored summary looks successful", async () => {
  const baseline = await resolve(),
    model = baseline.order[2];
  await observe(model, 200, 3500, 2, { pipelinePayloads: null, responseBody: providerBody });
  for (let i = 0; i < 8; i++)
    await observe(model, 200, 3500, 1, { pipelinePayloads: null, responseBody: normalized(" ") });
  assert.deepEqual((await resolve()).order, baseline.order);
  await observe(model, 200, 3500, 0, { pipelinePayloads: null, responseBody: providerBody });
  assert.deepEqual((await resolve()).order, [slow, model, baseline.order[1]]);
});
