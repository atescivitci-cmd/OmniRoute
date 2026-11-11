/** Safe, prompt-free native dispatch evidence. Legacy/unknown metadata is neutral. */
export type DeadlineRequestClass = {
  version: 1;
  format: "json_schema" | "json_object";
  maxTokens: number;
  effort: string | null;
  inputSizeBand: number;
};

export type NativeDispatchObservation =
  | { version: 1; observed: false; reason?: string }
  | {
      version: 1;
      observed: true;
      dispatchCount: 1;
      endpointIdentity: string;
      requestClass: DeadlineRequestClass;
      nativeControls: Record<string, string | number | boolean>;
      dispatchedAt: number;
      deadlineAt: number;
      declaredBudgetMs: number;
      observedAt: number;
      elapsedMs: number;
      remainingAtDispatchMs: number;
      abortObservedAt?: number;
      fetchRejectedAt?: number;
    };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const inputBandCharacters = 8192;

/** Input bands contain no text, hashes, names, URLs, prompts or schema contents. */
export function buildDeadlineRequestClass(body: unknown): DeadlineRequestClass | null {
  if (!record(body) || body.stream !== false) return null;
  for (const key of [
    "tools",
    "functions",
    "tool_choice",
    "function_call",
    "audio",
    "modalities",
    "images",
    "image",
    "video",
  ]) {
    if (Object.hasOwn(body, key) && body[key] !== undefined) return null;
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 1000)
    return null;
  for (const message of body.messages) {
    if (
      !record(message) ||
      !["system", "developer", "user", "assistant"].includes(String(message.role))
    )
      return null;
    if (message.tool_calls || message.function_call) return null;
    const content = message.content;
    if (typeof content === "string") continue;
    if (
      !Array.isArray(content) ||
      !content.every(
        (part) => record(part) && part.type === "text" && typeof part.text === "string"
      )
    )
      return null;
  }
  const format = record(body.response_format) ? body.response_format.type : undefined;
  if (format !== "json_schema" && format !== "json_object") return null;
  const caps = [body.max_tokens, body.max_completion_tokens].filter((value) => value !== undefined);
  if (
    !caps.length ||
    caps.some(
      (value) =>
        typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 1000000
    )
  )
    return null;
  if (new Set(caps).size !== 1) return null;
  const carriers = [
    body.reasoning_effort,
    record(body.reasoning) ? body.reasoning.effort : undefined,
    record(body.output_config) ? body.output_config.effort : undefined,
  ].filter((value) => value !== undefined);
  if (carriers.some((value) => typeof value !== "string" || !efforts.has(value.toLowerCase())))
    return null;
  const normalizedEfforts = carriers.map((value) => String(value).toLowerCase());
  if (new Set(normalizedEfforts).size > 1) return null;
  let inputCharacters: number;
  try {
    inputCharacters = JSON.stringify({
      messages: body.messages,
      response_format: body.response_format,
    }).length;
  } catch {
    return null;
  }
  if (inputCharacters > 1000000) return null;
  return {
    version: 1,
    format,
    maxTokens: caps[0] as number,
    effort: normalizedEfforts[0] ?? null,
    inputSizeBand: Math.max(1, Math.ceil(inputCharacters / inputBandCharacters)),
  };
}

function validClass(value: unknown): value is DeadlineRequestClass {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "effort,format,inputSizeBand,maxTokens,version"
  )
    return false;
  return (
    value.version === 1 &&
    ["json_schema", "json_object"].includes(String(value.format)) &&
    typeof value.maxTokens === "number" &&
    Number.isSafeInteger(value.maxTokens) &&
    value.maxTokens > 0 &&
    value.maxTokens <= 1000000 &&
    (value.effort === null || (typeof value.effort === "string" && efforts.has(value.effort))) &&
    typeof value.inputSizeBand === "number" &&
    Number.isSafeInteger(value.inputSizeBand) &&
    value.inputSizeBand >= 1 &&
    value.inputSizeBand <= Math.ceil(1000000 / inputBandCharacters)
  );
}

export function sameDeadlineRequestClass(a: unknown, b: unknown): boolean {
  return (
    validClass(a) &&
    validClass(b) &&
    a.version === b.version &&
    a.format === b.format &&
    a.maxTokens === b.maxTokens &&
    a.effort === b.effort &&
    a.inputSizeBand === b.inputSizeBand
  );
}

/** Restrict endpoint evidence to standard inference paths and omit no URL secrets. */
export function deadlineEndpointIdentity(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    value.includes("?") ||
    value.includes("#")
  )
    return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const pathname = url.pathname.replace(/\/$/, "");
    if (
      ![
        "/v1/chat/completions",
        "/chat/completions",
        "/v1/messages",
        "/messages",
        "/v1/responses",
        "/responses",
      ].includes(pathname)
    )
      return null;
    return url.origin + pathname;
  } catch {
    return null;
  }
}

/** Native controls are separate from original generic effort and never contain body text. */
export function nativeDeadlineControls(body: unknown): Record<string, string | number | boolean> {
  if (!record(body)) return {};
  const result: Record<string, string | number | boolean> = {};
  if (typeof body.reasoning_effort === "string" && efforts.has(body.reasoning_effort))
    result.reasoningEffort = body.reasoning_effort;
  if (
    record(body.chat_template_kwargs) &&
    typeof body.chat_template_kwargs.enable_thinking === "boolean"
  )
    result.enableThinking = body.chat_template_kwargs.enable_thinking;
  for (const [name, value] of [
    ["reasoningBudget", body.reasoning_budget],
    ["thinkingTokenBudget", body.thinking_token_budget],
    [
      "nestedReasoningBudget",
      record(body.chat_template_kwargs) ? body.chat_template_kwargs.reasoning_budget : undefined,
    ],
  ] as const) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= -1 && value <= 1000000)
      result[name] = value;
  }
  if (
    record(body.thinking) &&
    ["enabled", "disabled", "adaptive"].includes(String(body.thinking.type))
  )
    result.thinkingType = String(body.thinking.type);
  return result;
}
