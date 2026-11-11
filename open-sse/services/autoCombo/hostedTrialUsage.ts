import { AsyncLocalStorage } from 'node:async_hooks';
const usage = new AsyncLocalStorage<boolean>();
const record = (v: unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Only stored server combo policy; NEVER request headers/body or plugin output.
 * Nested routing cannot upgrade a non-trial parent into trial access. */
export function runWithHostedTrialUsage<T>(combo: unknown, execute: () => T): T {
  const c = record(combo) ? combo : {};
  const cfg = record(c.config) ? c.config : {};
  const source = record(c.autoConfig) ? c.autoConfig : record(cfg.auto) ? cfg.auto : cfg;
  const declared = source.selectionPolicy === 'fit-first-free' && source.localFallbackPolicy === 'last' &&
    source.hostedTrialUsage === 'prototype-development';
  return usage.run(declared && usage.getStore() !== false, execute);
}
export function isHostedTrialUsage(): boolean { return usage.getStore() === true; }
