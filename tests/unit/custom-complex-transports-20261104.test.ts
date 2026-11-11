import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  createRoutingTransportAttempt,
  runWithRoutingTransportAttempt,
  getRoutingTransportOutcome,
  assertRoutingTransportOutcome,
  runWithRoutingTransportWire,
  dispatchRoutingTransportFetch,
} from "../../open-sse/services/routingTransportContext.ts";

// Only dependency-injected transports are permitted by this fixture.
globalThis.fetch = async () => {
  throw new Error("fixture forbids network");
};
const { BedrockExecutor } = await import("../../open-sse/executors/bedrock.ts");
const { KiroExecutor } = await import("../../open-sse/executors/kiro.ts");
const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
const { sendAntigravityRequest, toSafeAntigravityLog } =
  await import("../../open-sse/executors/antigravity/executeAttempt.ts");
const { CursorExecutor, newStreamCtx } = await import("../../open-sse/executors/cursor.ts");
const { CursorSessionManager } = await import("../../open-sse/services/cursorSessionManager.ts");
const { TraeExecutor } = await import("../../open-sse/executors/trae.ts");
const { tlsFetchChatGpt, __setTlsFetchOverrideForTesting, __tlsFetchStreamingForTesting } =
  await import("../../open-sse/services/chatgptTlsClient.ts");
const { resumeChatGptHandoff } = await import("../../open-sse/executors/chatgpt-web/handoff.ts");
const silent = toSafeAntigravityLog(null);
const uncertain = { code: "routing_transport_execution_uncertain" };
const input = {
  model: "fixture-model",
  body: { messages: [{ role: "user", content: "mandatory fixture input" }] },
  stream: false,
  credentials: { apiKey: "fixture", accessToken: "fixture" },
};

test.afterEach(() => {
  globalThis.fetch = async () => {
    throw new Error("fixture forbids network");
  };
  __setTlsFetchOverrideForTesting(null);
});

test("generic custom fetch preserves payload and disallows redirect replay", async () => {
  const t = createRoutingTransportAttempt();
  let calls = 0;
  await runWithRoutingTransportAttempt(t, async () => {
    const response = await dispatchRoutingTransportFetch(
      "https://fixture.invalid/model",
      { method: "POST", body: "complete payload" },
      async (_u, init) => {
        calls++;
        assert.equal(init?.body, "complete payload");
        assert.equal(init?.redirect, "error");
        return new Response("ok");
      }
    );
    assert.equal(await response.text(), "ok");
  });
  assert.equal(calls, 1);
  assert.equal(getRoutingTransportOutcome(t).modelDispatches, 1);
});

test("custom response body failure remains sticky after executor return", async () => {
  const t = createRoutingTransportAttempt();
  let control: any;
  const response = await runWithRoutingTransportAttempt(t, () =>
    dispatchRoutingTransportFetch(
      "https://fixture.invalid/model",
      {},
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              control = c;
            },
          })
        )
    )
  );
  control.error(new Error("fixture body loss"));
  await assert.rejects(response.text(), uncertain);
  assert.throws(() => assertRoutingTransportOutcome(t), uncertain);
});

test("custom response cancellation preserves unknown execution", async () => {
  const t = createRoutingTransportAttempt();
  const response = await runWithRoutingTransportAttempt(t, () =>
    dispatchRoutingTransportFetch(
      "https://fixture.invalid/model",
      {},
      async () => new Response(new ReadableStream())
    )
  );
  await response.body!.cancel();
  const outcome = getRoutingTransportOutcome(t);
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.uncertain, true);
});

test("custom fetch pre-aborted local signal makes zero sends", async () => {
  const ac = new AbortController();
  ac.abort();
  const t = createRoutingTransportAttempt();
  let sends = 0;
  await assert.rejects(
    runWithRoutingTransportAttempt(t, () =>
      dispatchRoutingTransportFetch(
        "https://fixture.invalid/model",
        { signal: ac.signal },
        async () => {
          sends++;
          return new Response();
        }
      )
    ),
    { code: "routing_transport_cancelled" }
  );
  assert.equal(sends, 0);
  assert.equal(getRoutingTransportOutcome(t).modelDispatches, 0);
});

