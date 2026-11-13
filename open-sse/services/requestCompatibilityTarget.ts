import { getModelTargetFormat } from "../config/providerModels.ts";
import { getTargetFormat } from "./provider.ts";
import { stripUnsupportedParams } from "../translator/paramSupport.ts";
import { getEffectiveToolLimit, getKnownToolLimit } from "./toolLimitDetector.ts";
import type { RequestCompatibilityTarget } from "./requestCompatibility.ts";
import { noThinkingIntent } from "./reasoningEffortCompatibility.ts";

/** The existing operator/endpoint parameter policy is evidence of which native
 * controls cannot survive this target. Do not silently erase those controls.
 * Only small control fields are probed, never a full history per candidate.
 */
export function resolveRequestCompatibilityTarget(
  body: Record<string, unknown>,
  provider: string | null | undefined,
  model: string,
  targetFormat?: string
): RequestCompatibilityTarget {
  const canonical = provider === "gh" ? "github" : provider === "cc" ? "claude" : provider || "";
  const format =
    targetFormat ??
    getModelTargetFormat(canonical === "github" ? "gh" : canonical, model) ??
    getTargetFormat(canonical);
  const unsupportedControls: string[] = [];
  if (format === "claude") {
    const fields = ["thinking", "reasoning_effort", "output_config"] as const;
    const probe: Record<string, unknown> = {};
    for (const field of fields) {
      if (Object.hasOwn(body, field) && body[field] !== undefined) {
        probe[field] = structuredClone(body[field]);
      }
    }
    const present = Object.keys(probe);
    stripUnsupportedParams(canonical, model, probe);
    // The generic no-thinking promise already has a separately qualified final
    // mapping. Erasing that carrier here is not evidence that its meaning is lost.
    const genericNone = noThinkingIntent(body).genericRequested;
    unsupportedControls.push(
      ...present.filter(
        (field) => !Object.hasOwn(probe, field) && !(field === "reasoning_effort" && genericNone)
      )
    );
    // The existing non-Anthropic native passthrough strips this required
    // structured-output contract (#1719). Refuse that selected target before
    // translation instead of losing it before the final integrity snapshot.
    if (canonical !== "claude") {
      const output = body.output_config;
      if (
        output &&
        typeof output === "object" &&
        !Array.isArray(output) &&
        Object.hasOwn(output, "format") &&
        (output as Record<string, unknown>).format !== undefined
      )
        unsupportedControls.push("output_config");
      if (Object.hasOwn(body, "output_format") && body.output_format !== undefined)
        unsupportedControls.push("output_format");
    }
  }
  // Only a Responses-format target keeps `namespace` tool groups intact.
  const expandsNamespaceTools = format !== "openai-responses";
  return {
    provider: canonical,
    model,
    contextManagement:
      canonical === "claude" && format === "claude"
        ? "native"
        : format === "claude" && canonical === "github"
          ? "unsupported"
          : "unknown",
    // GitHub's executor already enforced 128; expose that same constraint
    // before selection instead of silently slicing the selected request.
    maxTools:
      canonical === "github"
        ? Math.min(getKnownToolLimit(canonical) ?? 128, 128)
        : (getKnownToolLimit(canonical) ??
          // The dispatcher applies its default cap to providers without a known limit.
          // Mirror it only when expanded namespace tools make the translated body larger
          // than the request looks; plain-tool requests keep their existing behaviour.
          (expandsNamespaceTools && hasNamespaceTools(body)
            ? getEffectiveToolLimit(canonical)
            : null)),
    unsupportedControls,
    expandsNamespaceTools,
  };
}

function hasNamespaceTools(body: Record<string, unknown>): boolean {
  return (
    Array.isArray(body?.tools) &&
    body.tools.some(
      (tool) =>
        tool !== null &&
        typeof tool === "object" &&
        (tool as Record<string, unknown>).type === "namespace"
    )
  );
}
