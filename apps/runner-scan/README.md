# scp-runner-scan

The SEPARATE image the `scp-managed-scan` promotion scan step (`packages/plugins/managed-scan`)
launches, one ephemeral single-shot container per artifact per method (ADR-0020 §1, proposal
§13.3, charter's Managed Execution Exception 2026-07-23 amendment): a digest-pinned scanner
toolchain + a minimal shell run shim (`run.sh`), nothing else. No Node app code lives here
(docs/DESIGN.md §3) — the `scpd` image carries no scanner at all; this is the only place `trivy`
exists in the whole system, exactly as `tofu` exists only in `scp-runner-iac`.

Not an npm workspace package — a plain Docker build context.

```
docker build -t scp-runner-scan:dev apps/runner-scan
```

Interface: `docker create --network none scp-runner-scan <trivy>` then `docker cp` the OCI image
layout the SERVER pulled by digest into `/work/image`, `docker start -a`, and `docker cp` the
result back out of `/work/out` — see `run.sh`'s own doc comment for the full per-method contract.
The runner has **no network** (`--network none`); the commander is what pulls the scan subject's
bytes over the allowlisted skopeo channel (ADR-0019 §4) and what parses the result into
`ScanEvidence`. The vulnerability DB is baked in at build time and the scan runs offline
(`--skip-db-update --offline-scan`); cross-air-gap DB refresh is increment 13.3b.

**OpenSCAP is a documented follow-on** (13.3a second half): this increment ships `trivy` only.
`tools/openscap/pin.env` reserves the pin slot; the `oscap` binary and its XCCDF→severity mapping
land with OpenSCAP runner support.