test("Kiro direct dispatch is counted and swallowed fetch errors stay uncertain", async () => {
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    throw new Error("fixture lost response");
  };
  const t = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(t, () => new KiroExecutor().execute(input as any)),
    uncertain
  );
  assert.equal(sends, 1);
});

test("Antigravity managed403 returns original without retrying changed headers", async () => {
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    return new Response("forbidden", { status: 403 });
  };
  const t = createRoutingTransportAttempt();
  await runWithRoutingTransportAttempt(t, async () => {
    const r = await sendAntigravityRequest(
      "antigravity",
      "https://fixture.invalid/chat",
      "fixture",
      { "x-goog-user-project": "fixture" },
      { model: "fixture", request: {} },
      {} as any,
      false,
      undefined,
      silent,
      0
    );
    assert.equal(r.response.status, 403);
    await r.response.text();
  });
  assert.equal(sends, 1);
  assert.equal(getRoutingTransportOutcome(t).blocked, false);
});

test("Antigravity managed429 does not sleep or issue credits/URL retry", async () => {
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    return new Response('{"error":{"message":"rate"}}', {
      status: 429,
      headers: { "retry-after": "60" },
    });
  };
  const t = createRoutingTransportAttempt();
  await runWithRoutingTransportAttempt(t, async () => {
    const r = await (new AntigravityExecutor() as any).runAntigravityAttempt({
      url: "https://fixture.invalid/chat",
      model: "fixture",
      headers: {},
      transformedBody: { model: "fixture", request: {} },
      credentials: {},
      stream: false,
      log: silent,
      accountId: "fixture",
      urlIndex: 0,
      retryAttemptsByUrl: { 0: 0 },
      fallbackCount: 2,
    });
    assert.equal(r.action, "return");
    assert.equal(r.result.response.status, 429);
  });
  assert.equal(sends, 1);
  assert.equal(getRoutingTransportOutcome(t).blocked, false);
});

test("Bedrock SDK send throw cannot be hidden by error Response", async () => {
  let sends = 0;
  const executor = new BedrockExecutor(() => ({
    send: async () => {
      sends++;
      throw new Error("fixture SDK lost response");
    },
  }));
  const t = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(t, () => executor.execute(input)),
    uncertain
  );
  assert.equal(sends, 1);
});

