#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Creates a GitHub-signed commit from the staged working tree using GraphQL.
# GH_TOKEN must be an installation token with contents: write permission.

set -euo pipefail

: "${BRANCH:?BRANCH must name the target branch}"
: "${COMMIT_HEADLINE:?COMMIT_HEADLINE must contain the commit headline}"
: "${GH_TOKEN:?GH_TOKEN must contain a GitHub token}"

if git diff --cached --quiet; then
  echo "No staged changes to commit."
  exit 0
fi

local_head="$(git rev-parse HEAD)"
remote_head="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/${BRANCH}" --jq .object.sha)"
if [[ "$local_head" != "$remote_head" ]]; then
  echo "Refusing to create a commit: local HEAD ($local_head) differs from origin/$BRANCH ($remote_head)." >&2
  exit 1
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
additions="$workdir/additions.json"
deletions="$workdir/deletions.json"

{
  printf '['
  first=true
  while IFS= read -r -d '' path; do
    if [[ "$first" == true ]]; then
      first=false
    else
      printf ','
    fi
    # Read from the index, so this exactly represents the staged tree.
    jq -n --arg path "$path" --arg contents "$(git show ":$path" | base64 -w0)" \
      '{path: $path, contents: $contents}'
  done < <(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMRT -z)
  printf ']'
} > "$additions"

{
  printf '['
  first=true
  while IFS= read -r -d '' path; do
    if [[ "$first" == true ]]; then
      first=false
    else
      printf ','
    fi
    jq -n --arg path "$path" '{path: $path}'
  done < <(git -c core.quotePath=false diff --cached --name-only --diff-filter=D -z)
  printf ']'
} > "$deletions"

payload="$workdir/payload.json"
jq -n \
  --arg query 'mutation($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) {
      commit { oid url }
    }
  }' \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg branch "$BRANCH" \
  --arg expected_head "$local_head" \
  --arg headline "$COMMIT_HEADLINE" \
  --slurpfile additions "$additions" \
  --slurpfile deletions "$deletions" \
  '{query: $query, variables: {input: {
    branch: {repositoryNameWithOwner: $repository, branchName: $branch},
    expectedHeadOid: $expected_head,
    message: {headline: $headline},
    fileChanges: {additions: $additions[0], deletions: $deletions[0]}
  }}}' > "$payload"

commit_oid="$(gh api graphql --method POST --input "$payload" --jq '.data.createCommitOnBranch.commit.oid')"
verification="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${commit_oid}" --jq '.commit.verification | {verified, reason}')"
echo "Created signed commit ${commit_oid}: ${verification}"

if [[ "$(jq -r .verified <<< "$verification")" != true ]]; then
  echo "GitHub did not verify the created commit." >&2
  exit 1
fi

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
