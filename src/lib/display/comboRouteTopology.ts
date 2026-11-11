export type ComboRouteRecency = {
  kind: "combo";
  comboId: string;
  comboName: string;
  lastStatus: number | null;
  lastRequestAt: string | null;
  recencyReason?: "ordered" | "malformed_timestamp";
  lastRequestAtMs: number | null;
};

/** These nodes describe the latest observed HTTP outcome, not provider connectivity.
 * Five-minute display freshness is explicit and does not certify availability.
 */
export function comboRouteTopology(rows: ComboRouteRecency[], now: number) {
  return rows.map((row) => {
    const age = row.lastRequestAtMs === null ? NaN : now - row.lastRequestAtMs;
    const fresh = row.recencyReason !== "malformed_timestamp" && Number.isFinite(age) && age >= 0 && age <= 300_000;
    const success = row.lastStatus !== null && row.lastStatus >= 200 && row.lastStatus < 400;
    const status: "active" | "error" | "idle" =
      !fresh || row.lastStatus === null ? "idle" : success ? "active" : "error";
    return {
      kind: "combo" as const,
      id: row.comboId,
      provider: `combo:${row.comboId}`,
      name: `${row.comboName} (combo route · ${fresh ? row.lastStatus ?? "unknown" : "stale/unknown"})`,
      status,
    };
  });
}
