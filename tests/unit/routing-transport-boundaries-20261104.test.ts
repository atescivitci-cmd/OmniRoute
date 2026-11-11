import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertRoutingTransportOutcome,
  createRoutingTransportAttempt,
  getRoutingTransportOutcome,
  runWithRoutingTransportAttempt,
  runWithRoutingTransportWire,
} from "../../open-sse/services/routingTransportContext.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "routing-transport-fixture-"));
process.env.DATA_DIR = data;
process.env.OMNIROUTE_CODEX_WS_ENABLED = "true";
process.env.ENABLE_TLS_FINGERPRINT = "false";
// Any accidentally unmocked network path fails before making a request.
globalThis.fetch = async () => {
  throw new Error("fixture forbids network");
};
const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
const { BaseExecutor } = await import("../../open-sse/executors/base.ts");
const { CodexExecutor, __setCodexWebSocketTransportForTesting, peekCodexSseTransientError } =
  await import("../../open-sse/executors/codex.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

test.after(() => {
  __setCodexWebSocketTransportForTesting(undefined);
  resetDbInstance();
  fs.rmSync(data, { recursive: true, force: true });
});
test.afterEach(() => {
  globalThis.fetch = async () => {
    throw new Error("fixture forbids network");
  };
  __setCodexWebSocketTransportForTesting(undefined);
});

test("managed proxy socket error never triggers retry, native fallback or proxy search", async () => {
  const token = createRoutingTransportAttempt();
  let wire = 0,
    native = 0;
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () =>
      runWithRoutingTransportWire(() =>
        proxyFetch(
          "https://fixture.invalid/chat",
          { method: "POST", body: "{}" },
          {
            undiciFetch: async () => {
              wire++;
              throw Object.assign(new Error("fetch failed"), { code: "UND_ERR_SOCKET" });
            },
            nativeFetch: async () => {
              native++;
              return new Response("forbidden");
            },
          }
        )
      )
    ),
    { code: "routing_transport_execution_uncertain" }
  );
  assert.equal(wire, 1);
  assert.equal(native, 0);
});

test("standalone proxy retry remains unchanged", async () => {
  let wire = 0;
  const result = await proxyFetch(
    "https://fixture.invalid/chat",
    { method: "POST", body: "{}" },
    {
      undiciFetch: async () => {
        wire++;
        if (wire === 1) throw Object.assign(new Error("fetch failed"), { code: "UND_ERR_SOCKET" });
        return new Response("ok");
      },
      nativeFetch: async () => {
        throw new Error("unexpected native fallback");
      },
    }
  );
  assert.equal(await result.text(), "ok");
  assert.equal(wire, 2);
});

test("managed TLS failure does not fall through to another transport", async () => {
  process.env.ENABLE_TLS_FINGERPRINT = "true";
  const token = createRoutingTransportAttempt();
  let tls = 0,
    alternate = 0;
  try {
    await assert.rejects(
      runWithRoutingTransportAttempt(token, () =>
        runWithRoutingTransportWire(() =>
          proxyFetch(
            "https://fixture.invalid/chat",
            { method: "POST", body: "{}" },
            {
              tlsFetch: async () => {
                tls++;
                throw new Error("synthetic TLS response lost");
              },
              undiciFetch: async () => {
                alternate++;
                return new Response("forbidden");
              },
              nativeFetch: async () => {
                alternate++;
                return new Response("forbidden");
              },
            }
          )
        )
      ),
      { code: "routing_transport_execution_uncertain" }
    );
    assert.equal(tls, 1);
    assert.equal(alternate, 0);
  } finally {
    process.env.ENABLE_TLS_FINGERPRINT = "false";
  }
});

