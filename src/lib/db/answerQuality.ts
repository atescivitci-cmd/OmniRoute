import { randomUUID, createHash } from "node:crypto";
import { getDbInstance } from "./core";
import {
  qualityCandidateKey,
  QUALITY_TTL_MS,
  type AnswerQualityEvidence,
} from "../../../open-sse/services/autoCombo/validatedAnswerQuality";
const RECEIPTS = "answerQualityReceiptV1",
  EVENTS = "answerQualityEventV1";
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Receipt = {
  owner: string;
  combo: string;
  contract: string;
  provider: string;
  connectionId: string;
  model: string;
  at: number;
  verdict?: boolean;
};
const valid = (s: unknown, max = 300): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= max;
let lastCleanup = 0;
function cleanup(now: number) {
  if (now - lastCleanup < 60_000 && now >= lastCleanup) return;
  lastCleanup = now;
  const db = getDbInstance();
  for (const [namespace, ttl, cap] of [
    [RECEIPTS, 30 * 60_000, 10000],
    [EVENTS, QUALITY_TTL_MS, 20000],
  ] as const) {
    db.prepare(
      "DELETE FROM key_value WHERE namespace=? AND json_valid(value) AND CAST(json_extract(value,'$.at') AS REAL)<?"
    ).run(namespace, now - ttl);
    db.prepare(
      "DELETE FROM key_value WHERE namespace=? AND key NOT IN (SELECT key FROM key_value WHERE namespace=? ORDER BY CASE WHEN json_valid(value) THEN CAST(json_extract(value,'$.at') AS REAL) ELSE 0 END DESC,key DESC LIMIT ?)"
    ).run(namespace, namespace, cap);
  }
}
export function createAnswerQualityReceipt(
  input: Omit<Receipt, "at" | "verdict">,
  now = Date.now()
): string | null {
  if (Object.values(input).some((v) => !valid(v))) return null;
  const id = randomUUID(),
    db = getDbInstance();
  db.prepare("INSERT INTO key_value(namespace,key,value) VALUES(?,?,?)").run(
    RECEIPTS,
    id,
    JSON.stringify({ ...input, at: now })
  );
  cleanup(now);
  return id;
}
export function recordAnswerQuality(
  owner: string,
  id: string,
  accepted: boolean,
  reason: string,
  now = Date.now()
): "recorded" | "duplicate" | "missing" {
  if (
    typeof accepted !== "boolean" ||
    accepted !== (reason === "accepted") ||
    ![
      "accepted",
      "model_output_invalid",
      "model_evidence_invalid",
      "model_price_invalid",
      "tool_arguments_invalid",
      "gateway_shape",
      "source_validation_failed",
    ].includes(reason)
  )
    return "missing";
  const db = getDbInstance();
  return db.transaction(() => {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace=? AND key=?")
      .get(RECEIPTS, id) as { value: string } | undefined;
    if (!row) return "missing";
    const r = JSON.parse(row.value) as Receipt;
    if (r.owner !== owner || r.at > now || now - r.at > 10 * 60_000) return "missing";
    if (r.verdict !== undefined) return "duplicate";
    r.verdict = accepted;
    db.prepare("UPDATE key_value SET value=? WHERE namespace=? AND key=?").run(
      JSON.stringify(r),
      RECEIPTS,
      id
    );
    const scope = digest([r.owner, r.combo, r.contract]);
    db.prepare("INSERT INTO key_value(namespace,key,value) VALUES(?,?,?)").run(
      EVENTS,
      scope + ":" + id,
      JSON.stringify({
        at: now,
        accepted,
        reason,
        candidate: qualityCandidateKey(r.provider, r.connectionId, r.model),
      })
    );
    db.prepare(
      "DELETE FROM key_value WHERE namespace=? AND CAST(json_extract(value,'$.at') AS REAL)<?"
    ).run(EVENTS, now - QUALITY_TTL_MS);
    db.prepare(
      "DELETE FROM key_value WHERE namespace=? AND key LIKE ? AND key NOT IN (SELECT key FROM key_value WHERE namespace=? AND key LIKE ? ORDER BY CAST(json_extract(value,'$.at') AS REAL) DESC,key DESC LIMIT 128)"
    ).run(EVENTS, scope + ":%", EVENTS, scope + ":%");
    cleanup(now);
    return "recorded";
  })();
}
export function answerQualityEvidence(
  owner: string | null | undefined,
  combo: string,
  contract: string | null,
  now = Date.now()
): Map<string, AnswerQualityEvidence> {
  const out = new Map<string, AnswerQualityEvidence>();
  if (!owner || !contract) return out;
  const scope = digest([owner, combo, contract]);
  const rows = getDbInstance()
    .prepare(
      "SELECT value FROM key_value WHERE namespace=? AND key LIKE ? ORDER BY CAST(json_extract(value,'$.at') AS REAL) DESC,key DESC LIMIT 128"
    )
    .all(EVENTS, scope + ":%") as { value: string }[];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const e = JSON.parse(row.value);
    if (
      e.at > now ||
      now - e.at >= QUALITY_TTL_MS ||
      typeof e.accepted !== "boolean" ||
      !valid(e.candidate, 1200)
    )
      continue;
    const n = counts.get(e.candidate) ?? 0;
    if (n >= 16) continue;
    counts.set(e.candidate, n + 1);
    const x = out.get(e.candidate) ?? { accepted: 0, rejected: 0, latestAt: e.at };
    if (e.accepted) x.accepted++;
    else x.rejected++;
    out.set(e.candidate, x);
  }
  return out;
}
