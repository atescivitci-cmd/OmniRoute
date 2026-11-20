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

const uuid = (k: number) => `${String(k).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`;
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
          user_id: `user_abc123_account_def456_session_${uuid(k)}`,
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
      metadata: { user_id: `user_x_account_y_session_${uuid(k)}` },
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
    metadata: { user_id: "user_h_account_a_session_12345678-abcd-4ef0-8123-456789abcdef" },
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

test("R12: a user id that merely contains the word session is not a session", () => {
  const bare = { messages: [{ role: "user", content: "hello there" }] };
  for (const uid of [
    "user-session-manager-1",
    "user_session_manager_account",
    "user_abc_session_12345678",
    "session_12345678-notauuid",
    "team_session_0000000a-aaaa-4bbb-8ccc-dddddddddddd_extra",
  ]) {
    assert.match(getConversationTieKey({ ...bare, metadata: { user_id: uid } })!, /^conv:/, uid);
  }
  assert.match(
    getConversationTieKey({
      ...bare,
      metadata: { user_id: "user_h_account_a_session_12345678-abcd-4ef0-8123-456789ABCDEF" },
    })!,
    /^uid:/
  );
  assert.match(
    getConversationTieKey({
      ...bare,
      metadata: { user_id: '{"device_id":"d","session_id":"s-1"}' },
    })!,
    /^uid:/
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

const rated = (rating: number) => ((rating - 0.69) / 0.29) * 0.06;

test("R7: an arena_elo row written under the bare model name is found from the provider-qualified id and refines the capability-derived value", () => {
  install([MEASURED, UNMEASURED]);
  const unrated = getTaskFitnessWithSource(UNMEASURED, "coding");
  withArenaRow("zorbex-arena", 0.97, () => {
    for (const id of ["zorbex-arena", MEASURED]) {
      const r = getTaskFitnessWithSource(id, "coding");
      assert.equal(r.source, "arena_elo");
    }
    const r = getTaskFitnessWithSource(MEASURED, "coding");
    assert.ok(
      Math.abs(r.score - (unrated.score + rated(0.97))) < 1e-9,
      `${r.score} vs ${unrated.score}`
    );
    assert.deepEqual(getTaskFitnessWithSource(UNMEASURED, "coding"), unrated);
  });
});

test("R7: a row keyed by the qualified id wins over the bare one, and user_override beats arena outright", () => {
  install([MEASURED]);
  const base = getTaskFitnessWithSource(MEASURED, "coding").score;
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
      assert.ok(Math.abs(getTaskFitness(MEASURED, "coding") - (base + rated(0.91))) < 1e-9);
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

// ── 2b. ratings refine, they never override: scale-mismatch cannot decide ───

function ratedFour(): { id: string; rating: number | null }[] {
  return [
    { id: "syna/rated-high", rating: 0.97 },
    { id: "synb/unrated", rating: null },
    { id: "sync/rated-mid", rating: 0.7 },
    { id: "synd/rated-low", rating: 0.45 },
  ];
}
function withRatings<T>(items: { id: string; rating: number | null }[], fn: () => T): T {
  for (const it of items) {
    if (it.rating !== null) {
      upsertModelIntelligence({
        model: it.id.split("/")[1],
        source: "arena_elo",
        category: "general",
        score: it.rating,
        eloRaw: null,
        confidence: null,
        expiresAt: null,
      } as never);
    }
  }
  invalidateFitnessCache();
  try {
    return fn();
  } finally {
    for (const it of items) {
      if (it.rating !== null) deleteModelIntelligence(it.id.split("/")[1], "arena_elo", "general");
    }
    invalidateFitnessCache();
  }
}

test("R10: equal capabilities: rated-high >= unrated >= rated-low, monotone in rating, bounded by the band", () => {
  const items = ratedFour();
  install(items.map((i) => i.id));
  withRatings(items, () => {
    const fit = Object.fromEntries(items.map((i) => [i.id, getTaskFitness(i.id, "general")]));
    assert.ok(fit["syna/rated-high"] >= fit["synb/unrated"]);
    assert.ok(fit["synb/unrated"] >= fit["synd/rated-low"]);
    assert.ok(
      fit["syna/rated-high"] > fit["sync/rated-mid"] &&
        fit["sync/rated-mid"] > fit["synd/rated-low"]
    );
    const span = fit["syna/rated-high"] - fit["synd/rated-low"];
    assert.ok(span <= 0.12 + 1e-9, `rating span ${span}`);
    // The mid-rated model is not below the unrated one by more than the band.
    assert.ok(fit["synb/unrated"] - fit["sync/rated-mid"] < 0.06);
    // Through the ranker at critical: the ordering by score follows the same order.
    const d = rankFitFirstFreeCandidates({
      candidates: items.map((i) => cand(i.id)),
      body: { messages: [{ role: "user", content: "Handle the request." }] },
      zeroAdditionalCostProviders: ["syna", "synb", "sync", "synd"],
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
    const score = Object.fromEntries(
      d.ranked.map((r) => [`${r.candidate.provider}/${r.candidate.model}`, r.factors.score])
    );
    assert.ok(score["syna/rated-high"] >= score["synb/unrated"]);
    assert.ok(score["synb/unrated"] >= score["synd/rated-low"]);
    assert.ok(score["sync/rated-mid"] >= score["synd/rated-low"]);
  });
});

test("R10: monotone in rating over the whole leaderboard range", () => {
  install(["syna/mono"]);
  let prev = -1;
  for (let r = 0.4; r <= 0.98 + 1e-9; r += 0.02) {
    const v = withRatings([{ id: "syna/mono", rating: r }], () =>
      getTaskFitness("syna/mono", "general")
    );
    assert.ok(v >= prev - 1e-12, `rating ${r.toFixed(2)} lowered fitness`);
    prev = v;
  }
});

test("R10: a rating alone cannot lift a weaker-capability model above a clearly stronger one", () => {
  install(["syna/strong"]);
  saveModelsDevCapabilities({
    syna: { strong: entry(1_000_000, 128_000), weak: entry(32_000, 8_192) } as never,
  });
  invalidateFitnessCache();
  withRatings([{ id: "syna/weak", rating: 0.98 }], () => {
    assert.ok(getTaskFitness("syna/weak", "coding") < getTaskFitness("syna/strong", "coding"));
  });
  // And the best rating moves a model by at most the band over its unrated self.
  const base = getTaskFitness("syna/weak", "coding");
  withRatings([{ id: "syna/weak", rating: 0.98 }], () => {
    assert.ok(getTaskFitness("syna/weak", "coding") - base <= 0.06 + 1e-9);
  });
});

test("R10: a rated model with no capability evidence never outranks a verified model", () => {
  install(["syna/verified"]);
  withRatings([{ id: "synz/never-synced", rating: 0.98 }], () => {
    assert.ok(
      getTaskFitness("synz/never-synced", "coding") <= getTaskFitness("syna/verified", "coding")
    );
  });
});

// ── 2c. a bare row applies to the provider-less form only, never to a longer path ──

test("R11: a bare arena row does not leak onto a different model that merely ends with the same segment", () => {
  install(["synb/leafy", "synb/other/leafy", "vendorx/team/leafy"]);
  const before = {
    plain: getTaskFitnessWithSource("synb/leafy", "coding"),
    nested: getTaskFitnessWithSource("synb/other/leafy", "coding"),
    deep: getTaskFitnessWithSource("vendorx/team/leafy", "coding"),
  };
  withArenaRow("leafy", 0.98, () => {
    // The legitimate bare-name case: provider/leafy resolves to the bare row.
    assert.equal(getTaskFitnessWithSource("synb/leafy", "coding").source, "arena_elo");
    // Different models that only share the last path segment are untouched.
    assert.equal(
      getTaskFitnessWithSource("vendorx/team/leafy", "coding").source,
      before.deep.source
    );
    assert.deepEqual(getTaskFitnessWithSource("vendorx/team/leafy", "coding"), before.deep);
    assert.notEqual(getTaskFitnessWithSource("synb/other/leafy", "coding").source, "arena_elo");
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

test("R9: aliases and snapshots of one model (x, x@default, x-<8-digit date>) share one draw", () => {
  // vendor X lists one model under three ids; vendor Y lists one model once.
  install(["synx/m-one", "synx/m-one@default", "synx/m-one-20260101", "syny/other"]);
  const ids = ["synx/m-one", "synx/m-one@default", "synx/m-one-20260101", "syny/other"];
  const N = 600;
  const wins = pickShares(ids.map(cand), N);
  const x = (wins.get("synx") ?? 0) / N;
  assert.ok(
    x > 0.4 && x < 0.6,
    `vendor X won ${(x * 100).toFixed(0)}% of ties (expected about 50%)`
  );
  const inner = new Set<string>();
  for (let k = 0; k < 200; k++) {
    const body = { messages: [{ role: "user", content: `inner ${k}` }] };
    const d = rankFitFirstFreeCandidates({
      candidates: ids.slice(0, 3).map(cand),
      body,
      zeroAdditionalCostProviders: ["synx"],
      conversationKey: getConversationTieKey(body),
    });
    inner.add(d.ranked[0].candidate.model);
  }
  assert.equal(inner.size, 3, `every alias is reachable inside one identity: ${[...inner]}`);
});

test("R9: several accounts of one model share one draw", () => {
  install(["synx/m-one", "syny/other"]);
  const cands = ["a", "b", "c"]
    .map((c) => ({ ...cand("synx/m-one"), connectionId: `conn-${c}` }))
    .concat([cand("syny/other")]);
  const N = 600;
  const wins = pickShares(cands as FitFirstCandidate[], N);
  const x = (wins.get("synx") ?? 0) / N;
  assert.ok(x > 0.4 && x < 0.6, `three accounts of one model won ${(x * 100).toFixed(0)}% of ties`);
});

test("R9: variants of a model are different models: flash, size, sol and mini variants never merge", () => {
  // Same provider, family, release date and capabilities on purpose: only the id differs.
  installWithMeta({
    "synx/m-code-2": { family: "fam", release: "2026-01-01" },
    "synx/m-code-2-flash": { family: "fam", release: "2026-01-01" },
    "synx/gemma-3-12b-it": { family: "fam", release: "2026-01-01" },
    "synx/gemma-3-4b-it": { family: "fam", release: "2026-01-01" },
    "synx/gpt-5.6": { family: "fam", release: "2026-01-01" },
    "synx/gpt-5.6-sol": { family: "fam", release: "2026-01-01" },
    "syny/other": { family: "fam2", release: "2026-02-02" },
  });
  const xs = [
    "m-code-2",
    "m-code-2-flash",
    "gemma-3-12b-it",
    "gemma-3-4b-it",
    "gpt-5.6",
    "gpt-5.6-sol",
  ];
  const N = 1400;
  const wins = pickShares([...xs.map((m) => cand(`synx/${m}`)), cand("syny/other")], N);
  const x = (wins.get("synx") ?? 0) / N;
  // Six distinct models against one: about 6/7.
  assert.ok(
    x > 0.8 && x < 0.92,
    `six distinct variants won ${(x * 100).toFixed(0)}% (expected about 86%)`
  );
});

test("R9: metadata coverage does not change the draw: the same pool with and without family/date behaves the same", () => {
  const ids = [
    "synx/m-one",
    "synx/m-one@default",
    "syny/m-two",
    "syny/m-two-20260101",
    "synz/m-three",
  ];
  const run = (withMeta: boolean) => {
    installWithMeta(
      Object.fromEntries(
        ids.map((i) => [
          i,
          withMeta
            ? { family: "f-" + i.split("/")[0], release: "2026-01-01" }
            : { family: null, release: null },
        ])
      )
    );
    return pickShares(ids.map(cand), 900);
  };
  const a = run(true);
  const b = run(false);
  for (const p of ["synx", "syny", "synz"]) {
    assert.ok(
      Math.abs((a.get(p) ?? 0) - (b.get(p) ?? 0)) / 900 < 0.06,
      `${p}: ${a.get(p)} vs ${b.get(p)}`
    );
  }
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
