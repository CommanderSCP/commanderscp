# tools/cosign

Not an npm workspace package — the **provenance record for the pinned cosign** that M17.3 E1
vendors into the SCP runtime image, plus the single source of truth every consumer reads.

- `pin.env` — the pin itself (version, image digest, in-image paths), shell-sourceable.
  `Dockerfile`, `scripts/install-pinned-cosign.sh`, `deploy/airgap/src/cosign-bin.ts` and
  `scripts/doctor.mjs` all carry a copy of these values;
  `deploy/airgap/src/cosign-bin.test.ts` fails if any copy drifts from this file.
- `LICENSE-cosign` — Apache-2.0, the upstream license, copied verbatim from
  `github.com/sigstore/cosign` at tag `v3.1.2`.

## What is pinned

| | |
|---|---|
| Tool | [sigstore/cosign](https://github.com/sigstore/cosign) |
| Version | **v3.1.2** (`GitVersion` reported by `cosign version`; GitCommit `193d2153431f8bb0d945a4c1ee721872f73add67`, built 2026-07-17) |
| Image ref (**what we actually use**) | `ghcr.io/sigstore/cosign/cosign@sha256:bea051df6a6d3bc84288b6db098df38a81d87b7ed226f34d22aaae1bc329c2b7` — the **linux/amd64 platform manifest** for tag `v3.1.2` |
| Multi-arch index digest (provenance only) | `sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849` |
| Path inside the upstream image | `/ko-app/cosign` (ko-built distroless image; mode `0555`, 141,146,020 B, `sha256:4ebe4c079c4d5667cd1ce4b38219a64da665295e8a071e97f4e727182d8a080d`) |
| Path inside the SCP image | `/opt/scp/bin/cosign` |
| License | Apache-2.0 (`LICENSE-cosign`; the image also carries `io.artifacthub.package.license=Apache-2.0`) |

## Why an image digest, not a downloaded release binary

`tools/openapi/bin/oasdiff-linux-amd64` is committed to git with a recorded release URL + sha256.
That shape was **rejected** here: the cosign release binary is 134.6 MiB against a ~22 MiB `.git`
— committing it would multiply the repository's size several times over, forever, on every clone.

A raw `curl` + `sha256sum` in the Dockerfile was rejected too. A digest pin is strictly stronger:
the digest **is** the content hash of the entire image (config + layers), it is what the registry
itself resolves and re-verifies on every pull, and a mutable tag cannot be re-pointed underneath
it. `apps/runner-iac/Dockerfile` already set this precedent for OpenTofu — "built FROM OpenTofu's
own official image … rather than hand-downloading/verifying a release binary — the upstream image
already owns that supply chain".

### Why the platform digest, not the index digest

`ghcr.io/sigstore/cosign/cosign:v3.1.2` is a multi-arch index. Referencing the index makes the
binary you get depend on the **build host's** architecture. Referencing the linux/amd64 *platform*
manifest digest makes the ref resolve to exactly one artifact everywhere — the same bytes on a CI
runner, an arm64 laptop, or an air-gapped mirror.

### Why linux/amd64 only

`.github/workflows/publish-images.yml` builds with plain `docker build` (no buildx, no
`--platform`), i.e. this project ships a single-arch linux/amd64 image today. Vendoring arm64 as
well would mean multi-arch image builds, which is a deliberate, separate decision — the same
"don't vendor architectures nothing in CI or prod actually runs" rationale `tools/openapi/README.md`
records for `oasdiff`. A developer on another architecture can still work: `pnpm doctor` and
`deploy/airgap` fall back to an operator-supplied `cosign` on `PATH` (see "Two cosign paths").

## Trust on first vendor (read this before updating the pin)

cosign's own release checksums are signed **by cosign, keylessly** — Fulcio for the certificate,
Rekor for the transparency log. Verifying them requires live calls to `fulcio.sigstore.dev` /
`rekor.sigstore.dev` and a TUF root refresh, which charter principle 5 forbids inside this
project's build, test, and runtime paths.

So authenticity is established **once, by a human, at vendor time**, from a connected machine, and
then **frozen as a digest**:

1. A human confirms the release is the genuine upstream one (release page, checksums, and — if
   they choose, on a throwaway connected machine, outside this repo's pipelines — a keyless
   `cosign verify-blob` of the checksum file).
2. The resolved image digest is written into `pin.env`.
3. Every later fetch — CI, image build, air-gap mirror — is **content-addressed** against that
   digest. No trust decision is repeated, and nothing downstream ever contacts Fulcio or Rekor.

This is the same trust shape as `tools/openapi`'s recorded sha256, one level up: verify once by
hand, pin the hash, never re-derive trust at build time.

## Two cosign paths (and why the old probing survives)

`deploy/airgap/src/cosign-bin.ts` is the one place that answers "which cosign, and is it ours?":

| Path | Resolved from | `pinned` | Flag strategy | Version check |
|---|---|---|---|---|
| Vendored | `/opt/scp/bin/cosign` (in-image), or `SCP_COSIGN_BIN` | `true` | **static** known-good flag set — no `--help` probe on a signing hot path | **fail closed**: `cosign version` must equal the pin, or it refuses to sign/verify |
| Operator-supplied | `cosign` on `PATH` | `false` | the pre-existing **version-adaptive** probe (`--use-signing-config` only when `sign-blob --help` advertises it) | none — we did not vet it |

The vendored path is `/opt/scp/bin`, deliberately **not** `/usr/local/bin`, so a Homebrew/apt
cosign can never be mistaken for the vetted pin.

`--tlog-upload=false` (sign) and `--insecure-ignore-tlog=true` (verify) are **unconditional on
both paths** — they are what keeps signing off the public Rekor log, not a portability detail.
Verified against the pinned v3.1.2 binary behind a closed proxy
(`HTTPS_PROXY=http://127.0.0.1:1`): `sign-blob` and `verify-blob` both succeed with zero egress.

## What this binary is NOT for

It is a **runtime** signing/verification tool. It must never become the verifier of the air-gap
bundle that carries it. `deploy/airgap/assets/install.sh` continues to require an **external**
cosign on the operator's `PATH` and an **external** `--pubkey`; a bundle verified with material
the bundle itself ships is the self-verification hole an adversarial review of PR #15 caught as
CRITICAL (regression suite: `deploy/airgap/src/install-sh-tamper.test.ts`). Nothing in this change
touches that trust model.

## Cost of the pin (measured, not estimated)

Built with `docker build -t scp:<tag> .` on the same daemon, same context, before and after
(2026-07-20, Docker Engine 29.6.1 under colima):

| | uncompressed (sum of `docker history`) | as stored/pulled (`docker inspect --format '{{.Size}}'`) |
|---|---|---|
| before | 752.7 MB | 189,111,356 B (189.1 MB) |
| after | 893.7 MB | 246,675,734 B (246.7 MB) |
| **delta** | **+141.0 MB** (the binary is exactly 141,146,020 B = 134.6 MiB) | **+57,564,378 B = +57.6 MB** (the binary compresses to ~57.6 MB) |

So: **+141.1 MB on disk, +57.6 MB to pull** — a ~19 % increase on the uncompressed image. That is
the whole cost of the pin: one binary, one layer. There is deliberately no `RUN chmod` layer — the
upstream file is already `0555` and `COPY` preserves the mode, whereas a chmod would have
duplicated all 134.6 MiB into a second layer.

Verified on the built image: `/opt/scp/bin/cosign` is mode `0555`, 141,146,020 B, hashes to the
`sha256` above, and reports `GitVersion: v3.1.2 / Platform: linux/amd64`; the image still boots
(it gets all the way to its Postgres connection attempt).

## Updating the pin

1. Pick the new cosign release from `github.com/sigstore/cosign/releases`.
2. On a connected machine, establish authenticity **by hand** (see "Trust on first vendor").
3. Resolve the **linux/amd64 platform manifest digest**:
   ```sh
   docker manifest inspect ghcr.io/sigstore/cosign/cosign:<version> \
     | jq -r '.manifests[] | select(.platform.architecture=="amd64" and .platform.os=="linux") | .digest'
   ```
4. Confirm the in-image binary path is still `/ko-app/cosign` (ko may change it):
   ```sh
   docker create --name c ghcr.io/sigstore/cosign/cosign@<digest> && docker export c | tar -tf - | grep cosign
   ```
5. Confirm the flags this repo depends on are still accepted — `sign-blob` with
   `--tlog-upload=false --new-bundle-format=false --use-signing-config=false --output-signature`
   and `verify-blob --insecure-ignore-tlog=true` — by round-tripping a blob **behind a closed
   proxy** (`HTTPS_PROXY=http://127.0.0.1:1`). Deprecation warnings are fine; `unknown flag` is
   not. If the static flag set must change, change it in `signBlobFlags()`'s **pinned** branch
   only — the unpinned branch belongs to operators' own cosign builds.
6. Update `pin.env` (version, image digest, index digest), then update the copies in `Dockerfile`,
   `deploy/airgap/src/cosign-bin.ts` and `scripts/doctor.mjs`. Refresh `LICENSE-cosign` if
   upstream's license changed.
7. `pnpm --filter @scp/airgap test` — `cosign-bin.test.ts` is the drift gate and will name any
   copy you missed.
8. Rebuild the image and re-measure the size delta; update the table above.
