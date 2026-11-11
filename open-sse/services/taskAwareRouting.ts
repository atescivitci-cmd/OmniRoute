/**
 * Task-aware routing layer for combo routing.
 *
 * Derives request difficulty (light / standard / heavy / critical) from cheap,
 * local structural signals — no LLM call. Routes heavier tasks toward higher-power
 * models using a continuous `modelPowerScore`. Also provides conversation-affinity
 * sticky round-robin for prompt-cache efficiency.
 *
 * Ported from upstream PR #2045 (decolua/9router) by @nguyenxvotanminh3.
 * Adaptation: operates on ResolvedComboTarget[] (TS target objects) rather than
 * plain string arrays, uses getResolvedModelCapabilities (OmniRoute TS API) instead
 * of getCapabilitiesForModel, and is wired additively — only applies when
 * isTaskRoutingStrategy() returns true. All other strategies are unaffected.
 *
 * ReDoS safety: all regexes use word-boundary anchors with alternation of fixed
 * literals, no variable-length quantifiers on overlapping groups. Safe per
 * CLAUDE.md PII/Regex learnings.
 */

import { createHash } from "node:crypto";
import { getResolvedModelCapabilities } from "./modelCapabilities.ts";
import type { ResolvedComboTarget } from "./combo/types.ts";

// ── Task level constants ──────────────────────────────────────────────────────

export const TASK_LEVEL_WEIGHT = {
  light: 1,
  standard: 2,
  heavy: 3,
  critical: 4,
} as const;

export type TaskLevel = keyof typeof TASK_LEVEL_WEIGHT;

export const TASK_TARGET_POWER: Record<TaskLevel, number> = {
  light: 35,
  standard: 65,
  heavy: 95,
  critical: 120,
};

// ReDoS-safe: all alternations are fixed-length word literals under \b anchors.
// No overlapping or nested quantifiers.
export const LIGHT_TASK_RE =
  /\b(hi|hello|thanks|thank you|ping|format|rewrite|grammar|translate|summari[sz]e|short|quick|one[- ]?liner|explain briefly)\b/i;

export const HEAVY_TASK_RE =
  /\b(debug|root cause|architecture|architectural|refactor|migrate|implementation|implement|design|analy[sz]e|investigate|compare|benchmark|whitebox|codebase|end[- ]?to[- ]?end|e2e)\b/i;

export const CRITICAL_TASK_RE =
  /\b(critical|security|vulnerability|exploit|rce|remote code execution|supply chain|account takeover|auth bypass|privilege escalation|tenant|cross[- ]tenant|sandbox escape|ssrf|deserialization|prod incident|data exfiltration|bug bounty)\b/i;

// ── Conversation affinity state ───────────────────────────────────────────────

/** @internal exported only for testing */
export const comboConversationAffinity = new Map<string, { index: number; lastUsed: number }>();
const CONVERSATION_AFFINITY_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CONVERSATION_AFFINITY_ENTRIES = 1000;

// ── Strategy gate ─────────────────────────────────────────────────────────────

/**
 * Returns true when the combo strategy is one of the task-aware strategies.
 * Task routing is additive: other strategies are wholly unaffected.
 */
