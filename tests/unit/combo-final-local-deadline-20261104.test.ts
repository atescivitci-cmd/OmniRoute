import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HandleSingleModel } from "../../open-sse/services/combo/types.ts";

// Use reproduction/run-fixtures.py: its existing loader remaps the installed
// helper import to this source tree and blocks all unmocked JavaScript networking.
assert.ok(
  process.execArgv.some((arg) => arg.endsWith("/register-isolated-runtime.mjs")),
  "Run with the offline fixture loader; never import the installed production helper"
);
const previousDataDir = process.env.DATA_DIR;
const previousFetch = globalThis.fetch;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-final-local-deadline-"));
process.env.DATA_DIR = dataDir;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("fixture_network_forbidden");
};
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { createRoutingAttemptGuard, isRoutingTerminal, markKnownNonDispatch } =
  await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { LOCAL_ROUTE } = await import("../../open-sse/services/localFinalFallback.mjs");
const dbCore = await import("../../src/lib/db/core.ts");
// Keep one-time disposable schema setup outside the deliberately short deadlines.
dbCore.getDbInstance();
const log = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const originalBody = () => ({
  model: "ac-terminal-continuity",
  stream: false,
  messages: [
    { role: "system", content: "Keep every mandatory instruction." },
    { role: "user", content: "Full synthetic history, including older turns." },
    { role: "assistant", content: "Prior synthetic answer." },
    { role: "user", content: "Continue with the complete request." },
  ],
  tools: [{ type: "function", function: { name: "fixture_tool", parameters: { type: "object" } } }],
  instructions: "Preserve this separate instruction field.",
  max_tokens: 91,
});
const success = () => Response.json({ choices: [{ message: { content: "fixture answer" } }] });
const combo = (config: Record<string, unknown> = {}) => ({
  name: "ac-terminal-continuity",
  strategy: "priority",
  allowedProviders: ["openai", "ollama-local"],
  models: [{ model: "openai/gpt-4o" }],
  config: {
    finalLocalFallbackModel: LOCAL_ROUTE,
    zeroAdditionalCostProviders: ["ollama-local"],
    maxRetries: 0,
    maxSetRetries: 0,
    retryDelayMs: 0,
    fallbackDelayMs: 0,
    disableSessionStickiness: true,
    reasoningTokenBufferEnabled: false,
    ...config,
  },
});