test("managed TLS uses manual redirect and refuses implicit POST replay", async () => {
  process.env.ENABLE_TLS_FINGERPRINT = "true";
  const token = createRoutingTransportAttempt();
  let tls = 0;
  try {
    await assert.rejects(
      runWithRoutingTransportAttempt(token, () =>
        runWithRoutingTransportWire(() =>
          proxyFetch(
            "https://fixture.invalid/chat",
            { method: "POST", body: "{}", redirect: "error" },
            {
              tlsFetch: async (_url, init) => {
                tls++;
                assert.equal(init?.redirect, "manual");
                return new Response(null, {
                  status: 307,
                  headers: { location: "https://other.invalid" },
                });
              },
              undiciFetch: async () => {
                throw new Error("forbidden alternate");
              },
            }
          )
        )
      ),
      { code: "routing_transport_execution_uncertain" }
    );
    assert.equal(tls, 1);
  } finally {
    process.env.ENABLE_TLS_FINGERPRINT = "false";
  }
});

class FixtureExecutor extends BaseExecutor {
  constructor() {
    super("fixture-provider", {
      baseUrls: ["https://fixture.invalid/a", "https://fixture.invalid/b"],
    } as never);
  }
  buildHeaders() {
    return {};
  }
  transformRequest(_model: string, body: unknown) {
    return structuredClone(body);
  }
  needsRefresh() {
    return false;
  }
}
const input = () => ({
  model: "fixture-model",
  body: {
    messages: [{ role: "user", content: "preserve all input" }],
    context_management: { edits: [] },
  },
  stream: false,
  credentials: {},
  contextEditing: { enabled: true },
});

test("managed BaseExecutor 400 does not strip fields or send corrective POST", async () => {
  const token = createRoutingTransportAttempt();
  const sent: string[] = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(String(init?.body));
    assert.equal(init?.redirect, "error");
    return Response.json(
      { error: { message: "Unsupported parameter: context_management" } },
      { status: 400 }
    );
  };
  const result = await runWithRoutingTransportAttempt(token, () =>
    new FixtureExecutor().execute(input())
  );
  assert.equal(result.response.status, 400);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /preserve all input/);
  assert.match(sent[0], /context_management/);
  assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
});

test("standalone BaseExecutor keeps existing context correction retry", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? Response.json(
          { error: { message: "Unsupported parameter: context_management" } },
          { status: 400 }
        )
      : Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  const result = await new FixtureExecutor().execute(input());
  assert.equal(result.response.status, 200);
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].context_management);
  assert.equal(bodies[1].context_management, undefined);
  assert.deepEqual(bodies[1].messages, bodies[0].messages);
});

test("managed BaseExecutor 429 returns once without intra-URL or URL fallback", async () => {
  const token = createRoutingTransportAttempt();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: { message: "rate limit" } }, { status: 429 });
  };
  const result = await runWithRoutingTransportAttempt(token, () =>
    new FixtureExecutor().execute(input())
  );
  assert.equal(result.response.status, 429);
  assert.equal(calls, 1);
});

test("managed BaseExecutor thrown fetch remains uncertain and never tries alternate URL", async () => {
  const token = createRoutingTransportAttempt();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("synthetic lost response");
  };
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => new FixtureExecutor().execute(input())),
    { code: "routing_transport_execution_uncertain" }
  );
  assert.equal(calls, 1);
});

test("managed BaseExecutor keeps fetch-start timeout armed until transport settles", async () => {
  const token = createRoutingTransportAttempt();
  const executor = new FixtureExecutor();
  executor.config.timeoutMs = 10;
  let aborted = false;
  globalThis.fetch = async (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      const guard = setTimeout(() => resolve(new Response("late response")), 100);
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          clearTimeout(guard);
          reject(init.signal?.reason);
        },
        { once: true }
      );
    });
  await assert.rejects(
    runWithRoutingTransportAttempt(token, () => executor.execute(input())),
    {
      code: "routing_transport_execution_uncertain",
    }
  );
  assert.equal(aborted, true);
});

const wsInput = () => ({
  model: "fixture-model",
  body: { input: [{ role: "user", content: "fixture" }] },
  stream: true,
  credentials: {
    accessToken: "fixture-not-a-real-token",
    providerSpecificData: { codexTransport: "websocket" },
  },
});

