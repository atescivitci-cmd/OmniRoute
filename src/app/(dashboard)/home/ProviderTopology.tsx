"use client";

import { useMemo, useEffect, useRef, useState } from "react";
import { topologyPositions, type TopologyEntry } from "@/lib/display/topologyObservations";
import { useTranslations } from "next-intl";
import { Handle, Position, type Node, type Edge, type NodeTypes } from "@xyflow/react";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { FlowCanvas } from "@/shared/components/flow/FlowCanvas";
import { StatusDot } from "@/shared/components/flow/StatusDot";
import { edgeStyle, FLOW_EDGE_COLORS } from "@/shared/components/flow/edgeStyles";
import { getFallbackProviderColor } from "@/shared/utils/providerFallbackColor";
import { resolveTopologyNodeLabel } from "./topologyLabel";

type ProviderConfig = { color?: string; name?: string; textIcon?: string };

function getProviderConfig(providerId: string): ProviderConfig {
  // Predefined providers keep their registry color/name untouched. Anything else (custom
  // openai-compatible-*/anthropic-compatible-* provider_nodes) gets a deterministic,
  // per-id fallback color instead of one shared gray — see #8328.
  return (
    (AI_PROVIDERS as Record<string, ProviderConfig>)[providerId] || {
      color: getFallbackProviderColor(providerId),
      name: providerId,
    }
  );
}

type ProviderNodeData = {
  label: string;
  color: string;
  providerId: string;
  active: boolean;
  error: boolean;
  /** Connection-health base state: a healthy connection with no in-flight traffic. */
  healthy: boolean;
  /** Most recently routed provider. Orthogonal to health — it can be last *and* healthy. */
  last: boolean;
  history: boolean;
  recordedError: boolean;
  detail: string;
  width: number;
  observedAt?: string | null;
};

function ProviderNode({ data }: { data: ProviderNodeData }) {
  const { label, color, providerId, active, error, healthy, last, history, recordedError, detail, width, observedAt } = data;
  const GREEN = FLOW_EDGE_COLORS.active;
  const RED = FLOW_EDGE_COLORS.error;
  const AMBER = FLOW_EDGE_COLORS.last;
  // "Last routed" is a traffic annotation, not a health state: the border keeps saying
  // whether the connection is up, and only the dot turns amber to mark recency.
  const dotColor = active ? color : last ? AMBER : GREEN;

  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border-2 transition-all duration-300 bg-bg"
      title={`${label}
${detail}`}
      tabIndex={0}
      aria-label={`${label}. ${detail}`}
      style={{
        width, height:52, boxSizing:"border-box", borderStyle:history ? "dashed" : "solid",
        borderColor: error ? RED : active ? color : healthy ? GREEN : "var(--color-border)",
        boxShadow: error
          ? `0 0 12px ${RED}30`
          : active
            ? `0 0 12px ${color}30`
            : healthy
              ? `0 0 10px ${GREEN}20`
              : "none",
        minWidth: "136px",
        maxWidth: width,
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Right}
        id="right"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      <div
        className="size-6 rounded flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18` }}
      >
        <ProviderIcon providerId={providerId} size={16} type="color" />
      </div>

      <div className="min-w-0 flex-1">
      <span
        className="block text-xs font-medium truncate"
        style={{
          color: recordedError || error ? RED : active ? color : healthy ? GREEN : "var(--color-text-main)",
        }}
      >
        {label}
      </span>
      <span className="block truncate text-[10px] text-text-muted">{history ? "History" : providerId === "combo" ? "Route" : "Provider"} · {observedAt || "Timestamp unknown"}</span>
      </div>

      {(active || error || healthy || last) && (
        <StatusDot color={dotColor} error={error} pulse={active || error} />
      )}
    </div>
  );
}

type RouterNodeData = { activeCount: number };

