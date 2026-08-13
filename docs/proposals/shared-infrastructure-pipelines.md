# Proposal: where shared infrastructure pipelines live

**Status:** v0.1 Draft — **proposed, pending review.** Nothing built.
**Role:** Answer the owner's question (2026-08-11): the easy pipelines are per-component — application source code (`build`), configuration-as-code (`configuration`), component-specific IaC (`infrastructure`). Where does IaC for **shared** infrastructure go — the cluster, the VPC, the shared message bus — and how does the UI organize it?
**Relates to:** [ADR-0007] (Category facet `build|infrastructure|configuration`), [ADR-0026](adr/0026-placements-and-derived-stage-names.md) (placements, stage names), [ADR-0027](adr/0027-service-rung-binding-resolution.md) / [ADR-0029](adr/0029-containment-ancestor-binding-rung.md) (the containment-ancestor binding ladder), [ADR-0028](adr/0028-stage-scoped-component-coupling.md) (stage-scoped trigger holds), [coupled-pipelines.md](coupled-pipelines.md) (the shipped `provides`/`requires` engine), GLOSSARY §deployment target, PROJECT_CHARTER principles 1, 2, 7.

## 1. The question, sharpened

A pipeline needs three answers: **who owns and releases it** (whose board does it appear on), **what it affects** (blast radius), and **how consumers see it** (attribution in their views). For per-component pipelines all three collapse to the component. Shared infrastructure splits them: a platform team owns the Terraform, but the blast radius is *whatever runs on the thing it stands up* — which crosses services, assemblies, and containment domains.

**The tiers compose per component** (owner, 2026-08-12): not everything runs on a cluster, and a cluster-hosted component may still need its own infra — an S3 bucket, a queue. One component can simultaneously carry its own `infrastructure` pipeline (the bucket), its `build` pipeline, and run on substrate a platform component `manages`. The tiers classify *each piece of infrastructure*, never the component.

The decision rule this proposal reduces to:

> **Ask whose outage it is, and where it bites.** If the infra's consumers are exactly a containment subtree, bind its pipeline at that rung (§2). If its consumers are defined by *placement* — whatever runs THERE — it is a platform component with `manages` edges to the targets it provisions (§3).

## 2. Containment-shaped sharing: bind at the ancestor rung (exists today)

IaC whose consumers coincide with a containment subtree — a service's own namespace, quotas, its dedicated database — binds its `infrastructure` pipeline at that rung. **This already ships**: ADR-0029's nearest-wins ancestor ladder resolves executor bindings component → assembly → service → domain → org, and the service board's Infrastructure tab renders service-rung pipelines. Nothing new is needed except the UI attribution below (§4).

The limit is honest: containment answers *who owns it*. Use this tier exactly when ownership and blast radius are the same subtree. The moment a second service consumes the thing, this tier is the wrong answer — do not "solve" that by promoting the binding to the org rung, which makes ownership a lie (the platform team is not the org) and blast radius invisible (everything under org is "affected").

## 3. Placement-shaped sharing: shared infrastructure is a platform component

**Model the shared thing as a first-class component in a platform service** — `platform-compute/eks-gamma`, `platform-network/vpc-core` — whose only pipeline is `infrastructure`. Shared infrastructure is somebody's application; it deserves what every release unit gets, and gets it for free: changes, waves, gates, freezes, approvals, campaigns, a service board for the platform team, a component journey for each piece of substrate. **Zero new engine machinery** (charter principle 7), and the repo already contains the precedent — M15's outpost-local Harbor/Gitea are exactly platform components in this sense.

The one genuinely new piece is the **link from provider to what it provisions**:

- **New relationship type `manages`** (`from: {component}`, `to: {deployment-target}`) — a registry row, pure data (charter principle 2). `hosted_on`/`deploys_to` point the wrong way (consumer → target); `manages` states provider → target: *this component's IaC stands up and maintains that place.*
- Everything else derives by traversal:
  - **Blast radius:** change on `eks-gamma` → targets it `manages` → placements at those targets → the components and services that actually run there. A named graph query (`substrate-impact-of`, additive) makes it one call, and the Decision for a gate at that change can cite it (principle 6).
  - **Consumer attribution:** a component journey's stage card is already per-deployment-target; one hop over `manages` renders *"substrate managed by platform-compute/eks-gamma"* as a link. The shared pipeline **lives** on the platform team's board and **appears** — as attribution, never as a duplicated lane — in every consumer's journey.

## 4. Ordering between substrate and application — already solved, twice

No new gate is needed to sequence "cluster upgrade before app deploy at gamma":

- **Change-level:** the shipped `provides`/`requires` engine — the cluster-upgrade change `provides k8s-1.31@amer-gamma`; an app change that needs it declares `requires`.
- **Standing, stage-scoped:** ADR-0028's trigger holds — a consumer component declares `depends_on` the platform component, and its deploy at a shared stage is not triggered until the dependency is satisfied *at that stage*, with the three-branch verdict and fail-closed weight semantics that ADR already fixed.

This proposal adds no coupling mechanism; it only gives the existing two a well-named provider to point at.

## 5. UI organization (the owner's actual question)

| Surface | What shows |
|---|---|
| Component journey (consumer) | Infrastructure lane: own pipeline, or *"inherited from ⟨service⟩"* (§2), or *"substrate managed by ⟨platform component⟩"* (§3) — the lane is never an unexplained blank. Stage cards carry the `manages` attribution per target. |
| Service board (platform team) | An ordinary board; the substrate components are rows like any others. |
| Deployment-target detail (inside pipeline views, per the nav decision) | "Managed by" section — the `manages` edge rendered from the target's side. |
| Graph | `manages` edges render like any relationship; `substrate-impact-of` drives a blast-radius view. The platform service gets the same guidon/crate marks as everything else. |

## 6. Not in scope / rejected

- **A new top-level "Infrastructure" area in the nav** — rejected: it would re-split the catalog by Category when the graph already organizes by ownership, and it would have no honest answer for who owns what it lists.
- **Modeling shared infra as a property of the deployment-target** — rejected: targets are not release units; nothing would carry the change/wave/gate lifecycle, which is the whole point of putting IaC under coordination.
- **Federation:** platform services are per-domain like everything else; an outpost's local substrate is outpost-local by construction. No journal changes.

## 7. Build increments (each independently shippable)

1. `manages` relationship type (migration: one registry row) + GLOSSARY entry.
2. `substrate-impact-of` named query (additive).
3. Journey/stage-card attribution + target-detail "Managed by" (UI, SDK already sufficient).
4. Documentation: the §1 decision rule lands in GLOSSARY under *deployment target* and *service*.
