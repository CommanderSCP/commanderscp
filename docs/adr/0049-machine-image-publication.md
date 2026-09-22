# ADR-0049: Machine-image publication runs as managed IaC, and the destination need not be a cloud

**Status:** Accepted (owner rulings 2026-09-22)
**Context doc:** [docs/proposals/machine-image-publication.md](../proposals/machine-image-publication.md) (Draft, proposed 2026-07-31; §4 asked five questions, four of which these rulings answer and one of which events answered)
**Relates to:** [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) "Managed Execution Exception" (2026-07-08 amendment — the non-host-reaching managed IaC class); [ADR-0020](0020-first-class-commander-scanning.md) (why `trivy vm ami:` is the wrong subject); [ADR-0045](0045-artifact-object-type.md) D4 (`derived_from`); [ADR-0019](0019-artifact-byte-channel.md) §3 (artifact-store credential class); [ADR-0012](0012-registry-consolidation.md) (the outpost-local registry the bytes land in); [ADR-0017](0017-ownership-refinement.md) (build devolution); [ADR-0003](0003-internal-egress-for-execution-systems.md) (the two-layer egress model)

## Context

M13.3a closed the machine-image scan arm without solving two destination-side problems the owner
raised: an artifact that crosses a boundary as *bytes* is not yet a bootable image **option** in the
destination (an AMI has to be registered), and an image routinely gets **modified after it crosses**
(baking in crypto once it is inside the air-gapped environment), which breaks the chain from the
commander's signature to the thing that actually boots.

The proposal deliberately left five questions for the owner rather than assuming answers. Four are
ruled below. The fifth — *"is `derived_from` worth building on its own, ahead of publication?"* — was
**answered by events**: it shipped with the artifact object type (migration `0095_artifact_object_type.sql`,
ADR-0045 D4, federation tests asserting the `artifact -> artifact` many-to-one registration). The
provenance half of the proposal is therefore already in place, and publication is what remains.

## Decision

**1. Publication runs through `scp-managed-iac`, inside the existing Managed Execution Exception —
no new charter paragraph.** Registering an image in a destination is read as *"small
Infrastructure-as-Code deployments"*, the non-host-reaching managed class of the 2026-07-08
amendment: it is a cloud-API (or hypervisor-API) call made by the isolated runner holding scoped,
vaulted credentials, and it reaches **no host**. It therefore inherits that amendment's four written
constraints unchanged — standard executor interface, isolated runner, scoped vaulted credentials,
coordination and execution architecturally separate.

The charter says extending the class allowlist requires owner sign-off. This is recorded as an
**interpretation of the existing class, not an extension of it** — and the owner's sign-off on that
reading is what this ADR is. The distinction that keeps it honest: publication never acquires host
login-grade credentials and never opens a network path to a host, which is exactly the line the
2026-07-12 host-reaching amendment draws around the *other* managed classes.

**2. The destination is NOT assumed to be a cloud.** The model is shaped from the outset to include
air-gapped and on-prem destinations — vSphere, bare metal, a local hypervisor — alongside AWS. This
is a deliberate cost accepted up front, because the alternative calcifies the design around AMI
semantics and the air-gap case is the one CommanderSCP exists for.

Concretely, no part of the contract may assume: an account, a region, a public API endpoint, or an
online credential exchange. A destination is a *capability* ("can turn these bytes into a bootable
option, and can tell me what it called the result"), not a cloud SDK. The AWS AMI case is **one
implementation of that seam, built first**, and the seam is judged by whether a second,
fundamentally different destination fits it without reshaping.

**3. A publishing executor's egress allowlist is a deployment-level operator setting, not a property
of the executor binding.** The binding is more expressive, but it is data a tenant can author, and
ADR-0003 is explicit that security must not rest on who may write a graph property. The allowlist is
what stops a publishing executor reaching a destination nobody authorized, so it lives with every
other egress surface in the chart, under operator control. Consistency is the secondary argument;
the primary one is that the boundary must not be tenant-writable.

**4. `derived_from` is not re-litigated.** It exists. Destination-side modification records a
`derived_from` edge from the modified artifact to the commander-attested base, which is what makes
the proposal's third provenance question — *"if the base is later found vulnerable, which
destination-published images inherit the finding?"* — answerable by graph traversal rather than
unanswerable.

## Consequences

- **No charter amendment is needed**, and the reason is recorded rather than assumed: publication is
  host-free. If a future publication path ever needs to reach a host, that is a different class and
  the 2026-07-12 amendment's enumerated list governs it.
- **The destination seam is the load-bearing design risk.** Shaping for vSphere/bare-metal alongside
  AWS costs more up front and is the explicit trade the owner chose. The seam should be built with a
  non-AWS destination in view from the first increment, not retrofitted — otherwise decision 2 is
  words rather than architecture.
- **Air-gapped destinations may have no API at all.** "Publish" there can degrade to *land the bytes
  where the hypervisor reads them and record what it was called*. The contract must express that
  without pretending an API call happened, which means the result of a publication is an **observed,
  recorded destination identifier**, never an assumed one.
- **The egress ruling removes a surface before it is built.** No `egressAllowlist` field appears on
  the publishing executor's binding config; attempting to add one later is a decision to revisit this
  ADR, not an implementation detail.
- The proposal moves from Draft to **Accepted-in-part**: §4's questions 1, 2, 4 and 5 are settled
  here (4 by decision 1 — a host-free managed class needs no bundled-backend role-matrix change), and
  question 3 is settled by `derived_from` having shipped. What remains is the build, not the design.
