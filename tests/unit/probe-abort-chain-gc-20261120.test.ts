/**
 * A probe's deadline reaches the upstream, and leaves a failure row, after garbage collections.
 *
 * Measured with the real canary probe against a real local HTTP server and collections forced
 * during the stall: for a stall before any response (no headers, headers with no body, an SSE
 * stream of pings only, a JSON body that never arrives) the upstream connection was never released
 * after the deadline (still open 10 s past a 4 s deadline; without collections it closed at about
 * 4.75 s) and no usage row was written. The request the pipeline reads its abort signal from is
 * built with `new Request(url, { signal })`, and the runtime follows the source signal through a
 * weak reference that is only kept alive while the Request object itself is. The admission step
 * rebuilds the request for every chat call and nothing kept that rebuilt Request alive, so after
 * a long enough stall the deadline never reached it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import v8 from "node:v8";
import vm from "node:vm";
import { createProviderConnection } from "@/lib/db/providers";
import { getDbInstance, resetDbInstance } from "@/lib/db/core";
import { createDefaultRoutingEvidenceCanaryDeps } from "@/lib/services/routingEvidenceCanary.ts";
import { USAGE_SOURCE_ROUTING_CANARY } from "@/shared/constants/usageSource";

v8.setFlagsFromString("--expose-gc");
const forceGc = vm.runInNewContext("gc") as () => void;

test.after(() => {
  resetDbInstance();
});

type Shape = "hold-headers" | "headers-silent" | "ping-trickle" | "json-silent";

const ACCEPTED_CODES: Record<Shape, string[]> = {
  "hold-headers": ["probe_deadline"],
  "headers-silent": ["STREAM_READINESS_TIMEOUT", "probe_deadline"],
  "ping-trickle": ["STREAM_READINESS_TIMEOUT", "probe_deadline"],
  "json-silent": ["probe_deadline"],
};

const DEADLINE_MS = 4000;

for (const shape of Object.keys(ACCEPTED_CODES) as Shape[]) {
  test(`after collections, a probe stalled before any response (${shape}) releases the upstream and leaves one failure row`, async () => {
    const startedAt = Date.now();
    let closedAfterMs: number | null = null;
    const timers: NodeJS.Timeout[] = [];
    const server = http.createServer((req, res) => {
      req.on("close", () => {
        if (closedAfterMs === null) closedAfterMs = Date.now() - startedAt;
      });
      if (shape === "hold-headers") return;
      res.writeHead(200, {
        "content-type": shape === "json-silent" ? "application/json" : "text/event-stream",
        "cache-control": "no-cache",
      });
      res.flushHeaders();
      if (shape === "ping-trickle") timers.push(setInterval(() => res.write(": ping\n\n"), 200));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const connection = await createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: `probe-abort-gc-${shape}-${Date.now()}`,
      apiKey: `sk-probe-abort-gc-${shape}-${Date.now()}`,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` },
    });
    const connectionId = String(connection.id);
    const gcTimer = setInterval(forceGc, 100);
    try {
      const outcome = await createDefaultRoutingEvidenceCanaryDeps().runProbe({
        provider: "openai",
        model: "gpt-4o",
        modelStr: "openai/gpt-4o",
        connectionId,
        prompt: "Routing probe.",
        maxTokens: 64,
        timeoutMs: DEADLINE_MS,
      });
      assert.equal(outcome.ok, false, "the probe did not complete");
      for (let i = 0; i < 80 && closedAfterMs === null; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 800)); // the usage write is not awaited
      assert.notEqual(closedAfterMs, null, "the upstream connection was never released");
      assert.ok(
        (closedAfterMs as number) < DEADLINE_MS + 4000,
        `upstream released ${closedAfterMs} ms after dispatch (deadline ${DEADLINE_MS} ms)`
      );
      const rows = getDbInstance()
        .prepare(
          "SELECT status, success, error_code, source FROM usage_history WHERE connection_id = ? ORDER BY id"
        )
        .all(connectionId) as Array<{
        status: string;
        success: number;
        error_code: string | null;
        source: string | null;
      }>;
      const failures = rows.filter((row) => row.success === 0);
      assert.equal(failures.length, 1, `expected one failure row: ${JSON.stringify(rows)}`);
      assert.ok(
        ACCEPTED_CODES[shape].includes(String(failures[0].error_code)),
        `unexpected failure row ${JSON.stringify(failures[0])}`
      );
      assert.equal(failures[0].source, USAGE_SOURCE_ROUTING_CANARY);
    } finally {
      clearInterval(gcTimer);
      for (const timer of timers) clearInterval(timer);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(null)));
    }
  });
}