test.afterEach(() => assert.equal(networkAttempts, 0));
test.after(async () => {
  await sleep(100); // Drain fixture-only asynchronous telemetry before closing SQLite.
  dbCore.resetDbInstance();
  globalThis.fetch = previousFetch;
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("actual final local: raw dispatcher gets the configured 50ms/100ms budgets", async () => {
  const body = originalBody();
  const attempts: unknown[] = [];
  let calls = 0;
  let childSignal: AbortSignal | undefined;
  const response = await handleComboChat({
    body,
    combo: combo({ targetTimeoutMs: 50, comboTimeoutMs: 100 }),
    settings: {},
    handleSingleModel: async (input, model, target) => {
      calls++;
      assert.deepEqual(input, body);
      assert.equal(model, LOCAL_ROUTE);
      childSignal = target?.modelAbortSignal;
      return new Promise<Response>((resolve) => {
        childSignal?.addEventListener("abort", () => resolve(success()), { once: true });
      });
    },
    isModelAvailable: async (model) => model === LOCAL_ROUTE,
    log: {
      ...log,
      info(tag, payload) {
        if (tag === "ROUTING_CHAIN" && JSON.parse(payload).event === "attempt")
          attempts.push(JSON.parse(payload));
      },
    },
  });
  assert.equal(response.status, 524);
  assert.equal((await response.json()).error.code, "target_timeout_execution_uncertain");
  assert.equal(isRoutingTerminal(response), true);
  assert.equal(childSignal?.aborted, true);
  assert.equal(calls, 1);
  assert.equal(attempts.length, 1);
});

test("actual final local: resolved headers/shared budgets stop one unchanged attempt", async (t) => {
  for (const scenario of [
    { name: "headers default", target: 40, whole: 500, preparation: 0 },
    { name: "remaining shared default", target: 500, whole: 180, preparation: 110 },
    { name: "earlier inherited deadline", target: 500, whole: 1000, preparation: 0, inherited: 70 },
  ]) {
    await t.test(scenario.name, { timeout: 2000 }, async () => {
      const body = originalBody();
      const before = structuredClone(body);
      const parent = new AbortController();
      const guard = createRoutingAttemptGuard({
        body,
        signal: parent.signal,
        limit: 3,
        ...(scenario.inherited ? { deadlineMs: Date.now() + scenario.inherited } : {}),
      });
      let calls = 0;
      let childSignal: AbortSignal | undefined;
      let release!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const raw: HandleSingleModel = async (input, model, target) => {
        calls++;
        assert.equal(model, LOCAL_ROUTE);
        assert.equal(target?.provider, "ollama-local");
        assert.deepEqual(input, before);
        childSignal = target?.modelAbortSignal;
        return pending;
      };
      const started = performance.now();
      try {
        const response = await handleComboChat({
          body,
          combo: combo(), // No raw timeout overrides: use the documented config cascade.
          settings: {
            comboDefaults: { targetTimeoutMs: scenario.target, comboTimeoutMs: scenario.whole },
          },
          handleSingleModel: guard.wrap(raw),
          isModelAvailable: async (model) => {
            if (model !== LOCAL_ROUTE) return false;
            await sleep(scenario.preparation);
            return true;
          },
          signal: parent.signal,
          log,
        });
        const elapsed = performance.now() - started;
        const headerLimited = scenario.target < (scenario.inherited ?? scenario.whole);
        assert.equal(response.status, headerLimited ? 524 : 504);
        assert.equal(
          (await response.json()).error.code,
          headerLimited ? "target_timeout_execution_uncertain" : "routing_deadline"
        );
        assert.equal(isRoutingTerminal(response), true);
        assert.equal(calls, 1);
        assert.equal(guard.attempts(), 1, "one owner charges local inference exactly once");
        assert.equal(childSignal?.aborted, true);
        assert.equal(parent.signal.aborted, false);
        assert.deepEqual(body, before);
        const originalBudget = scenario.inherited ?? Math.min(scenario.target, scenario.whole);
        assert.ok(
          elapsed < originalBudget + 60,
          `deadline did not reset after preparation: ${elapsed}ms`
        );
        // An uncertain outstanding local operation can never grant a new dispatch.
        const replay = await guard.wrap(raw)(body, LOCAL_ROUTE);
        assert.equal(isRoutingTerminal(replay), true);
        assert.equal(calls, 1);
        await replay.body?.cancel();
      } finally {
        release(success());
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
  }
});

test("actual final local: elapsed preparation cannot start inference after shared expiry", async () => {
  const body = originalBody();
  const guard = createRoutingAttemptGuard({ body, limit: 3 });
  let calls = 0;
  const response = await handleComboChat({
    body,
    combo: combo(),
    settings: { comboDefaults: { comboTimeoutMs: 30, targetTimeoutMs: 500 } },
    handleSingleModel: guard.wrap(async () => {
      calls++;
      return success();
    }),
    isModelAvailable: async (model) => {
      if (model !== LOCAL_ROUTE) return false;
      await sleep(65);
      return true;
    },
    log,
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "routing_deadline");
  assert.equal(isRoutingTerminal(response), true);
  assert.equal(calls, 0);
  assert.equal(guard.attempts(), 0);
});

test("actual final local: pending availability stops without a later dispatch", async (t) => {
  for (const mode of ["shared deadline", "caller", "inherited caller"]) {
    await t.test(mode, { timeout: 2000 }, async () => {
      const body = originalBody();
      const before = structuredClone(body);
      const parent = new AbortController();
      const inherited = new AbortController();
      const guard = createRoutingAttemptGuard({ body, signal: inherited.signal, limit: 3 });
      let releaseAvailability!: (available: boolean) => void;
      const availability = new Promise<boolean>((resolve) => {
        releaseAvailability = resolve;
      });
      let preparationStarted!: () => void;
      const preparation = new Promise<void>((resolve) => {
        preparationStarted = resolve;
      });
      let calls = 0;
      let settled = false;
      const request = handleComboChat({
        body,
        combo: combo(),
        settings: {
          comboDefaults: {
            targetTimeoutMs: 500,
            ...(mode === "shared deadline" ? { comboTimeoutMs: 40 } : {}),
          },
        },
        handleSingleModel: guard.wrap(async () => {
          calls++;
          return success();
        }),
        isModelAvailable: async (model) => {
          if (model !== LOCAL_ROUTE) return false;
          preparationStarted();
          return availability;
        },
        signal: parent.signal,
        log,
      });
      void request.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      try {
        await preparation;
        if (mode !== "shared deadline") {
          await sleep(20);
          (mode === "caller" ? parent : inherited).abort();
        }
        await sleep(100);
        assert.equal(settled, true, "a pending precheck must not outlive timeout/cancellation");
        const response = await request;
        assert.equal(response.status, mode === "shared deadline" ? 504 : 499);
        assert.equal(
          (await response.json()).error.code,
          mode === "shared deadline" ? "routing_deadline" : "request_cancelled"
        );
        assert.equal(isRoutingTerminal(response), true);
        assert.equal(calls, 0);
        assert.equal(guard.attempts(), 0);
        releaseAvailability(true);
        await sleep(20);
        assert.equal(calls, 0, "a late successful precheck cannot resume inference");
        assert.equal(guard.attempts(), 0);
        assert.deepEqual(body, before);
      } finally {
        releaseAvailability(true);
      }
    });
  }
});

test("actual final local: nested deadline bounds pending preparation and its late result", async (t) => {
  for (const parentTimeout of [0, 400]) {
    await t.test(`parent deadline ${parentTimeout}ms`, { timeout: 2000 }, async () => {
      const body = originalBody();
      const before = structuredClone(body);
      const guard = createRoutingAttemptGuard({ body, limit: 3 });
      const child = {
        name: "fixture-child",
        strategy: "priority",
        models: [{ model: "openai/gpt-4o" }],
        config: {
          comboTimeoutMs: 40,
          targetTimeoutMs: 500,
          maxRetries: 0,
          maxSetRetries: 0,
          disableSessionStickiness: true,
          reasoningTokenBufferEnabled: false,
        },
      };
      const parent = {
        ...combo({ comboTimeoutMs: parentTimeout, nestedComboMode: "execute" }),
        models: [{ kind: "combo-ref" as const, comboName: child.name }],
      };
      let releaseAvailability!: (available: boolean) => void;
      const availability = new Promise<boolean>((resolve) => {
        releaseAvailability = resolve;
      });
      let calls = 0;
      let localChecks = 0;
      let settled = false;
      const request = handleComboChat({
        body,
        combo: parent,
        settings: {},
        allCombos: [child, parent],
        handleSingleModel: guard.wrap(async () => {
          calls++;
          return success();
        }),
        isModelAvailable: async (model) => {
          if (model !== LOCAL_ROUTE) return false;
          localChecks++;
          return availability;
        },
        log,
      });
      void request.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      try {
        await sleep(100);
        assert.equal(
          localChecks,
          1,
          "the child rejected without dispatch, then local preparation began"
        );
        assert.ok(guard.deadline()! < Date.now(), "child tightened the original shared deadline");
        assert.equal(settled, true, "preparation uses the deadline tightened by the child combo");
        const response = await request;
        assert.equal(response.status, 504);
        assert.equal((await response.json()).error.code, "routing_deadline");
        assert.equal(isRoutingTerminal(response), true);
        assert.equal(calls, 0);
        assert.equal(guard.attempts(), 0);
        releaseAvailability(true);
        await sleep(20);
        assert.equal(calls, 0, "late availability cannot start local inference");
        assert.equal(guard.attempts(), 0);
        assert.deepEqual(body, before);
      } finally {
        releaseAvailability(true);
      }
    });
  }
});

test("actual final local: tightened nested deadline also cancels its response body", async () => {
  const body = { ...originalBody(), stream: true };
  const guard = createRoutingAttemptGuard({ body, limit: 3 });
  const child = {
    name: "fixture-child-body",
    strategy: "priority",
    models: [{ model: "openai/gpt-4o" }],
    config: { comboTimeoutMs: 80, targetTimeoutMs: 500, maxRetries: 0, maxSetRetries: 0 },
  };
  const parent = {
    ...combo({ comboTimeoutMs: 400, nestedComboMode: "execute" }),
    models: [{ kind: "combo-ref" as const, comboName: child.name }],
  };
  let calls = 0;
  let cancelled = 0;
  let childSignal: AbortSignal | undefined;
  const started = performance.now();
  const response = await handleComboChat({
    body,
    combo: parent,
    settings: {},
    allCombos: [child, parent],
    handleSingleModel: guard.wrap(async (input, model, target) => {
      calls++;
      assert.equal(model, LOCAL_ROUTE);
      assert.deepEqual(input, body);
      childSignal = target?.modelAbortSignal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          },
          cancel() {
            cancelled++;
          },
        })
      );
    }),
    isModelAvailable: async (model) => model === LOCAL_ROUTE,
    log,
  });
  assert.equal(response.status, 200);
  assert.equal(isRoutingTerminal(response), true);
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await assert.rejects(reader.read());
  assert.ok(performance.now() - started < 200, "the child deadline remains active during the body");
  assert.equal(childSignal?.aborted, true);
  assert.equal(cancelled, 1);
  assert.equal(calls, 1);
  assert.equal(guard.attempts(), 1);
});

test("actual final local: headers timeout does not limit availability without a whole deadline", async () => {
  const body = originalBody();
  const guard = createRoutingAttemptGuard({ body, limit: 3 });
  let releaseAvailability!: (available: boolean) => void;
  const availability = new Promise<boolean>((resolve) => {
    releaseAvailability = resolve;
  });
  let preparationStarted!: () => void;
  const preparation = new Promise<void>((resolve) => {
    preparationStarted = resolve;
  });
  let calls = 0;
  let settled = false;
  const request = handleComboChat({
    body,
    combo: combo({ targetTimeoutMs: 20 }),
    settings: {},
    handleSingleModel: guard.wrap(async (input, model) => {
      calls++;
      assert.deepEqual(input, body);
      assert.equal(model, LOCAL_ROUTE);
      return success();
    }),
    isModelAvailable: async (model) => {
      if (model !== LOCAL_ROUTE) return false;
      preparationStarted();
      return availability;
    },
    log,
  });
  void request.then(() => {
    settled = true;
  });
  try {
    await preparation;
    await sleep(65);
    assert.equal(settled, false, "the 20ms headers budget starts at inference dispatch");
    assert.equal(calls, 0);
    assert.equal(guard.attempts(), 0);
    releaseAvailability(true);
    const response = await request;
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls, 1);
    assert.equal(guard.attempts(), 1);
  } finally {
    releaseAvailability(true);
  }
});

test("actual final local: exhausted original attempt budget cannot be replaced", async () => {
  const body = originalBody();
  const guard = createRoutingAttemptGuard({ body, limit: 1 });
  const calls: string[] = [];
  const response = await handleComboChat({
    body,
    combo: combo({ targetTimeoutMs: 500 }),
    settings: {},
    handleSingleModel: guard.wrap(async (_body, model) => {
      calls.push(model);
      return markKnownNonDispatch(
        Response.json({ error: { code: "fixture_remote_unavailable" } }, { status: 503 })
      );
    }),
    isModelAvailable: async () => true,
    log,
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "routing_attempt_limit");
  assert.equal(isRoutingTerminal(response), true);
  assert.deepEqual(calls, ["openai/gpt-4o"]);
  assert.equal(guard.attempts(), 1);
});

test("actual final local: headers budget permits a longer successful stream", async () => {
  const body = { ...originalBody(), stream: true };
  const guard = createRoutingAttemptGuard({ body, limit: 1 });
  let childSignal: AbortSignal | undefined;
  let chunks = 0;
  const response = await handleComboChat({
    body,
    combo: combo({ targetTimeoutMs: 25 }),
    settings: {},
    handleSingleModel: guard.wrap(async (input, model, target) => {
      assert.deepEqual(input, body);
      assert.equal(model, LOCAL_ROUTE);
      childSignal = target?.modelAbortSignal;
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await sleep(15);
            if (chunks++ === 6) controller.close();
            else controller.enqueue(new TextEncoder().encode("data: fixture\n\n"));
          },
        })
      );
    }),
    isModelAvailable: async (model) => model === LOCAL_ROUTE,
    log,
  });
  assert.equal(response.status, 200);
  assert.equal(
    isRoutingTerminal(response),
    true,
    "response wrapper preserves commit classification"
  );
  const started = performance.now();
  assert.equal((await response.text()).match(/data: fixture/g)?.length, 6);
  assert.ok(performance.now() - started > 75);
  assert.equal(childSignal?.aborted, false);
  assert.equal(guard.attempts(), 1);
});

