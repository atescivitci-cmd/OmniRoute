import type { TopologyEntry } from "./topologyObservations";

export type TopologyLiveRequest = {
  provider: string;
  model: string;
  comboName?: string;
};

/** Display-only: never changes configured routes or retained observations. */
export function selectTopologyVisibility(
  entries: TopologyEntry[],
  liveRequests: TopologyLiveRequest[],
  showHistory = false
) {
  const combos = entries.filter((entry) => entry.kind === "combo");
  const activeCombos = new Set<string>();
  let hasUnattributedRequest = false;
  for (const request of liveRequests) {
    const references = request.comboName ? [request.comboName] : [request.model, request.provider];
    const matches = combos.filter((entry) =>
      references.some((reference) =>
        [entry.id, entry.provider, entry.comboName].includes(reference)
      )
    );
    // Older live snapshots may omit comboName. Keep all routes when a live
    // request cannot be attributed, rather than hiding a possibly active route.
    if (matches.length === 0) hasUnattributedRequest = true;
    for (const entry of matches) activeCombos.add(entry.id);
  }
  const currentEntries = entries.filter((entry) => {
    if (entry.kind === "history") return false;
    if (entry.kind !== "combo") return true;
    return (
      entry.status === "active" ||
      entry.status === "error" ||
      activeCombos.has(entry.id) ||
      hasUnattributedRequest
    );
  });
  return {
    entries: showHistory ? entries : currentEntries,
    expandableCount: entries.length - currentEntries.length,
    hasUnattributedRequest,
  };
}
