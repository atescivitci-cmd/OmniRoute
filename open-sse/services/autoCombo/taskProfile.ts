/** Validated advisory classification. It is never authorization or capability evidence. */
export const TASK_TYPES = [
  "coding",
  "debugging",
  "review",
  "planning",
  "analysis",
  "documentation",
  "math",
  "creative",
  "general",
] as const;
export const TASK_LEVELS = ["light", "standard", "heavy", "critical"] as const;
export const TASK_CAPABILITIES = ["vision", "tools", "reasoning"] as const;
export interface TaskProfile {
  taskType: (typeof TASK_TYPES)[number];
  complexity: (typeof TASK_LEVELS)[number];
  requiredCapabilities: Array<(typeof TASK_CAPABILITIES)[number]>;
  confidence: number;
}
export interface TaskInterpreter {
  // Only a caller-supplied, separately authorized interpreter may perform I/O.
  // Production does not configure one in this change. Timeout is not proof it stopped.
  interpret(
    request: Record<string, unknown>,
    options: { signal: AbortSignal; deadlineMs: number }
  ): Promise<unknown>;
}
export interface TaskProfileResolution {
  profile: TaskProfile;
  source: "interpreter" | "deterministic";
  fallbackReason: "not_configured" | "invalid_profile" | "timeout" | "interpreter_error" | null;
}
export function validateTaskProfile(value: unknown): TaskProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "complexity,confidence,requiredCapabilities,taskType")
    return null;
  if (
    !TASK_TYPES.includes(v.taskType as TaskProfile["taskType"]) ||
    !TASK_LEVELS.includes(v.complexity as TaskProfile["complexity"])
  )
    return null;
  if (
    typeof v.confidence !== "number" ||
    !Number.isFinite(v.confidence) ||
    v.confidence < 0 ||
    v.confidence > 1
  )
    return null;
  if (
    !Array.isArray(v.requiredCapabilities) ||
    v.requiredCapabilities.length > 3 ||
    !v.requiredCapabilities.every((c) => TASK_CAPABILITIES.includes(c))
  )
    return null;
  return {
    taskType: v.taskType as TaskProfile["taskType"],
    complexity: v.complexity as TaskProfile["complexity"],
    confidence: v.confidence,
    requiredCapabilities: [...new Set(v.requiredCapabilities)].sort(),
  };
}
export async function resolveTaskProfile(args: {
  body: Record<string, unknown>;
  fallback: TaskProfile;
  interpreter?: TaskInterpreter;
  signal?: AbortSignal | null;
  budgetMs?: number;
}): Promise<TaskProfileResolution> {
  args.signal?.throwIfAborted();
  const fallback = (reason: TaskProfileResolution["fallbackReason"]): TaskProfileResolution => ({
    profile: args.fallback,
    source: "deterministic",
    fallbackReason: reason,
  });
  if (!args.interpreter) return fallback("not_configured");
  const budget = Number.isFinite(args.budgetMs) ? Math.max(0, Math.min(250, args.budgetMs!)) : 250;
  if (budget === 0) return fallback("timeout");
  const started = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const control = new Promise<never>((_, reject) => {
      onAbort = () => {
        controller.abort(args.signal?.reason);
        reject(args.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      args.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new DOMException("Task interpretation deadline", "TimeoutError"));
      }, budget);
    });
    args.signal?.throwIfAborted();
    // A copy prevents an advisory implementation from rewriting the inference payload.
    const request = structuredClone(args.body);
    const result = await Promise.race([
      Promise.resolve().then(() => {
        args.signal?.throwIfAborted();
        if (performance.now() - started >= budget || timedOut) {
          timedOut = true;
          controller.abort();
          throw new DOMException("Task interpretation deadline", "TimeoutError");
        }
        return args.interpreter!.interpret(request, {
          signal: controller.signal,
          deadlineMs: budget,
        });
      }),
      control,
    ]);
    args.signal?.throwIfAborted();
    if (performance.now() - started >= budget) {
      controller.abort();
      return fallback("timeout");
    }
    const profile = validateTaskProfile(result);
    return profile
      ? { profile, source: "interpreter", fallbackReason: null }
      : fallback("invalid_profile");
  } catch (error) {
    args.signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError" && !controller.signal.aborted)
      throw error;
    return fallback(
      timedOut || (error instanceof Error && error.name === "TimeoutError")
        ? "timeout"
        : "interpreter_error"
    );
  } finally {
    clearTimeout(timer);
    if (onAbort) args.signal?.removeEventListener("abort", onAbort);
  }
}
