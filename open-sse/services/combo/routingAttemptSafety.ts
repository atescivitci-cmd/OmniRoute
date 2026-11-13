import type { HandleSingleModel, SingleModelTarget } from "./types.ts";
import { createHash } from "node:crypto";
import { LOCAL_COST_ERROR_CODES } from "../autoCombo/zeroCostAdmission.ts";
import {
  createRoutingTransportAttempt,
  runWithRoutingTransportAttempt,
  assertRoutingTransportOutcome,
} from "../routingTransportContext.ts";

// These capabilities are process-local. Wire headers/body fields cannot grant
// replay permission or claim that an attempted provider operation did not run.
const nonDispatch = new WeakSet<Response>();
const terminal = new WeakSet<Response>();
const definiteRejection = new WeakSet<Response>();
// A target refused BEFORE dispatch because the API key is over its USD limit. No provider saw
// the request, so a sanitized body may move on to another target (see sanitizedSwitch below).
const keyLimitRefusal = new WeakSet<Response>();
const responseReplacements = new WeakMap<Response, Response>();
const stopReasons = new WeakMap<Response, string>();
export function markDefiniteRejection<T extends Response>(response: T): T {
  definiteRejection.add(response);
  return response;
}
export function isDefiniteRoutingRejection(response: Response): boolean {
  return definiteRejection.has(response);
}
export function markKeyLimitRefusal<T extends Response>(response: T): T {
  keyLimitRefusal.add(response);
  return response;
}
export function isKeyLimitRefusal(response: Response): boolean {
  return keyLimitRefusal.has(response);
}
export function markKnownNonDispatch<T extends Response>(response: T): T {
  nonDispatch.add(response);
  return response;
}
export function markRoutingTerminal<T extends Response>(response: T): T {
  terminal.add(response);
  return response;
}
export function isRoutingTerminal(response: Response): boolean {
  return terminal.has(response);
}

/** Preserve trusted local capabilities when a lifecycle wrapper replaces a Response. */
export function inheritRoutingResponseState<T extends Response>(source: Response, target: T): T {
  copyRoutingResponseState(source, target);
  if (source !== target) responseReplacements.set(source, target);
  return target;
}
function copyRoutingResponseState<T extends Response>(source: Response, target: T): T {
  if (nonDispatch.has(source)) nonDispatch.add(target);
  if (definiteRejection.has(source)) definiteRejection.add(target);
  if (terminal.has(source)) terminal.add(target);
  if (keyLimitRefusal.has(source)) keyLimitRefusal.add(target);
  const reason = stopReasons.get(source);
  if (reason) stopReasons.set(target, reason);
  return target;
}

export async function cancelRoutingResponse(response: Response, reason?: unknown): Promise<void> {
  const seen = new Set<Response>();
  while (responseReplacements.has(response) && !seen.has(response)) {
    seen.add(response);
    response = responseReplacements.get(response)!;
  }
  try {
    await response.body?.cancel(reason);
  } catch {
    /* cleanup cannot dispatch or replace outcome */
  }
}

export function routingFailure(code: string, status = 502): Response {
  const response = markRoutingTerminal(
    Response.json(
      {
        error: {
          code,
          type: "routing_error",
          message: "Routing stopped safely; inspect the correlated failure chain.",
        },
      },
      { status }
    )
  );
  stopReasons.set(response, code);
  return response;
}

// hardBound: the request depends on provider-held state (stored responses, containers,
// provider-run tools) that no body rewrite can carry to another provider. providerBound with
// hardBound false means only signature-class artifacts (signed thinking, encrypted reasoning)
// are present, which sanitizeForProviderSwitch strips.
export type ReplayInput = { providerBound: boolean; hasTools: boolean; hardBound: boolean };
export function inspectReplayInput(body: Record<string, unknown>): ReplayInput {
  let hardBound = Boolean(body.previous_response_id || body.conversation || body.container);
  let providerBound = hardBound;
  let hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const row = value as Record<string, unknown>;
    // Never parse tool-output prose as routing authority.
    if (row.signature || row.encrypted_content || row.type === "redacted_thinking")
      providerBound = true;
    if (
      row.role === "tool" ||
      row.role === "function" ||
      row.tool_calls ||
      row.function_call ||
      ["tool_use", "tool_result", "function_call", "function_call_output"].includes(
        String(row.type)
      )
    )
      hasTools = true;
    if (
      typeof row.type === "string" &&
      /^(web_search|computer|code_interpreter|file_search|mcp)(?:_|$)/.test(row.type)
    ) {
      providerBound = true;
      hardBound = true;
    }
    for (const [key, child] of Object.entries(row)) {
      if (["content", "input", "output", "result"].includes(key) && typeof child === "string")
        continue;
      visit(child);
    }
  };
  visit(body);
  return { providerBound, hasTools, hardBound };
}

