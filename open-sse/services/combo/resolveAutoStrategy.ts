import {
  resolveDeadlineRoutingPolicy,
  applyDeadlineAwareRouting,
} from "../autoCombo/deadlineAwareRouting.ts";
import { resolveTaskProfile, type TaskInterpreter } from "../autoCombo/taskProfile.ts";
import { classifyTask } from "../taskAwareRouting.ts";
import { probeRequestCompatibility, RequestCompatibilityError } from "../requestCompatibility.ts";
import { resolveRequestCompatibilityTarget } from "../requestCompatibilityTarget.ts";
import { requestCompatibilityErrorResult } from "../requestCompatibilityResponse.ts";
import { inferFitFirstTaskType, inferRequiredCapabilities } from "../autoCombo/fitFirstPolicy.ts";
import {
  hasCurrentZeroCostAdmission,
  zeroCostErrorResponse,
} from "../autoCombo/zeroCostAdmission.ts";
import { resolveFitFirstFreeConfig } from "../autoCombo/fitFirstPolicy.ts";
import { randomUUID } from "node:crypto";
import {
  errorResponse,
  unavailableResponse,
  errorResponseWithComboDiagnostics,
} from "../../utils/error.ts";
import { BudgetExceededError, selectProvider as selectAutoProvider } from "../autoCombo/engine.ts";
import {
  applyPressedResponsiveness,
  isPressedTextRequest,
} from "../autoCombo/pressedResponsiveness.ts";
import { rankFitFirstFreeCandidates, type FitFirstDecision } from "../autoCombo/fitFirstPolicy.ts";
import {
  resolveRequestModePack,
  parseRequestBudgetCap,
  parseRequestBudgetFallback,
} from "../autoCombo/requestControls.ts";
import { selectWithStrategy } from "../autoCombo/routerStrategy.ts";
import { buildComplexityRoutingHint } from "../autoCombo/complexityRouter";
import { getModePack } from "../autoCombo/modePacks.ts";
import { isModelLocked } from "../accountFallback.ts";
import { recordComboIntent } from "../comboMetrics.ts";
import { estimateTokens, getComboTargetTokenLimit } from "../contextManager.ts";
import {
  estimateFullInputTokens,
  retainsFullContext,
  requestedOutputReserve,
} from "../fullContextAdmission.ts";
import { getExplicitModelOutputCap } from "../../../src/lib/modelCapabilities.ts";
import { classifyWithConfig } from "../intentClassifier.ts";
import type { RoutingHint } from "../manifestAdapter";
import { parseModel } from "../model.ts";
import { supportsToolCalling } from "../modelCapabilities.ts";
import { isProviderInCooldown } from "../providerCooldownTracker.ts";
import type { ResilienceSettings } from "../../../src/lib/resilience/settings";
import { recordRoutingDecision } from "../../../src/lib/db/routingDecisions.ts";
import { parseAutoConfig } from "./autoConfig.ts";
import { dedupeTargetsByExecutionKey } from "./comboData.ts";
import {
  getModelContextLimitForModelString,
  providerSupportsEmulatedToolCalling,
} from "./comboStructure.ts";
import {
  calculatePromptCacheAffinityScores,
  promptCacheTargetIdentity,
} from "./promptCacheAffinity.ts";
import type { ResetWindowConfig } from "./quotaScoring.ts";
import {
  _registerExecutionCandidates,
  expandAutoComboCandidatePool,
  extractPromptForIntent,
  getIntentConfig,
  mapIntentToTaskType,
  scoreAutoTargets,
} from "./autoStrategy.ts";
import type {
  AutoProviderCandidate,
  ComboLike,
  ComboLogger,
  IsModelAvailable,
  ResolvedComboTarget,
} from "./types.ts";

/**
 * Dependency-injected `buildAutoCandidates` — it lives in `combo.ts` (the host of
 * this leaf), so importing it directly would create an import cycle. Passing it
 * through `deps` keeps this module acyclic (same pattern as `buildTargetTimeoutRunner`).
 */
type BuildAutoCandidates = (
  targets: ResolvedComboTarget[],
  comboName: string,
  sessionId?: string | null,
  resetWindowConfig?: ResetWindowConfig,
  resilienceSettings?: ResilienceSettings | null,
  bypassQuotaPolicy?: boolean
) => Promise<AutoProviderCandidate[]>;

