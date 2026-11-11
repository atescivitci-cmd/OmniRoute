import { getDbInstance } from "../../../src/lib/db/core.ts";
import { readBoundedCallArtifact } from "../../../src/lib/usage/callLogArtifacts.ts";
import { isRecord } from "../combo/comboData.ts";
import { isFingerprintProvider } from "../combo/fingerprintExpansion.ts";
import type { RankedFitFirstCandidate } from "./fitFirstPolicy.ts";
import { localFallbackTier } from "./localFallbackPolicy.ts";

const WINDOW_MS = 7 * 86400_000;
const APP_BUDGET_MS = 18_000;
const MAX_ARTIFACTS = 8;
const MAX_BYTES = 128 * 1024;
const DETAIL_BUDGET_MS = 100;
let activeDetailReads = 0;

interface CallRow {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  connection_id: string;
  correlation_id: string | null;
  path: string;
  method: string;
  status: number;
  duration: number;
  has_error: number;
  cache_source: string;
  has_response_body: number;
  detail_state: string;
  has_pipeline_details: number;
  artifact_relpath: string;
  artifact_size_bytes: number;
  artifact_sha256: string;
}

export function isPressedTextRequest(comboName: string, body: Record<string, unknown>): boolean {
  return (
    comboName === "ac-pressed-zero-token-cost" &&
    body.stream === false &&
    body.modalities === undefined &&
    !body.audio &&
    Array.isArray(body.messages) &&
    body.messages.length > 0 &&
    body.messages.every(
      (message) =>
        isRecord(message) &&
        typeof message.role === "string" &&
        ["user", "assistant", "system", "developer"].includes(message.role) &&
        (typeof message.content === "string" ||
          (Array.isArray(message.content) &&
            message.content.every(
              (part) => isRecord(part) && part.type === "text" && typeof part.text === "string"
            )))
    )
  );
}

function partial(value: Record<string, unknown>): boolean {
  return Boolean(
    value.error ||
    value.truncated ||
    value.incomplete ||
    value.incomplete_details ||
    value.status === "incomplete" ||
    value._truncated ||
    value._omniroute_truncated ||
    value._omniroute_truncated_keys ||
    value._omniroute_truncated_array ||
    value._streamed
  );
}

function visibleText(value: unknown): boolean {
  if (typeof value !== "string" || !value.replace(/[\s\u200b-\u200d\u2060\ufeff]/gu, ""))
    return false;
  // Conservatively skip mixed tagged output, placeholders, and truncated log previews too.
  return !/<\/?(?:think(?:ing)?|thought|internal_thought|analysis|reasoning|scratchpad|tool_call|function_call)\b|<\|(?:channel|tool_call|analysis)\||\[(?:MaxDepth|TRUNCATED_DEPTH|\.\.\.truncated|omitted:)/i.test(
    value
  );
}

function completeChatResponse(value: unknown, row?: CallRow): boolean {
  if (
    !isRecord(value) ||
    partial(value) ||
    (value.object != null && value.object !== "chat.completion") ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    return false;
  if (
    row &&
    value.model != null &&
    value.model !== row.model &&
    value.model !== row.provider + "/" + row.model
  )
    return false;
  const choice = value.choices[0];
  if (!isRecord(choice) || partial(choice) || choice.delta || choice.finish_reason !== "stop")
    return false;
  const msg = choice.message;
  return (
    isRecord(msg) &&
    !partial(msg) &&
    msg.role === "assistant" &&
    !msg.tool_calls &&
    !msg.function_call &&
    !msg.refusal &&
    visibleText(msg.content) &&
    !(
      typeof msg.reasoning_content === "string" &&
      msg.reasoning_content.trim() === String(msg.content).trim()
    )
  );
}

function completeClientResponse(value: unknown, path: string): boolean {
  if (!path.endsWith("/messages")) return completeChatResponse(value);
  return (
    isRecord(value) &&
    !partial(value) &&
    value.type === "message" &&
    value.role === "assistant" &&
    value.stop_reason === "end_turn" &&
    Array.isArray(value.content) &&
    value.content.every(
      (part) =>
        isRecord(part) &&
        !partial(part) &&
        typeof part.type === "string" &&
        ["text", "thinking", "redacted_thinking"].includes(part.type)
    ) &&
    value.content.some((part) => isRecord(part) && part.type === "text" && visibleText(part.text))
  );
}

async function verifiedResponse(row: CallRow, comboName: string) {
  const artifact = await readBoundedCallArtifact(row, MAX_BYTES);
  if (!artifact || artifact.schemaVersion !== 5 || artifact.error || artifact.pipeline?.error)
    return false;
  const summary = artifact.summary;
  if (
    !summary ||
    summary.id !== row.id ||
    summary.timestamp !== row.timestamp ||
    summary.provider !== row.provider ||
    summary.model !== row.model ||
    summary.connectionId !== row.connection_id ||
    summary.comboName !== comboName ||
    summary.status !== row.status ||
    summary.duration !== row.duration ||
    summary.path !== row.path ||
    summary.method !== row.method
  )
    return false;
  // A stored client result takes precedence, including an explicit incomplete result.
  // Without pipeline details, /v1/messages can retain a normalized OpenAI provider body.
  if (row.has_pipeline_details)
    return completeClientResponse(artifact.pipeline?.clientResponse, row.path);
  return (
    !artifact.pipeline &&
    row.has_response_body === 1 &&
    completeChatResponse(artifact.responseBody, row)
  );
}

// Optional disk detail must not hold a new selection open. A timed-out read owns its
// slot until it actually settles, so a stalled filesystem cannot accumulate reads.
async function verifyWithinBudget(row: CallRow, comboName: string, deadline: number) {
  const remaining = deadline - performance.now();
  if (remaining <= 0 || activeDetailReads >= MAX_ARTIFACTS) return false;
  activeDetailReads++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (
      (await Promise.race([
        verifiedResponse(row, comboName)
          .catch(() => false)
          .finally(() => {
            activeDetailReads--;
          }),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        }),
      ])) && performance.now() < deadline
    );
  } finally {
    clearTimeout(timer);
  }
}

