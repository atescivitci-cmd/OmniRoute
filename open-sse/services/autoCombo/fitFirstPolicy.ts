import { operationalReliability } from "./rankingEvidence.ts";
import { TASK_LEVELS, type TaskProfileResolution, type TaskProfile } from "./taskProfile.ts";
import { providerSupportsEmulatedToolCalling } from "../combo/comboStructure.ts";
import {
  healthEvidenceHasRecentSamples,
  healthEvidenceSupportsHardVeto,
  type CandidateProvenance,
} from "./candidateProvenance.ts";
import { classifyToolContinuation } from "./toolContinuation.ts";
import { createHash } from "node:crypto";
import { localFallbackTier } from "./localFallbackPolicy.ts";
import { noThinkingIntent, noThinkingHandling } from "../reasoningEffortCompatibility.ts";

import type { ComboLike } from "../combo/types.ts";
import { getResolvedModelCapabilities } from "../modelCapabilities.ts";
import { classifyTask, scoreModelForTask, TASK_LEVEL_WEIGHT } from "../taskAwareRouting.ts";
import { getTaskFitnessWithSource } from "./taskFitness.ts";
import type { ProviderCandidate } from "./scoring.ts";
import { quotaRankingFactor } from "./scoring.ts";

export const FIT_FIRST_FREE_POLICY = "fit-first-free" as const;

export type FitFirstTaskType =
  | "coding"
  | "debugging"
  | "review"
  | "planning"
  | "analysis"
  | "documentation"
  | "math"
  | "creative"
  | "general";

export interface FitFirstCandidate extends ProviderCandidate {
  provenance?: CandidateProvenance;
  modelStr?: string;
  executionKey?: string;
  stepId?: string;
  quotaCutoffBlocked?: boolean;
  statusPenalty?: boolean;
  /** Only bounded successful-request timings can earn measured speed credit. */
  latencySampleSource?: "successful_usage_24h" | "unqualified";
  successfulLatencySampleCount?: number;
}

export interface FitFirstFactors {
  deadlineResponsiveness?: {
    source: "verified_native_deadline_observations";
    deadlineMs: number;
    late: number;
    timely: number;
    censored: number;
    demoted: boolean;
  };
  responsiveness?: {
    source: "call_logs_provider_responsiveness";
    deadlineMisses: number;
    timelyResponses: number;
    baseFitScore: number;
    adjustment: number;
  };
  taskFitness: number;
  taskFitnessSource: string;
  complexityFit: number;
  health: number;
  quota: number;
  reliability: number;
  reliabilityConfidence: number;
  reliabilitySampleCount: number;
  reliabilitySource: string;
  answerQuality: null;
  answerQualitySource: "unavailable";
  latencyEvidence: "observed" | "neutral_prior";
  latencyFit: number;
  score: number;
}

export interface RankedFitFirstCandidate {
  candidate: FitFirstCandidate;
  factors: FitFirstFactors;
  tieBreaker: string;
}

export interface FitFirstExclusion {
  provider: string;
  model: string;
  reason: string;
  provenance?: CandidateProvenance;
}

