import assert from "node:assert/strict";
import test from "node:test";
import {
  createRoutingTransportAttempt,
  getRoutingTransportOutcome,
  runWithRoutingTransportAttempt,
} from "../../open-sse/services/routingTransportContext.ts";

// The standard isolateDataDir preload must run before executor imports.
assert.ok(process.env.DATA_DIR, "fixtures require an isolated DATA_DIR");
assert.equal(process.env.OMNIROUTE_SKIP_SYSTEM_TRUST, "1");
assert.equal(process.env.OMNIROUTE_SKIP_DNS_WRITE, "1");
const forbidNetwork = async () => {
  throw new Error("fixture forbids unmocked network");
};
globalThis.fetch = forbidNetwork;
const { VeniceWebExecutor } = await import("../../open-sse/executors/venice-web.ts");
const { QwenWebExecutor } = await import("../../open-sse/executors/qwen-web.ts");
const { PoeWebExecutor } = await import("../../open-sse/executors/poe-web.ts");
const { GlmExecutor } = await import("../../open-sse/executors/glm.ts");
process.env.WEB_COOKIE_USE_BROWSER = "0";
process.env.OMNIROUTE_BROWSER_POOL = "off";
const { DuckDuckGoWebExecutor, __setDdgCircuitBreakerStateForTests } =
  await import("../../open-sse/executors/duckduckgo-web.ts");
const { FeloWebExecutor } = await import("../../open-sse/executors/felo-web.ts");
const { DeepSeekWebExecutor, tokenCache, sessionCache } =
  await import("../../open-sse/executors/deepseek-web.ts");
const { DeepSeekWebWithAutoRefreshExecutor } =
  await import("../../open-sse/executors/deepseek-web-with-auto-refresh.ts");
test.afterEach(() => {
  globalThis.fetch = forbidNetwork;
});

function input(model = "fixture-model", signal?: AbortSignal) {
  return {
    model,
    stream: false,
    signal,
    credentials: { apiKey: "fixture-only", providerSpecificData: {} },
    body: {
      model,
      messages: [
        { role: "system", content: "mandatory fixture policy" },
        { role: "user", content: "complete fixture input" },
      ],
      max_tokens: 123,
    },
  };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const brokenBody = (status = 200) =>
  new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(new Error("fixture body lost"));
      },
    }),
    { status, headers: { "content-type": "application/json" } }
  );

test("actual Venice managed request preserves standalone serialized payload and succeeds once", async () => {
  const bodies: unknown[] = [];
  const redirects: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    redirects.push(init?.redirect);
    return json({ choices: [{ message: { content: "fixture OK" } }] });
  };
  const executor = new VeniceWebExecutor();
  await executor.execute(input());
  const token = createRoutingTransportAttempt();
  const result = await runWithRoutingTransportAttempt(token, () => executor.execute(input()));
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual(bodies[1], { ...input().body, stream: false });
  assert.deepEqual(redirects, [undefined, "error"]);
  assert.equal((await result.response.json()).choices[0].message.content, "fixture OK");
  assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
  assert.equal(getRoutingTransportOutcome(token).uncertain, false);
});

test("actual Venice catch cannot conceal uncertain fetch execution", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("fixture socket lost");
  };
  const token = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => new VeniceWebExecutor().execute(input())),
    { code: "routing_transport_execution_uncertain" }
  );
  assert.equal(calls, 1);
});

test("actual Venice swallowed HTTP error-body read remains uncertain", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return brokenBody(503);
  };
  const token = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => new VeniceWebExecutor().execute(input())),
    { code: "routing_transport_execution_uncertain" }
  );
  assert.equal(calls, 1);
});

test("actual Poe success-body failure cannot produce an apparently successful result", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return brokenBody();
  };
  const token = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => new PoeWebExecutor().execute(input())),
    { code: "routing_transport_execution_uncertain" }
  );
  assert.equal(calls, 1);
});

