import { AsyncLocalStorage } from "node:async_hooks";
export type NativeDeadlineEvidenceContext = { deadlineAt: number; declaredBudgetMs: number };
const KEY = Symbol.for("omniroute.nativeDeadlineEvidence.v1");
const shared = globalThis as typeof globalThis & {
  [KEY]?: AsyncLocalStorage<NativeDeadlineEvidenceContext>;
};
const context =
  shared[KEY] ?? (shared[KEY] = new AsyncLocalStorage<NativeDeadlineEvidenceContext>());
export function getNativeDeadlineEvidenceContext(): NativeDeadlineEvidenceContext | undefined {
  return context.getStore();
}
export function getNativeDeadlineAt(): number | undefined {
  return context.getStore()?.deadlineAt;
}
/** Request-local observability only; never changes cancellation, reservations or dispatch. */
export function runWithNativeDeadline<T>(
  value: NativeDeadlineEvidenceContext | undefined,
  fn: () => T
): T {
  if (
    !value ||
    !Number.isSafeInteger(value.deadlineAt) ||
    !Number.isSafeInteger(value.declaredBudgetMs) ||
    value.deadlineAt <= 0 ||
    value.declaredBudgetMs <= 0
  )
    return fn();
  const prior = context.getStore();
  if (prior && prior.deadlineAt <= value.deadlineAt) return fn();
  return context.run(value, fn);
}
