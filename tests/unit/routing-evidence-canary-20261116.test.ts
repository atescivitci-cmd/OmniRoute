/**
 * Neutral routing-evidence canary (P1) — scheduler behaviour.
 *
 * Every effect is injected through `deps`, time through `now()`, randomness through `rng()`,
 * so nothing here touches a real DB, network, provider or clock. Candidate names in this
 * file are synthetic on purpose: the canary must behave identically whatever they are called.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The module transitively imports the DB layer; point it at a throwaway dir before import.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-canary-"));

const {
  runRoutingEvidenceCanaryTick,
  createRoutingEvidenceCanaryState,
  buildCanaryProbePrompt,
  isPrivateEndpoint,
} = await import("../../src/lib/services/routingEvidenceCanary.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

test.after(() => {
  resetDbInstance();
});

const NOW_MS = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;

function conn(id, provider, extra = {}) {
  return { id, provider, authType: "apikey", isActive: true, ...extra };
}

function makeDeps(overrides = {}) {
  const probes = [];
  const counts = {};
  // Mirrors production: every probe, success or failure, leaves one usage row behind.
  const record = (args) => {
    probes.push(args);
    const key = `${args.provider}/${args.model}`;
    counts[key] = { totalRequests: (counts[key]?.totalRequests ?? 0) + 1 };
  };
  const deps = {
    getSettings: async () => ({
      routingCanary: { enabled: true, connections: { c1: true, c2: true, c3: true } },
    }),
    getConnections: async () => [conn("c1", "provA"), conn("c2", "provB"), conn("c3", "provC")],
    listPoolTargets: async () => [
      { provider: "provA", modelStr: "provA/m-one", connectionId: null },
      { provider: "provB", modelStr: "provB/m-two", connectionId: null },
      { provider: "provC", modelStr: "provC/m-three", connectionId: null },
    ],
    getEvidenceCounts: async () => ({ ...counts }),
    getPricing: async () => ({ input: 0, output: 0 }),
    canExecuteProvider: () => true,
    isModelLocked: () => false,
    isLocalProvider: () => false,
    isChatCapable: async () => true,
    runProbe: async (args) => {
      record(args);
      return { ok: true, latencyMs: 120 };
    },
    ...overrides,
  };
  return { deps, probes, counts, record };
}

const rngSeq = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

async function tick(deps, state = createRoutingEvidenceCanaryState(), opts = {}) {
  return runRoutingEvidenceCanaryTick(deps, state, opts.now ?? (() => NOW_MS), {
    rng: opts.rng ?? rngSeq([0.1, 0.9, 0.5]),
    env: opts.env ?? {},
  });
}

test("disabled by default: no settings block means zero probes", async () => {
  const { deps, probes } = makeDeps({ getSettings: async () => ({}) });
  const result = await tick(deps);
  assert.equal(probes.length, 0);
  assert.equal(result.skippedAll, "disabled");
});

test("enabled=false means zero probes even with opted-in connections", async () => {
  const { deps, probes } = makeDeps({
    getSettings: async () => ({
      routingCanary: { enabled: false, connections: { c1: true } },
    }),
  });
  await tick(deps);
  assert.equal(probes.length, 0);
});

test("env kill switch beats an enabled setting", async () => {
  for (const off of ["0", "false", "off", "OFF"]) {
    const { deps, probes } = makeDeps();
    const result = await tick(deps, undefined, { env: { ROUTING_EVIDENCE_CANARY: off } });
    assert.equal(probes.length, 0, `value ${off}`);
    assert.equal(result.skippedAll, "kill_switch");
  }
});

test("only explicitly opted-in connections are probed", async () => {
  const { deps, probes } = makeDeps({
    getSettings: async () => ({ routingCanary: { enabled: true, connections: { c2: true } } }),
  });
  await tick(deps);
  assert.deepEqual(
    probes.map((p) => p.connectionId),
    ["c2"]
  );
});

test("subscription (oauth) connections are never probed in P1, even if opted in", async () => {
  const { deps, probes } = makeDeps({
    getConnections: async () => [conn("c1", "provA", { authType: "oauth" }), conn("c2", "provB")],
  });
  const result = await tick(deps);
  assert.deepEqual(
    probes.map((p) => p.connectionId),
    ["c2"]
  );
  assert.ok(result.skipped.subscription_connection >= 1);
});

test("local providers are skipped unless includeLocal is set", async () => {
  const local = (p) => p === "provA";
  {
    const { deps, probes } = makeDeps({ isLocalProvider: local });
    await tick(deps);
    assert.ok(!probes.some((p) => p.provider === "provA"));
  }
  {
    const { deps, probes } = makeDeps({
      isLocalProvider: local,
      getSettings: async () => ({
        routingCanary: { enabled: true, includeLocal: true, connections: { c1: true } },
      }),
    });
    await tick(deps);
    assert.ok(probes.some((p) => p.provider === "provA"));
  }
});

test("cooldown, terminal status, open breaker and model lock all skip the candidate", async () => {
  const future = new Date(NOW_MS + 10 * MIN).toISOString();
  const { deps, probes } = makeDeps({
    getConnections: async () => [
      conn("c1", "provA", { rateLimitedUntil: future }),
      conn("c2", "provB", { testStatus: "credits_exhausted" }),
      conn("c3", "provC"),
    ],
  });
  await tick(deps);
  assert.deepEqual(
    probes.map((p) => p.connectionId),
    ["c3"]
  );

  const breaker = makeDeps({ canExecuteProvider: (p) => p !== "provC" });
  await tick(breaker.deps);
  assert.ok(!breaker.probes.some((p) => p.provider === "provC"));

  const locked = makeDeps({ isModelLocked: (_p, _c, m) => m === "m-two" });
  await tick(locked.deps);
  assert.ok(!locked.probes.some((p) => p.model === "m-two"));
});

test("candidates that already have enough fresh evidence are not probed", async () => {
  const { deps, probes } = makeDeps({
    getEvidenceCounts: async () => ({
      "provA/m-one": { totalRequests: 10 },
      "provB/m-two": { totalRequests: 9 },
    }),
  });
  await tick(deps);
  const probed = probes.map((p) => `${p.provider}/${p.model}`).sort();
  assert.deepEqual(probed, ["provB/m-two", "provC/m-three"]);
});

test("a candidate is not re-probed inside the spacing window; failures double it", async () => {
  const state = createRoutingEvidenceCanaryState();
  let t = NOW_MS;
  const ctx = makeDeps({
    runProbe: async (args) => {
      ctx.record(args);
      return args.provider === "provB"
        ? { ok: false, latencyMs: 50, statusCode: 500 }
        : { ok: true, latencyMs: 50 };
    },
  });
  const { deps, probes } = ctx;
  await tick(deps, state, { now: () => t });
  assert.equal(probes.length, 3);

  t += 10 * MIN; // inside the 30 min spacing
  await tick(deps, state, { now: () => t });
  assert.equal(probes.length, 3);

  t += 25 * MIN; // 35 min after the first round: ok candidates are due, the failed one is not
  await tick(deps, state, { now: () => t });
  const second = probes
    .slice(3)
    .map((p) => p.provider)
    .sort();
  assert.deepEqual(second, ["provA", "provC"]);

  t += 30 * MIN; // 65 min: failed candidate (2x spacing = 60 min) is due again
  await tick(deps, state, { now: () => t });
  assert.ok(probes.slice(5).some((p) => p.provider === "provB"));
});

test("every candidate in a cycle receives byte-identical probe content", async () => {
  const { deps, probes } = makeDeps();
  await tick(deps);
  assert.equal(probes.length, 3);
  const prompts = new Set(probes.map((p) => p.prompt));
  assert.equal(prompts.size, 1);
  assert.ok([...prompts][0].length > 100);
});

test("probe content differs across cycles only by the cycle nonce", () => {
  const a = buildCanaryProbePrompt("small", "cycle-1");
  const b = buildCanaryProbePrompt("small", "cycle-2");
  assert.notEqual(a, b);
  assert.equal(a.replace("cycle-1", "X"), b.replace("cycle-2", "X"));
  const medium = buildCanaryProbePrompt("medium", "cycle-1");
  assert.ok(medium.length > a.length * 8);
});

test("ordering is data-driven: never-probed first, then least recently probed, ties by rng only", async () => {
  const state = createRoutingEvidenceCanaryState();
  const { deps, probes } = makeDeps({
    getSettings: async () => ({
      routingCanary: {
        enabled: true,
        maxProbesPerTick: 1,
        connections: { c1: true, c2: true, c3: true },
      },
    }),
  });
  state.lastProbeAt["provA/m-one@c1"] = NOW_MS - 120 * MIN;
  state.lastProbeAt["provB/m-two@c2"] = NOW_MS - 90 * MIN;
  // provC never probed -> goes first
  await tick(deps, state);
  assert.equal(probes[0].provider, "provC");
});

test("probe order does not depend on names: renaming candidates yields the same permutation", async () => {
  const run = async (names) => {
    const { deps, probes } = makeDeps({
      getConnections: async () => names.map((n, i) => conn(`id${i}`, n.provider)),
      getSettings: async () => ({
        routingCanary: {
          enabled: true,
          connections: Object.fromEntries(names.map((_n, i) => [`id${i}`, true])),
        },
      }),
      listPoolTargets: async () =>
        names.map((n) => ({
          provider: n.provider,
          modelStr: `${n.provider}/${n.model}`,
          connectionId: null,
        })),
    });
    await tick(deps, undefined, { rng: rngSeq([0.2, 0.7, 0.4, 0.9]) });
    return probes.map((p) => Number(p.connectionId.slice(2)));
  };
  const a = await run([
    { provider: "aaa", model: "x1" },
    { provider: "bbb", model: "x2" },
    { provider: "ccc", model: "x3" },
  ]);
  const b = await run([
    { provider: "zzz", model: "q9" },
    { provider: "yyy", model: "q8" },
    { provider: "xxx", model: "q7" },
  ]);
  assert.deepEqual(a, b);
});

test("metered or unknown-price candidates respect the daily budget; free ones are not capped", async () => {
  const pricing = {
    provA: { input: 0, output: 0 }, // free
    provB: { input: 3, output: 15 }, // metered
    provC: null, // unknown -> treated as metered with a conservative default
  };
  const { deps, probes } = makeDeps({
    getPricing: async (provider) => pricing[provider],
    getSettings: async () => ({
      routingCanary: {
        enabled: true,
        dailyBudgetUsd: 0.004, // roughly one small metered probe
        connections: { c1: true, c2: true, c3: true },
      },
    }),
  });
  const state = createRoutingEvidenceCanaryState();
  const result = await tick(deps, state);
  const names = probes.map((p) => p.provider).sort();
  assert.ok(names.includes("provA"), "free candidate always probed");
  assert.equal(names.filter((n) => n !== "provA").length, 1, "only one metered probe fits");
  assert.ok(result.skipped.budget_exhausted >= 1);
  assert.ok(state.spend.usd > 0 && state.spend.usd <= 0.004);
});

test("budget rolls over at the UTC day boundary", async () => {
  const state = createRoutingEvidenceCanaryState();
  const { deps, probes } = makeDeps({
    getPricing: async () => ({ input: 3, output: 15 }),
    getSettings: async () => ({
      routingCanary: { enabled: true, dailyBudgetUsd: 0.004, connections: { c1: true } },
    }),
    getConnections: async () => [conn("c1", "provA")],
    listPoolTargets: async () => [
      { provider: "provA", modelStr: "provA/m-one", connectionId: null },
      { provider: "provA", modelStr: "provA/m-two", connectionId: null },
    ],
  });
  await tick(deps, state);
  const first = probes.length;
  assert.ok(first >= 1);
  await tick(deps, state, { now: () => NOW_MS + 40 * MIN }); // same UTC day: budget still spent
  const sameDay = probes.length;
  const nextDay = NOW_MS + 13 * 60 * MIN; // 01:00 UTC next day
  await tick(deps, state, { now: () => nextDay });
  assert.ok(probes.length > sameDay);
});

test("maxProbesPerTick and per-provider spacing bound the load", async () => {
  const { deps, probes } = makeDeps({
    getSettings: async () => ({
      routingCanary: {
        enabled: true,
        maxProbesPerTick: 2,
        connections: { c1: true, c2: true, c3: true },
      },
    }),
  });
  await tick(deps);
  assert.equal(probes.length, 2);

  const sameProvider = makeDeps({
    getConnections: async () => [conn("c1", "provA")],
    getSettings: async () => ({ routingCanary: { enabled: true, connections: { c1: true } } }),
    listPoolTargets: async () => [
      { provider: "provA", modelStr: "provA/m-one", connectionId: null },
      { provider: "provA", modelStr: "provA/m-two", connectionId: null },
    ],
  });
  await tick(sameProvider.deps);
  assert.equal(sameProvider.probes.length, 1, "one probe per provider per tick");
});

test("a pool target pinned to a connection only uses that connection", async () => {
  const { deps, probes } = makeDeps({
    getConnections: async () => [conn("c1", "provA"), conn("c2", "provA")],
    getSettings: async () => ({
      routingCanary: { enabled: true, connections: { c1: true, c2: true } },
    }),
    listPoolTargets: async () => [
      { provider: "provA", modelStr: "provA/m-one", connectionId: "c2" },
    ],
  });
  await tick(deps);
  assert.deepEqual(
    probes.map((p) => p.connectionId),
    ["c2"]
  );
});

test("duplicate pool targets are probed once", async () => {
  const { deps, probes } = makeDeps({
    listPoolTargets: async () => [
      { provider: "provA", modelStr: "provA/m-one", connectionId: null },
      { provider: "provA", modelStr: "provA/m-one", connectionId: null },
    ],
  });
  await tick(deps);
  assert.equal(probes.length, 1);
});

test("a throwing probe is recorded as a failure and does not stop the tick", async () => {
  const state = createRoutingEvidenceCanaryState();
  const seen = [];
  const { deps } = makeDeps({
    runProbe: async (args) => {
      seen.push(args.provider);
      if (args.provider === "provB") throw new Error("boom");
      return { ok: true, latencyMs: 10 };
    },
  });
  const result = await tick(deps, state);
  assert.equal(seen.length, 3);
  assert.equal(result.failed, 1);
  assert.equal(state.failedAt["provB/m-two@c2"], NOW_MS);
});

test("a failure to list the pool aborts the tick loudly, not as an empty pool", async () => {
  const { deps, probes } = makeDeps({
    listPoolTargets: async () => {
      throw new Error("pool unavailable");
    },
  });
  const result = await tick(deps);
  assert.equal(probes.length, 0);
  assert.equal(result.error, "pool_unavailable");
});

test("re-entrant ticks are a no-op while one is running", async () => {
  const state = createRoutingEvidenceCanaryState();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const ctx = makeDeps({
    runProbe: async (args) => {
      ctx.record(args);
      await gate;
      return { ok: true, latencyMs: 1 };
    },
  });
  const { deps, probes } = ctx;
  const first = tick(deps, state);
  await new Promise((r) => setImmediate(r));
  const second = await tick(deps, state);
  assert.equal(second.skippedAll, "already_running");
  release();
  await first;
});

test("source neutrality: the canary names no provider, model family or combo", () => {
  const files = [
    "src/lib/services/routingEvidenceCanary.ts",
    "src/shared/constants/routingEvidenceCanary.ts",
  ];
  const banned =
    /claude|anthropic|opus|sonnet|haiku|gpt|openai|codex|gemini|nvidia|nemotron|ollama|github|copilot|llama|qwen|mistral|deepseek|kimi|glm|grok|cammy|terminal-continuity/i;
  for (const rel of files) {
    const abs = path.join(process.cwd(), rel);
    const text = fs.readFileSync(abs, "utf8");
    const hit = text.match(banned);
    assert.equal(hit, null, `${rel} mentions a banned name: ${hit && hit[0]}`);
    // Any comparison of a provider or model against a string literal is a name-based branch,
    // whatever the name: that is what this canary must never do.
    const literalBranch = text.match(
      /\b(provider|providerId|model|modelId|modelStr)\b\s*(===|==|!==|!=)\s*["'`]|["'`]\s*(===|==|!==|!=)\s*\b(provider|providerId|model|modelId|modelStr)\b|\b(provider|model|modelStr)\w*\.(startsWith|endsWith|includes)\(\s*["'`]|case\s+["'`][\w./-]+["'`]\s*:/
    );
    assert.equal(
      literalBranch,
      null,
      `${rel} branches on a name literal: ${literalBranch && literalBranch[0]}`
    );
  }
});

test("only declared chat-capable models are probed; unknown capability is not probed", async () => {
  const { deps, probes } = makeDeps({
    isChatCapable: async (_p, model) => model !== "m-two",
  });
  const result = await tick(deps);
  assert.ok(!probes.some((p) => p.model === "m-two"));
  assert.equal(result.skipped.not_chat_capable, 1);

  const failing = makeDeps({
    isChatCapable: async () => {
      throw new Error("registry unavailable");
    },
  });
  const res = await tick(failing.deps);
  assert.equal(failing.probes.length, 0, "unknown capability must not be probed");
  assert.equal(res.skipped.not_chat_capable, 3);
});

test("local and private endpoints are skipped unless includeLocal is set", async () => {
  for (const baseUrl of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080",
    "http://192.168.1.20:8000/v1",
    "http://10.0.0.5/v1",
    "http://172.20.1.1:9000",
    "http://[::1]:8000",
    "http://modelbox:8000",
    "http://100.64.0.7:11434",
    "http://100.127.255.1",
    "https://studio.tail1234.ts.net",
  ]) {
    assert.equal(isPrivateEndpoint(baseUrl), true, baseUrl);
    const { deps, probes } = makeDeps({
      getConnections: async () => [conn("c1", "provA", { baseUrl })],
    });
    await tick(deps);
    assert.equal(probes.filter((p) => p.provider === "provA").length, 0, baseUrl);
  }
  for (const baseUrl of [
    "https://api.example.com/v1",
    "http://8.8.8.8/v1",
    "http://172.32.0.1",
    "http://100.63.0.1",
    "http://100.128.0.1",
    "",
  ]) {
    assert.equal(isPrivateEndpoint(baseUrl), false, baseUrl);
  }
  const { deps, probes } = makeDeps({
    getConnections: async () => [conn("c1", "provA", { baseUrl: "http://localhost:11434/v1" })],
    getSettings: async () => ({
      routingCanary: { enabled: true, includeLocal: true, connections: { c1: true } },
    }),
  });
  await tick(deps);
  assert.ok(probes.some((p) => p.provider === "provA"));
});

test("repeated failures back off exponentially, capped at 24 h", async () => {
  const state = createRoutingEvidenceCanaryState();
  let t = NOW_MS;
  const ctx = makeDeps({
    getConnections: async () => [conn("c1", "provA")],
    listPoolTargets: async () => [
      { provider: "provA", modelStr: "provA/m-one", connectionId: null },
    ],
    getSettings: async () => ({ routingCanary: { enabled: true, connections: { c1: true } } }),
    runProbe: async (args) => {
      ctx.record(args);
      return { ok: false, latencyMs: 5, statusCode: 500 };
    },
  });
  const at = async (min) => {
    t = NOW_MS + min * MIN;
    await tick(ctx.deps, state, { now: () => t });
    return ctx.probes.length;
  };
  assert.equal(await at(0), 1); // fail 1 -> wait 60
  assert.equal(await at(59), 1);
  assert.equal(await at(61), 2); // fail 2 -> wait 120
  assert.equal(await at(61 + 119), 2);
  assert.equal(await at(61 + 121), 3); // fail 3 -> wait 240
  assert.equal(await at(61 + 121 + 239), 3);
  assert.equal(await at(61 + 121 + 241), 4);
  // far in the future the wait is capped at 24 h, not unbounded
  state.failCount["provA/m-one@c1"] = 40;
  state.lastProbeAt["provA/m-one@c1"] = NOW_MS + 10_000 * MIN;
  const before = ctx.probes.length;
  await tick(ctx.deps, state, { now: () => NOW_MS + 10_000 * MIN + 24 * 60 * MIN + MIN });
  assert.equal(ctx.probes.length, before + 1);
});

test("a probe that returns ok but leaves no new sample backs off like a failure", async () => {
  const state = createRoutingEvidenceCanaryState();
  const ctx = makeDeps({
    getConnections: async () => [conn("c1", "provA")],
    listPoolTargets: async () => [
      { provider: "provA", modelStr: "provA/m-one", connectionId: null },
    ],
    getSettings: async () => ({ routingCanary: { enabled: true, connections: { c1: true } } }),
    getEvidenceCounts: async () => ({}), // evidence never grows
  });
  await tick(ctx.deps, state, { now: () => NOW_MS });
  assert.equal(ctx.probes.length, 1);
  await tick(ctx.deps, state, { now: () => NOW_MS + 31 * MIN });
  assert.equal(ctx.probes.length, 1, "first silent probe doubles the wait to 60 min");
  assert.equal(state.failCount["provA/m-one@c1"], 1);
  await tick(ctx.deps, state, { now: () => NOW_MS + 61 * MIN });
  assert.equal(ctx.probes.length, 2);
});

test("a probe that leaves a sample resets the failure count", async () => {
  const state = createRoutingEvidenceCanaryState();
  state.failCount["provA/m-one@c1"] = 3;
  const ctx = makeDeps({
    getConnections: async () => [conn("c1", "provA")],
    listPoolTargets: async () => [
      { provider: "provA", modelStr: "provA/m-one", connectionId: null },
    ],
    getSettings: async () => ({ routingCanary: { enabled: true, connections: { c1: true } } }),
  });
  await tick(ctx.deps, state, { now: () => NOW_MS });
  assert.equal(ctx.probes.length, 1);
  await tick(ctx.deps, state, { now: () => NOW_MS + MIN });
  assert.equal(state.failCount["provA/m-one@c1"], undefined);
});

test("bookkeeping for candidates gone a week ago is pruned", async () => {
  const state = createRoutingEvidenceCanaryState();
  const old = NOW_MS - 8 * 24 * 60 * MIN;
  state.lastProbeAt["gone/x@c9"] = old;
  state.failedAt["gone/x@c9"] = old;
  state.failCount["gone/x@c9"] = 2;
  state.evidenceAtProbe["gone/x@c9"] = 1;
  state.lastProbeAt["recent/y@c8"] = NOW_MS - 60 * MIN;
  const { deps } = makeDeps();
  await tick(deps, state);
  assert.equal(state.lastProbeAt["gone/x@c9"], undefined);
  assert.equal(state.failedAt["gone/x@c9"], undefined);
  assert.equal(state.failCount["gone/x@c9"], undefined);
  assert.equal(state.evidenceAtProbe["gone/x@c9"], undefined);
  assert.ok(state.lastProbeAt["recent/y@c8"], "recent entries are kept");
});

test("the probe asks for a fixed-length answer so throughput is comparable across candidates", () => {
  const prompt = buildCanaryProbePrompt("small", "n");
  assert.ok(/numbers from 1 to 60/.test(prompt));
  assert.ok(!/single word/i.test(prompt));
});

test("ties are broken by the injected randomness, not by pool order", async () => {
  const firstProbed = async (rngValues) => {
    const { deps, probes } = makeDeps({
      getSettings: async () => ({
        routingCanary: {
          enabled: true,
          maxProbesPerTick: 1,
          connections: { c1: true, c2: true, c3: true },
        },
      }),
    });
    await tick(deps, undefined, { rng: rngSeq(rngValues) });
    return probes[0].provider;
  };
  const seen = new Set();
  for (const values of [
    [0.0, 0.0],
    [0.99, 0.99],
    [0.99, 0.0],
    [0.0, 0.99],
  ]) {
    seen.add(await firstProbed(values));
  }
  assert.ok(seen.size > 1, `first probe never varied with the rng: ${[...seen]}`);
});
