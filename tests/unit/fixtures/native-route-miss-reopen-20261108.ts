import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
assert.ok(
  process.env.DATA_DIR &&
    path.basename(process.env.DATA_DIR).startsWith("route-miss-quarantine-") &&
    fs.statSync(process.env.DATA_DIR).isDirectory()
);
globalThis.fetch = async () => {
  throw new Error("fixture_network_forbidden");
};
const core = await import("../../../src/lib/db/core.ts");
const nvidia = await import("../../../src/lib/db/nvidiaModelAvailability.ts");
const route = await import("../../../src/lib/db/nativeRouteMissQuarantine.ts");
const selected = nvidia.captureNvidiaSelectionProof(
  "nvidia",
  "fixture-account-a",
  "bigcode/starcoder2-15b",
  "r1"
);
const proof = route.captureNativeRouteMissProof(
  "nvidia",
  "fixture-account-a",
  "bigcode/starcoder2-15b",
  "https://integrate.api.nvidia.com/v1/chat/completions",
  selected
);
assert.ok(route.getNativeRouteMiss(proof), "fresh process must see the validated stored tuple");
console.log("ROUTE_MISS_REOPEN:true");
core.resetDbInstance();
