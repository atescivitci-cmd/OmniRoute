// Provider-aware reasoning_effort sanitation (xhigh/max normalization + reject strip).
// Extracted verbatim from base.ts. Deps are config/services only (no host import → no cycle).
import { PROVIDER_CLAUDE } from "../../services/systemTransforms.ts";
import { isClaudeCodeCompatible } from "../../services/provider.ts";
import { supportsClaudeMaxEffort, supportsXHighEffort } from "../../config/providerModels.ts";
import {
  noThinkingIntent,
  noThinkingHandling,
  omitNoThinkingControls,
  declaredThinkingEfforts,
} from "../../services/reasoningEffortCompatibility.ts";

/**
 * Sanitize reasoning_effort for providers that don't accept all values.
 *
 * The claude→openai translator may emit reasoning_effort=max/xhigh when the
 * client sends output_config.effort=max on a Claude-shape request. Combined with
 * runtime alias remapping (e.g. claude-opus-4-6 → mimo/mimo-v2.5-pro), this
 * routes xhigh to OpenAI-shape providers that don't accept the value:
 *
 *   xiaomi-mimo : low|medium|high only — 400 literal_error on xhigh
 *   mistral     : devstral models reject reasoning_effort entirely
 *   github      : claude/haiku/oswe models reject reasoning_effort entirely
 *
 * Each rejection burns a combo fallback attempt before reaching a working
 * provider. Apply provider-aware sanitation here (after transformRequest, so
 * reintroductions by per-provider transforms are also caught) before fetch.
 * xhigh support is opt-out: pass through unchanged unless the registry marks
 * a model as unsupported. Literal max support is provider-specific and
 * intentionally separate: some upstreams accept max even when they do not
 * accept xhigh. For OpenAI-shape providers, max normalizes to xhigh by default
 * and falls back to high only for explicit xhigh opt-outs.
 */
export const MISTRAL_NO_REASONING_EFFORT_PATTERN = /devstral/i;
// GitHub Copilot Claude routing is granular (upstream port: decolua/9router#791):
//   ✅ Pass through — Claude Opus 4.6, Claude Sonnet 4.6. Copilot routes both to
//      Anthropic's chat/completions surface, which honors reasoning_effort and
//      emits visible reasoning tokens (verified upstream: 3× token increase
//      between low/medium/high).
//   ❌ Strip — Claude Haiku 4.5 and Claude Opus 4.7 (rejected upstream by
//      Copilot's Claude backend), older Claude variants, all `haiku`-named
//      models, and the `oswe-*` family (Raptor) which still rejects
//      reasoning_effort.
// Order matters: the opt-in check must run BEFORE the broad Claude/haiku/oswe strip.
export const GITHUB_REASONING_EFFORT_OPT_IN_PATTERN = /claude[-_.]?(?:opus|sonnet)[-_.]?4[-_.]6/i;
export const GITHUB_NO_REASONING_EFFORT_PATTERN = /(claude|haiku|oswe)/i;
const NVIDIA_GLM_52_PATTERN = /z-ai\/glm-5\.2\b/i;
const NVIDIA_NEMOTRON_OMNI_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const NVIDIA_NEMOTRON_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type ReasoningSanitizeLog = {
  info?: (tag: string, msg: string) => void;
};

function isNvidiaGlm52(provider: string, model: string | undefined): boolean {
  return provider === "nvidia" && NVIDIA_GLM_52_PATTERN.test(model || "");
}

function isNvidiaMistralLarge4(provider: string, model: string | undefined): boolean {
  return provider === "nvidia" && model === "mistralai/mistral-large-4-1t-a52b";
}

/** Exact hosted recipe accepts only none/high; enable_thinking is ignored upstream.
 * https://docs.api.nvidia.com/nim/reference/mistralai-mistral-large-4-1t-a52b-infer
 * Do not silently drop reasoning, invent a token budget, or affect other models.
 */
