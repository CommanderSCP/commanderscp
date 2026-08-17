# ADR-0020: First-class commander scanning — the promotion scan step, `scp-managed-scan`, and commander-resident evidence

**Status:** Accepted (owner-decided 2026-07-23; the follow-up ADR the M13 proposal promised at approval)
**Context doc:** [docs/proposals/airgap-cds-validate-promote.md §13.3](../proposals/airgap-cds-validate-promote.md) (the merged decisions record — D1/D2/D5 and the scan-once/temporal-decay rationale this ADR records normatively)
**Relates to:** [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) "Managed Execution Exception" — the **2026-07-23 amendment** enumerating `scp-managed-scan` as a second non-host-reaching managed class (owner-approved, applied in PR #114); [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (scan as boundary authorization — its scan *location* is evolved here; its gate semantics are preserved); [ADR-0010](0010-outpost-local-artifact-infra.md) (receivers-stay-light — preserved; its "scan-at-source = at the origin outpost" reading is evolved); [ADR-0017](0017-ownership-refinement.md) (§2 "the commander does **not** run the scan" — superseded by exactly one step; everything else preserved); [ADR-0015](0015-cosign-cross-boundary-signing.md) (§5 who-signs-what — **untouched**); [ADR-0016](0016-scoped-scan-requirement-policies.md) (the M17.5 requirement resolution the scan step evaluates against — untouched); [ADR-0019](0019-artifact-byte-channel.md) (§4 — the allowlisted byte channel the commander pulls scan subjects over); [ADR-0011](0011-universal-outpost-validation.md) (universal receiver validation — untouched); DESIGN.md §12 (the `scp-managed-iac` runner pattern this mirrors)

## Context

M17.3 E6 hard-refuses any cross-boundary export lacking passing, digest-bound scan evidence — universal and fail-closed, whether or not a scan-requirement policy is bound. Under the model as shipped (ADR-0013, ADR-0017 §2), the only evidence producer was the org's own coordinated pipeline scan step: SCP consumed the verdict and never ran a scanner. The consequence, documented in the M13 proposal: **an org without a pipeline scanner cannot promote across a boundary at all** — the population the charter's Managed Execution Exception exists to serve ends at a `409`.

On 2026-07-23 the owner decided — in writing, recorded in the proposal's Decisions record (D1, D5) — that managed scanning is not a fallback bolted on for that population but **how the commander promotes**: *"the commander is what executes the scans and signatures as part of the promotion process. It would use Trivy, OpenSCAP, and other additional scanning methods provided and assigned an artifact type."* The charter amendment enumerating `scp-managed-scan` was approved the same day and applied to PROJECT_CHARTER.md in PR #114. This ADR records that decision in the form the working conventions require: significant decisions get an ADR after approval.

## Decision

### 1. Managed scanning is a first-class commander service

The commander's promotion process gains a first-class **promotion scan step**, executed **at the commander**:

```
scan (scanners selected per artifact type — scanner registry, §2)
  ──▶ evaluate (vs the M17.5 scan-requirement resolution, ADR-0016)
  ──▶ sign (the promotion manifest, M17.3 E6 — only if scans pass)
  ──▶ export
```

E6's evidence therefore exists **by construction** for every promotion: an org with no pipeline scanner promotes exactly like one with a full CI fleet. The step executes via the charter-enumerated **`scp-managed-scan`**, in the `scp-managed-iac` pattern (DESIGN.md §12): a thin orchestrator plugin behind the standard executor interface, launching ephemeral single-shot runner containers from a **separate `scp-runner-scan` image** carrying digest-pinned Trivy and OpenSCAP (`tools/*/pin.env` vendoring discipline; the scanners exist only in the runner image). Runner egress is `--network none` except an operator-allowlisted registry pull for the subject artifact's bytes — the commander pulls scan subjects **by digest** over the ADR-0019 §4 allowlisted channels; nothing in tenant data steers egress. Credentials are scoped and vaulted; the runner reaches no hosts.

**Org-pipeline scan evidence remains a supported alternate ingress**, consumed identically: where valid org-produced evidence already covers an artifact's digest (the existing `scan-result-control` pull path and report shapes), the promotion scan step consumes it instead of re-producing it. The gates cannot tell the sources apart — M17.5 and E6 are untouched, **zero gate-code changes**.

### 2. The scanner registry — methods assigned to artifact types, as registry data

Scanning methods are **registry data assigned to artifact types** (charter principle 2 — new concepts arrive as relationship/policy/registry data, not new top-level tables). The promotion scan step reads each artifact's type and selects the assigned scanner(s): `trivy` for container and machine images (and, as registry-design headroom, filesystems and OS packages); `openscap` for OS images against assigned SCAP compliance profiles; future scanner plugins slot in as new registry rows. An artifact type with **no** assigned scanner and **no** org-supplied evidence refuses at E6 exactly as today — fail-closed, unchanged.

### 3. Evidence and signing live at the commander — only

Managed-scan evidence is **commander-resident** (owner decision D5): the runner's results land in the commander's Postgres-backed evidence store, and verdicts are parsed there. **Outposts and retrans never store, read, or produce scan evidence.** What travels downstream is the commander's signature — the **transitive proof of scan-pass**: an artifact only carries a valid commander-signed promotion manifest if it passed scans (or was covered by valid org-pipeline evidence) before signing. Receivers validate that signature with the M17.4 machinery they already run; evidence travels nowhere, and there is no Gitea (or any other) prerequisite anywhere for evidence.

### 4. Scan-once = once at the commander, before signing, per promotion journey

"Scan-once" now means **once-at-the-commander-before-signing**. The unit is the **promotion journey**, not the artifact's lifetime: promoting the same artifact again later is a new initial promotion and gets a **fresh scan** against the then-current requirements. No grandfathering of stale artifacts into new journeys; no re-scanning within a journey.

**Why once is the right number — scan results are time-decaying.** New CVEs are published continuously, so an artifact's scan results inevitably worsen over time with no change to the artifact. If every promotion hop re-scanned, outposts farther down the promotion line would systematically face worse results than hops nearer the commander — the deep (air-gapped) end of the chain would be penalized for being far, and a long chain might never promote at all. Scanning and signing once at initial promotion pins the attestation to the moment that matters — *at the time of initial promotion, the artifact passed the then-current requirements* — and signature validation, unlike scan results, **does not decay**. Fairness across the chain, without grandfathering.

**Receivers never re-scan — unchanged.** Retrans and outposts validate signatures (ADR-0011 universal validation; ADR-0010 receivers-stay-light) exactly as before. The retrans profile ships cosign and skopeo only; the `scp-runner-scan` image never lands on a staging node or an outpost.

### 5. What this ADR evolves — and what it explicitly preserves

**Evolved** (marked, not rewritten — the prior ADRs stand as the honest record of the model as it was):

| Prior statement | Evolution (2026-07-23) |
|---|---|
| [ADR-0013](0013-supply-chain-scan-sbom-manifest.md): scan is the coordinated Trivy step at build — the only evidence model | The org-pipeline coordinated step becomes the supported **alternate** ingress; the commander's promotion scan step is the first-class producer. Scan **location** evolves; nothing else in ADR-0013 does |
| [ADR-0010](0010-outpost-local-artifact-infra.md): "scan-at-source" read as *at the origin outpost* | Scan-at-source now means **at the commander, before signing**. ADR-0010's receiver-side half — verify the signature, never re-scan, outposts need no scanning registry — is untouched |
| [ADR-0017 §2](0017-ownership-refinement.md): the commander "consumes the coordinated Trivy step's verdict as gate evidence… It does **not** run the scan" | Superseded by exactly one step: the commander's gate-only role now **includes the promotion scan step**. Build stays devolved to the originating outpost; the commander still never runs build |
| Evidence placement ("reference in, reference out" — SCP holds no evidence bytes) | Managed-scan evidence is **commander-resident** — the commander holds the evidence it itself produces (it is the evidence's origin, not a cache of someone else's bytes). Org-pipeline evidence stays reference + parsed verdict, as today |

**Preserved — explicitly, so no reader over-reads the evolution:**

- **Never-re-scan.** Downstream hops validate signatures; no hop re-scans, same as always.
- **Boundary authorization, not a quality gate** (ADR-0013). Scanning authorizes boundary crossing; domain-local changes that never cross trigger no promotion and no scan. "Default-permissive" describes **adoption** (when a scan is scheduled), never gate-weakening — a cross-boundary promotion always gets the scan step.
- **Gates consume evidence; they never produce it.** The M17.5 six-tier resolution and E6 are byte-for-byte untouched; the governance engines still only evaluate evidence. "SCP never runs Trivy" survives **for the gate** — the charter-enumerated runner is what scans, which is precisely why this took a charter amendment, not a reinterpretation.
- **E6 fail-closed universality.** A missing scan refuses exactly like a failed one, policy bound or not. The promotion scan step adds a way to *satisfy* E6; it adds no way to loosen it.
  > **AMENDED 2026-08-17 — the second sentence is SUPERSEDED by [ADR-0033](0033-scan-exclusions-and-overrides.md).** That ADR deliberately adds a way to loosen: a separately-authorized per-finding **exclusion** dimension, admitted top-down by a monotone AND down the tier chain, applied *before* counting. It was an owner decision, not a regression, and ADR-0033 §9 records the supersession explicitly.
  >
  > **What survives here, unchanged:** *fail-closed universality itself* — a missing scan still refuses exactly like a failed one, and an exclusion cannot manufacture a verdict where no scan ran. What changes is only that a scan's **counted** finding set may now be narrower than what the scanner reported, under authority every tier above has admitted. Read this bullet together with ADR-0033 §2, which is the reason the loosening was built as an exclusion rather than as a waiver on the verdict: a verdict-level waiver would have been **invisible at this very boundary**, because E6 identifies a scan outcome purely by shape.
- **The manifest signing model** ([ADR-0015 §5](0015-cosign-cross-boundary-signing.md)). The executor still cosign-signs artifacts + SBOM at build; the commander still cosign-signs **only its own promotion manifest**. "Executes the signatures as part of the promotion process" is the E6 manifest signing that already ships — what is new is the scan step that authorizes it.

## Charter alignment

- **The Managed Execution Exception, extended by owner sign-off (2026-07-23).** The charter reserved allowlist extension to the owner; that sign-off was given in writing and the amendment applied (PROJECT_CHARTER.md, "Amendment approved 2026-07-23"). `scp-managed-scan` joins small IaC deployments as a **non-host-reaching** enumerated class: standard executor interface, isolated single-shot ephemeral runners from a separate image, scoped vaulted credentials, no host reach, `--network none` except operator-allowlisted registry pulls.
- **"Managed execution is never a default" governs execution of changes.** The managed scanner is **read-only with respect to the scanned subject**: it analyzes artifacts and emits evidence; it never modifies, deploys, or provisions anything, and it executes no change — the amendment says so in terms. Running it as a default step of promotion therefore does not make change-execution a default.
- **Graph-native (principle 2):** the scanner registry is registry rows, not new top-level tables.
- **Postgres-only required dependency (principle 4):** the evidence store is Postgres-backed; no new stateful service.
- **Air-gap first-class (principle 5):** scanners and their data are vendored/pre-loaded; runners scan with DB downloads disabled; the trivy-db is refreshed directly when connected or **operator-loaded** across the CDS when not — the commander has no into-commander byte channel, so the DB never rides the relay/bundle path (proposal §13.3, M13.3b-ii); SCAP content has no OCI upstream and stays baked into the runner image.
- **Explainability (principle 6):** scan verdicts persist as Decisions; a refusing E6 export carries a `decision_id`, unchanged.

## Consequences

**Positive**
- The pipeline-less population the exception exists to serve can promote across boundaries: E6 evidence exists by construction, with zero gate weakening.
- The temporal-decay problem is solved structurally: one scan per journey at the moment of authorization, a non-decaying signature carrying the proof downstream, fresh scans for new journeys.
- Receivers stay exactly as light as ADR-0010/ADR-0004 declared — the evolution adds nothing to any outpost or retrans.
- The evolution surface is minimal and named: scan location and managed-evidence placement. Everything else in ADR-0010/0013/0017 stands.

**Costs / honesty**
- **SCP genuinely executes scans now** — in charter-enumerated, isolated, read-only runners, but genuinely. This is recorded as a charter amendment, not smuggled in as reinterpretation.
- The stale scan-location wording in code comments (`supply-chain.ts:18` "SCP NEVER runs Trivy", `:224-227`, and the receiver-side comments the proposal's census lists) is revised in build increment 13.3a to gate-scoped phrasing; the prior ADRs carry dated evolution markers rather than rewrites.
- Commander-resident evidence is a deliberate, scoped exception to the "reference in, reference out" posture — for evidence the commander itself produces, only.
- Scope at M13 is image-only (container images + machine images, owner decision D2); the registry rows for filesystems/packages are design headroom, and live-host SCAP scanning is out (a different, host-reaching charter conversation).

## Addendum (2026-07-31) — the machine-image method, and the AWS form that did not ship

Two clarifications from building the machine-image arm (13.3a). Neither changes a decision above; both make one of them concrete.

**§2's "`trivy` for container and machine images" is, as built, `trivy` for container images and `trivy-vm` for machine images.** The registry assigns methods per `ExecutorType`, and machine images ride `infrastructure` (D2) — so a *distinct* method is what makes the assignment expressible: `infrastructure -> ["trivy-vm"]` is a statement the registry can make, whereas "run `trivy`, but in vm mode when the subject happens to be a disk" would force the runner to **sniff** the subject and silently pick a scan mode, which is exactly the guess a fail-closed gate must not make. It also keeps the evidence honest: `scanner: "trivy-vm"` asserts "scanned as a VM disk image — partition table, filesystem, OS package DB", a materially different claim from "scanned as a container layer stack", from the same binary against the same DB. The `ScanMethod` widening is additive and gate-invisible, exactly as `openscap`'s was (E6 reads `digestMatch`/`artifactDigest`, never `scanner`). Migration `0048` moves the seeded `infrastructure` assignment onto it, guarded on the `0035` seed value so an operator's own assignment is never overwritten.

**Trivy's `ami:` / `ebs:` AWS API forms are NOT built, and — correcting the proposal — they are not a deferred capability blocked on a charter decision. They are the WRONG SUBJECT for this scan step.** The proposal listed them under "AWS API form when connected"; the reason that never comes due is structural, and it is worth writing down so nobody re-opens it as a feature request:

- **The commander's scan runs on the SOURCE side, before signing** (§4). It never reaches a destination account; a destination-side AMI is not a subject it could scan even in principle.
- **Whatever crosses a CDS crosses as BYTES IN A FILE.** Federation bundles are metadata-only ([ADR-0009](0009-optional-poke-mode-federation.md)); artifact bytes travel separately as operator-loaded media or a signed OCI-layout tarball on the retrans relay ([ADR-0019](0019-artifact-byte-channel.md)). An AMI is an EC2 resource, not bytes — it cannot cross. So a machine image that is going to be promoted across a boundary **has already been exported to a disk file before the commander ever sees it**. The commander is therefore always scanning a disk.
- **Even when a source build lands only as an AMI**, exporting it is a prerequisite of *crossing*, not of *scanning*: scanning the AMI in place and then exporting it yields a different artifact with a different digest, which must be scanned anyway. The in-place scan buys nothing.
- **Independently, an AMI id is a handle, not content.** Every gate in this path is content-addressed — E6's digest binding, the cosign manifest over `artifacts[].digest`, M17.4(a) arrived-set equality, M17.4(b) pre-deploy byte verify. `promotion-scan-step.ts` will not even plan a scan without an `artifact_digest`, and it binds evidence to the digest the server verified on the pull rather than to the scanner's self-report. There is nothing for `digestMatch` to mean for an `ami:` subject short of materializing and hashing the bytes — at which point one has a disk artifact and the shipped path already applies.

The charter objections to an AWS-form scan are real but **secondary, and never reached**: it would need scanner-initiated egress from a `--network none` container, and cloud-provider credentials mounted into the very process that parses untrusted filesystem images ([ADR-0019](0019-artifact-byte-channel.md) §3's artifact-store class covers registry read/push, not cloud IAM). Recorded here so the argument is not lost, but the disposition rests on the structural point above, not on this.

**Explicitly rejected, so the cheap version is not rebuilt later:** passing `ami:`/`ebs:` through to the runner with vaulted AWS credentials and an egress allowlist. It is the smallest build of the three and the worst: it breaks `--network none`, lets tenant-authored `sourceRef` steer egress, co-locates live cloud credentials with Trivy's ext4/VMDK parsers, and still produces no digest binding. If AMI-in-place scanning is ever genuinely wanted, the only acceptable shape is server-side materialization (read the snapshot blocks server-side, assemble and HASH the disk, hand it to the unchanged networkless runner) — which is, by construction, the disk-artifact path with extra steps.

**Out of scope here, and tracked separately:** publishing a promoted disk image *as* an AMI in a destination account, and what happens to the transitivity of the commander's signature when an image is modified after it crosses (baking in air-gap-local crypto, say). Both are destination-side, executor-shaped concerns rather than commander-scan concerns — see [docs/proposals/machine-image-publication.md](../proposals/machine-image-publication.md).
