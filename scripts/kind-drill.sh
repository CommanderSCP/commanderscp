#!/usr/bin/env bash
# M8 kind drill (BUILD_AND_TEST.md sec.8 M8 DoD): "helm install -> seeded golden path passes ->
# helm upgrade from the previous build with ZERO DOWNTIME (expand/contract proven -- old code runs
# on new schema during the roll) -> rollback". Runs on a local `kind` cluster -- no external
# registry, no network egress beyond what `docker build`/`pnpm install` already need.
#
# "The previous build" CANNOT be `main`: this milestone is where the Helm chart AND the migrations
# entrypoint (apps/server/src/migrate-bin.ts, run by the chart's migrations Job as `node
# dist/migrate-bin.js`) were BOTH first introduced -- an image built from `main` has no
# migrate-bin.js, so the (new) chart's migrations Job would fail against it. The honest "previous
# build" is therefore a commit ON THIS BRANCH that already has the chart + migrate-bin but predates
# this branch's NEWEST schema migration -- so the `helm upgrade` genuinely applies a real, new
# migration (apps/server/drizzle/0016_instance_keys_rls.sql) while the OLD-version pods keep
# serving, which is exactly the expand/contract "old code on new schema" property under test. The
# default baseline below is computed dynamically as the parent of whichever commit added the
# newest drizzle migration, so it stays correct as the branch grows; override with
# KIND_DRILL_BASELINE_REF if needed.
#
# What this proves, concretely:
#   1. `helm install` (old image) -> pods Ready -> golden path (login, register a service) over a
#      real port-forwarded HTTP client.
#   2. `helm upgrade` (new image, worker scaled up too) while an IN-CLUSTER poller pod hits the api
#      Service's /healthz by DNS every 500ms -- the upgrade must complete with ZERO non-200
#      responses observed. In-cluster and through the Service on purpose: a `kubectl port-forward`
#      pins to ONE pod and dies when the rollout replaces it, which reports downtime that the
#      Service never had. Old-version
#      pods keep serving throughout the rolling update window (maxUnavailable: 0), which is only
#      possible if the pre-upgrade migrations Job's schema change is forward-compatible with the
#      OLD code still running -- the actual expand/contract property, observed, not asserted.
#   3. The service registered in step 1 is still readable after the upgrade (data preserved).
#   4. `helm rollback` to the pre-upgrade revision succeeds.
#
# Requires: docker, kind, helm, kubectl, node (all already required elsewhere -- BUILD_AND_TEST.md
# sec.1). Never reaches the internet except what building the two images and `kind create cluster`
# (pulling the kindest/node base image, cached after first run) already need.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CLUSTER_NAME="${KIND_DRILL_CLUSTER_NAME:-scp-m8-kind-drill}"
RELEASE_NAME="scp"
OLD_IMAGE_TAG="kind-drill-old"
NEW_IMAGE_TAG="kind-drill-new"
# Default baseline: the parent of the commit that added the newest apps/server/drizzle/*.sql file
# on this branch -- i.e. the last state BEFORE this branch's newest schema migration, which still
# has the chart + migrate-bin (both landed earlier in the branch). Overridable.
default_baseline() {
  local newest_migration newest_commit
  newest_migration="$(git ls-files 'apps/server/drizzle/*.sql' | sort | tail -1)"
  newest_commit="$(git log -n1 --format=%H -- "$newest_migration")"
  git rev-parse "${newest_commit}^"
}
OLD_BASELINE_REF="${KIND_DRILL_BASELINE_REF:-$(default_baseline)}"
WORKTREE_DIR=""
PF_PID=""

