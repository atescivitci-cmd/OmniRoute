/**
 * routingEvidenceCanary.ts — opt-in, neutral routing evidence canary (P1).
 *
 * Why: the selector ranks candidates on measured latency and reliability, but only trusts a
 * candidate's latency once it has enough fresh successful samples. Candidates that real
 * traffic rarely reaches never gather those samples, so they cannot win on speed and the
 * ranking keeps choosing whatever was measured first.
 *
 * What: on a slow tick this scheduler sends one identical, synthetic, content-free probe to
 * each eligible candidate that still lacks fresh evidence. The probe runs through the real
 * request pipeline (real credentials, translation, cooldown and lockout handling), so the
 * normal usage recording produces the samples the selector already reads. Nothing in the
 * ranking changes.
 *
 * Neutrality: candidates are chosen from the combo pools and connection state only. There is
 * no provider, model or combo name anywhere in this file, ordering among equals is random,
 * and every candidate in a cycle receives byte-identical probe content. A test scans this
 * file for names.
 *
 * Safety: strictly opt-in (settings flag plus a per-connection opt-in), environment kill
 * switch, subscription-style connections and local providers excluded by default, a daily
 * spend budget for metered or unknown-price candidates, concurrency 1, one probe per
 * provider per tick, and a pause once a candidate has enough fresh samples.
 *
 * All effects sit behind an injectable `deps` object, time behind `now()` and randomness
 * behind `rng()`, so tests need no DB, network or timers.
 */

import { logger } from "@omniroute/open-sse/utils/logger.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { parseModel } from "@omniroute/open-sse/services/model.ts";
import { isModelLocked } from "@omniroute/open-sse/services/accountFallback.ts";
import {
  expandProviderWildcardsInCollection,
  expandProviderWildcardsInCombo,
} from "@omniroute/open-sse/services/combo/providerWildcard.ts";
import { getCircuitBreaker } from "@/shared/utils/circuitBreaker";
import { isLocalProvider } from "@/shared/constants/providers";
import { toNumberOrNull } from "@/shared/utils/numeric";
import { USAGE_SOURCE_ROUTING_CANARY } from "@/shared/constants/usageSource";
import { runWithUsageSource } from "@/lib/usage/usageSourceContext";
import {
  ROUTING_CANARY_BUCKET_TOKENS,
  ROUTING_CANARY_CHARS_PER_TOKEN,
  ROUTING_CANARY_DEFAULTS,
  ROUTING_CANARY_BACKOFF_CAP_MS,
  ROUTING_CANARY_KILL_VALUES,
  ROUTING_CANARY_OUTPUT_TOKENS,
  ROUTING_CANARY_PROBE_TIMEOUT_MS,
  ROUTING_CANARY_TERMINAL_STATUSES,
  ROUTING_CANARY_TICK_INTERVAL_MS,
  ROUTING_CANARY_UNKNOWN_PRICE_PER_M,
  type RoutingCanaryBucket,
  type RoutingCanaryConfig,
} from "@/shared/constants/routingEvidenceCanary";

const log = logger("RoutingEvidenceCanary");

type JsonRecord = Record<string, unknown>;

export interface CanaryConnection {
  id: string;
  provider: string;
  authType?: string | null;
  isActive?: boolean;
  rateLimitedUntil?: string | null;
  testStatus?: string | null;
  /** Custom endpoint, when the connection targets one. Used only to detect local/private hosts. */
  baseUrl?: string | null;
}

export interface CanaryPoolTarget {
  provider?: string | null;
  modelStr: string;
  connectionId?: string | null;
}

export interface CanaryPricing {
  input?: unknown;
  output?: unknown;
}

