/**
 * ROUTING_OVERLOAD_FAILOVER, chat.ts account loop: the final "all accounts unavailable" answer
 * keeps the overload mark only when EVERY account tried for the model failed with a classified
 * overload refusal. One account overloaded and another failing differently (here a 500) must not
 * produce a mark, because the routing guard would then treat the whole attempt as admission
 * control when one account may have done work.
 *
 * Drives the real handleChat -> handleSingleModelChat -> chatCore -> openai executor with two
 * accounts of one provider; only the upstream fetch is faked, keyed by each account's API key.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeHeaders } from "../../open-sse/utils/headers.ts";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("chat-overload-account-mark");
const { buildRequest, handleChat, resetStorage, seedConnection, settingsDb } = harness;
const { isOverloadRefusal } = await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");

const LIVE =
  "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later. (reset after 3s)";

test.beforeEach(async () => {
  await resetStorage();
  clearAllModelLockouts();
  process.env.ROUTING_OVERLOAD_FAILOVER = "1";
});

test.afterEach(async () => {
  delete process.env.ROUTING_OVERLOAD_FAILOVER;
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

type Reply = "overload" | "server-error";

async function run(first: Reply, second: Reply) {
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  // Priority decides the order the accounts are tried in: "first" before "second".
  await seedConnection("openai", { name: "acct-first", apiKey: "sk-acct-first", priority: 1 });
  await seedConnection("openai", { name: "acct-second", apiKey: "sk-acct-second", priority: 2 });
  const seen: string[] = [];
  globalThis.fetch = async (_url: unknown, init: RequestInit = {}) => {
    const headers = normalizeHeaders(init.headers);
    const auth = String(headers.authorization ?? headers.Authorization ?? "");
    const which = auth.includes("sk-acct-first") ? "first" : "second";
    seen.push(which);
    const reply = which === "first" ? first : second;
    return reply === "overload"
      ? new Response(JSON.stringify({ error: { code: 503, message: LIVE } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      : new Response(JSON.stringify({ error: { message: "internal error" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
  };
  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai/gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "account loop probe" }],
      },
    })
  );
  return { response: response as Response, seen };
}

test("every account overloaded: the final answer keeps the overload mark", async () => {
  const { response, seen } = await run("overload", "overload");
  assert.deepEqual(seen, ["first", "second"], "both accounts were tried");
  assert.equal(response.status, 503);
  assert.equal(isOverloadRefusal(response), true);
});

test("one account overloaded, another failing with a 500: no overload mark", async () => {
  const { response, seen } = await run("overload", "server-error");
  assert.deepEqual(seen, ["first", "second"], "both accounts were tried");
  assert.equal(isOverloadRefusal(response), false);
});

test("a 500 first, then an overload: no overload mark", async () => {
  const { response, seen } = await run("server-error", "overload");
  assert.deepEqual(seen, ["first", "second"], "both accounts were tried");
  assert.equal(isOverloadRefusal(response), false);
});
