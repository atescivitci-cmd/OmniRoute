import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Must be set before importing actual router modules. No live database or fetch.
const originalDataDir = process.env.DATA_DIR;
const originalFetch = globalThis.fetch;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-replay-independent-"));
process.env.DATA_DIR = dataDir;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("fixture_network_forbidden");
};
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { createRoutingAttemptGuard, routingFailure, isRoutingTerminal } =
  await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { finalLocalFallback, LOCAL_ROUTE } =
  await import("../../open-sse/services/localFinalFallback.mjs");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { clearCooldownState } = await import("../../open-sse/services/providerCooldownTracker.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
const dbCore = await import("../../src/lib/db/core.ts");

const log = { info() {}, warn() {}, error() {}, debug() {} };
const body = () => ({
  stream: false,
  messages: [{ role: "user", content: "nonpersonal fixture" }],
});
const success = () =>
  Response.json({
    choices: [{ message: { role: "assistant", content: "fixture answer" }, finish_reason: "stop" }],
  });
const failure = (status: number, code: string, details?: Record<string, unknown>) =>
  Response.json(
    {
      error: {
        type: "upstream_error",
        message: "fixture rejection",
        code,
        ...(details ? { details } : {}),
      },
    },
    { status }
  );
const models = ["openai/gpt-4o", "anthropic/claude-sonnet-4"];
let seq = 0;
function options(handleSingleModel: any, overrides: Record<string, any> = {}) {
  const config = overrides.config ?? {};
  const { config: _unused, ...other } = overrides;
  return {
    body: body(),
    combo: {
      name: `independent-replay-${seq++}`,
      strategy: "priority",
      models: models.map((model) => ({ model })),
      config: {
        maxRetries: 0,
        maxSetRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        disableSessionStickiness: true,
        reasoningTokenBufferEnabled: false,
        ...config,
      },
    },
    handleSingleModel,
    isModelAvailable: async () => true,
    log,
    settings: {},
    ...other,
  };
}
test.beforeEach(() => {
  resetAllCircuitBreakers();
  clearCooldownState();
  clearAllModelLockouts();
  networkAttempts = 0;
});
test.afterEach(() => {
  assert.equal(networkAttempts, 0, "no real network permitted");
});
test.after(async () => {
  // Drain the existing fire-and-forget fixture telemetry before deleting its DB.
  await new Promise((resolve) => setTimeout(resolve, 100));
  dbCore.resetDbInstance?.();
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("actual combo: cancelled before entry makes zero provider calls", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    handleComboChat(
      options(
        async () => {
          calls++;
          return success();
        },
        { signal: controller.signal }
      )
    ),
    { name: "AbortError" }
  );
  assert.equal(calls, 0);
});

test("actual combo: generic 400 is terminal but explicit model rejection can advance", async () => {
  for (const code of ["invalid_request", "model_not_found"]) {
    const calls: string[] = [];
    const result = await handleComboChat(
      options(async (_body: unknown, model: string) => {
        calls.push(model);
        return calls.length === 1 ? failure(400, code) : success();
      })
    );
    assert.equal(result.status, code === "invalid_request" ? 400 : 200);
    assert.equal(calls.length, code === "invalid_request" ? 1 : 2);
    await result.text();
  }
});

test(
  "actual combo: pending target timeout stops without a second attempt",
  { timeout: 2000 },
  async () => {
    let release!: (response: Response) => void;
    let calls = 0;
    let lateCancelled = 0;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const result = await handleComboChat(
      options(
        async () => {
          calls++;
          return pending;
        },
        { config: { targetTimeoutMs: 15 } }
      )
    );
    assert.equal(result.status, 524);
    assert.equal((await result.json()).error.code, "target_timeout_execution_uncertain");
    assert.equal(calls, 1);
    release(
      new Response(
        new ReadableStream({
          cancel() {
            lateCancelled++;
          },
        })
      )
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lateCancelled, 1, "late worker response is cleaned up");
  }
);

test(
  "actual combo: caller cancellation while pending does not replay",
  { timeout: 2000 },
  async () => {
    const controller = new AbortController();
    let calls = 0;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const request = handleComboChat(
      options(
        async () => {
          calls++;
          controller.abort();
          return pending;
        },
        { signal: controller.signal, config: { targetTimeoutMs: 50 } }
      )
    );
    const result = await request;
    assert.equal(result.status, 499);
    assert.equal(calls, 1);
    release(success());
    await new Promise((resolve) => setImmediate(resolve));
  }
);

test("actual combo: malformed HTTP 200 never causes another model generation", async () => {
  let calls = 0;
  const result = await handleComboChat(
    options(async () => {
      calls++;
      return Response.json({ unexpected: "fixture" });
    })
  );
  assert.equal(result.status, 502);
  assert.equal((await result.json()).error.code, "response_contract_failed");
  assert.equal(calls, 1);
});

test("actual combo: tool-bearing transient failure cannot replay uncertain work", async () => {
  let calls = 0;
  const result = await handleComboChat(
    options(
      async () => {
        calls++;
        return failure(503, "provider_unavailable");
      },
      {
        body: {
          ...body(),
          tools: [
            {
              type: "function",
              function: { name: "side_effect", parameters: { type: "object", properties: {} } },
            },
          ],
        },
      }
    )
  );
  assert.equal(result.status, 503);
  assert.equal(calls, 1);
  await result.text();
});

test("actual combo: provider-bound continuation prevents even model-rejection cross-provider replay", async () => {
  let calls = 0;
  const result = await handleComboChat(
    options(
      async () => {
        calls++;
        return failure(400, "model_not_found");
      },
      { body: { ...body(), previous_response_id: "fixture-bound-response" } }
    )
  );
  assert.equal(result.status, 400);
  assert.equal(calls, 1);
  await result.text();
});

test("actual combo: committed streaming output is never replaced by a second model", async () => {
  let calls = 0;
  const stream = `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "fixture output" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
  const result = await handleComboChat(
    options(
      async () => {
        calls++;
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
      { body: { ...body(), stream: true } }
    )
  );
  assert.equal(result.status, 200);
  assert.match(await result.text(), /fixture output/);
  assert.equal(calls, 1);
});

test("actual combo: a failure after streaming output is committed never dispatches fallback", async () => {
  let calls = 0,
    streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "already committed fixture output" } }] })}\n\n`
        )
      );
    },
  });
  const result = await handleComboChat(
    options(
      async () => {
        calls++;
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
      { body: { ...body(), stream: true } }
    )
  );
  const reader = result.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /already committed/);
  streamController.error(new Error("fixture late stream failure"));
  await assert.rejects(reader.read(), {
    name: "NetworkError",
    message: "Upstream response body failed",
  });
  assert.equal(calls, 1);
});

