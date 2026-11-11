/** Ordering only: never grants cost eligibility or bypasses capability admission. */
export function localFallbackTier(provider: string, policy?: "last" | null): number {
  if (policy !== "last") return 0;
  const canonical = provider.toLowerCase();
  return canonical === "ollama-local" || canonical === "ollama" ? 1 : 0;
}

/** Stable partition after affinity/eval ordering; does not admit or clone targets. */
export function enforceLocalLast<T extends { provider?: string | null }>(targets: T[], policy?: "last" | null): T[] {
  if (policy !== "last") return targets;
  return [...targets].sort((a, b) => localFallbackTier(a.provider || "", policy) - localFallbackTier(b.provider || "", policy));
}
