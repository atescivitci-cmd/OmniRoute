import test from "node:test";
import assert from "node:assert/strict";
import {
  readResidentCapacity,
  validateCapacity,
  assertSameCapacity,
  assertNativeCapacity,
  LOCAL_MODEL,
  DEFAULT_LOCAL_ORIGIN,
} from "../../../open-sse/services/localContext.mjs";
import {
  createNativeTokenCounter,
  inspectAllocation,
  guardedLocalFetch,
} from "../../../open-sse/services/localTokenBudget.mjs";
import { continuationFailure } from "../../../open-sse/services/localArchiveContinuation.mjs";

const GiB = 1024 ** 3;
const capacity = Object.freeze({
  model: LOCAL_MODEL,
  origin: DEFAULT_LOCAL_ORIGIN,
  context: 16384,
  digest: "07d35212591fc27746f0a317c975a6d68754fb38e9053d82e25f06057af28522",
});
const resident = { name: LOCAL_MODEL, context_length: capacity.context, digest: capacity.digest };
const metadata = (models) => async () => Response.json({ models });
const hasReason =
  (reason, phase = "admission", outcome = "not_dispatched") =>
  (error) => {
    assert.equal(error.status, 503);
    assert.deepEqual(error.details, { reason, failure_phase: phase, execution_outcome: outcome });
    return true;
  };

test("resident admission distinguishes zero and ambiguous matches without dispatch", async () => {
  await assert.rejects(
    readResidentCapacity(undefined, metadata([])),
    hasReason("model_not_resident")
  );
  await assert.rejects(
    readResidentCapacity(undefined, metadata([resident, resident])),
    hasReason("model_residency_ambiguous")
  );
  assert.deepEqual(await readResidentCapacity(undefined, metadata([resident])), capacity);
});

test("resident metadata remains exact and capacity changes still refuse", async () => {
  await assert.rejects(
    readResidentCapacity(undefined, metadata([{ ...resident, digest: "bad" }])),
    hasReason("invalid_resident_metadata")
  );
  assert.throws(
    () => validateCapacity({ ...capacity, origin: "http://remote.invalid" }),
    hasReason("non_loopback_endpoint")
  );
  assert.throws(
    () => assertSameCapacity(capacity, { ...capacity, context: 32768 }),
    hasReason("resident_capacity_changed")
  );
  assert.throws(
    () =>
      assertNativeCapacity(
        {
          messages: [{ role: "user", content: "x".repeat(16384) }],
          options: { num_ctx: 16384, num_predict: 320 },
        },
        capacity
      ),
    { code: "local_context_capacity_exceeded" }
  );
});

test("cancelled resident inspection never fetches and preserves caller reason", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancel", "AbortError");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(
    readResidentCapacity(
      undefined,
      async () => {
        calls++;
      },
      controller.signal
    ),
    (e) => e === reason
  );
  assert.equal(calls, 0);
});

test("resident cancellation during metadata body and timeout are distinct", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancel", "AbortError");
  await assert.rejects(
    readResidentCapacity(
      undefined,
      async () => ({
        ok: true,
        json: async () => {
          controller.abort(reason);
          return { models: [resident] };
        },
      }),
      controller.signal
    ),
    (e) => e === reason
  );
  await assert.rejects(
    readResidentCapacity(undefined, async () => {
      throw new DOMException("fixture", "TimeoutError");
    }),
    hasReason("resident_metadata_timeout")
  );
  await assert.rejects(
    readResidentCapacity(undefined, async () => {
      throw new Error("private fixture marker");
    }),
    hasReason("resident_metadata_unavailable")
  );
});

const gguf =
  "/Users/atescivitci/.ollama/models/blobs/sha256-f5ee307a2982106a6eb82b62b2c00b575c9072145a759ae4660378acda8dcf2d";