export function isTaskRoutingStrategy(strategy: unknown): boolean {
  return ["smart", "task", "task-aware", "task_aware", "auto"].includes(
    String(strategy ?? "").toLowerCase()
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function taskWeight(level: TaskLevel): number {
  return TASK_LEVEL_WEIGHT[level];
}

function collectText(value: unknown, out: string[] = []): string[] {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return out;
  }
  if (typeof value !== "object") return out;

  const rec = value as Record<string, unknown>;
  if (typeof rec["text"] === "string") out.push(rec["text"]);
  if (typeof rec["input_text"] === "string") out.push(rec["input_text"]);
  if (typeof rec["output_text"] === "string") out.push(rec["output_text"]);
  if (typeof rec["content"] === "string") out.push(rec["content"]);
  else if (Array.isArray(rec["content"])) collectText(rec["content"], out);
  if (Array.isArray(rec["parts"])) collectText(rec["parts"], out);
  if (typeof rec["query"] === "string") out.push(rec["query"]);
  if (typeof rec["url"] === "string") out.push(rec["url"]);

  return out;
}

function estimatePromptChars(body: Record<string, unknown>): number {
  const contents =
    (body["contents"] as unknown) ??
    ((body["request"] as Record<string, unknown> | undefined)?.["contents"] as unknown);
  const parts = [
    body["system"],
    body["instructions"],
    body["messages"],
    body["input"],
    contents,
    body["query"],
    body["url"],
  ];
  return collectText(parts).join("\n").length;
}

type WireSource<T> = { path: string; value: T };
type SignalStatus = "absent" | "observed" | "conflict" | "invalid";

/** Advisory wire observations, not proof of caller intent or an admission decision. */
export interface TaskResourceNormalization {
  messageSources: string[];
  messageDialectConflict: boolean;
  outputLimitSources: Array<WireSource<number>>;
  outputLimitStatus: SignalStatus;
  invalidOutputFields: string[];
}

export interface TaskExecutionPreferences {
  effortSources: Array<WireSource<string>>;
  effortStatus: SignalStatus;
  // A field on the wire may be an SDK default or an explicit user choice. The
  // request does not authenticate that distinction, so never invent it here.
  provenance: "not-observed" | "wire-unattributed";
  thinkingModeSources: Array<WireSource<string>>;
  thinkingBudgetSources: Array<WireSource<number>>;
  thinkingBudgetTokens: number | null;
  thinkingBudgetMode: "absent" | "bounded" | "disabled" | "automatic" | "conflict";
  invalidFields: string[];
}

function wireValue(body: Record<string, unknown>, path: string): unknown {
  let value: unknown = body;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function normalizeResources(body: Record<string, unknown>) {
  const messageSources: string[] = [];
  const messageArrays = new Set<unknown[]>();
  for (const path of ["messages", "input", "contents", "request.contents"]) {
    const value = wireValue(body, path);
    if (!Array.isArray(value)) continue;
    messageSources.push(path);
    messageArrays.add(value);
  }
  // Different simultaneously supplied dialects cannot safely be assumed to be
  // aliases. Keep a conservative count and expose the ambiguity, without changing
  // the request. A top-level contents array is never added a second time.
  let messageCount = [...messageArrays].reduce((count, messages) => count + messages.length, 0);
  const hasScalarInput = typeof body.input === "string";
  if (hasScalarInput) {
    messageSources.push("input");
    messageCount += 1;
  }
  const outputLimitSources: Array<WireSource<number>> = [];
  const invalidOutputFields: string[] = [];
  for (const path of [
    "max_tokens",
    "max_output_tokens",
    "max_completion_tokens",
    "generationConfig.maxOutputTokens",
    "request.generationConfig.maxOutputTokens",
  ]) {
    const value = wireValue(body, path);
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      invalidOutputFields.push(path);
    } else outputLimitSources.push({ path, value });
  }
  const distinctLimits = new Set(outputLimitSources.map((entry) => entry.value));
  const outputLimitStatus: SignalStatus =
    invalidOutputFields.length > 0
      ? "invalid"
      : distinctLimits.size > 1
        ? "conflict"
        : distinctLimits.size > 0
          ? "observed"
          : "absent";
  return {
    messageCount,
    outputTokens:
      outputLimitSources.length > 0
        ? Math.max(...outputLimitSources.map((entry) => entry.value))
        : 0,
    normalization: {
      messageSources,
      messageDialectConflict: messageArrays.size + Number(hasScalarInput) > 1,
      outputLimitSources,
      outputLimitStatus,
      invalidOutputFields,
    } satisfies TaskResourceNormalization,
  };
}

function getTaskText(body: Record<string, unknown>): string {
  const contents =
    (body?.["contents"] as unknown) ??
    ((body?.["request"] as Record<string, unknown> | undefined)?.["contents"] as unknown);
  return collectText([
    body?.["system"],
    body?.["instructions"],
    body?.["messages"],
    body?.["input"],
    contents,
    body?.["query"],
    body?.["url"],
  ]).join("\n");
}

function normalizeEffort(body: Record<string, unknown>) {
  const effortSources: Array<WireSource<string>> = [];
  const thinkingModeSources: Array<WireSource<string>> = [];
  const thinkingBudgetSources: Array<WireSource<number>> = [];
  const invalidFields: string[] = [];
  const allowedEfforts = new Set([
    "none",
    "off",
    "disabled",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "maximum",
    "hard",
    "deep",
  ]);
  for (const path of [
    "reasoning_effort",
    "reasoning.effort",
    "output_config.effort",
    "generationConfig.thinkingConfig.thinkingLevel",
    "request.generationConfig.thinkingConfig.thinkingLevel",
  ]) {
    const value = wireValue(body, path);
    if (value === undefined) continue;
    if (typeof value !== "string" || !allowedEfforts.has(value.toLowerCase())) {
      invalidFields.push(path);
    } else effortSources.push({ path, value: value.toLowerCase() });
  }
  const thinkingMode = wireValue(body, "thinking.type");
  if (thinkingMode !== undefined) {
    if (
      typeof thinkingMode === "string" &&
      ["adaptive", "enabled", "disabled"].includes(thinkingMode)
    ) {
      thinkingModeSources.push({ path: "thinking.type", value: thinkingMode });
    } else invalidFields.push("thinking.type");
  }
  for (const path of [
    "thinking.budget_tokens",
    "generationConfig.thinkingConfig.thinkingBudget",
    "request.generationConfig.thinkingConfig.thinkingBudget",
  ]) {
    const value = wireValue(body, path);
    if (value === undefined) continue;
    const minimum = path === "thinking.budget_tokens" ? 1 : -1;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
      invalidFields.push(path);
    } else thinkingBudgetSources.push({ path, value });
  }
  const distinctEfforts = new Set(effortSources.map((entry) => entry.value));
  const budgetModes = new Set(
    thinkingBudgetSources.map(({ value }) =>
      value === -1 ? "automatic" : value === 0 ? "disabled" : "bounded"
    )
  );
  const budgetValues = new Set(thinkingBudgetSources.map(({ value }) => value));
  const budgetConflict = budgetModes.size > 1 || budgetValues.size > 1;
  const disabledMode = thinkingModeSources.some(({ value }) => value === "disabled");
  const positivePreference = effortSources.some(
    ({ value }) => !["none", "off", "disabled"].includes(value)
  );
  const activeThinking =
    thinkingModeSources.some(({ value }) => value !== "disabled") ||
    thinkingBudgetSources.some(({ value }) => value !== 0);
  const offPreference = effortSources.some(({ value }) =>
    ["none", "off", "disabled"].includes(value)
  );
  const disabledBudget = thinkingBudgetSources.some(({ value }) => value === 0);
  const activeMode = thinkingModeSources.some(({ value }) => value !== "disabled");
  const effortConflict =
    distinctEfforts.size > 1 ||
    budgetConflict ||
    (disabledMode && (positivePreference || activeThinking)) ||
    (offPreference && activeThinking) ||
    (disabledBudget && (positivePreference || activeMode));
  const effortStatus: SignalStatus =
    invalidFields.length > 0
      ? "invalid"
      : effortConflict
        ? "conflict"
        : effortSources.length > 0
          ? "observed"
          : "absent";
  const observed =
    effortSources.length > 0 ||
    thinkingMode !== undefined ||
    thinkingBudgetSources.length > 0 ||
    invalidFields.length > 0;
  return {
    effort: effortStatus === "observed" ? effortSources[0].value : "",
    hasExplicitReasoning: positivePreference || activeThinking,
    preferences: {
      effortSources,
      effortStatus,
      provenance: observed ? "wire-unattributed" : "not-observed",
      thinkingModeSources,
      thinkingBudgetSources,
      thinkingBudgetTokens: thinkingBudgetSources.some(({ value }) => value > 0)
        ? Math.max(...thinkingBudgetSources.map(({ value }) => Math.max(0, value)))
        : null,
      thinkingBudgetMode: budgetConflict ? "conflict" : ([...budgetModes][0] ?? "absent"),
      invalidFields,
    } satisfies TaskExecutionPreferences,
  };
}

