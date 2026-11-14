import test from "node:test";
import assert from "node:assert/strict";
import { createRoutingAttemptGuard } from "../../open-sse/services/combo/routingAttemptSafety.ts";
const body = { messages: [{ role: "user", content: "fixture" }] };
async function exercise(
  input: Record<string, unknown> = body,
  options = {},
  failure = Response.json(
    { error: { code: "upstream_error", message: "temporarily unavailable" } },
    { status: 503 }
  )
) {
  let calls = 0;
  const guard = createRoutingAttemptGuard({ body: input, limit: 3, ...options });
  const run = guard.wrap(async (_body, _model, target) => {
    calls++;
    target!.routingAttemptToken!.enter();
    return calls === 1 ? failure : Response.json({ content: "fixture result" });
  });
  await run(input, "nvidia/fixture-a", { provider: "nvidia", connectionId: "fixture" });
  const response = await run(input, "nvidia/fixture-b", {
    provider: "nvidia",
    connectionId: "fixture",
  });
  return { calls, response };
}
test("server-attested strict free stateless text advances a completed 503, preserving target order", async () => {
  assert.equal((await exercise(body, { allowStatelessZeroCost503: true })).calls, 2);
});
test("wire fields cannot grant recovery without server attestation", async () => {
  assert.equal((await exercise({ ...body, allowStatelessZeroCost503: true })).calls, 1);
});
for (const [name, input, error] of [
  ["tools", { ...body, tools: [{ type: "function", function: { name: "fixture" } }] }, null],
  ["provider continuation", { ...body, previous_response_id: "fixture" }, null],
  ["uncertain", body, { error: { details: { execution_outcome: "unknown" } } }],
  ["partial content", body, { error: { code: "upstream_error" }, content: "partial" }],
  ["usage", body, { error: { code: "upstream_error" }, usage: { completion_tokens: 1 } }],
] as const)
  test(`${name} does not acquire fallback permission`, async () => {
    const failure = error ? Response.json(error, { status: 503 }) : undefined;
    assert.equal((await exercise(input, { allowStatelessZeroCost503: true }, failure)).calls, 1);
  });
test("a timeout does not become a completed-rejection retry", async () => {
  let calls = 0;
  const g = createRoutingAttemptGuard({ body, limit: 3, allowStatelessZeroCost503: true });
  const run = g.wrap(async () => {
    calls++;
    throw new DOMException("fixture timeout", "TimeoutError");
  });
  await run(body, "nvidia/fixture-a");
  await run(body, "nvidia/fixture-b");
  assert.equal(calls, 1);
});
