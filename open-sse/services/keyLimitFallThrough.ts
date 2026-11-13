import { createErrorResult } from "../utils/error.ts";
import { markKeyLimitRefusal, markKnownNonDispatch } from "./combo/routingAttemptSafety.ts";
import { sanitizeForProviderSwitch } from "./sanitizeForProviderSwitch.ts";

/**
 * KEY_LIMIT_FALLTHROUGH: a key over its USD usage limit used to be rejected up front with a
 * 400, which stopped the request even when another eligible target existed. The policy gate
 * now lets the request through carrying `usageLimitExceeded`; each target that WOULD add to
 * the key's recorded spend is refused here, before dispatch, so the router moves on to the
 * next eligible target. Free and local targets add nothing and stay eligible.
 *
 * Requests whose history carries provider signatures (signed thinking, encrypted reasoning)
 * may also move on, because the refusal happens before any provider sees the request and the
 * next dispatch uses a body stripped of those artifacts (sanitizeBodyAfterKeyLimit). Requests
 * bound to provider-held state (stored responses, containers, provider-run tools) and every
 * other kind of failure keep the existing stop (routing attempt guard).
 */
export const KEY_LIMIT_TARGET_SKIPPED = "api_key_usage_limit_target_skipped";

export interface KeyUsageLimitMarker {
  message: string;
}

export type CostOf = (
  provider: string,
  model: string,
  tokens: Record<string, number>
) => Promise<number>;

/** A target is metered when a standard sample request to it would be priced above zero, using
 * the same pricing path that records the key's spend. If that cannot be determined, treat it
 * as metered (fail closed) so the limit still holds. */
export async function isMeteredTarget(
  provider: string,
  model: string,
  costOf: CostOf
): Promise<boolean> {
  try {
    return (await costOf(provider, model, { input: 1_000_000, output: 1_000_000 })) > 0;
  } catch {
    return true;
  }
}

export async function keyLimitTargetRefusal(
  marker: KeyUsageLimitMarker | null | undefined,
  provider: string,
  model: string,
  costOf: CostOf
) {
  if (!marker) return null;
  if (!(await isMeteredTarget(provider, model, costOf))) return null;
  const result = createErrorResult(
    400,
    marker.message,
    null,
    KEY_LIMIT_TARGET_SKIPPED,
    "invalid_request_error"
  );
  markKnownNonDispatch(result.response);
  markKeyLimitRefusal(result.response);
  return result;
}

/** Body for the dispatch that follows a key-limit refusal: signed thinking and encrypted
 * reasoning removed, everything else untouched. Never mutates the input. */
export function sanitizeBodyAfterKeyLimit<T extends Record<string, unknown>>(body: T): T {
  return sanitizeForProviderSwitch(body) as T;
}