function hasPositiveComplexOperation(body: Record<string, unknown>): boolean {
  const arrays = [body.messages, body.input, body.contents, wireValue(body, "request.contents")];
  let currentAsk = "";
  for (const messages of arrays) {
    if (!Array.isArray(messages)) continue;
    const users = messages.filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        String((entry as Record<string, unknown>).role ?? "").toLowerCase() === "user"
    );
    const last = users.at(-1) as Record<string, unknown> | undefined;
    if (last) currentAsk = collectText(last.content ?? last.parts ?? last.text).join("\n");
    if (currentAsk) break;
  }
  if (!currentAsk) {
    const value = typeof body.input === "string" ? body.input : (body.prompt ?? body.query);
    if (typeof value === "string") currentAsk = value;
  }
  // A narrow positive operation cue can support high effort; generic system
  // scaffolding, quoted labels and "do not analyze" are not such evidence.
  return /^\s*(?:please\s+)?(?:analy[sz]e|debug|investigate|design|refactor|implement|migrate|compare|benchmark|architect)\b/i.test(
    currentAsk
  );
}

// ── Task signals ──────────────────────────────────────────────────────────────

export interface TaskSignals {
  promptChars: number;
  messageCount: number;
  toolCount: number;
  outputTokens: number;
  effort: string;
  /** A reasoning control was observed on the wire, not proven user-origin intent. */
  hasExplicitReasoning: boolean;
  executionPreferences?: TaskExecutionPreferences;
  resourceNormalization?: TaskResourceNormalization;
  lightKeyword: boolean;
  heavyKeyword: boolean;
  criticalKeyword: boolean;
}

