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
} from "../../open-sse/services/routingTransportContext.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-routing-fixture-"));
process.env.DATA_DIR = data;
process.env.ENABLE_TLS_FINGERPRINT = "false";
globalThis.fetch = async () => {
  throw new Error("fixture forbids network");
};
const { CopilotWebExecutor } = await import("../../open-sse/executors/copilot-web.ts");
const { CopilotM365WebExecutor, __setCopilotM365WebSocketForTesting } =
  await import("../../open-sse/executors/copilot-m365-web.ts");
const { encodeFrame } = await import("../../open-sse/executors/copilot-m365-frames.ts");
const { FETCH_TIMEOUT_MS } = await import("../../open-sse/config/constants.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

type Provider = "web" | "m365";
class FakeSocket {
  static instances: FakeSocket[] = [];
  static onSend: ((socket: FakeSocket, frame: any) => void) | undefined;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: (event: { message: string }) => void;
  onclose?: () => void;
  handlers = new Map<string, (...args: any[]) => void>();
  sent: any[] = [];
  closed = false;
  constructor(..._args: any[]) {
    FakeSocket.instances.push(this);
  }
  on(event: string, handler: (...args: any[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }
  send(raw: string) {
    const frame = JSON.parse(raw.replace(/\x1e$/, ""));
    this.sent.push(frame);
    FakeSocket.onSend?.(this, frame);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
    this.handlers.get("open")?.();
  }
  message(provider: Provider, frame: unknown) {
    if (provider === "web") this.onmessage?.({ data: JSON.stringify(frame) });
    else this.handlers.get("message")?.(Buffer.from(encodeFrame(frame as any)));
  }
  error() {
    this.onerror?.({ message: "synthetic socket failure" });
    this.handlers.get("error")?.(new Error("synthetic socket failure"));
  }
  remoteClose() {
    this.onclose?.();
    this.handlers.get("close")?.();
  }
}
const originalWebSocket = globalThis.WebSocket;
const originalSetTimeout = globalThis.setTimeout;
let restoreM365 = () => {};
let metadataCalls = 0;
let sequence = 0;

test.beforeEach(() => {
  metadataCalls = 0;
  FakeSocket.instances = [];
  FakeSocket.onSend = undefined;
  globalThis.WebSocket = FakeSocket as any;
  restoreM365 = __setCopilotM365WebSocketForTesting(FakeSocket as any);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://copilot.microsoft.com/c/api/start");
    assert.equal(init?.method, "POST");
    metadataCalls++;
    return new Response(
      JSON.stringify({ conversationId: "fixture-conversation", remainingTurns: 100 }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  };
});
test.afterEach(() => {
  restoreM365();
  globalThis.WebSocket = originalWebSocket;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.fetch = async () => {
    throw new Error("fixture forbids network");
  };
});
test.after(() => {
  resetDbInstance();
  fs.rmSync(data, { recursive: true, force: true });
});

function executor(provider: Provider) {
  return provider === "web" ? new CopilotWebExecutor() : new CopilotM365WebExecutor();
}
function input(provider: Provider, signal?: AbortSignal, stream = true) {
  return {
    model: provider === "web" ? "copilot" : "copilot-m365",
    stream,
    signal,
    body: { messages: [{ role: "user", content: "synthetic fixture" }] },
    credentials: {
      apiKey: `fixture-${++sequence}`,
      providerSpecificData: { chathubPath: "fixture-user@fixture-tenant" },
    },
  } as any;
}
function isModel(frame: any) {
  return frame.event === "send" || (frame.type === 4 && frame.target === "chat");
}
function dispatch(provider: Provider, socket: FakeSocket) {
  socket.open();
  if (provider === "m365") socket.message(provider, {});
}
function complete(provider: Provider, socket: FakeSocket) {
  if (provider === "web") {
    socket.message(provider, { event: "appendText", text: "fixture answer" });
    socket.message(provider, { event: "done" });
  } else {
    socket.message(provider, {
      type: 1,
      target: "update",
      arguments: [{ messages: [{ author: "bot", text: "fixture answer" }] }],
    });
    socket.message(provider, { type: 3 });
  }
}
async function opened(provider: Provider, signal?: AbortSignal) {
  const token = createRoutingTransportAttempt({ signal });
  const result = await runWithRoutingTransportAttempt(token, () =>
    executor(provider).execute(input(provider, signal))
  );
  assert.equal(FakeSocket.instances.length, 1);
  return { token, response: result.response, socket: FakeSocket.instances[0] };
}

for (const provider of ["web", "m365"] as const) {
  test(`${provider}: metadata/handshake leaves permit unused and a completed model turn claims once`, async () => {
    const { token, response, socket } = await opened(provider);
    assert.equal(getRoutingTransportOutcome(token).modelDispatches, 0);
    assert.equal(metadataCalls, provider === "web" ? 1 : 0);
    if (provider === "m365") {
      socket.open();
      assert.equal(getRoutingTransportOutcome(token).modelDispatches, 0);
      socket.message(provider, {});
    } else socket.open();
    assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
    complete(provider, socket);
    assert.match(await response.text(), /fixture answer/);
    assert.equal(socket.sent.filter(isModel).length, 1);
    assert.equal(socket.closed, true);
    assert.doesNotThrow(() => assertRoutingTransportOutcome(token));
  });

  test(`${provider}: already aborted input never opens a socket or sends inference`, async () => {
    const abort = new AbortController();
    abort.abort();
    // Deliberately omit token signal to exercise the executor's input-signal check.
    const token = createRoutingTransportAttempt();
    await assert.rejects(
      runWithRoutingTransportAttempt(token, () =>
        executor(provider).execute(input(provider, abort.signal))
      ),
      { code: "routing_transport_cancelled" }
    );
    assert.equal(FakeSocket.instances.length, 0);
    assert.equal(getRoutingTransportOutcome(token).modelDispatches, 0);
  });

  test(`${provider}: abort before socket open prevents later callback dispatch`, async () => {
    const abort = new AbortController();
    const { token, response, socket } = await opened(provider, abort.signal);
    abort.abort();
    dispatch(provider, socket);
    await assert.rejects(response.text(), { code: "routing_transport_cancelled" });
    assert.equal(socket.sent.filter(isModel).length, 0);
    assert.equal(getRoutingTransportOutcome(token).uncertain, false);
    assert.equal(socket.closed, true);
  });

  test(`${provider}: synchronous model send failure is sticky uncertainty`, async () => {
    const { token, response, socket } = await opened(provider);
    FakeSocket.onSend = (_socket, frame) => {
      if (isModel(frame)) throw new Error("synthetic send loss");
    };
    dispatch(provider, socket);
    await assert.rejects(response.text(), { code: "routing_transport_execution_uncertain" });
    assert.equal(socket.sent.filter(isModel).length, 1);
    assert.equal(getRoutingTransportOutcome(token).uncertain, true);
    dispatch(provider, socket);
    assert.equal(socket.sent.filter(isModel).length, 1);
  });

  for (const terminal of ["error", "close"] as const) {
    test(`${provider}: post-send ${terminal} outside ALS stays uncertain`, async () => {
      const { token, response, socket } = await opened(provider);
      dispatch(provider, socket);
      if (terminal === "error") socket.error();
      else socket.remoteClose();
      await assert.rejects(response.text(), { code: "routing_transport_execution_uncertain" });
      assert.equal(getRoutingTransportOutcome(token).uncertain, true);
      assert.equal(socket.sent.filter(isModel).length, 1);
    });
  }

  test(`${provider}: downstream cancellation closes socket and prevents replay`, async () => {
    const { token, response, socket } = await opened(provider);
    dispatch(provider, socket);
    await response.body!.cancel();
    assert.deepEqual(getRoutingTransportOutcome(token), {
      modelDispatches: 1,
      wireDispatches: 0,
      uncertain: true,
      cancelled: true,
      blocked: false,
    });
    assert.equal(socket.closed, true);
    dispatch(provider, socket);
    assert.equal(socket.sent.filter(isModel).length, 1);
  });

  test(`${provider}: post-send timeout stays uncertain and does not retry`, async () => {
    let timeout: (() => void) | undefined;
    globalThis.setTimeout = ((
      callback: (...args: any[]) => void,
      delay: number,
      ...args: any[]
    ) => {
      if (delay === FETCH_TIMEOUT_MS) {
        timeout = () => callback(...args);
        const timer = originalSetTimeout(() => {}, 60_000);
        timer.unref();
        return timer;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as any;
    const { token, response, socket } = await opened(provider);
    dispatch(provider, socket);
    assert.ok(timeout);
    timeout();
    await assert.rejects(response.text(), { code: "routing_transport_execution_uncertain" });
    assert.equal(getRoutingTransportOutcome(token).uncertain, true);
    assert.equal(socket.sent.filter(isModel).length, 1);
  });

  test(`${provider}: non-streaming conversion cannot hide post-dispatch loss as success`, async () => {
    const token = createRoutingTransportAttempt();
    const pending = runWithRoutingTransportAttempt(token, () =>
      executor(provider).execute(input(provider, undefined, false))
    );
    for (let i = 0; i < 30 && FakeSocket.instances.length === 0; i++) await Promise.resolve();
    const socket = FakeSocket.instances[0];
    assert.ok(socket);
    dispatch(provider, socket);
    socket.error();
    await assert.rejects(pending, { code: "routing_transport_execution_uncertain" });
    assert.equal(getRoutingTransportOutcome(token).modelDispatches, 1);
  });

  test(`${provider}: unmanaged completed protocol remains successful`, async () => {
    const result = await executor(provider).execute(input(provider));
    const socket = FakeSocket.instances[0];
    dispatch(provider, socket);
    complete(provider, socket);
    assert.match(await result.response.text(), /fixture answer/);
    assert.equal(socket.sent.filter(isModel).length, 1);
  });
}

test("web: managed hashcash challenge cannot resend the prompt", async () => {
  const { token, response, socket } = await opened("web");
  dispatch("web", socket);
  socket.message("web", { event: "challenge", method: "hashcash", parameter: "fixture:1" });
  await assert.rejects(response.text(), { code: "routing_transport_execution_uncertain" });
  assert.equal(getRoutingTransportOutcome(token).uncertain, true);
  assert.equal(socket.sent.filter(isModel).length, 1);
  assert.equal(
    socket.sent.some((frame) => frame.event === "challengeResponse"),
    false
  );
});

test("web: unmanaged hashcash response and existing prompt resend remain unchanged", async () => {
  const { response } = await new CopilotWebExecutor().execute(input("web"));
  const socket = FakeSocket.instances[0];
  dispatch("web", socket);
  socket.message("web", { event: "challenge", method: "hashcash", parameter: "fixture:1" });
  complete("web", socket);
  assert.match(await response.text(), /fixture answer/);
  assert.equal(socket.sent.filter(isModel).length, 2);
  assert.equal(
    socket.sent.some((frame) => frame.event === "challengeResponse"),
    true
  );
});

test("m365: cancellation during keepalive prevents the model invocation", async () => {
  const abort = new AbortController();
  const { token, response, socket } = await opened("m365", abort.signal);
  FakeSocket.onSend = (_socket, frame) => {
    if (frame.type === 6) abort.abort();
  };
  dispatch("m365", socket);
  await assert.rejects(response.text(), { code: "routing_transport_cancelled" });
  assert.equal(getRoutingTransportOutcome(token).modelDispatches, 0);
  assert.equal(socket.sent.filter(isModel).length, 0);
});

for (const provider of ["web", "m365"] as const) {
  test(`${provider}: trusted token-only abort promptly closes an idle socket`, async () => {
    const ac = new AbortController();
    const token = createRoutingTransportAttempt({ signal: ac.signal });
    const result = await runWithRoutingTransportAttempt(token, () =>
      executor(provider).execute(input(provider))
    );
    const socket = FakeSocket.instances[0];
    assert.ok(socket);
    dispatch(provider, socket);
    ac.abort();
    await assert.rejects(result.response.text(), { code: "routing_transport_execution_uncertain" });
    assert.equal(socket.closed, true);
    assert.equal(getRoutingTransportOutcome(token).cancelled, true);
    assert.equal(socket.sent.filter(isModel).length, 1);
  });
}
