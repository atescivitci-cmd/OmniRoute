import test from "node:test";
import assert from "node:assert/strict";
import { buildTargetTimeoutRunner } from "../../open-sse/services/combo/targetTimeoutRunner.ts";
import {
  isRoutingTerminal,
  markRoutingTerminal,
} from "../../open-sse/services/combo/routingAttemptSafety.ts";
const log = { info() {}, warn() {}, debug() {} };
const body = { messages: [{ role: "user", content: "fixture" }], stream: true };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(
  options: {
    timeout?: number;
    deadlineMs?: number;
    signal?: AbortSignal;
    response?: () => Response;
  } = {}
) {
  let signal: AbortSignal | undefined;
  let sends = 0;
  let cancellations = 0;
  let source: ReadableStreamDefaultController<Uint8Array>;
  const run = buildTargetTimeoutRunner({
    log,
    signal: options.signal,
    comboTargetTimeoutMs: options.timeout ?? 0,
    deadlineMs: options.deadlineMs,
    handleSingleModel: async (_body, _model, target) => {
      sends++;
      signal = target?.modelAbortSignal;
      return (
        options.response?.() ??
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              source = c;
            },
            cancel() {
              cancellations++;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        )
      );
    },
  });
  return {
    run,
    get signal() {
      return signal!;
    },
    get sends() {
      return sends;
    },
    get cancellations() {
      return cancellations;
    },
    get source() {
      return source!;
    },
  };
}
for (const origin of ["target", "request"] as const)
  test(`post-headers ${origin} abort reaches upstream and open body`, async () => {
    const parent = new AbortController();
    const f = fixture({ signal: origin === "request" ? parent.signal : undefined });
    const res = await f.run(
      body,
      "fixture/model",
      origin === "target" ? { modelAbortSignal: parent.signal } : undefined
    );
    assert.equal(res.status, 200);
    const pending = res.body!.getReader().read();
    parent.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await tick();
    assert.equal(f.signal.aborted, true);
    assert.equal(f.cancellations, 1);
    assert.equal(f.sends, 1);
  });
test("either distinct request/target abort cancels the same child once", async () => {
  const outer = new AbortController(),
    target = new AbortController();
  const f = fixture({ signal: outer.signal });
  const res = await f.run(body, "fixture/model", { modelAbortSignal: target.signal });
  const pending = res.body!.getReader().read();
  outer.abort();
  target.abort();
  await assert.rejects(pending);
  await tick();
  assert.equal(f.cancellations, 1);
});
test("consumer body cancel reaches upstream and removes parent listener", async () => {
  const parent = new AbortController();
  const f = fixture({ signal: parent.signal });
  const res = await f.run(body, "fixture/model");
  await res.body!.cancel();
  parent.abort();
  await tick();
  assert.equal(f.signal.aborted, true);
  assert.equal(f.cancellations, 1);
});
test("EOF releases the parent link without aborting completed upstream", async () => {
  const parent = new AbortController();
  const f = fixture({ signal: parent.signal });
  const res = await f.run(body, "fixture/model");
  f.source.enqueue(new TextEncoder().encode("ok"));
  f.source.close();
  assert.equal(await res.text(), "ok");
  parent.abort();
  assert.equal(f.signal.aborted, false);
  assert.equal(f.cancellations, 0);
});
test("stream read failure cleans up and never dispatches twice", async () => {
  const parent = new AbortController();
  const f = fixture({ signal: parent.signal });
  const res = await f.run(body, "fixture/model");
  const pending = res.text();
  f.source.error(new Error("fixture-private-source-error"));
  await assert.rejects(pending, { name: "NetworkError", message: "Upstream response body failed" });
  parent.abort();
  assert.equal(f.signal.aborted, true);
  assert.equal(f.sends, 1);
});
test("explicit whole-combo deadline remains active after headers", async () => {
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const f = fixture({ timeout: 10, deadlineMs: Date.now() + 40 });
    const res = await f.run(body, "fixture/model");
    assert.equal(res.status, 200);
    await assert.rejects(res.text(), { name: "TimeoutError" });
    assert.equal(f.signal.aborted, true);
    assert.equal(f.sends, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});
test("caller cancellation before consuming any bytes still aborts upstream", async () => {
  const parent = new AbortController();
  const f = fixture({ signal: parent.signal });
  const res = await f.run(body, "fixture/model");
  parent.abort();
  assert.equal(f.signal.aborted, true);
  await assert.rejects(res.text(), { name: "AbortError" });
});
test("null response body cleans up immediately", async () => {
  const parent = new AbortController();
  const f = fixture({ signal: parent.signal, response: () => new Response(null, { status: 204 }) });
  const res = await f.run(body, "fixture/model");
  assert.equal(res.status, 204);
  parent.abort();
  assert.equal(f.signal.aborted, false);
});
test("response wrapper preserves trusted process-local terminal classification", async () => {
  const f = fixture({
    response: () =>
      markRoutingTerminal(Response.json({ error: { code: "fixture" } }, { status: 503 })),
  });
  const res = await f.run(body, "fixture/model");
  assert.equal(isRoutingTerminal(res), true);
  await res.body!.cancel();
});
test("late response after preheaders timeout is cancelled without another dispatch", async () => {
  let child: AbortSignal;
  let release: (r: Response) => void;
  let cancelled = 0;
  const run = buildTargetTimeoutRunner({
    log,
    comboTargetTimeoutMs: 10,
    handleSingleModel: async (_b, _m, t) => {
      child = t!.modelAbortSignal!;
      return new Promise((r) => {
        release = r;
      });
    },
  });
  const result = await run(body, "fixture/model");
  assert.equal(result.status, 524);
  assert.equal(child!.aborted, true);
  release!(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      })
    )
  );
  await tick();
  assert.equal(cancelled, 1);
});
test("upstream cancellation that stalls does not stall local cleanup", async () => {
  let child: AbortSignal;
  const parent = new AbortController();
  const run = buildTargetTimeoutRunner({
    log,
    comboTargetTimeoutMs: 0,
    signal: parent.signal,
    handleSingleModel: async (_b, _m, t) => {
      child = t!.modelAbortSignal!;
      return new Response(
        new ReadableStream({
          cancel() {
            return new Promise(() => {});
          },
        })
      );
    },
  });
  const result = await run(body, "fixture/model");
  await result.body!.cancel();
  parent.abort();
  assert.equal(child!.aborted, true);
});

