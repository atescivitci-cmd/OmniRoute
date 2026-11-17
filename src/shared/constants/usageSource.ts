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
