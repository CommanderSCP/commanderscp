#!/usr/bin/env bash
# M29.1 kind drill (docs/adr/0060-front-door.md, BUILD_AND_TEST.md §M29.1 DoD): a scripted
# `scp install --role commander --profile eval` against a fresh kind cluster reaches a logged-in
# admin session, the role's default Standard Stack backends install (ready or their `needs`
# shown), and the HQ outpost is declared — all through ONE command, never `kubectl logs` and never
# `kubectl` against SCP's own namespace for THIS SCRIPT's verification (kubectl is used only for
# cluster/image FIXTURE setup and teardown — the same posture scripts/kind-drill.sh already has;
# every ASSERTION below is a plain `scp` CLI call, exactly what an operator would run).
#
# Not wired into the merge-gating kind harness (job "4e" in .github/workflows/ci.yml): that job's
# ~2-minute budget is tuned for Testcontainers-backed suites (the runner-launcher adapter, the
# stack controller unit-style kind tests against a scpd PROCESS) — this drill does a REAL, FULL
# `helm install` of the whole chart (postgres, api, worker, the stack controller, and all five
# Standard Stack backends actually installing), which took ~3 minutes end to end when this script
# was written and verified. Following the existing precedent (kind-drill.sh / ansible-drill.sh /
# airgap-drill.sh in .github/workflows/deploy-drills.yml — nightly + on-demand, never
# merge-gating, for exactly this "full kind cluster + real helm install" shape), this drill is
# wired into deploy-drills.yml the same way, not into job 4e.
#
# Requires: docker, kind, kubectl, helm, node (all already required — BUILD_AND_TEST.md §1).
# Assumes `pnpm build` already ran (packages/cli/dist/bin.js, apps/server/dist, apps/web/dist must
# exist) — same precondition scripts/kind-drill.sh's caller already has.
#
# Never reaches the internet beyond what building the two images and `kind create cluster`
# (pulling the pinned kindest/node, cached after first run) already need.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CLUSTER_NAME="${SCP_INSTALL_DRILL_CLUSTER_NAME:-scp-m29-1-install-drill}"
IMAGE_TAG="m29-1-install-drill"
RELEASE_NAME=scp
NAMESPACE=scp
PF_PID=""
INSTALL_LOG="$(mktemp)"

KUBECONFIG="$(mktemp -d)/scp-install-drill.kubeconfig"
export KUBECONFIG
# Isolated config dir for the drill's own `scp` CLI calls (config-store.ts's SCP_CONFIG_DIR
# override) — never a developer's real ~/.scp.
SCP_CONFIG_DIR="$(mktemp -d)"
export SCP_CONFIG_DIR

log() { echo "==> $*"; }
fail() { echo "scp-install-kind-drill: FAIL — $*" >&2; exit 1; }

