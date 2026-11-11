/** Exact observed account/model rejection; generic 400 is never durable evidence. */
export const ACCOUNT_MODEL_INELIGIBLE_CODE = "account_model_ineligible";
export const LOCAL_ACCOUNT_NEGATIVE_RESPONSES = new WeakSet<Response>();
export function isCodexAccountModelUnsupported(
  provider: unknown,
  status: unknown,
  model: unknown,
  message: unknown
): boolean {
  if (
    provider !== "codex" ||
    status !== 400 ||
    typeof model !== "string" ||
    !model ||
    model.length > 300 ||
    typeof message !== "string" ||
    message.length > 8192
  )
    return false;
  let detail = message;
  try {
    const parsed: unknown = JSON.parse(message);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const value = parsed as { detail?: unknown; error?: { message?: unknown } };
    if (typeof value.detail === "string") detail = value.detail;
    else if (value.error && typeof value.error.message === "string") detail = value.error.message;
    else return false;
  } catch {
    if (/^\s*[\[{]/.test(message)) return false;
  }
  const match =
    /^The '([^'\x00-\x1f\x7f]{1,300})' model is not supported when using Codex with a ChatGPT account\.$/.exec(
      detail
    );
  return !!match && match[0] === detail && match[1] === model;
}
export function hasAccountModelIdentityUpdate(
  data: Record<string, unknown>,
  previous: Record<string, unknown>,
  merged: Record<string, unknown>
): boolean {
  if (
    ["provider", "authType", "apiKey", "accessToken", "refreshToken", "idToken"].some((key) =>
      Object.hasOwn(data, key)
    )
  )
    return true;
  if (!Object.hasOwn(data, "providerSpecificData")) return false;
  const before = previous.providerSpecificData as Record<string, unknown> | null;
  const after = merged.providerSpecificData as Record<string, unknown> | null;
  // Compare only nonsecret effective identity/routing fields, never the whole object.
  return [
    "workspaceId",
    "chatgptUserId",
    "workspacePlanType",
    "baseUrl",
    "targetFormat",
    "cliproxyapiMode",
  ].some((key) => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null));
}

// Recheck ordinary eligibility after at most 30 minutes; this is a negative-cache
// TTL, not an entitlement grant or a transport retry. No background probe runs.
export const ACCOUNT_MODEL_NEGATIVE_TTL_MS = 30 * 60 * 1000;

/** Advance elapsed time monotonically within this process despite wall-clock rollback. */
export function createAccountEvidenceClock(
  wall: () => number = () => Date.now(),
  monotonic: () => number = () => performance.now()
): () => number | null {
  let lastEffective: number | null = null;
  let lastMonotonic: number | null = null;
  return () => {
    let currentWall: number;
    let currentMonotonic: number;
    try {
      currentWall = wall();
      currentMonotonic = monotonic();
    } catch {
      return null;
    }
    if (
      !Number.isSafeInteger(currentWall) ||
      currentWall < 0 ||
      currentWall > 8640000000000000 ||
      !Number.isFinite(currentMonotonic) ||
      currentMonotonic < 0 ||
      (lastMonotonic !== null && currentMonotonic < lastMonotonic)
    )
      return null;
    const effective =
      lastEffective === null
        ? currentWall
        : Math.max(currentWall, lastEffective + currentMonotonic - lastMonotonic!);
    if (effective > 8640000000000000) return null;
    lastEffective = effective;
    lastMonotonic = currentMonotonic;
    return Math.floor(effective);
  };
}

export function hasCurrentAccountProofTime(
  value: { capturedAt?: unknown },
  now: number | null
): boolean {
  return (
    now !== null &&
    Number.isSafeInteger(now) &&
    typeof value.capturedAt === "number" &&
    Number.isSafeInteger(value.capturedAt) &&
    value.capturedAt >= 0 &&
    now >= value.capturedAt &&
    now - value.capturedAt < ACCOUNT_MODEL_NEGATIVE_TTL_MS
  );
}

export function hasFreshAccountNegativeTime(
  value: { capturedAt?: unknown; observedAt?: unknown },
  now: number | null
): boolean {
  if (!hasCurrentAccountProofTime(value, now) || typeof value.observedAt !== "string") return false;
  const observedAt = Date.parse(value.observedAt);
  return (
    Number.isFinite(observedAt) &&
    new Date(observedAt).toISOString() === value.observedAt &&
    observedAt >= (value.capturedAt as number) &&
    observedAt <= now!
  );
}
