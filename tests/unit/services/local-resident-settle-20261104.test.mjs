import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOCAL_MODEL,
  DEFAULT_LOCAL_ORIGIN,
  RESIDENT_METADATA_BUDGET_MS,
  waitForResidentCapacity,
  assertSameCapacity,
} from "../../../open-sse/services/localContext.mjs";
import {
  executeNativeLocal,
  buildNativeRequest,
} from "../../../open-sse/services/localFinalFallback.mjs";
import {
  prepareLocalContinuation,
  prepareResidentContinuation,
  inferWithArchive,
  continuationFailure,
} from "../../../open-sse/services/localArchiveContinuation.mjs";

const originalFetch = globalThis.fetch;
let unqualifiedNetworkCalls = 0;
globalThis.fetch = async () => {
  unqualifiedNetworkCalls++;
  throw new Error("fixture_network_forbidden");
};
test.afterEach(() => assert.equal(unqualifiedNetworkCalls, 0));
test.after(() => {
  globalThis.fetch = originalFetch;
});
const capacity = Object.freeze({
  model: LOCAL_MODEL,
  origin: DEFAULT_LOCAL_ORIGIN,
  context: 65536,
  digest: "07d35212591fc27746f0a317c975a6d68754fb38e9053d82e25f06057af28522",
});
const modelRow = (value = capacity) => ({
  name: value.model,
  digest: value.digest,
  context_length: value.context,
});
const metadata = (models) => Response.json({ models });
const reason = (value) => (error) => {
  assert.equal(error.code, "local_context_unavailable");
  assert.equal(error.details.reason, value);
  assert.equal(error.details.execution_outcome, "not_dispatched");
  return true;
};
function clockFixture() {
  let tick = 0;
  const pauses = [];
  return {
    now: () => tick,
    pause: async (ms, signal) => {
      signal.throwIfAborted();
      pauses.push(ms);
      tick += ms;
    },
    advance: (ms) => {
      tick += ms;
    },
    pauses,
  };
}
const assertPs = (url, init) => {
  assert.equal(url, DEFAULT_LOCAL_ORIGIN + "/api/ps");
  assert.equal(init.method, "GET");
  assert.equal(init.cache, "no-store");
};

test("resident settle re-observes only absence and returns exact current metadata", async () => {
  const clock = clockFixture();
  let gets = 0;
  const result = await waitForResidentCapacity(
    undefined,
    async (url, init) => {
      assertPs(url, init);
      gets++;
      return metadata(gets === 1 ? [] : [modelRow()]);
    },
    undefined,
    clock
  );
  assert.deepEqual(result, capacity);
  assert.equal(gets, 2);
  assert.deepEqual(clock.pauses, [250]);
});

test("resident settle does not retry ambiguous, malformed or unavailable metadata", async () => {
  for (const [next, expected] of [
    [() => metadata([modelRow(), modelRow()]), "model_residency_ambiguous"],
    [() => metadata([{ ...modelRow(), digest: "malformed" }]), "invalid_resident_metadata"],
    [() => metadata(null), "invalid_resident_metadata"],
    [() => Response.json({ error: "fixture" }, { status: 503 }), "resident_metadata_unavailable"],
    [
      () => {
        throw new DOMException("fixture", "TimeoutError");
      },
      "resident_metadata_timeout",
    ],
  ]) {
    let gets = 0;
    const clock = clockFixture();
    await assert.rejects(
      waitForResidentCapacity(
        undefined,
        async () => (++gets === 1 ? metadata([]) : next()),
        undefined,
        clock
      ),
      reason(expected)
    );
    assert.equal(gets, 2);
    assert.equal(clock.pauses.length, 1);
  }
});

test("post-settle digest or capacity drift still fails the existing exact binding", async () => {
  for (const change of [{ digest: "f".repeat(64) }, { context: 131072 }]) {
    const clock = clockFixture();
    let gets = 0;
    const observed = await waitForResidentCapacity(
      undefined,
      async () => metadata(++gets === 1 ? [] : [modelRow({ ...capacity, ...change })]),
      undefined,
      clock
    );
    assert.throws(
      () => assertSameCapacity(capacity, observed),
      reason("resident_capacity_changed")
    );
    assert.equal(gets, 2);
  }
});

