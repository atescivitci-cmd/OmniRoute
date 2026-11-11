// ── CLAUDE_SESSION_AFFINITY_V2 (2026-08-29) — PRESERVE_PRIMARY_ERROR ──────────────────
// Extracted, fixed version of the fallback-mode execute() closure from executorProxy.ts.
// The 2026-08-29 incident: native Claude failed, CLIProxyAPI ALSO failed (ECONNREFUSED,
// because its installed binary was the wrong architecture), and the CLIProxyAPI failure
// REPLACED the native failure -- the caller never saw why Claude actually failed, only
// "proxy_unreachable" from the secondary bridge. This preserves the native/primary
// outcome whenever the secondary CLIProxyAPI retry does not produce a genuine success.
//
// Source of the vendor file this integrates into, pinned at handout time:
//   open-sse/handlers/chatCore/executorProxy.ts  sha256 93b46f95725a278be08132722fa099914081a3c4d363a9e9dbc02f89b9fdc26f
import { hasRoutingTransportAttempt } from "../../services/routingTransportContext.ts";

export type ExecResult = { response: { ok: boolean; status: number } };
export type Executor = { execute: (input: unknown) => Promise<ExecResult> };
export type LoggerLike =
  { error?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void } | null | undefined;

export function buildFixedFallbackExecute(
  nativeExec: Executor,
  proxyExec: Executor,
  isRetryableStatus: (status: number) => boolean,
  prov: string,
  log: LoggerLike
) {
  return async (input: unknown): Promise<ExecResult> => {
    // The central owner re-admits each target. A native outcome, including a
    // predispatch policy refusal, cannot authorize this hidden second transport.
    // Preserve both ordinary results and sticky uncertainty/cancellation.
    if (hasRoutingTransportAttempt()) return nativeExec.execute(input);
    let result: ExecResult | undefined;
    let nativeThrew: unknown;

    try {
      result = await nativeExec.execute(input);
    } catch (err) {
      nativeThrew = err;
    }

    // Native threw: the proxy retry can only WIN by succeeding. Any proxy failure --
    // thrown or a bad HTTP status -- preserves the native throw, never the proxy's.
    if (nativeThrew !== undefined) {
      try {
        const proxyResult = await proxyExec.execute(input);
        if (proxyResult.response.ok) return proxyResult;
        log?.error?.(
          "UPSTREAM_PROXY",
          `${prov} CLIProxyAPI fallback returned ${proxyResult.response.status}; preserving native failure`
        );
        throw nativeThrew;
      } catch (proxyErr) {
        if (proxyErr === nativeThrew) throw nativeThrew;
        const proxyMsg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
        log?.error?.(
          "UPSTREAM_PROXY",
          `${prov} CLIProxyAPI fallback also failed: ${proxyMsg}; preserving native failure`
        );
        throw nativeThrew;
      }
    }

    // Native returned an HTTP result. Not retryable -> done, same as before.
    if (!isRetryableStatus(result!.response.status)) {
      return result!;
    }

    // Native returned a retryable HTTP failure (e.g. 502, 429). The proxy retry can
    // only WIN by succeeding; any proxy failure returns the ORIGINAL native result,
    // not a secondary bridge failure that never explains the real reason.
    try {
      const proxyResult = await proxyExec.execute(input);
      if (proxyResult.response.ok) return proxyResult;
      log?.error?.(
        "UPSTREAM_PROXY",
        `${prov} CLIProxyAPI fallback returned ${proxyResult.response.status}; preserving native response ${result!.response.status}`
      );
      return result!;
    } catch (proxyErr) {
      const proxyMsg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
      log?.error?.(
        "UPSTREAM_PROXY",
        `${prov} CLIProxyAPI fallback also failed: ${proxyMsg}; preserving native response ${result!.response.status}`
      );
      return result!;
    }
  };
}
