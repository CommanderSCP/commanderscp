# `scp-runner-ops`

The ephemeral image `scp-managed-ops` launches per run for **host-reaching** managed execution
(M27, charter Managed Execution Exception — 2026-07-12 host-reaching amendment).

Build: `docker build -t scp-runner-ops:dev apps/runner-ops`

## What this image may do

Exactly the three classes the charter enumerates, and nothing else:

1. OS package install, upgrade, and version pinning
2. Configuration file and template rendering and push
3. cron and systemd unit changes

Small IaC is **not** here — it stays with `scp-runner-iac`, which reaches cloud APIs under
`--network none` and holds no host credentials.

## The lockdown is deletion, not configuration (ADR-0050)

`allowlist.json` names every Ansible module, lookup plugin and action plugin this image is
permitted to contain, grouped by the charter class each belongs to. `prune.py` **deletes everything
else** at build time.

This is the actual security control. `ansible.cfg` ships beside it as defence in depth and is
explicitly _not_ the control: `ANSIBLE_CONFIG`, a working-directory `ansible.cfg` and per-play
settings all compete for what a play may load, and a run's working directory is not something this
image can guarantee. A plugin file that is not present cannot be loaded by any configuration an
attacker can reach.

ADR-0002 originally specified disabling six names (`pipe/command/shell/raw/script/uri`). Censusing
`ansible-core` 2.18.6 showed those six are a minority of the reachable paths:

- **`lines`** executes a shell command exactly as `pipe` does, and was not on the list.
- **`expect`, `pip`, `git`, `subversion`, `async_wrapper`** all reach code execution.
- **`include_vars` / `include_role` / `include_tasks` / `import_role` / `import_tasks` /
  `import_playbook`** turn tenant-influenced _data_ into _tasks_. A tenant who can steer one
  argument chooses what code runs — defeating "no shell module reachable" without touching a shell
  module.

Hence an allowlist derived from charter text rather than a blocklist of observed symptoms.

## Why two baselines, and why the gate is not tautological

`src/lockdown.integration.test.ts` in `@scp/plugin-managed-ops` asserts **two different things**:

1. **built image == `allowlist.json`**, in both directions — proves the deletion happened in the
   shipped artifact, not just in the Dockerfile's intent.
2. **`allowlist.json` ⊆ `upstream-inventory.json`** — the recorded surface of the pinned
   `ansible-core`. A version bump changes that file, and _that diff is the review_.

Comparing only (1) would prove the prune script ran and nothing more. Worse, a new upstream
code-execution module would be silently deleted by the prune and the gate would stay green — safe,
but never reviewed, which is precisely what ADR-0050 says must not happen.

## Bumping `ansible-core`

1. Change `ANSIBLE_CORE_VERSION` in the Dockerfile and `ansibleCore` in both JSON files.
2. Regenerate `upstream-inventory.json` from the new version.
3. **Read the diff.** Anything added is a new surface; decide whether it belongs to a charter class
   before adding it to `allowlist.json`. Anything removed that the allowlist names will fail the
   build in `prune.py`, loudly, rather than going missing at run time.

## Status

M27.1 ships the image and its gate. `run.sh` **refuses to run** anything: the catalog (M27.3),
unsafe-marked parameters (M27.2) and credential provisioning (M27.4 BYO / M27.5 SCP-CA) attach in
their own increments. The refusal is deliberate — an image built today cannot be wired up and
quietly do the wrong thing.

## The Argo path (M28.2, ADR-0054)

The same image runs as the `scp-ops-v1` Argo Workflows catalog template. There nothing SCP controls
can stage `/work/in`, so when `SCP_OPS_API_URL` is set `run.sh` first runs `redeem.py`: it unseals
`SCP_OPS_RUN_TOKEN_SEALED` with the key at `SCP_OPS_SEALING_KEY_FILE`, generates this run's ed25519
keypair, redeems the token once at `POST /api/v1/ops-run-redemptions`, and writes the same four files
Mode C's orchestrator stages (`inventory.ini`, `params.json`, `ssh-credential`, `role`). From there
the code path is identical. The role comes from the redemption; an `SCP_OPS_ROLE` in the pod's
environment is ignored on this path.
