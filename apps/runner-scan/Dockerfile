# syntax=docker/dockerfile:1.7
#
# scp-runner-scan — the SEPARATE image the `scp-managed-scan` promotion scan step launches per scan
# (ADR-0020 §1, charter's Managed Execution Exception 2026-07-23 amendment, proposal §13.3). It
# mirrors apps/runner-iac EXACTLY in shape: pinned scanner toolchain + a minimal run shim, NOTHING
# else. No Node app code lives here (docs/DESIGN.md §3) — `packages/plugins/managed-scan` is the thin
# ORCHESTRATOR (launches this image as an ephemeral, single-shot `--network none` container per scan);
# this image is the ISOLATED TOOLCHAIN it launches. The scpd image (root Dockerfile) carries no
# scanner at all — this is the ONLY place `trivy` exists in the whole system, exactly as `tofu`
# exists only in scp-runner-iac (apps/runner-iac/README.md).
#
# `docker build -t scp-runner-scan:dev apps/runner-scan` is the only build command for this image.
# Built FROM Trivy's own official image (digest-pinned via tools/trivy/pin.env — see that file for
# why the multi-arch INDEX digest, not the amd64 platform digest, backs this FROM) rather than
# hand-downloading a release binary: the upstream image already owns that supply chain; this
# Dockerfile only pre-loads the vulnerability DB and adds the run shim.
#
# OFFLINE AT RUNTIME (charter principle 5): the vulnerability DB is downloaded ONCE here, at BUILD
# time (the one place network is used — the same place cosign/skopeo are vendored). At RUNTIME the
# runner is launched `--network none` and run.sh passes `--skip-db-update --offline-scan`, so the
# scanner never phones home. (Offline DB TRANSPORT across an air-gap boundary — refreshing this
# baked DB on a disconnected commander — is increment 13.3b, the `type: "blob"` channel.)

# Pinned to the tools/trivy/pin.env TRIVY_PINNED_IMAGE (the multi-arch index digest). Overridable at
# build for a pin bump; the drift test asserts this default matches pin.env byte-for-byte.
ARG TRIVY_IMAGE=aquasec/trivy@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7
FROM ${TRIVY_IMAGE}

# Pre-load the vulnerability DB into the image's default cache so the runtime scan needs NO network.
# `trivy version` right after fails the build loudly if the pinned image's binary is broken.
RUN trivy image --download-db-only && trivy version

# The upstream image already provides `trivy`; add only the run shim on top. No package-manager
# calls, no extra tooling — every extra byte is attack surface in a container the promotion scan
# step launches per artifact.
COPY run.sh /run.sh
RUN chmod +x /run.sh

WORKDIR /work
ENTRYPOINT ["/run.sh"]