# KUBECONFIG isolation: this drill can run inside an ARC runner POD that itself lives in a
# Kubernetes cluster (the homelab k3s), whose ambient in-cluster credentials + default namespace
# (`github-runners`) helm/kubectl would otherwise target instead of the kind cluster we create
# (confirmed via a workflow_dispatch spike: `helm install` hit `namespaces "github-runners" not
# found` against the fresh kind cluster). Point KUBECONFIG at a dedicated kind-only file and pin
# helm's namespace so every kubectl/helm call below targets ONLY the kind cluster's `default` ns.
KUBECONFIG="$(mktemp -d)/kind-drill.kubeconfig"
export KUBECONFIG
export HELM_NAMESPACE=default

log() { echo "==> $*"; }

cleanup() {
  local status=$?
  log "cleanup (exit code $status)"
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  # The zero-downtime witness is an in-cluster POD now, not a background shell job, so it is
  # deleted rather than killed — a failed run must not leave it polling in the cluster.
  kubectl delete pod "${WITNESS_POD:-kind-drill-witness}" --ignore-not-found --now >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ]; then
    echo "--- kind-drill.sh FAILED -- dumping cluster state ---"
    kubectl get pods -o wide 2>&1 || true
    kubectl describe pods 2>&1 | tail -200 || true
  fi
  helm uninstall "$RELEASE_NAME" >/dev/null 2>&1 || true
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  [ -n "$WORKTREE_DIR" ] && git worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

log "building the NEW image (this worktree's HEAD)"
docker build -t "scp:${NEW_IMAGE_TAG}" .

log "building the OLD image (${OLD_BASELINE_REF}) in a temporary worktree"
WORKTREE_DIR="$(mktemp -d)"
git fetch origin main --quiet 2>/dev/null || true
git worktree add --detach "$WORKTREE_DIR" "$OLD_BASELINE_REF" --quiet

# THE BASELINE'S APP CODE, BUT *TODAY'S* BUILD PLUMBING (Dockerfile + vendored-tool pins).
#
# What this drill is about is the APP: install an old version, upgrade to HEAD while a real
# migration applies under serving pods, roll back. The Dockerfile and the digest-pinned skopeo/
# cosign images are how the app gets built, not behaviour under test.
#
# Without this, the drill is unrunnable the moment a pinned digest stops resolving -- and a digest
# pin is immutable, not immortal: upstream re-pushes a tag, the registry garbage-collects the
# digests the old push pointed at, and EVERY historical commit becomes unbuildable at once. That
# is not a hypothetical. `quay.io/skopeo/stable@sha256:8b23fe43...` was GC'd and this drill failed
# every night from 2026-08-18 to 2026-08-29. Repinning HEAD alone does NOT fix it: the baseline is
# a HISTORICAL commit, which still carries the dead pin, so the old-image build keeps failing --
# and it never self-heals, because the baseline is chosen relative to the newest migration and so
# stays behind the repair indefinitely.
#
# Copying the plumbing forward keeps the drill testing what it claims to test. The old image is
# "the baseline's application, built the way we build today" -- which is what an upgrade drill
# wants anyway; it was never a byte-reproduction of a past release (it builds from source, not
# from a published artifact).
cp Dockerfile "$WORKTREE_DIR/Dockerfile"
rm -rf "$WORKTREE_DIR/tools/skopeo" "$WORKTREE_DIR/tools/cosign"
mkdir -p "$WORKTREE_DIR/tools"
cp -R tools/skopeo tools/cosign "$WORKTREE_DIR/tools/"

docker build -t "scp:${OLD_IMAGE_TAG}" "$WORKTREE_DIR"

log "creating kind cluster '${CLUSTER_NAME}'"
kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" --wait 120s

log "loading both images into kind"
kind load docker-image "scp:${OLD_IMAGE_TAG}" --name "$CLUSTER_NAME"
kind load docker-image "scp:${NEW_IMAGE_TAG}" --name "$CLUSTER_NAME"