function mapNvidiaMistralLarge4ReasoningParams(
  b: Record<string, unknown>
): Record<string, unknown> {
  for (const key of ["reasoning", "output_config", "chat_template_kwargs", "thinking"]) {
    if (hasOwn(b, key) && !isRecord(b[key]))
      throw new TypeError(`NVIDIA Mistral Large 4: ${key} must be an object`);
  }
  const c = readEffortCarriers(b);
  const values: string[] = [];
  for (const [present, value] of [
    [c.hasTopLevelReasoningEffort, b.reasoning_effort],
    [c.hasReasoningEffort, c.reasoning?.effort],
    [c.hasOutputConfigEffort, c.outputConfig?.effort],
  ] as const) {
    if (!present) continue;
    if (value !== "none" && value !== "high")
      throw new TypeError(
        "NVIDIA Mistral Large 4: unsupported reasoning effort; expected none or high"
      );
    values.push(value);
  }
  const template = isRecord(b.chat_template_kwargs) ? b.chat_template_kwargs : null;
  if (template && hasOwn(template, "enable_thinking")) {
    if (typeof template.enable_thinking !== "boolean")
      throw new TypeError("NVIDIA Mistral Large 4: enable_thinking must be boolean");
    values.push(template.enable_thinking ? "high" : "none");
  }
  const thinking = isRecord(b.thinking) ? b.thinking : null;
  if (thinking) {
    if (thinking.type === "adaptive" || thinking.type === "enabled") values.push("high");
    else if (thinking.type === "disabled") values.push("none");
    else throw new TypeError("NVIDIA Mistral Large 4: unsupported thinking type");
  }
  if (
    [b, template, thinking, c.reasoning].some(
      (record) =>
        record &&
        ["thinking_token_budget", "reasoning_budget", "budget_tokens"].some((key) =>
          hasOwn(record, key)
        )
    )
  ) {
    throw new TypeError("NVIDIA Mistral Large 4: explicit reasoning token budgets are unsupported");
  }
  if (new Set(values).size > 1)
    throw new TypeError("NVIDIA Mistral Large 4: conflicting reasoning controls");
  if (values.length === 0) return b;
  const next = stripEffortValue(b, c);
  next.reasoning_effort = values[0];
  if (thinking) delete next.thinking;
  if (template && hasOwn(template, "enable_thinking")) {
    const remaining = { ...template };
    delete remaining.enable_thinking;
    if (Object.keys(remaining).length) next.chat_template_kwargs = remaining;
    else delete next.chat_template_kwargs;
  }
  return next;
}

function isNvidiaNemotronOmni(provider: string, model: string | undefined): boolean {
  return provider === "nvidia" && model === NVIDIA_NEMOTRON_OMNI_MODEL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Bounded structured reasoning uses the existing 20% request-level default.
 * `thinking_token_budget` remains the self-hosted internal/native carrier here;
 * DefaultExecutor maps it to `reasoning_budget` only for NVIDIA's exact hosted
 * endpoint. Hosted API acceptance and response quality require live qualification.
 */
function nemotronStructuredThinkingBudget(maxTokens: unknown): number | null {
  if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    return null;
  }
  const budget = Math.min(512, Math.floor(maxTokens / 5));
  return budget > 0 ? budget : null;
}

function nemotronNativeBudgets(b: Record<string, unknown>): number[] {
  const template = isRecord(b.chat_template_kwargs) ? b.chat_template_kwargs : null;
  const values: number[] = [];
  for (const [present, value, legacy] of [
    [hasOwn(b, "thinking_token_budget"), b.thinking_token_budget, true],
    [hasOwn(b, "reasoning_budget"), b.reasoning_budget, false],
    [!!template && hasOwn(template, "reasoning_budget"), template?.reasoning_budget, false],
  ] as const) {
    if (!present) continue;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      (legacy ? value <= 0 : value < -1 || value > 32768)
    ) {
      throw new TypeError("NVIDIA Nemotron: invalid native reasoning budget");
    }
    values.push(value);
  }
  if (new Set(values).size > 1)
    throw new TypeError("NVIDIA Nemotron: conflicting native reasoning budgets");
  return values;
}

