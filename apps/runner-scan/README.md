# scp-runner-scan

The SEPARATE image the `scp-managed-scan` promotion scan step (`packages/plugins/managed-scan`)
launches, one ephemeral single-shot container per artifact per method (ADR-0020 §1, proposal
§13.3, charter's Managed Execution Exception 2026-07-23 amendment): a digest-pinned scanner
toolchain + a minimal shell run shim (`run.sh`), nothing else. No Node app code lives here
(docs/DESIGN.md §3) — the `scpd` image carries no scanner at all; this is the only place `trivy`
and `oscap` exist in the whole system, exactly as `tofu` exists only in `scp-runner-iac`.

Not an npm workspace package — a plain Docker build context.

```
docker build -t scp-runner-scan:dev apps/runner-scan
```

## Two scanners, two supply chains

- **Trivy** (vulnerabilities) — the static binary + the build-time-baked vulnerability DB are
  `COPY --from` a digest-pinned Trivy stage (`tools/trivy/pin.env`). The image no longer builds
  `FROM` Trivy's Alpine base — see below.
- **OpenSCAP** (compliance) — the FINAL base is a digest-pinned Fedora image (`tools/openscap/pin.env`)
  carrying `oscap` (openscap-scanner) + the SCAP Security Guide datastreams (scap-security-guide) at
  `/usr/share/xml/scap/ssg/content/` (`ssg-<os>-ds.xml`). Fedora, not Alpine, because `oscap` + its
  OVAL/SCE probes + SSG content are glibc-linked — Alpine is an `ldd` nightmare.

## Interface

`docker create --network none scp-runner-scan <method> [profile] [datastream]` then `docker cp` the
OCI image layout the SERVER pulled by digest into `/work/image`, `docker start -a`, and `docker cp`
the result back out of `/work/out` — see `run.sh`'s own doc comment for the full per-method
contract. Methods:

- `trivy` — scans the OCI layout at `/work/image`, emits `/work/out/result.json`.
- `openscap` — extracts `/work/image` into a rootfs and runs `oscap xccdf eval` (`OSCAP_PROBE_ROOT`)
  against the given SSG `datastream` + XCCDF `profile`, emitting `/work/out/arf.xml`. `profile`
  defaults to the SSG `standard` profile and `datastream` to `ssg-fedora-ds.xml` when omitted.

The runner has **no network** (`--network none`); the commander is what pulls the scan subject's
bytes over the allowlisted skopeo channel (ADR-0019 §4) and what parses the result into
`ScanEvidence` (`parseTrivyResult` / `parseOscapResult`, `promotion-scan-step.ts`). Both scanners'
data is baked in at build time and each scan runs offline (Trivy `--skip-db-update --offline-scan`;
`oscap` against a local datastream). Cross-air-gap TRANSPORT of the baked Trivy DB / SCAP content
onto a disconnected commander (the `type: "blob"` channel + refresh runbook) is increment
**13.3b part 2**; this increment keeps the build-time bake.
