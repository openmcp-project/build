#!/usr/bin/env bash

# Signs published container images with cosign and OCM component
# versions and verifies what it signed.
#
# Environment:
#   SIGNING_KEY     private key, either the path of a file holding it or the key itself.
#   SIGN            'false' turns signing off even when a key is present
#   SIGNING_NAME    OCM signature name, required by sign-cv and verify-cv
#   SBOM            'false' skips SBOM generation and attestation (signing only)
#   SBOM_DIR        directory the SBOM documents are written to, required by sign-images with SBOM on
#   SYFT            syft binary, required by sign-images with SBOM on
#   COSIGN          cosign binary, required by sign-images
#   OCM             ocm binary, required by sign-cv and verify-cv
#
# Subcommands:
#   enabled                                              exit 0 when signing should run, 1 otherwise
#   sbom-components <component>…                         comma list of components whose SBOMs are complete, empty when SBOM=false
#   sign-images <image-base> <version> <component>…      cosign sign, then syft and cosign attest, each component one by one
#   sign-cv <ctf-dir> <component> <version>              ocm sign a component version in a local CTF
#   verify-cv <repository> <component> <version>         ocm verify a published component version

die() { echo "$@" >&2; exit 1; }
log() { echo ">>> $*"; }
installed() { command -v "$1" &> /dev/null; }

workdir=""

# Passphrase of the imported cosign key. cosign v3 always encrypts the key it imports and
# only takes the passphrase from this variable
key_password=""

finish() {
    if [[ -n "$workdir" ]]; then
        rm -rf "$workdir"
    fi
}
trap finish EXIT INT

# materialize <var> <target> — write the value of <var>, a file or the content itself, to <target> as mode 0600.
materialize() {
    local name="$1" value="${!1}" target="$2"

    if [[ -f "$value" ]]; then
        [[ -r "$value" ]] || die "$name names a file that cannot be read: $value"
        cp "$value" "$target" || die "cannot copy $name into ${target%/*}"
    else
        # CRLF line endings survive being pasted into a CI secret and break openssl.
        printf '%s\n' "$value" | tr -d '\r' > "$target" || die "cannot write $name"
    fi
    chmod 600 "$target" || die "cannot lock down $target"
}

_enabled() {
    [[ "${SIGN:-true}" != "false" ]] || return 1
    [[ -n "${SIGNING_KEY:-}" ]] || return 1
    return 0
}

_sbom_enabled() {
    [[ "${SBOM:-true}" != "false" ]]
}

prepare_workdir() {
    umask 077
    workdir="$(mktemp -d)" || die "cannot create a temporary working directory"
    chmod 700 "$workdir" || die "cannot lock down $workdir"

    materialize SIGNING_KEY "$workdir/signing.key"

    # RSA only: 'ocm sign' has no ECDSA handler, so any other key type would sign the
    # images and then fail on the component version.
    openssl rsa -in "$workdir/signing.key" -check -noout > /dev/null ||
        die "SIGNING_KEY is neither an existing file nor a usable unencrypted RSA private key"

    openssl pkey -in "$workdir/signing.key" -pubout -out "$workdir/pub.pem" || die "cannot derive the public key"
    [[ -s "$workdir/pub.pem" ]] || die "cannot derive the public key"
}

prepare_cosign_key() {
    key_password="$(openssl rand -hex 16)" || die "cannot generate the cosign key password"

    COSIGN_PASSWORD="$key_password" "$COSIGN" import-key-pair --key "$workdir/signing.key" --output-key-prefix "$workdir/cosign" -y ||
        die "cosign could not import the signing key"
}

# verify_signature <image> <digest> — cosign verify with the derived public key, which needs
# no passphrase.
verify_signature() {
    "$COSIGN" verify --key "$workdir/pub.pem" "$1@$2"
}

# attest_sbom <image> <digest> <cosign attestation type> <file> — attach an SBOM and read it back.
attest_sbom() {
    local img="$1" dig="$2" type="$3" file="$4"

    # verify-attestation prints the whole document, so only its exit status is of interest.
    if "$COSIGN" verify-attestation --key "$workdir/pub.pem" --type "$type" "$img@$dig" > /dev/null 2>&1; then
        log "$img@$dig already carries a $type attestation from this key"
        return
    fi

    COSIGN_PASSWORD="$key_password" "$COSIGN" attest --yes --type "$type" --predicate "$file" --key "$workdir/cosign.key" "$img@$dig" ||
        die "could not attest the $type SBOM of $img@$dig"
    "$COSIGN" verify-attestation --key "$workdir/pub.pem" --type "$type" "$img@$dig" > /dev/null ||
        die "the $type attestation of $img@$dig does not verify with the signing key"
}

# sbom_image <image> <digest> <component> — scan the image with syft, keep both documents
# under SBOM_DIR for the component version, and attach them to the image.
sbom_image() {
    local img="$1" dig="$2" dir="$SBOM_DIR/$3"

    [[ -n "${SBOM_DIR:-}" ]] || die "SBOM_DIR must name the directory to write the SBOMs to"
    mkdir -p "$dir" || die "cannot create $dir"

    log "Generating SBOMs for $img@$dig"
    "$SYFT" scan "registry:$img@$dig" -o "cyclonedx-json=$dir/sbom-cyclonedx.json" -o "spdx-json=$dir/sbom-spdx.json" ||
        die "syft could not scan $img@$dig"

    local file
    for file in sbom-cyclonedx.json sbom-spdx.json; do
        [[ -s "$dir/$file" ]] || die "syft wrote no $file to $dir"
    done

    attest_sbom "$img" "$dig" cyclonedx "$dir/sbom-cyclonedx.json"
    attest_sbom "$img" "$dig" spdxjson "$dir/sbom-spdx.json"
}

