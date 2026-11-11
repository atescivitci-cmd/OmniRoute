import { comboRouteTopology, type ComboRouteRecency } from "./comboRouteTopology";
export type TopologyEntry = {
  kind: "provider" | "combo" | "history";
  id: string;
  provider: string;
  name?: string;
  comboName?: string;
  status?: "active" | "error" | "idle";
  observedStatus?: number | null;
  observedAt?: string | null;
  detail?: string;
};
type Metric = {
  lastStatus?: number | null;
  lastRequestAt?: string | null;
  lastErrorAt?: string | null;
};
export const TOPOLOGY_DISPLAY_FRESHNESS_MS = 300_000; // Display window, not a health SLO.
function topologyTime(value: string | null | undefined): number {
  return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? Date.parse(value)
    : NaN;
}
export function recentTopologyTime(value: string | null | undefined, now: number): boolean {
  const time = topologyTime(value);
  return Number.isFinite(time) && now >= time && now - time <= TOPOLOGY_DISPLAY_FRESHNESS_MS;
}
export function deriveTopologyObservations(
  providers: TopologyEntry[],
  metrics: Record<string, Metric>,
  routes: ComboRouteRecency[],
  now: number,
  normalize: (value: string) => string = (value) => value.toLowerCase()
) {
  const registered = new Set(providers.map((p) => normalize(p.provider)));
  const comboNames = new Set(routes.map((r) => r.comboName.toLowerCase()));
  const history: TopologyEntry[] = [];
  const observations = new Map<string, Metric>();
  const errorProviders = new Set<string>();
  let lastProvider = "";
  let lastTime = -Infinity;
  for (const [raw, metric] of Object.entries(metrics)) {
    const canonical = normalize(raw);
    const alias = comboNames.has(raw.toLowerCase());
    const fresh = recentTopologyTime(metric.lastRequestAt, now);
    const status =
      typeof metric.lastStatus === "number" && Number.isFinite(metric.lastStatus)
        ? metric.lastStatus
        : null;
    const timestamp = topologyTime(metric.lastRequestAt);
    const uncertainTime = !Number.isFinite(timestamp) || timestamp > now;
    if (alias || !registered.has(canonical) || uncertainTime) {
      // These are retained log groups, not configured vendor connections. A name
      // collision is ambiguous too: preserve it without recoloring a real provider.
      history.push({
        kind: "history",
        id: raw,
        provider: `history:${raw}`,
        status: "idle",
        observedStatus: status,
        observedAt: metric.lastRequestAt ?? null,
        name: `${raw} (${alias ? "route history" : uncertainTime ? "unknown-time history" : "unattributed history"} · HTTP ${status ?? "unknown"} · ${fresh ? "recent" : "stale/unknown"})`,
        detail: `Historical call-log provider field; ${alias ? "matches a combo alias, not proof of a vendor" : uncertainTime ? "timestamp is malformed, timezone-unqualified or in the future" : "no configured provider attribution"}. Last recorded: ${metric.lastRequestAt ?? "unknown"}. Records are retained; this is not current provider health.`,
      });
      continue;
    }
    const prior = observations.get(canonical);
    const priorTime = topologyTime(prior?.lastRequestAt),
      nextTime = topologyTime(metric.lastRequestAt);
    if (
      prior &&
      Number.isFinite(priorTime) &&
      (!Number.isFinite(nextTime) || priorTime >= nextTime)
    )
      continue;
    observations.set(canonical, metric);
  }
  for (const [canonical, metric] of observations) {
    const fresh = recentTopologyTime(metric.lastRequestAt, now);
    const status =
      typeof metric.lastStatus === "number" && Number.isFinite(metric.lastStatus)
        ? metric.lastStatus
        : null;
    if (!fresh) continue;
    const time = Date.parse(metric.lastRequestAt!);
    if (time > lastTime) {
      lastTime = time;
      lastProvider = canonical;
    }
    if (status !== null && (status < 200 || status >= 400)) errorProviders.add(canonical);
  }
  const comboEntries = comboRouteTopology(routes, now).map((p, i) => ({
    ...p,
    id: p.id,
    comboName: routes[i].comboName,
    observedStatus: routes[i].lastStatus,
    observedAt: routes[i].lastRequestAt,
    detail: `Latest combo HTTP outcome, not provider connectivity. Last recorded: ${routes[i].lastRequestAt ?? "unknown"}. Five-minute display freshness only.`,
  }));
  const providerEntries = providers.map((p) => {
    const metric = observations.get(normalize(p.provider));
    return {
      ...p,
      observedStatus: metric?.lastStatus ?? null,
      observedAt: metric?.lastRequestAt ?? null,
      detail: `Configured provider; reported connection state is not an inference guarantee. Latest recorded HTTP: ${metric?.lastStatus ?? "unknown"} at ${metric?.lastRequestAt ?? "unknown"}. Recent traffic annotations expire after five minutes.`,
    };
  });
  return {
    entries: [...providerEntries, ...comboEntries, ...history] as TopologyEntry[],
    lastProvider,
    errorProviders: [...errorProviders],
    recentRouteErrors: comboEntries.filter((p) => p.status === "error").length,
    historyCount: history.length,
  };
}

// Rectangular packing using the actual measured label widths. Explicit node
// dimensions prevent long labels from growing into neighbors; full text is a tooltip.
export function topologyPositions(widths: number[], containerWidth: number) {
  const single = containerWidth < 900;
  const gap = 32,
    row = 68,
    routerWidth = 180;
  const maxWidth = Math.max(
    136,
    single ? containerWidth - 64 : (containerWidth - routerWidth - 2 * gap - 64) / 2
  );
  const packed = widths.map((w) => Math.max(136, Math.min(maxWidth, w)));
  const leftWidth = Math.max(136, ...packed.filter((_, i) => i % 2 === 0));
  const rows = Math.ceil(packed.length / 2);
  return {
    single,
    height: single ? Math.max(300, (packed.length + 1) * row + 64) : Math.max(420, rows * row + 80),
    router: { x: -routerWidth / 2, y: single ? -row - 22 : -22 },
    nodes: packed.map((width, i) => ({
      width,
      height: 52,
      x: single
        ? -width / 2
        : i % 2 === 0
          ? -routerWidth / 2 - gap - leftWidth
          : routerWidth / 2 + gap,
      y: single ? i * row - 26 : (Math.floor(i / 2) - (rows - 1) / 2) * row - 26,
      side: single ? "bottom" : i % 2 === 0 ? "left" : "right",
    })),
  };
}
