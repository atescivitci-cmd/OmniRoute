/**
 * A probe's deadline must reach the upstream request while it is still waiting for headers.
 *
 * Live, a slow upstream kept the connection (and the probe's 499 usage row) for 127 to 288 s
 * although the probe returned at its 45 s deadline. Cause: Node makes a Request follow its input
 * AbortSignal through a WeakRef to the original Request's controller, the chat route rebuilds
 * the request and drops the original, and once the original is garbage collected a later abort
 * never reaches the pipeline. This test forces collection so the failure is deterministic; a
 * stubbed upstream that ignores its abort signal (as the other canary tests do) cannot see it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { createProviderConnection } from "@/lib/db/providers";
import { getDbInstance } from "@/lib/db/core";
import { createDefaultRoutingEvidenceCanaryDeps } from "@/lib/services/routingEvidenceCanary.ts";
import { USAGE_SOURCE_ROUTING_CANARY } from "@/shared/constants/usageSource";

// Load the chat route and its fetch wrapper BEFORE the upstream stub is installed.
await import("@/lib/api/modelTestRunner.ts");

v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc") as () => void;

test("the probe deadline aborts an upstream that is still waiting to send headers, even after GC", async () => {
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "abort-propagation",
    apiKey: "sk-abort-propagation",
    isActive: true,
    testStatus: "active",
  });
  const connectionId = String(connection.id);
  const original = globalThis.fetch;
  const startedAt = { value: 0 };
  let upstreamAbortedAtMs: number | null = null;
  let upstreamCalled = false;

  globalThis.fetch = (async (_input: unknown, init: { signal?: AbortSignal } = {}) => {
    upstreamCalled = true;
    return new Promise<Response>((resolve, reject) => {
      // A real network stack aborts the request when its signal fires; so does this stub.
      const timer = setTimeout(
        () =>
          resolve(
            new Response(
              JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
              { headers: { "content-type": "application/json" } }
            )
          ),
        6000
      );
      init.signal?.addEventListener(
        "abort",
        () => {
          upstreamAbortedAtMs = Date.now() - startedAt.value;
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true }
      );
    });
  }) as typeof fetch;

  try {
    const deps = createDefaultRoutingEvidenceCanaryDeps();
    startedAt.value = Date.now();
    const probe = deps.runProbe({
      provider: "openai",
      model: "gpt-4o",
      modelStr: "openai/gpt-4o",
      connectionId,
      prompt: "Routing probe.",
      maxTokens: 64,
      timeoutMs: 1500,
    });

    // Once the upstream request is pending, collect garbage repeatedly. Anything that is only
    // weakly reachable, such as the original Request, is gone after this.
    for (let i = 0; i < 40 && !upstreamCalled; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(upstreamCalled, true, "the probe reached the upstream");
    for (let i = 0; i < 4; i++) {
      collectGarbage();
      await new Promise((r) => setTimeout(r, 20));
    }

    const outcome = await probe;
    assert.equal(outcome.ok, false, "a probe that hit its deadline is not ok");

    // The abort reaches the upstream request at the deadline, not when the upstream answers.
    for (let i = 0; i < 20 && upstreamAbortedAtMs === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.notEqual(upstreamAbortedAtMs, null, "the upstream request never saw the abort");
    assert.ok(
      (upstreamAbortedAtMs as number) < 3500,
      `upstream abort arrived after ${upstreamAbortedAtMs} ms (deadline 1500 ms, upstream answer 6000 ms)`
    );

    // The pipeline writes no usage row when it is cancelled before any response, so the probe
    // records the timeout itself: one failure row at the deadline, tagged as a probe, in place
    // of the row that used to appear only when the upstream finally answered.
    const db = getDbInstance();
    await new Promise((r) => setTimeout(r, 800));
    const rows = db
      .prepare(
        "SELECT status, success, latency_ms, error_code, source FROM usage_history WHERE connection_id = ?"
      )
      .all(connectionId) as Array<{
      status: string;
      success: number;
      latency_ms: number;
      error_code: string | null;
      source: string | null;
    }>;
    assert.equal(rows.length, 1, `expected one failure row, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0].success, 0);
    assert.equal(rows[0].status, "504");
    assert.equal(rows[0].error_code, "probe_deadline");
    assert.equal(rows[0].source, USAGE_SOURCE_ROUTING_CANARY);
    assert.ok(
      rows[0].latency_ms < 3000,
      `failure row latency ${rows[0].latency_ms} ms; should be about the 1500 ms deadline`
    );
  } finally {
    globalThis.fetch = original;
  }
});
