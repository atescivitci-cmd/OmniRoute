import { runWithNativeDeadline } from "../../utils/nativeDeadlineContext.ts";
import {
  routingFailure,
  inheritRoutingGuard,
  inheritRoutingResponseState,
} from "./routingAttemptSafety.ts";
import type { HandleSingleModel, SingleModelTarget, ComboLogger } from "./types.ts";

// Only errors emitted by this lifecycle wrapper carry trusted classification.
// Upstream exception names/prose cannot impersonate a local deadline or cancel.
const lifecycleBodyFailures = new WeakMap<object, { code: string; status: number }>();

/** Abort is best effort: a waiter timeout never proves provider nonexecution. */
export function buildTargetTimeoutRunner(deps: {
  handleSingleModel: HandleSingleModel;
  comboTargetTimeoutMs: number;
  deadlineMs?: number;
  deadlineEvidenceBudgetMs?: number;
  signal?: AbortSignal | null;
  log: ComboLogger;
}): HandleSingleModel {
  const run: HandleSingleModel = async (body, model, target?: SingleModelTarget) => {
    const parents = [
      ...new Set([deps.signal, target?.modelAbortSignal].filter(Boolean)),
    ] as AbortSignal[];
    parents.forEach((parent) => parent.throwIfAborted());
    const startedAt = Date.now();
    const remaining = deps.deadlineMs ? deps.deadlineMs - startedAt : Infinity;
    if (remaining <= 0) return routingFailure("routing_deadline", 504);
    const targetTimeoutMs = deps.comboTargetTimeoutMs > 0 ? deps.comboTargetTimeoutMs : Infinity;
    const headersExpireAt = startedAt + targetTimeoutMs;
    const sharedExpiresAt = deps.deadlineMs || Infinity;
    const controller = new AbortController();
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    let sharedTimer: ReturnType<typeof setTimeout> | undefined;
    let headersReceived = false;
    let finished = false;
    let stopped: Response | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
    let resolveStop: (response: Response) => void;
    const wait = new Promise<Response>((resolve) => {
      resolveStop = resolve;
    });
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(headersTimer);
      clearTimeout(sharedTimer);
      parents.forEach((parent) => parent.removeEventListener("abort", onAbort));
    };
    const cancelReader = (reason?: unknown) => {
      // Upstream cancel can itself stall; local cleanup must not wait for it.
      try {
        void reader?.cancel(reason).catch(() => {});
      } catch {}
    };
    const stop = (code: string, status: number, reason?: unknown) => {
      if (finished) return;
      stopped = routingFailure(code, status);
      controller.abort(reason);
      cancelReader(reason);
      try {
        const failure = new DOMException(code, status === 499 ? "AbortError" : "TimeoutError");
        lifecycleBodyFailures.set(failure, { code, status });
        sink?.error(failure);
      } catch {}
      cleanup();
      resolveStop(stopped);
    };
    const onAbort = () =>
      stop("request_cancelled", 499, parents.find((parent) => parent.aborted)?.reason);
    parents.forEach((parent) => parent.addEventListener("abort", onAbort, { once: true }));
    if (parents.some((parent) => parent.aborted)) onAbort();
    const expire = (shared: boolean) => {
      if (finished || (!shared && headersReceived)) return;
      try {
        deps.log.warn("COMBO", "Routing deadline reached; execution outcome is uncertain");
      } catch {}
      stop(
        shared ? "routing_deadline" : "target_timeout_execution_uncertain",
        shared ? 504 : 524,
        new DOMException(shared ? "Combo deadline" : "Target headers deadline", "TimeoutError")
      );
    };
    if (!finished && Number.isFinite(targetTimeoutMs))
      headersTimer = setTimeout(() => expire(false), targetTimeoutMs);
    if (!finished && Number.isFinite(remaining))
      sharedTimer = setTimeout(() => expire(true), remaining);
    const check = () => {
      if (parents.some((parent) => parent.aborted)) onAbort();
      else if (!finished && Date.now() >= sharedExpiresAt) expire(true);
      else if (!finished && !headersReceived && Date.now() >= headersExpireAt) expire(false);
    };
    const work = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted();
        const response = await runWithNativeDeadline(
          deps.deadlineMs && deps.deadlineEvidenceBudgetMs
            ? { deadlineAt: deps.deadlineMs, declaredBudgetMs: deps.deadlineEvidenceBudgetMs }
            : undefined,
          () =>
            deps.handleSingleModel(body, model, {
              ...target,
              modelAbortSignal: controller.signal,
            })
        );
        check();
        if (finished) {
          void response.body?.cancel().catch(() => {});
          return stopped ?? routingFailure("execution_uncertain");
        }
        // Preserve the existing target budget: it bounds the awaited Response
        // (headers for streaming), not the subsequent stream generation time.
        headersReceived = true;
        clearTimeout(headersTimer);
        if (!response.body) {
          cleanup();
          return response;
        }
        reader = response.body.getReader();
        const stream = new ReadableStream<Uint8Array>(
          {
            start(value) {
              sink = value;
            },
            async pull(value) {
              if (finished) return;
              check();
              if (finished) return;
              try {
                const chunk = await reader!.read();
                check();
                if (finished) return;
                if (chunk.done) {
                  value.close();
                  cleanup();
                  reader!.releaseLock();
                } else value.enqueue(chunk.value);
              } catch (error) {
                if (finished) return;
                const lifecycleFailure =
                  error && typeof error === "object" ? lifecycleBodyFailures.get(error) : undefined;
                if (lifecycleFailure) {
                  stop(lifecycleFailure.code, lifecycleFailure.status, error);
                  return;
                }
                check();
                if (finished) return;
                controller.abort(error);
                cancelReader(error);
                cleanup();
                value.error(new DOMException("Upstream response body failed", "NetworkError"));
              }
            },
            cancel(reason) {
              if (!finished) {
                controller.abort(reason);
                cancelReader(reason);
                cleanup();
              }
            },
          },
          { highWaterMark: 0 }
        );
        const result = inheritRoutingResponseState(
          response,
          new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        );
        for (const key of ["url", "redirected", "type"] as const) {
          Object.defineProperty(result, key, { value: response[key], configurable: true });
        }
        // An idle response body does not keep an otherwise exiting process alive.
        // Only an explicit whole-combo deadline continues through the body.
        sharedTimer?.unref?.();
        return result;
      })
      .catch((error) => {
        if (!finished) {
          const cancelled =
            parents.some((parent) => parent.aborted) || error?.name === "AbortError";
          stop(
            cancelled ? "request_cancelled" : "execution_uncertain",
            cancelled ? 499 : 502,
            error
          );
        }
        return stopped ?? routingFailure("execution_uncertain");
      });
    // Caller cancellation survives headers. An explicit shared deadline also
    // survives; the per-target headers timer is released on Response arrival.
    return Promise.race([work, wait]);
  };
  return inheritRoutingGuard(run, deps.handleSingleModel);
}
