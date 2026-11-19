import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "router-answer-quality-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "isolated-unit-test-only-secret-not-for-deployment";
const { resetDbInstance, getDbInstance } = await import("../../src/lib/db/core.ts");
const { createAnswerQualityReceipt, recordAnswerQuality, answerQualityEvidence } =
  await import("../../src/lib/db/answerQuality.ts");
const { validatedQualityAdjustment, qualityCandidateKey, QUALITY_TTL_MS } =
  await import("../../open-sse/services/autoCombo/validatedAnswerQuality.ts");
const { rankFitFirstFreeCandidates } =
  await import("../../open-sse/services/autoCombo/fitFirstPolicy.ts");
const { reorderByDeadlineEvidence } =
  await import("../../open-sse/services/autoCombo/deadlineAwareRouting.ts");
test.after(() => {
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});
const now = 1900000000000,
  receipt = {
    owner: "key-a",
    combo: "travel",
    contract: "intake-v1",
    provider: "provider-a",
    connectionId: "account-a",
    model: "model-a",
  };
test("only request-linked owner feedback is accepted; retries cannot duplicate or reverse a verdict", () => {
  const id = createAnswerQualityReceipt(receipt, now)!;
  assert.ok(id);
  assert.equal(recordAnswerQuality("key-b", id, false, "model_output_invalid", now + 1), "missing");
  assert.equal(
    recordAnswerQuality("key-a", "missing", false, "model_output_invalid", now + 1),
    "missing"
  );
  assert.equal(
    recordAnswerQuality("key-a", id, false, "model_output_invalid", now + 1),
    "recorded"
  );
  assert.equal(recordAnswerQuality("key-a", id, true, "accepted", now + 2), "duplicate");
  const evidence = answerQualityEvidence("key-a", "travel", "intake-v1", now + 3);
  assert.deepEqual(
    [...evidence.values()].map((x) => [x.accepted, x.rejected]),
    [[0, 1]]
  );
  for (const [owner, combo, contract] of [
    ["key-b", "travel", "intake-v1"],
    ["key-a", "other", "intake-v1"],
    ["key-a", "travel", "other"],
  ])
    assert.equal(answerQualityEvidence(owner, combo, contract, now + 3).size, 0);
});
test("stale or future response receipts cannot produce fresh quality evidence", () => {
  for (const at of [now - 600001, now + 1]) {
    const id = createAnswerQualityReceipt(receipt, at)!;
    assert.equal(recordAnswerQuality("key-a", id, false, "model_output_invalid", now), "missing");
  }
});
test("penalty decays, accepts later positive evidence and never turns unknowns into failure", () => {
  assert.equal(validatedQualityAdjustment(undefined, now).penalty, 0);
  const e = { accepted: 0, rejected: 1, latestAt: now };
  assert.equal(validatedQualityAdjustment(e, now).penalty, 0.225);
  assert.equal(validatedQualityAdjustment(e, now + QUALITY_TTL_MS).penalty, 0);
  assert.ok(validatedQualityAdjustment({ ...e, accepted: 8 }, now).penalty < 0.05);
});
const candidate = (provider: string, model: string, connectionId: string) => ({
  provider,
  model,
  connectionId,
  modelStr: provider + "/" + model,
  quotaRemaining: 100,
  quotaTotal: 100,
  circuitBreakerState: "CLOSED" as const,
  costPer1MTokens: 0,
  p95LatencyMs: 100,
  latencyStdDev: 0,
  errorRate: 0,
});
test("a validator failure lowers automatic rank without removing any model or hardcoding a provider", () => {
  const pool = [
    candidate("provider-a", "model-a", "account-a"),
    candidate("provider-b", "model-b", "account-b"),
  ];
  const args = {
    candidates: pool,
    body: { messages: [{ role: "user", content: "Analyze evidence and return only JSON" }] },
    zeroAdditionalCostProviders: pool.map((x) => x.provider),
    now,
  };
  const baseline = rankFitFirstFreeCandidates(args);
  const first = baseline.ranked[0].candidate;
  const evidence = new Map([
    [
      qualityCandidateKey(first.provider, first.connectionId!, first.model),
      { accepted: 0, rejected: 2, latestAt: now },
    ],
  ]);
  const changed = rankFitFirstFreeCandidates({ ...args, answerQualityEvidence: evidence });
  assert.equal(changed.ranked.length, 2);
  assert.equal(changed.excluded.length, baseline.excluded.length);
  assert.notEqual(changed.ranked[0].candidate, first);
  assert.equal(
    changed.ranked.find((x) => x.candidate === first)!.factors.answerQualitySource,
    "client_validated_contract"
  );
});
test("a fast but validation-failing reply cannot reclaim first position through deadline promotion", () => {
  const rows = [
    { candidate: candidate("provider-b", "model-b", "account-b"), factors: { score: 0.6 } },
    {
      candidate: candidate("provider-a", "model-a", "account-a"),
      factors: { score: 0.4, answerQualityPenalty: 0.225 },
    },
  ];
  reorderByDeadlineEvidence(
    rows,
    new Map([
      [
        JSON.stringify(["provider-a", "model-a", "account-a"]),
        { late: 0, timely: 5, censored: 0, recentFast: 5 },
      ],
    ]),
    null
  );
  assert.equal(rows[0].candidate.provider, "provider-b");
  assert.equal(rows.length, 2);
});