export interface ResolveAutoStrategyDeps {
  signal?: AbortSignal | null;
  /** In-process extension only. No interpreter/provider is enabled by this change. */
  taskInterpreter?: TaskInterpreter;
  taskInterpretationBudgetMs?: number;
  orderedTargets: ResolvedComboTarget[];
  body: Record<string, unknown>;
  combo: ComboLike;
  settings: Record<string, unknown> | null | undefined;
  config: { complexityAwareRouting?: boolean; compatFilterFailOpen?: boolean };
  relayOptions?: {
    routingRequestId?: string | null;
    bypassProviderQuotaPolicy?: boolean;
    sessionId?: string | null;
    /** Per-request X-OmniRoute-Mode value (#6024/#6025). */
    mode?: string | null;
    /** Per-request X-OmniRoute-Budget value in USD (#6023). */
    budgetCap?: number | null;
    /** Per-request X-OmniRoute-Budget-Fallback value ("cheapest" | "strict") — #3470. */
    budgetFallback?: "cheapest" | "strict" | null;
  } | null;
  resilienceSettings: ResilienceSettings;
  log: ComboLogger;
  buildAutoCandidates: BuildAutoCandidates;
  /** Live connection/model availability gate used again immediately before dispatch. */
  isModelAvailable?: IsModelAvailable;
  /** Test seam for the request-ordering contract; production uses the real catalog expansion. */
  expandAutoCandidatePool?: typeof expandAutoComboCandidatePool;
}

export type ResolveAutoStrategyResult =
  | { earlyResponse: Response }
  | { orderedTargets: ResolvedComboTarget[]; autoUsedExplicitRouter: boolean };

function targetForCandidate(
  candidate: AutoProviderCandidate,
  eligibleTargets: ResolvedComboTarget[]
): ResolvedComboTarget | null {
  const baseTarget =
    eligibleTargets.find((target) => target.executionKey === candidate.executionKey) ||
    eligibleTargets.find(
      (target) =>
        target.stepId === candidate.stepId ||
        (target.provider === candidate.provider && target.modelStr === candidate.modelStr)
    );
  if (!baseTarget) return null;
  return {
    ...baseTarget,
    stepId: candidate.stepId,
    executionKey: candidate.executionKey,
    modelStr: candidate.modelStr,
    provider: candidate.provider,
    connectionId: candidate.connectionId ?? baseTarget.connectionId,
  };
}

/**
 * Resolve target ordering for the `auto` combo strategy.
 *
 * Extracted verbatim from `handleComboChat`'s `if (strategy === "auto")` branch:
 * tool-calling + context-window pre-filters, intent classification, candidate
 * building (quota cutoff), explicit-router vs rules selection, complexity-aware
 * scoring and final dedup ordering. Behavior is byte-identical to the previous
 * inline block; the two `return unavailableResponse(...)` exits become
 * `{ earlyResponse }` so the host can decide to return them, and the mutated
 * `orderedTargets` / `autoUsedExplicitRouter` are returned instead of closed over.
 */
