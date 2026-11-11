"use client";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { Card } from "@/shared/components";
import { useLiveRequests } from "@/hooks/useLiveDashboard";
import { selectTopologyVisibility } from "@/lib/display/topologyVisibility";
import type { TopologyEntry } from "@/lib/display/topologyObservations";
import { selectActiveRequests } from "../home/topologyUtils";
const ProviderTopology = dynamic(() => import("../home/ProviderTopology"), { ssr: false });

export function HomeProviderTopologySection({
  providers,
  lastProvider,
  errorProviders,
  recentRouteErrors,
  historyCount,
  enabled = true,
}: {
  providers: TopologyEntry[];
  lastProvider: string;
  errorProviders: string[];
  recentRouteErrors: number;
  historyCount: number;
  enabled?: boolean;
}) {
  const t = useTranslations("home");
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("settings");
  const tAnalytics = useTranslations("analytics");
  const { activeRequests: liveActiveRequests } = useLiveRequests({ enabled });
  const activeRequests = selectActiveRequests(liveActiveRequests);
  const [showHistory, setShowHistory] = useState(false);
  const graphId = useId();
  const visibleTopology = selectTopologyVisibility(providers, liveActiveRequests, showHistory);
  const connectionIssues = providers.filter(
    (p) => p.kind === "provider" && p.status === "error"
  ).length;
  return (
    <Card>
      <div className="mb-3 space-y-1">
        <h2 className="text-base font-semibold">{t("providerTopology")}</h2>
        <div className="flex flex-wrap gap-3 text-[11px] text-text-muted">
          <span>{tCommon("active")}: reported connection / fresh route outcome</span>
          <span>{tSettings("recent")}: latest provider traffic</span>
          <span>{tAnalytics("modelStatusError")}: reported connection / recent HTTP error</span>
        </div>
        <p className="text-xs text-text-muted" aria-live="polite">
          {activeRequests.length} in-flight requests · {errorProviders.length} recent provider
          outcome errors · {recentRouteErrors} recent route outcome errors
        </p>
        <p className="text-xs text-text-muted">
          Latest-outcome window: 5 minutes (display only). {connectionIssues} reported connection
          issues · {historyCount} historical/unattributed log buckets.
        </p>
        <p className="text-[11px] text-text-muted">
          Provider border = reported connection state or recent HTTP error; route = latest HTTP
          outcome; history is not provider health. Hover or focus a node for its timestamp and
          provenance.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-xs text-text-muted">
            {showHistory
              ? "All recorded topology entries shown."
              : "Current view: configured providers and recent or in-flight routes."}
          </span>
          {(visibleTopology.expandableCount > 0 || showHistory) && (
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs text-text-primary hover:bg-bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
              aria-expanded={showHistory}
              aria-controls={graphId}
              onClick={() => setShowHistory((shown) => !shown)}
            >
              {showHistory
                ? "Hide older routes and history"
                : `Show older routes and history (${visibleTopology.expandableCount})`}
            </button>
          )}
        </div>
        {visibleTopology.hasUnattributedRequest && !showHistory && (
          <p className="text-[11px] text-text-muted">
            Routes remain visible while an in-flight request has no matching route identity.
          </p>
        )}
      </div>
      <div id={graphId}>
        <ProviderTopology
          providers={visibleTopology.entries}
          activeRequests={activeRequests}
          lastProvider={lastProvider}
          errorProviders={errorProviders}
        />
      </div>
    </Card>
  );
}
