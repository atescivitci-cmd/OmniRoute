import { createHash, randomUUID } from "node:crypto";
import { getDbInstance } from "./core";
import {
  isCodexAccountModelUnsupported,
  createAccountEvidenceClock,
  hasCurrentAccountProofTime,
  hasFreshAccountNegativeTime,
  ACCOUNT_MODEL_NEGATIVE_TTL_MS,
} from "./accountModelEligibilityPolicy";

const evidenceNow = createAccountEvidenceClock();
const NS = "accountModelEligibilityNegativeV1";
const IDENTITY = "accountModelEligibilityIdentityV1";
const RESET = "accountModelEligibilityResetV1";
const valid = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 300;
const key = (id: string, model: string) => JSON.stringify([id, model]);
export type AccountModelProof = {
  provider: "codex";
  connectionId: string;
  model: string;
  revision: string;
  /** Server capture time; late responses never renew this admission evidence window. */
  capturedAt: number;
};
type Negative = AccountModelProof & { observedAt: string; reason: "account_model_unsupported" };

/** Metadata only: neither reads nor hashes any credential value. */
export function accountModelRevision(
  provider: string,
  connectionId: string,
  model: string
): string | null {
  if (provider !== "codex" || !valid(connectionId) || !valid(model)) return null;
  try {
    const db = getDbInstance();
    const row = db
      .prepare(
        `SELECT id,created_at,auth_type,proxy_enabled,per_key_proxy_enabled,
      json_extract(provider_specific_data,'$.baseUrl') AS base_url,
      json_extract(provider_specific_data,'$.targetFormat') AS target_format,
      json_extract(provider_specific_data,'$.cliproxyapiMode') AS cliproxyapi_mode,
      json_extract(provider_specific_data,'$.workspaceId') AS workspace_id,
      json_extract(provider_specific_data,'$.chatgptUserId') AS user_id,
      json_extract(provider_specific_data,'$.workspacePlanType') AS plan_type,
      json_type(provider_specific_data,'$.extraApiKeys') AS extra_type,
      json_array_length(provider_specific_data,'$.extraApiKeys') AS extra_count
      FROM provider_connections WHERE id=? AND provider='codex'`
      )
      .get(connectionId) as Record<string, unknown> | undefined;
    if (
      !row ||
      row.auth_type !== "oauth" ||
      row.cliproxyapi_mode === "claude-native" ||
      (row.extra_type != null && row.extra_type !== "null" && row.extra_type !== "array") ||
      Number(row.extra_count || 0) > 0
    )
      return null;
    const hasProxyTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='upstream_proxy_config'")
      .get();
    const proxy = hasProxyTable
      ? (db
          .prepare("SELECT mode,enabled FROM upstream_proxy_config WHERE provider_id='codex'")
          .get() as { mode?: unknown; enabled?: unknown } | undefined)
      : undefined;
    // Evidence produced by the native selected account cannot assert proxy entitlement.
    if (proxy && Number(proxy.enabled) === 1 && proxy.mode !== "native") return null;
    const value = (namespace: string, itemKey: string) =>
      (
        db
          .prepare("SELECT value FROM key_value WHERE namespace=? AND key=?")
          .get(namespace, itemKey) as { value?: unknown } | undefined
      )?.value;
    const descriptors = (raw: unknown) => {
      if (raw === undefined) return [];
      if (typeof raw !== "string") throw new Error("invalid catalog");
      const list: unknown = JSON.parse(raw);
      if (!Array.isArray(list)) throw new Error("invalid catalog");
      return list
        .map((item: any) => [item?.id, item?.apiFormat, item?.targetFormat, item?.upstreamProtocol])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    };
    return createHash("sha256")
      .update(
        JSON.stringify([
          row,
          value(IDENTITY, connectionId),
          value(RESET, key(connectionId, model)),
          descriptors(value("syncedAvailableModels", `codex:${connectionId}`)),
          descriptors(value("customModels", "codex")),
        ])
      )
      .digest("hex");
  } catch {
    return null;
  }
}
export function captureAccountModelProof(
  provider: string,
  connectionId: string,
  model: string | null,
  observedUpdatedAt: unknown
): AccountModelProof | null {
  if (provider !== "codex" || !model || typeof observedUpdatedAt !== "string") return null;
  try {
    return getDbInstance().transaction(() => {
      const row = getDbInstance()
        .prepare("SELECT updated_at FROM provider_connections WHERE id=? AND provider='codex'")
        .get(connectionId) as { updated_at?: unknown } | undefined;
      if (!row || row.updated_at !== observedUpdatedAt) return null;
      const revision = accountModelRevision(provider, connectionId, model);
      const capturedAt = evidenceNow();
      return revision && capturedAt !== null
        ? { provider: "codex" as const, connectionId, model, revision, capturedAt }
        : null;
    })();
  } catch {
    return null;
  }
}
export function recordAccountModelNegative(
  proof: AccountModelProof | null,
  provider: string,
  connectionId: string,
  model: string,
  status: number,
  message: string
): boolean {
  if (
    !proof ||
    proof.provider !== provider ||
    proof.connectionId !== connectionId ||
    proof.model !== model ||
    !isCodexAccountModelUnsupported(provider, status, model, message)
  )
    return false;
  try {
    return getDbInstance().transaction(() => {
      if (!proof.revision || proof.revision !== accountModelRevision(provider, connectionId, model))
        return false;
      const now = evidenceNow();
      if (!hasCurrentAccountProofTime(proof, now)) return false;
      const existingRow = getDbInstance()
        .prepare("SELECT value FROM key_value WHERE namespace=? AND key=?")
        .get(NS, key(connectionId, model)) as { value?: string } | undefined;
      if (existingRow?.value) {
        try {
          const existing = JSON.parse(existingRow.value) as Negative;
          // A delayed response may not replace a newer same-generation observation.
          if (
            existing &&
            existing.provider === provider &&
            existing.connectionId === connectionId &&
            existing.model === model &&
            existing.reason === "account_model_unsupported" &&
            existing.revision === proof.revision &&
            hasFreshAccountNegativeTime(existing, now) &&
            existing.capturedAt > proof.capturedAt
          )
            return false;
        } catch {
          /* Invalid old data does not become admission authority. */
        }
      }
      const entry: Negative = {
        ...proof,
        observedAt: new Date(now!).toISOString(),
        reason: "account_model_unsupported",
      };
      getDbInstance()
        .prepare("INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)")
        .run(NS, key(connectionId, model), JSON.stringify(entry));
      return true;
    })();
  } catch {
    return false;
  }
}
/** Diagnostic timing uses the same effective clock as negative admission. */
export function getAccountModelNegativeTiming(entry: Negative | null) {
  if (!entry) return null;
  const now = evidenceNow();
  if (!hasFreshAccountNegativeTime(entry, now)) return null;
  const until = entry.capturedAt + ACCOUNT_MODEL_NEGATIVE_TTL_MS;
  return { until, remainingMs: until - now! };
}
export function getAccountModelNegative(
  provider: string,
  connectionId: string,
  model: string
): Negative | null {
  if (provider !== "codex" || !valid(connectionId) || !valid(model)) return null;
  try {
    const row = getDbInstance()
      .prepare("SELECT value FROM key_value WHERE namespace=? AND key=?")
      .get(NS, key(connectionId, model)) as { value?: string } | undefined;
    if (!row?.value) return null;
    const entry = JSON.parse(row.value) as Negative;
    const currentRevision = accountModelRevision(provider, connectionId, model);
    if (
      !entry ||
      typeof entry.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.revision) ||
      typeof currentRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(currentRevision)
    )
      return null;
    return entry.provider === provider &&
      entry.connectionId === connectionId &&
      entry.model === model &&
      entry.reason === "account_model_unsupported" &&
      hasFreshAccountNegativeTime(entry, evidenceNow()) &&
      entry.revision === currentRevision
      ? entry
      : null;
  } catch {
    return null;
  }
}
export function invalidateAccountModelIdentity(connectionId: string): void {
  getDbInstance()
    .prepare("INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)")
    .run(IDENTITY, connectionId, randomUUID());
}
export function clearAccountModelNegatives(connectionId?: string, model?: string): boolean {
  const db = getDbInstance();
  return db.transaction(() => {
    const accounts = connectionId
      ? [{ id: connectionId }]
      : (db.prepare("SELECT id FROM provider_connections WHERE provider='codex'").all() as {
          id: string;
        }[]);
    for (const account of accounts)
      db.prepare("INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)").run(
        model ? RESET : IDENTITY,
        model ? key(account.id, model) : account.id,
        randomUUID()
      );
    const rows = db.prepare("SELECT key,value FROM key_value WHERE namespace=?").all(NS) as {
      key: string;
      value: string;
    }[];
    let changed = false;
    for (const row of rows) {
      let entry: Negative;
      try {
        entry = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (
        (!connectionId || entry.connectionId === connectionId) &&
        (!model || entry.model === model)
      ) {
        db.prepare("DELETE FROM key_value WHERE namespace=? AND key=?").run(NS, row.key);
        changed = true;
      }
    }
    return changed;
  })();
}
export function listAccountModelNegatives(): Negative[] {
  try {
    return (
      getDbInstance().prepare("SELECT value FROM key_value WHERE namespace=?").all(NS) as {
        value: string;
      }[]
    ).flatMap((row) => {
      try {
        const entry = JSON.parse(row.value) as Negative;
        return getAccountModelNegative(entry.provider, entry.connectionId, entry.model)
          ? [entry]
          : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
export function allScopedAccountsIneligible(
  provider: string,
  model: string,
  allowed: string[] | null,
  forced?: string | null,
  excluded: string[] = []
): boolean {
  if (provider !== "codex" || !valid(model)) return false;
  try {
    const rows = getDbInstance()
      .prepare("SELECT id FROM provider_connections WHERE provider='codex' AND is_active=1")
      .all() as { id: string }[];
    const scope = rows.filter(
      (row) =>
        (!allowed || allowed.includes(row.id)) &&
        (!forced || row.id === forced) &&
        !excluded.includes(row.id)
    );
    return (
      scope.length > 0 && scope.every((row) => !!getAccountModelNegative(provider, row.id, model))
    );
  } catch {
    return false;
  }
}