export async function resolveAutoStrategyOrder(
  deps: ResolveAutoStrategyDeps
): Promise<ResolveAutoStrategyResult> {
  const {
    body,
    combo,
    settings,
    config,
    relayOptions,
    resilienceSettings,
    log,
    buildAutoCandidates,
    isModelAvailable,
    expandAutoCandidatePool = expandAutoComboCandidatePool,
  } = deps;
  deps.signal?.throwIfAborted();
  let orderedTargets = deps.orderedTargets;
  let autoUsedExplicitRouter = false;
  let requiresPerTargetCompression = false;

  const requestHasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  let eligibleTargets = [...orderedTargets];
  const strictCentralPolicy = resolveFitFirstFreeConfig(combo);
  const compatFilterFailOpen =
    !(strictCentralPolicy.enabled && strictCentralPolicy.localFallbackPolicy === "last") &&
    (config?.compatFilterFailOpen === true ||
      (settings as { compatFilterFailOpen?: unknown } | null | undefined)?.compatFilterFailOpen ===
        true);

  // MODEL_FREE_AUTO_PRECOMPAT_EXPANSION_V1: model-free auto combos intentionally
  // begin with zero static targets. Expand their bounded live catalog before any
  // request capability filter. Filtering the empty placeholder first caused every
  // Claude Code request carrying tools to fail with a false capability_mismatch
  // before a provider/model candidate was even considered.
  eligibleTargets = await expandAutoCandidatePool(eligibleTargets, combo);

  const expandedTargets = eligibleTargets;

  if (requestHasTools) {
    // Keep #5240 prompt-emulation providers (toolCalling:"emulated") even when
    // registry/capability rows honestly report toolCalling:false.
    const filtered = eligibleTargets.filter(
      (target) =>
        supportsToolCalling(target.modelStr) || providerSupportsEmulatedToolCalling(target.provider)
    );
    if (filtered.length > 0) {
      eligibleTargets = filtered;
    } else if (compatFilterFailOpen) {
      log.warn(
        "COMBO",
        "Auto strategy: all candidates filtered by tool-calling policy, falling back to full pool (compatFilterFailOpen)"
      );
    } else {
      // #8488: fail closed with an explicit compatibility error instead of
      // re-admitting tool-incapable targets.
      const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
      return {
        earlyResponse: errorResponseWithComboDiagnostics(
          400,
          `No target in combo ${combo.name} supports tool calling; request carried ${toolCount} tools`,
          {
            poolSize: eligibleTargets.length,
            attempted: 0,
            excluded: eligibleTargets.map((target) => ({
              provider: target.provider,
              model: target.modelStr,
              reason: "tools",
            })),
            attemptOrder: [],
            terminalReason: "capability_mismatch",
          },
          { code: "capability_mismatch", type: "invalid_request_error" }
        ),
      };
    }
  }

  // Context-window pre-filter (#1808)
  // Ordinary requests retain their compression-aware admission. Terminal continuity
  // cannot compact: use the complete final-input estimate, concrete target window,
  // and requested output reserve before ranking or constructing fallback targets.
  // Uses the same 4-chars-per-token heuristic as contextManager.ts::compressContext().
  // Ordinary unknown limits remain includable; continuity uses the same bounded
  // getTokenLimit fallback as chatCore rather than treating unknown as unlimited.
  const preserveFullContext = retainsFullContext(combo.name);
  const targetContextLimit = (target: ResolvedComboTarget) =>
    preserveFullContext
      ? getComboTargetTokenLimit({ modelStr: target.modelStr, provider: target.provider })
      : getModelContextLimitForModelString(target.modelStr);
  const targetRequiredTokens = (target: ResolvedComboTarget) => {
    if (!preserveFullContext) return estimatedInputTokens;
    const parsed = parseModel(target.modelStr);
    const cap = getExplicitModelOutputCap({
      provider: target.provider,
      model: parsed.model || target.modelStr,
    });
    return estimatedInputTokens + requestedOutputReserve(body, cap);
  };
  const requestMessages = body.messages;
  const estimatedInputTokens = preserveFullContext
    ? estimateFullInputTokens(body)
    : estimateTokens(
        typeof requestMessages === "string" ||
          (requestMessages !== null && typeof requestMessages === "object")
          ? requestMessages
          : []
      );
  if (estimatedInputTokens > 0) {
    const knownContextTargets = eligibleTargets.filter(
      (target) => targetContextLimit(target) !== null
    );
    const filteredByContext = eligibleTargets.filter((target) => {
      const limit = targetContextLimit(target);
      if (limit === null || limit === undefined) return true; // unknown — include to be safe
      return limit >= targetRequiredTokens(target);
    });
    const overflowingKnownContextTargets = knownContextTargets.filter(
      (target) => (targetContextLimit(target) ?? 0) < targetRequiredTokens(target)
    );
    if (
      !preserveFullContext &&
      overflowingKnownContextTargets.length > 0 &&
      filteredByContext.length > 0
    ) {
      // COMPRESSION_AWARE_AUTO_ADMISSION_V1: chatCore compresses separately for
      // each target immediately before dispatch. A raw-fit/unknown candidate
      // keeps this request admissible, but filtering here must not discard the
      // smaller known-window routes that remain safe after compression. They
      // may be the only healthy or task-fit fallbacks at dispatch time.
      requiresPerTargetCompression = true;
      log.info(
        "COMBO",
        `Auto strategy: raw request requires per-target compression (est. ${estimatedInputTokens} tokens); preserving ${overflowingKnownContextTargets.length} compressible known-window candidates alongside ${filteredByContext.length} raw-fit/unknown candidates`
      );
    } else if (filteredByContext.length > 0) {
      log.debug?.(
        "COMBO",
        `Auto strategy: context-window filter kept ${filteredByContext.length}/${eligibleTargets.length} candidates (est. ${estimatedInputTokens} tokens)`
      );
      eligibleTargets = filteredByContext;
    } else if (compatFilterFailOpen && !preserveFullContext) {
      log.warn(
        "COMBO",
        `Auto strategy: all candidates filtered by context-window policy (est. ${estimatedInputTokens} tokens), falling back to full pool (compatFilterFailOpen)`
      );
    } else {
      // #8488: every candidate has a known limit below the estimate — surface
      // context_length_exceeded rather than dispatching oversized targets.
      return {
        earlyResponse: errorResponseWithComboDiagnostics(
          400,
          `Request requires approximately ${estimatedInputTokens} input tokens${preserveFullContext ? " plus its requested output reserve; the full conversation must be retained" : ""}, but every auto-strategy candidate in combo ${combo.name} has a smaller known context limit`,
          {
            poolSize: eligibleTargets.length,
            attempted: 0,
            excluded: eligibleTargets.map((target) => ({
              provider: target.provider,
              model: target.modelStr,
              reason: "context_window",
            })),
            attemptOrder: [],
            terminalReason: "context_length_exceeded",
          },
          { code: "context_length_exceeded", type: "invalid_request_error" }
        ),
      };
    }
  }

  const prompt = extractPromptForIntent(body);
  const systemPrompt = typeof combo?.system_message === "string" ? combo.system_message : undefined;
  const intentConfig = getIntentConfig(settings, combo);
  const intent = classifyWithConfig(prompt, intentConfig, systemPrompt);
  recordComboIntent(combo.name, intent);
  const taskType = mapIntentToTaskType(intent);

  const {
    routingStrategy,
    candidatePool,
    weights: configWeights,
    explorationRate,
    budgetCap: configBudgetCap,
    budgetFallback: configBudgetFallback,
    modePack: configModePack,
    selectionPolicy,
    zeroAdditionalCostProviders,
    resetWindowConfig,
    slaPolicy,
  } = parseAutoConfig(combo, eligibleTargets);

  // Per-request overrides (#6023 / #6024 / #6025 / #3470): X-OmniRoute-Budget,
  // X-OmniRoute-Budget-Fallback and X-OmniRoute-Mode headers (threaded via
  // relayOptions) take precedence over the combo's stored config for this single
  // request. Unknown/garbage header values are ignored so the saved config is
  // preserved.
  const requestBudgetCap = parseRequestBudgetCap(relayOptions?.budgetCap);
  const budgetCap = requestBudgetCap ?? configBudgetCap;
  const requestBudgetFallback = parseRequestBudgetFallback(relayOptions?.budgetFallback);
  const budgetFallback = requestBudgetFallback ?? configBudgetFallback;
  const requestModePack = resolveRequestModePack(relayOptions?.mode);
  const modePack = requestModePack.override ? requestModePack.modePack : configModePack;
  // #7008: `weights` must track the *effective* (post-override) modePack, not just
  // the combo's stored one. `selectAutoProvider()` (engine.ts) already re-derives
  // weights internally from the `modePack` it's given, so it correctly reacts to a
  // per-request X-OmniRoute-Mode override — but `scoreAutoTargets()` (the fallback
  // ranking below) has no such re-derivation and only ever sees whatever `weights`
  // it's handed. Without this recompute, a request overriding e.g. `quality-first`
  // to `ship-fast` would select its primary target under ship-fast weights but rank
  // every fallback under the stale quality-first weights — the same
  // select-under-one-policy/rank-under-another bug this module's original fix
  // (parseAutoConfig honoring the combo's own stored modePack) set out to close.
  const weights = modePack ? getModePack(modePack) || configWeights : configWeights;
  if (
    requestModePack.override ||
    requestBudgetCap !== undefined ||
    requestBudgetFallback !== undefined
  ) {
    log.debug?.(
      "COMBO",
      `Auto strategy: per-request controls applied (mode=${
        requestModePack.override ? (requestModePack.modePack ?? "balanced") : "—"
      }, budgetCap=${requestBudgetCap ?? "—"}, budgetFallback=${requestBudgetFallback ?? "—"})`
    );
  }

  let lastKnownGoodProvider: string | undefined;
  try {
    const { getLKGP } = await import("../../../src/lib/localDb");
    const lkgp = await getLKGP(combo.name, combo.id || combo.name);
    if (lkgp) lastKnownGoodProvider = lkgp.provider;
  } catch (err) {
    log.warn("COMBO", "Failed to retrieve Last Known Good Provider. This is non-fatal.", { err });
  }

  let candidates = await buildAutoCandidates(
    eligibleTargets,
    combo.name,
    relayOptions?.sessionId,
    resetWindowConfig,
    resilienceSettings,
    relayOptions?.bypassProviderQuotaPolicy === true
  );
  const expandedCandidates = candidates;
  // Account expansion happens inside buildAutoCandidates; model-free catalog
  // targets have connectionId=null before that stage. Admit the concrete pair.
  if (strictCentralPolicy.enabled && strictCentralPolicy.localFallbackPolicy === "last") {
    const costAdmissions = await Promise.all(
      candidates.map(async (candidate) => {
        const target = targetForCandidate(candidate, eligibleTargets);
        const id = candidate.connectionId;
        if (
          !target ||
          !id ||
          (Array.isArray(target.allowedConnectionIds) && !target.allowedConnectionIds.includes(id))
        )
          return false;
        return hasCurrentZeroCostAdmission({
          provider: candidate.provider,
          model: candidate.model,
          connectionId: id,
          body,
        });
      })
    );
    candidates = candidates.filter((_, index) => costAdmissions[index]);
    if (!candidates.length)
      return {
        earlyResponse: zeroCostErrorResponse(
          503,
          "No current account-specific zero-additional-cost admission is available",
          { code: "zero_cost_admission_unavailable" }
        ),
      };
  }
  if (candidates.length === 0) {
    return {
      earlyResponse: unavailableResponse(
        503,
        "No auto strategy candidates remained after visibility and connection filtering"
      ),
    };
  }
  const cacheAffinityScores = calculatePromptCacheAffinityScores(candidates, body);
  for (const candidate of candidates) {
    candidate.cacheAffinity = cacheAffinityScores.get(promptCacheTargetIdentity(candidate)) ?? 0;
  }
  const routableCandidates = candidates.filter(
    (candidate) => candidate.quotaCutoffBlocked !== true
  );
  const quotaBlockedCount = candidates.length - routableCandidates.length;
  if (quotaBlockedCount > 0) {
    log.info(
      "COMBO",
      `Auto strategy: quota cutoff skipped ${quotaBlockedCount}/${candidates.length} account candidates`
    );
  }
  // G2: Register candidates so chatCore can mark quotaSoftPenalty via setCandidateQuotaSoftPenalty.
  _registerExecutionCandidates(routableCandidates);
  if (candidates.length > 0 && routableCandidates.length === 0) {
    return {
      earlyResponse: unavailableResponse(
        429,
        "All auto strategy candidates are below configured quota cutoffs"
      ),
    };
  }
  if (routableCandidates.length > 0) {
    let selectedProvider: string | null = null;
    let selectedModel: string | null = null;
    let selectedConnectionId: string | null = null;
    let selectionReason = "";
    let fitFirstDecision: FitFirstDecision | null = null;
    let deadlineRankTrace:
      | {
          ranked: Array<{
            provider: string;
            model: string;
            before: number;
            after: number;
            evidence:
              FitFirstDecision["ranked"][number]["factors"]["deadlineResponsiveness"] | null;
          }>;
          excludedBeforeScoring: Array<{ model: string; reason: string }>;
        }
      | undefined;
    let structuralTask: ReturnType<typeof classifyTask> | null = null;

    if (selectionPolicy === "fit-first-free") {
      if (zeroAdditionalCostProviders.length === 0) {
        return {
          earlyResponse: unavailableResponse(
            503,
            "Fit-first-free requires an operator-verified zero-additional-cost provider allowlist"
          ),
        };
      }

      const availability = await Promise.all(
        routableCandidates.map(async (candidate) => {
          const target = targetForCandidate(candidate, eligibleTargets);
          if (!target) return { available: false, reason: "target_unresolved" };
          const compatibility = probeRequestCompatibility(
            body,
            resolveRequestCompatibilityTarget(body, candidate.provider, candidate.model)
          );
          if (compatibility.ok === false) return { available: false, reason: compatibility.code };
          if (!isModelAvailable) return { available: true, reason: "not_checked" };
          try {
            return {
              available: Boolean(await isModelAvailable(candidate.modelStr, target)),
              reason: "model_unavailable",
            };
          } catch {
            return { available: false, reason: "availability_check_failed" };
          }
        })
      );
      const availableCandidates = routableCandidates.filter(
        (_candidate, index) => availability[index].available
      );
      deps.signal?.throwIfAborted();
      const deterministicTask = inferFitFirstTaskType(body, intent);
      structuralTask = classifyTask(body);
      const taskProfile = await resolveTaskProfile({
        body,
        fallback: {
          taskType: deterministicTask.taskType,
          complexity: structuralTask.level,
          requiredCapabilities: inferRequiredCapabilities(body) as Array<
            "vision" | "tools" | "reasoning"
          >,
          confidence: 0,
        },
        interpreter: deps.taskInterpreter,
        signal: deps.signal,
        budgetMs: deps.taskInterpretationBudgetMs,
      });
      fitFirstDecision = rankFitFirstFreeCandidates({
        taskProfile,
        candidates: availableCandidates,
        body,
        fallbackIntent: intent,
        zeroAdditionalCostProviders,
        localFallbackPolicy: strictCentralPolicy.localFallbackPolicy,
      });
      if (isPressedTextRequest(combo.name, body)) {
        await applyPressedResponsiveness(
          fitFirstDecision.ranked,
          combo.name,
          strictCentralPolicy.localFallbackPolicy,
          relayOptions?.routingRequestId
        );
        deps.signal?.throwIfAborted();
      }
      const deadlinePolicy = resolveDeadlineRoutingPolicy(combo.config, body);
      if (deadlinePolicy) {
        const before = new Map(fitFirstDecision.ranked.map((entry, index) => [entry, index + 1]));
        await applyDeadlineAwareRouting(
          fitFirstDecision.ranked,
          combo.name,
          deadlinePolicy,
          strictCentralPolicy.localFallbackPolicy,
          relayOptions?.routingRequestId
        );
        deps.signal?.throwIfAborted();
        const eligible = new Set(eligibleTargets);
        const expandedModels = new Set(expandedCandidates.map((candidate) => candidate.modelStr));
        const admitted = new Set(candidates);
        const routable = new Set(routableCandidates);
        deadlineRankTrace = {
          ranked: fitFirstDecision.ranked.map((entry, index) => ({
            provider: entry.candidate.provider,
            model: entry.candidate.model,
            before: before.get(entry)!,
            after: index + 1,
            evidence: entry.factors.deadlineResponsiveness ?? null,
          })),
          excludedBeforeScoring: [
            ...expandedTargets
              .filter((target) => !eligible.has(target))
              .map((target) => ({
                model: target.modelStr,
                reason: "request_compatibility",
              })),
            ...eligibleTargets
              .filter((target) => !expandedModels.has(target.modelStr))
              .map((target) => ({
                model: target.modelStr,
                reason: "no_visible_connection_candidate",
              })),
            ...expandedCandidates
              .filter((candidate) => !admitted.has(candidate))
              .map((candidate) => ({
                model: candidate.modelStr,
                reason: "zero_cost_admission",
              })),
            ...candidates
              .filter((candidate) => !routable.has(candidate))
              .map((candidate) => ({
                model: candidate.modelStr,
                reason: "quota_cutoff",
              })),
          ],
        };
      }
      routableCandidates.forEach((candidate, index) => {
        if (!availability[index].available) {
          fitFirstDecision?.excluded.push({
            provider: candidate.provider,
            model: candidate.model,
            reason: availability[index].reason,
          });
        }
      });
      const winner = fitFirstDecision.ranked[0];
      if (!winner) {
        const incompatible = availability.find((entry) => entry.reason.startsWith("request_"));
        if (incompatible && availability.every((entry) => entry.reason.startsWith("request_"))) {
          // COMPAT_REFUSAL_DIAGNOSTICS: every candidate refused; log which reason each gave.
          log.warn("COMBO", "fit-first: every candidate refused request features", {
            combo: combo?.name,
            candidates: routableCandidates.map((candidate, index) => ({
              provider: candidate.provider,
              model: candidate.model,
              reason: availability[index].reason,
            })),
          });
          return {
            earlyResponse: requestCompatibilityErrorResult(
              new RequestCompatibilityError(
                incompatible.reason as "request_required_control_unsupported"
              )
            ).response,
          };
        }
        // The diagnostic serializer caps model detail. Keep each distinct reason
        // visible before repeated exclusions from a large provider catalog.
        const firstExclusions = new Map<string, (typeof fitFirstDecision.excluded)[number]>();
        for (const entry of fitFirstDecision.excluded) {
          if (!firstExclusions.has(entry.reason)) firstExclusions.set(entry.reason, entry);
        }
        const representatives = new Set(firstExclusions.values());
        return {
          // Availability is boolean here. Preserve 503 rather than inventing a
          // provider 429, cooldown duration or recovery promise. Expose only the
          // existing sanitized candidate identifiers and enumerated exclusions.
          earlyResponse: errorResponseWithComboDiagnostics(
            503,
            incompatible
              ? "No verified zero-additional-cost model is currently eligible: some targets cannot preserve required request features; the remaining targets are unavailable or excluded. See candidate diagnostics."
              : "No verified zero-additional-cost model is currently eligible for this request. See candidate diagnostics.",
            {
              poolSize: routableCandidates.length,
              attempted: 0,
              excluded: [
                ...representatives,
                ...fitFirstDecision.excluded.filter((entry) => !representatives.has(entry)),
              ],
              attemptOrder: [],
              terminalReason: "no_eligible_zero_cost_model",
            }
          ),
        };
      }
      selectedProvider = winner.candidate.provider;
      selectedModel = winner.candidate.model;
      selectedConnectionId = winner.candidate.connectionId ?? null;
      selectionReason = `fit-first-free score=${winner.factors.score.toFixed(3)} task=${fitFirstDecision.taskType} source=${fitFirstDecision.taskSource} level=${fitFirstDecision.taskLevel}`;
      autoUsedExplicitRouter = true;
    }

    // When overflow candidates are retained beside a raw-fit/unknown candidate,
    // prefer the largest healthy KNOWN window. That gives chatCore a deterministic compression budget and
    // prevents unknown metadata from masquerading as unlimited context. Respect
    // explicit router/budget policies by leaving those paths to their own logic.
    if (
      (!selectedProvider || !selectedModel) &&
      requiresPerTargetCompression &&
      routingStrategy === "rules" &&
      budgetCap === undefined
    ) {
      const staticallyHealthyKnownCandidates = routableCandidates.filter((candidate) => {
        const contextLimit = getModelContextLimitForModelString(candidate.modelStr);
        return (
          contextLimit !== null &&
          candidate.statusPenalty !== true &&
          String(candidate.circuitBreakerState || "CLOSED").toUpperCase() !== "OPEN"
        );
      });
      const healthChecks = await Promise.all(
        staticallyHealthyKnownCandidates.map(async (candidate) => {
          const target =
            eligibleTargets.find((entry) => entry.executionKey === candidate.executionKey) ||
            eligibleTargets.find(
              (entry) =>
                entry.stepId === candidate.stepId ||
                (entry.provider === candidate.provider && entry.modelStr === candidate.modelStr)
            );
          const rawModel = parseModel(candidate.modelStr).model || candidate.modelStr;
          if (
            resilienceSettings?.providerCooldown?.enabled === true &&
            isProviderInCooldown(
              candidate.provider,
              candidate.connectionId ?? undefined,
              resilienceSettings
            )
          ) {
            return false;
          }
          if (
            candidate.provider &&
            rawModel &&
            isModelLocked(candidate.provider, candidate.connectionId || "", rawModel)
          ) {
            return false;
          }
          if (isModelAvailable && target) {
            return Boolean(await isModelAvailable(candidate.modelStr, target));
          }
          return true;
        })
      );
      const healthyKnownCandidates = staticallyHealthyKnownCandidates.filter(
        (_candidate, index) => healthChecks[index]
      );
      const preferredKnownCandidates = healthyKnownCandidates.some(
        (candidate) => candidate.quotaSoftPenalty !== true
      )
        ? healthyKnownCandidates.filter((candidate) => candidate.quotaSoftPenalty !== true)
        : healthyKnownCandidates;
      const compressionTarget = [...preferredKnownCandidates].sort(
        (a, b) =>
          (getModelContextLimitForModelString(b.modelStr) ?? 0) -
          (getModelContextLimitForModelString(a.modelStr) ?? 0)
      )[0];
      if (compressionTarget) {
        const parsed = parseModel(compressionTarget.modelStr);
        selectedProvider = compressionTarget.provider;
        selectedModel = parsed.model || compressionTarget.model;
        selectedConnectionId = compressionTarget.connectionId ?? null;
        selectionReason = `compression-aware context=${getModelContextLimitForModelString(compressionTarget.modelStr)}`;
        // Protect this primary from the later task-aware pass, whose raw-token
        // penalty otherwise favors unknown-context targets again.
        autoUsedExplicitRouter = true;
      }
    }

    if ((!selectedProvider || !selectedModel) && routingStrategy !== "rules") {
      try {
        const decision = selectWithStrategy(
          routableCandidates,
          {
            taskType,
            requestHasTools,
            lastKnownGoodProvider,
            estimatedInputTokens,
            sla: slaPolicy,
          },
          routingStrategy
        );
        selectedProvider = decision.provider;
        selectedModel = decision.model;
        selectedConnectionId = decision.connectionId ?? null;
        selectionReason = decision.reason;
        autoUsedExplicitRouter = true;
      } catch (err) {
        log.warn(
          "COMBO",
          `Auto strategy '${routingStrategy}' failed (${err?.message || "unknown"}), falling back to rules`
        );
      }
    }

    if (!selectedProvider || !selectedModel) {
      let selection;
      try {
        selection = selectAutoProvider(
          {
            id: combo.id || combo.name,
            name: combo.name,
            type: "auto",
            candidatePool,
            weights,
            modePack,
            budgetCap,
            budgetFallback,
            explorationRate,
            selectionPolicy,
          },
          routableCandidates,
          taskType
        );
      } catch (err) {
        // #3470: `budgetFallback: "strict"` refuses to select when every candidate
        // exceeds `budgetCap` — surface a clear cost-exceeds-budget response
        // instead of letting it propagate as an unhandled 500.
        if (err instanceof BudgetExceededError) {
          return { earlyResponse: errorResponse(402, err.message) };
        }
        throw err;
      }
      selectedProvider = selection.provider;
      selectedModel = selection.model;
      selectedConnectionId = selection.connectionId ?? null;
      selectionReason = `score=${selection.score.toFixed(3)}${selection.isExploration ? " (exploration)" : ""}`;
    }

    // Complexity-aware routing (2026, opt-in): classify the request's
    // difficulty and feed a tier hint into scoring so tierAffinity /
    // specificityMatch favor candidates whose tier matches the request.
    const autoManifestHint: RoutingHint | null =
      config.complexityAwareRouting === true
        ? buildComplexityRoutingHint(
            eligibleTargets.filter((t) => t.kind === "model"),
            body,
            log
          )
        : null;

    const candidateBackedTargets = candidates
      .map((candidate) => targetForCandidate(candidate, eligibleTargets))
      .filter((target): target is ResolvedComboTarget => target !== null);
    const scoredTargets = fitFirstDecision
      ? fitFirstDecision.ranked
          .map((entry) => {
            const target = targetForCandidate(
              entry.candidate as AutoProviderCandidate,
              eligibleTargets
            );
            if (
              target &&
              strictCentralPolicy.enabled &&
              strictCentralPolicy.localFallbackPolicy === "last"
            ) {
              target.allowedConnectionIds = target.connectionId ? [target.connectionId] : [];
            }
            return target ? { target, score: entry.factors.score } : null;
          })
          .filter(
            (entry): entry is { target: ResolvedComboTarget; score: number } => entry !== null
          )
      : scoreAutoTargets(eligibleTargets, routableCandidates, taskType, weights, autoManifestHint);
    const rankedTargets = scoredTargets.map((entry) => entry.target);
    const selectedTarget =
      scoredTargets.find((entry) => {
        const parsed = parseModel(entry.target.modelStr);
        const modelId = parsed.model || entry.target.modelStr;
        return (
          entry.target.provider === selectedProvider &&
          modelId === selectedModel &&
          (!selectedConnectionId || entry.target.connectionId === selectedConnectionId)
        );
      })?.target ||
      rankedTargets[0] ||
      candidateBackedTargets[0];
    if (!selectedTarget) {
      return {
        earlyResponse: unavailableResponse(
          429,
          "No auto strategy targets remained after quota cutoff filtering"
        ),
      };
    }

    // Keep candidate-backed targets as the last-resort fallback tail: dedupe
    // drops the routable ranked ones, while quota-blocked candidates still
    // survive as a final fallback. Raw eligibleTargets are intentionally not
    // appended because buildAutoCandidates is the visibility/connection
    // admission gate; appending the raw pool re-admitted hidden models.
    const fallbackTail = fitFirstDecision ? rankedTargets : candidateBackedTargets;
    orderedTargets = dedupeTargetsByExecutionKey(
      [selectedTarget, ...rankedTargets, ...fallbackTail].filter(
        (entry): entry is ResolvedComboTarget => entry !== undefined && entry !== null
      )
    );

    if (fitFirstDecision) {
      const winner = fitFirstDecision.ranked[0];
      const routingRecord = {
        requestId:
          typeof relayOptions?.routingRequestId === "string"
            ? relayOptions.routingRequestId
            : randomUUID(),
        taskType: fitFirstDecision.taskType,
        comboId: combo.id || combo.name,
        providerSelected: winner.candidate.provider,
        modelSelected: winner.candidate.model,
        score: winner.factors.score,
        factors: {
          policy: "fit-first-free",
          taskSource: fitFirstDecision.taskSource,
          taskProfileSource: fitFirstDecision.taskProfileSource,
          taskProfileFallbackReason: fitFirstDecision.taskProfileFallbackReason,
          taskProfileConfidence: fitFirstDecision.taskProfileConfidence,
          // Enum-only operation interpretation is advisory; configured,
          // validated interpreter output keeps its separate source above.
          deterministicTaskIntent: fitFirstDecision.taskIntent,
          executionPreferences: structuralTask?.executionPreferences,
          resourceNormalization: structuralTask?.resourceNormalization,
          capabilityFreshness: "not_attested_by_resolver",
          answerQualityEvidence: "unavailable",
          taskLevel: fitFirstDecision.taskLevel,
          taskReasons: fitFirstDecision.taskReasons,
          requiredCapabilities: fitFirstDecision.requiredCapabilities,
          winner: winner.factors,
          winnerProvenance: winner.candidate.provenance ?? null,
          primaryReservations: [],
          alternatives: fitFirstDecision.ranked.slice(1, 6).map((entry) => ({
            provider: entry.candidate.provider,
            model: entry.candidate.model,
            score: entry.factors.score,
            ...(entry.factors.responsiveness && { responsiveness: entry.factors.responsiveness }),
            ...(entry.factors.deadlineResponsiveness && {
              deadlineResponsiveness: entry.factors.deadlineResponsiveness,
            }),
            provenance: entry.candidate.provenance ?? null,
          })),
          excluded: fitFirstDecision.excluded,
          ...(deadlineRankTrace && { deadlineRankTrace }),
        },
        source: "auto-fit-first",
      };
      queueMicrotask(() => {
        try {
          recordRoutingDecision(routingRecord);
        } catch (err) {
          log.warn(
            "COMBO",
            `Failed to persist fit-first-free routing decision: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      });
    }

    log.info(
      "COMBO",
      `Auto selection: ${selectedTarget?.modelStr || `${selectedProvider}/${selectedModel}`} | intent=${intent} task=${taskType} | strategy=${routingStrategy} | ${selectionReason}`
    );
  }

  deps.signal?.throwIfAborted();
  return { orderedTargets, autoUsedExplicitRouter };
}