test("per-scope and per-candidate retention stays bounded", () => {
  for (let n = 0; n < 140; n++) {
    const r = { ...receipt, contract: "bounded", model: n < 20 ? "repeated" : "model-" + n };
    const id = createAnswerQualityReceipt(r, now + n)!;
    assert.equal(
      recordAnswerQuality(
        "key-a",
        id,
        n % 2 === 0,
        n % 2 === 0 ? "accepted" : "model_output_invalid",
        now + n
      ),
      "recorded"
    );
  }
  const e = answerQualityEvidence("key-a", "travel", "bounded", now + 141);
  const total = [...e.values()].reduce((n, x) => n + x.accepted + x.rejected, 0);
  assert.ok(total <= 128);
  assert.ok([...e.values()].every((x) => x.accepted + x.rejected <= 16));
});

test("authenticated feedback route rejects unknown, foreign, revoked and malformed reports", async () => {
  const { createApiKey, revokeApiKey } = await import("../../src/lib/db/apiKeys.ts");
  const { POST } = await import("../../src/app/api/v1/routing/feedback/route.ts");
  const a = await createApiKey("quality-test-a", "test"),
    b = await createApiKey("quality-test-b", "test");
  const id = createAnswerQualityReceipt({ ...receipt, owner: a.id }, Date.now())!;
  const send = (key: string | null, body: unknown) =>
    POST(
      new Request("http://127.0.0.1/v1/routing/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: "Bearer " + key } : {}),
        },
        body: JSON.stringify(body),
      })
    );
  const body = { receipt: id, accepted: false, reason: "model_output_invalid" };
  assert.equal((await send(null, body)).status, 401);
  assert.equal((await send("not-a-key", body)).status, 401);
  assert.equal((await send(b.key, body)).status, 404);
  assert.equal((await send(a.key, { ...body, provider: "forged" })).status, 400);
  assert.equal((await send(a.key, { ...body, accepted: true })).status, 400);
  assert.equal((await send(a.key, body)).status, 200);
  assert.equal(
    (await (await send(a.key, { receipt: id, accepted: true, reason: "accepted" })).json()).status,
    "duplicate"
  );
  await revokeApiKey(a.id);
  assert.equal((await send(a.key, body)).status, 401);
});

test("global receipt and event metadata caps are enforced", () => {
  const db = getDbInstance(),
    at = now + 120000;
  db.transaction(() => {
    const put = db.prepare("INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)");
    for (let n = 0; n < 10002; n++)
      put.run(
        "answerQualityReceiptV1",
        "cap-receipt-" + n,
        JSON.stringify({ ...receipt, at: at - 1 })
      );
    for (let n = 0; n < 20002; n++)
      put.run(
        "answerQualityEventV1",
        "cap-event-" + n,
        JSON.stringify({
          at: at - 1,
          accepted: false,
          reason: "model_output_invalid",
          candidate: "fixture",
        })
      );
  })();
  createAnswerQualityReceipt(receipt, at);
  for (const [ns, max] of [
    ["answerQualityReceiptV1", 10000],
    ["answerQualityEventV1", 20000],
  ])
    assert.ok(
      (db.prepare("SELECT count(*) n FROM key_value WHERE namespace=?").get(ns) as { n: number })
        .n <= max
    );
});

test("switching accounts cannot erase the same model's semantic failure", () => {
  assert.equal(
    qualityCandidateKey("provider-a", "first-account", "model-a"),
    qualityCandidateKey("provider-a", "second-account", "model-a")
  );
  assert.notEqual(
    qualityCandidateKey("provider-a", "first-account", "model-a"),
    qualityCandidateKey("provider-a", "first-account", "model-b")
  );
  const pool = [
    candidate("provider-a", "model-a", "account-one"),
    candidate("provider-a", "model-a", "account-two"),
    candidate("provider-b", "model-b", "account-b"),
  ];
  const evidence = new Map([
    [
      qualityCandidateKey("provider-a", "account-one", "model-a"),
      { accepted: 0, rejected: 2, latestAt: now },
    ],
  ]);
  const decision = rankFitFirstFreeCandidates({
    candidates: pool,
    body: { messages: [{ role: "user", content: "Analyze evidence and return only JSON" }] },
    zeroAdditionalCostProviders: ["provider-a", "provider-b"],
    answerQualityEvidence: evidence,
    now,
  });
  assert.equal(decision.ranked[0].candidate.provider, "provider-b");
  assert.equal(decision.ranked.length, 3);
  assert.equal(decision.ranked.filter((x) => x.factors.answerQualityPenalty! > 0).length, 2);
});

test("persisted account-scoped V1 events retain model influence after account aggregation", () => {
  const r = { ...receipt, contract: "legacy-v1" },
    id = createAnswerQualityReceipt(r, now)!;
  assert.equal(
    recordAnswerQuality("key-a", id, false, "model_output_invalid", now + 1),
    "recorded"
  );
  getDbInstance()
    .prepare(
      "UPDATE key_value SET value=json_set(value,'$.candidate',?) WHERE namespace=? AND key LIKE ?"
    )
    .run(JSON.stringify([r.provider, r.connectionId, r.model]), "answerQualityEventV1", "%:" + id);
  const second = createAnswerQualityReceipt({ ...r, connectionId: "account-two" }, now + 2)!;
  recordAnswerQuality("key-a", second, false, "model_output_invalid", now + 3);
  const e = answerQualityEvidence("key-a", "travel", "legacy-v1", now + 4);
  assert.equal(e.size, 1);
  assert.equal(e.get(qualityCandidateKey(r.provider, "account-three", r.model))?.rejected, 2);
});