test("guard: known rejected target is not retried but different account stays eligible", async () => {
  const guard = createRoutingAttemptGuard({ body: body(), limit: 8 });
  let calls = 0;
  const wrapped = guard.wrap(async () => {
    calls++;
    return failure(400, "model_not_found");
  });
  await wrapped(body(), "codex/fixture-model", { connectionId: "account-a" });
  await wrapped(body(), "codex/fixture-model", { connectionId: "account-a" });
  await wrapped(body(), "codex/fixture-model", { connectionId: "account-b" });
  assert.equal(calls, 2);
});

test("guard: concurrent refusal remains sticky when the original operation later succeeds", async () => {
  const guard = createRoutingAttemptGuard({ body: body(), limit: 8 });
  let release!: (response: Response) => void;
  let calls = 0;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const wrapped = guard.wrap(async () => {
    calls++;
    return pending;
  });
  const first = wrapped(body(), models[0]);
  const refused = await wrapped(body(), models[1]);
  assert.equal((await refused.clone().json()).error.code, "concurrent_replay_blocked");
  release(success());
  const original = await first;
  assert.equal(
    original.status,
    refused.status,
    "earlier terminal refusal must not be overwritten by success"
  );
  assert.equal(guard.terminal(), refused);
  assert.equal(calls, 1);
});

test("guard: cancellation remains sticky if an outer catch attempts reuse", async () => {
  const guard = createRoutingAttemptGuard({ body: body(), limit: 8 });
  let calls = 0;
  const wrapped = guard.wrap(async () => {
    calls++;
    throw new DOMException("fixture transport cancellation", "AbortError");
  });
  await assert.rejects(wrapped(body(), models[0]), { name: "AbortError" });
  await wrapped(body(), models[1]).catch(() => undefined);
  assert.equal(calls, 1, "catching cancellation cannot grant another dispatch");
});

