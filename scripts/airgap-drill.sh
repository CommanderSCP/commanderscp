#!/usr/bin/env bash
# M8 air-gap zero-egress install drill (BUILD_AND_TEST.md sec.8 M8 DoD: "Air-gap drill in CI:
# build bundle -> install into a network-isolated kind cluster from a local registry -> golden
# path ... pass with ZERO external egress (enforced by network policy)"; and the SECURITY-SENSITIVE
# note: "the air-gap drill must GENUINELY block egress ... enforce default-deny NetworkPolicy and
# assert a deliberate egress attempt FAILS").
#
# WHAT MAKES THE EGRESS BLOCK GENUINE (not vacuous): kind's DEFAULT CNI (kindnet) does NOT enforce
# NetworkPolicy at all -- a default-deny egress policy on a plain kind cluster is a no-op, and a
# "golden path that happens not to call out" would prove nothing. This drill installs Calico as the
# CNI specifically so the chart's default-deny egress NetworkPolicy is ACTUALLY enforced, then:
#   (a) proves the enforcement is real -- a deliberately-launched pod carrying the chart's own pod
#       labels (so it's covered by the default-deny egress policy) tries to reach a PUBLIC IP on
#       ports 443, 5432 (Postgres), AND 4222 (NATS) -- the latter two specifically because
#       adversarial review MAJOR #2 found the chart's allow-postgres/allow-nats rules, on
#       UNCONFIGURED defaults, used to render no `to:` at all (= "any destination", including the
#       public internet, on those ports); testing only 443 would never have caught that hole. ALL
#       THREE MUST fail; the drill FAILS if any of them SUCCEEDS;
#   (b) proves the app still works under that same policy -- the golden path (register a service)
#       succeeds, because the chart's explicit DNS + in-cluster-Postgres allows are the only egress
#       the app needs.
#
# Images come from a LOCAL registry (the air-gap "customer registry" stand-in), pushed there by the
# signed bundle's own install.sh (cosign-verify -> retarget -> digest-pinned) -- so this also
# exercises the full bundle install path against a real cluster, which the @scp/airgap package's own
# manual verification explicitly could NOT (no cluster). The cluster has no image-pull path to the
# internet: every image is either in the local registry or `kind load`ed.
#
# Requires: docker (colima ok), kind, kubectl, helm, skopeo, cosign, node/pnpm. HEAVY + SLOW
# (Calico install + two image builds + a bundle build) -- this is a nightly/manual drill, never a
# per-PR merge gate. See .github/workflows/deploy-drills.yml.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CLUSTER_NAME="${AIRGAP_DRILL_CLUSTER_NAME:-scp-m8-airgap-drill}"
REGISTRY_CONTAINER="scp-airgap-drill-registry"
REGISTRY_PORT="${AIRGAP_DRILL_REGISTRY_PORT:-5070}"
RELEASE_NAME="scp"
BUNDLE_VERSION="airgap-drill"
SCRATCH="$(mktemp -d)"
PF_PID=""
BUNDLE_DIR=""

log() { echo "==> $*"; }

cleanup() {
  local status=$?
  log "cleanup (exit $status)"
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    echo "--- airgap-drill.sh FAILED -- cluster state ---" >&2
    kubectl get pods -A 2>&1 | tail -40 >&2 || true
  fi
  helm uninstall "$RELEASE_NAME" >/dev/null 2>&1 || true
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  docker rm -f "$REGISTRY_CONTAINER" 2>/dev/null || true
  rm -rf "$SCRATCH"
  exit "$status"
}
trap cleanup EXIT

SCPD_REF="${AIRGAP_DRILL_SCPD_REF:-scp:dev}"
RUNNER_IAC_REF="${AIRGAP_DRILL_RUNNER_IAC_REF:-scp-runner-iac:dev}"
POSTGRES_REF="${AIRGAP_DRILL_POSTGRES_REF:-postgres:16}"

# KUBECONFIG isolation + namespace pin (see scripts/kind-drill.sh for the full rationale): this drill
# can run inside an ARC runner POD living in the homelab k3s, whose ambient in-cluster kubeconfig +
# SA namespace (github-runners) would otherwise leak into helm/kubectl/install.sh instead of the
# fresh kind cluster. A dedicated kind-only KUBECONFIG + HELM_NAMESPACE=default keeps every
# kubectl/helm/install.sh call targeting only this drill's kind cluster and its `default` namespace.
KUBECONFIG="$(mktemp -d)/airgap-drill.kubeconfig"
export KUBECONFIG
export HELM_NAMESPACE=default

