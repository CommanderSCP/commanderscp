# tools/busybox

Not an npm workspace package — the **provenance record for the pinned BusyBox** the M21.5
`scp-runner-dep` image (`apps/runner-dep/Dockerfile`) builds `FROM`, plus the single source of truth
every consumer reads. Mirrors `tools/trivy` and `tools/openscap` in shape.

- `pin.env` — the pin itself (version, upstream repo, image digests), shell-sourceable.
  `apps/runner-dep/Dockerfile`'s `FROM` carries a copy of `BUSYBOX_PINNED_IMAGE`;
  `packages/plugins/managed-dep/src/runner-image.test.ts` fails if that copy drifts from this file,
  and `runner-image.integration.test.ts` fails if the BUILT IMAGE disagrees with either.

## What is pinned

|                                                                                   |                                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base image                                                                        | [busybox](https://hub.docker.com/_/busybox) (Docker Official Image)                                                                              |
| Version                                                                           | **1.36.1-musl**                                                                                                                                  |
| Image ref (**what the runner builds FROM**)                                       | `busybox@sha256:3c6ae8008e2c2eedd141725c30b20d9c36b026eb796688f88205845ef17aa213` — the **multi-arch index (manifest-list) digest** for that tag |
| linux/amd64 platform digest (production runner arch, provenance + drift-asserted) | `sha256:cbf412bcf1379481c80f65208703910fe543b3a948ae74a32a10ca3789dc13ab`                                                                        |
| License                                                                           | GPL-2.0 (upstream BusyBox)                                                                                                                       |

## Why a digest and not the tag

`scp-runner-dep` exists to make four charter clauses true — _"never runs a package manager"_, _"never
resolves or regenerates a lockfile"_, _"never builds, compiles, or tests"_, _"the runner contains no
package manager"_ — and each of them is a statement about what the image **contains**. A mutable tag
makes that a statement about whatever Docker Hub served the build host that day.

There is a sharper version of the same problem, and it is why the base is a **literal `FROM`** rather
than a build ARG with a digest default: `docker build --build-arg RUNNER_DEP_BASE_IMAGE=node:22
apps/runner-dep` produced an image tagged as the vetted runner that carried a full Node toolchain,
and the only test guarding the pin read the Dockerfile's **text**. A build arg is an override; the
clauses are not overridable, so the value is not a parameter.

## Updating the pin

1. Pick the new BusyBox tag from [Docker Hub](https://hub.docker.com/_/busybox). Keep the `-musl`
   flavour: it is the fully static one, so the image has no dynamic loader to satisfy either.
2. Resolve the **multi-arch index digest** (what the `FROM` uses):
   ```sh
   docker pull busybox:<tag>
   docker inspect --format '{{index .RepoDigests 0}}' busybox:<tag>
   ```
   and the **linux/amd64 platform** digest (recorded for provenance):
   ```sh
   docker manifest inspect busybox:<tag> \
     | jq -r '.manifests[] | select(.platform.architecture=="amd64" and .platform.os=="linux") | .digest'
   ```
3. Confirm the applets `apps/runner-dep/run.sh` depends on are still present — `sh`, `awk`, `sed`,
   `mkdir`, `cat` — and that nothing new arrived that a package manager could be built out of:
   ```sh
   docker run --rm --network none --entrypoint /bin/sh busybox@<digest> -c 'busybox --list'
   ```
4. Update `pin.env` (version, index digest, amd64 digest), then update the `FROM` in
   `apps/runner-dep/Dockerfile`.
5. `pnpm --filter @scp/plugin-managed-dep test` — `runner-image.test.ts` is the drift gate and will
   name any copy you missed. Then, on a host with Docker,
   `pnpm --filter @scp/plugin-managed-dep test:integration` — that one builds the image and asserts
   the clauses against the artifact rather than against this file.
