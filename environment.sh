#!/bin/bash

export COMMON_SCRIPT_DIR="$(realpath "$(dirname ${BASH_SOURCE[0]})")"
source "$COMMON_SCRIPT_DIR/lib.sh"
export PROJECT_ROOT="${PROJECT_ROOT:-$(realpath "$COMMON_SCRIPT_DIR/../..")}"
export COMPONENT_DEFINITION_FILE="${COMPONENT_DEFINITION_FILE:-"$PROJECT_ROOT/components/components.yaml"}"

if [[ -f "$COMMON_SCRIPT_DIR/../environment.sh" ]]; then
  source "$COMMON_SCRIPT_DIR/../environment.sh"
fi
