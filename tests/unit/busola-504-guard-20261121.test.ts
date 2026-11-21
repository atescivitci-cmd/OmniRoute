/**
 * The Busola-504 guard (scripts/verify_busola_504_fixes.sh) must accept the two valid forms of
 * "Fix 1" (a failing model never gets health 1.0) and must refuse everything else.
 *
 * Form (a): the original confidence-gated condition (CONFIDENT_FAILURE_MIN_CONFIDENCE).
 * Form (b): the observed-rate successor, `observedHealthFactor` in fitFirstPolicy.ts plus the
 *           `healthRule: "observed_rate"` marker in every decision (OmniRoute fork PR #42).
 *
 * These tests run the REAL guard script against copies of the REAL source files. The negative
 * tests mutate the copy so the health rule is weakened; the guard has to fail each of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  observedHealthFactor,
  rankFitFirstFreeCandidates,
} from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const GUARD = path.join(ROOT, "scripts", "verify_busola_504_fixes.sh");
const FF_REL = path.join("open-sse", "services", "autoCombo", "fitFirstPolicy.ts");
const CI_REL = path.join("open-sse", "executors", "claudeIdentity.ts");

function makeSourceTree(mutate?: (ff: string) => string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-src-"));
  for (const rel of [FF_REL, CI_REL]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    let text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (rel === FF_REL && mutate) text = mutate(text);
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function makeDistTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-dist-"));
  const build = path.join(dir, "dist", ".build");
  fs.mkdirSync(build, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(build, name), text);
  return dir;
}

function runGuard(...args: string[]) {
  const r = spawnSync("sh", [GUARD, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const ORIGINAL_FORM = `
  const CONFIDENT_FAILURE_MIN_CONFIDENCE = 0.5;
  const confidentlyFailing = operational.reason === "observed" && operational.confidence >= CONFIDENT_FAILURE_MIN_CONFIDENCE && operational.score < 0.5;
`;

test("source: the current fitFirstPolicy.ts (observed-rate successor) passes the guard", () => {
  const r = runGuard("--source", ROOT);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /observed-rate successor/);
});

test("source: the original CONFIDENT_FAILURE_MIN_CONFIDENCE form still passes", () => {
  const tree = makeSourceTree(
    (ff) =>
      // Pretend this is the old tree: no successor helper, the original condition present.
      ff
        .replace("export function observedHealthFactor", "function renamedAway")
        .replace(/healthRule: "observed_rate",\n/, "") + ORIGINAL_FORM
  );
  const r = runGuard("--source", tree);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /original form/);
});

test("source: a helper that returns 1.0 for a failing model is refused", () => {
  const tree = makeSourceTree((ff) =>
    ff.replace(/\? operational\.score\n\s*: 0\.5;/, "? 1\n    : 0.5;")
  );
  const r = runGuard("--source", tree);
  assert.notEqual(r.code, 0, "guard accepted a health rule that returns 1.0");
  assert.match(r.out, /Fix 1 missing/);
});

test("source: re-introducing a volume gate into the helper is refused", () => {
  const tree = makeSourceTree((ff) =>
    ff.replace(
      'return circuitBreakerState === "CLOSED" && operational.reason === "observed"',
      'return circuitBreakerState === "CLOSED" && operational.reason === "observed" && (operational as { sampleCount?: number }).sampleCount !== 0'
    )
  );
  const r = runGuard("--source", tree);
  assert.notEqual(r.code, 0, "guard accepted a modified health expression");
});

test("source: dropping the breaker condition from the helper is refused", () => {
  const tree = makeSourceTree((ff) =>
    ff.replace(
      'return circuitBreakerState === "CLOSED" && operational.reason === "observed"',
      'return operational.reason === "observed"'
    )
  );
  const r = runGuard("--source", tree);
  assert.notEqual(r.code, 0, "guard accepted a health rule without the breaker condition");
});

test("source: the helper existing but no longer used for the health factor is refused", () => {
  const tree = makeSourceTree((ff) =>
    ff.replace(
      "const health = observedHealthFactor(candidate.circuitBreakerState, operational);",
      "const health = 1;"
    )
  );
  const r = runGuard("--source", tree);
  assert.notEqual(r.code, 0, "guard accepted an unused helper (health hard-coded to 1)");
});

test("source: removing the runtime marker is refused", () => {
  const tree = makeSourceTree((ff) => ff.replace(/healthRule: "observed_rate",\n/, ""));
  const r = runGuard("--source", tree);
  assert.notEqual(r.code, 0, "guard accepted a build without the healthRule marker");
});

test("source: neither form present is refused", () => {
  const tree = makeSourceTree((ff) =>
    ff
      .replace("export function observedHealthFactor", "function renamedAway")
      .replace(/healthRule: "observed_rate",\n/, "")
  );
  const r = runGuard("--source", tree);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /neither CONFIDENT_FAILURE_MIN_CONFIDENCE/);
});

// --- compiled output ---------------------------------------------------------------------------

const NEW_DIST =
  'function h(e,t){return"CLOSED"===e&&"observed"===t.reason?t.score:.5}' +
  'let I=h(c.circuitBreakerState,v);const f={taskFitness:1,health:I,healthRule:"observed_rate",quota:1,reliabilitySampleCount:3};';

test("dist: observed-rate expression plus marker in one live file passes", () => {
  const dist = makeDistTree({ "ff.js": NEW_DIST });
  const r = runGuard("--dist", dist);
  assert.equal(r.code, 0, r.out);
});

test("dist: inlined expression and flipped operand order pass", () => {
  const inlined =
    'let health="CLOSED"===t.circuitBreakerState&&"observed"===v.reason?v.score:.5,x={health,healthRule:"observed_rate",reliabilitySampleCount:3};';
  const flipped =
    'let health=t.circuitBreakerState==="CLOSED"&&v.reason==="observed"?v.score:0.5,x={health,healthRule:"observed_rate",reliabilitySampleCount:3};';
  for (const code of [inlined, flipped]) {
    const r = runGuard("--dist", makeDistTree({ "ff.js": code }));
    assert.equal(r.code, 0, r.out);
  }
});

test("dist: the original compiled condition (confidence>=.5) still passes", () => {
  const dist = makeDistTree({ "ff.js": 'w="observed"===v.reason&&v.confidence>=.5&&v.score<.5' });
  const r = runGuard("--dist", dist);
  assert.equal(r.code, 0, r.out);
});

test("dist: marker without the expression is refused", () => {
  const dist = makeDistTree({ "ff.js": 'const f={healthRule:"observed_rate",health:1};' });
  const r = runGuard("--dist", dist);
  assert.notEqual(r.code, 0, "guard accepted a marker with no observed-rate expression");
});

test("dist: expression without the marker is refused", () => {
  const dist = makeDistTree({
    "ff.js": 'function h(e,t){return"CLOSED"===e&&"observed"===t.reason?t.score:.5}',
  });
  const r = runGuard("--dist", dist);
  assert.notEqual(r.code, 0, "guard accepted an expression with no runtime marker");
});

test("dist: a health rule that returns 1 for observed is refused", () => {
  const dist = makeDistTree({
    "ff.js":
      'function h(e,t){return"CLOSED"===e&&"observed"===t.reason?1:.5}x={healthRule:"observed_rate"};',
  });
  const r = runGuard("--dist", dist);
  assert.notEqual(r.code, 0, "guard accepted a health rule that returns 1.0");
});

test("dist: backups do not count as live code", () => {
  const dist = makeDistTree({ "ff.js.bak": NEW_DIST });
  const r = runGuard("--dist", dist);
  assert.notEqual(r.code, 0, "guard counted a .bak file");
});

test("dist: the marker and the expression must be in the same live file", () => {
  const dist = makeDistTree({
    "a.js": 'function h(e,t){return"CLOSED"===e&&"observed"===t.reason?t.score:.5}',
    "b.js": 'const f={healthRule:"observed_rate"};',
  });
  const r = runGuard("--dist", dist);
  assert.notEqual(r.code, 0, "guard accepted marker and expression from different files");
});

// --- the behaviour the guard protects ---------------------------------------------------------

test("behaviour: a failing model never gets health 1.0; health equals the observed rate", () => {
  for (const rate of [0, 0.1, 0.25, 0.49, 0.5, 0.51, 0.9, 0.99]) {
    const health = observedHealthFactor("CLOSED", { reason: "observed", score: rate });
    assert.equal(health, rate);
    assert.ok(health < 1, `rate ${rate} must not earn health 1.0`);
  }
  assert.equal(observedHealthFactor("CLOSED", { reason: "observed", score: 1 }), 1);
});

test("behaviour: an open or half-open breaker or no observation scores the neutral 0.5", () => {
  assert.equal(observedHealthFactor("OPEN", { reason: "observed", score: 1 }), 0.5);
  assert.equal(observedHealthFactor("HALF_OPEN", { reason: "observed", score: 0.2 }), 0.5);
  assert.equal(observedHealthFactor("CLOSED", { reason: "missing_or_stale", score: 0.5 }), 0.5);
  assert.equal(observedHealthFactor(undefined, { reason: "observed", score: 1 }), 0.5);
});

test("behaviour: every ranked decision records healthRule observed_rate", () => {
  const now = Date.now();
  const mk = (model: string, errorRate: number) => ({
    stepId: `s-${model}`,
    executionKey: `e-${model}`,
    modelStr: `p1/${model}`,
    provider: "p1",
    model,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 0,
    p95LatencyMs: 1000,
    latencyStdDev: 10,
    errorRate,
    failureRate: errorRate,
    provenance: {
      connectionFingerprint: "c",
      health: {
        source: "usage_24h",
        sampleCount: 20,
        windowHours: 24,
        latestObservationAt: null,
        evaluatedAt: new Date(now).toISOString(),
        errorClass: "unknown",
      },
      quota: { source: "unavailable", acquiredAt: new Date(now).toISOString(), measuredAt: null },
      capabilities: { source: "resolver_native_or_emulated_or_heuristic", verified: "unknown" },
    },
  });
  const decision = rankFitFirstFreeCandidates({
    candidates: [mk("m-good", 0), mk("m-bad", 0.6)] as never,
    body: { model: "x", messages: [{ role: "user", content: "hello" }] },
    zeroAdditionalCostProviders: ["p1"],
    now,
  });
  assert.ok(decision.ranked.length > 0, "expected ranked candidates");
  for (const r of decision.ranked) assert.equal(r.factors.healthRule, "observed_rate");
});

// --- regressions a text-only guard could be fooled by (found by the independent review) ---------

const HELPER_RE = /export function observedHealthFactor[\s\S]*?\n}\n/;
const CALL_LINE =
  "const health = observedHealthFactor(candidate.circuitBreakerState, operational);";

function mustRefuseSource(name: string, mutate: (ff: string) => string) {
  test(`source mutant refused: ${name}`, () => {
    const tree = makeSourceTree(mutate);
    const r = runGuard("--source", tree);
    assert.notEqual(r.code, 0, `guard accepted: ${name}\n${r.out}`);
  });
}

mustRefuseSource("correct helper parked in a block comment above a helper that returns 1", (ff) => {
  const original = ff.match(HELPER_RE)![0];
  const bad = ff.replace(/\? operational\.score\n\s*: 0\.5;/, "? 1 : 0.5;");
  return `/*\n${original}*/\n${bad}`;
});
mustRefuseSource("correct helper parked in a template literal above a bad helper", (ff) => {
  const original = ff.match(HELPER_RE)![0].replace(/`/g, "");
  const bad = ff.replace(/\? operational\.score\n\s*: 0\.5;/, "? 1 : 0.5;");
  return `const __decoy = \`\n${original}\`;\n${bad}`;
});
mustRefuseSource("early return 1 before the correct return", (ff) =>
  ff.replace(
    'return circuitBreakerState === "CLOSED"',
    'if (operational.score < 0.5) return 1;\n  return circuitBreakerState === "CLOSED"'
  )
);
mustRefuseSource("the call kept only in a comment while health is hard-coded", (ff) =>
  ff.replace(CALL_LINE, `// ${CALL_LINE}\n      const health = 1;`)
);
mustRefuseSource("the helper called but its result discarded", (ff) =>
  ff.replace(
    CALL_LINE,
    `observedHealthFactor(candidate.circuitBreakerState, operational);\n      const health = 1;`
  )
);
mustRefuseSource("the call fed a doctored operand", (ff) =>
  ff.replace(
    CALL_LINE,
    'const health = observedHealthFactor(candidate.circuitBreakerState, { reason: "observed", score: 1 });'
  )
);
mustRefuseSource("health reassigned after the call", (ff) =>
  ff.replace(
    CALL_LINE,
    `let health = observedHealthFactor(candidate.circuitBreakerState, operational);\n      health = 1;`
  )
);
mustRefuseSource("factors report health: 1 instead of the computed health", (ff) =>
  ff.replace(
    /health,\n(\s*)healthRule: "observed_rate",/,
    'health: 1,\n$1healthRule: "observed_rate",'
  )
);
mustRefuseSource("the score formula no longer uses the health factor", (ff) =>
  ff.replace("health * weights.health", "1 * weights.health")
);
mustRefuseSource("the runtime marker only in a comment", (ff) =>
  ff.replace(/healthRule: "observed_rate",\n/, '// healthRule: "observed_rate",\n')
);
mustRefuseSource(
  "the original form only mentioned in a comment, successor removed",
  (ff) =>
    ff
      .replace("export function observedHealthFactor", "function renamedAway")
      .replace(/healthRule: "observed_rate",\n/, "") +
    "\n// const CONFIDENT_FAILURE_MIN_CONFIDENCE = 0.5; confidence >= CONFIDENT_FAILURE_MIN_CONFIDENCE\n"
);

