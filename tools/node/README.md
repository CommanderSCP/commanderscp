# tools/node — the pinned Node base image

This mirrors `tools/skopeo/` and `tools/cosign/` (their READMEs state the shared shape; where this
pin differs, the difference is called out here). `pin.env` is the **single source of truth** for
the root `Dockerfile`'s Node base image — the image both its `base` (build toolchain) and
`runtime` stages start from.

## What consumes the pin

| Consumer                                                     | How                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Root `Dockerfile`                                            | `ARG NODE_IMAGE=<NODE_PINNED_IMAGE>` default — must match `pin.env` byte-for-byte                       |
| `tools/ci-mirror/images.list`                                | references `${NODE_PINNED_IMAGE}` / `${NODE_PINNED_VERSION}` by variable, never re-typed                |
| `scripts/ci-mirror.sh seed`                                  | exports `NODE_IMAGE=<mirror ref>` so CI compose builds resolve the GHCR mirror, not Docker Hub          |
| every `deploy/compose/*.yml` that builds the root Dockerfile | passes `NODE_IMAGE` through as a build arg (pass-through form — unset falls back to the pinned default) |
| `deploy/airgap/src/skopeo-bin.test.ts`                       | the census that holds all of the above together; it fails on any drift                                  |

## How it differs from the skopeo/cosign pins

- **No vendored binary.** skopeo/cosign pins select a tool that is _extracted_ from the image;
  this pin selects a _base image_. There is no `*_UPSTREAM_PATH`/`*_VENDORED_PATH`, no wrapper,
  and no runtime version assertion — the census above and the digest itself are the whole guard.
- **The digest is the multi-arch INDEX digest** (skopeo/cosign pin the linux/amd64 platform
  manifest). CI job 4d mirrors whatever single-arch manifest the amd64 runner resolves it to —
  see `images.list`'s CAVEAT.

## Updating the pin

1. Resolve the new index digest against Docker Hub, e.g.
   `docker buildx imagetools inspect node:<tag>` (the `Digest:` line), or the registry API.
2. Update `NODE_PINNED_IMAGE` (and `NODE_PINNED_VERSION` if the tag changed) in `pin.env`.
3. Update the root `Dockerfile`'s `ARG NODE_IMAGE=` default to the same ref — the census reds CI
   until they agree.
4. Let CI job 4d re-mirror on the next run (the mirror cache is keyed on the digest, so the bump
   is a cache miss and the new bytes really are fetched).

A tag is not an identity: bump the digest deliberately, never "fix" the pin back to a floating
tag. `FROM node:22-trixie-slim` resolving Docker Hub live on every E2E compose build is exactly
what this pin was created to end (2026-08-31).
