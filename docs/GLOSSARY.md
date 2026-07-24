# CommanderSCP Terminology Glossary

**Status:** Authoritative for vocabulary. Owner-decided 2026-07-24 — the reasoning, the rejected alternatives, and the cost table live in [ADR-0021](adr/0021-terminology.md).

## Why this document exists

CommanderSCP **coordinates other people's tools**, and those tools arrived with vocabulary already attached. Argo CD, Kargo, JFrog, Helm, GitHub Actions and Terraform all use words like *promotion*, *release*, *stage* and *environment* — and they do not all mean the same thing by them. On top of that, the product ships into regulated and cross-domain environments where NIST and CNSSI have already defined *security domain*, *authorization boundary* and *cross-domain solution* precisely, and where a word like *release* carries a **disclosure** meaning that has nothing to do with software delivery.

The rule this glossary follows:

1. **Where a clear industry standard exists, use it** — and cite it, so a new engineer can go read the source.
2. **Where standards collide or the concept is genuinely ours, the owner decided** — and [ADR-0021](adr/0021-terminology.md) records why, including the alternatives that were considered and rejected.
3. **Where the glossary's preferred word does not match the code today, this document says so in the entry.** Nothing here describes an aspirational codebase as if it already exists. Three code changes are tracked as follow-on PRs; each is flagged where it bites.

Audience: a new engineer trying to read the code, and an operator trying to read the UI. It is not a research dump — the research is in the ADR.

---

## Quick reference

| Term | One-line meaning | Standard? |
|---|---|---|
| **promotion** | The same already-built artifact advances to the next step without being rebuilt | INDUSTRY-STANDARD |
| **cross-domain promotion** | A promotion whose next step crosses a **security-domain** boundary, and therefore must pass the CDS supply-chain gate | QUALIFIED-STANDARD |
| **accept / accepted** | The human approval gate that terminates a change's lifecycle in success | SCP-SPECIFIC |
| **release** | The versioned unit of change moving through its whole pipeline — a change **is** a release | QUALIFIED-STANDARD |
| **release topology** | A versioned declarative document describing a release's waves, target groups and gates | SCP-SPECIFIC |
| **deploy / deployment** | The push of an artifact into one environment so it runs there | INDUSTRY-STANDARD |
| **deployment target** | The graph object type an executor acts on (cluster, host, environment, region) — deliberately broad | SCP-SPECIFIC |
| **environment** | A named operational tier (dev / gamma / prod) within one security domain | INDUSTRY-STANDARD |
| **stage** | **Reserved:** a named (security domain × environment) place. No such entity exists yet | QUALIFIED-STANDARD |
| **wave** | One ordered step of a compiled plan — a set of targets that move together | SCP-SPECIFIC |
| **change** | The coordinated unit of work; a graph object with a lifecycle state machine | SCP-SPECIFIC |
| **pipeline** | The ordered path a release travels for one executor **Type** | INDUSTRY-STANDARD |
| **artifact** | The immutable built thing identified by digest (image, rpm, npm, config bundle, plan) | INDUSTRY-STANDARD |
| **bundle** | Three distinct things — see the entry; always qualify | SCP-SPECIFIC |
| **security domain** | A domain implementing one security policy under a single administering authority | INDUSTRY-STANDARD (CNSSI-4009) |
| **containment domain** | The intra-org `domain` graph object type — an ordinary grouping below org | SCP-SPECIFIC |
| **authorization boundary** | The components authorized for operation by one authorizing official, excluding separately authorized connected systems | INDUSTRY-STANDARD (NIST SP 800-37) |
| **CDS / cross-domain solution** | The accredited mechanism that transfers information between security domains | INDUSTRY-STANDARD (CNSSI-4009) |
| **retrans** | The SCP federation role that sits at a CDS boundary and validate-then-relays | SCP-SPECIFIC |
| **commander** | The federation role that is the source of truth for global config | SCP-SPECIFIC |
| **outpost** | The federation role for a per-domain/per-environment instance | SCP-SPECIFIC |
| **federation** | Hash-chained, signed journal exchange between SCP instances | QUALIFIED-STANDARD |
| **org / tenant** | The top-level tenancy unit; one org is one federation identity | SCP-SPECIFIC |
| **instance** | One running deployment of the SCP binary; multi-tenant | SCP-SPECIFIC |
| **region** | A geographic locality *within* a security domain | INDUSTRY-STANDARD |
| **executor** | A plugin implementing the observe/trigger/status/abort verbs against an execution system | SCP-SPECIFIC |
| **execution system** | The registered external system an executor talks to (an Argo CD, a GitHub) | SCP-SPECIFIC |
| **coordination, not execution** | The charter invariant: SCP triggers/observes/gates; it does not build, test, scan or deploy | SCP-SPECIFIC |
| **scan gate** | A boundary-crossing **authorization** gate whose evidence is a vulnerability scan verdict | SCP-SPECIFIC |
| **manifest** | The commander-signed enumeration of exactly the artifacts authorized to cross | SCP-SPECIFIC |
| **control** | An abstract graph object declaring a check; plugins are its bindings | SCP-SPECIFIC |
| **decision** | The persisted, explainable verdict record every engine judgement writes | SCP-SPECIFIC |
| **poke / poke-mode** | An optional contentless commander→outpost wake signal | SCP-SPECIFIC |

---

## The organizing idea: promotion is a genus, cross-domain promotion is a species

Everything about *promotion* in this system follows from one relationship:

> **PROMOTION is the genus.** The same already-built artifact advances to the next step in its pipeline, without being rebuilt.
>
> **CROSS-DOMAIN PROMOTION is the species.** It is a promotion whose next step happens to cross a **security-domain** boundary — and *because* of that crossing it must additionally pass the CDS supply-chain gate: scan, a cosign-signed promotion manifest, and cosign-verify at every hop.

Two consequences worth internalising:

- **Bare "promotion" never implies a domain crossing.** Gamma → Prod inside one domain is a promotion, full stop.
- **"Cross-domain promotion" is always written in full.** When the security-domain boundary is what you mean, the qualifier is not optional — it is the only thing distinguishing the species from the genus.

---

## Entries

### promotion

**Definition.** The same already-built artifact advances to the next step of its pipeline **without being rebuilt** — "build once, deploy many". Promotion is defined by *artifact identity*: the bits that arrive are the bits that were built. It is **not** defined by what kind of boundary is crossed.

In GitOps terms — which is what SCP actually coordinates — a promotion is the act of updating the desired state in Git so the next environment picks up the already-built artifact.

