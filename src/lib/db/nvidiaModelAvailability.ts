import { createHash, randomUUID } from 'node:crypto';
import { getDbInstance } from './core';
const NS = 'nvidiaAccountModelNegativeV1';
type Entry = { provider: 'nvidia'; connectionId: string; model: string; revision: string; pairRevision?: string; observedAt: string; reason: 'nvidia_account_function_not_found' };
const keyFor = (connectionId: string, model: string) => JSON.stringify([connectionId,model]);
const valid = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 300;
/** Current metadata revision only. No credential columns, decrypted views or remote requests. */
function metadataRevision(provider: string, connectionId: string, model: string, legacy: boolean): string | null {
  if (provider !== 'nvidia' || !valid(connectionId)) return null;
  try {
    const db = getDbInstance();
    const row = db.prepare(`SELECT id,created_at,auth_type,proxy_enabled,per_key_proxy_enabled,
      json_extract(provider_specific_data,'$.baseUrl') AS base_url,
      json_extract(provider_specific_data,'$.targetFormat') AS target_format,
      json_type(provider_specific_data,'$.extraApiKeys') AS extra_keys_type,
      json_array_length(provider_specific_data,'$.extraApiKeys') AS extra_keys_count
      FROM provider_connections WHERE id=? AND provider='nvidia'`).get(connectionId);
    if (!row) return null;
    const projected = row as { extra_keys_type?: string | null; extra_keys_count?: number | null };
    if ((projected.extra_keys_type != null && projected.extra_keys_type !== 'null' && projected.extra_keys_type !== 'array') || Number(projected.extra_keys_count || 0) > 0) return null;
    const catalog = db.prepare("SELECT value FROM key_value WHERE namespace='syncedAvailableModels' AND key=?").get(`nvidia:${connectionId}`) as {value?:unknown} | undefined;
    const reset = db.prepare("SELECT value FROM key_value WHERE namespace='nvidiaAccountModelResetV1' AND key=?").get(keyFor(connectionId,model));
    const identity = db.prepare("SELECT value FROM key_value WHERE namespace='nvidiaAccountModelIdentityV1' AND key=?").get(connectionId);
    const custom = db.prepare("SELECT value FROM key_value WHERE namespace='customModels' AND key='nvidia'").get() as {value?:unknown} | undefined;
    // Only stable published model descriptors participate, never arbitrary model headers.
    const ids = (value: unknown) => {
      if (typeof value !== 'string') return [];
      const list: unknown = JSON.parse(value); if (!Array.isArray(list)) throw new Error('invalid catalog');
      return list.filter((m: any) => legacy || m?.id === model).map((m: any) => [m?.id,m?.apiFormat,m?.targetFormat,m?.upstreamProtocol]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    };
    return createHash('sha256').update(JSON.stringify([row,identity,reset,ids(catalog?.value),ids(custom?.value)])).digest('hex');
  } catch { return null; }
}
export function nvidiaAvailabilityRevision(provider: string, connectionId: string, model = ""): string | null {
  return metadataRevision(provider,connectionId,model,false);
}
export function recordNvidiaModelNegative(connectionId: string, model: string, attemptRevision: string | null): boolean {
  try { return getDbInstance().transaction(() => {
  if (!valid(model) || !attemptRevision || nvidiaAvailabilityRevision('nvidia',connectionId,model) !== attemptRevision) return false;
  // Only configured/imported model identifiers are eligible for durable marking.
  const configured = getDbInstance().prepare(`SELECT 1 AS present FROM key_value kv, json_each(kv.value) m
    WHERE ((kv.namespace='syncedAvailableModels' AND kv.key=?) OR (kv.namespace='customModels' AND kv.key='nvidia'))
    AND json_extract(m.value,'$.id')=? LIMIT 1`).get(`nvidia:${connectionId}`,model);
  if (!configured) return false;
  const revision=metadataRevision('nvidia',connectionId,model,true);
  if (!revision) return false;
  // Leave the old revision readable by an older runtime after rollback.
  const entry: Entry = {provider:'nvidia',connectionId,model,revision,pairRevision:attemptRevision,observedAt:new Date().toISOString(),reason:'nvidia_account_function_not_found'};
  getDbInstance().prepare('INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)').run(NS,keyFor(connectionId,model),JSON.stringify(entry));
  return true;
  })(); } catch { return false; }
}
export function getNvidiaModelNegative(provider: string, connectionId: string, model: string): Entry | null {
  if (provider !== 'nvidia' || !valid(connectionId) || !valid(model)) return null;
  try { return getDbInstance().transaction((): Entry | null => {
    const row=getDbInstance().prepare('SELECT value FROM key_value WHERE namespace=? AND key=?').get(NS,keyFor(connectionId,model)) as {value?:string}|undefined;
    if (!row?.value) return null;
    const e=JSON.parse(row.value) as Entry;
    if(e.provider!==provider || e.connectionId!==connectionId || e.model!==model || e.reason!=='nvidia_account_function_not_found' || typeof e.revision!=='string' || !/^[a-f0-9]{64}$/.test(e.revision)) return null;
    const pair=nvidiaAvailabilityRevision(provider,connectionId,model);
    if(!pair) return null;
    if(e.pairRevision!==undefined) return e.pairRevision===pair ? e : null;
    if(e.revision!==metadataRevision(provider,connectionId,model,true)) return null;
    // Only upgrade *still valid* legacy evidence, preserving its legacy digest
    // and observation time. Never overwrite a reset or replacement row.
    const upgraded={...e,pairRevision:pair};
    try {
      const updated=getDbInstance().prepare('UPDATE key_value SET value=? WHERE namespace=? AND key=? AND value=?')
        .run(JSON.stringify(upgraded),NS,keyFor(connectionId,model),row.value);
      return updated.changes===1 ? upgraded : null;
    } catch { return e; } // Still honor verified evidence on a read-only store.
  })(); } catch { return null; }
}
export function clearNvidiaModelNegatives(connectionId?: string, model?: string): boolean {
  const db=getDbInstance();
  return db.transaction(() => {
  const accounts = connectionId ? [{ id: connectionId }] : db.prepare("SELECT id FROM provider_connections WHERE provider='nvidia'").all() as {id:string}[];
  // Explicit reset invalidates earlier in-flight evidence even when no negative row exists yet.
  for (const account of accounts) db.prepare('INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)').run(
    model ? 'nvidiaAccountModelResetV1' : 'nvidiaAccountModelIdentityV1', model ? keyFor(account.id,model) : account.id, randomUUID());
  const rows=db.prepare('SELECT key,value FROM key_value WHERE namespace=?').all(NS) as {key:string;value:string}[];
  let changed=false;
  for(const row of rows){
    let e:Entry; try{e=JSON.parse(row.value);}catch{continue;}
    if ((!connectionId || e.connectionId===connectionId) && (!model || e.model===model)) {
      db.prepare('DELETE FROM key_value WHERE namespace=? AND key=?').run(NS,row.key);changed=true;
    }
  }
  return changed;
  })();
}
export function listNvidiaModelNegatives(): Entry[] {
  try {
    const rows=getDbInstance().prepare('SELECT value FROM key_value WHERE namespace=?').all(NS) as {value:string}[];
    return rows.flatMap(row=>{try{const e=JSON.parse(row.value) as Entry;return getNvidiaModelNegative(e.provider,e.connectionId,e.model) ? [e] : [];}catch{return [];}});
  }catch{return [];}
}

export function invalidateNvidiaModelIdentity(connectionId: string): void {
  getDbInstance().prepare('INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)').run('nvidiaAccountModelIdentityV1',connectionId,randomUUID());
  // Called inside the provider-update transaction. Generation alone invalidates all old entries.
  // Retain old metadata rows until explicit reset or replacement; never nest/commit the caller transaction.
}
/** Interpret a no-credential result as model-specific only when every scoped active account has matching evidence. */
export function allScopedNvidiaAccountsNegative(provider: string, model: string, allowed: string[] | null,
  forced?: string | null, excluded: string[] = []): boolean {
  if (provider !== 'nvidia' || !valid(model)) return false;
  try {
    const rows=getDbInstance().prepare("SELECT id FROM provider_connections WHERE provider='nvidia' AND is_active=1").all() as {id:string}[];
    const scoped=rows.filter(r=>(!allowed || allowed.includes(r.id)) && (!forced || r.id===forced) && !excluded.includes(r.id));
    return scoped.length>0 && scoped.every(r=>!!getNvidiaModelNegative(provider,r.id,model));
  }catch{return false;}
}

export function captureNvidiaSelectionProof(provider: string, connectionId: string, model: string | null, observedUpdatedAt: unknown) {
  if (provider !== 'nvidia' || !model || typeof observedUpdatedAt !== 'string') return null;
  try { return getDbInstance().transaction(() => {
    const row=getDbInstance().prepare("SELECT updated_at FROM provider_connections WHERE id=? AND provider='nvidia'").get(connectionId) as {updated_at?:unknown}|undefined;
    if (!row || row.updated_at !== observedUpdatedAt) return null;
    const revision=nvidiaAvailabilityRevision(provider,connectionId,model);
    return revision ? {connectionId,model,revision} : null;
  })(); } catch { return null; }
}
