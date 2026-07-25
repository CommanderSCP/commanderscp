#!/usr/bin/env bash
# Reclaim disk on a GitHub-hosted runner before a drill that builds several images AND stands up a
# kind cluster.
#
# WHY THIS EXISTS. Disk is the one genuinely new constraint introduced by moving CI from the homelab
# ARC runners to GitHub-hosted `ubuntu-latest`: a hosted runner documents ~14 GB of free SSD, where a
# homelab node had no practical limit. The deploy drills are the jobs that plausibly exceed it —
# each does two or more full image builds (scpd is multi-stage and large), a signed air-gap bundle,
# a `kind` node image, and then pulls a Kubernetes control plane (plus Calico, plus Argo CD for the
# bundled-argocd drill) into that cluster. Nothing else in CI combines multiple image builds with a
# cluster bring-up, which is why this step is wired ONLY into .github/workflows/deploy-drills.yml
# and deliberately NOT sprinkled across the ci.yml jobs.
#
# WHAT IT REMOVES. Only preinstalled toolchains for languages this repo does not use — the Android
# SDK, .NET, GHC/Haskell, and CodeQL/Swift bundles that GitHub bakes into the image. Together these
# are the bulk of the used space and reclaim well over 10 GB. Node comes from actions/setup-node and
# pnpm from corepack (.github/actions/setup), and every drill installs its own
# helm/kubectl/kind/cosign/skopeo, so nothing removed here is a dependency of anything we run.
#
# PORTABILITY. A plain shell script, not a third-party action, so it introduces no hosted-service
# dependency (BUILD_AND_TEST.md §6, charter principle 5) and is a harmless no-op on a self-hosted
# runner or a workstation, where none of these paths exist. It never fails the job: a missing path
# is expected, and reclaiming less space than hoped is not itself an error.

set -uo pipefail

echo "disk before:"
df -h / || true

for path in \
  /usr/local/lib/android \
  /usr/share/dotnet \
  /opt/ghc \
  /usr/local/.ghcup \
  /opt/hostedtoolcache/CodeQL \
  /usr/local/share/powershell \
  /usr/share/swift; do
  if [ -e "$path" ]; then
    echo "removing $path"
    sudo rm -rf "$path" || echo "could not fully remove $path — continuing"
  fi
done

echo "disk after:"
df -h / || true
