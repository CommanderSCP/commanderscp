/**
 * Purpose-written operator-facing doc, bundled as `docs/OFFLINE_INSTALL.md`.
 *
 * Deliberate choice over just copying BUILD_AND_TEST.md/DESIGN.md verbatim (which this package
 * ALSO copies in, unmodified, as background reference material — see build-bundle.ts): those two
 * docs are written for CONTRIBUTORS building CommanderSCP from source, full of pnpm/turbo/CI
 * detail an air-gapped OPERATOR installing a pre-built bundle neither has nor needs. This file is
 * the thing an operator actually reads: what's in the tarball, how to verify it, how to run
 * install.sh, what "the same bundle is the upgrade package" means in practice.
 *
 * The `images/` listing is GENERATED from `bundle-images.ts` rather than written out here. It used
 * to be prose, and prose drifted: it still named three images long after the bundle had grown to
 * nine, and it never named `scp-runner-scan`/`scp-runner-dep` because the bundle never carried
 * them (M21.7 item 1). An operator's inventory of what crossed the air gap is exactly the wrong
 * thing to maintain by hand in a second place.
 */
import { BUNDLE_IMAGE_SPECS } from "./bundle-images.js";

/** The `images/` subtree of the contents listing, one entry per canonically-bundled image. */
function renderImagesTree(): string {
  const width = Math.max(...BUNDLE_IMAGE_SPECS.map((s) => s.name.length)) + 1;
  return BUNDLE_IMAGE_SPECS.map(
    (spec) => `    ${(spec.name + "/").padEnd(width + 1)}  ${spec.doc}`
  ).join("\n");
}

