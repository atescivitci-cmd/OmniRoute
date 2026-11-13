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
