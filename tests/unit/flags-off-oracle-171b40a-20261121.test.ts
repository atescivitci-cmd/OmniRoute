/**
 * ORACLE: with every ROUTING_* setting unset, this tree must rank exactly like build 171b40a,
 * the build that is installed and live (dist/BUILD_SHA = 171b40a; the ranking sources are
 * byte-identical to that commit).
 *
 * The fixture is the real 18-model pool and 208 real usage rows (a copy of the live usage
 * history, no keys or prompts). tests/tools/oracleRank.ts seeds those rows, assembles candidates
 * with the production buildAutoCandidates and ranks three request shapes (critical with tools, heavy
 * without tools, light chat) for 200 conversation keys each, 600 rankings of 18 candidates. The
 * harness runs in a child process with a throwaway DATA_DIR and every ROUTING_* variable cleared.
 *
 *  1. the new tree's output must equal tests/fixtures/oracle-171b40a-golden.json, produced by the
 *     harness run inside a pristine checkout of 171b40a: same winners, same order, same scores
 *     (exact float equality), same exclusions, for every key;
 *  2. when OMNIROUTE_ORACLE_ROOT points at a checkout of 171b40a, the harness is also run there
 *     live and compared (copy tests/tools/oracleRank.ts and the fixture into it first);
 *  3. sensitivity: with class evidence, band and the abandon rule on, the output must DIFFER,
 *     otherwise the oracle could not detect a behaviour change.
 * A mismatch is a blocker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const HARNESS = path.join(ROOT, "tests", "tools", "oracleRank.ts");

type Result = { candidates: number; rankings: Record<string, Array<Record<string, unknown>>> };

function runHarness(cwd: string, settings?: Record<string, string>): Result {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ROUTING_") || name === "DATA_DIR") delete env[name];
  }
  if (settings) env.ORACLE_SETTINGS = JSON.stringify(settings);
  const r = spawnSync("node", ["--import", "tsx/esm", HARNESS], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 240_000,
  });
  assert.equal(r.status, 0, `harness failed in ${cwd}: ${r.stderr.slice(-800)}`);
  assert.match(
    r.stderr,
    /oracleRank DATA_DIR=\S+/,
    "the harness must print its throwaway DATA_DIR"
  );
  assert.ok(!/oracleRank DATA_DIR=\S*\.omniroute/.test(r.stderr));
  const last = r.stdout.trim().split("\n").at(-1)!;
  return JSON.parse(last) as Result;
}

function firstDifference(a: Result, b: Result): string | null {
  for (const shape of Object.keys(a.rankings)) {
    const xs = a.rankings[shape];
    const ys = b.rankings[shape] ?? [];
    if (xs.length !== ys.length) return `${shape}: ${xs.length} vs ${ys.length} rankings`;
    for (let i = 0; i < xs.length; i++) {
      if (JSON.stringify(xs[i]) !== JSON.stringify(ys[i])) {
        return `${shape} key ${i}: ${JSON.stringify(xs[i]).slice(0, 300)} vs ${JSON.stringify(ys[i]).slice(0, 300)}`;
      }
    }
  }
  return null;
}

const golden = JSON.parse(
  fs.readFileSync(path.join(ROOT, "tests", "fixtures", "oracle-171b40a-golden.json"), "utf8")
) as Result;

test("oracle: with every setting unset the ranking equals the 171b40a golden for 600 rankings", () => {
  const now = runHarness(ROOT);
  assert.equal(now.candidates, 18);
  const total = Object.values(now.rankings).reduce((n, list) => n + list.length, 0);
  assert.equal(total, 600);
  assert.equal(firstDifference(golden, now), null);
  // and the lists are not trivially identical: they have real structure
  const critical = now.rankings.criticalTools as Array<{ ranked: unknown[][] }>;
  assert.ok(critical[0].ranked.length >= 10);
  const winners = new Set(
    (now.rankings.criticalTools as Array<{ ranked: unknown[][] }>).map(
      (r) => `${r.ranked[0][0]}/${r.ranked[0][1]}`
    )
  );
  assert.ok(winners.size >= 1);
});

test("oracle: live comparison against a 171b40a checkout when OMNIROUTE_ORACLE_ROOT is set", (t) => {
  const oracleRoot = process.env.OMNIROUTE_ORACLE_ROOT;
  if (!oracleRoot)
    return t.skip("OMNIROUTE_ORACLE_ROOT not set (the golden comparison above still ran)");
  const baseline = runHarness(oracleRoot);
  const now = runHarness(ROOT);
  assert.equal(firstDifference(baseline, now), null);
});

test("oracle sensitivity: turning the settings on changes the output", () => {
  const on = runHarness(ROOT, {
    ROUTING_CLASS_EVIDENCE: "1",
    ROUTING_SPREAD_TIEBREAK: "1",
    ROUTING_TIE_BAND: "0.02",
    ROUTING_CLIENT_ABANDON_NEUTRAL: "1",
  });
  assert.notEqual(firstDifference(golden, on), null, "settings on must differ from 171b40a");
});
