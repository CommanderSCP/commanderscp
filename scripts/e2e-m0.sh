#!/usr/bin/env bash
# M0 golden path (BUILD_AND_TEST.md §8 M0 definition of done): builds the image, brings up the
# two-container compose stack, waits for health, then drives the *real* CLI against it:
#   scp login -> scp object create service --name billing -> scp object list service
# and finally curls the UI stub page and asserts the object is listed there too.
#
# Never touches the internet beyond what `docker build`/`pnpm install` already needed.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="deploy/compose/docker-compose.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
BASE_URL="http://localhost:8080"
CLI_CONFIG_DIR="$(mktemp -d)"
CLI_BIN=(node "$ROOT_DIR/packages/cli/dist/bin.js")

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- e2e-m0.sh FAILED (exit $status) — dumping 'scp' service logs ---"
    "${COMPOSE[@]}" logs scp || true
  fi
  echo "--- tearing down compose stack ---"
  "${COMPOSE[@]}" down -v --remove-orphans || true
  rm -rf "$CLI_CONFIG_DIR"
  exit "$status"
}
trap cleanup EXIT

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

export SCP_CONFIG_DIR="$CLI_CONFIG_DIR"
export SCP_API_URL="$BASE_URL/api/v1"

echo "==> scp login"
"${CLI_BIN[@]}" login --username admin --password "$ADMIN_PASSWORD"

echo "==> scp object create service --name billing"
"${CLI_BIN[@]}" object create service --name billing

echo "==> scp object list service"
LIST_OUTPUT="$("${CLI_BIN[@]}" object list service --output json)"
echo "$LIST_OUTPUT"
if ! echo "$LIST_OUTPUT" | grep -q '"billing"'; then
  echo "FAIL: 'billing' not found in 'scp object list service' output" >&2
  exit 1
fi
echo "PASS: billing appears in 'scp object list service'"

echo "==> curling the UI stub page and asserting the object is listed"
TOKEN="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.SCP_CONFIG_DIR + '/credentials.json', 'utf8')).token)")"
UI_HTML="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/ui")"
if ! echo "$UI_HTML" | grep -q 'billing'; then
  echo "FAIL: 'billing' not found on the UI stub page" >&2
  echo "$UI_HTML" >&2
  exit 1
fi
echo "PASS: billing appears on the UI stub page"

echo "==> M0 golden path e2e: ALL CHECKS PASSED"
