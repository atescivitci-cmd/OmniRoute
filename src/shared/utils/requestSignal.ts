/**
 * Give a Request an abort signal that cannot be lost to garbage collection.
 *
 * `new Request(url, { signal })` does not use `signal` directly. The runtime creates a new
 * "follower" signal for the Request and the source signal reaches it only through a weak
 * reference that stays alive while the Request object itself does. Code in this gateway often
 * keeps only `request.signal` (not the Request), so after a long stall and a few collections the
 * Request is gone, the follower never hears the abort, and a deadline or client disconnect no
 * longer reaches the upstream fetch or the usage bookkeeping. Measured: a probe stalled before any
 * response kept its upstream connection open for at least 10 s past a 4 s deadline once
 * collections ran.
 *
 * Binding the source signal itself removes the follower. The signal is then exactly the object
 * whoever owns the abort already holds, so its lifetime is theirs. Abort semantics are the same:
 * the signal is already aborted when the source was, and aborts when the source does.
 */
export function bindRequestSignal<T extends Request>(request: T, signal: AbortSignal): T {
  Object.defineProperty(request, "signal", {
    value: signal,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return request;
}
