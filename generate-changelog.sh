#!/bin/bash

set -euo pipefail

echo "Generating changelog for version: $VERSION"

# Ensure gh CLI available
if ! command -v gh &> /dev/null; then
  echo "gh CLI is required but not installed." >&2
  exit 1
fi

RELEASE_NOTES_TO_JSON_SCRIPT="$(realpath "$(dirname $0)/release-notes-to-json.sh")"
cd $(dirname "$0")/../../

LATEST_RELEASE_TAG=$(gh release list --json tagName,isLatest --jq '.[] | select(.isLatest)|.tagName')
if [[ -z "$LATEST_RELEASE_TAG" ]]; then # first release?
  LATEST_RELEASE_TAG=$(git rev-list --max-parents=0 HEAD) # first commit in the branch.
fi

GIT_LOG_OUTPUT=$(git log "$LATEST_RELEASE_TAG"..HEAD --oneline --pretty=format:"%s")
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
  echo -n "Checking PR $PR_NUMBER"

  IS_BOT=$(jq -r '.author.is_bot' <<< "$PR_JSON")
  if [[ "$IS_BOT" == "true" ]]; then
    echo " [skipping bot PR"]
    continue
  fi

  PR_TITLE=$(jq -r '.title' <<< "$PR_JSON")
  PR_URL=$(jq -r '.url' <<< "$PR_JSON")
  PR_BODY=$(jq -r '.body' <<< "$PR_JSON")
  echo " - $PR_TITLE"

  # Determine type from conventional commit (assumes title like "type(scope): message" or "type: message")
  TYPE=$(echo "$PR_TITLE" | grep -oE '^[a-z]+' || echo "feat")
  CLEAN_TITLE=$(echo "$PR_TITLE" | sed -E 's/^[a-z]+(\([^)]+\))?(!)?:[[:space:]]+//')

  # Extract release note block, this contains the release notes and the release notes headers.
  # The last sed call is required to remove the carriage return characters (Github seems to use \r\n for new lines in PR bodies).
  RELEASE_NOTE_BLOCK=$(echo "$PR_BODY" | sed -n '/\*\*Release note\*\*:/,$p' | sed -n '/^```.*$/,/^```$/p' | sed 's/\r//g')
  # Extract release notes body
  RELEASE_NOTE_JSON=$("$RELEASE_NOTES_TO_JSON_SCRIPT" <<< "$RELEASE_NOTE_BLOCK")

  # skip PRs without release notes
  if [[ "$RELEASE_NOTE_JSON" == "[]" ]]; then
    echo "  [ignoring PR without release notes]"
    continue
  fi

  # Format release notes
  # Updating NOTE_ENTRY in the loop does not work because it is executed in a subshell, therefore this workaround via echo.
  NOTE_ENTRY="$(
    jq -rc 'sort_by(.audience, .type) | .[]' <<< "$RELEASE_NOTE_JSON" | while IFS= read -r note; do
      NOTE_TYPE=$(jq -r '.type' <<< "$note" | tr '[:lower:]' '[:upper:]')
      NOTE_AUDIENCE=$(jq -r '.audience' <<< "$note" | tr '[:lower:]' '[:upper:]')
      NOTE_BODY=$(jq -r '.body' <<< "$note")
      echo -en "\n  - **[$NOTE_AUDIENCE][$NOTE_TYPE]** $NOTE_BODY"
    done
  )"

  # Format entry
  ENTRY="- $CLEAN_TITLE [#${PR_NUMBER}](${PR_URL})"

  # Extract and format the release note headers.
  HEADERS=$(echo "$PR_BODY" | sed -n '/\*\*Release note\*\*:/,$p' | sed -n '/^```.*$/,/^```$/p'| head -n 1 | sed 's/^```//')
  FORMATED_HEADERS=$(echo "$HEADERS" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/\s\+/ /g' | sed 's/\(\S\+\)/[\1]/g')

  ENTRY="- ${CLEAN_TITLE} [${PR_NUMBER}](${PR_URL})${NOTE_ENTRY}\n"

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
