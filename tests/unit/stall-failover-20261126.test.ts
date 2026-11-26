/**
 * ROUTING_STALL_FAILOVER unit coverage: the flag, the provider-executed-tool check, the exception
 * predicate (each condition failing blocks replay), and the routing guard itself driven with
 * the real transport context (an aborted wire dispatch, as the executor produces it).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_STALL_FAILOVERS_PER_REQUEST,
  hasProviderExecutedTools,
  isStallFailoverEnabled,
  stallFailoverRefusal,
  type StallFailoverCheck,
} from "../../open-sse/services/combo/stallFailover.ts";
import {
  createRoutingAttemptGuard,
  isRoutingTerminal,
  markStallReplayCandidate,
} from "../../open-sse/services/combo/routingAttemptSafety.ts";
import { runWithRoutingTransportWire } from "../../open-sse/services/routingTransportContext.ts";
import {
  createUpstreamStalledError,
  createUpstreamStalledResponse,
} from "../../open-sse/handlers/chatCore/upstreamStall.ts";

test("flag: needs ROUTING_STALL_FAILOVER truthy AND a stall deadline", () => {
  assert.equal(isStallFailoverEnabled({}), false);
  assert.equal(isStallFailoverEnabled({ ROUTING_STALL_FAILOVER: "1" }), false, "no deadline");
  assert.equal(
    isStallFailoverEnabled({ ROUTING_STALL_FAILOVER: "0", ROUTING_STALL_DEADLINE_MS: "120000" }),
    false
  );
  for (const on of ["1", "true", "yes", "on", " TRUE "]) {
    assert.equal(
      isStallFailoverEnabled({ ROUTING_STALL_FAILOVER: on, ROUTING_STALL_DEADLINE_MS: "120000" }),
      true,
      on
    );
  }
});

test("provider-executed tools: only untyped, function and custom tools are client-side", () => {
  // Claude Code style custom tools, OpenAI function tools, Anthropic custom: client-side.
  assert.equal(
    hasProviderExecutedTools({ tools: [{ name: "read_file", input_schema: {} }] }),
    false
  );
  assert.equal(
    hasProviderExecutedTools({ tools: [{ type: "function", function: { name: "f" } }] }),
    false
  );
  assert.equal(hasProviderExecutedTools({ tools: [{ type: "custom", name: "x" }] }), false);
  assert.equal(
    hasProviderExecutedTools({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "read_file", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
      ],
    }),
    false,
    "client tool history is fine"
  );
  // Provider-executed: Anthropic server tools, MCP connector, OpenAI Responses built-ins, unknown.
  for (const tool of [
    { type: "web_search_20250305", name: "web_search" },
    { type: "web_fetch_20250910", name: "web_fetch" },
    { type: "code_execution_20250522", name: "code_execution" },
    { type: "computer_20250124", name: "computer" },
    { type: "web_search" },
    { type: "web_search_preview" },
    { type: "file_search" },
    { type: "code_interpreter" },
    { type: "computer_use_preview" },
    { type: "image_generation" },
    { type: "mcp", server_label: "x" },
    { type: "something_new" },
  ]) {
    assert.equal(hasProviderExecutedTools({ tools: [tool] }), true, JSON.stringify(tool));
  }
  assert.equal(hasProviderExecutedTools({ mcp_servers: [{ url: "https://x" }] }), true);
  // Earlier provider-run tools in the history.
  assert.equal(
    hasProviderExecutedTools({
      messages: [{ role: "assistant", content: [{ type: "server_tool_use", name: "web_search" }] }],
    }),
    true
  );
  assert.equal(
    hasProviderExecutedTools({
      messages: [{ role: "user", content: [{ type: "web_search_tool_result", content: [] }] }],
    }),
    true
  );
  assert.equal(hasProviderExecutedTools({ input: [{ type: "web_search_call", id: "w" }] }), true);
});

const ALLOWED: StallFailoverCheck = {
  enabled: true,
  stallMarked: true,
  transportClean: true,
  responseCommitted: false,
  providerExecutedTools: false,
  hardBound: false,
  providerBound: false,
  sanitizedSwitch: false,
  failoversUsed: 0,
  callerAborted: false,
};

test("predicate: allowed only when every condition holds; each failing condition blocks", () => {
  assert.equal(stallFailoverRefusal(ALLOWED), null);
  const cases: Array<[Partial<StallFailoverCheck>, string]> = [
    [{ enabled: false }, "stall_failover_disabled"],
    [{ stallMarked: false }, "not_own_stall"], // (1) not our own stall abort
    [{ transportClean: false }, "transport_not_stall_only"], // (1)/(2) other transport failure
    [{ responseCommitted: true }, "response_committed"], // (3) something reached the client
    [{ callerAborted: true }, "caller_aborted"],
    [{ providerExecutedTools: true }, "provider_executed_tools"], // (4)
    [{ hardBound: true }, "provider_executed_tools"], // (4) provider-held state
    [{ providerBound: true }, "provider_bound_unsanitized"],
    [{ failoversUsed: MAX_STALL_FAILOVERS_PER_REQUEST }, "stall_failover_budget"],
  ];
  for (const [change, reason] of cases) {
    assert.equal(stallFailoverRefusal({ ...ALLOWED, ...change }), reason, JSON.stringify(change));
  }
  assert.equal(
    stallFailoverRefusal({ ...ALLOWED, providerBound: true, sanitizedSwitch: true }),
    null,
    "a provider-bound history may move on when the combo sanitizes it"
  );
});

// ── The guard itself ────────────────────────────────────────────────────────────────────────────

function withFlags<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const saved = [process.env.ROUTING_STALL_FAILOVER, process.env.ROUTING_STALL_DEADLINE_MS];
  if (on) {
    process.env.ROUTING_STALL_FAILOVER = "1";
    process.env.ROUTING_STALL_DEADLINE_MS = "120000";
  } else {
    delete process.env.ROUTING_STALL_FAILOVER;
    delete process.env.ROUTING_STALL_DEADLINE_MS;
  }
  return fn().finally(() => {
    if (saved[0] === undefined) delete process.env.ROUTING_STALL_FAILOVER;
    else process.env.ROUTING_STALL_FAILOVER = saved[0];
    if (saved[1] === undefined) delete process.env.ROUTING_STALL_DEADLINE_MS;
    else process.env.ROUTING_STALL_DEADLINE_MS = saved[1];
  });
}

const TOOL_BODY = {
  model: "combo",
  tools: [{ name: "read_file", input_schema: {} }],
  messages: [{ role: "user", content: "hi" }],
};

/** An attempt as chatCore returns it after its own headers-phase stall: the wire dispatch was
 * aborted by the trusted stall error (or by `abortWith`), and the marked 504 is returned. */
