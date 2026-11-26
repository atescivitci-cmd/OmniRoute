import { createHash } from "node:crypto";
import { DURABLE_EVIDENCE_WINDOW_HOURS } from "./durableEvidence.ts";

export interface CandidateProvenance {
  connectionFingerprint: string | null;
  health: {
    /** usage_durable: 7-day decayed, class-family-gated rows (ROUTING_DURABLE_EVIDENCE). */
    source: "usage_24h" | "usage_durable" | "runtime_process" | "bootstrap";
    sampleCount: number | null;
    /**
     * usage_durable only: decay-weighted sample count, the confidence of the estimate. sampleCount
     * stays the RAW gated row count, which decides whether evidence exists at all.
     */
    effectiveSampleCount?: number;
    windowHours: number | null;
    latestObservationAt: string | null;
    evaluatedAt: string;
    errorClass: "unknown" | "provider_unavailable" | "model_unavailable";
  };
  quota: {
    source: "quota_fetcher_result" | "unavailable";
    acquiredAt: string;
    measuredAt: null;
    applicability: "model_unknown" | "account_windows";
    windowNames: string[];
  };
  capabilities: {
    source: "resolver_native_or_emulated_or_heuristic";
    verified: "unknown";
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function candidateProvenance(args: {
  provider: string;
  connectionId?: string | null;
  historical: boolean;
  historicalSamples: unknown;
  runtimeSamples: unknown;
  runtimeLatest: unknown;
  quota: unknown;
  now?: number;
  /** Set only when the historical stats came from the durable evidence. Default: usage_24h, 24. */
  historicalSource?: "usage_durable";
  historicalWindowHours?: number;
  historicalEffectiveSamples?: number;
}): CandidateProvenance {
  const now = new Date(args.now ?? Date.now()).toISOString();
  const quota =
    args.quota && typeof args.quota === "object"
      ? (args.quota as Record<string, unknown>)
      : null;
  const windows =
    quota?.windows && typeof quota.windows === "object" ? quota.windows : {};
  const latest =
    typeof args.runtimeLatest === "string" &&
    Number.isFinite(Date.parse(args.runtimeLatest))
      ? args.runtimeLatest
      : null;
  return {
    connectionFingerprint: args.connectionId
      ? createHash("sha256")
          .update(args.connectionId)
          .digest("hex")
          .slice(0, 16)
      : null,
    health: {
      source: args.historical
        ? (args.historicalSource ?? "usage_24h")
        : count(args.runtimeSamples)
          ? "runtime_process"
          : "bootstrap",
      sampleCount: count(
        args.historical ? args.historicalSamples : args.runtimeSamples,
      ),
      windowHours: args.historical ? (args.historicalSource ? args.historicalWindowHours ?? null : 24) : null,
      ...(args.historical &&
        args.historicalSource &&
        args.historicalEffectiveSamples !== undefined && {
          effectiveSampleCount: args.historicalEffectiveSamples,
        }),
      latestObservationAt: args.historical ? null : latest,
      evaluatedAt: now,
      errorClass: "unknown",
    },
    quota: {
      source: quota ? "quota_fetcher_result" : "unavailable",
      acquiredAt: now,
      measuredAt: null,
      // No authoritative GitHub per-model multiplier/plan entitlement is available
      // here. Preserve conservative account depletion; NEVER infer a free window.
      applicability:
        args.provider === "github" ? "model_unknown" : "account_windows",
      windowNames: Object.keys(windows)
        .filter((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name))
        .sort(),
    },
    capabilities: {
      source: "resolver_native_or_emulated_or_heuristic",
      verified: "unknown",
    },
  };
}

/**
 * True for the bounded usage aggregates that may be read as recent evidence: the 24 h window, or
 * the durable 7-day decayed window (whose sample count is already the decayed effective count).
 */
export function isBoundedUsageHealth(
  health: { source: string; windowHours: number | null } | undefined,
): boolean {
  if (!health) return false;
  if (health.source === "usage_24h") return health.windowHours === 24;
  if (health.source === "usage_durable") return health.windowHours === DURABLE_EVIDENCE_WINDOW_HOURS;
  return false;
}

/** An aggregate process-lifetime failure is a soft signal, not permanent availability proof. */
export function healthEvidenceHasRecentSamples(
  provenance: CandidateProvenance | undefined,
  now = Date.now(),
): boolean {
  const health = provenance?.health;
  if (
    !health ||
    !isBoundedUsageHealth(health) ||
    (health.sampleCount ?? 0) < 10
  )
    return false;
  const evaluated = Date.parse(health.evaluatedAt);
  return (
    Number.isFinite(evaluated) && now >= evaluated && now - evaluated <= 60_000
  );
}

export function healthEvidenceSupportsHardVeto(
  provenance: CandidateProvenance | undefined,
): boolean {
  return (
    healthEvidenceHasRecentSamples(provenance) &&
    provenance?.health.errorClass !== "unknown"
  );
}