test("Bedrock complete SDK result uses one dispatch", async () => {
  let sends = 0;
  const executor = new BedrockExecutor(() => ({
    send: async () => {
      sends++;
      return {
        output: { message: { content: [{ text: "ok" }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  }));
  const t = createRoutingTransportAttempt();
  await runWithRoutingTransportAttempt(t, async () => {
    const r = await executor.execute(input);
    assert.equal(r.response.status, 200);
    assert.match(await r.response.text(), /ok/);
  });
  assert.equal(sends, 1);
});

for (const kind of ["throw", "missing-stop"] as const)
  test(`Bedrock ${kind} stream never becomes clean completion`, async () => {
    async function* events() {
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } };
      if (kind === "throw") throw new Error("fixture iterator loss");
    }
    const executor = new BedrockExecutor(() => ({ send: async () => ({ stream: events() }) }));
    const t = createRoutingTransportAttempt();
    await assert.rejects(
      runWithRoutingTransportAttempt(t, async () => {
        const r = await executor.execute({ ...input, stream: true });
        await r.response.text();
      }),
      uncertain
    );
  });

function sessionFixture(write: (chunk: any) => any) {
  const req = Object.assign(new EventEmitter(), { write, close() {}, closed: false });
  const client = Object.assign(new EventEmitter(), { close() {} });
  const manager = new CursorSessionManager();
  const session = manager.open("fixture", client as any, req as any, new Map());
  session.pendingToolCalls.set("one", { execMsgId: 1, execId: "a", toolName: "fixture" });
  session.pendingToolCalls.set("two", { execMsgId: 2, execId: "b", toolName: "fixture" });
  return { manager, session, req, client };
}

test("Cursor matched tool batch claims once across two frames", async () => {
  let writes = 0;
  const f = sessionFixture(() => {
    writes++;
  });
  const t = createRoutingTransportAttempt();
  await runWithRoutingTransportAttempt(t, () =>
    f.manager.sendToolResults(f.session, [
      { id: "one", content: "a", isError: false },
      { id: "two", content: "b", isError: false },
    ])
  );
  assert.equal(writes, 2);
  assert.equal(getRoutingTransportOutcome(t).modelDispatches, 1);
  f.manager.close(f.session);
});

test("Cursor partial tool batch failure remains uncertain and cannot cold replay", async () => {
  let writes = 0;
  const f = sessionFixture(() => {
    if (++writes === 2) throw new Error("fixture write lost");
  });
  const t = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(t, () =>
      f.manager.sendToolResults(f.session, [
        { id: "one", content: "a", isError: false },
        { id: "two", content: "b", isError: false },
      ])
    ),
    uncertain
  );
  assert.equal(writes, 2);
  assert.equal(f.session.pendingToolCalls.has("one"), false);
  assert.equal(f.session.pendingToolCalls.has("two"), true);
  await assert.rejects(
    runWithRoutingTransportAttempt(t, () => runWithRoutingTransportWire(() => writes++)),
    uncertain
  );
  assert.equal(writes, 2);
  f.manager.close(f.session);
});

test("Cursor cancellation between tool writes prevents next frame", async () => {
  let writes = 0;
  const ac = new AbortController();
  const f = sessionFixture(() => {
    writes++;
    ac.abort();
  });
  const t = createRoutingTransportAttempt({ signal: ac.signal });
  await assert.rejects(
    runWithRoutingTransportAttempt(t, () =>
      f.manager.sendToolResults(f.session, [
        { id: "one", content: "a", isError: false },
        { id: "two", content: "b", isError: false },
      ])
    ),
    { code: "routing_transport_cancelled" }
  );
  assert.equal(writes, 1);
  f.manager.close(f.session);
});

test("Cursor missing tool IDs do not claim or send", async () => {
  let writes = 0;
  const f = sessionFixture(() => writes++);
  const t = createRoutingTransportAttempt();
  await runWithRoutingTransportAttempt(t, () =>
    assert.equal(
      f.manager.sendToolResults(f.session, [{ id: "missing", content: "a", isError: false }]),
      false
    )
  );
  assert.equal(writes, 0);
  assert.equal(getRoutingTransportOutcome(t).modelDispatches, 0);
  f.manager.close(f.session);
});

test("Cursor HTTP2 request throw records uncertainty before error conversion", async () => {
  let requests = 0;
  const client = Object.assign(new EventEmitter(), {
    request() {
      requests++;
      throw new Error("fixture headers write uncertain");
    },
    close() {},
  });
  const executor = new CursorExecutor({ connect: () => client } as any);
  const t = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(t, () =>
      (executor as any).openH2("https://fixture.invalid/chat", {}, Buffer.from("full input"))
    ),
    uncertain
  );
  assert.equal(requests, 1);
  assert.equal(getRoutingTransportOutcome(t).uncertain, true);
});

test("Trae session creation is inference; incomplete event EOF stays uncertain", async () => {
  let posts = 0,
    gets = 0;
  globalThis.fetch = async (_u, init) => {
    if (init?.method === "POST") {
      posts++;
      return new Response('{"code":0,"data":{"chat_session_id":"fixture","message_id":"fixture"}}');
    }
    gets++;
    return new Response("");
  };
  const executor = new TraeExecutor() as any;
  const t = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(t, async () => {
      await executor.createSession({}, "full input", "fixture", {});
      await executor.streamEvents({}, "fixture", "fixture", () => false);
    }),
    uncertain
  );
  assert.equal(posts, 1);
  assert.equal(gets, 1);
});

