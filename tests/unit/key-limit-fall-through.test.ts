// An API key over its USD usage limit must not hard-stop the request. Targets that would add
// to the key's recorded spend are skipped before dispatch so the router can try the next
// eligible target; targets that add nothing (free or local) stay eligible. Requests carrying
// provider-bound state still cannot switch providers (existing routing guard, unchanged).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-limit-fall-through-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "key-limit-test-secret";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const policy = await import("../../src/shared/utils/apiKeyPolicy.ts");
const fallThrough = await import("../../open-sse/services/keyLimitFallThrough.ts");
const { createRoutingAttemptGuard } =
  await import("../../open-sse/services/combo/routingAttemptSafety.ts");

const FALL = { usageLimitFallThrough: true };
const req = (key: string) =>
  new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
  });

async function overLimitKey() {
  await localDb.updatePricing({
    claude: {
      "claude-opus-4-8": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 },
    },
  });
  const created = await apiKeysDb.createApiKey("Capped Key", "machine-fall-through");
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 0.01,
    weeklyUsageLimitUsd: 0.02,
  });
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    apiKeyId: created.id,
    apiKeyName: "Capped Key",
    tokens: { input: 5_000_000, output: 0 },
    success: true,
    timestamp: new Date().toISOString(),
  });
  return created;
}

test.beforeEach(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  usageHistory.clearPendingRequests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  delete process.env.KEY_LIMIT_FALLTHROUGH;
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("over-limit key is not rejected up front; the limit message travels with the request", async () => {
  const created = await overLimitKey();
  const result = await policy.enforceApiKeyPolicy(req(created.key), "claude/claude-opus-4-8", FALL);
  assert.equal(result.rejection, null);
  const marker = (result.apiKeyInfo as { usageLimitExceeded?: { message: string } })
    .usageLimitExceeded;
  assert.ok(marker && /usage quota/i.test(marker.message), JSON.stringify(marker));
});

test("kill switch KEY_LIMIT_FALLTHROUGH=0 restores the hard 400 rejection", async () => {
  process.env.KEY_LIMIT_FALLTHROUGH = "0";
  const created = await overLimitKey();
  const result = await policy.enforceApiKeyPolicy(req(created.key), "claude/claude-opus-4-8", FALL);
  assert.equal(result.rejection?.status, 400);
});

test("a key under its limit carries no marker", async () => {
  const created = await apiKeysDb.createApiKey("Under Key", "machine-under");
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 100,
    weeklyUsageLimitUsd: 500,
  });
  const result = await policy.enforceApiKeyPolicy(req(created.key), "claude/claude-opus-4-8");
  assert.equal(result.rejection, null);
  assert.equal(
    (result.apiKeyInfo as { usageLimitExceeded?: unknown }).usageLimitExceeded,
    undefined
  );
});

test("the marker is per request, never cached onto the key's stored metadata", async () => {
  const created = await overLimitKey();
  await policy.enforceApiKeyPolicy(req(created.key), "claude/claude-opus-4-8", FALL);
  const stored = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.equal((stored as { usageLimitExceeded?: unknown }).usageLimitExceeded, undefined);
});

const costOf = async (provider: string, _model: string, tokens: Record<string, number>) =>
  provider === "claude" ? (tokens.input ?? 0) / 1_000_000 : 0;
const marker = { message: "This API key reached its weekly USD usage quota." };

test("metered target is refused with a 400 that is safe to advance past", async () => {
  const refusal = await fallThrough.keyLimitTargetRefusal(
    marker,
    "claude",
    "claude-opus-4-8",
    costOf
  );
  assert.ok(refusal);
  assert.equal(refusal.status, 400);
  assert.equal(refusal.response.status, 400);
  assert.match(refusal.error, /usage quota/);
});

test("free or local targets stay eligible; no marker means no refusal; cost errors fail closed", async () => {
  assert.equal(
    await fallThrough.keyLimitTargetRefusal(marker, "ollama-local", "qwen", costOf),
    null
  );
  assert.equal(
    await fallThrough.keyLimitTargetRefusal(marker, "nvidia", "free-model", costOf),
    null
  );
  assert.equal(
    await fallThrough.keyLimitTargetRefusal(undefined, "claude", "claude-opus-4-8", costOf),
    null
  );
  const broken = async () => {
    throw new Error("pricing unavailable");
  };
  assert.ok(await fallThrough.keyLimitTargetRefusal(marker, "claude", "claude-opus-4-8", broken));
});

test("over-limit request falls through to the next target instead of erroring", async () => {
  const body = { messages: [{ role: "user", content: "hello" }] };
  const tried: string[] = [];
  const run = createRoutingAttemptGuard({ body, limit: 3 }).wrap(
    async (_b: unknown, target: string) => {
      tried.push(target);
      const [provider, model] = target.split("/");
      const refusal = await fallThrough.keyLimitTargetRefusal(marker, provider, model, costOf);
      return refusal ? refusal.response : Response.json({ ok: true });
    }
  );
  const first = await run(body, "claude/claude-opus-4-8");
  assert.equal(first.status, 400);
  const second = await run(body, "ollama-local/qwen3");
  assert.equal(second.status, 200);
  assert.deepEqual(tried, ["claude/claude-opus-4-8", "ollama-local/qwen3"]);
});