log "checking prerequisites"
for bin in docker kind kubectl helm skopeo cosign node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing required tool: $bin" >&2; exit 1; }
done

log "ensuring source images exist locally"
if ! docker image inspect "$SCPD_REF" >/dev/null 2>&1; then
  [ "$SCPD_REF" = "scp:dev" ] && docker build -t scp:dev . || { echo "missing $SCPD_REF" >&2; exit 1; }
fi
docker image inspect "$RUNNER_IAC_REF" >/dev/null 2>&1 || docker build -t "$RUNNER_IAC_REF" apps/runner-iac
docker image inspect "$POSTGRES_REF" >/dev/null 2>&1 || docker pull "$POSTGRES_REF"

log "building @scp/airgap + a REAL signed bundle (ephemeral test cosign key)"
pnpm --filter @scp/airgap build >/dev/null
BUNDLE_OUT="${SCRATCH}/bundle-out"
node deploy/airgap/dist/build-bundle.js \
  --version "$BUNDLE_VERSION" --out-dir "$BUNDLE_OUT" \
  --scpd-ref "$SCPD_REF" --runner-iac-ref "$RUNNER_IAC_REF" --postgres-ref "$POSTGRES_REF"
TARBALL="$(find "$BUNDLE_OUT" -name "scp-bundle-${BUNDLE_VERSION}.tar.gz" | head -1)"
[ -n "$TARBALL" ] || { echo "bundle not produced" >&2; exit 1; }

log "extracting the bundle"
tar -xzf "$TARBALL" -C "$SCRATCH"
BUNDLE_DIR="$(find "$SCRATCH" -maxdepth 2 -name install.sh -type f | head -1 | xargs dirname)"
[ -n "$BUNDLE_DIR" ] || { echo "install.sh not found in extracted bundle" >&2; exit 1; }

log "creating a kind cluster with Calico (so NetworkPolicy is ACTUALLY enforced), default CNI disabled"
cat > "${SCRATCH}/kind-config.yaml" <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: "192.168.0.0/16"
EOF
kind create cluster --name "$CLUSTER_NAME" --config "${SCRATCH}/kind-config.yaml" --kubeconfig "$KUBECONFIG" --wait 60s || true
kubectl config use-context "kind-${CLUSTER_NAME}"
# Pin the context namespace: inside an ARC pod, an empty context namespace makes client-go fall back
# to the pod's SA namespace (github-runners), diverging from helm's `default`. See kind-drill.sh.
kubectl config set-context --current --namespace=default

log "installing Calico (vendored manifest if present, else the pinned upstream URL at cluster-build time)"
# NOTE: fetching the Calico manifest is a BUILD-TIME action of standing up the drill's cluster, not
# a runtime call by the product -- same category as `kind create cluster` pulling kindest/node. For
# a truly offline homelab runner, vendor calico.yaml under scripts/vendor/ and point
# AIRGAP_DRILL_CALICO_MANIFEST at it.
CALICO_MANIFEST="${AIRGAP_DRILL_CALICO_MANIFEST:-https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/calico.yaml}"
kubectl apply -f "$CALICO_MANIFEST"
log "waiting for Calico + CoreDNS to be ready"
kubectl -n kube-system rollout status daemonset/calico-node --timeout=180s
kubectl -n kube-system rollout status deployment/coredns --timeout=120s
kubectl wait --for=condition=Ready nodes --all --timeout=120s

log "preloading postgres:16 into the cluster (eval DB; the chart's eval-postgres template pins the literal tag, IfNotPresent — no registry/internet pull needed)"
kind load docker-image "$POSTGRES_REF" --name "$CLUSTER_NAME"

log "starting a local registry:2 (the air-gap customer-registry stand-in) and connecting it to kind's network"
docker rm -f "$REGISTRY_CONTAINER" 2>/dev/null || true
docker run -d --name "$REGISTRY_CONTAINER" -p "${REGISTRY_PORT}:5000" registry:2 >/dev/null
docker network connect kind "$REGISTRY_CONTAINER" 2>/dev/null || true
for i in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:${REGISTRY_PORT}/v2/" >/dev/null 2>&1 && break
  [ "$i" -eq 20 ] && { echo "local registry never came up" >&2; exit 1; }
  sleep 1
