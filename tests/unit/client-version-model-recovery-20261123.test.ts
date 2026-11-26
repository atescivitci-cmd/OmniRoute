import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "router-version-refusal-"));
const { createRoutingAttemptGuard, isRoutingTerminal } =
  await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { handleComboChat, isModelScoped400 } = await import("../../open-sse/services/combo.ts");
const message =
  "Claude Code 2.1.219 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
const rejected = (status = 400, text = message) =>
  Response.json({ error: { message: text, code: "bad_request" } }, { status });
const log = { info() {}, warn() {}, debug() {}, error() {} };
test("version compatibility refusal advances through the existing owner with identical payload", async () => {
  assert.equal(isModelScoped400(message), true);
  for (const tools of [undefined, [{ type: "function", function: { name: "lookup" } }]]) {
    const body = {
      messages: [{ role: "user", content: "Help plan the trip" }],
      ...(tools ? { tools } : {}),
    };
    const calls: string[] = [];
    const guard = createRoutingAttemptGuard({ body, limit: 3 });
    const run = guard.wrap(async (received, model) => {
      assert.deepEqual(received, body);
      calls.push(model);
      return calls.length === 1
        ? rejected()
        : Response.json({ choices: [{ message: { role: "assistant", content: "A real reply" } }] });
    });
    const response = await handleComboChat({
      body,
      combo: {
        name: "version-recovery",
        strategy: "priority",
        models: [{ model: "p/a" }, { model: "q/b" }],
      },
      handleSingleModel: run,
      routingAttemptGuard: guard,
      log,
      settings: {},
      allCombos: [],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["p/a", "q/b"]);
  }
});
test("body errors, auth errors and provider-bound continuations still stop", async () => {
  for (const [body, status, text] of [
    [{ messages: [{ role: "user", content: "Hi" }] }, 400, "Invalid messages format"],
    [{ messages: [{ role: "user", content: "Hi" }] }, 401, message],
    [{ previous_response_id: "prior", messages: [{ role: "user", content: "Hi" }] }, 400, message],
  ] as const) {
    const run = createRoutingAttemptGuard({ body: body as Record<string, unknown>, limit: 3 }).wrap(
      async () => rejected(status, text)
    );
    assert.equal(isRoutingTerminal(await run(body as Record<string, unknown>, "p/a")), true);
  }
});
