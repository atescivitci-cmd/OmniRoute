#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CRITICAL_ROUTES = [
  "server/app/api/v1/messages/route.js",
  "server/app/api/v1/chat/completions/route.js",
];

function walk(dir, predicate, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, output);
    else if (predicate(full)) output.push(full);
  }
  return output;
}

function strings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, output));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => strings(item, output));
  }
  return output;
}

function nextRelativeReference(raw) {
  const normalized = String(raw).replaceAll("\\", "/");
  const marker = ".build/next/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);
  if (normalized.startsWith("static/")) return normalized;
  if (normalized.startsWith("server/")) return normalized;
  return null;
}

function manifestReference(raw, manifestPath, nextRoot) {
  if (!/\.(?:js|css|json|html|map|woff2?|wasm)$/i.test(raw)) return null;
  const normalized = raw.replaceAll("\\", "/");
  if (normalized.startsWith("static/") || normalized.startsWith("server/")) {
    return path.join(nextRoot, normalized);
  }
  if (normalized.startsWith("app/") || normalized.startsWith("pages/")) {
    return path.join(nextRoot, "server", normalized);
  }
  if (normalized.startsWith("chunks/") && manifestPath.includes(`${path.sep}server${path.sep}`)) {
    return path.join(nextRoot, "server", normalized);
  }
  return null;
}

export function validateNextRuntimeArtifact(packageRoot) {
  const root = path.resolve(packageRoot);
  const nextRoot = path.join(root, ".build", "next");
  const missing = new Set();
  const checked = new Set();
  const nftFiles = walk(nextRoot, (file) => file.endsWith(".nft.json"));

  for (const nftPath of nftFiles) {
    const parsed = JSON.parse(fs.readFileSync(nftPath, "utf8"));
    for (const raw of parsed.files || []) {
      const relative = nextRelativeReference(raw);
      if (!relative || !relative.startsWith("server/chunks/")) continue;
      const target = path.join(nextRoot, relative);
      checked.add(target);
      if (!fs.existsSync(target)) missing.add(target);
    }
  }

  const manifestFiles = walk(nextRoot, (file) => /manifest\.json$/i.test(file));
  for (const manifestPath of manifestFiles) {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const raw of strings(parsed)) {
      const target = manifestReference(raw, manifestPath, nextRoot);
      if (!target) continue;
      checked.add(target);
      if (!fs.existsSync(target)) missing.add(target);
    }
  }

  for (const criticalRoute of CRITICAL_ROUTES) {
    const target = path.join(nextRoot, criticalRoute);
    checked.add(target);
    if (!fs.existsSync(target)) missing.add(target);
  }

  return {
    ok: missing.size === 0,
    nftCount: nftFiles.length,
    manifestCount: manifestFiles.length,
    checkedCount: checked.size,
    missing: [...missing].map((target) => path.relative(root, target)).sort(),
  };
}

function main() {
  const packageRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve("dist");
  const result = validateNextRuntimeArtifact(packageRoot);
  if (!result.ok) {
    console.error("[runtime-artifact] missing referenced runtime files:");
    result.missing.forEach((file) => console.error(`  - ${file}`));
    process.exit(1);
  }
  console.log(
    `[runtime-artifact] OK: ${result.checkedCount} references across ` +
      `${result.nftCount} NFT files and ${result.manifestCount} manifests`
  );
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
