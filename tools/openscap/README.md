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
| oscap version | **1.4.0** (`oscap --version`) — installed from the Fedora GA **frozen** release repo, **fail-closed asserted** at build (not the rolling `updates` repo) |
| SSG content version | **0.1.74** (`scap-security-guide`, same frozen release repo) |
| Image ref (**what the runner's FINAL stage builds FROM**) | `fedora@sha256:f1a3fab47bcb3c3ddf3135d5ee7ba8b7b25f2e809a47440936212a3a50957f3d` — the **multi-arch index (manifest-list) digest** for Fedora 41 |
| linux/amd64 platform digest (production runner arch, provenance + drift-asserted) | `sha256:68bb1ba893be0c05991b2df55bc6571862bab7526fd6053b1ebacd53a2a75366` |
| Install repo (frozen snapshot; `--disablerepo=* --enablerepo=fedora`) | `fedora` (Fedora 41 GA release tree — immutable) |
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

## Content-addressed install — frozen GA repo + fail-closed version assertion

The **Fedora image is digest-pinned** AND `oscap` + SSG are installed **only from the frozen Fedora
GA release repo** (`--disablerepo=* --enablerepo=fedora` in the Dockerfile) — an immutable snapshot
Fedora never republishes into — **not** the rolling `updates`/`updates-testing` repos. Installing
from those rolling repos is what previously made the exact tool version *float* at build time (the
repo served whatever was latest); scoping the install to the GA release tree makes the oscap + SSG
versions **reproducible from the pin**. The build then **asserts the exact version fail-closed**:

```dockerfile
RUN dnf install -y --disablerepo="*" --enablerepo=fedora openscap-scanner scap-security-guide ... \
 && oscap --version | grep -qF "(oscap) ${OPENSCAP_PINNED_VERSION}" \
 && ...
```

so a version mismatch **fails the build loudly** rather than merely checking that oscap runs — the
same content-addressed discipline the Trivy/cosign/skopeo pins already enforce.
`packages/plugins/managed-scan/src/pin.test.ts` gates all of this: the `ARG OPENSCAP_PINNED_VERSION`
default must equal `OPENSCAP_PINNED_VERSION`, the fail-closed `grep -qF` assertion must be present,
and the install must be scoped to the frozen repo (no floating default set).

A *fully* offline, sha256-per-RPM mirror of the closure **and** the SCAP-content `type: "blob"`
cross-boundary transport is **13.3b part 2** — a disconnected build host still needs a local mirror
of the Fedora GA release tree until then; the reproducibility guarantee here is the frozen GA
snapshot plus the fail-closed version assertion.

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
4. Determine the oscap + SSG versions the new base's **frozen GA release repo** serves (query the
   release repo with the rolling repos disabled — the versions the Dockerfile install will resolve):
   ```sh
   docker run --rm fedora@<newdigest> \
     dnf -q --disablerepo=updates --disablerepo=updates-testing \
       list openscap-scanner scap-security-guide
   ```
   and update `OPENSCAP_PINNED_VERSION` + `OPENSCAP_SSG_VERSION` to those exact versions.
5. Update `pin.env` (all keys) and this table; `apps/runner-scan/Dockerfile`'s `ARG OPENSCAP_IMAGE`
   default must match `OPENSCAP_PINNED_IMAGE` and its `ARG OPENSCAP_PINNED_VERSION` default must match
   `OPENSCAP_PINNED_VERSION` (the drift test enforces both, plus the fail-closed `grep -qF` assertion
   and the frozen-repo scoping).
6. `pnpm --filter @scp/plugin-managed-scan test` — `pin.test.ts` is the drift gate and will name any
   copy you missed.
