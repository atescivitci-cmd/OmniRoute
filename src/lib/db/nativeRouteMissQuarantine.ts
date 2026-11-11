import { createHash } from "node:crypto";
import { getDbInstance } from "./core";
import { nvidiaAvailabilityRevision } from "./nvidiaModelAvailability";
import {
  ACCOUNT_MODEL_NEGATIVE_TTL_MS,
  createAccountEvidenceClock,
  hasCurrentAccountProofTime,
  hasFreshAccountNegativeTime,
} from "./accountModelEligibilityPolicy";
import { nvidiaProvider } from "../../../open-sse/config/providers/registry/nvidia/index.ts";
import { nvidiaStarCoderRouteMiss } from "../../../open-sse/services/modelEligibilityResponse.ts";
import { markKnownNonDispatch } from "../../../open-sse/services/combo/routingAttemptSafety.ts";
import { normalizeOpenAIChatUrl } from "../../../open-sse/executors/default/urlNormalizers.ts";

// A transient native route miss is distinct from reset-required entitlement facts.
const NS = "nativeRouteMissNegativeV1";
const MODEL = "bigcode/starcoder2-15b";
export const NATIVE_ROUTE_MISS_CODE = "nvidia_native_route_not_found";
export const NATIVE_ROUTE_MISS_TTL_MS = ACCOUNT_MODEL_NEGATIVE_TTL_MS;
export const LOCAL_NATIVE_ROUTE_MISS_RESPONSES = new WeakSet<Response>();
const PUBLIC_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const endpointHash = createHash("sha256").update(PUBLIC_ENDPOINT).digest("hex");
const evidenceNow = createAccountEvidenceClock();
const valid = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 300;
const digest = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
export type NativeRouteMissProof = {
  provider: "nvidia";
  connectionId: string;
  endpointHash: string;
  model: string;
  revision: string;
  capturedAt: number;
};
type Negative = NativeRouteMissProof & { observedAt: string };
type NvidiaEvidence = Parameters<typeof nvidiaStarCoderRouteMiss>[0];
const key = (p: NativeRouteMissProof) =>
  JSON.stringify([p.provider, p.connectionId, p.endpointHash, p.model]);
