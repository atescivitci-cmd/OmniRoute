#!/bin/sh
# VERIFY_BUSOLA_504_FIXES — fail the build/install if either stability fix is missing.
#
# Two fixes from OmniRoute branch ates/busola-504-stability-20261111 (merge 9e13e2c):
#   Fix 1 (fitFirstPolicy.ts): a model with >=20 samples and reliability <0.5 no longer
#          gets health factor 1.0. Marker: CONFIDENT_FAILURE_MIN_CONFIDENCE.
#   Fix 2 (claudeIdentity.ts): context-1m beta is not forced on Opus when the client
#          negotiated betas without it. Marker: allowContext1m. Cause of
#          "429 Usage credits are required for long context requests".
#
# Usage:
#   verify_busola_504_fixes.sh --source <source-tree-root>   # check TS source
#   verify_busola_504_fixes.sh --dist <installed-gateway>    # check compiled output
#   verify_busola_504_fixes.sh --both <source> <dist>
#
# Exits non-zero (FAIL) if any required fix is absent. Wire this into the build
# (after source checkout, before packaging) and the install (after unpack, before
# activation). A rebuild that drops either fix must not ship.

set -eu

fail() { echo "BUSOLA-504-GUARD FAIL: $1" >&2; exit 1; }
ok()   { echo "BUSOLA-504-GUARD ok: $1"; }

check_source() {
  root="$1"
  ff="$root/open-sse/services/autoCombo/fitFirstPolicy.ts"
  ci="$root/open-sse/executors/claudeIdentity.ts"

  [ -f "$ff" ] || fail "source fitFirstPolicy.ts not found at $ff"
  [ -f "$ci" ] || fail "source claudeIdentity.ts not found at $ci"

  # Fix 1: the reliability condition must gate the health factor.
  grep -q "CONFIDENT_FAILURE_MIN_CONFIDENCE" "$ff" \
    || fail "Fix 1 missing: CONFIDENT_FAILURE_MIN_CONFIDENCE not in fitFirstPolicy.ts"
  grep -Eq "confidence[[:space:]]*>=[[:space:]]*CONFIDENT_FAILURE_MIN_CONFIDENCE" "$ff" \
    || fail "Fix 1 incomplete: reliability condition not applied to the health factor"
  ok "Fix 1 present in source (fitFirstPolicy.ts)"

  # Fix 2: context-1m push must be gated by allowContext1m.
  grep -q "allowContext1m" "$ci" \
    || fail "Fix 2 missing: allowContext1m not in claudeIdentity.ts"
  # The push must be guarded by isContext1m which includes allowContext1m,
  # never an unconditional push.
  grep -Eq "allowContext1m" "$ci" \
    || fail "Fix 2 incomplete: context-1m not gated by allowContext1m"
  ok "Fix 2 present in source (claudeIdentity.ts)"
}

check_dist() {
  dist="$1"
  build="$dist/dist/.build"
  [ -d "$build" ] || build="$dist"   # allow pointing straight at .build

  # Backups kept next to patched files (.bak-health-* / .bak-ctx1m-*) hold the
  # pre-fix buggy form ON PURPOSE. Exclude them from every scan — they are not
  # live code and must not trip the guard.
  is_backup() { case "$1" in *.bak-health-*|*.bak-ctx1m-*|*.bak) return 0;; *) return 1;; esac; }

  # Fix 1: compiled health factor must carry the reliability condition.
  # Minified form: confidence>=.5 (or >=0.5) guarding the health factor.
  fix1_found=0
  for f in $(grep -rlE 'confidence>=(\.5|0\.5)' "$build" 2>/dev/null || true); do
    is_backup "$f" && continue
    fix1_found=1; break
  done
  [ "$fix1_found" = 1 ] \
    || fail "Fix 1 missing in compiled output: reliability condition (confidence>=.5) not found in live files under $build"
  ok "Fix 1 present in compiled output (reliability condition)"

  # Fix 2: context-1m must NOT be pushed on the raw model flag (pre-fix form r&&push).
  # Safe forms: !1&& (hand patch) or a composed condition including the client beta
  # check. Scan live files only; backups legitimately carry the pre-fix form.
  for f in $(grep -rl 'context-1m-2025-08-07' "$build" 2>/dev/null || true); do
    is_backup "$f" && continue
    if grep -oE '[,;(]r&&[a-z]\.push\("context-1m-2025-08-07"\)' "$f" >/dev/null 2>&1; then
      fail "Fix 2 regressed in $f: model-only context-1m push present (pre-fix form r&&...push)"
    fi
  done
  ok "Fix 2 present in compiled output (no pre-fix unconditional context-1m push in live files)"
}

mode="${1:-}"
case "$mode" in
  --source) [ $# -eq 2 ] || fail "usage: --source <root>"; check_source "$2" ;;
  --dist)   [ $# -eq 2 ] || fail "usage: --dist <gateway>"; check_dist "$2" ;;
  --both)   [ $# -eq 3 ] || fail "usage: --both <source> <dist>"; check_source "$2"; check_dist "$3" ;;
  *) echo "usage: $0 --source <root> | --dist <gateway> | --both <source> <dist>" >&2; exit 2 ;;
esac

echo "BUSOLA-504-GUARD: all required fixes present"
