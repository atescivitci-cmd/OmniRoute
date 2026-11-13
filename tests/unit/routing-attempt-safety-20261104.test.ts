import test from "node:test";
import assert from "node:assert/strict";
import {
  createRoutingAttemptGuard,
  inspectReplayInput,
  isRoutingTerminal,
  markKnownNonDispatch,
} from "../../open-sse/services/combo/routingAttemptSafety.ts";
import { buildTargetTimeoutRunner } from "../../open-sse/services/combo/targetTimeoutRunner.ts";
import {
  assertRoutingTransportDispatch,
  stopRoutingTransportAttempt,
} from "../../open-sse/services/routingTransportContext.ts";

const body = { messages: [{ role: "user", content: "fixture" }] };
const err = (status = 400, code = "invalid_request") =>
  Response.json({ error: { code } }, { status });
const ok = () => Response.json({ choices: [{ message: { content: "OK" } }] });
const log = { info() {}, warn() {} };
const guard = (input = body, options = {}) =>
  createRoutingAttemptGuard({ body: input, limit: 3, ...options });

test("pre-cancelled request sends zero", async () => {
  const c = new AbortController();
  c.abort();
  let n = 0;
  await assert.rejects(
    guard(body, { signal: c.signal }).wrap(async () => {
      n++;
      return ok();
    })(body, "p/a")
  );
  assert.equal(n, 0);
});
for (const status of [400, 401, 403, 422])
  test(`generic ${status} is terminal`, async () => {
    let n = 0;
    const run = guard().wrap(async () => {
      n++;
      return err(status);
    });
    assert.equal(isRoutingTerminal(await run(body, "p/a")), true);
    await run(body, "p/b");
    assert.equal(n, 1);
  });
for (const code of ["model_not_found", "account_model_ineligible", "context_length_exceeded"])
  test(`${code} may advance, never repeat target`, async () => {
    let n = 0;
    const run = guard().wrap(async () => {
      n++;
      return n === 1 ? err(400, code) : ok();
    });
    await run(body, "p/a");
    await run(body, "p/a");
    const result = await run(body, "p/b");
    assert.equal(n, 2);
    assert.equal(result.status, 200);
  });
test("known predispatch rejection can advance ordinary text", async () => {
  let n = 0;
  const run = guard().wrap(async () => {
    n++;
    return markKnownNonDispatch(err(503));
  });
  await run(body, "p/a");
  await run(body, "p/b");
  assert.equal(n, 2);
});
for (const input of [
  { ...body, previous_response_id: "opaque" },
  { messages: [{ role: "assistant", content: [{ type: "thinking", signature: "opaque" }] }] },
  { ...body, tools: [{ type: "web_search_preview" }] },
])
  test("provider-bound state forbids automatic provider switch", async () => {
    let n = 0;
    const run = guard(input as any).wrap(async () => {
      n++;
      return err(400, "model_not_found");
    });
    await run(input, "p/a");
    await run(input, "q/b");
    assert.equal(n, 1);
  });
