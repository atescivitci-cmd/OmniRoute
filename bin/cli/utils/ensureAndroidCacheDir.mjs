/**
 * Next.js cache-dir prep for Android / Termux.
 *
 * Next.js `getCacheDirectory()` has no dedicated branch for
 * `process.platform === "android"`. On that path it only accepts a cache root
 * that *already* exists (`fs.existsSync` on `~/.cache` or a generic tmp dir).
 * If neither exists it prints `Unsupported platform: android` and exits — the
 * CLI can still look "running" while every request returns a bare HTTP 500
 * because the instrumentation hook never loads (and so neither does logging).
 *
 * Termux Node sometimes reports `platform === "android"` and sometimes
 * `"linux"` with Termux env signals (`TERMUX_VERSION` / `PREFIX`). Creating
 * `~/.cache` (and pointing `XDG_CACHE_HOME` at it when unset) makes the probe
 * succeed on both shapes.
 *
 * Call this *before* spawning or loading Next.js. Safe no-op on desktop
 * platforms that are not Termux.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isTermux } from "../../../scripts/build/postinstallSupport.mjs";

/**
 * @param {string} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function needsAndroidCacheDirPrep(platform = process.platform, env = process.env) {
  return platform === "android" || isTermux(env);
}

/**
 * @param {() => string} [homedirFn]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveAndroidCacheDir(homedirFn = homedir, env = process.env) {
  if (typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME.trim()) {
    return env.XDG_CACHE_HOME;
  }
  return join(homedirFn(), ".cache");
}

/**
 * Ensure a writable cache directory exists for Next.js on Android/Termux.
 *
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {() => string} [options.homedirFn]
 * @param {typeof mkdirSync} [options.mkdirSyncFn]
 * @param {typeof existsSync} [options.existsSyncFn]
 * @param {boolean} [options.setEnv] When true (default), set `XDG_CACHE_HOME` on `env`
 *   if unset so child processes inherit a known-writable cache root.
 * @returns {{ prepared: boolean, cacheDir: string | null, created: boolean }}
 */
export function ensureAndroidCacheDir(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    homedirFn = homedir,
    mkdirSyncFn = mkdirSync,
    existsSyncFn = existsSync,
    setEnv = true,
  } = options;

  if (!needsAndroidCacheDirPrep(platform, env)) {
    return { prepared: false, cacheDir: null, created: false };
  }

  const cacheDir = resolveAndroidCacheDir(homedirFn, env);
  let created = false;
  if (!existsSyncFn(cacheDir)) {
    mkdirSyncFn(cacheDir, { recursive: true });
    created = true;
  }

  if (setEnv && !(typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME.trim())) {
    env.XDG_CACHE_HOME = cacheDir;
  }

  return { prepared: true, cacheDir, created };
}

/**
 * Detect Next.js instrumentation-hook failures that leave the server looking
 * "up" while requests get silent HTTP 500s (typical when the Android cache
 * probe failed before logging started).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isFatalInstrumentationHookFailure(text) {
  if (!text) return false;
  return (
    /Unsupported platform:\s*android/i.test(text) ||
    /error occurred while loading instrumentation hook/i.test(text)
  );
}

/**
 * INSTRUMENTATION_DIAGNOSIS_SPLIT_V4 (2026-08-31)
 *
 * Is this instrumentation failure ACTUALLY an Android/Termux cache problem?
 *
 * isFatalInstrumentationHookFailure() above is deliberately broad -- it matches any
 * instrumentation-hook failure so the supervisor can surface something rather than
 * swallow it. Using that same predicate to choose the ADVICE was the defect: on
 * 2026-08-31 a macOS host with an existing, writable ~/.cache (owner atescivitci:staff,
 * mode 755) was told to `mkdir -p ~/.cache`, while ServerSupervisor suppressed the real
 * child exception. The operator chased a non-existent cache problem and the actual boot
 * failure was never printed.
 *
 * Android cache advice is correct ONLY when the platform genuinely needs the prep, or
 * when Next.js itself said so. Everything else gets the generic path.
 *
 * @param {string} text raw child output
 * @param {string} [platform] process.platform
 * @param {object} [env] process.env
 * @returns {boolean}
 */
export function isAndroidCacheInstrumentationFailure(
  text,
  platform = process.platform,
  env = process.env
) {
  if (!isFatalInstrumentationHookFailure(text)) return false;
  // Next.js said it explicitly -- authoritative regardless of what we detect.
  if (/Unsupported platform:\s*android/i.test(text)) return true;
  // Otherwise only when this host actually needs the Android/Termux cache prep.
  return needsAndroidCacheDirPrep(platform, env);
}

/**
 * Operator-facing text for a GENERIC instrumentation-hook failure -- the non-Android
 * path. Prints the original child output rather than a guess, because the whole point
 * of V4 is that the real exception was being replaced by a wrong diagnosis.
 *
 * @param {string} text raw child output to surface verbatim
 * @returns {string}
 */
export function formatGenericInstrumentationFailureHint(text) {
  const raw = (text || "").trimEnd();
  return (
    `\n\x1b[31m✖ Next.js instrumentation hook failed to load.\x1b[0m\n` +
    `  This is the original error from the server process:\n\n` +
    `${raw}\n\n` +
    `  Re-run with \x1b[36momniroute serve --log\x1b[0m for the full child output.\n`
  );
}

/**
 * Operator-facing hint when that instrumentation failure shows up in child
 * output — defense in depth if prep was skipped or a future Next.js probe
 * regresses.
 *
 * @param {string} [cacheDir]
 * @returns {string}
 */
export function formatAndroidInstrumentationFailureHint(cacheDir) {
  const dir = cacheDir || join(homedir(), ".cache");
  return (
    `\n\x1b[31m✖ Next.js instrumentation failed on Android/Termux (likely missing cache dir).\x1b[0m\n` +
    `  OmniRoute tried to create a writable cache at:\n` +
    `    \x1b[36m${dir}\x1b[0m\n` +
    `  Manual workaround (survives reinstalls — do NOT patch dist/server.js):\n` +
    `    \x1b[36mmkdir -p ~/.cache\x1b[0m\n` +
    `    then restart: \x1b[36momniroute serve\x1b[0m\n` +
    `  See: docs/guides/TERMUX_GUIDE.md → Troubleshooting → Unsupported platform: android\n`
  );
}
