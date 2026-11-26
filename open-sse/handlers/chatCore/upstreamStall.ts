/**
 * Per-attempt "no first byte" deadline for a combo attempt whose upstream call streams
 * (ROUTING_STALL_DEADLINE_MS, default off).
 *
 * Live 2026-11-26: a model that never answered (nvidia/z-ai/glm-5.3-flash) held each combo
 * request until the client gave up at 140 s. Nothing before that could fire: the combo per-target
 * headers timeout is 310 s while combo cooldown-wait is on (max(120 s, wait budget + 10 s)), the
 * upstream start timeout is FETCH_TIMEOUT_MS (600 s), and stream readiness (80 s) only starts once
 * response headers exist. The client's abort then wrote no usage row for the model at all (a
 * client abort is deliberately not a provider failure), so the "broken right now" guard never saw
 * the stall and the model stayed first in rotation.
 *
 * With the flag set, an attempt that streams upstream must produce its first non-ping SSE event
 * (headers plus first event) within the deadline, counted from the moment the attempt is
 * dispatched (after any local queue or semaphore wait). Otherwise the attempt is aborted, a
 * per-model usage row is written as 504 `upstream_stalled`, and the combo moves to the next
 * candidate. Nothing has reached the client at that point: chatCore holds the response until
 * stream readiness confirms the first event.
 *
 * Deliberately NOT applied to an upstream call that does not stream. A non-streaming upstream
 * legitimately sends nothing (not even headers, for most providers) until the whole generation is
 * done, and real non-streaming generations of 60 to 285 s exist, so "no first byte yet" is no
 * evidence of a stall there. Those attempts keep today's timeouts.
 */

export const UPSTREAM_STALLED_CODE = "upstream_stalled";
export const ROUTING_STALL_DEADLINE_ENV = "ROUTING_STALL_DEADLINE_MS";

/** The deadline in ms, or 0 (off) when unset, empty, zero, negative or not a number. */
export function resolveRoutingStallDeadlineMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[ROUTING_STALL_DEADLINE_ENV];
  if (raw == null || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  // setTimeout clamps anything above 2^31-1 to 1 ms; keep the value meaningful.
  return Math.min(Math.floor(parsed), 2_147_483_647);
}

// Only errors created here are trusted as a stall, by identity: an upstream error whose name or
// message merely reads like one must not be relabelled a model stall.
const trustedStallErrors = new WeakSet<object>();

export function createUpstreamStalledError(
  deadlineMs: number,
  provider: string,
  model: string
): Error & { code: string; status: number } {
  const err = new Error(
    `Upstream produced no response within ${deadlineMs}ms (${provider}/${model})`
  ) as Error & { code: string; status: number };
  // TimeoutError, not AbortError: the request was not cancelled by the client.
  err.name = "TimeoutError";
  err.code = UPSTREAM_STALLED_CODE;
  err.status = 504;
  trustedStallErrors.add(err);
  return err;
}

export function isUpstreamStalledError(error: unknown): boolean {
  return error !== null && typeof error === "object" && trustedStallErrors.has(error);
}

/** The JSON error response a stalled attempt returns to the combo layer. */
export function createUpstreamStalledResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "stream_timeout", code: UPSTREAM_STALLED_CODE },
    }),
    { status: 504, headers: { "Content-Type": "application/json" } }
  );
}

type StallPhase = "idle" | "awaiting_headers" | "awaiting_first_event" | "done";

export type UpstreamStallWatch = {
  readonly enabled: boolean;
  readonly deadlineMs: number;
  /**
   * Start one upstream attempt. Returns a signal that aborts with a trusted stall error when the
   * attempt has not received response headers by the deadline, or null when the watch is off.
   */
  beginAttempt: () => AbortSignal | null;
  /**
   * Response headers arrived. The headers timer stops; when the caller will next wait for the
   * first stream event (stream readiness) it passes `awaitFirstEvent` and spends the rest of the
   * budget there. Otherwise (the body is drained server-side) the watch is finished.
   */
  markHeaders: (awaitFirstEvent: boolean) => void;
  /** The first non-ping event arrived: the attempt is not stalled. */
  markFirstEvent: () => void;
  /**
   * The attempt ended without a response (it threw). Stops the timer and freezes whether it was
   * already overdue, so the handler that maps the error can still read `isOverdue()`.
   */
  endAttempt: () => void;
  /** Budget left for the first event, in ms (at least 1 while a phase is open). */
  remainingMs: (now?: number) => number;
  /**
   * True while an attempt is still waiting for headers or its first event and has been waiting
   * for at least the deadline. A client that disconnects at that point left because the model
   * stalled, so the model's row says so instead of `client_disconnected`.
   */
  isOverdue: (now?: number) => boolean;
  dispose: () => void;
};

const DISABLED_WATCH: UpstreamStallWatch = {
  enabled: false,
  deadlineMs: 0,
  beginAttempt: () => null,
  markHeaders: () => {},
  markFirstEvent: () => {},
  endAttempt: () => {},
  remainingMs: () => Infinity,
  isOverdue: () => false,
  dispose: () => {},
};

export function createUpstreamStallWatch(options: {
  deadlineMs: number;
  provider: string;
  model: string;
  log?: { warn?: (tag: string, message: string) => void } | null;
}): UpstreamStallWatch {
  const deadlineMs = Math.floor(options.deadlineMs);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return DISABLED_WATCH;

  let phase: StallPhase = "idle";
  let startedAt = 0;
  // Whether the last attempt that ended without a response had already waited past the deadline.
  let endedOverdue = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    enabled: true,
    deadlineMs,
    beginAttempt() {
      clearTimer();
      phase = "awaiting_headers";
      startedAt = Date.now();
      endedOverdue = false;
      const controller = new AbortController();
      timer = setTimeout(() => {
        timer = null;
        if (phase !== "awaiting_headers") return;
        const error = createUpstreamStalledError(deadlineMs, options.provider, options.model);
        options.log?.warn?.("STALL", `${error.message}; aborting this attempt`);
        controller.abort(error);
      }, deadlineMs);
      // A pending stall timer must never keep an otherwise exiting process alive.
      timer.unref?.();
      return controller.signal;
    },
    markHeaders(awaitFirstEvent) {
      clearTimer();
      if (phase !== "awaiting_headers") return;
      phase = awaitFirstEvent ? "awaiting_first_event" : "done";
    },
    markFirstEvent() {
      clearTimer();
      phase = "done";
      endedOverdue = false;
    },
    endAttempt() {
      clearTimer();
      if (phase !== "awaiting_headers" && phase !== "awaiting_first_event") return;
      endedOverdue = Date.now() - startedAt >= deadlineMs;
      phase = "done";
    },
    remainingMs(now = Date.now()) {
      if (phase === "idle" || phase === "done") return Infinity;
      return Math.max(1, startedAt + deadlineMs - now);
    },
    isOverdue(now = Date.now()) {
      if (phase !== "awaiting_headers" && phase !== "awaiting_first_event") return endedOverdue;
      return now - startedAt >= deadlineMs;
    },
    dispose() {
      clearTimer();
    },
  };
}
