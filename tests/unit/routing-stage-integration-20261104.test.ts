import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "routing-stages-"));
process.env.DATA_DIR = data;
globalThis.fetch = async () => {
  throw new Error("fixture network forbidden");
};
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { createRoutingAttemptGuard, createRoutingStageScope, runRoutingStage, isRoutingTerminal } =
  await import("../../open-sse/services/combo/routingAttemptSafety.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { clearCooldownState } = await import("../../open-sse/services/providerCooldownTracker.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
const log = { info() {}, warn() {}, error() {}, debug() {} };
const body = () => ({
  stream: false,
  messages: [{ role: "user", content: "complete fixture input" }],
});
const ok = (text = "fixture") =>
  Response.json({
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  });
const bad = (status = 503) =>
  Response.json({ error: { code: "fixture_rejected", message: "fixture" } }, { status });
let sequence = 0;
function nested(child: any, dispatch: any, extra: any = {}) {
  const parent = {
    name: `stage-parent-${sequence++}`,
    strategy: "priority",
    models: [{ kind: "combo-ref", comboName: child.name }, { model: "p/parent-fallback" }],
    config: {
      nestedComboMode: "execute",
      maxRetries: 0,
      maxSetRetries: 0,
      retryDelayMs: 0,
      disableSessionStickiness: true,
      ...extra.config,
    },
  };
  return {
    body: body(),
    combo: parent,
    allCombos: [parent, child],
    handleSingleModel: dispatch,
    isModelAvailable: async () => true,
    log,
    settings: { modelLockout: { enabled: false } },
    ...extra,
    ...(extra.config ? { combo: parent } : {}),
  };
}
function pipeline(extra: any = {}) {
  return {
    name: `pipeline-${sequence++}`,
    strategy: "pipeline",
    models: [{ model: "p/a" }, { model: "p/b", prompt: "transform" }],
    config: { maxRetries: 0, maxSetRetries: 0, retryDelayMs: 0, ...extra },
  };
}
test.beforeEach(() => {
  resetAllCircuitBreakers();
  clearCooldownState();
  clearAllModelLockouts();
});
test.after(() => {
  resetDbInstance();
  fs.rmSync(data, { recursive: true, force: true });
});

test("nested pipeline preserves stages and intentional transform without wrapper double dispatch", async () => {
  const calls: any[] = [];
  const r = await handleComboChat(
    nested(pipeline(), async (b: any, m: string) => {
      calls.push({ body: structuredClone(b), model: m });
      return ok(calls.length === 1 ? "FIRST" : "SECOND");
    })
  );
  assert.equal(r.status, 200);
  assert.match(await r.text(), /SECOND/);
  assert.deepEqual(
    calls.map((x) => x.model),
    ["p/a", "p/b"]
  );
  assert.equal(calls[0].body.messages[0].content, "complete fixture input");
  assert.equal(calls[1].body.messages.at(-1).content, "FIRST");
});
test("configured intermediate retries reuse one stage owner, then next stage runs once", async () => {
  const calls: string[] = [];
  const r = await handleComboChat(
    nested(pipeline({ maxRetries: 1 }), async (_b: any, m: string) => {
      calls.push(m);
      return calls.length === 1 ? bad(429) : ok();
    })
  );
  assert.equal(r.status, 200);
  await r.text();
  assert.deepEqual(calls, ["p/a", "p/a", "p/b"]);
});
test("failure after successful stage never retries composite or enters parent fallback", async () => {
  const calls: string[] = [];
  const r = await handleComboChat(
    nested(
      pipeline(),
      async (_b: any, m: string) => {
        calls.push(m);
        return calls.length === 1 ? ok() : bad();
      },
      { config: { maxRetries: 2 } }
    )
  );
  assert.equal(r.status, 503);
  assert.equal(isRoutingTerminal(r), true);
  assert.deepEqual(calls, ["p/a", "p/b"]);
  await r.text();
});
test("uncertain mandatory stage cannot be replayed by its configured retry loop", async () => {
  const calls: string[] = [];
  const r = await handleComboChat(
    nested(pipeline({ maxRetries: 2 }), async (_b: any, m: string) => {
      calls.push(m);
      throw new Error("fixture transport uncertainty");
    })
  );
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
  await r.text();
});
test("explicit stage ids permit same-model stages but bind input and forbid committed stage replay", async () => {
  let sends = 0;
  const g = createRoutingAttemptGuard({ body: body(), limit: 3 });
  const scope = createRoutingStageScope(
    g,
    g.wrap(async () => {
      sends++;
      return ok();
    })
  );
  await (await runRoutingStage(scope.dispatch, "step/0", body(), "p/a")).text();
  await (await runRoutingStage(scope.dispatch, "step/1", body(), "p/a")).text();
  const r = await runRoutingStage(scope.dispatch, "step/0", body(), "p/a");
  assert.equal(r.ok, false);
  assert.equal(sends, 2);
  assert.equal(g.attempts(), 2);
  const changed = await runRoutingStage(
    scope.dispatch,
    "step/1",
    { messages: [{ role: "user", content: "changed" }] },
    "p/a"
  );
  assert.equal(changed.ok, false);
  assert.equal(sends, 2);
});
test("stage leaves share exact root ceiling and cannot borrow another stage allowance", async () => {
  let sends = 0;
  const g = createRoutingAttemptGuard({ body: body(), limit: 2 });
  const scope = createRoutingStageScope(g, async () => {
    sends++;
    return ok();
  });
  for (const id of ["step/0", "step/1"])
    await (await runRoutingStage(scope.dispatch, id, body(), "p/a")).text();
  const last = await runRoutingStage(scope.dispatch, "step/2", body(), "p/a");
  assert.equal(last.ok, false);
  assert.equal(sends, 2);
  assert.equal(g.attempts(), 2);
});
test("fusion parallel panel and final stage have independent permits under shared parent", async () => {
  const calls: string[] = [];
  const child = {
    name: "fusion-fixture",
    strategy: "fusion",
    models: [{ model: "p/a" }, { model: "p/b" }],
    config: {
      judgeModel: "p/judge",
      fusionTuning: { minPanel: 2, stragglerGraceMs: 2, panelHardTimeoutMs: 100 },
    },
  };
  const r = await handleComboChat(
    nested(child, async (_b: any, m: string) => {
      calls.push(m);
      return ok(m);
    })
  );
  assert.equal(r.status, 200);
  await r.text();
  assert.deepEqual(calls, ["p/a", "p/b", "p/judge"]);
});
test("nested fusion combo-ref panel preserves child stages and counts leaf calls only", async () => {
  const p = pipeline();
  const child = {
    name: "fusion-nested",
    strategy: "fusion",
    models: [{ kind: "combo-ref", comboName: p.name }, { model: "p/other" }],
    config: {
      judgeModel: "p/judge",
      fusionTuning: { minPanel: 2, stragglerGraceMs: 2, panelHardTimeoutMs: 100 },
    },
  };
  const calls: string[] = [];
  const opts = nested(child, async (_b: any, m: string) => {
    calls.push(m);
    return ok(m);
  });
  opts.allCombos.push(p);
  const r = await handleComboChat(opts);
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((m) => m === "p/a").length, 1);
  assert.equal(calls.filter((m) => m === "p/b").length, 1);
  assert.equal(calls.at(-1), "p/judge");
});
test("fusion preserves configured quorum while reporting optional straggler uncertainty without replay", async () => {
  let release!: (r: Response) => void;
  let cancelled = 0;
  const slow = new Promise<Response>((r) => {
    release = r;
  });
  const calls: string[] = [];
  const child = {
    name: "fusion-quorum",
    strategy: "fusion",
    models: [{ model: "p/a" }, { model: "p/slow" }],
    config: {
      judgeModel: "p/judge",
      fusionTuning: { minPanel: 1, stragglerGraceMs: 2, panelHardTimeoutMs: 100 },
    },
  };
  const r = await handleComboChat(
    nested(child, async (_b: any, m: string) => {
      calls.push(m);
      return m === "p/slow" ? slow : ok(m);
    })
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-OmniRoute-Stage-Execution"), "partial_uncertain");
  assert.equal(r.headers.get("X-OmniRoute-Uncertain-Stages"), "1");
  await r.text();
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      })
    )
  );
  await new Promise(setImmediate);
  assert.equal(cancelled, 1);
  assert.deepEqual(calls, ["p/a", "p/slow", "p/judge"]);
});
test("parent cancellation blocks later pipeline steps and never activates parent fallback", async () => {
  const c = new AbortController();
  const calls: string[] = [];
  const r = await handleComboChat(
    nested(
      pipeline(),
      async (_b: any, m: string) => {
        calls.push(m);
        c.abort();
        return ok();
      },
      { signal: c.signal }
    )
  );
  assert.equal(r.status, 499);
  assert.equal(calls.length, 1);
  await r.text();
});
test("chaos preserves concurrent panels and marks HTTP failures as failed parts", async () => {
  const calls: string[] = [];
  const child = {
    name: "chaos-fixture",
    strategy: "auto",
    models: [{ model: "p/a" }, { model: "p/b" }],
    config: { chaos: { enabled: true, tuning: { panelHardTimeoutMs: 100, minPanel: 1 } } },
  };
  const r = await handleComboChat(
    nested(child, async (_b: any, m: string) => {
      calls.push(m);
      return m === "p/a" ? bad() : ok("GOOD");
    })
  );
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.match(text, /"ok":false/);
  assert.match(text, /GOOD/);
});
test("composite response cancel aborts pending chaos stages without another dispatch", async () => {
  const signals: AbortSignal[] = [];
  let calls = 0;
  const child = {
    name: "chaos-cancel",
    strategy: "auto",
    models: [{ model: "p/a" }, { model: "p/b" }],
    config: { chaos: { enabled: true, tuning: { panelHardTimeoutMs: 100 } } },
  };
  const r = await handleComboChat(
    nested(child, async (_b: any, _m: string, t: any) => {
      calls++;
      signals.push(t.modelAbortSignal);
      return new Promise<Response>(() => {});
    })
  );
  await new Promise(setImmediate);
  await r.body!.cancel();
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.equal(
    signals.every((s) => s.aborted),
    true
  );
});

