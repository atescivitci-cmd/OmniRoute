import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveDeadlineRoutingPolicy,
  reorderByDeadlineEvidence,
  readDeadlineArtifactBatches,
} from "../../open-sse/services/autoCombo/deadlineAwareRouting.ts";
const body = {
  stream: false,
  max_tokens: 2000,
  reasoning_effort: "low",
  response_format: {
    type: "json_schema",
    json_schema: { name: "rates", schema: { type: "object" } },
  },
  messages: [{ role: "user", content: "Analyze travel source prices" }],
};
const config = { deadlineAwareRouting: true, comboTimeoutMs: 40000 };
const candidate = (model: string, quota = 100, provider = "nvidia") => ({
  candidate: { provider, model, connectionId: "c", quotaRemaining: quota },
  factors: { score: model === "slow" ? 0.9 : 0.7 },
});
const key = (model: string, provider = "nvidia") => JSON.stringify([provider, model, "c"]);
test("deadline selection is explicit valid per-combo opt-in only", () => {
  assert.equal(resolveDeadlineRoutingPolicy({}, body), null);
  assert.equal(
    resolveDeadlineRoutingPolicy({ ...config, deadlineAwareRouting: false }, body),
    null
  );
  assert.equal(resolveDeadlineRoutingPolicy({ ...config, comboTimeoutMs: 0 }, body), null);
  assert.equal(resolveDeadlineRoutingPolicy(config, body)?.deadlineMs, 40000);
});
test("streaming, tools and multimodal requests retain existing ordering", () => {
  for (const other of [
    { ...body, stream: true },
    { ...body, tools: [{ type: "function" }] },
    {
      ...body,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
        },
      ],
    },
  ])
    assert.equal(resolveDeadlineRoutingPolicy(config, other), null);
});
test("verified late-only candidate yields to existing eligible alternative without changing scores", () => {
  const rows = [candidate("slow"), candidate("other")],
    before = rows.map((x) => x.factors.score);
  reorderByDeadlineEvidence(
    rows,
    new Map([[key("slow"), { late: 1, timely: 0, censored: 1 }]]),
    "last"
  );
  assert.deepEqual(
    rows.map((x) => x.candidate.model),
    ["other", "slow"]
  );
  assert.equal(rows.find((x) => x.candidate.model === "slow")!.factors.score, before[0]);
});
test("unknown, timely and all-late evidence does not invent a better route", () => {
  for (const evidence of [
    new Map(),
    new Map([[key("slow"), { late: 1, timely: 1, censored: 1 }]]),
    new Map([
      [key("slow"), { late: 1, timely: 0, censored: 1 }],
      [key("other"), { late: 1, timely: 0, censored: 1 }],
    ]),
  ]) {
    const rows = [candidate("slow"), candidate("other")];
    reorderByDeadlineEvidence(rows, evidence, "last");
    assert.deepEqual(
      rows.map((x) => x.candidate.model),
      ["slow", "other"]
    );
  }
});
test("deadline observations never cross quota or local-last boundaries", () => {
  for (const rows of [
    [candidate("slow", 100), candidate("other", 90)],
    [candidate("slow"), candidate("other", 100, "ollama-local")],
  ]) {
    reorderByDeadlineEvidence(
      rows,
      new Map([[key("slow"), { late: 1, timely: 0, censored: 1 }]]),
      "last"
    );
    assert.equal(rows[0].candidate.model, "slow");
  }
});

