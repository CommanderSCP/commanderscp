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
- **The manifest signing model** ([ADR-0015 §5](0015-cosign-cross-boundary-signing.md)). The executor still cosign-signs artifacts + SBOM at build; the commander still cosign-signs **only its own promotion manifest**. "Executes the signatures as part of the promotion process" is the E6 manifest signing that already ships — what is new is the scan step that authorizes it.

## Charter alignment

- **The Managed Execution Exception, extended by owner sign-off (2026-07-23).** The charter reserved allowlist extension to the owner; that sign-off was given in writing and the amendment applied (PROJECT_CHARTER.md, "Amendment approved 2026-07-23"). `scp-managed-scan` joins small IaC deployments as a **non-host-reaching** enumerated class: standard executor interface, isolated single-shot ephemeral runners from a separate image, scoped vaulted credentials, no host reach, `--network none` except operator-allowlisted registry pulls.
- **"Managed execution is never a default" governs execution of changes.** The managed scanner is **read-only with respect to the scanned subject**: it analyzes artifacts and emits evidence; it never modifies, deploys, or provisions anything, and it executes no change — the amendment says so in terms. Running it as a default step of promotion therefore does not make change-execution a default.
- **Graph-native (principle 2):** the scanner registry is registry rows, not new top-level tables.
- **Postgres-only required dependency (principle 4):** the evidence store is Postgres-backed; no new stateful service.
- **Air-gap first-class (principle 5):** scanners and their data are vendored/pre-loaded; runners scan with DB downloads disabled; offline scanner data (trivy-db, SCAP content) crosses boundaries as `type: "blob"` artifacts on the existing byte channel (proposal §13.3).
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
