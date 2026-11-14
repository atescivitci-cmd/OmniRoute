/**
 * Per-call and per-model cost recording for call_logs.
 *
 * The figure stored is an ESTIMATE, labelled by cost_source:
 *   provider_reported  the provider sent an exact cost with the usage
 *   pricing_table      tokens x the configured price for provider/model (list price, so
 *                      subscription-backed traffic gets a notional amount, not a bill)
 *   unpriced           usage was present but no price applies (free or local models), or
 *                      pricing could not be read; cost is 0, or null when pricing failed
 *   no_usage           the call reported no token usage (most failures)
 * Recording is best effort and never changes how a request is served.
 */
import { calculateCost, extractExactCostUsd } from "./costCalculator";

export type CallCostSource = "provider_reported" | "pricing_table" | "unpriced" | "no_usage";

export interface CallCost {
  costUsd: number | null;
  costSource: CallCostSource;
}

type Usage = Record<string, number | undefined>;
type CostFn = (provider: string, model: string, tokens: Usage) => Promise<number>;

function hasUsage(tokens: unknown): tokens is Usage {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return false;
  return Object.values(tokens as Record<string, unknown>).some(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
}

export async function resolveCallCost(
  provider: string | null | undefined,
  model: string | null | undefined,
  tokens: unknown,
  deps: { calculateCost?: CostFn } = {}
): Promise<CallCost> {
  if (!hasUsage(tokens) || !provider || !model) return { costUsd: null, costSource: "no_usage" };
  const costOf: CostFn = deps.calculateCost ?? ((p, m, t) => calculateCost(p, m, t));
  try {
    const costUsd = await costOf(provider, model, tokens);
    if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0)
      return { costUsd: null, costSource: "unpriced" };
    if (extractExactCostUsd(tokens) !== null) return { costUsd, costSource: "provider_reported" };
    return { costUsd, costSource: costUsd > 0 ? "pricing_table" : "unpriced" };
  } catch {
    return { costUsd: null, costSource: "unpriced" };
  }
}

export interface ModelCostRow {
  provider: string;
  model: string;
  calls: number;
  costedCalls: number;
  costUsd: number;
}

interface SqlDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** Per provider/model totals since an ISO timestamp. costedCalls counts calls that carry a figure. */
export function getCostByModel(db: SqlDb, sinceIso: string): ModelCostRow[] {
  const rows = db
    .prepare(
      `SELECT provider, model, COUNT(*) AS calls,
              SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS costedCalls,
              COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM call_logs
        WHERE timestamp >= ? AND model != 'connection-test'
        GROUP BY provider, model
        ORDER BY costUsd DESC, calls DESC`
    )
    .all(sinceIso) as ModelCostRow[];
  return rows.map((row) => ({
    provider: String(row.provider),
    model: String(row.model),
    calls: Number(row.calls),
    costedCalls: Number(row.costedCalls),
    costUsd: Number(row.costUsd),
  }));
}
