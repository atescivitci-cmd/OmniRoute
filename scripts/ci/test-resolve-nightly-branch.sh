#!/usr/bin/env bash
set -euo pipefail
script=$(cd "$(dirname "$0")" && pwd)/resolve-nightly-branch.sh
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cd "$fixture"
git init -q
git -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -qm fixture
sha=$(git rev-parse HEAD)
for branch in cammy/v4-instrumentation-diagnosis release/v3.8.9 release/v3.8.49; do
  git update-ref "refs/remotes/origin/$branch" "$sha"
done
export GITHUB_OUTPUT="$fixture/output"
unset INPUT_BRANCH
export GITHUB_REPOSITORY=atescivitci-cmd/omniroute-cammy
export DEFAULT_BRANCH=cammy/v4-instrumentation-diagnosis
bash "$script"
test "$(cat "$GITHUB_OUTPUT")" = 'target=cammy/v4-instrumentation-diagnosis'
: > "$GITHUB_OUTPUT"
GITHUB_REPOSITORY=upstream/OmniRoute bash "$script"
test "$(cat "$GITHUB_OUTPUT")" = 'target=release/v3.8.49'
for invalid in missing 'refs/heads/main' '../main' $'main\ntarget=evil'; do
  if INPUT_BRANCH="$invalid" bash "$script"; then exit 1; fi
done
if GITHUB_REPOSITORY=upstream/OmniRoute INPUT_BRANCH=cammy/v4-instrumentation-diagnosis bash "$script"; then exit 1; fi
git update-ref -d refs/remotes/origin/release/v3.8.9
git update-ref -d refs/remotes/origin/release/v3.8.49
if GITHUB_REPOSITORY=upstream/OmniRoute bash "$script"; then exit 1; fi
echo 'PASS: fork default, highest release, missing and malformed branches, upstream boundary'
