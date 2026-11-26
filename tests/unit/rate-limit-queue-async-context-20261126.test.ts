/**
 * A request queued behind another in the local rate limiter must run in ITS OWN async context.
 *
 * Live 2026-11-26 20:33Z: three concurrent streaming tool requests on one gemini account queued in
 * the model-scoped limiter. Bottleneck started the queued jobs from the first job's completion, so
 * they ran inside the FIRST request's AsyncLocalStorage context, including its routing transport
 * attempt. Their upstream dispatch then counted as a second dispatch of the first request's attempt:
 * both queued requests failed at once with "Routing transport attempt stopped; no automatic
 * transport replay is permitted" (503 routing_transport_replay_blocked) before any upstream call,
 * and the first request's attempt was poisoned too (it failed the same way after its 80 s readiness
 * wait). No upstream_503 row was ever written, so overload failover and quality-first never saw a
 * real failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

const rl = await import("../../open-sse/services/rateLimitManager.ts");
const transport = await import("../../open-sse/services/routingTransportContext.ts");

test.after(async () => {
  await rl.__resetRateLimitManagerForTests();
});

test("a queued rate-limited job runs in its caller's async context (one dispatch per own attempt)", async () => {
  const connectionId = "conn-als-queue";
  rl.enableRateLimitProtection(connectionId);
  rl.refreshConnectionRateLimits(connectionId, { maxConcurrent: 1 });
  const marker = new AsyncLocalStorage<string>();

  const run = (name: string, holdMs: number) => {
    const token = transport.createRoutingTransportAttempt();
    return marker.run(name, () =>
      transport.runWithRoutingTransportAttempt(token, () =>
        rl.withRateLimit("gemini", connectionId, "gemini-3.5-flash", async () => {
          const seen = {
            marker: marker.getStore(),
            ownAttempt: transport.getCurrentRoutingTransportAttempt() === token,
          };
          // The dispatch every executor makes for its attempt.
          await transport.runWithRoutingTransportWire(async () => {
            await new Promise((resolve) => setTimeout(resolve, holdMs));
            return null;
          });
          return seen;
        })
      )
    );
  };

  const results = await Promise.allSettled([run("first", 60), run("second", 1), run("third", 1)]);
  for (const [i, name] of ["first", "second", "third"].entries()) {
    const result = results[i];
    assert.equal(
      result.status,
      "fulfilled",
      `${name}: ${String((result as PromiseRejectedResult).reason)}`
    );
    const value = (result as PromiseFulfilledResult<{ marker: string; ownAttempt: boolean }>).value;
    assert.equal(value.marker, name, `${name} ran in its own async context`);
    assert.equal(value.ownAttempt, true, `${name} dispatched under its own transport attempt`);
  }
});