test("empty nested pipeline performs no work and permits healthy parent sibling", async () => {
  const child = {
    name: "empty-pipeline",
    strategy: "pipeline",
    models: [],
    config: { maxRetries: 0 },
  };
  const calls: string[] = [];
  const r = await handleComboChat(
    nested(child, async (_b: any, m: string) => {
      calls.push(m);
      return ok();
    })
  );
  assert.equal(r.status, 200);
  await r.text();
  assert.deepEqual(calls, ["p/parent-fallback"]);
});

test("quorum cutoff aborts nested pipeline and forbids its later step after settlement", async () => {
  let release!: (r: Response) => void;
  const slow = new Promise<Response>((r) => {
    release = r;
  });
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const p = {
    name: "quorum-child-pipeline",
    strategy: "pipeline",
    models: [{ model: "p/slow" }, { model: "p/later" }],
    config: { maxRetries: 0, retryDelayMs: 0 },
  };
  const child = {
    name: "quorum-parent-fusion",
    strategy: "fusion",
    models: [{ kind: "combo-ref", comboName: p.name }, { model: "p/fast" }],
    config: {
      judgeModel: "p/judge",
      disableSessionStickiness: true,
      fusionTuning: { minPanel: 1, stragglerGraceMs: 2, panelHardTimeoutMs: 150 },
    },
  };
  const opts = nested(child, async (_b: any, m: string, t: any) => {
    calls.push(m);
    if (m === "p/slow") {
      signals.push(t.modelAbortSignal);
      return slow;
    }
    return ok(m);
  });
  opts.allCombos.push(p);
  const r = await handleComboChat(opts);
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(signals[0].aborted, true);
  release(ok("late first"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.includes("p/later"), false);
  assert.equal(calls.length, 3);
});

async function pinnedComposite(strategy: string, dispatch: any) {
  const { getDbInstance } = await import("../../src/lib/db/core.ts");
  const { recordSessionModelUsage } = await import("../../src/lib/db/contextHandoffs.ts");
  getDbInstance()
    .prepare(
      "INSERT OR IGNORE INTO provider_connections (id,provider,auth_type,name,is_active,test_status,created_at,updated_at) VALUES ('stage-pin','stagepin','api_key','fixture',1,'active',datetime('now'),datetime('now'))"
    )
    .run();
  const n = sequence++;
  const combo = {
    name: `stage-pin-${n}`,
    strategy,
    models: [{ model: "stagepin/first" }, { model: "stagepin/last" }],
    context_cache_protection: true,
    config: {
      maxRetries: 0,
      retryDelayMs: 0,
      judgeModel: "stagepin/judge",
      ...(strategy === "auto"
        ? { chaos: { enabled: true, tuning: { panelHardTimeoutMs: 100 } } }
        : {}),
    },
  };
  recordSessionModelUsage(`stage-pin-session-${n}`, combo.name, "stagepin/last", "stagepin");
  return handleComboChat({
    body: body(),
    combo,
    allCombos: [combo],
    handleSingleModel: dispatch,
    isModelAvailable: async () => true,
    log,
    settings: { modelLockout: { enabled: false } },
    relayOptions: { sessionId: `stage-pin-session-${n}` },
  });
}
for (const strategy of ["pipeline", "fusion", "auto"])
  test(`eligible pin bypasses ${strategy} with one trusted leaf`, async () => {
    const calls: string[] = [];
    const r = await pinnedComposite(strategy, async (_b: any, m: string) => {
      calls.push(m);
      return ok();
    });
    assert.equal(r.status, 200);
    await r.text();
    assert.deepEqual(calls, ["stagepin/last"]);
  });
test("definite pin rejection permits normal configured pipeline stages", async () => {
  const calls: string[] = [];
  const r = await pinnedComposite("pipeline", async (_b: any, m: string) => {
    calls.push(m);
    return calls.length === 1
      ? Response.json({ error: { code: "context_length_exceeded" } }, { status: 400 })
      : ok();
  });
  assert.equal(r.status, 200);
  await r.text();
  assert.deepEqual(calls, ["stagepin/last", "stagepin/first", "stagepin/last"]);
});
test("unusable committed pin body never replays through configured stages", async () => {
  let calls = 0;
  const r = await pinnedComposite("pipeline", async () => {
    calls++;
    return ok("");
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  assert.equal(isRoutingTerminal(r), true);
  await r.text();
});
test("uncertain pin never replays through configured stages", async () => {
  let calls = 0;
  const r = await pinnedComposite("pipeline", async () => {
    calls++;
    throw new Error("fixture uncertainty");
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  await r.text();
});

test(
  "explicit whole-combo intermediate body deadline cancels body and prevents later stage or parent fallback",
  { timeout: 2000 },
  async () => {
    let calls = 0,
      cancels = 0;
    let signal!: AbortSignal;
    const r = await handleComboChat(
      nested(
        pipeline({ targetTimeoutMs: 15, comboTimeoutMs: 40 }),
        async (_b: any, _m: string, t: any) => {
          calls++;
          signal = t.modelAbortSignal;
          return new Response(
            new ReadableStream({
              cancel() {
                cancels++;
              },
            })
          );
        }
      )
    );
    assert.equal(r.ok, false);
    await r.text();
    assert.equal(calls, 1);
    assert.equal(cancels, 1);
    assert.equal(signal.aborted, true);
  }
);
test(
  "parent cancellation during intermediate body prevents every later dispatch",
  { timeout: 2000 },
  async () => {
    let calls = 0,
      cancels = 0;
    const controller = new AbortController();
    const pending = handleComboChat(
      nested(
        pipeline(),
        async () => {
          calls++;
          setTimeout(() => controller.abort(), 5);
          return new Response(
            new ReadableStream({
              cancel() {
                cancels++;
              },
            })
          );
        },
        { signal: controller.signal }
      )
    );
    const r = await pending;
    assert.equal(r.ok, false);
    await r.text();
    assert.equal(calls, 1);
    assert.equal(cancels, 1);
  }
);
test("fusion tool-bearing request bypasses panels with complete original input once", async () => {
  const original = {
    ...body(),
    tools: [
      { type: "function", function: { name: "fixture_tool", parameters: { type: "object" } } },
    ],
    tool_choice: "auto",
  };
  const child = {
    name: "fusion-tools",
    strategy: "fusion",
    models: [{ model: "p/a" }, { model: "p/b" }],
    config: { judgeModel: "p/judge" },
  };
  const calls: any[] = [];
  const r = await handleComboChat(
    nested(
      child,
      async (b: any, m: string) => {
        calls.push({ b, m });
        return ok();
      },
      { body: original }
    )
  );
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].m, "p/judge");
  assert.deepEqual(calls[0].b, original);
});
test(
  "chaos timeout is emitted once with explicit uncertainty and cannot append late success",
  { timeout: 2000 },
  async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      release = r;
    });
    const calls: string[] = [];
    const child = {
      name: "chaos-timeout",
      strategy: "auto",
      models: [{ model: "p/fast" }, { model: "p/slow" }],
      config: { chaos: { enabled: true, tuning: { panelHardTimeoutMs: 15 } } },
    };
    const r = await handleComboChat(
      nested(child, async (_b: any, m: string) => {
        calls.push(m);
        return m === "p/slow" ? pending : ok("GOOD");
      })
    );
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.match(text, /"execution":"uncertain"/);
    assert.equal((text.match(/chaos-panel-timeout/g) || []).length, 1);
    release(ok("LATE"));
    await new Promise(setImmediate);
    assert.equal(text.includes("LATE"), false);
    assert.equal(calls.length, 2);
  }
);
