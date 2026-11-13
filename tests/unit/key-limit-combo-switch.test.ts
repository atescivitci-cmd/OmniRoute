// End to end through handleComboChat: a request whose history carries signed thinking, on a
// same-terminal-continuity combo with an explicit session id, moves from a target refused for
// the key's USD limit to a free target, and the second target never sees the signature.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-limit-combo-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const core = await import("../../src/lib/db/core.ts");
const { clearSessions } = await import("../../open-sse/services/sessionManager.ts");
const { resetAllComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../open-sse/services/rateLimitSemaphore.ts");
const fallThrough = await import("../../open-sse/services/keyLimitFallThrough.ts");

const marker = { message: "This API key reached its weekly USD usage quota." };
const costOf = async (provider: string) => (provider === "claude" ? 1 : 0);
const log = { info() {}, warn() {}, error() {}, debug() {} };

const signedBody = (extra: Record<string, unknown> = {}) => ({
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", signature: "SIG123" },
        { type: "text", text: "hello" },
      ],
    },
    { role: "user", content: "continue" },
  ],
  ...extra,
});

async function run(body: Record<string, unknown>, sessionId: string | null) {
  const seen: Array<{ model: string; body: string }> = [];
  const result = await handleComboChat({
    body,
    combo: {
      name: "kl-continuity",
      strategy: "priority",
      models: ["claude/claude-opus-4-8", "ollama-local/qwen3"],
      same_terminal_continuity: true,
      context_cache_protection: true,
      config: { maxRetries: 0 },
    },
    handleSingleModel: async (b: Record<string, unknown>, modelStr: string) => {
      seen.push({ model: modelStr, body: JSON.stringify(b) });
      const [provider, ...rest] = modelStr.split("/");
      const refusal = await fallThrough.keyLimitTargetRefusal(
        marker,
        provider,
        rest.join("/"),
        costOf
      );
      return refusal
        ? refusal.response
        : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
    relayOptions: sessionId ? { sessionId } : undefined,
  } as never);
  return { result, seen };
}

test.beforeEach(() => {
  clearSessions();
  resetAllComboMetrics();
  resetAllCircuitBreakers();
});

test.after(async () => {
  resetAllSemaphores();
  clearSessions();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("signed history switches to the free target and the second target never sees the signature", async () => {
  const { result, seen } = await run(signedBody(), "terminal-session-1");
  assert.equal(result.status, 200);
  assert.deepEqual(
    seen.map((s) => s.model),
    ["claude/claude-opus-4-8", "ollama-local/qwen3"]
  );
  assert.ok(seen[0].body.includes("SIG123"), "the refused first target saw the original body");
  assert.ok(!seen[1].body.includes("SIG123"), "the switched target must not receive the signature");
  assert.ok(seen[1].body.includes("hello") && seen[1].body.includes("continue"));
});

test("a request bound to provider-held state stays stopped", async () => {
  const { result, seen } = await run(
    signedBody({ previous_response_id: "resp_1" }),
    "terminal-session-2"
  );
  assert.equal(seen.length, 1);
  assert.notEqual(result.status, 200);
});
