import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const action = YAML.parse(
  readFileSync(new URL("../../.github/actions/npm-ci-retry/action.yml", import.meta.url), "utf8")
);
const script = action.runs.steps[0].run;
const fixture = mkdtempSync(join(tmpdir(), "npm-retry-test-"));
try {
  writeFileSync(join(fixture, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const [name, body, expected] of [
    ["all attempts fail", "exit 42", 42],
    ["first attempt succeeds", "exit 0", 0],
    [
      "transient failure recovers",
      `if [ -f "$RETRY_FIXTURE/attempted" ]; then exit 0; fi\ntouch "$RETRY_FIXTURE/attempted"\nexit 42`,
      0,
    ],
  ]) {
    writeFileSync(join(fixture, "npm"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, RETRY_FIXTURE: fixture },
      encoding: "utf8",
    });
    assert.equal(result.status, expected, `${name}: ${result.stdout} ${result.stderr}`);
    console.log(`PASS: ${name}`);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