test("actual final local: shared deadline and caller abort remain bound after headers", async (t) => {
  for (const mode of ["shared", "caller", "inherited caller"]) {
    await t.test(mode, { timeout: 2000 }, async () => {
      const body = { ...originalBody(), stream: true };
      const parent = new AbortController();
      const guard = createRoutingAttemptGuard({ body, signal: parent.signal, limit: 2 });
      let calls = 0;
      let cancelled = 0;
      let childSignal: AbortSignal | undefined;
      const response = await handleComboChat({
        body,
        combo: combo({
          targetTimeoutMs: 25,
          ...(mode === "shared" ? { comboTimeoutMs: 100 } : {}),
        }),
        settings: {},
        handleSingleModel: guard.wrap(async (_input, _model, target) => {
          calls++;
          childSignal = target?.modelAbortSignal;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              },
              cancel() {
                cancelled++;
              },
            })
          );
        }),
        isModelAvailable: async (model) => model === LOCAL_ROUTE,
        signal: mode === "inherited caller" ? new AbortController().signal : parent.signal,
        log,
      });
      assert.equal(response.status, 200);
      assert.equal(isRoutingTerminal(response), true);
      const reader = response.body!.getReader();
      assert.equal((await reader.read()).done, false);
      if (mode !== "shared") parent.abort();
      await assert.rejects(reader.read(), {
        name: mode === "shared" ? "TimeoutError" : "AbortError",
      });
      assert.equal(childSignal?.aborted, true);
      assert.equal(cancelled, 1);
      assert.equal(calls, 1);
      assert.equal(guard.attempts(), 1);
    });
  }
});
