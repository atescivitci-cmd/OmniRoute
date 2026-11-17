import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped provenance for usage rows.
 *
 * The routing evidence canary drives the real chat pipeline, which writes its `usage_history` and
 * `call_logs` rows from several places (streaming, non-streaming, failure paths). Rather than
 * thread a flag through each of them, the canary runs a probe inside this context and the row
 * writers read it. Async continuations created inside the context, including fire-and-forget
 * writes and stream callbacks, inherit it.
 *
 * The storage lives on `globalThis` under a registered symbol because the canary starts from the
 * instrumentation bundle while the pipeline runs from the route bundle. A module-local instance
 * would be a different copy in each, and the pipeline would never see the value.
 */

const STORAGE_KEY = Symbol.for("omniroute.usageSourceContext");

type GlobalWithStorage = typeof globalThis & {
  [STORAGE_KEY]?: AsyncLocalStorage<string>;
};

function getStorage(): AsyncLocalStorage<string> {
  const holder = globalThis as GlobalWithStorage;
  if (!holder[STORAGE_KEY]) holder[STORAGE_KEY] = new AsyncLocalStorage<string>();
  return holder[STORAGE_KEY];
}

/** Run `callback` so every usage row written for it carries `source`. */
export function runWithUsageSource<TResult>(source: string, callback: () => TResult): TResult {
  return getStorage().run(source, callback);
}

/** The provenance bound to the current async context, or null for ordinary traffic. */
export function getUsageSource(): string | null {
  return getStorage().getStore() ?? null;
}
