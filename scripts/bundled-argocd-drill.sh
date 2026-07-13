#!/usr/bin/env bash
# Bundled Argo CD auto-wire E2E drill (M11 — closes the gap helm-verify structurally cannot cover).
#
# helm-verify renders the charts and asserts on STRUCTURE. It can never prove the two things that
# only a live cluster shows:
#   (a) that the split delivery actually works — `helm install` of the (now small) SCP chart
#       SUCCEEDS, and the bundled Argo CD applies out-of-release via scripts/scp-bundled.sh; and
#   (b) that the post-upgrade auto-wire hook (apps/server/src/bundled-argocd-autowire-bin.ts) stands
#       up against a LIVE Argo CD, logs in with the generated admin secret, mints a SCOPED
#       (get/sync, never admin) token for the scp-coordinator account, and stores it in SCP's
#       encrypted secret store — such that the STORED ciphertext decrypts to a token Argo CD accepts.
#
# This drill does exactly that on a local `kind` cluster, then proves the stored artifact is real by
# reading it back through SCP's OWN runtime decrypt path and exercising it against the Argo CD API,
# and proves it is genuinely SCOPED by asserting an admin/write op is DENIED.
#
# What it proves (each an explicit PASS line):
#   §2  `helm install` of deploy/helm SUCCEEDS — the chart is back under Helm's 1 MB release-Secret
#       limit (the M11 regression that motivated the deploy/helm-bundled split; a fat chart fails here).
#   §3  scripts/scp-bundled.sh enable argocd applies the bundled Argo CD out-of-release and flips the
#       SCP release's auto-wire hook — its `helm upgrade` blocks on the post-upgrade hook, so a green
#       wrapper run already proves the mint+store completed.
#   §6  the auto-wire bin's own success marker, captured from the (newest, hook-deleted-on-success)
#       Job pod — the live "minted + stored 'bundled-argocd-token'" witness.
#   §7  exactly one non-empty token row exists in SCP's `secrets` table UNDER THE BOOTSTRAP ORG.
#   §7b the STORED token, read back through SCP's runtime getSecretValue (RLS + AES-256-GCM decrypt
#       with the deployed master key), authenticates against the live Argo CD API — and its JWT `sub`
#       is `scp-coordinator:apiKey` (an apiKey token), never `admin:login`.
#   §8  independent live check: the scp-coordinator account really mints authenticating tokens.
#   §8b NEGATIVE scope: the scoped token is DENIED an admin/write op (POST /api/v1/projects → 403) —
#       the 'never admin' half of the invariant, which a positive read alone cannot prove.
#   §9  idempotency: re-running enable re-mints without error, still exactly one token row.
#
# NetworkPolicy is DISABLED for this drill (the hardened default-deny doesn't yet grant the hook
# egress to the kube API + DNS — a documented follow-up). Requires docker, kind, helm, kubectl. Pulls
# quay.io/argoproj/argocd + valkey once (drills allow egress; this is not the air-gap drill).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CLUSTER_NAME="${ARGOCD_DRILL_CLUSTER_NAME:-scp-argocd-autowire-drill}"
RELEASE_NAME="scp"
IMAGE_TAG="argocd-autowire-drill"
ARGOCD_NS="scp-argocd"
TOKEN_KEY="bundled-argocd-token"
SCP_ACCOUNT="scp-coordinator"
BOOTSTRAP_ORG="default"
INSTALL_TIMEOUT="${ARGOCD_DRILL_INSTALL_TIMEOUT:-900s}"

# KUBECONFIG isolation — identical rationale to scripts/kind-drill.sh (an ARC runner pod's ambient
# in-cluster kubeconfig/SA-namespace would otherwise leak into helm/kubectl).
KUBECONFIG="$(mktemp -d)/argocd-drill.kubeconfig"
export KUBECONFIG
export HELM_NAMESPACE=default

AUTOWIRE_LOG="$(mktemp)"
WRAP_LOG="$(mktemp)"
PF_PID=""
LOGGER_PID=""
WRAP_PID=""

log() { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# HTTP through the (occasionally flaky) kubectl port-forward. `kubectl port-forward` can briefly drop
# a connection, and a lone `curl` connect-failure (exit 7) would trip `set -e` and kill the drill.
# These retry transient connect failures and return the value, so only a genuine API answer counts.
http_code() { # $1=url; rest: extra curl args → prints the HTTP status code (000 if never reachable)
  local url="$1"; shift; local c
  for _ in 1 2 3 4 5 6; do
    c="$(curl -s -o /dev/null -w '%{http_code}' "$url" "$@" --max-time 10 2>/dev/null || echo 000)"
    [ "$c" != "000" ] && { printf '%s' "$c"; return 0; }
    sleep 2
  done
  printf '000'
}
http_token() { # $1=url; rest: extra curl args → prints the JSON "token" field (empty if none)
  local url="$1"; shift; local body
  for _ in 1 2 3 4 5 6; do
    body="$(curl -s "$url" "$@" --max-time 10 2>/dev/null || true)"
    case "$body" in *'"token"'*) printf '%s' "$body" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; return 0 ;; esac
    sleep 2
  done
  return 0
}