test("provider-bound requests still cannot switch providers (guard unchanged)", async () => {
  const body = {
    messages: [{ role: "user", content: "x" }],
    tools: [{ type: "web_search_preview" }],
  };
  let sent = 0;
  const run = createRoutingAttemptGuard({ body, limit: 3 }).wrap(
    async (_b: unknown, target: string) => {
      sent++;
      const [provider, model] = target.split("/");
      const refusal = await fallThrough.keyLimitTargetRefusal(marker, provider, model, costOf);
      return refusal ? refusal.response : Response.json({ ok: true });
    }
  );
  const first = await run(body, "claude/claude-opus-4-8");
  assert.equal(first.status, 400);
  await run(body, "ollama-local/qwen3");
  assert.equal(sent, 1, "a provider-bound request must not be sent to a second provider");
});

test("callers that do not opt in (embeddings, music, ...) still get the hard 400", async () => {
  const created = await overLimitKey();
  const result = await policy.enforceApiKeyPolicy(req(created.key), "claude/claude-opus-4-8");
  assert.equal(result.rejection?.status, 400);
});

// ── Mid-conversation switch (signed thinking history) ────────────────────────────────────
// A request whose history carries provider signatures may move to another provider only when
// (1) the previous target refused it BEFORE dispatch because of the key's USD limit (so no
// provider saw or acted on it), (2) the caller sanitizes the body for the switch, and
// (3) the request is bound only by signature-class artifacts the sanitizer strips. Everything
// else keeps the existing stop.
const guardMod = await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const signedBody = () => ({
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
});
const refuseThenOk = async (target: string) => {
  const [provider, model] = target.split("/");
  const refusal = await fallThrough.keyLimitTargetRefusal(marker, provider, model, costOf);
  return refusal ? refusal.response : Response.json({ ok: true });
};

test("key-limit refusal is recognizable and survives response replacement", async () => {
  const refusal = await fallThrough.keyLimitTargetRefusal(marker, "claude", "opus", costOf);
  assert.ok(refusal);
  assert.equal(guardMod.isKeyLimitRefusal(refusal.response), true);
  const replaced = guardMod.inheritRoutingResponseState(refusal.response, refusal.response.clone());
  assert.equal(guardMod.isKeyLimitRefusal(replaced), true);
  assert.equal(guardMod.isKeyLimitRefusal(Response.json({}, { status: 400 })), false);
});

test("signature-bound history switches after a key-limit refusal when the caller sanitizes", async () => {
  const body = signedBody();
  assert.equal(guardMod.inspectReplayInput(body).providerBound, true);
  assert.equal(guardMod.inspectReplayInput(body).hardBound, false);
  const tried: string[] = [];
  const run = createRoutingAttemptGuard({ body, limit: 3, sanitizedSwitch: true }).wrap(
    async (_b: unknown, target: string) => {
      tried.push(target);
      return refuseThenOk(target);
    }
  );
  assert.equal((await run(body, "claude/claude-opus-4-8")).status, 400);
  assert.equal((await run(body, "ollama-local/qwen3")).status, 200);
  assert.deepEqual(tried, ["claude/claude-opus-4-8", "ollama-local/qwen3"]);
});

test("without the sanitizing opt-in a signed history still cannot switch", async () => {
  const body = signedBody();
  let sent = 0;
  const run = createRoutingAttemptGuard({ body, limit: 3 }).wrap(
    async (_b: unknown, target: string) => {
      sent++;
      return refuseThenOk(target);
    }
  );
  await run(body, "claude/claude-opus-4-8");
  await run(body, "ollama-local/qwen3");
  assert.equal(sent, 1);
});

test("hard provider binding never switches, even for a key-limit refusal", async () => {
  for (const hard of [
    { previous_response_id: "resp_1" },
    { conversation: "conv_1" },
    { tools: [{ type: "web_search_preview" }] },
  ]) {
    const body = { ...signedBody(), ...hard };
    assert.equal(guardMod.inspectReplayInput(body).hardBound, true);
    let sent = 0;
    const run = createRoutingAttemptGuard({ body, limit: 3, sanitizedSwitch: true }).wrap(
      async (_b: unknown, target: string) => {
        sent++;
        return refuseThenOk(target);
      }
    );
    await run(body, "claude/claude-opus-4-8");
    await run(body, "ollama-local/qwen3");
    assert.equal(sent, 1, JSON.stringify(hard));
  }
});

test("only a key-limit refusal opens the exception, not other failures", async () => {
  const body = signedBody();
  for (const make of [
    () => Response.json({ error: { code: "x" } }, { status: 500 }),
    () => guardMod.markKnownNonDispatch(Response.json({ error: { code: "x" } }, { status: 400 })),
  ]) {
    let sent = 0;
    const run = createRoutingAttemptGuard({ body, limit: 3, sanitizedSwitch: true }).wrap(
      async () => {
        sent++;
        return make();
      }
    );
    await run(body, "claude/claude-opus-4-8");
    await run(body, "ollama-local/qwen3");
    assert.equal(sent, 1);
  }
});

test("switch body is stripped of signatures and thinking, text and roles survive", () => {
  const out = fallThrough.sanitizeBodyAfterKeyLimit(signedBody()) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const text = JSON.stringify(out);
  assert.ok(!text.includes("SIG123") && !text.includes('"thinking"'), text);
  assert.ok(text.includes("hello") && text.includes("continue"));
  assert.deepEqual(
    out.messages.map((m) => m.role),
    ["user", "assistant", "user"]
  );
});

test("the original body is not mutated by sanitizing", () => {
  const body = signedBody();
  fallThrough.sanitizeBodyAfterKeyLimit(body);
  assert.ok(JSON.stringify(body).includes("SIG123"));
});