export function getTaskSignals(body: Record<string, unknown>): TaskSignals {
  const promptChars = estimatePromptChars(body);
  const resources = normalizeResources(body);
  const messageCount = resources.messageCount;
  const toolCount = Array.isArray(body?.["tools"]) ? (body["tools"] as unknown[]).length : 0;
  const outputTokens = resources.outputTokens;
  const execution = normalizeEffort(body);
  const effort = execution.effort;
  const text = getTaskText(body);

  return {
    promptChars,
    messageCount,
    toolCount,
    outputTokens,
    effort,
    hasExplicitReasoning: execution.hasExplicitReasoning,
    executionPreferences: execution.preferences,
    resourceNormalization: resources.normalization,
    lightKeyword: LIGHT_TASK_RE.test(text),
    heavyKeyword: HEAVY_TASK_RE.test(text),
    criticalKeyword: CRITICAL_TASK_RE.test(text),
  };
}

// ── Task classification ───────────────────────────────────────────────────────

export interface TaskClassification extends TaskSignals {
  level: TaskLevel;
  weight: number;
  reasons: string[];
}

/**
 * Classify request difficulty for smart combo routing.
 *
 * Deliberately uses cheap, local signals only — no LLM call. It is a routing
 * hint: light requests stay on fast/cheap models while large, tool-heavy,
 * security-sensitive, or reasoning-heavy requests try stronger models first.
 * Fallback still tries every model.
 */
