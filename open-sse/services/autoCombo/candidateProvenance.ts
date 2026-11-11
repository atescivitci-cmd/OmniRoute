import { createHash } from "node:crypto";

export interface CandidateProvenance {
  connectionFingerprint: string | null;
  health: {
    source: "usage_24h" | "runtime_process" | "bootstrap";
    sampleCount: number | null;
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
        ? "usage_24h"
        : count(args.runtimeSamples)
          ? "runtime_process"
          : "bootstrap",
      sampleCount: count(
        args.historical ? args.historicalSamples : args.runtimeSamples,
      ),
      windowHours: args.historical ? 24 : null,
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

/** An aggregate process-lifetime failure is a soft signal, not permanent availability proof. */
export function healthEvidenceHasRecentSamples(
  provenance: CandidateProvenance | undefined,
  now = Date.now(),
): boolean {
  const health = provenance?.health;
  if (
    !health ||
    health.source !== "usage_24h" ||
    health.windowHours !== 24 ||
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
