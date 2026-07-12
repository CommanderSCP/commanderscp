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
#   2. `helm upgrade` (new image, worker scaled up too) while a background poller hits /healthz
#      every 500ms -- the upgrade must complete with ZERO non-200 responses observed. Old-version
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
POLL_PID=""

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
  [ -n "$POLL_PID" ] && kill "$POLL_PID" 2>/dev/null || true
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
  --wait --timeout 240s

log "waiting for all pods Ready"
kubectl wait --for=condition=Ready pods --all --timeout=120s

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

log "golden path: extract bootstrap admin password, login, register a service"
# `--tail=-1` (all lines) + a `--previous` fallback: robust against the api container having
# restarted after logging the one-time password (the line would then be in the previous
# container's logs, invisible to a plain `kubectl logs`). The `|| true` on each grep pipeline is
# load-bearing: this script runs under `set -euo pipefail`, and grep exiting 1 on no-match would
# otherwise (via pipefail) kill the whole script at the command substitution -- BEFORE the graceful
# "not found, try --previous / fail with a message" logic below ever runs.
API_POD="$(kubectl get pods -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')"
BOOTSTRAP_LOG_LINE="$(kubectl logs "$API_POD" --tail=-1 2>/dev/null | grep -i "one-time password" | tail -n1 || true)"
if [ -z "$BOOTSTRAP_LOG_LINE" ]; then
  BOOTSTRAP_LOG_LINE="$(kubectl logs "$API_POD" --previous --tail=-1 2>/dev/null | grep -i "one-time password" | tail -n1 || true)"
fi
if [ -z "$BOOTSTRAP_LOG_LINE" ]; then
  echo "could not find the bootstrap admin log line in ${API_POD} (current or previous container)" >&2
  echo "--- ${API_POD} current logs (tail) ---" >&2
  kubectl logs "$API_POD" --tail=40 2>&1 | tail -40 >&2 || true
  exit 1
fi
# Extract with grep/sed rather than inline `node -e "...()..."` inside $(...): the ancient
# system bash (3.2 on macOS) miscounts parens inside a double-quoted inline-node string within a
# command substitution, producing a spurious "syntax error near unexpected token '('". grep/sed
# is both portable to bash 3.2 and dependency-free. The pino log line is JSON; the password is
# printed as `...shown once): <PASSWORD>"` (the trailing `"` closes the JSON string).
ADMIN_PASSWORD="$(printf '%s' "$BOOTSTRAP_LOG_LINE" | sed -n 's/.*shown once): \([^"]*\).*/\1/p')"
if [ -z "$ADMIN_PASSWORD" ]; then
  echo "could not parse the one-time password out of: $BOOTSTRAP_LOG_LINE" >&2
  exit 1
fi

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

log "starting a background health poller (500ms interval) -- this is the zero-downtime witness"
(
  fails=0
  total=0
  while true; do
    total=$((total + 1))
    code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/healthz" --max-time 2 2>/dev/null || echo 000)"
    if [ "$code" != "200" ]; then
      fails=$((fails + 1))
      echo "$(date +%s.%N) NON-200: $code"
    fi
    sleep 0.5
  done
) >/tmp/kind-drill-health-poll.log 2>&1 &
POLL_PID=$!

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

kill "$POLL_PID" 2>/dev/null || true
sleep 1
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