const FIXED_CHUNK =
  'function h(e,t){return"CLOSED"===e&&"observed"===t.reason?t.score:.5}let I=h(c.circuitBreakerState,v);' +
  'const f={taskFitness:1,health:I,healthRule:"observed_rate",quota:1,reliabilitySampleCount:3};';

test("dist: a fixed chunk next to a stale chunk with health 1 is refused (every copy must be fixed)", () => {
  const dist = makeDistTree({
    "a.js": FIXED_CHUNK,
    "b.js": "const f={taskFitness:1,health:1,quota:1,reliabilitySampleCount:3};",
  });
  const r = runGuard("--dist", dist);
  assert.notEqual(r.code, 0, `guard accepted a stale chunk\n${r.out}`);
  assert.match(r.out, /b\.js/);
});

test("dist: every fixed chunk passes together", () => {
  const dist = makeDistTree({ "a.js": FIXED_CHUNK, "b.js": FIXED_CHUNK, "c.mjs": FIXED_CHUNK });
  const r = runGuard("--dist", dist);
  assert.equal(r.code, 0, r.out);
});

test("dist: a text file carrying the marker and the expression does not count", () => {
  const dist = makeDistTree({ "NOTES.txt": FIXED_CHUNK });
  const r = runGuard("--dist", dist);
  assert.notEqual(r.code, 0, "guard counted a non-JS file");
});

