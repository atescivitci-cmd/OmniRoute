/**
 * usageSource.ts — provenance values for the `usage_history.source` column.
 *
 * `NULL` means ordinary client traffic. A non-null value marks rows that OmniRoute itself
 * generated, so reports can separate them from what clients actually asked for. Kept as a
 * pure constants module (no imports) so SQL builders can use it without pulling in the DB layer.
 */

/** Synthetic probes sent by the routing evidence canary. */
export const USAGE_SOURCE_ROUTING_CANARY = "routing-canary";

/**
 * SQL predicate that keeps ordinary traffic and drops canary probes. Use it in report queries
 * that describe what clients asked for. Do NOT use it where the rows are real consumption of a
 * provider quota or spend, nor in the selector's latency evidence, which needs the probe rows.
 */
export const EXCLUDE_ROUTING_CANARY_SQL = `(source IS NULL OR source <> '${USAGE_SOURCE_ROUTING_CANARY}')`;

/** A 200 whose translated body had no usable output; recorded as a failure WITH its tokens. */
export const MALFORMED_TRANSLATED_RESPONSE_CODE = "malformed_translated_response";
/** A 200 after which the gateway itself threw; recorded as a failure WITH its tokens. */
export const POST_PROCESSING_ERROR_CODE = "post_processing_error";

/**
 * SQL predicate for rows whose tokens the provider billed. Since 2026-11-26 a request writes
 * exactly one usage row, and the only rows that carry provider-reported tokens are:
 *  - successes;
 *  - malformed_translated_response: the provider answered 200 (and billed) but OmniRoute rejected
 *    the translated body as unusable;
 *  - post_processing_error: the provider answered 200 (and billed) but the gateway threw while
 *    post-processing it.
 * Every other failure row carries zero tokens. Use this wherever spend or consumed tokens are
 * counted, in place of "success = 1". Request counts keep using success = 1.
 */
export const BILLED_USAGE_ROW_SQL = `(success = 1 OR error_code IN ('${MALFORMED_TRANSLATED_RESPONSE_CODE}', '${POST_PROCESSING_ERROR_CODE}'))`;
