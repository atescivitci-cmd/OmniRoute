import { getRegistryEntry } from "../config/providerRegistry.ts";
import { getSyncedSupportedThinkingEfforts } from "../../src/lib/db/models.ts";

type Body = Record<string, unknown>;
const record = (x: unknown): x is Body => !!x && typeof x === "object" && !Array.isArray(x);
const own = (x: Body, key: string) => Object.prototype.hasOwnProperty.call(x, key);

/** Read every explicit carrier; one carrier cannot conceal a conflicting request. */
export function noThinkingIntent(body: Body): {
  requested: boolean;
  conflict: boolean;
  genericRequested: boolean;
  nativeDisabled: boolean;
} {
  const switches: boolean[] = [];
  let malformed = false;
  let genericRequested = false;
  let nativeDisabled = false;
  for (const key of ["reasoning", "output_config", "chat_template_kwargs"]) {
    if (own(body, key) && !record(body[key])) malformed = true;
  }
  for (const [present, value] of [
    [own(body, "reasoning_effort"), body.reasoning_effort],
    [
      record(body.reasoning) && own(body.reasoning, "effort"),
      record(body.reasoning) ? body.reasoning.effort : undefined,
    ],
    [
      record(body.output_config) && own(body.output_config, "effort"),
      record(body.output_config) ? body.output_config.effort : undefined,
    ],
  ] as const) {
    if (!present) continue;
    if (typeof value !== "string" || !value.trim()) malformed = true;
    else {
      const active = value.trim().toLowerCase() !== "none";
      switches.push(active);
      if (!active) genericRequested = true;
    }
  }
  if (record(body.thinking) && typeof body.thinking.type === "string") {
    if (body.thinking.type === "disabled") {
      switches.push(false);
      nativeDisabled = true;
    } else if (["enabled", "adaptive"].includes(body.thinking.type)) switches.push(true);
  }
  if (record(body.chat_template_kwargs) && own(body.chat_template_kwargs, "enable_thinking")) {
    if (typeof body.chat_template_kwargs.enable_thinking !== "boolean") malformed = true;
    else {
      switches.push(body.chat_template_kwargs.enable_thinking);
      if (!body.chat_template_kwargs.enable_thinking) nativeDisabled = true;
    }
  }
  for (const [present, value] of [
    [own(body, "thinking_token_budget"), body.thinking_token_budget],
    [
      record(body.thinking) && own(body.thinking, "budget_tokens"),
      record(body.thinking) ? body.thinking.budget_tokens : undefined,
    ],
  ] as const) {
    if (!present) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) malformed = true;
    else switches.push(true);
  }
  // Hosted NVIDIA's canonical budget can be zero (no reasoning) or -1 (unbounded).
  for (const [present, value] of [
    [own(body, "reasoning_budget"), body.reasoning_budget],
    [
      record(body.chat_template_kwargs) && own(body.chat_template_kwargs, "reasoning_budget"),
      record(body.chat_template_kwargs) ? body.chat_template_kwargs.reasoning_budget : undefined,
    ],
  ] as const) {
    if (!present) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1 || value > 32768)
      malformed = true;
    else switches.push(value !== 0);
  }
  // New admission concerns the generic promise. Native-only controls retain
  // their established adapter behavior; inspect them only for conflicts with it.
  const requested = genericRequested;
  return {
    requested,
    conflict: requested && (malformed || switches.includes(true)),
    genericRequested,
    nativeDisabled,
  };
}

/** Exact endpoint evidence only: no heuristic, leaf-name or cross-provider fallback. */
export function declaredThinkingEfforts(provider: string, model: string): readonly string[] | null {
  const registry = getRegistryEntry(provider);
  const entry = registry?.models?.find((m) => m.id === model || m.aliases?.includes(model));
  return (
    entry?.supportedThinkingEfforts ??
    getSyncedSupportedThinkingEfforts(registry?.id || provider, model)
  );
}

export function noThinkingHandling(provider: string, model: string): "native" | "omit" | null {
  const entry = getRegistryEntry(provider)?.models?.find(
    (m) => m.id === model || m.aliases?.includes(model)
  );
  if (!declaredThinkingEfforts(provider, model)?.includes("none")) return null;
  if (entry?.reasoningEffortNoneHandling === "omit" && entry.supportsReasoning === false)
    return "omit";
  return entry?.reasoningEffortNoneHandling === "omit" ? null : "native";
}

/** Used at the LAST dispatch boundary, after defaults and configurable filters. */
export function omitNoThinkingControls(body: Body): Body {
  const next = { ...body };
  delete next.reasoning_effort;
  delete next.reasoning;
  if (record(next.output_config)) {
    const output = { ...next.output_config };
    delete output.effort;
    if (Object.keys(output).length) next.output_config = output;
    else delete next.output_config;
  }
  if (record(next.thinking) && next.thinking.type === "disabled") delete next.thinking;
  if (record(next.chat_template_kwargs) && next.chat_template_kwargs.enable_thinking === false) {
    const kwargs = { ...next.chat_template_kwargs };
    delete kwargs.enable_thinking;
    if (Object.keys(kwargs).length) next.chat_template_kwargs = kwargs;
    else delete next.chat_template_kwargs;
  }
  return next;
}
