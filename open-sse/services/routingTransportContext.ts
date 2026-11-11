import { AsyncLocalStorage } from "node:async_hooks";

// Created only by trusted routing code. A body/header cannot manufacture a token.
const brand: unique symbol = Symbol("routing-transport-attempt");
export type TransportFailureDiagnostic = Readonly<{
  name?: string; code?: string; errno?: number; syscall?: string;
  causeName?: string; causeCode?: string; causeErrno?: number; causeSyscall?: string;
}>;
const safeNames = new Set(["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "FetchError", "SystemError"]);
const safeCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "ABORT_ERR", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED", "UND_ERR_CONNECT", "ERR_STREAM_PREMATURE_CLOSE"]);
const safeSyscalls = new Set(["connect", "read", "write", "getaddrinfo", "getnameinfo", "recv", "send", "accept", "socket", "tls"]);
function ownData(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try { const d = Object.getOwnPropertyDescriptor(value, key); return d && "value" in d ? d.value : undefined; } catch { return undefined; }
}
function safeFields(value: unknown): { name?: string; code?: string; errno?: number; syscall?: string } {
  const out: { name?: string; code?: string; errno?: number; syscall?: string } = {};
  try {
    let name = ownData(value, "name");
    if (name === undefined) {
      if (value instanceof DOMException) name = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get?.call(value);
      else if (value instanceof TypeError) name = "TypeError";
      else if (value instanceof RangeError) name = "RangeError";
      else if (value instanceof Error) name = "Error";
    }
    if (typeof name === "string" && safeNames.has(name)) out.name = name;
  } catch { /* Hostile accessors/proxies remain unknown. */ }
  const code = ownData(value, "code"), errno = ownData(value, "errno"), syscall = ownData(value, "syscall");
  if (typeof code === "string" && safeCodes.has(code)) out.code = code;
  if (typeof errno === "number" && Number.isSafeInteger(errno) && errno >= -2147483648 && errno <= 2147483647) out.errno = errno;
  if (typeof syscall === "string" && safeSyscalls.has(syscall)) out.syscall = syscall;
  return out;
}
function diagnostic(error: unknown): TransportFailureDiagnostic {
  const result: Record<string, string | number> = { ...safeFields(error) };
  for (const [key, value] of Object.entries(safeFields(ownData(error, "cause")))) result["cause" + key[0].toUpperCase() + key.slice(1)] = value;
  return Object.freeze(result);
}

export type RoutingTransportAttempt = Readonly<{ [brand]: true }>;
type State = {
  signal?: AbortSignal | null;
  modelDispatches: number;
  wireDispatches: number;
  uncertain: boolean;
  cancelled: boolean;
  blocked: boolean;
  transportFailure?: TransportFailureDiagnostic;
};
const states = new WeakMap<RoutingTransportAttempt, State>();
const attempts = new AsyncLocalStorage<RoutingTransportAttempt>();
const wireScopes = new AsyncLocalStorage<boolean>();

export class RoutingTransportSafetyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly execution: "unknown" | "not_dispatched";
  readonly transportFailure?: TransportFailureDiagnostic;
  constructor(state: State) {
    super("Routing transport attempt stopped; no automatic transport replay is permitted.");
    if (state.transportFailure) this.transportFailure = Object.freeze({ ...state.transportFailure });
    this.name = state.cancelled ? "AbortError" : "RoutingTransportSafetyError";
    this.status = state.cancelled ? 499 : 503;
    this.code = state.uncertain
      ? "routing_transport_execution_uncertain"
      : state.cancelled
        ? "routing_transport_cancelled"
        : "routing_transport_replay_blocked";
    this.execution = state.uncertain || state.modelDispatches > 0 ? "unknown" : "not_dispatched";
  }
}

export function createRoutingTransportAttempt(
  options: { signal?: AbortSignal | null } = {}
): RoutingTransportAttempt {
  const token = Object.freeze({ [brand]: true as const });
  states.set(token, {
    signal: options.signal,
    modelDispatches: 0,
    wireDispatches: 0,
    uncertain: false,
    cancelled: false,
    blocked: false,
  });
  return token;
}

function recordTransportFailure(error: unknown, token?: RoutingTransportAttempt): void {
  if (error instanceof RoutingTransportSafetyError) return;
  const state = token ? states.get(token) : currentState();
  if (state && !state.transportFailure) state.transportFailure = diagnostic(error);
}

function currentState(): State | undefined {
  const token = attempts.getStore();
  return token ? states.get(token) : undefined;
}

function assertState(state: State): void {
  if (state.signal?.aborted) state.cancelled = true;
  if (state.uncertain || state.cancelled || state.blocked) {
    throw new RoutingTransportSafetyError(state);
  }
}

export function getCurrentRoutingTransportAttempt(): RoutingTransportAttempt | undefined {
  return attempts.getStore();
}

export function hasRoutingTransportAttempt(): boolean {
  return currentState() !== undefined;
}

export function getRoutingTransportOutcome(token: RoutingTransportAttempt) {
  const state = states.get(token);
  if (!state) throw new TypeError("Invalid routing transport token");
  return Object.freeze({
    modelDispatches: state.modelDispatches,
    wireDispatches: state.wireDispatches,
    uncertain: state.uncertain,
    cancelled: state.cancelled || state.signal?.aborted === true,
    blocked: state.blocked,
    ...(state.transportFailure && { transportFailure: Object.freeze({ ...state.transportFailure }) }),
  });
}

/** Trusted bounded metadata only; never includes the original exception object. */
export function getCurrentRoutingTransportFailure(): TransportFailureDiagnostic | undefined {
  const value = currentState()?.transportFailure;
  return value ? Object.freeze({ ...value }) : undefined;
}

export function assertRoutingTransportOutcome(token: RoutingTransportAttempt): void {
  const state = states.get(token);
  if (!state) throw new TypeError("Invalid routing transport token");
  assertState(state);
}

export async function runWithRoutingTransportAttempt<T>(
  token: RoutingTransportAttempt,
  fn: () => T | Promise<T>
): Promise<T> {
  const state = states.get(token);
  if (!state) throw new TypeError("Invalid routing transport token");
  assertState(state);
  return attempts.run(token, async () => {
    try {
      const result = await fn();
      // A nested catch cannot turn a refused/uncertain dispatch into success.
      assertState(state);
      return result;
    } catch (error) {
      // Neither a replacement exception nor an executor-specific timeout may
      // hide the authoritative sticky execution/cancellation outcome.
      assertState(state);
      throw error;
    }
  });
}

export function assertRoutingTransportDispatch(
  layer: "model" | "wire" = "model",
  token?: RoutingTransportAttempt
): void {
  const state = token ? states.get(token) : currentState();
  if (token && !state) throw new TypeError("Invalid routing transport token");
  if (!state || (layer === "wire" && !wireScopes.getStore())) return;
  assertState(state);
  const key = layer === "model" ? "modelDispatches" : "wireDispatches";
  if (state[key] !== 0) {
    state.blocked = true;
    throw new RoutingTransportSafetyError(state);
  }
  state[key] = 1;
}

export function stopRoutingTransportAttempt(
  reason: "execution_uncertain" | "cancelled",
  token?: RoutingTransportAttempt
): void {
  const state = token ? states.get(token) : currentState();
  if (token && !state) throw new TypeError("Invalid routing transport token");
  if (!state) return;
  if (reason === "execution_uncertain") state.uncertain = true;
  else state.cancelled = true;
}

/** Trusted caller cannot establish a safe continuation; no dispatch is implied. */
export function refuseRoutingTransportAttempt(token?: RoutingTransportAttempt): never {
  const state = token ? states.get(token) : currentState();
  if (!state) throw new TypeError("Missing routing transport token");
  state.blocked = true;
  throw new RoutingTransportSafetyError(state);
}

export function isRoutingTransportWireScope(): boolean {
  return hasRoutingTransportAttempt() && wireScopes.getStore() === true;
}

/** Explicit inference wire scope: metadata, quota and credential calls stay outside it. */
export async function runWithRoutingTransportWire<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!hasRoutingTransportAttempt()) return fn();
  assertRoutingTransportDispatch("model");
  return wireScopes.run(true, async () => {
    try {
      const result = await fn();
      const state = currentState();
      if (state) assertState(state);
      return result;
    } catch (error) {
      // Fetch was invoked. Abort/error does not prove remote non-execution.
      if (!(error instanceof RoutingTransportSafetyError)) {
        recordTransportFailure(error);
        stopRoutingTransportAttempt("execution_uncertain");
      }
      const state = currentState();
      if (state) assertState(state);
      throw error;
    }
  });
}

