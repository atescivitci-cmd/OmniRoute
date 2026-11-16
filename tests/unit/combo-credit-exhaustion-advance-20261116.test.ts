/**
 * An upstream that says the account is out of credit BEFORE producing any output (HTTP 400
 * "credit balance is too low", HTTP 402 Payment Required, insufficient_quota) is an admission
 * refusal exactly like the 429 case (TOOL_RATE_LIMIT_FAILOVER_V1): nothing was generated, so
 * the combo may move on to the next ranked target with the identical payload, for plain AND
 * tool requests. Every other 400/401/403/5xx keeps its existing behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never open the real ~/.omniroute database: pin DATA_DIR to a throwaway directory BEFORE any
// module import (the npm test scripts also preload tests/_setup/isolateDataDir.ts).
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-credit-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-credit-test-secret";
assert.ok(process.env.DATA_DIR.startsWith(os.tmpdir()), "DATA_DIR must be a temp dir");

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { createRoutingAttemptGuard, isRoutingTerminal } =
  await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { isCreditExhaustionText } =
  await import("../../open-sse/services/combo/creditExhaustion.ts");
const { CREDITS_EXHAUSTED_SIGNALS } = await import("../../open-sse/services/accountFallback.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

const ANTHROPIC_CREDIT =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

const plainBody = () => ({ model: "test", messages: [{ role: "user", content: "hi" }] });
const toolBody = () => ({
  ...plainBody(),
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
});

function makeCombo(models: string[]) {
  return {
    name: "test-combo-credit",
    strategy: "priority",
    models: models.map((m) => ({ model: m })),
  };
}
const okResponse = (modelStr: string) =>
  Response.json({
    id: "ok",
    object: "chat.completion",
    choices: [{ message: { role: "assistant", content: `ok from ${modelStr}` } }],
  });
const errResponse = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error: { message, type: "invalid_request_error", ...extra } }, { status });
const emptyResponse = (status: number) => new Response("", { status });
// The shape chatCore (createErrorResult/buildErrorBody) actually hands the router for EVERY
// upstream 402, whatever the upstream sent (empty body, text/plain, JSON without a message,
// or JSON with unrelated text): a JSON envelope with code "payment_required".
const envelope402 = (text: string) =>
  Response.json(
    { error: { message: `[402]: ${text}`, type: "billing_error", code: "payment_required" } },
    { status: 402 }
  );

type Make = () => Response;

async function runCombo(body: Record<string, unknown>, first: Make, models?: string[]) {
  const called: string[] = [];
  const bodies: string[] = [];
  const response = await handleComboChat({
    body,
    combo: makeCombo(models ?? ["p1/model-a", "p2/model-b"]),
    handleSingleModel: async (b: unknown, modelStr: string) => {
      called.push(modelStr);
      bodies.push(JSON.stringify(b));
      return modelStr === "p1/model-a" ? first() : okResponse(modelStr);
    },
    log,
    settings: {},
    allCombos: [],
  });
  return { response, called, bodies };
}

// ── (a) (b) Anthropic-style credit 400 ────────────────────────────────────────────────────
test("plain request: credit-balance 400 advances; B gets the identical body and its 200 returns", async () => {
  const body = plainBody();
  const { response, called, bodies } = await runCombo(body, () =>
    errResponse(400, ANTHROPIC_CREDIT)
  );
  assert.equal(response.status, 200);
  assert.deepEqual(called, ["p1/model-a", "p2/model-b"]);
  assert.equal(bodies[0], bodies[1]);
  assert.match(await response.text(), /ok from p2\/model-b/);
});

test("tool request: credit-balance 400 advances with the identical body", async () => {
  const { response, called, bodies } = await runCombo(toolBody(), () =>
    errResponse(400, ANTHROPIC_CREDIT)
  );
  assert.equal(response.status, 200);
  assert.deepEqual(called, ["p1/model-a", "p2/model-b"]);
  assert.equal(bodies[0], bodies[1]);
});

// ── (c) 402 ───────────────────────────────────────────────────────────────────────────────
test("402 credit text and chatCore's canonical payment_required envelope advance (plain and tools)", async () => {
  const shapes: Array<[string, Make]> = [
    ["402 credit text", () => errResponse(402, "Insufficient credits. Add more to continue.")],
    ["402 anthropic text", () => errResponse(402, ANTHROPIC_CREDIT)],
    ["envelope: Unknown error (empty upstream body)", () => envelope402("Unknown error")],
    ["envelope: Payment Required (text/plain upstream)", () => envelope402("Payment Required")],
    ["envelope: Account suspended", () => envelope402("Account suspended")],
    ["envelope: Insufficient Balance", () => envelope402("Insufficient Balance")],
  ];
  for (const [label, make] of shapes) {
    for (const [kind, body] of [
      ["plain", plainBody()],
      ["tools", toolBody()],
    ] as const) {
      const { response, called } = await runCombo(body, make);
      assert.equal(response.status, 200, `${label} ${kind}`);
      assert.deepEqual(called, ["p1/model-a", "p2/model-b"], `${label} ${kind}`);
    }
  }
});

test("stub shapes chatCore never produces for a 402 now STOP (empty, non-JSON, message-less)", async () => {
  // Production never emits these to the router: chatCore rewrites every upstream 402 into the
  // payment_required envelope above. They are pinned here only to prove the guard does not
  // treat an unreadable 402 as a credit signal on its own.
  const shapes: Array<[string, Make]> = [
    ["empty body", () => emptyResponse(402)],
    [
      "empty body with json content type",
      () => new Response("", { status: 402, headers: { "content-type": "application/json" } }),
    ],
    ["text/plain", () => new Response("Payment Required", { status: 402 })],
    [
      "json without message or code",
      () => Response.json({ error: { type: "payment_required" } }, { status: 402 }),
    ],
  ];
  for (const [label, make] of shapes) {
    for (const body of [plainBody(), toolBody()]) {
      const { response, called } = await runCombo(body, make);
      // 402 as is, or 502 execution_uncertain for the unreadable JSON-typed body; never a 200.
      assert.ok([402, 502].includes(response.status), `${label}: ${response.status}`);
      assert.deepEqual(called, ["p1/model-a"], label);
    }
  }
});

test("402 whose JSON message is clearly about something else stays generic (stops)", async () => {
  for (const body of [plainBody(), toolBody()]) {
    const { response, called } = await runCombo(body, () =>
      errResponse(402, "This model is not available in your region")
    );
    assert.notEqual(response.status, 200);
    assert.deepEqual(called, ["p1/model-a"]);
    const coded = await runCombo(body, () =>
      Response.json({ error: { code: "key_budget_exceeded" } }, { status: 402 })
    );
    assert.notEqual(coded.response.status, 200);
    assert.deepEqual(coded.called, ["p1/model-a"]);
  }
});

// ── (d) insufficient_quota shapes ────────────────────────────────────────────────────────
test("insufficient_quota 400 as message text and as error.code both advance", async () => {
  const shapes: Array<[string, Make]> = [
    [
      "message",
      () => errResponse(400, "You exceeded your current quota, please check your plan and billing"),
    ],
    ["message token", () => errResponse(400, "insufficient_quota")],
    ["code", () => errResponse(400, "Request failed", { code: "insufficient_quota" })],
    ["code only", () => Response.json({ error: { code: "insufficient_quota" } }, { status: 400 })],
    [
      "billing hard limit",
      () =>
        errResponse(400, "Billing hard limit has been reached", {
          code: "billing_hard_limit_reached",
        }),
    ],
    [
      "billing hard limit, message only",
      () => errResponse(400, "Billing hard limit has been reached"),
    ],
    ["402 code", () => errResponse(402, "Request failed", { code: "insufficient_quota" })],
  ];
  for (const [label, make] of shapes) {
    for (const body of [plainBody(), toolBody()]) {
      const { response, called } = await runCombo(body, make);
      assert.equal(response.status, 200, label);
      assert.deepEqual(called, ["p1/model-a", "p2/model-b"], label);
    }
  }
});

test("credit 400 whose text also contains combo.ts body-specific keywords still advances", async () => {
  // combo.ts has its own 400 stop for text containing context/prompt/token/malformed/invalid/
  // bad request; credit exhaustion must be exempt exactly like the malformed-credential 400.
  const texts = [
    "Your credit balance is too low. Invalid API usage: tokens cannot be billed. Bad request.",
    "insufficient_quota: your prompt could not be processed, context unchanged",
  ];
  for (const text of texts) {
    for (const body of [plainBody(), toolBody()]) {
      const { response, called } = await runCombo(body, () => errResponse(400, text));
      assert.equal(response.status, 200, text);
      assert.deepEqual(called, ["p1/model-a", "p2/model-b"], text);
    }
  }
});

test("round-robin strategy also advances on a credit 400 / 402 (plain and tools)", async () => {
  let n = 0;
  for (const make of [
    () => errResponse(400, ANTHROPIC_CREDIT),
    () => envelope402("Unknown error"),
  ]) {
    for (const body of [plainBody(), toolBody()]) {
      const called: string[] = [];
      const response = await handleComboChat({
        body,
        combo: {
          name: `test-combo-credit-rr-${++n}`,
          strategy: "round-robin",
          models: [{ model: "p1/model-a" }, { model: "p2/model-b" }],
        },
        handleSingleModel: async (_b: unknown, modelStr: string) => {
          called.push(modelStr);
          return modelStr === "p1/model-a" ? make() : okResponse(modelStr);
        },
        log,
        settings: {},
        allCombos: [],
      });
      // A fresh round-robin state starts at the first target.
      assert.equal(response.status, 200, called.join(","));
      assert.deepEqual(called, ["p1/model-a", "p2/model-b"]);
    }
  }
});

// ── (m) sibling targets of the same provider ─────────────────────────────────────────────
// combo.ts already classifies the credit text as provider quota exhaustion
// (applyComboTargetExhaustion) and skips remaining same-provider targets for the request,
// except for per-model-quota providers, where only the failing model is affected. Pinned here;
// nothing new was added to the router for this.
test("credit refusal: remaining same-provider targets are skipped (no wasted attempt)", async () => {
  const shapes: Make[] = [
    () => errResponse(400, ANTHROPIC_CREDIT),
    () => errResponse(402, ANTHROPIC_CREDIT),
    () => envelope402("Unknown error"),
  ];
  for (const [body, make] of shapes.flatMap((m) =>
    [plainBody(), toolBody()].map((b) => [b, m] as const)
  )) {
    const called: string[] = [];
    const response = await handleComboChat({
      body,
      combo: makeCombo(["anthropic/model-a", "anthropic/model-b", "p2/model-c"]),
      handleSingleModel: async (_b: unknown, modelStr: string) => {
        called.push(modelStr);
        return modelStr === "anthropic/model-a" ? make() : okResponse(modelStr);
      },
      log,
      settings: {},
      allCombos: [],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(called, ["anthropic/model-a", "p2/model-c"]);
  }
});

test("credit refusal on a per-model-quota provider does NOT skip sibling models", async () => {
  for (const body of [plainBody(), toolBody()]) {
    const called: string[] = [];
    const response = await handleComboChat({
      body,
      combo: makeCombo(["gemini/model-a", "gemini/model-b", "p2/model-c"]),
      handleSingleModel: async (_b: unknown, modelStr: string) => {
        called.push(modelStr);
        return modelStr === "gemini/model-a"
          ? errResponse(400, ANTHROPIC_CREDIT)
          : okResponse(modelStr);
      },
      log,
      settings: {},
      allCombos: [],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(called, ["gemini/model-a", "gemini/model-b"]);
  }
});

test("guard alone does not skip a sibling model on the same connection (combo.ts does, above)", async () => {
  const seen: string[] = [];
  const run = createRoutingAttemptGuard({ body: plainBody(), limit: 5 }).wrap(
    async (_b: unknown, model: string) => {
      seen.push(model);
      return model === "p1/model-a" ? errResponse(400, ANTHROPIC_CREDIT) : okResponse(model);
    }
  );
  const target = { connectionId: "conn-1" };
  await run(plainBody(), "p1/model-a", target);
  assert.equal((await run(plainBody(), "p1/model-b", target)).status, 200);
  assert.deepEqual(seen, ["p1/model-a", "p1/model-b"]);
});

// ── (e) near misses must still stop ──────────────────────────────────────────────────────
test("near-miss 400s do not advance and keep the request_rejected stop", async () => {
  const texts = [
    "invalid request",
    "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.",
    "prompt is too long: 250000 tokens > 200000 maximum",
    "max_tokens must be less than or equal to 4096",
    "messages.0.content: Input should be a valid string",
    "The supplied credentials are invalid",
    "credit card number format invalid",
    "Invalid request: the tool credits parameter is missing",
    "the authorization code is invalid or expired",
    "Too many requests, please slow down",
    "The server is overloaded",
  ];
  for (const text of texts) {
    for (const body of [plainBody(), toolBody()]) {
      const { response, called } = await runCombo(body, () => errResponse(400, text));
      assert.equal(response.status, 400, text);
      assert.deepEqual(called, ["p1/model-a"], text);
    }
  }
});

test("credit wording in the user's own content echoed in an error does not advance", async () => {
  const body = {
    model: "test",
    messages: [{ role: "user", content: "what does insufficient_quota mean?" }],
  };
  const { response, called } = await runCombo(body, () =>
    errResponse(400, "Invalid request: messages[0].content is not allowed here")
  );
  assert.equal(response.status, 400);
  assert.deepEqual(called, ["p1/model-a"]);
});

// ── (f) provider-bound requests keep the stop ────────────────────────────────────────────
test("providerBound request: credit 400 and 402 still stop (provider_continuation_unqualified)", async () => {
  const bodies = [
    { ...plainBody(), previous_response_id: "resp_fixture" },
    {
      model: "test",
      input: [{ type: "reasoning", encrypted_content: "opaque" }],
    },
  ];
  for (const body of bodies) {
    for (const make of [
      () => errResponse(400, ANTHROPIC_CREDIT),
      () => errResponse(402, ANTHROPIC_CREDIT),
      () => envelope402("Unknown error"),
    ]) {
      const { response, called } = await runCombo(body, make);
      assert.ok(response.status === 400 || response.status === 402);
      assert.deepEqual(called, ["p1/model-a"]);
    }
  }
  const run = createRoutingAttemptGuard({ body: bodies[0], limit: 3 }).wrap(async () =>
    errResponse(400, ANTHROPIC_CREDIT)
  );
  assert.equal(isRoutingTerminal(await run(bodies[0], "p1/model-a")), true);
});

// ── (g) 401 / 403 with credit-sounding text still stop ───────────────────────────────────
test("401 and 403 with credit text still stop", async () => {
  for (const status of [401, 403]) {
    for (const body of [plainBody(), toolBody()]) {
      const { response, called } = await runCombo(body, () =>
        errResponse(status, ANTHROPIC_CREDIT)
      );
      assert.equal(response.status, status);
      assert.deepEqual(called, ["p1/model-a"], `status ${status}`);
    }
  }
});

// ── (h) 429 unchanged ────────────────────────────────────────────────────────────────────
test("429 still advances for plain and tool requests (unchanged)", async () => {
  for (const body of [plainBody(), toolBody()]) {
    const { response, called } = await runCombo(body, () => errResponse(429, "rate limited"));
    assert.equal(response.status, 200);
    // A 429 is retried once on the same target by the existing transient-retry loop before
    // advancing; that pre-existing behavior is what is pinned here, not changed.
    assert.equal(called.at(-1), "p2/model-b");
    assert.ok(called.length <= 3);
  }
});

// ── (i) 500 with credit text on a tool request still stops ───────────────────────────────
test("500 with credit text on a tool request still stops (tool_replay_unqualified)", async () => {
  const { response, called } = await runCombo(toolBody(), () => errResponse(500, ANTHROPIC_CREDIT));
  assert.equal(response.status, 500);
  assert.deepEqual(called, ["p1/model-a"]);
  const guard = createRoutingAttemptGuard({ body: toolBody(), limit: 3 }).wrap(async () =>
    errResponse(500, ANTHROPIC_CREDIT)
  );
  assert.equal(isRoutingTerminal(await guard(toolBody(), "p1/model-a")), true);
});

// ── (j) no retry of the failed target; budget still bounds the call ──────────────────────
test("guard: the failed [model, connection] is not retried; credit refusal is not terminal", async () => {
  let first = 0;
  const run = createRoutingAttemptGuard({ body: toolBody(), limit: 5 }).wrap(
    async (_b: unknown, model: string) => {
      if (model === "p1/model-a") {
        first++;
        return errResponse(400, ANTHROPIC_CREDIT);
      }
      return okResponse(model);
    }
  );
  const failed = await run(toolBody(), "p1/model-a");
  assert.equal(failed.status, 400);
  assert.equal(isRoutingTerminal(failed), false);
  const again = await run(toolBody(), "p1/model-a");
  assert.equal(first, 1, "no second upstream attempt on the rejected target");
  assert.equal(again.status, 400);
  assert.equal((await run(toolBody(), "p2/model-b")).status, 200);
});

test("all targets credit-exhausted returns the final refusal (no loop) and respects the attempt limit", async () => {
  const called: string[] = [];
  const response = await handleComboChat({
    body: toolBody(),
    combo: makeCombo(["p1/a", "p2/b", "p3/c"]),
    handleSingleModel: async (_b: unknown, modelStr: string) => {
      called.push(modelStr);
      return errResponse(402, ANTHROPIC_CREDIT);
    },
    log,
    settings: {},
    allCombos: [],
  });
  assert.notEqual(response.status, 200);
  assert.deepEqual(called, ["p1/a", "p2/b", "p3/c"]);

  let n = 0;
  const run = createRoutingAttemptGuard({ body: plainBody(), limit: 2 }).wrap(async () => {
    n++;
    return errResponse(400, ANTHROPIC_CREDIT);
  });
  await run(plainBody(), "p1/a");
  await run(plainBody(), "p2/b");
  const third = await run(plainBody(), "p3/c");
  assert.equal(n, 2, "attempt limit bounds upstream attempts");
  assert.equal(third.status, 503);
});

// ── (k) committed responses never advance ────────────────────────────────────────────────
test("a successful (committed) first response is returned as is, never advanced", async () => {
  const called: string[] = [];
  const response = await handleComboChat({
    body: plainBody(),
    combo: makeCombo(["p1/model-a", "p2/model-b"]),
    handleSingleModel: async (_b: unknown, modelStr: string) => {
      called.push(modelStr);
      return okResponse(modelStr);
    },
    log,
    settings: {},
    allCombos: [],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(called, ["p1/model-a"]);
  const run = createRoutingAttemptGuard({ body: plainBody(), limit: 3 }).wrap(async () =>
    okResponse("p1/model-a")
  );
  const ok = await run(plainBody(), "p1/model-a");
  assert.equal(ok.status, 200);
  assert.equal(isRoutingTerminal(ok), true);
});

// ── (l) detector ─────────────────────────────────────────────────────────────────────────
test("detector: positives", () => {
  for (const text of [
    ANTHROPIC_CREDIT,
    "credit_balance_too_low",
    "insufficient_quota",
    "You exceeded your current quota, please check your plan and billing details.",
    "You have exceeded your current usage quota",
    "Insufficient account balance",
    "Insufficient credits. Add more to continue.",
    "insufficient_balance",
    "Insufficient balance",
    "You are out of credits",
    "Credits exhausted",
    "billing_hard_limit_reached",
    "Billing hard limit has been reached",
    "The free tier of the model has been exhausted",
    "Error: Your Credit Balance Is Too Low",
  ]) {
    assert.equal(isCreditExhaustionText(text), true, text);
  }
});

test("detector: near misses must not match", () => {
  for (const text of [
    "invalid request",
    "Invalid request body",
    "This model's maximum context length is 8192 tokens",
    "prompt is too long: 250000 tokens > 200000 maximum",
    "max_tokens must be <= 4096",
    "messages.0.content: Input should be a valid string",
    "Too many requests",
    "rate limit exceeded",
    "The server is overloaded",
    "the authorization code is invalid",
    "The supplied credentials are invalid",
    "credit card number format invalid",
    "tool credits parameter is missing",
    "credit",
    "credits",
    "balance",
    "quota",
    "payment required",
    "model is not supported",
    "",
  ]) {
    assert.equal(isCreditExhaustionText(text), false, text);
  }
  assert.equal(isCreditExhaustionText(undefined as unknown as string), false);
  assert.equal(isCreditExhaustionText(null as unknown as string), false);
  assert.equal(isCreditExhaustionText(42 as unknown as string), false);
  assert.equal(isCreditExhaustionText({ a: 1 } as unknown as string), false);
});

test("detector: scan is bounded to the first 2000 characters and cannot be ReDoSed", () => {
  const pad = "x".repeat(2000);
  assert.equal(isCreditExhaustionText(`${pad} insufficient_quota`), false);
  assert.equal(isCreditExhaustionText(`insufficient_quota ${pad}`), true);
  for (const big of [
    "a".repeat(1_000_000),
    "credit ".repeat(150_000),
    "your credit balance is ".repeat(60_000),
    "insufficient ".repeat(80_000),
    " ".repeat(1_000_000),
  ]) {
    const t0 = performance.now();
    assert.equal(isCreditExhaustionText(big), false);
    assert.ok(performance.now() - t0 < 200, "1 MB input must finish quickly");
  }
});

test("every CREDITS_EXHAUSTED_SIGNALS phrase is either detected or explicitly justified", () => {
  // Phrases deliberately NOT matched by isCreditExhaustionText, with the reason.
  const NOT_INCLUDED: Record<string, string> = {
    // Bare "payment required" is only meaningful together with HTTP 402; the status check
    // handles that case. As text on a 400 it is too ambiguous (billing page copy, user echo).
    "payment required": "ambiguous outside HTTP 402; the 402 status itself is the signal",
  };
  const missing: string[] = [];
  for (const signal of CREDITS_EXHAUSTED_SIGNALS as string[]) {
    if (isCreditExhaustionText(signal)) continue;
    if (!(signal in NOT_INCLUDED)) missing.push(signal);
  }
  assert.deepEqual(missing, [], `unjustified omissions: ${missing.join(", ")}`);
  for (const key of Object.keys(NOT_INCLUDED)) {
    assert.ok((CREDITS_EXHAUSTED_SIGNALS as string[]).includes(key), `stale justification: ${key}`);
    assert.equal(isCreditExhaustionText(key), false, key);
  }
});
