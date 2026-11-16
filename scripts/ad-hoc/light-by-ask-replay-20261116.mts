/**
 * Read-only replay for ROUTING_LIGHT_BY_ASK (2026-11-16).
 * Builds the representative request shapes used by tests/unit/light-by-ask-20261116.test.ts,
 * classifies each with the flag off and on, and prints which model scoreModelForTask ranks
 * first among the Claude candidates for each classified level.
 *
 * Run: node --import tsx/esm scripts/ad-hoc/light-by-ask-replay-20261116.mts
 * Uses a throwaway DATA_DIR; reads no gateway database and no credentials.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-replay-"));
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const { classifyTask, scoreModelForTask } =
  await import("../../open-sse/services/taskAwareRouting.ts");
const { FIXTURE_TABLE } = await import("../../tests/unit/_fixtures/lightByAskFixtures.ts");

const CANDIDATES = [
  "claude/claude-opus-5",
  "claude/claude-opus-4-8",
  "claude/claude-opus-4-7",
  "claude/claude-sonnet-5",
  "claude/claude-sonnet-4-6",
  "claude/claude-haiku-4-5-20251001",
];

type Task = ReturnType<typeof classifyTask>;
function winner(task: Task): string {
  // Stable ties keep original order, like reorderByTaskWeight.
  return CANDIDATES.map((m, i) => ({ m, i, score: scoreModelForTask(m, task) })).sort(
    (a, b) => b.score - a.score || a.i - b.i
  )[0].m;
}

function classify(body: Record<string, unknown>, on: boolean): Task {
  if (on) process.env.ROUTING_LIGHT_BY_ASK = "1";
  else delete process.env.ROUTING_LIGHT_BY_ASK;
  try {
    return classifyTask(body);
  } finally {
    delete process.env.ROUTING_LIGHT_BY_ASK;
  }
}

console.log("Candidates:", CANDIDATES.join(", "));
console.log("\nTop-ranked model per level (scoreModelForTask on a task of that level):");
for (const level of ["light", "standard", "heavy", "critical"] as const) {
  const fake = { level, weight: 0, promptChars: 0, outputTokens: 0 } as unknown as Task;
  console.log(`  ${level.padEnd(9)} -> ${winner(fake)}`);
}

console.log(
  "\nfixture".padEnd(36),
  "flag-off".padEnd(10),
  "flag-on".padEnd(10),
  "winner-off".padEnd(34),
  "winner-on"
);
let lowered = 0;
for (const [label, body] of FIXTURE_TABLE) {
  const off = classify(body, false);
  const on = classify(body, true);
  if (on.level !== off.level) lowered += 1;
  console.log(
    label.padEnd(36),
    off.level.padEnd(10),
    on.level.padEnd(10),
    winner(off).padEnd(34),
    winner(on),
    on.level !== off.level ? `  [${on.reasons.join(",")}]` : ""
  );
}
console.log(`\n${lowered} of ${FIXTURE_TABLE.length} fixtures lowered by the flag.`);