test("tool output prose cannot grant replay permission", () => {
  assert.deepEqual(
    inspectReplayInput({
      messages: [{ role: "tool", tool_call_id: "x", content: '{"safe":true}' }],
    }),
    { providerBound: false, hasTools: true }
  );
});
test("uncertain tool request is not replayed", async () => {
  const input = { ...body, tools: [{ type: "function", function: { name: "charge" } }] };
  let n = 0;
  const run = guard(input as any).wrap(async () => {
    n++;
    return err(503);
  });
  await run(input, "p/a");
  await run(input, "q/b");
  assert.equal(n, 1);
});
test("completed200 is never redispatched even if caller rejects its content", async () => {
  let n = 0;
  const run = guard().wrap(async () => {
    n++;
    return ok();
  });
  await run(body, "p/a");
  await run(body, "q/b");
  assert.equal(n, 1);
});
test("thrown transport failure stops unknown execution", async () => {
  let n = 0;
  const run = guard().wrap(async () => {
    n++;
    throw new Error("PRIVATE");
  });
  const result = await run(body, "p/a");
  await run(body, "q/b");
  assert.equal(n, 1);
  assert.equal(isRoutingTerminal(result), true);
  assert.doesNotMatch(await result.text(), /PRIVATE/);
});
test("swallowed nested executor retry is sticky", async () => {
  let n = 0;
  const run = guard().wrap(async (_b, _m, target: any) => {
    n++;
    target.routingAttemptToken.enter();
    try {
      target.routingAttemptToken.enter();
    } catch {}
    return ok();
  });
  const r = await run(body, "p/a");
  await run(body, "p/b");
  assert.equal(n, 1);
  assert.equal(r.status, 502);
});
test("swallowed physical retry and uncertainty cannot conceal success", async () => {
  for (const fail of [
    () => {
      assertRoutingTransportDispatch();
      try {
        assertRoutingTransportDispatch();
      } catch {}
    },
    () => stopRoutingTransportAttempt("execution_uncertain"),
  ]) {
    let n = 0;
    const run = guard().wrap(async () => {
      n++;
      fail();
      return ok();
    });
    const r = await run(body, "p/a");
    await run(body, "p/b");
    assert.equal(n, 1);
    assert.equal(r.status, 502);
  }
});
test("shared dispatch budget includes alternate/local-like targets", async () => {
  let n = 0;
  const run = guard(body, { limit: 2 }).wrap(async () => {
    n++;
    return err(503);
  });
  await run(body, "a/one");
  await run(body, "b/two");
  const r = await run(body, "ollama-local/fixture");
  assert.equal(n, 2);
  assert.equal(r.status, 503);
  assert.equal(isRoutingTerminal(r), true);
});
test("expired deadline and Retry-After stop before another dispatch", async () => {
  let n = 0;
  const expired = guard(body, { deadlineMs: Date.now() - 1 }).wrap(async () => {
    n++;
    return ok();
  });
  await expired(body, "p/a");
  assert.equal(n, 0);
  const run = guard().wrap(async () => {
    n++;
    return new Response("{}", { status: 429, headers: { "Retry-After": "60" } });
  });
  await run(body, "p/a");
  const r = await run(body, "p/a");
  assert.equal(n, 1);
  assert.equal(r.status, 429);
  assert.ok(r.headers.has("retry-after"));
});
test("deadline does not claim pending worker was cancelled", async () => {
  let n = 0;
  let release!: (value: Response) => void;
  const g = guard();
  const run = buildTargetTimeoutRunner({
    log,
    comboTargetTimeoutMs: 5,
    handleSingleModel: g.wrap(async () => {
      n++;
      return new Promise<Response>((r) => {
        release = r;
      });
    }),
  });
  const r = await run(body, "p/a");
  assert.equal(n, 1);
  assert.equal(r.status, 524);
  assert.equal(isRoutingTerminal(r), true);
  release(ok());
});
test("zero configured timeout still preserves cancellation and synchronous failures", async () => {
  const c = new AbortController();
  const run = buildTargetTimeoutRunner({
    log,
    comboTargetTimeoutMs: 0,
    handleSingleModel: async () => new Promise<Response>(() => {}),
  });
  const pending = run(body, "p/a", { modelAbortSignal: c.signal });
  setTimeout(() => c.abort(), 5);
  assert.equal((await pending).status, 499);
  const throws = buildTargetTimeoutRunner({
    log,
    comboTargetTimeoutMs: 0,
    handleSingleModel: (() => {
      throw new Error("PRIVATE");
    }) as any,
  });
  const response = await throws(body, "p/a");
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /PRIVATE/);
});
test("diagnostics are bounded static metadata, sink exceptions do not alter result", async () => {
  const events: any[] = [];
  const g = guard(body, {
    requestId: "valid-id",
    emit: (e: any) => {
      events.push(e);
      throw new Error();
    },
  });
  g.event({ event: "skip", reason: "blocked", prompt: "PRIVATE", model: "bad\nsecret" });
  const result = await g.wrap(async () => ok())(body, "p/a");
  assert.equal(result.status, 200);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|secret/);
});

