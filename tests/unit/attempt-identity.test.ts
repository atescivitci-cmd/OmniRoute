import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  carryAttemptIdentity,
  resolveAttemptIdentity,
} from "../../src/sse/handlers/chat/attemptIdentity.ts";

test("attempt identity is generated once and preserved through fallback overrides", () => {
  const generated = resolveAttemptIdentity({}, () => "attempt-fixed");
  assert.equal(generated, "attempt-fixed");

  const fallback = carryAttemptIdentity(
    { emergencyFallbackTried: false, comboExecutionKey: null, comboStepId: null },
    generated,
    { emergencyFallbackTried: true, forcedConnectionId: null }
  );
  assert.equal(fallback.attemptId, "attempt-fixed");
  assert.equal(fallback.comboExecutionKey, "attempt-fixed");
  assert.equal(fallback.comboStepId, null);
});

test("an existing execution key becomes the fixed attempt identity", () => {
  assert.equal(
    resolveAttemptIdentity(
      { attemptId: "", comboExecutionKey: "existing-key", comboStepId: "fallback-step" },
      () => "generated"
    ),
    "existing-key"
  );
});

test("fallback source never clears the fixed execution identity", () => {
  const source = fs.readFileSync(
    new URL("../../src/sse/handlers/chat.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /emergencyFallbackTried:\s*true[\s\S]{0,240}comboExecutionKey:\s*null/,
    "fallback must carry the fixed attempt identity"
  );
});