/** Merge only trusted per-attempt and explicit transport cancellation signals. */
export function getRoutingTransportSignal(
  signal?: AbortSignal | null,
  token = getCurrentRoutingTransportAttempt()
): AbortSignal | undefined {
  const owned = token ? states.get(token)?.signal : undefined;
  const signals = [owned, signal].filter((entry): entry is AbortSignal => !!entry);
  if (signals.length === 0) return undefined;
  return signals.length === 1 || signals[0] === signals[1] ? signals[0] : AbortSignal.any(signals);
}

/** Keep late body failures bound to the original attempt, including after ALS return. */
export function bindRoutingTransportResponse(
  response: Response,
  token = getCurrentRoutingTransportAttempt(),
  signal = token ? getRoutingTransportSignal(undefined, token) : undefined
): Response {
  if (!token) return response;
  try {
    assertRoutingTransportOutcome(token);
    if (!response.body) return response;
    const reader = response.body.getReader();
    let settled = false;
    let sink: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const cancelReader = () => {
      void reader.cancel().catch(() => {});
    };
    const fail = (cancelled = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cancelled) stopRoutingTransportAttempt("cancelled", token);
      stopRoutingTransportAttempt("execution_uncertain", token);
      cancelReader();
      try {
        assertRoutingTransportOutcome(token);
      } catch (error) {
        sink.error(error);
      }
    };
    const onAbort = () => fail(true);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        sink = controller;
      },
      async pull(controller) {
        if (settled) return;
        try {
          assertRoutingTransportOutcome(token);
          const chunk = await reader.read();
          if (settled) return;
          assertRoutingTransportOutcome(token);
          if (chunk.done) {
            settled = true;
            cleanup();
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          recordTransportFailure(error, token);
          fail();
        }
      },
      cancel() {
        if (settled) return;
        settled = true;
        cleanup();
        stopRoutingTransportAttempt("cancelled", token);
        stopRoutingTransportAttempt("execution_uncertain", token);
        cancelReader();
      },
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const bound = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    for (const key of ["url", "redirected", "type"] as const) {
      Object.defineProperty(bound, key, { value: response[key], configurable: true });
    }
    return bound;
  } catch (error) {
    recordTransportFailure(error, token);
    stopRoutingTransportAttempt("execution_uncertain", token);
    assertRoutingTransportOutcome(token);
    throw error;
  }
}

/** Explicit custom-executor inference call; metadata/auth calls must not use this. */
export async function dispatchRoutingTransportFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<Response> {
  if (!hasRoutingTransportAttempt()) return fetchImpl(input, init);
  const token = getCurrentRoutingTransportAttempt()!;
  const inputSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const signal = getRoutingTransportSignal(inputSignal, token);
  if (signal?.aborted) {
    stopRoutingTransportAttempt("cancelled", token);
    assertRoutingTransportOutcome(token);
  }
  return runWithRoutingTransportWire(async () => {
    // A redirect can replay the model POST outside this process' retry owner.
    const response = await fetchImpl(input, { ...init, signal, redirect: "error" });
    return bindRoutingTransportResponse(response, token, signal);
  });
}
