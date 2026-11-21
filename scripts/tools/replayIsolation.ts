/**
 * Imported FIRST by replay_fair_selection.ts and by every test of the fair-selection work. The ranker modules open the gateway database as a
 * side effect of being imported, and opening it applies pending migrations. Pointing DATA_DIR at a
 * throwaway directory before they load keeps the replay from ever touching the live database.
 * It refuses to run when DATA_DIR is set to the live data directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** realpath of the nearest existing ancestor plus the rest, so a symlink cannot hide a live path. */
function resolveReal(target: string): string {
  let probe = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...rest.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return path.resolve(target);
      rest.push(path.basename(probe));
      probe = parent;
    }
  }
}
function isLivePath(candidate: string): boolean {
  const live = resolveReal(path.join(os.homedir(), ".omniroute"));
  const real = resolveReal(candidate);
  return (
    real === live ||
    real.startsWith(live + path.sep) ||
    path.resolve(candidate).includes(".omniroute") ||
    real.includes(".omniroute")
  );
}
const requested = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
if (requested && isLivePath(requested)) {
  console.error(`refusing to run: DATA_DIR ${requested} is or resolves to a live data path`);
  process.exit(2);
}
if (!requested) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "replay-fair-selection-"));
}
// The ranker reads model capabilities, task fitness tiers and overrides from the database, so a
// faithful replay needs them: work on a private COPY of the copy that was passed with --db, and
// let the modules migrate that private copy. Neither the live file nor the --db copy is written.
const dbArg = process.argv.indexOf("--db");
if (dbArg >= 0 && process.argv[dbArg + 1] && !requested) {
  const source = path.resolve(process.argv[dbArg + 1]);
  const target = path.join(process.env.DATA_DIR!, "storage.sqlite");
  if (!isLivePath(source) && fs.existsSync(source)) {
    fs.copyFileSync(source, target);
    (globalThis as { __replayDbCopy?: string }).__replayDbCopy = target;
  }
}
process.env.APP_LOG_TO_FILE ||= "false";
if (isLivePath(process.env.DATA_DIR!)) {
  console.error("refusing to run: DATA_DIR is or resolves to a live data path");
  process.exit(2);
}
console.error(`DATA_DIR=${process.env.DATA_DIR}`);