test("dist: the rule present but never applied to the breaker state is refused", () => {
  const dist = makeDistTree({
    "a.js":
      'function h(e,t){return"CLOSED"===e&&"observed"===t.reason?t.score:.5}let I=1;' +
      'const f={health:I,healthRule:"observed_rate",reliabilitySampleCount:3};',
  });
  const r = runGuard("--dist", dist);
  assert.notEqual(r.code, 0, "guard accepted a decoy function that is never called");
});

test("dist: the marker not adjacent to the health property is refused", () => {
  const dist = makeDistTree({
    "a.js":
      'function h(e,t){return"CLOSED"===e&&"observed"===t.reason?t.score:.5}let I=h(c.circuitBreakerState,v);' +
      'const f={healthRule:"observed_rate",quota:1,health:1,reliabilitySampleCount:3};',
  });
  const r = runGuard("--dist", dist);
  assert.notEqual(r.code, 0, "guard accepted a marker detached from the health property");
});

// --- the real compiled form (found by the first installer dry-run of the merged tip) ----------------
// Next/SWC inlines observedHealthFactor as a comma expression with a temp for the parameter. This is
// the text the real build printed (chunk _1uosndd, 2026-11-21), quoted verbatim around the marker.
const SWC_INLINE =
  'v=P.get(t),w=(o=t.circuitBreakerState,"CLOSED"===o&&"observed"===v.reason?v.score:.5),C=(0,h.quotaRankingFactor)(t),k=v.score;' +
  'return{candidate:t,factors:{taskFitness:f.score,taskFitnessSource:f.source,complexityFit:b,health:w,healthRule:"observed_rate",quota:C,reliability:k,reliabilityConfidence:v.confidence,reliabilitySampleCount:v.sampleCount}};';