**Industry-standard?** Yes. Kargo's documentation frames a promotion as a request to move a piece of freight into a specified stage. The `argoproj-labs/gitops-promoter` project describes itself as a GitOps-first **environment** promotion tool. JFrog's "build promotion" moves or copies build artifacts to a target repository. In none of these does "promotion" imply crossing a *security* boundary; it implies advancing without rebuilding.

**Not to be confused with:**
- **cross-domain promotion** — the species below, which additionally crosses a security domain. Never say bare "promotion" when you mean that.
- **`accept` / `accepted`** — the change-lifecycle approval gate. That is a human decision about a change, not an artifact advancing. It used to be spelled `promote`, which is exactly why it is being renamed (see the `accept` entry).
- **Argo Rollouts' "Promote"** — the progressive-delivery sub-step inside a canary analysis. SCP observes it; SCP does not own it (`docs/proposals/coordination-ui-views.md` §2).
- **`scp federation promote`** — the CLI verb that exports a **Promotion Bundle**. That is a real promotion (the genus), and it is often but not always cross-domain.

**In the code.** `apps/web/src/components/pipeline/PromotionArrow.tsx` renders exactly this sense — a wide arrow between two stacked pipeline cards, coloured by gate state. `apps/server/src/federation/promotion-repo.ts` carries Promotion Bundles. `packages/schemas/src/federation.ts` (`PromotionManifestSchema`, ~:436) carries the signed manifest that authorizes a cross-domain one.

---

### cross-domain promotion

**Definition.** A promotion whose next step crosses a **security-domain** boundary — commercial → GovCloud → IL5 → air-gapped. Because the crossing is a boundary-authorization event, a cross-domain promotion must additionally satisfy the CDS supply-chain gate:

1. a passing, **digest-bound** scan verdict against the effective scoped pass-criteria ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md));
2. a **cosign-signed promotion manifest** enumerating exactly the authorized artifact set ([ADR-0015](adr/0015-cosign-cross-boundary-signing.md));
3. **cosign-verify at every hop** — the retrans verifies before letting anything cross the CDS, and the receiving outpost verifies again inside the domain before deploy ([ADR-0011](adr/0011-universal-outpost-validation.md)).

What crosses is **metadata** — change objects, digests, signatures, SBOM references, the signed manifest. Artifact bytes travel on a separate channel ([ADR-0019](adr/0019-artifact-byte-channel.md)).

**Always qualified.** Write "cross-domain promotion" in full. Bare "promotion" is the genus and carries no boundary implication.

**Industry-standard?** Qualified. The concept is standard; the *word* is ours. CNSSI-4009 defines a cross-domain solution using two verbs — **access** and **transfer** — of information between different security domains, and NCDSMO's accredited-product taxonomy splits transfer-CDS from access-CDS. By the letter of those standards, the correct verb for this hop is **transfer**. The owner considered renaming it and **rejected** that in favour of keeping the existing federation vocabulary at zero rename cost; [ADR-0021](adr/0021-terminology.md) records the rejection honestly, including that "transfer" is the literal CDS-standard verb.

**Not to be confused with:**
- **promotion (bare)** — the genus. Env-to-env, no boundary.
- **transfer** — the CDS-standard word for this. We do not use it as our name for the hop, but when writing for an accreditation audience it is the word they will expect; say "cross-domain promotion (a CDS *transfer* in CNSSI-4009 terms)".
- **relay** — what the retrans does mechanically (validate then forward). Relaying is a step *inside* a cross-domain promotion, not a synonym for it.

**In the code.** `apps/server/src/federation/promotion-repo.ts` (`importPromotionBundle`), `apps/server/src/federation/retrans-relay.ts`, `apps/server/src/federation/artifact-verify.ts`, and the export-time gate that hard-refuses any digest lacking a passing digest-bound scan.

---

### accept / accepted

**Definition.** The **human approval gate** that terminates a change's lifecycle in success. A change that has finished executing and validating is *accepted* by a person, and `accepted` is a terminal success state (a rollback is still possible afterwards; nothing else is).

`accept` is **domain-agnostic**. It applies to every change, including purely intra-domain ones that never cross any boundary and never move any artifact anywhere new.

**Formerly spelled `promote` / `promoted`.** This is the owner's 2026-07-24 rename decision (D5 in [ADR-0021](adr/0021-terminology.md)). The rationale: the approval gate is a *human decision on a change*, not *an artifact advancing* — so under the genus/species model above, calling it "promote" actively fights the glossary. Every reader who learns that promotion means "the same bits advance" then hits `validating → promoted` and has to unlearn it.

It is **not** an artifact promotion (the genus) and **not** a cross-domain promotion (the species). It is a third thing that happened to share a word.

**In the code — the code still spells it `promote`/`promoted`.** As of this document the rename has not landed:

- `apps/server/src/coordination/transitions.ts` — the edge is `{ from: "validating", to: "promoted", trigger: "promote" }`
- `packages/schemas/src/changes.ts:22` — `"promoted"` is a `ChangeState` enum value, returned on every change response
- `apps/server/src/routes/changes.ts:344` — `POST /api/v1/changes/:id/promote` (`operationId: promoteChange`)
- `packages/cli/src/cli.ts:1664` — `scp change promote <id>`
- `apps/server/drizzle/0007_change_coordination.sql` seeds the `state_transitions` rows

The rename is a **tracked follow-on PR** ([ADR-0021](adr/0021-terminology.md) Consequences, item ii). It is genuinely breaking: a `/v1` path change, a data migration over `changes.state`, the seeded `state_transitions` rows, the CLI verb, and the enum in every change response. It is judged payable now because the project is pre-1.0 with a single deployment, and because [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md) set the direct precedent — it removed `parent`/`child` outright in favour of `commander`/`outpost`/`retrans`, a breaking federation-role enum rename taken for exactly this class of reason.

**Not to be confused with:**
- **`scp federation promote`** (`packages/cli/src/cli.ts:2707`) — the Promotion Bundle export verb. That one is a real promotion and keeps its name.
- **an approval** — `requireApprovals` is a *policy effect* producing approval tasks and `approves` relationships (DESIGN.md §10.2). An approval is evidence a gate consumes; `accept` is the lifecycle transition the gate guards. A change can require several approvals and still be accepted once.

---

### release

**Definition.** **A change *is* a release.** A release is the versioned unit of change moving through its **whole** pipeline. It may span many waves, may touch many targets, and may cross security domains. A release comes from exactly **one source per pipeline** — a release needing both a software and an infrastructure source is two releases.

