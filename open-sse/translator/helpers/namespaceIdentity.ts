/**
 * Responses-API namespace tool groups are flattened to Chat functions with a request-scoped
 * identity map ({ flatName -> { namespace, name } }) carried on a non-enumerable `_toolNameMap`
 * property, so the response side can hand the tool call back to the client with its namespace.
 *
 * Other translators use the same property name for a different shape (string alias map), so this
 * guard tells the two apart.
 */
export type NamespaceIdentity = { namespace: string; name: string };

export function isNamespaceIdentityMap(map: unknown): map is Map<string, NamespaceIdentity> {
  if (!(map instanceof Map) || map.size === 0) return false;
  for (const value of map.values()) {
    if (!value || typeof value !== "object") return false;
    const { namespace, name } = value as Record<string, unknown>;
    if (typeof namespace !== "string" || typeof name !== "string") return false;
  }
  return true;
}
