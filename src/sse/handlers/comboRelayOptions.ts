/**
 * Build the optional relay metadata passed from the HTTP/auth layer into combo.ts.
 *
 * Same-terminal continuity is a priority strategy, not a context-relay strategy.
 * Before TRACKER44_SESSION_PLUMBING_V1, priority combos never received relayOptions,
 * so their gate could not see the x-omniroute-session value already resolved by AUTH.
 */
export type ComboRelayOptionInput = {
  combo: {
    strategy?: unknown;
    same_terminal_continuity?: unknown;
  };
  relayConfig: Record<string, unknown> | null;
  sessionId: string | null;
  sessionAffinityKey: string | null;
  bypassProviderQuotaPolicy: boolean;
  perRequestAutoControls: Record<string, unknown>;
};

export type BuiltComboRelayOptions = Record<string, unknown> & {
  sessionId?: string | null;
  config?: Record<string, unknown> | null;
  bypassProviderQuotaPolicy?: boolean;
};

export function buildComboRelayOptions({
  combo,
  relayConfig,
  sessionId,
  sessionAffinityKey,
  bypassProviderQuotaPolicy,
  perRequestAutoControls,
}: ComboRelayOptionInput): BuiltComboRelayOptions | undefined {
  const isContextRelay = combo.strategy === "context-relay";
  const sameTerminalContinuityEnabled = combo.same_terminal_continuity === true;
  const hasAutoControls = Object.keys(perRequestAutoControls).length > 0;

  if (
    !isContextRelay &&
    !sameTerminalContinuityEnabled &&
    !bypassProviderQuotaPolicy &&
    !hasAutoControls
  ) {
    return undefined;
  }

  return {
    ...(isContextRelay ? { sessionId, config: relayConfig } : {}),
    // AUTH has already applied precedence and provenance prefixes here. Passing
    // sessionId instead would lose the header: identity used by account affinity.
    ...(sameTerminalContinuityEnabled ? { sessionId: sessionAffinityKey } : {}),
    ...(bypassProviderQuotaPolicy ? { bypassProviderQuotaPolicy: true } : {}),
    ...perRequestAutoControls,
  };
}
