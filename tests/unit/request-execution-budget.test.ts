import test from "node:test";
import assert from "node:assert/strict";
import { withExecutionBudget } from "../../open-sse/utils/requestExecutionBudget.ts";
const payload = { model: "fixture", messages: [{ role: "user", content: "fixture" }] };
const request = (value?: string) =>
  new Request("http://localhost/v1/messages", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      ...(value ? { "x-omniroute-request-timeout-ms": value } : {}),
    },
  });
test("absence of execution budget preserves the identical request", () => {
  const r = request();
  assert.equal(withExecutionBudget(r, payload), r);
});
for (const value of ["-1", "0", "foo", "10.2", "999999999999999999999"])
  test("invalid budget is stripped without applying " + value, () => {
    const r = withExecutionBudget(request(value), payload);
    assert.equal(r.headers.has("x-omniroute-request-timeout-ms"), false);
  });
test("bounded caller deadline aborts downstream and never becomes provider metadata", async () => {
  const r = withExecutionBudget(request("250"), payload);
  assert.equal(r.headers.has("x-omniroute-request-timeout-ms"), false);
  assert.deepEqual(await r.json(), payload);
  await new Promise((resolve) => setTimeout(resolve, 270));
  assert.equal(r.signal.aborted, true);
});
test("caller disconnect propagates before the execution deadline", () => {
  const c = new AbortController();
  const r = new Request(request("10000"), { signal: c.signal });
  const next = withExecutionBudget(r, payload);
  c.abort();
  assert.equal(next.signal.aborted, true);
});
