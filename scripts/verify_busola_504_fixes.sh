#!/bin/sh
# VERIFY_BUSOLA_504_FIXES — fail the build/install if either stability fix is missing.
#
# Two fixes from OmniRoute branch ates/busola-504-stability-20261111 (merge 9e13e2c):
#   Fix 1 (fitFirstPolicy.ts): a model that fails more than half the time no longer gets
#          health factor 1.0. Two accepted forms, either one satisfies the guard:
#            (a) original form: >=20 samples and reliability <0.5; marker
#                CONFIDENT_FAILURE_MIN_CONFIDENCE and `confidence >= CONFIDENT_FAILURE_MIN_CONFIDENCE`.
#            (b) successor form (OmniRoute fork PR #42, volume-blind health): the exported helper
#                `observedHealthFactor`, whose body must be exactly
#                  return circuitBreakerState === "CLOSED" && operational.reason === "observed"
#                    ? operational.score : 0.5;
#                (health is the observed success rate, never 1.0 for a failing model, no sample
#                gate), used for the health factor, plus the runtime marker
#                healthRule: "observed_rate", (object literal, trailing comma: the interface member
#                ends in a semicolon and must not satisfy the check) in every decision's factors. In compiled output the
#                same expression must be present (minified: "CLOSED"===x&&"observed"===y.reason?y.score:.5)
#                together with healthRule:"observed_rate".
#          A build that has neither form must not ship. Changing form (b) requires changing this
#          guard and tests/unit/busola-504-guard-20261121.test.ts in the same PR.
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

  # Fix 1: a failing model must not get health 1.0. Accept the original form (a) or the
  # successor form (b); fail if neither is complete.
  fix1_old=0
  if grep -q "CONFIDENT_FAILURE_MIN_CONFIDENCE" "$ff" \
    && grep -Eq "confidence[[:space:]]*>=[[:space:]]*CONFIDENT_FAILURE_MIN_CONFIDENCE" "$ff"; then
    fix1_old=1
  fi
  fix1_new=0
  # Body of the exported helper, whitespace collapsed to single spaces, comments excluded (the
  # doc comment sits above the function; a one-line // comment inside the body is dropped).
  body=$(awk '/^export function observedHealthFactor[[:space:]]*\(/ {f=1} f {print} f && /^}/ {exit}' "$ff" \
    | sed 's#//.*$##' | tr '\n' ' ' | tr -s '[:space:]' ' ')
  expect='return circuitBreakerState === "CLOSED" && operational.reason === "observed" ? operational.score : 0.5; }'
  case "$body" in
    *"$expect"*)
      calls=$(grep -c 'observedHealthFactor(' "$ff" || true)
      if [ "${calls:-0}" -ge 2 ] \
        && grep -Eq 'const health = observedHealthFactor\(' "$ff" \
        && grep -Eq 'healthRule:[[:space:]]*"observed_rate"[[:space:]]*,' "$ff"; then
        fix1_new=1
      fi
      ;;
  esac
  if [ "$fix1_old" = 1 ]; then
    ok "Fix 1 present in source, original form (fitFirstPolicy.ts)"
  elif [ "$fix1_new" = 1 ]; then
    ok "Fix 1 present in source, observed-rate successor (observedHealthFactor, fitFirstPolicy.ts)"
  else
    fail "Fix 1 missing: neither CONFIDENT_FAILURE_MIN_CONFIDENCE (original) nor the complete observedHealthFactor rule (successor) in fitFirstPolicy.ts"
  fi

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
  # Successor form (b): the minified observed-rate expression AND the runtime marker, in the
  # SAME live file. Operand order may be flipped by the minifier ("CLOSED"===x or x==="CLOSED").
  if [ "$fix1_found" = 0 ]; then
    id='[A-Za-z_$][A-Za-z0-9_$]*'
    for f in $(grep -rl 'healthRule:"observed_rate"' "$build" 2>/dev/null || true); do
      is_backup "$f" && continue
      if grep -Eq "(\"CLOSED\"===[^&?:]{1,80}|[^&?:]{1,80}===\"CLOSED\")&&(\"observed\"===$id\.reason|$id\.reason===\"observed\")\?$id\.score:(\.5|0\.5)" "$f" 2>/dev/null; then
        fix1_found=1; break
      fi
    done
  fi
  [ "$fix1_found" = 1 ] \
    || fail "Fix 1 missing in compiled output: neither the reliability condition (confidence>=.5) nor the observed-rate health expression with healthRule:\"observed_rate\" found in live files under $build"
  ok "Fix 1 present in compiled output (reliability condition or observed-rate health)"

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
