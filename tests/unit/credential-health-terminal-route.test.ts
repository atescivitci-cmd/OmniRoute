import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-terminal-probe-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-terminal-probe-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/route.ts");

const originalFetch = globalThis.fetch;

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("background connection test performs no network request and preserves terminal DB state", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  for (const testStatus of ["credits_exhausted", "banned", "expired"]) {
    const connection = await providersDb.createProviderConnection({
      provider: "nvidia",
      authType: "apikey",
      name: `Terminal ${testStatus}`,
      apiKey: `test-key-${testStatus}`,
      testStatus,
      lastError: `durable ${testStatus}`,
      lastErrorAt: "2026-09-10T23:53:20.000Z",
      lastErrorType: "quota",
      errorCode: testStatus === "credits_exhausted" ? 402 : 403,
      isActive: true,
    });
    const connectionId = String((connection as { id: string }).id);

    const result = await testSingleConnection(connectionId, undefined, { automated: true });
    const stored = await providersDb.getProviderConnectionById(connectionId);

    assert.equal(result.skipped, true);
    assert.equal(result.retainedConnectionStatus, testStatus);
    assert.equal(stored?.testStatus, testStatus);
    assert.equal(stored?.lastError, `durable ${testStatus}`);
    assert.equal(stored?.lastErrorAt, "2026-09-10T23:53:20.000Z");
  }

  assert.equal(fetchCalls, 0, "terminal background probes must not contact the provider");
});