kubectl config use-context "kind-${CLUSTER_NAME}"
# Pin the context namespace to `default` explicitly. Inside an ARC runner POD, a kubeconfig context
# with NO namespace makes client-go fall back to the pod's own service-account namespace
# (`github-runners`, from /var/run/secrets/.../namespace) — so kubectl would query that namespace
# while helm (HELM_NAMESPACE=default, above) installs into `default`. Without this, `kubectl wait
# pods --all` returns "no matching resources found" against the wrong namespace (confirmed in the
# spike). Harmless on a workstation (namespace is `default` there anyway).
kubectl config set-context --current --namespace=default

# SINGLE api replica for the install (api.replicaCount=1 + hpa disabled): the golden path
# extracts the bootstrap admin's one-time password from the api pod's logs, and that line is
# printed exactly once -- by whichever replica wins the create race. With >1 replica (and pods that
# can restart on a loaded machine) the line can end up in a since-scrolled-off or restarted
# container's logs, making extraction racy. One replica makes it deterministic. The UPGRADE below
# still scales worker 1->2, so the rolling-update / zero-downtime property is exercised regardless.
log "helm install (OLD image, eval postgres, single api replica for a deterministic bootstrap log)"
helm install "$RELEASE_NAME" deploy/helm \
  --set image.repository=scp \
  --set image.tag="${OLD_IMAGE_TAG}" \
  --set image.pullPolicy=Never \
  --set postgres.evalInCluster.enabled=true \
  --set api.replicaCount=1 \
  --set api.hpa.enabled=false \
  --set worker.replicaCount=1 \
  --timeout 240s

# The bootstrap admin's one-time password is printed exactly ONCE, on the api's admin-CREATING boot,
# and is never stored (apps/server/src/auth/local-auth.ts). On a loaded kind cluster the api pod can
# restart once during startup, after which a plain `kubectl logs` shows only "admin already exists,
# skipping" and even `--previous` can miss the first boot's logs. So we DON'T `--wait` on the install
# above; instead we poll the api logs from first boot (accumulating current + previous container
# logs) to capture the password reliably, and only THEN wait for full readiness.
log "capturing the bootstrap admin one-time password by polling api+worker logs from first boot"
CAPTURE_LOG="/tmp/kind-drill-api-capture.log"
: > "$CAPTURE_LOG"
ADMIN_PASSWORD=""
for _ in $(seq 1 90); do
  API_POD="$(kubectl get pods -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  # ALSO POLL THE WORKER. `main.ts` now creates the bootstrap admin only in the HTTP-serving role
  # (`createsBootstrapAdmin`), so on any CURRENT build the password is in the api's log by
  # construction. This drill, however, installs a HISTORICAL baseline first — and every baseline
  # that predates that fix ran `ensureBootstrapAdmin` in EVERY process, so whichever of api/worker
  # won the race printed the one-and-only copy of the credential. Polling just the api made this
  # drill fail as "could not capture the bootstrap one-time password" whenever the worker won.
  # The baseline is chosen relative to the newest migration, so it stays behind the product fix for
  # as long as no new migration lands; reading both logs is what makes the drill work on both sides
  # of that fix instead of only on the near side.
  WORKER_POD="$(kubectl get pods -l app.kubernetes.io/component=worker -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  for POD in "$API_POD" "$WORKER_POD"; do
    [ -n "$POD" ] || continue
    kubectl logs "$POD" --tail=-1 2>/dev/null >> "$CAPTURE_LOG" || true
    kubectl logs "$POD" --previous --tail=-1 2>/dev/null >> "$CAPTURE_LOG" || true
  done
  # Extraction is NOT gated on the api pod existing: the accumulated log may hold the line from the
  # worker (a pre-fix baseline where the worker won the race), and gating on $API_POD would collect
  # that line and then decline to read it.
  LINE="$(grep -i "one-time password" "$CAPTURE_LOG" | tail -n1 || true)"
  if [ -n "$LINE" ]; then
    ADMIN_PASSWORD="$(printf '%s' "$LINE" | sed -n 's/.*shown once): \([^"]*\).*/\1/p')"
    [ -n "$ADMIN_PASSWORD" ] && break
  fi
  sleep 2
