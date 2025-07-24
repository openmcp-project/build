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

GIT_LOG_OUTPUT=$(git log "$LATEST_RELEASE_TAG"..HEAD --oneline --pretty=format:"%s" main)
PR_COMMITS=$(echo "$GIT_LOG_OUTPUT" | grep -oE "#[0-9]+" || true | tr -d '#' | sort -u)

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

  PR_TITLE=$(echo "$PR_JSON" | jq -r '.title')
  PR_URL=$(echo "$PR_JSON" | jq -r '.url')
  PR_BODY=$(echo "$PR_JSON" | jq -r '.body')

  # Determine type from conventional commit (assumes title like "type(scope): message" or "type: message")
  TYPE=$(echo "$PR_TITLE" | grep -oE '^[a-z]+' || echo "feat")
  CLEAN_TITLE=$(echo "$PR_TITLE" | sed -E 's/^[a-z]+(\([^)]+\))?(!)?:[[:space:]]+//')

  # Extract release note block, this contains the release notes and the release notes headers.
  RELEASE_NOTE_BLOCK=$(echo "$PR_BODY" | sed -n '/\*\*Release note\*\*:/,$p' | sed -n '/^```.*$/,/^```$/p')
  # Extract release notes body
  RELEASE_NOTE=$(echo "$RELEASE_NOTE_BLOCK" | sed '1d;$d' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

  # Format entry
  ENTRY="- $CLEAN_TITLE [#${PR_NUMBER}](${PR_URL})"

  if [[ -z "$RELEASE_NOTE"  || "$RELEASE_NOTE" == "NONE" ]]; then
    ENTRY+="."
  else
    # Extract and format the release note headers.
    HEADERS=$(echo "$PR_BODY" | sed -n '/\*\*Release note\*\*:/,$p' | sed -n '/^```.*$/,/^```$/p'| head -n 1 | sed 's/^```//')
    FORMATED_HEADERS=$(echo "$HEADERS" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/\s\+/ /g' | sed 's/\(\S\+\)/[\1]/g')

    ENTRY="- ${FORMATED_HEADERS} ${CLEAN_TITLE} [#${PR_NUMBER}](${PR_URL}): ${RELEASE_NOTE}"
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
