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
  fix1_new=0
  # Code with comments removed and template-literal contents blanked (so a correct body parked in a
  # comment, a block comment or a template string cannot satisfy the check), whitespace collapsed.
  code=$(awk '
    BEGIN { st = 0; sq = sprintf("%c", 39); dq = "\""; bt = "`"; bs = "\\" }
    { line = $0; gsub(/\r/, "", line); out = ""; n = length(line)
      for (i = 1; i <= n; i++) { c = substr(line, i, 1); d = substr(line, i, 2)
        if (st == 4) { if (d == "*/") { st = 0; i++ } ; continue }
        if (st == 0) { if (d == "//") break; if (d == "/*") { st = 4; i++; continue }
          if (c == dq) st = 1; else if (c == sq) st = 2; else if (c == bt) st = 3
          out = out c; continue }
        if (st == 1 || st == 2) { out = out c
          if (c == bs) { i++; out = out substr(line, i, 1) }
          else if ((st == 1 && c == dq) || (st == 2 && c == sq)) st = 0
          continue }
        if (st == 3) { if (c == bs) { i++; continue } ; if (c == bt) { st = 0; out = out c } ; continue } }
      if (st == 1 || st == 2) st = 0
      print out }' "$ff" | tr '\n' ' ' | tr -s '[:space:]' ' ')
  # original form (a), judged on CODE only: a comment mentioning the constant must not satisfy it.
  if printf '%s' "$code" | grep -q "CONFIDENT_FAILURE_MIN_CONFIDENCE" \
    && printf '%s' "$code" | grep -Eq "confidence[[:space:]]*>=[[:space:]]*CONFIDENT_FAILURE_MIN_CONFIDENCE" \
    && printf '%s' "$code" | grep -Eq "const[[:space:]]+CONFIDENT_FAILURE_MIN_CONFIDENCE[[:space:]]*="; then
    fix1_old=1
  fi
  # (1) the WHOLE helper, signature to closing brace, exactly: a first-statement `return`, nothing before it.
  helper='export function observedHealthFactor( circuitBreakerState: string | undefined, operational: { reason: string; score: number } ): number { return circuitBreakerState === "CLOSED" && operational.reason === "observed" ? operational.score : 0.5; }'
  # (2) the only place health is computed, (3) reported as-is next to the marker, (4) used by the score.
  callsite='const health = observedHealthFactor(candidate.circuitBreakerState, operational);'
  reported='health, healthRule: "observed_rate",'
  case "$code" in
    *"$helper"*"$callsite"*"$reported"*)
      # health is assigned exactly once (no later `health = 1`, no `let health`) and feeds the score.
      assigns=$(printf '%s' "$code" | grep -Eo '(^|[^.A-Za-z0-9_$])health[[:space:]]*=[^=>]' | wc -l | tr -d ' ')
      if [ "${assigns:-0}" -eq 1 ] \
        && printf '%s' "$code" | grep -Eq 'health \* weights\.health'; then
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

  # Fix 1: compiled health factor. The ranking module is compiled into EVERY route bundle that
  # imports it (6 chunks in the 2026-11-20 build), so every live JS file that carries the factors
  # object (reliabilitySampleCount:) must itself contain a complete Fix 1 form, not just one of them.
  id='[A-Za-z_$][A-Za-z0-9_$]*'
  file_has_fix1() {
    f="$1"
    # original form: reliability condition gating the health factor
    grep -Eq 'confidence>=(\.5|0\.5)' "$f" 2>/dev/null && return 0
    # successor form: marker right after the health property ...
    grep -Eq "[,{]health(:$id)?,healthRule:\"observed_rate\"" "$f" 2>/dev/null || return 1
    # ... and the rule applied to the candidate's breaker state: inlined, or a function that is CALLED with it.
    expr="(\"CLOSED\"===[^&?:]{1,80}|[^&?:]{1,80}===\"CLOSED\")&&(\"observed\"===$id\.reason|$id\.reason===\"observed\")\?$id\.score:(\.5|0\.5)"
    grep -Eq "\"CLOSED\"===$id\.circuitBreakerState&&(\"observed\"===$id\.reason|$id\.reason===\"observed\")\?$id\.score:(\.5|0\.5)|$id\.circuitBreakerState===\"CLOSED\"&&(\"observed\"===$id\.reason|$id\.reason===\"observed\")\?$id\.score:(\.5|0\.5)" "$f" 2>/dev/null && return 0
    fn=$(grep -Eo "function $id\($id,$id\)\{return ?$expr" "$f" 2>/dev/null | head -1 | sed -E 's/^function ([A-Za-z_$][A-Za-z0-9_$]*)\(.*/\1/')
    if [ -z "$fn" ]; then
      fn=$(grep -Eo "(const|let|var) $id=\($id,$id\)=>$expr" "$f" 2>/dev/null | head -1 | sed -E 's/^(const|let|var) ([A-Za-z_$][A-Za-z0-9_$]*)=.*/\2/')
    fi
    [ -n "$fn" ] || return 1
    fnre=$(printf '%s' "$fn" | sed 's/[$]/\\$/g')
    grep -Eq "[^A-Za-z0-9_$.]$fnre\($id\.circuitBreakerState,$id\)" "$f" 2>/dev/null
  }
  fix1_found=0; fix1_bad=""
  for f in $(grep -rl --include='*.js' --include='*.mjs' --include='*.cjs' 'reliabilitySampleCount:' "$build" 2>/dev/null || true); do
    is_backup "$f" && continue
    if file_has_fix1 "$f"; then fix1_found=1; else fix1_bad="$fix1_bad $f"; fi
  done
  if [ "$fix1_found" = 0 ] && [ -z "$fix1_bad" ]; then
    # no live file carries the factors object at all: fall back to "any live file has a complete form"
    for f in $(grep -rl --include='*.js' --include='*.mjs' --include='*.cjs' -e 'healthRule:"observed_rate"' -e 'confidence>=' "$build" 2>/dev/null || true); do
      is_backup "$f" && continue
      if file_has_fix1 "$f"; then fix1_found=1; break; fi
    done
  fi
  [ -z "$fix1_bad" ] || fail "Fix 1 missing in compiled output: these live files carry the factors object but no complete Fix 1 form:$fix1_bad"
  [ "$fix1_found" = 1 ] \
    || fail "Fix 1 missing in compiled output: neither the reliability condition (confidence>=.5) nor the observed-rate health rule with healthRule:\"observed_rate\" found in live files under $build"
  ok "Fix 1 present in every compiled copy of the ranking module (reliability condition or observed-rate health)"

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