export function renderOfflineInstallDoc(bundleVersion: string): string {
  return `# CommanderSCP air-gap bundle — offline install & upgrade

Bundle: \`scp-bundle-${bundleVersion}.tar.gz\`

This document is written for the operator installing or upgrading CommanderSCP on a disconnected
or air-gapped network. See \`BUILD_AND_TEST.md\`/\`DESIGN.md\` in this same \`docs/\` directory for
background on the project; neither is required reading to complete an install.

## What's in the bundle

\`\`\`
scp-bundle-${bundleVersion}/
  images/                   Every image this release needs, as OCI layout (skopeo-copyable).
                            Each <name>/ is accompanied by <name>.digest (its pinned manifest
                            digest, sha256:...) and <name>.digest.sig (cosign signature over it).
${renderImagesTree()}
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
nothing about that tarball, only about itself.

**Use that independently-obtained key for EVERY verification below, including \`install.sh\` —
never the \`cosign.pub\` shipped INSIDE the bundle.** \`install.sh\` REQUIRES an external key
(\`--pubkey <path>\` or \`SCP_COSIGN_PUBKEY\`) and refuses to run without one: an attacker who
substitutes the whole bundle can simply re-sign everything with their own key and ship a matching
\`cosign.pub\` alongside it, so a bundle verifying itself against a key it also ships proves
nothing about authenticity. The in-bundle \`cosign.pub\` is shipped for convenience only (e.g.
eyeballing it against a known-good value) — no tool in this project ever reads it as a trust root.

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
./install.sh --registry <your-registry-host>/<path> \\
  --pubkey /path/to/independently-obtained/cosign.pub \\
  --mode helm [--namespace scp] [--release-name scp]
\`\`\`

\`--pubkey\` (or the \`SCP_COSIGN_PUBKEY\` environment variable) is REQUIRED — \`install.sh\` fails
closed with a clear message if it's omitted, rather than falling back to the bundle's own
\`cosign.pub\`.

\`install.sh\` is the same script for a first install and for an upgrade — it always: (1)
cosign-verifies every bundled image and the checksums file against that EXTERNAL \`--pubkey\`
FIRST, refusing to continue on any failure; (2) pushes each image, by digest, into your registry
under \`<registry>/<image-name>\`; (3) re-resolves each pushed image's digest from your registry and
confirms it is byte-for-byte the digest that was just verified (a registry push cannot silently
substitute a different image without this check catching it); (4) runs \`helm upgrade --install\`
(or, in \`--mode compose\`, rewrites and runs the compose file) pinned to those exact digests —
never a mutable tag alone.

Add \`--dry-run\` to perform every step above except the final \`helm upgrade\`/\`docker compose up\`
— useful to prove the verify+retarget-push loop works before touching a live cluster/host.

See \`install.sh --help\` for the full flag list, and its own header comment for the security
rationale behind each step (it is deliberately not a script you should treat as trustworthy without
reading — read it once before running it against a production system).

## The managed-execution runner images (and why install.sh does not switch them on)

The bundle carries all three ephemeral runner images — \`scp-runner-iac\`, \`scp-runner-scan\`,
\`scp-runner-dep\` — unconditionally, so every managed-execution class is **installable** offline.
Two things do not follow from that, and both are worth knowing before you plan a rollout: none of
them is **enabled**, and not every deployment mode can **run** one.

**\`--mode helm\` CAN start them, as of 2026-08-20 (M23.4) — this paragraph said the opposite until
then, and an operator who read the old text and planned around it should re-plan.** What changed is
that the orchestrator plugins no longer launch a runner only with the docker CLI: with
\`managedRunners.launcher=kubernetes\` each run is an ephemeral \`Job\` created through the API
server. Still NO docker socket — this chart mounts none and never will (a container-escape risk it
will not paper over). Three values enable it, and the chart refuses to render if any is missing
rather than hanging: \`managedRunners.launcher=kubernetes\`, an EXISTING ReadWriteMany claim in
\`managedRunners.kubernetes.workspace.claimName=<your-claim>\` (Kubernetes has no \`docker cp\`, so
inputs and evidence move through a volume the worker and the Job both mount — this chart does not
create it), and at least one class: \`managedIac.enabled=true\` with \`managedIac.runnerImage=<ref>\`,
\`managedDep.runnerImage=<ref>\`, or \`managedScan.runnerImage=<ref>\`.

**Two things to know before you turn it on under helm.** managed-IaC's credentials reach the runner
as a per-run Secret, which needs \`secrets: create,delete\` on the worker ServiceAccount — the chart
grants it by default and \`managedRunners.kubernetes.perRunSecrets=false\` declines it, in which case
managed-IaC refuses loudly rather than putting the credential in a pod env var. And \`--network
none\` is NOT honoured on Kubernetes and cannot be: no pod-spec field removes a pod's network
namespace, so runner pods carry the label \`scp.launcher.network\` (its value is the requested mode)
for a NetworkPolicy to select, which
is traffic denial rather than interface absence and is fail-open on a CNI that does not enforce. On
compose/VM, \`--network none\` denies that path outright. See \`helm/README.md\` and ADR-0035 §6a.

**\`--mode compose\` — which is also what the \`scp.platform\` Ansible role runs on a VM — is the
mode where they work.** Each class is off until you name its image, that image setting IS the
class's on/off control, and here the setting is an environment variable on the \`scp\` service. So
\`install.sh\` pushes and digest-pins all three, prints the exact refs, and leaves the choice to you:

| Runner | What it does | How to enable (compose/VM) |
| --- | --- | --- |
| \`scp-runner-iac\` | managed-IaC releases for orgs without a pipeline | \`SCP_MANAGED_IAC_RUNNER_IMAGE=<printed ref>\` |
| \`scp-runner-scan\` | the commander's promotion-scan toolchain (trivy + oscap) | \`SCP_MANAGED_SCAN_RUNNER_IMAGE=<printed ref>\` |
| \`scp-runner-dep\` | the isolated manifest editor for dependency bumps | \`SCP_MANAGED_DEP_RUNNER_IMAGE=<printed ref>\` — this class WRITES to your repositories |

Add the ones you want to the \`scp\` service's \`environment:\` block in the retargeted compose file
\`install.sh\` wrote, then \`docker compose up -d\` again:

\`\`\`yaml
services:
  scp:
    environment:
      SCP_MANAGED_SCAN_RUNNER_IMAGE: <the ref install.sh printed>
\`\`\`

**Two prerequisites, or none of those settings starts anything.** Both widen what the \`scp\`
container can do to its host, so both are deliberately yours to decide rather than something
\`install.sh\` arranges:

1. **a docker CLI inside the container** — the scpd image ships none (it carries cosign and skopeo
   and nothing else). Mount one and point \`SCP_MANAGED_RUNNER_DOCKER_BINARY\` at its path.
2. **a reachable Docker daemon** — a mounted \`/var/run/docker.sock\`, or \`DOCKER_HOST\`. Each
   runner is launched with \`docker create\` / \`docker cp\` / \`docker start\`, and the shipped
   compose file mounts no socket.

Without both, the image ref is set and no runner can be launched.

Use the printed **digest-pinned** ref rather than a tag you compose yourself: the digest is the
thing this bundle's signatures actually attest to, and a bare tag in your registry is mutable.

## What "the bundle is the upgrade package" means

There is no separate upgrade artifact. To upgrade an existing install, download the new version's
\`scp-bundle-<new-version>.tar.gz\`, verify it the same way, and run its \`install.sh\` the same way,
pointed at the same \`--registry\`/\`--namespace\`/\`--release-name\`. For Helm installs this becomes
a \`helm upgrade\` of the existing release (pre-upgrade migrations Job runs automatically —
expand/contract, zero-downtime, see \`helm/README.md\`); for compose installs it's an in-place
\`docker compose up -d\` against the retargeted file.
`;
}