test("ChatGPT metadata does not claim inference; one generation does", async () => {
  let sends = 0;
  __setTlsFetchOverrideForTesting(async () => {
    sends++;
    return { status: 200, headers: new Headers(), text: "ok", body: null };
  });
  const t = createRoutingTransportAttempt();
  await runWithRoutingTransportAttempt(t, async () => {
    await tlsFetchChatGpt("https://fixture.invalid/metadata");
    assert.equal(getRoutingTransportOutcome(t).modelDispatches, 0);
    await runWithRoutingTransportWire(() =>
      tlsFetchChatGpt("https://fixture.invalid/chat", { method: "POST", body: "full input" })
    );
  });
  assert.equal(sends, 2);
  assert.equal(getRoutingTransportOutcome(t).modelDispatches, 1);
  assert.equal(getRoutingTransportOutcome(t).wireDispatches, 1);
});

test("ChatGPT masked native rejection remains sticky despite mapped502", async () => {
  let sends = 0;
  const t = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(t, () =>
      runWithRoutingTransportWire(() =>
        __tlsFetchStreamingForTesting(
          {
            request: async () => {
              sends++;
              throw new Error("fixture loss");
            },
          },
          "https://fixture.invalid/chat",
          { followRedirects: false },
          "[DONE]",
          null,
          100,
          0
        )
      )
    ),
    uncertain
  );
  assert.equal(sends, 1);
});

test("ChatGPT managed redirect is not accepted or replayed", async () => {
  let sends = 0;
  __setTlsFetchOverrideForTesting(async () => {
    sends++;
    return {
      status: 307,
      headers: new Headers({ location: "https://fixture.invalid/other" }),
      text: "",
      body: null,
    };
  });
  const t = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(t, () =>
      runWithRoutingTransportWire(() =>
        tlsFetchChatGpt("https://fixture.invalid/chat", { method: "POST" })
      )
    ),
    uncertain
  );
  assert.equal(sends, 1);
});

test("ChatGPT unqualified resume performs zero secondary POSTs", async () => {
  let sends = 0;
  __setTlsFetchOverrideForTesting(async () => {
    sends++;
    return { status: 200, headers: new Headers(), text: "ok", body: null };
  });
  const t = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(t, () =>
      resumeChatGptHandoff({
        conversationId: "fixture",
        resumeToken: "fixture",
        headers: {},
        timeoutMs: 100,
        readContent: async function* () {},
      })
    ),
    { code: "routing_transport_replay_blocked" }
  );
  assert.equal(sends, 0);
  assert.equal(getRoutingTransportOutcome(t).modelDispatches, 0);
});

test("trusted token cancellation reaches pending custom fetch before result", async () => {
  const ac = new AbortController();
  const token = createRoutingTransportAttempt({ signal: ac.signal });
  let observed: AbortSignal | null | undefined;
  const pending = runWithRoutingTransportAttempt(token, () =>
    dispatchRoutingTransportFetch("https://fixture.invalid/model", {}, async (_u, init) => {
      observed = init?.signal;
      return new Promise((_resolve, reject) => {
        observed?.addEventListener("abort", () => reject(new Error("fixture aborted")), {
          once: true,
        });
      });
    })
  );
  await Promise.resolve();
  ac.abort();
  await assert.rejects(pending, uncertain);
  assert.equal(observed?.aborted, true);
});

test("trusted token cancellation wakes stalled body read and invokes cancel", async () => {
  const ac = new AbortController();
  const token = createRoutingTransportAttempt({ signal: ac.signal });
  let cancels = 0;
  const response = await runWithRoutingTransportAttempt(token, () =>
    dispatchRoutingTransportFetch(
      "https://fixture.invalid/model",
      {},
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancels++;
            },
          })
        )
    )
  );
  const pending = response.text();
  ac.abort();
  await assert.rejects(pending, uncertain);
  assert.equal(cancels, 1);
});

test("Cursor incomplete pending batch is refused before any result write", async () => {
  let writes = 0;
  const f = sessionFixture(() => writes++);
  const token = createRoutingTransportAttempt();
  await runWithRoutingTransportAttempt(token, () =>
    assert.equal(
      f.manager.sendToolResults(f.session, [{ id: "one", content: "a", isError: false }]),
      false
    )
  );
  assert.equal(writes, 0);
  assert.equal(f.session.pendingToolCalls.size, 2);
  assert.equal(getRoutingTransportOutcome(token).modelDispatches, 0);
  f.manager.close(f.session);
});

