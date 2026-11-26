/** Age of quality-score rows (shared by the feed status and the ranking decision factors). */

/** Quality data older than this is reported stale (two missed daily syncs). */
export const QUALITY_STALE_AFTER_HOURS = 48;

/** Hours since a SQLite `datetime('now')` value (UTC, no zone suffix) or an ISO time. */
export function ageHours(syncedAt: string | null | undefined, now = Date.now()): number | null {
  if (!syncedAt) return null;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(syncedAt) ? syncedAt : `${syncedAt.replace(" ", "T")}Z`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, (now - parsed) / 3_600_000);
}
