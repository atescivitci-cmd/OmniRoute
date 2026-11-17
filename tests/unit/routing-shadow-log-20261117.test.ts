/**
 * Stage 1 of the shadow classifier: log the decision the rule classifier makes.
 *
 * Pins the contract: nothing is recorded unless ROUTING_SHADOW_LOG is on, the record holds
 * lengths, counts and flags but never prompt text, the write cannot affect routing, and the
 * real combo pipeline (not just the pure builder) reaches the table with the request's id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getDbInstance } from "@/lib/db/core";
import {
  insertRoutingShadowDecision,
  pruneRoutingShadowDecisions,
  getRoutingShadowSummary,
  __resetRoutingShadowPruneForTests,
  type RoutingShadowDecisionInput,
} from "@/lib/db/routingShadowDecisions";
import {
  __resetRoutingShadowWarningForTests,
  buildRuleDecisionRecord,
  emitRuleDecision,
  isRoutingShadowLogEnabled,
} from "../../open-sse/services/routingShadow.ts";
import { handleComboChat } from "../../open-sse/services/combo.ts";

const db = () => getDbInstance();
const SECRET_ASK = "what is the capital of france please zzq-marker-7781";

function tools(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: "function",
    function: { name: `tool_${i}`, description: "x", parameters: { type: "object" } },
  }));
}

function bodyWithAsk(ask: string, toolCount = 0): Record<string, unknown> {
  return {
    messages: [{ role: "user", content: ask }],
    ...(toolCount ? { tools: tools(toolCount) } : {}),
  };
}

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Like withEnv, but keeps the variables set until the async work has finished. */
async function withEnvAsync<T>(
  vars: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function rowCount(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM routing_shadow_decisions").get() as { n: number })
    .n;
}

async function waitForRows(expected: number, ms = 2000): Promise<number> {
  const end = Date.now() + ms;
  let n = rowCount();
  while (n < expected && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    n = rowCount();
  }
  return n;
}

function sample(overrides: Partial<RoutingShadowDecisionInput> = {}): RoutingShadowDecisionInput {
  return {
    requestId: "req-sample",
    comboName: "combo-a",
    strategy: "task-aware",
    ruleLevel: "standard",
    ruleReasons: ["default"],
    path: "task_ordered",
    lightByAsk: false,
    wasLevel: null,
    promptChars: 10,
    messageCount: 1,
    toolCount: 0,
    outputTokens: 0,
    effort: "medium",
    lightKeyword: false,
    heavyKeyword: false,
    criticalKeyword: false,
    askChars: 10,
    userTurns: 1,
    askNonAscii: false,
    askNonText: false,
    compactedHistory: false,
    ...overrides,
  };
}

test.beforeEach(() => {
  db().prepare("DELETE FROM routing_shadow_decisions").run();
  __resetRoutingShadowPruneForTests();
});

test("the flag is off unless explicitly turned on", () => {
  assert.equal(isRoutingShadowLogEnabled({}), false);
  assert.equal(isRoutingShadowLogEnabled({ ROUTING_SHADOW_LOG: "0" }), false);
  assert.equal(isRoutingShadowLogEnabled({ ROUTING_SHADOW_LOG: "off" }), false);
  for (const on of ["1", "true", "YES", " on "]) {
    assert.equal(isRoutingShadowLogEnabled({ ROUTING_SHADOW_LOG: on }), true, on);
  }
});

test("a light-by-ask decision is recorded with its signals and without the prompt text", () => {
  withEnv({ ROUTING_LIGHT_BY_ASK: "1" }, () => {
    const record = buildRuleDecisionRecord({
      body: bodyWithAsk(SECRET_ASK, 120),
      strategy: "task-aware",
      comboName: "c1",
      requestId: "r1",
    });
    assert.equal(record.ruleLevel, "light");
    assert.equal(record.lightByAsk, true);
    assert.notEqual(record.wasLevel, null, "the level the rules would have chosen is kept");
    assert.equal(record.toolCount, 120);
    assert.equal(record.askChars, SECRET_ASK.length);
    assert.equal(record.userTurns, 1);
    assert.equal(record.askNonAscii, false);
    assert.equal(record.requestId, "r1");
    assert.ok(!JSON.stringify(record).includes("zzq-marker-7781"), "no prompt text in the record");
  });
});

test("a heavy ask, a non-ASCII ask and the flag-off legacy path are described correctly", () => {
  withEnv({ ROUTING_LIGHT_BY_ASK: "1" }, () => {
    const heavy = buildRuleDecisionRecord({
      body: bodyWithAsk("please debug and refactor the whole architecture of this codebase"),
      strategy: "smart",
      comboName: "c2",
      requestId: "r2",
    });
    assert.notEqual(heavy.ruleLevel, "light");
    assert.equal(heavy.lightByAsk, false);
    assert.equal(heavy.heavyKeyword, true);

    const nonAscii = buildRuleDecisionRecord({
      body: bodyWithAsk("Bonjour, ça va très bien merci"),
      strategy: "smart",
      comboName: "c2",
      requestId: "r3",
    });
    assert.equal(nonAscii.askNonAscii, true);
    assert.equal(nonAscii.lightByAsk, false, "light-by-ask refuses non-ASCII asks");
  });
  withEnv({ ROUTING_LIGHT_BY_ASK: undefined }, () => {
    const legacy = buildRuleDecisionRecord({
      body: bodyWithAsk(SECRET_ASK, 120),
      strategy: "smart",
      comboName: "c3",
      requestId: null,
    });
    assert.equal(legacy.lightByAsk, false);
    assert.equal(legacy.wasLevel, null);
    assert.equal(legacy.requestId, null);
  });
});

test("the record carries the path, the compacted-history flag and bounded identifiers", () => {
  const compacted = buildRuleDecisionRecord({
    body: {
      messages: [
        {
          role: "user",
          content: "Another language model started to solve this problem and left a summary",
        },
        { role: "user", content: "continue" },
      ],
    },
    strategy: "auto",
    comboName: "c".repeat(500),
    requestId: "r".repeat(500),
    path: "context_overflow",
  });
  assert.equal(compacted.compactedHistory, true);
  assert.equal(compacted.path, "context_overflow");
  assert.equal(compacted.requestId?.length, 200, "request id is capped");
  assert.equal(compacted.comboName?.length, 200, "combo name is capped");
  const plain = buildRuleDecisionRecord({
    body: bodyWithAsk("hello"),
    strategy: "auto",
    comboName: "c",
    requestId: "r",
  });
  assert.equal(plain.compactedHistory, false);
  assert.equal(plain.path, null);
});

test("the table dedups per request and combo, keeps nulls apart, prunes and summarises", () => {
  assert.equal(insertRoutingShadowDecision(sample()), true);
  assert.equal(insertRoutingShadowDecision(sample()), false, "same request and combo is one row");
  assert.equal(insertRoutingShadowDecision(sample({ comboName: "combo-b" })), true);
  assert.equal(insertRoutingShadowDecision(sample({ requestId: null })), true);
  assert.equal(insertRoutingShadowDecision(sample({ requestId: null })), true);
  assert.equal(rowCount(), 4);

  insertRoutingShadowDecision(
    sample({
      requestId: "old",
      timestamp: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString(),
    })
  );
  assert.equal(rowCount(), 5);
  assert.equal(pruneRoutingShadowDecisions(), 1, "only the 20 day old row is pruned");
  assert.equal(rowCount(), 4);

  insertRoutingShadowDecision(
    sample({ requestId: "l1", ruleLevel: "light", lightByAsk: true, wasLevel: "critical" })
  );
  const summary = getRoutingShadowSummary(new Date(Date.now() - 3600_000).toISOString());
  const light = summary.find((r) => r.ruleLevel === "light");
  assert.equal(light?.requests, 1);
  assert.equal(light?.lightByAsk, 1);
});

test("pruning is bounded per call and drains a backlog over successive calls", () => {
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  db().exec("BEGIN");
  const insert = db().prepare(
    "INSERT INTO routing_shadow_decisions (timestamp, rule_level) VALUES (?, 'standard')"
  );
  for (let i = 0; i < 12_500; i++) insert.run(old);
  db().exec("COMMIT");
  assert.equal(pruneRoutingShadowDecisions(), 10_000, "one call removes at most five batches");
  assert.equal(rowCount(), 2_500);
  assert.equal(pruneRoutingShadowDecisions(), 2_500, "the next call drains the rest");
  assert.equal(rowCount(), 0);
});

test("nothing is written unless the flag is on and the strategy is task routing", async () => {
  const args = {
    body: bodyWithAsk("hello there"),
    strategy: "task-aware",
    comboName: "c",
    requestId: "gate-1",
  };
  emitRuleDecision(args, {});
  emitRuleDecision(
    { ...args, requestId: "gate-2", strategy: "priority" },
    { ROUTING_SHADOW_LOG: "1" }
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(rowCount(), 0, "flag off and non-task strategy both write nothing");
  emitRuleDecision({ ...args, requestId: "gate-3" }, { ROUTING_SHADOW_LOG: "1" });
  assert.equal(await waitForRows(1), 1, "flag on and task strategy writes one row");
});

test("a failing write warns once, never surfaces, and writing works again afterwards", async () => {
  __resetRoutingShadowWarningForTests();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  const emit = (id: string) =>
    emitRuleDecision(
      { body: bodyWithAsk("hello"), strategy: "auto", comboName: "c", requestId: id },
      { ROUTING_SHADOW_LOG: "1" }
    );
  db().exec("ALTER TABLE routing_shadow_decisions RENAME TO routing_shadow_decisions_off");
  try {
    emit("boom-1");
    emit("boom-2");
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    db().exec("ALTER TABLE routing_shadow_decisions_off RENAME TO routing_shadow_decisions");
    console.warn = originalWarn;
  }
  assert.equal(rowCount(), 0);
  const ours = warnings.filter((line) => line.includes("[routingShadow]"));
  assert.equal(ours.length, 1, `one warning for two failures: ${JSON.stringify(ours)}`);

  emit("after-recovery");
  assert.equal(await waitForRows(1), 1, "a later write succeeds once the table is back");
});

function log() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

async function runCombo(
  strategy: string,
  correlationId: string,
  body: Record<string, unknown>,
  models: string[] = ["openai/gpt-4o-mini", "claude/sonnet"]
) {
  const calls: string[] = [];
  const result = await handleComboChat({
    body,
    combo: {
      name: `shadow-${strategy}`,
      strategy,
      models,
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    },
    handleSingleModel: async (_b: unknown, modelStr: string) => {
      calls.push(modelStr);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    isModelAvailable: async () => true,
    log: log(),
    settings: null,
    allCombos: null,
    correlationId,
  } as never);
  return { calls, ok: (result as Response).ok };
}

test("the real combo pipeline records one row with the request id, and routing is unchanged", async () => {
  // "auto" is the only stored strategy that reaches task routing: "task-aware" and "smart"
  // normalize to "priority" before the pipeline sees them.
  const body = bodyWithAsk(SECRET_ASK, 20);
  const bodyBefore = JSON.stringify(body);
  const off = await withEnvAsync({ ROUTING_SHADOW_LOG: undefined }, () =>
    runCombo("auto", "req-off", body)
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(rowCount(), 0, "flag off: the pipeline records nothing");

  const on = await withEnvAsync({ ROUTING_SHADOW_LOG: "1" }, () =>
    runCombo("auto", "req-shadow-1", body)
  );
  assert.equal(await waitForRows(1), 1, "flag on: the pipeline reached the table");
  const row = db()
    .prepare("SELECT * FROM routing_shadow_decisions WHERE request_id = ?")
    .get("req-shadow-1") as Record<string, unknown>;
  assert.ok(row, "the row carries the request's correlation id");
  assert.equal(row.combo_name, "shadow-auto");
  assert.equal(row.strategy, "auto");
  assert.equal(row.tool_count, 20);
  assert.equal(row.path, "task_ordered");
  assert.equal(JSON.stringify(body), bodyBefore, "recording leaves the request body untouched");
  assert.ok(!JSON.stringify(row).includes("zzq-marker-7781"), "no prompt text in the row");

  assert.deepEqual(
    on.calls,
    off.calls,
    "logging changes which targets are tried, and in what order"
  );
  assert.equal(on.ok, off.ok);

  await withEnvAsync({ ROUTING_SHADOW_LOG: "1" }, () => runCombo("priority", "req-priority", body));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(rowCount(), 1, "a non task-routing strategy is not recorded");
});

test("a request that ends early is still recorded, with the step it reached", async () => {
  // About 220k tokens of text overflows the only candidate's 128k window, so the pipeline
  // returns before ordering. The baseline must still count it. Every candidate needs a known
  // limit for this check to fire, hence a single known model.
  const huge = bodyWithAsk(`${"lorem ipsum dolor sit amet ".repeat(35_000)} summarise this`);
  const result = await withEnvAsync({ ROUTING_SHADOW_LOG: "1" }, () =>
    runCombo("auto", "req-overflow", huge, ["openai/gpt-4o-mini"])
  );
  assert.equal(result.calls.length, 0, "no target was tried");
  assert.equal(result.ok, false);
  assert.equal(await waitForRows(1), 1);
  const row = db()
    .prepare("SELECT path, rule_level FROM routing_shadow_decisions WHERE request_id = ?")
    .get("req-overflow") as { path: string; rule_level: string };
  assert.equal(row.path, "context_overflow");
  assert.equal(row.rule_level, "critical", "the largest prompts are in the baseline");
});

test("a fit-first combo that refuses every candidate is recorded as an early response", async () => {
  // Fit-first with no proven candidate ends the request before any target is tried. This is a
  // real early exit of the pipeline, reached through the production entry point.
  const calls: string[] = [];
  const noop = () => {};
  const response = await withEnvAsync({ ROUTING_SHADOW_LOG: "1" }, () =>
    handleComboChat({
      body: bodyWithAsk("hi there"),
      combo: {
        name: "shadow-fit-first",
        strategy: "auto",
        models: ["openai/gpt-4o-mini", "openai/gpt-4o"],
        config: {
          maxRetries: 0,
          retryDelayMs: 0,
          fallbackDelayMs: 0,
          selectionPolicy: "fit-first-free",
        },
      },
      handleSingleModel: async (_b: unknown, modelStr: string) => {
        calls.push(modelStr);
        return new Response("{}", { status: 200 });
      },
      isModelAvailable: async () => true,
      log: { info: noop, warn: noop, error: noop, debug: noop },
      settings: null,
      allCombos: null,
      correlationId: "req-fit-first",
    } as never)
  );
  assert.equal((response as Response).ok, false);
  assert.deepEqual(calls, [], "no target was tried");
  assert.equal(await waitForRows(1), 1);
  const row = db()
    .prepare("SELECT path FROM routing_shadow_decisions WHERE request_id = ?")
    .get("req-fit-first") as { path: string };
  assert.equal(row.path, "strategy_early_response");
});
