#!/bin/bash

set -euo pipefail
source "$(realpath "$(dirname $0)/environment.sh")"

# This basically runs 'sed -i', but works on both GNU and BSD sed by manually creating a temporary file instead of using the -i flag.
# The last argument is the file to operate on, everything else is passed to sed.
# If the specified file doesn't exist, this is ignored silently.

FILE=${@: -1}
if [[ -z "$FILE" ]]; then
  echo "No file specified."
  exit 1
fi

if [[ ! -f "$FILE" ]]; then
  exit 0
fi

TMPFILE=$(mktemp)

# helper function to restore the temp file to the original file, if that one doesn't exist
function restore() {
  if [[ ! -f "$FILE" ]] && [[ -f "$TMPFILE" ]]; then
    mv "$TMPFILE" "$FILE"
  fi
}

trap restore EXIT

mv "$FILE" "$TMPFILE"
cat "$TMPFILE" | sed "${@:1:$#-1}" > "$FILE"
rm -f "$TMPFILE"