import { qualifyDeadlineObservation } from "../../open-sse/services/autoCombo/deadlineAwareRouting.ts";
const policy = () => resolveDeadlineRoutingPolicy(config, body)!;
const row = {
  id: "offline",
  timestamp: new Date(60000).toISOString(),
  provider: "nvidia",
  model: "m",
  connection_id: "c",
  correlation_id: "r",
  method: "POST",
  path: "/v1/chat/completions",
  status: 499,
  duration: 40000,
  cache_source: "upstream",
  detail_state: "ready",
  has_response_body: 0,
  has_pipeline_details: 0,
  artifact_relpath: "offline.json",
  artifact_size_bytes: 1000,
  artifact_sha256: "offline",
};
function artifact(status = 499) {
  const d = { ...row, status };
  return {
    schemaVersion: 5,
    summary: {
      id: d.id,
      timestamp: d.timestamp,
      provider: d.provider,
      model: d.model,
      connectionId: d.connection_id,
      comboName: "offline-deadline",
      status: d.status,
      duration: d.duration,
      path: d.path,
      method: d.method,
    },
    requestBody: {
      _truncated: true,
      _omniroute: {
        nativeDispatch: {
          version: 1,
          observed: true,
          dispatchCount: 1,
          endpointIdentity: "https://example.com/v1/chat/completions",
          requestClass: policy().requestClass,
          nativeControls: { stream: false },
          declaredBudgetMs: 40000,
          dispatchedAt: 60800,
          deadlineAt: 100000,
          observedAt: 100000,
          elapsedMs: 39200,
          remainingAtDispatchMs: 39200,
          abortObservedAt: 100000,
        },
      },
    },
    responseBody:
      status === 200
        ? {
            model: "m",
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }],
          }
        : undefined,
    error: status === 499 ? "Request aborted" : undefined,
  };
}
const qualify = (a: any, r: any = row) =>
  qualifyDeadlineObservation(
    r,
    a,
    policy(),
    "https://example.com/v1/chat/completions",
    "offline-deadline",
    101000
  );
test("800ms setup and39.2s native at40s is right-censored evidence, not an outage", () => {
  assert.equal(qualify(artifact()), "censored");
  assert.equal(
    qualify({ ...artifact(504), error: "Combo deadline" }, { ...row, status: 504 }),
    "censored"
  );
});
test("early cancellation stays neutral despite later persistence or whole-call duration", () => {
  const a = artifact();
  const m = a.requestBody._omniroute.nativeDispatch;
  m.abortObservedAt = 99999;
  m.observedAt = 99999;
  m.elapsedMs = 39199;
  assert.equal(qualify(a), null);
  m.observedAt = 100100;
  m.elapsedMs = 39300;
  assert.equal(qualify(a), null);
});
test("legacy, wrong endpoint, class, connection and changed deadline stay neutral", () => {
  const base = artifact();
  for (const alter of [
    (a: any) => delete a.requestBody._omniroute,
    (a: any) =>
      (a.requestBody._omniroute.nativeDispatch.endpointIdentity =
        "https://other.example/v1/chat/completions"),
    (a: any) => (a.requestBody._omniroute.nativeDispatch.requestClass.maxTokens = 3000),
    (a: any) => (a.summary.connectionId = "other"),
    (a: any) => (a.requestBody._omniroute.nativeDispatch.declaredBudgetMs = 20000),
    (a: any) => (a.requestBody._omniroute.nativeDispatch.dispatchCount = 2),
  ]) {
    const a = structuredClone(base);
    alter(a);
    assert.equal(qualify(a), null);
  }
});
test("only complete visible timely200 is a positive operational observation", () => {
  const a = artifact(200);
  const m = a.requestBody._omniroute.nativeDispatch;
  m.observedAt = 90000;
  m.elapsedMs = 29200;
  delete (m as any).abortObservedAt;
  assert.equal(qualify(a, { ...row, status: 200 }), "timely");
  (a.responseBody!.choices[0] as any).finish_reason = "length";
  assert.equal(qualify(a, { ...row, status: 200 }), null);
});
test("deadline and opt-in settings round-trip through the supported combo API schema", async () => {
  const { updateComboSchema } = await import("../../src/shared/validation/schemas/combo.ts");
  assert.equal(updateComboSchema.safeParse({ config }).success, true);
  assert.equal(
    updateComboSchema.safeParse({ config: { ...config, deadlineAwareRouting: "true" } }).success,
    false
  );
  assert.equal(
    updateComboSchema.safeParse({ config: { ...config, comboTimeoutMs: -1 } }).success,
    false
  );
});

