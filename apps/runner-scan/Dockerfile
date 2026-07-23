# syntax=docker/dockerfile:1.7
#
# scp-runner-scan — the SEPARATE image the `scp-managed-scan` promotion scan step launches per scan
# (ADR-0020 §1, charter's Managed Execution Exception 2026-07-23 amendment, proposal §13.3). It
# mirrors apps/runner-iac EXACTLY in shape: a pinned scanner toolchain + a minimal run shim, NOTHING
# else. No Node app code lives here (docs/DESIGN.md §3) — `packages/plugins/managed-scan` is the thin
# ORCHESTRATOR (launches this image as an ephemeral, single-shot `--network none` container per scan);
# this image is the ISOLATED TOOLCHAIN it launches. The scpd image (root Dockerfile) carries no
# scanner at all — this is the ONLY place `trivy` and `oscap` exist in the whole system, exactly as
# `tofu` exists only in scp-runner-iac (apps/runner-iac/README.md).
#
# `docker build -t scp-runner-scan:dev apps/runner-scan` is the only build command for this image.
#
# TWO SCANNERS, TWO SUPPLY CHAINS (M13.3b part 1 — OpenSCAP the second managed-scan method):
#   - Trivy   — vendored from Trivy's OWN official image (digest-pinned via tools/trivy/pin.env). We
#               do NOT `FROM` it anymore (that made this image Alpine, and `oscap` on Alpine is an ldd
#               nightmare — the SSG/OVAL probe binaries are glibc). Instead we COPY the static `trivy`
#               binary + the build-time-baked vulnerability DB OUT of a pinned Trivy stage into the
#               final image — the same "copy the vetted binary out of an image that is never executed"
#               discipline tools/cosign + tools/skopeo already use.
#   - OpenSCAP — the FINAL base is a digest-pinned Fedora image (tools/openscap/pin.env) that carries
#               `oscap` (openscap-scanner) + the SCAP Security Guide datastreams (scap-security-guide),
#               installed at BUILD time. SCAP content lands at /usr/share/xml/scap/ssg/content/
#               (ssg-<os>-ds.xml datastreams — e.g. ssg-debian11-ds.xml, ssg-ol8-ds.xml, ssg-fedora-ds.xml).
#
# OFFLINE AT RUNTIME (charter principle 5): both scanners' data is pre-loaded at BUILD time (the one
# place network is used — the same place cosign/skopeo/trivy-DB are vendored). At RUNTIME the runner is
# launched `--network none`: run.sh passes `--skip-db-update --offline-scan` to Trivy, and `oscap`
# evaluates a LOCAL datastream against a LOCALLY-extracted rootfs (OSCAP_PROBE_ROOT) — neither phones
# home. (Cross-air-gap TRANSPORT of the baked Trivy DB / SCAP content onto a disconnected commander —
# the `type: "blob"` channel + refresh runbook — is increment 13.3b PART 2; this increment keeps the
# build-time bake, so a disconnected build host needs a local mirror of the fedora + trivy sources.)
#
# HONEST LIMITATION (13.3b part 1): `oscap` + SSG are `dnf install`ed from the pinned Fedora base's
# DEFAULT repos at build time, so the FEDORA IMAGE is digest-pinned but the exact oscap/SSG package
# versions track those repos. tools/openscap/pin.env records the version the base's repos currently
# serve; the Dockerfile asserts `oscap --version` succeeds (fails the build loudly if the toolchain is
# broken). Fully offline package vendoring / exact-version pinning is 13.3b part 2, alongside the SCAP
# content blob channel — deliberately out of scope here.

# Both base-image pins are declared as GLOBAL build args BEFORE the first FROM — a build arg used in a
# `FROM` must precede the first stage (an ARG declared inside a stage is blank at the next FROM). The
# drift test (packages/plugins/managed-scan/src/pin.test.ts) asserts each default matches its pin.env
# byte-for-byte:
#   TRIVY_IMAGE    — tools/trivy/pin.env    TRIVY_PINNED_IMAGE    (multi-arch index digest; see that file)
#   OPENSCAP_IMAGE — tools/openscap/pin.env OPENSCAP_PINNED_IMAGE (fedora multi-arch index digest)
ARG TRIVY_IMAGE=aquasec/trivy@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7
ARG OPENSCAP_IMAGE=fedora@sha256:f1a3fab47bcb3c3ddf3135d5ee7ba8b7b25f2e809a47440936212a3a50957f3d

# ---------------------------------------------------------------------------------------------------
# STAGE 1 — Trivy: bake the vulnerability DB, then hand the static binary + DB to the final stage.
# This stage is NEVER executed as the runner; only COPY'd out of.
# ---------------------------------------------------------------------------------------------------
FROM ${TRIVY_IMAGE} AS trivy

# Pre-load the vulnerability DB into a KNOWN cache dir (not $HOME/.cache) so the COPY into the final
# stage is a fixed path. `trivy version` right after fails the build loudly if the pinned binary is broken.
RUN trivy --cache-dir /trivy-cache image --download-db-only && trivy version

# ---------------------------------------------------------------------------------------------------
# STAGE 2 (FINAL) — OpenSCAP: a digest-pinned Fedora carrying oscap + SSG content, plus the copied-in
# Trivy binary + baked DB.
# ---------------------------------------------------------------------------------------------------
FROM ${OPENSCAP_IMAGE}

# oscap (openscap-scanner) + the SCAP Security Guide datastreams, plus jq/tar for extracting the
# docker-cp'd OCI layout into a rootfs (run.sh). `--setopt=install_weak_deps=False` keeps the image
# lean (every extra byte is attack surface in a container the promotion scan step launches per
# artifact). `oscap --version` asserts the toolchain is present and runnable — fails the build loudly.
RUN dnf install -y --setopt=install_weak_deps=False \
      openscap-scanner scap-security-guide jq tar gzip \
  && oscap --version \
  && ls /usr/share/xml/scap/ssg/content/ssg-fedora-ds.xml \
  && dnf clean all

# Trivy: the static binary + the build-time-baked DB, copied OUT of the pinned Trivy stage. Trivy's
# default cache dir is $HOME/.cache/trivy (HOME=/root here), so the DB lands where `trivy image
# --input --skip-db-update` finds it with no --cache-dir flag. `trivy version` confirms the static
# binary runs on the glibc (Fedora) base — fails the build loudly if it does not.
COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy
COPY --from=trivy /trivy-cache /root/.cache/trivy
RUN trivy version && trivy --cache-dir /root/.cache/trivy image --download-db-only --skip-db-update >/dev/null 2>&1 || true

# The scanners are provided above; add only the run shim on top. No further package-manager calls.
COPY run.sh /run.sh
RUN chmod +x /run.sh

WORKDIR /work
ENTRYPOINT ["/run.sh"]
