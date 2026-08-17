# Container runtimes for managed execution — podman verification

**Status: verified 2026-08-16.** Podman **6.1.0**, rootless, runs every managed executor correctly.

CommanderSCP's managed executors (`scp-managed-iac`, `scp-managed-scan`, `scp-managed-dep`) shell
out to a container runtime binary. That binary is operator-governed, not tenant-suppliable, and is
selected by **`SCP_MANAGED_RUNNER_DOCKER_BINARY`** (default `"docker"`), injected server-side by
`managedRunnerDockerBinary()` in
[`apps/server/src/coordination/executor-bindings-repo.ts`](../apps/server/src/coordination/executor-bindings-repo.ts).

This document records what was actually measured, because "it should work" is not a deployment
posture for the regulated, air-gapped and FedRAMP/IL estates this matters for — largely RHEL, where a
Docker daemon is often disallowed and podman is the sanctioned runtime.

## Why this is worth having

Podman is **rootless and daemonless**. For the containment argument the charter's [Managed Execution
Exception](../PROJECT_CHARTER.md) rests on, that is strictly *better* than Docker: there is no
privileged long-lived daemon to reason about, and the runner's uid maps to an unprivileged host user
rather than to root. The exception's blast-radius claim gets stronger, not weaker, under podman.

## Scope — two separate questions, only one of which is answered here