done
if [ -z "$ADMIN_PASSWORD" ]; then
  echo "FAIL: could not capture the bootstrap one-time password after polling api+worker logs" >&2
  echo "--- accumulated api logs (tail) ---" >&2
  tail -60 "$CAPTURE_LOG" >&2 || true
  exit 1
fi
log "captured bootstrap admin one-time password"

log "waiting for all pods Ready"
kubectl wait --for=condition=Ready pods --all --timeout=180s

log "port-forwarding to the api Service"
kubectl port-forward "svc/${RELEASE_NAME}-commanderscp-api" 18090:80 >/tmp/kind-drill-pf.log 2>&1 &
PF_PID=$!
sleep 3

BASE_URL="http://127.0.0.1:18090"
for i in $(seq 1 30); do
  curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1 && break
  [ "$i" -eq 30 ] && { echo "api never became healthy" >&2; exit 1; }
  sleep 1
done

log "golden path: login as bootstrap admin (one-time password captured above), register a service"
LOGIN_RESPONSE="$(curl -fsS -X POST "${BASE_URL}/api/v1/auth/login" -H "content-type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PASSWORD}\"}")"
TOKEN="$(printf '%s' "$LOGIN_RESPONSE" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [ -z "$TOKEN" ]; then
  echo "FAIL: login did not return a token: $LOGIN_RESPONSE" >&2
  exit 1
fi

CREATE_RESPONSE="$(curl -fsS -X POST "${BASE_URL}/api/v1/services" \
  -H "authorization: Bearer ${TOKEN}" -H "content-type: application/json" \
  -d '{"name":"kind-drill-service"}')"
echo "$CREATE_RESPONSE" | grep -q '"kind-drill-service"' || { echo "FAIL: service registration failed: $CREATE_RESPONSE" >&2; exit 1; }
log "PASS: golden path -- registered 'kind-drill-service' against the OLD image"

# THE WITNESS RUNS INSIDE THE CLUSTER, THROUGH THE SERVICE — it cannot be a port-forward.
#
# `kubectl port-forward svc/X` does NOT load-balance: it resolves the Service once, PINS to a
# single backing pod, and tunnels to that pod. A rolling upgrade replaces exactly that pod, so the
# tunnel dies BY CONSTRUCTION — whether or not the Service ever stopped serving. The old witness
# therefore reported "zero-downtime violated" on every run: 35/35 observations were curl code 000
# (connection failure) and NOT ONE was an HTTP status, which is the signature of a dead tunnel
# rather than of an unavailable Service.
#
# Zero-downtime is a claim about what an in-cluster CONSUMER sees through the Service's load
# balancing, so that is where it has to be measured. This runs the poller in a pod that curls the
# api Service by DNS, exactly as any other workload would.
#
# The image is the already-loaded OLD scpd tag (Node 22 ⇒ global `fetch`), deliberately: the drill
# loads exactly one image into kind and pulls nothing else, so introducing a curl/busybox image
# here would add a registry dependency to a drill whose whole point is running without one.
log "starting the in-cluster zero-downtime witness (Service DNS, 500ms interval)"
WITNESS_POD="kind-drill-witness"
kubectl delete pod "$WITNESS_POD" --ignore-not-found --now >/dev/null 2>&1 || true
kubectl run "$WITNESS_POD" --restart=Never --image="scp:${OLD_IMAGE_TAG}" \
  --overrides='{"spec":{"containers":[{"name":"witness","image":"scp:'"${OLD_IMAGE_TAG}"'","imagePullPolicy":"Never","command":["node","-e","const u=process.env.U;let n=0;(async()=>{for(;;){try{const r=await fetch(u,{signal:AbortSignal.timeout(2000)});if(r.status!==200)console.log(`NON-200: ${r.status}`);}catch(e){console.log(`NON-200: 000 ${e.name}`);}await new Promise(r=>setTimeout(r,500));}})();"],"env":[{"name":"U","value":"http://'"${RELEASE_NAME}"'-commanderscp-api/healthz"}]}]}}' \
  >/dev/null
