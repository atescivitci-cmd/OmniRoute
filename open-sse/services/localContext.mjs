// Capacity comes only from the configured loopback Ollama server's resident
// model metadata. Never infer resource admission from a model's advertised max.
export const LOCAL_MODEL = "qwen3.6:35b-a3b";
export const MAX_CONTEXT = 262144;
export const CONTEXT_MARGIN = 8192;
export const DEFAULT_LOCAL_ORIGIN = "http://127.0.0.1:11434";
export const RESIDENT_METADATA_BUDGET_MS = 3000;

export function capacityUnavailable(reason = "resident_capacity_unavailable") {
  const error = new Error(
    `This local continuation step was not dispatched (${reason}). A verified resident model and its current context capacity are required. No larger context was requested by this step. Retry after the owner establishes an admissible local context or choose an existing authorized subscription route.`
  );
  error.code = "local_context_unavailable";
  error.status = 503;
  error.details = { reason, failure_phase: "admission", execution_outcome: "not_dispatched" };
  return error;
}
export function loopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw capacityUnavailable("invalid_local_endpoint");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw capacityUnavailable("non_loopback_endpoint");
  return url.origin;
}
export function assertArchiveEndpoint(value) {
  if (loopbackOrigin(value) !== DEFAULT_LOCAL_ORIGIN) {
    const error = new Error(
      `This archive continuation step was not dispatched. The archive planner currently supports only ${DEFAULT_LOCAL_ORIGIN}; localhost, IPv6 and alternate ports require configured-endpoint planning support. Preserve the original session or use an existing authorized subscription route.`
    );
    error.code = "unsupported_archive_endpoint";
    error.status = 503;
    throw error;
  }
}
export function validateCapacity(value, origin) {
  if (
    !value ||
    value.model !== LOCAL_MODEL ||
    !Number.isSafeInteger(value.context) ||
    value.context < 1 ||
    value.context > MAX_CONTEXT ||
    !/^[a-f0-9]{64}$/.test(value.digest ?? "")
  )
    throw capacityUnavailable("invalid_resident_metadata");
  const safeOrigin = loopbackOrigin(value.origin);
  if (origin && safeOrigin !== loopbackOrigin(origin))
    throw capacityUnavailable("resident_endpoint_changed");
  return Object.freeze({
    model: LOCAL_MODEL,
    context: value.context,
    digest: value.digest,
    origin: safeOrigin,
  });
}
export async function readResidentCapacity(origin = DEFAULT_LOCAL_ORIGIN, fetcher = fetch, signal) {
  signal?.throwIfAborted();
  const safeOrigin = loopbackOrigin(origin);
  let response, data;
  try {
    const timeout = AbortSignal.timeout(RESIDENT_METADATA_BUDGET_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    response = await fetcher(safeOrigin + "/api/ps", {
      method: "GET",
      cache: "no-store",
      signal: requestSignal,
    });
    if (!response.ok) throw Error("metadata unavailable");
    data = await response.json();
    requestSignal.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === "AbortError") throw error;
    throw capacityUnavailable(
      error?.name === "TimeoutError" ? "resident_metadata_timeout" : "resident_metadata_unavailable"
    );
  }
  signal?.throwIfAborted();
  if (!Array.isArray(data?.models)) throw capacityUnavailable("invalid_resident_metadata");
  const matches = data.models.filter(
    (m) => m && typeof m === "object" && (m.name ?? m.model) === LOCAL_MODEL
  );
  if (matches.length === 0) throw capacityUnavailable("model_not_resident");
  if (matches.length > 1) throw capacityUnavailable("model_residency_ambiguous");
  const model = matches[0];
  return validateCapacity({
    model: LOCAL_MODEL,
    context: model.context_length,
    digest: model.digest,
    origin: safeOrigin,
  });
}

