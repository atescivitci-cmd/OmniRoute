import type { ZeroCostEvidence, ZeroCostEvidenceResolver, ZeroCostRequest } from './zeroCostAdmission.ts';

/** Server observations only. Never deserialize this from request metadata or a
 * provider catalog. The observer must bind these facts to the current native
 * daemon, connection revision and effective transport, and invalidate on change.
 * This module does not observe, start, configure, load or download anything. */
export type LocalOllamaObservation = {
  connectionId: string;
  provider: 'ollama-local';
  effectiveChatUrl: string;
  transport: 'direct';
  nativeDaemonIdentity: string;
  request: ZeroCostRequest; // same in-process admission invocation, never caller metadata
  connectionRevision: string;
  model: { id: string; digest: string; localWeightsPresent: true; remoteHost: null; remoteModel: null };
};

/** Literal loopback only: no DNS, credentials, query, fragment, alternate path,
 * encoded host spelling, trailing dot, IPv4 integer shorthand or remote proxy. */
export function isLiteralLoopbackOllamaUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 256 || raw.trim() !== raw) return false;
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/v1\/chat\/completions$/.test(raw)) return false;
  try {
    const u = new URL(raw);
    return u.port !== '' && Number(u.port) <= 65535 && !u.username && !u.password && !u.search && !u.hash;
  } catch { return false; }
}

/** Concrete local-only no-metered-inference predicate. This is NOT capability,
 * context, model health, residency or availability proof. Existing fail-closed
 * capability/context filtering remains required and must not be bypassed.
 * Native daemon/model identity must prove this exact model maps to local weights,
 * not a cloud alias. Cloud capability on the daemon is not itself disqualifying. */
export function resolveLocalOllamaEvidence(
  request: ZeroCostRequest,
  observation: LocalOllamaObservation | null,
): ZeroCostEvidence | null {
  const o = observation;
  if (!o || request.provider !== 'ollama-local' || o.provider !== request.provider ||
      request.connectionId !== o.connectionId || request.model !== o.model?.id ||
      !isLiteralLoopbackOllamaUrl(o.effectiveChatUrl) || o.transport !== 'direct' ||
      o.request !== request || o.model.localWeightsPresent !== true ||
      o.model.remoteHost !== null || o.model.remoteModel !== null ||
      !/^(?:sha256:)?[a-f0-9]{64}$/.test(o.model.digest) ||
      typeof o.nativeDaemonIdentity !== 'string' || !o.nativeDaemonIdentity || o.nativeDaemonIdentity.length > 128 ||
      typeof o.connectionRevision !== 'string' || !o.connectionRevision || o.connectionRevision.length > 128) return null;
  return {
    provider: request.provider, model: request.model, connectionId: request.connectionId,
    noAdditionalCost: true, request,
    evidenceId: `native-local:${o.model.digest}`,
  };
}

/** A trusted startup adapter may install this resolver only after supplying a
 * real current observer. No fixture/default observation is shipped. Re-read on
 * EVERY admission, including retry model and post-plugin body; no stale closure. */
export function createLocalOllamaResolver(
  readCurrent: (request: ZeroCostRequest) => LocalOllamaObservation | null,
): ZeroCostEvidenceResolver {
  return request => {
    if (request.provider !== 'ollama-local') return null;
    try { return resolveLocalOllamaEvidence(request, readCurrent(request)); }
    catch { return null; }
  };
}