test("Cursor session binding rejects changed selected target without acquiring old stream", () => {
  const f = sessionFixture(() => {});
  f.session.routingBinding = "original-selected-account-model";
  f.manager.release(f.session, "awaiting_tool_result");
  assert.equal(f.manager.acquire("fixture", "other-selected-account-model"), undefined);
  assert.equal(f.session.state, "awaiting_tool_result");
  assert.equal(f.manager.acquire("fixture", "original-selected-account-model"), f.session);
  f.manager.close(f.session);
});

test("Cursor open abort listener transfers to drive and cannot close released stream", async () => {
  let closed = 0;
  const req = Object.assign(new EventEmitter(), {
    write() {
      queueMicrotask(() => req.emit("response", { ":status": 200 }));
    },
    close() {
      closed++;
    },
  });
  const client = Object.assign(new EventEmitter(), {
    request() {
      return req;
    },
    close() {
      closed++;
    },
  });
  const executor = new CursorExecutor({ connect: () => client } as any);
  const ac = new AbortController();
  const token = createRoutingTransportAttempt({ signal: ac.signal });
  const opened = await runWithRoutingTransportAttempt(token, () =>
    (executor as any).openH2(
      "https://fixture.invalid/chat",
      {},
      Buffer.from("full input"),
      ac.signal
    )
  );
  const ctx = newStreamCtx("fixture", () => {});
  const driven = runWithRoutingTransportAttempt(token, () =>
    (executor as any).driveH2(opened, ctx, undefined, new Map(), undefined, undefined, ac.signal)
  );
  ctx.endReason = "tool_calls";
  req.emit("end");
  await driven;
  ac.abort();
  assert.equal(closed, 0);
});

test("Cursor oversized frame after dispatch retains terminal uncertainty", async () => {
  const req = Object.assign(new EventEmitter(), { close() {} });
  const client = { close() {} };
  const executor = new CursorExecutor({} as any);
  const token = createRoutingTransportAttempt();
  const ctx = newStreamCtx("fixture", () => {});
  const pending = runWithRoutingTransportAttempt(token, () =>
    runWithRoutingTransportWire(() =>
      (executor as any).driveH2(
        { req, client, initialBytes: Buffer.alloc(0) },
        ctx,
        undefined,
        new Map(),
        undefined,
        undefined
      )
    )
  );
  const frame = Buffer.alloc(5);
  frame.writeUInt32BE(16 * 1024 * 1024 + 1, 1);
  req.emit("data", frame);
  await assert.rejects(pending, uncertain);
  assert.equal(getRoutingTransportOutcome(token).uncertain, true);
});

test("Bedrock token-only cancellation reaches SDK and closes iterator", async () => {
  const ac = new AbortController();
  const token = createRoutingTransportAttempt({ signal: ac.signal });
  let observed: any;
  let returns = 0;
  let release: any;
  const iterator = {
    next() {
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    return() {
      returns++;
      release?.({ done: true });
      return Promise.resolve({ done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const executor = new BedrockExecutor(() => ({
    send: async (_cmd: any, opts: any) => {
      observed = opts.abortSignal;
      return { stream: iterator };
    },
  }));
  const result = await runWithRoutingTransportAttempt(token, () =>
    executor.execute({ ...input, stream: true })
  );
  const body = result.response.text();
  ac.abort();
  await assert.rejects(body, uncertain);
  assert.equal(observed.aborted, true);
  assert.equal(returns, 1);
});

test("ChatGPT pending native deadline cannot be hidden as ordinary502", async () => {
  let sends = 0;
  const token = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () =>
      runWithRoutingTransportWire(() =>
        __tlsFetchStreamingForTesting(
          {
            request: async () => {
              sends++;
              return new Promise(() => {});
            },
          },
          "https://fixture.invalid/chat",
          { followRedirects: false },
          "[DONE]",
          null,
          10,
          0
        )
      )
    ),
    uncertain
  );
  assert.equal(sends, 1);
  assert.equal(getRoutingTransportOutcome(token).uncertain, true);
});
