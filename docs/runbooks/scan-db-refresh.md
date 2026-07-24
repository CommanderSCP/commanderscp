# Runbook — refreshing the commander's managed-scan vulnerability DB

**Scope:** the commander's **managed-scan** promotion scan step (ADR-0020, proposal §13.3) runs the
`scp-runner-scan` container `--network none`. Its Trivy vulnerability DB is either **baked** into the
runner image at build time (the fail-closed fallback, as stale as the image) or **pre-loaded** from a
server-maintained cache (`SCP_MANAGED_SCAN_DB_CACHE`, a PVC in Helm) that the operator keeps fresh.
This runbook is how the operator keeps it fresh — in **two** modes — plus how staleness is surfaced,
the schema-compat gate, and the trivy-db/SSG asymmetry.

> **Owner decisions recorded here (2026-07-24):** operator-loaded air-gap refresh (the commander has
> no into-commander byte channel); a commander-level staleness policy ("a company applies their own
> rules"); a dedicated cache PVC + the baked fallback; operator-invoked (never automatic) refresh; the
> trivy-db/SSG asymmetry.

## What the runner consumes, and when it fails closed

- **No cache configured** (`SCP_MANAGED_SCAN_DB_CACHE` unset) → the runner uses the **image-baked**
  DB. No staleness gate (it is as stale as the image). This is the zero-config single-container/dev
  default.
- **Cache configured** → the commander classifies the cached DB **before** every managed scan against
  the instance **staleness policy** and the pinned Trivy's **schema version**:
  - **missing / empty / corrupt / unreadable-metadata / wrong schema** → **FAIL CLOSED**: no scan →
    no evidence → E6 refuses the promotion, and the block Decision names the reason.
  - **age > hard max** → **FAIL CLOSED** (same).
  - **age > soft max** → **WARN**: the scan still runs, and the warning is surfaced on the
    `ScanEvidence` (`scanDbStaleness: "warn"`, `scanDbThresholdFired: "soft"`) and in the Decision.
  - **fresh** → scans normally.
- Either way the runner runs **offline** (`--skip-db-update --offline-scan`, container `--network
  none`). The pre-load only changes **which** already-downloaded DB Trivy reads — never whether it
  dials out.

The DB **source** (`baked` | `refreshed` | `operator-loaded` | `absent`) is surfaced on the evidence
(`scanDbSource`) and on `scp scan-db status`.

## Configure the staleness policy (commander-level, runtime, no redeploy)

The soft/hard bounds are an **instance-scoped** setting (modeled on M17.5's `scan_requirement_floors`
— tenant-readable, operator-writable). Defaults when unset: **soft 7d, hard 30d**.

```sh
# READ (any authenticated principal):
scp scan-db staleness-policy get

# WRITE (operator only — needs SCP_OPERATOR_TOKEN; omit a bound to reset it to the built-in default):
SCP_OPERATOR_TOKEN=… scp scan-db staleness-policy set --soft-max-age-hours 168 --hard-max-age-hours 720
```

## Mode 1 — CONNECTED refresh (operator-invoked skopeo pull)

For a commander that can reach the upstream OCI registry. Pulls `ghcr.io/aquasec/trivy-db` into the
cache under the `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` allowlist (ADR-0019 §4), **atomic-swaps** it in (no
torn read during a concurrent scan), and **asserts the DB schema** the pinned Trivy can read
(`tools/trivy/pin.env` `TRIVY_DB_SCHEMA_VERSION`) — a DB a newer Trivy built that the pinned binary
cannot read is **refused**, no cache write.

```sh
# Ensure the upstream host is allowlisted:
#   SCP_ARTIFACT_OCI_REGISTRY_HOSTS=ghcr.io[,…]
SCP_OPERATOR_TOKEN=… scp scan-db refresh
scp scan-db status      # confirm source=refreshed, a fresh age, schemaCompatible=true
```

## Mode 2 — AIR-GAP operator-load (no into-commander channel)

A disconnected commander sits at the **top** of the federation with **no** into-commander byte channel
(the relay flows downward + change-bound; `.scpbundle` is metadata-only, ADR-0009), so it cannot
*receive* a DB over the promotion channel. The operator instead **produces a signed DB blob at the
connected side, walks it across the CDS, and loads it** — verified before it is accepted.

**At the connected side** (produce the signed blob — the SAME `type:"blob"` shape both modes use):

```sh
# 1. Pull the upstream DB into a Trivy --cache-dir layout (cache/db/{trivy.db,metadata.json}):
skopeo copy docker://ghcr.io/aquasec/trivy-db:2 dir:/tmp/trivydb
#    …extract the layer so you have cache/db/trivy.db + cache/db/metadata.json (see refresh internals),
#    OR copy them out of a built scp-runner-scan image (/root/.cache/trivy).
# 2. Package the db/ dir as a blob and cosign-sign it (detached, offline — no Rekor):
tar -czf trivy-db.blob -C /path/to/cache db
cosign sign-blob --key cosign.key --tlog-upload=false --output-signature trivy-db.blob.sig --yes trivy-db.blob
#    Distribute cosign.pub alongside — it is not a secret.
```

**Walk `trivy-db.blob`, `trivy-db.blob.sig`, and `cosign.pub` across the CDS**, place them on a path
the commander can read (e.g. a mounted volume).

**At the air-gapped commander** (verify + load — digest-bound + detached-signature, atomic swap,
schema-compat asserted; a tampered/wrong-key blob is **refused with no cache write**):

```sh
SCP_OPERATOR_TOKEN=… scp scan-db load \
  --file   /mnt/transfer/trivy-db.blob \
  --sig    /mnt/transfer/trivy-db.blob.sig \
  --pubkey /mnt/transfer/cosign.pub \
  [--digest sha256:<hex>]           # optional cross-check that the bytes hash to this
scp scan-db status                  # confirm source=operator-loaded, a fresh age
```

Paths are **server-local** (operator-token gated) so a multi-hundred-MB DB never traverses the JSON
API — the operator placed the bytes after carrying them across the boundary.

## The trivy-db / SSG (OpenSCAP) asymmetry

Only the **trivy-db** has an OCI upstream to skopeo-refresh / repackage-as-blob. The **SCAP Security
Guide** datastreams OpenSCAP evaluates against have **no OCI upstream**, so they stay **baked** into
the runner image (installed from the frozen Fedora GA release repo at a pinned version — see
`apps/runner-scan/Dockerfile`). The runner honors an **optional** operator-supplied SCAP override dir
(`SCP_SCAN_SCAP_DIR`, copied to `/work/scap`) for a hand-carried datastream, but there is no
refresh/load flow for SSG: to move SSG content forward you rebuild (and re-pin) the runner image. The
staleness policy applies to the trivy-db only.

## Verifying

- `scp scan-db status` — presence, age, source, schema compatibility, staleness, active thresholds.
- The block Decision on a fail-closed promotion cites the exact reason (missing/corrupt/hard-stale).
- A warn-age scan still exports; its `ScanEvidence.scanDbStaleness` is `warn` and the deposited
  `control_runs.detail` carries a `scan DB WARN` note.