/** Hosted endpoint uses reasoning_budget; local NIM/vLLM use a different carrier. */
export function normalizeNvidiaHostedReasoningBudget(
  body: unknown,
  provider: string,
  model: string | undefined,
  endpointUrl: string
): unknown {
  if (!isNvidiaNemotronOmni(provider, model) || !isRecord(body)) return body;
  let hosted = false;
  try {
    const url = new URL(endpointUrl);
    hosted =
      url.origin === "https://integrate.api.nvidia.com" &&
      url.pathname.replace(/\/$/, "") === "/v1/chat/completions" &&
      !url.username &&
      !url.password;
  } catch {}
  if (!hosted) return body;
  const values = nemotronNativeBudgets(body);
  if (values.some((value) => value > 32768))
    throw new TypeError("NVIDIA Nemotron: hosted reasoning budget exceeds 32768");
  if (!hasOwn(body, "thinking_token_budget")) return body;
  const next = { ...body };
  delete next.thinking_token_budget;
  const template = isRecord(body.chat_template_kwargs) ? body.chat_template_kwargs : null;
  if (!hasOwn(body, "reasoning_budget") && !(template && hasOwn(template, "reasoning_budget")))
    next.reasoning_budget = body.thinking_token_budget;
  return next;
}

function mapNvidiaNemotronOmniReasoningParams(
  b: Record<string, unknown>,
  log?: ReasoningSanitizeLog | null
): Record<string, unknown> {
  for (const key of ["reasoning", "output_config", "chat_template_kwargs"] as const) {
    if (hasOwn(b, key) && !isRecord(b[key])) {
      throw new TypeError(`NVIDIA Nemotron: ${key} must be an object`);
    }
  }

  const c = readEffortCarriers(b);
  const efforts: string[] = [];
  for (const [present, raw] of [
    [c.hasTopLevelReasoningEffort, b.reasoning_effort],
    [c.hasReasoningEffort, c.reasoning?.effort],
    [c.hasOutputConfigEffort, c.outputConfig?.effort],
  ] as const) {
    if (!present) continue;
    if (typeof raw !== "string" || !NVIDIA_NEMOTRON_EFFORTS.has(raw.toLowerCase())) {
      throw new TypeError("NVIDIA Nemotron: invalid reasoning effort");
    }
    efforts.push(raw.toLowerCase());
  }
  if (new Set(efforts).size > 1) {
    throw new TypeError("NVIDIA Nemotron: conflicting reasoning efforts");
  }

  const templateKwargs = b.chat_template_kwargs as Record<string, unknown> | undefined;
  const hasNativeSwitch = !!templateKwargs && hasOwn(templateKwargs, "enable_thinking");
  const nativeSwitch = templateKwargs?.enable_thinking;
  if (hasNativeSwitch && typeof nativeSwitch !== "boolean") {
    throw new TypeError("NVIDIA Nemotron: enable_thinking must be boolean");
  }
  const nativeBudgets = nemotronNativeBudgets(b);
  const hasNativeBudget = nativeBudgets.length > 0;

  const effort = efforts[0];
  const requestedThinking = effort === undefined ? undefined : effort !== "none";
  if (
    (requestedThinking !== undefined && hasNativeSwitch && nativeSwitch !== requestedThinking) ||
    ((requestedThinking === false || nativeSwitch === false) &&
      nativeBudgets.some((value) => value !== 0))
  ) {
    throw new TypeError("NVIDIA Nemotron: conflicting thinking controls");
  }

  let next = efforts.length > 0 ? stripEffortValue(b, c) : b;
  if (requestedThinking !== undefined && !hasNativeSwitch) {
    next = {
      ...next,
      chat_template_kwargs: { ...templateKwargs, enable_thinking: requestedThinking },
    };
  }

  const responseFormat = b.response_format;
  const structured =
    isRecord(responseFormat) &&
    (responseFormat.type === "json_object" || responseFormat.type === "json_schema");
  if (requestedThinking !== false && !hasNativeSwitch && !hasNativeBudget && structured) {
    const budget = nemotronStructuredThinkingBudget(b.max_tokens);
    if (budget !== null) next = { ...next, thinking_token_budget: budget };
  }

  if (next !== b) {
    log?.info?.(
      "REASONING_SANITIZE",
      `nvidia/${NVIDIA_NEMOTRON_OMNI_MODEL}: mapped request-scoped thinking controls`
    );
  }
  return next;
}

type NvidiaGlm52EffortInfo = {
  reasoning: Record<string, unknown> | null;
  effortStr: string;
};

