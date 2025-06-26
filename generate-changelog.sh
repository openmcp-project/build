#!/bin/bash

set -euo pipefail

# Ensure gh CLI available
if ! command -v gh &> /dev/null; then
  echo "gh CLI is required but not installed." >&2
  exit 1
fi

cd $(dirname "$0")/../../

LATEST_RELEASE_TAG=$(gh release list --json tagName,isLatest --jq '.[] | select(.isLatest)|.tagName')
if [[ -z "$LATEST_RELEASE_TAG" ]]; then # first release?
  LATEST_RELEASE_TAG=$(git rev-list --max-parents=0 HEAD) # first commit in the branch.
fi

PR_COMMITS=$(git log "$LATEST_RELEASE_TAG"..HEAD --oneline --pretty=format:"%s" main | grep -oE "#[0-9]+" | tr -d '#' | sort -u || true)

CHANGELOG_FILE=./CHANGELOG.md
# File header Header
echo "# Changes included in $VERSION:" > "$CHANGELOG_FILE"
echo "" >> "$CHANGELOG_FILE"

declare -A SECTIONS
SECTIONS=(
  [feat]="### 🚀 Features"
  [fix]="### 🐛 Fixes"
  [chore]="### 🔧 Chores"
  [docs]="### 📚 Documentation"
  [refactor]="### 🔨 Refactoring"
  [test]="### ✅ Tests"
  [perf]="### ⚡ Performance"
  [ci]="### 🔁 CI"
)

# Prepare section buffers
declare -A PR_ENTRIES
for key in "${!SECTIONS[@]}"; do
  PR_ENTRIES[$key]=""
done

for PR_NUMBER in $PR_COMMITS; do
  PR_JSON=$(gh pr view "$PR_NUMBER" --json number,title,body,url,author)

  IS_BOT=$(echo "$PR_JSON" | jq -r '.author.is_bot')
  if [[ "$IS_BOT" == "true" ]]; then
    continue
  fi

  TITLE=$(echo "$PR_JSON" | jq -r '.title')
  URL=$(echo "$PR_JSON" | jq -r '.url')
  BODY=$(echo "$PR_JSON" | jq -r '.body')

  # Determine type from conventional commit (assumes title like "type(scope): message" or "type: message")
  TYPE=$(echo "$TITLE" | grep -oE '^[a-z]+' || echo "feat")
  CLEAN_TITLE=$(echo "$TITLE" | sed -E 's/^[a-z]+(\([^)]+\))?(!)?:[[:space:]]+//')

  # Extract release note block, we only extract the "user" related notes.
  RELEASE_NOTE=$(echo "$BODY" | awk '/^```[[:space:]]*(breaking|feature|bugfix|doc|other)[[:space:]]+user[[:space:]]*$/ {flag=1; next} /^```[[:space:]]*$/ {flag=0} flag' | grep -v  'NONE' || true)
  # Format entry
  ENTRY="- $CLEAN_TITLE [#${PR_NUMBER}](${URL})"

  if [[ -n "$RELEASE_NOTE" ]]; then
    ENTRY+=": $RELEASE_NOTE"
  else
    ENTRY+="."
  fi
  ENTRY+="\n"

  # Append to appropriate section
  if [[ -n "${PR_ENTRIES[$TYPE]+x}" ]]; then
    PR_ENTRIES[$TYPE]+="$ENTRY"
  else
    PR_ENTRIES[chore]+="$ENTRY"
  fi
done

# Output sections
for key in "${!SECTIONS[@]}"; do
  if [[ -n "${PR_ENTRIES[$key]}" ]]; then
    echo "${SECTIONS[$key]}" >> "$CHANGELOG_FILE"
    echo -e "${PR_ENTRIES[$key]}" >> "$CHANGELOG_FILE"
    echo "" >> "$CHANGELOG_FILE"
  fi
done

cat "$CHANGELOG_FILE"
