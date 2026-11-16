/**
 * Live-data-dir guard: a TEST process must never open the real OmniRoute data directory.
 *
 * Why this exists (2026-11-16): `resolveDataDir()` falls back to `~/.omniroute` when DATA_DIR is
 * unset, and nothing stopped a test process from taking that fallback. The documented single-file
 * command (`node --import tsx/esm --test tests/unit/x.test.ts`) does not load the isolation preload,
 * so 2258 of 3071 top-level test files wrote fixtures (provider connections, `manage`-scoped API keys,
 * settings, call logs) into the live gateway database, and one un-isolated run spent real credentials.
 *
 * The guard is fail-closed and deliberately narrow:
 *  - it only fires when a test-process signal is present AND the data dir is the real default;
 *  - several independent signals, so no single one is load-bearing;
 *  - the check runs BEFORE anything touches the path (mkdir, open, migrate, backup, restore);
 *  - production (launchd/systemd/docker, `npm run dev|build|start`, the CLI, the installer) carries
 *    none of the signals, so for them this is a few property reads and an early return.
 *
 * This module is dependency-free on purpose (no import of dataPaths/db) so `dataPaths.ts` can use it
 * without creating an import cycle.
 */
import fs from "fs";
import os from "os";
import path from "path";

/** The one escape hatch. Named in the error message only; no script in this repo sets it. */
export const REAL_DB_OPT_OUT_ENV = "OMNIROUTE_ALLOW_REAL_DB_IN_TESTS";

export const LIVE_DATA_DIR_GUARD_CODE = "OMNIROUTE_LIVE_DATA_DIR_IN_TEST_PROCESS";

type EnvLike = Record<string, string | undefined>;

/** `foo.test.ts`, `foo.test.mjs` ... as the main script (`node --import tsx foo.test.ts`). */
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/i;

/**
 * Returns a short description of the first test-process signal found, or null for a normal process.
 *
 * Signals (any one is enough):
 *  1. NODE_TEST_CONTEXT set        - every child process spawned by node's test runner
 *  2. `--test` in argv/execArgv    - the runner process itself (`--test-*` flags only in execArgv, because
 *                                    argv carries user CLI flags such as `omniroute setup --test-provider`)
 *  3. VITEST set                   - vitest workers
 *  4. NODE_ENV === "test"
 *  5. main script is `*.test.*`    - plain `node --import tsx file.test.ts` with no runner
 *
 * Path-substring heuristics ("test" anywhere in argv) are NOT used: `/home/test/app/latest/server.js`
 * must not be treated as a test, because a false positive here would lock a real install out.
 */
export function detectTestProcessSignal(
  env: EnvLike = process.env,
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv
): string | null {
  if (env.NODE_TEST_CONTEXT !== undefined)
    return "NODE_TEST_CONTEXT is set (node test runner child)";
  if (env.VITEST !== undefined) return "VITEST is set";
  if (env.NODE_ENV === "test") return "NODE_ENV=test";
  if (Array.isArray(argv)) {
    if (argv.some((arg) => arg === "--test")) return "--test in process.argv";
    const mainScript = argv[1];
    if (typeof mainScript === "string" && TEST_FILE_RE.test(mainScript)) {
      return `main script is a test file (${path.basename(mainScript)})`;
    }
  }
  if (Array.isArray(execArgv)) {
    for (const arg of execArgv) {
      if (typeof arg !== "string") continue;
      if (arg === "--test" || arg.startsWith("--test-") || arg.startsWith("--experimental-test-")) {
        return `${arg} in process.execArgv`;
      }
    }
  }
  return null;
}

export function isRealDbOptOutSet(env: EnvLike = process.env): boolean {
  return env[REAL_DB_OPT_OUT_ENV] === "1";
}

/** Case-insensitive file systems (macOS default, Windows): `~/.OmniRoute` is the same directory. */
function foldCase(value: string): string {
  return process.platform === "darwin" || process.platform === "win32"
    ? value.toLowerCase()
    : value;
}

/**
 * Absolute path with symlinks resolved, even when the leaf does not exist yet: the deepest existing
 * ancestor is realpath'd and the missing tail is re-appended. This is what makes a symlinked HOME,
 * a symlink pointing at ~/.omniroute, `a/../.omniroute`, a trailing slash or a relative spelling all
 * compare equal to the real location.
 */
export function canonicalizePath(input: string): string {
  const absolute = path.resolve(input);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return foldCase(path.join(real, ...tail.reverse()));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return foldCase(absolute);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function expandTilde(raw: string, homeDir: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return null;
}

export type LiveDataDirViolation = {
  signal: string;
  dataDir: string;
  protectedDir: string;
};

/**
 * Pure decision: is this a test process pointed at one of the protected (real) data directories?
 * No file is created or modified. `protectedDirs` are the real default locations.
 */
export function findLiveDataDirViolation(options: {
  dataDir: string;
  protectedDirs: readonly string[];
  /** DATA_DIR exactly as configured, so a `~/...` spelling can be recognised. */
  rawDataDir?: string | null;
  homeDir?: string;
  env?: EnvLike;
  argv?: readonly string[];
  execArgv?: readonly string[];
}): LiveDataDirViolation | null {
  const env = options.env ?? process.env;
  const signal = detectTestProcessSignal(env, options.argv, options.execArgv);
  if (!signal) return null;
  if (isRealDbOptOutSet(env)) return null;

  const candidates = [options.dataDir];
  if (options.rawDataDir && options.homeDir) {
    const expanded = expandTilde(options.rawDataDir, options.homeDir);
    if (expanded) candidates.push(expanded);
  }

  const canonicalProtected = options.protectedDirs.map((dir) => ({
    dir,
    canonical: canonicalizePath(dir),
  }));
  for (const candidate of candidates) {
    const canonical = canonicalizePath(candidate);
    const hit = canonicalProtected.find((entry) => entry.canonical === canonical);
    if (hit) return { signal, dataDir: candidate, protectedDir: hit.dir };
  }
  return null;
}

export class LiveDataDirGuardError extends Error {
  readonly code = LIVE_DATA_DIR_GUARD_CODE;
  constructor(readonly violation: LiveDataDirViolation) {
    super(buildLiveDataDirMessage(violation));
    this.name = "LiveDataDirGuardError";
  }
}

export function buildLiveDataDirMessage(violation: LiveDataDirViolation): string {
  return [
    "[DB] Refusing to open the REAL OmniRoute data directory from a test process.",
    `  data dir : ${violation.dataDir}  (the live default, ${violation.protectedDir})`,
    `  detected : ${violation.signal}`,
    "  Opening it would write test fixtures (connections, API keys, settings, call logs) into the",
    "  live gateway database. Nothing was created or modified.",
    "  Fix, either:",
    "    - run through the isolation preload:",
    "        node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts \\",
    "          --import ./tests/_setup/isolateDataDir.ts --test <file>   (or use an `npm run test*` script)",
    "    - or point the test at a throwaway directory: DATA_DIR=$(mktemp -d) node ... --test <file>",
    `  Only if you truly must use the real database in a test process, set ${REAL_DB_OPT_OUT_ENV}=1.`,
  ].join("\n");
}

export function assertNotLiveDataDir(violation: LiveDataDirViolation | null): void {
  if (violation) throw new LiveDataDirGuardError(violation);
}

/** Resolved home directory, same fallback chain as dataPaths. */
export function guardHomeDir(): string {
  try {
    return os.homedir();
  } catch {
    return path.resolve(process.env.HOME || process.env.USERPROFILE || os.tmpdir());
  }
}
