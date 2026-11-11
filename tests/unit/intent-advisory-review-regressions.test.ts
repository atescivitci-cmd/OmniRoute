import test from "node:test";
import assert from "node:assert/strict";
import { inferFitFirstIntent } from "../../open-sse/services/autoCombo/fitFirstPolicy.ts";

for (const [ask, type] of [
  ["Could you please review this function?", "review"],
  ["Could you please calculate 7 times 8?", "math"],
] as const)
  test("polite modal operation: " + type, () => {
    const body = { messages: [{ role: "user", content: ask }] },
      before = structuredClone(body);
    assert.equal(inferFitFirstIntent(body).taskType, type);
    assert.deepEqual(body, before);
  });
test("discussing JSON does not request JSON output", () => {
  for (const ask of ["Explain what JSON means in one sentence.", 'Explain the term "JSON".']) {
    assert.notEqual(
      inferFitFirstIntent({ messages: [{ role: "user", content: ask }] }).outputContract,
      "json"
    );
  }
});
test("quoted and negated return literals do not create JSON output contracts", () => {
  for (const ask of [
    'Explain the code `return {"ok":true}` in one sentence.',
    'Do not return {"ok":true}; explain in plain prose.',
  ])
    assert.notEqual(
      inferFitFirstIntent({ messages: [{ role: "user", content: ask }] }).outputContract,
      "json"
    );
});
test("explicit JSON output directives still expose the requested contract", () => {
  for (const ask of [
    'Return exactly this JSON object: {"ok":true}',
    "Reply only with valid JSON.",
    "Format the result as JSON.",
  ]) {
    assert.equal(
      inferFitFirstIntent({ messages: [{ role: "user", content: ask }] }).outputContract,
      "json"
    );
  }
});