function stalledDispatch(options: { mark?: boolean; abortWith?: unknown } = {}) {
  return async () => {
    try {
      await runWithRoutingTransportWire(() =>
        Promise.reject(options.abortWith ?? createUpstreamStalledError(120000, "openai", "m"))
      );
    } catch {
      /* chatCore maps the abort to its stall result */
    }
    const response = createUpstreamStalledResponse("stalled");
    return options.mark === false ? response : markStallReplayCandidate(response);
  };
}

/** A first-event-phase stall: the transport was never stopped (headers arrived, body unbound). */
function firstEventStall(mark = true) {
  return async () => {
    const response = createUpstreamStalledResponse("stalled");
    return mark ? markStallReplayCandidate(response) : response;
  };
}

function guardFor(body: Record<string, unknown> = TOOL_BODY, signal?: AbortSignal) {
  return createRoutingAttemptGuard({ body, limit: 30, signal });
}

test("guard, flag on: a marked headers-phase stall (transport stopped by our abort) may move on", async () => {
  await withFlags(true, async () => {
    const guard = guardFor();
    const result = await guard.wrap(stalledDispatch())(TOOL_BODY, "openai/m1", {} as never);
    assert.equal(result.status, 504);
    assert.equal(isRoutingTerminal(result), false, "not a stop: the combo may advance");
  });
});

test("guard, flag on: a marked first-event-phase stall on a tool request may move on", async () => {
  await withFlags(true, async () => {
    const guard = guardFor();
    const result = await guard.wrap(firstEventStall())(TOOL_BODY, "openai/m1", {} as never);
    assert.equal(isRoutingTerminal(result), false);
  });
});

