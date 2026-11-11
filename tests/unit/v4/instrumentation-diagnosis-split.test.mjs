// INSTRUMENTATION_DIAGNOSIS_SPLIT_V4 (2026-08-31)
//
// Incident: a macOS host with an existing, writable ~/.cache (atescivitci:staff, 755)
// was told to `mkdir -p ~/.cache` after a generic Next.js instrumentation-hook failure,
// while ServerSupervisor suppressed the real child exception. The operator chased a
// non-existent cache problem across two failed deployments; the actual boot error was
// never printed.
//
// Cause: isFatalInstrumentationHookFailure() is deliberately broad (so nothing is
// swallowed), but it was ALSO used to choose the advice. Detection and classification
// are now separate.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isFatalInstrumentationHookFailure,
  isAndroidCacheInstrumentationFailure,
  formatGenericInstrumentationFailureHint,
  formatAndroidInstrumentationFailureHint,
} from "../../../bin/cli/utils/ensureAndroidCacheDir.mjs";

const GENERIC = "Error: An error occurred while loading instrumentation hook";
const ANDROID = "Unsupported platform: android";

// --- 1. generic failure on darwin ---------------------------------------------------

test("1. generic instrumentation error on darwin is NOT classified as an Android cache failure", () => {
  assert.equal(isFatalInstrumentationHookFailure(GENERIC), true, "still detected");
  assert.equal(isAndroidCacheInstrumentationFailure(GENERIC, "darwin", {}), false);
});

test("1b. the darwin hint shows the ORIGINAL exception and gives no cache advice", () => {
  const out = formatGenericInstrumentationFailureHint(
    "Error: An error occurred while loading instrumentation hook\n  at boot (/x/y.js:1:1)"
  );
  assert.match(out, /at boot \(\/x\/y\.js:1:1\)/, "original child output must be visible");
  assert.doesNotMatch(out, /mkdir/i, "no mkdir command");
  assert.doesNotMatch(out, /\.cache/, "no cache advice");
  assert.doesNotMatch(out, /android|termux/i, "no Android/Termux diagnosis");
  assert.match(out, /--log/, "advises re-running with --log");
});

// --- 2. explicit android ------------------------------------------------------------

test("2. 'Unsupported platform: android' still gets Android cache advice, on any platform", () => {
  assert.equal(
    isAndroidCacheInstrumentationFailure(ANDROID, "darwin", {}),
    true,
    "Next.js said so explicitly -- authoritative"
  );
  assert.equal(isAndroidCacheInstrumentationFailure(ANDROID, "linux", {}), true);
  assert.match(formatAndroidInstrumentationFailureHint("/tmp/c"), /mkdir -p ~\/\.cache/);
});

// --- 3. termux on linux -------------------------------------------------------------

test("3. Termux-on-linux still gets Android cache advice for a generic failure", () => {
  const termuxEnv = { PREFIX: "/data/data/com.termux/files/usr" };
  assert.equal(
    isAndroidCacheInstrumentationFailure(GENERIC, "linux", termuxEnv),
    true,
    "needsAndroidCacheDirPrep must still route Termux to the cache hint"
  );
});

test("3b. plain linux (not Termux) gets the generic path", () => {
  assert.equal(isAndroidCacheInstrumentationFailure(GENERIC, "linux", {}), false);
});

// --- 4. once-only guard -------------------------------------------------------------

test("4. the once-only reporting guard still holds, and does not discard the exception", async () => {
  const serve = await import("../../../bin/cli/commands/serve.mjs");
  serve.resetInstrumentationFailureHintForTests();
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    const first = serve.maybeReportInstrumentationHookFailure(GENERIC + "\n  at first()");
    const second = serve.maybeReportInstrumentationHookFailure(GENERIC + "\n  at second()");
    assert.equal(first, true, "first report prints");
    assert.equal(second, false, "second is suppressed by the guard");
  } finally {
    process.stderr.write = orig;
    serve.resetInstrumentationFailureHintForTests();
  }
  const out = chunks.join("");
  assert.match(out, /at first\(\)/, "the original exception is preserved, not discarded");
  assert.doesNotMatch(out, /mkdir/i, "and darwin still gets no cache advice");
});

// --- 5. non-matching text ------------------------------------------------------------

test("5. unrelated output is not treated as an instrumentation failure at all", () => {
  assert.equal(isFatalInstrumentationHookFailure("listening on 20128"), false);
  assert.equal(isAndroidCacheInstrumentationFailure("listening on 20128", "darwin", {}), false);
  assert.equal(isFatalInstrumentationHookFailure(""), false);
  assert.equal(isFatalInstrumentationHookFailure(null), false);
});