export type RoutingAttemptToken = { enter(): void; entered(): boolean; refused(): boolean };
export class RoutingAttemptRefused extends Error {
  constructor() {
    super("nested_transport_retry_blocked");
    this.name = "RoutingAttemptRefused";
  }
}
function makeToken(signal?: AbortSignal | null): RoutingAttemptToken {
  let dispatched = false;
  let refused = false;
  return {
    enter() {
      signal?.throwIfAborted();
      if (dispatched) {
        refused = true;
        throw new RoutingAttemptRefused();
      }
      dispatched = true;
    },
    entered: () => dispatched,
    refused: () => refused,
  };
}

async function boundedErrorCode(
  response: Response
): Promise<{ code: string | null; uncertain: boolean; reason: string | null } | null> {
  if (!response.headers.get("content-type")?.includes("application/json")) return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  // An error body is not a licence to stall the entire retry owner.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > 8192) return null;
          chunks.push(item.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const value = JSON.parse(new TextDecoder().decode(bytes));
        const detail = value?.error?.details;
        return {
          code: typeof value?.error?.code === "string" ? value.error.code : null,
          uncertain:
            detail?.execution_outcome === "uncertain" || detail?.execution_outcome === "unknown",
          reason: typeof detail?.reason === "string" ? detail.reason : null,
        };
      })(),
      new Promise<{ code: null; uncertain: boolean; reason: string }>((resolve) => {
        timer = setTimeout(
          () => resolve({ code: null, uncertain: true, reason: "error_body_deadline" }),
          100
        );
      }),
    ]);
  } catch {
    return { code: null, uncertain: true, reason: "error_body_unreadable" };
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

const DEFINITE_REJECTIONS = new Set([
  "context_length_exceeded",
  "model_not_found",
  "model_not_supported",
  "account_model_ineligible",
  "nvidia_model_catalog_negative",
  "capability_mismatch",
  "provider_circuit_open",
]);
const safeId = (value: unknown): string | null =>
  typeof value === "string" && /^[a-zA-Z0-9_.:/+@-]{1,200}$/.test(value) ? value : null;
const owners = new WeakMap<HandleSingleModel, ReturnType<typeof createRoutingAttemptGuard>>();
const originals = new WeakMap<HandleSingleModel, HandleSingleModel>();
const stageScopes = new WeakMap<HandleSingleModel, RoutingStageScope>();
function rawDispatch(dispatch: HandleSingleModel): HandleSingleModel {
  const seen = new Set<HandleSingleModel>();
  while (originals.has(dispatch) && !seen.has(dispatch)) {
    seen.add(dispatch);
    dispatch = originals.get(dispatch)!;
  }
  return dispatch;
}
export const routingGuardFor = (dispatch: HandleSingleModel) => owners.get(dispatch);
export function inheritRoutingGuard(wrapper: HandleSingleModel, original: HandleSingleModel) {
  const owner = owners.get(original);
  if (owner) owners.set(wrapper, owner);
  originals.set(wrapper, rawDispatch(original));
  const scope = stageScopes.get(original);
  if (scope) stageScopes.set(wrapper, scope);
  return wrapper;
}

type AttemptBudget = {
  startedAt: number;
  attempts: number;
  limit: number;
  deadlineMs?: number;
  signal?: AbortSignal | null;
};
type GuardHooks = {
  beforeAttempt?: () => Response | null;
  onAttempt?: () => void;
  onStop?: (response: Response, reason: string) => void;
};

/** One request-local owner shared by target, set, cooldown and final-local paths. */
export function createRoutingAttemptGuard(options: {
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
  limit: number;
  deadlineMs?: number;
  requestId?: string | null;
  emit?: (event: Record<string, unknown>) => void;
  /** Internal only: nested stages share physical-attempt accounting, not response state. */
  sharedBudget?: AttemptBudget;
  hooks?: GuardHooks;
  /**
   * The caller sanitizes the body (sanitizeForProviderSwitch) before every dispatch that
   * follows a key-limit refusal. Only then may a signature-bound history advance, and only
   * past a refusal made before dispatch. Hard provider binding and every other failure keep
   * the existing stop.
   */
  sanitizedSwitch?: boolean;
}) {
  const budget = options.sharedBudget ?? {
    startedAt: Date.now(),
    attempts: 0,
    limit: options.limit,
    deadlineMs: options.deadlineMs,
    signal: options.signal,
  };
  const input = inspectReplayInput(options.body);
  let sanitizedSwitch = options.sanitizedSwitch === true;
  const rejected = new Set<string>();
  let attempts = 0;
  let stopped: Response | null = null;
  let inFlight = false;
  let compositeOpen = false;
  let eventCount = 0;
  const retryNotBefore = new Map<string, number>();
  let priorFailure: Response | null = null;
  const emit = (event: Record<string, unknown>) => {
    if (eventCount++ >= 256) return;
    const clean: Record<string, unknown> = { requestId: safeId(options.requestId) };
    for (const key of [
      "event",
      "reason",
      "provider",
      "model",
      "connectionId",
      "code",
      "execution",
      "stageId",
    ]) {
      if (key in event) clean[key] = safeId(event[key]);
    }
    for (const key of ["attempt", "attempts", "status", "durationMs"]) {
      if (typeof event[key] === "number" && Number.isFinite(event[key]))
        clean[key] = Math.max(0, event[key] as number);
    }
    try {
      options.emit?.(clean);
    } catch {
      /* diagnostics cannot change routing */
    }
  };
  const stop = (response: Response, reason: string) => {
    if (stopped) return stopped;
    stopped = markRoutingTerminal(response);
    if (!stopReasons.has(stopped)) stopReasons.set(stopped, reason);
    emit({ event: "stop", reason, attempts });
    options.hooks?.onStop?.(stopped, reason);
    return stopped;
  };
  const guard = {
    terminal: () => stopped,
    attempts: () => budget.attempts,
    deadline: () => budget.deadlineMs,
    signal: () => options.signal ?? budget.signal,
    finish: (response: Response, reason = "composite_complete") => stop(response, reason),
    beginComposite() {
      if (stopped || inFlight || compositeOpen)
        return stopped ?? stop(routingFailure("composite_reentry_blocked"), "concurrent_replay");
      compositeOpen = true;
      return null;
    },
    releaseCompositeWithoutWork() {
      if (!stopped) compositeOpen = false;
    },
    fork(
      body: Record<string, unknown>,
      limit: number,
      hooks: GuardHooks = {},
      signal?: AbortSignal
    ) {
      return createRoutingAttemptGuard({
        ...options,
        body,
        limit,
        sharedBudget: budget,
        signal: signal
          ? AbortSignal.any(
              [options.signal, budget.signal, signal].filter(Boolean) as AbortSignal[]
            )
          : options.signal,
        hooks: {
          beforeAttempt: () => options.hooks?.beforeAttempt?.() ?? hooks.beforeAttempt?.() ?? null,
          onAttempt: () => {
            options.hooks?.onAttempt?.();
            hooks.onAttempt?.();
          },
          onStop: (response, reason) => {
            options.hooks?.onStop?.(response, reason);
            hooks.onStop?.(response, reason);
          },
        },
      });
    },
    /** The combo has an explicit per-terminal session and will sanitize the body before any
     * dispatch that follows a key-limit refusal. Called by the combo, never by wire input. */
    enableSanitizedSwitch() {
      sanitizedSwitch = true;
    },
    restrictTimeout(ms: number) {
      if (Number.isFinite(ms) && ms > 0)
        budget.deadlineMs = Math.min(budget.deadlineMs ?? Infinity, budget.startedAt + ms);
    },
    event: emit,
    auxiliary(dispatch: HandleSingleModel): HandleSingleModel {
      return async (body, model, target) => {
        options.signal?.throwIfAborted();
        if (!stopped?.ok || budget.attempts >= budget.limit)
          return routingFailure("auxiliary_attempt_not_admitted");
        const child = guard.fork(body, 1);
        return child.wrap(dispatch)(body, model, target);
      };
    },
    wrap(dispatch: HandleSingleModel): HandleSingleModel {
      if (owners.get(dispatch) === guard) return dispatch;
      const wrapped: HandleSingleModel = async (body, model, target) => {
        options.signal?.throwIfAborted();
        budget.signal?.throwIfAborted();
        target?.modelAbortSignal?.throwIfAborted();
        if (stopped) return stopped.ok ? routingFailure("response_already_committed") : stopped;
        if (compositeOpen)
          return stop(routingFailure("composite_replay_blocked"), "concurrent_replay");
        const refusal = options.hooks?.beforeAttempt?.();
        if (refusal) return stop(refusal, "parent_stage_stopped");
        if (budget.deadlineMs && Date.now() >= budget.deadlineMs)
          return stop(routingFailure("routing_deadline", 504), "deadline");
        if (attempts >= options.limit || budget.attempts >= budget.limit)
          return stop(routingFailure("routing_attempt_limit", 503), "attempt_limit");
        if (inFlight) return stop(routingFailure("concurrent_replay_blocked"), "concurrent_replay");
        const typed = target as { provider?: string; connectionId?: string } | undefined;
        const key = JSON.stringify([model, typed?.connectionId ?? null]);
        if ((retryNotBefore.get(key) ?? 0) > Date.now()) {
          // Do not start a new timer/second retry loop. Existing orchestration
          // may wait; otherwise skip only this paced target and keep alternatives.
          const response = markKnownNonDispatch(
            Response.json(
              {
                error: {
                  code: "target_retry_after_pending",
                  type: "rate_limit_error",
                  message: "This target remains paced; another eligible target may be selected.",
                },
              },
              { status: 429 }
            )
          );
          response.headers.set(
            "Retry-After",
            String(Math.ceil(((retryNotBefore.get(key) ?? 0) - Date.now()) / 1000))
          );
          emit({ event: "skip", reason: "target_retry_after_pending", model: safeId(model) });
          return response;
        }

        if (rejected.has(key))
          return markKnownNonDispatch(
            Response.json(
              {
                error: {
                  code: "account_model_ineligible",
                  type: "invalid_request_error",
                  message: "This target was already rejected during this request.",
                },
              },
              { status: 400 }
            )
          );
        if (priorFailure) void cancelRoutingResponse(priorFailure);
        priorFailure = null;
        const token = makeToken(target?.modelAbortSignal ?? options.signal);
        attempts++;
        budget.attempts++;
        options.hooks?.onAttempt?.();
        inFlight = true;
        const start = Date.now();
        emit({
          event: "attempt",
          attempt: attempts,
          provider: safeId(typed?.provider),
          model: safeId(model),
          connectionId: safeId(typed?.connectionId),
        });
        let received: Response | null = null;
        try {
          const transport = createRoutingTransportAttempt({
            signal: target?.modelAbortSignal ?? options.signal,
          });
          const result = await runWithRoutingTransportAttempt(transport, async () => {
            received = await dispatch(body, model, {
              ...target,
              routingAttemptToken: token,
              failoverBeforeRetry: true,
            } as SingleModelTarget);
            return received;
          });
          const priorStop = guard.terminal();
          if (priorStop) {
            if (result !== priorStop) void cancelRoutingResponse(result);
            return priorStop.ok ? routingFailure("response_already_committed") : priorStop;
          }
          options.signal?.throwIfAborted();
          budget.signal?.throwIfAborted();
          target?.modelAbortSignal?.throwIfAborted();
          if (token.refused())
            return stop(
              routingFailure("nested_transport_retry_blocked"),
              "nested_transport_retry_blocked"
            );
          const error = result.ok ? null : await boundedErrorCode(result);
          assertRoutingTransportOutcome(transport);
          const code = error?.code ?? null;
          emit({
            event: "outcome",
            attempt: attempts,
            provider: safeId(typed?.provider),
            model: safeId(model),
            status: result.status,
            code: safeId(code),
            reason: safeId(error?.reason),
            durationMs: Date.now() - start,
            execution: nonDispatch.has(result)
              ? "not_dispatched"
              : error?.uncertain
                ? "uncertain"
                : "response_observed",
          });
          if (isRoutingTerminal(result)) return stop(result, "terminal_outcome");
          if (result.ok) return stop(result, "response_committed");
          if (error?.uncertain) {
            if (["error_body_deadline", "error_body_unreadable"].includes(error.reason ?? "")) {
              void cancelRoutingResponse(result);
              return stop(routingFailure(error.reason!), "execution_uncertain");
            }
            return stop(result, "execution_uncertain");
          }
          // Cost/scope admission is a request policy refusal, never evidence that
          // a different target may execute. Keep this separate from eligibility.
          if (LOCAL_COST_ERROR_CODES.has(code ?? "")) return stop(result, "local_cost_admission");
          if (input.providerBound) {
            const keyLimitAdvance =
              sanitizedSwitch &&
              !input.hardBound &&
              keyLimitRefusal.has(result) &&
              nonDispatch.has(result);
            if (!keyLimitAdvance) return stop(result, "provider_continuation_unqualified");
            rejected.add(key);
            priorFailure = result;
            return result;
          }
          // A wire error code is not positive evidence of non-generation. The
          // native handler marks the one qualified NVIDIA rejection locally.
          if (
            (typed?.provider === "nvidia" || (!typed?.provider && model.startsWith("nvidia/"))) &&
            ([401, 403, 404, 408, 429].includes(result.status) || result.status >= 500) &&
            !nonDispatch.has(result) &&
            !definiteRejection.has(result)
          )
            return stop(result, "no_safe_fallback");
          if (
            nonDispatch.has(result) ||
            definiteRejection.has(result) ||
            (!input.hasTools &&
              result.status >= 400 &&
              result.status < 500 &&
              DEFINITE_REJECTIONS.has(code ?? ""))
          ) {
            rejected.add(key);
            priorFailure = result;
            return result;
          }
          if ([400, 401, 403, 422, 499].includes(result.status))
            return stop(result, "request_rejected");
          // A rejection status is affirmative nonexecution for ordinary text;
          // network errors and 5xx do not prove a tool operation did not execute.
          // TOOL_RATE_LIMIT_FAILOVER_V1: a 429 is the provider declining admission
          // before any generation, so no tool operation can have run and another
          // target may be tried. Every other status here (408, 5xx) can follow
          // partial execution and still stops a tool request.
          if (input.hasTools && result.status !== 429)
            return stop(result, "tool_replay_unqualified");
          if ([408, 429, 500, 502, 503, 504].includes(result.status)) {
            const hint = result.headers.get("retry-after");
            if (hint) {
              const seconds = Number(hint);
              const at =
                Number.isFinite(seconds) && seconds >= 0
                  ? Date.now() + seconds * 1000
                  : Date.parse(hint);
              if (Number.isFinite(at) && at > Date.now()) retryNotBefore.set(key, at);
            }
            priorFailure = result;
            return result;
          }
          return stop(result, "no_safe_fallback");
        } catch (error) {
          if (received) void cancelRoutingResponse(received);
          if (
            options.signal?.aborted ||
            budget.signal?.aborted ||
            target?.modelAbortSignal?.aborted ||
            (error as Error)?.name === "AbortError"
          ) {
            stop(routingFailure("request_cancelled", 499), "cancelled");
            throw error;
          }
          return stop(routingFailure("execution_uncertain"), "execution_uncertain");
        } finally {
          inFlight = false;
        }
      };
      owners.set(wrapped, guard);
      originals.set(wrapped, rawDispatch(dispatch));
      return wrapped;
    },
  };
  return guard;
}

const STAGE_CALL = Symbol("trusted-routing-stage-call");
type StageLease = {
  id: string;
  binding: string;
  guard: ReturnType<typeof createRoutingAttemptGuard>;
  run: HandleSingleModel;
  branchUsed: boolean;
  optional: boolean;
  started: boolean;
  uncertain: boolean;
  controller: AbortController;
};
type StagePermit = Readonly<{
  scope: RoutingStageScope;
  lease: StageLease;
  body: Record<string, unknown>;
  model: string;
}>;
const stagePermits = new WeakSet<object>();
const fatalStageReasons = new Set([
  "cancelled",
  "request_cancelled",
  "execution_uncertain",
  "terminal_outcome",
  "parent_stage_stopped",
  "deadline",
  "routing_deadline",
  "attempt_limit",
  "routing_attempt_limit",
  "target_timeout_execution_uncertain",
  "error_body_deadline",
  "error_body_unreadable",
  "tool_replay_unqualified",
  "provider_continuation_unqualified",
  "concurrent_replay",
  "nested_transport_retry_blocked",
  "stage_reentry_blocked",
  "stage_body_execution_uncertain",
  "stage_execution_uncertain",
  "stage_identity_missing",
  "stage_input_changed",
  "stage_identity_invalid",
  "stage_scope_finished",
]);

/** A configured composite is one parent branch, with separately named leaf attempts. */
export class RoutingStageScope {
  readonly dispatch: HandleSingleModel;
  private readonly raw: HandleSingleModel;
  private readonly leases = new Map<string, StageLease>();
  private failure: Response | null = null;
  private started = false;
  private finished = false;
  private readonly controller = new AbortController();
  constructor(
    readonly owner: ReturnType<typeof createRoutingAttemptGuard>,
    dispatch: HandleSingleModel
  ) {
    this.raw = rawDispatch(dispatch);
    this.failure = owner.beginComposite();
    this.dispatch = async (body, model, target) => {
      const permit = this.permit(target, body, model);
      if (!permit) return this.fail("stage_identity_missing");
      const signals = [
        this.owner.signal(),
        target?.modelAbortSignal,
        this.controller.signal,
        permit.lease.controller.signal,
      ].filter(Boolean) as AbortSignal[];
      return permit.lease.run(body, model, {
        ...target,
        modelAbortSignal: AbortSignal.any(signals),
      } as SingleModelTarget);
    };
    owners.set(this.dispatch, owner);
    originals.set(this.dispatch, this.raw);
    stageScopes.set(this.dispatch, this);
  }
  stopped(): Response | null {
    if (!this.failure) return null;
    try {
      return copyRoutingResponseState(this.failure, this.failure.clone());
    } catch {
      return routingFailure("stage_execution_uncertain");
    }
  }
  fail(code: string, status = 502): Response {
    if (!this.failure) {
      this.failure = routingFailure(code, status);
      this.controller.abort(new DOMException("Stage scope stopped", "AbortError"));
    }
    return this.stopped()!;
  }
  private permit(
    target: SingleModelTarget | undefined,
    body: Record<string, unknown>,
    model: string
  ): StagePermit | null {
    const value = (target as unknown as Record<symbol, unknown> | undefined)?.[STAGE_CALL] as
      StagePermit | undefined;
    return value &&
      stagePermits.has(value) &&
      value.scope === this &&
      value.body === body &&
      value.model === model
      ? value
      : null;
  }
  private lease(
    id: string,
    body: Record<string, unknown>,
    model: string,
    maxAttempts: number,
    optional: boolean
  ): StageLease | null {
    if (this.finished || this.failure) return null;
    if (!/^[A-Za-z0-9_.:/-]{1,160}$/.test(id)) {
      this.fail("stage_identity_invalid");
      return null;
    }
    let binding: string;
    try {
      binding = createHash("sha256")
        .update(JSON.stringify([model, body]))
        .digest("hex");
    } catch {
      this.fail("stage_input_invalid", 400);
      return null;
    }
    const replay = inspectReplayInput(body);
    optional = optional && !replay.hasTools && !replay.providerBound;
    const existing = this.leases.get(id);
    if (existing) {
      if (existing.binding !== binding || existing.optional !== optional) {
        this.fail("stage_input_changed", 400);
        return null;
      }
      return existing;
    }
    let lease: StageLease;
    const guard = this.owner.fork(body, Math.max(1, Math.min(100, Math.floor(maxAttempts) || 1)), {
      beforeAttempt: () =>
        this.failure ?? (this.owner.terminal()?.ok === false ? this.owner.terminal() : null),
      onAttempt: () => {
        this.started = true;
        lease.started = true;
      },
      onStop: (response, reason) => {
        if (
          !response.ok &&
          (fatalStageReasons.has(reason) || fatalStageReasons.has(stopReasons.get(response) ?? ""))
        ) {
          if (lease.optional && !this.owner.signal()?.aborted) {
            this.noteUncertain(lease, reason);
            return;
          }
          if (!this.failure) {
            this.failure = markRoutingTerminal(response);
            this.controller.abort(new DOMException("Stage scope stopped", "AbortError"));
          }
        }
      },
    });
    lease = {
      id,
      binding,
      guard,
      run: guard.wrap(this.raw),
      branchUsed: false,
      optional,
      started: false,
      uncertain: false,
      controller: new AbortController(),
    };
    this.leases.set(id, lease);
    return lease;
  }
  private noteUncertain(lease: StageLease, reason: string) {
    if (lease.started) lease.uncertain = true;
    this.owner.event({
      event: "stage_outcome",
      stageId: lease.id,
      reason,
      execution: lease.started ? "uncertain" : "not_dispatched",
    });
    lease.controller.abort(new DOMException("Optional stage stopped", "AbortError"));
  }
  stopStage(id: string, reason = "stage_quorum_cutoff"): void {
    const lease = this.leases.get(id);
    if (!lease) return;
    const response = routingFailure(reason, 504);
    if (!lease.optional) {
      this.fail("stage_execution_uncertain");
      return;
    }
    this.noteUncertain(lease, reason);
    lease.guard.finish(response, "execution_uncertain");
  }
  private observe(response: Response, lease: StageLease): Response {
    if (!response.body) return response;
    const reader = response.body.getReader();
    const scope = this;
    return inheritRoutingResponseState(
      response,
      new Response(
        new ReadableStream({
          async pull(controller) {
            try {
              const item = await reader.read();
              if (item.done) controller.close();
              else controller.enqueue(item.value);
            } catch (error) {
              if (lease.optional && !scope.owner.signal()?.aborted)
                scope.noteUncertain(lease, "stage_body_execution_uncertain");
              else scope.fail("stage_body_execution_uncertain");
              controller.error(error);
            }
          },
          cancel(reason) {
            return reader.cancel(reason).catch(() => {});
          },
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers }
      )
    );
  }
  async call(
    handle: HandleSingleModel,
    id: string,
    body: Record<string, unknown>,
    model: string,
    target?: SingleModelTarget,
    maxAttempts = 1,
    optional = false
  ): Promise<Response> {
    const lease = this.lease(id, body, model, maxAttempts, optional);
    if (!lease) return this.stopped() ?? this.fail("stage_scope_finished");
    const permit: StagePermit = Object.freeze({ scope: this, lease, body, model });
    stagePermits.add(permit);
    try {
      this.owner.signal()?.throwIfAborted();
      const stageTarget: SingleModelTarget & { [STAGE_CALL]: StagePermit } = {
        ...target,
        modelAbortSignal: AbortSignal.any(
          [
            this.owner.signal(),
            target?.modelAbortSignal,
            this.controller.signal,
            lease.controller.signal,
          ].filter(Boolean) as AbortSignal[]
        ),
        [STAGE_CALL]: permit,
      };
      const response = await handle(body, model, stageTarget);
      this.owner.signal()?.throwIfAborted();
      if (this.owner.terminal() && !this.owner.terminal()!.ok)
        this.failure ??= this.owner.terminal();
      if (
        fatalStageReasons.has(stopReasons.get(response) ?? "") &&
        !this.failure &&
        !lease.optional
      ) {
        this.failure = markRoutingTerminal(response);
        this.controller.abort(new DOMException("Stage scope stopped", "AbortError"));
      }
      if (this.failure) {
        if (response !== this.failure) void cancelRoutingResponse(response);
        return this.stopped()!;
      }
      if (fatalStageReasons.has(stopReasons.get(response) ?? "") && lease.optional)
        this.noteUncertain(lease, stopReasons.get(response)!);
      return this.observe(response, lease);
    } catch (error) {
      const cancelled = this.owner.signal()?.aborted || (error as Error)?.name === "AbortError";
      if (lease.optional && !this.owner.signal()?.aborted)
        this.noteUncertain(lease, "stage_execution_uncertain");
      else
        this.fail(
          cancelled ? "request_cancelled" : "stage_execution_uncertain",
          cancelled ? 499 : 502
        );
      throw error;
    }
  }
  async branch(
    body: Record<string, unknown>,
    model: string,
    target: SingleModelTarget | undefined,
    run: (dispatch: HandleSingleModel) => Promise<Response>
  ): Promise<Response> {
    const permit = this.permit(target, body, model);
    if (!permit) return this.fail("stage_identity_missing");
    if (permit.lease.branchUsed) return this.fail("stage_reentry_blocked");
    permit.lease.branchUsed = true;
    const lease = permit.lease;
    const signal = AbortSignal.any(
      [
        this.owner.signal(),
        target?.modelAbortSignal,
        this.controller.signal,
        lease.controller.signal,
      ].filter(Boolean) as AbortSignal[]
    );
    const child = lease.guard.fork(
      body,
      100,
      {
        beforeAttempt: () => (lease.guard.terminal()?.ok === false ? lease.guard.terminal() : null),
      },
      signal
    );
    return run(child.wrap(this.raw));
  }
  finish(response: Response): Response {
    this.finished = true;
    const result = this.stopped() ?? response;
    if (result !== response) void cancelRoutingResponse(response);
    // Internal stage output is not client output, but it prohibits replaying the
    // whole composite through a sibling parent target after any stage work.
    let output = result;
    const uncertain = [...this.leases.values()].filter((lease) => lease.uncertain).length;
    const headers = new Headers(result.headers);
    if (uncertain) {
      // Diagnostic only; this header cannot grant replay or admission authority.
      headers.set("X-OmniRoute-Stage-Execution", "partial_uncertain");
      headers.set("X-OmniRoute-Uncertain-Stages", String(uncertain));
    }
    if (result.body && result.ok) {
      const reader = result.body.getReader();
      const scope = this;
      output = inheritRoutingResponseState(
        result,
        new Response(
          new ReadableStream({
            async pull(controller) {
              try {
                const item = await reader.read();
                if (scope.failure) throw new Error("Composite execution stopped");
                if (item.done) controller.close();
                else controller.enqueue(item.value);
              } catch (error) {
                scope.fail("stage_body_execution_uncertain");
                controller.error(error);
              }
            },
            cancel(reason) {
              scope.fail("request_cancelled", 499);
              return reader.cancel(reason).catch(() => {});
            },
          }),
          { status: result.status, statusText: result.statusText, headers }
        )
      );
    } else if (uncertain) {
      output = inheritRoutingResponseState(
        result,
        new Response(result.body, { status: result.status, statusText: result.statusText, headers })
      );
    }
    if (this.started || response.ok) return this.owner.finish(output, "composite_complete");
    this.owner.releaseCompositeWithoutWork();
    return output;
  }
}

export function createRoutingStageScope(
  owner: ReturnType<typeof createRoutingAttemptGuard>,
  dispatch: HandleSingleModel
) {
  return new RoutingStageScope(owner, dispatch);
}
export function runRoutingStage(
  handle: HandleSingleModel,
  id: string,
  body: Record<string, unknown>,
  model: string,
  target?: SingleModelTarget,
  maxAttempts = 1,
  optionalIndependent = false
): Promise<Response> {
  return (
    stageScopes
      .get(handle)
      ?.call(handle, id, body, model, target, maxAttempts, optionalIndependent) ??
    handle(body, model, target)
  );
}
export function runRoutingStageBranch(
  handle: HandleSingleModel,
  body: Record<string, unknown>,
  model: string,
  target: SingleModelTarget | undefined,
  run: (dispatch: HandleSingleModel) => Promise<Response>
): Promise<Response> {
  const scope = stageScopes.get(handle);
  return scope ? scope.branch(body, model, target, run) : run(handle);
}
export function routingStageFailure(handle: HandleSingleModel): Response | null {
  return stageScopes.get(handle)?.stopped() ?? null;
}
export function failRoutingStage(
  handle: HandleSingleModel,
  code: string,
  status = 502
): Response | null {
  return stageScopes.get(handle)?.fail(code, status) ?? null;
}
export function stopRoutingStage(handle: HandleSingleModel, id: string, reason?: string): void {
  stageScopes.get(handle)?.stopStage(id, reason);
}
