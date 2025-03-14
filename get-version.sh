#!/bin/bash -eu

set -euo pipefail
source "$(realpath "$(dirname $0)/environment.sh")"

if [[ -n "${VERSION_OVERRIDE:-}" ]]; then
  echo -n "$VERSION_OVERRIDE"
  exit 0
fi

VERSION="$(cat "${PROJECT_ROOT}/VERSION")"

(
  cd "$PROJECT_ROOT"

  if [[ "$VERSION" = *-dev ]] ; then
    VERSION="$VERSION-$(git rev-parse HEAD)"
  fi
  
  echo "$VERSION"
)