test("resident settle has one 3s total budget including successful metadata body", async () => {
  const clock = clockFixture();
  let gets = 0;
  await assert.rejects(
    waitForResidentCapacity(
      undefined,
      async () => {
        gets++;
        if (gets === 1) {
          clock.advance(1000);
          return metadata([]);
        }
        return {
          ok: true,
          json: async () => {
            clock.advance(1751);
            return { models: [modelRow()] };
          },
        };
      },
      undefined,
      clock
    ),
    reason("resident_settle_timeout")
  );
  assert.equal(gets, 2);
  assert.equal(clock.now(), 3001);
  assert.equal(RESIDENT_METADATA_BUDGET_MS, 3000);
});

test("all absence observations terminate within original budget without model dispatch", async () => {
  const clock = clockFixture();
  let gets = 0;
  await assert.rejects(
    waitForResidentCapacity(
      undefined,
      async (url, init) => {
        assertPs(url, init);
        gets++;
        return metadata([]);
      },
      undefined,
      clock
    ),
    reason("resident_settle_timeout")
  );
  assert.ok(gets <= 13);
  assert.ok(clock.now() <= 3000);
});

test("non-advancing fixture clock cannot create an unbounded observation loop", async () => {
  let gets = 0;
  await assert.rejects(
    waitForResidentCapacity(
      undefined,
      async () => {
        gets++;
        return metadata([]);
      },
      undefined,
      { now: () => 0, pause: async () => {} }
    ),
    reason("resident_settle_timeout")
  );
  assert.equal(gets, 13);
});

test("invalid or expanded budget refuses before any metadata call", async () => {
  for (const budgetMs of [0, NaN, Infinity, 3001]) {
    let gets = 0;
    await assert.rejects(
      waitForResidentCapacity(
        undefined,
        async () => {
          gets++;
          return metadata([]);
        },
        undefined,
        { budgetMs }
      ),
      reason("resident_metadata_budget_invalid")
    );
    assert.equal(gets, 0);
  }
});

test("caller cancellation before or during wait is terminal without another observation", async () => {
  const before = new AbortController();
  before.abort();
  let gets = 0;
  await assert.rejects(
    waitForResidentCapacity(
      undefined,
      async () => {
        gets++;
        return metadata([]);
      },
      before.signal
    ),
    { name: "AbortError" }
  );
  assert.equal(gets, 0);
  const during = new AbortController(),
    cancelled = new DOMException("fixture cancellation", "AbortError");
  await assert.rejects(
    waitForResidentCapacity(
      undefined,
      async () => {
        gets++;
        return metadata([]);
      },
      during.signal,
      {
        pause: async () => {
          during.abort(cancelled);
        },
      }
    ),
    (error) => error === cancelled
  );
  assert.equal(gets, 1);
});

test(
  "metadata body that ignores cancellation cannot extend the settle waiter",
  { timeout: 1000 },
  async () => {
    let gets = 0;
    await assert.rejects(
      waitForResidentCapacity(
        undefined,
        async () => {
          gets++;
          return { ok: true, json: () => new Promise(() => {}) };
        },
        undefined,
        { budgetMs: 15 }
      ),
      reason("resident_metadata_timeout")
    );
    assert.equal(gets, 1);
  }
);

test(
  "an absent observation followed by a stalled metadata body remains bounded",
  { timeout: 1000 },
  async () => {
    let gets = 0;
    await assert.rejects(
      waitForResidentCapacity(
        undefined,
        async () => {
          gets++;
          return gets === 1 ? metadata([]) : { ok: true, json: () => new Promise(() => {}) };
        },
        undefined,
        { budgetMs: 15, pause: async () => {} }
      ),
      reason("resident_settle_timeout")
    );
    assert.equal(gets, 2);
  }
);

test("actual native entry settles once, preserves input and physical context, then sends once", async () => {
  let gets = 0,
    posts = 0;
  const original = {
    messages: [
      { role: "system", content: "mandatory fixture policy" },
      { role: "user", content: "complete current fixture input" },
    ],
    max_tokens: 320,
    tools: [
      {
        type: "function",
        function: {
          name: "fixture_tool",
          parameters: {
            type: "object",
            properties: { arg: { type: "string" } },
            required: ["arg"],
          },
        },
      },
    ],
  };
  const result = await executeNativeLocal(
    { model: LOCAL_MODEL, body: original, stream: false, clientHeaders: {} },
    {
      buildUrl: () => DEFAULT_LOCAL_ORIGIN + "/v1/chat/completions",
      transformRequest: (_model, body) => body,
    },
    async (url, init) => {
      if (init.method === "GET") {
        assertPs(url, init);
        gets++;
        return metadata(gets === 1 ? [] : [modelRow()]);
      }
      assert.equal(url, DEFAULT_LOCAL_ORIGIN + "/api/chat");
      assert.equal(init.method, "POST");
      posts++;
      const sent = JSON.parse(init.body);
      assert.deepEqual(sent.messages, original.messages);
      assert.deepEqual(sent.tools, original.tools);
      assert.equal(
        sent.options.num_ctx,
        65536,
        "do not shrink a larger physical context to the small logical output budget"
      );
      assert.equal(sent.options.num_predict, 320);
      assert.equal(sent.shift, false);
      assert.equal(sent.truncate, false);
      return Response.json({
        done: true,
        message: { role: "assistant", content: "fixture result" },
        eval_count: 1,
        prompt_eval_count: 10,
      });
    }
  );
  assert.equal(result.response.status, 200);
  assert.equal(gets, 3);
  assert.equal(posts, 1);
  assert.equal(original.max_tokens, 320);
});