done
# The in-cluster nodes reach the registry by its container name on the shared 'kind' docker network.
REG_IN_CLUSTER="${REGISTRY_CONTAINER}:5000"

log "install.sh: cosign-verify -> retarget-push into the local registry -> helm install (NetworkPolicy on)"
# The chart's default-deny egress NetworkPolicy is on by default (networkPolicy.enabled=true). We
# pass the in-cluster registry ref so retargeted images resolve from inside the cluster.
(
  cd "$BUNDLE_DIR"
  # SCP_EXTRA_HELM_SET enables the eval in-cluster postgres (preloaded above via `kind load`), so
  # this drill is fully self-contained with no external DB and no internet image pulls. scpd +
  # runner-iac are retargeted+pushed to the local registry by install.sh; the eval postgres image
  # is the documented known-gap (chart pins the literal tag) that `kind load` covers here.
  # --pubkey: the EXTERNAL copy build-bundle.js wrote ALONGSIDE the tarball (BUNDLE_OUT/cosign.pub,
  # NOT the cosign.pub shipped INSIDE the bundle dir being verified) — install.sh (adversarial
  # review CRITICAL #1) refuses to run without an external key; using the same one build-bundle
  # wrote is this drill's stand-in for "the operator obtained it out-of-band".
  SCP_EXTRA_HELM_SET="postgres.evalInCluster.enabled=true" \
    ./install.sh --registry "${REG_IN_CLUSTER}/scp" --pubkey "${BUNDLE_OUT}/cosign.pub" \
      --mode helm --insecure-registry --release-name "$RELEASE_NAME"
)

# Capture the bootstrap admin one-time password by polling api logs (current + previous, accumulated).
# The api pod can restart once during startup on a loaded kind cluster, and the password is printed
# ONCE and never stored (apps/server/src/auth/local-auth.ts) — see scripts/kind-drill.sh. Captured
# here (right after install) and reused in the golden path below.
log "capturing the bootstrap admin one-time password by polling api logs"
CAPTURE_LOG="${SCRATCH}/airgap-api-capture.log"
: > "$CAPTURE_LOG"
PW=""
for _ in $(seq 1 90); do
  API_POD="$(kubectl get pods -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -n "$API_POD" ]; then
    kubectl logs "$API_POD" --tail=-1 2>/dev/null >> "$CAPTURE_LOG" || true
    kubectl logs "$API_POD" --previous --tail=-1 2>/dev/null >> "$CAPTURE_LOG" || true
    LINE="$(grep -i "one-time password" "$CAPTURE_LOG" | tail -n1 || true)"
    if [ -n "$LINE" ]; then
      PW="$(printf '%s' "$LINE" | sed -n 's/.*shown once): \([^"]*\).*/\1/p')"
      [ -n "$PW" ] && break
    fi
  fi
  sleep 2
done
[ -n "$PW" ] || { echo "FAIL: could not capture the bootstrap one-time password after polling api logs" >&2; tail -60 "$CAPTURE_LOG" >&2 || true; exit 1; }
log "captured bootstrap admin one-time password"

log "waiting for all pods Ready under the enforced default-deny egress policy"
kubectl wait --for=condition=Ready pods -l app.kubernetes.io/name=commanderscp --all --timeout=240s || {
  echo "pods did not become Ready:" >&2; kubectl get pods -A; exit 1;
}

