/**
 * A credit refusal (HTTP 400 with credit text, or chatCore's canonical 402 payment_required
 * envelope) from a context-PINNED model is an admission refusal before any output, exactly like
 * the 429 the pin path already hands over on. The router must fall through to the combo's normal
 * selection instead of returning the error to the client mid tool loop. Non-credit 400s,
 * provider-bound requests and committed/terminal outcomes keep their existing behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never open the real ~/.omniroute database: DATA_DIR is a throwaway temp dir BEFORE any import.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-credit-pin-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-credit-pin-test-secret";
assert.ok(process.env.DATA_DIR.startsWith(os.tmpdir()), "DATA_DIR must be a temp dir");

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { tryPinnedModelDispatch } = await import("../../open-sse/services/combo/dispatchPrelude.ts");
const { resolveComboSetupConfig } = await import("../../open-sse/services/comboConfig.ts");
const { createRoutingAttemptGuard, isRoutingTerminal } =
  await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { recordSessionModelUsage } = await import("../../src/lib/db/contextHandoffs.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };
const PROVIDER = "creditpin";
const CREDIT =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.";

test.after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const ok = (text = "served") =>
  Response.json({ choices: [{ message: { role: "assistant", content: text } }] });
const credit400 = () =>
  Response.json(
    { error: { message: `[400]: ${CREDIT}`, type: "invalid_request_error" } },
    { status: 400 }
  );
const credit400Raw = () =>
  Response.json(
    { type: "error", error: { type: "invalid_request_error", message: CREDIT } },
    { status: 400 }
  );
const credit402 = () =>
  Response.json(
    {
      error: {
        message: "[402]: Insufficient Balance",
        type: "billing_error",
        code: "payment_required",
      },
    },
    { status: 402 }
  );
const bad400 = () =>
  Response.json({ error: { message: "[400]: messages: field required" } }, { status: 400 });
const plainBody = () => ({ model: "x", messages: [{ role: "user", content: "hi" }] });
const toolBody = () => ({
  ...plainBody(),
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
});

let seq = 0;
function seedConnection() {
  getDbInstance()
    .prepare(
      `INSERT OR IGNORE INTO provider_connections (id,provider,auth_type,name,is_active,test_status,created_at,updated_at) VALUES ('creditpin-conn','${PROVIDER}','api_key','fixture',1,'active',datetime('now'),datetime('now'))`
    )
    .run();
}

function pinnedCombo() {
  const n = seq++;
  const combo = {
    name: `credit-pin-${n}`,
    strategy: "priority",
    models: [{ model: `${PROVIDER}/first` }, { model: `${PROVIDER}/last` }],
    context_cache_protection: true,
    config: { maxRetries: 0, retryDelayMs: 0 },
  };
  const sessionId = `credit-pin-session-${n}`;
  recordSessionModelUsage(sessionId, combo.name, `${PROVIDER}/last`, PROVIDER);
  return { combo, sessionId };
}

async function runPinned(
  body: Record<string, unknown>,
  pinnedResponse: () => Response
): Promise<{ res: Response; calls: string[]; bodies: string[] }> {
  seedConnection();
  const { combo, sessionId } = pinnedCombo();
  const calls: string[] = [];
  const bodies: string[] = [];
  const res = await handleComboChat({
    body,
    combo,
    allCombos: [combo],
    handleSingleModel: async (b: Record<string, unknown>, m: string) => {
      calls.push(m);
      bodies.push(JSON.stringify(b.messages));
      return m === `${PROVIDER}/last` ? pinnedResponse() : ok(`served by ${m}`);
    },
    isModelAvailable: async () => true,
    log,
    settings: { modelLockout: { enabled: false } },
    relayOptions: { sessionId },
  });
  return { res, calls, bodies };
}

test("pinned model credit 400 / 402 falls through; the next target serves the same messages", async () => {
  for (const make of [credit400, credit400Raw, credit402]) {
    for (const body of [plainBody(), toolBody()]) {
      const { res, calls, bodies } = await runPinned(body, make);
      assert.equal(res.status, 200, `${make.name}`);
      assert.deepEqual(calls, [`${PROVIDER}/last`, `${PROVIDER}/first`], `${make.name}`);
      assert.equal(bodies[0], bodies[1], "identical request messages");
      assert.match(await res.text(), /served by creditpin\/first/);
    }
  }
});

test("pinned model non-credit 400 is still returned as is (no fall-through)", async () => {
  for (const body of [plainBody(), toolBody()]) {
    const { res, calls } = await runPinned(body, bad400);
    assert.equal(res.status, 400);
    assert.deepEqual(calls, [`${PROVIDER}/last`]);
  }
});

test("pinned model 402 with a non-credit code (gateway budget) is still returned as is", async () => {
  const { res, calls } = await runPinned(plainBody(), () =>
    Response.json(
      { error: { message: "key budget", code: "key_budget_exceeded" } },
      { status: 402 }
    )
  );
  assert.equal(res.status, 402);
  assert.deepEqual(calls, [`${PROVIDER}/last`]);
});

test("providerBound request: pinned credit refusal is NOT handed over", async () => {
  for (const body of [
    { ...plainBody(), previous_response_id: "resp_fixture" },
    { model: "x", input: [{ type: "reasoning", encrypted_content: "opaque" }] },
  ]) {
    for (const make of [credit400, credit402]) {
      const { res, calls } = await runPinned(body, make);
      assert.ok(res.status === 400 || res.status === 402, `status ${res.status}`);
      assert.deepEqual(calls, [`${PROVIDER}/last`]);
    }
  }
});

// ── direct unit coverage of the pin helper ────────────────────────────────────────────────
async function direct(body: Record<string, unknown>, wrapWithGuard: boolean, make: () => Response) {
  seedConnection();
  const combo = {
    name: `credit-pin-direct-${seq++}`,
    strategy: "priority",
    models: [{ model: `${PROVIDER}/last` }],
    config: {},
  };
  const dispatched: string[] = [];
  const stub = async (_b: unknown, m: string) => {
    dispatched.push(m);
    return make();
  };
  const handler = wrapWithGuard
    ? createRoutingAttemptGuard({ body, limit: 3 }).wrap(stub as never)
    : (stub as never);
  const res = await tryPinnedModelDispatch({
    body,
    combo,
    pinnedModel: `${PROVIDER}/last`,
    allCombos: [],
    config: resolveComboSetupConfig(combo, {}),
    clientRequestedStream: false,
    handleSingleModelWithTimeout: handler,
    log,
  });
  return { res, dispatched };
}

test("tryPinnedModelDispatch: credit 400 / 402 returns null (fall through), like 429", async () => {
  for (const make of [credit400, credit400Raw, credit402]) {
    for (const guarded of [false, true]) {
      const { res, dispatched } = await direct(toolBody(), guarded, make);
      assert.equal(res, null, `${make.name} guarded=${guarded}`);
      assert.deepEqual(dispatched, [`${PROVIDER}/last`]);
    }
  }
});

test("tryPinnedModelDispatch: non-credit 400 is returned as is; providerBound credit refusal is terminal", async () => {
  const bad = await direct(plainBody(), true, bad400);
  assert.ok(bad.res);
  assert.equal(bad.res.status, 400);
  const bound = { ...plainBody(), previous_response_id: "resp_fixture" };
  const stopped = await direct(bound, true, credit400);
  assert.ok(stopped.res, "providerBound credit refusal must not fall through");
  assert.equal(isRoutingTerminal(stopped.res), true);
});