test("parent abort listener survives headers and is removed at EOF", async () => {
  const parent = new AbortController();
  let links = 0;
  const add = parent.signal.addEventListener.bind(parent.signal),
    remove = parent.signal.removeEventListener.bind(parent.signal);
  parent.signal.addEventListener = ((type: any, cb: any, options: any) => {
    if (type === "abort") links++;
    return add(type, cb, options);
  }) as any;
  parent.signal.removeEventListener = ((type: any, cb: any, options: any) => {
    if (type === "abort") links--;
    return remove(type, cb, options);
  }) as any;
  const f = fixture({ signal: parent.signal });
  const response = await f.run(body, "fixture/model");
  assert.equal(links, 1);
  f.source.close();
  await response.text();
  assert.equal(links, 0);
});

test("fallback closes prior error body through timeout response wrapper", async () => {
  const { createRoutingAttemptGuard } =
    await import("../../open-sse/services/combo/routingAttemptSafety.ts");
  let sends = 0,
    cancels = 0;
  const guard = createRoutingAttemptGuard({ body: { messages: [] }, limit: 3 });
  const run = buildTargetTimeoutRunner({
    log,
    comboTargetTimeoutMs: 0,
    handleSingleModel: guard.wrap(async () => {
      sends++;
      return sends === 1
        ? new Response(
            new ReadableStream({
              cancel() {
                cancels++;
              },
            }),
            { status: 503, headers: { "content-type": "text/plain" } }
          )
        : Response.json({ choices: [{ message: { content: "OK" } }] });
    }),
  });
  const first = await run({ messages: [] }, "fixture/a");
  assert.equal(first.status, 503);
  const second = await run({ messages: [] }, "fixture/b");
  await tick();
  assert.equal(cancels, 1);
  assert.equal(sends, 2);
  await second.body!.cancel();
});

test("body wrapper preserves observed response URL/type/redirect metadata", async () => {
  const upstream = Response.json({ ok: true });
  Object.defineProperties(upstream, {
    url: { value: "https://fixture.invalid/result" },
    redirected: { value: true },
    type: { value: "basic" },
  });
  const f = fixture({ response: () => upstream });
  const res = await f.run(body, "fixture/model");
  assert.equal(res.url, upstream.url);
  assert.equal(res.type, upstream.type);
  assert.equal(res.redirected, upstream.redirected);
  await res.body!.cancel();
});