function withinMetadataWindow(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function pauseMetadataObservation(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// A short missing-resident window can be observed without generating, loading or
// resizing a model. This is NOT a lease, idle witness or profile qualification.
// Only absence is re-observed; ambiguity, metadata/identity failures and changed
// capacity still fail through their existing admission checks. The entire wait,
// including metadata bodies, consumes one existing 3s metadata budget.
export async function waitForResidentCapacity(
  origin = DEFAULT_LOCAL_ORIGIN,
  fetcher = fetch,
  signal,
  {
    budgetMs = RESIDENT_METADATA_BUDGET_MS,
    now = () => performance.now(),
    pause = pauseMetadataObservation,
  } = {}
) {
  signal?.throwIfAborted();
  if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > RESIDENT_METADATA_BUDGET_MS)
    throw capacityUnavailable("resident_metadata_budget_invalid");
  const started = now();
  if (!Number.isFinite(started)) throw capacityUnavailable("resident_metadata_clock_invalid");
  const deadline = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Resident metadata deadline", "TimeoutError")),
    budgetMs
  );
  const remaining = () => {
    const elapsed = now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0)
      throw capacityUnavailable("resident_metadata_clock_invalid");
    return budgetMs - elapsed;
  };
  let absent = false;
  try {
    // Independent count bound also prevents a faulty injected clock/pause from
    // turning this pre-dispatch observation into an unbounded retry loop.
    for (let observation = 0; observation < 13; observation++) {
      requestSignal.throwIfAborted();
      if (remaining() <= 0) throw capacityUnavailable("resident_settle_timeout");
      try {
        const value = await withinMetadataWindow(
          () => readResidentCapacity(origin, fetcher, requestSignal),
          requestSignal
        );
        requestSignal.throwIfAborted();
        if (remaining() <= 0) throw capacityUnavailable("resident_settle_timeout");
        return value;
      } catch (error) {
        signal?.throwIfAborted();
        if (requestSignal.aborted) throw error;
        if (error?.details?.reason !== "model_not_resident") throw error;
        absent = true;
      }
      const left = remaining();
      if (left <= 0 || observation === 12) throw capacityUnavailable("resident_settle_timeout");
      await withinMetadataWindow(() => pause(Math.min(250, left), requestSignal), requestSignal);
    }
    throw capacityUnavailable("resident_settle_timeout");
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.signal.aborted)
      throw capacityUnavailable(absent ? "resident_settle_timeout" : "resident_metadata_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export function assertSameCapacity(planned, current) {
  const a = validateCapacity(planned),
    b = validateCapacity(current);
  if (a.origin !== b.origin || a.context !== b.context || a.digest !== b.digest)
    throw capacityUnavailable("resident_capacity_changed");
  return b;
}
export function nativeInputBound(request) {
  if (!Array.isArray(request.messages) || !Array.isArray(request.tools ?? []))
    throw capacityUnavailable("invalid_native_request");
  return (
    Buffer.byteLength(JSON.stringify(request), "utf8") +
    64 * (request.messages.length + (request.tools?.length ?? 0) + 5)
  );
}
export function assertNativeCapacity(request, capacity, retrievalReserve = 0) {
  const verified = validateCapacity(capacity);
  const output = request.options?.num_predict;
  if (
    request.options?.num_ctx !== verified.context ||
    !Number.isSafeInteger(output) ||
    output < 1 ||
    !Number.isSafeInteger(retrievalReserve) ||
    retrievalReserve < 0
  )
    throw capacityUnavailable("unverified_request_capacity");
  if (request.messages.some((m) => m.images?.length))
    throw capacityUnavailable("visual_token_budget_unverified");
  const bound = nativeInputBound(request),
    required = bound + output + CONTEXT_MARGIN + retrievalReserve;
  if (required > verified.context) {
    const error = new Error(
      `The complete serialized local request cannot be admitted within the verified resident context ${verified.context}. Conservative input bound ${bound}, output ${output}, framing ${CONTEXT_MARGIN}, retrieval ${retrievalReserve}. These bounds are not exact token counts. No instructions or tool schemas were removed. This continuation step was not dispatched and requested no context increase. Use a bounded handoff or an existing authorized subscription route.`
    );
    error.code = "local_context_capacity_exceeded";
    error.status = 422;
    error.details = {
      context_limit: verified.context,
      input_upper_bound: bound,
      output_reserve: output,
      framing_reserve: CONTEXT_MARGIN,
      retrieval_reserve: retrievalReserve,
    };
    throw error;
  }
  return bound;
}
