# scp_clear_forced_password_change — shared by every scripts/e2e-*.sh and drill that logs in as
# the bootstrap admin and then needs past ensureBootstrapAdmin's mustChangePassword:true gate
# (#422 re-verify BLOCKING 0/2: a same-password "change" is refused server-side, and seed.ts's
# demo-seed path deliberately RE-ARMS the flag after it finishes — modeling that the operator's
# printed password must still go through a REAL forced change on their own real first login, the
# same as a non-demo install). Source this file, then call the function with a fresh, genuinely
# different, throwaway password — never the account's real one, and never re-used across scripts.
#
# Usage: scp_clear_forced_password_change <base_url> <bearer_token> <current_password>
#   base_url        e.g. "$BASE_URL/api/v1" or "${BASE_URL}" with /api/v1 already included —
#                   whatever this script's own login call already used for the host part; this
#                   function appends /auth/password itself, so pass the SAME root as your own
#                   /auth/login call, not a URL that already ends in /auth/login.
#   bearer_token    the token THIS script already holds (from its own prior /auth/login) — the
#                   session that makes the change stays alive afterward (changeLocalPassword's
#                   own current-session exemption), so the caller's later calls with the SAME
#                   token keep working with no further action.
#   current_password  what this script's own /auth/login call just used.
#
# Exits the calling script (via `exit 1`) on failure — a script that reaches this point already
# depends on the gate being clear, so a silent failure here would just surface as a confusing 403
# several steps later instead. Prints the FRESH password to stdout (only that, nothing else) — the
# account's password really did change, so a caller that logs in AGAIN later (e2e-web.sh's own
# Playwright run, driving a real browser login) must capture and use it instead of its own now-stale
# variable. A caller that only needs the CURRENT session's token (the common case — TOKEN keeps
# working with no further action) can simply not capture it.
scp_clear_forced_password_change() {
  local base_url="$1" token="$2" current_password="$3"
  local fresh
  fresh="e2e-$(head -c18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  local status
  status="$(curl -fsS -o /dev/null -w '%{http_code}' -X POST "${base_url%/}/auth/password" \
    -H "authorization: Bearer ${token}" -H 'content-type: application/json' \
    -d "{\"currentPassword\":\"${current_password}\",\"newPassword\":\"${fresh}\"}")"
  if [ "$status" != "204" ]; then
    echo "scp_clear_forced_password_change: POST /auth/password returned ${status} (expected 204)" >&2
    exit 1
  fi
  printf '%s' "$fresh"
}

# scp_clear_forced_password_change_via_cli — same purpose, for scripts that already log in through
# the real `scp` CLI binary (SCP_CONFIG_DIR/SCP_API_URL already exported by the caller) rather than
# raw curl. Uses the CLI's own `scp passwd` door (packages/cli/src/cli.ts) instead of a second HTTP
# implementation.
#
# Usage: scp_clear_forced_password_change_via_cli <cli_bin_array_name> <current_password>
#   cli_bin_array_name   the NAME (not the value — pass it unquoted, e.g. CLI_BIN) of an array
#                        variable holding the CLI invocation, e.g. CLI_BIN=(node dist/bin.js);
#                        SCP_CONFIG_DIR and SCP_API_URL must already be exported for this call,
#                        exactly as they were for the script's own prior `scp login`.
scp_clear_forced_password_change_via_cli() {
  local -n cli_bin_ref="$1"
  local current_password="$2"
  local fresh
  fresh="e2e-$(head -c18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  "${cli_bin_ref[@]}" passwd --current-password "$current_password" --new-password "$fresh"
}
