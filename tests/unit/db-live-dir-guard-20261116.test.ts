// Live-data-dir guard (2026-11-16).
//
// A TEST process that resolves its data directory to the real default (~/.omniroute) used to open
// the live gateway database and plant fixture rows into it. src/lib/db/core.ts now refuses.
//
// Every case that has to prove the guard fires runs in a CHILD process with a clean environment:
// HOME is a fresh temp directory, DATA_DIR is unset, and only the signal under test is present.
// The real home directory is never touched. The parent suite itself runs under the isolation
// preload (tests/_setup/isolateDataDir.ts), exactly as the package.json test scripts run it.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE_URL = pathToFileURL(path.join(REPO_ROOT, "src/lib/db/core.ts")).href;
const PRELOAD_POLYFILL = "./open-sse/utils/setupPolyfill.ts";
const PRELOAD_ISOLATE = "./tests/_setup/isolateDataDir.ts";
const OPT_OUT = "OMNIROUTE_ALLOW_REAL_DB_IN_TESTS";

// No "test" token anywhere in this path: a child running as a *production-shaped* process must not
// look like a test through its script path.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omr-guard-"));
const CHILD_SCRIPT = path.join(scratch, "child.mjs");
const CHILD_TEST_NAMED = path.join(scratch, "child.test.mjs");
const CHILD_SOURCE = `
const coreUrl = process.argv[2] ?? process.env.GUARD_CORE_URL;
const mode = process.argv[3] ?? process.env.GUARD_MODE ?? "open";
if (mode === "logfile") {
  const env = await import(coreUrl.replace("/db/core.ts", "/logEnv.ts"));
  console.log("LOG_TO_FILE=" + env.getAppLogToFile());
  process.exit(0);
}
try {
  const core = await import(coreUrl);
  if (mode === "ensure") await core.ensureDbInitialized();
  else if (mode === "open") core.getDbInstance();
  console.log("CHILD_OK dataDir=" + core.DATA_DIR);
  try { core.closeDbInstance(); } catch {}
  process.exit(0);
} catch (error) {
  console.error("CHILD_ERROR " + (error && error.message ? error.message : String(error)));
  process.exit(3);
}
`;