export function classifyTask(body: Record<string, unknown>): TaskClassification {
  const s = getTaskSignals(body ?? {});
  const reasons: string[] = [];
  const add = (condition: boolean, reason: string): boolean => {
    if (condition) reasons.push(reason);
    return condition;
  };

  const effortIsHigh = /^(high|xhigh|max|maximum|hard|deep)$/.test(s.effort);
  const complexOperationWithHighEffort = effortIsHigh && hasPositiveComplexOperation(body);

  const critical =
    add(s.promptChars >= 100000, "huge-context") ||
    add(s.outputTokens >= 32768, "huge-output") ||
    add(s.toolCount >= 8 && s.promptChars >= 16000, "many-tools-large-context") ||
    add(
      s.criticalKeyword && (effortIsHigh || s.toolCount >= 3 || s.promptChars >= 8000),
      "critical-domain"
    );

  if (critical) {
    return { level: "critical", weight: taskWeight("critical"), ...s, reasons };
  }

  const heavySignalCount = [
    add(s.promptChars >= 50000, "large-context"),
    add(s.promptChars >= 24000, "medium-large-context"),
    add(s.messageCount >= 16, "long-conversation"),
    add(s.toolCount >= 4, "many-tools"),
    add(s.outputTokens >= 8192, "large-output"),
    add(s.criticalKeyword, "security-sensitive"),
    add(s.heavyKeyword && s.promptChars >= 4000, "complex-task"),
  ].filter(Boolean).length;

  if (complexOperationWithHighEffort) reasons.push("complex-operation-with-high-effort");
  if (heavySignalCount >= 2 || s.promptChars >= 50000 || complexOperationWithHighEffort) {
    return { level: "heavy", weight: taskWeight("heavy"), ...s, reasons };
  }

  const normalized = s.resourceNormalization!;
  const preferences = s.executionPreferences!;
  if (normalized.invalidOutputFields.length > 0) reasons.push("invalid-output-limit");
  if (normalized.outputLimitStatus === "conflict") reasons.push("conflicting-output-limits");
  if (normalized.messageDialectConflict) reasons.push("conflicting-message-dialects");
  if (preferences.effortStatus === "conflict") reasons.push("conflicting-reasoning-controls");
  if (preferences.invalidFields.length > 0) reasons.push("invalid-reasoning-controls");
  const controlsUnambiguous =
    normalized.invalidOutputFields.length === 0 &&
    normalized.outputLimitStatus !== "conflict" &&
    !normalized.messageDialectConflict &&
    preferences.effortStatus !== "conflict" &&
    preferences.invalidFields.length === 0;
  const light =
    controlsUnambiguous &&
    s.promptChars <= 2000 &&
    s.messageCount <= 3 &&
    s.toolCount === 0 &&
    s.outputTokens <= 1500 &&
    !s.criticalKeyword &&
    !s.heavyKeyword;

  if (
    light ||
    (s.lightKeyword &&
      controlsUnambiguous &&
      s.promptChars <= 4000 &&
      s.messageCount <= 3 &&
      s.toolCount === 0 &&
      s.outputTokens <= 1500 &&
      !s.criticalKeyword &&
      !s.heavyKeyword)
  ) {
    return {
      level: "light",
      weight: taskWeight("light"),
      ...s,
      reasons: reasons.length > 0 ? reasons : ["small-simple-request"],
    };
  }

  return {
    level: "standard",
    weight: taskWeight("standard"),
    ...s,
    reasons: reasons.length > 0 ? reasons : ["default"],
  };
}

// ── Model power scoring ───────────────────────────────────────────────────────

/**
 * Estimate how capable a model is on a continuous 0–150 scale, using both
 * registry-derived capabilities and heuristic name matching.
 */
export function modelPowerScore(modelStr: string): number {
  const id = `${modelStr ?? ""}`.toLowerCase();
  const caps = getResolvedModelCapabilities(modelStr);

  let score = 35;
  if (caps.reasoning) score += 18;
  if (caps.supportsVision === true) score += 3;
  if (caps.toolCalling) score += 3;

  const ctx = caps.contextWindow ?? 0;
  if (ctx >= 1_000_000) score += 22;
  else if (ctx >= 400_000) score += 15;
  else if (ctx >= 200_000) score += 9;
  else if (ctx > 0 && ctx <= 32_000) score -= 10;

  const maxOut = caps.maxOutputTokens ?? 0;
  if (maxOut >= 128_000) score += 12;
  else if (maxOut >= 64_000) score += 8;
  else if (maxOut > 0 && maxOut <= 8_192) score -= 8;

  if (
    /\b(opus|mythos|gpt-5|o3|o4|pro|max|ultra|deepseek-v4-pro|sonnet-4|glm-5|kimi-k2\.7|minimax-m3|reasoner)\b/i.test(
      id
    )
  )
    score += 28;
  if (/\b(coder|code|coding)\b/i.test(id)) score += 8;
  if (/\b(haiku|flash|mini|lite|small|nano|instant|fast|turbo|3\.5|8b|7b)\b/i.test(id)) score -= 24;

  return Math.max(0, Math.min(150, score));
}

