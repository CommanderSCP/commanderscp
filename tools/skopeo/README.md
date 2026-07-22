# tools/skopeo

Not an npm workspace package — the **provenance record for the pinned skopeo** that M15.5 c1
vendors into the SCP runtime image, plus the single source of truth every consumer reads. This
mirrors `tools/cosign` (M17.3 E1) deliberately; where the two differ, the difference is called
out below.

- `pin.env` — the pin itself (version, image digest, in-image paths), shell-sourceable.
  `Dockerfile` and `packages/cosign/src/skopeo-bin.ts` carry a copy of these values;
  `deploy/airgap/src/skopeo-bin.test.ts` fails if any copy drifts from this file.
- `skopeo-wrapper.sh` — the in-image entry point installed at `/opt/scp/bin/skopeo` (see "The
  dynamic-linking deviation"). Committed with the executable bit set; `COPY` preserves it.
- `policy.json` — the minimal containers-policy the Dockerfile installs at
  `/etc/containers/policy.json` (see "The policy.json choice").
- `LICENSE-skopeo` — Apache-2.0, the upstream license, copied verbatim from
  `github.com/containers/skopeo` at tag `v1.22.2`.

## What is pinned

| | |
|---|---|
| Tool | [containers/skopeo](https://github.com/containers/skopeo) |
| Version | **1.22.2** (`skopeo --version` reports `skopeo version 1.22.2 commit: c766fdc4c1ff9525fa6a38f860430f10646124b3`; note: **no leading `v`**, unlike cosign) |
| Image ref (**what we actually use**) | `quay.io/skopeo/stable@sha256:8b23fe434af822adf71bc7c8674a8dfab379771aa1400fb81ff655a5cecfca87` — the **linux/amd64 platform manifest** for tag `v1.22.2` |
| Multi-arch index digest (provenance only) | `sha256:c7d3c512612f52805023cd38351081dad7e2729fc13d14b701e47c7c8bdd6615` |
| Path inside the upstream image | `/usr/bin/skopeo` (Fedora-based image; mode `0755`, 26,006,776 B, `sha256:da3115824eadde2a920eda0b96241c2f7e5f91ce03b6b41d7d49361365832645`) |
| Paths inside the SCP image | `/opt/scp/bin/skopeo` (wrapper) → `/opt/scp/libexec/skopeo/{skopeo, lib/*}` (real binary + its library closure + loader) |
| License | Apache-2.0 (`LICENSE-skopeo`); the vendored `.so` files are unmodified Fedora-built libraries redistributed from the upstream image under their own licenses (glibc/libgpgme LGPL, etc.) |

## Why an image digest, not a downloaded release binary

For cosign this was a size-driven choice; for skopeo it is not even a choice: **upstream skopeo
publishes no release binaries at all** ([their install docs](https://github.com/containers/skopeo/blob/main/install.md)
say so explicitly) — `quay.io/skopeo/stable` *is* the official binary distribution. A digest pin
is also strictly stronger than any tag or URL+sha256: the digest is the content hash of the
entire image, it is what the registry re-verifies on every pull, and a mutable tag cannot be
re-pointed underneath it. Same precedent chain as `tools/cosign` and `apps/runner-iac`'s pinned
OpenTofu image.

### Why the platform digest, not the index digest

`quay.io/skopeo/stable:v1.22.2` is a multi-arch index (amd64/arm64/ppc64le/s390x). Referencing
the index makes the binary you get depend on the **build host's** architecture; referencing the
linux/amd64 *platform* manifest digest makes the ref resolve to exactly one artifact everywhere —
the same bytes on a CI runner, an arm64 laptop, or an air-gapped mirror.

### Why linux/amd64 only

Identical rationale to `tools/cosign/README.md`: `.github/workflows/publish-images.yml` builds a
single-arch linux/amd64 image (plain `docker build`, no buildx), so vendoring other architectures
would be paying for bytes nothing in CI or prod runs. Developers on other architectures still
work: everything outside the runtime image uses an operator/dev-supplied `skopeo` on `PATH`
(see "Two skopeo paths").

## The dynamic-linking deviation (how this differs from the cosign pin)

cosign's ko-built binary is **static** — E1 copies one file and is done. skopeo's binary is
**dynamically linked** against Fedora sonames (`libgpgme.so.45`, `libsubid.so.5`,
`libsqlite3.so.0`, …) that the Debian-based `node:22-bookworm-slim` runtime image does not ship
(Debian's soname for gpgme is `libgpgme.so.11` — these are not just missing files, they are
different ABI versions). A bare `COPY` of the binary would produce a loader error at runtime.

So the Dockerfile vendors, from the same digest-pinned image:

- the binary itself → `/opt/scp/libexec/skopeo/skopeo`
- its **full `ldd` closure** (21 libraries, verified closed — each library's own dependencies are
  already in the list) **plus Fedora's own ELF loader** `ld-linux-x86-64.so.2` →
  `/opt/scp/libexec/skopeo/lib/`
- a wrapper (`skopeo-wrapper.sh`, this directory) → `/opt/scp/bin/skopeo`, which runs
  `$lib/ld-linux-x86-64.so.2 --library-path $lib $libexec/skopeo "$@"` so the binary executes
  against **exactly the vendored libraries, never the host's** — the Debian glibc version is
  irrelevant to it.

Alternatives rejected:

- **Build from source with `DISABLE_CGO`** (produces a static pure-Go binary): requires fetching
  Go sources at image-build time — a network fetch that is not content-addressed by us, exactly
  what the digest-pin shape exists to avoid, and it would make us the builder (and de-facto
  vetter) of a custom skopeo variant upstream never ships.
- **`apt-get install skopeo`**: Debian bookworm carries 1.9.3 (2022), unpinned, resolved at
  build time from whatever the mirror serves.
- **Copying Fedora's whole `/usr/lib64`**: two orders of magnitude more bytes than the closure.

The closure list lives as explicit `COPY` lines in the Dockerfile on purpose: if an upstream
update renames or adds a soname, the build **fails loudly** at the `COPY` (missing file) or the
CI `skopeo --version` check (new unlisted dependency), instead of shipping a binary that breaks
at runtime.

## The policy.json choice

skopeo refuses to copy without a signature policy (`/etc/containers/policy.json`). The Dockerfile
installs this directory's minimal policy:

```json
{ "default": [{ "type": "insecureAcceptAnything" }] }
```

**Why `insecureAcceptAnything` and not `signedBy`/`sigstoreSigned`:** in SCP, skopeo is a **byte
mover**. Artifact trust for promoted images is enforced by **cosign manifest verification at
promotion import** (M17.4a — receiver-side, fail-closed, against the sending domain's paired
public key), not by skopeo's policy engine, which governs a different trust system
(simple-signing/GPG and registry-attached sigstore signatures) that SCP does not use. This is
also exactly the default the upstream image itself ships. If the M15.5 c2 relay design later
wants transport-level enforcement as defense-in-depth, tightening this file (per-registry
`sigstoreSigned` entries) is a one-file change with its own review.

`registries.d` is deliberately **not** carried: skopeo runs fine on its built-in defaults, and
those files only configure lookaside endpoints for the simple-signing flow we don't use.

Note for c2: `node:22-bookworm-slim` ships **no CA bundle** (`/etc/ssl/certs/ca-certificates.crt`
is absent), so `docker://` transports against TLS registries from inside the image will need a CA
decision (mounted bundle, `--src-cert-dir`, or an image change) — that belongs to the relay
increment, not this one. Offline transports (`oci:`, `dir:`) verified working without it.

## Trust on first vendor (read this before updating the pin)

Same shape as the cosign pin: authenticity is established **once, by a human, at vendor time**,
from a connected machine, and then **frozen as a digest**:

1. A human confirms the image is the genuine upstream one (the `skopeo/stable` repository on
   quay.io is the official distribution named by upstream's own install docs).
2. The resolved linux/amd64 platform digest is written into `pin.env`.
3. Every later fetch — CI, image build, air-gap mirror — is **content-addressed** against that
   digest. No trust decision is repeated at build time, and nothing downstream contacts quay.io
   by tag.

(Unlike cosign, upstream publishes no signed checksums to cross-check — the digest of the
official image is the strongest available anchor.)

## Two skopeo paths (and why the old probing survives)

`packages/cosign/src/skopeo-bin.ts` is the one place that answers "which skopeo, and is it
ours?" — the same pinned-vs-probe split as `resolveCosign()`, in the same package:

| Path | Resolved from | `pinned` | Version check |
|---|---|---|---|
| Vendored | `/opt/scp/bin/skopeo` (in-image), or `SCP_SKOPEO_BIN` | `true` | **fail closed**: `skopeo --version` must equal the pin, or `assertPinnedSkopeoVersion()` refuses to proceed |
| Operator-supplied | `skopeo` on `PATH` | `false` | none — we did not vet it |

The vendored path is `/opt/scp/bin`, deliberately **not** `/usr/local/bin`, so a Homebrew/apt
skopeo can never be mistaken for the vetted pin.

**The release/bundle path does not use any of this.** `deploy/airgap/src/build-bundle.ts` (via
`deploy/airgap/src/skopeo.ts`) and `deploy/airgap/assets/install.sh` keep using the operator's
own `PATH` skopeo, exactly as before — install.sh runs on an operator's air-gapped install
target where `/opt/scp` does not exist, and CI's deploy-drills keep installing skopeo from apt
for those suites. `skopeo-bin.test.ts` asserts install.sh stays clean of the vendored path.

## What this binary is for (and not for)

It exists for the **M15.5 c2 artifact relay** — the runtime image moving image bytes between
registries at a domain boundary. This increment (c1) vendors and pins it only: **no product code
calls it yet, and no behavior changed anywhere**. It is NOT for the air-gap release path (above),
and — like the vendored cosign — it must never become part of verifying the air-gap bundle that
carries it.

CI note for c2: when relay tests need the *pinned* binary on a runner, extract it from
`SKOPEO_PINNED_IMAGE` the way `scripts/install-pinned-cosign.sh` does for cosign (the wrapper +
libexec layout must be reproduced, or simply run the tests against the built image). Today's CI
keeps its apt/`PATH` skopeo for the release-path suites — do not switch those.

## Cost of the pin (measured, not estimated)

Built with `docker build -t scp:<tag> .` on the same daemon, same context, before and after
(2026-07-22, Docker Engine 29.5.2 under colima):

| | uncompressed (sum of `docker history`) | as stored/pulled (`docker inspect --format '{{.Size}}'`) |
|---|---|---|
| before | 895.7 MB | 247,125,516 B (247.1 MB) |
| after | 931.6 MB | 262,006,375 B (262.0 MB) |
| **delta** | **+35.9 MB** (26.0 MB binary + 9.8 MB libs/loader + ~1 kB wrapper/policy) | **+14,880,859 B = +14.9 MB** (the bundle compresses ~2.4:1) |

So: **+35.9 MB on disk, +14.9 MB to pull** — roughly a quarter of what the cosign pin cost
(141 MB / 57.6 MB), a ~4 % increase on the uncompressed image. There are deliberately no `RUN` layers: the wrapper's
executable bit is preserved from git by `COPY`, and the binary/libraries keep their upstream
modes.

Verified on the built image: `/opt/scp/bin/skopeo --version` reports exactly `skopeo version
1.22.2 commit: c766fdc4c1ff9525fa6a38f860430f10646124b3`, an offline `dir:` → `oci:` copy
round-trip succeeds against the shipped policy.json, and `/opt/scp/bin/cosign` still reports its
own pin.

## Updating the pin

1. Pick the new skopeo release from `github.com/containers/skopeo/releases` / the
   `quay.io/skopeo/stable` tags.
2. On a connected machine, establish authenticity **by hand** (see "Trust on first vendor").
3. Resolve the **linux/amd64 platform manifest digest**:
   ```sh
   docker manifest inspect quay.io/skopeo/stable:<version> \
     | jq -r '.manifests[] | select(.platform.architecture=="amd64" and .platform.os=="linux") | .digest'
   ```
4. Confirm the in-image binary path is still `/usr/bin/skopeo`, and **regenerate the library
   closure** (the Dockerfile's COPY list) — sonames change between Fedora bases:
   ```sh
   docker run --rm --entrypoint sh quay.io/skopeo/stable@<digest> -c \
     'ldd /usr/bin/skopeo | awk "{print \$3}" | grep "^/" | sort -u; ldd /usr/bin/skopeo | grep ld-linux'
   ```
   Verify the closure is closed (run `ldd` over each listed library and check nothing new
   appears) before rewriting the Dockerfile list.
5. Confirm the wrapper still works and the transports the relay depends on still behave: build
   the image, then run `/opt/scp/bin/skopeo --version` and an offline `dir:` → `oci:` copy
   round-trip inside it.
6. Update `pin.env` (version, image digest, index digest), then the copies in `Dockerfile` and
   `packages/cosign/src/skopeo-bin.ts`. Refresh `LICENSE-skopeo` if upstream's license changed.
7. `pnpm --filter @scp/airgap test` — `skopeo-bin.test.ts` is the drift gate and will name any
   copy you missed.
8. Rebuild the image and re-measure the size delta; update the table above.
