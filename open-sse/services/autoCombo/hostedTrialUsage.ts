import { AsyncLocalStorage } from "node:async_hooks";
const usage = new AsyncLocalStorage<boolean>();
export type ConfiguredAccountPolicy = Readonly<{
  enabled: boolean;
  providers: readonly string[] | null;
}>;
const accountPolicy = new AsyncLocalStorage<ConfiguredAccountPolicy>();
export function captureConfiguredAccountPolicy(): ConfiguredAccountPolicy {
  return accountPolicy.getStore() ?? Object.freeze({ enabled: false, providers: null });
}
export function configuredAccountProviderAllowed(provider: string): boolean {
  const policy = captureConfiguredAccountPolicy();
  return (
    policy.enabled &&
    (policy.providers === null || policy.providers.includes(provider.toLowerCase()))
  );
}
export function runWithCapturedAccountPolicy<T>(
  policy: ConfiguredAccountPolicy,
  execute: () => T
): T {
  const current = captureConfiguredAccountPolicy();
  const providers =
    current.providers === null
      ? policy.providers
      : policy.providers === null
        ? current.providers
        : current.providers.filter((p) => policy.providers!.includes(p));
  return accountPolicy.run(
    Object.freeze({
      enabled: current.enabled && policy.enabled,
      providers: providers === null ? null : Object.freeze([...providers]),
    }),
    execute
  );
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
/** Only stored server combo policy; NEVER request headers/body or plugin output.
 * Nested routing cannot upgrade a non-trial parent into trial access. */
export function runWithHostedTrialUsage<T>(combo: unknown, execute: () => T): T {
  const c = record(combo) ? combo : {};
  const cfg = record(c.config) ? c.config : {};
  const source = record(c.autoConfig) ? c.autoConfig : record(cfg.auto) ? cfg.auto : cfg;
  const declared =
    source.selectionPolicy === "fit-first-free" &&
    source.localFallbackPolicy === "last" &&
    source.hostedTrialUsage === "prototype-development";
  const parent = accountPolicy.getStore();
  const configured = source.costAdmissionMode === "configured-accounts";
  const allowed = Array.isArray(c.allowedProviders)
    ? c.allowedProviders
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.toLowerCase())
    : null;
  const providers =
    parent?.providers == null
      ? allowed
      : allowed === null
        ? parent.providers
        : allowed.filter((p) => parent.providers!.includes(p));
  const policy = Object.freeze({
    enabled: configured && parent?.enabled !== false,
    providers: providers === null ? null : Object.freeze([...providers]),
  });
  return accountPolicy.run(policy, () =>
    usage.run(declared && usage.getStore() !== false, execute)
  );
}
export function isHostedTrialUsage(): boolean {
  return usage.getStore() === true;
}
