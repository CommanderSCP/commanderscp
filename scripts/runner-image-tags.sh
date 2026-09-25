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

# scp-runner-ops (M27.1): its build context alone determines the image — the ansible-core version
# is an ARG with a default IN the Dockerfile, so it is already inside the hashed context, and the
# allowlist + upstream inventory are context files too. A lockdown change therefore yields a new
# image, which is the property that matters: the pruned surface must never be served from a stale tag.
ops_hash=$(find apps/runner-ops -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-16)

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

# scp-sshd-fixture (M27.9 item d): a TEST HOST, not a runner — a real `sshd` trusting a CA the test
# mints at run time. It lives under tools/ rather than apps/runner-* deliberately: `@scp/airgap`
# requires every apps/runner-* directory to be bundled and activatable, and this image must never
# ship. It is tagged and published by the same machinery because the reason is identical — the
# integration jobs blackhole egress, so anything a test needs has to arrive as a pre-pulled ref.
sshd_fixture_hash=$(find tools/sshd-fixture -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-16)

# scp-builder-rpm (M28.1): the scp-build-rpm-v1 CATALOG image, not a runner — SCP never launches it,
# the org's Argo Workflows does. Tagged by the same formula because the real-counterparty test
# (`rpm-build-lane.integration.test.ts`) runs it, and its build does a `dnf install` the integration
# job's blackholed egress cannot. Its build context (Dockerfile + build-rpm.sh + the test fixture)
# is the whole input.
builder_rpm_hash=$(find apps/builder-rpm -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-16)

# scp-stackd (M29.4): the Standard Stack controller. NOT a runner and not built from its own
# directory alone — it bundles workspace packages and CARRIES the vendored chart and the helm pin
# (E4: the image IS the release's stack), so every one of those is part of what it is. A chart bump
# with no controller change must still yield a new image.
stackd_hash=$(
  {
    find apps/stackd packages/schemas/src packages/sdk/src deploy/helm-bundled -type f \
      -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/bundle/*' -exec sha256sum {} +
    sha256sum tools/helm/pin.env tools/node/pin.env pnpm-lock.yaml package.json tsconfig.base.json
  } | sort | sha256sum | cut -c1-16
)

echo "SCP_RUNNER_SCAN_IMAGE_REF=${registry}/scp-runner-scan:${scan_hash}"
echo "SCP_STACKD_IMAGE_REF=${registry}/scp-stackd:${stackd_hash}"
echo "SCP_RUNNER_IAC_IMAGE_REF=${registry}/scp-runner-iac:${iac_hash}"
echo "SCP_RUNNER_DEP_IMAGE_REF=${registry}/scp-runner-dep:${dep_hash}"
echo "SCP_RUNNER_OPS_IMAGE_REF=${registry}/scp-runner-ops:${ops_hash}"
echo "SCP_SSHD_FIXTURE_IMAGE_REF=${registry}/scp-sshd-fixture:${sshd_fixture_hash}"
echo "SCP_BUILDER_RPM_IMAGE_REF=${registry}/scp-builder-rpm:${builder_rpm_hash}"
