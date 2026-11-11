import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveTopologyObservations,
  type TopologyEntry,
} from "../../src/lib/display/topologyObservations";
import { selectTopologyVisibility } from "../../src/lib/display/topologyVisibility";

const provider: TopologyEntry = { kind: "provider", id: "p", provider: "vendor", status: "error" };
const old: TopologyEntry = {
  kind: "combo",
  id: "old",
  provider: "combo:old",
  comboName: "Old route",
  status: "idle",
};
const recent: TopologyEntry = {
  kind: "combo",
  id: "recent",
  provider: "combo:recent",
  comboName: "Recent route",
  status: "error",
};
const history: TopologyEntry = {
  kind: "history",
  id: "history",
  provider: "history:old",
  status: "idle",
};
const entries = [provider, old, recent, history];
const ids = (values: TopologyEntry[]) => values.map((entry) => entry.id);

test("default view preserves providers and recent errors but collapses old routes and history", () => {
  const result = selectTopologyVisibility(entries, []);
  assert.deepEqual(ids(result.entries), ["p", "recent"]);
  assert.equal(result.expandableCount, 2);
});
test("recent successful routes also remain visible", () => {
  assert.deepEqual(ids(selectTopologyVisibility([{ ...recent, status: "active" }], []).entries), [
    "recent",
  ]);
});
test("explicit in-flight combo name keeps stale route visible", () => {
  const result = selectTopologyVisibility(entries, [
    { provider: "vendor", model: "model", comboName: "Old route" },
  ]);
  assert.deepEqual(ids(result.entries), ["p", "old", "recent"]);
  assert.equal(result.hasUnattributedRequest, false);
});
test("older snapshots can identify a live route through model alias or combo id", () => {
  for (const request of [
    { provider: "vendor", model: "Old route" },
    { provider: "combo:old", model: "model" },
    { provider: "vendor", model: "old" },
  ]) {
    assert.deepEqual(ids(selectTopologyVisibility(entries, [request]).entries), [
      "p",
      "old",
      "recent",
    ]);
  }
});
test("unattributed live request conservatively preserves all routes, never history", () => {
  const result = selectTopologyVisibility(entries, [{ provider: "vendor", model: "unknown" }]);
  assert.deepEqual(ids(result.entries), ["p", "old", "recent"]);
  assert.equal(result.hasUnattributedRequest, true);
});
test("unknown explicit route identity is conservative too", () => {
  assert.equal(
    selectTopologyVisibility(entries, [
      { provider: "vendor", model: "model", comboName: "New route" },
    ]).hasUnattributedRequest,
    true
  );
});
test("one unattributed request among known requests keeps all routes", () => {
  const result = selectTopologyVisibility(entries, [
    { provider: "vendor", model: "Recent route" },
    { provider: "vendor", model: "unknown" },
  ]);
  assert.deepEqual(ids(result.entries), ["p", "old", "recent"]);
});
test("expansion restores exact original entries and ordering without mutations", () => {
  for (const entry of entries) Object.freeze(entry);
  Object.freeze(entries);
  const result = selectTopologyVisibility(entries, [], true);
  assert.equal(result.entries, entries);
  assert.equal(result.expandableCount, 2);
  assert.deepEqual(ids(selectTopologyVisibility(entries, [], false).entries), ["p", "recent"]);
});
test("empty data and provider-only data are safe", () => {
  assert.deepEqual(selectTopologyVisibility([], []).entries, []);
  assert.deepEqual(selectTopologyVisibility([provider], []).entries, [provider]);
  assert.equal(selectTopologyVisibility([provider], []).expandableCount, 0);
});
test("missing/unknown route status is collapsed unless live", () => {
  assert.deepEqual(selectTopologyVisibility([{ ...old, status: undefined }], []).entries, []);
});
test("display derivation carries exact combo identity, independent of formatted labels", () => {
  const now = Date.parse("2026-11-06T20:00:00Z");
  const result = deriveTopologyObservations(
    [provider],
    {},
    [
      {
        kind: "combo",
        comboId: "old",
        comboName: "A (combo route · name)",
        lastStatus: 200,
        lastRequestAt: "2026-11-06T19:00:00Z",
        lastRequestAtMs: now - 3600000,
      },
    ],
    now
  );
  const route = result.entries.find((entry) => entry.kind === "combo")!;
  assert.equal(route.comboName, "A (combo route · name)");
  assert.deepEqual(
    ids(
      selectTopologyVisibility(result.entries, [
        { provider: "vendor", model: "model", comboName: route.comboName },
      ]).entries
    ),
    ["p", "old"]
  );
});
test("freshness boundary retains recent errors and hides expired outcomes without touching records", () => {
  const now = Date.parse("2026-11-06T20:00:00Z");
  for (const [age, expected] of [
    [300000, true],
    [300001, false],
    [-1, false],
  ] as const) {
    const route = {
      kind: "combo" as const,
      comboId: "r",
      comboName: "Route",
      lastStatus: 503,
      lastRequestAt: new Date(now - age).toISOString(),
      lastRequestAtMs: now - age,
    };
    const result = deriveTopologyObservations([], {}, [route], now);
    assert.equal(selectTopologyVisibility(result.entries, []).entries.length > 0, expected);
    assert.equal(result.entries.length, 1);
  }
});