// Hard capabilities: missing one drops request data (images, PDFs). Maps TS
// ResolvedModelCapabilities fields that correspond to hard-cap modalities.
const HARD_CAP_CHECKS = new Set(["vision"]);

/**
 * Score a single model for a given task + capability requirements.
 * Higher score = better fit. Negative score = capability hard-miss.
 */
export function scoreModelForTask(
  modelStr: string,
  task: TaskClassification = classifyTask({}),
  required: Set<string> = new Set()
): number {
  const caps = getResolvedModelCapabilities(modelStr);
  const target = TASK_TARGET_POWER[task.level];
  const power = modelPowerScore(modelStr);
  let score = 100 - Math.abs(power - target);

  // Hard capability misses: drop score heavily so the model sorts to the back
  // but stays in the list (fallback still tries every model).
  for (const cap of required) {
    if (!HARD_CAP_CHECKS.has(cap)) continue;
    if (cap === "vision" && caps.supportsVision !== true) score -= 10000;
  }

  if ((required.has("reasoning") || task.weight >= TASK_LEVEL_WEIGHT.heavy) && !caps.reasoning)
    score -= 120;
  if (required.has("search") && !caps.toolCalling) score -= 30;

  const estimatedPromptTokens = Math.ceil((task.promptChars ?? 0) / 4);
  const ctxLimit = caps.contextWindow ?? 0;
  if (ctxLimit > 0 && estimatedPromptTokens > ctxLimit * 0.85) score -= 200;

  const maxOut = caps.maxOutputTokens ?? 0;
  if (maxOut > 0 && task.outputTokens > 0 && task.outputTokens > maxOut) score -= 80;

  if (task.level === "light" && power > 95) score -= 35;
  if (task.level === "standard" && power > 125) score -= 10;
  if (task.level === "heavy" && power < 65) score -= 60;
  if (task.level === "critical" && power < 85) score -= 100;

  return score;
}

/**
 * Reorder ResolvedComboTarget[] so the best-fit model for the task comes first.
 * Stable: ties keep original order. Identity-returns when no reordering needed
 * (avoids allocations on the common path). Never removes targets.
 */
export function reorderByTaskWeight(
  targets: ResolvedComboTarget[],
  task: TaskClassification = classifyTask({}),
  required: Set<string> = new Set()
): ResolvedComboTarget[] {
  if (!Array.isArray(targets) || targets.length <= 1) return targets;

  const reordered = targets
    .map((t, i) => ({ t, i, score: scoreModelForTask(t.modelStr, task, required) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.t);

  return reordered.every((t, i) => t === targets[i]) ? targets : reordered;
}

// ── Conversation affinity (cache-key derivation) ──────────────────────────────

function normalizeFingerprintText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

function firstRoleText(
  items: unknown[],
  roles: Set<string>,
  contentKey: "content" | "parts" = "content"
): string {
  if (!Array.isArray(items)) return "";
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (!roles.has(String(rec["role"] ?? ""))) continue;
    const raw = contentKey === "parts" ? rec["parts"] : rec["content"];
    const text = normalizeFingerprintText(collectText(raw).join("\n"));
    if (text) return text;
  }
  return "";
}

function allRoleText(
  items: unknown[],
  roles: Set<string>,
  contentKey: "content" | "parts" = "content"
): string {
  if (!Array.isArray(items)) return "";
  return normalizeFingerprintText(
    items
      .filter(
        (item): item is Record<string, unknown> =>
          !!item &&
          typeof item === "object" &&
          roles.has(String((item as Record<string, unknown>)["role"] ?? ""))
      )
      .map((item) =>
        collectText(contentKey === "parts" ? item["parts"] : item["content"]).join("\n")
      )
      .filter(Boolean)
      .join("\n")
  );
}

function hashConversationSeed(seed: string): string | null {
  const normalized = normalizeFingerprintText(seed);
  if (!normalized) return null;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 24);
}