test("deadline reads cover quiet targets before the busiest target exhausts the budget", async () => {
  const { interleaveDeadlineRows } = await import("../../open-sse/services/autoCombo/deadlineAwareRouting.ts");
  const rows = [...Array.from({ length: 9 }, (_, i) => ({ pair: "busy", id: i })),
    { pair: "quiet", id: 9 }, { pair: "quiet", id: 10 }];
  assert.deepEqual(interleaveDeadlineRows(rows, (row) => row.pair).slice(0, 4).map((row) => row.id), [0, 9, 1, 10]);
});

test("repeat deadline misses can outweigh intermittent success with a proven peer", () => {
  const samples = new Map([[key("slow"), { late: 2, timely: 2, censored: 2 }]]);
  const rows = [candidate("slow"), candidate("other")];
  reorderByDeadlineEvidence(rows, samples, "last");
  assert.equal(rows[0].candidate.model, "slow");
  samples.set(key("other"), { late: 0, timely: 2, censored: 0 });
  reorderByDeadlineEvidence(rows, samples, "last");
  assert.equal(rows[0].candidate.model, "other");
});

test("two timely structured results promote an eligible peer ahead of an unobserved target", () => {
  const rows = [candidate("unknown"), candidate("timely"), candidate("late"), candidate("lower-quota", 90)];
  reorderByDeadlineEvidence(rows, new Map([
    [key("timely"), { late: 0, timely: 2, censored: 0 }],
    [key("late"), { late: 1, timely: 0, censored: 1 }],
    [key("lower-quota"), { late: 0, timely: 3, censored: 0 }],
  ]), "last");
  assert.deepEqual(rows.map(row => row.candidate.model), ["timely", "unknown", "late", "lower-quota"]);
});

test("a fresh near-deadline miss defers an intermittently timely target to a proven faster peer", () => {
  const rows = [candidate("mixed"), candidate("unobserved"), candidate("fast")];
  const samples = new Map([
    [key("mixed"), { late: 1, timely: 3, censored: 1, recentMissElapsedMs: 64681 }],
    [key("fast"), { late: 0, timely: 2, censored: 0, slowestTimelyMs: 6462 }],
  ]);
  reorderByDeadlineEvidence(rows, samples, "last");
  assert.deepEqual(rows.map(row => row.candidate.model), ["fast", "unobserved", "mixed"]);
});

test("a proven fast peer precedes near-deadline successes and a late fallback", () => {
  const rows = [candidate("unavailable"), candidate("late-fallback"), candidate("near-budget"), candidate("fast")];
  const samples = new Map([
    [key("late-fallback"), { late: 1, timely: 0, censored: 1, recentMissElapsedMs: 64000 }],
    [key("near-budget"), { late: 0, timely: 2, censored: 0, slowestTimelyMs: 57000 }],
    [key("fast"), { late: 0, timely: 2, censored: 0, slowestTimelyMs: 18000, recentFast: 2 }],
  ]);
  reorderByDeadlineEvidence(rows, samples, "last");
  assert.deepEqual(rows.map(row => row.candidate.model), ["fast", "near-budget", "unavailable", "late-fallback"]);
});

test("one recent clean fast result outranks repeated misses in the same tier", () => {
  const rows = [candidate("slow"), candidate("unknown"), candidate("fast"), candidate("lower-quota", 90)];
  const samples = new Map([
    [key("slow"), { late: 3, timely: 1, censored: 3, recentMissElapsedMs: 64694 }],
    [key("fast"), { late: 0, timely: 1, censored: 0, slowestTimelyMs: 16441, recentFast: 1 }],
  ]);
  reorderByDeadlineEvidence(rows, samples, "last");
  assert.deepEqual(rows.map(row => row.candidate.model), ["fast", "unknown", "slow", "lower-quota"]);
});

test("one fast result preserves order without a fresh repeated miss in the same tier", () => {
  for (const [miss, quota] of [[undefined, 100], [64694, 90]] as const) {
    const rows = [candidate("slow"), candidate("fast", quota)];
    const samples = new Map([
      [key("slow"), { late: 3, timely: 1, censored: 3, recentMissElapsedMs: miss }],
      [key("fast"), { late: 0, timely: 1, censored: 0, slowestTimelyMs: 16441, recentFast: 1 }],
    ]);
    reorderByDeadlineEvidence(rows, samples, "last");
    assert.deepEqual(rows.map(row => row.candidate.model), ["slow", "fast"]);
  }
});

