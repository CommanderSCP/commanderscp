#!/usr/bin/env bash
# Compose-stack Playwright E2E (BUILD_AND_TEST.md §8 M2 item 5 DoD (a), §4.4 "also a
# `pnpm --filter @scp/web test:e2e` local target against the dev server" — THIS is the other half,
# the compose-stack target): builds the workspace (incl. the CLI binary and the Web UI SPA),
# builds+boots the two-container eval compose stack (`SCP_SEED_DEMO=true` by default — DESIGN.md
# §5.3), waits for health AND for the demo seed to actually land, then runs apps/web's Playwright
# suite against the ALREADY-RUNNING stack (`PLAYWRIGHT_BASE_URL`) instead of letting it bootstrap
# its own Testcontainers server (apps/web/e2e/global-setup.ts's compose-stack mode). Every spec
# under apps/web/e2e runs in this mode, including the ones written for the local target (they work
# unmodified against the seeded stack's admin login) plus apps/web/e2e/seeded-demo.spec.ts, which
# only runs here.
#
# Structure/style mirrors scripts/e2e-m0.sh closely (same build -> compose up -> wait-healthy ->
# extract bootstrap password -> trap-cleanup-with-log-dump pattern).
#
# Never touches the internet beyond what `docker build`/`pnpm install` already needed.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="deploy/compose/docker-compose.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
BASE_URL="http://localhost:8080"

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- e2e-web.sh FAILED (exit $status) — dumping 'scp' service logs ---"
    "${COMPOSE[@]}" logs scp || true
  fi
  echo "--- tearing down compose stack ---"
  "${COMPOSE[@]}" down -v --remove-orphans || true
  exit "$status"
}
trap cleanup EXIT

echo "==> ensuring the workspace (incl. @scp/cli and the @scp/web SPA) is built"
pnpm build
pnpm --filter @scp/web build

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
if [ -z "$BOOTSTRAP_LOG_LINE" ]; then
  echo "could not find the bootstrap admin log line" >&2
  exit 1
fi
# Logs are pino JSON prefixed by the compose service label (e.g. "scp-1  | {...}"); parse the
# JSON properly rather than string-slicing the raw line (which still has the "}" JSON tail).
ADMIN_PASSWORD="$(node -e '
  const line = process.argv[1];
  const jsonStart = line.indexOf("{");
  const record = JSON.parse(line.slice(jsonStart));
  const match = /shown once\): (\S+)/.exec(record.msg);
  if (!match) process.exit(1);
  console.log(match[1]);
' "$BOOTSTRAP_LOG_LINE")"
if [ -z "$ADMIN_PASSWORD" ]; then
  echo "could not parse the bootstrap admin password out of: $BOOTSTRAP_LOG_LINE" >&2
  exit 1
fi
echo "bootstrap admin password extracted (redacted)"

# config.ts's defaults ("default" org, "admin" username) — docker-compose.yml doesn't override
# SCP_BOOTSTRAP_ORG/SCP_BOOTSTRAP_ADMIN_USERNAME, so these are exactly what the compose stack
# actually bootstrapped (same assumption scripts/e2e-m0.sh's `--username admin` already makes).
ADMIN_USERNAME="admin"
ORG_NAME="default"

echo "==> logging in (to poll for the demo seed landing before starting Playwright)"
LOGIN_RESPONSE="$(curl -fsS -X POST "$BASE_URL/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}")"
TOKEN="$(node -e 'console.log(JSON.parse(process.argv[1]).token)' "$LOGIN_RESPONSE")"

echo "==> waiting for the demo seed (SCP_SEED_DEMO=true, seed.ts) to land"
for i in $(seq 1 30); do
  if curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/v1/objects/service" \
      | grep -q '"checkout"'; then
    echo "demo seed present (after ${i}s)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "demo seed did not land in time" >&2
    exit 1
  fi
  sleep 1
done

echo "==> running apps/web's Playwright suite (Chromium) against the compose stack"
export PLAYWRIGHT_BASE_URL="$BASE_URL"
export E2E_ORG_NAME="$ORG_NAME"
export E2E_ADMIN_USERNAME="$ADMIN_USERNAME"
export E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD"
pnpm --filter @scp/web test:e2e

echo "==> compose-stack Playwright e2e: ALL CHECKS PASSED"
