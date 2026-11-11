import { observeLocalOllama } from './observeLocalOllama.ts';
import { resolveLocalOllamaEvidence, isLiteralLoopbackOllamaUrl } from './localOllamaAdmission.ts';
import type { ZeroCostRequest } from './zeroCostAdmission.ts';

/** Production local subset: only safe projected connection metadata. No auth
 * fields, entire providerSpecificData, quota loader or credential getter. */
export async function resolveConfiguredLocalOllama(request: ZeroCostRequest) {
  if (request.provider !== 'ollama-local' || request.body.safeguards !== undefined) return null;
  const { getDbInstance } = await import('../../../src/lib/db/core');
  const db = getDbInstance();
  const row = db.prepare(`SELECT id, updated_at,
    json_extract(provider_specific_data, '$.baseUrl') AS base_url,
    json_extract(provider_specific_data, '$.targetFormat') AS target_format
    FROM provider_connections WHERE id = ? AND provider = 'ollama-local' AND is_active = 1`).get(request.connectionId) as
      {id:string;updated_at:string;base_url:unknown;target_format:unknown} | undefined;
  if (!row || typeof row.base_url !== 'string' || (row.target_format && row.target_format !== 'openai')) return null;
  const base = row.base_url.replace(/\/$/,'');
  const url = base.endsWith('/chat/completions') ? base : base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  if (!isLiteralLoopbackOllamaUrl(url) || (request.effectiveChatUrl !== undefined && request.effectiveChatUrl !== url)) return null;
  // The configured canonical native provider plus native ps/tags protocol is
  // the service binding. Final executor additionally verifies direct transport.
  const result = await observeLocalOllama(request, {
    connectionId:row.id, connectionRevision:String(row.updated_at),
    effectiveChatUrl:url, nativeDaemonIdentity:`ollama-local:${new URL(url).origin}`,
    directTransport:true,
  },request.signal);
  if (!result) return null;
  if (Array.isArray(request.body.tools) && request.body.tools.length > 0 && !result.capabilities.includes('tools')) return null;
  // At final dispatch use the actual native context, not a larger catalog default.
  // Keep the router's existing estimator (heuristic, not tokenizer proof), and
  // inspect the post-compression body so valid compression is not precluded.
  if (request.effectiveChatUrl !== undefined) {
    const { estimateTokens } = await import('../contextManager.ts');
    const output = request.body.max_completion_tokens ?? request.body.max_tokens;
    const estimated = estimateTokens(request.body);
    if (!Number.isFinite(estimated) || estimated < 0 || typeof output !== 'number' || !Number.isSafeInteger(output) || output <= 0 ||
        estimated + output > result.contextLength) return null;
  }
  return resolveLocalOllamaEvidence(request,result.observation);
}
