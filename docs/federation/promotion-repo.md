# promotion-repo

Reference for `apps/server/src/federation/promotion-repo.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 25 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. M17.3 (E6) EXPORT SCAN GATE

M17.3 (E6) EXPORT SCAN GATE — the boundary re-check (defense in depth). For EACH SUBSTANTIVE artifact (everything in `artifacts[]` EXCEPT `type: "blob"` — the SBOM is the scan's OUTPUT, not a scanned input, so it is EXEMPT) there MUST exist a CURRENT, digest-bound, floor-satisfying scan outcome from an ADMITTED PRODUCER, judged under the scan-exclusion set that is in force NOW. This is UNIVERSAL and fail-closed: a MISSING scan refuses exactly like a FAILED one, whether or not a scan-requirement policy was ever bound. This NEVER runs a scan (coordinate-not-execute) — it only re-verifies an outcome an execution system already produced.

THE RULE ITSELF LIVES IN `scan-evidence.ts`, shared with the promotion scan step's short-circuit. Its module doc records the four properties that changed here and why each was an authorization defect: a scan outcome was identified by the SHAPE of its evidence (which `webhook-control` echoes verbatim from an operator-configured URL, so a tenant could manufacture one), any HISTORICAL passing row satisfied the gate forever, the gate applied no threshold of its own, and (M22.9) a passing row kept authorizing crossings under an exclusion set that had since been withdrawn.

Takes the RAW `control_runs` rows, not the bundle's `controlOutcomes` projection. The projection drops `plugin_module`, `control_object_id` and `created_at` — which are exactly producer identity and recency — and it is IN the Ed25519 checksum payload (`promotionChecksumPayload`), so widening it to carry them would change every bundle's checksum and break verification at every peer. The gate reads the rows; the bundle keeps its shape byte-for-byte.

## §2. M17.3 (E6) EXPORT SCAN GATE

M17.3 (E6) EXPORT SCAN GATE — HARD-REFUSE, fail-closed. The SBOM (`type: "blob"`) is EXEMPT (it is the scan's output). EDGE CASE: a promotion carrying NO substantive artifact has nothing to scan, so the gate passes VACUOUSLY — a metadata-only promotion (config/policy-only, no oci/rpm/deb/npm/config/infra content) still exports (and still carries a signed manifest over an empty artifact set). "Every substantive artifact is scanned" is trivially true of zero. THE SUBSTANTIVE SET IS NOT FILTERED HERE — `substantiveArtifactsOf` is the ONE definition, shared with the component pipeline tile's read-only re-run of this same gate. It excludes the SBOM blob (the scan's output) and the change's DECLARED test bundle (D23: signature-verified per hop, never scanned — scan stays image-only per M13). See that function's doc for why the bundle exclusion is keyed on the digest the change declared rather than on a type or a name.

## §3. Import a Promotion Bundle

Import a Promotion Bundle. Takes a `Db` (not a single `TenantTx`) because M17.4(a)'s manifest verification runs a cosign `verify-blob` SUBPROCESS, and the codebase forbids holding a pooled connection open across a cosign subprocess (`exportPromotionBundle` splits phases for exactly this reason). Three phases around the out-of-tx subprocess: 1. tx: address-to-self + resolve exporter peer + Ed25519 checksum/signature gate + resolve the peer's cosign pubkey. (No cosign subprocess yet — pure DB.) 2. NO tx: M17.4(a) `verifyPromotionManifest` — the cosign subprocess + set/tie/self-binding/ downgrade checks. On failure, persist a `block` Decision + hash-chained audit event in a fresh tx and throw a 409 carrying `decision_id` (mirrors the export gate — DESIGN §6/§10.4). 3. tx: apply — propose the local Change, attach approval evidence, record the transfer.
