# Proposal: the Outpost UI — a domain workbench and a setup lane, differentiated by data, never by role

**Status:** v0.2 — **owner decisions recorded 2026-08-13** (§8): setup surface = both (in-place affordances + setup landing); subdomains = **nested containment domains now** (overriding this proposal's §5 deferral recommendation — the owner chose (b)); sequencing = both lanes in one round, A3 accepted. Implementation proceeding on the ui-review branch.
**Role:** Answer the owner's ask (2026-08-13): an Outpost UI for (a) domain-specific tasks the commander doesn't need to know about — the headline case being domain-specific configuration changes for services — and (b) domain-specific outpost setup — importing and deploying to targets. "Stood up by the Outpost itself, not the Commander (except for the case where Commander and Outpost are one and the same, though still different subdomains)."
**Relates to:** [ADR-0022](../adr/0022-outpost-config-authority-split.md) (the config-authority split this completes the outpost side of), [ADR-0031](../adr/0031-domain-local-objects-never-federate.md) + §6a/M20.5 (domain-local objects and subtree locality — the mechanism the workbench operates), [ADR-0030](../adr/0030-dev-branch-pipelines.md) (`ref_pattern`/`classification` on source mappings), [ADR-0011](../adr/0011-universal-outpost-validation.md), [ADR-0010](../adr/0010-outpost-local-artifact-infra.md) (M15 outpost-local Gitea/Harbor), M16.3 (outpost-local UI + write-control census), Mode A P1–P5 (`/connect/argocd`), [GLOSSARY](../GLOSSARY.md) (the six senses of "domain"), charter principles 2, 3, 6, 7.

## 1. The finding that shapes everything: the Outpost UI already exists as a mechanism

Measured at HEAD (grounding sweep, 2026-08-13, six lenses; citations throughout):

- **An outpost serves the entire SPA, standalone.** One binary, one universal `apps/web/dist` bundle; `outpost-local-ui.integration.test.ts` (M16.3 P1) pins that an outpost-role instance serves the SPA, deep links, and its own API with zero commander dependency. The only role branch in serving is total: `role: retrans` gets no SPA at all (`app.ts:271`).
- **Domain-local work already renders natively at the outpost.** A domain-local component's change never journals at any lifecycle point (every writer gated on `!domainLocal`, pinned by `domain-local-invisibility.integration.test.ts`), and `change-detail.tsx` / `change-pipeline.tsx` render its full lifecycle from one local read (`GET /changes/{id}/explain`).
- **The commander-side UI already correctly excludes all of it.** ADR-0022's pages (`outpost-settings.tsx`, `outpost-configuration.tsx`) author only the two commander-owned facts (trust tier, poke mode) and render everything outpost-owned read-only with a "configured at the outpost" note.

So "an Outpost UI" is **not a new app, bundle, nav, or mode**. What is missing is narrower and better: the **authoring surfaces** for the workflows an outpost operator actually performs. Today those workflows dead-end into the CLI at precisely measured points (§3–§4). The Outpost UI is the completion of those surfaces — served, like everything, by every instance.

## 2. The principle: differentiate by data, never by role

Three precedents in this repo already decide the architectural question, and this proposal follows them rather than relitigating:

1. **M16.3 P2's write-control census**: the first cut gated UI controls on an unmeasured role/origin claim; for half of them the claim was false and the gating broke a documented workflow. The standing rule since: the UI does not pre-block on a guess — it offers the write and renders the server's refusal (`409` + `decision_id`).
2. **ADR-0031**: the commander's UI never needed a "hide domain-local" mode because the object never arrives — *"that absence is the guarantee."* No conditional rendering anywhere.
3. **BUILD_AND_TEST.md:703**: the explicit precedent against role-gated views; `SCP_FEDERATION_ROLE` gates exactly one thing (retrans SPA withholding) and `federation_self.role` is advisory — server logic never compares either against `commander`/`outpost` (measured; the two axes are never even cross-checked).

**Why this dissolves the owner's colocated case.** If the commander and an outpost are one instance, a role-gated UI would have to answer "which mode is this?" — and any answer would be wrong half the time. A data-driven UI has no such question: every surface in §3–§4 keys on what exists (a domain-local subtree, an unplaced component, a discovery result awaiting acceptance), so the same instance serving both duties simply shows both kinds of work. The "different subdomains" half of the ask is then a *scoping* question (§5), not a UI-mode question.

The one honesty correction this forces (measured, lens 5): `domain-local.tsx`'s comment asserts "the commander's UI simply never receives a domain-local object" as if it were a guarantee. It is a **topology assumption** — ADR-0031 owner Q5 makes locality declarable on any instance in any role, so a commander-role org's own domain-local objects render in its own UI. That is *correct behavior* under this principle (they are its domain's local work), and the comment should say so rather than imply commander-side absence is invariant.

## 3. Lane A — the domain workbench: config changes the commander never sees

The end-to-end flow for a domain-specific configuration-as-code change at an outpost, measured step by step:

| Step | Surface today | State |
|---|---|---|
| Declare the domain-local component (or inherit via M20.5 container) | Registry create form checkbox; badge on list/detail | **UI complete** (M20) |
| Point a repo at it — source mapping (repo, path glob, `ref_pattern`, Type, `classification`) | **None.** SDK/CLI only (`scp change-source create-mapping`); zero calls in `apps/web` | **No UI** |
| Bind the executor with an explicit Type | Plugins page creates **Type-blind** (`putBinding` sends no `type`; silently defaults `configuration`); `registry-detail.tsx` can repurpose after the fact | **Partial, two-step** |
| Change flows: propose → waves → gates → deploy | `component-pipeline.tsx`, `change-detail.tsx` (generic, predates M20) | **UI complete** |
| See that the change is domain-local | **Impossible**: the wire `Change` schema carries no `domainLocal`; a `NoBoundarySegment` is ambiguous between "domain-local" and "ordinary un-promoted" | **No signal on the wire** |

Four builds complete the lane:

- **A1. Source-mapping authoring** in the component pipeline's source panel (where the read-only display, "any branch" warning, and classification badge already live): create and delete, with repo/path/ref-pattern/Type/classification fields. No new API — `createMapping`/`deleteMapping` exist; there is deliberately no PATCH (edit = delete + recreate, and the UI should say so rather than fake an edit).
- **A2. Typed binding creation**: a Type selector (`build | infrastructure | configuration`, per ADR-0007's facet) on the Plugins connect form and anywhere a binding is created. The current silent `configuration` default is exactly the class of silent wrong-Type that `registry-detail`'s repurpose control exists to repair.
- **A3. `domainLocal` on the wire `Change`** (additive, server-side): stamped at propose (it is already computed there — ADR-0031 §5 inherits it from targets), surfaced as the same badge vocabulary as objects, disambiguating the boundary-segment absence honestly ("no boundary — this change never leaves this domain" vs "not yet promoted").
- **A4. Freezes**: an outpost's freezes are *structurally* domain-only — no journal kind exists for them at all (measured; `service-board-precedence.integration.test.ts`) — yet freeze management is CLI-only at both roles, and `outpost-configuration.tsx` explains where freezes live while offering zero controls. A freeze card (declare/list/lift, scope picker) is the workbench's governance surface.

## 4. Lane B — the setup lane: importing and deploying to targets

Measured state: **exactly one** end-to-end setup flow has UI — `/connect/argocd` (Mode A P5). Everything else an operator does to stand up a domain dead-ends:

- Discovery plugins for **github, gitea, gitlab** exist server-side (`KNOWN_DISCOVERY_MODULES`) with no wizard and no CLI shortcut — connecting any of them means hand-assembling `secrets.put` + `execution-system` create + `discovery.run` + `discovery.accept`.
- **Placements have zero UI** — `apps/web` never calls `client.placements.*`; the pipeline view renders *"Declare a placement to give it a stage"* as inert prose.
- **Deployment targets** are hand-created one at a time in the generic registry form, which is reachable only via the `/graph` picker (no nav entry — deliberate at the time, worth revisiting for the setup lane's sake).
- **Imported components arrive as orphans by design** (the wizard's own notice) with no next-step beyond a link to the components list.
- The M19 worker-dispatch blocker is **fixed at HEAD** (PR #200 builds the plugin host on every role), so none of this waits on topology work. (Its proposal doc is stale — still "Draft," recommending a different fix than what shipped — flagged for correction separately.)

Four builds, in dependency order:

- **B1. Generalize `/connect/argocd` → `/connect/$kind`**: the wizard's three steps (register → enumerate → accept) are already generic API doors; parameterize the module id and manifest-driven config form over the four shipped discovery modules. The Argo CD path keeps its testids.
- **B2. Placements UI**: the pipeline view's "not placed" prose becomes the affordance — *Place at target…* opening a target picker (create-target inline for the not-yet-imported case). This is the single highest-leverage gap: it is named, in prose, on the exact screen where the operator feels it.
- **B3. Post-import triage**: the wizard's orphan notice becomes a worklist — imported components awaiting a service (`part_of` assignment), reusing the existing assign control from `registry-detail.tsx`.
- **B4. Target import**: where a discovery module proposes targets (Argo CD clusters do), accept them alongside components instead of hand-creating. Also the nav decision for `deployment-targets` (a "Targets" entry under Federation, or surfaced inside the setup landing only).

Whether Lanes A and B get a shared task-oriented **setup landing** (a per-domain checklist: connect systems → import → place → bind → map) or live purely as in-place affordances is an owner call (§8 Q1). Both lanes work either way; the landing adds discoverability for the first-day operator at the cost of one more page.

## 5. The colocated instance and "different subdomains"

What is structurally true today (measured, lens 5):

- One org = one federation identity (`federation_self.orgId` is the PK). An instance's role is advisory; nothing anywhere assumes commander XOR outpost.
- **Containment `domain` objects can nest** — `resolveDomainId` does not constrain the parent's type, and the rung walk is generic to depth 10 — but *nothing exercises it*: zero code, tests, docs, or UI create a domain under a domain. It is an unexercised capability, not a feature.
- M20.5 makes locality inheritable from **any** container — domain, service, or assembly — at create, one hop.

So the colocated case ("commander and outpost are one, though still different subdomains") has two viable modelings:

- **(a) Defer the domain object; use what ships.** The "subdomain" a colocated instance's outpost-duty operates on is, in every concrete example the owner has given, a *service/assembly subtree* — and M20.5 already lets that subtree be declared local at its root. Everything in §3–§4 works today under this reading. Nothing new to build or decide.
- **(b) Nested containment domains as first-class subdomains.** Truer to the word "subdomain," and rung policy resolution would walk it for free — but it lands on the `domain` object type, which ADR-0031 explicitly parked behind the **unresolved stage-vs-domain modeling question**, and it would be this repo's first user of domain nesting. Choosing it now front-runs that decision.

**Recommendation: (a), explicitly deferring (b)** until stage-vs-domain settles — the same deferral ADR-0031 made for subtree declarations before M20.5, for the same reason. Nothing in Lanes A/B depends on the choice.

> **Owner decision (2026-08-13): (b) — nested containment domains become first-class subdomains now.** The deferral recommendation above is overridden and kept for the record. Boundary of the decision, stated precisely so it does not silently widen: the owner decided that **domains nest** — a `domain` object may be created inside another `domain`, the rung walk resolves through it (already structurally true, now exercised and pinned), and M20.5 locality inheritance applies across the domain rung like any other container. This does **not** resolve the stage-vs-domain modeling question; it constrains it (any future answer must be compatible with nested domains). First-class means, concretely: an integration test pinning create-under-domain + rung resolution + locality inheritance through a nested domain; a parent-domain picker on the domain create form; GLOSSARY updated. An ADR records this once the implementation review lands, per working convention.

One adjacent open ruling to import from the M20 author (flagged by them 2026-08-13, undecided): **publishing a child out of a still-local subtree** is currently allowed and leaves the commander seeing an orphan (its containment edge is withheld by §4). No surface in this proposal depends on either answer; the publish card renders the withheld edge honestly today. It should be ruled on before any UI *summarizes* subtree publish state.

## 6. Not in scope / rejected

- **Role-gated navigation or views** — rejected on three standing precedents (§2). The Outpost UI is a set of surfaces every instance serves.
- **Client-side pre-blocking of writes** — rejected; M16.3's rule stands (offer the write, render the refusal with its `decision_id`).
- **A second bundle/app for outposts** — rejected; M16.3 P1's one-bundle property is load-bearing for air-gap and self-hosting (charter 5).
- **Outpost-local Harbor/Gitea create-from-UI** — out of scope here; creation is Helm-values-by-design (ADR-0010). Its *import* path rides B1 like any other system.
- **Un-publish, retrofit, or any locality mutation surface** — ADR-0031 §6/§6a; nothing here touches locality except at create.

## 7. Build increments (each independently shippable)

1. **A3** — `Change.domainLocal` (additive schema + stamp at propose) + change-page badge. Smallest; unblocks honest rendering everywhere else.
2. **B2** — placements UI on the pipeline view.
3. **A1 + A2** — source-mapping authoring + typed binding creation (one "pipeline plumbing" review unit).
4. **B1** — generalize the connect wizard; **B3/B4** ride its review.
5. **A4** — freeze card.
6. Doc correction batch: `discovery-worker-dispatch.md` status flip; `domain-local.tsx` comment honesty fix (§2).

## 8. Open questions for the owner

1. **Setup landing**: in-place affordances only, or also a per-domain setup checklist page? (§4 close)
2. **Subdomains**: confirm deferral of nested `domain` objects (§5a over §5b)?
3. **Sequencing**: mock Lane A or Lane B first on :8080? A3 (the additive server change) is assumed acceptable in either case — flag if not.
