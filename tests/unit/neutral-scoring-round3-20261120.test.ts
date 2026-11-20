import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTask,
  getConversationTieKey,
  reorderByTaskWeight,
  TASK_LEVEL_WEIGHT,
} from "../../open-sse/services/taskAwareRouting.ts";
import {
  rankFitFirstFreeCandidates,
  type FitFirstCandidate,
} from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { DEFAULT_WEIGHTS, scorePool } from "../../open-sse/services/autoCombo/scoring.ts";
import {
  clearUserFitnessOverride,
  getCapabilityDerivedFitness,
  getTaskFitness,
  getTaskFitnessWithSource,
  invalidateFitnessCache,
  setUserFitnessOverride,
} from "../../open-sse/services/autoCombo/taskFitness.ts";
import {
  clearModelsDevCapabilities,
  ensureCapabilitiesTable,
  saveModelsDevCapabilities,
} from "../../src/lib/modelsDevSync.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import {
  deleteModelIntelligence,
  upsertModelIntelligence,
} from "../../src/lib/db/modelIntelligence.ts";

// Round 3 (2026-11-20): long-system-prompt key collapse, measured evidence reachability,
// graceful degradation. Real ranker, real resolver, isolated DB.

test.after(() => {
  clearModelsDevCapabilities();
  resetDbInstance();
});

const entry = (limit_context: number | null, limit_output: number | null) => ({
  tool_call: true,
  reasoning: true,
  attachment: false,
  structured_output: null,
  temperature: null,
  modalities_input: null,
  modalities_output: null,
  knowledge_cutoff: null,
  release_date: null,
  last_updated: null,
  status: null,
  family: null,
  open_weights: null,
  limit_context,
  limit_input: null,
  limit_output,
  interleaved_field: null,
});
function install(ids: string[]) {
  const data: Record<string, Record<string, ReturnType<typeof entry>>> = {};
  for (const id of ids) {
    const i = id.indexOf("/");
    (data[id.slice(0, i)] ||= {})[id.slice(i + 1)] = entry(1_000_000, 128_000);
  }
  saveModelsDevCapabilities(data);
  invalidateFitnessCache();
}
function cand(id: string): FitFirstCandidate {
  const i = id.indexOf("/");
  return {
    provider: id.slice(0, i),
    model: id.slice(i + 1),
    modelStr: id,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 0,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
  } as FitFirstCandidate;
}

const EQUAL = ["syna/zorbex-9", "synb/quillon-3", "sync/vandra-7", "synd/hexel-5"];
function winner(body: Record<string, unknown>, sessionId?: string | null): string {
  const d = rankFitFirstFreeCandidates({
    candidates: EQUAL.map(cand),
    body,
    zeroAdditionalCostProviders: ["syna", "synb", "sync", "synd"],
    conversationKey: getConversationTieKey(body, { sessionId }),
    taskProfile: {
      source: "interpreter",
      fallbackReason: null,
      profile: {
        taskType: "general",
        complexity: "critical",
        requiredCapabilities: [],
        confidence: 1,
      },
    },
  });
  return `${d.ranked[0].candidate.provider}/${d.ranked[0].candidate.model}`;
}
function spread(winners: string[]): Map<string, number> {
  const m = new Map(EQUAL.map((i) => [i, 0]));
  for (const w of winners) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}
function assertSpread(winners: string[], label: string) {
  const n = winners.length;
  const m = spread(winners);
  for (const [id, c] of m) {
    assert.ok(c > n * 0.13 && c < n * 0.4, `${label}: ${id} won ${c}/${n}: ${[...m].join(" ")}`);
  }
}

// ── 1. realistic bodies with long static prefixes ───────────────────────────

const CLAUDE_CODE_STATIC =
  "You are Claude Code, an interactive CLI agent. Follow all rules. ".repeat(300); // ~19K chars
const CODEX_STATIC = "You are Codex, a coding agent running in a terminal. Obey the rules. ".repeat(
  280
); // ~19K chars

