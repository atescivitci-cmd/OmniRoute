/**
 * ROUTING_OVERLOAD_FAILOVER unit coverage: the overload classifier, the exception predicate and the
 * routing guard driven with marked responses (as chatCore and chat.ts produce them).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_OVERLOAD_FAILOVERS_PER_REQUEST,
  classifyOverloadRefusal,
  isOverloadFailoverEnabled,
  overloadFailoverRefusal,
  type OverloadFailoverCheck,
} from "../../open-sse/services/combo/overloadFailover.ts";
import {
  createRoutingAttemptGuard,
  isRoutingTerminal,
  markOverloadRefusal,
} from "../../open-sse/services/combo/routingAttemptSafety.ts";

const LIVE =
  "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later. (reset after 3s)";

test("flag: ROUTING_OVERLOAD_FAILOVER truthy only", () => {
  assert.equal(isOverloadFailoverEnabled({}), false);
  assert.equal(isOverloadFailoverEnabled({ ROUTING_OVERLOAD_FAILOVER: "0" }), false);
  for (const on of ["1", "true", "yes", "on", " ON "]) {
    assert.equal(isOverloadFailoverEnabled({ ROUTING_OVERLOAD_FAILOVER: on }), true, on);
  }
});

test("classifier: structured overload codes on 503", () => {
  const bodies: Array<[string, unknown]> = [
    [
      "anthropic overloaded_error",
      { type: "error", error: { type: "overloaded_error", message: "x" } },
    ],
    ["google UNAVAILABLE", { error: { code: 503, status: "UNAVAILABLE", message: "x" } }],
    ["google RESOURCE_EXHAUSTED", { error: { code: 503, status: "RESOURCE_EXHAUSTED" } }],
    ["openai server_overloaded", { error: { code: "server_overloaded", message: "x" } }],
    ["openai engine_overloaded", { error: { type: "engine_overloaded", message: "x" } }],
    ["json string body", JSON.stringify({ error: { type: "overloaded_error" } })],
  ];
  for (const [label, body] of bodies) {
    const result = classifyOverloadRefusal({ status: 503, body });
    assert.equal(result.overload, true, label);
  }
  assert.equal(
    classifyOverloadRefusal({ status: 503, errorCode: "server_overloaded" }).overload,
    true,
    "parsed code"
  );
  assert.equal(
    classifyOverloadRefusal({ status: 503, errorType: "overloaded_error" }).overload,
    true,
    "parsed type"
  );
});

test("classifier: the live Gemini message, the phrase allowlist and a retry hint on 503", () => {
  assert.equal(classifyOverloadRefusal({ status: 503, message: LIVE }).overload, true, "live");
  assert.equal(
    classifyOverloadRefusal({ status: 503, body: { error: { code: 503, message: LIVE } } })
      .overload,
    true,
    "live, in a body with a numeric code"
  );
  for (const phrase of [
    "The engine is currently overloaded",
    "Model is over capacity",
    "Servers are at capacity",
    "capacity exceeded for this model",
    "insufficient capacity",
    "Please try again later.",
  ]) {
    assert.equal(classifyOverloadRefusal({ status: 503, message: phrase }).overload, true, phrase);
  }
  assert.equal(
    classifyOverloadRefusal({ status: 503, message: "Service Unavailable", retryAfterMs: 3000 })
      .overload,
    true,
    "retry hint"
  );
});

test("classifier: a generic 503 with no overload signal is refused", () => {
  for (const input of [
    { status: 503 },
    { status: 503, message: "Service Unavailable" },
    { status: 503, body: { error: { code: 503, message: "upstream connect error" } } },
    { status: 503, retryAfterMs: 0 },
    { status: 503, errorCode: 503 as unknown, errorType: null },
  ]) {
    assert.equal(classifyOverloadRefusal(input).overload, false, JSON.stringify(input));
  }
});

test("classifier: 529 always; 502/504 only with an explicit overload code or phrase", () => {
  assert.equal(classifyOverloadRefusal({ status: 529 }).overload, true);
  for (const status of [502, 504]) {
    assert.equal(classifyOverloadRefusal({ status }).overload, false, `${status} bare`);
    assert.equal(
      classifyOverloadRefusal({ status, retryAfterMs: 5000 }).overload,
      false,
      `${status} retry hint alone`
    );
    assert.equal(
      classifyOverloadRefusal({ status, message: "Gateway timeout, try again later" }).overload,
      false,
      `${status} try again later alone`
    );
    assert.equal(
      classifyOverloadRefusal({ status, message: "upstream is overloaded" }).overload,
      true,
      `${status} explicit phrase`
    );
    assert.equal(
      classifyOverloadRefusal({ status, body: { error: { type: "overloaded_error" } } }).overload,
      true,
      `${status} explicit code`
    );
  }
});

test("classifier: never on a success status (a mid-stream error after content) or other errors", () => {
  for (const status of [200, 400, 401, 404, 408, 429, 500]) {
    assert.equal(
      classifyOverloadRefusal({ status, message: LIVE, retryAfterMs: 3000 }).overload,
      false,
      String(status)
    );
  }
});

const ALLOWED: OverloadFailoverCheck = {
  enabled: true,
  overloadMarked: true,
  responseCommitted: false,
  transportStopped: false,
  providerExecutedTools: false,
  hardBound: false,
  providerBound: false,
  sanitizedSwitch: false,
  nvidiaUnqualified: false,
  failoversUsed: 0,
  callerAborted: false,
};

test("predicate: allowed only when every condition holds; each failing condition blocks", () => {
  assert.equal(overloadFailoverRefusal(ALLOWED), null);
  const cases: Array<[Partial<OverloadFailoverCheck>, string]> = [
    [{ enabled: false }, "overload_failover_disabled"],
    [{ overloadMarked: false }, "not_overload_refusal"],
    [{ transportStopped: true }, "transport_stopped"],
    [{ responseCommitted: true }, "response_committed"],
    [{ callerAborted: true }, "caller_aborted"],
    [{ providerExecutedTools: true }, "provider_executed_tools"],
    [{ hardBound: true }, "provider_executed_tools"],
    [{ providerBound: true }, "provider_bound_unsanitized"],
    [{ nvidiaUnqualified: true }, "nvidia_no_safe_fallback"],
    [{ failoversUsed: MAX_OVERLOAD_FAILOVERS_PER_REQUEST }, "overload_failover_budget"],
  ];
  for (const [change, reason] of cases) {
    assert.equal(
      overloadFailoverRefusal({ ...ALLOWED, ...change }),
      reason,
      JSON.stringify(change)
    );
  }
  assert.equal(
    overloadFailoverRefusal({ ...ALLOWED, providerBound: true, sanitizedSwitch: true }),
    null
  );
});

// ── The guard ───────────────────────────────────────────────────────────────────────────────

async function withFlag<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.ROUTING_OVERLOAD_FAILOVER;
  if (on) process.env.ROUTING_OVERLOAD_FAILOVER = "1";
  else delete process.env.ROUTING_OVERLOAD_FAILOVER;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.ROUTING_OVERLOAD_FAILOVER;
    else process.env.ROUTING_OVERLOAD_FAILOVER = saved;
  }
}

const TOOL_BODY = {
  model: "combo",
  tools: [{ name: "read_file", input_schema: {} }],
  messages: [{ role: "user", content: "hi" }],
};

function overloaded(mark = true) {
  return async () => {
    const response = Response.json(
      { error: { message: LIVE, code: 503 } },
      { status: 503, headers: { "retry-after": "3" } }
    );
    return mark ? markOverloadRefusal(response) : response;
  };
}

test("guard, flag on: a marked overload refusal on a tool request moves on; the model is not re-picked", async () => {
  await withFlag(true, async () => {
    const events: Array<Record<string, unknown>> = [];
    const guard = createRoutingAttemptGuard({
      body: TOOL_BODY,
      limit: 30,
      emit: (event) => events.push(event),
    });
    let dispatched = 0;
    const wrapped = guard.wrap(async () => {
      dispatched++;
      return overloaded()();
    });
    const first = await wrapped(TOOL_BODY, "gemini/gemini-3.5-flash", {
      connectionId: "a",
      provider: "gemini",
    } as never);
    assert.equal(first.status, 503);
    assert.equal(isRoutingTerminal(first), false);
    assert.ok(events.some((e) => e.event === "outcome" && e.status === 503));
    assert.ok(events.some((e) => e.event === "overload_failover"));
    const again = await wrapped(TOOL_BODY, "gemini/gemini-3.5-flash", {
      connectionId: "b",
      provider: "gemini",
    } as never);
    assert.equal(again.status, 400, "the overloaded model is skipped on every connection");
    assert.equal(dispatched, 1);
  });
});

test("guard: an unmarked 503 on a tool request keeps the old stop (flag on or off)", async () => {
  for (const flag of [true, false]) {
    await withFlag(flag, async () => {
      const result = await createRoutingAttemptGuard({ body: TOOL_BODY, limit: 30 }).wrap(
        overloaded(false)
      )(TOOL_BODY, "gemini/m", {} as never);
      assert.equal(isRoutingTerminal(result), true, `flag ${flag}`);
    });
  }
});

test("guard, flag OFF: a marked overload refusal keeps the old tool stop", async () => {
  await withFlag(false, async () => {
    const result = await createRoutingAttemptGuard({ body: TOOL_BODY, limit: 30 }).wrap(
      overloaded()
    )(TOOL_BODY, "gemini/m", {} as never);
    assert.equal(isRoutingTerminal(result), true);
  });
});

test("guard, flag on: server tools, unsanitized provider-bound history and NVIDIA keep their stops", async () => {
  await withFlag(true, async () => {
    const serverTools = {
      ...TOOL_BODY,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    };
    const a = await createRoutingAttemptGuard({ body: serverTools, limit: 30 }).wrap(overloaded())(
      serverTools,
      "gemini/m",
      {} as never
    );
    assert.equal(isRoutingTerminal(a), true, "server tool");

    const signed = {
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "sig" }] },
      ],
    };
    const b = await createRoutingAttemptGuard({ body: signed, limit: 30 }).wrap(overloaded())(
      signed,
      "gemini/m",
      {} as never
    );
    assert.equal(isRoutingTerminal(b), true, "provider-bound without sanitized switch");
    const c = await createRoutingAttemptGuard({
      body: signed,
      limit: 30,
      sanitizedSwitch: true,
    }).wrap(overloaded())(signed, "gemini/m", {} as never);
    assert.equal(isRoutingTerminal(c), false, "provider-bound with sanitized switch");

    const d = await createRoutingAttemptGuard({ body: TOOL_BODY, limit: 30 }).wrap(overloaded())(
      TOOL_BODY,
      "nvidia/z-ai/glm-5.3",
      { provider: "nvidia" } as never
    );
    assert.equal(isRoutingTerminal(d), true, "nvidia, as for a 429");
  });
});

test("guard, flag on: at most two overload failovers per REQUEST, shared with forked guards", async () => {
  await withFlag(true, async () => {
    const parent = createRoutingAttemptGuard({ body: TOOL_BODY, limit: 30 });
    const results = [];
    for (const model of ["gemini/m1", "gemini/m2", "gemini/m3"]) {
      results.push(
        await parent.fork(TOOL_BODY, 5).wrap(overloaded())(TOOL_BODY, model, {} as never)
      );
    }
    assert.deepEqual(
      results.map((r) => isRoutingTerminal(r)),
      [false, false, true]
    );
  });
});

test("guard: overload_failover_refused is emitted only when the refusal stops the request", async () => {
  await withFlag(true, async () => {
    const plainBody = { model: "combo", messages: [{ role: "user", content: "hi" }] };
    for (const [label, body, expectStop] of [
      ["no-tool request (old rules still move on)", plainBody, false],
      ["tool request (the old tool stop applies)", TOOL_BODY, true],
    ] as const) {
      const events: Array<Record<string, unknown>> = [];
      const parent = createRoutingAttemptGuard({
        body,
        limit: 30,
        emit: (event) => events.push(event),
      });
      // Spend the per-request budget, then a third overload is refused with overload_failover_budget.
      for (const model of ["gemini/m1", "gemini/m2"]) {
        await parent.fork(body, 5).wrap(overloaded())(body, model, {} as never);
      }
      const third = await parent.fork(body, 5).wrap(overloaded())(body, "gemini/m3", {} as never);
      const refused = events.filter((e) => e.event === "overload_failover_refused");
      assert.equal(isRoutingTerminal(third), expectStop, label);
      if (expectStop) {
        assert.equal(refused.length, 1, `${label}: ${JSON.stringify(events)}`);
        assert.equal(refused[0].reason, "overload_failover_budget");
      } else {
        assert.equal(refused.length, 0, `${label}: ${JSON.stringify(refused)}`);
      }
    }
  });
});