test("actual Qwen chat setup stays outside model permit; one generation is guarded", async () => {
  const token = createRoutingTransportAttempt();
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("/chats/new")) {
      assert.equal(getRoutingTransportOutcome(token).modelDispatches, 0);
      return json({ data: { id: "fixture-chat" } });
    }
    assert.ok(target.includes("/chat/completions"));
    assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
    assert.equal(init?.redirect, "error");
    return new Response(
      'data: {"choices":[{"delta":{"content":"fixture OK","phase":"answer"}}]}\n\n',
      {
        headers: { "content-type": "text/event-stream" },
      }
    );
  };
  const result = await runWithRoutingTransportAttempt(token, () =>
    new QwenWebExecutor().execute(input())
  );
  assert.equal(calls.length, 2);
  assert.equal((await result.response.json()).choices[0].message.content, "fixture OK");
});

test("actual Qwen cancellation during setup prevents generation dispatch", async () => {
  const controller = new AbortController();
  const token = createRoutingTransportAttempt({ signal: controller.signal });
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    controller.abort();
    return json({ data: { id: "fixture-chat" } });
  };
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () =>
      new QwenWebExecutor().execute(input("fixture-model", controller.signal))
    ),
    { code: "routing_transport_cancelled" }
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("/chats/new"));
  assert.equal(getRoutingTransportOutcome(token).modelDispatches, 0);
});

test("actual Qwen swallowed stream read failure remains uncertain", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return String(url).includes("/chats/new")
      ? json({ data: { id: "fixture-chat" } })
      : brokenBody();
  };
  const token = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => new QwenWebExecutor().execute(input())),
    { code: "routing_transport_execution_uncertain" }
  );
  assert.equal(calls, 2);
  assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
});

test("actual GLM managed 429 returns original result without hidden alternate transport", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json({ error: { message: "fixture rate limit" } }, 429);
  };
  const token = createRoutingTransportAttempt();
  const result = await runWithRoutingTransportAttempt(token, () =>
    new GlmExecutor().execute(input("glm-4.7"))
  );
  assert.equal(calls, 1);
  assert.equal(result.response.status, 429);
  assert.equal(getRoutingTransportOutcome(token).blocked, false);
  assert.equal(getRoutingTransportOutcome(token).uncertain, false);
});

test("actual GLM standalone 429 keeps its existing alternate transport behavior", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json({ error: { message: "fixture rate limit" } }, 429);
  };
  const result = await new GlmExecutor().execute(input("glm-4.7"));
  assert.equal(calls, 2);
  assert.equal(result.response.status, 429);
});

test("actual GLM managed transport uncertainty does not try alternate endpoint", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("fixture fetch failed");
  };
  const token = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => new GlmExecutor().execute(input("glm-4.7"))),
    { code: "routing_transport_execution_uncertain" }
  );
  assert.equal(calls, 1);
});

test("pre-aborted actual custom executor request performs neither setup nor inference", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json({});
  };
  const controller = new AbortController();
  controller.abort();
  const token = createRoutingTransportAttempt({ signal: controller.signal });
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () =>
      new QwenWebExecutor().execute(input("fixture-model", controller.signal))
    ),
    { code: "routing_transport_cancelled" }
  );
  assert.equal(calls, 0);
});

function ddg() {
  __setDdgCircuitBreakerStateForTests(0, 0);
  const executor = new DuckDuckGoWebExecutor();
  // Existing metadata/session boundaries use fixture values; real sendChat/seed execute.
  (executor as any).getPool = () => null;
  (executor as any).warmSession = async () => {};
  (executor as any).acquireAuthHeaders = async () => ({
    vqd4: "fixture",
    vqdHash1: null,
    status: 200,
    retryAfter: null,
  });
  return executor;
}

for (const status of [401, 403, 418]) {
  test(`actual DuckDuckGo managed ${status} sends only requested input, without seed or auth replay`, async () => {
    const sent: any[] = [];
    globalThis.fetch = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return json({ error: "fixture response" }, status);
    };
    const token = createRoutingTransportAttempt();
    const result = await runWithRoutingTransportAttempt(token, () => ddg().execute(input()));
    assert.equal(result.status, status);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].messages, input().body.messages);
    assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
    assert.equal(getRoutingTransportOutcome(token).blocked, false);
  });
}

test("actual DuckDuckGo standalone optional seed remains separate from requested input", async () => {
  const sent: any[] = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response('data: {"message":"fixture answer"}\n', {
      headers: { "content-type": "text/event-stream" },
    });
  };
  await ddg().execute(input());
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(sent[1].messages, input().body.messages);
});