export interface CanaryProbeArgs {
  provider: string;
  model: string;
  modelStr: string;
  connectionId: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface CanaryProbeResult {
  ok: boolean;
  latencyMs: number;
  statusCode?: number;
}

export interface RoutingEvidenceCanaryDeps {
  getSettings: () => Promise<JsonRecord>;
  getConnections: () => Promise<CanaryConnection[]>;
  listPoolTargets: (comboScope: string[]) => Promise<CanaryPoolTarget[]>;
  getEvidenceCounts: () => Promise<Record<string, { totalRequests?: number }>>;
  getPricing: (provider: string, model: string) => Promise<CanaryPricing | null | undefined>;
  canExecuteProvider: (provider: string) => boolean;
  isModelLocked: (provider: string, connectionId: string, model: string) => boolean;
  isLocalProvider: (provider: string) => boolean;
  /** True only when declared metadata says the model serves chat requests. Unknown is false. */
  isChatCapable: (provider: string, model: string) => Promise<boolean>;
  runProbe: (args: CanaryProbeArgs) => Promise<CanaryProbeResult>;
}

export interface RoutingEvidenceCanaryState {
  running: boolean;
  cycle: number;
  lastProbeAt: Record<string, number>;
  failedAt: Record<string, number>;
  /** Consecutive failed or evidence-less probes per candidate; drives exponential backoff. */
  failCount: Record<string, number>;
  /** Evidence count seen when the candidate was last probed, to spot probes that leave no sample. */
  evidenceAtProbe: Record<string, number>;
  spend: { day: string; usd: number };
}

export interface RoutingEvidenceCanaryTickResult {
  skippedAll?: "already_running" | "kill_switch" | "disabled";
  error?: "pool_unavailable" | "evidence_unavailable" | "settings_unavailable";
  probed: number;
  failed: number;
  skipped: Record<string, number>;
}

export function createRoutingEvidenceCanaryState(): RoutingEvidenceCanaryState {
  return {
    running: false,
    cycle: 0,
    lastProbeAt: {},
    failedAt: {},
    failCount: {},
    evidenceAtProbe: {},
    spend: { day: "", usd: 0 },
  };
}

const FILLER_LINE =
  "Reference note {n}: the archive keeps a ledger of routine measurements taken at regular intervals and filed by date.";

/**
 * Deterministic synthetic prompt. Identical for every candidate within a cycle; the cycle
 * nonce at the end is the only thing that changes between cycles, which keeps upstream prefix
 * caches from making later probes look faster than real traffic.
 */
export function buildCanaryProbePrompt(bucket: RoutingCanaryBucket, cycleNonce: string): string {
  const targetChars = ROUTING_CANARY_BUCKET_TOKENS[bucket] * ROUTING_CANARY_CHARS_PER_TOKEN;
  const lines: string[] = ["Routing probe. Read the notes below, then follow the final line."];
  let size = lines[0].length;
  for (let n = 1; size < targetChars; n++) {
    const line = FILLER_LINE.replace("{n}", String(n));
    lines.push(line);
    size += line.length + 1;
  }
  lines.push(`Cycle: ${cycleNonce}`);
  lines.push(
    "Write the whole numbers from 1 to 60 in order, separated by single spaces, and nothing else."
  );
  return lines.join("\n");
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = toNumberOrNull(value);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function resolveRoutingCanaryConfig(settings: JsonRecord): RoutingCanaryConfig {
  const raw = (settings?.routingCanary ?? {}) as JsonRecord;
  const d = ROUTING_CANARY_DEFAULTS;
  const budget = toNumberOrNull(raw.dailyBudgetUsd);
  const connections: Record<string, boolean> = {};
  if (raw.connections && typeof raw.connections === "object") {
    for (const [id, on] of Object.entries(raw.connections as JsonRecord)) {
      if (on === true) connections[id] = true;
    }
  }
  return {
    enabled: raw.enabled === true,
    connections,
    combos: Array.isArray(raw.combos)
      ? raw.combos.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      : [],
    includeLocal: raw.includeLocal === true,
    dailyBudgetUsd: budget === null ? d.dailyBudgetUsd : Math.min(50, Math.max(0, budget)),
    targetSamples: clampInt(raw.targetSamples, 10, 50, d.targetSamples),
    minSpacingMinutes: clampInt(raw.minSpacingMinutes, 5, 1440, d.minSpacingMinutes),
    maxProbesPerTick: clampInt(raw.maxProbesPerTick, 1, 20, d.maxProbesPerTick),
    bucket: raw.bucket === "medium" ? "medium" : "small",
  };
}

function isKilled(env: Record<string, string | undefined>): boolean {
  const value = String(env.ROUTING_EVIDENCE_CANARY ?? "")
    .trim()
    .toLowerCase();
  return ROUTING_CANARY_KILL_VALUES.includes(value);
}

/** Estimated probe cost. Free only when the price record says exactly zero both ways. */
export function estimateProbeCost(
  pricing: CanaryPricing | null | undefined,
  bucket: RoutingCanaryBucket
): { usd: number; free: boolean } {
  const input = toNumberOrNull(pricing?.input);
  const output = toNumberOrNull(pricing?.output);
  if (input !== null && output !== null && input === 0 && output === 0) {
    return { usd: 0, free: true };
  }
  const inPrice = input !== null && input >= 0 ? input : ROUTING_CANARY_UNKNOWN_PRICE_PER_M.input;
  const outPrice =
    output !== null && output >= 0 ? output : ROUTING_CANARY_UNKNOWN_PRICE_PER_M.output;
  const usd =
    (ROUTING_CANARY_BUCKET_TOKENS[bucket] * inPrice + ROUTING_CANARY_OUTPUT_TOKENS * outPrice) /
    1_000_000;
  return { usd, free: false };
}

/** Loopback, link-local and private-range hosts: a probe there may load a model into RAM. */
export function isPrivateEndpoint(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".ts.net")
    ) {
      return true;
    }
    if (host.includes(":")) {
      return (
        host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")
      );
    }
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (!m) return !host.includes(".");
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  } catch {
    return false;
  }
}