A release is emphatically **not** "one push into one stage". That push is a **deployment**.

**Industry-standard?** Qualified. The word has at least five entrenched senses in the wider industry, and we adopt a blend of the first two:

1. **the versioned artifact bundle / named version** — the most prevalent sense, and half of ours;
2. **the process or event of shipping** ("release train", "release management") — the other half;
3. **Humble & Farley's strict sense** in *Continuous Delivery*: *deploy* means install into an environment, *release* means make available to **users** (feature flags, dark launch). We do **not** use this sense — SCP has no user-exposure primitive;
4. **Helm's sense**: an installed instance of a chart in a cluster. This is a hard collision — SCP ships a Helm chart, so "the release" in a `helm list` output is a completely different object;
5. **Linux packaging's `release` field** (the `-1` in `1.2.3-1`).

Note that DORA measures **deployment** frequency, not release frequency — further evidence that "deployment" is the word for the per-environment push.

**Why the precision matters here — a compliance landmine.** In DoD/IC usage, **"release" and "releasability" mean a disclosure determination** (REL TO markings, foreign disclosure review). Cross-domain filters exist precisely to enforce security *and releasability* policies. A cross-domain product that uses "release" loosely to mean "deploy" invites an accreditation reader to see a **disclosure determination** where a software deployment was meant. That is the single strongest reason this glossary insists on the distinction between *release* (the unit moving through the pipeline) and *deployment* (the push into one environment).

**Not to be confused with:** a Helm release; a deployment; a GitHub Release object; a releasability determination.

**In the code.** There is **no** release table, entity, or API resource — "release" is a gloss on `change`. It is stated most directly at `apps/server/src/coordination/changes-repo.ts` (~:74): *"a change IS a release, and a release comes from ONE source per pipeline, so one change drives one pipeline. A release needing both is two releases."* The one place the word is load-bearing in an identifier is **`release-topology`** (below), whose slug leaks into URNs.

---

### release topology

**Definition.** A versioned declarative JSON document (a registry graph object, IaC-manageable) describing how a release progresses: waves with sequential or parallel target groups, per-wave gates, and fan-in gates. Single, canary, blue/green, rolling, regional, domain-based, federated and custom topologies are all **data**, not workflow code (DESIGN.md §9.3).

A change compiles against a release topology into `plan → waves → wave_targets` rows.

**Industry-standard?** No — SCP-specific. The nearest analogues are Spinnaker's deployment strategies and Argo Rollouts' strategy specs, but neither is a first-class versioned registry object the way this is.

**Not to be confused with:** the *graph* topology (`depends_on` / `consumes` edges between services and components), which is a different structure entirely and is what the two-layer graph explorer renders.

**In the code.** Object type `release-topology`, seeded in `apps/server/drizzle/0002_rls_rbac_seed.sql`; resolved in `apps/server/src/coordination/plan-service.ts:77` and `apps/server/src/coordination/campaign-repo.ts:104`. **Its slug leaks into URNs** (`urn:scp:{org}:release-topology:{slug}`), so unlike the rest of "release" this identifier is not free to redefine.

---

### deploy / deployment

**Definition.** The push of an already-built artifact into **one** environment so that it runs there. A deployment is the per-environment event; a release is the whole journey.

**Industry-standard?** Yes, and unambiguously so — this is the least contested word in the delivery vocabulary. GitHub Actions mints a `deployment` object per environment-scoped job. DORA's headline metric is deployment frequency. Humble & Farley define deploy as installing into an environment (reserving *release* for user exposure).

**Not to be confused with:** *release* (the whole unit moving through the pipeline); *promotion* (the advance from one step to the next, of which a deployment is often the effect); Kubernetes' `Deployment` resource (a workload controller — a completely different noun that happens to share the word, and which SCP coordinates Argo CD to manage).

**In the code.** Deploys are coordinated, never executed by SCP: Argo CD for Kubernetes (`packages/plugins/argocd`), Ansible via `scp-runner-ops` for hosts (proposed), Argo Workflows or `scp-managed-iac` for cloud infrastructure (`packages/plugins/managed-iac`).

---

### deployment target

**Definition.** The graph object type an executor acts on. Deliberately broad: a `deployment-target` may model a **cluster**, a **host**, an **environment**, or a **region**.

**Industry-standard?** No — SCP-specific, and honestly the most overloaded object type in the model. That breadth is a deliberate simplicity trade (charter priority 1), not an oversight: rather than three near-identical tables, one object type carries the "place an executor points at" role, and executor bindings disambiguate by Type and scope.

**Not to be confused with:** *environment* (a tier concept a deployment target may or may not represent) and *stage* (a reserved (security domain × environment) place — see below). If you need to know *which* sense a given `deployment-target` row carries, read its bindings; the type alone does not tell you.

**In the code.** Object type `deployment-target`, seeded at `apps/server/drizzle/0002_rls_rbac_seed.sql:159`, with `deployed_to`-style relationship types seeded alongside it (`:186`, `:190`). Per-region deploy-target bindings are what [ADR-0017](adr/0017-ownership-refinement.md) §3's multi-region Argo CD setting builds on.

---

### environment

**Definition.** A named operational tier within one security domain — dev, beta, gamma, prod. Environments are ordered within a domain and a promotion typically advances an artifact from one to the next.

**Industry-standard?** Yes. GitHub Actions environments, Argo CD's app-per-environment convention and Kargo's stage-per-environment model all use it the same way.

**Not to be confused with:** *stage* — under D6 (below), "stage" is reserved for the **(security domain × environment)** pair, so `gamma` is an environment and `gamma-commercial` would be a stage. And *deployment target*, which may happen to model an environment but may equally model a single cluster or host.

**In the code — there is no `environment` table.** Environments today are expressed as labels, deployment-target names, and wave structure. That is a real gap, not a hidden feature; see the `stage` entry for what a future entity would need to carry.

---

### stage

**Definition — RESERVED VOCABULARY.** In CommanderSCP, **stage** means a named **(security domain × environment)** place: `gamma-commercial`, `production-govcloud`, `prod-il5`. The word is spent on *place*, and on nothing else.

It is **not** spent on ordering, and **not** on pipeline phases.

**Industry-standard?** Split, and we deliberately pick the minority sense.

