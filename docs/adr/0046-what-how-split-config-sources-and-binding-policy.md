# ADR-0046: Teams author the WHAT, domains author the HOW — config sources, the `executorBinding` policy effect, and the domain reconciler

**Status:** **Accepted** — owner rulings made in-session 2026-08-26 and recorded in [docs/proposals/team-pipeline-iac.md](../proposals/team-pipeline-iac.md) §0 (D2, D3, D4, D7, D9, D10) and §14 (resolutions 1, 2, 7). This ADR is that acceptance for the delivery architecture; it does not re-open any ruling.

**Numbering note (claimed 2026-08-26):** a census of `docs/adr/` on `origin/main` **and every remote branch** found `0045` the highest number anywhere, so this document takes `0046`. Per [ADR-0044](0044-multi-region-instance-resilience.md)'s own numbering note, **an ADR number reserved by a census is valid only as of that census** — re-run it against `main` immediately before merge.

**Relates to:** [ADR-0031](0031-domain-local-objects-never-federate.md) (`source_mappings` and `executor_bindings` never federate — the one real tension with the ask, and the ADR this design deliberately leaves **unamended**), [ADR-0017](0017-ownership-refinement.md) (domain HOW ownership), [ADR-0016](0016-scoped-scan-requirement-policies.md) (`scanThreshold` — the scoped-policy-effect precedent), [ADR-0032 §3a](0032-dependency-subscriptions.md) (`dependencySubscription` — the second policy-effect precedent, and the dependency-subscription machinery D10 rides), [ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) (the fake-success hazard an unbound placement reaches), [ADR-0007](0007-executor-binding-type-taxonomy.md) (the executor Type taxonomy the policy effect keys on), [ADR-0027](0027-service-rung-binding-resolution.md) / [ADR-0029](0029-containment-ancestor-binding-rung.md) (the nearest-rung ladder D8's default moves down), [ADR-0028](0028-stage-scoped-component-coupling.md) (the hold shape freezes reuse), [ADR-0030](0030-dev-branch-pipelines.md) (dev pipelines by source ref; `source_mappings` identity is the `(repo, path, ref)` tuple), [ADR-0012](0012-registry-consolidation.md) (the org's own Gitea npm registry D10's standards packages publish to), [ADR-0014](0014-git-provider-abstraction.md) (`@scp/git-provider-core`, whose `readFileAtRef` this design leans on), [ADR-0026](0026-placements-and-derived-stage-names.md) (placements), [iac-placements.md](../proposals/iac-placements.md), [iac-stack-ownership.md](../proposals/iac-stack-ownership.md) (`managed_by_stack` pruning), [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principle 1 (coordination, not execution).

---

## Context

The owner asked for a headline product capability: **a team defines the pipeline for its service and components as code, in git, and that definition takes effect across every outpost and security domain** — connected, disconnected, and air-gapped — with SCP syncing the repos and registering the IaC itself.

The measured foundation (2026-08-26, proposal §2) needs no recreation. `@scp/iac` is a CDK-style construct library with **pure synth** producing a `DesiredStateManifest` that `scp plan` / `scp apply` POST to `/plans`; the **server** diffs desired against actual (`apps/server/src/iac/plan-diff.ts`), prunes within the stack it owns via the server-owned `managed_by_stack` column, and authorizes **per diff entry** (`plans-repo.ts`). A role binding for a team at a service scope already confines a team's stack to its slice of the graph. Manifests already express objects, relationships, placements, source mappings, executor bindings, dependency producers and governance rungs. Federation is typeId-agnostic: every non-domain-local object write journals in the same transaction, and a newly declared object reaches every domain with **zero federation-layer changes**.

Two things were missing, and one thing was in the way.

Missing: **repo-driven delivery** (today's IaC is CLI-push only; no GitOps-for-SCP exists anywhere in the design), and a way for one declaration to reach domains the authoring team has no access to.

In the way: **[ADR-0031](0031-domain-local-objects-never-federate.md)**. `source_mappings` and `executor_bindings` never federate — the routing layer is per-domain **by design**, because it is where credentials, executor addresses and local topology live. A naive reading of the ask ("one repo drives every domain") requires either federating the routing layer or having the commander hold every domain's execution credentials. Both are wrong: the first amends ADR-0031 to remove exactly the property it exists to guarantee, and the second violates charter principle 1's rule that the platform does not hold credentials to the infrastructure execution systems manage.

There is also a standing quality problem this design must not repeat. `POST /discovery/accept` is the only observation-driven graph-write path, and it bypasses strict create — the homelab's ~50 imported components landed as RBAC orphans. Any new automatic write path has to be better than that by construction, not by intent. (That path's retirement is [ADR-0047](0047-discovery-scaffolder-land-through-review.md); this ADR only inherits the lesson.)

---

## Decision

**Split the declaration in two along the line that already exists in the architecture: teams author the WHAT, which federates as ordinary graph objects; each domain authors the HOW once, locally; a domain-local reconciler joins them.** ADR-0031 stands unamended, and no federation-layer change is required.

```
component repo (commander domain)        commander                    every outpost
┌───────────────────────────┐   sync   ┌──────────────┐   journal   ┌──────────────────┐
│ payments-api/scp/stack.ts │ ───────▶ │ plan → apply │ ──────────▶ │ read-only WHAT   │
│ payments-api/scp/         │  (JSON   │ (Decisions,  │  (mTLS or   │       ×          │
│   manifest.json           │   only)  │  freezes)    │  .scpbundle │ binding policy   │
└───────────────────────────┘          └──────────────┘  via retrans│  (domain-local)  │
                                                        └───────────│ = executor_      │
                                                                    │    bindings      │
                                                                    └──────────────────┘
```

- **WHAT** — team-owned, in the repo, global: service, components, placements, release topology, and source mappings for commander-domain repos. These are ordinary graph objects and existing manifest collections. They federate today.
- **HOW** — domain-owned, authored once per domain, local: a **binding policy** saying which local execution system serves which targets for which Type. A domain-local reconciler joins the federated WHAT against the local policy and materializes `executor_bindings`.

Teams never file per-outpost binding tickets. Adding an outpost to the promotion path is one local policy line. Credentials never leave the domain.

### 1. The config source, and what SCP will and will not read (D2, D9)

A **config-source** registry object — graph-native registry data, not a new top-level table — declared at the instance that owns the repo. It carries the repo identity (provider + identity, resolved against a registered git execution-system binding using the same repo-identity matching as `manifest-reader.ts` — never "the org's first github binding"), the `ref`, the path globs selecting stack manifests, and per-stack ownership mapping `stackName → team`.

**SCP never executes team-authored code.** Teams author TypeScript constructs; **their own CI** runs synth and commits the resulting manifest JSON beside the source, with a drift check — the monorepo's own committed-codegen convention, turned outward. SCP reads only the declarative JSON, validates it against `DesiredStateManifestSchema`, and plans from it. This keeps charter principle 1 intact and keeps a supply-chain execution surface from appearing inside the coordination plane.

**Registration is by git namespace/pattern → owning team** (`git.corp.example/payments/*` → `team-payments`), not repo by repo. One registration covers a team's whole fleet of component repos. Each matched repo's stack applies **as that team** — ~~via a service-account subject bound to that team's roles~~ **the team object is itself the acting subject (owner decision 2026-08-27, correcting the struck clause)** — so authorization is exactly the existing per-diff-entry `authorize()` — a team's stack cannot mutate another team's service no matter what its manifest claims.

> **Why the correction, and why it is a simplification rather than a compromise.** The service-account phrasing described machinery that does not exist: measured on `main`, **no credential type authenticates as a `service-account`** (`auth/pat.ts` binds a PAT to a *user*; `auth/local-auth.ts` resolves a session to `user.objectId`), and nothing maps a team to one. Building that identity would have meant a designation mechanism, an edge, and a resolution walk — all to produce an `actorObjectId`.
>
> None of it is needed. `authz/resolve.ts` seeds its recursive CTE **at the subject itself** (depth 0) and walks `member_of` *upward*, so a `team` object's own role bindings resolve directly; a team is already a first-class RBAC subject, exactly as `routes/ownership.ts` treats it. The sync loop is not an HTTP caller, so it needs no credential at all — `computeDiffForManifest` / `prepareApplyChecks` / `executePlanDiff` take `actorObjectId` as a plain parameter, and the config source already declares `stackName → team`. The team's object id **is** the subject.
>
> A second property falls out for free and is worth stating, because it would otherwise have had to be engineered: **the audit trail distinguishes the two delivery modes by construction.** A CLI push (D7) authenticates as a *user* and is recorded as that user; a repo-driven sync is recorded as the *team*. "Who applied this, and through which door" is answerable from the subject alone.
>
> **What has NOT changed is the guarantee.** The sync loop must resolve a real subject and run the real `prepareApplyChecks` → `authorize()` loop exactly as the HTTP route does. The tempting shortcut — calling `executePlanDiff` directly with a system actor, the way the reconcile engine does for its own writes — would silently void this ADR's central promise that a team's stack cannot mutate another team's service. A repo matched by two patterns, or a stack name already owned elsewhere, is a **loud refusal at sync**, never last-writer-wins.

Locality follows the registering instance: registered at the **commander**, the stacks it applies are global config and federate as usual; registered at an **outpost** (ADR-0017 domain-owned repos, ADR-0030 dev pipelines), the config source and everything it applies is `domainLocal` and never journals.

### 2. Merge is the approval; freezes hold, they do not block (D3)

Merge to the registered `ref` **is** the approval — CODEOWNERS plus the PR review gate authorship, which is the control teams already run their code through. On each sync SCP lists changed manifest paths, reads each, validates, and runs plan/apply per stack as that stack's team identity.

Every plan persists as a **Decision** carrying the manifest content hash and the repo commit SHA in `inputContext`. The boundary goes in the Decision, never `now` — the same determinism rule the rest of the platform follows.

**An active freeze whose scope covers an affected object holds the apply** (re-evaluated each sync/tick, the ADR-0028 hold shape) and applies when lifted. It does not fail the sync and does not silently skip. Freeze semantics for config applies reuse `checkFreeze` unchanged.

**Failure is honest.** A manifest that fails validation, or an apply refused by authz, freeze, or strict-create, produces a visible config-source status on API, CLI and UI, plus a Decision. *The repo being ahead of the graph is a displayed state, never an inferred one.* This is the direct lesson from the orphan-import history: an automatic write path earns its keep only if the cases where it did not write are as visible as the cases where it did.

### 3. CLI-push stays first-class; one stack has one owner (D7)

Registering a repo is something an org **can** do, never something it must. `scp plan` / `scp apply` from a terminal or from a team's own CI remain fully supported and unchanged. Config sources are **additive delivery on the same `/plans` engine** — same diff path, same Decisions, same freezes, same authz. PR-time dry-runs (`scp plan --manifest`, diff posted as a PR comment) work in both modes.

The one new rule is **single ownership per stack**: a stack bound to a config source is repo-owned, and a direct CLI apply against it is **refused with a 409 naming the owning config source**. Without that rule the next sync would silently revert the push — the worst of both delivery modes. Removing the stack from the config-source registration returns it to CLI-push.

### 4. The `executorBinding` policy effect and the domain reconciler (D4, §14 res 2, §14 res 7)

The HOW is a **policy effect**, following the `scanThreshold` (ADR-0016) and `dependencySubscription` (ADR-0032 §3a) precedent, rather than a new object type — scope is a deployment-target, container, or containment domain; effect names the local execution system and the Type it serves. Authored by domain operators holding `policy:write` at that scope. Domain-local by default.

A **domain-local reconciler** (a background loop, running at any instance role) walks the placements visible in-domain, resolves the winning policy per (placement, Type), and creates or updates `executor_bindings` rows using the executor-binding identity rules already in force (1:N per target keyed by purpose/Type, ADR-0007). Removal of a placement or of a policy prunes the derived binding. **Teams never author bindings.**

Three properties are load-bearing:

- **Unbound is loud, and there is no commander-side default.** A placement no policy matches surfaces as unbound on the config-source and pipeline-view status. There is deliberately **no org-tier fallback executor**: a missing (target, Type) policy dispatches nothing and says so. This keeps domain HOW ownership (ADR-0017) crisp, and it fixes an existing hazard rather than adding one — an unbound placement **fake-succeeds** under stage-shaped compilation ([ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) case (a), the post-import hazard). Turning "no binding" from a silent state into a reported one is a safety improvement on its own merits.
- **Derived bindings carry provenance.** Rows the reconciler owns are marked as reconciler-managed, so hand-authored bindings — which remain legal, e.g. one-offs — are never pruned by it. The provenance is **read from the row**, not inferred from which policy happened to match.
- **The test lane is a dedicated key.** The policy carries a `test` lane alongside the build lane, and **falls back to the build lane when a domain does not set one**. The lane key and its fallback rule are binding-policy semantics and are recorded here; the *shape* of what runs in that lane — test-hook, workflow, rollout and evidence types — belongs to the increment-8 contract in `@scp/schemas` and is cited from there rather than restated in prose, so this ADR cannot go stale against it.

### 5. Sync scope: every outpost receives all WHAT (§14 res 1)

Declarations are small metadata, and placements for other domains sit inert at an outpost. No per-peer narrowing ships; it waits for a real tenant ask. This is what keeps the federation layer unchanged — the journal stays typeId-agnostic and no filtering rule enters it.

### 6. Cross-repo inheritance is a package import resolved at synth (D10)

A standards repo publishes versioned wave shapes, helpers and conventions as a package on the org's **own registry** (Gitea npm, already the default unified registry per ADR-0012, so air-gap-clean). Component repos `import` it and **their CI resolves it at synth time**. The synthesized manifest stays flat and fully explicit; **SCP never fetches, composes, or merges manifests server-side.** Fleet-wide standards rollout rides the already-built dependency-subscription machinery (ADR-0032): the standards package publishes, subscribed component repos receive the bump as a PR. Pipeline-structure standards update like any other dependency.

### 7. Where declarations live (D9)

Each component's own repo carries `scp/stack.ts` and its committed `scp/manifest.json`. The service object is declared once in a thin home — a small team repo, or the platform repo's team slice — and component repos reference it by name. Central repos remain for exactly three things: the platform estate, the per-domain HOW stacks, and importable standards. This revises the original "single config repo" framing; hundreds of engineers are never bottlenecked on one shared repo.

---

## Consequences

**Positive**

- ADR-0031 needs no amendment, and the federation layer needs no change at all. The capability is bought with one new registry object, one new policy effect, and one reconciler.
- Credentials stay in the domain that owns them. The commander never learns an outpost's executor addresses or secrets.
- Adding an outpost to a team's promotion path is a single local policy line, authored by the people who own that domain, with no ticket to the team and no edit to the team's repo.
- "No binding" becomes a reported state instead of a silent one, closing a live fake-success hazard (ADR-0006 case (a)).
- Both delivery modes ride one engine, so there is exactly one diff/apply/authz/freeze path to reason about, test, and audit.

**Negative, and accepted**

- Two authoring surfaces exist (team WHAT and domain HOW), so a placement can be correct and still not run. The mitigation is the loudness rule in §4 — this is precisely why unbound-and-loud is not optional.
- Every outpost receives declarations it will never act on (§5). Accepted as small metadata; revisit on a tenant ask.
- Merge-is-approval moves the review gate into the team's git provider. SCP records the commit SHA in every Decision, but the quality of the review is the org's CODEOWNERS configuration, not something SCP enforces.
- A repo-owned stack refusing CLI apply (§3) is a new 409 an operator can hit; it names the owning config source so the refusal is self-explaining.

**Follow-ups carried into later increments** (proposal §13; each lands with its own verification tests)

- Blocking pre-work: bounded multi-file/tree reads in `@scp/git-provider-core`, and closing the M21.2 Gitea/GitLab unbounded-buffer gap, **before** leaning harder on `readFileAtRef`.
- Verify placement federation through the pair-bound doors — that the import path materializes placements with their derived edges intact.
- Locality defaults for pipeline-declared targets: infra products must federate even when declared from otherwise team-scoped stacks.
- Known traps on file for every new consumer: `source_mappings` identity is the `(repo, path, ref)` tuple (ADR-0030 — key on all three); startup kicks for any new loop are **UNKEYED** (the pg-boss singleton swallow); the reconcile loop is a **competing consumer** (route work to it, do not listen alongside it).

---

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Federate `executor_bindings` / `source_mappings`** so one repo writes routing everywhere | Removes exactly the property ADR-0031 exists to guarantee. Routing carries domain-local credentials, addresses and topology; federating it either leaks them upward or makes the commander author config it cannot validate. The WHAT/HOW split gets the same user-visible outcome with the invariant intact. |
| **Commander holds each domain's execution credentials** and dispatches centrally | Violates charter principle 1 — the platform does not hold credentials to the infrastructure execution systems manage — and collapses the air-gap story, since the commander cannot reach a disconnected domain's executors by construction. |
| **SCP executes the team's TypeScript** (synth server-side) | Charter principle 1 again, plus an arbitrary-code-execution surface inside the coordination plane and a supply-chain problem with no good answer. D2's committed-JSON convention gets the ergonomics with none of it. |
| **SCP composes/merges manifests server-side** so standards can be inherited centrally | Makes the applied state a function of server-side resolution nobody can reproduce locally, and re-introduces the "what will actually apply?" question the explicit manifest answers. D10 puts inheritance at synth, in the team's own CI, where it is an ordinary package version. |
| **One config repo for the whole org** (the original framing) | Bottlenecks every team on one repo's review queue and one CODEOWNERS file. D9 moves declarations next to the code they release, with pattern registration keeping the ceremony to one per team fleet. |
| **Repo-watching replaces CLI push** | Would force every org into GitOps to use IaC at all. D7 keeps CLI-push first-class and makes config sources purely additive delivery on the same engine. |
| **An org-tier default executor** as fallback when no domain policy matches | Silent defaults are how an unbound placement fake-succeeds today. §14 res 2 rules unbound-and-loud instead; a default would have re-created the exact class of bug this design closes. |
| **Last-writer-wins for a repo matched by two registration patterns** | Ownership ambiguity in the authorization path is not a merge conflict to resolve heuristically. It refuses loudly at sync. |

---

## Charter check

| Principle | Verdict |
|---|---|
| 1 Coordination, not execution | **Holds.** SCP reads declarative JSON (the `readFileAtRef` precedent); it never executes team code (D2). No new credential classes; domain credentials never leave the domain. |
| 2 Graph-native | **Holds.** Config source is a registry object; the binding policy is a policy effect on the existing precedent; the pipeline stays derived. No new top-level concept table. |
| 3 API-first parity | **Improved.** Config-source registration and status land API → SDK → CLI → IaC → UI, closing surfaces that had no dedicated CLI or UI at all. |
| 4 PostgreSQL only | **Holds.** Sync and reconcile are existing loop shapes (pg-boss / tick). No new stateful service. |
| 5 Air-gap first-class | **Holds structurally.** Outposts consume the graph, not the repo; **neither outposts nor retrans ever touch git.** Bundles and retrans are unchanged. |
| 6 Explainability | **Holds.** Every plan, apply, hold and refusal is a Decision; config-source status makes repo-ahead-of-graph visible rather than inferable. |
| 7 Priorities | The WHAT/HOW split is the Simplicity/Federation trade taken deliberately: no federation-layer change, one new policy effect, one reconciler. |