function executionFixture({
  swap = 0,
  free = 50,
  rss = 16 * GiB,
  pages = 4_000_000,
  rows = 1,
  processing = false,
  cache = true,
} = {}) {
  return (file) => {
    if (file === "/usr/bin/vm_stat")
      return `Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: ${pages}.\nPages inactive: 0.\nPages speculative: 0.\n`;
    if (file === "/usr/bin/memory_pressure") return `System-wide memory free percentage: ${free}%`;
    if (file === "/usr/sbin/sysctl")
      return `vm.swapusage: total = 1024M used = 0M free = ${swap}M (encrypted)`;
    if (file === "/usr/sbin/lsof") return "111\n";
    if (file === "/bin/ps")
      return Array.from(
        { length: rows },
        (_, i) =>
          `${process.getuid()} ${222 + i} 111 ${rss / 1024} /fixture/runner --model ${gguf} --port 12345 ${cache ? "--cache-type-k q4_0 --cache-type-v q4_0" : ""}`
      ).join("\n");
    if (file === "/usr/bin/curl") return JSON.stringify([{ is_processing: processing }]);
    throw new Error("unexpected fixture executable");
  };
}

test("zero and low allocated free swap remain admitted with adequate actual resources", () => {
  for (const swap of [0, 1, 473.25]) {
    const result = inspectAllocation(capacity, capacity.context, {
      execute: executionFixture({ swap }),
    });
    assert.equal(result.swap_free_bytes, swap * 1024 ** 2);
    assert.equal(result.target_context, capacity.context);
  }
});

test("real memory pressure, RAM, RSS and growth checks retain their refusal", () => {
  for (const [config, reason] of [
    [{ free: 14 }, "resource_memory_pressure"],
    [{ pages: 1000 }, "resource_memory_headroom"],
    [{ rss: 31 * GiB }, "resource_rss_limit"],
    [{ rows: 0 }, "allocation_runner_unverified"],
  ])
    assert.throws(
      () => inspectAllocation(capacity, capacity.context, { execute: executionFixture(config) }),
      hasReason(reason)
    );
  for (const config of [{ processing: true }, { cache: false }]) {
    assert.throws(
      () => inspectAllocation(capacity, 32768, { execute: executionFixture(config) }),
      hasReason("allocation_growth_unverified")
    );
  }
});

test("exact model digest admission remains mandatory before any inspection", () => {
  let calls = 0;
  const execute = () => {
    calls++;
    throw new Error("must not inspect");
  };
  assert.throws(
    () => createNativeTokenCounter({ ...capacity, digest: "f".repeat(64) }, { execute }),
    hasReason("local_identity_unverified")
  );
  assert.throws(
    () => inspectAllocation({ ...capacity, digest: "f".repeat(64) }, 16384, { execute }),
    hasReason("local_identity_unverified")
  );
  assert.equal(calls, 0);
});

function guardFixture(
  sample = () => ({ available_bytes: 10 * GiB, free_percent: 50, rss_bytes: 16 * GiB })
) {
  let tick,
    cleanups = 0,
    inspections = 0;
  const options = {
    inspect: () => {
      inspections++;
      return { rss_bytes: 16 * GiB, increment_upper_bound_bytes: GiB };
    },
    sample,
    schedule: (fn) => {
      tick = fn;
      return 42;
    },
    cancel: (timer) => {
      assert.equal(timer, 42);
      cleanups++;
    },
  };
  return { options, tick: () => tick(), cleanups: () => cleanups, inspections: () => inspections };
}
const runGuard = (fetcher, fixture, signal) =>
  guardedLocalFetch(
    "http://fixture.invalid/api/chat",
    { method: "POST", body: "fixture only", signal },
    capacity,
    capacity,
    fetcher,
    fixture.options
  );

test("pre-dispatch cancellation makes zero inspections and zero sends", async () => {
  const c = new AbortController();
  c.abort();
  const fixture = guardFixture();
  let sends = 0;
  await assert.rejects(
    runGuard(
      async () => {
        sends++;
      },
      fixture,
      c.signal
    ),
    { name: "AbortError" }
  );
  assert.equal(sends, 0);
  assert.equal(fixture.inspections(), 0);
  assert.equal(fixture.cleanups(), 0);
});

test("cancellation during inspection still prevents transport", async () => {
  const c = new AbortController(),
    fixture = guardFixture();
  let sends = 0;
  const original = fixture.options.inspect;
  fixture.options.inspect = () => {
    const value = original();
    c.abort();
    return value;
  };
  await assert.rejects(
    runGuard(
      async () => {
        sends++;
      },
      fixture,
      c.signal
    ),
    { name: "AbortError" }
  );
  assert.equal(sends, 0);
  assert.equal(fixture.cleanups(), 0);
});