let homeCounter = 0;
const homes: string[] = [];
function freshHome(): string {
  const dir = path.join(scratch, `home-${++homeCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  homes.push(dir);
  return dir;
}

type RunOptions = {
  home: string;
  env?: Record<string, string>;
  mode?: "open" | "ensure" | "import" | "logfile";
  nodeArgs?: string[];
  scriptArgs?: string[];
  script?: string;
  /** Under `node --test <file>` the runner passes no script args; the child reads GUARD_CORE_URL. */
  noArgs?: boolean;
};

function runChild(options: RunOptions) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: options.home,
    APP_LOG_TO_FILE: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    ...options.env,
  };
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--import",
      PRELOAD_POLYFILL,
      ...(options.nodeArgs ?? []),
      options.script ?? CHILD_SCRIPT,
      ...(options.noArgs ? [] : [CORE_URL, options.mode ?? "open"]),
      ...(options.scriptArgs ?? []),
    ],
    { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 120_000 }
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function assertBlocked(run: ReturnType<typeof runChild>, home: string) {
  assert.notEqual(run.status, 0, `child must exit non-zero\n${run.output}`);
  assert.match(run.output, /OMNIROUTE_ALLOW_REAL_DB_IN_TESTS/, run.output);
  assert.match(run.output, /isolateDataDir/, run.output);
  assert.match(run.output, /DATA_DIR/, run.output);
  assert.doesNotMatch(run.output, /CHILD_OK/, run.output);
  assert.equal(
    fs.existsSync(path.join(home, ".omniroute")),
    false,
    "the guard must fire before ~/.omniroute is created"
  );
}

before(() => {
  fs.writeFileSync(CHILD_SCRIPT, CHILD_SOURCE);
  fs.writeFileSync(CHILD_TEST_NAMED, CHILD_SOURCE);
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("live data dir guard: each test signal alone triggers", () => {
  it("NODE_TEST_CONTEXT (node test runner child processes)", () => {
    const home = freshHome();
    assertBlocked(runChild({ home, env: { NODE_TEST_CONTEXT: "child-v8" } }), home);
  });

  it("--test in process.argv", () => {
    const home = freshHome();
    assertBlocked(runChild({ home, scriptArgs: ["--test"] }), home);
  });

  it("VITEST", () => {
    const home = freshHome();
    assertBlocked(runChild({ home, env: { VITEST: "true" } }), home);
  });

  it("NODE_ENV=test", () => {
    const home = freshHome();
    assertBlocked(runChild({ home, env: { NODE_ENV: "test" } }), home);
  });

  it("main script named *.test.* (plain `node file.test.ts`)", () => {
    const home = freshHome();
    assertBlocked(runChild({ home, script: CHILD_TEST_NAMED }), home);
  });

  it("ensureDbInitialized() is guarded too, not only getDbInstance()", () => {
    const home = freshHome();
    assertBlocked(runChild({ home, mode: "ensure", env: { NODE_TEST_CONTEXT: "child-v8" } }), home);
  });
});

describe("live data dir guard: the documented single-file command", () => {
  it("node --test <file> without the isolation preload fails and leaves ~/.omniroute alone", () => {
    const home = freshHome();
    const run = runChild({
      home,
      nodeArgs: ["--test", "--test-force-exit"],
      script: CHILD_TEST_NAMED,
      scriptArgs: [],
      noArgs: true,
      env: { GUARD_CORE_URL: CORE_URL },
    });
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /OMNIROUTE_ALLOW_REAL_DB_IN_TESTS/, run.output);
    assert.equal(fs.existsSync(path.join(home, ".omniroute")), false);
  });
});

describe("live data dir guard: it must not fire when the data dir is not the live one", () => {
  it("DATA_DIR set to a temp directory does not trigger", () => {
    const home = freshHome();
    const dataDir = path.join(scratch, "explicit-data");
    const run = runChild({ home, env: { NODE_TEST_CONTEXT: "child-v8", DATA_DIR: dataDir } });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /CHILD_OK/);
    assert.equal(fs.existsSync(path.join(dataDir, "storage.sqlite")), true);
    assert.equal(fs.existsSync(path.join(home, ".omniroute")), false);
  });

  it("the existing isolation preload still isolates and the guard stays quiet", () => {
    const home = freshHome();
    const run = runChild({
      home,
      nodeArgs: ["--import", PRELOAD_ISOLATE],
      env: { NODE_TEST_CONTEXT: "child-v8" },
    });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /CHILD_OK/);
    assert.equal(fs.existsSync(path.join(home, ".omniroute")), false);
  });

  it("importing the module alone creates no ~/.omniroute in a test process", () => {
    const home = freshHome();
    const run = runChild({ home, mode: "import", env: { NODE_TEST_CONTEXT: "child-v8" } });
    assert.equal(run.status, 0, run.output);
    assert.equal(fs.existsSync(path.join(home, ".omniroute")), false);
  });

  it("importing with DATA_DIR explicitly set to the default creates nothing either", () => {
    const home = freshHome();
    const run = runChild({
      home,
      mode: "import",
      env: { NODE_TEST_CONTEXT: "child-v8", DATA_DIR: path.join(home, ".omniroute") },
    });
    assert.equal(run.status, 0, run.output);
    assert.equal(fs.existsSync(path.join(home, ".omniroute")), false);
  });

  it("the opt-out env var disables the guard", () => {
    const home = freshHome();
    const run = runChild({
      home,
      env: { NODE_TEST_CONTEXT: "child-v8", [OPT_OUT]: "1" },
    });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /CHILD_OK/);
    assert.equal(fs.existsSync(path.join(home, ".omniroute", "storage.sqlite")), true);
  });

  it("an opt-out value other than 1 does not disable the guard", () => {
    const home = freshHome();
    assertBlocked(
      runChild({ home, env: { NODE_TEST_CONTEXT: "child-v8", [OPT_OUT]: "true" } }),
      home
    );
  });
});

describe("live data dir guard: every spelling of the default dir is caught", () => {
  it("DATA_DIR explicitly set to the default path", () => {
    const home = freshHome();
    const env = { NODE_TEST_CONTEXT: "child-v8", DATA_DIR: path.join(home, ".omniroute") };
    assertBlocked(runChild({ home, env }), home);
  });

  it("trailing slash", () => {
    const home = freshHome();
    const env = { NODE_TEST_CONTEXT: "child-v8", DATA_DIR: `${home}/.omniroute/` };
    assertBlocked(runChild({ home, env }), home);
  });

  it("dot and dot-dot segments", () => {
    const home = freshHome();
    const env = {
      NODE_TEST_CONTEXT: "child-v8",
      DATA_DIR: `${home}/./elsewhere/../.omniroute`,
    };
    assertBlocked(runChild({ home, env }), home);
  });

  it("relative path resolved against the working directory", () => {
    const home = freshHome();
    const env = {
      NODE_TEST_CONTEXT: "child-v8",
      DATA_DIR: path.relative(REPO_ROOT, path.join(home, ".omniroute")),
    };
    assertBlocked(runChild({ home, env }), home);
  });

  it("tilde spelling", () => {
    const home = freshHome();
    const env = { NODE_TEST_CONTEXT: "child-v8", DATA_DIR: "~/.omniroute" };
    const run = runChild({ home, env });
    assertBlocked(run, home);
    // A literal "~" directory must not have been created inside the repo either.
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "~")), false);
  });

  it("symlinked home: DATA_DIR reaches the default dir through a symlink to HOME", () => {
    const home = freshHome();
    const link = path.join(scratch, "home-link");
    fs.symlinkSync(home, link);
    const env = { NODE_TEST_CONTEXT: "child-v8", DATA_DIR: path.join(link, ".omniroute") };
    assertBlocked(runChild({ home, env }), home);
  });

  it("symlinked directory: DATA_DIR is a symlink to an existing default dir", () => {
    const home = freshHome();
    const live = path.join(home, ".omniroute");
    fs.mkdirSync(live);
    const link = path.join(scratch, "data-link");
    fs.symlinkSync(live, link);
    const run = runChild({
      home,
      env: { NODE_TEST_CONTEXT: "child-v8", DATA_DIR: link },
    });
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /OMNIROUTE_ALLOW_REAL_DB_IN_TESTS/, run.output);
    assert.deepEqual(fs.readdirSync(live), [], "nothing may be created inside the live dir");
  });

  it("an existing default dir is left untouched when the guard fires", () => {
    const home = freshHome();
    const live = path.join(home, ".omniroute");
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, "keep.txt"), "x");
    const run = runChild({ home, env: { NODE_TEST_CONTEXT: "child-v8" } });
    assert.notEqual(run.status, 0, run.output);
    assert.deepEqual(fs.readdirSync(live), ["keep.txt"]);
  });
});

describe("live data dir guard: production paths are unaffected", () => {
  it("no test signal: the default dir is allowed and used", () => {
    const home = freshHome();
    const run = runChild({ home });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /CHILD_OK/);
    assert.equal(fs.existsSync(path.join(home, ".omniroute", "storage.sqlite")), true);
  });

  it("no test signal: DATA_DIR explicitly set to the default dir is allowed", () => {
    const home = freshHome();
    const run = runChild({ home, env: { DATA_DIR: path.join(home, ".omniroute") } });
    assert.equal(run.status, 0, run.output);
    assert.equal(fs.existsSync(path.join(home, ".omniroute", "storage.sqlite")), true);
  });

  it("NODE_ENV=production and development do not trigger", () => {
    for (const nodeEnv of ["production", "development"]) {
      const home = freshHome();
      const run = runChild({ home, env: { NODE_ENV: nodeEnv } });
      assert.equal(run.status, 0, `${nodeEnv}\n${run.output}`);
      assert.equal(fs.existsSync(path.join(home, ".omniroute", "storage.sqlite")), true);
    }
  });

  it("a CLI flag that merely starts with --test-, and a path containing a test dir, do not trigger", () => {
    const home = freshHome();
    const run = runChild({
      home,
      scriptArgs: ["--test-provider", "/home/test/app/latest/server.js"],
    });
    assert.equal(run.status, 0, run.output);
    assert.equal(fs.existsSync(path.join(home, ".omniroute", "storage.sqlite")), true);
  });
});

describe("live data dir guard: app log file", () => {
  // APP_LOG_TO_FILE is deliberately left at its default here (runChild sets it to "false" otherwise).
  const logEnv = (extra: Record<string, string>) => ({ APP_LOG_TO_FILE: "true", ...extra });

  it("a test process aimed at the live dir does not write logs/ into it", () => {
    const home = freshHome();
    const run = runChild({
      home,
      mode: "logfile",
      env: logEnv({ NODE_TEST_CONTEXT: "child-v8" }),
    });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /LOG_TO_FILE=false/);
  });

  it("file logging stays on for a test process with an isolated DATA_DIR and for production", () => {
    const home = freshHome();
    const isolated = runChild({
      home,
      mode: "logfile",
      env: logEnv({ NODE_TEST_CONTEXT: "child-v8", DATA_DIR: path.join(scratch, "log-data") }),
    });
    assert.match(isolated.output, /LOG_TO_FILE=true/, isolated.output);
    const production = runChild({ home: freshHome(), mode: "logfile", env: logEnv({}) });
    assert.match(production.output, /LOG_TO_FILE=true/, production.output);
  });
});

describe("live data dir guard: detection logic (pure)", () => {
  async function load() {
    return await import("../../src/lib/testProcessGuard.ts");
  }

  it("each signal is detected on its own and a clean process is not", async () => {
    const { detectTestProcessSignal } = await load();
    assert.equal(detectTestProcessSignal({}, ["node", "server.js"], []), null);
    assert.ok(detectTestProcessSignal({ NODE_TEST_CONTEXT: "child-v8" }, ["node", "x.js"], []));
    assert.ok(detectTestProcessSignal({ VITEST: "true" }, ["node", "x.js"], []));
    assert.ok(detectTestProcessSignal({ NODE_ENV: "test" }, ["node", "x.js"], []));
    assert.ok(detectTestProcessSignal({}, ["node", "x.js", "--test"], []));
    assert.ok(detectTestProcessSignal({}, ["node", "x.js"], ["--test"]));
    assert.ok(detectTestProcessSignal({}, ["node", "x.js"], ["--test-force-exit"]));
    assert.ok(detectTestProcessSignal({}, ["node", "/repo/tests/unit/a.test.ts"], []));
  });

  it("does not misfire on look-alikes", async () => {
    const { detectTestProcessSignal } = await load();
    assert.equal(detectTestProcessSignal({ NODE_ENV: "production" }, ["node", "s.js"], []), null);
    assert.equal(
      detectTestProcessSignal({}, ["node", "/home/test/app/latest/server.js"], []),
      null
    );
    assert.equal(
      detectTestProcessSignal({}, ["node", "bin/omniroute.mjs", "--test-provider"], []),
      null
    );
    assert.equal(detectTestProcessSignal({}, ["node", "/opt/contest/protest.js"], []), null);
  });
});

describe("live data dir guard: the opt-out is never set by the repo", () => {
  it(`no script, workflow, config or source file sets ${OPT_OUT}`, () => {
    const roots = ["package.json", "scripts", "bin", "tests/_setup", ".github", "src", "open-sse"];
    const allowed = new Set([path.join("src", "lib", "testProcessGuard.ts")]);
    const offenders: string[] = [];
    const walk = (rel: string) => {
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) return;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(abs)) {
          if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
          walk(path.join(rel, entry));
        }
        return;
      }
      if (allowed.has(rel) || stat.size > 2_000_000) return;
      if (!/\.(ts|tsx|js|mjs|cjs|json|ya?ml|sh|env.*)$/.test(rel) && !rel.includes(".env")) return;
      if (fs.readFileSync(abs, "utf8").includes(OPT_OUT)) offenders.push(rel);
    };
    roots.forEach(walk);
    assert.deepEqual(offenders, []);
  });
});
