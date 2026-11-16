/**
 * Read-only routing preview for the Claude 5.5 family (2026-11-16).
 * Prints each model's modelPowerScore and, per task level, the ranking produced by
 * scoreModelForTask over (a) the current account model set and (b) that set plus
 * Haiku 5.5 / Sonnet 5.5 / Opus 5.5. Uses the repo's real exports; nothing is tuned.
 *
 * Run: node --import tsx/esm scripts/ad-hoc/cc55-routing-preview-20261116.mts
 * Throwaway DATA_DIR, no gateway database, no credentials, no network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cc55-"));
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const { modelPowerScore, scoreModelForTask, classifyTask } =
  await import("../../open-sse/services/taskAwareRouting.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");

const CURRENT = [
  "claude/claude-fable-5",
  "claude/claude-opus-5",
  "claude/claude-opus-4-8",
  "claude/claude-opus-4-7",
  "claude/claude-opus-4-6",
  "claude/claude-opus-4-5-20251101",
  "claude/claude-sonnet-5",
  "claude/claude-sonnet-4-6",
  "claude/claude-sonnet-4-5-20250929",
  "claude/claude-haiku-4-5-20251001",
];
const NEW_55 = ["claude/claude-opus-5-5", "claude/claude-sonnet-5-5", "claude/claude-haiku-5-5"];

type Task = ReturnType<typeof classifyTask>;
const LEVELS = ["light", "standard", "heavy", "critical"] as const;

export function rank(models: string[], level: (typeof LEVELS)[number]) {
  const task = { level, weight: 0, promptChars: 0, outputTokens: 0 } as unknown as Task;
  return models
    .map((m, i) => ({ m, i, score: scoreModelForTask(m, task) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
}

console.log(
  "modelPowerScore and resolved capabilities (ctx / maxOut / reasoning / tools / vision):"
);
for (const m of [...CURRENT, ...NEW_55]) {
  const c = getResolvedModelCapabilities(m);
  console.log(
    `  ${m.padEnd(38)} power=${String(modelPowerScore(m)).padStart(3)}  ` +
      `${c.contextWindow ?? "-"} / ${c.maxOutputTokens ?? "-"} / ${c.reasoning} / ${c.toolCalling} / ${c.supportsVision}`
  );
}

for (const [label, set] of [
  ["CURRENT set", CURRENT],
  ["CURRENT + 5.5 set", [...CURRENT, ...NEW_55]],
] as const) {
  console.log(`\n${label}: top 3 per level (score)`);
  for (const level of LEVELS) {
    const top = rank([...set], level)
      .slice(0, 3)
      .map((r) => `${r.m.replace("claude/", "")}(${r.score})`);
    console.log(`  ${level.padEnd(9)} ${top.join("  >  ")}`);
  }
}

const light = rank([...CURRENT, ...NEW_55], "light");
const idx = (id: string) => light.findIndex((r) => r.m === id);
console.log(
  `\nlight: haiku-5-5 rank ${idx("claude/claude-haiku-5-5") + 1}, ` +
    `haiku-4-5 rank ${idx("claude/claude-haiku-4-5-20251001") + 1}`
);
