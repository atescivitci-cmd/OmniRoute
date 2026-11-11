import { getDbInstance } from "../../../src/lib/db/core.ts";
import { readBoundedCallArtifact } from "../../../src/lib/usage/callLogArtifacts.ts";
import { isFingerprintProvider } from "../combo/fingerprintExpansion.ts";
import { localFallbackTier } from "./localFallbackPolicy.ts";
import {
  buildDeadlineRequestClass,
  sameDeadlineRequestClass,
  deadlineEndpointIdentity,
} from "../../utils/nativeDispatchEvidence.ts";
import type { RankedFitFirstCandidate } from "./fitFirstPolicy.ts";

const WINDOW_MS = 7 * 86400_000,
  MAX_ROWS = 256,
  MAX_BYTES = 128 * 1024,
  MAX_ARTIFACTS = 24,
  READ_BATCH_SIZE = 8,
  RECENT_MISS_MS = 30 * 60_000,
  RECENT_FAST_MS = 60 * 60_000,
  READ_BUDGET_MS = 100;
let activeReads = 0;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const key = (provider: string, model: string, connection: string) =>
  JSON.stringify([provider, model, connection]);
export type DeadlinePolicy = {
  deadlineMs: number;
  requestClass: NonNullable<ReturnType<typeof buildDeadlineRequestClass>>;
};
export type DeadlineCounts = {
  late: number;
  timely: number;
  censored: number;
  deadlineMs?: number;
  recentMissElapsedMs?: number;
  slowestTimelyMs?: number;
  recentFast?: number;
  consecutiveRecentFast?: number;
};
type Ranked = {
  candidate: {
    provider: string;
    model: string;
    connectionId?: string | null;
    quotaRemaining: number | null;
  };
  factors: { score: number; deadlineResponsiveness?: any };
};
export function resolveDeadlineRoutingPolicy(
  config: unknown,
  body: unknown
): DeadlinePolicy | null {
  if (
    !record(config) ||
    config.deadlineAwareRouting !== true ||
    !Number.isSafeInteger(config.comboTimeoutMs) ||
    config.comboTimeoutMs < 1000 ||
    config.comboTimeoutMs > 2147483647
  )
    return null;
  const requestClass = buildDeadlineRequestClass(body);
  return requestClass ? { deadlineMs: config.comboTimeoutMs, requestClass } : null;
}
/** Stable reorder only: no score, availability, reservation, quota or quality mutation. */
export function reorderByDeadlineEvidence<T extends Ranked>(
  ranked: T[],
  evidence: Map<string, DeadlineCounts>,
  localPolicy: "last" | null
): T[] {
  const groups = new Map<string, number[]>();
  ranked.forEach((entry, index) => {
    const k = JSON.stringify([
      entry.candidate.quotaRemaining,
      localFallbackTier(entry.candidate.provider, localPolicy),
    ]);
    const indices = groups.get(k) ?? [];
    indices.push(index);
    groups.set(k, indices);
  });
  for (const indices of groups.values()) {
    const entries = indices.map((index) => ranked[index]);
    const countsFor = (entry: T) => evidence.get(
      key(entry.candidate.provider, entry.candidate.model, entry.candidate.connectionId ?? "")
    );
    // Fresh matching completions after a miss are stronger evidence of current
    // responsiveness than an older censored sample. Keep the miss in telemetry.
    const recovered = (entry: T) => (countsFor(entry)?.consecutiveRecentFast ?? 0) >= 2;
    const provenTimely = (entry: T) => {
      const e = countsFor(entry);
      return !!e && e.timely >= 2 && (e.late === 0 || recovered(entry));
    };
    const provenFast = (entry: T) =>
      provenTimely(entry) && (countsFor(entry)?.recentFast ?? 0) >= 2;
    // A clean, recent fast observation can break a tie against repeated
    // misses, while ordinary promotion still requires two fast completions.
    const repeatMissPeers = new Set<T>();
    const repeatMisses = new Set<T>();
    for (const entry of entries) {
      const counts = countsFor(entry);
      const missMs = counts?.recentMissElapsedMs;
      if (!counts || counts.late < 2 || missMs === undefined) continue;
      for (const peer of entries) {
        const peerCounts = countsFor(peer);
        if (
          peerCounts?.late === 0 &&
          (peerCounts.recentFast ?? 0) >= 1 &&
          peerCounts.slowestTimelyMs !== undefined &&
          peerCounts.slowestTimelyMs <= missMs * 0.75
        ) {
          repeatMissPeers.add(peer);
          repeatMisses.add(entry);
        }
      }
    }
    const preferFast = (entry: T) => provenFast(entry) || repeatMissPeers.has(entry);
    const hasProvenAlternative = entries.some(provenTimely);
    const fastPeers = entries.filter(provenTimely).map(countsFor);
    const recentSlowdown = (entry: T) => {
      const missMs = countsFor(entry)?.recentMissElapsedMs;
      return missMs !== undefined && fastPeers.some((peer) =>
        peer?.slowestTimelyMs !== undefined && peer.slowestTimelyMs <= missMs * 0.75
      );
    };
    const atRisk = (entry: T) => {
      const e = countsFor(entry);
      return !!e && e.late > 0 && !recovered(entry) &&
        (repeatMisses.has(entry) || recentSlowdown(entry) || e.timely === 0 ||
          (hasProvenAlternative && e.late >= 2 && e.late >= e.timely));
    };
    const canDemote = entries.some((entry) => !atRisk(entry));
    // Prefer repeatable on-time completions within the same quota and local tier.
    // A candidate without evidence remains eligible as a fallback.
    const ordered = canDemote
      ? [...entries.filter(preferFast),
         ...entries.filter((entry) => provenTimely(entry) && !preferFast(entry)),
         ...entries.filter((entry) => !preferFast(entry) && !provenTimely(entry) && !atRisk(entry)),
         ...entries.filter(atRisk)]
      : entries;
    entries.forEach((entry) => {
      const e = evidence.get(
        key(entry.candidate.provider, entry.candidate.model, entry.candidate.connectionId ?? "")
      );
      if (e)
        entry.factors.deadlineResponsiveness = {
          source: "verified_native_deadline_observations",
          deadlineMs: e.deadlineMs ?? 0,
          late: e.late,
          timely: e.timely,
          censored: e.censored,
          demoted: canDemote && atRisk(entry),
          preferred: canDemote && provenTimely(entry),
          recentSlowdown: recentSlowdown(entry),
          fastPreferred: canDemote && preferFast(entry),
          repeatedMissDemotion: canDemote && repeatMisses.has(entry),
        };
    });
    indices.forEach((index, n) => {
      ranked[index] = ordered[n];
    });
  }
  return ranked;
}
export type DeadlineCallRow = {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  connection_id: string;
  correlation_id: string | null;
  combo_name?: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  cache_source: string;
  detail_state: string;
  has_response_body: number;
  has_pipeline_details: number;
  artifact_relpath: string;
  artifact_size_bytes: number;
  artifact_sha256: string;
};
function complete(value: unknown, row: DeadlineCallRow): boolean {
  if (
    !record(value) ||
    value.error ||
    value._truncated ||
    value.incomplete ||
    value.incomplete_details ||
    value.status === "incomplete" ||
    value._streamed ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    return false;
  if (
    value.model != null &&
    value.model !== row.model &&
    value.model !== row.provider + "/" + row.model
  )
    return false;
  const c = value.choices[0],
    m = c?.message;
  return (
    record(c) &&
    !c.delta &&
    c.finish_reason === "stop" &&
    record(m) &&
    m.role === "assistant" &&
    !m.tool_calls &&
    !m.function_call &&
    !m.refusal &&
    typeof m.content === "string" &&
    !!m.content.replace(/[\s\u200b-\u200d\u2060\ufeff]/gu, "") &&
    !/<\/?(?:think|analysis|reasoning|tool_call)\b|<\|(?:channel|analysis)\|/i.test(m.content) &&
    m.reasoning_content?.trim?.() !== m.content.trim()
  );
}
/** A late abort is censored responsiveness evidence, never an outage or nonexecution proof. */
export function qualifyDeadlineObservation(
  row: DeadlineCallRow,
  artifact: unknown,
  policy: DeadlinePolicy,
  endpoint: string,
  comboName: string,
  now = Date.now()
): "late" | "timely" | "censored" | null {
  if (!record(artifact) || artifact.schemaVersion !== 5 || !record(artifact.summary)) return null;
  const s = artifact.summary;
  if (
    s.id !== row.id ||
    s.timestamp !== row.timestamp ||
    s.provider !== row.provider ||
    s.model !== row.model ||
    s.connectionId !== row.connection_id ||
    s.comboName !== comboName ||
    s.status !== row.status ||
    s.duration !== row.duration ||
    s.path !== row.path ||
    s.method !== row.method
  )
    return null;
  const m = artifact.requestBody?._omniroute?.nativeDispatch;
  if (
    !record(m) ||
    m.version !== 1 ||
    m.observed !== true ||
    m.dispatchCount !== 1 ||
    m.endpointIdentity !== endpoint ||
    m.declaredBudgetMs !== policy.deadlineMs ||
    !sameDeadlineRequestClass(m.requestClass, policy.requestClass)
  )
    return null;
  for (const field of [
    "dispatchedAt",
    "deadlineAt",
    "observedAt",
    "elapsedMs",
    "remainingAtDispatchMs",
  ])
    if (!Number.isSafeInteger(m[field])) return null;
  if (
    m.dispatchedAt < now - WINDOW_MS ||
    m.observedAt > now + 1000 ||
    m.observedAt < m.dispatchedAt ||
    m.remainingAtDispatchMs <= 0 ||
    m.remainingAtDispatchMs > m.declaredBudgetMs ||
    m.remainingAtDispatchMs !== m.deadlineAt - m.dispatchedAt ||
    m.elapsedMs !== m.observedAt - m.dispatchedAt
  )
    return null;
  if (row.status === 499 || row.status === 504) {
    // The native signal timestamp, not delayed persistence, determines an early cancellation.
    const terminal = m.abortObservedAt ?? m.fetchRejectedAt;
    if (!Number.isSafeInteger(terminal) || terminal !== m.observedAt || terminal < m.deadlineAt)
      return null;
    return "censored";
  }
  if (row.status !== 200 || artifact.error || artifact.pipeline?.error) return null;
  const response = row.has_pipeline_details
    ? artifact.pipeline?.clientResponse
    : artifact.responseBody;
  if (!complete(response, row)) return null;
  return m.observedAt < m.deadlineAt ? "timely" : "late";
}
async function boundedArtifact(row: DeadlineCallRow, until: number): Promise<unknown | null> {
  const remaining = until - performance.now();
  if (remaining <= 0 || activeReads >= MAX_ARTIFACTS) return null;
  activeReads++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readBoundedCallArtifact(row, MAX_BYTES)
        .catch(() => null)
        .finally(() => {
          activeReads--;
        }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Existing executor/connection resolution is read-only here; no provider dispatch is invoked. */
async function currentEndpoint(
  entry: RankedFitFirstCandidate,
  connections: Map<string, unknown>
): Promise<string | null> {
  const id = entry.candidate.connectionId;
  if (!id || isFingerprintProvider(entry.candidate.provider)) return null;
  const [{ getProviderConnectionById }, { getExecutor }] = await Promise.all([
    import("../../../src/lib/db/providers.ts"),
    import("../../executors/index.ts"),
  ]);
  if (!connections.has(id)) connections.set(id, await getProviderConnectionById(id));
  const connection = connections.get(id);
  if (!record(connection) || connection.provider !== entry.candidate.provider) return null;
  const executor = getExecutor(entry.candidate.provider);
  if (executor.getFallbackCount() !== 1) return null;
  try {
    return deadlineEndpointIdentity(executor.buildUrl(entry.candidate.model, false, 0, connection));
  } catch {
    return null;
  }
}
/** Give each eligible target a turn in the bounded artifact read budget. */
export function interleaveDeadlineRows<T>(rows: T[], pairOf: (row: T) => string): T[] {
  const offsets = new Map<string, number>();
  return rows.map((row) => {
    const pair = pairOf(row);
    const offset = offsets.get(pair) ?? 0;
    offsets.set(pair, offset + 1);
    return { row, offset };
  }).sort((a, b) => a.offset - b.offset).map(({ row }) => row);
}

/** Bound filesystem concurrency while preserving sampling order and completed reads. */
export async function readDeadlineArtifactBatches<T, A>(
  rows: T[],
  read: (row: T) => Promise<A | null>,
  withinBudget: () => boolean
): Promise<Array<{ row: T; artifact: A }>> {
  const samples: Array<{ row: T; artifact: A }> = [];
  const limit = Math.min(rows.length, MAX_ARTIFACTS);
  for (let offset = 0; offset < limit && withinBudget(); offset += READ_BATCH_SIZE) {
    const batch = rows.slice(offset, Math.min(offset + READ_BATCH_SIZE, limit));
    const artifacts = await Promise.all(batch.map(read));
    batch.forEach((row, index) => {
      const artifact = artifacts[index];
      if (artifact !== null) samples.push({ row, artifact });
    });
  }
  return samples;
}

export async function applyDeadlineAwareRouting(
  ranked: RankedFitFirstCandidate[],
  comboName: string,
  policy: DeadlinePolicy,
  localPolicy: "last" | null,
  currentId?: string | null
) {
  if (ranked.length < 2) return;
  const pairs = new Map<string, { endpoint: string; entry: RankedFitFirstCandidate }>(),
    connections = new Map<string, unknown>();
  for (const entry of ranked) {
    const endpoint = await currentEndpoint(entry, connections);
    if (endpoint && entry.candidate.connectionId)
      pairs.set(
        key(entry.candidate.provider, entry.candidate.model, entry.candidate.connectionId),
        { endpoint, entry }
      );
  }
  if (!pairs.size) return;
  let rows: DeadlineCallRow[];
  try {
    const now = Date.now();
    rows = getDbInstance()
      .prepare(
        `SELECT id,timestamp,provider,model,connection_id,correlation_id,method,path,status,duration,cache_source,detail_state,has_response_body,has_pipeline_details,artifact_relpath,artifact_size_bytes,artifact_sha256 FROM call_logs INDEXED BY idx_call_logs_combo_name_timestamp WHERE combo_name=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT ${MAX_ROWS}`
      )
      .all(
        comboName,
        new Date(now - WINDOW_MS).toISOString(),
        new Date(now).toISOString()
      ) as DeadlineCallRow[];
  } catch {
    return;
  }
  const pairOf = (row: DeadlineCallRow) => key(row.provider, row.model, row.connection_id);
  const eligible = rows.filter((row) =>
    pairs.has(pairOf(row)) &&
    row.method === "POST" &&
    row.cache_source === "upstream" &&
    /^\/(?:api\/)?v1\/(?:messages|chat\/completions)$/.test(row.path) &&
    (!currentId || row.correlation_id !== currentId) &&
    [200, 499, 504].includes(row.status) &&
    row.detail_state === "ready" &&
    Number.isSafeInteger(row.duration) &&
    row.duration > 0 &&
    row.artifact_size_bytes > 0 &&
    row.artifact_size_bytes <= MAX_BYTES
  );
  const fairRows = interleaveDeadlineRows(eligible, pairOf);
  const until = performance.now() + READ_BUDGET_MS,
    counts = new Map<string, DeadlineCounts>(),
    seen = new Set<string>();
  const samples = await readDeadlineArtifactBatches(
    fairRows,
    (row) => boundedArtifact(row, until),
    () => performance.now() < until
  );
  for (const { row, artifact } of samples) {
    const pair = pairOf(row);
    const target = pairs.get(pair)!;
    const existing = counts.get(pair);
    if (existing && existing.late + existing.timely >= 4) continue;
    const identity = JSON.stringify([pair, row.correlation_id || row.timestamp.slice(0, 10)]);
    if (seen.has(identity)) continue;
    const result = qualifyDeadlineObservation(row, artifact, policy, target.endpoint, comboName);
    if (!result) continue;
    seen.add(identity);
    const count = existing ?? { late: 0, timely: 0, censored: 0, deadlineMs: policy.deadlineMs };
    const dispatch = (artifact as { requestBody: { _omniroute: { nativeDispatch: {
      elapsedMs: number; observedAt: number;
    } } } }).requestBody._omniroute.nativeDispatch;
    const newerSamplesAllFast =
      (count.consecutiveRecentFast ?? 0) === count.timely + count.late;
    if (result === "timely") {
      count.timely++;
      if (
        Date.now() - dispatch.observedAt <= RECENT_FAST_MS &&
        dispatch.elapsedMs <= policy.deadlineMs * 0.75
      ) {
        count.recentFast = (count.recentFast ?? 0) + 1;
        if (newerSamplesAllFast)
          count.consecutiveRecentFast = (count.consecutiveRecentFast ?? 0) + 1;
      }
      count.slowestTimelyMs = Math.max(count.slowestTimelyMs ?? 0, dispatch.elapsedMs);
    } else {
      count.late++;
      // Only a fresh, near-full-budget miss is comparable to a fast peer.
      if (Date.now() - dispatch.observedAt <= RECENT_MISS_MS &&
          dispatch.elapsedMs >= policy.deadlineMs * 0.9) {
        count.recentMissElapsedMs = Math.max(count.recentMissElapsedMs ?? 0, dispatch.elapsedMs);
      }
    }
    if (result === "censored") count.censored++;
    counts.set(pair, count);
  }
  reorderByDeadlineEvidence(ranked, counts, localPolicy);
}
