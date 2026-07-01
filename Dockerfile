# Minimal FIPS-compliant runtime image.
# The binary must have been built with Dockerfile.fips-builder beforehand.
# At runtime the binary dlopens gardenlinux's FIPS 140-validated OpenSSL,
# which is pre-configured as the default crypto provider in this image.
FROM ghcr.io/gardenlinux/gardenlinux-fips:1877.19
ARG TARGETOS
ARG TARGETARCH
ARG COMPONENT
WORKDIR /
COPY bin/$COMPONENT.$TARGETOS-fips-$TARGETARCH /<component>
USER 65532:65532

# docker doesn't substitute args in ENTRYPOINT, so we replace this during the build script
ENTRYPOINT ["/<component>"]
