import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-native-dispatch-"));
process.env.DATA_DIR = dataDir;
const { buildDeadlineRequestClass, deadlineEndpointIdentity, sameDeadlineRequestClass } =
  await import("../../open-sse/utils/nativeDispatchEvidence.ts");
const { createPreparedRequestLogger, runWithCapture } =
  await import("../../open-sse/utils/providerRequestLogging.ts");
const { runWithNativeDeadline } = await import("../../open-sse/utils/nativeDeadlineContext.ts");
const { persistAttemptLogs } = await import("../../open-sse/handlers/chatCore/attemptLogging.ts");
const { getCallLogById } = await import("../../src/lib/usage/callLogs.ts");
const coreDb = await import("../../src/lib/db/core.ts");

const endpoint = "https://provider.example/v1/chat/completions";
const body = {
  model: "example-model",
  messages: [{ role: "user", content: "Private traveler prompt not retained in metadata" }],
  stream: false,
  reasoning_effort: "low",
  max_tokens: 2000,
  response_format: {
    type: "json_schema",
    json_schema: { name: "rates", schema: { type: "object" } },
  },
};
const quiet = { logTargetRequest() {} };
const makeCapture = () =>
  createPreparedRequestLogger(
    quiet,
    { id: "offline-request", model: "example-model", provider: "example", connectionId: "conn" },
    { originalBody: body }
  );
const context = { deadlineAt: 140000, declaredBudgetMs: 40000 };

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

test("request class and endpoint evidence contain controls only, with strict unknown neutrality", () => {
  const cls = buildDeadlineRequestClass(body);
  assert.ok(cls);
  assert.equal(cls.effort, "low");
  assert.equal(cls.maxTokens, 2000);
  assert.equal(cls.format, "json_schema");
  assert.equal(JSON.stringify(cls).includes("Private traveler"), false);
  assert.equal(deadlineEndpointIdentity(endpoint), endpoint);
  for (const url of [
    endpoint + "?key=secret",
    endpoint + "#fragment",
    "https://user:password@provider.example/v1/chat/completions",
    "https://provider.example/private/secret",
  ])
    assert.equal(deadlineEndpointIdentity(url), null);
  for (const request of [
    { ...body, stream: true },
    { ...body, tools: [] },
    { ...body, audio: {} },
    {
      ...body,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "secret" } }] }],
    },
    { ...body, response_format: undefined },
    { ...body, max_tokens: undefined },
  ])
    assert.equal(buildDeadlineRequestClass(request), null);
  assert.equal(sameDeadlineRequestClass(cls, { ...cls, maxTokens: 2400 }), false);
  assert.equal(sameDeadlineRequestClass(cls, { ...cls, effort: "none" }), false);
  assert.equal(sameDeadlineRequestClass(cls, cls), true);
});

test("prepared logging alone never fabricates a physical dispatch", async () => {
  const capture = makeCapture();
  capture.capture({
    url: endpoint,
    headers: { Authorization: "never-retained" },
    body,
    bodyString: JSON.stringify(body),
  });
  assert.equal(capture.nativeDispatch().observed, false);
});

test("actual wrapped fetch proves 800ms setup plus 39.2s native at a 40s deadline", async () => {
  const oldFetch = globalThis.fetch,
    oldNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  globalThis.fetch = async () => new Response("{}");
  try {
    const capture = makeCapture();
    await runWithNativeDeadline(context, () =>
      runWithCapture(capture, async () => {
        now += 800;
        await fetch(endpoint, { method: "POST", body: JSON.stringify(body) });
      })
    );
    now = 140000;
    const value = capture.nativeDispatch();
    assert.equal(value.observed, true);
    if (!value.observed) return;
    assert.equal(value.dispatchedAt, 100800);
    assert.equal(value.declaredBudgetMs, 40000);
    assert.equal(value.remainingAtDispatchMs, 39200);
    assert.equal(value.elapsedMs, 39200);
    assert.equal(value.observedAt, value.deadlineAt);
    assert.equal(value.endpointIdentity, endpoint);
    assert.equal(JSON.stringify(value).includes("Private traveler"), false);
    assert.equal(JSON.stringify(value).includes("Authorization"), false);
  } finally {
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
  }
});

test("early cancel plus delayed persistence remains an early right-censored observation", async () => {
  const oldFetch = globalThis.fetch,
    oldNow = Date.now;
  let now = 100000;
  const controller = new AbortController();
  Date.now = () => now;
  globalThis.fetch = async () => new Response("{}");
  try {
    const capture = makeCapture();
    await runWithNativeDeadline(context, () =>
      runWithCapture(capture, () =>
        fetch(endpoint, { method: "POST", body: JSON.stringify(body), signal: controller.signal })
      )
    );
    now = 110000;
    controller.abort();
    now = 200000;
    const value = capture.nativeDispatch();
    assert.equal(value.observed, true);
    if (!value.observed) return;
    assert.equal(value.abortObservedAt, 110000);
    assert.equal(value.observedAt, 110000);
    assert.ok(value.elapsedMs < value.remainingAtDispatchMs);
  } finally {
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
  }
});

test("identical physical retries cannot hide behind prepared-body dedup", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}");
  try {
    const capture = makeCapture();
    await runWithNativeDeadline({ deadlineAt: Date.now() + 40000, declaredBudgetMs: 40000 }, () =>
      runWithCapture(capture, async () => {
        for (let n = 0; n < 2; n++)
          await fetch(endpoint, { method: "POST", body: JSON.stringify(body) });
      })
    );
    assert.equal(capture.nativeDispatch().observed, false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("499 persistence overwrites spoofed evidence and noLog suppresses request detail", async () => {
  await coreDb.ensureDbInitialized();
  const ctx = (id: string, noLogEnabled = false) => ({
    traceId: id,
    provider: "example",
    connectionId: "conn",
    model: "example-model",
    skillRequestId: id,
    detailedLoggingEnabled: false,
    reqLogger: null,
    pendingRequestId: id,
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    requestedModel: "example-model",
    credentials: { connectionId: "conn" },
    startTime: Date.now(),
    body: {
      ...body,
      _omniroute: { nativeDispatch: { version: 1, observed: true, endpointIdentity: "spoofed" } },
    },
    sourceFormat: "openai",
    targetFormat: "openai",
    comboName: "offline-deadline",
    comboStepId: null,
    comboExecutionKey: null,
    tokensCompressed: 0,
    apiKeyInfo: null,
    noLogEnabled,
  });
  persistAttemptLogs({ status: 499, error: "Request aborted" }, ctx("dispatch-spoof"));
  persistAttemptLogs({ status: 499, error: "Request aborted" }, ctx("dispatch-nolog", true));
  const wait = async (id: string) => {
    for (let n = 0; n < 100; n++) {
      const row = await getCallLogById(id);
      if (row) return row as any;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  };
  const row = await wait("dispatch-spoof");
  assert.ok(row);
  assert.equal(row.requestBody._omniroute.nativeDispatch.observed, false);
  assert.notEqual(row.requestBody._omniroute.nativeDispatch.endpointIdentity, "spoofed");
  const noLog = await wait("dispatch-nolog");
  assert.ok(noLog);
  assert.equal(noLog.requestBody, null);
});
