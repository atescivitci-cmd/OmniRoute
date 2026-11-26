/**
 * Failover after the gateway's OWN stall abort (ROUTING_STALL_FAILOVER, default off; meaningful
 * only with ROUTING_STALL_DEADLINE_MS set). Owner-approved 2026-11-26 ("Yes, allow retry").
 *
 * The routing replay-safety guard (routingAttemptSafety.ts, routingTransportContext.ts) refuses to
 * send a request to another target after an aborted in-flight fetch, after a 5xx on a tool request
 * and after an nvidia 5xx, because the first provider may already have executed something. This
 * module is the ONE narrow exception to those stops. A combo may advance only when ALL hold:
 *
 *   1. The attempt ended because the gateway's own stall deadline fired. Proven by identity: the
 *      response carries a process-local mark that only chatCore's stall paths set
 *      (markStallReplayCandidate), and a transport-level abort must be the trusted stall error
 *      (isUpstreamStalledError), never an error-string match.
 *   2. The gateway received no model output for that attempt: either no response headers at all
 *      (headers-phase stall), or headers plus only pings/comments (first-event-phase stall: stream
 *      readiness confirmed no non-ping event arrived). Headers-then-silence qualifies because
 *      headers carry no model output; no text, reasoning or tool_use event reached the gateway,
 *      so none can have reached the client.
 *   3. Nothing from this attempt was written to the client: chatCore holds the response until the
 *      first event, and the guard has not committed any response for this request.
 *   4. The request has no provider-executed (server-side) tools, in the tool list or in history.
 *      Only client-side tools are allowed: no `type`, `function` or `custom`. Anything else
 *      (Anthropic web_search_* / web_fetch_* / code_execution_* / computer_* / mcp, an
 *      `mcp_servers` connector, OpenAI Responses web_search / file_search / code_interpreter /
 *      computer_use / image_generation / mcp, or a server_tool_use / *_tool_result block in the
 *      history) blocks the exception. Unknown tool types are treated as provider-executed, and so
 *      is a typeless tool that declares no callable (Gemini googleSearch / codeExecution /
 *      url_context / google_search_retrieval). Also refused: the non-function keys of
 *      REPLAY_UNSAFE_TOP_LEVEL_KEYS (mcp_servers, tool_resources, web_search_options), OpenRouter
 *      `plugins`, xAI `search_parameters`, a Gemini tool_config beyond function calling, a
 *      Responses `background` run, and Gemini executableCode / codeExecutionResult history parts.
 *
 * Why this is safe in this deployment: tools run on the client. A stalled attempt delivered
 * nothing, so no tool call can have executed; the only cost of a replay is a possible duplicate
 * provider charge for a generation nobody received.
 *
 * Bounds: at most MAX_STALL_FAILOVERS_PER_REQUEST replays per request (counted on the attempt
 * budget every forked/staged guard shares), and the stalled model is
 * rejected on every connection for the rest of the request. A history bound to the stalled
 * provider (signed thinking / encrypted reasoning) may move on only when the combo sanitizes the
 * body before the next dispatch (the existing sanitized-switch path); otherwise the old stop
 * stands. Every other guard stop is unchanged.
 */
import { resolveRoutingStallDeadlineMs } from "../../handlers/chatCore/upstreamStall.ts";
import { REPLAY_UNSAFE_TOP_LEVEL_KEYS } from "./routingAttemptSafety.ts";

export const ROUTING_STALL_FAILOVER_ENV = "ROUTING_STALL_FAILOVER";
export const MAX_STALL_FAILOVERS_PER_REQUEST = 1;

/** On only when ROUTING_STALL_FAILOVER is truthy AND a stall deadline is configured. */
export function isStallFailoverEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = (env[ROUTING_STALL_FAILOVER_ENV] ?? "").trim().toLowerCase();
  if (!["1", "true", "yes", "on"].includes(raw)) return false;
  return resolveRoutingStallDeadlineMs(env) > 0;
}

const CLIENT_SIDE_TOOL_TYPES = new Set(["function", "custom"]);
// Top-level request keys that turn on a provider-executed capability (or provider-held state).
// The function-calling keys of REPLAY_UNSAFE_TOP_LEVEL_KEYS (tool_choice, function_call,
// parallel_tool_calls) only steer client-side tools and are not refused here; Gemini's
// tool_config / toolConfig is refused unless it only configures function calling.
// Computed on first use: routingAttemptSafety.ts imports this module, so its exports are not yet
// initialised while this module evaluates.
let providerCapabilityTopLevelKeys: string[] | null = null;
function getProviderCapabilityTopLevelKeys(): string[] {
  providerCapabilityTopLevelKeys ??= [
    ...REPLAY_UNSAFE_TOP_LEVEL_KEYS.filter(
      (key) =>
        ![
          "tool_choice",
          "function_call",
          "parallel_tool_calls",
          "tool_config",
          "toolConfig",
        ].includes(key)
    ),
    "plugins", // OpenRouter web/file plugins
    "search_parameters", // xAI live search
  ];
  return providerCapabilityTopLevelKeys;
}
const FUNCTION_ONLY_TOOL_CONFIG_KEYS = new Set([
  "functionCallingConfig",
  "function_calling_config",
]);
// Blocks in a conversation that only exist when the provider ran a tool itself.
const PROVIDER_TOOL_BLOCK = /^(server_tool_use|mcp_tool_use|mcp_tool_result|.+_tool_result)$/;
const PROVIDER_TOOL_CALL_ITEM =
  /^(web_search_call|file_search_call|code_interpreter_call|computer_call|image_generation_call|mcp_call|mcp_list_tools|mcp_approval_request)$/;