cleanup() {
  local status=$?
  log "cleanup (exit code $status)"
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    echo "--- scp-install-kind-drill.sh FAILED — dumping the install log and cluster state ---" >&2
    cat "$INSTALL_LOG" >&2 || true
    kubectl get pods -A -o wide 2>&1 || true
  fi
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

log "building the scpd image"
docker build -t "scp:${IMAGE_TAG}" .

log "building the scp-stackd image (ADR-0058) — stackd.enabled defaults to true since this ADR"
docker build -f apps/stackd/Dockerfile -t "scp-stackd:${IMAGE_TAG}" .

log "creating kind cluster '${CLUSTER_NAME}'"
# The pinned node image job 4e already mirrors (tools/ci-mirror/images.list) — no other image is
# pulled by cluster creation.
kind create cluster --name "$CLUSTER_NAME" --image docker.io/kindest/node:v1.36.1 \
  --kubeconfig "$KUBECONFIG" --wait 120s

log "loading both images into kind"
kind load docker-image "scp:${IMAGE_TAG}" "scp-stackd:${IMAGE_TAG}" --name "$CLUSTER_NAME"

KUBE_CONTEXT="kind-${CLUSTER_NAME}"
kubectl config use-context "$KUBE_CONTEXT" >/dev/null

log "scp install --role commander --profile eval — one command, no kubectl logs"
# --set here only points at the LOCALLY loaded images (never published) — see install-cli.ts's own
# doc comment on --set for why this is the same escape hatch an operator would reach for. Every
# other value (federationRole, deploymentMode, instanceOperator.grantBootstrapAdmin,
# bootstrap.org/adminUsername, postgres.evalInCluster.enabled) is `scp install`'s own doing.
set +e
node "${ROOT_DIR}/packages/cli/dist/bin.js" install \
  --role commander --profile eval \
  --kube-context "$KUBE_CONTEXT" --namespace "$NAMESPACE" --release-name "$RELEASE_NAME" \
  --yes \
  --set "image.repository=scp" --set "image.tag=${IMAGE_TAG}" --set "image.pullPolicy=Never" \
  --set "stackd.image.repository=scp-stackd" --set "stackd.image.tag=${IMAGE_TAG}" \
  --set "stackd.image.pullPolicy=Never" \
  --timeout 300 --stack-timeout 300 \
  >"$INSTALL_LOG" 2>&1
INSTALL_EXIT=$?
set -e
cat "$INSTALL_LOG"
[ "$INSTALL_EXIT" -eq 0 ] || fail "scp install exited ${INSTALL_EXIT}"

log "asserting the install log proves every DoD item — NOT by reading kubectl logs, by reading what scp install itself already printed to ITS OWN terminal"

grep -q "bootstrap admin one-time password (shown once — not stored in plaintext):" "$INSTALL_LOG" \
  || fail "the credential-surfacing step did not run — the installer never printed the one-time password in its own terminal (docs/adr/0060-front-door.md §2)"

grep -q "Logged in as 'admin'" "$INSTALL_LOG" \
  || fail "no logged-in admin session — the printed password never round-tripped through a real login"

grep -q "declaring this instance's federation identity (role: commander)" "$INSTALL_LOG" \
  || fail "the federation identity step did not run"

grep -q "HQ outpost declared." "$INSTALL_LOG" \
  || fail "the HQ outpost was not declared for this commander install"

for backend in argocd argo-workflows argo-rollouts argo-events gitea; do
  line="$(grep -E "^${backend}[[:space:]]" "$INSTALL_LOG" || true)"
  [ -n "$line" ] || fail "no stack status row for backend '${backend}'"
  echo "$line" | grep -qE '\(pending\)' \
    && fail "backend '${backend}' never reported ready OR needs within --stack-timeout: ${line}"
  echo "   ${line}"
done
log "PASS: every enabled backend reported ready or needs (never left (pending))"

log "re-verifying through FRESH scp CLI calls (a new process, a new port-forward) — proves the state actually persisted server-side, not just that the installer's own in-memory summary looked right"
kubectl -n "$NAMESPACE" port-forward "svc/${RELEASE_NAME}-commanderscp-api" 0:80 \
  >/tmp/scp-install-drill-pf.log 2>&1 &
PF_PID=$!
# `port-forward ...:80` with a literal `0` local port picks an ephemeral one; read it back from
# the CLI's own announcement line ("Forwarding from 127.0.0.1:PORT -> 80").
for _ in $(seq 1 30); do
  PF_PORT="$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9]*\).*/\1/p' /tmp/scp-install-drill-pf.log | head -n1)"
  [ -n "$PF_PORT" ] && break
  sleep 1
done
[ -n "$PF_PORT" ] || fail "port-forward never announced a local port"
export SCP_API_URL="http://127.0.0.1:${PF_PORT}/api/v1"
for _ in $(seq 1 30); do
  curl -fsS "${SCP_API_URL%/api/v1}/healthz" >/dev/null 2>&1 && break
  sleep 1
done

WHOAMI_OUT="$(node "${ROOT_DIR}/packages/cli/dist/bin.js" whoami 2>&1)" \
  || fail "scp whoami failed against the stored session: ${WHOAMI_OUT}"
echo "$WHOAMI_OUT" | grep -qi "admin" || fail "scp whoami did not report the admin session: ${WHOAMI_OUT}"
log "PASS: scp whoami confirms the logged-in admin session (fresh process, stored credentials)"

OUTPOST_OUT="$(node "${ROOT_DIR}/packages/cli/dist/bin.js" federation outpost list 2>&1)" \
  || fail "scp federation outpost list failed: ${OUTPOST_OUT}"
echo "$OUTPOST_OUT" | grep -qi '\bhq\b' || fail "no HQ outpost binding in: ${OUTPOST_OUT}"
log "PASS: the HQ outpost exists (re-read via a fresh 'scp federation outpost list')"

STACK_OUT="$(node "${ROOT_DIR}/packages/cli/dist/bin.js" stack status 2>&1)" \
  || fail "scp stack status failed: ${STACK_OUT}"
for backend in argocd argo-workflows argo-rollouts argo-events gitea; do
  echo "$STACK_OUT" | grep -q "^${backend}" || fail "scp stack status has no row for '${backend}': ${STACK_OUT}"
done
log "PASS: scp stack status (fresh call) still reports every backend"

log "M29.1 kind install drill: ALL CHECKS PASSED (scp install -> logged-in admin session -> stack ready/needs -> HQ outpost, no kubectl logs, no kubectl against scp's namespace for verification)"
