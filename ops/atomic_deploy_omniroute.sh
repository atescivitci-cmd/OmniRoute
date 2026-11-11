#!/usr/bin/env bash
# ATOMIC_DEPLOY_V4 (2026-08-31) — PREPARED, NOT RUN.
#
# Why this exists: both failed V2 deployments used
#   rsync -a --delete-after --exclude 'node_modules/' package/ <live install>/
# over a RUNNING install. Codex then proved the exact TGZ boots correctly in
# isolation, which leaves install/restart state as the cause. Never replace a global
# package while an old Node process can still lazy-load files out of that directory.
#
# This script installs to a NEW directory and swaps it in with the service stopped,
# and treats a teardown warning as a HARD STOP rather than proof of anything.
#
# Usage:
#   bash atomic_deploy_omniroute.sh --package <new.tgz> --rollback <preinstall.tgz> \
#        [--expect-sha <sha256>] [--rollback-sha <sha256>] [--dry-run]
set -uo pipefail

PKG=""; ROLLBACK=""; EXPECT_SHA=""; ROLLBACK_SHA=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --package) PKG="$2"; shift 2;;
    --rollback) ROLLBACK="$2"; shift 2;;
    --expect-sha) EXPECT_SHA="$2"; shift 2;;
    --rollback-sha) ROLLBACK_SHA="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$PKG" ] && [ -n "$ROLLBACK" ] || { echo "usage: --package <tgz> --rollback <tgz>" >&2; exit 2; }

OMNI_LABEL="io.simplesmartai.omniroute"
HR_LABEL="io.simplesmartai.headroom"
ROOT="$(npm root -g)"
LIVE="$ROOT/omniroute"
OMNI_URL="http://127.0.0.1:20128"
HR_URL="http://127.0.0.1:8791"
VAULT="${VAULT_PATH:-$HOME/cammy/brain-repo/Cammy AI EA/00 Brain/credentials/Ates Secret Master.env}"
U="$(id -u)"
say(){ echo "==> $*"; }
die(){ echo "FATAL: $*" >&2; exit 1; }
run(){ [ "$DRY" = "1" ] && { echo "    [dry-run] $*"; return 0; }; eval "$@"; }

# ---- 1. verify both SHAs BEFORE touching anything --------------------------------
say "1. verifying package identity"
[ -f "$PKG" ] || die "package not found: $PKG"
[ -f "$ROLLBACK" ] || die "rollback tgz not found: $ROLLBACK — refusing to deploy without a proven rollback"
a=$(shasum -a 256 "$PKG" | awk '{print $1}')
b=$(shasum -a 256 "$ROLLBACK" | awk '{print $1}')
echo "    package:  $a"
echo "    rollback: $b"
[ -n "$EXPECT_SHA" ] && { [ "$a" = "$EXPECT_SHA" ] || die "package sha mismatch"; }
[ -n "$ROLLBACK_SHA" ] && { [ "$b" = "$ROLLBACK_SHA" ] || die "rollback sha mismatch"; }

TOKEN="$(grep -m1 '^OMNIROUTE_ENDPOINT_TOKEN=' "$VAULT" | cut -d= -f2- | tr -d '"'"'"'\r' || true)"
[ -n "$TOKEN" ] || die "OMNIROUTE_ENDPOINT_TOKEN not in vault"

smoke(){  # $1=base url -> echoes http code for /v1/messages
  curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST "$1/v1/messages" \
    -H "Authorization: Bearer $TOKEN" -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d '{"model":"ac-quality-fallback","max_tokens":4,"messages":[{"role":"user","content":"ping"}]}' || echo 000
}

# ---- 2. stop Headroom -------------------------------------------------------------
say "2. stopping Headroom"
run "launchctl bootout gui/$U/$HR_LABEL 2>/dev/null || true"