test("deadline evidence reads one bounded batch concurrently and retains completed samples at cutoff", async () => {
  const resolvers: Array<(value: number | null) => void> = [];
  let withinBudget = true;
  const pending = readDeadlineArtifactBatches(
    Array.from({ length: 16 }, (_, index) => index),
    () => new Promise<number | null>(resolve => resolvers.push(resolve)),
    () => withinBudget
  );
  assert.equal(resolvers.length, 8);
  withinBudget = false;
  resolvers.reverse().forEach((resolve, index) => resolve(index === 2 ? null : 7 - index));
  const samples = await pending;
  assert.deepEqual(samples, [0, 1, 2, 3, 4, 6, 7].map(row => ({ row, artifact: row })));
  assert.equal(resolvers.length, 8);
});

test("two recent fast completions after a miss restore a route without excluding peers", () => {
  const rows = [candidate("unknown"), candidate("recovered"), candidate("lower-quota", 90)];
  const evidence = new Map([
    [key("recovered"), {
      timely: 2, late: 1, censored: 1, recentFast: 2, consecutiveRecentFast: 2,
    }],
  ]);
  reorderByDeadlineEvidence(rows, evidence, "last");
  assert.deepEqual(rows.map((row) => row.candidate.model), ["recovered", "unknown", "lower-quota"]);
  evidence.get(key("recovered"))!.consecutiveRecentFast = 1;
  reorderByDeadlineEvidence(rows.reverse(), evidence, "last");
  assert.deepEqual(rows.map((row) => row.candidate.model), ["lower-quota", "unknown", "recovered"]);
});

test("mixed request classes do not exhaust artifact coverage at the former 24-row limit", async () => {
  const rows = Array.from({ length: 64 }, (_, index) => index);
  const samples = await readDeadlineArtifactBatches(rows, async (row) => row, () => true);
  assert.equal(samples.length, rows.length);
  assert.ok(samples.some(({ row }) => row === 48));
});

test("a verified read completing after the I/O deadline is reusable by the next decision", async (t) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { setTimeout: pause } = await import("node:timers/promises");
  const { randomUUID } = await import("node:crypto");
  const { writeCallArtifact, CALL_LOGS_DIR } = await import("../../src/lib/usage/callLogArtifacts.ts");
  const { readDeadlineArtifact } = await import("../../open-sse/services/autoCombo/deadlineAwareRouting.ts");
  const id = "cache-" + randomUUID(), timestamp = new Date().toISOString();
  const artifact = {
    schemaVersion: 5,
    summary: { id, timestamp, method: "POST", path: "/v1/chat/completions", status: 200 },
    requestBody: {}, responseBody: { value: "verified fixture" }, error: null,
  } as Parameters<typeof writeCallArtifact>[0];
  const saved = writeCallArtifact(artifact)!;
  assert.ok(saved);
  const filename = path.join(CALL_LOGS_DIR!, saved.relPath);
  const row = {
    id, timestamp, artifact_relpath: saved.relPath,
    artifact_size_bytes: saved.sizeBytes, artifact_sha256: saved.sha256,
  } as Parameters<typeof readDeadlineArtifact>[0];
  const originalOpen = fs.promises.open.bind(fs.promises);
  let opens = 0;
  let finished: () => void;
  const closed = new Promise<void>((resolve) => { finished = resolve; });
  const mock = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === filename) {
      opens++;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); finished(); };
      await pause(80);
    }
    return handle;
  });
  t.after(() => { mock.mock.restore(); fs.rmSync(filename, { force: true }); });
  assert.equal(await readDeadlineArtifact(row, performance.now() + 10), null);
  await closed;
  await pause(0);
  fs.unlinkSync(filename);
  assert.deepEqual(await readDeadlineArtifact(row, performance.now() + 100), artifact);
  assert.equal(opens, 1);
  assert.equal(await readDeadlineArtifact({ ...row, artifact_sha256: "00000000" }, performance.now() + 100), null);
});
