# scp-runner-iac

The SEPARATE image the `scp-managed-iac` executor (`packages/plugins/managed-iac`) launches, one
ephemeral container per run (DESIGN.md §12 Mode 2, charter's Managed Execution Exception,
BUILD_AND_TEST.md §8 M7 item 3): pinned OpenTofu + a minimal shell run shim (`run.sh`), nothing
else. No Node app code lives here (docs/DESIGN.md §3) — the `scpd` image carries no IaC toolchain
at all; this is the only place `tofu` exists in the whole system.

Not an npm workspace package — a plain Docker build context.

```
docker build -t scp-runner-iac:dev apps/runner-iac
```

Interface: `docker create --network <mode> --name <name> --env-file <vaulted infra creds> [-e
PRIOR_STATE_FILE=...] scp-runner-iac <plan|apply|rollback>` then `docker cp <workspace-dir>/.
<container>:/workspace`, `docker start -a`, `docker cp <container>:/workspace <workspace-dir>`,
`docker rm -f` — see `run.sh`'s own doc comment for the full per-action contract (evidence files
written back into `/workspace`, state-history snapshots, `PRIOR_STATE_FILE` for rollback). NEVER a
bind mount (`-v`) and never a bare `-e` for the credential: the workspace is copied in and out by
`@scp/runner-launcher`, the one place every managed runner is launched (M23.1), and the credential
travels through a mode-0600 `--env-file` unlinked the instant `create` returns, not the argv.
