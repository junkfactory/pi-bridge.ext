#!/usr/bin/env bash
# Release-trigger helper. Run from repo root BEFORE pushing.
# Usage: ./ci/tag.sh <version>   (e.g. 0.1.0)
# Set DRY_RUN=1 to skip the destructive steps (npm version, git push).
set -euo pipefail

cd "$(dirname "$0")/../.."

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <version> (semver, e.g. 0.1.0)" >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "main" ]]; then
  echo "Not on main (branch: '$BRANCH'). Aborting." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree not clean. Aborting." >&2
  exit 1
fi

npx vitest run

TAG="v$VERSION"
if [[ -n "${DRY_RUN:-}" ]]; then
  echo "DRY_RUN: npm version $VERSION"
  echo "DRY_RUN: git push origin main $TAG"
else
  npm version "$VERSION"
  git push origin main "$TAG"
fi

echo "Done. The $TAG push triggers the release job."
echo "Next steps: check the release notes; on protocol-change cuts, add the pairing line to the release notes afterward."
