import { request as httpRequest } from 'node:http';
import { isLiteralLoopbackOllamaUrl, type LocalOllamaObservation } from './localOllamaAdmission.ts';
import type { ZeroCostRequest } from './zeroCostAdmission.ts';

export type NativeLocalBinding = {
  connectionId: string; connectionRevision: string;
  effectiveChatUrl: string; nativeDaemonIdentity: string;
  /** Supplied by the effective executor transport, not connection label. */
  directTransport: true;
};

/** Direct bounded metadata GET. No proxy dispatcher, redirects, authentication,
 * inference, model pulls, quota fetches or lazy credential reads. */
function metadata(url: URL, signal?: AbortSignal, payload?: {model:string}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const req = httpRequest(url, {method:payload ? 'POST' : 'GET', agent:false, signal, headers:{Accept:'application/json',...(payload ? {'Content-Type':'application/json'} : {})}}, res => {
      if (res.statusCode !== 200) { res.destroy(); reject(new Error('local_metadata_unavailable')); return; }
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 262144) { req.destroy(new Error('local_metadata_too_large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('local_metadata_aborted')));
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          resolve(value);
        } catch { reject(new Error('local_metadata_invalid')); }
      });
    });
    // Absolute deadline, not an inactivity timer that slow input can extend.
    const timer = setTimeout(() => req.destroy(new Error('local_metadata_timeout')), 2000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

/** Concrete same-request observer for an ALREADY configured/qualified native
 * local connection. Not invoked by this experiment until installed binding is
 * known. Residency + matching native tags digest proves this model-specific
 * subset without requiring the daemon to disable all cloud capabilities. */
export async function observeLocalOllama(
  request: ZeroCostRequest, binding: NativeLocalBinding, signal?: AbortSignal,
): Promise<{observation: LocalOllamaObservation; contextLength: number; capabilities:string[]} | null> {
  if (request.provider !== 'ollama-local' || request.connectionId !== binding.connectionId ||
      binding.directTransport !== true || !isLiteralLoopbackOllamaUrl(binding.effectiveChatUrl)) return null;
  try {
    const base = new URL(binding.effectiveChatUrl);
    const [ps, tags] = await Promise.all([
      metadata(new URL('/api/ps', base), signal), metadata(new URL('/api/tags', base), signal),
    ]);
    if (!Array.isArray(ps.models) || !Array.isArray(tags.models)) return null;
    const matching = (row: any) => row && row.name === request.model && row.model === request.model;
    const resident = ps.models.filter(matching), stored = tags.models.filter(matching);
    if (resident.length !== 1 || stored.length !== 1) return null;
    const p = resident[0], t = stored[0];
    if (typeof p.digest !== 'string' || !/^[a-f0-9]{64}$/.test(p.digest) || p.digest !== t.digest ||
        !Number.isFinite(t.size) || t.size <= 0 || !Number.isSafeInteger(p.context_length) || p.context_length <= 0 ||
        [p,t].some(row => [row.remote_host,row.remote_model].some(v => v !== undefined && v !== null && v !== ''))) return null;
    // Metadata only; /api/show does not run inference or load a model. Do not
    // return its template/system text: retain only capability flags.
    const show = await metadata(new URL('/api/show',base),signal,{model:request.model});
    if (!Array.isArray(show.capabilities) || !show.capabilities.every(v => typeof v === 'string') ||
        !show.capabilities.includes('completion') ||
        [show.remote_host,show.remote_model].some(v => v !== undefined && v !== null && v !== '')) return null;
    return {contextLength:p.context_length, capabilities:show.capabilities as string[], observation:{
      request, provider:'ollama-local', connectionId:request.connectionId,
      connectionRevision:binding.connectionRevision, effectiveChatUrl:binding.effectiveChatUrl,
      nativeDaemonIdentity:binding.nativeDaemonIdentity, transport:'direct',
      model:{id:request.model,digest:p.digest,localWeightsPresent:true,remoteHost:null,remoteModel:null},
    }};
  } catch { return null; }
}