/** Pulls a normalized (lowercased) effort string out of top-level or nested `reasoning.effort`. */
function extractNvidiaGlm52Effort(b: Record<string, unknown>): NvidiaGlm52EffortInfo | null {
  const reasoning =
    b.reasoning && typeof b.reasoning === "object" && !Array.isArray(b.reasoning)
      ? (b.reasoning as Record<string, unknown>)
      : null;
  const effort = b.reasoning_effort ?? reasoning?.effort;
  if (effort === undefined) return null;

  const effortStr = typeof effort === "string" ? effort.toLowerCase() : "";
  if (!effortStr) return null;

  return { reasoning, effortStr };
}

/** Builds `chat_template_kwargs.enable_thinking`, or null when the existing kwargs shape is unusable. */
function buildNvidiaGlm52TemplateKwargs(
  rawTemplateKwargs: unknown,
  effortStr: string
): Record<string, unknown> | null {
  if (
    rawTemplateKwargs !== undefined &&
    (!rawTemplateKwargs ||
      typeof rawTemplateKwargs !== "object" ||
      Array.isArray(rawTemplateKwargs))
  ) {
    return null;
  }

  const templateKwargs = {
    ...((rawTemplateKwargs as Record<string, unknown> | undefined) ?? {}),
  };
  if (!Object.prototype.hasOwnProperty.call(templateKwargs, "enable_thinking")) {
    templateKwargs.enable_thinking = effortStr !== "none";
  }
  return templateKwargs;
}

/** Returns a copy of `b` with `reasoning_effort`/`reasoning.effort` replaced by `templateKwargs`. */
function withNvidiaGlm52TemplateKwargs(
  b: Record<string, unknown>,
  templateKwargs: Record<string, unknown>,
  reasoning: Record<string, unknown> | null
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...b, chat_template_kwargs: templateKwargs };
  delete next.reasoning_effort;
  if (reasoning) {
    const nextReasoning = { ...reasoning };
    delete nextReasoning.effort;
    if (Object.keys(nextReasoning).length === 0) delete next.reasoning;
    else next.reasoning = nextReasoning;
  }
  return next;
}

/**
 * Map OmniRoute's reasoning-effort inputs onto NVIDIA's native thinking controls
 * for GLM-5.2 and the exact Nemotron 3 Nano Omni model. This runs before
 * DefaultExecutor's unsupported parameter stripping so nested effort is not
 * discarded first, and is reused by the final sanitizer for other paths.
 */
export function mapNvidiaGlm52ReasoningParams(
  body: unknown,
  provider: string,
  model: string | undefined,
  log?: ReasoningSanitizeLog | null
): unknown {
  if (isNvidiaMistralLarge4(provider, model)) {
    return isRecord(body) ? mapNvidiaMistralLarge4ReasoningParams(body) : body;
  }
  if (isNvidiaNemotronOmni(provider, model)) {
    if (!isRecord(body)) return body;
    return mapNvidiaNemotronOmniReasoningParams(body, log);
  }
  if (!isNvidiaGlm52(provider, model)) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const b = body as Record<string, unknown>;
  const info = extractNvidiaGlm52Effort(b);
  if (!info) return body;

  const templateKwargs = buildNvidiaGlm52TemplateKwargs(b.chat_template_kwargs, info.effortStr);
  if (!templateKwargs) return body;

  const next = withNvidiaGlm52TemplateKwargs(b, templateKwargs, info.reasoning);
  log?.info?.(
    "REASONING_SANITIZE",
    `nvidia/${model || ""}: mapped reasoning effort to enable_thinking`
  );
  return next;
}

export function supportsMaxEffortForProvider(provider: string, model: string): boolean {
  const isClaude =
    (provider === PROVIDER_CLAUDE || isClaudeCodeCompatible(provider)) &&
    supportsClaudeMaxEffort(model);
  // opencode-go proxies DeepSeek with the native DeepSeek API contract, which
  // accepts {high, max} literally. Without this opt-in, max would be
  // normalized to xhigh (the OmniRoute-internal top tier) and rejected by the
  // upstream. Scoped to opencode-go deliberately: OpenRouter's DeepSeek path
  // (pi#4055) is the documented inverse and expects xhigh, not max.
  // Ollama Cloud also accepts literal max (for example GLM 5.2 supports
  // low|medium|high|max|none) and rejects xhigh.
  const isOpencodeGoDeepSeek =
    provider === "opencode-go" && model.toLowerCase().includes("deepseek");
  const isOllamaCloud = provider === "ollama-cloud";
  const isMoonshotK3 =
    (provider === "moonshot" || provider === "kimi") && /^kimi-k3(?:$|-)/i.test(model);
  return isClaude || isOpencodeGoDeepSeek || isOllamaCloud || isMoonshotK3;
}