test("guard, flag on: the stalled model is not re-picked on any connection; other models are", async () => {
  await withFlags(true, async () => {
    const guard = guardFor();
    let dispatched = 0;
    const counting = async () => {
      dispatched++;
      return markStallReplayCandidate(createUpstreamStalledResponse("stalled"));
    };
    const wrapped = guard.wrap(counting);
    await wrapped(TOOL_BODY, "openai/m1", { connectionId: "a" } as never);
    const again = await wrapped(TOOL_BODY, "openai/m1", { connectionId: "b" } as never);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /account_model_ineligible/);
    assert.equal(dispatched, 1, "the same model on another connection is not dispatched");
    await wrapped(TOOL_BODY, "openai/m2", { connectionId: "a" } as never);
    assert.equal(dispatched, 2, "a different model is still dispatched");
  });
});

test("guard, flag on: only one stall failover per request", async () => {
  await withFlags(true, async () => {
    const guard = guardFor();
    const first = await guard.wrap(firstEventStall())(TOOL_BODY, "openai/m1", {} as never);
    assert.equal(isRoutingTerminal(first), false);
    const second = await guard.wrap(firstEventStall())(TOOL_BODY, "openai/m2", {} as never);
    assert.equal(isRoutingTerminal(second), true, "second stall stops as before");
  });
});

test("guard, flag on: an unmarked stall, or a non-stall transport abort, keeps the old stops", async () => {
  await withFlags(true, async () => {
    // (1) not marked: the old tool-request stop.
    const unmarked = await guardFor().wrap(firstEventStall(false))(
      TOOL_BODY,
      "openai/m1",
      {} as never
    );
    assert.equal(isRoutingTerminal(unmarked), true);
    // (1)/(2) marked response, but the transport ended on something other than our stall.
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const other = await guardFor().wrap(stalledDispatch({ abortWith: reset }))(
      TOOL_BODY,
      "openai/m1",
      {} as never
    );
    assert.equal(isRoutingTerminal(other), true);
    assert.match(await other.text(), /execution_uncertain/);
    // A lookalike error (same name/code/message, not the trusted object) is not our stall.
    const lookalike = Object.assign(new Error("Upstream produced no response within 120000ms"), {
      name: "TimeoutError",
      code: "upstream_stalled",
    });
    const fake = await guardFor().wrap(stalledDispatch({ abortWith: lookalike }))(
      TOOL_BODY,
      "openai/m1",
      {} as never
    );
    assert.equal(isRoutingTerminal(fake), true);
  });
});

test("guard, flag on: (4) a request with a provider-executed tool keeps the old stop", async () => {
  await withFlags(true, async () => {
    const body = { ...TOOL_BODY, tools: [{ type: "web_search_20250305", name: "web_search" }] };
    const result = await guardFor(body).wrap(firstEventStall())(body, "openai/m1", {} as never);
    assert.equal(isRoutingTerminal(result), true);
  });
});

test("guard, flag on: (3) nothing may replay once a response was committed", async () => {
  await withFlags(true, async () => {
    const guard = guardFor();
    const ok = await guard.wrap(async () => new Response("ok", { status: 200 }))(
      TOOL_BODY,
      "openai/m0",
      {} as never
    );
    assert.equal(ok.status, 200);
    const after = await guard.wrap(firstEventStall())(TOOL_BODY, "openai/m1", {} as never);
    assert.equal(isRoutingTerminal(after), true);
    assert.match(await after.text(), /response_already_committed/);
  });
});

test("guard, flag on: a provider-bound history is replayed only with the sanitized switch", async () => {
  await withFlags(true, async () => {
    const body = {
      model: "combo",
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "sig" }] },
        { role: "user", content: "next" },
      ],
    };
    const plain = await createRoutingAttemptGuard({ body, limit: 30 }).wrap(firstEventStall())(
      body,
      "openai/m1",
      {} as never
    );
    assert.equal(isRoutingTerminal(plain), true);
    const sanitized = await createRoutingAttemptGuard({
      body,
      limit: 30,
      sanitizedSwitch: true,
    }).wrap(firstEventStall())(body, "openai/m1", {} as never);
    assert.equal(isRoutingTerminal(sanitized), false);
  });
});

test("guard, flag OFF: every stall keeps exactly the old stops", async () => {
  await withFlags(false, async () => {
    const headers = await guardFor().wrap(stalledDispatch())(TOOL_BODY, "openai/m1", {} as never);
    assert.equal(isRoutingTerminal(headers), true);
    assert.match(await headers.text(), /execution_uncertain/);
    const firstEvent = await guardFor().wrap(firstEventStall())(
      TOOL_BODY,
      "openai/m1",
      {} as never
    );
    assert.equal(isRoutingTerminal(firstEvent), true);
  });
});