function RouterNode({ data }: { data: RouterNodeData }) {
  return (
    <div style={{width:180,height:44,boxSizing:"border-box"}} className="flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 border-primary bg-primary/8 shadow-lg min-w-[140px] justify-center">
      <Handle
        type="source"
        position={Position.Top}
        id="top"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      <div className="flex items-center justify-center size-7 rounded-md bg-primary/15 shrink-0">
        <span className="material-symbols-outlined text-primary text-[16px]">route</span>
      </div>
      <span className="text-sm font-bold text-primary">OmniRoute</span>
      {data.activeCount > 0 && (
        <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary text-white text-[10px] font-bold leading-none">
          {data.activeCount}
        </span>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  provider: ProviderNode as any,
  router: RouterNode as any,
};

type ProviderEntry = TopologyEntry;

function buildLayout(
  providers: ProviderEntry[],
  activeSet: Set<string>,
  lastSet: Set<string>,
  errorSet: Set<string>,
  containerWidth: number,
  activeRequestCount: number
): { nodes: Node[]; edges: Edge[]; height: number } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  // Sort: active → error → last-used → healthy(connected) → rest (alpha within groups)
  const sorted = [...providers].sort((a, b) => {
    const rank = (p: ProviderEntry) => {
      // Added route annotations must never displace an existing provider node.
      if (p.kind === "history") return 6;
      if (p.kind === "combo") return 5;
      const id = p.provider.toLowerCase();
      if (activeSet.has(id)) return 0;
      if (errorSet.has(id) || p.status === "error") return 1;
      if (lastSet.has(id)) return 2;
      if (p.status === "active") return 3;
      return 4;
    };
    const d = rank(a) - rank(b);
    return d !== 0
      ? d
      : a.provider.toLowerCase().localeCompare(b.provider.toLowerCase()); // ASCII kasıtlı
  });

  const labels = sorted.map(p => resolveTopologyNodeLabel(p.name, getProviderConfig(p.provider).name, p.provider));
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  const context = canvas?.getContext("2d");
  if (context) context.font = `500 12px ${getComputedStyle(document.body).fontFamily}`;
  const widths = labels.map(label => Math.ceil((context?.measureText(label).width ?? label.length * 7.5) + 78));
  const layout = topologyPositions(widths, containerWidth);
  nodes.push({ id:"router", type:"router", position:layout.router, style:{width:180,height:44}, data:{activeCount:activeRequestCount}, draggable:false });
  sorted.forEach((p,i) => {
    const pid = p.provider.toLowerCase();
    const isProvider = p.kind === "provider";
    const active = isProvider && activeSet.has(pid);
    const trafficError = isProvider && !active && errorSet.has(pid);
    const last = isProvider && !active && !trafficError && lastSet.has(pid);
    const healthError = p.kind !== "history" && !active && !trafficError && p.status === "error";
    const healthy = p.kind !== "history" && !active && !trafficError && !healthError && p.status === "active";
    const error = trafficError || healthError;
    const config = getProviderConfig(isProvider ? p.provider : `${p.kind}:${p.id}`);
    const nodeId = `${p.kind}-${p.id}`;
    const position = layout.nodes[i];
    nodes.push({ id:nodeId, type:"provider", position:{x:position.x,y:position.y}, style:{width:position.width,height:52},
      data:{label:labels[i], color:config.color || "#6b7280", providerId:isProvider ? p.provider : "combo", active,error,healthy,last,
        history:p.kind === "history", recordedError:p.kind === "history" && p.observedStatus != null && (p.observedStatus < 200 || p.observedStatus >= 400),
        width:position.width, observedAt:p.observedAt, detail:p.detail || "Configured provider; reported connection state is not a guarantee of successful inference."} satisfies ProviderNodeData,
      draggable:false });
    const sourceHandle = position.side;
    const targetHandle = sourceHandle === "left" ? "right" : sourceHandle === "right" ? "left" : "top";
    edges.push({id:`e-${nodeId}`,source:"router",sourceHandle,target:nodeId,targetHandle,animated:active,style:edgeStyle(active,last,error,healthy)});
  });

  return { nodes, edges, height:layout.height };
}

type Props = {
  providers?: ProviderEntry[];
  activeRequests?: Array<{ provider?: string; model?: string }>;
  lastProvider?: string;
  errorProviders?: string[];
};

export default function ProviderTopology({
  providers = [],
  activeRequests = [],
  lastProvider = "",
  errorProviders = [],
}: Props) {
  const t = useTranslations("common");
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1000);
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const observe = () => setContainerWidth(Math.max(240,Math.floor(el.getBoundingClientRect().width)));
    observe(); const ro = new ResizeObserver(observe); ro.observe(el); return () => ro.disconnect();
  }, [providers.length === 0]);
  const activeKey = useMemo(
    () =>
      activeRequests
        .map((r) => r.provider?.toLowerCase())
        .filter(Boolean)
        .sort()
        .join(","),
    [activeRequests]
  );
  const lastKey = lastProvider.toLowerCase();
  const errorKey = [...errorProviders].map(p => p.toLowerCase()).sort().join(",");

  const activeSet = useMemo(
    () => new Set<string>(activeKey ? activeKey.split(",") : []),
    [activeKey]
  );
  const lastSet = useMemo(() => new Set<string>(lastKey ? [lastKey] : []), [lastKey]);
  const errorSet = useMemo(() => new Set<string>(errorKey ? errorKey.split(",") : []), [errorKey]);

  const { nodes, edges, height } = useMemo(
    () => buildLayout(providers, activeSet, lastSet, errorSet, containerWidth, activeRequests.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providers, activeSet, lastKey, errorKey, containerWidth, activeRequests.length]
  );

  const providersKey = useMemo(
    () =>
      providers
        .map((p) => p.provider)
        .sort()
        .join(","),
    [providers]
  );

  const containerClass =
    "h-full w-full min-w-0 rounded-xl border border-border bg-bg-subtle/20 overflow-hidden";

  if (providers.length === 0) {
    return (
      <div ref={containerRef} style={{height:300}}
        className={`${containerClass} flex flex-col items-center justify-center gap-2 text-text-muted`}
      >
        <span className="material-symbols-outlined text-[32px]">device_hub</span>
        <p className="text-sm">{t("providerTopologyEmpty")}</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{height}} className="w-full min-w-0">
    <FlowCanvas
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitKey={`${providersKey}:${containerWidth}:${nodes.map(n => n.style?.width).join(",")}`}
      className={containerClass}
    />
    </div>
  );
}