const pairKey = (provider: string, model: string, connection: string) =>
  JSON.stringify([provider, model, connection]);

/** Reorders only already-admitted concrete pairs; never feeds call outcomes to the p95/health estimators. */
export async function applyPressedResponsiveness(
  ranked: RankedFitFirstCandidate[],
  comboName: string,
  localPolicy: "last" | null,
  currentId?: string | null
) {
  if (ranked.length < 2) return;
  const pairs = new Map<string, RankedFitFirstCandidate[]>();
  for (const entry of ranked) {
    const { provider, model, connectionId } = entry.candidate;
    // call_logs has no fingerprint identity for accounts sharing one connection.
    if (!connectionId || isFingerprintProvider(provider)) continue;
    const key = pairKey(provider, model, connectionId);
    const entries = pairs.get(key) ?? [];
    entries.push(entry);
    pairs.set(key, entries);
  }
  if (!pairs.size) return;

  let rows: CallRow[];
  try {
    const now = Date.now();
    // Limit the indexed combo/time slice BEFORE filtering evidence so scan work is bounded.
    rows = getDbInstance()
      .prepare(
        `
      SELECT id, timestamp, provider, model, connection_id, correlation_id, path, method, status,
             duration, error_summary IS NOT NULL AS has_error, cache_source, has_response_body,
             detail_state, has_pipeline_details, artifact_relpath, artifact_size_bytes, artifact_sha256
      FROM call_logs INDEXED BY idx_call_logs_combo_name_timestamp WHERE combo_name = ? AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp DESC LIMIT 256
    `
      )
      .all(
        comboName,
        new Date(now - WINDOW_MS).toISOString(),
        new Date(now).toISOString()
      ) as CallRow[];
  } catch {
    return;
  }
  const deadline = performance.now() + DETAIL_BUDGET_MS;
  const seen = new Set<string>();
  let reads = 0;
  for (const row of rows) {
    const entries = pairs.get(pairKey(row.provider, row.model, row.connection_id));
    const timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== row.timestamp)
      continue;
    if (
      !entries ||
      row.method !== "POST" ||
      row.cache_source !== "upstream" ||
      !/^\/(?:api\/)?v1\/(?:messages|chat\/completions)$/.test(row.path) ||
      (currentId && row.correlation_id === currentId) ||
      !Number.isSafeInteger(row.duration) ||
      row.duration <= 0
    )
      continue;
    const counts = entries[0].factors.responsiveness;
    if (counts && counts.deadlineMisses + counts.timelyResponses >= 4) continue;
    // Older attempts without correlation IDs count at most once per pair per UTC day.
    const observation = JSON.stringify([
      row.provider,
      row.model,
      row.connection_id,
      row.correlation_id || row.timestamp.slice(0, 10),
    ]);
    if (seen.has(observation)) continue;
    const late = row.duration >= APP_BUDGET_MS;
    if (!(row.status === 504 && late)) {
      if (
        row.status !== 200 ||
        row.has_error ||
        row.detail_state !== "ready" ||
        !(row.has_pipeline_details || row.has_response_body) ||
        !(row.artifact_size_bytes > 0 && row.artifact_size_bytes <= MAX_BYTES) ||
        reads >= MAX_ARTIFACTS
      )
        continue;
      reads++;
      if (!(await verifyWithinBudget(row, comboName, deadline))) continue;
    }
    seen.add(observation);
    for (const entry of entries) {
      const counts = (entry.factors.responsiveness ??= {
        source: "call_logs_provider_responsiveness",
        deadlineMisses: 0,
        timelyResponses: 0,
        baseFitScore: entry.factors.score,
        adjustment: 0,
      });
      if (late) counts.deadlineMisses++;
      else counts.timelyResponses++;
    }
  }
  if (!seen.size) return;
  for (const { factors } of ranked) {
    const evidence = factors.responsiveness;
    if (!evidence) continue;
    // A timely response can overcome a small fit gap. Even repeated misses have bounded influence.
    const net = evidence.timelyResponses - evidence.deadlineMisses;
    evidence.adjustment = net < 0 ? Math.max(-0.12, 0.06 * net) : Math.min(0.03, 0.015 * net);
    factors.score = Math.max(0, Math.min(1, evidence.baseFitScore + evidence.adjustment));
  }
  // Preserve the native ordering across every quota and local-last boundary.
  for (let start = 0; start < ranked.length;) {
    const first = ranked[start].candidate;
    let end = start + 1;
    while (
      end < ranked.length &&
      ranked[end].candidate.quotaRemaining === first.quotaRemaining &&
      localFallbackTier(ranked[end].candidate.provider, localPolicy) ===
        localFallbackTier(first.provider, localPolicy)
    )
      end++;
    const ordered = ranked
      .slice(start, end)
      .sort(
        (a, b) =>
          b.factors.score - a.factors.score ||
          b.factors.taskFitness - a.factors.taskFitness ||
          b.factors.complexityFit - a.factors.complexityFit
      );
    ranked.splice(start, ordered.length, ...ordered);
    start = end;
  }
}
