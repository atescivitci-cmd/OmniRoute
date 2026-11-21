/**
 * Task-aware routing layer for combo routing.
 *
 * Derives request difficulty (light / standard / heavy / critical) from cheap,
 * local structural signals — no LLM call. Routes heavier tasks toward models with more
 * VERIFIED capability using a continuous, name-blind `modelPowerScore`. Also provides conversation-affinity
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
import {
  CONTEXT_OVERFLOW_LIMIT,
  deriveCapabilityDemand,
  demandedCapabilityStrength,
  NEUTRAL_DEMAND,
  type CapabilityDemand,
} from "./capabilityStrength.ts";
import type { ResolvedComboTarget } from "./combo/types.ts";

// ── Task level constants ──────────────────────────────────────────────────────

export const TASK_LEVEL_WEIGHT = {
  light: 1,
  standard: 2,
  heavy: 3,
  critical: 4,
} as const;

export type TaskLevel = keyof typeof TASK_LEVEL_WEIGHT;

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

// A narrow positive operation cue at the START of the ask. Shared by hasPositiveComplexOperation
// and the light-by-ask pre-check so both agree on what a complex-operation cue is.
const COMPLEX_OPERATION_CUE_RE =
  /^\s*(?:please\s+)?(?:analy[sz]e|debug|investigate|design|refactor|implement|migrate|compare|benchmark|architect)\b/i;

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
  return COMPLEX_OPERATION_CUE_RE.test(currentAsk);
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
  const base = classifyFromSignals(body, s);
  // ROUTING_LIGHT_BY_ASK (default off). Light only ever LOWERS a level: an already-light
  // result is returned untouched, and anything the pre-check does not clearly accept falls
  // through to the unchanged logic above.
  if (base.level === "light" || !isLightByAskEnabled()) return base;
  return classifyLightByAsk(body ?? {}, s, base) ?? base;
}

/** The original (pre-2026-11-16) classification, unchanged. Flag-off behaviour is this. */
function classifyFromSignals(body: Record<string, unknown>, s: TaskSignals): TaskClassification {
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

// ── Light by ask (ROUTING_LIGHT_BY_ASK, 2026-11-16) ───────────────────────────
//
// The legacy rules rate difficulty from the tool INVENTORY and total prompt size, so every
// terminal-Codex turn (100+ tools, big system prompt) is `critical` even for "ok". This
// pre-check rates the CURRENT ASK instead. It is flag-gated (default off), provider agnostic
// (no model names) and can only LOWER a level to `light`.
//
// Flag mechanism: open-sse selector code must stay pure and DB-free (classifyTask runs in
// plain unit tests), so the flag is read from process.env at call time, not from the
// feature_flags DB table. Turn it on/off by setting ROUTING_LIGHT_BY_ASK=1 / unset in the
// gateway process environment and restarting that process.
//
// Light requires ALL of:
//   - ask (last real user message) is 1..400 chars;
//   - ask has no heavy/critical keyword (regexes tested on the ASK ONLY, never on system
//     prompt or history), no complex-operation cue, and no ask-risk/mutating-verb cue;
//   - effort is not high/xhigh/max/maximum/hard/deep and no large thinking budget
//     (Codex's default "medium" is not a signal);
//   - <= 3 real user turns in the conversation;
//   - no assistant WRITE/EXECUTE tool call earlier in the conversation (see
//     classifyToolCallName for the rule table; unnamed or unrecognised calls count as
//     write/execute);
//   - conversation text (system prompt, instructions and tool inventory EXCLUDED) < 100k chars;
//   - output limit < 8192 and no invalid/conflicting controls.
// The tool inventory (`toolCount`) is deliberately NOT consulted: it stays a capability
// requirement elsewhere (eligibility), not a difficulty signal.

export const LIGHT_BY_ASK_FLAG = "ROUTING_LIGHT_BY_ASK";
export const LIGHT_BY_ASK_MAX_ASK_CHARS = 400;
export const LIGHT_BY_ASK_MAX_USER_TURNS = 3;
export const LIGHT_BY_ASK_MAX_CONVERSATION_CHARS = 100_000;
export const LIGHT_BY_ASK_MAX_OUTPUT_TOKENS = 8192;
const LIGHT_BY_ASK_MAX_THINKING_BUDGET = 8192;

export function isLightByAskEnabled(): boolean {
  const raw = String(process.env[LIGHT_BY_ASK_FLAG] ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// Injected, non-user scaffolding that clients put in user-role items/blocks. Fixed literals
// under a start anchor: ReDoS safe. A slash command (<command-name>/<command-args>) is NOT
// scaffolding: it is the user's real ask.
// A closed wrapper is stripped on its own and any text after it is kept as the ask.
const CLOSED_WRAPPER_RE = /^\s*<([a-z_-]+)>[\s\S]*?<\/\1>/i;
const INJECTED_SCAFFOLDING_RE =
  /^\s*(?:<environment_context>|<user_instructions>|<system-reminder>|<permissions instructions>|<user-prompt-submit-hook>|<turn_aborted>|<ide_context>|<local-command|<INSTRUCTIONS>|# AGENTS\.md instructions)/i;

// Extra ask-only guard so a short but consequential ask is never "light": credentials,
// production/deploy, money, destructive or mutating verbs. Fixed literals under \b: ReDoS safe.
// Deliberately broad; narrowing it later is a safe direction, widening light is not.
const LIGHT_BY_ASK_RISK_RE =
  /\b(?:credential|secret|password|passcode|token|api[- ]?key|production|prod|deploy|delete|drop|rotate|revoke|wipe|sudo|force|payment|wire|billing|invoice|refund|transfer|purchase|buy|install|uninstall|commit|push|merge|rebase|reset|rm|kill|restart|reboot|shutdown|send|create|write|edit|patch|apply|run|execute|fix|update|change|modify|rename|move|remove|add|email|text|call|schedule|book|order|post|tweet|cancel|approve|publish|ship|release|enable|disable|grant|share|clean|build|generate|convert|optimi[sz]e|improve|review|check|audit|script|truncate|chmod|curl|make|resolve|upgrade|restore|unlock|pay|charge|invite|archive|forward|reply|respond|submit|upload)\w*\b/i;

const WRITE_EXEC_SUBSTRING_RE =
  /(exec|shell|bash|run|write|edit|patch|apply|delete|remove|create|update|send|commit|push|deploy|script|command|terminal|python|install|sudo|kill|mkdir|chmod|rename|upload|download|import|modify|rotate|revoke|cancel|respond|accept|decline|schedule|invite|archive|trash|label|share|approve|pay|charge|book|order|publish|forward|reply|merge|close|transition|trigger|dispatch|invoke|ban|kick|disable|enable|unlock|provision|mark)/i;
const WRITE_EXEC_TOKENS = new Set([
  "node",
  "npm",
  "git",
  "mv",
  "cp",
  "rm",
  "add",
  "set",
  "put",
  "post",
  "save",
  "insert",
  "append",
  "submit",
  "click",
  "type",
  "press",
  "key",
  "move",
  "copy",
  "replace",
  "clear",
  "reset",
  "enable",
  "disable",
  "grant",
  "open",
  "launch",
  "start",
  "stop",
  "restart",
  "fix",
  "build",
  "test",
  "make",
  "cmd",
]);
const READ_ONLY_TOKENS = new Set([
  "read",
  "get",
  "list",
  "search",
  "find",
  "view",
  "cat",
  "ls",
  "fetch",
  "query",
  "grep",
  "glob",
  "stat",
  "lookup",
  "describe",
  "show",
  "pwd",
  "whoami",
]);

/**
 * Tool-call rule table. A call is read-only ONLY when its name has a read-only token and no
 * write/execute substring or token. Everything else, including unnamed/unrecognised calls
 * and shells (bash, exec_command, osascript), counts as write-or-execute.
 */
export function classifyToolCallName(name: unknown): "read" | "write-or-execute" {
  if (typeof name !== "string" || !name.trim()) return "write-or-execute";
  if (WRITE_EXEC_SUBSTRING_RE.test(name)) return "write-or-execute";
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.some((t) => WRITE_EXEC_TOKENS.has(t))) return "write-or-execute";
  return tokens.some((t) => READ_ONLY_TOKENS.has(t)) ? "read" : "write-or-execute";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Distinct conversation arrays across the supported wire dialects. */
function conversationArrays(body: Record<string, unknown>): unknown[][] {
  const out = new Set<unknown[]>();
  for (const candidate of [
    body.messages,
    body.input,
    body.contents,
    wireValue(body, "request.contents"),
  ]) {
    if (Array.isArray(candidate)) out.add(candidate);
  }
  return [...out];
}

interface UserTurn {
  /** Text with injected scaffolding removed. May be empty for a file/image-only message. */
  text: string;
  /** The message carries a non-text part (image, file, document, inline data, ...). */
  hasNonText: boolean;
}

/** Strip leading injected wrappers. A closed wrapper is removed and trailing text is kept. */
function stripInjectedScaffolding(piece: string): string {
  let current = piece;
  while (INJECTED_SCAFFOLDING_RE.test(current)) {
    const closed = CLOSED_WRAPPER_RE.exec(current);
    if (!closed) return ""; // unclosed or header-style scaffolding: drop the whole piece
    current = current.slice(closed[0].length);
  }
  return current;
}

/**
 * A real user turn, or null when the entry is not one: not user-role, only tool results, only
 * injected scaffolding, or empty. A user message with only non-text parts (image/file) IS a
 * turn with empty text, so it can never fall back to an earlier message as "the ask".
 */
function realUserTurn(entry: unknown): UserTurn | null {
  const rec = asRecord(entry);
  if (!rec || String(rec.role ?? "").toLowerCase() !== "user") return null;
  const raw = rec.content ?? rec.parts ?? rec.text;
  const pieces: string[] = [];
  let hasNonText = false;
  if (typeof raw === "string") pieces.push(raw);
  else if (Array.isArray(raw)) {
    for (const part of raw) {
      if (typeof part === "string") {
        pieces.push(part);
        continue;
      }
      const p = asRecord(part);
      if (!p) continue;
      const type = String(p.type ?? "");
      if (type === "tool_result" || type === "function_call_output" || p.functionResponse) continue;
      const text = typeof p.text === "string" ? p.text : p.input_text;
      if (typeof text === "string") pieces.push(text);
      else hasNonText = true;
    }
  }
  const text = pieces.map(stripInjectedScaffolding).join("\n").trim();
  if (!text && !hasNonText) return null;
  return { text, hasNonText };
}

function collectUserTurns(body: Record<string, unknown>): UserTurn[] {
  for (const messages of conversationArrays(body ?? {})) {
    const turns = messages.map(realUserTurn).filter((turn): turn is UserTurn => turn !== null);
    if (turns.length > 0) return turns;
  }
  const value = typeof body?.input === "string" ? body.input : (body?.prompt ?? body?.query);
  if (typeof value === "string" && value.trim()) {
    return [{ text: value.trim(), hasNonText: false }];
  }
  return [];
}

/**
 * The current ask (last real user message), the count of real user turns, and whether the
 * last turn carries a non-text part. A last message with only an image/file yields ask "".
 */
export function extractCurrentAsk(body: Record<string, unknown>): {
  ask: string;
  userTurns: number;
  askHasNonText: boolean;
} {
  const turns = collectUserTurns(body);
  const last = turns[turns.length - 1];
  return {
    ask: last?.text ?? "",
    userTurns: turns.length,
    askHasNonText: last?.hasNonText ?? false,
  };
}

/** Count assistant-side tool calls already in the conversation, by read-only vs write/execute. */
export function scanPriorToolCalls(body: Record<string, unknown>): {
  readOnly: number;
  writeOrExecute: number;
} {
  const tally = { readOnly: 0, writeOrExecute: 0 };
  const note = (kind: "read" | "write-or-execute") => {
    if (kind === "read") tally.readOnly += 1;
    else tally.writeOrExecute += 1;
  };
  for (const messages of conversationArrays(body ?? {})) {
    for (const entry of messages) {
      const rec = asRecord(entry);
      if (!rec) continue;
      // Responses API items.
      const type = String(rec.type ?? "");
      if (type === "web_search_call" || type === "file_search_call") note("read");
      else if (type === "function_call" || type === "custom_tool_call" || type === "mcp_call") {
        // Classify the whole identity: a read-looking `name` under a write namespace/server
        // (e.g. name "list", namespace "mcp__codex_apps__calendar_create_event") is a write.
        const identity = [rec.namespace, rec.server_label, rec.name]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("__");
        note(classifyToolCallName(identity));
      } else if (type.endsWith("_call")) {
        // local_shell_call, computer_call, code_interpreter_call, apply_patch_call, ...
        note("write-or-execute");
      }
      // Chat completions.
      if (Array.isArray(rec.tool_calls)) {
        for (const call of rec.tool_calls) {
          const c = asRecord(call);
          note(classifyToolCallName(asRecord(c?.function)?.name ?? c?.name));
        }
      }
      const legacyFn = asRecord(rec.function_call);
      if (legacyFn) note(classifyToolCallName(legacyFn.name));
      // Anthropic content blocks and Gemini parts.
      for (const blocks of [rec.content, rec.parts]) {
        if (!Array.isArray(blocks)) continue;
        for (const block of blocks) {
          const b = asRecord(block);
          if (!b) continue;
          const bt = String(b.type ?? "");
          if (bt === "tool_use" || bt === "server_tool_use" || bt === "mcp_tool_use") {
            note(classifyToolCallName(b.name));
          }
          const fc = asRecord(b.functionCall);
          if (fc) note(classifyToolCallName(fc.name));
          if (b.executableCode) note("write-or-execute");
        }
      }
    }
  }
  return tally;
}

const CONFIRMATION_ASK_RE =
  /^\s*(?:ok(?:ay)?|yes|yep|yeah|sure|y|go ahead|do it|go for it|proceed|continue|sounds good|looks good|lgtm|please do|go on|next|try again|retry|now do the rest)\b/i;

const COMPACTED_HISTORY_PREFIX = "Another language model started to solve this problem";

/** A compaction item, or a handoff summary as the first user text: earlier turns are not visible. */
export function hasCompactedHistory(body: Record<string, unknown>): boolean {
  for (const messages of conversationArrays(body)) {
    for (const entry of messages) {
      if (asRecord(entry)?.type === "compaction") return true;
    }
  }
  const first = collectUserTurns(body)[0];
  return first !== undefined && first.text.trimStart().startsWith(COMPACTED_HISTORY_PREFIX);
}

/** Characters of real conversation: system prompt, instructions and the tool inventory excluded. */
function conversationChars(body: Record<string, unknown>): number {
  let total = 0;
  try {
    for (const messages of conversationArrays(body)) total += JSON.stringify(messages).length;
  } catch {
    return Number.POSITIVE_INFINITY; // unmeasurable: never light
  }
  for (const value of [body.input, body.prompt, body.query]) {
    if (typeof value === "string") total += value.length;
  }
  return total;
}

/**
 * Returns a `light` classification when the current ask is clearly simple, else null (the
 * caller then keeps `base`). `base` is only used to log the level that was lowered.
 */
function classifyLightByAsk(
  body: Record<string, unknown>,
  s: TaskSignals,
  base: TaskClassification
): TaskClassification | null {
  // History that this request does not carry (server-side state) or that was compacted away
  // cannot be inspected, so the "few turns / no prior write" guards would be vacuous. Same
  // trio as routingAttemptSafety.ts hardBound.
  if (body.previous_response_id || body.conversation || body.container) return null;
  if (hasCompactedHistory(body)) return null;

  const { ask, userTurns, askHasNonText } = extractCurrentAsk(body);
  if (ask.length === 0 || ask.length > LIGHT_BY_ASK_MAX_ASK_CHARS) return null;
  // An image/file in the last message carries the question; the text alone is not the ask.
  if (askHasNonText) return null;
  if (userTurns > LIGHT_BY_ASK_MAX_USER_TURNS) return null;
  // The keyword lexicon above is English only, so a non-English ask cannot be judged "simple".
  // (ASCII non-English text such as Spanish is a known, documented limit.) \u0080-\uFFFF is the
  // non-ASCII range, written this way to avoid a control-character regex.
  if (/[\u0080-\uFFFF]/.test(ask)) return null;
  // A bare confirmation after earlier turns continues whatever was proposed or running; the
  // ask alone says nothing about its difficulty. A fresh single-turn "ok" is still light.
  if (userTurns > 1 && CONFIRMATION_ASK_RE.test(ask)) return null;

  const normalized = s.resourceNormalization;
  const preferences = s.executionPreferences;
  if (!normalized || !preferences) return null;
  const controlsUnambiguous =
    normalized.invalidOutputFields.length === 0 &&
    normalized.outputLimitStatus !== "conflict" &&
    !normalized.messageDialectConflict &&
    preferences.effortStatus !== "conflict" &&
    preferences.invalidFields.length === 0;
  if (!controlsUnambiguous) return null;
  if (s.outputTokens >= LIGHT_BY_ASK_MAX_OUTPUT_TOKENS) return null;
  if (/^(high|xhigh|max|maximum|hard|deep)$/.test(s.effort)) return null;
  if ((preferences.thinkingBudgetTokens ?? 0) >= LIGHT_BY_ASK_MAX_THINKING_BUDGET) return null;

  // Keywords on the ASK ONLY (the legacy flags look at system prompt + history too).
  if (HEAVY_TASK_RE.test(ask) || CRITICAL_TASK_RE.test(ask)) return null;
  if (COMPLEX_OPERATION_CUE_RE.test(ask) || hasPositiveComplexOperation(body)) return null;
  if (LIGHT_BY_ASK_RISK_RE.test(ask)) return null;

  const calls = scanPriorToolCalls(body);
  if (calls.writeOrExecute > 0) return null;
  if (conversationChars(body) >= LIGHT_BY_ASK_MAX_CONVERSATION_CHARS) return null;

  return {
    level: "light",
    weight: taskWeight("light"),
    ...s,
    reasons: [
      "light-by-ask",
      `ask-chars:${ask.length}`,
      `user-turns:${userTurns}`,
      `prior-readonly-tool-calls:${calls.readOnly}`,
      `tool-inventory:${s.toolCount}`,
      `was:${base.level}`,
    ],
  };
}

// ── Model power scoring ───────────────────────────────────────────────────────

/**
 * Verified capability power on a 0-150 scale (150 x demand-relative strength).
 *
 * Built ONLY from resolved capabilities (reasoning, tool calling, context window, output
 * limit) measured against a demand (`NEUTRAL_DEMAND` when none is given); it never reads a
 * provider or model name, so two models with the same resolved capabilities get the same power,
 * whoever made them. A capability the registry could not verify adds nothing (it is not guessed
 * from the name and not penalised). Monotone: more verified capability never lowers the value,
 * and capability beyond the demand adds nothing.
 *
 * Before 2026-11-20 this also added +28 / -24 / +8 from brand and size words in the model id
 * (opus, gpt-5, pro, haiku, mini, ...). That made the critical tier reachable only by models
 * whose NAME matched, so one vendor won by design. See docs/routing/AUTO-COMBO.md.
 */
export function modelPowerScore(
  modelStr: string,
  demand: CapabilityDemand = NEUTRAL_DEMAND
): number {
  return Math.round(
    demandedCapabilityStrength(getResolvedModelCapabilities(modelStr), demand) * 150
  );
}

/**
 * What this request needs from a model, from the request's own signals only: estimated prompt
 * tokens, the requested output limit (a documented default when it sends none), whether reasoning
 * is required or explicitly requested on the wire, and whether it carries tools. `required` is
 * the capability set the scorer already receives (`tools` is spelled `search` by fit-first).
 * Shared by `scoreModelForTask` and the fit-first task-fitness term, so both describe the same
 * demand.
 */
export function capabilityDemandForTask(
  task: Pick<TaskClassification, "promptChars" | "outputTokens"> &
    Partial<Pick<TaskClassification, "hasExplicitReasoning">>,
  required: Set<string> = new Set()
): CapabilityDemand {
  return deriveCapabilityDemand({
    promptChars: task.promptChars,
    outputTokens: task.outputTokens,
    reasoning: required.has("reasoning") || task.hasExplicitReasoning === true,
    tools: required.has("tools") || required.has("search"),
  });
}

/** Largest penalty for a requested output far above the model's own output cap. */
const OUTPUT_SHORTFALL_MAX_PENALTY = 80;

// Hard capabilities: missing one drops request data (images, PDFs). Maps TS
// ResolvedModelCapabilities fields that correspond to hard-cap modalities.
const HARD_CAP_CHECKS = new Set(["vision"]);

/**
 * Score a single model for a given task + capability requirements.
 * Higher score = better fit. Negative score = capability hard-miss.
 *
 * Fit is DEMAND-RELATIVE sufficiency: `100 x demandedCapabilityStrength(caps, demand)`, where the
 * demand is what this request needs (`capabilityDemandForTask`). Every model whose verified
 * capabilities cover the demand gets the same fit whatever larger spec it has, a shortfall lowers
 * it continuously and in proportion, and a capability the request does not demand earns nothing
 * and costs nothing. A bigger model is never ranked below a smaller one (monotone) and there is
 * no "too powerful" or "below the threshold" cliff. Models that cover the request therefore tie
 * on this factor and are decided by evidence (reliability, latency, health, quota). The
 * deductions are GENUINE unmet requirements: context window cannot hold the prompt, output limit
 * below the requested output, and a required vision / reasoning / tool capability that is not
 * verified.
 */
export function scoreModelForTask(
  modelStr: string,
  task: TaskClassification = classifyTask({}),
  required: Set<string> = new Set()
): number {
  const caps = getResolvedModelCapabilities(modelStr);
  const demand = capabilityDemandForTask(task, required);
  let score = 100 * demandedCapabilityStrength(caps, demand);

  // Hard capability misses: drop score heavily so the model sorts to the back
  // but stays in the list (fallback still tries every model).
  for (const cap of required) {
    if (!HARD_CAP_CHECKS.has(cap)) continue;
    if (cap === "vision" && caps.supportsVision !== true) score -= 10000;
  }

  // A required capability that is not verified is an unmet requirement. The task level alone
  // is not a requirement (it used to subtract 120 here for any heavy+ task on a model not
  // known to reason).
  // A required reasoning capability that is not verified takes the -120 gate. Reasoning the
  // request does not demand neither rewards nor penalises: until 2026-11-20 a flat 10/15-point
  // soft penalty on heavy/critical asks scored an undemanded capability, which is removed. A
  // demanded reasoning dimension is scored in `demandedCapabilityStrength` as well.
  if (required.has("reasoning") && caps.supportsThinking !== true) score -= 120;
  if (required.has("search") && !caps.toolCalling) score -= 30;

  const ctxLimit = caps.contextWindow ?? 0;
  if (ctxLimit > 0 && demand.promptTokens > ctxLimit * CONTEXT_OVERFLOW_LIMIT) score -= 200;

  // A requested output above the model's own cap is a shortfall, penalised in proportion to its
  // size (0 at or above the cap, growing linearly to -80 as the cap approaches 0), so there is no
  // step at the cap. It adds to the proportional output credit already lost in the strength.
  const maxOut = caps.maxOutputTokens ?? 0;
  if (maxOut > 0 && Number.isFinite(task.outputTokens) && task.outputTokens > maxOut) {
    score -= OUTPUT_SHORTFALL_MAX_PENALTY * ((task.outputTokens - maxOut) / task.outputTokens);
  }

  return score;
}

/**
 * Neutral tie-break for targets with equal fit: a hash of a conversation-stable key and the
 * target's provider, model and connection. Never list order, alphabetical order or a vendor.
 */
function targetTieHash(target: ResolvedComboTarget, tieKey: string): string {
  return createHash("sha256")
    .update(
      `${tieKey}\0${target.provider ?? ""}\0${target.modelStr ?? ""}\0${target.connectionId ?? ""}`
    )
    .digest("hex");
}

export interface ReorderByTaskWeightOptions {
  /** Conversation-stable key for the tie hash (`getConversationCacheKey`). Fixed key when absent. */
  tieKey?: string | null;
  /**
   * Keep the input order between targets of equal score instead of hashing. Use it only when the
   * input order is itself meaningful ranking evidence (the `auto` strategy hands over targets
   * already ordered by its own scorer, whose tie-break is neutral), never when it is just the
   * order the operator listed the models in.
   */
  preserveInputOrder?: boolean;
}

/**
 * Reorder ResolvedComboTarget[] so the best-fit model for the task comes first.
 * Targets with an equal score are ordered by a neutral, conversation-stable hash (pass the
 * request's `getConversationCacheKey` as `tieKey`; without one a fixed key is used), so the
 * listed order never decides between equal targets and one conversation keeps its order from
 * turn to turn. Targets identical in provider, model and connection keep their listed order.
 * Identity-returns when no reordering is needed (avoids allocations on the common path).
 * Never removes targets.
 */
export function reorderByTaskWeight(
  targets: ResolvedComboTarget[],
  task: TaskClassification = classifyTask({}),
  required: Set<string> = new Set(),
  options: ReorderByTaskWeightOptions = {}
): ResolvedComboTarget[] {
  if (!Array.isArray(targets) || targets.length <= 1) return targets;

  const key = options.tieKey ?? "";
  const preserve = options.preserveInputOrder === true;
  const reordered = targets
    .map((t, i) => ({
      t,
      i,
      score: scoreModelForTask(t.modelStr, task, required),
      tie: preserve ? "" : targetTieHash(t, key),
    }))
    .sort((a, b) => b.score - a.score || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0) || a.i - b.i)
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

// ── Conversation tie key (neutral tie-break seed) ─────────────────────────────

function fullDigest(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

/** First text of the first matching-role entry, FULL length (never truncated). */
function fullFirstRoleText(
  items: unknown,
  roles: Set<string>,
  contentKey: "content" | "parts" = "content"
): string {
  if (!Array.isArray(items)) return "";
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (!roles.has(String(rec["role"] ?? ""))) continue;
    const text = collectText(rec[contentKey]).join("\n").trim();
    if (text) return text;
  }
  return "";
}

function fullAllRoleText(
  items: unknown,
  roles: Set<string>,
  contentKey: "content" | "parts" = "content"
): string {
  if (!Array.isArray(items)) return "";
  return items
    .filter(
      (item): item is Record<string, unknown> =>
        !!item &&
        typeof item === "object" &&
        roles.has(String((item as Record<string, unknown>)["role"] ?? ""))
    )
    .map((item) => collectText(item[contentKey]).join("\n"))
    .filter(Boolean)
    .join("\n");
}

// The older Claude Code form ends with `_session_<uuid>`; nothing looser counts as a session.
const SESSION_IN_USER_ID_RE =
  /_session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Session id carried by metadata.user_id: either a JSON object with `session_id`/`sessionId`
 * (the form Claude Code sends and that claudeCodeCompatible.ts emits) or the older
 * `user_<hash>_account_<uuid>_session_<uuid>` string (uuid-shaped, anchored at the end). A user_id without a session part is a
 * user (or device) identifier, not a conversation, and yields null.
 */
function sessionFromUserId(userId: string): string | null {
  const text = userId.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const id = parsed.session_id ?? parsed.sessionId;
      return typeof id === "string" && id.trim() ? id.trim().toLowerCase() : null;
    } catch {
      /* fall through to the pattern */
    }
  }
  const match = SESSION_IN_USER_ID_RE.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Conversation-stable, neutral seed for tie-breaks between candidates that are exactly equal on
 * every score. The same conversation yields the same key on every turn, and different
 * conversations yield different keys, whatever the length of the shared system prompt.
 *
 * Order of preference (first present wins):
 *  1. an external, client-chosen session id (`ext:` ids from X-Session-Id style headers,
 *     passed as `options.sessionId`);
 *  2. a session id embedded in `metadata.user_id` (Claude Code sends
 *     `user_<hash>_account_<uuid>_session_<uuid>` on /v1/messages);
 *  3. explicit ids in the body: conversation_id, thread_id, session_id, metadata.* variants,
 *     prompt_cache_key (Codex);
 *  4. the server-derived session fingerprint (`options.sessionId` without the `ext:` prefix);
 *  5. digests of the system prompt and of the FIRST user message, each over its full text, then
 *     combined (a long, shared system prompt can no longer swallow the per-session part);
 *  6. null, so the caller falls back to the ask.
 *
 * Nothing here reads a model, provider or list order. Never truncates a joined string.
 * Known limit: a client-chosen id steers only ties between candidates that are already exactly
 * equal on capability, evidence, quota and health; every admission gate still applies.
 */
export function getConversationTieKey(
  body: Record<string, unknown>,
  options: { sessionId?: string | null } = {}
): string | null {
  const tag = (kind: string, value: string) =>
    `${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
  const sessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
  if (sessionId.startsWith("ext:")) return tag("ext", sessionId);
  if (!body || typeof body !== "object") return sessionId ? tag("sid", sessionId) : null;

  const meta = (body["metadata"] ?? {}) as Record<string, unknown>;
  const userId = typeof meta["user_id"] === "string" ? (meta["user_id"] as string) : "";
  const embedded = sessionFromUserId(userId);
  if (embedded) return tag("uid", embedded);

  for (const value of [
    body["conversation_id"],
    body["conversationId"],
    body["thread_id"],
    body["threadId"],
    body["session_id"],
    body["sessionId"],
    meta["conversation_id"],
    meta["conversationId"],
    meta["thread_id"],
    meta["threadId"],
    meta["session_id"],
    meta["sessionId"],
    body["prompt_cache_key"],
  ]) {
    if (value != null && String(value).trim()) return tag("explicit", String(value).trim());
  }
  if (sessionId) return tag("sid", sessionId);

  const systemRoles = new Set(["system", "developer"]);
  const userRoles = new Set(["user"]);
  const contents =
    body["contents"] ?? (body["request"] as Record<string, unknown> | undefined)?.["contents"];
  const system = [
    collectText(body["system"]).join("\n"),
    collectText(body["instructions"]).join("\n"),
    fullAllRoleText(body["messages"], systemRoles),
    fullAllRoleText(body["input"], systemRoles),
    fullAllRoleText(contents, systemRoles, "parts"),
  ]
    .filter(Boolean)
    .join("\n");
  const firstUser = [
    fullFirstRoleText(body["messages"], userRoles),
    typeof body["input"] === "string"
      ? (body["input"] as string)
      : fullFirstRoleText(body["input"], userRoles),
    fullFirstRoleText(contents, userRoles, "parts"),
    typeof body["query"] === "string" ? (body["query"] as string) : "",
    typeof body["url"] === "string" ? (body["url"] as string) : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (!system && !firstUser) return null;
  return tag(
    "conv",
    `${system ? fullDigest(system) : ""}\0${firstUser ? fullDigest(firstUser) : ""}`
  );
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
