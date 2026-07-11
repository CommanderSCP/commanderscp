/**
 * Purpose-written operator-facing doc, bundled as `docs/OFFLINE_INSTALL.md`.
 *
 * Deliberate choice over just copying BUILD_AND_TEST.md/DESIGN.md verbatim (which this package
 * ALSO copies in, unmodified, as background reference material — see build-bundle.ts): those two
 * docs are written for CONTRIBUTORS building CommanderSCP from source, full of pnpm/turbo/CI
 * detail an air-gapped OPERATOR installing a pre-built bundle neither has nor needs. This file is
 * the thing an operator actually reads: what's in the tarball, how to verify it, how to run
 * install.sh, what "the same bundle is the upgrade package" means in practice.
 */
export function renderOfflineInstallDoc(bundleVersion: string): string {
  return `# CommanderSCP air-gap bundle — offline install & upgrade

Bundle: \`scp-bundle-${bundleVersion}.tar.gz\`

This document is written for the operator installing or upgrading CommanderSCP on a disconnected
or air-gapped network. See \`BUILD_AND_TEST.md\`/\`DESIGN.md\` in this same \`docs/\` directory for
background on the project; neither is required reading to complete an install.

## What's in the bundle

\`\`\`
scp-bundle-${bundleVersion}/
  images/                   Every image this release needs, as OCI layout (skopeo-copyable)
    scpd/                     api + worker + Web UI (the ghcr.io/commanderscp/scpd image)
    scpd.digest               its pinned manifest digest (sha256:...)
    scpd.digest.sig           cosign signature over scpd.digest
    scp-runner-iac/            the isolated managed-IaC executor image (Mode 2 only)
    scp-runner-iac.digest / .digest.sig
    postgres-eval/             the unmodified postgres:16 image (evaluation/compose use only)
    postgres-eval.digest / .digest.sig
  helm/                      The full Helm chart (deploy/helm) — production Kubernetes installs
  compose/
    docker-compose.yml          the original dev/eval file, for reference (builds from source — do NOT run this one offline)
    docker-compose.airgap.yml   the retargeted variant install.sh actually uses (image: refs, not build:)
  docs/                      This file, plus the project's BUILD_AND_TEST.md/DESIGN.md for reference
  manifest.json              Machine-readable bundle manifest (version, per-image digests)
  manifest.sh                Same manifest, flat shell variables — sourced by install.sh
  install.sh                 The install/upgrade script — see below
  cosign.pub                 Public key to verify every signature in this bundle
  CHECKSUMS.txt              sha256 of every file in this bundle (sha256sum -c compatible)
  CHECKSUMS.txt.sig          cosign signature over CHECKSUMS.txt
\`\`\`

Alongside the tarball itself (not inside it): \`scp-bundle-${bundleVersion}.tar.gz.sig\` and a copy
of \`cosign.pub\`. **Obtain the public key from a channel independent of the tarball's own
download** (the project's release page, a prior trusted install, etc.) before trusting the
signature on the tarball itself — a bundled \`cosign.pub\` alongside a tampered tarball proves
nothing about that tarball, only about itself. Once you've verified the tarball with an
independently-obtained key, the copy of \`cosign.pub\` inside it is fine to use for the
per-image/per-file checks below (they're all covered by that same outer verification already).

## Verify before you extract anything

\`\`\`bash
cosign verify-blob --key cosign.pub --signature scp-bundle-${bundleVersion}.tar.gz.sig \\
  --insecure-ignore-tlog=true scp-bundle-${bundleVersion}.tar.gz
\`\`\`

A non-zero exit or any \`Error:\` output means the tarball is not what was signed — stop, do not
extract it, and get a fresh copy through a trusted channel.

## Install or upgrade

\`\`\`bash
tar xzf scp-bundle-${bundleVersion}.tar.gz
cd scp-bundle-${bundleVersion}
./install.sh --registry <your-registry-host>/<path> --mode helm [--namespace scp] [--release-name scp]
\`\`\`

\`install.sh\` is the same script for a first install and for an upgrade — it always: (1)
cosign-verifies every bundled image and the checksums file against \`cosign.pub\` FIRST, refusing
to continue on any failure; (2) pushes each image, by digest, into your registry under
\`<registry>/<image-name>\`; (3) re-resolves each pushed image's digest from your registry and
confirms it is byte-for-byte the digest that was just verified (a registry push cannot silently
substitute a different image without this check catching it); (4) runs \`helm upgrade --install\`
(or, in \`--mode compose\`, rewrites and runs the compose file) pinned to those exact digests —
never a mutable tag alone.

Add \`--dry-run\` to perform every step above except the final \`helm upgrade\`/\`docker compose up\`
— useful to prove the verify+retarget-push loop works before touching a live cluster/host.

See \`install.sh --help\` for the full flag list, and its own header comment for the security
rationale behind each step (it is deliberately not a script you should treat as trustworthy without
reading — read it once before running it against a production system).

## What "the bundle is the upgrade package" means

There is no separate upgrade artifact. To upgrade an existing install, download the new version's
\`scp-bundle-<new-version>.tar.gz\`, verify it the same way, and run its \`install.sh\` the same way,
pointed at the same \`--registry\`/\`--namespace\`/\`--release-name\`. For Helm installs this becomes
a \`helm upgrade\` of the existing release (pre-upgrade migrations Job runs automatically —
expand/contract, zero-downtime, see \`helm/README.md\`); for compose installs it's an in-place
\`docker compose up -d\` against the retargeted file.
`;
}
