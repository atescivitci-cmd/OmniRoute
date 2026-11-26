/**
 * chatCore streaming per-request cost recording (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's onStreamComplete: resolves the real per-request cost for a
 * completed streaming response and records it against the api key. onStreamComplete is synchronous,
 * so this is a sync fire-and-forget driven through calculateCost().then().catch() that never throws
 * to the caller. calculateCost and recordCost are injected so the hook stays decoupled. Behaviour
 * is byte-identical to the previous inline block, plus the cash cost: the connection's
 * operator-set cash class (absent = metered) decides whether the estimate is real money.
 */

import { cashCostFor, resolveCashClass, type CashClass } from "@/lib/usage/cashCost";

type CostResolver = (
  provider: string,
  model: string,
  usage: Record<string, number | undefined> | null | undefined,
  options: { serviceTier?: string }
) => Promise<number>;

export function recordStreamingCost(args: {
  apiKeyId: string | null | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  streamUsage: Record<string, number | undefined> | null | undefined;
  serviceTier?: string;
  /** Connection cash class; omitted means metered (cash cost = estimate). */
  cashClass?: CashClass;
  /** Provider of the serving connection, recorded for share limits (falls back to provider). */
  costProvider?: string | null;
  calculateCost: CostResolver;
  recordCost: (apiKeyId: string, cost: number, cashCost?: number, provider?: string) => void;
}): void {
  if (!args.apiKeyId || !args.streamUsage) return;

  const apiKeyId = args.apiKeyId;
  args
    .calculateCost(args.provider, args.model, args.streamUsage, { serviceTier: args.serviceTier })
    .then((estimatedCost) => {
      if (estimatedCost > 0)
        args.recordCost(
          apiKeyId,
          estimatedCost,
          cashCostFor(estimatedCost, args.cashClass ?? "metered"),
          args.costProvider || args.provider || undefined
        );
    })
    .catch(() => {});
}

/**
 * Non-streaming counterpart: record `cost` for `apiKeyId` with the cash cost of the connection that
 * served the request (its operator-set providerSpecificData.cashClass; absent = metered).
 */
export function recordConnectionCost(
  recordCost: (apiKeyId: string, cost: number, cashCost?: number, provider?: string) => void,
  apiKeyId: string,
  cost: number,
  credentials: { providerSpecificData?: unknown; provider?: unknown } | null | undefined
): void {
  recordCost(
    apiKeyId,
    cost,
    cashCostFor(cost, resolveCashClass(credentials?.providerSpecificData)),
    typeof credentials?.provider === "string" ? credentials.provider : undefined
  );
}
