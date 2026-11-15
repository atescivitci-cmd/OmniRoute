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

/** Side channel for the identity map; never collides with the string-valued `_toolNameMap`. */
export const NAMESPACE_IDENTITY_KEY = "_namespaceIdentityMap";

/** Read the identity map a Responses->Chat translator left on its result, if any. */
export function captureNamespaceIdentityMap(
  result: unknown
): Map<string, NamespaceIdentity> | null {
  const map = (result as { _toolNameMap?: unknown } | null | undefined)?._toolNameMap;
  return isNamespaceIdentityMap(map) ? map : null;
}

/** Attach the identity map as a non-enumerable property so it never reaches the upstream wire. */
export function attachNamespaceIdentityMap(
  result: unknown,
  map: Map<string, NamespaceIdentity> | null
): void {
  if (!map || !result || typeof result !== "object") return;
  Object.defineProperty(result, NAMESPACE_IDENTITY_KEY, {
    value: map,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * Split the request-side tool maps off a translated body (and delete both properties).
 * - identityMap: `{ namespace, name }` values, for returning namespaced tool calls to the client.
 * - aliasMap: string-valued aliases (Claude OAuth `proxy_` prefix, Kiro truncated names), used to
 *   map upstream tool names back. A string map is never treated as an identity map.
 */
export function extractRequestToolMaps(body: Record<string, unknown>): {
  identityMap: Map<string, NamespaceIdentity> | null;
  aliasMap: Map<string, string> | null;
} {
  const side = body[NAMESPACE_IDENTITY_KEY];
  const legacy = body._toolNameMap;
  const identityMap = isNamespaceIdentityMap(side)
    ? side
    : isNamespaceIdentityMap(legacy)
      ? legacy
      : null;
  const aliasMap =
    legacy instanceof Map && !isNamespaceIdentityMap(legacy)
      ? (legacy as Map<string, string>)
      : null;
  delete body[NAMESPACE_IDENTITY_KEY];
  delete body._toolNameMap;
  return { identityMap, aliasMap };
}
