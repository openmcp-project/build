#!/bin/bash

set -euo pipefail

echo "Generating changelog for version: $VERSION"

# Ensure gh CLI available
if ! command -v gh &> /dev/null; then
  echo "gh CLI is required but not installed." >&2
  exit 1
fi

RELEASE_NOTES_TO_JSON_SCRIPT="$(realpath "$(dirname $0)/release-notes-to-json.sh")"
CHANGELOG_GENERATOR_SCRIPT="$(realpath "$(dirname $0)/changelog/main.go")"
cd $(dirname "$0")/../../

LATEST_RELEASE_TAG="v0.2.0"
# LATEST_RELEASE_TAG=$(gh release list --json tagName,isLatest --jq '.[] | select(.isLatest)|.tagName')
# if [[ -z "$LATEST_RELEASE_TAG" ]]; then # first release?
#   LATEST_RELEASE_TAG=$(git rev-list --max-parents=0 HEAD) # first commit in the branch.
# fi

GIT_LOG_OUTPUT=$(git log "$LATEST_RELEASE_TAG"..HEAD --oneline --pretty=format:"%s")
PR_COMMITS=$(echo "$GIT_LOG_OUTPUT" | grep -oE "#[0-9]+" || true | tr -d '#' | sort -u)

PR_INFO_FILE=$(mktemp)
echo "[" > "$PR_INFO_FILE"
CHANGELOG_FILE=./CHANGELOG.md
# File header Header
echo "# Changes included in $VERSION:" > "$CHANGELOG_FILE"
echo "" >> "$CHANGELOG_FILE"

is_first=true
for PR_NUMBER in $PR_COMMITS; do
  echo "Getting info for PR $PR_NUMBER"
  PR_JSON=$(gh pr view "$PR_NUMBER" --json number,title,body,url,author)
  if [[ "$is_first" == true ]]; then
    is_first=false
  else
    echo "," >> "$PR_INFO_FILE"
  fi
  echo "$PR_JSON" >> "$PR_INFO_FILE"
done

echo "]" >> "$PR_INFO_FILE"

echo "Executing changelog generator for $PR_INFO_FILE ..."
go run "$CHANGELOG_GENERATOR_SCRIPT" "$PR_INFO_FILE" >> "$CHANGELOG_FILE"

cat "$CHANGELOG_FILE"
