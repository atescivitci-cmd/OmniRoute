/**
 * Cash cost: what a request costs in real money, as opposed to its list-price estimate.
 *
 * A request served by a subscription account (already paid for), a free tier or a local model
 * adds no cash cost even though `calculateCost` prices it at list rates. Budgets that should
 * only count money actually spent (cost basis "cash") need that distinction.
 *
 * The class is OPERATOR DATA on each provider connection
 * (`providerSpecificData.cashClass`), never derived from a provider or model name. A connection
 * without a valid class is treated as "metered": cash cost equals the list-price estimate. That
 * default can only over-count spend, never hide it.
 */

export const CASH_CLASSES = ["subscription", "free", "local", "metered"] as const;
export type CashClass = (typeof CASH_CLASSES)[number];
export type CostBasis = "list" | "cash";

export const COST_BASES: readonly CostBasis[] = ["list", "cash"];

export function isCashClass(value: unknown): value is CashClass {
  return typeof value === "string" && (CASH_CLASSES as readonly string[]).includes(value);
}

/** Read the operator-set cash class from a connection's providerSpecificData. */
export function resolveCashClass(providerSpecificData: unknown): CashClass {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return "metered";
  const value = (providerSpecificData as Record<string, unknown>).cashClass;
  return isCashClass(value) ? value : "metered";
}

/** Cash cost of a request whose list-price estimate is `listCost`. */
export function cashCostFor(listCost: number, cashClass: CashClass): number {
  if (!Number.isFinite(listCost) || listCost <= 0) return 0;
  return cashClass === "metered" ? listCost : 0;
}

export function normalizeCostBasis(value: unknown): CostBasis {
  return value === "cash" ? "cash" : "list";
}

/**
 * The amount a stored cost entry contributes under a cost basis. Entries recorded before cash
 * cost existed have no cash value and count at list price under the cash basis (over-count, never
 * under-count).
 */
export function entryAmount(
  entry: { cost: number; cashCost?: number | null },
  basis: CostBasis
): number {
  if (basis === "cash" && typeof entry.cashCost === "number" && Number.isFinite(entry.cashCost)) {
    return entry.cashCost;
  }
  return entry.cost;
}
