// VISION_HISTORY_PLACEHOLDER_V1. Hermetic: no network, no provider, no Ollama; mocks only.
import test from "node:test";
import assert from "node:assert/strict";

const target = new URL("../../open-sse/services/localFinalFallback.mjs", import.meta.url).href;
const { finalLocalFallback, LOCAL_ROUTE } = await import(target);

const IMG = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };

function run(body, { remoteStatus = 503, remoteCode } = {}) {
  const calls = [];
  const remoteBody = remoteCode ? { error: { code: remoteCode } } : { error: { message: "quota" } };
  const options = {
    body,
    combo: {
      name: "ac-terminal-continuity",
      config: {
        finalLocalFallbackModel: LOCAL_ROUTE,
        zeroAdditionalCostProviders: ["ollama-local"],
        localArchiveContinuation: true,
      },
      allowedProviders: ["ollama-local"],
    },
    log: { info() {}, warn() {} },
    isModelAvailable: async () => true,
    handleSingleModel: async (sent) => {
      calls.push(sent);
      return Response.json({ ok: true });
    },
  };
  const remote = async () => Response.json(remoteBody, { status: remoteStatus });
  return finalLocalFallback(options, remote).then((res) => ({ res, calls, options }));
}

const hasImage = (v) => JSON.stringify(v).includes('"type":"image"');

test("earlier image + text-only latest turn reaches local with a placeholder", async () => {
  const body = {
    max_tokens: 100,
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, IMG] },
      { role: "assistant", content: "I see it." },
      { role: "user", content: "summarize where we are" },
    ],
  };
  const before = structuredClone(body);
  const { res, calls, options } = await run(body);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(hasImage(calls[0]), false);
  assert.match(JSON.stringify(calls[0]), /Image omitted/);
  assert.deepEqual(options.body, before, "caller body must not be mutated");
});

test("image nested in an earlier tool_result is replaced too", async () => {
  const body = {
    max_tokens: 100,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [IMG] }] },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ],
  };
  const { res, calls } = await run(body);
  assert.equal(res.status, 200);
  assert.equal(hasImage(calls[0]), false);
});

test("image in the latest user turn still refuses (capability_mismatch)", async () => {
  const body = {
    max_tokens: 100,
    messages: [
      { role: "assistant", content: "hi" },
      { role: "user", content: [{ type: "text", text: "what is this" }, IMG] },
    ],
  };
  const { res, calls } = await run(body);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "capability_mismatch");
  assert.equal(calls.length, 0);
});

test("image in the latest tool_result still refuses", async () => {
  const body = {
    max_tokens: 100,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [IMG] }] },
    ],
  };
  const { res, calls } = await run(body);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("remote context_length_exceeded with images is still returned unchanged", async () => {
  const body = {
    max_tokens: 100,
    messages: [
      { role: "user", content: [IMG] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "go" },
    ],
  };
  const { res, calls } = await run(body, {
    remoteStatus: 400,
    remoteCode: "context_length_exceeded",
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "context_length_exceeded");
  assert.equal(calls.length, 0);
});

test("unconvertible visual (computer_screenshot) in history still refuses", async () => {
  const body = {
    max_tokens: 100,
    input: [
      {
        type: "computer_call_output",
        output: { type: "computer_screenshot", image_url: "data:image/png;base64,AA" },
      },
      { role: "assistant", content: "ok" },
      { role: "user", content: "go" },
    ],
  };
  const { res, calls } = await run(body);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("text-only request behavior is unchanged", async () => {
  const body = { max_tokens: 100, messages: [{ role: "user", content: "hello" }] };
  const { res, calls } = await run(body);
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], body);
});