- The **majority** CD sense of "stage" is a **pipeline phase** — Jenkins `stage()`, GitLab CI `stages:`, Spinnaker pipeline stages. We do **not** use it that way.
- The **minority** sense — and ours — is Kargo's `Stage` CRD, which models exactly this environment-like node that freight is promoted into. That precedent makes the reservation standards-defensible rather than idiosyncratic.

**Honest status: no stage entity exists in the schema today.** There is no `stage` table, no `environment` table, and **no (domain × environment) compound name like `gamma-commercial` appears anywhere in the repository**. "Stage" is *reserved vocabulary that a future entity may fill*, not a description of something built.

**Two in-tree misuses are tracked for cleanup** ([ADR-0021](adr/0021-terminology.md) Consequences, item iii — a cheap UI-and-docs-only change with no API and no schema impact):

- The **UI calls a wave a "stage"**: `apps/web/src/components/pipeline/StageCard.tsx` takes a `ChangeWave` and renders it with a `stageNumber`; `apps/web/src/routes/change-pipeline.tsx` renders `waves.map(...)` into `data-testid="pipeline-stages"`. Those should say **wave**.
- **Code comments use "stage" for pipeline phases** — e.g. the execution map in `docs/proposals/promotion-and-execution-model.md` §1 and the surrounding comments. Those should say **phase** or **step**.

Neither has been changed yet.

