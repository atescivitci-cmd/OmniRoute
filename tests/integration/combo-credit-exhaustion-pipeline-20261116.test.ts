/**
 * Real-pipeline coverage for the credit-exhaustion advance (handleChat -> combo -> routing guard
 * -> handleSingleModelChat -> chatCore -> real executors, with only fetch mocked). The stub-level
 * unit tests cannot see chatCore's error rewriting: every upstream 402 reaches the router as the
 * canonical envelope {error:{message:"[402]: <text>", type:"billing_error", code:"payment_required"}}
 * whatever the upstream sent, so these tests drive the real shapes.
 *
 * The harness pins DATA_DIR to a throwaway temp dir; ~/.omniroute is never opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHeaders } from "../../open-sse/utils/headers.ts";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("combo-credit-exhaustion-pipeline");
const { BaseExecutor, buildOpenAIResponse, buildRequest, combosDb, handleChat, resetStorage } =
  harness;
const { seedConnection, settingsDb } = harness;
assert.equal(process.env.DATA_DIR, harness.TEST_DATA_DIR, "DATA_DIR must be the harness temp dir");

const ANTHROPIC_CREDIT =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type Part = { text?: string };
type Msg = { role?: string; content?: string | Part[] };
type Tool = { name?: string; function?: { name?: string } };
type Body = { messages?: Msg[]; tools?: Tool[] };
type Shape = { name: string; make: () => Response; advances: boolean; status?: number };

const SHAPES: Shape[] = [
  {
    name: "anthropic credit-balance 400",
    advances: true,
    make: () =>
      json(400, {
        type: "error",
        error: { type: "invalid_request_error", message: ANTHROPIC_CREDIT },
      }),
  },
  {
    name: "deepseek-style 402 Insufficient Balance",
    advances: true,
    make: () =>
      json(402, {
        error: {
          message: "Insufficient Balance",
          type: "unknown_error",
          param: null,
          code: "invalid_request_error",
        },
      }),
  },
  { name: "empty-body 402", advances: true, make: () => new Response("", { status: 402 }) },
  {
    name: "text/plain 402",
    advances: true,
    make: () =>
      new Response("Payment Required", { status: 402, headers: { "content-type": "text/plain" } }),
  },
  {
    name: "402 Account suspended",
    advances: true,
    make: () => json(402, { error: { message: "Account suspended" } }),
  },
  {
    name: "openai insufficient_quota 400",
    advances: true,
    make: () =>
      json(400, {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
  },
  {
    name: "non-credit 400 (field required)",
    advances: false,
    status: 400,
    make: () => json(400, { error: { message: "messages: field required" } }),
  },
  {
    name: "400 with request_id prefix and credit-free text",
    advances: false,
    status: 400,
    make: () =>
      json(400, {
        type: "error",
        error: { type: "invalid_request_error", message: "request_id: abc" },
      }),
  },
  {
    name: "401 with credit text",
    advances: false,
    status: 401,
    make: () => json(401, { error: { message: ANTHROPIC_CREDIT } }),
  },
  {
    name: "403 with credit text",
    advances: false,
    status: 403,
    make: () => json(403, { error: { message: ANTHROPIC_CREDIT } }),
  },
];

const TOOL_OPENAI = [
  {
    type: "function",
    function: { name: "lookup", parameters: { type: "object", properties: {} } },
  },
];
const TOOL_CLAUDE = [
  { name: "lookup", description: "d", input_schema: { type: "object", properties: {} } },
];

function sseOpenAI(text: string) {
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl_s",
      object: "chat.completion.chunk",
      model: "gpt-4.1-mini",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return new Response(
    chunk({ role: "assistant", content: text }) + chunk({}, "stop") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
});
test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = harness.originalRetryDelayMs;
});
test.after(async () => {
  await harness.cleanup();
});

async function run(
  shape: Shape,
  opts: { tools: boolean; stream: boolean; source: "openai" | "claude" }
) {
  await seedConnection("claude", { apiKey: "sk-claude-A" });
  await seedConnection("openai", { apiKey: "sk-openai-B" });
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  await combosDb.createCombo({
    name: "credit-combo",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["claude/claude-3-5-sonnet-20241022", "openai/gpt-4.1-mini"],
  });
  let a = 0;
  let b = 0;
  let aBody: Body | null = null;
  let bBody: Body | null = null;
  globalThis.fetch = (async (_url: unknown, init: { headers?: unknown; body?: unknown } = {}) => {
    const h = normalizeHeaders(init.headers as Parameters<typeof normalizeHeaders>[0]);
    const parsed: Body | null = typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (h["x-api-key"] === "sk-claude-A" || h.authorization === "Bearer sk-claude-A") {
      a++;
      aBody = parsed;
      return shape.make();
    }
    if (h.authorization === "Bearer sk-openai-B") {
      b++;
      bBody = parsed;
      return opts.stream ? sseOpenAI("served by B") : buildOpenAIResponse("served by B");
    }
    throw new Error(`unexpected upstream call ${JSON.stringify(h)}`);
  }) as typeof fetch;

  const body: Record<string, unknown> =
    opts.source === "openai"
      ? {
          model: "credit-combo",
          stream: opts.stream,
          messages: [{ role: "user", content: "hi" }],
          ...(opts.tools ? { tools: TOOL_OPENAI } : {}),
        }
      : {
          model: "credit-combo",
          stream: opts.stream,
          max_tokens: 50,
          messages: [{ role: "user", content: "hi" }],
          ...(opts.tools ? { tools: TOOL_CLAUDE } : {}),
        };
  const res = await handleChat(
    buildRequest({
      url:
        opts.source === "openai"
          ? "http://localhost/v1/chat/completions"
          : "http://localhost/v1/messages",
      body,
      headers: opts.source === "claude" ? { "anthropic-version": "2023-06-01" } : {},
    })
  );
  const text = await res.text();
  return { res, text, a, b, aBody, bBody };
}

// The user text and tool name the client sent must reach the next target unchanged, whichever
// wire format each upstream speaks.
function userTexts(b: Body | null): string[] {
  return (b?.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((p) => p?.text ?? "").join("")
    );
}
function toolNames(b: Body | null): string[] {
  return (b?.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean);
}

for (const tools of [false, true]) {
  for (const shape of SHAPES) {
    test(`pipeline: ${shape.name} tools=${tools} stream=false`, async () => {
      const r = await run(shape, { tools, stream: false, source: "openai" });
      assert.equal(r.a, 1, "first target attempted exactly once");
      if (shape.advances) {
        assert.equal(r.res.status, 200, r.text.slice(0, 200));
        assert.equal(r.b, 1, "next target attempted");
        assert.match(r.text, /served by B/);
        assert.deepEqual(userTexts(r.bBody), userTexts(r.aBody), "same user messages");
        assert.deepEqual(toolNames(r.bBody), tools ? ["lookup"] : []);
        assert.deepEqual(toolNames(r.aBody), toolNames(r.bBody), "same tools");
      } else {
        assert.equal(r.res.status, shape.status, r.text.slice(0, 200));
        assert.equal(r.b, 0, "next target must NOT be attempted");
      }
    });
  }
}

for (const shape of SHAPES.filter((s) => s.advances).slice(0, 2)) {
  test(`pipeline: ${shape.name} stream=true advances and streams the next target`, async () => {
    const r = await run(shape, { tools: false, stream: true, source: "openai" });
    assert.equal(r.res.status, 200, r.text.slice(0, 200));
    assert.equal(r.a, 1);
    assert.equal(r.b, 1);
    assert.match(r.text, /served by B/);
    assert.deepEqual(userTexts(r.bBody), userTexts(r.aBody));
  });
}

test("pipeline: anthropic credit 400 on a Claude-format client request with tools and stream", async () => {
  const r = await run(SHAPES[0], { tools: true, stream: true, source: "claude" });
  assert.equal(r.res.status, 200, r.text.slice(0, 200));
  assert.equal(r.a, 1);
  assert.equal(r.b, 1);
  assert.deepEqual(userTexts(r.bBody), ["hi"]);
  assert.deepEqual(toolNames(r.bBody), ["lookup"]);
});

test("pipeline: a tool request after a credit refusal advances (not tool_replay_unqualified)", async () => {
  const r = await run(SHAPES[1], { tools: true, stream: false, source: "openai" });
  assert.equal(r.res.status, 200, r.text.slice(0, 200));
  assert.equal(r.b, 1);
  assert.deepEqual(toolNames(r.bBody), ["lookup"]);
});