// Gemini history parts produced by provider-side code execution.
const PROVIDER_EXECUTION_PART_KEYS = [
  "executableCode",
  "codeExecutionResult",
  "executable_code",
  "code_execution_result",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when a tool definition is anything other than a plain client-executed tool. Client-side:
 * no `type` (or `function` / `custom`) AND it declares a callable the client runs: a `name`
 * (Anthropic custom, OpenAI Responses function), an OpenAI chat `function` object, or Gemini
 * `functionDeclarations`. A typeless object without any of those ({googleSearch: {}},
 * {codeExecution: {}}, {url_context: {}}, {google_search_retrieval: {...}}) is a provider
 * capability.
 */
function isProviderExecutedToolDefinition(tool: unknown): boolean {
  if (!isRecord(tool)) return true;
  const type = tool.type;
  if (type !== undefined && type !== null) {
    if (!(typeof type === "string" && CLIENT_SIDE_TOOL_TYPES.has(type))) return true;
  }
  const declaresCallable =
    (typeof tool.name === "string" && tool.name.length > 0) ||
    isRecord(tool.function) ||
    Array.isArray(tool.functionDeclarations) ||
    Array.isArray(tool.function_declarations);
  if (!declaresCallable) return true;
  // A Gemini tool entry may mix function declarations with built-ins in one object
  // ({functionDeclarations: [...], googleSearch: {}}). Name-based tools (Anthropic custom, OpenAI)
  // may carry provider metadata keys and are judged by their type and name only.
  const isGeminiEntry =
    Array.isArray(tool.functionDeclarations) || Array.isArray(tool.function_declarations);
  return (
    isGeminiEntry &&
    Object.keys(tool).some(
      (key) => !["functionDeclarations", "function_declarations"].includes(key)
    )
  );
}

/**
 * Whether the request asks the provider to execute any tool or capability itself, now or earlier
 * in the conversation, or to run it in the background. Conservative: anything not recognisably a
 * client-side function tool counts as provider-executed.
 */
export function hasProviderExecutedTools(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (Array.isArray(body.tools) && body.tools.some(isProviderExecutedToolDefinition)) return true;
  for (const key of getProviderCapabilityTopLevelKeys()) if (body[key] != null) return true;
  for (const key of ["tool_config", "toolConfig"]) {
    const config = body[key];
    if (config == null) continue;
    if (!isRecord(config)) return true;
    if (Object.keys(config).some((k) => !FUNCTION_ONLY_TOOL_CONFIG_KEYS.has(k))) return true;
  }
  // OpenAI Responses: a background run keeps executing provider-side after the client leaves.
  if (body.background === true) return true;
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some((child) => visit(child, depth + 1));
    const row = value as Record<string, unknown>;
    if (typeof row.type === "string") {
      if (row.type !== "tool_result" && PROVIDER_TOOL_BLOCK.test(row.type)) return true;
      if (PROVIDER_TOOL_CALL_ITEM.test(row.type)) return true;
    }
    if (PROVIDER_EXECUTION_PART_KEYS.some((key) => row[key] != null)) return true;
    for (const [key, child] of Object.entries(row)) {
      if (key === "tools") continue; // tool definitions are checked above, at the top level
      if (typeof child === "object" && visit(child, depth + 1)) return true;
    }
    return false;
  };
  for (const key of ["messages", "input", "contents"]) {
    if (visit(body[key], 0)) return true;
  }
  return false;
}

export type StallFailoverCheck = {
  enabled: boolean;
  /** Condition 1: the response carries chatCore's trusted stall mark. */
  stallMarked: boolean;
  /**
   * Condition 1 at the transport layer: when the attempt's transport was stopped, the stop is the
   * trusted stall abort and nothing else (no cancellation, no other failure, no refused redispatch).
   * `true` when the transport was not stopped at all.
   */
  transportClean: boolean;
  /** Condition 3: no response for this request has been committed to the client. */
  responseCommitted: boolean;
  /** Condition 4 inputs. */
  providerExecutedTools: boolean;
  hardBound: boolean;
  providerBound: boolean;
  sanitizedSwitch: boolean;
  /** Bound: replays already spent on this request. */
  failoversUsed: number;
  /** The caller (client) has gone away. */
  callerAborted: boolean;
};

/**
 * The exception predicate. Returns null when replay is allowed, otherwise the first reason it is
 * not (for diagnostics and tests). Condition 2 is enforced where the mark is set: chatCore marks
 * only a stall with no headers, or with headers and no non-ping event.
 */
export function stallFailoverRefusal(check: StallFailoverCheck): string | null {
  if (!check.enabled) return "stall_failover_disabled";
  if (!check.stallMarked) return "not_own_stall";
  if (!check.transportClean) return "transport_not_stall_only";
  if (check.responseCommitted) return "response_committed";
  if (check.callerAborted) return "caller_aborted";
  if (check.hardBound || check.providerExecutedTools) return "provider_executed_tools";
  if (check.providerBound && !check.sanitizedSwitch) return "provider_bound_unsanitized";
  if (check.failoversUsed >= MAX_STALL_FAILOVERS_PER_REQUEST) return "stall_failover_budget";
  return null;
}