/** Exact current native endpoint/profile projection; no credential values or arbitrary URLs retained. */
function routeRevision(connectionId: string, model: string, centralAttempt = true): string | null {
  if (nvidiaProvider.baseUrl !== PUBLIC_ENDPOINT) return null;
  const db = getDbInstance();
  const base = nvidiaAvailabilityRevision("nvidia", connectionId, model);
  if (!base) return null;
  const row = db
    .prepare(
      `SELECT json_extract(provider_specific_data,'$.baseUrl') AS base_url,
    json_extract(provider_specific_data,'$.cliproxyapiMode') AS proxy_mode
    FROM provider_connections WHERE id=? AND provider='nvidia'`
    )
    .get(connectionId) as { base_url?: unknown; proxy_mode?: unknown } | undefined;
  if (!row || row.proxy_mode === "claude-native") return null;
  const actualEndpoint =
    typeof row.base_url === "string" && row.base_url.trim()
      ? normalizeOpenAIChatUrl(row.base_url)
      : PUBLIC_ENDPOINT;
  if (actualEndpoint !== PUBLIC_ENDPOINT) return null;
  const hasProxyTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='upstream_proxy_config'")
    .get();
  const proxy = hasProxyTable
    ? (db
        .prepare("SELECT mode,enabled FROM upstream_proxy_config WHERE provider_id='nvidia'")
        .get() as { mode?: unknown; enabled?: unknown } | undefined)
    : undefined;
  const mode = proxy && Number(proxy.enabled) === 1 ? proxy.mode : "native";
  // Noncentral fallback can still use a proxy endpoint; its eligibility is not
  // disproved by native-only evidence. Central NVIDIA explicitly stays native.
  if (mode !== "native" && !(centralAttempt && mode === "fallback")) return null;
  return createHash("sha256")
    .update(JSON.stringify([base, endpointHash, mode]))
    .digest("hex");
}
function current(p: NativeRouteMissProof | null, now: number | null): p is NativeRouteMissProof {
  return (
    !!p &&
    p.provider === "nvidia" &&
    valid(p.connectionId) &&
    p.model === MODEL &&
    p.endpointHash === endpointHash &&
    digest(p.revision) &&
    hasCurrentAccountProofTime(p, now) &&
    routeRevision(p.connectionId, p.model) === p.revision
  );
}
/** Bind the already-selected single-key account proof immediately before dispatch. */
export function captureNativeRouteMissProof(
  provider: string,
  connectionId: string,
  model: string,
  endpoint: unknown,
  selected: { connectionId?: unknown; model?: unknown; revision?: unknown } | null | undefined
): NativeRouteMissProof | null {
  if (
    provider !== "nvidia" ||
    model !== MODEL ||
    !valid(connectionId) ||
    endpoint !== PUBLIC_ENDPOINT ||
    selected?.connectionId !== connectionId ||
    selected?.model !== model ||
    !digest(selected?.revision)
  )
    return null;
  try {
    return getDbInstance().transaction(() => {
      const capturedAt = evidenceNow();
      if (nvidiaAvailabilityRevision(provider, connectionId, model) !== selected.revision)
        return null;
      const revision = routeRevision(connectionId, model);
      if (!revision) return null;
      const proof: NativeRouteMissProof = {
        provider,
        connectionId,
        model,
        endpointHash,
        revision,
        capturedAt: capturedAt as number,
      };
      if (!current(proof, capturedAt)) return null;
      // A selected proof must still name an exact imported/configured model.
      const configured = getDbInstance()
        .prepare(
          `SELECT 1 AS present FROM key_value kv, json_each(kv.value) m
      WHERE ((kv.namespace='syncedAvailableModels' AND kv.key=?) OR (kv.namespace='customModels' AND kv.key='nvidia'))
      AND json_extract(m.value,'$.id')=? LIMIT 1`
        )
        .get(`nvidia:${connectionId}`, model);
      return configured ? proof : null;
    })();
  } catch {
    return null;
  }
}
/** Only actual native, nonredirected, exact public-URL plain404 evidence may seed this cache. */
export function recordNativeRouteMiss(
  proof: NativeRouteMissProof | null,
  e: NvidiaEvidence,
  message: string
): boolean {
  if (
    !proof ||
    e.responseUrl !== PUBLIC_ENDPOINT ||
    e.endpoint !== PUBLIC_ENDPOINT ||
    e.expectedConnection !== proof.connectionId ||
    e.expectedModel !== proof.model ||
    !e.body ||
    typeof e.body !== "object" ||
    Object.keys(e.body).length !== 1 ||
    !nvidiaStarCoderRouteMiss(e, message)
  )
    return false;
  try {
    return getDbInstance().transaction(() => {
      const now = evidenceNow();
      if (!current(proof, now)) return false;
      const row = getDbInstance()
        .prepare("SELECT value FROM key_value WHERE namespace=? AND key=?")
        .get(NS, key(proof)) as { value?: string } | undefined;
      if (row?.value) {
        try {
          const previous = JSON.parse(row.value) as Negative;
          // A delayed older response cannot replace a newer observation or renew it.
          if (
            previous.revision === proof.revision &&
            hasFreshAccountNegativeTime(previous, now) &&
            previous.capturedAt >= proof.capturedAt
          )
            return previous.capturedAt === proof.capturedAt;
        } catch {
          /* corrupt cache data is not evidence */
        }
      }
      const entry: Negative = {
        provider: proof.provider,
        connectionId: proof.connectionId,
        endpointHash: proof.endpointHash,
        model: proof.model,
        revision: proof.revision,
        capturedAt: proof.capturedAt,
        observedAt: new Date(now!).toISOString(),
      };
      getDbInstance()
        .prepare("INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)")
        .run(NS, key(proof), JSON.stringify(entry));
      return true;
    })();
  } catch {
    return false;
  }
}
/** Read-only, fresh selected-account/endpoint/revision validation precedes a known non-dispatch. */
export function getNativeRouteMiss(proof: NativeRouteMissProof | null): Negative | null {
  try {
    const now = evidenceNow();
    if (!current(proof, now)) return null;
    const row = getDbInstance()
      .prepare("SELECT value FROM key_value WHERE namespace=? AND key=?")
      .get(NS, key(proof)) as { value?: string } | undefined;
    if (!row?.value) return null;
    const entry = JSON.parse(row.value) as Negative;
    return entry &&
      entry.provider === proof.provider &&
      entry.connectionId === proof.connectionId &&
      entry.endpointHash === proof.endpointHash &&
      entry.model === proof.model &&
      entry.revision === proof.revision &&
      hasFreshAccountNegativeTime(entry, now)
      ? entry
      : null;
  } catch {
    return null;
  } // Cache I/O failure retains ordinary admission; never grants replay authority.
}

/** Candidate-only read. The optional context comes exclusively from the server attempt owner. */
export function getNativeRouteMissForAccount(
  provider: string,
  connectionId: string,
  model: string,
  centralAttempt = false
): Negative | null {
  if (provider !== "nvidia" || model !== MODEL || !valid(connectionId)) return null;
  try {
    const revision = routeRevision(connectionId, model, centralAttempt);
    const capturedAt = evidenceNow();
    if (!revision || capturedAt === null) return null;
    return getNativeRouteMiss({
      provider,
      connectionId,
      endpointHash,
      model,
      revision,
      capturedAt,
    });
  } catch {
    return null;
  }
}

// A credential-level refusal is trusted only by local object identity, never by
// serialized flags. Auth creates it only when every scoped filter veto is this cache.
const credentialRefusals = new WeakSet<object>();
export function markNativeRouteMissCredentialRefusal<T extends object>(value: T): T {
  credentialRefusals.add(value);
  return value;
}
export function isNativeRouteMissCredentialRefusal(value: unknown): boolean {
  return !!value && typeof value === "object" && credentialRefusals.has(value);
}
export function cachedNativeRouteMissResponse(): Response {
  return markKnownNonDispatch(
    Response.json(
      {
        error: {
          code: NATIVE_ROUTE_MISS_CODE,
          type: "invalid_request_error",
          message: "Selected account/endpoint/model has a recent verified route miss.",
        },
      },
      { status: 404 }
    )
  );
}
