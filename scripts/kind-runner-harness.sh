#!/usr/bin/env bash
# ==================================================================================================
# THE KUBERNETES RUNNER HARNESS (M23.2) — A REAL API SERVER, ON EVERY PR
# ==================================================================================================
#
# WHY IT EXISTS AS A GATE AND NOT A DRILL. Owner decision 3 (BUILD_AND_TEST.md M23, 2026-08-18):
# "A REAL PR-GATING KUBERNETES HARNESS. The DoD's premise that one exists is false: nothing in the
# tree talks to a Kubernetes API server, and the three shell drills are `schedule`-only, state twice
# that they are 'NEVER merge-gating', and recorded their greens on a decommissioned runner. Building
# one is net-new work with vendored-CNI and disk cost, and it is required rather than optional — a
# fake Kubernetes client only proves the adapter agrees with itself."
#
# WHAT IT PROVES THAT `kubernetes-adapter.test.ts` CANNOT, and every item is a question a fake
# answers by construction:
#   - that the API server ACCEPTS the Job manifest this adapter builds (a fake accepts anything);
#   - that `spec.suspend: true` -> PATCH `false` really is create-then-start on a live Job controller;
#   - that `subPath` mounts land the copied bytes where the runner looks for them, and that what the
#     runner writes comes back out — the whole of owner decision 5's byte-movement story;
#   - that a duplicate `metadata.name` really is a 409 with `reason: AlreadyExists`;
#   - that an RFC3339 deadline is rejected as a label VALUE and accepted as an annotation;
#   - THAT THE CHART'S OWN RBAC IS SUFFICIENT. The harness binds the SA to the Role rendered from
#     `deploy/helm/templates/runner-iac.yaml` by `helm template` — not to a hand-written copy — so a
#     verb the adapter needs and the chart does not grant is a 403 here rather than in production.
#     That check found one immediately: the shipped Role grants `create,get,list,watch,delete` on
#     `batch/jobs` and NO `patch`, and the unsuspend is a PATCH.
#
# OFFLINE (charter principle 5). Two images and no live registry:
#   - `kindest/node`, digest-pinned in `tools/ci-mirror/images.list` and served from the GHCR mirror.
#     `scripts/ci-mirror.sh seed` re-tags it to the literal `SCP_KIND_NODE_IMAGE` names it, so
#     `kind create cluster --image` finds it locally and pulls nothing.
#   - the runner image, loaded with `kind load image-archive` from a skopeo-produced,
#     SINGLE-PLATFORM docker-archive. NOT `kind load docker-image`: that runs
#     `ctr images import --all-platforms`, which fails on a multi-arch tag with
#     "content digest ... not found" — measured here and already recorded at
#     `scripts/airgap-drill.sh:173-186`, whose workaround this reuses rather than re-deriving.
#
# WHAT IT DELIBERATELY DOES NOT DO: install a CNI. kind's default kindnet does not enforce
# NetworkPolicy — re-measured for M23.2 with a known-positive control, a pod SELECTED by a deny-all
# egress policy reached a public IP and a resolver exactly like an unselected one. A gate that
# installed no CNI and asserted containment would assert nothing; a gate that installed Calico would
# add its image, its rollout wait and its unvendored manifest to every PR. Network containment stays
# with `scripts/airgap-drill.sh`, which already has that machinery. THIS harness gates the Job
# LIFECYCLE, and says so.
#
#   scripts/kind-runner-harness.sh up     create the cluster and write <workdir>/harness.json
#   scripts/kind-runner-harness.sh down   delete the cluster
#
set -euo pipefail

CLUSTER_NAME="${SCP_KIND_CLUSTER:-scp-runner-harness}"
NAMESPACE="${SCP_KIND_NAMESPACE:-scp-runner-harness}"
# The kind node image. DIGEST-PINNED IN THE MIRROR MANIFEST and re-tagged to this literal by
# `ci-mirror.sh seed`; this default is what a developer's machine uses.
NODE_IMAGE="${SCP_KIND_NODE_IMAGE:-kindest/node:v1.36.1}"
# The image the runner Jobs run. `alpine:3.20` is ALREADY in tools/ci-mirror/images.list (it is
# managed-scan's clean scan subject), so the harness adds no new mirror entry for it — and it has a
# shell, which is what lets one image stand in for all three runner classes' observable behaviour:
# read /work/in, write /work/out, exit 0 or not, print to stdout or stderr.
RUNNER_IMAGE="${SCP_KIND_RUNNER_IMAGE:-alpine:3.20}"
WORKDIR="${SCP_KIND_WORKDIR:-${HOME}/.cache/scp-kind-runner-harness}"
# The shared workspace. On CI this is an ordinary host directory; kind mounts it into the node and
# the runner Job mounts it from the node. It is the single-node stand-in for the RWX PersistentVolume
# owner decision 5 makes a production prerequisite — and it is a stand-in, not a substitute: it
# proves the adapter's subPath layout and byte movement, not that any particular storage class is RWX.
WORKSPACE_HOST="${WORKDIR}/workspace"
NODE_WORKSPACE="/scp-workspace"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\n[kind-runner-harness] %s\n' "$*" >&2; }

