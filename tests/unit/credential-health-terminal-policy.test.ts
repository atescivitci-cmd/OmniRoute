import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { shouldSkipAutomatedCredentialProbe } from "../../src/lib/credentialHealth/terminalPolicy.ts";

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

test("automated credential probes skip durable terminal connection states", () => {
  for (const testStatus of ["credits_exhausted", "banned", "expired"]) {
    assert.equal(
      shouldSkipAutomatedCredentialProbe({ testStatus }),
      true,
      `${testStatus} must not be reactivated by a generic background probe`
    );
  }
});

test("automated credential probes retain eligible transient states", () => {
  for (const testStatus of [null, "active", "success", "error", "unavailable"]) {
    assert.equal(shouldSkipAutomatedCredentialProbe({ testStatus }), false);
  }
});

test("scheduler and connection-test route enforce the terminal-state guard", () => {
  const scheduler = read("../../src/lib/credentialHealth/scheduler.ts");
  const route = read("../../src/app/api/providers/[id]/test/route.ts");

  assert.match(
    scheduler,
    /testSingleConnection\(connectionId,\s*undefined,\s*\{\s*automated:\s*true\s*\}\)/s,
    "the background scheduler must identify its probes as automated"
  );
  assert.match(
    scheduler,
    /shouldSkipAutomatedCredentialProbe\(conn\)/,
    "the scheduler must filter known terminal rows before starting network probes"
  );
  assert.match(
    route,
    /options\.automated\s*&&\s*shouldSkipAutomatedCredentialProbe\(connection\)/,
    "the route must recheck terminal status at execution time"
  );
  assert.match(
    route,
    /clearConnectionErrorIfUnchanged\(/,
    "an automated success must use an atomic state guard before clearing errors"
  );
});
