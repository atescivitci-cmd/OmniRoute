/**
 * chatCore upstream-proxy executor resolver (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore: resolves the executor for a provider honoring the configured
 * upstream proxy mode. `native` / disabled → the provider's own executor; `cliproxyapi` → the
 * CLIProxyAPI passthrough executor; `fallback` → a wrapper that tries the native executor first and
 * retries via CLIProxyAPI on configured failure codes (default 5xx + 429 + network) or on a thrown
 * error. Behaviour is byte-identical to the previous inline closure (it only captured `log`).
 */

import { getExecutor } from "../../executors/index.ts";
import { isCliproxyapiDeepModeEnabled } from "../../executors/cliproxyapi.ts";
import { getCachedSettings } from "@/lib/db/readCache";
import { getUpstreamProxyConfigCached } from "./comboContextCache.ts";
import { wrapExecutorWithCliproxyapiModelMapping } from "./cliproxyModelMapping.ts";
import {
  resolveDedicatedCliproxyapiApiKey,
  wrapExecutorWithCliproxyapiCredentials,
} from "./cliproxyapiCredentials.ts";
import { buildFixedFallbackExecute } from "./fallbackWrapperExecute.ts";

type LoggerLike =
  | {
      info?: (...args: unknown[]) => void;
      error?: (...args: unknown[]) => void;
      warn?: (...args: unknown[]) => void;
    }
  | null
  | undefined;

const DEFAULT_FALLBACK_CODES = [429, 500, 502, 503, 504];

function parseFallbackCodes(raw: unknown): number[] | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  return parsed.length > 0 ? parsed : null;
}

/**
 * Reads the CLIProxyAPI-related settings shared by both the direct
 * `mode: "cliproxyapi"` passthrough leg and the `mode: "fallback"` retry leg:
 * the custom fallback status codes and the dedicated credential (#7645).
 * Falls back to defaults / no dedicated key on any read failure.
 */
async function loadCliproxyapiSettings(): Promise<{
  fallbackCodes: number[];
  dedicatedApiKey: string | null;
}> {
  try {
    const allSettings = await getCachedSettings();
    return {
      fallbackCodes: parseFallbackCodes(allSettings.cliproxyapi_fallback_codes) ?? [
        ...DEFAULT_FALLBACK_CODES,
      ],
      dedicatedApiKey: resolveDedicatedCliproxyapiApiKey(allSettings),
    };
  } catch {
    return { fallbackCodes: [...DEFAULT_FALLBACK_CODES], dedicatedApiKey: null };
  }
}

export async function resolveExecutorWithProxy(
  prov: string,
  log?: LoggerLike,
  providerSpecificData?: Record<string, unknown> | null,
  centralAttempt = false
) {
  // Per-connection routing override (#6339): the resolved connection can opt itself
  // into the CLIProxyAPI passthrough executor via providerSpecificData.cliproxyapiMode
  // === "claude-native" (UI toggle). This takes precedence over the provider-level
  // upstream_proxy_config mode — one connection can deep-route while the provider's
  // default (and its other connections) stay native. Backward-compatible: connections
  // without the flag fall through to the existing per-provider behaviour untouched.
  if (isCliproxyapiDeepModeEnabled(providerSpecificData)) {
    log?.info?.(
      "UPSTREAM_PROXY",
      `${prov} routed through CLIProxyAPI (per-connection claude-native override)`
    );
    return getExecutor("cliproxyapi");
  }

  const cfg = await getUpstreamProxyConfigCached(prov);
  if (!cfg.enabled || cfg.mode === "native") return getExecutor(prov);

  if (cfg.mode === "cliproxyapi") {
    log?.info?.("UPSTREAM_PROXY", `${prov} routed through CLIProxyAPI (passthrough)`);
    const { dedicatedApiKey } = await loadCliproxyapiSettings();
    return wrapExecutorWithCliproxyapiCredentials(
      wrapExecutorWithCliproxyapiModelMapping(
        getExecutor("cliproxyapi"),
        cfg.cliproxyapiModelMapping
      ),
      dedicatedApiKey
    );
  }

  // mode === "fallback": try native first, retry via CLIProxyAPI on specific failures.
  // The model mapping applies only to the CLIProxyAPI retry leg (proxyExec) — the
  // native leg must keep seeing the original, unmapped model.
  const nativeExec = getExecutor(prov);
  // Central routing already owns fallback. Retain the native NVIDIA executor
  // identity so an exact account/function rejection can be attributed to it.
  if (prov === "nvidia" && centralAttempt) return nativeExec;
  const { fallbackCodes, dedicatedApiKey } = await loadCliproxyapiSettings();
  // #7645: the CLIProxyAPI retry leg must authenticate with the dedicated
  // key, never the native provider's own (already-failed) credential.
  const proxyExec = wrapExecutorWithCliproxyapiCredentials(
    wrapExecutorWithCliproxyapiModelMapping(
      getExecutor("cliproxyapi"),
      cfg.cliproxyapiModelMapping
    ),
    dedicatedApiKey
  );
  const isRetryableStatus = (s: number) => fallbackCodes.includes(s) || s === 0;

  // CLAUDE_SESSION_AFFINITY_V2 (2026-08-30): use the fixed fallback executor.
  // The previous inline implementation threw/returned the SECONDARY CLIProxyAPI failure,
  // discarding the real native error -- the 2026-08-29 incident where an ECONNREFUSED
  // from a wrong-architecture CLIProxyAPI binary masked why Claude actually failed.
  // buildFixedFallbackExecute preserves the primary outcome whenever the secondary retry
  // does not genuinely succeed.
  const wrapper = Object.create(nativeExec);
  wrapper.execute = buildFixedFallbackExecute(
    nativeExec as never,
    proxyExec as never,
    isRetryableStatus,
    prov,
    log as never
  );
  return wrapper;
}