test("dist: the real SWC output (temp variable assigned from the breaker state) passes", () => {
  const r = runGuard("--dist", makeDistTree({ "chunk.js": SWC_INLINE }));
  assert.equal(r.code, 0, r.out);
});

test("dist: the SWC inline form with a result of 1 is refused", () => {
  const code = SWC_INLINE.replace("?v.score:.5)", "?1:.5)");
  const r = runGuard("--dist", makeDistTree({ "chunk.js": code }));
  assert.notEqual(r.code, 0, "guard accepted a health rule that returns 1 in the SWC inline form");
});

test("dist: the SWC inline form fed from another property than the breaker state is refused", () => {
  const code = SWC_INLINE.replace("o=t.circuitBreakerState", "o=t.provider");
  const r = runGuard("--dist", makeDistTree({ "chunk.js": code }));
  assert.notEqual(r.code, 0, "guard accepted a rule that is not applied to the breaker state");
});

test("dist: the SWC inline form without the observed condition is refused", () => {
  const code = SWC_INLINE.replace('&&"observed"===v.reason', "");
  const r = runGuard("--dist", makeDistTree({ "chunk.js": code }));
  assert.notEqual(r.code, 0, "guard accepted a rule without the observed condition");
});

test("dist: two chunks, one real SWC form and one stale chunk, are refused", () => {
  const stale = "const f={health:1,quota:1,reliabilitySampleCount:3};";
  const r = runGuard("--dist", makeDistTree({ "a.js": SWC_INLINE, "b.js": stale }));
  assert.notEqual(r.code, 0, "guard accepted a stale chunk next to a good one");
});
