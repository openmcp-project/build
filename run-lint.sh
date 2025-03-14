#!/bin/bash

# Runs 'go test' on all modules.
# Expects NESTED_MODULES to be set and the code directories being passed in as arguments.

set -euo pipefail
source "$(realpath "$(dirname $0)/environment.sh")"

function run_lint() {
  "$LINTER" run -c "$PROJECT_ROOT/.golangci.yaml" "$@"
}

echo "> Running linter ..."

# NESTED_MODULES must be set to the list of nested go modules, e.g. 'api,nested2,nested3'
paths=("$@")
for nm in ${NESTED_MODULES//,/ }; do
  echo "> Linting $nm module ..." | indent 1
  # filter out paths that belong to the nested module by prefix matching
  module_paths=()
  non_module_paths=()
  for val in "${paths[@]}"; do
    if [[ "$val" =~ ^$PROJECT_ROOT/$nm ]] || [[ "$val" =~ ^$nm ]]; then
      module_paths+=("$val")
    else
      non_module_paths+=("$val")
    fi
  done
  paths=("${non_module_paths[@]}")
  (
    cd "$PROJECT_ROOT/$nm"
    run_lint "${module_paths[@]}"
  )
done

echo "> Linting root module ..." | indent 1
(
  cd "$PROJECT_ROOT"
  run_lint "${paths[@]}"
)