**Not to be confused with:** *wave* (the ordering primitive that actually exists), *environment* (one axis of a stage), *phase*/*step* (what other CD tools call a stage).

---

### wave

**Definition.** One ordered step of a **compiled plan**: a set of targets that move together. Wave order is computed from graph `depends_on` edges (topological sort with cycle rejection) plus explicit coordination rules such as "infrastructure before application". Waves sharing an index run in parallel (fan-out); a fan-in gate requires every target of the previous wave to have succeeded.

Waves are the ordering primitive SCP actually has. In a federated release topology, the waves **are** the domains — commercial → FedRAMP → IL5 → air-gapped — and each wave's gate is the target domain's own local gate outcome, reported back via the journal (DESIGN.md §13).

**Industry-standard?** No — SCP-specific, though the shape rhymes with a Spinnaker deployment stage sequence or an Argo Rollouts step list.

**Not to be confused with:** *stage* (reserved for a place, per D6). The UI currently mislabels waves as stages — see the `stage` entry.

**In the code.** `change_waves` / `change_wave_targets` and `campaign_waves` (`apps/server/src/db/schema.ts`, ~:943); compiled by `apps/server/src/coordination/plan-compiler.ts`; DESIGN.md §9.3.

---

### change

**Definition.** The coordinated unit of work — a graph object with a projection row carrying an explicit, table-driven lifecycle state machine. A change targets objects, compiles into a plan of waves, passes gates, and terminates in success (`accepted`), `cancelled`, or `rolled_back`.

**A change is also a release** (see `release`) — same thing, two vocabularies for two audiences: *change* is what the engine calls it, *release* is what a delivery engineer calls it.

**Lifecycle.** `proposed → evaluated → coordinated → executing → validating → accepted`, with an optional `coordinated → waiting → executing` detour when cross-change prerequisites are outstanding, `cancel` legal from every pre-acceptance state, and `rollback` legal once something has actually executed. **In the code the terminal state is still spelled `promoted`** — see the `accept` entry.

Every transition goes through **one guarded transition function** that atomically checks the gates bound to that edge, writes the audit event, and writes the Decision record. That single funnel is what makes explainability cheap rather than aspirational (DESIGN.md §9.1).

**Industry-standard?** SCP-specific in this precise form. The ITIL sense of "change" (a change request under change management) is the closest cousin and is not wrong — but SCP's change is a coordination object with a compiled plan, not a ticket.

**In the code.** `apps/server/src/coordination/changes-repo.ts`, `apps/server/src/coordination/transitions.ts`, `packages/schemas/src/changes.ts`, `apps/server/src/routes/changes.ts`.

---

### pipeline

**Definition.** The ordered path a release travels for **one executor Type** — build → registry → config → gamma → prod for a software pipeline; plan → gate → apply for an infrastructure pipeline. Because a change carries exactly one Type ([ADR-0007](adr/0007-executor-binding-type-taxonomy.md)), **one change drives one pipeline**; work spanning two pipelines is two changes, chained with `provides`/`requires`.

**Industry-standard?** Yes, in the ordinary CI/CD sense. What is SCP-specific is the one-change-one-pipeline rule and the Type-based routing.

**Not to be confused with:** a Jenkins/GitLab pipeline *definition file* — SCP does not own or author pipeline definitions; it coordinates the execution systems that do. Coupled pipelines (build → config → deploy across changes) are a **chain** of pipelines, not one pipeline.

**In the code.** `type?: ExecutorType` on the change (`apps/server/src/coordination/changes-repo.ts`), `apps/server/src/coordination/coupling.ts` for the cross-change chain, and the pipeline views under `apps/web/src/components/pipeline/`.

---

### artifact

**Definition.** The immutable built thing, identified by **digest**: an OCI image, an rpm/deb/npm/Maven/Helm package, a config bundle, an infrastructure plan, or an SBOM. Promotion is defined by artifact identity — the same digest advances.

**Industry-standard?** Yes; digest-addressed artifacts are the shared vocabulary of OCI, JFrog, and every SLSA-aligned supply chain.

**Not to be confused with:** a **bundle** (see below — a bundle is a transport container, not a built thing); a CI "build artifact" in the loose sense of any file a job uploads.

**In the code.** Digests thread through the gate context as `artifactDigest` (`apps/server/src/governance/gate-orchestrator.ts` `buildControlContext`); bytes travel on the channel designed in [ADR-0019](adr/0019-artifact-byte-channel.md); verification is `apps/server/src/federation/artifact-verify.ts`.

---

### bundle — always qualify

"Bundle" alone is ambiguous in this repository. There are **three** distinct things:

1. **Promotion bundle** — the metadata-only export of a change toward another domain: the change object, provenance, control outcomes with evidence, artifact digests, SBOM references, and the cosign-signed promotion manifest. **It carries no artifact bytes.** The importing domain instantiates its *own* local change (state `proposed`, `imported_from_domain` set) which must pass **local** policy. Approvals travel as **evidence, never as authority**. → `apps/server/src/federation/promotion-repo.ts`, `packages/schemas/src/federation.ts`.
2. **Air-gap federation bundle** (`.scpbundle`) — the signed, checksummed tarball of hash-chained journal segments walked across an air gap by `scp federation export` / `scp federation import`. Also metadata. → `apps/server/src/federation/export-repo.ts`, `import-repo.ts`.
3. **Relay tarball** (`*-relay.tar.gz`) — the **artifact-byte** container the retrans validates and forwards across a CDS. This is the only one of the three that carries bytes. → `apps/server/src/federation/retrans-relay.ts`, [ADR-0019](adr/0019-artifact-byte-channel.md).

A fourth, unrelated sense exists in the deployment story: the **air-gapped release bundle** built by `deploy/airgap` (the installable product tarball). Say which one you mean.

**Not to be confused with:** Helm chart packaging, or "bundle" in the JavaScript build sense.

---

### security domain

**Definition.** *A domain that implements a security policy and is administered by a single authority.* Commercial, GovCloud, FedRAMP, IL5 and air-gapped are each a security domain. In CommanderSCP this is the **trust tier** — the ambient boundary a deployment lives in, above org.

The owner's framing is an AWS **partition**: like `aws` / `aws-us-gov` / `aws-cn`, a partition is ambient — every resource is born in exactly one, nothing silently crosses it, and it is not modelled as a row that groups accounts ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology).

**Industry-standard?** Yes. The definition above is CNSSI-4009-2015's, also carried in NIST SP 800-137. NIST SP 800-53 Rev. 5 gives an equivalent resources/entities/common-policy formulation. NIST SP 800-57 Part 1 Rev. 5 adds **composability** — a security domain is a system or subsystem under a single trusted authority, and security domains may be organised (for example hierarchically) into larger domains. That composability is what makes commander → outpost → retrans a legitimate hierarchy of domains rather than a private invention.

**Terminology adopted 2026-07-24 (D4).** Use **"security domain"** — the NIST/CNSSI term — for the trust tier. Existing docs also say **"trust domain (partition)"**; that phrase remains valid and is not being rewritten, but "security domain" is the preferred term going forward because it is the term an accreditation reader already knows.

**Not to be confused with — five rival senses of bare "domain":**
- a **DNS** domain;
- a **Windows/Active Directory** domain;
- a **DDD bounded context** ("the domain model");
- an **identity realm** — NIST's own federation literature speaks of a collection of realms (domains);
- SCP's own **containment domain** object type (next entry).

Also distinct: **SPIFFE's "trust domain"**, which corresponds to the **trust root** of a system — i.e. it is defined by a shared PKI root, whereas a *security* domain is defined by common security **policy** under one administering authority. These are different concepts and they cross-cut: two security domains can share a trust root, and one security domain can contain several. SCP deliberately does **not** use `spiffe://` identifiers; it uses `urn:scp:domain:<domainId>` in the certificate SAN URI (RFC 8141 URN, `apps/server/src/federation/mtls-enforcement.ts`), precisely to avoid taking a SPIFFE dependency. That was a deliberate choice, not an oversight.

**Bare "domain" is banned as a tier name** — in prose *and* as a stored value. [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology mandates the full forms and specifies that the floor table's tier literal is `trust_domain`, never bare `domain`; DESIGN.md:481 does the same for the policy-resolution chain.

**In the code — the docs solved this; the code did not.** There are roughly **356** non-test `domainId` references across `apps/` and `packages/`. About **51** live in `apps/server/src/federation` and mean the **security/trust** sense (`federation_self.domainId`, `apps/server/src/db/schema.ts:1011`). About **45** live in `apps/server/src/graph` and mean the **containment** sense (`objects.domainId`, `apps/server/src/db/schema.ts:169`). **Both are plain `uuid` with zero type-level separation**, so nothing today stops one being passed where the other is expected.

**The fix is a tracked follow-on PR, not something already done:** branded TypeScript types `TrustDomainId` vs `ContainmentDomainId`, so the collision becomes **uncompilable** rather than a naming convention ([ADR-0021](adr/0021-terminology.md) Consequences, item i).

---

### containment domain

**Definition.** The `domain` **object type** in the graph — an ordinary intra-org grouping that sits **below** org in the containment chain: org → containment domain → service → component. It is the "domain" in policy resolution and in the scan-requirement scope chain.

**Industry-standard?** No — SCP-specific. It is closest to a folder/organizational-unit concept.

**Not to be confused with:** the **security domain** (the trust tier above org). They are never the same thing. `apps/server/src/db/schema.ts` records the distinction explicitly, and [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology exists solely to keep them apart.

**In the code.** Object type `domain`, seeded at `apps/server/drizzle/0002_rls_rbac_seed.sql:152`; the column is `objects.domain_id` (`apps/server/src/db/schema.ts:169`); the walk is `apps/server/src/graph/containment.ts` (`containmentChain`), which is org-filtered on every join and rooted at the org root — it **structurally cannot** express any tier above org, which is exactly why the security-domain tier needed a separate instance-scoped table.

**Same branded-types caveat as above:** `objects.domainId` and `federation_self.domainId` are both bare `uuid` today.

---

### authorization boundary

**Definition.** *All components of an information system to be authorized for operation by an authorizing official. This **excludes** separately authorized systems to which the information system is connected.*

**Industry-standard?** Yes — NIST SP 800-37 Rev. 2 and NIST SP 800-53 Rev. 5.

**Why it matters here.** That exclusion clause is the **strongest standards justification for why the retrans role exists**. The security domains SCP federates across are *separately authorized systems by construction* — a commercial domain and an IL5 domain have different authorizing officials and different ATOs. They are therefore outside one another's authorization boundaries, and a connection between them is not an internal system link but a cross-boundary connection requiring its own accredited mechanism. The retrans is that mechanism's SCP-side counterpart: it validates and relays, holds no local authoritative objects, originates no config, and never terminates a promotion.

**Not to be confused with:** a *security domain* (a policy/authority scope, which an authorization boundary usually but not necessarily aligns with) or a *network* boundary (a topology fact — an authorization boundary is an accreditation fact).

**In the code.** Not modelled as an entity. It is the standards rationale behind the `retrans` role (`packages/schemas/src/federation.ts`, `FederationRoleSchema`) and behind the fail-closed import checks.

---

### CDS / cross-domain solution

**Definition.** The accredited mechanism that permits information to move between security domains. CNSSI-4009 frames a CDS in terms of exactly two verbs — **access** and **transfer** — of information between different security domains; NCDSMO's accredited-product taxonomy correspondingly splits **transfer**-CDS from **access**-CDS.

**Industry-standard?** Yes — CNSSI-4009, and the NCDSMO product taxonomy built on it.

**SCP is not a CDS.** SCP coordinates *around* one. The CDS is the customer's accredited guard; SCP's retrans role sits **beside** it, validating what it hands over and what it receives.

**Not to be confused with:** the **retrans** (SCP's own role at the boundary — see next entry) and with **cross-domain promotion** (the SCP operation that traverses a CDS).

**In the code.** `apps/server/src/federation/retrans-relay.ts`; the design is [ADR-0019](adr/0019-artifact-byte-channel.md) §2 and `docs/proposals/airgap-cds-validate-promote.md`.

---

### retrans

**Definition.** The SCP federation role (short for *retransmission*) that sits at a CDS boundary. It deliberately does much **less** than an outpost: it validates — signature and hash-chain verification, cosign-verify of artifacts and manifest, the same fail-closed checks as any import — and then relays onward through the CDS. It **never** originates config, **never** holds local authoritative objects, and **never** terminates a promotion. A store-and-forward validation relay, nothing more.

**Industry-standard?** No — SCP-specific, introduced by [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md).

**Not to be confused with:** an **outpost** (which does hold local authoritative objects and does terminate promotions), and the **CDS itself** (the customer's accredited guard — the retrans is SCP's counterpart beside it, not the guard).

**In the code.** `FederationRoleSchema` in `packages/schemas/src/federation.ts` (~:17–28); `apps/server/src/federation/retrans-relay.ts`; migration `apps/server/drizzle/0020_commander_outpost_retrans.sql`.

---

### commander

**Definition.** The federation role designating the single instance that is the **source of truth for global configuration** — the domain registry, org structure, global policies, release topologies, campaign and initiative definitions. The charter's Global Coordination Layer. It also owns the **cross-boundary gate**: it consumes the scan verdict and cosign-signs its own promotion manifest.

The commander **never runs build** ([ADR-0017](adr/0017-ownership-refinement.md) §2) and **never dials an outpost** for data (see `poke` for the one narrow, opt-in, contentless exception).

**Industry-standard?** No — SCP-specific. It replaced `parent` in [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md).

**Not to be confused with:** an "instance" (a commander is a *role* a running instance is configured into — same binary, same image, same chart) and a "control plane" in the Kubernetes sense.

**In the code.** `federation_self.role = 'commander'` (`apps/server/src/db/schema.ts` ~:1009); set explicitly by `scp federation init --role commander`, never inferred.

---

### outpost

**Definition.** The federation role for a per-domain / per-environment instance — `commercial-amer`, `commercial-apac`, `federal`, `airgap-1`. An outpost is **authoritative for its own local objects** (local services and components, deployment targets, changes, control outcomes, approvals, audit segments) and holds commander-origin config as a **structurally read-only replica**: it may layer stricter local policy on top, never weaken it. It reports status upward, which is what gives the commander its cross-domain view.

Outposts remain **fully operational when disconnected** — federation enhances operation, it is never required for it. Build execution devolves to the **originating** outpost ([ADR-0017](adr/0017-ownership-refinement.md)), and the receiving outpost **always validates before deploying** — commercial included ([ADR-0011](adr/0011-universal-outpost-validation.md)).

**Industry-standard?** No — SCP-specific. It replaced `child` in [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md).

**Not to be confused with:** a **region** (an outpost may serve several) and a **containment domain** (an intra-org grouping, nothing to do with deployment topology).

**In the code.** `packages/schemas/src/federation.ts` (~:17–18); `federation_self.role = 'outpost'`.

---

### federation

**Definition.** The exchange of an append-only, hash-chained, **Ed25519-signed** Sync Journal between SCP instances. Each entry is stamped `(origin_domain, sequence, content_hash)`; per-domain monotonic cursors make replication idempotent and resumable. Two transports carry the identical journal format: **mTLS HTTPS** (always outpost-initiated) and **air-gap bundle files** walked across the gap.

**Single-writer authority:** every object has exactly one authoritative origin domain; non-authoritative copies are read-only replicas; conflict resolution is "authority wins" — no merge algorithm exists because none is needed. Where a non-owning domain must contribute, it creates an **overlay** it does own, linked by `annotates`.

**Industry-standard?** Qualified. "Federation" in the identity sense (SAML/OIDC federation between realms) is the dominant industry meaning and is **not** what SCP means — SCP explicitly does *not* do federated identity mapping; each domain keeps its own identities (DESIGN.md §13, Explicitly deferred). SCP's sense is closer to database/data federation: replicating authoritative state between independently governed instances.

**Not to be confused with:** identity federation; a service mesh; "multi-cluster" in the Kubernetes sense.

**In the code.** `apps/server/src/federation/` (journal, cursors, export/import, sync); `packages/schemas/src/federation.ts`; DESIGN.md §13.

---

### org / tenant

**Definition.** The top-level tenancy unit. An SCP **instance is multi-tenant** — one deployment hosts many orgs — and every graph object, policy and audit row carries an `orgId` under row-level security.

**One org is one federation identity.** `federation_self` is keyed per-org (`orgId` primary key, `domainId` unique), so a deployment hosting N orgs mints N domain identities.

**Honest open question.** Whether "one outpost deployment per domain, hosting multiple related orgs" ([ADR-0017](adr/0017-ownership-refinement.md) §1, a *deployment-layer* statement) should collapse to **one federation identity per deployment** is a genuine, **open** federation-model question. It is flagged in [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) and is **not** resolved by ADR-0017 or by this glossary. Federation identity remains **per-org** until an ADR says otherwise.

**Not to be confused with:** an *instance* (the deployment), a *security domain* (the ambient tier above org), a *containment domain* (the grouping below org).

**In the code.** `orgs` (`apps/server/src/db/schema.ts:35`); `federation_self` (~:1009). Note that `orgs`, `state_transitions` and the nullable-`orgId` rows on `object_types` / `relationship_types` / `roles` are the deliberate exceptions to "every table carries `orgId`".

---

### instance

**Definition.** One running deployment of the SCP binary — API process plus worker, one Postgres. **One binary, roles not products:** an instance becomes a commander, an outpost or a retrans purely by configuration (`scp federation init --role …`). Same image, same Helm chart, same upgrade path.

An instance is **multi-tenant** (many orgs) and lives in exactly **one** security domain.

**Industry-standard?** No — ordinary English, but worth pinning because "instance", "domain", "outpost" and "org" get used interchangeably in conversation and they are four different things.

**Not to be confused with:** an *org* (a tenant inside an instance), a *security domain* (the tier the instance sits in), a role name (`commander` is what an instance *does*, not what it *is*).

---

### region

**Definition.** A geographic locality **within** a security domain — `amer`, `apac`, `emea`. Regions are a deployment/locality axis, entirely orthogonal to trust: `commercial-amer` and `commercial-apac` are two regions of one security domain.

**Industry-standard?** Yes — the cloud-provider sense (AWS/Azure/GCP regions), which is exactly how it is used here.

**Not to be confused with:** a *security domain* (a policy/authority boundary; regions do not cross it) or a *partition* (which in AWS terms is the *domain* analogue, not the region analogue — `aws-us-gov` is a partition; `us-gov-west-1` is a region inside it).

**In the code.** Regions are not a table; they appear as deployment-target attributes and executor bindings. One outpost owns Argo CD per region for a prod environment ([ADR-0017](adr/0017-ownership-refinement.md) §3; `apps/server/src/coordination/multiregion-argocd.integration.test.ts`).

---

### executor

**Definition.** A plugin implementing the executor interface against an execution system. Executors get exactly four verbs — **observe / trigger / status / abort** — and the platform holds no credentials to the infrastructure those systems manage (charter principle 1).

Each executor binding carries a **Type** ([ADR-0007](adr/0007-executor-binding-type-taxonomy.md)) — `build` / `infrastructure` / `configuration` — which is what routes a change to the right pipeline.

**The two scoped exceptions**, both pre-authorized at charter level: `scp-managed-iac` (trivial IaC releases for pipeline-less orgs, ephemeral containers, vaulted scoped credentials) and the proposed `scp-runner-ops` (host-reaching Ansible from a closed, cosign-signed task catalog, never arbitrary shell). A third managed component, `scp-managed-scan`, runs the commander-side promotion scan ([ADR-0020](adr/0020-first-class-commander-scanning.md)).

**Industry-standard?** No — SCP-specific. Closest analogues are Backstage's "actions" and Crossplane's "providers", neither of which is a good match.

**Not to be confused with:** an **execution system** (the external thing itself — see next entry) and a **control plugin** (which produces gate evidence, not execution).

**In the code.** `packages/plugins/` — `argocd`, `github`, `gitlab`, `gitea`, `terraform`, `managed-iac`, `harbor`, `fake-executor`; bindings in `apps/server/src/coordination/executor-bindings-repo.ts`.

---

### execution system

**Definition.** The registered **external system** an executor talks to: a specific Argo CD, a specific GitHub org, a specific Argo Workflows. A first-class graph object type, so the graph records *which* Argo CD a binding points at and the UI can deep-link into it.

**Industry-standard?** No — SCP-specific, introduced with the Mode A "import your existing executors" work.

**Not to be confused with:** the **executor** (SCP's plugin *for* that system) and the **deployment target** (the place inside that system an executor acts on).

**In the code.** Object type `execution-system`, seeded at `apps/server/drizzle/0019_execution_system.sql:9`; its `serverUrl` is the deep-link base the UI uses (`apps/web/src/components/pipeline/StageCard.tsx`).

---

### coordination, not execution

**Definition.** The charter's first non-negotiable principle: CommanderSCP **does not** build, test, scan, sign, provision, or deploy anything itself. Every phase runs on a coordinated execution system — bundled or bring-your-own — and SCP triggers it, observes it, gates it, and consumes its results as evidence.

Two scoped execution exceptions exist, both pre-authorized by owner decision and both behind the same executor interface, in ephemeral containers, with vaulted scoped credentials: **`scp-managed-iac`** (2026-07-08) and the proposed **`scp-runner-ops`** (charter amendment 2026-07-12). A third managed component, **`scp-managed-scan`**, runs the commander-side promotion scan step ([ADR-0020](adr/0020-first-class-commander-scanning.md)).

Where this bites the vocabulary: the commander **cosign-signs only its own promotion manifest** — never an origin artifact and never the SBOM. The *executor* signs those, at build ([ADR-0015](adr/0015-cosign-cross-boundary-signing.md) §5).

**Not to be confused with:** "orchestration". SCP deliberately does not orchestrate progressive delivery — canary, analysis and promote happen inside Argo Rollouts, and SCP mirrors them via `observe()`.

**In the code.** `docs/proposals/promotion-and-execution-model.md` §0 is the canonical statement; `apps/server/src/coordination/observe.ts` and `reconcile.ts` are the loop.

---

### scan gate

**Definition.** A **boundary-crossing authorization gate** whose evidence is a vulnerability-scan verdict bound to an artifact **digest**. It exists to authorize a cross-domain promotion — it is deliberately **not** a general code-quality gate.

Two consequences follow directly from that framing and are load-bearing:

- **Domain-local artifacts are never scanned** — they never cross a boundary, so there is nothing to authorize.
- **Receivers never re-scan** — they trust scan-at-source and verify signatures instead. Outposts stay light by design.

Pass-criteria are **scoped, most-restrictive-wins** over six tiers — platform → security domain (trust domain / partition) → org → containment domain → service → component — resolved as a per-severity MIN, which is order-independent. A child scope may only **tighten** ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md)).

**Industry-standard?** SCP-specific as a *gate framing*. The mechanism (Trivy verdicts, severity thresholds) is entirely conventional; what is ours is treating the scan as boundary **authorization** rather than quality.

**Not to be confused with:** a CI security scan (a quality gate inside someone else's pipeline — SCP can consume its evidence, but that is an alternate ingress, not the gate itself).

**In the code.** `packages/plugins/scan-result-control/`, `apps/server/src/federation/promotion-scan-step.ts`, `apps/server/src/governance/gate-orchestrator.ts` (`buildControlContext` threads `artifactDigest`).

---

### manifest

**Definition.** The **promotion manifest**: the commander-signed enumeration of *exactly* the artifacts authorized to cross a boundary. Its job is the "**nothing slipped in**" guarantee — a receiver verifies that the arrived set matches the signed set, with no additions and no substitutions.

The commander cosign-signs **only** this manifest. The executor cosign-signs the artifacts and the SBOM, at build ([ADR-0015](adr/0015-cosign-cross-boundary-signing.md) §5).

**Not to be confused with:** an **OCI image manifest** (the registry's own descriptor document — a real collision, since SCP handles both), a Kubernetes manifest (a YAML resource file), or an **SBOM** (a component inventory, not an authorization).

**In the code.** `PromotionManifestSchema` in `packages/schemas/src/federation.ts:436`.

---

### control

**Definition.** An abstract **graph object** declaring a category — security / quality / operational / compliance / custom — and a contract. **ControlPlugin implementations are bindings**, which is what makes swapping Trivy for Snyk a binding change and never a policy change.

Outcomes are standardized: `pass | fail | warning | skipped | timed_out | expired`, always with an evidence payload that Decision records reference. **Human controls** materialize as approval tasks with N-of-M quorum; a **hybrid** gate requires both a scan and a human sign-off.

**A gate** is a set of control bindings attached to a wave boundary or a lifecycle edge. A gate is satisfied when its **required** controls pass; advisory and recommended controls annotate without blocking.

**Industry-standard?** "Control" in the NIST SP 800-53 sense (a security control) is the ambient meaning in this market, and SCP's usage is compatible with it but broader — an SCP control is any pluggable check, including purely operational ones.

**In the code.** `apps/server/src/governance/controls-repo.ts`, `control-runner.ts`, `gate-orchestrator.ts`; `apps/server/src/coordination/gates.ts`; plugins `packages/plugins/scan-result-control/`, `webhook-control/`.

---

### decision

**Definition.** The persisted, explainable verdict record every engine judgement writes: kind, subject, verdict, the full **input context** snapshot (policy versions consulted, control outcomes with evidence references, graph facts, actor, time) and a structured **reason tree** rendered to human text.

Charter principle 6 makes two promises here: every engine verdict persists a Decision with its inputs, and **every blocked response carries a `decision_id`**. Because policy evaluation is a pure function (context in → verdict + reason tree out), explainability is literally the return value rather than a logging afterthought.

**Industry-standard?** No — SCP-specific. OPA's "decision logs" are the nearest cousin, but those are a logging feature; this is a first-class record written in the same transaction as the action.

**In the code.** `decisions` table (DESIGN.md §10.4), `apps/server/src/coordination/decisions-repo.ts`; the UI's "Why?" links resolve to it.

---

### poke / poke-mode

**Definition.** An **optional, per-outpost, contentless** wake signal from the commander to an outpost or retrans: *"something is pending, come pull."* The signal carries **no data**. All data continues to flow outpost→commander via pull. When poke-mode is enabled for an outpost, that outpost's frequent interval poll is disabled; it pulls on poke, backed by a sparse safety-net reconcile so a dropped poke self-heals.

**Off by default**, set per outpost (some poll-mode, some poke-mode on the same instance), authenticated by the same enrolled-commander mTLS peer identity the outpost already trusts, idempotent and rate-limited.

**The invariant, precisely restated** ([ADR-0009](adr/0009-optional-poke-mode-federation.md)): the guarantee is no longer "the commander never initiates a connection to an outpost" but rather —

> no **data** flows commander→outpost; the commander MAY send a **contentless, authenticated wake signal** to an outpost — and only where that outpost is explicitly configured for poke-mode and the topology and accreditation permit it.

The data-direction guarantee is **unchanged**; only the *triggering* direction is relaxed, and only opt-in. Regulated partitions (FedRAMP/IL) simply leave it off.

Poke reaches air-gapped domains **via the retrans chain**, hop by hop — the commander never dials the outpost directly.

**Not to be confused with:** a webhook (poke carries no payload and no state), and push-based federation (which does not exist and will not).

**In the code.** `apps/server/src/federation/poke-sender.ts`, `poke-rate-limit.ts`; per-peer flag on `federation_peers`.

---

## Deprecated / avoid

| Don't say | Say instead | Why |
|---|---|---|
| bare **"domain"** as a tier name | **"security domain"** (the trust tier) or **"containment domain"** (the intra-org object type) | Five live rival senses — DNS, Windows/AD, DDD bounded context, identity realm, and our own object type. Banned in prose *and* as a stored value: the floor table's tier literal is `trust_domain`, never `domain` ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology; DESIGN.md:481). |
| **"promotion"** unqualified when a security-domain crossing is meant | **"cross-domain promotion"** | Bare promotion is the genus and carries no boundary implication. Dropping the qualifier silently claims a CDS gate ran when it may not have. |
| **"promote" / "promoted"** for the change approval gate | **"accept" / "accepted"** | It is a human approval and a terminal success state, not an artifact advancing — the collision fights the genus/species model (D5). **The code still spells it `promote`/`promoted`**; the rename is a tracked follow-on PR ([ADR-0021](adr/0021-terminology.md) Consequences ii). |
| **"release"** meaning a single push into one environment | **"deployment"** | A release is the whole versioned unit moving through its pipeline; a change *is* a release. Also: in DoD/IC usage "release" means a **disclosure determination**, which is the last thing you want an accreditation reader to infer. |
| **"stage"** meaning a pipeline **phase** | **"phase"** or **"step"** | "Stage" is reserved for a (security domain × environment) place (D6). Code comments currently misuse it; cleanup is tracked ([ADR-0021](adr/0021-terminology.md) Consequences iii). |
| **"stage"** meaning a **wave** | **"wave"** | Same reservation. The UI currently mislabels waves as stages (`apps/web/src/components/pipeline/StageCard.tsx`, `apps/web/src/routes/change-pipeline.tsx`); cleanup is tracked, not done. |
| **"bundle"** unqualified | **"promotion bundle"** / **"air-gap federation bundle"** / **"relay tarball"** | Three different things, only one of which carries artifact bytes. |
| **"parent" / "child"** for federation roles | **"commander" / "outpost" / "retrans"** | Removed outright, not aliased, by [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md). (The words remain correct for *process* supervision and RBAC containment walks — that is a different concept.) |

**Note on `stage`:** no `stage` entity exists in the schema today, and no `(domain × environment)` compound name such as `gamma-commercial` appears anywhere in the repository. "Stage" is reserved vocabulary a future entity may fill — the reservation is a decision about what the word will mean, not a claim that the thing is built.

---

## See also

- [ADR-0021 — Terminology](adr/0021-terminology.md) — the six decisions, the rejected alternatives, the cost table, and the three tracked follow-on code PRs.
- [ADR-0016 §Terminology](adr/0016-scoped-scan-requirement-policies.md) — the trust-domain / containment-domain split this glossary generalizes.
- [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md) — commander / outpost / retrans, and the precedent for a breaking pre-1.0 enum rename.
- [docs/proposals/promotion-and-execution-model.md](proposals/promotion-and-execution-model.md) — the authoritative end-to-end workflow these words describe.
- [DESIGN.md §9](DESIGN.md) (change lifecycle, plans, waves, gates) and [§13](DESIGN.md) (federation).
