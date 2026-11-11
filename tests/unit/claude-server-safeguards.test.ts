import test from "node:test";
import assert from "node:assert/strict";

import { forwardAnthropicProtocolHeaders } from "../../open-sse/config/anthropicHeaders.ts";
import { BaseExecutor } from "../../open-sse/executors/base.ts";
import {
  hasSafeguardResults,
  hasServerSafeguards,
  relayClaudeServerSafeguardsResponse,
  supportsClaudeServerSafeguards,
} from "../../open-sse/handlers/chatCore/claudeServerSafeguards.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

class NativeClaudeSafeguardsExecutor extends BaseExecutor {
  constructor() {
    super("claude", {
      baseUrls: ["https://claude.invalid/v1/messages"],
      headers: { "anthropic-version": "internal-would-lose" },
    });
  }

  async transformRequest(): Promise<never> {
    throw new Error("native safeguards request must not enter generic request transforms");
  }
}

test("detects only explicit safeguards request and safeguard_results response fields", () => {
  assert.equal(hasServerSafeguards({ safeguards: [] }), true);
  assert.equal(hasServerSafeguards({ messages: [] }), false);
  assert.equal(hasSafeguardResults({ safeguard_results: [] }), true);
  assert.equal(hasSafeguardResults({ content: [] }), false);
});

test("native safeguards are supported only by the real Claude Messages route", () => {
  assert.equal(supportsClaudeServerSafeguards("claude", FORMATS.CLAUDE), true);
  for (const provider of ["codex", "github", "nvidia", "ollama-local"]) {
    assert.equal(supportsClaudeServerSafeguards(provider, FORMATS.CLAUDE), false);
  }
  assert.equal(supportsClaudeServerSafeguards("claude", FORMATS.OPENAI), false);
});

test("Anthropic protocol forwarding is open-list, case-insensitive, and excludes auth", () => {
  const outbound = {
    "Anthropic-Version": "internal-version",
    "anthropic-beta": "internal-beta",
    authorization: "Bearer upstream-owned",
  };
  forwardAnthropicProtocolHeaders(outbound, {
    "ANTHROPIC-VERSION": "2099-01-01",
    "Anthropic-Beta": "dangerous-tool-use-2026-09-03,future-beta-2099-01-01",
    "anthropic-future-capability": "client-value",
    authorization: "Bearer client-must-not-forward",
  });

  assert.deepEqual(outbound, {
    "anthropic-version": "2099-01-01",
    "anthropic-beta": "dangerous-tool-use-2026-09-03,future-beta-2099-01-01",
    "anthropic-future-capability": "client-value",
    authorization: "Bearer upstream-owned",
  });
});

test("native Claude executor preserves safeguards payload and future protocol headers", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";
  let capturedHeaders = new Headers();
  globalThis.fetch = async (_url, init) => {
    capturedBody = String(init?.body ?? "");
    capturedHeaders = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        safeguard_results: [{ classification: "allow" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const body = {
    model: "claude-sonnet-4-6",
    safeguards: [{ type: "tool", name: "Bash", input: { command: "pwd" } }],
    messages: [{ role: "user", content: "classify" }],
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    future_request_field: { exact: ["order", "kept"] },
  };

  try {
    const executor = new NativeClaudeSafeguardsExecutor();
    const result = await executor.execute({
      model: "claude-sonnet-4-6",
      body,
      stream: false,
      credentials: { apiKey: "test-only" },
      clientHeaders: {
        "anthropic-version": "2099-01-01",
        "anthropic-beta": "dangerous-tool-use-2026-09-03,future-beta-2099-01-01",
        "anthropic-future-capability": "client-value",
      },
    });

    assert.equal(capturedBody, JSON.stringify(body));
    assert.equal(capturedHeaders.get("anthropic-version"), "2099-01-01");
    assert.equal(
      capturedHeaders.get("anthropic-beta"),
      "dangerous-tool-use-2026-09-03,future-beta-2099-01-01"
    );
    assert.equal(capturedHeaders.get("anthropic-future-capability"), "client-value");
    assert.equal(capturedHeaders.get("x-anthropic-billing-header"), null);
    assert.deepEqual(await result.response.json(), {
      id: "msg_test",
      type: "message",
      safeguard_results: [{ classification: "allow" }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("response relay preserves JSON and SSE bytes and finalizes once", async () => {
  for (const [contentType, bytes] of [
    ["application/json", '{"safeguard_results":[{"classification":"allow"}]}'],
    [
      "text/event-stream",
      'event: content_block_delta\ndata: {"delta":{"type":"safeguard_results_delta","index":0}}\n\n',
    ],
  ] as const) {
    let finalized = 0;
    const relayed = relayClaudeServerSafeguardsResponse(
      new Response(new TextEncoder().encode(bytes), { headers: { "content-type": contentType } }),
      () => {
        finalized += 1;
      }
    );
    assert.equal(await relayed.text(), bytes);
    assert.equal(relayed.headers.get("content-type"), contentType);
    assert.equal(finalized, 1);
  }
});
