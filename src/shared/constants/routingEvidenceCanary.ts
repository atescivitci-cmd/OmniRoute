/**
 * routingEvidenceCanary.ts — constants for the opt-in routing evidence canary (P1).
 *
 * The canary gives the selector measured latency and reliability for candidates that real
 * traffic rarely reaches. It treats every candidate identically and contains no provider,
 * model or combo names: eligibility comes from connection state and settings only.
 */

export const ROUTING_CANARY_TICK_INTERVAL_MS = 60_000;

/** Wall-clock ceiling for a single probe, enforced by the probe runner. */
export const ROUTING_CANARY_PROBE_TIMEOUT_MS = 45_000;

export type RoutingCanaryBucket = "small" | "medium";

/** Approximate prompt size per bucket. One bucket is used for every candidate in a cycle. */
export const ROUTING_CANARY_BUCKET_TOKENS: Record<RoutingCanaryBucket, number> = {
  small: 1_000,
  medium: 16_000,
};

/** Rough characters per token used only to size the synthetic prompt. */
export const ROUTING_CANARY_CHARS_PER_TOKEN = 4;

/** Upper bound on generated tokens for a probe. */
export const ROUTING_CANARY_OUTPUT_TOKENS = 64;

/**
 * Price assumed (USD per 1M tokens) when a candidate has no pricing record. Unknown is treated
 * as metered, never as free, so a missing price can only make the canary more cautious.
 */
export const ROUTING_CANARY_UNKNOWN_PRICE_PER_M = { input: 5, output: 15 } as const;

/** Longest wait between probes of a candidate that keeps failing or leaves no sample. */
export const ROUTING_CANARY_BACKOFF_CAP_MS = 24 * 60 * 60 * 1000;

/** Connection states that never recover without an operator action. */
export const ROUTING_CANARY_TERMINAL_STATUSES: readonly string[] = [
  "credits_exhausted",
  "banned",
  "expired",
];

/** Values of the ROUTING_EVIDENCE_CANARY environment variable that force the canary off. */
export const ROUTING_CANARY_KILL_VALUES: readonly string[] = ["0", "false", "off", "no"];

export interface RoutingCanaryConfig {
  enabled: boolean;
  connections: Record<string, boolean>;
  combos: string[];
  includeLocal: boolean;
  dailyBudgetUsd: number;
  targetSamples: number;
  minSpacingMinutes: number;
  maxProbesPerTick: number;
  bucket: RoutingCanaryBucket;
}

export const ROUTING_CANARY_DEFAULTS: RoutingCanaryConfig = {
  enabled: false,
  connections: {},
  combos: [],
  includeLocal: false,
  dailyBudgetUsd: 0.5,
  targetSamples: 10,
  minSpacingMinutes: 30,
  maxProbesPerTick: 6,
  bucket: "small",
};
