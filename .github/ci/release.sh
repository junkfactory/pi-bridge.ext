#!/usr/bin/env bash
# Runs inside GitHub Actions on a v* tag push.
set -euo pipefail

TAG="${GITHUB_REF_NAME:-}"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "GITHUB_REF_NAME '$TAG' is not a valid release tag." >&2
  exit 1
fi

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG already exists; nothing to do."
  exit 0
fi

gh release create "$TAG" --generate-notes --title "$TAG"
