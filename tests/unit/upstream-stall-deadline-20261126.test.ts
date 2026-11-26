/**
 * ROUTING_STALL_DEADLINE_MS unit coverage: flag parsing, the per-attempt stall watch, the trusted
 * stall error, the combo predicate, and that an upstream_stalled usage row counts as a real model
 * failure for the quality-first "broken right now" guard. The production request path is covered
 * end to end in combo-stall-deadline-e2e-20261126.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  UPSTREAM_STALLED_CODE,
  createUpstreamStallWatch,
  createUpstreamStalledError,
  createUpstreamStalledResponse,
  isUpstreamStalledError,
  resolveRoutingStallDeadlineMs,
} from "../../open-sse/handlers/chatCore/upstreamStall.ts";
import {
  BROKEN_NOW_MIN_FAILURES,
  brokenNowFor,
  countRecentRealFailures,
  isRealModelFailure,
} from "../../open-sse/services/autoCombo/qualityFirst.ts";
import {
  isStreamReadinessFailureErrorBody,
  shouldRecordProviderBreakerFailure,
} from "../../open-sse/services/combo/comboPredicates.ts";
import { isLocalStreamLifecycleError } from "../../src/shared/utils/circuitBreaker.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("flag parsing: unset, empty, zero, negative and junk are off; a positive number is the deadline", () => {
  assert.equal(resolveRoutingStallDeadlineMs({}), 0);
  assert.equal(resolveRoutingStallDeadlineMs({ ROUTING_STALL_DEADLINE_MS: "" }), 0);
  assert.equal(resolveRoutingStallDeadlineMs({ ROUTING_STALL_DEADLINE_MS: "  " }), 0);
  assert.equal(resolveRoutingStallDeadlineMs({ ROUTING_STALL_DEADLINE_MS: "0" }), 0);
  assert.equal(resolveRoutingStallDeadlineMs({ ROUTING_STALL_DEADLINE_MS: "-5" }), 0);
  assert.equal(resolveRoutingStallDeadlineMs({ ROUTING_STALL_DEADLINE_MS: "soon" }), 0);
  assert.equal(resolveRoutingStallDeadlineMs({ ROUTING_STALL_DEADLINE_MS: "60000" }), 60000);
  assert.equal(resolveRoutingStallDeadlineMs({ ROUTING_STALL_DEADLINE_MS: "1500.9" }), 1500);
  assert.equal(
    resolveRoutingStallDeadlineMs({ ROUTING_STALL_DEADLINE_MS: "1e12" }),
    2_147_483_647,
    "clamped to the largest timer setTimeout honours"
  );
});

test("a disabled watch never aborts, never reports overdue, and leaves readiness budget unlimited", () => {
  const watch = createUpstreamStallWatch({ deadlineMs: 0, provider: "p", model: "m" });
  assert.equal(watch.enabled, false);
  assert.equal(watch.beginAttempt(), null);
  watch.markHeaders(true);
  assert.equal(watch.remainingMs(), Infinity);
  assert.equal(watch.isOverdue(Date.now() + 10 ** 9), false);
  watch.endAttempt();
  assert.equal(watch.isOverdue(Date.now() + 10 ** 9), false);
});

test("the attempt signal aborts at the deadline with a trusted stall error when no headers arrive", async () => {
  const watch = createUpstreamStallWatch({ deadlineMs: 40, provider: "nvidia", model: "glm" });
  const signal = watch.beginAttempt()!;
  assert.equal(signal.aborted, false);
  await sleep(80);
  assert.equal(signal.aborted, true);
  assert.ok(isUpstreamStalledError(signal.reason));
  assert.equal((signal.reason as { code: string }).code, UPSTREAM_STALLED_CODE);
  assert.equal((signal.reason as { status: number }).status, 504);
  assert.equal((signal.reason as Error).name, "TimeoutError");
  assert.match((signal.reason as Error).message, /nvidia\/glm/);
  assert.equal(watch.isOverdue(), true);
  watch.dispose();
});

test("headers before the deadline stop the timer; the first-event phase spends the rest of the budget", async () => {
  const watch = createUpstreamStallWatch({ deadlineMs: 60, provider: "p", model: "m" });
  const signal = watch.beginAttempt()!;
  await sleep(20);
  watch.markHeaders(true);
  const remaining = watch.remainingMs();
  assert.ok(remaining > 0 && remaining <= 40, `remaining ${remaining}`);
  await sleep(80);
  assert.equal(signal.aborted, false, "the headers timer no longer fires");
  assert.equal(watch.isOverdue(), true, "no first event yet and past the deadline");
  assert.equal(watch.remainingMs(), 1, "budget never reads as 0 (0 would disable readiness)");
  watch.markFirstEvent();
  assert.equal(watch.isOverdue(), false);
  assert.equal(watch.remainingMs(), Infinity);
});

test("a body drained server-side (headers, no readiness wait) is not watched past the headers", async () => {
  const watch = createUpstreamStallWatch({ deadlineMs: 20, provider: "p", model: "m" });
  watch.beginAttempt();
  watch.markHeaders(false);
  await sleep(50);
  assert.equal(watch.isOverdue(), false);
});

test("a client that leaves an attempt already past the deadline is a stall; one that leaves earlier is not", async () => {
  const early = createUpstreamStallWatch({ deadlineMs: 200, provider: "p", model: "m" });
  early.beginAttempt();
  await sleep(10);
  early.endAttempt(); // the client abort reached the attempt before the deadline
  assert.equal(early.isOverdue(), false, "early leave stays a client disconnect");

  const late = createUpstreamStallWatch({ deadlineMs: 20, provider: "p", model: "m" });
  late.beginAttempt();
  late.markHeaders(true);
  await sleep(40);
  late.endAttempt(); // the client left while no first event had come
  assert.equal(late.isOverdue(), true, "the frozen outcome survives the attempt's end");

  // A model that was streaming normally when the client pressed Escape stays client_disconnected.
  const streaming = createUpstreamStallWatch({ deadlineMs: 20, provider: "p", model: "m" });
  streaming.beginAttempt();
  streaming.markHeaders(true);
  streaming.markFirstEvent();
  await sleep(40);
  streaming.endAttempt();
  assert.equal(streaming.isOverdue(), false);

  // A new attempt starts clean.
  late.beginAttempt();
  assert.equal(late.isOverdue(), false);
  late.dispose();
});

test("only errors the watch created are trusted as stalls", () => {
  assert.equal(isUpstreamStalledError(createUpstreamStalledError(10, "p", "m")), true);
  const lookalike = Object.assign(new Error("Upstream produced no response within 10ms"), {
    name: "TimeoutError",
    code: UPSTREAM_STALLED_CODE,
  });
  assert.equal(isUpstreamStalledError(lookalike), false);
  assert.equal(isUpstreamStalledError(null), false);
  assert.equal(isUpstreamStalledError(UPSTREAM_STALLED_CODE), false);
});

test("a stall is not mistaken for a client abort (that would map it to 499 and drop the row)", () => {
  assert.equal(isLocalStreamLifecycleError(createUpstreamStalledError(10, "p", "m")), false);
});

test("the stall response is a 504 JSON body carrying upstream_stalled", async () => {
  const response = createUpstreamStalledResponse("no answer");
  assert.equal(response.status, 504);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  const body = await response.json();
  assert.equal(body.error.code, UPSTREAM_STALLED_CODE);
  assert.equal(body.error.type, "stream_timeout");
});

test("combo: upstream_stalled is handled like a readiness stall only while the flag is on", () => {
  const body = { error: { code: UPSTREAM_STALLED_CODE } };
  const previous = process.env.ROUTING_STALL_DEADLINE_MS;
  try {
    delete process.env.ROUTING_STALL_DEADLINE_MS;
    assert.equal(isStreamReadinessFailureErrorBody(body), false, "flag off: unchanged");
    process.env.ROUTING_STALL_DEADLINE_MS = "60000";
    assert.equal(isStreamReadinessFailureErrorBody(body), true);
    // A readiness-class failure never trips the whole provider's breaker.
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: isStreamReadinessFailureErrorBody(body),
        status: 504,
        sameProviderNext: false,
      }),
      false
    );
    // Existing codes are untouched either way.
    assert.equal(
      isStreamReadinessFailureErrorBody({ error: { code: "STREAM_READINESS_TIMEOUT" } }),
      true
    );
  } finally {
    if (previous === undefined) delete process.env.ROUTING_STALL_DEADLINE_MS;
    else process.env.ROUTING_STALL_DEADLINE_MS = previous;
  }
});

test("quality-first: an upstream_stalled row is a real model failure, and three of them exclude the model", () => {
  const now = Date.parse("2026-11-26T14:30:00.000Z");
  const row = (minutesAgo: number, extra: Record<string, unknown> = {}) => ({
    provider: "nvidia",
    model: "z-ai/glm-5.3-flash",
    success: false,
    errorCode: UPSTREAM_STALLED_CODE,
    status: "504",
    source: null,
    timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
    ...extra,
  });
  assert.equal(isRealModelFailure(row(1)), true);
  // Contrast: what the live incident wrote (nothing per model) and what a client leaving writes.
  assert.equal(
    isRealModelFailure(row(1, { errorCode: "client_disconnected", status: "499" })),
    false
  );

  const counts = countRecentRealFailures([row(1), row(5), row(10)], { now });
  const failures = counts.get("nvidia/z-ai/glm-5.3-flash") ?? 0;
  assert.equal(failures, BROKEN_NOW_MIN_FAILURES);
  assert.deepEqual(
    brokenNowFor({ recentRealFailures: failures, modelLocked: false, providerCooldown: false }),
    { reason: "broken_now_recent_failures", recentRealFailures: 3, windowMinutes: 30 }
  );
});