# sign_image <image-base> <version> <component>
sign_image() {
    local img="$1/$3:$2" dig=""

    if ! dig="$(docker buildx imagetools inspect "$img" --format '{{.Manifest.Digest}}' 2>/dev/null)"; then
        die "Could not read $img from the registry. Was it pushed?"
    fi
    [[ -n "$dig" ]] || die "Could not determine the digest of $img"

    if verify_signature "$img" "$dig" > /dev/null 2>&1; then
        log "$img@$dig is already signed with this key"
    else
        log "Signing $img@$dig"
        COSIGN_PASSWORD="$key_password" "$COSIGN" sign --key "$workdir/cosign.key" --yes "$img@$dig" ||
            die "could not sign $img@$dig"
    fi

    verify_signature "$img" "$dig" ||
        die "the signature of $img@$dig does not verify with the signing key"
    log "Verified the signature of $img@$dig"

    if _sbom_enabled; then
        sbom_image "$img" "$dig" "$3"
    fi
}

# sbom_components <component>… — print the comma separated list of components whose two SBOM
# documents exist under SBOM_DIR. Component specs may carry a ':version', which the SBOMs ignore.
_sbom_components() {
    local found=() missing=() comp=""

    _sbom_enabled || exit 0
    [[ -n "${SBOM_DIR:-}" ]] || die "SBOM_DIR must name the directory the SBOMs were written to"
    [[ $# -gt 0 ]] || die "usage: signing.sh sbom-components <component>..."

    for comp in "$@"; do
        comp="${comp%%:*}"
        # '[]' is how callers spell "no components", same as in components.yaml.
        [[ -n "$comp" && "$comp" != "[]" ]] || continue
        if [[ -s "$SBOM_DIR/$comp/sbom-cyclonedx.json" && -s "$SBOM_DIR/$comp/sbom-spdx.json" ]]; then
            found+=("$comp")
        else
            missing+=("$comp")
        fi
    done

    # Publishing a component version without the SBOMs that were announced would be silent.
    [[ ${#missing[@]} -eq 0 ]] ||
        die "no complete SBOMs for ${missing[*]} in $SBOM_DIR. Sign the images with 'task build:img:sign-multi', or set SBOM=false to build without them"

    ( IFS=,; printf '%s' "${found[*]}" )
}

# verify_cv <repository> <component> <version>
verify_cv() {
    "$OCM" verify componentversions --signature "${SIGNING_NAME}" --public-key "$workdir/pub.pem" "$1//$2:$3"
}

_sign_images() {
    local image_base="${1:-}" version="${2:-}" component=""

    [[ -n "$image_base" ]] || die "usage: signing.sh sign-images <image-base> <version> <component>..."
    [[ -n "$version" ]] || die "usage: signing.sh sign-images <image-base> <version> <component>..."
    shift 2
    [[ $# -gt 0 ]] || die "no components given to sign"
    installed docker || die "docker is required to read the manifest digests of the images"
    _enabled || die "signing is not enabled: set SIGNING_KEY to the key itself or the path of a file holding it, and leave SIGN unset or set it to anything but 'false'"

    prepare_workdir
    prepare_cosign_key

    for component in "$@"; do
        sign_image "$image_base" "$version" "$component"
    done
}

_cv_preconditions() {
    _enabled || die "signing is not enabled: set SIGNING_KEY to the key itself or the path of a file holding it, and leave SIGN unset or set it to anything but 'false'"
    # An empty name reaches ocm as an empty signature and fails with a message that gives no hint of it.
    [[ -n "${SIGNING_NAME:-}" ]] || die "SIGNING_NAME must name the component version signature"
}

_sign_cv() {
    local ctf="${1:-}" component="${2:-}" version="${3:-}"

    [[ -n "$ctf" && -n "$component" && -n "$version" ]] || die "usage: signing.sh sign-cv <ctf-dir> <component> <version>"
    _cv_preconditions

    prepare_workdir

    log "Signing $component:$version in $ctf"
    "$OCM" sign componentversions --signature "${SIGNING_NAME}" --private-key "$workdir/signing.key" "directory::$ctf//$component:$version" ||
        die "could not sign $component:$version"
    verify_cv "directory::$ctf" "$component" "$version" ||
        die "the signature of $component:$version does not verify in $ctf"
    log "Signed and verified $component:$version"
}

_verify_cv() {
    local repository="${1:-}" component="${2:-}" version="${3:-}"

    [[ -n "$repository" && -n "$component" && -n "$version" ]] || die "usage: signing.sh verify-cv <repository> <component> <version>"
    _cv_preconditions

    prepare_workdir

    verify_cv "$repository" "$component" "$version" ||
        die "$component:$version is not verifiably signed with ${SIGNING_NAME}"
    log "Verified the signature ${SIGNING_NAME} of $component:$version"
}

subcmd="${1:-}"
[[ -n "$subcmd" ]] || die "usage: signing.sh <enabled|sbom-components|sign-images|sign-cv|verify-cv> [args]"
shift

case "$subcmd" in
    (enabled) _enabled;;
    (sbom-components) _sbom_components "$@";;
    (sign-images) _sign_images "$@";;
    (sign-cv) _sign_cv "$@";;
    (verify-cv) _verify_cv "$@";;
    (*) die "Unknown subcommand: $subcmd";;
esac