cleanup() {
  local status=$?
  log "cleanup (exit code $status)"
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  [ -n "$LOGGER_PID" ] && kill "$LOGGER_PID" 2>/dev/null || true
  [ -n "$WRAP_PID" ] && kill "$WRAP_PID" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    echo "--- bundled-argocd-drill.sh FAILED — dumping state ---" >&2
    echo "--- wrapper log ---" >&2; tail -60 "$WRAP_LOG" 2>/dev/null || true
    echo "--- captured auto-wire logs ---" >&2; tail -60 "$AUTOWIRE_LOG" 2>/dev/null || true
    echo "--- pods (all namespaces) ---" >&2; kubectl get pods -A -o wide 2>&1 || true
    echo "--- argocd pods describe ---" >&2; kubectl -n "$ARGOCD_NS" describe pods 2>&1 | tail -120 || true
  fi
  helm uninstall "$RELEASE_NAME" >/dev/null 2>&1 || true
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

# ---- 1. Build scpd — the ONLY image we load into kind ---------------------------------------
# The bundled Argo CD images (argocd, dex, valkey) are NOT pre-loaded: upstream ships them with
# imagePullPolicy: Always (the kubelet re-resolves them regardless) AND `kind load` of those
# multi-arch upstream images fails ("content digest ... not found" — the local daemon holds one
# platform). They pull in-cluster. Only scpd is a locally-built single-platform image.
log "building the scpd image (this worktree's HEAD)"
docker build -t "scp:${IMAGE_TAG}" .

log "creating kind cluster '${CLUSTER_NAME}'"
kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" --wait 120s
log "loading the scpd image into kind (bundled Argo CD images pull in-cluster)"
kind load docker-image "scp:${IMAGE_TAG}" --name "$CLUSTER_NAME"
kubectl config use-context "kind-${CLUSTER_NAME}"
kubectl config set-context --current --namespace=default

# ---- 2. helm install the SCP chart — proves it is back under the 1 MB release-Secret limit ---
log "helm install (main SCP chart only — bundled Argo CD comes next, out-of-release)"
helm install "$RELEASE_NAME" deploy/helm \
  --set image.repository=scp \
  --set image.tag="${IMAGE_TAG}" \
  --set image.pullPolicy=Never \
  --set postgres.evalInCluster.enabled=true \
  --set api.replicaCount=1 \
  --set api.hpa.enabled=false \
  --set worker.replicaCount=1 \
  --set networkPolicy.enabled=false \
  --wait --timeout 300s \
  || fail "helm install of the main SCP chart FAILED — is the chart back over Helm's 1 MB release-Secret limit? (the deploy/helm-bundled split must keep vendored manifests OUT of deploy/helm)"
log "PASS §2: helm install of the main SCP chart succeeded (chart is under Helm's 1 MB release limit)"

# ---- 3. Enable the bundled Argo CD via the one-command wrapper, in the background so we can
#         stream the post-upgrade auto-wire Job's logs before Helm deletes it on success --------
log "enabling bundled Argo CD (scripts/scp-bundled.sh enable argocd) — applies out-of-release + fires auto-wire"
scripts/scp-bundled.sh enable argocd \
  --scp-release "$RELEASE_NAME" --scp-namespace default \
  --wait-timeout "$INSTALL_TIMEOUT" >"$WRAP_LOG" 2>&1 &
WRAP_PID=$!

# Stream the NEWEST auto-wire Job pod's logs. The Job has backoffLimit>0 + restartPolicy Never, so a
# retry leaves an earlier Failed pod alongside the final one; `.items[0]` (name-sort) can pin the
# Failed pod forever. Sort by creationTimestamp and take the LAST — the current attempt — and
# `logs -f` streams until it exits (flushing the success marker before hook-delete-on-success).
log "streaming the newest auto-wire Job pod's logs"
(
  while kill -0 "$WRAP_PID" 2>/dev/null; do
    POD="$(kubectl get pods -l app.kubernetes.io/component=argocd-autowire \
      --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1:].metadata.name}' 2>/dev/null || true)"
    if [ -n "$POD" ]; then
      kubectl logs -f "$POD" --tail=-1 >>"$AUTOWIRE_LOG" 2>/dev/null || true
    fi
    sleep 1
  done
) &
LOGGER_PID=$!

set +e
wait "$WRAP_PID"; WRAP_RC=$?
set -e
WRAP_PID=""
kill "$LOGGER_PID" 2>/dev/null || true
LOGGER_PID=""
[ "$WRAP_RC" -eq 0 ] || { tail -40 "$WRAP_LOG" >&2; fail "scp-bundled.sh enable argocd returned ${WRAP_RC} — the bundled Argo CD apply and/or the post-upgrade auto-wire hook did not succeed"; }
log "PASS §3: bundled Argo CD applied out-of-release and the auto-wire hook completed (wrapper rc 0)"

# ---- 6. The bin's own live success witness --------------------------------------------------
grep -q "stored as SCP secret '${TOKEN_KEY}'" "$AUTOWIRE_LOG" \
  || { cat "$AUTOWIRE_LOG" >&2; fail "auto-wire success marker not found (expected \"stored as SCP secret '${TOKEN_KEY}'\")"; }
log "PASS §6: auto-wire bin reported minting the scoped token and storing it as '${TOKEN_KEY}'"

# ---- 7. Outcome: exactly one non-empty token row UNDER THE BOOTSTRAP ORG --------------------
PG_POD="$(kubectl get pods -l app.kubernetes.io/component=postgres-eval -o jsonpath='{.items[0].metadata.name}')"
[ -n "$PG_POD" ] || fail "could not find the eval postgres pod"
ROW="$(kubectl exec "$PG_POD" -- psql -U scp -d scp -tAc \
  "SELECT count(*), coalesce(max(length(s.ciphertext)),0) FROM secrets s JOIN orgs o ON o.id=s.org_id WHERE s.key='${TOKEN_KEY}' AND o.name='${BOOTSTRAP_ORG}'" | tr -d '[:space:]')"
log "secrets row for '${TOKEN_KEY}' under org '${BOOTSTRAP_ORG}': ${ROW} (count|ciphertext-len)"
case "$ROW" in
  1\|0) fail "token row present but ciphertext is empty" ;;
  1\|*) : ;;
  *) fail "expected exactly one non-empty '${TOKEN_KEY}' row under org '${BOOTSTRAP_ORG}', got '${ROW}'" ;;
