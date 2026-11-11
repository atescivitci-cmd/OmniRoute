import { createErrorResult } from "../utils/error.ts";
import { markKnownNonDispatch } from "./combo/routingAttemptSafety.ts";
import type { RequestCompatibilityError } from "./requestCompatibility.ts";

/** Only an in-process pre-dispatch decision can mark this Response safe to
 * consider another target. A caller/upstream error code carries no authority.
 */
export function requestCompatibilityErrorResult(error: RequestCompatibilityError) {
  const result = createErrorResult(
    422,
    "Selected target cannot preserve required request features.",
    null,
    error.code,
    "invalid_request_error"
  );
  markKnownNonDispatch(result.response);
  return result;
}
