/**
 * A 400 whose upstream text says the target's own credential / authorization header is
 * malformed is about that target, not about the request. The upstream rejected it at the
 * auth layer before processing anything, so the combo may move on to the next ranked
 * target. Ordinary 400s (bad request body, schema, context length) keep failing closed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-cred-400-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-cred-400-test-secret";

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { createRoutingAttemptGuard, isRoutingTerminal } =
  await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { isCredentialRejectionText } =
  await import("../../open-sse/services/combo/credentialRejection.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

const CRED_TEXT = "bad request: Authorization header is badly formatted";

const plainBody = () => ({ model: "test", messages: [{ role: "user", content: "hi" }] });
const toolBody = () => ({
  ...plainBody(),
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
});

function makeCombo(models: string[]) {
  return {
    name: "test-combo-cred-400",
    strategy: "priority",
    models: models.map((m) => ({ model: m })),
  };
}
const okResponse = (modelStr: string) =>
  Response.json({
    id: "ok",
    object: "chat.completion",
    choices: [{ message: { role: "assistant", content: `ok from ${modelStr}` } }],
  });
const errResponse = (status: number, message: string) =>
  Response.json({ error: { message, type: "invalid_request_error" } }, { status });

async function runCombo(body: Record<string, unknown>, firstStatus: number, firstMessage: string) {
  const called: string[] = [];
  const response = await handleComboChat({
    body,
    combo: makeCombo(["p1/model-a", "p2/model-b"]),
    handleSingleModel: async (_b: unknown, modelStr: string) => {
      called.push(modelStr);
      return modelStr === "p1/model-a"
        ? errResponse(firstStatus, firstMessage)
        : okResponse(modelStr);
    },
    log,
    settings: {},
    allCombos: [],
  });
  return { response, called };
}

test("plain request: credential-header 400 advances to the next target", async () => {
  const { response, called } = await runCombo(plainBody(), 400, CRED_TEXT);
  assert.equal(response.status, 200);
  assert.deepEqual(called, ["p1/model-a", "p2/model-b"]);
});

test("tool request: credential-header 400 advances to the next target", async () => {
  const { response, called } = await runCombo(toolBody(), 400, CRED_TEXT);
  assert.equal(response.status, 200);
  assert.deepEqual(called, ["p1/model-a", "p2/model-b"]);
});

test("ordinary 400 still stops (plain and tool)", async () => {
  for (const body of [plainBody(), toolBody()]) {
    const { response, called } = await runCombo(body, 400, "invalid request body");
    assert.equal(response.status, 400);
    assert.deepEqual(called, ["p1/model-a"]);
  }
});

test("401 and 403 keep today's behavior (stop, no advance)", async () => {
  for (const status of [401, 403]) {
    const { response, called } = await runCombo(plainBody(), status, "unauthorized");
    assert.equal(response.status, status);
    assert.deepEqual(called, ["p1/model-a"], `status ${status}`);
  }
});

test("single-target request just returns the 400", async () => {
  const called: string[] = [];
  const response = await handleComboChat({
    body: plainBody(),
    combo: makeCombo(["p1/model-a"]),
    handleSingleModel: async (_b: unknown, modelStr: string) => {
      called.push(modelStr);
      return errResponse(400, CRED_TEXT);
    },
    log,
    settings: {},
    allCombos: [],
  });
  assert.equal(response.status, 400);
  assert.deepEqual(called, ["p1/model-a"]);
});

test("provider-bound request keeps the existing stop (known limit)", async () => {
  const body = { ...plainBody(), previous_response_id: "resp_fixture" };
  const { response, called } = await runCombo(body, 400, CRED_TEXT);
  assert.equal(response.status, 400);
  assert.deepEqual(called, ["p1/model-a"]);
});

test("the failed target is not retried within the same call", async () => {
  let first = 0;
  const run = createRoutingAttemptGuard({ body: plainBody(), limit: 5 }).wrap(
    async (_b: unknown, model: string) => {
      if (model === "p1/model-a") {
        first++;
        return errResponse(400, CRED_TEXT);
      }
      return okResponse(model);
    }
  );
  const failed = await run(plainBody(), "p1/model-a");
  assert.equal(failed.status, 400);
  assert.equal(isRoutingTerminal(failed), false);
  const again = await run(plainBody(), "p1/model-a");
  assert.equal(first, 1);
  assert.equal(again.status, 400);
  assert.equal((await run(plainBody(), "p2/model-b")).status, 200);
});

test("guard: ordinary 400 stays terminal, credential 400 is not terminal", async () => {
  const ordinary = createRoutingAttemptGuard({ body: plainBody(), limit: 3 }).wrap(async () =>
    errResponse(400, "invalid request body")
  );
  assert.equal(isRoutingTerminal(await ordinary(plainBody(), "p1/model-a")), true);
  const cred = createRoutingAttemptGuard({ body: toolBody(), limit: 3 }).wrap(async () =>
    errResponse(400, CRED_TEXT)
  );
  assert.equal(isRoutingTerminal(await cred(toolBody(), "p1/model-a")), false);
});

test("pattern matcher: positives", () => {
  for (const text of [
    "bad request: Authorization header is badly formatted",
    "Authorization header is badly formatted",
    "invalid authorization header",
    "Invalid Authorization header format",
    "malformed authorization header",
    "Malformed Authorization header",
  ]) {
    assert.equal(isCredentialRejectionText(text), true, text);
  }
});

test("pattern matcher: near-misses must not match", () => {
  for (const text of [
    "invalid request body",
    "bad request",
    "Invalid message format: the request body is malformed.",
    "malformed JSON in request body",
    "the authorization code is invalid",
    "authorization parameter is required",
    "Authorization header is required",
    "authorization is pending",
    "malformed authorization code",
    "malformed authorization request",
    "Malformed Authorization",
    "authorization code is malformed",
    "invalid authorization request",
    "authorization failed for model gpt-x",
    "invalid header value in request",
    "model is not supported",
    "",
  ]) {
    assert.equal(isCredentialRejectionText(text), false, text);
  }
  assert.equal(isCredentialRejectionText(undefined as unknown as string), false);
  assert.equal(isCredentialRejectionText(42 as unknown as string), false);
});

test("known limit: a second model on the same rejected connection is still dispatched", async () => {
  const seen: string[] = [];
  const run = createRoutingAttemptGuard({ body: plainBody(), limit: 5 }).wrap(
    async (_b: unknown, model: string) => {
      seen.push(model);
      return model === "p1/model-a" ? errResponse(400, CRED_TEXT) : okResponse(model);
    }
  );
  const target = { connectionId: "conn-1" };
  await run(plainBody(), "p1/model-a", target);
  assert.equal((await run(plainBody(), "p1/model-b", target)).status, 200);
  assert.deepEqual(seen, ["p1/model-a", "p1/model-b"]);
});