test("Codex WebSocket send failure is sticky uncertainty with one send and zero HTTP fallback", async () => {
  const token = createRoutingTransportAttempt();
  let sends = 0,
    http = 0;
  globalThis.fetch = async () => {
    http++;
    throw new Error("forbidden HTTP");
  };
  __setCodexWebSocketTransportForTesting(async () => ({
    send() {
      sends++;
      throw new Error("synthetic send failed");
    },
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  }));
  await assert.rejects(
    runWithRoutingTransportAttempt(token, async () => {
      const result = await new CodexExecutor().execute(wsInput());
      await result.response.text();
    }),
    { code: "routing_transport_execution_uncertain" }
  );
  assert.equal(sends, 1);
  assert.equal(http, 0);
});

test("late Codex WebSocket error keeps captured attempt uncertainty after returned response", async () => {
  const token = createRoutingTransportAttempt();
  let socket: any;
  let notifySent!: () => void;
  const sent = new Promise<void>((r) => {
    notifySent = r;
  });
  __setCodexWebSocketTransportForTesting(
    async () =>
      (socket = {
        send() {
          notifySent();
        },
        close() {},
        onmessage: null,
        onerror: null,
        onclose: null,
      })
  );
  const result = await runWithRoutingTransportAttempt(token, () =>
    new CodexExecutor().execute(wsInput())
  );
  await sent;
  socket.onerror({ message: "synthetic later error" });
  await result.response.text();
  assert.throws(() => assertRoutingTransportOutcome(token), {
    code: "routing_transport_execution_uncertain",
  });
  assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
});

test("managed Codex HTTP peek timeout retains uncertainty after headers", async () => {
  const token = createRoutingTransportAttempt();
  const response = new Response(new ReadableStream({ pull() {}, cancel() {} }), {
    headers: { "content-type": "text/event-stream" },
  });
  await assert.rejects(
    runWithRoutingTransportAttempt(token, async () => {
      await runWithRoutingTransportWire(() => response);
      const peek = await peekCodexSseTransientError(response, 5);
      assert.equal(peek.timedOut, true);
    }),
    { code: "routing_transport_execution_uncertain" }
  );
  assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
});

test("managed Codex HTTP peek read error cannot be swallowed into successful response", async () => {
  const token = createRoutingTransportAttempt();
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(new Error("synthetic body failure"));
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
  await assert.rejects(
    runWithRoutingTransportAttempt(token, async () => {
      await runWithRoutingTransportWire(() => response);
      try {
        await peekCodexSseTransientError(response, 5);
      } catch {}
      return "pretend success";
    }),
    { code: "routing_transport_execution_uncertain" }
  );
});

test("managed Codex late passthrough error marks original token outside its execution context", async () => {
  const token = createRoutingTransportAttempt();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_text.delta","delta":"fixture"}\n\n'
          )
        );
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
  const peek = await runWithRoutingTransportAttempt(token, async () => {
    await runWithRoutingTransportWire(() => response);
    return peekCodexSseTransientError(response, 500);
  });
  assert.ok(peek.replacementBody);
  const reader = peek.replacementBody!.getReader();
  assert.equal((await reader.read()).done, false);
  upstream.error(new Error("synthetic later body failure"));
  await assert.rejects(reader.read());
  assert.throws(() => assertRoutingTransportOutcome(token), {
    code: "routing_transport_execution_uncertain",
  });
});

test("managed Codex body reader setup failure cannot be swallowed", async () => {
  const token = createRoutingTransportAttempt();
  const response = new Response("fixture", { headers: { "content-type": "text/event-stream" } });
  const heldReader = response.body!.getReader();
  try {
    await assert.rejects(
      runWithRoutingTransportAttempt(token, async () => {
        await runWithRoutingTransportWire(() => response);
        try {
          await peekCodexSseTransientError(response, 5);
        } catch {}
        return "pretend success";
      }),
      { code: "routing_transport_execution_uncertain" }
    );
  } finally {
    heldReader.releaseLock();
  }
});