// ── Effort carrier helpers (#7044) ──────────────────────────────────────────
// OmniRoute carries the requested effort on up to three shapes:
//   1. top-level `reasoning_effort`        — OpenAI / OmniRoute-internal
//   2. `reasoning.effort`                  — OpenAI Responses shape
//   3. `output_config.effort`              — Anthropic Messages native (Claude Code / Claude passthrough)
// Carrier (3) was previously invisible to this sanitizer, so a native Claude request
// carrying `output_config.effort: "xhigh"` reached providers that don't accept xhigh
// (e.g. claude-sonnet-4-6, supportsXHighEffort=false) unchanged → HTTP 400 (#7044).
interface EffortCarriers {
  reasoning: Record<string, unknown> | null;
  outputConfig: Record<string, unknown> | null;
  hasTopLevelReasoningEffort: boolean;
  hasReasoningEffort: boolean;
  hasOutputConfigEffort: boolean;
  effort: unknown;
}

function readEffortCarriers(b: Record<string, unknown>): EffortCarriers {
  const reasoning =
    b.reasoning && typeof b.reasoning === "object" && !Array.isArray(b.reasoning)
      ? (b.reasoning as Record<string, unknown>)
      : null;
  const outputConfig =
    b.output_config && typeof b.output_config === "object" && !Array.isArray(b.output_config)
      ? (b.output_config as Record<string, unknown>)
      : null;
  const hasTopLevelReasoningEffort = Object.prototype.hasOwnProperty.call(b, "reasoning_effort");
  const hasReasoningEffort = !!(
    reasoning && Object.prototype.hasOwnProperty.call(reasoning, "effort")
  );
  const hasOutputConfigEffort = !!(
    outputConfig && Object.prototype.hasOwnProperty.call(outputConfig, "effort")
  );
  const effort = b.reasoning_effort ?? reasoning?.effort ?? outputConfig?.effort;
  return {
    reasoning,
    outputConfig,
    hasTopLevelReasoningEffort,
    hasReasoningEffort,
    hasOutputConfigEffort,
    effort,
  };
}

/** Write a normalized effort value back to every carrier that was present. */
function writeEffortValue(
  b: Record<string, unknown>,
  value: string,
  c: EffortCarriers
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...b };
  if (c.hasTopLevelReasoningEffort) next.reasoning_effort = value;
  if (c.hasReasoningEffort && c.reasoning) next.reasoning = { ...c.reasoning, effort: value };
  if (c.hasOutputConfigEffort && c.outputConfig)
    next.output_config = { ...c.outputConfig, effort: value };
  return next;
}

/** Strip the effort field from every carrier that was present. */
function stripEffortValue(b: Record<string, unknown>, c: EffortCarriers): Record<string, unknown> {
  const next: Record<string, unknown> = { ...b };
  if (c.hasTopLevelReasoningEffort) delete next.reasoning_effort;
  if (c.hasReasoningEffort && c.reasoning) {
    const r: Record<string, unknown> = { ...c.reasoning };
    delete r.effort;
    if (Object.keys(r).length === 0) delete next.reasoning;
    else next.reasoning = r;
  }
  if (c.hasOutputConfigEffort && c.outputConfig) {
    const oc: Record<string, unknown> = { ...c.outputConfig };
    delete oc.effort;
    if (Object.keys(oc).length === 0) delete next.output_config;
    else next.output_config = oc;
  }
  return next;
}

