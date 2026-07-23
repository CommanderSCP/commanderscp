# tools/openscap

Not an npm workspace package — the **provenance record for the pinned OpenSCAP base image** the
M13.3b `scp-runner-scan` image (`apps/runner-scan/Dockerfile`) builds its FINAL stage `FROM`, plus
the single source of truth every consumer reads.

- `pin.env` — the pin itself (version, upstream repo, image digests), shell-sourceable.
  `apps/runner-scan/Dockerfile`'s `ARG OPENSCAP_IMAGE` default carries a copy of
  `OPENSCAP_PINNED_IMAGE`; `packages/plugins/managed-scan/src/pin.test.ts` fails if that copy drifts
  from this file (and fails closed if it is left as the empty stub).

## What is pinned

| | |
|---|---|
| Tool | [OpenSCAP](https://github.com/OpenSCAP/openscap) (`oscap`) + [SCAP Security Guide](https://github.com/ComplianceAsCode/content) datastreams |
| Version | **oscap 1.4.2** (`oscap --version`), from the pinned Fedora base's default repos at build time |
| Image ref (**what the runner's FINAL stage builds FROM**) | `fedora@sha256:f1a3fab47bcb3c3ddf3135d5ee7ba8b7b25f2e809a47440936212a3a50957f3d` — the **multi-arch index (manifest-list) digest** for Fedora 41 |
| linux/amd64 platform digest (production runner arch, provenance + drift-asserted) | `sha256:68bb1ba893be0c05991b2df55bc6571862bab7526fd6053b1ebacd53a2a75366` |
| SCAP content path | `/usr/share/xml/scap/ssg/content/` (`ssg-<os>-ds.xml` datastreams — e.g. `ssg-debian11-ds.xml`, `ssg-ol8-ds.xml`, `ssg-fedora-ds.xml`) |
| License | LGPL-2.1 (openscap) / BSD-3-Clause (SSG content) |

## Why a Fedora base (not a vendored binary like cosign/skopeo/trivy)

`cosign`/`skopeo` vendor a single **binary** copied out of an image that is never executed; the
Trivy stage likewise hands only its **static binary + baked DB** into the final image. `oscap`
cannot be treated that way: it needs its OVAL/SCE probe binaries **and** the SSG datastream content
present and **glibc-linked** — building it FROM Trivy's Alpine base is an `ldd` nightmare. So the
`scp-runner-scan` FINAL base is a digest-pinned Fedora image carrying `oscap` + SSG, and the Trivy
binary + baked DB are `COPY --from` the pinned Trivy stage into it.

## Why the INDEX digest, not the amd64 PLATFORM digest

Same rationale as `tools/trivy`: `scp-runner-scan` is **executed** as an ephemeral runner (like
`scp-runner-iac`), so the `FROM` pins the multi-arch **index** digest — content-addressed and
reproducible, resolving to the build host's architecture (amd64 in production, arm64 on an arm
dev/CI host) with no emulation. The linux/amd64 platform digest is recorded for provenance and
asserted by the drift test as the production target arch.

## HONEST LIMITATION — build-time package install (13.3b part 1)

The **Fedora image is digest-pinned**, but `oscap` + SSG are `dnf install`ed from that base's
default repos at build time, so the exact **package** versions track those repos rather than a
content-addressed pin. `OPENSCAP_PINNED_VERSION` records the oscap version the base serves as of
this pin; the Dockerfile asserts `oscap --version` **succeeds** at build (failing loudly if the
toolchain is broken) but does not assert an exact version (which would break the build on every
upstream repo refresh). Fully offline package vendoring / exact-version pinning **and** the SCAP
content `type: "blob"` cross-boundary transport is **13.3b part 2** — deliberately out of scope for
this increment, which keeps the build-time bake. A disconnected build host therefore needs a local
mirror of the Fedora + Trivy sources until part 2 lands.

## Trust on first vendor (read this before updating the pin)

Same shape as `tools/cosign`/`tools/trivy`: authenticity is established **once, by a human, at
vendor time**, from a connected machine, and then **frozen as a digest**. Every later fetch is
content-addressed against that digest.

## How `oscap` scans a container image (offline)

`oscap` cannot read an OCI layout directly. `run.sh`'s `openscap` arm resolves the image manifest
from the docker-cp'd OCI layout (`index.json` → the manifest carrying `.layers`), untars the layers
into a rootfs, and runs `oscap xccdf eval` with `OSCAP_PROBE_ROOT` pointed at that rootfs (the same
offline mechanism `oscap-podman`/`oscap-docker` use under the hood) against a **local** SSG
datastream — no network. The XCCDF/ARF result is parsed at the commander (`parseOscapResult`,
`promotion-scan-step.ts`): failed rule-results are counted by XCCDF severity into the four
`ScanSeverityCounts` (high→high, medium→medium, low→low; XCCDF has no `critical` → 0; unknown/unset
fold away).

## Updating the pin

1. Pick the new Fedora release.
2. On a connected machine, establish authenticity **by hand** (see "Trust on first vendor").
3. Resolve the **multi-arch index digest** (what the `FROM` uses) and the **linux/amd64 platform**
   digest (recorded for provenance):
   ```sh
   docker pull fedora:<version>                       # prints the index (manifest-list) digest
   docker manifest inspect fedora:<version> \
     | jq -r '.manifests[] | select(.platform.architecture=="amd64" and .platform.os=="linux") | .digest'
   ```
4. Confirm `oscap --version` and the SSG content path inside a throwaway build, and update
   `OPENSCAP_PINNED_VERSION` to the reported version.
5. Update `pin.env` (all keys) and this table; `apps/runner-scan/Dockerfile`'s `ARG OPENSCAP_IMAGE`
   default must match `OPENSCAP_PINNED_IMAGE` (the drift test enforces it).
