#!/usr/bin/env bash
set -euo pipefail

# Exercise the built HTTP entrypoint with an empty disposable store. The model
# deliberately cannot resolve to an upstream, even with the guard disabled.
mkdir -p security-evidence
export DATA_DIR
DATA_DIR=$(mktemp -d)
export JWT_SECRET=ci-security-secret-with-sufficient-length-for-validation
export API_KEY_SECRET=ci-security-api-key-secret-long
export HOSTNAME=127.0.0.1
export PORT=${SECURITY_TEST_PORT:-20128}
export OMNIROUTE_URL="http://127.0.0.1:$PORT"
export REQUIRE_API_KEY=false
export PROMPTFOO_DISABLE_TELEMETRY=1
export PROMPTFOO_DISABLE_UPDATE=1
export DISABLE_SQLITE_AUTO_BACKUP=true
server_pid=
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

for mode in warn block; do
  INJECTION_GUARD_MODE=$mode node "${SECURITY_SERVER_ENTRY:-dist/server.js}" > "security-evidence/server-$mode.log" 2>&1 &
  server_pid=$!
  ready=false
  for i in $(seq 1 60); do
    kill -0 "$server_pid" 2>/dev/null || break
    # A real route response, not a listening socket; actual guard semantics are
    # checked by promptfoo below. No valid provider model exists in this store.
    status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
      -X POST -H 'Content-Type: text/plain' --data 'startup probe' \
      "$OMNIROUTE_URL/v1/chat/completions" || true)
    if [ "$status" = 415 ]; then ready=true; break; fi
    sleep 1
  done
  if [ "$ready" != true ]; then
    cat "security-evidence/server-$mode.log"
    echo 'Built server did not become ready' >&2
    exit 1
  fi
  result=0
  ./node_modules/.bin/promptfoo eval -c promptfooconfig.yaml --no-cache \
    --output "security-evidence/$mode.json" || result=$?
  node --input-type=module - "$mode" "$result" <<'JS'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const [mode, exitCode] = process.argv.slice(2);
const report = JSON.parse(readFileSync(`security-evidence/${mode}.json`, 'utf8'));
const rows = report.results.results;
assert.equal(rows.length, 2, 'Both adversarial cases must run');
if (mode === 'block') assert.equal(Number(exitCode), 0);
for (const row of rows) {
  assert.equal(row.gradingResult.pass, mode === 'block');
  const body = row.response.output;
  assert.equal(body.httpStatus, mode === 'block' ? 400 : 404);
  assert.equal(body.error.code, mode === 'block' ? 'SECURITY_001' : 'model_not_found');
}
// promptfoo aborts aggregate accounting on HTTP 404. For the negative control,
// require both actual responses and failed assertions above, never a generic
// nonzero exit. The positive run must also finish its aggregate accounting.
if (mode === 'block') {
  assert.equal(report.results.stats.errors, 0);
  assert.equal(report.results.stats.successes, 2);
  assert.equal(report.results.stats.failures, 0);
  const benign = await fetch(`${process.env.OMNIROUTE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'security-canary-no-provider/does-not-exist',
      messages: [{ role: 'user', content: 'What is two plus two?' }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(benign.status, 404);
  assert.equal((await benign.json()).error.code, 'model_not_found');
  console.log('Benign control passed the guard without an upstream request');
}
console.log(`${mode}: verified both HTTP responses and ${mode === 'block' ? 'passing' : 'failing'} assertions`);
JS
  kill "$server_pid"
  wait "$server_pid" 2>/dev/null || true
  server_pid=
done
