import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRoutingTransportDispatch,
  assertRoutingTransportOutcome,
  createRoutingTransportAttempt,
  getRoutingTransportOutcome,
  hasRoutingTransportAttempt,
  runWithRoutingTransportAttempt,
  runWithRoutingTransportWire,
  stopRoutingTransportAttempt,
} from "../../../open-sse/services/routingTransportContext.ts";

test("standalone dispatch retains existing behavior", async () => {
  assert.equal(hasRoutingTransportAttempt(), false);
  let calls = 0;
  for (let i = 0; i < 2; i++) await runWithRoutingTransportWire(() => ++calls);
  assert.equal(calls, 2);
});

test("one model and one nested wire claim do not double count", async () => {
  const token = createRoutingTransportAttempt();
  const value = await runWithRoutingTransportAttempt(token, () =>
    runWithRoutingTransportWire(() => {
      assertRoutingTransportDispatch("wire");
      return "ok";
    })
  );
  assert.equal(value, "ok");
  assert.deepEqual(getRoutingTransportOutcome(token), {
    modelDispatches: 1,
    wireDispatches: 1,
    uncertain: false,
    cancelled: false,
    blocked: false,
  });
});

test("second model dispatch is blocked even when nested error is swallowed", async () => {
  const token = createRoutingTransportAttempt();
  let sends = 0;
  await assert.rejects(
    runWithRoutingTransportAttempt(token, async () => {
      await runWithRoutingTransportWire(() => ++sends);
      try {
        await runWithRoutingTransportWire(() => ++sends);
      } catch {}
      return "pretend success";
    }),
    { code: "routing_transport_replay_blocked" }
  );
  assert.equal(sends, 1);
});

test("wire-level retry is blocked inside a single model dispatch", async () => {
  const token = createRoutingTransportAttempt();
  let sends = 0;
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () =>
      runWithRoutingTransportWire(() => {
        assertRoutingTransportDispatch("wire");
        sends++;
        assertRoutingTransportDispatch("wire");
        sends++;
      })
    ),
    { code: "routing_transport_replay_blocked" }
  );
  assert.equal(sends, 1);
});

test("metadata outside explicit wire scope does not consume inference permit", async () => {
  const token = createRoutingTransportAttempt();
  await runWithRoutingTransportAttempt(token, async () => {
    assertRoutingTransportDispatch("wire");
    assertRoutingTransportDispatch("wire");
    await runWithRoutingTransportWire(() => assertRoutingTransportDispatch("wire"));
  });
  assert.equal(getRoutingTransportOutcome(token).wireDispatches, 1);
});

test("pre-abort prevents invocation", async () => {
  const ac = new AbortController();
  ac.abort();
  const token = createRoutingTransportAttempt({ signal: ac.signal });
  let calls = 0;
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => ++calls),
    { name: "AbortError" }
  );
  assert.equal(calls, 0);
});

test("error after invocation remains uncertain despite swallowed exception", async () => {
  const token = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(token, async () => {
      try {
        await runWithRoutingTransportWire(() => {
          throw new Error("fixture failure");
        });
      } catch {}
      return "ignored";
    }),
    { code: "routing_transport_execution_uncertain", execution: "unknown" }
  );
  assert.equal(getRoutingTransportOutcome(token).uncertain, true);
});

test("interleaved requests own independent permits", async () => {
  const tokens = [createRoutingTransportAttempt(), createRoutingTransportAttempt()];
  await Promise.all(
    tokens.map((token) =>
      runWithRoutingTransportAttempt(token, async () => {
        await Promise.resolve();
        return runWithRoutingTransportWire(() => assertRoutingTransportDispatch("wire"));
      })
    )
  );
  for (const token of tokens) assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
  assert.equal(hasRoutingTransportAttempt(), false);
});

test("detached stream callback retains token and cannot redispatch after response return", async () => {
  const token = createRoutingTransportAttempt();
  let release!: () => void;
  const later = new Promise<void>((r) => {
    release = r;
  });
  let continuation!: Promise<unknown>;
  await runWithRoutingTransportAttempt(token, async () => {
    await runWithRoutingTransportWire(() => "headers");
    continuation = later.then(() => runWithRoutingTransportWire(() => "forbidden"));
  });
  release();
  await assert.rejects(continuation, { code: "routing_transport_replay_blocked" });
  assert.throws(() => assertRoutingTransportOutcome(token), {
    code: "routing_transport_replay_blocked",
  });
});

test("explicit asynchronous callback stop stays bound to its captured token", async () => {
  const first = createRoutingTransportAttempt();
  const second = createRoutingTransportAttempt();
  await runWithRoutingTransportAttempt(first, () => assertRoutingTransportDispatch());
  await runWithRoutingTransportAttempt(second, () =>
    stopRoutingTransportAttempt("execution_uncertain", first)
  );
  assert.equal(getRoutingTransportOutcome(first).uncertain, true);
  assert.equal(getRoutingTransportOutcome(second).uncertain, false);
});

test("forged tokens are rejected", async () => {
  await assert.rejects(
    runWithRoutingTransportAttempt({} as never, () => "forbidden"),
    TypeError
  );
  assert.throws(() => assertRoutingTransportDispatch("model", {} as never), TypeError);
});
