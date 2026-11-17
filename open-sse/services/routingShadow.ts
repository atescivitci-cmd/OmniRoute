/**
 * routingShadow.ts: stage 1 of the shadow classifier (flag ROUTING_SHADOW_LOG, default off).
 *
 * Records the decision the rule classifier (`classifyTask`) makes for each task-routed request,
 * so it can be measured and later compared with a shadow classifier. It changes no routing: it
 * runs after the ordering inputs are fixed, defers the database write, swallows every error,
 * and stores only lengths, counts and flags, never prompt text.
 *
 * Flag mechanism matches ROUTING_LIGHT_BY_ASK: read from process.env at call time, so selector
 * code stays DB-free. The writer is imported lazily, only when the flag is on, from the same
 * module graph as the caller, so there is no registration step that a second bundle copy of
 * this module could miss.
 */
import { classifyTask, extractCurrentAsk, isTaskRoutingStrategy } from "./taskAwareRouting.ts";
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
}

/** Build the stored record. Pure: no I/O, and the ask text is measured, never kept. */
export function buildRuleDecisionRecord(args: RuleDecisionArgs): RoutingShadowDecisionInput {
  const task = classifyTask(args.body ?? {});
  const { ask, userTurns, askHasNonText } = extractCurrentAsk(args.body ?? {});
  const reasons = Array.isArray(task.reasons) ? task.reasons : [];
  const was = reasons.find((reason) => reason.startsWith("was:"));
  return {
    requestId: args.requestId ? String(args.requestId) : null,
    comboName: args.comboName ? String(args.comboName) : null,
    strategy: args.strategy,
    ruleLevel: task.level,
    ruleReasons: reasons,
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
  };
}

/**
 * Record the rule decision for one request. No-op unless the flag is on and the strategy is a
 * task-routing one. Never throws and never blocks: the write happens on a later tick.
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
        .catch(() => undefined);
    });
  } catch {
    // Shadow logging must never affect routing.
  }
}
