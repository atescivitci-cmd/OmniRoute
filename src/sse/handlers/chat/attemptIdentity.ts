type AttemptIdentityOptions = {
  attemptId?: string | null;
  comboExecutionKey?: string | null;
  comboStepId?: string | null;
  [key: string]: unknown;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Resolve one stable identity before any fallback begins. */
export function resolveAttemptIdentity(
  options: AttemptIdentityOptions,
  generate: () => string = () => globalThis.crypto.randomUUID()
): string {
  return (
    nonEmpty(options.attemptId) ??
    nonEmpty(options.comboExecutionKey) ??
    nonEmpty(options.comboStepId) ??
    generate()
  );
}

/** Preserve the fixed attempt identity while allowing fallback metadata to change. */
export function carryAttemptIdentity<T extends AttemptIdentityOptions>(
  options: T,
  attemptId: string,
  overrides: Record<string, unknown> = {}
): T & { attemptId: string; comboExecutionKey: string } {
  return {
    ...options,
    ...overrides,
    attemptId,
    comboExecutionKey: attemptId,
  } as T & { attemptId: string; comboExecutionKey: string };
}
