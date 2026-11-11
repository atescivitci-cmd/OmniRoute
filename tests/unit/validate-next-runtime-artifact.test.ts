import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateNextRuntimeArtifact } from "../../scripts/check/validate-next-runtime-artifact.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-runtime-artifact-"));
  const next = path.join(root, ".build", "next");
  const routeDir = path.join(next, "server", "app", "api", "v1", "messages");
  const chatDir = path.join(next, "server", "app", "api", "v1", "chat", "completions");
  const chunks = path.join(next, "server", "chunks");
  fs.mkdirSync(routeDir, { recursive: true });
  fs.mkdirSync(chatDir, { recursive: true });
  fs.mkdirSync(chunks, { recursive: true });
  fs.writeFileSync(path.join(routeDir, "route.js"), "route");
  fs.writeFileSync(path.join(chatDir, "route.js"), "route");
  fs.writeFileSync(path.join(chunks, "present.js"), "chunk");
  fs.writeFileSync(
    path.join(routeDir, "route.js.nft.json"),
    JSON.stringify({ files: ["../../../../../../chunks/present.js"] })
  );
  fs.writeFileSync(path.join(next, "build-manifest.json"), JSON.stringify({ pages: {} }));
  return root;
}

test("runtime artifact validator accepts a complete route graph", () => {
  const root = fixture();
  try {
    assert.equal(validateNextRuntimeArtifact(root).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime artifact validator catches a chunk referenced through a stale dist path", () => {
  const root = fixture();
  try {
    const nft = path.join(
      root,
      ".build",
      "next",
      "server",
      "app",
      "api",
      "v1",
      "messages",
      "route.js.nft.json"
    );
    fs.writeFileSync(
      nft,
      JSON.stringify({
        files: ["../../../../../../../../../dist/.build/next/server/chunks/missing.js"],
      })
    );
    const result = validateNextRuntimeArtifact(root);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [".build/next/server/chunks/missing.js"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