test("caller cancellation during transport or body remains cancellation, once cleanup", async () => {
  for (const atBody of [false, true]) {
    const c = new AbortController(),
      fixture = guardFixture();
    const reason = new DOMException("caller cancellation", "AbortError");
    const fetcher = async () => {
      if (!atBody) {
        c.abort(reason);
        throw reason;
      }
      return {
        ok: true,
        json: async () => {
          c.abort(reason);
          return { message: { content: "must not release" } };
        },
      };
    };
    await assert.rejects(runGuard(fetcher, fixture, c.signal), (e) => e === reason);
    assert.equal(fixture.cleanups(), 1);
  }
});

test("runtime monitor reasons are bounded and do not claim provider timeout or nondispatch", async () => {
  for (const [sample, reason] of [
    [
      () => ({ available_bytes: GiB, free_percent: 50, rss_bytes: 16 * GiB }),
      "runtime_memory_headroom",
    ],
    [
      () => ({ available_bytes: 10 * GiB, free_percent: 14, rss_bytes: 16 * GiB }),
      "runtime_memory_pressure",
    ],
    [
      () => ({ available_bytes: 10 * GiB, free_percent: 50, rss_bytes: 31 * GiB }),
      "runtime_rss_limit",
    ],
    [
      () => ({ available_bytes: NaN, free_percent: 50, rss_bytes: 16 * GiB }),
      "runtime_resource_metadata_invalid",
    ],
    [
      () => {
        throw new Error("PRIVATE_EXCEPTION_MARKER");
      },
      "runtime_resource_verification_unavailable",
    ],
  ]) {
    const fixture = guardFixture(sample);
    let sends = 0;
    const fetcher = async (_url, init) => {
      sends++;
      fixture.tick();
      init.signal.throwIfAborted();
    };
    let caught;
    await assert.rejects(runGuard(fetcher, fixture), (e) => {
      caught = e;
      return hasReason(reason, "runtime_monitor", "uncertain")(e);
    });
    const publicFailure = continuationFailure(caught);
    assert.deepEqual(publicFailure.error.details, caught.details);
    assert.equal(publicFailure.status, 503);
    assert.doesNotMatch(
      JSON.stringify(publicFailure),
      /PRIVATE_EXCEPTION_MARKER|provider timeout|No inference was dispatched/
    );
    assert.equal(sends, 1);
    assert.equal(fixture.cleanups(), 1);
  }
});

test("transport and body failures remain uncertain with no retry", async () => {
  for (const [stage, reason] of [
    ["network", "backend_connection_failed"],
    ["body", "backend_response_failed"],
    ["timeout", "backend_timeout"],
  ]) {
    let sends = 0;
    const fixture = guardFixture();
    const fetcher = async () => {
      sends++;
      if (stage === "body")
        return {
          ok: true,
          json: async () => {
            throw new Error("private fixture body");
          },
        };
      if (stage === "timeout") throw new DOMException("fixture deadline", "TimeoutError");
      throw new Error("private fixture connection");
    };
    await assert.rejects(runGuard(fetcher, fixture), hasReason(reason, "transport", "uncertain"));
    assert.equal(sends, 1);
    assert.equal(fixture.cleanups(), 1);
  }
});

test("successful body and upstream non-OK retain existing outcomes, once cleanup", async () => {
  for (const status of [200, 400]) {
    const fixture = guardFixture(),
      response = Response.json({ message: { content: "fixture" } }, { status });
    const result = await runGuard(async () => response, fixture);
    assert.equal(result.status, status);
    assert.deepEqual(await result.json(), { message: { content: "fixture" } });
    assert.equal(fixture.cleanups(), 1);
  }
});

test("archive failure projection preserves cancellation and strips unapproved detail keys", () => {
  for (const name of ["AbortError", "TimeoutError"]) {
    const error = new DOMException("fixture", name);
    assert.throws(
      () => continuationFailure(error),
      (e) => e === error
    );
  }
  const error = Object.assign(new Error("static message"), {
    code: "local_context_unavailable",
    details: {
      reason: "model_not_resident",
      failure_phase: "admission",
      execution_outcome: "not_dispatched",
      private: "PRIVATE_DETAIL_MARKER",
    },
  });
  assert.deepEqual(continuationFailure(error).error.details, {
    reason: "model_not_resident",
    failure_phase: "admission",
    execution_outcome: "not_dispatched",
  });
  error.details.reason = "PRIVATE_REASON_MARKER";
  assert.equal(continuationFailure(error).error.details, undefined);
});
