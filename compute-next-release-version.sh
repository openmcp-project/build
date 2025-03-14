#!/bin/bash

set -euo pipefail
source "$(realpath "$(dirname $0)/environment.sh")"

if [[ -z "${VERSION:-}" ]]; then
  VERSION=$("$COMMON_SCRIPT_DIR/get-version.sh")
fi

semver=${1:-"minor"}

major=${VERSION%%.*}
major=${major#v}
minor=${VERSION#*.}
minor=${minor%%.*}
patch=${VERSION##*.}
patch=${patch%%-*}

case "$semver" in
  ("major")
    major=$((major + 1))
    minor=0
    patch=0
    ;;
  ("minor")
    minor=$((minor + 1))
    patch=0
    ;;
  ("patch")
    patch=$((patch + 1))
    ;;
  (*)
    echo "invalid argument: $semver"
    exit 1
    ;;
esac

echo -n "v$major.$minor.$patch"
