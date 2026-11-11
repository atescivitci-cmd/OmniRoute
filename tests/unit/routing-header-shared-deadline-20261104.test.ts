import test from "node:test";
import assert from "node:assert/strict";
import { buildTargetTimeoutRunner } from "../../open-sse/services/combo/targetTimeoutRunner.ts";
import { isRoutingTerminal } from "../../open-sse/services/combo/routingAttemptSafety.ts";

const log = { info() {}, warn() {}, debug() {} };
const input = { messages: [{ role: "user", content: "synthetic" }], stream: true };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("active stream completes beyond headers budget with no whole-combo deadline", async () => {
  let child: AbortSignal | undefined;
  let sends = 0,
    cancelled = 0,
    count = 0;
  const run = buildTargetTimeoutRunner({
    comboTargetTimeoutMs: 50,
    log,
    handleSingleModel: async (body, model, target) => {
      sends++;
      child = target?.modelAbortSignal;
      assert.deepEqual(body, input);
      assert.equal(model, "fixture/model");
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              await sleep(10);
              if (++count <= 16) controller.enqueue(new TextEncoder().encode("x"));
              else controller.close();
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 }
        )
      );
    },
  });
  const started = Date.now();
  const response = await run(input, "fixture/model");
  assert.equal(await response.text(), "x".repeat(16));
  assert.ok(Date.now() - started > 100);
  assert.equal(child?.aborted, false);
  assert.equal(cancelled, 0);
  assert.equal(sends, 1);
});

test("caller abort survives an already expired headers budget", async () => {
  const parent = new AbortController();
  let child: AbortSignal | undefined,
    cancellations = 0;
  const run = buildTargetTimeoutRunner({
    comboTargetTimeoutMs: 10,
    signal: parent.signal,
    log,
    handleSingleModel: async (_b, _m, target) => {
      child = target?.modelAbortSignal;
      return new Response(
        new ReadableStream({
          cancel() {
            cancellations++;
          },
        })
      );
    },
  });
  const response = await run(input, "fixture/model");
  await sleep(30);
  assert.equal(child?.aborted, false);
  const pending = response.text();
  parent.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(child?.aborted, true);
  assert.equal(cancellations, 1);
});

test("explicit original whole-combo deadline ends an active body after headers", async () => {
  let child: AbortSignal | undefined,
    cancellations = 0,
    chunks = 0;
  const started = Date.now();
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const run = buildTargetTimeoutRunner({
      comboTargetTimeoutMs: 25,
      deadlineMs: started + 90,
      log,
      handleSingleModel: async (_b, _m, target) => {
        child = target?.modelAbortSignal;
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                await sleep(10);
                if (!child?.aborted) {
                  chunks++;
                  controller.enqueue(new Uint8Array([120]));
                }
              },
              cancel() {
                cancellations++;
              },
            },
            { highWaterMark: 0 }
          )
        );
      },
    });
    const response = await run(input, "fixture/model");
    await assert.rejects(response.text(), { name: "TimeoutError", message: "routing_deadline" });
    assert.ok(Date.now() - started >= 60);
    assert.ok(chunks > 2);
    assert.equal(child?.aborted, true);
    assert.equal(cancellations, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("both timers clean up on EOF without aborting completed upstream", async () => {
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  const active = new Set<ReturnType<typeof setTimeout>>();
  let created = 0;
  globalThis.setTimeout = ((fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const handle = originalSet(fn, delay, ...args);
    active.add(handle);
    created++;
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: any) => {
    active.delete(handle);
    return originalClear(handle);
  }) as typeof clearTimeout;
  let child: AbortSignal | undefined;
  try {
    const run = buildTargetTimeoutRunner({
      comboTargetTimeoutMs: 500,
      deadlineMs: Date.now() + 800,
      log,
      handleSingleModel: async (_b, _m, target) => {
        child = target?.modelAbortSignal;
        return new Response("complete");
      },
    });
    const response = await run(input, "fixture/model");
    assert.equal(created, 2);
    assert.equal(active.size, 1);
    assert.equal(await response.text(), "complete");
    assert.equal(active.size, 0);
    assert.equal(child?.aborted, false);
  } finally {
    active.forEach(originalClear);
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});

test("shared deadline cleanup is bounded when upstream cancellation stalls", async () => {
  let child: AbortSignal | undefined,
    cancellations = 0;
  const keepAlive = setTimeout(() => {}, 300);
  try {
    const run = buildTargetTimeoutRunner({
      comboTargetTimeoutMs: 10,
      deadlineMs: Date.now() + 35,
      log,
      handleSingleModel: async (_b, _m, target) => {
        child = target?.modelAbortSignal;
        return new Response(
          new ReadableStream({
            cancel() {
              cancellations++;
              return new Promise(() => {});
            },
          })
        );
      },
    });
    const response = await run(input, "fixture/model");
    await assert.rejects(response.text(), { name: "TimeoutError" });
    assert.equal(child?.aborted, true);
    assert.equal(cancellations, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("expired shared deadline refuses before any provider dispatch", async () => {
  let sends = 0;
  const run = buildTargetTimeoutRunner({
    comboTargetTimeoutMs: 100,
    deadlineMs: Date.now() - 1,
    log,
    handleSingleModel: async () => {
      sends++;
      return new Response("unused");
    },
  });
  const response = await run(input, "fixture/model");
  assert.equal(response.status, 504);
  assert.equal(isRoutingTerminal(response), true);
  assert.equal(sends, 0);
});

test("event-loop-delayed headers are rejected before switching to body phase", async () => {
  let child: AbortSignal | undefined,
    cancellations = 0;
  const run = buildTargetTimeoutRunner({
    comboTargetTimeoutMs: 10,
    log,
    handleSingleModel: async (_b, _m, target) => {
      child = target?.modelAbortSignal;
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* synthetic blocked event loop */
      }
      return new Response(
        new ReadableStream({
          cancel() {
            cancellations++;
          },
        })
      );
    },
  });
  const response = await run(input, "fixture/model");
  assert.equal(response.status, 524);
  assert.equal(isRoutingTerminal(response), true);
  assert.equal(child?.aborted, true);
  assert.equal(cancellations, 1);
});

test("nested earlier whole deadline retains trusted classification through outer body wrapper", async () => {
  const keepAlive = setTimeout(() => {}, 500);
  let sends = 0,
    cancellations = 0;
  let child: AbortSignal | undefined;
  try {
    const inner = buildTargetTimeoutRunner({
      comboTargetTimeoutMs: 20,
      deadlineMs: Date.now() + 60,
      log,
      handleSingleModel: async (_b, _m, target) => {
        sends++;
        child = target?.modelAbortSignal;
        return new Response(
          new ReadableStream({
            cancel() {
              cancellations++;
            },
          })
        );
      },
    });
    const outer = buildTargetTimeoutRunner({
      comboTargetTimeoutMs: 0,
      deadlineMs: Date.now() + 400,
      log,
      handleSingleModel: inner,
    });
    const response = await outer(input, "fixture/model");
    await assert.rejects(response.text(), { name: "TimeoutError", message: "routing_deadline" });
    assert.equal(sends, 1);
    assert.equal(cancellations, 1);
    assert.equal(child?.aborted, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("upstream exception cannot impersonate trusted lifecycle classification", async () => {
  const run = buildTargetTimeoutRunner({
    comboTargetTimeoutMs: 20,
    log,
    handleSingleModel: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new DOMException("private upstream prose", "TimeoutError"));
          },
        })
      ),
  });
  const response = await run(input, "fixture/model");
  await assert.rejects(response.text(), {
    name: "NetworkError",
    message: "Upstream response body failed",
  });
});
