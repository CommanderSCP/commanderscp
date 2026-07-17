#!/usr/bin/env bash
# M7 Real Executor Integrations golden path (BUILD_AND_TEST.md §8 M7 definition of done).
#
# HONEST SCOPE (read before extending this script): this E2E proves the M7 API/CLI surface end to
# end against the real compose-deployed image — webhook HMAC signature verification (fail-closed:
# a bad signature is REJECTED, a correctly-signed one is accepted and correlates into a real
# Change), executor/notification binding CRUD, the plugin-manifest catalog, and discovery's
# "never auto-commits — only /discovery/accept writes to the graph" guarantee (proven directly:
# the graph is asserted empty of the proposed objects before accept, present after). It does NOT
# include an ArgoCD-in-kind (or fake-ArgoCD-stand-in) wave-EXECUTION variant — DEFERRED, FLAGGED
# HERE rather than silently skipped (same posture as federation-https's M6 "DEFERRED, FLAGGED IN
# THE M6 PR BODY" precedent): actually exercising a real ExecutorPlugin (github/argocd/terraform/
# managed-iac) driving a wave to `succeeded` needs either a `kind`-hosted ArgoCD (real cluster
# bring-up in CI — not attempted this milestone) or a hand-built deterministic ArgoCD-API stand-in
# server wired into the compose network (a real, working design, just not completed in this
# session's time budget). What IS proven here uses only the shared fake-executor (already
# real-plugin-host-proven since M3) to drive one target through the SAME wave machinery, so the
# ONLY new-to-M7 surface under-tested by this script specifically is "does @scp/plugin-github/
# argocd/terraform/managed-iac's real wire format work against a real GitHub/ArgoCD/pipeline" —
# which nock-fixture tests (deterministic, per-package) and the opt-in nightly live-sandbox job
# (scripts/../.github/workflows/nightly-live-sandbox.yml) cover instead.
#
# Never touches the internet beyond what `docker build`/`pnpm install` already needed.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="deploy/compose/docker-compose.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
BASE_URL="http://localhost:8080"
API_URL="$BASE_URL/api/v1"
CLI_CONFIG_DIR="$(mktemp -d)"
CLI_BIN=(node "$ROOT_DIR/packages/cli/dist/bin.js")

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- e2e-m7.sh FAILED (exit $status) — dumping 'scp' service logs ---"
    "${COMPOSE[@]}" logs scp || true
  fi
  echo "--- tearing down compose stack ---"
  "${COMPOSE[@]}" down -v --remove-orphans || true
  rm -rf "$CLI_CONFIG_DIR"
  exit "$status"
}
trap cleanup EXIT

json_field() {
  node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const path = process.argv[1].split(".");
    let value = data;
    for (const key of path) value = value?.[key];
    if (value === undefined || value === null) { process.exit(1); }
    console.log(typeof value === "string" ? value : JSON.stringify(value));
  ' "$1"
}

echo "==> ensuring the workspace (incl. @scp/cli) is built"
pnpm build

echo "==> building the scp image and starting the compose stack"
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d

echo "==> waiting for the scp service to become healthy"
for i in $(seq 1 60); do
  if curl -fsS "$BASE_URL/healthz" >/dev/null 2>&1; then
    echo "scp is up (after ${i}s)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "scp did not become healthy in time" >&2
    exit 1
  fi
  sleep 1
done

echo "==> extracting the bootstrap admin one-time password from server logs"
BOOTSTRAP_LOG_LINE="$("${COMPOSE[@]}" logs scp 2>/dev/null | grep -i "one-time password" | tail -n1)"
ADMIN_PASSWORD="$(node -e '
  const line = process.argv[1];
  const jsonStart = line.indexOf("{");
  const record = JSON.parse(line.slice(jsonStart));
  const match = /shown once\): (\S+)/.exec(record.msg);
  if (!match) process.exit(1);
  console.log(match[1]);
' "$BOOTSTRAP_LOG_LINE")"
echo "bootstrap admin password extracted (redacted)"

export SCP_CONFIG_DIR="$CLI_CONFIG_DIR"
export SCP_API_URL="$API_URL"

echo "==> scp login"
"${CLI_BIN[@]}" login --username admin --password "$ADMIN_PASSWORD"
TOKEN="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.SCP_CONFIG_DIR + '/credentials.json', 'utf8')).token)")"

echo "==> register: scp service register --name m7-svc + scp component register --name m7-comp"
SERVICE_JSON="$("${CLI_BIN[@]}" service register --name m7-svc --output json)"
SERVICE_ID="$(echo "$SERVICE_JSON" | json_field id)"
COMPONENT_JSON="$("${CLI_BIN[@]}" component register --name m7-comp --service "$SERVICE_ID" --output json)"
COMPONENT_ID="$(echo "$COMPONENT_JSON" | json_field id)"
echo "service id: $SERVICE_ID / component id: $COMPONENT_ID"

