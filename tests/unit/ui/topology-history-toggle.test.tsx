// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { TopologyEntry } from "../../../src/lib/display/topologyObservations";
import type { TopologyLiveRequest } from "../../../src/lib/display/topologyVisibility";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/dynamic", () => ({
  default: () => (props: { providers: TopologyEntry[]; activeRequests: unknown[] }) => (
    <div
      data-testid="topology"
      data-entries={props.providers.map((p) => p.id).join(",")}
      data-active={props.activeRequests.length}
    />
  ),
}));
vi.mock("@/shared/components", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const state = vi.hoisted(() => ({ requests: [] as TopologyLiveRequest[] }));
vi.mock("@/hooks/useLiveDashboard", () => ({
  useLiveRequests: () => ({ activeRequests: state.requests }),
}));
const { HomeProviderTopologySection } =
  await import("../../../src/app/(dashboard)/dashboard/HomeProviderTopologySection");
const entries: TopologyEntry[] = [
  { kind: "provider", id: "provider", provider: "vendor", status: "error" },
  { kind: "combo", id: "old", provider: "combo:old", comboName: "Old", status: "idle" },
  { kind: "combo", id: "recent", provider: "combo:recent", comboName: "Recent", status: "error" },
  { kind: "history", id: "history", provider: "history:old", status: "idle" },
];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = (providers = entries) =>
  act(() =>
    root.render(
      <HomeProviderTopologySection
        providers={providers}
        lastProvider="vendor"
        errorProviders={["vendor"]}
        recentRouteErrors={1}
        historyCount={1}
      />
    )
  );
const shown = () => container.querySelector("[data-testid=topology]")?.getAttribute("data-entries");
const toggle = () => act(() => container.querySelector("button")!.click());
beforeEach(() => {
  state.requests = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("starts compact and repeatedly expands/collapses without deleting input data", () => {
  render();
  expect(shown()).toBe("provider,recent");
  expect(container.textContent).toContain("Show older routes and history (2)");
  for (let i = 0; i < 3; i++) {
    toggle();
    expect(shown()).toBe("provider,old,recent,history");
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    toggle();
    expect(shown()).toBe("provider,recent");
  }
  expect(entries).toHaveLength(4);
  expect(container.textContent).toContain("1 recent route outcome errors");
});
it("keeps live stale route and collapses it after completion", () => {
  state.requests = [{ provider: "vendor", model: "model", comboName: "Old" }];
  render();
  expect(shown()).toBe("provider,old,recent");
  expect(container.querySelector("[data-testid=topology]")?.getAttribute("data-active")).toBe("1");
  state.requests = [];
  render();
  expect(shown()).toBe("provider,recent");
});
it("preserves ambiguous in-flight routes and explains why", () => {
  state.requests = [{ provider: "vendor", model: "unattributed" }];
  render();
  expect(shown()).toBe("provider,old,recent");
  expect(container.textContent).toContain("no matching route identity");
});
it("keeps expanded mode across refreshed data and allows returning to compact", () => {
  render();
  toggle();
  render([...entries, { kind: "history", id: "new-history", provider: "history:new" }]);
  expect(shown()).toBe("provider,old,recent,history,new-history");
  toggle();
  expect(shown()).toBe("provider,recent");
});
it("does not show a pointless toggle for provider-only or empty data", () => {
  render([entries[0]]);
  expect(container.querySelector("button")).toBeNull();
  render([]);
  expect(shown()).toBe("");
  expect(container.querySelector("button")).toBeNull();
});
it("links the disclosure to the graph and resets safely after remount", () => {
  render();
  const id = container.querySelector("button")?.getAttribute("aria-controls");
  expect(id).toBeTruthy();
  expect(document.getElementById(id!)).not.toBeNull();
  toggle();
  act(() => root.unmount());
  root = createRoot(container);
  render();
  expect(shown()).toBe("provider,recent");
  expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
});