test("actual native entry never dispatches after its exact post-settle capacity changes", async () => {
  let gets = 0,
    posts = 0;
  const result = await executeNativeLocal(
    {
      model: LOCAL_MODEL,
      body: { messages: [{ role: "user", content: "fixture" }], max_tokens: 320 },
      stream: false,
    },
    {
      buildUrl: () => DEFAULT_LOCAL_ORIGIN + "/v1/chat/completions",
      transformRequest: (_model, body) => body,
    },
    async (_url, init) => {
      if (init.method !== "GET") {
        posts++;
        throw new Error("must not dispatch");
      }
      gets++;
      return metadata([modelRow(gets === 1 ? capacity : { ...capacity, context: 131072 })]);
    }
  );
  assert.equal(result.response.status, 503);
  assert.equal(posts, 0);
  assert.equal((await result.response.json()).error.details.reason, "resident_capacity_changed");
});

test("archive planning accepts caller cancellation before tokenizer or archive work", async () => {
  const controller = new AbortController();
  controller.abort();
  let gets = 0,
    counters = 0;
  await assert.rejects(
    prepareResidentContinuation(
      {},
      {},
      {},
      async () => {
        gets++;
        return metadata([]);
      },
      "/unused-fixture",
      {
        signal: controller.signal,
        counterFactory: () => {
          counters++;
          throw new Error("must not run");
        },
      }
    ),
    { name: "AbortError" }
  );
  assert.equal(gets, 0);
  assert.equal(counters, 0);
});

test("signed archive refuses a larger changed resident instead of silently shrinking or rebinding", async () => {
  const parent = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "local-archive-residency-fixture-")
  );
  const root = path.join(parent, "archive");
  try {
    const headers = new Headers({
      "x-session-id": "fixture-session",
      authorization: "Bearer SYNTHETIC_FIXTURE_ONLY",
    });
    const original = {
      messages: [{ role: "user", content: "mandatory fixture task" }],
      max_tokens: 320,
    };
    const prepared = prepareLocalContinuation(
      original,
      { id: "fixture-owner" },
      headers,
      root,
      capacity,
      () => 1,
      true
    );
    headers.set("x-omniroute-local-archive", prepared.token);
    const request = buildNativeRequest({ stream: false }, prepared.body, capacity);
    let gets = 0,
      posts = 0,
      counters = 0;
    const response = await inferWithArchive(
      request,
      { clientHeaders: headers, stream: false },
      DEFAULT_LOCAL_ORIGIN + "/api/chat",
      async (url, init) => {
        if (init.method !== "GET") {
          posts++;
          throw new Error("must not dispatch");
        }
        assertPs(url, init);
        gets++;
        return metadata([modelRow({ ...capacity, context: 131072 })]);
      },
      root,
      () => {
        counters++;
        throw new Error("must not rebind tokenizer");
      }
    );
    assert.equal(response.status, 422);
    assert.match((await response.json()).error.message, /archive_invalid_context_limit/);
    assert.equal(gets, 1);
    assert.equal(posts, 0);
    assert.equal(counters, 0);
    assert.equal(request.options.num_ctx, 65536);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("settle failures retain bounded diagnostic details through public archive projection", async () => {
  let captured;
  try {
    await waitForResidentCapacity(undefined, async () => metadata([]), undefined, {
      now: () => 0,
      pause: async () => {},
    });
  } catch (error) {
    captured = error;
  }
  const projected = continuationFailure(captured);
  assert.equal(projected.status, 503);
  assert.deepEqual(projected.error.details, {
    reason: "resident_settle_timeout",
    failure_phase: "admission",
    execution_outcome: "not_dispatched",
  });
});