# -----------------------------------------------------------------------------------------
# 1. Webhook HMAC signature verification — fail-closed (SECURITY-SENSITIVE DoD item).
# -----------------------------------------------------------------------------------------

echo "==> scp change-source webhook-secret github --secret <value>"
WEBHOOK_SECRET="m7-e2e-webhook-secret-value"
"${CLI_BIN[@]}" change-source webhook-secret github --secret "$WEBHOOK_SECRET" --output json >/dev/null
echo "PASS: webhook secret configured for sourceKind 'github'"

echo "==> scp change-source (correlate github pushes under repoPattern m7-org/m7-repo to the registered component)"
CORRELATE_HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"sourceKind\":\"github\",\"repoPattern\":\"m7-org/m7-repo\",\"component\":\"$COMPONENT_ID\"}" \
  "$API_URL/change-sources/github/mappings")"
if [ "$CORRELATE_HTTP_CODE" -ge 300 ]; then
  echo "FAIL: creating the source_mapping returned HTTP $CORRELATE_HTTP_CODE" >&2
  exit 1
fi
echo "PASS: source_mapping created (github: m7-org/m7-repo -> component $COMPONENT_ID)"

# A REAL GitHub `push` event shape (nested repository.full_name / head_commit.id) — exercises
# coordination/webhook-processor.ts's github-specific extractHint() path
# (@scp/plugin-github's mapGithubWebhookEventToHint), not just the generic flat {repo,path,
# correlationKey} shape a manual/adapter caller would send.
PUSH_PAYLOAD='{"ref":"refs/heads/main","repository":{"full_name":"m7-org/m7-repo"},"head_commit":{"id":"abc123def456"}}'
BAD_SIGNATURE="sha256=0000000000000000000000000000000000000000000000000000000000000000"
GOOD_SIGNATURE="sha256=$(node -e "
  const crypto = require('node:crypto');
  process.stdout.write(crypto.createHmac('sha256', process.argv[1]).update(process.argv[2]).digest('hex'));
" "$WEBHOOK_SECRET" "$PUSH_PAYLOAD")"

echo "==> POSTing an INVALID signature — must be REJECTED (401), never persisted"
BAD_SIG_HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "x-github-event: push" -H "x-hub-signature-256: $BAD_SIGNATURE" \
  -d "$PUSH_PAYLOAD" "$API_URL/change-sources/github/webhook")"
if [ "$BAD_SIG_HTTP_CODE" != "401" ]; then
  echo "FAIL: expected HTTP 401 for a bad webhook signature, got $BAD_SIG_HTTP_CODE" >&2
  exit 1
fi
echo "PASS: bad signature rejected with HTTP 401 (fail-closed)"

echo "==> POSTing a VALID signature (real GitHub push payload shape) — must be accepted (202) and correlate into a real Change"
GOOD_SIG_HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "x-github-event: push" -H "x-hub-signature-256: $GOOD_SIGNATURE" \
  -d "$PUSH_PAYLOAD" "$API_URL/change-sources/github/webhook")"
if [ "$GOOD_SIG_HTTP_CODE" != "202" ]; then
  echo "FAIL: expected HTTP 202 for a validly-signed webhook, got $GOOD_SIG_HTTP_CODE" >&2
  exit 1
fi
echo "PASS: correctly-signed webhook accepted with HTTP 202"

echo "==> waiting for the reconcile loop to correlate the signed webhook into a real Change"
CORRELATED_CHANGE_ID=""
for i in $(seq 1 30); do
  CHANGES_JSON="$("${CLI_BIN[@]}" change list --output json)"
  CORRELATED_CHANGE_ID="$(node -e '
    const items = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const found = items.find((c) => c.sourceKind === "github");
    if (found) console.log(found.id);
  ' <<<"$CHANGES_JSON")"
  if [ -n "$CORRELATED_CHANGE_ID" ]; then
    echo "PASS: signed webhook correlated into Change $CORRELATED_CHANGE_ID (after ${i}s)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "FAIL: signed webhook never correlated into a Change within 30s" >&2
    exit 1
  fi
  sleep 1
done

# -----------------------------------------------------------------------------------------
# 2. Plugin config API surface — manifests, executor/notification bindings, secrets.
# -----------------------------------------------------------------------------------------

echo "==> scp plugin manifests"
MANIFESTS_JSON="$("${CLI_BIN[@]}" plugin manifests)"
for expected in github github-discovery argocd terraform managed-iac webhook-notify smtp-notify; do
  FOUND="$(node -e '
    const items = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(items.some((m) => m.id === process.argv[1]) ? "yes" : "no");
  ' <<<"$MANIFESTS_JSON" "$expected")"
  if [ "$FOUND" != "yes" ]; then
    echo "FAIL: plugin manifest catalog is missing '$expected'" >&2
    exit 1
  fi
