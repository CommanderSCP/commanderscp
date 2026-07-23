# tools/trivy

Not an npm workspace package — the **provenance record for the pinned Trivy** the M13.3a
`scp-runner-scan` image (`apps/runner-scan/Dockerfile`) builds `FROM`, plus the single source of
truth every consumer reads.

- `pin.env` — the pin itself (version, upstream repo, image digests), shell-sourceable.
  `apps/runner-scan/Dockerfile`'s `ARG TRIVY_IMAGE` default carries a copy of `TRIVY_PINNED_IMAGE`;
  `packages/plugins/managed-scan/src/pin.test.ts` fails if that copy drifts from this file.

## What is pinned

| | |
|---|---|
| Tool | [aquasecurity/trivy](https://github.com/aquasecurity/trivy) |
| Version | **v0.58.1** (`Version` reported by `trivy version`) |
| Image ref (**what the runner builds FROM**) | `aquasec/trivy@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7` — the **multi-arch index (manifest-list) digest** for tag `v0.58.1` |
| linux/amd64 platform digest (production runner arch, provenance + drift-asserted) | `sha256:de81be41be9665a7b761680cd4bb570313a923154b994c79b49b5a55f1a55e35` |
| License | Apache-2.0 (upstream) |

## Why the INDEX digest, not the amd64 PLATFORM digest (the deliberate deviation from cosign/skopeo)

`tools/cosign` and `tools/skopeo` pin the **linux/amd64 platform** digest because they vendor a
BINARY — the file is `COPY`'d out of an image that is never executed, so the pin forces the exact
production platform. `scp-runner-scan` is different: the image is **executed** as an ephemeral
runner (like `scp-runner-iac`, which `FROM`s a multi-arch OpenTofu tag for the same reason).
Pinning the multi-arch **index** digest keeps the pull content-addressed and reproducible while
resolving to the build host's architecture, so the runner runs natively — amd64 in production,
arm64 on an arm dev/CI host — with no emulation. The linux/amd64 platform digest is recorded above
for provenance and asserted by the drift test as the production target arch.

## Trust on first vendor (read this before updating the pin)

Same shape as `tools/cosign`: authenticity is established **once, by a human, at vendor time**,
from a connected machine, and then **frozen as a digest**. Every later fetch — CI, image build,
air-gap mirror — is content-addressed against that digest; no trust decision is repeated and
nothing downstream contacts the network to re-derive it (charter principle 5).

## The vulnerability DB is baked at build, scanned offline at runtime

`apps/runner-scan/Dockerfile` runs `trivy image --download-db-only` at BUILD time — the one place
network is used, the same place cosign/skopeo are vendored. At RUNTIME the runner is launched
`--network none` and `run.sh` passes `--skip-db-update --offline-scan`, so the scanner never phones
home. Refreshing that baked DB across an air-gap boundary (the disconnected commander case) is
increment **13.3b**: trivy-db crosses as a `type: "blob"` artifact on the existing byte channel,
E6-exempt like the SBOM (proposal §13.3).

## Updating the pin

1. Pick the new Trivy release from `github.com/aquasecurity/trivy/releases`.
2. On a connected machine, establish authenticity **by hand** (see "Trust on first vendor").
3. Resolve the **multi-arch index digest** (what the `FROM` uses):
   ```sh
   docker manifest inspect --verbose aquasec/trivy:<version> | jq -r '.Descriptor.digest'
   ```
   and the **linux/amd64 platform** digest (recorded for provenance):
   ```sh
   docker manifest inspect aquasec/trivy:<version> \
     | jq -r '.manifests[] | select(.platform.architecture=="amd64" and .platform.os=="linux") | .digest'
   ```
4. Confirm the flags `run.sh` depends on are still accepted — `trivy image --input --format json
   --skip-db-update --offline-scan --scanners vuln --exit-code 0 --output` — by scanning a local
   OCI layout **behind a closed proxy** (`HTTPS_PROXY=http://127.0.0.1:1`). `unknown flag` is not
   acceptable; deprecation warnings are fine.
5. Update `pin.env` (version, index digest, amd64 digest), then update the `ARG TRIVY_IMAGE`
   default in `apps/runner-scan/Dockerfile`.
6. `pnpm --filter @scp/plugin-managed-scan test` — `pin.test.ts` is the drift gate and will name
   any copy you missed.