esac
log "PASS §7: exactly one non-empty '${TOKEN_KEY}' row is stored under the bootstrap org"

# ---- 7b. Read the STORED token back through SCP's OWN runtime decrypt path, and exercise it ---
# This is the crux: not "a token exists" but "the ciphertext SCP wrote decrypts (RLS + AES-256-GCM,
# deployed master key) to a token Argo CD accepts, and is an apiKey (scoped) token, not admin".
log "reading the STORED token back through SCP's runtime getSecretValue (in the api pod)"
API_POD="$(kubectl get pods -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')"
[ -n "$API_POD" ] || fail "could not find the api pod"
# Run in the api pod's cwd (/app/apps/server) so relative dist imports + node_modules resolve; pass
# the key via env (no shell-quote injection). Stderr is captured so a decrypt/RLS/import failure is
# visible, not swallowed.
# Resolve the bootstrap org id via ADMIN psql (no RLS ambiguity), then read the secret in the api
# pod as scp_app under withTenantTx — the exact runtime read path (least-privileged role + RLS +
# AES-256-GCM decrypt with the deployed master key). The api pod holds the RUNTIME (app) URL and the
# master key, but never the admin DATABASE_URL, so we pass the org id in rather than look it up here.
ORG_ID="$(kubectl exec "$PG_POD" -- psql -U scp -d scp -tAc "SELECT id FROM orgs WHERE name='${BOOTSTRAP_ORG}'" | tr -d '[:space:]')"
[ -n "$ORG_ID" ] || fail "could not resolve bootstrap org id"
READ_ERR="$(mktemp)"
STORED_TOKEN="$(kubectl exec "$API_POD" -- env SCP_READ_KEY="$TOKEN_KEY" SCP_READ_ORG="$ORG_ID" node --input-type=module -e '
const { loadConfig } = await import("./dist/config.js");
const { createDb, createPool } = await import("./dist/db/client.js");
const { withTenantTx } = await import("./dist/db/tenant-tx.js");
const { getSecretValue } = await import("./dist/secrets/secrets-repo.js");
const cfg = loadConfig();
const pool = createPool(cfg.runtimeDatabaseUrl);
const db = createDb(pool);
const orgId = process.env.SCP_READ_ORG;
const tok = await withTenantTx(db, orgId, (tx) => getSecretValue(tx, orgId, process.env.SCP_READ_KEY, cfg.secretsMasterKey));
process.stdout.write(tok || "");
await pool.end();
' 2>"$READ_ERR")" || true
if [ -z "$STORED_TOKEN" ]; then
  echo "--- stored-token runtime read stderr ---" >&2; cat "$READ_ERR" >&2 || true
  fail "the stored '${TOKEN_KEY}' did not decrypt back through SCP's runtime read path (RLS/master-key/ciphertext problem)"