test(
  "actual combo: total deadline bounds an in-flight target, not only its start",
  { timeout: 2000 },
  async () => {
    let calls = 0;
    const started = performance.now();
    const result = await handleComboChat(
      options(
        async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 120));
          return success();
        },
        { config: { comboTimeoutMs: 20, targetTimeoutMs: 500 } }
      )
    );
    assert.equal(result.ok, false, "late success after the whole turn deadline must not escape");
    assert.ok(performance.now() - started < 100, "whole-turn deadline must bound the waiter");
    assert.equal(calls, 1);
  }
);

test("actual combo: explicit local monitor uncertainty is terminal even for plain text", async () => {
  let calls = 0;
  const result = await handleComboChat(
    options(async () => {
      calls++;
      return calls === 1
        ? failure(503, "local_backend_unavailable", {
            reason: "runtime_memory_pressure",
            failure_phase: "runtime_monitor",
            execution_outcome: "uncertain",
          })
        : success();
    })
  );
  assert.equal(result.status, 503);
  assert.equal(calls, 1);
  await result.text();
});

test("outer local: marked uncertain remote result never starts local fallback", async () => {
  let localCalls = 0;
  const result = routingFailure("execution_uncertain");
  const actual = await finalLocalFallback(
    {
      body: body(),
      combo: {
        name: "ac-terminal-continuity",
        allowedProviders: ["ollama-local"],
        config: {
          finalLocalFallbackModel: LOCAL_ROUTE,
          zeroAdditionalCostProviders: ["ollama-local"],
        },
      },
      handleSingleModel: async () => {
        localCalls++;
        return success();
      },
      isReplayTerminal: isRoutingTerminal,
    },
    async () => result
  );
  assert.equal(actual, result);
  assert.equal(localCalls, 0);
});

test("outer local: terminal local uncertainty must not be replaced by old remote context error", async () => {
  const remote = failure(400, "context_length_exceeded");
  const local = routingFailure("target_timeout_execution_uncertain", 524);
  let terminal: Response | null = null,
    calls = 0;
  const actual = await finalLocalFallback(
    {
      body: body(),
      combo: {
        name: "ac-terminal-continuity",
        allowedProviders: ["ollama-local"],
        config: {
          finalLocalFallbackModel: LOCAL_ROUTE,
          zeroAdditionalCostProviders: ["ollama-local"],
        },
      },
      handleSingleModel: async () => {
        calls++;
        terminal = local;
        return local;
      },
      isReplayTerminal: isRoutingTerminal,
      routingAttemptGuard: { terminal: () => terminal },
    },
    async () => remote
  );
  assert.equal(actual, local, "uncertain local execution must remain visible and terminal");
  assert.equal(calls, 1);
});

test("deliberate pipeline retains its separate stage dispatches", async () => {
  let calls = 0;
  const configured = options(async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: calls === 1 ? "FIRST" : "SECOND" } }] });
  });
  configured.combo.strategy = "pipeline";
  const result = await handleComboChat(configured);
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.match(await result.text(), /SECOND/);
});
test("round-robin malformed200 stops instead of returning cached failed envelope", async () => {
  let calls = 0;
  const configured = options(async () => {
    calls++;
    return Response.json({ unexpected: "fixture" });
  });
  configured.combo.strategy = "round-robin";
  const result = await handleComboChat(configured);
  assert.equal(result.status, 502);
  assert.equal(calls, 1);
});

test("actual retry pacing skips failed target without vetoing independent provider", async () => {
  const calls: string[] = [];
  const configured = options(
    async (_b: unknown, model: string) => {
      calls.push(model);
      return calls.length === 1
        ? new Response(
            JSON.stringify({ error: { code: "rate_limit_error", message: "fixture rate limit" } }),
            { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } }
          )
        : success();
    },
    { config: { maxRetries: 1, retryDelayMs: 0 }, settings: { modelLockout: { enabled: false } } }
  );
  const response = await handleComboChat(configured);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, models);
});

test("managed parent supports explicitly owned nested pipeline stages", async () => {
  let calls = 0;
  const configured = options(
    async () => {
      calls++;
      return success();
    },
    { config: { nestedComboMode: "execute" } }
  );
  configured.combo.models = [{ kind: "combo-ref", comboName: "fixture-pipeline-child" }];
  configured.allCombos = [
    {
      name: "fixture-pipeline-child",
      strategy: "pipeline",
      models: models.map((model) => ({ model })),
    },
  ];
  const response = await handleComboChat(configured);
  assert.equal(response.ok, true);
  assert.equal(calls, 2);
  await response.text();
});