/**
 * Derive a stable cache-affinity key from explicit thread metadata when present,
 * otherwise from the immutable start of the prompt (system + first user turn).
 * Appended turns should not move an existing conversation to another model.
 */
export function getConversationCacheKey(body: Record<string, unknown>): string | null {
  if (!body || typeof body !== "object") return null;

  const meta = body["metadata"] as Record<string, unknown> | undefined;
  const explicitCandidates = [
    body["conversation_id"],
    body["conversationId"],
    body["thread_id"],
    body["threadId"],
    body["session_id"],
    body["sessionId"],
    meta?.["conversation_id"],
    meta?.["conversationId"],
    meta?.["thread_id"],
    meta?.["threadId"],
    meta?.["session_id"],
    meta?.["sessionId"],
  ];
  const explicit = explicitCandidates.find((v) => v != null && String(v).trim());
  if (explicit != null) return hashConversationSeed(`explicit:${String(explicit).trim()}`);

  const systemRoles = new Set(["system", "developer"]);
  const userRoles = new Set(["user"]);
  const contents =
    (body["contents"] as unknown[]) ??
    ((body["request"] as Record<string, unknown> | undefined)?.["contents"] as unknown[]);

  const seedParts = [
    collectText(body["system"]).join("\n"),
    collectText(body["instructions"]).join("\n"),
    allRoleText((body["messages"] as unknown[]) ?? [], systemRoles),
    allRoleText((body["input"] as unknown[]) ?? [], systemRoles),
    allRoleText(contents ?? [], systemRoles, "parts"),
    firstRoleText((body["messages"] as unknown[]) ?? [], userRoles),
    typeof body["input"] === "string"
      ? body["input"]
      : firstRoleText((body["input"] as unknown[]) ?? [], userRoles),
    firstRoleText(contents ?? [], userRoles, "parts"),
    body["query"],
    body["url"],
  ].filter(Boolean);

  return hashConversationSeed(seedParts.join("\n"));
}

// ── Affinity management (for round-robin integration) ────────────────────────

/** @internal exported for testing */
export function pruneConversationAffinity(now = Date.now()): void {
  for (const [key, value] of comboConversationAffinity) {
    if (!value || now - value.lastUsed > CONVERSATION_AFFINITY_TTL_MS) {
      comboConversationAffinity.delete(key);
    }
  }
  while (comboConversationAffinity.size > MAX_CONVERSATION_AFFINITY_ENTRIES) {
    const oldestKey = comboConversationAffinity.keys().next().value;
    if (oldestKey === undefined) break;
    comboConversationAffinity.delete(oldestKey);
  }
}

/**
 * Returns the pinned target index for a conversation, or null if none.
 * Creates and stores an affinity entry on first call for a new conversation.
 *
 * Used by getRotatedModels (round-robin) when stickyLimit > 1.
 */
export function getOrSetConversationAffinityIndex(
  rotationKey: string,
  conversationCacheKey: string,
  currentIndex: number
): number {
  const now = Date.now();
  pruneConversationAffinity(now);

  const affinityKey = `${rotationKey}:${conversationCacheKey}`;
  const existing = comboConversationAffinity.get(affinityKey);
  if (existing) {
    const pinnedIndex = existing.index;
    // Refresh TTL (move to end of Map iteration order)
    comboConversationAffinity.delete(affinityKey);
    comboConversationAffinity.set(affinityKey, { index: pinnedIndex, lastUsed: now });
    return pinnedIndex;
  }

  comboConversationAffinity.set(affinityKey, { index: currentIndex, lastUsed: now });
  return currentIndex;
}

/**
 * Clear affinity entries for a specific combo (or all if no name given).
 * Called by resetComboRotation.
 */
export function clearConversationAffinity(comboName?: string): void {
  if (comboName) {
    const prefix = `${comboName}:`;
    for (const key of comboConversationAffinity.keys()) {
      if (key.startsWith(prefix)) comboConversationAffinity.delete(key);
    }
  } else {
    comboConversationAffinity.clear();
  }
}
