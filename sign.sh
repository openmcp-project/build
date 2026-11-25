#!/usr/bin/env bash

# Signs images, SBOMs and component versions keyless with Sigstore
# and verifies each signature against the expected signer.
#
# cosign opens the Sigstore browser login unless the environment provides an identity token.
#
# Environment:
#   COSIGN, OCM         tool binaries
#   SIGNING_IDENTITY    certificate identity the signatures must carry
#   SIGNING_ISSUER      OIDC issuer of that identity
#   SIGNING_NAME        component version signature name, cv and verify-cv only
#   LOCALTMP            receives the OCM signing configuration and the attestation list
#   JQ                  tool binary, attest only
#
# Subcommands:
#   image <reference>        sign the image the reference resolves to
#   attest <records>         attach the SBOMs recorded by generate-sboms.sh to their images
#   cv <reference>           sign a component version
#   verify-cv <reference>    verify the signature of a component version

# jq variables must not be expanded by the shell.
# shellcheck disable=SC2016

log() { echo ">>> $*"; }
die() { echo "$@" >&2; exit 1; }

# attest_sbom <image> <cosign predicate type> <file> — attach one SBOM and verify it.
attest_sbom() {
    "$COSIGN" attest --yes --type "$2" --predicate "$3" "$1" || die "Cannot attest $3 to $1"
    "$COSIGN" verify-attestation "${signer[@]}" --type "$2" "$1" > /dev/null ||
        die "Attestation of $3 on $1 does not verify"
}

# ocm_config — select Sigstore and the expected signer for the following ocm commands.
ocm_config() {
    [[ -n "${SIGNING_NAME:-}" && -n "${LOCALTMP:-}" ]] || die "SIGNING_NAME and LOCALTMP must be set"

    export OCM_CONFIG="$LOCALTMP/ocm-signing.yaml"
    cat > "$OCM_CONFIG" <<EOF || die "Cannot write $OCM_CONFIG"
type: generic.config.ocm.software/v1
configurations:
- type: signing.config.ocm.software/v1alpha1
  signature: $SIGNING_NAME
  signer:
    type: SigstoreSigningConfiguration/v1alpha1
  verifier:
    type: SigstoreVerificationConfiguration/v1alpha1
    certificateIdentity: $SIGNING_IDENTITY
    certificateOIDCIssuer: $SIGNING_ISSUER
EOF

    if [[ -z "${CI:-}" ]]; then
        cat >> "$OCM_CONFIG" <<EOF || die "Cannot write $OCM_CONFIG"
- type: credentials.config.ocm.software/v1
  consumers:
  - identity:
      type: SigstoreSigner/v1alpha1
      signature: $SIGNING_NAME
    credentials:
    - type: OIDCIdentityTokenProvider/v1alpha1
EOF
    fi

    # ocm runs the cosign it finds on PATH and downloads its own otherwise.
    PATH="$(dirname "$COSIGN"):$PATH"
}

_image() {
    local digest image

    digest="$(docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}')" || die "Cannot resolve $1"
    [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || die "Invalid image digest: $digest"
    image="${1%:*}@$digest"

    log "Signing $image"
    "$COSIGN" sign --yes "$image" || die "Cannot sign $image"
    "$COSIGN" verify "${signer[@]}" "$image" > /dev/null || die "Signature of $image does not verify"
}

# platform image and SBOM directory of every SBOM record
#
# Input, other fields omitted:
#   {
#    "pinned": "ghcr.io/org/images/app@sha256:<index>",
#    "digest": "sha256:<platform>",
#    "directory": "tmp/sbom/app/v1.0.0/<platform>",
#   }
# Output, tab separated:
#   ghcr.io/org/images/app@sha256:<platform>    tmp/sbom/app/v1.0.0/<platform>
attestations_filter='
    (.pinned | split("@") | first) as $repository
    | ["\($repository)@\(.digest)", .directory]
    | @tsv
'

_attest() {
    local image directory

    [[ -n "${JQ:-}" && -n "${LOCALTMP:-}" ]] || die "JQ and LOCALTMP must be set"

    "$JQ" -r "$attestations_filter" "$1" > "$LOCALTMP/attestations.tsv" || die "Cannot read SBOM records from $1"

    while IFS=$'\t' read -r image directory; do
        log "Attesting SBOMs of $image"
        attest_sbom "$image" cyclonedx "$directory/sbom-cyclonedx.json"
        attest_sbom "$image" spdxjson "$directory/sbom-spdx.json"
    done < "$LOCALTMP/attestations.tsv"
}

_cv() {
    ocm_config
    log "Signing $1"
    "$OCM" sign cv --signature "$SIGNING_NAME" "$1" || die "Cannot sign $1"
    "$OCM" verify cv --signature "$SIGNING_NAME" "$1" || die "Signature of $1 does not verify"
}

_verify_cv() {
    ocm_config
    "$OCM" verify cv --signature "$SIGNING_NAME" "$1" || die "Signature of $1 does not verify"
}

if [[ -z "${SIGNING_IDENTITY:-}" ]] || [[ -z "${SIGNING_ISSUER:-}" ]]; then
    die "Set SIGNING_IDENTITY and SIGNING_ISSUER to the login you sign with, e.g. your email and https://github.com/login/oauth"
fi

signer=(
    --certificate-identity "$SIGNING_IDENTITY"
    --certificate-oidc-issuer "$SIGNING_ISSUER"
)

subcmd="$1"
shift

case "$subcmd" in
    (image) _image "$@";;
    (attest) _attest "$@";;
    (cv) _cv "$@";;
    (verify-cv) _verify_cv "$@";;
    (*) die "Unknown subcommand: $subcmd";;
esac
