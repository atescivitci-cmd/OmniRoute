// Narrow normal-dashboard policy editing. Never resolves credentials or dispatches models.
export type PolicyRecord = Record<string, any>;
export function stablePolicyJson(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stablePolicyJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stablePolicyJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function policyEditorIssue(combo: PolicyRecord): string | null {
  if (combo.strategy !== 'auto' || !Array.isArray(combo.models) || combo.models.length !== 0)
    return 'This editor requires an auto combo with no explicit model steps.';
  if (combo.autoConfig != null || combo.config?.auto != null)
    return 'A higher-precedence autoConfig/config.auto exists. No change will be made here.';
  if (!combo.config || typeof combo.config !== 'object' || Array.isArray(combo.config) || !Array.isArray(combo.allowedProviders))
    return 'Existing config and provider scope are required for reversible editing.';
  // The existing PUT removes these legacy fields. Do not silently change unrelated settings.
  const removed = ['queueDepth','fallbackDelayMs','handoffProviders','maxComboDepth','manifestRouting','complexityAwareRouting','pipeline_enabled','pipelineConcurrency','shadowRouting','evalRouting','resetAwareEnabled','resetAwareWindow'];
  if (removed.some(k => Object.hasOwn(combo.config, k))) return 'Legacy configuration requires separate migration; normal PUT would remove unrelated fields.';
  if (combo.config.zeroLatencyOptimizationsEnabled !== true && (combo.config.hedging === true || Number(combo.config.predictiveTtftMs) > 0 || (combo.config.fallbackCompressionMode && combo.config.fallbackCompressionMode !== 'off')))
    return 'Legacy zero-latency settings require separate normalization before this edit.';
  return null;
}
export function parsePolicyProviders(value: string): string[] {
  const result = [...new Set(value.split(',').map(x => x.trim()).filter(Boolean))];
  if (!result.length || result.length > 20 || result.some(x => !/^[a-z0-9._-]{1,100}$/i.test(x)))
    throw new Error('Enter 1–20 comma-separated provider identifiers.');
  return result;
}
export function prepareCentralPolicy(combo: PolicyRecord, allowed: string, zeroCost: string, trial: boolean) {
  const issue = policyEditorIssue(combo); if (issue) throw new Error(issue);
  const allowedProviders = parsePolicyProviders(allowed);
  const zeroAdditionalCostProviders = parsePolicyProviders(zeroCost);
  if (zeroAdditionalCostProviders.some(x => !allowedProviders.includes(x)))
    throw new Error('Each zero-additional-cost provider must also be in the allowed provider scope.');
  const config = { ...combo.config, selectionPolicy: 'fit-first-free', budgetFallback: 'strict', explorationRate: 0,
    localFallbackPolicy: 'last', compatFilterFailOpen: false, zeroAdditionalCostProviders };
  if (trial) config.hostedTrialUsage = 'prototype-development'; else delete config.hostedTrialUsage;
  return { allowedProviders, config };
}
export function policySnapshotMatches(left: PolicyRecord, right: PolicyRecord): boolean {
  const clean = (x: PolicyRecord) => { const { updatedAt, warning, ...rest } = x; return rest; };
  return stablePolicyJson(clean(left)) === stablePolicyJson(clean(right));
}
