# Minimal FIPS-compliant runtime image.
# The binary must have been built with Dockerfile.fips-builder beforehand.
# It is static and carries the FIPS 140-3 Go Cryptographic Module.
# The FIPS base is kept so the runtime OS stays the FIPS-configured gardenlinux the nodes run.
FROM ghcr.io/gardenlinux/gardenlinux/fips:1877.28@sha256:60ce1d9bb98a00591e3cbaf962d370cb73c8e1edb0a39acde5c77ebbb23538d4

ARG TARGETOS
ARG TARGETARCH
ARG COMPONENT
WORKDIR /
COPY bin/$COMPONENT.$TARGETOS-fips-$TARGETARCH /<component>
USER 65532:65532

# docker doesn't substitute args in ENTRYPOINT, so we replace this during the build script
ENTRYPOINT ["/<component>"]
