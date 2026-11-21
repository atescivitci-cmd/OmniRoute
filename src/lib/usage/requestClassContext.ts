import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped request class for usage rows.
 *
 * Same mechanism as usageSourceContext.ts, for the same reason: usage rows are written from
 * several places (streaming, non-streaming, failure paths, deadline cancels) and none of them
 * should need an extra argument. The chat core sets the class once per request and the row writer
 * reads it. Async continuations created inside the context, including fire-and-forget writes and
 * stream callbacks, inherit it.
 *
 * The storage lives on `globalThis` under a registered symbol because the pipeline can be
 * bundled into more than one chunk; a module-local instance would be a different copy in each.
 * The value is derived from the request body by deriveRequestClass, never taken from a header.
 */

const STORAGE_KEY = Symbol.for("omniroute.requestClassContext");

type GlobalWithStorage = typeof globalThis & {
  [STORAGE_KEY]?: AsyncLocalStorage<string>;
};

function getStorage(): AsyncLocalStorage<string> {
  const holder = globalThis as GlobalWithStorage;
  if (!holder[STORAGE_KEY]) holder[STORAGE_KEY] = new AsyncLocalStorage<string>();
  return holder[STORAGE_KEY];
}

/** Run `callback` so every usage row written for it carries `requestClass`. */
export function runWithRequestClass<TResult>(
  requestClass: string,
  callback: () => TResult
): TResult {
  return getStorage().run(requestClass, callback);
}

/** The request class bound to the current async context, or null. */
export function getRequestClass(): string | null {
  return getStorage().getStore() ?? null;
}
