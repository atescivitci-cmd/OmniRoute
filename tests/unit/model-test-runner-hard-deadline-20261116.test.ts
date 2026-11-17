/**
 * runSingleModelTest must return at its deadline even when the upstream ignores the abort signal
 * (observed live: a probe with a 45 s timeout held a caller for about 168 s). Only the upstream
 * HTTP call is stubbed; the whole chat pipeline is real, on an isolated throwaway DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createProviderConnection } from "@/lib/db/providers";
import { runSingleModelTest } from "@/lib/api/modelTestRunner.ts";

const ok = () =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }), {
    headers: { "content-type": "application/json" },
  });

async function makeConnection(name: string) {
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: `sk-${name}`,
    isActive: true,
    testStatus: "active",
  });
  return String(connection.id);
}

test("returns slow at the deadline when the upstream ignores the abort signal", async () => {
  const connectionId = await makeConnection("hard-deadline-ignore-signal");
  const original = globalThis.fetch;
  // Warm the pipeline with a fast response so first-request setup cost is not counted.
  globalThis.fetch = (async () => ok()) as typeof fetch;
  await runSingleModelTest({
    providerId: "openai",
    modelId: "gpt-4o",
    connectionId,
    timeoutMs: 10_000,
  });

  // The upstream never looks at the signal and answers only after 4 s.
  globalThis.fetch = (async () => {
    await new Promise((r) => setTimeout(r, 4_000));
    return ok();
  }) as typeof fetch;
  try {
    const started = Date.now();
    const result = await runSingleModelTest({
      providerId: "openai",
      modelId: "gpt-4o",
      connectionId,
      timeoutMs: 1_000,
      hardDeadline: true,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.status, "slow", JSON.stringify(result));
    assert.equal(result.isTimeout, true);
    assert.ok(elapsed < 2_500, `returned after ${elapsed} ms, deadline was 1000 ms`);
  } finally {
    globalThis.fetch = original;
  }
});

test("returns slow at the deadline when headers arrive but the body never finishes", async () => {
  const connectionId = await makeConnection("hard-deadline-stalled-body");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ok()) as typeof fetch;
  await runSingleModelTest({
    providerId: "openai",
    modelId: "gpt-4o",
    connectionId,
    timeoutMs: 10_000,
  });

  globalThis.fetch = (async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        // Keep the stream open for 4 s, then finish with a valid event.
        setTimeout(() => {
          try {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n')
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            /* the reader was cancelled at the deadline, which is the point */
          }
        }, 4_000);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const started = Date.now();
    const result = await runSingleModelTest({
      providerId: "openai",
      modelId: "gpt-4o",
      connectionId,
      timeoutMs: 1_000,
      hardDeadline: true,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.status, "slow", JSON.stringify(result));
    assert.ok(elapsed < 2_500, `returned after ${elapsed} ms, deadline was 1000 ms`);
  } finally {
    globalThis.fetch = original;
  }
});

test("a fast answer still returns ok and the deadline timer does not leak", async () => {
  const connectionId = await makeConnection("hard-deadline-fast");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ok()) as typeof fetch;
  try {
    const result = await runSingleModelTest({
      providerId: "openai",
      modelId: "gpt-4o",
      connectionId,
      timeoutMs: 5_000,
      hardDeadline: true,
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
  } finally {
    globalThis.fetch = original;
  }
});

function trickleStream(chunks: string[], everyMs: number, totalMs: number) {
  const encoder = new TextEncoder();
  let i = 0;
  let timer: ReturnType<typeof setInterval>;
  return new Response(
    new ReadableStream({
      start(controller) {
        const started = Date.now();
        timer = setInterval(() => {
          if (Date.now() - started >= totalMs) {
            clearInterval(timer);
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
            );
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[i++ % chunks.length]));
        }, everyMs);
      },
      cancel() {
        clearInterval(timer);
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}

for (const [label, chunks] of [
  ["keepalive comments", [": keep-alive\n\n"]],
  ["reasoning-only deltas", ['data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n']],
  ["empty role deltas", ['data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n']],
] as const) {
  test(`returns slow at the deadline while the upstream trickles ${label}`, async () => {
    const connectionId = await makeConnection(
      `hard-deadline-trickle-${label.replace(/\W+/g, "-")}`
    );
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ok()) as typeof fetch;
    await runSingleModelTest({
      providerId: "openai",
      modelId: "gpt-4o",
      connectionId,
      timeoutMs: 10_000,
    });
    globalThis.fetch = (async () => trickleStream([...chunks], 200, 4_000)) as typeof fetch;
    try {
      const started = Date.now();
      const result = await runSingleModelTest({
        providerId: "openai",
        modelId: "gpt-4o",
        connectionId,
        timeoutMs: 1_000,
        hardDeadline: true,
      });
      const elapsed = Date.now() - started;
      assert.equal(result.status, "slow", `${JSON.stringify(result)} after ${elapsed} ms`);
      assert.ok(elapsed < 2_500, `returned after ${elapsed} ms, deadline was 1000 ms`);
    } finally {
      globalThis.fetch = original;
    }
  });
}

test("without hardDeadline the old meaning is kept: a stream that keeps delivering is read to the end", async () => {
  const connectionId = await makeConnection("hard-deadline-legacy");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ok()) as typeof fetch;
  await runSingleModelTest({
    providerId: "openai",
    modelId: "gpt-4o",
    connectionId,
    timeoutMs: 10_000,
  });
  globalThis.fetch = (async () =>
    trickleStream(
      ['data: {"choices":[{"delta":{"reasoning_content":"t"}}]}\n\n'],
      200,
      2_500
    )) as typeof fetch;
  try {
    const result = await runSingleModelTest({
      providerId: "openai",
      modelId: "gpt-4o",
      connectionId,
      timeoutMs: 1_000,
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
  } finally {
    globalThis.fetch = original;
  }
});

test("the hard deadline cancels the upstream stream instead of leaving it open", async () => {
  const connectionId = await makeConnection("hard-deadline-cancel");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ok()) as typeof fetch;
  await runSingleModelTest({
    providerId: "openai",
    modelId: "gpt-4o",
    connectionId,
    timeoutMs: 10_000,
  });
  let cancelled = false;
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval>;
    return new Response(
      new ReadableStream({
        start(controller) {
          timer = setInterval(
            () =>
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"t"}}]}\n\n')
              ),
            100
          );
        },
        cancel() {
          cancelled = true;
          clearInterval(timer);
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  }) as typeof fetch;
  try {
    const result = await runSingleModelTest({
      providerId: "openai",
      modelId: "gpt-4o",
      connectionId,
      timeoutMs: 800,
      hardDeadline: true,
    });
    assert.equal(result.status, "slow", JSON.stringify(result));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(cancelled, true, "upstream stream was not cancelled");
  } finally {
    globalThis.fetch = original;
  }
});
