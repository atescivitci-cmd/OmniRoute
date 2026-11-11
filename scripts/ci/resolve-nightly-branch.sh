#!/usr/bin/env bash
set -euo pipefail

# Fork nightlies validate the maintained default branch; upstream retains its
# highest-release default. Explicit dispatches must name an existing branch.
target=${INPUT_BRANCH:-}
if [ -z "$target" ]; then
  if [ "${GITHUB_REPOSITORY:-}" = "atescivitci-cmd/omniroute-cammy" ]; then
    target=${DEFAULT_BRANCH:?Repository default branch is required}
  else
    target=$(git for-each-ref --format='%(refname:strip=3)' 'refs/remotes/origin/release/v*' | sort -V | tail -1)
  fi
fi
git check-ref-format "refs/heads/$target" >/dev/null
git show-ref --verify --quiet "refs/remotes/origin/$target" || {
  echo "Target is not an existing remote branch: $target" >&2
  exit 1
}
if [ "${GITHUB_REPOSITORY:-}" != "atescivitci-cmd/omniroute-cammy" ] &&
  [[ ! "$target" =~ ^release/v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Refusing non-canonical release branch: $target" >&2
  exit 1
fi
echo "Validating branch: $target"
echo "target=$target" >> "${GITHUB_OUTPUT:?}"
