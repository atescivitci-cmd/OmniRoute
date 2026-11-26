/**
 * Tool-calling verdict for one model id across the synced models.dev catalog (model_capabilities),
 * for ROUTING_TOOLS_FROM_CATALOG (open-sse/services/autoCombo/fitFirstPolicy.ts).
 *
 * The capability resolver reads tool_call only from the routing provider's own catalog rows. A
 * model hosted by a provider with no row of its own (live: nvidia/moonshotai/kimi-k3.1-pro) is
 * therefore "unknown" even when models.dev lists the same model id under other hosts. This reads
 * every row of the same model id (exact id, or the same last path segment):
 *   - any row with tool_call = false  -> false (an explicit negative always wins)
 *   - else any row with tool_call = true -> true
 *   - else null (no evidence)
 * Model id only: no provider name decides it.
 */
import { getDbInstance } from "./core";

const cache = new Map<string, { at: number; value: boolean | null }>();
const TTL_MS = 60_000;

export function getCatalogToolCallVerdict(modelId: string, now = Date.now()): boolean | null {
  const id = String(modelId ?? "")
    .trim()
    .toLowerCase();
  if (!id) return null;
  const hit = cache.get(id);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const leaf = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const db = getDbInstance();
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_capabilities'")
    .get();
  let value: boolean | null = null;
  if (table) {
    const row = db
      .prepare(
        `SELECT SUM(CASE WHEN tool_call = 1 THEN 1 ELSE 0 END) AS yes,
                SUM(CASE WHEN tool_call = 0 THEN 1 ELSE 0 END) AS no
         FROM model_capabilities
         WHERE lower(model_id) = ? OR lower(model_id) = ? OR lower(model_id) LIKE ?`
      )
      .get(id, leaf, `%/${leaf}`) as { yes: number | null; no: number | null } | undefined;
    if (Number(row?.no ?? 0) > 0) value = false;
    else if (Number(row?.yes ?? 0) > 0) value = true;
  }
  cache.set(id, { at: now, value });
  return value;
}

/** Test seam. */
export function _clearCatalogToolEvidenceCache(): void {
  cache.clear();
}
