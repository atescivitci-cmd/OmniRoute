import { createErrorResult } from "../utils/error.ts";
import { nvidiaProvider } from "../config/providers/registry/nvidia/index.ts";
import { markKnownNonDispatch, markDefiniteRejection } from "./combo/routingAttemptSafety.ts";
import { ACCOUNT_MODEL_INELIGIBLE_CODE } from "../../src/lib/db/accountModelEligibilityPolicy.ts";
import {
  NVIDIA_MODEL_NEGATIVE_CODE,
  isNvidiaAccountFunctionMissing,
} from "../../src/lib/db/nvidiaModelAvailabilityPolicy.ts";

type EligibilityCode = typeof ACCOUNT_MODEL_INELIGIBLE_CODE | typeof NVIDIA_MODEL_NEGATIVE_CODE;
/** Native wire evidence, never reconstructed from the displayed error string. */
type NvidiaRejectionEvidence = {
  provider: unknown;
  nativeExecutor: boolean;
  status: number;
  endpoint: unknown;
  responseUrl: unknown;
  redirected: boolean;
  body: unknown;
  expectedModel: unknown;
  attemptModel: unknown;
  expectedConnection: unknown;
  attemptConnection: unknown;
};
function hasNativeNvidiaIdentity(e: NvidiaRejectionEvidence): boolean {
  return (
    e.provider === "nvidia" &&
    e.nativeExecutor &&
    !e.redirected &&
    e.status === 404 &&
    e.endpoint === nvidiaProvider.baseUrl &&
    (!e.responseUrl || e.responseUrl === e.endpoint) &&
    typeof e.expectedConnection === "string" &&
    !!e.expectedConnection &&
    e.expectedConnection === e.attemptConnection &&
    typeof e.expectedModel === "string" &&
    e.expectedModel === e.attemptModel
  );
}
export function isNativeNvidiaEntitlementRejection(e: NvidiaRejectionEvidence): boolean {
  if (!hasNativeNvidiaIdentity(e) || !e.body || typeof e.body !== "object" || Array.isArray(e.body))
    return false;
  try {
    return isNvidiaAccountFunctionMissing(e.provider, e.status, JSON.stringify(e.body));
  } catch {
    return false;
  }
}

/** Exact native gateway route miss, scoped to the observed model and this request. */
export function nvidiaStarCoderRouteMiss(e: NvidiaRejectionEvidence, message: string) {
  if (
    !hasNativeNvidiaIdentity(e) ||
    e.expectedModel !== "bigcode/starcoder2-15b" ||
    !e.body ||
    typeof e.body !== "object" ||
    !Object.hasOwn(e.body, "_rawText") ||
    Object.keys(e.body).length !== 1 ||
    e.body._rawText !== message ||
    !/^404 page not found(?:\r?\n)?$/.test(message)
  )
    return null;
  const result = createErrorResult(
    404,
    "The NVIDIA StarCoder endpoint returned a route miss.",
    null,
    "nvidia_native_route_not_found",
    "invalid_request_error"
  );
  markDefiniteRejection(result.response);
  return result;
}
function eligibilityResult(code: EligibilityCode) {
  if (code !== ACCOUNT_MODEL_INELIGIBLE_CODE && code !== NVIDIA_MODEL_NEGATIVE_CODE)
    throw new TypeError("invalid_model_eligibility_code");
  // Never echo an upstream account identifier, error prose or credentials.
  return createErrorResult(
    404,
    "Selected account/model is unavailable; another eligible target may be considered.",
    null,
    code,
    "invalid_request_error"
  );
}
/** Server-owned cache decision only; a caller/provider error code cannot invoke this path. */
export function cachedModelEligibilityResponse(code: EligibilityCode): Response {
  return markKnownNonDispatch(eligibilityResult(code).response);
}
/** Exact observed rejection, not a generic404 and not a claim of transport nondispatch. */
export function nvidiaFunctionRejectionResult(
  provider: unknown,
  status: unknown,
  message: unknown
) {
  if (!isNvidiaAccountFunctionMissing(provider, status, message)) return null;
  const result = eligibilityResult(NVIDIA_MODEL_NEGATIVE_CODE);
  markDefiniteRejection(result.response);
  return result;
}