# Wait for the witness to be RUNNING before the upgrade starts, or it observes nothing and the
# drill passes vacuously — a witness that was never watching is worse than no witness.
for _ in $(seq 1 60); do
  [ "$(kubectl get pod "$WITNESS_POD" -o jsonpath='{.status.phase}' 2>/dev/null)" = "Running" ] && break
  sleep 1
done
[ "$(kubectl get pod "$WITNESS_POD" -o jsonpath='{.status.phase}' 2>/dev/null)" = "Running" ] \
  || { echo "FAIL: in-cluster witness never started — cannot observe the upgrade" >&2; exit 1; }

log "helm upgrade -> NEW image (worker scaled 1->3, exercising the rollingUpdate path)"
helm upgrade "$RELEASE_NAME" deploy/helm \
  --set image.repository=scp \
  --set image.tag="${NEW_IMAGE_TAG}" \
  --set image.pullPolicy=Never \
  --set postgres.evalInCluster.enabled=true \
  --set api.replicaCount=1 \
  --set api.hpa.enabled=false \
  --set worker.replicaCount=3 \
  --wait --timeout 240s

sleep 1
kubectl logs "$WITNESS_POD" > /tmp/kind-drill-health-poll.log 2>&1 || true
kubectl delete pod "$WITNESS_POD" --ignore-not-found --now >/dev/null 2>&1 || true
NON_200_COUNT="$(grep -c "NON-200" /tmp/kind-drill-health-poll.log || true)"
POLL_COUNT="$(wc -l < /tmp/kind-drill-health-poll.log | tr -d ' ')"
log "health poll during upgrade: ${POLL_COUNT} non-200 log lines (0 expected)"
if [ -n "$NON_200_COUNT" ] && [ "$NON_200_COUNT" -gt 0 ]; then
  echo "FAIL: zero-downtime violated -- ${NON_200_COUNT} non-200 response(s) observed during helm upgrade" >&2
  cat /tmp/kind-drill-health-poll.log >&2
  exit 1
fi
log "PASS: zero downtime observed during helm upgrade (old code served every request until new pods were ready)"

log "verifying data survived the upgrade (the service registered against the OLD image is still there)"
LIST_RESPONSE="$(curl -fsS "${BASE_URL}/api/v1/services" -H "authorization: Bearer ${TOKEN}")"
echo "$LIST_RESPONSE" | grep -q '"kind-drill-service"' || { echo "FAIL: data lost across upgrade: $LIST_RESPONSE" >&2; exit 1; }
log "PASS: data preserved across the upgrade"

log "verifying worker scaled to 3 (the upgrade's values change actually applied)"
WORKER_READY="$(kubectl get deployment "${RELEASE_NAME}-commanderscp-worker" -o jsonpath='{.status.readyReplicas}')"
[ "$WORKER_READY" = "3" ] || { echo "FAIL: expected 3 ready worker replicas, got ${WORKER_READY}" >&2; exit 1; }
log "PASS: worker scaled to 3 replicas"

log "helm rollback -> revision 1 (the OLD image + install-time replica counts: worker=1)"
helm rollback "$RELEASE_NAME" 1 --wait --timeout 180s
WORKER_READY_AFTER_ROLLBACK="$(kubectl get deployment "${RELEASE_NAME}-commanderscp-worker" -o jsonpath='{.status.readyReplicas}')"
[ "$WORKER_READY_AFTER_ROLLBACK" = "1" ] || { echo "FAIL: rollback did not restore worker replica count to install-time 1 (got ${WORKER_READY_AFTER_ROLLBACK})" >&2; exit 1; }
log "PASS: helm rollback succeeded"

log "M8 kind drill: ALL CHECKS PASSED (install -> golden path -> zero-downtime upgrade -> data preserved -> rollback)"
