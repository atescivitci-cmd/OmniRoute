/**
 * The request class reaches buildAutoCandidates through the real caller (resolveAutoStrategyOrder)
 * only while ROUTING_DURABLE_EVIDENCE is on; with it off the call is exactly the old six arguments.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-durable-caller-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resolveAutoStrategyOrder } =
  await import("@omniroute/open-sse/services/combo/resolveAutoStrategy.ts");
const { resetDbInstance } = await import("@/lib/db/core.ts");

after(() => {
  resetDbInstance();
  delete process.env.ROUTING_DURABLE_EVIDENCE;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as never;
const target = (provider: string, modelStr: string) => ({
  kind: "model",
  stepId: modelStr,
  executionKey: `${provider}>${modelStr}`,
  modelStr,
  provider,
  providerId: null,
  connectionId: null,
  weight: 1,
  label: null,
});

async function capturedArgs(flag: string | undefined, body: Record<string, unknown>) {
  if (flag === undefined) delete process.env.ROUTING_DURABLE_EVIDENCE;
  else process.env.ROUTING_DURABLE_EVIDENCE = flag;
  const calls: unknown[][] = [];
  try {
    await resolveAutoStrategyOrder({
      orderedTargets: [target("openai", "gpt-4o"), target("anthropic", "claude-3")],
      body,
      combo: { id: "c1", name: "autoc", config: {} },
      settings: null,
      config: {},
      relayOptions: null,
      resilienceSettings: { quotaPreflight: { enabled: false } },
      log: noopLog,
      buildAutoCandidates: (async (...args: unknown[]) => {
        calls.push(args);
        return [];
      }) as never,
    } as never);
  } finally {
    delete process.env.ROUTING_DURABLE_EVIDENCE;
  }
  assert.equal(calls.length, 1);
  return calls[0];
}

const TOOL_BODY = {
  stream: true,
  tools: [{ type: "function", function: { name: "run", parameters: { type: "object" } } }],
  messages: [{ role: "user", content: "go" }],
};

test("flag on: the request class derived from the body is passed as the 7th argument", async () => {
  const args = await capturedArgs("1", TOOL_BODY);
  assert.deepEqual(args[6], { requestClass: "t0s" });
  const chat = await capturedArgs("1", { messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(chat[6], { requestClass: "c0n" });
});

test("flag off or unset: no class is derived or passed", async () => {
  for (const flag of [undefined, "0"]) {
    const args = await capturedArgs(flag, TOOL_BODY);
    assert.equal(args[6], undefined);
  }
});
