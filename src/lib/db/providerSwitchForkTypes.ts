// ── CLAUDE_SESSION_AFFINITY_V2 — SHARED FORK TYPES (2026-08-30) ─────────────────────────
// Types only. No behaviour, no imports, no DB access.
//
// Extracted 2026-08-30 in response to Codex's second audit (Blocker 1): the DB module
// (src/lib/db/providerSwitchForks.ts) previously imported ProviderSwitchForkRecord
// directly from open-sse/services/providerSwitchFork.ts -- a database module importing
// service implementation code, and via a relative path that was wrong for the real
// production tree layout besides. Both the service module and the DB module now import
// these types from here instead, so neither depends on the other's implementation.
//
// Placement follows the package's own convention for types-only DB modules
// (cf. the real src/lib/db/_rowTypes.ts).

export type ForkState = "PREPARED" | "COMMITTED" | "ROLLED_BACK";

export interface ProviderSwitchForkRecord {
  id: string;
  sessionId: string;
  comboName: string;
  state: ForkState;
  sourceProvider: string;
  sourceModel: string;
  targetProvider: string;
  targetModel: string;
  sourceHash: string;
  sanitizedHash: string;
  messageCount: number;
  toolCount: number;
  reason: string;
  preparedAt: string;
  committedAt: string | null;
  rolledBackAt: string | null;
  errorCode: string | null;
}

/** Durable notification outbox row state (see migration 135). */
export type OutboxState = "PENDING" | "CLAIMED" | "DELIVERED";

export interface ProviderSwitchOutboxRow {
  forkId: string;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  deliveredAt: string | null;
  lastError: string | null;
}
