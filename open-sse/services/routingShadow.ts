/**
 * routingShadow.ts: stage 1 of the shadow classifier (flag ROUTING_SHADOW_LOG, default off).
 *
 * Records the decision the rule classifier (`classifyTask`) makes for each task-routed request,
 * so it can be measured and later compared with a shadow classifier. It changes no routing: it
 * only reads the request, swallows every error, and stores only lengths, counts and flags,
 * never prompt text.
 *
 * Cost when the flag is ON: the record is built inline, because the body can be rewritten later
 * in the pipeline, so one extra classification of the request (about 1 to 2 ms on large
 * prompts, measured on real bodies) runs on the request path. Only the database write is
 * deferred to a later tick. With the flag OFF the cost is one environment read.
 *
 * Flag mechanism matches ROUTING_LIGHT_BY_ASK: read from process.env at call time, so selector
 * code stays DB-free. The writer is imported lazily, only when the flag is on, from the same
 * module graph as the caller, so there is no registration step that a second bundle copy of
 * this module could miss.
 */
import {
  classifyTask,
  extractCurrentAsk,
  hasCompactedHistory,
  isTaskRoutingStrategy,
} from "./taskAwareRouting.ts";
import type { RoutingShadowDecisionInput } from "@/lib/db/routingShadowDecisions";

export const ROUTING_SHADOW_LOG_FLAG = "ROUTING_SHADOW_LOG";

export function isRoutingShadowLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env[ROUTING_SHADOW_LOG_FLAG] ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export interface RuleDecisionArgs {
  body: Record<string, unknown>;
  strategy: string;
  comboName: string | null | undefined;
  requestId: string | null | undefined;
  /** Step of the target pipeline reached when this is recorded (stored in `path`). */
  path?: string | null;
}

// Free-form identifiers can be client influenced and are otherwise unbounded.
const MAX_ID_CHARS = 200;
function capId(value: string | null | undefined): string | null {
  return value ? String(value).slice(0, MAX_ID_CHARS) : null;
}

/** Build the stored record. Pure: no I/O, and the ask text is measured, never kept. */
export function buildRuleDecisionRecord(args: RuleDecisionArgs): RoutingShadowDecisionInput {
  const task = classifyTask(args.body ?? {});
  const { ask, userTurns, askHasNonText } = extractCurrentAsk(args.body ?? {});
  const reasons = Array.isArray(task.reasons) ? task.reasons : [];
  const was = reasons.find((reason) => reason.startsWith("was:"));
  return {
    requestId: capId(args.requestId),
    comboName: capId(args.comboName),
    strategy: args.strategy,
    ruleLevel: task.level,
    ruleReasons: reasons,
    path: capId(args.path ?? null),
    lightByAsk: reasons.includes("light-by-ask"),
    wasLevel: was ? was.slice("was:".length) : null,
    promptChars: task.promptChars,
    messageCount: task.messageCount,
    toolCount: task.toolCount,
    outputTokens: task.outputTokens,
    effort: task.effort,
    lightKeyword: task.lightKeyword,
    heavyKeyword: task.heavyKeyword,
    criticalKeyword: task.criticalKeyword,
    askChars: ask.length,
    userTurns,
    // The same non-ASCII range the light-by-ask pre-check refuses.
    askNonAscii: /[\u0080-￿]/.test(ask),
    askNonText: Boolean(askHasNonText),
    compactedHistory: hasCompactedHistory(args.body ?? {}),
  };
}

let warnedAboutWriteFailure = false;
function warnOnceAboutWriteFailure(error: unknown): void {
  if (warnedAboutWriteFailure) return;
  warnedAboutWriteFailure = true;
  const reason = error instanceof Error ? error.message : String(error);
  // Without this, a missing table (migration 138 not applied) would leave the baseline silently
  // empty. Logged once per process; the request is unaffected.
  console.warn(
    `[routingShadow] could not record a rule decision, further failures are silent: ${reason}`
  );
}

/** Test seam: forget that a write failure was already reported. */
export function __resetRoutingShadowWarningForTests(): void {
  warnedAboutWriteFailure = false;
}

/**
 * Record the rule decision for one request. No-op unless the flag is on and the strategy is a
 * task-routing one. Never throws. The record is built now; the write happens on a later tick.
 */
export function emitRuleDecision(
  args: RuleDecisionArgs,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isRoutingShadowLogEnabled(env)) return;
  if (!isTaskRoutingStrategy(args.strategy)) return;
  try {
    const record = buildRuleDecisionRecord(args);
    setImmediate(() => {
      import("@/lib/db/routingShadowDecisions")
        .then((module) => module.insertRoutingShadowDecision(record))
        .catch(warnOnceAboutWriteFailure);
    });
  } catch {
    // Shadow logging must never affect routing.
  }
}
