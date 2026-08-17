#!/usr/bin/env bash
# LEVER 1 — deterministic content-hash tags for the ephemeral runner images.
#
# Both the `runner-images` publish job and the `integration` job in .github/workflows/ci.yml source
# these EXACT tags: the publish job builds+pushes them to GHCR (rebuilt ONLY when the build context
# changes — a `docker pull || build+push` cache), and the integration job(s) `docker pull` them so
# the tests never build in CI. Because those two must agree, the tag FORMULA lives here, in one
# place, and both jobs compute it identically.
#
# Emits `KEY=value` lines suitable for appending to $GITHUB_ENV (or $GITHUB_OUTPUT). The two env
# var names match the `refEnvVar`s the tests read via resolveRunnerImage (@scp/plugin-testkit):
# SCP_RUNNER_SCAN_IMAGE_REF and SCP_RUNNER_IAC_IMAGE_REF. Run from the repo root.
set -euo pipefail

registry="ghcr.io/commanderscp"

# scp-runner-scan: the Dockerfile/run.sh build context PLUS the pinned Trivy + OpenSCAP DB versions
# the image bakes in — a pin bump must yield a NEW image even if apps/runner-scan/** is byte-identical.
scan_hash=$(
  {
    find apps/runner-scan -type f -exec sha256sum {} +
    sha256sum tools/trivy/pin.env tools/openscap/pin.env
  } | sort | sha256sum | cut -c1-16
)

# scp-runner-iac: its build context alone determines the image.
iac_hash=$(find apps/runner-iac -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-16)

# scp-runner-dep (M21.5): the Dockerfile/run.sh build context PLUS the pinned BusyBox base — same
# reasoning as scp-runner-scan's pin inclusion. The base is a LITERAL digest in the Dockerfile (it is
# deliberately not a build arg — see apps/runner-dep/Dockerfile), so a pin bump already changes
# apps/runner-dep/**; tools/busybox/pin.env is hashed anyway so that updating the pin's provenance
# record and the Dockerfile in the same commit can never yield a stale cached image.
dep_hash=$(
  {
    find apps/runner-dep -type f -exec sha256sum {} +
    sha256sum tools/busybox/pin.env
  } | sort | sha256sum | cut -c1-16
)

echo "SCP_RUNNER_SCAN_IMAGE_REF=${registry}/scp-runner-scan:${scan_hash}"
echo "SCP_RUNNER_IAC_IMAGE_REF=${registry}/scp-runner-iac:${iac_hash}"
echo "SCP_RUNNER_DEP_IMAGE_REF=${registry}/scp-runner-dep:${dep_hash}"