# ---- THE GENUINE ZERO-EGRESS ASSERTION -------------------------------------------------------
log "SECURITY: launching a deliberate-egress-attempt pod covered by the chart's default-deny egress policy"
# Same pod labels the chart's default-deny NetworkPolicy selects (commanderscp name+instance), so
# Calico applies the default-deny egress rule to it. It tries to open a TCP connection to a PUBLIC
# IP on THREE ports: 443 (nothing allows this -- the general "no arbitrary internet egress" case),
# and 5432 / 4222 (the exact Postgres/NATS ports MAJOR #2's adversarial-review finding named: the
# chart's allow-postgres/allow-nats rules, when networkPolicy.postgresCidr/natsCidr are left
# UNSET, used to render NO `to:` at all -- Kubernetes NetworkPolicy semantics for an egress rule
# with a port but no `to:` is "any destination", so a pod could reach the public internet on the
# DB port even under an otherwise-enforced default-deny policy). Testing only port 443 would NOT
# have caught that hole -- it was never allow-listed at all, so it was already blocked before the
# fix. Under a genuinely-enforced default-deny + the MAJOR #2 fix, ALL THREE must fail (timeout/
# refused). If ANY of them SUCCEEDS, the egress block is not real (or the private-range default
# regressed) and the drill FAILS.
cat > "${SCRATCH}/egress-probe.yaml" <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: egress-probe
  labels:
    app.kubernetes.io/name: commanderscp
    app.kubernetes.io/instance: ${RELEASE_NAME}
spec:
  restartPolicy: Never
  containers:
    - name: probe
      image: ${REG_IN_CLUSTER}/scp/scpd:${BUNDLE_VERSION}
      command: ["node", "-e", "const net=require('node:net');const ports=[443,5432,4222];let remaining=ports.length;for(const port of ports){const s=net.createConnection({host:'1.1.1.1',port,timeout:8000},()=>{console.log('EGRESS_REACHED:'+port);s.destroy();if(--remaining===0)process.exit(0)});s.on('timeout',()=>{console.log('EGRESS_BLOCKED_TIMEOUT:'+port);s.destroy();if(--remaining===0)process.exit(0)});s.on('error',e=>{console.log('EGRESS_BLOCKED_'+e.code+':'+port);if(--remaining===0)process.exit(0)})}"]
EOF
kubectl apply -f "${SCRATCH}/egress-probe.yaml"
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/egress-probe --timeout=30s 2>/dev/null \
  || kubectl wait --for=jsonpath='{.status.phase}'=Failed pod/egress-probe --timeout=30s 2>/dev/null || true
PROBE_OUT="$(kubectl logs egress-probe 2>/dev/null || true)"
log "egress-probe result: ${PROBE_OUT:-<no output>}"
if printf '%s' "$PROBE_OUT" | grep -q "EGRESS_REACHED"; then
  echo "FAIL: a pod under the default-deny egress policy REACHED the public internet (1.1.1.1) on at least one probed port -- egress is NOT genuinely blocked:" >&2
  printf '%s\n' "$PROBE_OUT" | grep "EGRESS_REACHED" >&2
  exit 1
fi
for port in 443 5432 4222; do
  printf '%s' "$PROBE_OUT" | grep -q "EGRESS_BLOCKED.*:${port}$" || {
    echo "FAIL: egress-probe produced no conclusive BLOCKED result for port ${port} (expected EGRESS_BLOCKED_*:${port}): ${PROBE_OUT}" >&2
    exit 1
  }
done
log "PASS: deliberate egress attempts on ports 443, 5432 (Postgres), and 4222 (NATS) were ALL BLOCKED by the enforced default-deny NetworkPolicy"

# ---- GOLDEN PATH under the same enforced policy ----------------------------------------------
log "golden path (register a service) -- must still work with only the chart's explicit in-cluster allows"
kubectl port-forward "svc/${RELEASE_NAME}-commanderscp-api" 18095:80 >/tmp/airgap-drill-pf.log 2>&1 &
PF_PID=$!
sleep 3
BASE_URL="http://127.0.0.1:18095"
for i in $(seq 1 30); do curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1 && break; sleep 1; done
# PW was captured earlier (right after install.sh) via the restart-robust poll — reuse it here.
TOKEN="$(curl -fsS -X POST "${BASE_URL}/api/v1/auth/login" -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"${PW}\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] || { echo "FAIL: login returned no token" >&2; exit 1; }
CREATE="$(curl -fsS -X POST "${BASE_URL}/api/v1/services" -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' -d '{"name":"airgap-drill-service"}')"
printf '%s' "$CREATE" | grep -q '"airgap-drill-service"' || { echo "FAIL: golden path service registration failed: $CREATE" >&2; exit 1; }
log "PASS: golden path succeeded under the enforced zero-egress policy"

log "M8 air-gap zero-egress drill: ALL CHECKS PASSED (bundle -> local registry -> Calico-enforced default-deny -> deliberate egress BLOCKED -> golden path OK)"
