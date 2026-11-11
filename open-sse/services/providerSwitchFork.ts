// ── CLAUDE_SESSION_AFFINITY_V2 (2026-08-29, buildTargetBody fix 2026-08-30) ─────────────
// Storage-agnostic core for Changes 2/3 of the same-terminal-continuity handout.
// Deliberately has NO database dependency: prepareProviderSwitchFork/commitFork/
// rollbackFork are pure functions over a ProviderSwitchForkRecord. Persistence lives in
// ../../src/lib/db/providerSwitchForks.ts (migrations/134_provider_switch_forks.sql),
// added 2026-08-30 -- see that file's header for why the earlier "no migration
// convention found" conclusion was wrong.
//
// buildTargetBody (2026-08-30, Codex audit Blocker 4): the real combo.ts call site
// should use `sanitized => injectUniversalHandoffBody(sanitized, lastModel, modelStr,
// reason, existingHandoff)` -- reviewed against real combo.ts source (getLastSessionModel/
// recordSessionModelUsage/getHandoff/injectUniversalHandoffBody import from
// ../../src/lib/db/contextHandoffs.ts and ./contextHandoff.ts, dispatch at combo.ts:1171
// via handleSingleModelWithTimeout(attemptBody, modelStr, ...)) but still NOT
// live-integration-tested against the running combo.ts control flow itself -- see
// combo.ts.integration.patch.md for the current state of that integration and its
// explicitly-listed open items.
import { sanitizeForProviderSwitch } from "./sanitizeForProviderSwitch.ts";
// Shared types live in the DB tree so the DB module does not import service code
// (Codex audit 2, Blocker 1). This direction -- open-sse importing from src/lib/db --
// is the package's own established convention (cf. combo.ts importing
// ../../src/lib/db/contextHandoffs.ts).
import type {
  ForkState,
  ProviderSwitchForkRecord,
} from "../../src/lib/db/providerSwitchForkTypes.ts";

export type { ForkState, ProviderSwitchForkRecord };

export interface PrepareForkInput {
  body: Record<string, unknown>;
  sessionId: string;
  comboName: string;
  previousModel: string;
  currentModel: string;
  reason: string;
  sourceProvider: string;
  targetProvider: string;
  now: () => string;
  hash: (input: string) => string;
  id: () => string;
  /**
   * Builds the final target body FROM the already-sanitized body. Required, not
   * defaulted internally -- added 2026-08-30 in response to Codex's audit (Blocker 4):
   * the earlier version always prepended a bare transition note and never called the
   * real injectUniversalHandoffBody/getHandoff, so a genuinely stored summary from a
   * prior switch was silently discarded on every subsequent switch instead of being
   * layered on top of the sanitized transcript. The real combo.ts integration should
   * pass `sanitized => injectUniversalHandoffBody(sanitized, lastModel, modelStr,
   * reason, existingHandoff)` -- that real function already emits a generic
   * <context_handoff> transition block even when existingHandoff is null/has no
   * summary, so no separate "no summary" fallback is needed there. Tests that don't
   * have access to the real OmniRoute function can pass `withTransitionNote` (exported
   * below) as a minimal stand-in.
   */
  buildTargetBody: (sanitized: Record<string, unknown>) => Record<string, unknown>;
}

export interface PreparedFork {
  record: ProviderSwitchForkRecord;
  sanitizedBody: Record<string, unknown>;
}

function countMessages(body: Record<string, unknown>): number {
  if (Array.isArray(body.messages)) return body.messages.length;
  if (Array.isArray(body.input)) return body.input.length;
  return 0;
}

function countTools(body: Record<string, unknown>): number {
  return Array.isArray(body.tools) ? body.tools.length : 0;
}

// A short, non-content system note announcing the transition. Deliberately carries no
// prompt text, no reasoning, no secrets -- only the fact of the switch.
function buildTransitionSystemMessage(reason: string): { role: string; content: string } {
  return { role: "system", content: `[OmniRoute] ${reason}` };
}

/**
 * Minimal stand-in buildTargetBody for callers without access to the real
 * injectUniversalHandoffBody (e.g. isolated tests). Prepends a bare transition note;
 * carries no prompt content, no stored summary. Exported so tests can pass it directly
 * as `buildTargetBody` without reimplementing it.
 */
export function withTransitionNote(
  body: Record<string, unknown>,
  reason: string
): Record<string, unknown> {
  const note = buildTransitionSystemMessage(reason);
  const next = { ...body };
  if (Array.isArray(next.messages)) {
    next.messages = [note, ...next.messages];
  } else if (Array.isArray(next.input)) {
    next.input = [note, ...next.input];
  }
  return next;
}

/**
 * prepareProviderSwitchFork -- deterministic, synchronous with respect to the caller
 * (no LLM call of its own). Sanitizes the body, records provenance, and returns both
 * the PREPARED audit record and the sanitized body ready for the fallback attempt.
 *
 * Never depends on an asynchronous LLM-generated summary: the deterministic
 * sanitized transcript IS what protects the first cross-provider request. A generated
 * summary (maybeGenerateUniversalHandoff, existing code) may supplement it later, but
 * must never gate or delay this.
 */
export function prepareProviderSwitchFork(input: PrepareForkInput): PreparedFork {
  const sourceHash = input.hash(JSON.stringify(input.body));
  const sanitized = sanitizeForProviderSwitch(input.body);
  const targetBody = input.buildTargetBody(sanitized);
  const sanitizedHash = input.hash(JSON.stringify(targetBody));

  const record: ProviderSwitchForkRecord = {
    id: input.id(),
    sessionId: input.sessionId,
    comboName: input.comboName,
    state: "PREPARED",
    sourceProvider: input.sourceProvider,
    sourceModel: input.previousModel,
    targetProvider: input.targetProvider,
    targetModel: input.currentModel,
    sourceHash,
    sanitizedHash,
    messageCount: countMessages(input.body),
    toolCount: countTools(input.body),
    reason: input.reason,
    preparedAt: input.now(),
    committedAt: null,
    rolledBackAt: null,
    errorCode: null,
  };

  return { record, sanitizedBody: targetBody };
}

/** On fallback success: PREPARED -> COMMITTED. Only a PREPARED fork may commit. */
export function commitFork(
  record: ProviderSwitchForkRecord,
  now: () => string
): ProviderSwitchForkRecord {
  if (record.state !== "PREPARED") {
    throw new Error(
      `commitFork: cannot commit a fork in state ${record.state} (expected PREPARED)`
    );
  }
  return { ...record, state: "COMMITTED", committedAt: now(), rolledBackAt: null };
}

/** On fallback failure: PREPARED -> ROLLED_BACK. Only a PREPARED fork may roll back. */
export function rollbackFork(
  record: ProviderSwitchForkRecord,
  errorCode: string,
  now: () => string
): ProviderSwitchForkRecord {
  if (record.state !== "PREPARED") {
    throw new Error(
      `rollbackFork: cannot roll back a fork in state ${record.state} (expected PREPARED)`
    );
  }
  return { ...record, state: "ROLLED_BACK", rolledBackAt: now(), errorCode };
}