| Question | Answered? |
|---|---|
| Podman as the **managed-runner runtime** (what the executors `execFile`) | **Yes — this document.** The one that matters for the charter. |
| Podman as the **Testcontainers backend** (what the integration suite's Postgres/registry run on) | **No.** Out of scope. Testcontainers still needs a Docker-API socket; these runs used colima's. |

Keeping them apart matters: the second is a test-harness convenience, the first is the deployment
claim.

## What was tested

| | |
|---|---|
| Podman client / server | 6.1.0 (`go1.26.5`, build origin brew) |
| Rootless | `podman info --format '{{.Host.Security.Rootless}}'` → **`true`** |
| Machine provider | `applehv`, 4 CPUs, 2 GiB (see *Limits* below) |
| Host | macOS `darwin/arm64` |
| Repo | `main` @ `45087ba` (M21.5 merged, so `managed-dep` is present) |

### The command surface

Unchanged, and deliberately the narrow podman-compatible subset — `create` (never `run`), `cp` in,
`start -a`, `cp` out, `rm -f`, with `--network none`, **no** `-v` bind mount, **no** `docker.sock`,
**no** `--privileged`. Nothing was widened to make podman pass. Podman accepts all of it verbatim.

### Results

| Suite | Result under podman |
|---|---|
| `packages/plugins/managed-dep` unit (incl. `runner-containment.test.ts`) | 177/177 pass |
| `packages/plugins/managed-scan` unit (incl. `scanner-containment.test.ts`) | 28/28 pass |
| `packages/plugins/managed-iac` unit | 9/9 pass |
| `managed-dep/src/runner-image.integration.test.ts` (builds + inspects the `FROM scratch` image) | 6/6 pass |
| `managed-iac.integration.test.ts` (real container: plan → gate → approve → apply → rollback) | 2/2 pass |
| `apps/server` `bump-provenance` + `bump-dispatch` integration | 46/46 pass |
| `apps/server` `promotion-scan-step` integration (real `scp-runner-scan`, real Trivy/OpenSCAP/`trivy vm`) | 10/10 pass¹ |
| `apps/server` `governance` + `plans` integration | 48/48 pass |
| `apps/server` `routes/executors` integration | 1 failure at the time of testing — **see F2**, a pinned test expectation, not a runtime defect; **fixed** |

¹ after loading the runner image into podman's store — see **F3**.

`podman build` also handles `apps/runner-dep`'s two-stage `FROM scratch` assembly, including the
build-time "exactly busybox + 7 applets" count assertion. The `# syntax=docker/dockerfile:1.7`
directive is ignored by buildah, harmlessly — this Dockerfile uses no BuildKit-only features.

**The copy-in/copy-out path — the specific risk — is clean.** Rootless podman applies uid mapping on
`cp` into a container differently from Docker, so that was the first place checked. A full
`create → cp in → start -a → cp out → rm -f` round trip through the real `scp-runner-dep` image
returned byte-correct edited output, and the copied-out tree landed on the host owned by the
invoking user (`501:20`), not by root. No ownership or permission fixup is needed.

## Findings

### F1 — No test exercised the knob at all — and wiring one immediately found a live bug (**fixed**)

Pointing `SCP_MANAGED_RUNNER_DOCKER_BINARY` at podman changes the behaviour of **zero** tests. The
three suites that look like they cover this are each structurally incapable of it:

- `managed-scan/src/scanner-containment.test.ts` — a **static grep** over `git ls-files`. Runs no
  container.
- `managed-dep/src/runner-containment.test.ts` — **mocks `node:child_process` wholesale**; every
  `docker` invocation is a stub. Runs no container by design ("no Docker required").
- `managed-dep/src/runner-image.integration.test.ts` — runs real containers, but **hardcodes the
  literal string `"docker"`** and never reads the config or the env var.

`grep -n 'SCP_MANAGED_RUNNER_DOCKER_BINARY\|dockerBinary'` across all three returns **no matches**.
The operator knob is real and correct in the server; nothing downstream of it is tested, and the knob
is documented in no doc, deploy manifest, or README in the repo.

This is the *actuator-vs-signal* shape: the setting exists and is injected correctly, but nothing
verifies the thing it selects can actually run the workload.

**What the test found the moment it was written (2026-08-16, now fixed).** The injection is written
once *per module*, as a separate `if (pluginModule === …)` arm — so the property was only ever as
complete as the last person to add a managed class remembered to make it. `managed-iac` and
`managed-scan` set `dockerBinary`; **`managed-dep` did not, on any of its three construction
paths**, though it `execFile`s `config.dockerBinary ?? "docker"` exactly like its siblings.

Two consequences, both real:

- **Functional.** An operator setting `SCP_MANAGED_RUNNER_DOCKER_BINARY=podman` got podman for two
  managed classes and a silent hardcoded `docker` for the third. On a podman-only RHEL host,
  dependency bumps fail while scanning and IaC work — the "setting that silently applies to half the
  runs" that `managedRunnerSettings`' own doc comment exists to warn against.
- **Defence in depth.** The stated property — "the two defences now fail independently", so a
  write-door regression downgrades from RCE to an inert config key — was **false for `managed-dep`**.
  The write door does refuse the key today (`plugin-manifests-managed-dep.test.ts` pins it), so this
  was not a live RCE; but the second, independent defence was absent, and it is exactly a write-door
  fail-open for a sibling module that [PR #238](https://github.com/CommanderSCP/commanderscp/pull/238)
  had just fixed. Driving the resolution with a tenant-supplied value returned
  `"/tmp/tenant-chosen-binary"` — the tenant's choice, not the server's.

The gap had been **noticed and then documented rather than closed**: an earlier edit corrected the
plugin's own doc comment from "Server-injected in production" to "NOTHING SETS IT IN PRODUCTION — a
test/fixture seam". The comment was made accurate; the behaviour was left broken. A comment that
truthfully describes a missing control still leaves the control missing.

Fixed by adding `dockerBinary` to `managedDepServerSettings()` and threading it through both
construction paths. Now pinned by two tests — `routes/executors.integration.test.ts` enumerates every
managed module through the binding path, and `dependencies/bump-dispatch.integration.test.ts` covers
the binding-free dispatch that actually runs in production. Both were confirmed to fail when the
wiring is removed. Adding a fourth managed executor fails the first until it is wired.

**Workaround used here:** a `docker` → `podman` shim first on `PATH`, so the existing suites run
unmodified against podman. No parallel "podman test" was written. Non-vacuity was confirmed by image
provenance rather than by a green tick — after the runs, `scp-runner-dep:m21-5-integration-test` and
`scp-runner-iac:m7-integration-test` existed in **podman's** store and in **no** Docker store, so the
containers demonstrably ran on podman.

### F2 — One server test hardcodes `"docker"` and fails on any podman-configured host

[`apps/server/src/routes/executors.integration.test.ts:621`](../apps/server/src/routes/executors.integration.test.ts#L621)

```
expect(cfg.dockerBinary).toBe("docker");
```

```
AssertionError: expected 'podman' to be 'docker'
Expected: "docker"
Received: "podman"
```

The test saves, overrides and restores `SCP_MANAGED_IAC_RUNNER_IMAGE`, `…_NETWORK_MODE` and
`…_WORKSPACE_ROOT`, but leaves `SCP_MANAGED_RUNNER_DOCKER_BINARY` ambient and then asserts the
default literal. So it is non-hermetic in exactly one variable — and it is red on precisely the hosts
this work targets. The security property it guards (server injection overrides a malicious stored
tenant value) is intact and worth keeping; only the assertion's coupling to the default is wrong.

**Fixed 2026-08-16.** The env var is now controlled alongside its three siblings and pinned to a
value that is *not* the default (`/usr/bin/operator-chosen-runtime`), so the assertion proves the
value was injected from the knob rather than passing vacuously against the `"docker"` fallback. A
`restoreEnv` helper `delete`s an originally-absent var instead of assigning `undefined`, which would
otherwise store the string `"undefined"` and leak a bogus runtime path into later tests.

### F3 — Podman and Docker have separate image stores; the runner image must be present in podman

The 7 `promotion-scan-step` failures seen on the first podman run were **not** a podman defect. The
test builds `scp-runner-scan` with the literal `docker` (into colima's store) while the orchestrator
under test launches it with `podman` (a different store), so the image was simply absent. Baseline
confirms the split rather than a regression: **10/10 pass under docker, 7 fail under podman with the
image missing, 10/10 pass under podman once it is loaded.**

For operators this is the real deployment note: **switching the knob is not sufficient — the vetted
runner images must be in the runtime's own store.**

## Air-gap

The load path works, and is the one air-gapped sites already use:

```bash
docker save -o runner-scan.tar scp-runner-scan:<tag> && podman load -i runner-scan.tar
```

243 MB image, loaded in ~8 s. Two things to know:

- **Podman fully-qualifies bare tags on load.** `scp-runner-scan:<tag>` became
  `docker.io/library/scp-runner-scan:<tag>`; an image built by `podman build` becomes
  `localhost/…`. Bare references still resolved against local storage in both cases, so the
  orchestrator's image refs worked unchanged — but an image that is *absent* locally sends podman to
  its `unqualified-search-registries`, which in an air-gapped site is a failure with a confusing
  message. Prefer fully-qualified refs in `SCP_MANAGED_*_RUNNER_IMAGE`.
- **The drill and build scripts are docker-shaped.** `scripts/airgap-drill.sh`,
  `ansible-drill.sh`, `kind-drill.sh`, `bundled-argocd-drill.sh` and `runner-image-tags.sh` invoke
  `docker build` / `docker pull` / `docker image inspect` as literals. These are build-host and CI
  concerns rather than the runtime managed-execution path, so they do not affect the verdict above —
  but a RHEL/podman build host cannot run them as written. Making them honour a
  `${CONTAINER_ENGINE:-docker}` is a small, separate piece of work.

## Operator guidance

```bash
SCP_MANAGED_RUNNER_DOCKER_BINARY=podman
```

One knob, server/operator-governed, same trust tier as `SCP_MANAGED_IAC_RUNNER_IMAGE`. Tenants cannot
set it: it is refused at the write door by `validatePluginConfig` **and** overwritten by server
injection (two independent defences — see the comment at `executor-bindings-repo.ts:580`). Set it
once; every managed executor picks it up.

Checklist for a podman deployment:

1. Set `SCP_MANAGED_RUNNER_DOCKER_BINARY=podman` (an absolute path such as `/usr/bin/podman` is
   preferable — it is `execFile`'d, so it resolves on the server process's `PATH`).
2. Load the vetted runner images into **podman's** store (F3), fully qualified (Air-gap, above).
3. Rootless is the recommended and verified mode. No `--privileged`, no socket, no bind mount is
   required by any managed executor, so no rootful escalation is needed.

## Limits of this verification — stated rather than papered over

- **Podman ran in a macOS `applehv` VM, not natively on RHEL.** The containers themselves ran
  rootless on a Linux kernel, which is what the uid-mapping risk is about, so the result transfers;
  but a native RHEL 9 rootless run (with SELinux enforcing, and `crun` rather than a macOS-provisioned
  machine) has not been done. **SELinux labelling was therefore not exercised** — normally the risk
  sits with `-v` mounts, which this design does not use at all, but it remains untested.
- `podman-remote`, rootful podman, and podman as a Testcontainers backend were not tested.
- The runs above were made *before* the F1/F2 fixes. `managed-dep` was therefore verified as a
  container workload (its runner image builds and round-trips under podman) but was, at that moment,
  still being handed a hardcoded `docker` by the server. The fix routes the operator's binary to it
  through the same knob its siblings use, and is covered by tests on both construction paths; an
  end-to-end podman bump through the *server* dispatch path has not been re-run since.

## Suggested charter note (not applied — owner sign-off)

The Managed Execution Exception's containment preconditions are runtime-neutral as written, and
nothing here needs an amendment to be true. But the exception's argument is *strengthened* by a
rootless, daemonless runtime, and that is worth saying explicitly where the containment case is made.
Proposed wording, for the owner to accept or discard:

> Managed runners are runtime-neutral: the runner command surface is the narrow subset common to
> Docker and podman (`create`, `cp`, `start`, `rm`, `--network none`, no bind mount, no socket, no
> privileged flag), selected by the operator-governed `SCP_MANAGED_RUNNER_DOCKER_BINARY`. Rootless
> podman is verified (6.1.0, 2026-08-16) and is the recommended runtime where a container daemon is
> disallowed.
