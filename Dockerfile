# Build stage to concatenate CRDs into a single crds.yaml
FROM alpine:3.20 AS crds
WORKDIR /crds
COPY api/crds/manifests/*.yaml ./
RUN cat *.yaml > /crds.yaml

# Use distroless as minimal base image to package the component binary
# Refer to https://github.com/GoogleContainerTools/distroless for more details
FROM gcr.io/distroless/static-debian12:nonroot@sha256:a9329520abc449e3b14d5bc3a6ffae065bdde0f02667fa10880c49b35c109fd1
ARG TARGETOS
ARG TARGETARCH
ARG COMPONENT
WORKDIR /
COPY bin/$COMPONENT.$TARGETOS-$TARGETARCH /<component>
COPY --from=crds /crds.yaml /crds.yaml
USER 65532:65532

# docker doesn't substitue args in ENTRYPOINT, so we replace this during the build script
ENTRYPOINT ["/<component>"]