# ---- 3. stop OmniRoute, and PROVE it is gone (all three, or abort) ----------------
say "3. stopping OmniRoute and proving it is gone"
OLD_PID="$(lsof -nP -iTCP:20128 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')"
run "launchctl bootout gui/$U/$OMNI_LABEL 2>/dev/null || true"
if [ "$DRY" = "0" ]; then
  ok=0
  for i in $(seq 1 60); do
    j=1; launchctl list "$OMNI_LABEL" >/dev/null 2>&1 && j=0
    p=1; lsof -nP -iTCP:20128 -sTCP:LISTEN >/dev/null 2>&1 && p=0
    q=1; [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null && q=0
    if [ "$j" = 1 ] && [ "$p" = 1 ] && [ "$q" = 1 ]; then ok=1; echo "    job absent, port unbound, pid gone (${i}00ms)"; break; fi
    sleep 0.5
  done
  # A teardown warning is a HARD STOP before install -- never proceed on a maybe.
  [ "$ok" = "1" ] || die "OmniRoute did not fully stop (job/port/pid). REFUSING to install over a live tree."
fi

# ---- 4. install to a NEW directory, then swap ------------------------------------
say "4. installing to a new directory (no in-place mixing)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/omniroute-stage-XXXXXX")"
run "tar xzf '$PKG' -C '$STAGE'"
[ "$DRY" = "1" ] || [ -d "$STAGE/package" ] || die "package/ not found in tgz"
# node_modules is not shipped; carry the existing one across by COPY, not symlink.
if [ "$DRY" = "0" ] && [ -d "$LIVE/node_modules" ]; then
  say "    copying node_modules into the new tree (this is the slow step)"
  cp -R "$LIVE/node_modules" "$STAGE/package/node_modules"
fi
PREV="$LIVE.prev.$(date +%s)"
run "mv '$LIVE' '$PREV'"
run "mv '$STAGE/package' '$LIVE'"
echo "    previous tree parked at: $PREV"

# ---- 5. verify installed identity BEFORE starting --------------------------------
say "5. verifying installed tree before start"
if [ "$DRY" = "0" ]; then
  python3 - "$LIVE/dist" <<'PY' || die "installed tree has missing chunk references"
import json,os,sys
base=os.path.join(sys.argv[1],'.build','next','server')
bad=0
for t in ['app/api/v1/messages/route.js.nft.json','app/api/v1/chat/completions/route.js.nft.json']:
    f=os.path.join(base,t)
    if not os.path.exists(f): print("    MISSING NFT:",t); bad=1; continue
    d=json.load(open(f))
    miss=[r for r in d.get('files',[]) if '/chunks/' in r
          and not os.path.exists(os.path.normpath(os.path.join(os.path.dirname(f),r)))]
    print(f"    {t.split('/route')[0].replace('app/api/','')}: {len(miss)} missing chunk refs")
    if miss: bad=1
sys.exit(bad)
PY
fi

# ---- 6. start OmniRoute, capture raw output, prove routes load --------------------
say "6. starting OmniRoute"
run "launchctl bootstrap gui/$U '$HOME/Library/LaunchAgents/$OMNI_LABEL.plist'"
if [ "$DRY" = "0" ]; then
  up=0
  for i in $(seq 1 60); do
    c=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$OMNI_URL/api/monitoring/health" || echo 000)
    [ "$c" = "200" ] && { up=1; echo "    direct health 200 after ${i}s"; break; }
    sleep 1
  done
  if [ "$up" != "1" ]; then
    echo "    --- raw child output ---" >&2
    tail -40 "$HOME/Library/Logs/cammy/omniroute-stderr.log" 2>/dev/null >&2
    grep '"level":"error"' "$HOME/.omniroute/logs/application/app.log" 2>/dev/null | tail -5 >&2
    die "OmniRoute did not reach direct health 200"
  fi
  d=$(smoke "$OMNI_URL")
  echo "    direct /v1/messages -> $d"
  case "$d" in 500|000) die "critical route did not load (HTTP $d)";; esac
fi

# ---- 7/8. start Headroom, require authenticated round trip ------------------------
say "7. starting Headroom"
run "launchctl bootstrap gui/$U '$HOME/Library/LaunchAgents/$HR_LABEL.plist'"
if [ "$DRY" = "0" ]; then
  hr=000
  for i in $(seq 1 30); do hr=$(smoke "$HR_URL"); [ "$hr" = "200" ] && break; sleep 1; done
  echo "    headroom round-trip -> $hr"
  [ "$hr" = "200" ] || die "authenticated Headroom round trip failed (HTTP $hr)"
fi

say "DEPLOY OK. Previous tree kept at $PREV — remove only after a real session passes."