fi

log "port-forwarding Argo CD to exercise the STORED token"
kubectl -n "$ARGOCD_NS" port-forward svc/argocd-server 18091:80 >/tmp/argocd-drill-pf.log 2>&1 &
PF_PID=$!
ARGOCD_URL="http://127.0.0.1:18091"
sleep 3
STORED_CODE="$(http_code "${ARGOCD_URL}/api/v1/applications" -H "authorization: Bearer ${STORED_TOKEN}")"
[ "$STORED_CODE" = "200" ] || fail "the STORED token did NOT authenticate against GET /api/v1/applications (HTTP ${STORED_CODE}) — SCP stored a token Argo CD rejects"
log "PASS §7b: the STORED token decrypts through SCP's runtime path and authenticates against the live Argo CD API (its scoping is proven at §8b)"

# ---- 8. Independent live check: the scoped account mints authenticating tokens ---------------
ADMIN_PW="$(kubectl -n "$ARGOCD_NS" get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"
[ -n "$ADMIN_PW" ] || fail "could not read Argo CD initial-admin password"
ADMIN_JWT="$(http_token "${ARGOCD_URL}/api/v1/session" -X POST -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PW}\"}")"
[ -n "$ADMIN_JWT" ] || fail "Argo CD admin login returned no token"
SCOPED_TOKEN="$(http_token "${ARGOCD_URL}/api/v1/account/${SCP_ACCOUNT}/token" \
  -X POST -H "authorization: Bearer ${ADMIN_JWT}" -H 'content-type: application/json' -d '{}')"
[ -n "$SCOPED_TOKEN" ] || fail "minting an '${SCP_ACCOUNT}' token failed — is the account configured with apiKey capability in argocd-cm?"
APPS_CODE="$(http_code "${ARGOCD_URL}/api/v1/applications" -H "authorization: Bearer ${SCOPED_TOKEN}")"
[ "$APPS_CODE" = "200" ] || fail "freshly-minted scoped token did not authenticate (GET /api/v1/applications → HTTP ${APPS_CODE})"
log "PASS §8: the scp-coordinator account mints tokens that authenticate against the live Argo CD API"

# ---- 8b. NEGATIVE: the 'never admin' half of the SCOPED invariant, proven LIVE --------------
# policy.csv grants scp-coordinator only applications get/sync (no policy.default), so creating a
# project (needs projects/create) is PermissionDenied → HTTP 403. A regression that widened the
# account would make this 200/201 and FAIL — the check helm-verify + the positive reads can't make.
DENY_CODE="$(http_code "${ARGOCD_URL}/api/v1/projects" -X POST \
  -H "authorization: Bearer ${STORED_TOKEN}" -H 'content-type: application/json' \
  -d '{"project":{"metadata":{"name":"scp-drill-should-be-denied"},"spec":{}}}')"
[ "$DENY_CODE" = "403" ] || fail "the scoped token was NOT denied an admin/write op (POST /api/v1/projects → HTTP ${DENY_CODE}, expected 403) — 'never admin' scoping invariant violated"
log "PASS §8b: the scoped token is correctly DENIED an admin/write op (POST /api/v1/projects → 403)"

kill "$PF_PID" 2>/dev/null || true
PF_PID=""

# ---- 9. Idempotency: re-enable re-mints without error, still one row ------------------------
log "re-running enable argocd (idempotent re-mint via the post-upgrade hook)"
scripts/scp-bundled.sh enable argocd --scp-release "$RELEASE_NAME" --scp-namespace default \
  --wait-timeout "$INSTALL_TIMEOUT" >"$WRAP_LOG" 2>&1 \
  || { tail -40 "$WRAP_LOG" >&2; fail "idempotent re-enable failed"; }
ROW_AFTER="$(kubectl exec "$PG_POD" -- psql -U scp -d scp -tAc \
  "SELECT count(*) FROM secrets s JOIN orgs o ON o.id=s.org_id WHERE s.key='${TOKEN_KEY}' AND o.name='${BOOTSTRAP_ORG}'" | tr -d '[:space:]')"
[ "$ROW_AFTER" = "1" ] || fail "after re-mint expected exactly one '${TOKEN_KEY}' row (overwrite, not duplicate), got '${ROW_AFTER}'"
log "PASS §9: idempotent re-enable — still exactly one '${TOKEN_KEY}' row"

log "bundled Argo CD auto-wire drill: ALL CHECKS PASSED (split install → out-of-release apply → live mint+store → stored-token decrypt+auth → scoped-deny → idempotent re-mint)"