down() {
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  log "cluster '${CLUSTER_NAME}' deleted"
}

up() {
  for tool in kind kubectl helm docker; do
    command -v "$tool" >/dev/null 2>&1 || { echo "[kind-runner-harness] missing: $tool" >&2; exit 1; }
  done

  rm -rf "$WORKDIR"
  mkdir -p "$WORKSPACE_HOST"
  # WORLD-WRITABLE ON PURPOSE. The runner container's uid is the image's, not the harness's, and the
  # whole point of the copy-out arm is that the container WRITES here. A permission failure would
  # surface as an empty evidence directory, which is exactly the silent-truncation shape the
  # ordering suite exists to prevent — so it is made impossible rather than diagnosed later.
  chmod 0777 "$WORKSPACE_HOST"

  export KUBECONFIG="${WORKDIR}/kubeconfig"

  cat >"${WORKDIR}/kind-config.yaml" <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: ${WORKSPACE_HOST}
        containerPath: ${NODE_WORKSPACE}
EOF

  log "creating cluster '${CLUSTER_NAME}' from ${NODE_IMAGE}"
  local t0 t1
  t0=$(date +%s)
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  kind create cluster \
    --name "$CLUSTER_NAME" \
    --image "$NODE_IMAGE" \
    --config "${WORKDIR}/kind-config.yaml" \
    --kubeconfig "$KUBECONFIG" \
    --wait 120s
  t1=$(date +%s)
  log "cluster ready in $((t1 - t0))s"

  log "loading ${RUNNER_IMAGE} as a single-platform archive (see the header for why not kind load docker-image)"
  local arch archive
  # The kind NODE's architecture, which is the runner's — not the shell's. On a native amd64 CI
  # runner these agree; on an arm64 developer machine they also agree, and asking the node is what
  # keeps that a fact rather than a coincidence.
  arch="$(kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.architecture}')"
  archive="${WORKDIR}/runner-image.tar"
  # `docker save --platform` RATHER THAN skopeo, and the difference from `airgap-drill.sh`'s
  # workaround is worth one sentence: that script predates the flag and reaches for
  # `skopeo copy docker-daemon:` instead, which talks to the daemon over a hardcoded
  # `/var/run/docker.sock` and therefore fails outright on any host whose daemon is elsewhere
  # (measured here on colima: "failed to connect to the docker API at unix:///var/run/docker.sock").
  # `docker save --platform` uses the client's own DOCKER_HOST, needs no extra tool, and produces the
  # same thing the workaround was after: a SINGLE-PLATFORM archive. That is the part that matters —
  # `kind load docker-image` runs `ctr images import --all-platforms` against a multi-arch tag and
  # fails with "content digest ... not found".
  docker save --platform "linux/${arch}" -o "$archive" "$RUNNER_IMAGE"
  kind load image-archive "$archive" --name "$CLUSTER_NAME"

  log "creating namespace + ServiceAccount"
  kubectl create namespace "$NAMESPACE"
  kubectl -n "$NAMESPACE" create serviceaccount scp-runner-harness

  log "applying THE CHART'S OWN runner RBAC — helm template, not a hand-written copy"
  # `--set serviceAccount.name` points the chart's RoleBinding at the harness SA, so what is bound is
  # exactly the Role `deploy/helm/templates/runner-iac.yaml` renders. A verb the adapter needs and
  # the chart does not grant is then a 403 in the test rather than a surprise in production.
  helm template scp "${REPO_ROOT}/deploy/helm" \
    --namespace "$NAMESPACE" \
    --set managedIac.enabled=true \
    --set managedIac.runnerImage="$RUNNER_IMAGE" \
    --set serviceAccount.name=scp-runner-harness \
    --show-only templates/runner-iac.yaml \
    | kubectl apply -n "$NAMESPACE" -f -

  log "minting a ServiceAccount token and extracting the cluster CA"
  local token ca_file api_base
  token="$(kubectl -n "$NAMESPACE" create token scp-runner-harness --duration=2h)"
  ca_file="${WORKDIR}/cluster-ca.crt"
  kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' \
    | base64 -d >"$ca_file"
  api_base="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"

  cat >"${WORKDIR}/harness.json" <<EOF
{
  "cluster": "${CLUSTER_NAME}",
  "namespace": "${NAMESPACE}",
  "apiBase": "${api_base}",
  "token": "${token}",
  "caFile": "${ca_file}",
  "kubeconfig": "${KUBECONFIG}",
  "workspaceHost": "${WORKSPACE_HOST}",
  "nodeWorkspace": "${NODE_WORKSPACE}",
  "runnerImage": "${RUNNER_IMAGE}",
  "createSeconds": $((t1 - t0))
}
EOF
  log "harness ready: ${WORKDIR}/harness.json"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 [up|down]" >&2; exit 2 ;;
esac