export interface FitFirstDecision {
  taskIntent: Omit<FitFirstIntent, "profile">;
  taskType: FitFirstTaskType;
  taskSource: "ask" | "project" | "fallback" | "interpreter";
  taskProfileSource: "interpreter" | "deterministic";
  taskProfileFallbackReason: TaskProfileResolution["fallbackReason"];
  taskProfileConfidence: number;
  taskLevel: ReturnType<typeof classifyTask>["level"];
  taskReasons: string[];
  requiredCapabilities: string[];
  ranked: RankedFitFirstCandidate[];
  excluded: FitFirstExclusion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function autoConfigSource(combo: ComboLike): Record<string, unknown> {
  if (isRecord(combo.autoConfig)) return combo.autoConfig;
  if (isRecord(combo.config?.auto)) return combo.config.auto;
  return isRecord(combo.config) ? combo.config : {};
}

export function resolveFitFirstFreeConfig(combo: ComboLike): {
  enabled: boolean;
  zeroAdditionalCostProviders: string[];
  localFallbackPolicy: "last" | null;
} {
  const source = autoConfigSource(combo);
  const enabled = source.selectionPolicy === FIT_FIRST_FREE_POLICY;
  const zeroAdditionalCostProviders = stringArray(source.zeroAdditionalCostProviders).map(
    (provider) => provider.toLowerCase()
  );
  return {
    enabled,
    zeroAdditionalCostProviders,
    localFallbackPolicy: source.localFallbackPolicy === "last" ? "last" : null,
  };
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (!isRecord(entry)) return "";
      if (typeof entry.text === "string") return entry.text;
      if (typeof entry.input_text === "string") return entry.input_text;
      if (typeof entry.content === "string") return entry.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function roleText(messages: unknown, roles: Set<string>, lastOnly = false): string {
  if (!Array.isArray(messages)) return "";
  const matches = messages
    .filter((entry): entry is Record<string, unknown> => {
      return isRecord(entry) && roles.has(String(entry.role ?? "").toLowerCase());
    })
    .map((entry) => textFromContent(entry.content ?? entry.parts ?? entry.text))
    .filter(Boolean);
  return lastOnly ? (matches.at(-1) ?? "") : matches.join("\n");
}

function selectorInputs(body: Record<string, unknown>): {
  ask: string;
  project: string;
  recentUserAsks: string[];
} {
  const nested = isRecord(body.request) ? body.request.contents : undefined;
  const messages = body.messages ?? body.input ?? body.contents ?? nested;
  const userTexts = Array.isArray(messages)
    ? messages
        .filter(
          (entry): entry is Record<string, unknown> =>
            isRecord(entry) && String(entry.role ?? "").toLowerCase() === "user"
        )
        .map((entry) => textFromContent(entry.content ?? entry.parts ?? entry.text))
        .filter(Boolean)
    : [];
  const ask =
    userTexts.at(-1) ||
    (typeof body.input === "string" ? body.input : "") ||
    (typeof body.prompt === "string" ? body.prompt : "") ||
    (typeof body.query === "string" ? body.query : "");
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const project = [
    textFromContent(body.system),
    textFromContent(body.instructions),
    roleText(messages, new Set(["system", "developer"])),
    metadata.project,
    metadata.projectName,
    metadata.repository,
    metadata.repo,
    metadata.cwd,
    body.project,
    body.repository,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return { ask, project, recentUserAsks: userTexts.slice(-9, -1) };
}

/** Advisory operation parsing only: never rewrite input or establish admission. */
export type FitFirstOperation =
  | "unknown"
  | "debug"
  | "review"
  | "plan"
  | "document"
  | "implement"
  | "calculate"
  | "compose"
  | "analyze"
  | "translate"
  | "edit_text"
  | "summarize"
  | "constrained_output"
  | "greeting"
  | "explain";
export interface FitFirstIntent {
  taskType: FitFirstTaskType;
  source: "ask" | "project" | "fallback";
  contextOrigin: "current_ask" | "recent_user_history" | "project_context" | "unknown";
  primaryOperation: FitFirstOperation;
  secondaryOperations: FitFirstOperation[];
  language: "en" | "es" | "tr" | "mixed" | "unknown";
  uncertainty:
    | "none"
    | "no_explicit_operation"
    | "competing_operations"
    | "context_inherited"
    | "bounded_input";
  outputContract: "json" | "csv" | "code" | "brief" | "verbatim" | null;
  evidenceRequirements: Array<"citations" | "calculation" | "code_examples">;
  // Standard is an advisory placeholder, never a replacement for structural admission.
  // Confidence expresses rule specificity, not a calibrated answer-quality probability.
  profile: TaskProfile;
}

type OperationMatch = {
  taskType: FitFirstTaskType;
  operation: FitFirstOperation;
  language: "en" | "es" | "tr";
  start: number;
  end: number;
  specificity: number;
};
type OperationRule = Omit<OperationMatch, "start" | "end"> & { pattern: RegExp };

/** Bound classifier work without truncating the inference request. Offsets stay stable. */
function operationText(text: string): string {
  const source = text
    .slice(0, 12000)
    .replace(/<(system-reminder|untrusted_text|example|data)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (match) =>
      " ".repeat(match.length)
    );
  const blank = (start: number, end: number) => {
    // Work in UTF-16 indices to agree with RegExp.index and String offsets.
    for (let index = start; index < end; index++) chars[index] = " ";
  };
  const chars = source.split("");
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const fenced = source.startsWith("```", i);
    const quote =
      c === '"' ||
      c === "`" ||
      c === "“" ||
      c === "‘" ||
      (c === "'" && !/[\p{L}\p{N}]/u.test(source[i - 1] ?? ""));
    if (fenced || quote) {
      const closing = fenced ? "```" : c === "“" ? "”" : c === "‘" ? "’" : c;
      let end = i + (fenced ? 3 : 1);
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source.startsWith(closing, end)) {
          end += closing.length;
          break;
        }
        end++;
      }
      blank(i, Math.min(end, source.length));
      i = end - 1;
    } else if (c === "{" || c === "[") {
      const stack = [c === "{" ? "}" : "]"];
      let end = i + 1;
      for (; end < source.length && stack.length; end++) {
        const next = source[end];
        if (next === '"' || next === "'") {
          const q = next;
          for (end++; end < source.length; end++) {
            if (source[end] === "\\") {
              end++;
              continue;
            }
            if (source[end] === q) break;
          }
        } else if (next === "{" || next === "[") stack.push(next === "{" ? "}" : "]");
        else if (next === stack.at(-1)) stack.pop();
      }
      // Unbalanced data is ambiguous too; it cannot supply a trusted operation.
      blank(i, Math.min(end, source.length));
      i = end - 1;
    }
  }
  return chars
    .join("")
    .replace(
      /\b(?:rather\s+than|instead\s+of|without)\b[^,.!?;\n]*(?:,|(?=\b(?:but|instead)\b|[.!?;\n]|$))/gi,
      (match) => " ".repeat(match.length)
    )
    .replace(
      /\b(?:do\s+not|don['’]t|never|avoid|without|no\s+need\s+to|not(?!\s+only\b))\b[^.!?;\n]*?(?=\b(?:but|instead|however)\b|[.!?;\n]|$)/gi,
      (match) => " ".repeat(match.length)
    )
    .replace(
      /\b(?:no|nunca|sin)\s+(?:debug(?:ging)?|review|fix|depur\w*|revis\w*|arregl\w*|escrib\w*|program\w*)\b[^.!?;\n]*?(?=\b(?:pero|sino)\b|[.!?;\n]|$)/giu,
      (match) => " ".repeat(match.length)
    )
    .replace(/[^.!?;\n]*\b(?:yapma|yazma|inceleme)\b[^.!?;\n]*/giu, (match) =>
      " ".repeat(match.length)
    );
}

const OPERATION_RULES: OperationRule[] = [];
function operationRule(
  taskType: FitFirstTaskType,
  operation: FitFirstOperation,
  language: OperationMatch["language"],
  pattern: RegExp,
  specificity = 1
) {
  OPERATION_RULES.push({ taskType, operation, language, pattern, specificity });
}
operationRule(
  "debugging",
  "debug",
  "en",
  /\b(?:debug(?:ging)?|troubleshoot(?:ing)?|find\s+(?:the\s+)?root\s+cause)\b/giu
);
operationRule(
  "debugging",
  "debug",
  "en",
  /\b(?:fix|repair|resolve)\b(?=[^.!?;\n]{0,100}\b(?:bug|error|exception|regression|function|test|crash|incident|failure)\b)/giu
);
operationRule("review", "review", "en", /\b(?:review|audit|inspect|assess|critique|verify)\b/giu);
operationRule(
  "review",
  "review",
  "en",
  /\b(?:write|provide|give|perform|do|conduct)\s+(?:(?:a|an|the|brief|detailed|code)\s+){0,5}(?:review|audit|assessment)\b/giu,
  3
);
operationRule("general", "explain", "en", /\b(?:explain|describe|define)\b/giu, 2);
operationRule("planning", "plan", "en", /\b(?:plan|planning|architect|design|strategize)\b/giu);
operationRule(
  "documentation",
  "document",
  "en",
  /\b(?:document|write\s+(?:(?:a|an|the|brief|new)\s+){0,4}(?:readme|docs|documentation|manual|changelog|release\s+notes))\b/giu,
  2
);
operationRule("coding", "implement", "en", /\b(?:implement|refactor|program)\b/giu);
operationRule(
  "coding",
  "implement",
  "en",
  /\b(?:write|create|produce|generate)\s+(?:(?:a|an|the|simple|new|short|small|python|typescript|javascript|sql|rust|java|go)\s+){0,6}(?:function|code|script|class|algorithm|query|tests?|test\s+suite)\b/giu,
  2
);
operationRule(
  "math",
  "calculate",
  "en",
  /\b(?:calculate|compute|solve|derive|prove|integrate|differentiate)\b/giu
);
operationRule(
  "creative",
  "compose",
  "en",
  /\b(?:write|compose|create|generate|design)\s+(?:(?:a|an|the|short|new|brief|humorous|four-line|little)\s+){0,6}(?:poem|story|slogan|screenplay|logo|song|copywriting)\b/giu,
  3
);
operationRule("creative", "compose", "en", /\bbrainstorm\b/giu);
operationRule(
  "analysis",
  "analyze",
  "en",
  /\b(?:analy[sz]e|compare|investigate|research|reason|evaluate|diagnose|synthesize)\b/giu
);
operationRule("general", "translate", "en", /\btranslate\b/giu, 2);
operationRule(
  "general",
  "edit_text",
  "en",
  /\b(?:(?:fix|correct)\s+(?:the\s+)?(?:grammar|spelling)|rewrite)\b/giu,
  3
);
operationRule("general", "summarize", "en", /\bsummari[sz]e\b/giu, 2);
operationRule(
  "general",
  "constrained_output",
  "en",
  /\b(?:return|output|reply|respond|format)\b/giu
);
operationRule("general", "greeting", "en", /^\s*(?:hi|hello|thanks|thank\s+you)[.!\s]*$/giu, 2);
operationRule("math", "calculate", "es", /\b(?:calcula|calcular|resuelve|demuestra)\b/giu, 2);
operationRule(
  "coding",
  "implement",
  "es",
  /\b(?:escribe|crea|implementa|refactoriza)\s+(?:(?:una?|la|el|de|python|simple)\s+){0,6}(?:funci[oó]n|c[oó]digo|programa|algoritmo)\b/giu,
  3
);
operationRule(
  "creative",
  "compose",
  "es",
  /\b(?:escribe|crea|redacta|diseña|disena)\s+(?:(?:una?|la|el|breve|corta?)\s+){0,5}(?:poema|historia|cuento|eslogan)\b/giu,
  3
);
operationRule("documentation", "document", "es", /\bdocumenta\b/giu, 2);
operationRule("review", "review", "es", /\b(?:revisa|audita)\b/giu, 2);
operationRule("planning", "plan", "es", /\b(?:planifica|diseña|disena)\b/giu);
operationRule("analysis", "analyze", "es", /\b(?:analiza|compara|investiga|evalúa|evalua)\b/giu, 2);
operationRule("general", "translate", "es", /\btraduce\b/giu, 2);
operationRule("general", "constrained_output", "es", /\b(?:devuelve|responde)\b/giu);
operationRule(
  "math",
  "calculate",
  "tr",
  /(?<![\p{L}\p{N}_])(?:hesapla|çöz|coz|kanıtla|kanitla)(?![\p{L}\p{N}_])/giu,
  2
);
operationRule(
  "creative",
  "compose",
  "tr",
  /(?<![\p{L}\p{N}_])(?:şiir|siir|hikaye|hikâye|slogan)(?:\s+[\p{L}-]+){0,3}\s+(?:yaz|oluştur|olustur|tasarla)(?![\p{L}\p{N}_])/giu,
  3
);
operationRule(
  "coding",
  "implement",
  "tr",
  /(?<![\p{L}\p{N}_])(?:fonksiyon\w*|kod|program)(?:\s+[\p{L}-]+){0,3}\s+(?:yaz|oluştur|olustur)(?![\p{L}\p{N}_])/giu,
  3
);
operationRule(
  "documentation",
  "document",
  "tr",
  /(?<![\p{L}\p{N}_])belgele(?![\p{L}\p{N}_])/giu,
  2
);
operationRule(
  "review",
  "review",
  "tr",
  /(?<![\p{L}\p{N}_])(?:incele|gözden\s+geçir)(?![\p{L}\p{N}_])/giu,
  2
);
operationRule("planning", "plan", "tr", /(?<![\p{L}\p{N}_])(?:planla|tasarla)(?![\p{L}\p{N}_])/giu);
operationRule(
  "analysis",
  "analyze",
  "tr",
  /(?<![\p{L}\p{N}_])(?:analiz\s+et|karşılaştır)(?![\p{L}\p{N}_])/giu,
  2
);
operationRule("general", "translate", "tr", /(?<![\p{L}\p{N}_])çevir(?![\p{L}\p{N}_])/giu, 2);
operationRule(
  "general",
  "constrained_output",
  "tr",
  /(?<![\p{L}\p{N}_])(?:yanıtla|cevapla)(?![\p{L}\p{N}_])/giu
);

/** Distinguish a directed operation from an operation merely named as background. */
function directedEnglishOperation(
  text: string,
  start: number,
  end: number,
  activityContext: boolean
): boolean {
  const before = text.slice(Math.max(0, start - 160), start);
  let boundary = 0;
  for (const match of before.matchAll(/[.!?;:,\n]|\b(?:then|but)\b/giu)) {
    boundary = match.index! + match[0].length;
  }
  const prefix = before.slice(boundary).trim();
  const suffix = text.slice(end, end + 64);
  // "Review completed" is a status, whereas "Review the completed plan" is a directive.
  if (
    /^\s+(?:(?:is|was|has\s+been|had\s+been)\s+)?(?:completed?|done|finished|ready|pending)\b/i.test(
      suffix
    )
  )
    return false;
  if (
    /^(?:(?:please|now|first|next|also|just|kindly|finally|instead|not\s+only)\s*)*(?:(?:(?:can|could|would|will)\s+you|(?:i|we)\s+(?:want|need|ask|request)\s+(?:(?:you|us)\s+)?to|(?:your|the)\s+task\s+is\s+to|help\s+me(?:\s+to)?|let['’]?s)\s*)?(?:please\s*)?$/i.test(
      prefix
    )
  )
    return true;
  if (/^(?:either|whether|should\s+i|which)\b/i.test(prefix)) return true;
  // Keep genuine coordinated requests; a noun prefix such as "The review and" does not qualify.
  if (
    /^(?:please\s+)?(?:review|audit|inspect|plan|design|document|implement|refactor|write|create|calculate|compute|analy[sz]e|compare|translate|explain)\b[\s\S]{0,140}\band\s*$/i.test(
      prefix
    )
  )
    return true;
  return activityContext && /^(?:we|i)\s+(?:are|am|were|was)\s*$/i.test(prefix);
}

function operationMatches(text: string, activityContext = false): OperationMatch[] {
  const matches: OperationMatch[] = [];
  for (const rule of OPERATION_RULES) {
    // RegExp instances are not shared mutable cursors across concurrent requests.
    for (const match of text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
      const start = match.index!;
      const end = start + match[0].length;
      if (rule.language === "en" && !directedEnglishOperation(text, start, end, activityContext))
        continue;
      matches.push({ ...rule, start, end });
    }
  }
  const specific = matches.sort(
    (a, b) => b.specificity - a.specificity || b.end - b.start - (a.end - a.start)
  );
  const kept: OperationMatch[] = [];
  for (const match of specific) {
    if (!kept.some((old) => match.start < old.end && old.start < match.end)) kept.push(match);
  }
  return kept.sort((a, b) => a.start - b.start);
}

const CONTINUATION_REQUEST = /^\s*(?:continue|resume|carry\s+on|go\s+on|keep\s+going)[.!?\s]*$/i;
export function inferFitFirstIntent(body: Record<string, unknown>): FitFirstIntent {
  const { ask, project, recentUserAsks } = selectorInputs(body);
  const current = operationText(ask);
  const continuation = CONTINUATION_REQUEST.test(current);
  let matches = operationMatches(current);
  let source: FitFirstIntent["source"] = matches.length ? "ask" : "fallback";
  let contextOrigin: FitFirstIntent["contextOrigin"] = matches.length ? "current_ask" : "unknown";
  if (!matches.length && continuation) {
    if (recentUserAsks.length) {
      // Inspect at most eight preceding user turns, not assistant/tool data or
      // unrelated generic instructions. An unknown recent topic stays unknown.
      for (const previous of [...recentUserAsks].reverse()) {
        const prior = operationText(previous);
        if (CONTINUATION_REQUEST.test(prior)) continue;
        matches = operationMatches(prior);
        if (matches.length) {
          source = "project";
          contextOrigin = "recent_user_history";
        }
        break;
      }
    } else {
      matches = operationMatches(operationText(project), true);
      if (matches.length) {
        source = "project";
        contextOrigin = "project_context";
      }
    }
  }
  const primary = matches[0];
  const semantic = matches.filter((match) => match.taskType !== "general");
  const alternatives =
    /\b(?:either|whether|should\s+i|which)\b/i.test(current) &&
    new Set(semantic.map((match) => match.taskType)).size > 1;
  const taskType: FitFirstTaskType = alternatives ? "general" : (primary?.taskType ?? "general");
  const languages = new Set(matches.map((match) => match.language));
  const language: FitFirstIntent["language"] =
    languages.size > 1 ? "mixed" : (matches[0]?.language ?? "unknown");
  // Offsets in the masked advisory scan match the original UTF-16 string.
  // A quoted/negated return is absent from matches and cannot grant a contract.
  const literalJsonOutput =
    source === "ask" &&
    matches.some(
      (match) =>
        match.operation === "constrained_output" &&
        /^\s+(?:(?:only|exactly|this|just|the|following|object)\s+){0,6}:?\s*\{/.test(
          ask.slice(match.end, match.end + 100)
        )
    );
  const outputContract: FitFirstIntent["outputContract"] =
    /\b(?:return|output|respond|reply|give|produce|generate|devuelve|responde)\s+(?:(?:only|exactly|just|valid|the|this|a|an|with|in|as)\s+){0,6}json\b/i.test(
      current
    ) ||
    /\b(?:format|return|output|reply|respond)\b[^.!?;\n]{0,100}\b(?:as|in)\s+(?:valid\s+)?json\b/i.test(
      current
    ) ||
    /^\s*(?:please\s+)?json\s+only\b/i.test(current) ||
    literalJsonOutput
      ? "json"
      : /\bcsv\b/i.test(current)
        ? "csv"
        : /\bcode\s+only\b/i.test(current)
          ? "code"
          : /\b(?:exactly|verbatim|nothing\s+else)\b/i.test(current)
            ? "verbatim"
            : /\b(?:brief|only\s+(?:with\s+)?(?:the\s+)?(?:number|word))\b/i.test(current)
              ? "brief"
              : null;
  const evidenceRequirements: FitFirstIntent["evidenceRequirements"] = [];
  if (/\b(?:cite|citations|source\s+evidence|supporting\s+sources)\b/i.test(current))
    evidenceRequirements.push("citations");
  if (/\b(?:show\s+(?:the\s+)?(?:calculation|counting|steps)|proof)\b/i.test(current))
    evidenceRequirements.push("calculation");
  if (/\b(?:assert|examples|test\s+cases)\b/i.test(current))
    evidenceRequirements.push("code_examples");
  const uncertainty: FitFirstIntent["uncertainty"] =
    ask.length > 12000
      ? "bounded_input"
      : alternatives
        ? "competing_operations"
        : source === "project"
          ? "context_inherited"
          : primary
            ? "none"
            : "no_explicit_operation";
  return {
    taskType,
    source,
    contextOrigin,
    primaryOperation: alternatives || !primary ? "unknown" : primary.operation,
    secondaryOperations: [
      ...new Set(semantic.filter((match) => match !== primary).map((match) => match.operation)),
    ],
    language,
    uncertainty,
    outputContract,
    evidenceRequirements,
    profile: {
      taskType,
      complexity: "standard",
      requiredCapabilities: [],
      confidence: !primary
        ? 0
        : ask.length > 12000
          ? 0.25
          : alternatives
            ? 0.3
            : source === "project"
              ? 0.45
              : 0.75,
    },
  };
}

/** Compatibility projection; unknown asks do not inherit arbitrary project keywords. */
export function inferFitFirstTaskType(
  body: Record<string, unknown>,
  _fallbackIntent = "medium"
): { taskType: FitFirstTaskType; source: "ask" | "project" | "fallback" } {
  const { taskType, source } = inferFitFirstIntent(body);
  return { taskType, source };
}

function containsVisualInput(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(containsVisualInput);
  if (!isRecord(value)) return false;
  const type = String(value.type ?? "").toLowerCase();
  if (["image", "image_url", "input_image", "computer_screenshot"].includes(type)) return true;
  return Object.values(value).some(containsVisualInput);
}

export function inferRequiredCapabilities(body: Record<string, unknown>): string[] {
  const required = new Set<string>();
  if (noThinkingIntent(body).requested) required.add("reasoning_none");
  if (Array.isArray(body.tools) && body.tools.length > 0) required.add("tools");
  if (containsVisualInput(body.messages ?? body.input ?? body.contents)) required.add("vision");
  const reasoning = isRecord(body.reasoning) ? body.reasoning.effort : body.reasoning_effort;
  if (typeof reasoning === "string" && !/^(none|off|disabled|minimal)$/i.test(reasoning)) {
    required.add("reasoning");
  }
  return [...required].sort();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function candidateModelString(candidate: FitFirstCandidate): string {
  return candidate.modelStr || `${candidate.provider}/${candidate.model}`;
}

function isNonGenerativeSpecialtyModel(candidate: FitFirstCandidate): boolean {
  const model = candidateModelString(candidate).toLowerCase();
  return (
    /(?:^|[/_.-])(?:embed(?:ding|qa)?|rerank(?:er)?)(?:$|[/_.-])/.test(model) ||
    model.includes("retriever") ||
    /(?:^|[/_.-])(?:guard|nemoguard)(?:$|[/_.-])/.test(model) ||
    /content[-_.]?safety|topic[-_.]?control|safety[-_.]?guard/.test(model)
  );
}

function requestFingerprint(body: Record<string, unknown>): string {
  const { ask, project } = selectorInputs(body);
  return createHash("sha256")
    .update(`${project.slice(0, 4000)}\0${ask.slice(0, 12000)}`)
    .digest("hex")
    .slice(0, 16);
}

function neutralTieBreaker(fingerprint: string, candidate: FitFirstCandidate): string {
  return createHash("sha256")
    .update(
      `${fingerprint}\0${candidate.provider}\0${candidate.model}\0${candidate.connectionId ?? ""}`
    )
    .digest("hex");
}

function weightProfile(level: ReturnType<typeof classifyTask>["level"]) {
  // Preserve each profile's existing operational weight budget. Reliability
  // receives four parts to speed's one, so a speed-only advantage cannot
  // outweigh an operational-reliability score deficit greater than 0.25.
  if (level === "light") {
    return {
      task: 0.32,
      complexity: 0.28,
      health: 0.08,
      quota: 0.07,
      reliability: 0.2,
      latency: 0.05,
    };
  }
  if (level === "heavy" || level === "critical") {
    return {
      task: 0.5,
      complexity: 0.32,
      health: 0.07,
      quota: 0.06,
      reliability: 0.05,
      latency: 0,
    };
  }
  return {
    task: 0.42,
    complexity: 0.3,
    health: 0.08,
    quota: 0.07,
    reliability: 0.104,
    latency: 0.026,
  };
}

export function rankFitFirstFreeCandidates(args: {
  candidates: FitFirstCandidate[];
  body: Record<string, unknown>;
  fallbackIntent?: string;
  zeroAdditionalCostProviders: string[];
  localFallbackPolicy?: "last" | null;
  taskProfile?: TaskProfileResolution;
  now?: number;
}): FitFirstDecision {
  const task = classifyTask(args.body);
  const { profile: _taskProfileProposal, ...taskIntent } = inferFitFirstIntent(args.body);
  const deterministicTask = { taskType: taskIntent.taskType, source: taskIntent.source };
  const profile = args.taskProfile?.profile;
  const taskDecision =
    args.taskProfile?.source === "interpreter" && profile
      ? { taskType: profile.taskType, source: "interpreter" as const }
      : deterministicTask;
  // Advisory complexity cannot lower the complete request's structural floor.
  if (profile && TASK_LEVELS.indexOf(profile.complexity) > TASK_LEVELS.indexOf(task.level)) {
    task.level = profile.complexity;
    task.weight = TASK_LEVEL_WEIGHT[profile.complexity];
    task.reasons = [...task.reasons, "interpreter_complexity"];
  }
  const requiredCapabilities = [
    ...new Set([...inferRequiredCapabilities(args.body), ...(profile?.requiredCapabilities ?? [])]),
  ].sort();
  const now = args.now ?? Date.now();
  const allowedProviders = new Set(
    args.zeroAdditionalCostProviders.map((provider) => provider.toLowerCase())
  );
  const excluded: FitFirstExclusion[] = [];
  const eligible = args.candidates.filter((candidate) => {
    let reason = "";
    if (allowedProviders.size === 0 || !allowedProviders.has(candidate.provider.toLowerCase())) {
      reason = "not_verified_zero_additional_cost";
    } else if (isNonGenerativeSpecialtyModel(candidate)) {
      reason = "non_generative_specialty_model";
    } else if (
      requiredCapabilities.includes("reasoning_none") &&
      (noThinkingIntent(args.body).conflict ||
        noThinkingHandling(candidate.provider, candidate.model) === null)
    ) {
      reason = "capability_unverified_reasoning_effort_none";
    } else if (
      requiredCapabilities.includes("vision") &&
      getResolvedModelCapabilities(candidateModelString(candidate)).supportsVision !== true
    ) {
      reason = "capability_mismatch_vision";
    } else if (
      requiredCapabilities.includes("tools") &&
      getResolvedModelCapabilities(candidateModelString(candidate)).supportsTools !== true &&
      !providerSupportsEmulatedToolCalling(candidate.provider)
    ) {
      reason = "capability_unverified_tools";
    } else if (
      requiredCapabilities.includes("reasoning") &&
      getResolvedModelCapabilities(candidateModelString(candidate)).supportsThinking !== true
    ) {
      reason = "capability_unverified_reasoning";
    } else if (
      candidate.quotaCutoffBlocked === true ||
      (candidate.quotaPolicyBypassed !== true &&
        (candidate.quotaRemaining === null || candidate.quotaRemaining <= 0))
    ) {
      reason = "quota_unavailable";
    } else if (candidate.statusPenalty === true) {
      reason = "connection_unavailable";
    } else if (candidate.circuitBreakerState === "OPEN") {
      reason = "circuit_open";
    } else if (
      Math.max(candidate.failureRate ?? 0, candidate.errorRate ?? 0) >= 1 &&
      healthEvidenceSupportsHardVeto(candidate.provenance)
    ) {
      reason = "observed_failure_rate";
    }
    if (!reason) return true;
    excluded.push({
      provider: candidate.provider,
      model: candidate.model,
      reason,
      provenance: candidate.provenance,
    });
    return false;
  });
  const evidence = new Map(
    eligible.map((candidate) => [candidate, operationalReliability(candidate, now)])
  );
  const validLatency = (candidate: FitFirstCandidate) =>
    evidence.get(candidate)!.sampleCount > 0 &&
    candidate.latencySampleSource === "successful_usage_24h" &&
    Number.isSafeInteger(candidate.successfulLatencySampleCount) &&
    candidate.successfulLatencySampleCount! >= 3 &&
    candidate.successfulLatencySampleCount! <= candidate.provenance!.health.sampleCount! &&
    Number.isFinite(candidate.p95LatencyMs) &&
    candidate.p95LatencyMs > 0;
  const maxLatency = Math.max(
    ...eligible.filter(validLatency).map((candidate) => candidate.p95LatencyMs),
    1
  );
  const required = new Set(
    requiredCapabilities.map((capability) => (capability === "tools" ? "search" : capability))
  );
  const weights = weightProfile(task.level);
  const fingerprint = requestFingerprint(args.body);
  const ranked = eligible
    .map((candidate): RankedFitFirstCandidate => {
      const modelStr = candidateModelString(candidate);
      const fitness = getTaskFitnessWithSource(modelStr, taskDecision.taskType);
      const complexityFit = clamp01(scoreModelForTask(modelStr, task, required) / 100);
      const health =
        candidate.circuitBreakerState === "CLOSED" &&
        healthEvidenceHasRecentSamples(candidate.provenance)
          ? 1
          : 0.5;
      const quota = quotaRankingFactor(candidate);
      const operational = evidence.get(candidate)!;
      const reliability = operational.score;
      const latencyFit = validLatency(candidate)
        ? clamp01(1 - candidate.p95LatencyMs / maxLatency)
        : 0.5;
      const score = clamp01(
        fitness.score * weights.task +
          complexityFit * weights.complexity +
          health * weights.health +
          quota * weights.quota +
          reliability * weights.reliability +
          latencyFit * weights.latency
      );
      return {
        candidate,
        factors: {
          taskFitness: fitness.score,
          taskFitnessSource: fitness.source,
          complexityFit,
          health,
          quota,
          reliability,
          reliabilityConfidence: operational.confidence,
          reliabilitySampleCount: operational.sampleCount,
          reliabilitySource: operational.source,
          answerQuality: null,
          answerQualitySource: "unavailable",
          latencyEvidence: validLatency(candidate) ? "observed" : "neutral_prior",
          latencyFit,
          score,
        },
        tieBreaker: neutralTieBreaker(fingerprint, candidate),
      };
    })
    .sort(
      (a, b) =>
        localFallbackTier(a.candidate.provider, args.localFallbackPolicy) -
          localFallbackTier(b.candidate.provider, args.localFallbackPolicy) ||
        b.factors.score - a.factors.score ||
        b.factors.taskFitness - a.factors.taskFitness ||
        b.factors.complexityFit - a.factors.complexityFit ||
        a.tieBreaker.localeCompare(b.tieBreaker)
    );

  return {
    taskIntent,
    taskType: taskDecision.taskType,
    taskSource: taskDecision.source,
    taskProfileSource: args.taskProfile?.source ?? "deterministic",
    taskProfileFallbackReason: args.taskProfile
      ? args.taskProfile.fallbackReason
      : "not_configured",
    taskProfileConfidence: profile?.confidence ?? 0,
    taskLevel: task.level,
    taskReasons: task.reasons,
    requiredCapabilities,
    ranked,
    excluded,
  };
}

export { classifyToolContinuation } from "./toolContinuation.ts";

export function hasToolContinuation(body: Record<string, unknown>): boolean {
  return classifyToolContinuation(body).continuation;
}
