# `scp-runner-dep`

The isolated single-shot image the `scp-managed-dep` executor launches per dependency bump
(charter's Managed Execution Exception, `scp-managed-dep` amendment approved 2026-08-13 and
qualified 2026-08-15; [ADR-0032](../../docs/adr/0032-dependency-subscriptions.md) §8;
BUILD_AND_TEST.md §8 M21.5).

```
docker build -t scp-runner-dep:dev apps/runner-dep
```

It is the third runner image, and it follows `apps/runner-iac` and `apps/runner-scan` exactly: a
pinned base plus a minimal run shim, no Node app code (DESIGN §3). The orchestrator half —
`packages/plugins/managed-dep` — runs inside `scpd`, holds the per-run repository-scoped
short-lived credential, and reaches the git provider. This image reaches nothing.

## What it is, expressed as what it does not contain

Four charter clauses are properties of this image rather than of any code's restraint:

| clause                                                | what makes it true                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| "never runs a package manager"                        | there is no npm/yarn/pnpm/pip/mvn/gradle/go/cargo in the image                       |
| "never resolves or regenerates a lockfile"            | resolving needs a package manager and a network; it has neither                      |
| "never builds, compiles, or tests"                    | there is no compiler and no language runtime                                         |
| "the runner contains no package manager" (2026-08-15) | the runtime image is `FROM scratch` and holds one static binary + seven applet names |

### That last row is not the obvious build, and the difference was measured

`FROM busybox` plus the shim does **not** satisfy the fourth clause: a stock BusyBox ships `dpkg` and
`rpm` applets (along with `wget`, `nc`, `telnet` and some four hundred others). So the runtime image
is **assembled rather than inherited** — an `assemble` stage copies out the one static multi-call
binary and creates symlinks for exactly the seven applets `run.sh` invokes, and the final stage is
`scratch` and receives only that tree.

**The residual, stated:** BusyBox is a multi-call binary, so the code behind `dpkg`/`rpm` is still
inside `/bin/busybox` and `busybox dpkg` still dispatches to it. Removing that needs a
custom-compiled BusyBox — a C toolchain in the build of the one image whose argument is that it has
no toolchain. What the clauses are about is unaffected: the container is `--network none`
unconditionally (nothing to fetch), the only bytes present are the one manifest copied in (nothing
to unpack), and neither dpkg nor rpm is one of the five ecosystems this class authors.

### How each clause is actually checked

Two tests, at two altitudes, and the second is the one that can answer the question:

- `packages/plugins/managed-dep/src/runner-image.test.ts` reads the **Dockerfile** and the shim, and
  drift-checks the base against `tools/busybox/pin.env`. Cheap, runs everywhere, and structurally
  blind to what the base brought in — which is exactly how `dpkg`/`rpm` were here unnoticed, and how
  a `--build-arg RUNNER_DEP_BASE_IMAGE=node:22` override (the base used to be a build ARG carrying a
  mutable tag) produced an image tagged as the vetted runner with a full Node toolchain in it.
- `packages/plugins/managed-dep/src/runner-image.integration.test.ts` **builds the image** and asks
  the artifact: it exports the container filesystem and asserts the exact tree, checks every
  forbidden name against the container's `PATH`, and runs a real bump end to end through the real
  ENTRYPOINT. Both halves of the ARG defect are closed — the base is now a **literal digest-pinned
  `FROM`** (no arg to override, no tag to move), and the proof is against the artifact.

## Base image pin

`tools/busybox/pin.env` is the single source of truth (`BUSYBOX_PINNED_IMAGE`), mirroring
`tools/trivy/pin.env` and `tools/openscap/pin.env`. See that directory's README for the update
recipe.

## Who builds and publishes it

The same two places as its siblings, and this is what makes the clauses enforceable on a shipped
deployment rather than only in this repository:

- `.github/workflows/ci.yml`'s `runner-images` job builds + pushes a **content-hash-tagged** copy to
  GHCR once per content change (`scripts/runner-image-tags.sh` is the tag formula,
  `SCP_RUNNER_DEP_IMAGE_REF`); the integration job pulls it, so the built-artifact test above runs
  on every CI run without paying a build.
- `.github/workflows/publish-images.yml` publishes the deliberate `sha-<commit>`/`latest` release
  tags a consuming gitops repo pins against.

An operator names the pinned ref in `SCP_MANAGED_DEP_RUNNER_IMAGE`. **Unset is the default and it
means OFF** — with no image, a managed-dep dispatch fails closed before a container could be launched
or a credential minted (ADR-0006: managed execution is never a default).

## Egress

`--network none`, unconditionally. Unlike `scp-managed-scan` — whose network clause the 2026-07-23
amendment qualifies for registry pulls — the `scp-managed-dep` clause carries no qualifier, so the
orchestrator passes the literal rather than an operator-settable value. There is no
`SCP_MANAGED_DEP_NETWORK_MODE`; a knob would have been an operator-facing way to contradict the
charter.

## Interface

```
docker create --network none scp-runner-dep <ecosystem> <manifestPath> <coordinate> <fromVersion> <toVersion>
docker cp <dir>/. <container>:/work/in
docker start -a <container>
docker cp <container>:/work/out/. <dir>
```

`/work/in/manifest` is the one file read; `/work/out/manifest` is the one file written. No bind
mount, no docker socket, no environment. `manifestPath` is carried for messages only and is never
opened — the subject is always `/work/in/manifest`.

The transform is the reference edit from `bump-edit.ts`'s `applyManifestBump`: find the ONE line
naming both the coordinate and the version the manifest declares today, and replace the first
occurrence of that version token on it. `runner-shim.test.ts` runs the shim and the reference over
the same fixtures and requires byte-identical output.

## What is NOT verified here

Nothing. This container decides nothing about whether the edit is permissible — it applies one
transform and exits. The orchestrator re-reads its output against the input with two independent
verifiers (`verifyManifestBump`, textual and descriptor-anchored; `verifyManifestOnlyEdit`, a parse
anchored on the document) and mints an HMAC proof; `publishBump` refuses content without one. Bytes
this container produced cannot reach a repository unless both verifiers agreed with them.