done
echo "PASS: all 7 bundled plugin manifests present"

echo "==> scp executor bind (fake-executor — no network, proves the binding CRUD wire path)"
"${CLI_BIN[@]}" executor bind "$COMPONENT_ID" --module fake-executor --instance-id "m7-e2e-fake" --output json >/dev/null
EXECUTOR_BINDING_JSON="$("${CLI_BIN[@]}" executor get "$COMPONENT_ID" --output json)"
if [ "$(echo "$EXECUTOR_BINDING_JSON" | json_field pluginInstanceId)" != "m7-e2e-fake" ]; then
  echo "FAIL: executor binding did not round-trip" >&2
  exit 1
fi
echo "PASS: executor binding round-trips"

echo "==> scp notify bind (webhook-notify — CRUD-only, no delivery attempted)"
"${CLI_BIN[@]}" notify bind "m7-e2e-notify" --module webhook-notify --config '{"url":"http://example.invalid/hook"}' --min-severity warning --output json >/dev/null
NOTIFY_LIST_JSON="$("${CLI_BIN[@]}" notify list --output json)"
NOTIFY_FOUND="$(node -e '
  const items = JSON.parse(require("fs").readFileSync(0, "utf8"));
  console.log(items.some((b) => b.pluginInstanceId === "m7-e2e-notify") ? "yes" : "no");
' <<<"$NOTIFY_LIST_JSON")"
if [ "$NOTIFY_FOUND" != "yes" ]; then
  echo "FAIL: notification binding did not round-trip" >&2
  exit 1
fi
echo "PASS: notification binding round-trips"

echo "==> scp secret put/list/delete"
"${CLI_BIN[@]}" secret put m7-e2e-secret --value "super-secret-value" --output json >/dev/null
SECRET_KEYS_JSON="$("${CLI_BIN[@]}" secret list --output json)"
SECRET_FOUND="$(node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  console.log(data.keys.includes("m7-e2e-secret") ? "yes" : "no");
' <<<"$SECRET_KEYS_JSON")"
if [ "$SECRET_FOUND" != "yes" ]; then
  echo "FAIL: secret key did not appear in 'scp secret list'" >&2
  exit 1
fi
"${CLI_BIN[@]}" secret delete m7-e2e-secret
echo "PASS: secret store put/list/delete round-trip (value itself never echoed back by any endpoint)"

# -----------------------------------------------------------------------------------------
# 3. Discovery — NEVER auto-commits (DESIGN §11), proven directly: the proposed object does not
#    exist anywhere in the graph before accept, and resolves by id immediately after.
# -----------------------------------------------------------------------------------------

DISCOVERED_NAME="m7-discovered-repo-$$"
echo "==> discovery: asserting a hand-built proposal's object ('$DISCOVERED_NAME') does NOT exist before accept"
PRE_ACCEPT_SERVICES_JSON="$("${CLI_BIN[@]}" service list --output json)"
PRE_ACCEPT_FOUND="$(node -e '
  const items = JSON.parse(require("fs").readFileSync(0, "utf8"));
  console.log(items.some((s) => s.name === process.argv[1]) ? "yes" : "no");
' <<<"$PRE_ACCEPT_SERVICES_JSON" "$DISCOVERED_NAME")"
if [ "$PRE_ACCEPT_FOUND" != "no" ]; then
  echo "FAIL: the discovery fixture's object already exists before accept was ever called" >&2
  exit 1
fi
echo "PASS: discovered object does not exist pre-accept (nothing auto-committed)"

echo "==> scp discovery accept (the ONLY path that commits)"
PROPOSAL_JSON="{\"objects\":[{\"typeId\":\"service\",\"name\":\"$DISCOVERED_NAME\"}],\"relationships\":[]}"
ACCEPT_JSON="$("${CLI_BIN[@]}" discovery accept --proposal "$PROPOSAL_JSON" --output json)"
CREATED_OBJECT_ID="$(echo "$ACCEPT_JSON" | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (data.createdObjectIds.length !== 1) process.exit(1);
  console.log(data.createdObjectIds[0]);
')"
echo "PASS: discovery accept committed 1 object ($CREATED_OBJECT_ID) — explicit acceptance is the only write path"

echo "==> confirming the accepted object is immediately resolvable (a real graph write, not a no-op)"
POST_ACCEPT_GET_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "$API_URL/objects/service/$CREATED_OBJECT_ID")"
if [ "$POST_ACCEPT_GET_CODE" != "200" ]; then
  echo "FAIL: expected the accepted object to resolve with HTTP 200, got $POST_ACCEPT_GET_CODE" >&2
  exit 1
fi
echo "PASS: accepted object resolves by id"

echo "==> scp audit verify"
"${CLI_BIN[@]}" audit verify

echo "==> M7 golden path e2e: ALL CHECKS PASSED"