function connectionBlockReason(
  connection: CanaryConnection,
  cfg: RoutingCanaryConfig,
  deps: RoutingEvidenceCanaryDeps,
  nowMs: number
): string | null {
  if (connection.isActive === false) return "inactive";
  if (connection.authType !== "apikey") return "subscription_connection";
  if (
    !cfg.includeLocal &&
    (deps.isLocalProvider(connection.provider) || isPrivateEndpoint(connection.baseUrl))
  ) {
    return "local_provider";
  }
  if (connection.rateLimitedUntil) {
    const until = new Date(connection.rateLimitedUntil).getTime();
    if (Number.isFinite(until) && until > nowMs) return "cooldown";
  }
  if (connection.testStatus && ROUTING_CANARY_TERMINAL_STATUSES.includes(connection.testStatus)) {
    return "terminal_status";
  }
  if (!deps.canExecuteProvider(connection.provider)) return "breaker_open";
  return null;
}

interface Candidate {
  key: string;
  provider: string;
  model: string;
  modelStr: string;
  connectionId: string;
  evidenceCount?: number;
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function runRoutingEvidenceCanaryTick(
  deps: RoutingEvidenceCanaryDeps,
  state: RoutingEvidenceCanaryState = createRoutingEvidenceCanaryState(),
  now: () => number = Date.now,
  opts: { rng?: () => number; env?: Record<string, string | undefined> } = {}
): Promise<RoutingEvidenceCanaryTickResult> {
  const result: RoutingEvidenceCanaryTickResult = { probed: 0, failed: 0, skipped: {} };
  const bump = (reason: string) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
  };
  if (state.running) return { ...result, skippedAll: "already_running" };
  state.running = true;
  try {
    const env = opts.env ?? (process.env as Record<string, string | undefined>);
    if (isKilled(env)) return { ...result, skippedAll: "kill_switch" };

    let settings: JsonRecord;
    try {
      settings = await deps.getSettings();
    } catch (err) {
      log.warn("settings unavailable", { error: sanitizeErrorMessage(err) });
      return { ...result, error: "settings_unavailable" };
    }
    const cfg = resolveRoutingCanaryConfig(settings);
    if (!cfg.enabled) return { ...result, skippedAll: "disabled" };

    const nowMs = now();
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (state.spend.day !== day) state.spend = { day, usd: 0 };

    const allConnections = await deps.getConnections();
    const optedIn = allConnections.filter((c) => cfg.connections[c.id] === true);
    const usable = new Map<string, CanaryConnection>();
    for (const connection of optedIn) {
      const reason = connectionBlockReason(connection, cfg, deps, nowMs);
      if (reason) bump(reason);
      else usable.set(connection.id, connection);
    }
    if (usable.size === 0) return result;

    let targets: CanaryPoolTarget[];
    let evidence: Record<string, { totalRequests?: number }>;
    try {
      targets = await deps.listPoolTargets(cfg.combos);
    } catch (err) {
      log.warn("pool unavailable", { error: sanitizeErrorMessage(err) });
      return { ...result, error: "pool_unavailable" };
    }
    try {
      evidence = await deps.getEvidenceCounts();
    } catch (err) {
      log.warn("evidence counts unavailable", { error: sanitizeErrorMessage(err) });
      return { ...result, error: "evidence_unavailable" };
    }

    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const target of targets) {
      const parsed = parseModel(target.modelStr);
      const provider = target.provider || parsed.provider || parsed.providerAlias || "unknown";
      const model = parsed.model || target.modelStr;
      const connectionIds = target.connectionId
        ? [target.connectionId]
        : [...usable.values()].filter((c) => c.provider === provider).map((c) => c.id);
      for (const connectionId of connectionIds) {
        const connection = usable.get(connectionId);
        if (!connection || connection.provider !== provider) continue;
        const key = `${provider}/${model}@${connectionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ key, provider, model, modelStr: target.modelStr, connectionId });
      }
    }

    // Forget bookkeeping for candidates that left the pool a week ago, so state stays bounded.
    const staleBefore = nowMs - 7 * 24 * 60 * 60 * 1000;
    for (const key of Object.keys(state.lastProbeAt)) {
      if (!seen.has(key) && state.lastProbeAt[key] < staleBefore) {
        delete state.lastProbeAt[key];
        delete state.failedAt[key];
        delete state.failCount[key];
        delete state.evidenceAtProbe[key];
      }
    }

    const spacingMs = cfg.minSpacingMinutes * 60_000;
    const due: Candidate[] = [];
    for (const candidate of candidates) {
      let chatCapable = false;
      try {
        chatCapable = await deps.isChatCapable(candidate.provider, candidate.model);
      } catch {
        chatCapable = false;
      }
      if (!chatCapable) {
        bump("not_chat_capable");
        continue;
      }
      if (deps.isModelLocked(candidate.provider, candidate.connectionId, candidate.model)) {
        bump("model_locked");
        continue;
      }
      const have = evidence[`${candidate.provider}/${candidate.model}`]?.totalRequests ?? 0;
      // A probe that returned but left no new sample (timeout, alias rewrite, recording gap)
      // counts as a failure, so such a candidate backs off instead of being re-probed forever.
      const before = state.evidenceAtProbe[candidate.key];
      if (before !== undefined) {
        delete state.evidenceAtProbe[candidate.key];
        const explicitFailure = state.failedAt[candidate.key] === state.lastProbeAt[candidate.key];
        if (have <= before && !explicitFailure) {
          state.failCount[candidate.key] = (state.failCount[candidate.key] ?? 0) + 1;
        } else if (have > before && !explicitFailure) {
          delete state.failCount[candidate.key];
        }
      }
      if (have >= cfg.targetSamples) {
        bump("evidence_sufficient");
        continue;
      }
      const last = state.lastProbeAt[candidate.key];
      if (last !== undefined) {
        const wait = Math.min(
          ROUTING_CANARY_BACKOFF_CAP_MS,
          spacingMs * 2 ** (state.failCount[candidate.key] ?? 0)
        );
        if (nowMs - last < wait) {
          bump("spacing");
          continue;
        }
      }
      due.push({ ...candidate, evidenceCount: have } as Candidate);
    }

    const ordered = shuffle(due, opts.rng ?? Math.random).sort(
      (a, b) => (state.lastProbeAt[a.key] ?? 0) - (state.lastProbeAt[b.key] ?? 0)
    );

    state.cycle += 1;
    const prompt = buildCanaryProbePrompt(cfg.bucket, `${day}#${state.cycle}`);
    const probedProviders = new Set<string>();
    for (const candidate of ordered) {
      if (result.probed >= cfg.maxProbesPerTick) break;
      if (probedProviders.has(candidate.provider)) {
        bump("provider_spacing");
        continue;
      }
      let cost = { usd: 0, free: true };
      try {
        cost = estimateProbeCost(
          await deps.getPricing(candidate.provider, candidate.model),
          cfg.bucket
        );
      } catch {
        cost = estimateProbeCost(null, cfg.bucket);
      }
      if (!cost.free && state.spend.usd + cost.usd > cfg.dailyBudgetUsd) {
        bump("budget_exhausted");
        continue;
      }

      probedProviders.add(candidate.provider);
      state.lastProbeAt[candidate.key] = nowMs;
      state.evidenceAtProbe[candidate.key] = candidate.evidenceCount ?? 0;
      delete state.failedAt[candidate.key];
      if (!cost.free) state.spend.usd += cost.usd;
      result.probed += 1;
      try {
        const outcome = await deps.runProbe({
          provider: candidate.provider,
          model: candidate.model,
          modelStr: candidate.modelStr,
          connectionId: candidate.connectionId,
          prompt,
          maxTokens: ROUTING_CANARY_OUTPUT_TOKENS,
          timeoutMs: ROUTING_CANARY_PROBE_TIMEOUT_MS,
        });
        if (!outcome.ok) {
          state.failedAt[candidate.key] = nowMs;
          state.failCount[candidate.key] = (state.failCount[candidate.key] ?? 0) + 1;
          result.failed += 1;
        }
      } catch (err) {
        state.failedAt[candidate.key] = nowMs;
        state.failCount[candidate.key] = (state.failCount[candidate.key] ?? 0) + 1;
        result.failed += 1;
        log.warn(`${candidate.key}: probe error`, { error: sanitizeErrorMessage(err) });
      }
    }
    return result;
  } catch (err) {
    log.warn("tick error", { error: sanitizeErrorMessage(err) });
    return result;
  } finally {
    state.running = false;
  }
}

export function createDefaultRoutingEvidenceCanaryDeps(): RoutingEvidenceCanaryDeps {
  return {
    getSettings: async () => {
      const { getSettings } = await import("@/lib/db/settings");
      return (await getSettings()) as JsonRecord;
    },
    getConnections: async () => {
      const { getProviderConnections } = await import("@/lib/db/providers");
      const rows = (await getProviderConnections({ isActive: true })) as JsonRecord[];
      // Keep only routing-relevant fields so no credential outlives this call.
      return rows.map((row) => ({
        id: String(row.id),
        provider: String(row.provider),
        authType: (row.authType as string | undefined) ?? null,
        isActive: row.isActive !== false,
        rateLimitedUntil: (row.rateLimitedUntil as string | undefined) ?? null,
        testStatus: (row.testStatus as string | undefined) ?? null,
        baseUrl:
          ((row.providerSpecificData as JsonRecord | undefined)?.baseUrl as string | undefined) ??
          (row.baseUrl as string | undefined) ??
          null,
      }));
    },
    listPoolTargets: async (comboScope) => {
      const { getCombos } = await import("@/lib/db/combos");
      const { resolveComboTargets } =
        await import("@omniroute/open-sse/services/combo/comboStructure.ts");
      const { expandAutoComboCandidatePool } =
        await import("@omniroute/open-sse/services/combo/autoStrategy.ts");
      const raw = (await getCombos()) as unknown as Array<JsonRecord & { name: string }>;
      // Same wildcard expansion the live router applies before it resolves any combo.
      const all = (await expandProviderWildcardsInCollection(raw as never)) as unknown as Array<
        JsonRecord & { name: string }
      >;
      const chosen = comboScope.length
        ? all.filter((combo) => comboScope.includes(combo.name))
        : all.filter((combo) => combo.strategy === "auto");
      const out: CanaryPoolTarget[] = [];
      let failedCombos = 0;
      for (const combo of chosen) {
        try {
          const expandedCombo = await expandProviderWildcardsInCombo(combo as never);
          const resolved = resolveComboTargets(expandedCombo as never, all as never);
          const expanded = await expandAutoComboCandidatePool(resolved, expandedCombo as never);
          for (const target of expanded) {
            out.push({
              provider: target.provider,
              modelStr: target.modelStr,
              connectionId: target.connectionId ?? null,
            });
          }
        } catch (err) {
          // One broken combo must not stop probing for the others, but it must not be silent.
          failedCombos += 1;
          log.warn(`combo ${combo.name}: pool resolution failed`, {
            error: sanitizeErrorMessage(err),
          });
        }
      }
      if (failedCombos > 0 && out.length === 0) {
        throw new Error("no combo pool could be resolved");
      }
      return out;
    },
    getEvidenceCounts: async () => {
      const { getModelLatencyStats } = await import("@/lib/usageDb");
      return (await getModelLatencyStats({
        windowHours: 24,
        minSamples: 1,
        maxRows: 10000,
      })) as Record<string, { totalRequests?: number }>;
    },
    getPricing: async (provider, model) => {
      const { getPricingForModel } = await import("@/lib/db/settings/pricing");
      return (await getPricingForModel(provider, model)) as CanaryPricing | null;
    },
    canExecuteProvider: (provider) => getCircuitBreaker(provider).canExecute(),
    isModelLocked: (provider, connectionId, model) => isModelLocked(provider, connectionId, model),
    isLocalProvider: (provider) => isLocalProvider(provider),
    isChatCapable: async (provider, model) => {
      const { getSyncedAvailableModels, getCustomModels } = await import("@/lib/db/models");
      const { getModelsByProviderId } =
        await import("@omniroute/open-sse/config/providerModels.ts");
      const CHAT_FORMATS = ["chat-completions", "responses", "chat"];
      const CHAT_ENDPOINTS = ["chat", "chat-completions", "responses"];
      const records = [
        ...((await getSyncedAvailableModels(provider)) as JsonRecord[]),
        ...((await getCustomModels(provider)) as JsonRecord[]),
      ].filter((record) => record && record.id === model);
      if (records.length > 0) {
        return records.every((record) => {
          const format = typeof record.apiFormat === "string" ? record.apiFormat : null;
          const endpoints = Array.isArray(record.supportedEndpoints)
            ? (record.supportedEndpoints as unknown[]).filter(
                (e): e is string => typeof e === "string"
              )
            : null;
          if (format && !CHAT_FORMATS.includes(format)) return false;
          if (endpoints && endpoints.length > 0) {
            return endpoints.some((e) => CHAT_ENDPOINTS.includes(e));
          }
          // A record that declares nothing (plain catalog syncs often do not) proves nothing:
          // fall back to the static chat catalog rather than assuming chat.
          return format !== null && CHAT_FORMATS.includes(format)
            ? true
            : getModelsByProviderId(provider).some((entry) => entry.id === model);
        });
      }
      // No synced or custom record: the static chat catalog is the declared source.
      return getModelsByProviderId(provider).some((entry) => entry.id === model);
    },
    runProbe: async (args) => {
      const { runSingleModelTest } = await import("@/lib/api/modelTestRunner");
      // Tag every usage row the pipeline writes for this probe, so cost and usage reports can
      // tell synthetic probes from client traffic. The selector still reads these rows.
      const outcome = await runWithUsageSource(USAGE_SOURCE_ROUTING_CANARY, async () => {
        const result = await runSingleModelTest({
          providerId: args.provider,
          modelId: args.modelStr,
          connectionId: args.connectionId,
          timeoutMs: args.timeoutMs,
          streamChat: true,
          prompt: args.prompt,
          maxTokens: args.maxTokens,
          hardDeadline: true,
        });
        // A deadline that fires before any response cancels the upstream request, and the
        // pipeline then writes no usage_history row. That timeout is the reliability evidence
        // the probe exists to collect, so record it here, tagged like the rest of the probe.
        if (result.responseNotReceived) {
          const { saveRequestUsage } = await import("@/lib/usageDb");
          await saveRequestUsage({
            provider: args.provider,
            model: args.model,
            connectionId: args.connectionId,
            status: String(result.httpStatus),
            success: false,
            latencyMs: result.latencyMs,
            errorCode: "probe_deadline",
            endpoint: "/v1/chat/completions",
          });
        }
        return result;
      });
      return {
        ok: outcome.status === "ok",
        latencyMs: outcome.latencyMs,
        statusCode: outcome.statusCode,
      };
    },
  };
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
const schedulerState = createRoutingEvidenceCanaryState();

/** Start the in-process scheduler. Idempotent. A no-op each tick until settings enable it. */
export function startRoutingEvidenceCanary(): void {
  if (schedulerInterval) return;
  log.info("scheduler started");
  const deps = createDefaultRoutingEvidenceCanaryDeps();
  schedulerInterval = setInterval(() => {
    runRoutingEvidenceCanaryTick(deps, schedulerState).catch(() => undefined);
  }, ROUTING_CANARY_TICK_INTERVAL_MS);
  schedulerInterval.unref?.();
}

/** Stop the in-process scheduler. Idempotent. */
export function stopRoutingEvidenceCanary(): void {
  if (!schedulerInterval) return;
  clearInterval(schedulerInterval);
  schedulerInterval = null;
  log.info("scheduler stopped");
}