test("actual DuckDuckGo caught transport failure stays uncertain, with no status retry", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("fixture transport lost");
  };
  const token = createRoutingTransportAttempt();
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => ddg().execute(input())),
    { code: "routing_transport_execution_uncertain" }
  );
  assert.equal(calls, 1);
});

test("actual Felo generation POST plus stream GET use one model permit", async () => {
  const token = createRoutingTransportAttempt();
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(init?.method));
    assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
    if (init?.method === "POST") {
      assert.equal(JSON.parse(String(init.body)).query, "complete fixture input");
      return json({ stream_key: "fixture-stream" });
    }
    const content = JSON.stringify({ data: { type: "answer", data: { text: "fixture OK" } } });
    return new Response(`data:${JSON.stringify({ content })}\n`);
  };
  const result = await runWithRoutingTransportAttempt(token, () =>
    new FeloWebExecutor().execute(input())
  );
  assert.deepEqual(calls, ["POST", "GET"]);
  assert.equal((await result.json()).choices[0].message.content, "fixture OK");
  assert.equal(getRoutingTransportOutcome(token).uncertain, false);
});

for (const failure of ["fetch", "status", "body"]) {
  test(`actual Felo ${failure} failure while retrieving started generation is terminal uncertainty`, async () => {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      if (init?.method === "POST") return json({ stream_key: "fixture-stream" });
      if (failure === "fetch") throw new Error("fixture retrieval lost");
      if (failure === "status") return json({ error: "fixture retrieval unavailable" }, 503);
      return brokenBody();
    };
    const token = createRoutingTransportAttempt();
    await assert.rejects(
      runWithRoutingTransportAttempt(token, () => new FeloWebExecutor().execute(input())),
      { code: "routing_transport_execution_uncertain" }
    );
    assert.equal(calls, 2);
    assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
  });
}

// Same bounded difficulty-one PoW fixture used by the existing DeepSeek session tests.
const powFixture = {
  algorithm: "DeepSeekHashV1",
  challenge: "311b26ae1e0fe7375e242958ce46db5552a6c67fea3f96880dcd846c63a74286",
  salt: "1122334455667788",
  signature: "fixture",
  difficulty: 1,
  expire_at: 1778891543095,
  expire_after: 300000,
  target_path: "/api/v0/chat/completion",
};

test("actual DeepSeek managed stale-session failure does not create or dispatch replacement session", async () => {
  tokenCache.clear();
  sessionCache.clear();
  tokenCache.set("fixture-only", {
    accessToken: "fixture-access",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  });
  sessionCache.set("fixture-only", { sessionId: "fixture-existing", createdAt: Date.now() });
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("/create_pow_challenge"))
      return json({ code: 0, data: { biz_data: { challenge: powFixture } } });
    assert.ok(target.endsWith("/chat/completion"), "unexpected metadata or retry request");
    return json({ error: "fixture unavailable" }, 503);
  };
  const request = input();
  request.credentials.providerSpecificData = { persistSession: true };
  const token = createRoutingTransportAttempt();
  const result = await runWithRoutingTransportAttempt(token, () =>
    new DeepSeekWebExecutor().execute(request)
  );
  assert.equal(result.response.status, 503);
  assert.equal(calls.filter((url) => url.endsWith("/chat/completion")).length, 1);
  assert.equal(calls.filter((url) => url.includes("/chat_session/create")).length, 0);
  assert.equal(getRoutingTransportOutcome(token).blocked, false);
  tokenCache.clear();
  sessionCache.clear();
});

for (const managed of [true, false]) {
  test(`actual DeepSeek refresh wrapper ${managed ? "managed suppresses" : "standalone preserves"} auth retry`, async () => {
    const executor = new DeepSeekWebWithAutoRefreshExecutor({ autoRefresh: false });
    let attempts = 0,
      refreshes = 0;
    (executor as any).executeBase = async () => ({
      response: json({}, ++attempts === 1 ? 401 : 200),
    });
    (executor as any).doRefreshSession = async () => {
      refreshes++;
    };
    const run = () => executor.execute(input());
    const result = managed
      ? await runWithRoutingTransportAttempt(createRoutingTransportAttempt(), run)
      : await run();
    assert.equal(attempts, managed ? 1 : 2);
    assert.equal(refreshes, managed ? 0 : 1);
    assert.equal(result.response.status, managed ? 401 : 200);
    executor.destroy();
  });
}
