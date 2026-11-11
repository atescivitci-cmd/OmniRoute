/**
 * chatCore upstream body preparation (Quality Gate v2 / Fase 9 — chatCore god-file decomposition,
 * #3501 — first internal sub-slice of executeProviderRequest).
 *
 * Extracted from handleChatCore's execute() closure: prepares the body actually sent upstream for a
 * given target model. Pins the model id, applies the configured payload rules, enforces the tool
 * list to the provider's effective limit and injects an OpenAI `prompt_cache_key` for
 * caching-capable providers. Pure with respect to handler
 * state (returns a fresh body, only logs as a side effect). Excess tools are refused rather
 * than silently removed; native protected data is checked before dispatch.
 */

import {
  applyConfiguredPayloadRules,
  resolvePayloadRuleProtocols,
} from "../../services/payloadRules.ts";
import { getEffectiveToolLimit, getKnownToolLimit } from "../../services/toolLimitDetector.ts";
import {
  providerSupportsCaching,
  resolveConnectionCacheOverride,
  type ConnectionCacheOverride,
} from "../../utils/cacheControlPolicy.ts";
import { FORMATS } from "../../translator/formats.ts";
import { sanitizeRequestForResolvedTarget } from "../../services/targetRequestSanitizer.ts";
import {
  RequestCompatibilityError,
  requireRequestCompatibility,
  assertNativeProtocolDataUnchanged,
} from "../../services/requestCompatibility.ts";
import { resolveRequestCompatibilityTarget } from "../../services/requestCompatibilityTarget.ts";

type LoggerLike = { debug?: (...args: unknown[]) => void } | null | undefined;
type Body = Record<string, unknown>;
type CredentialsLike =
  | {
      apiKey?: unknown;
      accessToken?: unknown;
      providerSpecificData?: Record<string, unknown> | null;
    }
  | null
  | undefined;

function buildAppliedRulesSummary(
  applied: Array<{ type: string; path: string; value?: unknown }>
): string {
  return applied
    .map((rule) => {
      if (rule.type === "filter") return `${rule.type}:${rule.path}`;
      const serializedValue = JSON.stringify(rule.value);
      const safeValue =
        typeof serializedValue === "string" && serializedValue.length > 80
          ? `${serializedValue.slice(0, 77)}...`
          : serializedValue;
      return `${rule.type}:${rule.path}=${safeValue}`;
    })
    .join(", ");
}

function enforceToolLimit(
  bodyToSend: Body,
  provider: string | null | undefined,
  bypassDefaultToolLimit: boolean,
  _log?: LoggerLike
): Body {
  if (!Array.isArray(bodyToSend.tools)) return bodyToSend;

  const knownLimit = getKnownToolLimit(provider);
  if (knownLimit !== null) {
    if (bodyToSend.tools.length > knownLimit) {
      throw new RequestCompatibilityError("request_tool_limit_exceeded");
    }
    return bodyToSend;
  }

  if (bypassDefaultToolLimit === true) return bodyToSend;

  const effectiveToolLimit = getEffectiveToolLimit(provider);
  if (bodyToSend.tools.length > effectiveToolLimit) {
    throw new RequestCompatibilityError("request_tool_limit_exceeded");
  }
  return bodyToSend;
}

// Inject prompt_cache_key only for providers that support it.
async function injectPromptCacheKey(
  bodyToSend: Body,
  provider: string | null | undefined,
  targetFormat: string,
  connectionCacheOverride: ConnectionCacheOverride | null
): Promise<Body> {
  if (
    targetFormat === FORMATS.OPENAI &&
    providerSupportsCaching(provider, undefined, connectionCacheOverride) &&
    !bodyToSend.prompt_cache_key &&
    Array.isArray(bodyToSend.messages) &&
    !["nvidia", "codex", "xai"].includes(provider)
  ) {
    const { generatePromptCacheKey } = await import("@/lib/promptCache");
    const cacheKey = generatePromptCacheKey(bodyToSend.messages);
    if (cacheKey) {
      bodyToSend = { ...bodyToSend, prompt_cache_key: cacheKey };
    }
  }
  return bodyToSend;
}

export async function prepareUpstreamBody(opts: {
  translatedBody: Body;
  modelToCall: string;
  provider: string | null | undefined;
  targetFormat: string;
  credentials: CredentialsLike;
  bypassDefaultToolLimit?: boolean;
  preserveProtocol?: boolean;
  /** Original generic none intent, captured before translation/payload rules. */
  requiredNoThinking?: boolean;
  log?: LoggerLike;
}): Promise<Body> {
  const {
    translatedBody,
    modelToCall,
    provider,
    targetFormat,
    credentials,
    bypassDefaultToolLimit = false,
    preserveProtocol = false,
    requiredNoThinking,
    log,
  } = opts;

  let bodyToSend: Body =
    translatedBody.model === modelToCall
      ? translatedBody
      : { ...translatedBody, model: modelToCall };
  const compatibilityTarget = resolveRequestCompatibilityTarget(
    bodyToSend,
    provider,
    modelToCall,
    targetFormat
  );
  bodyToSend = requireRequestCompatibility(bodyToSend, compatibilityTarget).body;
  const nativeBefore =
    (provider === "github" || provider === "gh") && targetFormat === FORMATS.CLAUDE
      ? structuredClone(bodyToSend)
      : null;
  if (preserveProtocol) {
    return structuredClone(bodyToSend);
  }
  const payloadRuleModel =
    typeof bodyToSend.model === "string" && bodyToSend.model.length > 0
      ? bodyToSend.model
      : modelToCall;
  const payloadRuleProtocols = resolvePayloadRuleProtocols({ provider, targetFormat });
  const payloadRuleResult = await applyConfiguredPayloadRules(
    bodyToSend,
    payloadRuleModel,
    payloadRuleProtocols
  );
  bodyToSend = payloadRuleResult.payload;
  bodyToSend = requireRequestCompatibility(
    bodyToSend,
    resolveRequestCompatibilityTarget(bodyToSend, provider, modelToCall, targetFormat)
  ).body;

  if (payloadRuleResult.applied.length > 0) {
    log?.debug?.(
      "PAYLOAD_RULES",
      `Applied ${payloadRuleResult.applied.length} rule(s) for ${payloadRuleModel} (${payloadRuleProtocols.join(", ")}): ${buildAppliedRulesSummary(payloadRuleResult.applied)}`
    );
  }

  bodyToSend = sanitizeRequestForResolvedTarget(bodyToSend, {
    provider,
    model: payloadRuleModel,
    requiredNoThinking,
    log,
  });
  bodyToSend = enforceToolLimit(bodyToSend, provider, bypassDefaultToolLimit ?? false, log);
  const connectionCacheOverride = resolveConnectionCacheOverride(credentials?.providerSpecificData);
  bodyToSend = await injectPromptCacheKey(
    bodyToSend,
    provider,
    targetFormat,
    connectionCacheOverride
  );
  if (nativeBefore) assertNativeProtocolDataUnchanged(nativeBefore, bodyToSend);

  return bodyToSend;
}
