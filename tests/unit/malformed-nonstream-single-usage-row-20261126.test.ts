/**
 * A non-streaming request that ends as a failure writes ONLY the failure row to usage_history.
 *
 * Live (2026-11-26): NVIDIA mistral-large answered HTTP 200 with no usable choices. chatCore wrote
 * the success row (status 200, success 1) before translating the response, then the malformed
 * check after translation wrote the failure row (502 malformed_translated_response) about 30 ms
 * later. Every malformed failure was therefore also counted as a success in the ranking evidence.
 *
 * Rules under test:
 *  - malformed 200: exactly one row, the failure, carrying the tokens the provider reported. The
 *    provider billed them: getUsageStats and the monthly token totals read every row, and the
 *    spend readers that count successful rows only (per-key USD limits, connection spend,
 *    Antigravity units) also count this failure through BILLED_USAGE_ROW_SQL
 *    (billed-usage-rows-20261126.test.ts)
 *  - a post-processing step that throws after a 200: exactly one row, a failure with the tokens
 *  - a post-call guardrail block: exactly one row, the success (the provider answered usably)
 *  - a good 200: exactly one success row, with the provider latency, as before
 *  - streaming: once a completion is recorded, a later failure finalizer writes no second row
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-malformed-usage-row-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { guardrailRegistry } = await import("../../src/lib/guardrails/index.ts");
const { BaseGuardrail } = await import("../../src/lib/guardrails/base.ts");
const core = await import("../../src/lib/db/core.ts");
const { createStreamFailureFinalizers } =
  await import("../../open-sse/utils/streamFailureFinalization.ts");

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

type Row = {
  status: string;
  success: number;
  error_code: string | null;
  tokens_input: number;
  tokens_output: number;
  latency_ms: number;
};

function rowsFor(model: string): Row[] {
  return core
    .getDbInstance()
    .prepare(
      `SELECT status, success, error_code, tokens_input, tokens_output, latency_ms
       FROM usage_history WHERE model = ? ORDER BY id`
    )
    .all(model) as Row[];
}

/** saveRequestUsage is fire-and-forget: wait until the writes have landed and settled. */
async function settledRows(model: string, min: number): Promise<Row[]> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && rowsFor(model).length < min) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 150));
  return rowsFor(model);
}

async function invoke(model: string, upstream: () => Response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => upstream()) as typeof fetch;
  try {
    const body = { model, stream: false, messages: [{ role: "user", content: "hello" }] };
    return await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model, extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json", "user-agent": "unit-test" }),
      },
      apiKeyInfo: null,
      userAgent: "unit-test",
    } as never);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("malformed 200 (no choices): one usage row, the failure, with the reported tokens", async () => {
  const model = "malformed-no-choices";
  const result = (await invoke(model, () =>
    json({
      id: "chatcmpl-x",
      object: "chat.completion",
      model,
      usage: { prompt_tokens: 120, completion_tokens: 3, total_tokens: 123 },
    })
  )) as { success: boolean; status: number };
  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  const rows = await settledRows(model, 1);
  assert.deepEqual(
    rows.map((r) => [r.status, r.success, r.error_code]),
    [["502", 0, "malformed_translated_response"]],
    "a request that ends as a failure must not also be recorded as a success"
  );
  assert.equal(rows[0].tokens_input, 120, "the billed input tokens stay on the record");
  assert.equal(rows[0].tokens_output, 3);
});

test("a good 200: one success row, as before", async () => {
  const model = "good-json";
  const result = (await invoke(model, () =>
    json({
      id: "chatcmpl-y",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
    })
  )) as { success: boolean };
  assert.equal(result.success, true);
  const rows = await settledRows(model, 1);
  assert.deepEqual(
    rows.map((r) => [r.status, r.success, r.error_code, r.tokens_input, r.tokens_output]),
    [["200", 1, null, 9, 2]]
  );
});

test("streaming: a failure after a recorded completion writes no second row", () => {
  const persisted: Array<[number, string | undefined]> = [];
  let completed = false;
  const { handleStreamFailure } = createStreamFailureFinalizers({
    isFailureCompletionRecorded: () => false,
    isStreamCompletionRecorded: () => completed,
    onStreamComplete: () => {
      completed = true;
    },
    persistFailureUsage: (status, code) => persisted.push([status, code]),
  });
  completed = true; // the 200 completion already wrote its row
  handleStreamFailure({ status: 502, message: "late", code: "stream_terminated" });
  assert.deepEqual(persisted, []);
});

const GOOD = (model: string) => () =>
  json({
    id: "chatcmpl-z",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 70, completion_tokens: 5, total_tokens: 75 },
  });

test("a post-processing step that throws after a 200 still writes exactly one row, a failure", async () => {
  const model = "throws-after-200";
  const original = guardrailRegistry.runPostCallHooks;
  guardrailRegistry.runPostCallHooks = (async () => {
    throw new Error("post-call hook exploded");
  }) as typeof original;
  try {
    await assert.rejects(invoke(model, GOOD(model)), /post-call hook exploded/);
  } finally {
    guardrailRegistry.runPostCallHooks = original;
  }
  const rows = await settledRows(model, 1);
  assert.deepEqual(
    rows.map((r) => [r.status, r.success, r.error_code, r.tokens_input, r.tokens_output]),
    [["500", 0, "post_processing_error", 70, 5]]
  );
});

test("a post-call guardrail block keeps its single success row", async () => {
  const model = "guardrail-blocked";
  class BlockAll extends BaseGuardrail {
    constructor() {
      super("test-block-all", { priority: 1 });
    }
    async postCall() {
      return { block: true, message: "blocked by test" };
    }
  }
  guardrailRegistry.register(new BlockAll());
  try {
    const result = (await invoke(model, GOOD(model))) as { success: boolean; status: number };
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
  } finally {
    const kept = guardrailRegistry.list().filter((g) => g.name !== "test-block-all");
    guardrailRegistry.clear();
    for (const g of kept) guardrailRegistry.register(g);
  }
  const rows = await settledRows(model, 1);
  assert.deepEqual(
    rows.map((r) => [r.status, r.success, r.error_code, r.tokens_input, r.tokens_output]),
    [["200", 1, null, 70, 5]]
  );
});