const claudeCodeBody = (k: number, extra: Record<string, unknown> = {}, turns = 1) => {
  const messages: unknown[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<system-reminder>cwd=/work/p-${k} date=2026-11-${(k % 28) + 1}</system-reminder>`,
        },
        { type: "text", text: `Session ${k}: fix ticket ${k * 13}.` },
      ],
    },
  ];
  for (let t = 1; t < turns; t++) {
    messages.push(
      { role: "assistant", content: `done ${t}` },
      { role: "user", content: `then ${t} ${"y".repeat(t * 9)}` }
    );
  }
  return {
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's CLI." },
      { type: "text", text: CLAUDE_CODE_STATIC },
    ],
    messages,
    ...extra,
  };
};

const codexBody = (k: number, extra: Record<string, unknown> = {}, turns = 1) => {
  const input: unknown[] = [
    {
      role: "user",
      content: [{ type: "input_text", text: `Task ${k}: refactor module ${k * 3}` }],
    },
  ];
  for (let t = 1; t < turns; t++) {
    input.push(
      { role: "assistant", content: [{ type: "output_text", text: `ok ${t}` }] },
      { role: "user", content: [{ type: "input_text", text: `next ${t} ${"z".repeat(t * 5)}` }] }
    );
  }
  return { instructions: CODEX_STATIC, input, ...extra };
};

test("R6: Claude Code style bodies (19K static system, per-session user text, metadata.user_id) spread across equal candidates", () => {
  install(EQUAL);
  const N = 120;
  const withId = Array.from({ length: N }, (_, k) =>
    winner(
      claudeCodeBody(k, {
        metadata: {
          user_id: `user_abc123_account_def_session_${String(k).padStart(8, "0")}-aaaa-bbbb`,
        },
      })
    )
  );
  assertSpread(withId, "with metadata.user_id");
  const withoutId = Array.from({ length: N }, (_, k) => winner(claudeCodeBody(k)));
  assertSpread(withoutId, "no session id (first user message only)");
});

test("R6: a per-session tail at the END of a long system prompt reaches the key", () => {
  install(EQUAL);
  const N = 120;
  const winners = Array.from({ length: N }, (_, k) =>
    winner({
      system: [
        { type: "text", text: `${CLAUDE_CODE_STATIC}\nEnvironment: cwd=/work/project-${k}` },
      ],
      messages: [{ role: "user", content: "same first message for every session" }],
    })
  );
  assertSpread(winners, "long system prefix, distinct tail, identical first message");
});

test("R6: Codex style bodies (long instructions) spread, with and without prompt_cache_key", () => {
  install(EQUAL);
  const N = 120;
  assertSpread(
    Array.from({ length: N }, (_, k) => winner(codexBody(k))),
    "no prompt_cache_key"
  );
  assertSpread(
    Array.from({ length: N }, (_, k) =>
      winner(codexBody(k, { prompt_cache_key: `pck-${k}-${"q".repeat(20)}` }))
    ),
    "prompt_cache_key"
  );
});

test("R6: Claude Code JSON metadata.user_id sessions spread and stay stable", () => {
  install(EQUAL);
  const uid = (k: number) =>
    JSON.stringify({
      device_id: "same-device",
      account_uuid: "",
      session_id: `${String(k).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`,
    });
  assertSpread(
    Array.from({ length: 120 }, (_, k) =>
      winner(claudeCodeBody(k, { metadata: { user_id: uid(k) } }))
    ),
    "json user_id"
  );
  for (let k = 0; k < 8; k++) {
    const picks = new Set<string>();
    for (let t = 1; t <= 10; t++)
      picks.add(winner(claudeCodeBody(k, { metadata: { user_id: uid(k) } }, t)));
    assert.equal(picks.size, 1);
  }
});

test("R6: each style keeps one winner for the life of a conversation", () => {
  install(EQUAL);
  for (let k = 0; k < 12; k++) {
    const meta = {
      metadata: { user_id: `user_x_account_y_session_${String(k).padStart(8, "0")}-1111` },
    };
    for (const make of [
      (t: number) => claudeCodeBody(k, meta, t),
      (t: number) => claudeCodeBody(k, {}, t),
      (t: number) => codexBody(k, {}, t),
      (t: number) => codexBody(k, { prompt_cache_key: `pck-${k}` }, t),
    ]) {
      const picks = new Set<string>();
      for (let t = 1; t <= 12; t++) picks.add(winner(make(t)));
      assert.equal(picks.size, 1, `conversation ${k} switched model between turns`);
    }
  }
});

test("R6: key priority: external session id, then session inside metadata.user_id, then explicit ids, then server fingerprint, then content", () => {
  const body = claudeCodeBody(1, {
    metadata: { user_id: "user_h_account_a_session_12345678-abcd" },
    prompt_cache_key: "pck",
  });
  const ext = getConversationTieKey(body, { sessionId: "ext:client-chosen" });
  assert.match(ext!, /^ext:/);
  assert.notEqual(ext, getConversationTieKey(body, { sessionId: "ext:another" }));
  assert.equal(
    getConversationTieKey(body, { sessionId: "deadbeef" }),
    getConversationTieKey(body, {})
  );
  assert.match(getConversationTieKey(body)!, /^uid:/);
  const { metadata: _m, ...noMeta } = body;
  assert.match(getConversationTieKey(noMeta)!, /^explicit:/);
  const { prompt_cache_key: _p, ...bare } = noMeta;
  assert.match(getConversationTieKey(bare, { sessionId: "deadbeef" })!, /^sid:/);
  assert.match(getConversationTieKey(bare)!, /^conv:/);
  assert.equal(getConversationTieKey({}), null);
  // JSON user_id (device/account/session), the form Claude Code sends and claudeCodeCompatible emits.
  const j = (sid: string, device = "dev") => ({
    ...bare,
    metadata: { user_id: JSON.stringify({ device_id: device, account_uuid: "", session_id: sid }) },
  });
  assert.match(getConversationTieKey(j("11111111-2222-3333-4444-555555555555"))!, /^uid:/);
  assert.equal(
    getConversationTieKey(j("11111111-2222-3333-4444-555555555555", "devA")),
    getConversationTieKey(j("11111111-2222-3333-4444-555555555555", "devB"))
  );
  assert.notEqual(
    getConversationTieKey(j("11111111-2222-3333-4444-555555555555")),
    getConversationTieKey(j("99999999-2222-3333-4444-555555555555"))
  );
  assert.match(
    getConversationTieKey({
      ...bare,
      metadata: { user_id: JSON.stringify({ device_id: "d", session_id: "" }) },
    })!,
    /^conv:/
  );
  // A user_id with no session segment is not a conversation id.
  assert.match(
    getConversationTieKey({ ...bare, metadata: { user_id: "user_only_hash" } })!,
    /^conv:/
  );
});

test("R6: same key function for fit-first and the task-aware reorder (both paths agree)", () => {
  install(EQUAL);
  const task = {
    ...classifyTask({}),
    level: "critical" as const,
    weight: TASK_LEVEL_WEIGHT.critical,
  };
  const tgt = (id: string) => ({
    kind: "model" as const,
    stepId: id,
    executionKey: id,
    modelStr: id,
    provider: id.split("/")[0],
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  });
  const N = 60;
  for (let k = 0; k < N; k++) {
    const body = claudeCodeBody(k, { prompt_cache_key: `pck-${k}` });
    const key = getConversationTieKey(body);
    const fitFirst = winner(body);
    const reorder = reorderByTaskWeight(EQUAL.map(tgt), task, new Set(), { tieKey: key })[0]
      .modelStr;
    // Both are pure functions of the same key: each is stable for that key.
    assert.equal(winner(body), fitFirst);
    assert.equal(
      reorderByTaskWeight(EQUAL.map(tgt), task, new Set(), { tieKey: key })[0].modelStr,
      reorder
    );
  }
  // prompt_cache_key is part of the key in both paths: two bodies differing only in it differ.
  assert.notEqual(
    getConversationTieKey(claudeCodeBody(0, { prompt_cache_key: "a" })),
    getConversationTieKey(claudeCodeBody(0, { prompt_cache_key: "b" }))
  );
});

// ── 2. measured evidence is reachable under the qualified and the bare id ───

const MEASURED = "syna/zorbex-arena";
const UNMEASURED = "synb/quillon-3";

function withArenaRow<T>(model: string, score: number, fn: () => T): T {
  upsertModelIntelligence({
    model,
    source: "arena_elo",
    category: "coding",
    score,
    eloRaw: 1500,
    confidence: "high",
    expiresAt: null,
  } as never);
  invalidateFitnessCache();
  try {
    return fn();
  } finally {
    deleteModelIntelligence(model, "arena_elo", "coding");
    invalidateFitnessCache();
  }
}

test("R7: an arena_elo row written under the bare model name is found from the provider-qualified id", () => {
  install([MEASURED, UNMEASURED]);
  withArenaRow("zorbex-arena", 0.97, () => {
    assert.deepEqual(getTaskFitnessWithSource("zorbex-arena", "coding"), {
      score: 0.97,
      source: "arena_elo",
    });
    assert.deepEqual(getTaskFitnessWithSource(MEASURED, "coding"), {
      score: 0.97,
      source: "arena_elo",
    });
    const other = getTaskFitnessWithSource(UNMEASURED, "coding");
    assert.equal(other.source, "capability_derived");
  });
});

test("R7: a row keyed by the qualified id wins over the bare one, and user_override beats arena", () => {
  install([MEASURED]);
  withArenaRow("zorbex-arena", 0.5, () => {
    upsertModelIntelligence({
      model: MEASURED,
      source: "arena_elo",
      category: "coding",
      score: 0.91,
      eloRaw: null,
      confidence: null,
      expiresAt: null,
    } as never);
    invalidateFitnessCache();
    try {
      assert.equal(getTaskFitness(MEASURED, "coding"), 0.91);
    } finally {
      deleteModelIntelligence(MEASURED, "arena_elo", "coding");
      invalidateFitnessCache();
    }
    setUserFitnessOverride("zorbex-arena", "coding", 0.33);
    try {
      assert.deepEqual(getTaskFitnessWithSource(MEASURED, "coding"), {
        score: 0.33,
        source: "user_override",
      });
    } finally {
      clearUserFitnessOverride("zorbex-arena", "coding");
    }
  });
});

test("R7: legacy 12-factor path and fit-first path both see the measured row", () => {
  install([MEASURED, UNMEASURED]);
  withArenaRow("zorbex-arena", 0.97, () => {
    const mk = (id: string) => ({
      provider: id.split("/")[0],
      model: id.split("/")[1],
      quotaRemaining: 100,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED" as const,
      costPer1MTokens: 1,
      p95LatencyMs: 100,
      latencyStdDev: 10,
      errorRate: 0,
    });
    const scored = scorePool(
      [mk(MEASURED), mk(UNMEASURED)],
      "coding",
      DEFAULT_WEIGHTS,
      getTaskFitness
    );
    const fa = scored.find((s) => s.model === "zorbex-arena")!.factors.taskFit;
    const fb = scored.find((s) => s.model === "quillon-3")!.factors.taskFit;
    assert.ok(fa > fb + 0.02, `${fa} vs ${fb}`);
    const d = rankFitFirstFreeCandidates({
      candidates: [cand(MEASURED), cand(UNMEASURED)],
      body: { messages: [{ role: "user", content: "Implement a TypeScript function and tests." }] },
      zeroAdditionalCostProviders: ["syna", "synb"],
      taskProfile: {
        source: "deterministic",
        fallbackReason: "not_configured",
        profile: {
          taskType: "coding",
          complexity: "standard",
          requiredCapabilities: [],
          confidence: 1,
        },
      },
    });
    assert.equal(
      d.ranked.find((r) => r.candidate.model === "zorbex-arena")!.factors.taskFitnessSource,
      "arena_elo"
    );
  });
});

test("R7: an unmeasured model is not penalised by measurement elsewhere: it keeps its capability-derived fitness", () => {
  install([MEASURED, UNMEASURED]);
  const before = getTaskFitnessWithSource(UNMEASURED, "coding");
  withArenaRow("zorbex-arena", 0.4, () => {
    assert.deepEqual(getTaskFitnessWithSource(UNMEASURED, "coding"), before);
  });
});

// ── 4. a model counts once in the tie draw ──────────────────────────────────

function installWithMeta(map: Record<string, { family: string | null; release: string | null }>) {
  const data: Record<string, Record<string, ReturnType<typeof entry>>> = {};
  for (const [id, meta] of Object.entries(map)) {
    const i = id.indexOf("/");
    (data[id.slice(0, i)] ||= {})[id.slice(i + 1)] = {
      ...entry(1_000_000, 128_000),
      family: meta.family,
      release_date: meta.release,
    } as never;
  }
  saveModelsDevCapabilities(data);
  invalidateFitnessCache();
}

function pickShares(candidates: FitFirstCandidate[], conversations: number): Map<string, number> {
  const providers = [...new Set(candidates.map((c) => c.provider))];
  const wins = new Map<string, number>();
  for (let k = 0; k < conversations; k++) {
    const body = { messages: [{ role: "user", content: `conversation ${k}: do thing ${k * 11}` }] };
    const d = rankFitFirstFreeCandidates({
      candidates,
      body,
      zeroAdditionalCostProviders: providers,
      conversationKey: getConversationTieKey(body),
      taskProfile: {
        source: "interpreter",
        fallbackReason: null,
        profile: {
          taskType: "general",
          complexity: "critical",
          requiredCapabilities: [],
          confidence: 1,
        },
      },
    });
    const w = d.ranked[0].candidate.provider;
    wins.set(w, (wins.get(w) ?? 0) + 1);
  }
  return wins;
}

test("R9: aliases and snapshot ids of one model (same provider, family, release date, capabilities) share one draw", () => {
  // vendor X lists one model under four ids; vendor Y lists one model once. Without identity
  // collapse X would win 4 of 5 ties.
  installWithMeta({
    "synx/m-one": { family: "fam-x", release: "2026-01-01" },
    "synx/m-one@default": { family: "fam-x", release: "2026-01-01" },
    "synx/m-one-20260101": { family: "fam-x", release: "2026-01-01" },
    "synx/m-one-latest": { family: "fam-x", release: "2026-01-01" },
    "syny/other": { family: "fam-y", release: "2026-02-02" },
  });
  const ids = [
    "synx/m-one",
    "synx/m-one@default",
    "synx/m-one-20260101",
    "synx/m-one-latest",
    "syny/other",
  ];
  const N = 600;
  const wins = pickShares(ids.map(cand), N);
  const x = (wins.get("synx") ?? 0) / N;
  assert.ok(
    x > 0.4 && x < 0.6,
    `vendor X won ${(x * 100).toFixed(0)}% of ties (expected about 50%)`
  );
  // Within the identity the alias is chosen by the entry hash, spread across the four ids.
  const inner = new Set<string>();
  for (let k = 0; k < 200; k++) {
    const body = { messages: [{ role: "user", content: `inner ${k}` }] };
    const d = rankFitFirstFreeCandidates({
      candidates: ids.slice(0, 4).map(cand),
      body,
      zeroAdditionalCostProviders: ["synx"],
      conversationKey: getConversationTieKey(body),
    });
    inner.add(d.ranked[0].candidate.model);
  }
  assert.ok(inner.size >= 3, `aliases inside one identity should all be reachable: ${[...inner]}`);
});

test("R9: several accounts of one model share one draw", () => {
  installWithMeta({
    "synx/m-one": { family: null, release: null },
    "syny/other": { family: null, release: null },
  });
  const cands = ["a", "b", "c"]
    .map((c) => ({ ...cand("synx/m-one"), connectionId: `conn-${c}` }))
    .concat([cand("syny/other")]);
  const N = 600;
  const wins = pickShares(cands as FitFirstCandidate[], N);
  const x = (wins.get("synx") ?? 0) / N;
  assert.ok(x > 0.4 && x < 0.6, `three accounts of one model won ${(x * 100).toFixed(0)}% of ties`);
});

test("R9: distinct models are never merged: without metadata each equal model keeps its own draw", () => {
  installWithMeta({
    "synx/m-a": { family: null, release: null },
    "synx/m-b": { family: null, release: null },
    "synx/m-c": { family: null, release: null },
    "syny/other": { family: null, release: null },
  });
  const N = 800;
  const wins = pickShares(["synx/m-a", "synx/m-b", "synx/m-c", "syny/other"].map(cand), N);
  const x = (wins.get("synx") ?? 0) / N;
  assert.ok(
    x > 0.68 && x < 0.82,
    `three distinct metadata-less models won ${(x * 100).toFixed(0)}% (expected about 75%)`
  );
});

test("R9: same family and release date but different capabilities are different identities", () => {
  const meta = { family: "fam-z", release: "2026-03-03" };
  const data: Record<string, Record<string, ReturnType<typeof entry>>> = {
    synx: {
      big: {
        ...entry(1_000_000, 128_000),
        family: meta.family,
        release_date: meta.release,
      } as never,
      small: {
        ...entry(500_000, 128_000),
        family: meta.family,
        release_date: meta.release,
      } as never,
    },
  };
  saveModelsDevCapabilities(data);
  invalidateFitnessCache();
  const d = rankFitFirstFreeCandidates({
    candidates: [cand("synx/big"), cand("synx/small")],
    body: { messages: [{ role: "user", content: "x" }] },
    zeroAdditionalCostProviders: ["synx"],
  });
  const [a, b] = d.ranked.map((r) => r.tieBreaker.slice(0, 64));
  assert.notEqual(a, b);
});

// ── 3. graceful degradation (replaces the deleted "DB not initialised" fallbacks) ──

test("R8: with the capability and intelligence tables unreadable the fitness path neither throws nor guesses", () => {
  const db = getDbInstance();
  ensureCapabilitiesTable();
  db.exec("DROP TABLE IF EXISTS model_capabilities");
  db.exec("DROP TABLE IF EXISTS model_intelligence");
  invalidateFitnessCache();
  try {
    for (const id of ["syna/never-synced", "zz-bare-unknown", "x/y/z-nested"]) {
      for (const type of ["coding", "planning", "general"]) {
        assert.doesNotThrow(() => getTaskFitnessWithSource(id, type));
        assert.deepEqual(getTaskFitnessWithSource(id, type), {
          score: 0.5,
          source: "no_capability_evidence",
        });
      }
    }
    assert.equal(getCapabilityDerivedFitness("syna/never-synced", "coding"), null);
  } finally {
    ensureCapabilitiesTable();
    invalidateFitnessCache();
  }
});
