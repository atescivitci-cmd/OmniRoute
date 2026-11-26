/**
 * Failover on a provider OVERLOAD refusal for tool requests (ROUTING_OVERLOAD_FAILOVER, default
 * off). Owner-approved 2026-11-26 ("Yes, build and ship").
 *
 * Live 2026-11-26 19:28Z: streaming /v1/messages tool requests routed to gemini/gemini-3.5-flash
 * got HTTP 503 "This model is currently experiencing high demand. Spikes in demand are usually
 * temporary. Please try again later. (reset after 3s)". The routing replay-safety guard stops a
 * tool request on any 5xx (tool_replay_unqualified), so the client got `event: error`; only a 429
 * may move on (TOOL_RATE_LIMIT_FAILOVER_V1).
 *
 * Why an overload refusal is as safe as a 429: it is admission control before generation. The
 * provider refused the request outright with an error status; it produced no output, so no tool
 * call was generated, and tools run on the client in this deployment, so nothing can have
 * executed. The only cost of trying another target is the one refused request.
 *
 * The classification is deliberately tight (classifyOverloadRefusal). A generic 503 with no
 * overload signal is NOT an overload: it can be a proxy or a crashed backend that may have done
 * work. 502 and 504 are gateway and timeout statuses that can follow partial execution, so they
 * qualify only with an explicit overload code or phrase, never on a retry hint or "try again
 * later" alone. 529 is Anthropic's dedicated overloaded status and qualifies by itself.
 */
export const ROUTING_OVERLOAD_FAILOVER_ENV = "ROUTING_OVERLOAD_FAILOVER";
/**
 * Overload failovers per request. An overload refusal comes back in seconds, so the cost of one
 * more try is small, but every refused target is a request the provider counted; two covers a
 * provider-wide spike (two overloaded models in a row) without walking a whole combo of refusals.
 * Counted on the attempt budget every forked/staged guard shares, on top of the normal attempt
 * limit that still applies.
 */
export const MAX_OVERLOAD_FAILOVERS_PER_REQUEST = 2;

export function isOverloadFailoverEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = (env[ROUTING_OVERLOAD_FAILOVER_ENV] ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

// Structured codes / types / statuses that mean "overloaded, refused at admission".
const OVERLOAD_STRUCTURED = new Set([
  "overloaded_error", // Anthropic
  "overloaded",
  "server_overloaded", // OpenAI
  "engine_overloaded", // OpenAI (legacy)
  "model_overloaded",
  "capacity_exceeded",
  "unavailable", // Google RPC status UNAVAILABLE (503)
  "resource_exhausted", // Google RPC status RESOURCE_EXHAUSTED
]);
// Phrases that name overload / capacity explicitly.
const OVERLOAD_PHRASE =
  /\b(?:high demand|overloaded|over capacity|at capacity|capacity (?:issue|issues|limit|limits|constraint|constraints|exceeded)|insufficient capacity|temporarily overloaded)\b/i;
// A weaker phrase, accepted only on 503 (never on 502/504).
const RETRY_LATER_PHRASE = /\btry again later\b/i;

export type OverloadInput = {
  status: number;
  /** Raw upstream error body (string or parsed object), when it was read. */
  body?: unknown;
  /** Parsed upstream error message. */
  message?: unknown;
  errorCode?: unknown;
  errorType?: unknown;
  /** Retry hint from the upstream (Retry-After header or a parsed "reset after Ns"), in ms. */
  retryAfterMs?: number | null;
};

export type OverloadClassification = { overload: true; signal: string } | { overload: false };

function collectStructured(body: unknown, into: string[]): void {
  let value = body;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 3) return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, depth + 1));
      return;
    }
    const row = node as Record<string, unknown>;
    for (const key of ["type", "code", "status", "reason"]) {
      if (typeof row[key] === "string") into.push(row[key] as string);
    }
    visit(row.error, depth + 1);
    visit(row.details, depth + 1);
  };
  visit(value, 0);
}

function textOf(input: OverloadInput): string {
  const parts: string[] = [];
  if (typeof input.message === "string") parts.push(input.message);
  if (typeof input.body === "string") parts.push(input.body);
  else if (input.body && typeof input.body === "object") {
    try {
      parts.push(JSON.stringify(input.body));
    } catch {
      /* unserialisable body: rely on the message */
    }
  }
  return parts.join(" ").slice(0, 8192);
}

/**
 * Is this upstream error an overload refusal made before any output? Only error statuses reach
 * here; a 2xx (including a stream that later carried an error event) is never one.
 */
export function classifyOverloadRefusal(input: OverloadInput): OverloadClassification {
  const status = input.status;
  if (![502, 503, 504, 529].includes(status)) return { overload: false };
  if (status === 529) return { overload: true, signal: "status_529" };

  const structured: string[] = [];
  // Upstream parsers may hand over numbers (e.g. code 503); only strings are codes here.
  if (typeof input.errorCode === "string") structured.push(input.errorCode);
  if (typeof input.errorType === "string") structured.push(input.errorType);
  collectStructured(input.body, structured);
  const code = structured.find((value) => OVERLOAD_STRUCTURED.has(value.trim().toLowerCase()));
  if (code) return { overload: true, signal: `code:${code.trim().toLowerCase()}` };

  const text = textOf(input);
  const phrase = text.match(OVERLOAD_PHRASE);
  if (phrase) return { overload: true, signal: `phrase:${phrase[0].toLowerCase()}` };

  if (status !== 503) return { overload: false }; // 502/504: explicit overload only
  if (typeof input.retryAfterMs === "number" && input.retryAfterMs > 0)
    return { overload: true, signal: "retry_hint" };
  if (RETRY_LATER_PHRASE.test(text)) return { overload: true, signal: "phrase:try again later" };
  return { overload: false };
}

export type OverloadFailoverCheck = {
  enabled: boolean;
  /** Condition 1+2: chatCore classified the pre-output upstream error as an overload refusal. */
  overloadMarked: boolean;
  /** Condition 3: no response for this request has been committed to the client. */
  responseCommitted: boolean;
  /** The transport was stopped (cancelled / uncertain / blocked): not a clean refusal. */
  transportStopped: boolean;
  /** Condition 4. */
  providerExecutedTools: boolean;
  hardBound: boolean;
  providerBound: boolean;
  sanitizedSwitch: boolean;
  /** The NVIDIA no-safe-fallback rule applies to 429 too; an overload gets no more than a 429. */
  nvidiaUnqualified: boolean;
  failoversUsed: number;
  callerAborted: boolean;
};

/** null when the overload failover is allowed, otherwise the first reason it is not. */
export function overloadFailoverRefusal(check: OverloadFailoverCheck): string | null {
  if (!check.enabled) return "overload_failover_disabled";
  if (!check.overloadMarked) return "not_overload_refusal";
  if (check.transportStopped) return "transport_stopped";
  if (check.responseCommitted) return "response_committed";
  if (check.callerAborted) return "caller_aborted";
  if (check.hardBound || check.providerExecutedTools) return "provider_executed_tools";
  if (check.providerBound && !check.sanitizedSwitch) return "provider_bound_unsanitized";
  if (check.nvidiaUnqualified) return "nvidia_no_safe_fallback";
  if (check.failoversUsed >= MAX_OVERLOAD_FAILOVERS_PER_REQUEST) return "overload_failover_budget";
  return null;
}
