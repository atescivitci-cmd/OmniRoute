import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Run complete production functions against in-memory dependencies. Extracting
// declarations avoids importing auth's DB/config/provider initialization graph.
function declarations(relativePath: string, names: string[]): string {
  const url = new URL(relativePath, import.meta.url);
  const source = ts.createSourceFile(
    url.pathname,
    fs.readFileSync(url, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  return names
    .map((name) => {
      const declaration = source.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
      );
      assert.ok(declaration, `production declaration ${name} must exist`);
      return declaration.getText(source).replace(/^export\s+/, "");
    })
    .join("\n");
}

const names = [
  "normalizeStatus",
  "isTerminalConnectionStatus",
  "normalizeExcludedConnectionIds",
  "getConnectionErrorPenalty",
  "getConnectionRecencyPenalty",
  "getP2CConnectionScore",
  "compareP2CConnections",
  "getProviderCredentials",
  "getProviderCredentialsWithQuotaPreflight",
];
const script = ts.transpileModule(
  `${declarations("../../src/sse/services/auth.ts", names)}\n${declarations(
    "../../src/sse/services/sessionAffinityPin.ts",
    ["isConnectionEligibleForAffinityPin", "applySessionAffinityPin", "resolveSessionAffinityTtlMs"]
  )}\nglobalThis.actual = { ${names.join(",")}, applySessionAffinityPin };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;

type Row = Record<string, any> & { id: string };
type FixtureOptions = {
  rows?: Row[];
  exhausted?: string[];
  blocked?: string[];
  headroom?: Record<string, number | null>;
  pinned?: string;
  strategy?: string;
  creditsMode?: string;
  forbidQuotaReads?: boolean;
};
function row(id: string, overrides: Record<string, unknown> = {}): Row {
  return {
    id,
    provider: "fixture",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
    ...overrides,
  };
}
function fixture(options: FixtureOptions = {}) {
  const rows = options.rows ?? [row("account-a")];
  const calls = { quota: [] as string[], live: 0, released: 0, touches: [] as string[] };
  const quotaRead = (kind: string, id: string) => {
    calls.quota.push(`${kind}:${id}`);
    assert.equal(options.forbidQuotaReads, undefined, "bypass must not read included quota");
  };
  const unavailable = (until: unknown) => !!until && Date.parse(String(until)) > Date.now();
  const context: any = {
    Date,
    Map,
    Set,
    Promise,
    randomUUID: () => "00000000-0000-0000-0000-000000000000",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    fetch() {
      throw new Error("fixture_network_forbidden");
    },
    createSelectionLock: () => ({ wait: Promise.resolve(), release: () => calls.released++ }),
    getSelectionMutexKey: () => "fixture-lock",
    resolveProviderId: (provider: string) => provider,
    NOAUTH_PROVIDERS: {},
    WEB_COOKIE_PROVIDERS: {},
    getSettings: async () => ({ fallbackStrategy: options.strategy ?? "fill-first" }),
    getProviderSearchPool: async (provider: string) => [provider],
    getCachedRawProviderConnections: async () => rows.filter((item) => item.isActive),
    getProviderConnections: async () => rows,
    createLazyConnectionView: (item: Row) => ({ ...item }),
    toProviderConnection: (item: Row) => ({ ...item }),
    getSessionAccountAffinity: () => (options.pinned ? { connectionId: options.pinned } : null),
    selectSessionAffinityConnection: async () => null,
    isModelExcludedByConnection: (_model: string, data: any) => data?.excluded === true,
    isAccountUnavailable: unavailable,
    isCodexScopeUnavailable: (item: Row) => item.providerSpecificData?.scopeLimited === true,
    isModelLocked: (_provider: string, id: string) =>
      rows.some((item) => item.id === id && item.modelLocked),
    evaluateQuotaLimitPolicy: (_provider: string, item: Row) => {
      quotaRead("policy", item.id);
      return { blocked: options.blocked?.includes(item.id) ?? false, reasons: [], resetAt: null };
    },
    isQuotaExhaustedForRequest: (id: string) => {
      quotaRead("exhausted", id);
      return options.exhausted?.includes(id) ?? false;
    },
    isAccountQuotaExhausted: (id: string) => {
      quotaRead("aggregate", id);
      return options.exhausted?.includes(id) ?? false;
    },
    getConnectionQuotaHeadroomPercent: (_provider: string, item: Row) => {
      quotaRead("headroom", item.id);
      return options.headroom?.[item.id] ?? null;
    },
    getQuotaCache: () => null,
    getEarliestFutureDate: () => null,
    parseFutureDateMs: (value: unknown) => (unavailable(value) ? Date.parse(String(value)) : null),
    getEarliestRateLimitedUntil: () => null,
    maybeSyntheticNoAuthFallback: async () => null,
    formatRetryAfter: () => "fixture-retry",
    formatConnectionPrefixesForLog: () => "fixture-connections",
    formatSessionKeyForLog: () => "fixture-session",
    getModelLockoutInfo: () => null,
    getCodexScopeRateLimitedUntil: () => null,
    getQuotaScopeLabelForProvider: () => "model",
    resetConnectionBackoff: async () => {},
    touchConnectionLastUsed: async (id: string) => {
      calls.touches.push(id);
      return null;
    },
    captureNvidiaSelectionProof: () => null,
    captureAccountModelProof: () => null,
    toNumber: (value: unknown, fallback = 0) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback,
    getCreditsMode: () => options.creditsMode ?? "never",
    getCachedSettings: async () => ({ fixture: true }),
    resolveResilienceSettings: () => ({
      quotaPreflight: {
        defaultThresholdPercent: 2,
        warnThresholdPercent: 10,
        providerWindowDefaults: {},
      },
    }),
    isQuotaPreflightEnabled: () => true,
    preflightQuota: async () => {
      calls.live++;
      return { proceed: true };
    },
  };
  vm.runInNewContext(script, context, { timeout: 1000 });
  return { actual: context.actual, calls, rows };
}

test("actual credential admission bypasses included exhaustion and configured quota only when trusted", async () => {
  for (const provider of ["fixture", "claude", "codex", "github", "nvidia", "ollama-local"]) {
    const managed = fixture({
      exhausted: ["account-a"],
      blocked: ["account-a"],
      forbidQuotaReads: true,
    });
    const selected = await managed.actual.getProviderCredentials(
      provider,
      null,
      ["account-a"],
      "model",
      { bypassQuotaPolicy: true }
    );
    assert.equal(selected.connectionId, "account-a", provider);
    assert.equal(managed.calls.quota.length, 0);
    assert.equal(managed.calls.released, 1);
  }
  for (const options of [{ exhausted: ["account-a"] }, { blocked: ["account-a"] }]) {
    const strict = fixture(options);
    const selected = await strict.actual.getProviderCredentials(
      "fixture",
      null,
      ["account-a"],
      "model"
    );
    assert.equal(selected.allRateLimited, true);
    assert.equal(strict.calls.released, 1);
  }
});

test("actual preflight wrapper performs no extra quota probe for explicit bypass or existing credits-first mode", async () => {
  for (const mode of ["explicit", "credits-first"]) {
    const f = fixture({
      exhausted: ["account-a"],
      blocked: ["account-a"],
      creditsMode: mode === "credits-first" ? "always" : "never",
      forbidQuotaReads: true,
    });
    const selected = await f.actual.getProviderCredentialsWithQuotaPreflight(
      mode === "credits-first" ? "antigravity" : "fixture",
      null,
      ["account-a"],
      "model",
      mode === "explicit" ? { bypassQuotaPolicy: true } : {}
    );
    assert.equal(selected.connectionId, "account-a");
    assert.equal(f.calls.live, 0);
    assert.equal(f.calls.quota.length, 0);
  }
  const strict = fixture();
  assert.equal(
    (
      await strict.actual.getProviderCredentialsWithQuotaPreflight(
        "fixture",
        null,
        ["account-a"],
        "model"
      )
    ).connectionId,
    "account-a"
  );
  assert.equal(strict.calls.live, 1);
});

test("actual auth P2C path ignores included quota on bypass and preserves strict quota preference", async () => {
  for (const count of [2, 3]) {
    const rows = [row("account-a"), row("account-b"), row("account-c")].slice(0, count);
    const managed = fixture({
      rows,
      strategy: "p2c",
      headroom: { "account-a": 1, "account-b": 100 },
      forbidQuotaReads: true,
    });
    assert.equal(
      (
        await managed.actual.getProviderCredentials("fixture", null, null, "model", {
          bypassQuotaPolicy: true,
        })
      ).connectionId,
      "account-a"
    );
    assert.equal(managed.calls.quota.length, 0);
    const strict = fixture({
      rows,
      strategy: "p2c",
      headroom: { "account-a": 1, "account-b": 100 },
    });
    assert.equal(
      (await strict.actual.getProviderCredentials("fixture", null, null, "model")).connectionId,
      "account-b"
    );
  }
});

test("actual P2C tie-break is quota neutral under bypass; recorded upstream errors still matter", () => {
  const f = fixture({ headroom: { "account-a": 50, "account-b": 51 } });
  // Adjacent values carry the same rounded quota penalty, exercising the tie-break.
  assert.equal(
    Math.sign(
      f.actual.compareP2CConnections("fixture", row("account-a"), row("account-b"), "model")
    ),
    1
  );
  assert.equal(
    Math.sign(
      f.actual.compareP2CConnections(
        "fixture",
        row("account-a"),
        row("account-b"),
        "model",
        undefined,
        true
      )
    ),
    -1
  );
  const recordedError = row("account-a", {
    lastError: "fixture upstream error",
    lastErrorType: "rate_limited",
    errorCode: 429,
  });
  assert.equal(
    Math.sign(
      f.actual.compareP2CConnections(
        "fixture",
        recordedError,
        row("account-b"),
        "model",
        undefined,
        true
      )
    ),
    1
  );
});

test("actual bypass admission retains account, inactive, terminal, real rate-limit and model gates", async () => {
  const badRows = [
    row("account-a", { isActive: false }),
    ...["credits_exhausted", "banned", "expired"].map((testStatus) =>
      row("account-a", { testStatus })
    ),
    row("account-a", { rateLimitedUntil: new Date(Date.now() + 60_000).toISOString() }),
    row("account-a", { modelLocked: true }),
    row("account-a", { providerSpecificData: { excluded: true } }),
    row("account-a", { providerSpecificData: { scopeLimited: true } }),
  ];
  for (const bad of badRows) {
    const f = fixture({ rows: [bad, row("account-b")], forbidQuotaReads: true });
    const selected = await f.actual.getProviderCredentials("codex", null, null, "model", {
      bypassQuotaPolicy: true,
    });
    assert.equal(selected.connectionId, "account-b", JSON.stringify(bad));
  }
  for (const [excluded, allowed, options] of [
    [null, ["account-b"], {}],
    ["account-a", null, {}],
    [null, null, { forcedConnectionId: "account-b" }],
  ] as const) {
    const f = fixture({ rows: [row("account-a"), row("account-b")], forbidQuotaReads: true });
    assert.equal(
      (
        await f.actual.getProviderCredentials("fixture", excluded, allowed, "model", {
          ...options,
          bypassQuotaPolicy: true,
        })
      ).connectionId,
      "account-b"
    );
  }
});

function pinParams(f: ReturnType<typeof fixture>, bypassQuotaPolicy: boolean) {
  return {
    forcedConnectionId: "account-b",
    options: { bypassQuotaPolicy, sessionKey: "fixture-session" },
    sessionAffinityTtlMs: 60_000,
    connections: f.rows,
    provider: "codex",
    requestedModel: "model",
    excludedConnectionIds: new Set<string>(),
    isTerminalConnectionStatus: f.actual.isTerminalConnectionStatus,
    isCodexScopeUnavailable: (item: Row) => item.providerSpecificData?.scopeLimited === true,
    isQuotaPolicyBlocked: () => true,
  };
}

test("actual affinity pin follows the same trusted included-quota bypass", () => {
  const managed = fixture({
    pinned: "account-a",
    exhausted: ["account-a"],
    forbidQuotaReads: true,
  });
  assert.equal(managed.actual.applySessionAffinityPin(pinParams(managed, true)), "account-a");
  assert.equal(managed.calls.quota.length, 0);
  const strict = fixture({ pinned: "account-a", exhausted: ["account-a"] });
  assert.equal(strict.actual.applySessionAffinityPin(pinParams(strict, false)), null);
});

test("actual affinity bypass retains exclusions, missing account, terminal, rate-limit and model gates", () => {
  for (const bad of [
    row("account-a", { testStatus: "credits_exhausted" }),
    row("account-a", { rateLimitedUntil: new Date(Date.now() + 60_000).toISOString() }),
    row("account-a", { modelLocked: true }),
    row("account-a", { providerSpecificData: { excluded: true } }),
    row("account-a", { providerSpecificData: { scopeLimited: true } }),
  ]) {
    const f = fixture({ pinned: "account-a", rows: [bad], forbidQuotaReads: true });
    assert.equal(f.actual.applySessionAffinityPin(pinParams(f, true)), null);
  }
  const absent = fixture({ pinned: "not-authorized", forbidQuotaReads: true });
  assert.equal(absent.actual.applySessionAffinityPin(pinParams(absent, true)), null);
  const excluded = fixture({ pinned: "account-a", forbidQuotaReads: true });
  const params = pinParams(excluded, true);
  params.excludedConnectionIds.add("account-a");
  assert.equal(excluded.actual.applySessionAffinityPin(params), null);
});
