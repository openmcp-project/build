#!/bin/bash

# This script reads release notes from STDIN and converts them to JSON format, which is then printed to STDOUT.
# Expected input format:
#
# ```<type> <audience>
# <body> (may span multiple lines)
# ```
# (the above block may repeat multiple times)
#
# Output:
# [
#   {
#     "type": "<type>",
#     "audience": "<audience>",
#     "body": "<body>"
#   },
#   ...
# ]
#
# Additional whitespace is ignored, but each release note block must start with ``` followed by two lowercase words,
# and it must end with ``` followed by any amount of whitespace and then a newline or end of input.
#
# Release notes where the body is empty or "NONE" are ignored and not part of the output JSON array.

set -euo pipefail

type=""
audience=""
body=""
rnj='[]'

start_regex='^[[:blank:]]*```[[:blank:]]*([a-z]+)[[:blank:]]+([a-z]+)[[:blank:]]*$'
end_regex='^[[:blank:]]*```[[:blank:]]*$'
empty_regex='^[[:space:]]*$'
line=""

while IFS= read -r line || [[ -n "$line" ]]; do
  # check if we are currently reading a release note body
  if [[ -n "$type" ]]; then
    # check for end of release note block
    if [[ "$line" =~ $end_regex ]]; then
      # end of release note block
      # add release note to JSON array, unless the body is empty or "NONE"
      if [[ ! "$body" =~ $empty_regex ]] && [[ "$body" != "NONE" ]]; then
        rnj="$(jq '. + [{"type": $type, "audience": $audience, "body": $body}]' --arg type "$type" --arg audience "$audience" --arg body "$body" <<< "$rnj")" 
      fi
      # reset variables
      type=""
      audience=""
      body=""
    else
      # more body content
      # append line to body
      if [[ -n "$body" ]]; then
        body="$body\n$line"
      else
        body="$line"
      fi
    fi
  else
    # not currently reading a release note body
    # check for start of release note block
    if [[ "$line" =~ $start_regex ]]; then
      # start of release note block
      type="${BASH_REMATCH[1]}"
      audience="${BASH_REMATCH[2]}"
      body=""
    else
      # invalid line outside of release note block
      if [[ -n "$line" ]]; then
      # ignore empty lines, log a warning otherwise
        echo "unexpected line in release notes: $line" >&2
      fi
    fi
  fi
done

# output JSON array
echo "$rnj"
