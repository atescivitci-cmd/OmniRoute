/**
 * Oracle harness: ranks a fixed pool with the production candidate assembly and the production
 * fit-first ranker of whatever source tree it runs in, and prints every ranking as JSON.
 *
 *   cd <source tree root> && node --import tsx/esm <this file> [fixture.json]
 *
 * It runs in the CURRENT WORKING DIRECTORY's tree, so the same file can be copied next to a
 * pristine checkout of the build that is live (171b40a) and next to the new tip, and the two
 * outputs compared. Safety: it never touches a real data directory. DATA_DIR is replaced by a
 * fresh temporary directory BEFORE any gateway module is imported, printed on stderr, and the
 * run is refused if it would contain ".omniroute". Every ROUTING_* setting is cleared first, so
 * the output is the default (settings unset) behaviour.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const oracleSettings = process.env.ORACLE_SETTINGS;
for (const name of Object.keys(process.env))
  if (name.startsWith("ROUTING_")) delete process.env[name];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-rank-"));
if (dataDir.includes(".omniroute") || fs.realpathSync(dataDir).includes(".omniroute")) {
  console.error("refusing to run: DATA_DIR contains .omniroute");
  process.exit(2);
}
process.env.DATA_DIR = dataDir;
// Only for the oracle's own sensitivity check: ORACLE_SETTINGS='{"ROUTING_X":"1"}' turns settings on.
if (oracleSettings) {
  for (const [k, v] of Object.entries(JSON.parse(oracleSettings))) {
    process.env[k] = String(v);
  }
}
process.env.APP_LOG_TO_FILE = "false";
console.error(`oracleRank DATA_DIR=${dataDir}`);

const root = process.cwd();
const fixturePath =
  process.argv[2] ?? path.join(root, "tests", "fixtures", "oracle-rank-fixture.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
  pool: Array<{ provider: string; model: string }>;
  usageRows: Array<{
    provider: string;
    model: string;
    success: boolean;
    errorCode: string | null;
    latencyMs: number | null;
    ttftMs: number | null;
    tokensInput: number | null;
    tokensOutput: number | null;
    source: string | null;
    ageMs: number;
  }>;
};

const load = (rel: string) => import(path.join(root, rel));
const { saveRequestUsage } = await load("src/lib/usage/usageHistory.ts");
const { buildAutoCandidates } = await load("open-sse/services/combo.ts");
const { rankFitFirstFreeCandidates } = await load("open-sse/services/autoCombo/fitFirstPolicy.ts");

const now = Date.now();
for (const row of fixture.usageRows) {
  await saveRequestUsage({
    provider: row.provider,
    model: row.model,
    success: row.success,
    status: row.success ? "200" : "500",
    errorCode: row.errorCode,
    latencyMs: row.latencyMs ?? 0,
    timeToFirstTokenMs: row.ttftMs ?? 0,
    tokens: { input: row.tokensInput ?? 0, output: row.tokensOutput ?? 0 },
    timestamp: new Date(now - row.ageMs).toISOString(),
    ...(row.source ? { source: row.source } : {}),
  });
}

const candidates = await buildAutoCandidates(
  fixture.pool.map((p) => ({
    kind: "model",
    provider: p.provider,
    modelStr: `${p.provider}/${p.model}`,
    stepId: p.model,
    executionKey: p.model,
    connectionId: null,
  })),
  "oracle-fixture"
);

const tool = {
  type: "function",
  function: { name: "run", parameters: { type: "object", properties: {} } },
};
const bodies: Record<string, (id: string) => Record<string, unknown>> = {
  criticalTools: (id) => ({
    stream: true,
    max_tokens: 2112,
    tools: [tool],
    conversation_id: id,
    messages: [{ role: "user", content: "Review the failing build log. ".repeat(4200) }],
  }),
  heavyPlain: (id) => ({
    stream: true,
    conversation_id: id,
    messages: [{ role: "user", content: "Summarise this log. ".repeat(2000) }],
  }),
  lightChat: (id) => ({
    conversation_id: id,
    messages: [{ role: "user", content: "Explain what a mutex is." }],
  }),
};

const providers = [...new Set(fixture.pool.map((p) => p.provider))];
const out: Record<string, unknown[]> = {};
for (const [shape, make] of Object.entries(bodies)) {
  out[shape] = [];
  for (let i = 0; i < 200; i++) {
    const decision = rankFitFirstFreeCandidates({
      candidates,
      body: make(`oracle-conversation-${i}`),
      zeroAdditionalCostProviders: providers,
      now,
    });
    out[shape].push({
      key: i,
      taskLevel: decision.taskLevel,
      ranked: decision.ranked.map(
        (e: { candidate: { provider: string; model: string }; factors: { score: number } }) => [
          e.candidate.provider,
          e.candidate.model,
          e.factors.score,
        ]
      ),
      excluded: decision.excluded.map((e: { provider: string; model: string; reason: string }) => [
        e.provider,
        e.model,
        e.reason,
      ]),
    });
  }
}
// the last line of stdout is the result; earlier lines are module start-up logging
console.log(JSON.stringify({ candidates: candidates.length, rankings: out }));
