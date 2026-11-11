import { isHostedTrialUsage } from './hostedTrialUsage.ts';
import type { ZeroCostRequest, ZeroCostEvidence } from './zeroCostAdmission.ts';
export const NVIDIA_TRIAL_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
/** Canonical NVIDIA-hosted catalog endpoint, not downloadable/partner NIM.
 * Official API reference binds this destination; FAQ declares trial no-cost.
 * No credit ledger or invented account provenance field. */
export function isNvidiaTrialUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'integrate.api.nvidia.com' &&
      (u.port === '' || u.port === '443') && u.pathname === '/v1/chat/completions' &&
      !u.username && !u.password && !u.search && !u.hash;
  } catch { return false; }
}
export function projectedNvidiaTrialEvidence(request: ZeroCostRequest, row: {
  id: unknown; updated_at: unknown; auth_type: unknown; base_url: unknown; target_format: unknown;
} | undefined): ZeroCostEvidence | null {
  if (!isHostedTrialUsage() || request.provider !== 'nvidia' || !row || row.id !== request.connectionId ||
      row.auth_type !== 'apikey' || request.body.safeguards !== undefined ||
      typeof request.model !== 'string' || !request.model.trim() ||
      (row.target_format !== null && row.target_format !== undefined && row.target_format !== '' && row.target_format !== 'openai')) return null;
  const base = row.base_url === null || row.base_url === undefined || row.base_url === '' ? NVIDIA_TRIAL_CHAT_URL : row.base_url;
  const configured = typeof base === 'string' && /^https:\/\/integrate\.api\.nvidia\.com(?::443)?\/v1\/?$/.test(base)
    ? base.replace(/\/$/,'') + '/chat/completions' : base;
  if (!isNvidiaTrialUrl(configured) || (request.effectiveChatUrl !== undefined && !isNvidiaTrialUrl(request.effectiveChatUrl))) return null;
  // This is economic admission only. Existing fail-closed central capability,
  // context, model availability and rate-limit checks remain authoritative.
  // The hosted trial class, not a static model price list, supplies cost proof.
  return {provider:request.provider,model:request.model,connectionId:request.connectionId,
    noAdditionalCost:true,request,evidenceId:'nvidia-hosted-trial:2026-10-31'};
}
export async function resolveConfiguredNvidiaTrial(request: ZeroCostRequest): Promise<ZeroCostEvidence | null> {
  if (!isHostedTrialUsage() || request.provider !== 'nvidia') return null;
  const { getDbInstance } = await import('../../../src/lib/db/core');
  const row = getDbInstance().prepare(`SELECT id,updated_at,auth_type,
    json_extract(provider_specific_data,'$.baseUrl') AS base_url,
    json_extract(provider_specific_data,'$.targetFormat') AS target_format
    FROM provider_connections WHERE id = ? AND provider = 'nvidia' AND is_active = 1`).get(request.connectionId) as
      {id:unknown;updated_at:unknown;auth_type:unknown;base_url:unknown;target_format:unknown} | undefined;
  return projectedNvidiaTrialEvidence(request,row);
}
