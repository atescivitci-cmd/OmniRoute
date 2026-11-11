import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-combo-local-queue-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const core = await import("../../src/lib/db/core.ts");
const { resetAllComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../open-sse/services/rateLimitSemaphore.ts");
const { clearSessions } = await import("../../open-sse/services/sessionManager.ts");

function createLog() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function okResponse() {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function localQueueErrorResponse(
  status: number,
  code: "RATE_LIMIT_QUEUE_TIMEOUT" | "RATE_LIMIT_QUEUE_FULL",
  stream: boolean
) {
  const payload = { error: { message: "OmniRoute local scheduler event", code } };
  const body = stream
    ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
    : JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: { "content-type": stream ? "text/event-stream" : "application/json" },
  });
}

function resetRuntimeState() {
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  resetAllSemaphores();
  clearSessions();
}

test.beforeEach(resetRuntimeState);

test.after(() => {
  resetRuntimeState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

for (const scenario of [
  { strategy: "priority", status: 503, code: "RATE_LIMIT_QUEUE_TIMEOUT", stream: true },
  { strategy: "round-robin", status: 429, code: "RATE_LIMIT_QUEUE_FULL", stream: false },
] as const) {
  test(`${scenario.strategy} advances immediately after ${scenario.code}`, async () => {
    const calls: string[] = [];
    const result = await handleComboChat({
      body: {},
      combo: {
        name: `local-queue-${scenario.strategy}`,
        strategy: scenario.strategy,
        models: ["nvidia/model-a", "nvidia/model-b"],
        config: { maxRetries: 2, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        if (calls.length === 1) {
          return localQueueErrorResponse(scenario.status, scenario.code, scenario.stream);
        }
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2, "the local queue failure must not consume configured retries");
    assert.notEqual(calls[0], calls[1], "fallback must advance to the sibling target");
  });
}
