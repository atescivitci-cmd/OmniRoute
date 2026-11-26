/**
 * Per-attempt "no first byte" deadline for a combo attempt whose upstream call streams
 * (ROUTING_STALL_DEADLINE_MS, default off; recommended value when enabled: 120000).
 *
 * Live 2026-11-26: a model that never answered (nvidia/z-ai/glm-5.3-flash) held each combo
 * request until the client gave up at 140 s. Nothing before that could fire: the combo per-target
 * headers timeout is 310 s while combo cooldown-wait is on (max(120 s, wait budget + 10 s)), the
 * upstream start timeout is FETCH_TIMEOUT_MS (600 s), and stream readiness (80 s, adaptive up to
 * 180 s) only starts once response headers exist. The client's abort then wrote no usage row for
 * the model at all, so the "broken right now" guard never saw the stall.
 *
 * With the flag set, the deadline counts from dispatch (after any local queue or semaphore wait):
 *   - Headers phase: no response headers by the deadline aborts the attempt.
 *   - First-event phase: stream readiness waits max(its own adaptive timeout, what is left of the
 *     deadline). The deadline never shortens what readiness already grants; it only extends the
 *     wait to the deadline when readiness alone would give up earlier, and labels the timeout
 *     upstream_stalled when the deadline was the binding bound.
 * A stall writes a per-model 504 `upstream_stalled` row and returns a JSON 504 to the combo.
 * Nothing has reached the client at that point: chatCore holds the response until stream
 * readiness confirms the first event. Whether the combo then fails over is decided by the
 * routing replay-safety guard, unchanged here.
 *
 * Why 120 s and not lower: live nvidia/mistralai/mistral-large-4-1t-a52b on /v1/messages had
 * successful answers with tiny outputs after 73 s and 285 s, so first-token time itself can be
 * that long; usage_history.ttft_ms cannot settle it (it equals latency_ms for streams).
 *
 * Deliberately NOT applied to an upstream call that does not stream, nor to a stream:true call
 * that the upstream answered with a JSON body. Those legitimately send nothing until the whole
 * generation is done (real non-streaming generations of 60 to 285 s exist), so "no first byte
 * yet" is no evidence of a stall. They keep today's timeouts.
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
   * Response headers arrived. The headers timer stops. Pass `awaitFirstEvent` only when the
   * caller will next wait for the first SSE event (stream readiness); otherwise (a JSON body, or
   * a body drained server-side) the watch is finished for this attempt.
   */
  markHeaders: (awaitFirstEvent: boolean) => void;
  /** The first non-ping event arrived. Returns ms from dispatch to it, or null when not watched. */
  markFirstEvent: () => number | null;
  /** The attempt ended without a response (it threw): stop the timer, close the phase. */
  endAttempt: () => void;
  /**
   * Budget for the first event in ms: what is left of the deadline (at least 1), or Infinity when
   * no first-event phase is open.
   */
  remainingMs: (now?: number) => number;
  dispose: () => void;
};

const DISABLED_WATCH: UpstreamStallWatch = {
  enabled: false,
  deadlineMs: 0,
  beginAttempt: () => null,
  markHeaders: () => {},
  markFirstEvent: () => null,
  endAttempt: () => {},
  remainingMs: () => Infinity,
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
      const watched = phase === "awaiting_first_event";
      phase = "done";
      return watched ? Date.now() - startedAt : null;
    },
    endAttempt() {
      clearTimer();
      phase = "done";
    },
    remainingMs(now = Date.now()) {
      if (phase !== "awaiting_first_event") return Infinity;
      return Math.max(1, startedAt + deadlineMs - now);
    },
    dispose() {
      clearTimer();
    },
  };
}

/**
 * The first-event wait under the stall deadline: never shorter than stream readiness's own
 * (adaptive) timeout, extended to the rest of the stall budget when that is longer. Reports which
 * bound is binding so a timeout is labelled by cause, not by clock comparison afterwards.
 */
export function resolveFirstEventWait(
  readinessTimeoutMs: number,
  stallRemainingMs: number
): { timeoutMs: number; stallBound: boolean } {
  if (!Number.isFinite(stallRemainingMs))
    return { timeoutMs: readinessTimeoutMs, stallBound: false };
  // readiness <= 0 means readiness is off; the stall budget alone then bounds the wait.
  if (readinessTimeoutMs <= 0) return { timeoutMs: stallRemainingMs, stallBound: true };
  return stallRemainingMs > readinessTimeoutMs
    ? { timeoutMs: stallRemainingMs, stallBound: true }
    : { timeoutMs: readinessTimeoutMs, stallBound: false };
}