export function sanitizeReasoningEffortForProvider(
  body: unknown,
  provider: string,
  model: string | undefined,
  log?: ReasoningSanitizeLog | null,
  options: {
    finalDispatch?: boolean;
    deferNoThinkingMapping?: boolean;
    requiredNoThinking?: boolean;
  } = {}
): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>,
      intent = noThinkingIntent(
        options.requiredNoThinking ? { ...b, reasoning_effort: "none" } : b
      );
    const handling = intent.requested ? noThinkingHandling(provider, model || "") : null;
    if (intent.conflict) throw new TypeError("Conflicting explicit reasoning controls");
    // Native disabled defaults may be produced by translation. Only a generic
    // explicit request, or an endpoint with reviewed native handling, is judged here.
    if (intent.requested && (intent.genericRequested || handling !== null)) {
      if (handling === null && declaredThinkingEfforts(provider, model || "") !== null)
        throw new TypeError("Selected endpoint cannot verify requested reasoning effort none");
      if (
        handling === "native" &&
        options.requiredNoThinking &&
        !noThinkingIntent(b).genericRequested &&
        !noThinkingIntent(b).nativeDisabled
      )
        throw new TypeError(
          "Required reasoning effort none was removed by target parameter transformation"
        );
      if (handling === "omit" && options.finalDispatch) return omitNoThinkingControls(b);
      if (options.deferNoThinkingMapping) return b;
    }
  }
  if (
    isNvidiaGlm52(provider, model) ||
    isNvidiaNemotronOmni(provider, model) ||
    isNvidiaMistralLarge4(provider, model)
  ) {
    return mapNvidiaGlm52ReasoningParams(body, provider, model, log);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const c = readEffortCarriers(b);
  if (c.effort === undefined) return body;
  const effortStr = typeof c.effort === "string" ? c.effort.toLowerCase() : "";
  const modelStr = model || "";

  const githubOptIn =
    provider === "github" && GITHUB_REASONING_EFFORT_OPT_IN_PATTERN.test(modelStr);
  const rejecting =
    (provider === "mistral" && MISTRAL_NO_REASONING_EFFORT_PATTERN.test(modelStr)) ||
    (provider === "github" && !githubOptIn && GITHUB_NO_REASONING_EFFORT_PATTERN.test(modelStr));
  if (rejecting) {
    log?.info?.(
      "REASONING_SANITIZE",
      `${provider}/${modelStr}: removed unsupported reasoning_effort`
    );
    return stripEffortValue(b, c);
  }

  // Native DeepSeek (api.deepseek.com) — V4 thinking mode accepts reasoning_effort
  // ONLY as {high, max} (its own top tier is literally "max"). OmniRoute's internal
  // scale is low|medium|high|xhigh where xhigh is the top, so map onto DeepSeek's
  // vocabulary: xhigh → max (top→top), low|medium → high (below the enum floor).
  // high/max pass through unchanged. Without this, the claude→openai translator's
  // xhigh (and max-normalized-to-xhigh below) reaches DeepSeek as an unknown value,
  // silently dropping the client's requested effort. This is the INVERSE of the
  // OpenRouter-DeepSeek path, whose normalized API expects xhigh, not max (pi#4055).
  if (provider === "deepseek") {
    const mapped =
      effortStr === "xhigh" ? "max" : effortStr === "low" || effortStr === "medium" ? "high" : null;
    if (mapped && mapped !== effortStr) {
      log?.info?.(
        "REASONING_SANITIZE",
        `deepseek/${modelStr}: normalized reasoning_effort ${effortStr} → ${mapped}`
      );
      return writeEffortValue(b, mapped, c);
    }
    return body;
  }

  const supportsXHigh = supportsXHighEffort(provider, modelStr);
  const shouldDowngradeXHigh = effortStr === "xhigh" && !supportsXHigh;
  const supportsXHighForMax = supportsXHigh;
  const supportsMax = supportsMaxEffortForProvider(provider, modelStr);
  const shouldNormalizeMaxToXHigh = effortStr === "max" && !supportsMax && supportsXHighForMax;
  const shouldDowngradeMax = effortStr === "max" && !supportsMax && !supportsXHighForMax;

  if (shouldNormalizeMaxToXHigh) {
    log?.info?.(
      "REASONING_SANITIZE",
      `${provider}/${modelStr}: normalized reasoning_effort max → xhigh`
    );
    return writeEffortValue(b, "xhigh", c);
  }

  if (shouldDowngradeXHigh || shouldDowngradeMax) {
    log?.info?.(
      "REASONING_SANITIZE",
      `${provider}/${modelStr}: downgraded reasoning_effort ${effortStr} → high`
    );
    return writeEffortValue(b, "high", c);
  }

  return body;
}