test("Retry-After is target scoped, not an unrelated-provider veto", async () => {
  let calls = 0;
  const run = guard().wrap(async () => {
    calls++;
    return calls === 1
      ? new Response("{}", { status: 429, headers: { "Retry-After": "30" } })
      : ok();
  });
  await run(body, "a/model");
  assert.equal((await run(body, "b/other")).status, 200);
  assert.equal(calls, 2);
});
test("blocked event loop cannot turn an overdue result into success", async () => {
  const run = buildTargetTimeoutRunner({
    log,
    comboTargetTimeoutMs: 5,
    handleSingleModel: async () => {
      const until = Date.now() + 25;
      while (Date.now() < until) {}
      return ok();
    },
  });
  assert.equal((await run(body, "p/a")).status, 524);
});
test("auxiliary handoff is a distinct one-attempt operation, never cached user output", async () => {
  const g = guard(body, { limit: 2 });
  let calls = 0;
  const dispatch = async (value: any) => {
    calls++;
    return Response.json({ value: value.messages[0].content });
  };
  const primary = await g.wrap(dispatch)(body, "p/a");
  const auxiliary = await g.auxiliary(dispatch)(
    { messages: [{ role: "user", content: "handoff fixture" }] },
    "p/a"
  );
  assert.equal((await auxiliary.json()).value, "handoff fixture");
  assert.equal((await primary.json()).value, "fixture");
  await g.auxiliary(dispatch)(body, "p/a");
  assert.equal(calls, 2);
});
test("unreadable error body preserves uncertain execution", async () => {
  let calls = 0;
  const run = guard().wrap(async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error("PRIVATE"));
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  });
  const r = await run(body, "p/a");
  await run(body, "p/b");
  assert.equal(calls, 1);
  assert.equal(isRoutingTerminal(r), true);
});

test("stalled JSON error body returns bounded static terminal response", async () => {
  let cancelled = 0;
  const run = guard().wrap(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      )
  );
  const response = await run(body, "p/a");
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "error_body_deadline");
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelled, 1);
});

test("auxiliary handoff retains target timeout and shared deadline", async () => {
  const g = guard(body, { limit: 3 });
  await g.wrap(async () => ok())(body, "p/a");
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const run = buildTargetTimeoutRunner({
    log,
    comboTargetTimeoutMs: 5,
    deadlineMs: g.deadline(),
    handleSingleModel: g.auxiliary(async () => pending),
  });
  const response = await run(body, "p/a");
  assert.equal(response.status, 524);
  release(ok());
  const elapsed = guard();
  elapsed.restrictTimeout(1);
  await new Promise((r) => setTimeout(r, 3));
  let sent = false;
  assert.equal(
    (
      await elapsed.wrap(async () => {
        sent = true;
        return ok();
      })(body, "p/a")
    ).status,
    504
  );
  assert.equal(sent, false);
});

// Tool-request rate limit: a 429 is the provider declining admission before any
// generation, so no tool operation can have run. The next target may be tried.
const toolBody = { ...body, tools: [{ type: "function", function: { name: "charge" } }] };
const rateLimited = (headers: Record<string, string> = {}) =>
  Response.json(
    { error: { type: "rate_limit_error", message: "would exceed your account's rate limit" } },
    { status: 429, headers }
  );
test("rate-limited tool request advances to the next target", async () => {
  const seen: string[] = [];
  const run = guard(toolBody).wrap(async (_b, model) => {
    seen.push(model);
    return model === "p/a" ? rateLimited() : ok();
  });
  assert.equal((await run(toolBody, "p/a")).status, 429);
  const second = await run(toolBody, "q/b");
  assert.deepEqual(seen, ["p/a", "q/b"]);
  assert.equal(second.status, 200);
});
test("rate-limited tool target is not re-dispatched while its Retry-After holds", async () => {
  let n = 0;
  const run = guard(toolBody).wrap(async () => {
    n++;
    return rateLimited({ "Retry-After": "60" });
  });
  await run(toolBody, "p/a");
  const again = await run(toolBody, "p/a");
  assert.equal(n, 1);
  assert.equal(again.status, 429);
});
test("tool request still stops on statuses that do not prove non-execution", async () => {
  for (const status of [408, 500, 502, 503, 504]) {
    let n = 0;
    const run = guard(toolBody).wrap(async () => {
      n++;
      return err(status, "upstream_error");
    });
    await run(toolBody, "p/a");
    await run(toolBody, "q/b");
    assert.equal(n, 1, `status ${status} must not be replayed for a tool request`);
  }
});
test("unqualified native-function 429 keeps its own stricter stop for tool requests", async () => {
  let n = 0;
  const run = guard(toolBody).wrap(async () => {
    n++;
    return rateLimited();
  });
  await run(toolBody, "nvidia/fixture-model");
  await run(toolBody, "q/b");
  assert.equal(n, 1);
});
test("provider-bound tool continuation is not moved by a rate limit", async () => {
  const bound = { ...toolBody, previous_response_id: "resp_fixture" };
  if (!inspectReplayInput(bound).providerBound) return;
  let n = 0;
  const run = guard(bound).wrap(async () => {
    n++;
    return rateLimited();
  });
  await run(bound, "p/a");
  await run(bound, "q/b");
  assert.equal(n, 1);
});
