#!/bin/bash

# Runs 'go test' on all modules.
# Expects NESTED_MODULES to be set and the code directories being passed in as arguments.

set -euo pipefail
source "$(realpath "$(dirname $0)/environment.sh")"

function run_test() {
  go test "$@" -coverprofile cover.root.out
  go tool cover --html=cover.root.out -o cover.root.html
  go tool cover -func cover.root.out | tail -n 1
}

echo "> Running tests ..."

# NESTED_MODULES must be set to the list of nested go modules, e.g. 'api,nested2,nested3'
paths=("$@")
for nm in ${NESTED_MODULES//,/ }; do
  echo "> Testing $nm module ..." | indent 1
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
    run_test "${module_paths[@]}"
  )
done

echo "> Testing root module ..." | indent 1
(
  cd "$PROJECT_ROOT"
  run_test "${paths[@]}"
)
