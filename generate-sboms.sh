#!/usr/bin/env bash

# Generates CycloneDX and SPDX SBOMs for every platform of every image in the component.
#
# Environment:
#   JQ, SYFT    tool binaries
#   LOCALTMP    holds component-resources.json and component-values.json,
#               receives sbom/, sboms.jsonl and component-sbom-values.json

# jq variables must not be expanded by the shell.
# shellcheck disable=SC2016

log() { echo ">>> $*"; }
die() { echo "$@" >&2; exit 1; }

digest_pattern='^sha256:[a-f0-9]{64}$'
platform_pattern='^[a-z0-9]+/[a-z0-9]+(/[a-zA-Z0-9._-]+)?$'

# name, version and reference of every image resource
images_filter='
    .[]
    | select(.type == "ociImage")
    | [.name, .version, .access.imageReference]
    | @tsv
'

# digest and os/architecture[/variant] of a platform record
platform_columns='
    [.digest, ([.platform.os, .platform.architecture, (.platform.variant // empty)] | join("/"))]
    | @tsv
'

# BuildKit stores provenance in the index as manifests of an unknown platform.
index_platforms='
    .manifests[]
    | select(
        (.annotations["vnd.docker.reference.type"] == "attestation-manifest"
            and .platform.os == "unknown"
            and .platform.architecture == "unknown")
        | not)
    | if .mediaType == "application/vnd.oci.image.manifest.v1+json"
        or .mediaType == "application/vnd.docker.distribution.manifest.v2+json"
      then .
      else error("Unsupported platform manifest type")
      end
'

sbom_bindings='
    .values.SBOMS = $sboms
    | .values.IMAGE_REFERENCES = ($sboms | map({key: .reference, value: .pinned}) | from_entries)
'

# inspect <reference> <docker format flags>… — print registry metadata of an image.
inspect() {
    docker buildx imagetools inspect "$@"
}

# repository <reference> — print the reference without tag or digest.
repository() {
    local repo="${1%@*}"

    # A colon before the last slash belongs to a registry port, not a tag.
    if [[ "${repo##*/}" == *:* ]]; then
        repo="${repo%:*}"
    fi
    echo "$repo"
}

# platforms <pinned reference> <digest> — print digest and platform of every runnable image.
platforms() {
    local manifest config

    manifest="$(inspect "$1" --raw)" || return
    if "$JQ" -e 'has("manifests")' <<< "$manifest" > /dev/null; then
        "$JQ" -r "$index_platforms | $platform_columns" <<< "$manifest"
        return
    fi

    config="$(inspect "$1" --format '{{json .Image}}')" || return
    "$JQ" -r --arg digest "$2" \
        "{digest: \$digest, platform: {os, architecture, variant}} | $platform_columns" <<< "$config"
}

# scan <repository> <digest> <platform> <directory> — write both SBOM formats of one platform image.
scan() {
    local args=(
        "registry:$1@$2"
        --platform "$3"
        -o "cyclonedx-json=$4/sbom-cyclonedx.json"
        -o "spdx-json=$4/sbom-spdx.json"
    )

    mkdir -p "$4" || return
    "$SYFT" scan "${args[@]}"
}

# record <name> <version> <reference> <pinned> <digest> <platform> <directory> — print one SBOM record.
record() {
    echo   '{'
    printf '  "name": "%s",' "$1"
    printf '  "version": "%s",' "$2"
    printf '  "reference": "%s",' "$3"
    printf '  "pinned": "%s",' "$4"
    printf '  "digest": "%s",' "$5"
    printf '  "platform": "%s",' "$6"
    printf '  "directory": "%s"' "$7"
    echo   '}'
}

# image_sboms <name> <version> <reference> — scan every platform of one image.
image_sboms() {
    local name="$1" version="$2" reference="$3"
    local digest repo pinned child platform directory

    [[ -n "$reference" && "$reference" != -* ]] || die "Invalid image reference: $reference"

    digest="$(inspect "$reference" --format '{{.Manifest.Digest}}')" || die "Cannot resolve $reference"
    [[ "$digest" =~ $digest_pattern ]] || die "Invalid image digest: $digest"

    repo="$(repository "$reference")"
    pinned="$repo@$digest"

    platforms "$pinned" "$digest" > "$LOCALTMP/platforms.tsv" || die "Cannot list platforms of $pinned"
    [[ -s "$LOCALTMP/platforms.tsv" ]] || die "No image platforms: $reference"

    while IFS=$'\t' read -r child platform; do
        [[ "$child" =~ $digest_pattern ]] || die "Invalid platform digest: $child"
        [[ "$platform" =~ $platform_pattern && "$platform" != *unknown* ]] || die "Invalid image platform: $platform"

        directory="$LOCALTMP/sbom/$name/$version/${child#sha256:}"

        log "Scanning $repo@$child ($platform)"
        scan "$repo" "$child" "$platform" "$directory" || die "Cannot scan $repo@$child"
        record "$name" "$version" "$reference" "$pinned" "$child" "$platform" "$directory" >> "$records" ||
            die "Cannot record SBOMs of $repo@$child"
    done < "$LOCALTMP/platforms.tsv"
}

[[ -n "${JQ:-}" && -n "${SYFT:-}" && -n "${LOCALTMP:-}" ]] || die "JQ, SYFT and LOCALTMP must be set"

resources="$LOCALTMP/component-resources.json"
values="$LOCALTMP/component-values.json"
records="$LOCALTMP/sboms.jsonl"

"$JQ" -r "$images_filter" "$resources" > "$LOCALTMP/images.tsv" || die "Cannot read images from $resources"
: > "$records" || die "Cannot write $records"

while IFS=$'\t' read -r name version reference; do
    image_sboms "$name" "$version" "$reference"
done < "$LOCALTMP/images.tsv"

"$JQ" --slurpfile sboms "$records" "$sbom_bindings" "$values" > "$LOCALTMP/component-sbom-values.json" ||
    die "Cannot write SBOM bindings"
