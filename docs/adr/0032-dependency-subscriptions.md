# ADR-0032: Dependency subscriptions — a declared inventory, a three-level enablement chain, and a managed bump actuator

**Status:** Proposed (2026-08-13) — five decision points settled with the owner on 2026-08-13. **The §8 actuator is now BUILT (M21.5, 2026-08-16) on the charter amendment it was contingent on (approved 2026-08-13, qualified 2026-08-15); §8a–§8f are that build's own normative clauses, every one of them a defect an adversarial review found in a component that was correct and had no caller.** **Amended 2026-08-13 (§3a, during M21.3): the subscription is a `dependencySubscription` POLICY EFFECT, not a new built-in object type — which makes proposal §10 Q6 moot for M21 as built.** **Amended 2026-08-16 (§3a-i): §3a's own attachment clause was wrong — a subscription is attached by the policy's `properties.scope`, not by the `governed_by` edge §3a named; the ADR now agrees with the code comment that caught it.**
**Context doc:** [docs/proposals/dependency-subscriptions.md](../proposals/dependency-subscriptions.md)
**Relates to:** [ADR-0002](0002-execution-strategy.md) (the four-arm ownership test and six-gate boundary test this feature must pass); [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (SCP stores no SBOM bytes); [ADR-0016](0016-scoped-scan-requirement-policies.md) (the multi-tier resolution shape reused here); [ADR-0022](0022-outpost-config-authority-split.md) (commander-declared config must be a graph object to reach an outpost); [ADR-0028](0028-stage-scoped-component-coupling.md) (`provides`/`requires` — prior art for the wait predicate); [ADR-0030](0030-dev-branch-pipelines.md) §2 (declared, never inferred); [ADR-0031](0031-domain-local-objects-never-federate.md) (domain-local work does not journal)

## Context

A component team wants to subscribe to a **major line** of a dependency and receive each new release on
that line as an automatic code change, at a chosen granularity (minor-and-patch, or patch-only), across
internal and third-party dependencies and across five ecosystems including container base images.

The proposal holds the full reasoning and the measured grounding. Five facts measured at HEAD
(2026-08-13) drive every clause below.

1. **`depends_on` is unavailable.** It is endpoint-constrained to `service|component →
   service|component` (`drizzle/0002_rls_rbac_seed.sql:181-183`) and is simultaneously the wave-plan
   toposort input, the `impact-of`/`blast-radius` default relType, and the `stageDependencies`
   materialisation target (`drizzle/0054:9,27`, `drizzle/0055:92`). A cycle among co-placed targets is a
   hard plan-compile error; package graphs routinely contain cycles.
2. **Package coordinates are not representable as URNs.** `urn:scp:{org}:{type}:{slug}` lowercases and
   hyphenates (`graph/urn.ts:1-18`), collapsing `@acme/lib`, `acme/lib` and `acme-lib` into one URN;
   collision is a 409 with no auto-suffix. SCP also has **no artifact name at all** — `ArtifactRef` is
   `{type, digest}` and no `purl` exists in the tree.
3. **Bulk graph writes are measured-expensive.** Two per-org `pg_advisory_xact_lock`s held to commit plus
   an Ed25519 signature per journal row; the `impact-of` recursive CTE measured at 7+ minutes then disk
   exhaustion at fan-out 8–14, against a 5s production `statement_timeout`.
4. **Federation cuts both ways.** Config that must reach an outpost must ride `object_upsert` as a graph
   object (ADR-0022 clause 2) — nothing table-shaped can travel. But a new **built-in** type is unsafe
   mid-fleet-upgrade: `import-repo.ts`'s `object_upsert` branch has no try/catch and `createObject` 404s
   on an unregistered type, so one such object wedges a not-yet-migrated outpost's signed bundle. A
   **runtime** custom type federates to nobody.
5. **SCP has never written to a user repo.** No git client dependency, no branch/commit/PR hook on
   `GitProviderAdapter`, and the only repo write in the tree (`postCommitStatus`) posts a commit *status*
   and is unwired. `ExecutorPlugin`'s four verbs *are* the structural enforcement of charter principle 1.

## Decision

### 1. The feature is four separable pieces, and only the fourth touches the charter

Inventory, subscription-and-enablement, detection, and actuator are built and reasoned about separately.
Pieces 1–3 are charter-clean. Only the actuator (§8) requires an amendment.

Pieces 1–3 must not be shipped and called done: the requirement **is** the code change.

### 2. Vocabulary — "dependency subscription", always qualified

Bare *subscription* stays with `notification_bindings`. The full term is used in code, API, CLI and UI.
The GLOSSARY entry is authoritative (CLAUDE.md) and lands before any code.

### 3. The inventory is a projection table; the subscription is a graph object

A **scoped, deliberate bend of charter principle 2**, justified by Context 2, 3 and 4 and anticipated by
DESIGN §5's closure-table escape hatch.

- **Inventory** (`dependency_lines`, `component_dependencies`) is derived, per-domain, high-churn
  observation data — the category `change_source_events` and `object_health` already occupy. It is a
  projection table, it does not federate, and each domain derives its own.
- **Dependency subscription and its enablement** are declared config that must reach outposts, so they
  are a **graph object** riding `object_upsert` (ADR-0022 clause 2).

**Boundary, load-bearing:** nothing in the dependency path may expose a **transitive traversal**. That
boundary is what makes the table representation sufficient; without it the graph would be necessary
again, and Context 3's measurement would apply.

### 3a. The subscription is a POLICY EFFECT, not a new object type (2026-08-13, M21.3)

Amending §3's "a graph object" to name the mechanism precisely, because the obvious reading — a new
built-in `dependency-subscription` object type — walks straight into Context 4 and would have made
proposal §10 Q6 a hard prerequisite.

A **dependency subscription is a `dependencySubscription` effect on an ordinary `policy` object**,
attached by the existing `governed_by` edge and resolved by the existing `matchPoliciesForTargets` /
`resolvePolicies` / `containmentChain` machinery. This mirrors `scanThreshold` (ADR-0016) exactly —
the shipped precedent for governed, federating, multi-tier configuration, built this way for these
reasons.

Four consequences, all improvements:

1. **No new built-in object or relationship type ships at all.** Context 4's federation hazard is not
   merely mitigated but **absent**, and **proposal §10 Q6 is moot for M21 as built** — it stays open
   as a general hardening question about the importer, not a prerequisite for this feature.
   *(Measured while settling this: the failure mode Q6 describes is a Postgres **foreign-key
   violation, 23503**, not the 404 originally reported — `objects.type_id` references
   `object_types.id` and `objects-repo.ts` has no type-existence check. So the fix, if ever made,
   cannot be a copy of `relationship_upsert`'s skip-on-400: that catch would not fire.)*
2. **It federates already.** `policy` is a built-in type on every instance and the importer's
   `policy_upsert` shares the `object_upsert` case — no new journal entry kind, no new registration,
   nothing for an outpost to be missing.
3. **Charter principle 2 is satisfied in its own words** — "new concepts arrive as
   relationship/**policy**/registry data" — rather than bent a second time.
4. **The merge stays ours.** Like `scanThreshold`, `dependencySubscription` is deliberately **NOT**
   added to `policy-model.ts`'s `PolicyEffect` union: that union drives the gate's require/approve
   enforcement, and an enablement bit is not an "unsatisfied effect". `mergeContributorEffects`
   already ignores unrecognised effect shapes, so existing enforcement is provably untouched, and
   §6's monotone AND is computed by this feature's own resolver over the matched contributions —
   exactly as `scan-requirements.ts` computes its own per-severity MIN rather than using the union.

The **instance-level unlock** is not a policy: it is instance-scoped rather than org-scoped, so it
follows the singleton-table precedent (migrations 0029 / 0035 / 0036) with operator-token-gated
writes — the same split ADR-0016 uses for its above-org tiers.

### 3a-i. Amendment (2026-08-16) — attachment is `properties.scope`, not a `governed_by` edge

**Status of §3a: unchanged.** The subscription is still a `dependencySubscription` effect on an
ordinary `policy` object, mirroring `scanThreshold` exactly, for all four consequences recorded
above. What was wrong is the one clause naming the attachment mechanism.

**§3a as originally written said** the effect is "attached by the existing `governed_by` edge". That
is not what shipped. `governed_by` is indeed a registered
`(organization|domain|service|component|team) -> policy` relationship type, but nothing in policy
resolution reads it today: `policy-resolve.ts` records it as the natural later optimization behind
the same function signature, and the shipped matcher works off the policy's own `properties.scope` —
`scope.objectRef` / `scope.selector` / `scope.group` — exactly as it does for every other policy,
`scanThreshold` included. A subscription is attached by authoring it at a scope, the same way a scan
ceiling is; mirroring `scanThreshold` "in every structural respect" means mirroring *that*, not
inventing a second attachment mechanism this feature alone would use.

**The `governed_by` mention is preserved, not deleted, because it is forward-compatible rather than
simply wrong**: if `governed_by` is ever materialised into the matcher, this module inherits it for
free, since resolution already goes through the unchanged `matchPoliciesForTargets` /
`resolvePolicies` / `containmentChain` machinery §3a describes. Found and corrected during M21.4;
the module doc at `dependencies/subscription-resolution.ts:38-45` states the corrected mechanism
in the code, and this amendment brings the ADR into agreement with it.

### 4. Direct declared dependencies only

The inventory is what a component's own manifests **declare**. The transitive closure is not stored:
ADR-0013 keeps SBOM bytes out of SCP deliberately, and a stored closure is that by another name. Both
queries the feature needs — *"which components subscribe to P?"* and *"what does C declare?"* — are
single-hop index lookups.

### 4a. WHAT ACTUALLY WRITES THE INVENTORY (2026-08-16, M21.2)

§4 says what the inventory IS — "what a component's own manifests declare" — and says nothing about
what reads them. Built without that, nothing did: `upsertComponentDependency` and
`pruneComponentDependencies` had **no non-test caller anywhere in the tree**, so
`component_dependencies` was empty on every real deployment. That is not one dead function. §6's
work-list, §7's third-party poll and §7a's manifest-path lookup all derive from that table, so the
whole feature above it resolved over nothing while every test passed — the **fifth** M21 component
built and never installed. The clauses below are normative because "there is a function that does
this" is not the same claim as "this happens".

1. **THE TRIGGER IS AN ACCEPTED CHANGE, THROUGH A ROUTER, ON THIS CAPABILITY'S OWN QUEUE.** Same
   shape and same reason as §7c clause 2: `boss.work()` is a competing consumer, so a second worker
   on `domain-events` would split the jobs with internal detection rather than add a listener. The
   two capabilities register two ROUTERS on the shared stream and one queue each. The accept — not
   the proposal — is the trigger, because it is the point this domain has decided is real and it is
   the same commit §7a derives a released version from, so the inventory and the released version
   are read at ONE commit rather than two. The manifest fetch happens **outside any transaction**
   (§7c clause 2 again).

2. **INGESTION IS GATED BY THE CHAIN'S FIRST TWO CONJUNCTS; THE THIRD SUBTRACTS DOWNSTREAM.** §6's
   consequence is stated in two deliberately different verbs — "a disabled component is never
   FETCHED and an opted-out dependency is never POLLED" — and building it showed the distinction is
   load-bearing rather than stylistic. Ingestion prunes each manifest down to exactly the lines it
   just read, so an opt-out that suppressed the WRITE would delete the record that the component
   declares that dependency at all; the inventory, the UI and §8's conflict check would then stop
   being able to see a dependency a team merely asked not to be bumped on, and re-enabling would
   need a fresh push to recover it. **An opt-out subtracts a SUBSCRIPTION, never an OBSERVATION.**
   The component-level gate is computed by `mergeDependencySubscription` itself over WITNESS lines
   built from the candidates' own selectors — an exact decision procedure, not a sample, and not the
   AND written a second time in a place no test of the merge can reach.

3. **MANIFEST PATHS ARE NOT DERIVABLE FROM ANYTHING STORED, SO THEY ARE PROBED — AND THE PROBE IS
   SCOPED TO THE REPOSITORY THIS PASS READS.** `source_mappings.path_pattern` is nullable and, where
   discovery writes one, it is a directory GLOB: a containment predicate, which can answer "is this
   path mine?" and cannot enumerate. There is no directory-listing primitive reachable from the
   server — `readFileAtRef` takes one path and refuses a directory. So ingestion GENERATES a
   candidate set (the six manifest filenames under the literal head of each `path_pattern`) and then
   FILTERS it back through the mapping's own predicate — generation guesses, the predicate decides —
   which `readFileAtRef`'s contract explicitly sanctions ("`not_found` is a routine answer"). It
   ALWAYS re-reads the paths already recorded for that component **in this repository** first: those
   are the only way a manifest at a non-standard location, or one that has been DELETED, stays
   visible. The reads are bounded per run and the paths the budget did not reach are reported BY
   NAME, because "42 candidates were not read" leaves an operator with no way to learn which
   manifests are frozen.

   Two derivations here are stated as rules because building them without saying so produced two
   defects. **The candidate set comes only from the mappings that name THIS repository**: deriving
   it from all of a component's mappings spends reads in the wrong repo and manufactures the
   `not_found` that clause 4's prune then acts on. **The repo root is a prefix only when a mapping
   constrains no path**: seeding it unconditionally made two components in one monorepo both claim
   the root `package.json` as their own declarations, even where `path_pattern` scoped each to a
   different subdirectory. A wildcard-free `path_pattern` is genuinely ambiguous between a file and
   a directory, and the one closed set that is knowable resolves it — a pattern ending in one of the
   six manifest filenames names that manifest, anything else is read both ways.

   *Known limit, stated rather than discovered:* a manifest at an unguessable path that has never
   been recorded is not found. The honest fix is to widen the discovery walk, which already observes
   the marker filenames and discards them at its `hasMarker` boolean; that is a change to three
   adapters and the `DiscoveryProposal` shape.

4. **A MANIFEST IS PRUNED ONLY ON POSITIVE EVIDENCE ABOUT ITS CONTENT.** Either it was read and
   parsed (prune to what it declares), or the provider said the PATH is not there (prune to nothing
   — the file was deleted). Every other outcome leaves that path's rows untouched and is reported
   with its own reason: a reader throw, a missing REF, an indeterminate not-found, each of
   `read-file.ts`'s four decode refusals, a Git-LFS pointer, an unparseable body. **Unreadable is
   not empty**, and the consequence of collapsing the two is not cosmetic: `listSubscribedComponentLines`
   derives subscription FROM these rows, so a component whose inventory is emptied by a bad read is
   silently unsubscribed from everything. Two splits carry this clause and neither is optional:
   `not_found` is split on `missing` (a force-pushed branch must not empty every component in the
   repo), and a Git-LFS pointer is detected STRUCTURALLY, because `parseRequirementsTxt` never
   throws and would otherwise turn the pointer's own lines into the component's python inventory.

4a. **THE PRUNE IS SCOPED TO THE REPOSITORY THE EVIDENCE CAME FROM** (2026-08-16). Clause 4 is a
   statement about CONTENT and it needed a second half about PLACE. A pass reads one repository, and
   `component_dependencies` recorded `observed_ref` — a commit sha, which names no repository — and
   nothing else about where a declaration came from. A component fed by two repositories (a
   supported shape: `source_mappings` is many-per-component and the correlator matches on
   `repo_pattern`) therefore had every one of its known manifest paths probed in whichever repo the
   release came from, and the `not_found: "path"` that came back for the OTHER repo's paths is the
   branch that prunes. It lost one repository's entire inventory on every release from the other,
   silently, which by clause 4's own reasoning unsubscribes it. `component_dependencies.observed_repo`
   (drizzle/0063) records where each declaration was read from and the prune cannot delete outside
   it. The column is NULLABLE and a row with no recorded repository is matched by no pass — stale
   and visible beats deleted and silent — and a re-observation stamps it. Clause 3's repo-scoped
   probe is the other half; neither alone is sufficient, because two repositories both mapped at
   their root produce identical candidate paths and no path-shaped rule can attribute one of them.

4b. **A PARTIAL BODY IS NOT AN EMPTY MANIFEST, AND ONLY THE BYTE COUNT CAN SEE THAT** (2026-08-16).
   Clause 4's structural guard was written for the Git-LFS spelling of "this body is not the
   manifest" and covered only that one. Every format in §10 is line-oriented or brace-balanced, so
   the first N bytes of a `requirements.txt` are a valid `requirements.txt` — a truncated response
   parses as FEWER dependencies and the rest are pruned with no skip entry at all. No parser and no
   consumer can detect it; the provider's declared size and the payload's own length are in hand at
   exactly one point, so `decodeBoundedBase64` refuses a payload SHORTER than the declared size as
   `incomplete_body`, which reaches ingestion as an ordinary refusal and prunes nothing. Short only:
   `size` is provider metadata, and failing closed on an over-long payload would make every manifest
   in a repo whose provider under-reports unreadable, for a discrepancy that cannot truncate
   anything.

4c. **AN OLDER PASS MAY NOT LAND AFTER A NEWER ONE** (2026-08-16). Both delivery hops are
   at-least-once and the queue is a competing consumer, so a retry of an earlier accept can arrive
   after a later one; applied out of order, the older pass prunes each manifest down to what the
   OLDER commit declared and deletes what the newer one added. `observed_ref` cannot order them —
   it is a commit sha, two shas carry no order, and deciding ancestry needs a history walk §9 keeps
   out of the plugin seam. What is orderable is WHEN each pass read, so `observed_at` is stamped
   from the read rather than from the write, and a pass whose read is older than what the row
   already carries applies nothing and writes no Decision. *The residue, stated:* this orders by
   when a pass LOOKED, not by commit ancestry; two passes whose reads and commits are ordered
   oppositely still land wrongly, and the next accepted change or a backfill re-derives the truth.

5. **A BACKFILL IS PART OF THE FEATURE, NOT AN OPERATIONAL EXTRA.** An event-driven ingestion covers
   components that RELEASE and nothing else, so on an existing estate the inventory stays empty
   until each team happens to commit, and a component that never pushes again never acquires one.
   `POST /api/v1/dependencies/inventory/backfill` follows the shipped
   `POST /discovery/backfill-source-mappings` precedent exactly: operator-triggered, idempotent, and
   it reports every skip. It resolves the repo from the component's OWN `source_mappings` and
   refuses (rather than guesses) where they name a glob or two different repos, and it cannot weaken
   the gate — there is no flag that skips it. Two properties of the RECEIPT are normative, because a
   backfill is the one caller a human reads the output of: it reports the DESTRUCTIVE half
   (`declarationsPruned` / `manifestsRemoved`), without which a run that emptied a component's whole
   inventory at the wrong ref is indistinguishable from a clean one; and the live provider I/O it
   performs inline is BOUNDED (`fetchBudget`), with the components it did not reach reported as
   `not_attempted`, because a whole-org run otherwise holds unbounded round trips against a user's
   provider inside one request.

6. **THE INGRESS HAD TO BE FIXED FOR ANY OF THIS TO WORK ON REAL DATA.** `changes.source_ref` carried
   no `repo` for any provider webhook (GitHub nests it at `repository.full_name`) and **no `commit`
   for any driver at all** — measured filterlessly, nothing non-test in the tree ever wrote that key,
   though every git adapter's `mapEvent` had always returned one. `canonicalizeSourceRef` now lifts
   all three flat keys beside the verbatim raw payload, the same way it already lifted
   `artifact_digest`. This is not M21.2 scope creep: §7a's three language ecosystems refuse with
   `no_released_commit` without it and `manifest-reader.ts` throws without a repo, so M21.4's
   internal detection could not succeed on any real delivery either.

6a. **THE INGESTION DECISION IS A FUNCTION OF WHAT THE COMPONENT DECLARES, AND OF NOTHING ELSE**
   (2026-08-16). It is written through `insertDecisionIfChanged`, so a field that moves while the
   subject does not re-opens the persist-on-change guard that exists because a churning Decision
   measured 1.44 GB/day (ADR-0024). That is a claim about EVERY field, and it was false in three
   until each was removed: a skip's free-text `detail` interpolated the ref (so a component whose
   commit never resolves wrote a fresh Decision per accepted change), a manifest's `pruned` count
   describes the PREVIOUS state rather than this observation, and the gate's `witness` is one line
   the merge happened to be satisfied on. The reason tree carries each skip's PATH and REASON, and
   the gate's `contributions` — all stable, and all that "which level decided this, and what could
   not be read" needs. Separately, the witness is now chosen in a canonical order rather than as the
   first selector out of an unordered `SELECT`, because a value that differs between two identical
   runs is a hazard for whichever consumer reads it next.

6b. **THE COMPONENT GATE'S WITNESSES RESPECT `ecosystem`'s CLOSED DOMAIN** (2026-08-16). The gate
   decides the existential "is there ANY line this component would be subscribed to?" by asking the
   real merge about witness lines built from each candidate's own selector, filling unspelled fields
   with a value no candidate names. That is correct for `coordinate` and `major`, which are open
   strings. It is wrong for `ecosystem`, whose entire domain is §10's five members: a witness
   carrying an invented sixth is matched by no ecosystem-scoped opt-out, so a component with an
   org-wide enable and one opt-out per ecosystem — five effects that between them cover every line
   that could exist — kept an OPEN gate and was fetched, and therefore pruned, on every accepted
   change forever. A selector naming no ecosystem now expands to one witness per real ecosystem, and
   the existential stays exact in both directions.

7. **THE ROLE GUARD MATCHES INTERNAL DETECTION, DERIVED FROM INGESTION'S OWN FACTS.** The process
   axis applies (background work belongs to `all`/`worker`). The federation axis does not: §7c
   clause 3 makes the poll commander-only because it **dials public package registries on a timer**,
   while ingestion initiates no timed egress and reads through the git binding this domain's
   executors already coordinate over. §3 says each domain derives its own inventory, so a
   commander-only guard would leave every outpost's `component_dependencies` permanently empty.

### 5. Package dependencies never use `depends_on`

They mint no `depends_on` edge, so the plan compiler's toposort and cycle check cannot see them
(Context 1). A permanent test pins this.

### 6. Enablement is a monotone AND across three levels

```
effective_enabled(component, dependency) =
      instance_unlocked  AND  component_enabled  AND  NOT dependency_opted_out
```

The instance level **unlocks and never activates**; the component level is the team's own switch; the
deepest level may **only subtract**. This reuses the algebra proven in `governance/scan-requirements.ts`
— top-down, child may only tighten, pure and order-independent — with "absent never means zero" reading
here as **absent never means enabled**. Each level's contribution is carried for explainability, as
`ScanThresholdContribution` does, so a Decision can answer *which level turned this off* (principle 6).

**The ingestion work-list is derived from this resolution**, so a disabled component is never fetched and
an opted-out dependency is never polled.

An instance-level unlock that silently activated authoring on any component would violate ADR-0006's
"managed execution is never a default"; the AND makes that structurally impossible.

### 6a. A GROUP-SCOPED `dependencySubscription` EFFECT IS REFUSED AT AUTHORING TIME (2026-08-13, M21.3; **widened to BOTH directions 2026-08-15, M21.4**)

`matchPoliciesForTargets` returns a `scope.group` policy **only when the acting subject is a
transitive `member_of` that group** (`governance/policy-resolve.ts:186-193`). That is right for "this
rule governs work done BY this group" and wrong for a constraint, because a constraint that fails to
match is a constraint that does not apply.

The two directions of this feature's effect fail **differently**, and both failures are silent:

- a group-scoped **opt-out** that fails to match yields STILL-ENABLED. SCP then authors a bump for a
  dependency a team explicitly opted out of — which is precisely the case the opt-out exists to serve
  (proposal §1: "one or more dependencies are causing issues when upgraded and so they want to handle
  that manually"). It fails silently in both halves: fewer rows from the matcher, fewer contributions
  in the merge, and `enabled: true` is an ordinary-looking answer. An operator would learn about it
  from a pull request they explicitly asked never to receive.
- a group-scoped **enable** that fails to match yields NOT-enabled. M21.3 read that as the safe
  direction and permitted it — *"nothing is lost"*. **That reasoning was incomplete, and M21.4 is
  where the missing half became measurable.** The jobs that ACT on a subscription resolve as
  `SYSTEM_ACTOR_ID`, which by its own definition has **no `objects` row at all**
  (`coordination/system-actor.ts:9`) and is therefore a transitive `member_of` nothing — so
  `matchPoliciesForTargets` can never return a `scope.group` policy for them, and a group-scoped
  enable is **permanently inert** on every path that fetches or bumps anything
  (`dependencies/internal-release-detection.ts`'s subscriber gate and the third-party poll's
  work-list both call `listSubscribedComponentLines` with that actor). Meanwhile the SAME policy
  resolves `enabled: true` for a human team member who asks, because they *are* in the group. The
  team sees a working subscription in the API and receives nothing, forever, with no error anywhere.
  "Nothing is lost" is true of the enablement algebra and false of the feature: **a subscription that
  silently never fires is its own footgun**, the mirror image of an opt-out that silently never
  applies.

**Decision: authoring a `dependencySubscription` effect at `group` scope is refused with a 400 in
BOTH directions**, with a message naming the direction's own failure and `objectRef`/`selector` as
the remedy. A silent fail-open (opt-out) and a silent no-op (enable) at evaluation time both become a
loud refusal at authoring time — the same move `0061`'s declared-producer CHECK makes: render the
unusable state unrepresentable rather than merely guarded.

**This can be relaxed for the enable direction** if a future design resolves a subscription **per
owner** — evaluating each subscribing component's own team membership rather than the acting
subject's — at which point a group-scoped enable becomes meaningful and only the opt-out's fail-open
remains. Nothing in the tree does that today, and the relaxation must not be made by re-permitting the
enable while the actor is still the system sentinel.

**Why not fix the matcher instead.** The identical exposure exists for `scanThreshold` (ADR-0016,
shipped): a group-scoped scan **ceiling** silently does not contribute for a non-member, leaving the
effective threshold LOOSER than the operator authored. Changing `matchPoliciesForTargets` here would
alter that shipped gate's behaviour as a side effect of a dependency feature — which is how a
governance change gets made without anyone deciding to make one. This clause guards **this feature's
use** of the matcher; the matcher itself is tracked separately, for both consumers at once.

**Cost, accepted:** a team wanting a group-wide subscription — in either direction — must express it
as an `objectRef`/`selector` scope rather than a group. That is a real ergonomic loss, doubled by the
widening, and it is the correct trade: the alternative is an opt-out that appears to work and an
enable that appears to work.

#### 6a-i. Amended during the M21.3 review round — WHERE the refusal lives, and HOW WIDE it is

Two corrections, both found by building the clause rather than by reading it.

**(a) It is enforced at the write choke point, not at the typed route.** The first cut installed the
refusal in exactly one place: the composed `validateWrite` of the typed `/policies` routes. Its
sibling in that same composition, `assertPolicyScopeWithinAuthority`, was already installed in
**three** — that config plus `iac/plans-repo.ts`'s create and update branches — which is the tell
that the route was never the boundary. Three doors reached `createObject` with a free-form `typeId`
and free-form `properties` and planted the exact document the typed route answers 400 to, each
reproduced end to end: **IaC** (`POST /plans` + `/plans/{id}/apply` — which made `routes/plans.ts`'s
"the exact same governance gates the typed /policies routes enforce" false), **hand-fill**
(`POST /api/v1/federation/hand-fill`), and **overlay** (`POST /api/v1/federation/overlays`, plain
`object:write`). The refusal now lives in `graph/objects-repo.ts`'s `createObject`/`updateObject` —
the one choke point every local write door funnels through — following the M16.2 clause-(4)
precedent already there. Adding three more call sites was rejected explicitly: that is the shape
that produced the bug, and the next door added would repeat it.

**The exemption is exactly one path wide.** A row arriving by genuine federation import is NOT
refused, because `import-repo.ts`'s `object_upsert` branch has no try/catch and a throw there aborts
the whole signed bundle and wedges the channel (proposal §10 Q6) — and because an authoring-time
refusal belongs at the authoring instance, not at a receiver refereeing a document another domain
owns. But `federationImport` is set by **two** modules, not one (`import-repo.ts` and
`federation/handfill-repo.ts`; census re-run filterlessly, there is no third), and hand-fill is a
**local operator action** with a free-form `typeId`, no chain to wedge, and an operator standing
there to read the 400. So hand-fill calls the guard for itself, exactly as it already does for the
M16.2 peer-binding clause and for the same reason.

**(b) It refuses only when `group` is the ONLY scope present.** `matchPoliciesForTargets` evaluates
the three scope kinds **independently**, not as alternatives: the `objectRef` and `selector` branches
each record a match before the actor-dependent `group` branch is reached. A policy carrying `group`
**and** `objectRef` therefore contributes for every caller through the `objectRef` route, member or
not — the hazard is absent, and the first cut's 400 told the author to do what they had already
done. Residual, stated rather than papered over: this is a structural test, so a **dangling**
`objectRef` (or a selector nothing matches yet) leaves the group branch as the only live route. That
is not fixable at authoring time for the general case, because a selector is designed to match
objects that do not exist yet.

### 7. Detection has two ingresses and an air-gap shape

- **Internal** — derived, because no event carries it, and driven by a ROUTER on the domain-event
  queue rather than by a second worker on it (§7c clause 2, normative):
  `scp.change.transitioned(toState=accepted)` → the
  change's wave targets → `deployment-target.properties.environment === 'prod'` → the component placed
  there → the lines it **declares** it publishes. Rollback changes auto-accept and are **not** releases.
  Domain-local changes do not journal (ADR-0031), so domain-local internal dependencies are
  domain-visible only — stated, not discovered later.
- **Third-party** — a daily self-rescheduling tick (there is no `boss.schedule` usage to copy) resolving
  versions through per-ecosystem **index plugins**, so the existing egress guard and host allowlist
  apply. The job is **explicitly role-guarded**: there is no trustworthy runtime commander/outpost
  predicate, so an unguarded background job runs on air-gapped outposts too. That guard is
  **fail-closed on an UNDECLARED deployment** — see §7c clause 3, which is normative. **The two
  ingresses own disjoint sets of lines and the poll polls THIRD-PARTY LINES ONLY** — see §7b clause
  1, which is normative.
- **Air-gap** — the Trivy-DB shape (the only shipped external-feed pattern): an operator-loaded,
  cosign-signed feed with a fail-closed staleness policy. Where neither an index nor a feed exists,
  third-party detection reports **unavailable** rather than degrading silently.
- **Container images** need none of that fallback: the org's own registry **is** the index, reached by
  the existing skopeo/Harbor path. Image tags are **not** semver, so a line carries a tag pattern plus a
  parsed-version extractor, unparseable tags are **skipped rather than guessed**, and the subscription
  records the **digest** it moved to, because a mutable tag is not an identity.

Per-tick verdicts use `insertDecisionIfChanged`; a daily poll re-writing a byte-identical "no new
version" Decision per dependency would reproduce the measured 1.44 GB/day amplification exactly.

### 7b. WHAT `latest_version`/`latest_digest` MEAN, and WHO MAY WRITE THEM (2026-08-15, M21.4)

§7 gives detection two ingresses and §7a says what version an internal release published. Neither says
what the **column pair** those ingresses write means — and built without that, the two writers meant
different things by it. Every clause below is a defect found by an adversarial review of the M21.4
build, stated here normatively because "both writers should agree" is not enforceable by a type: both
write a `string` into a `text` column.

The meaning, in one sentence each. **`latest_version` is the HEAD of the line: the greatest version ON
this line this domain has observed.** **`latest_digest` is the digest OF that version, observed in the
same act.** NULL in either is "not observed", never "nothing newer exists" (§7's schema note).

1. **THE INGRESS SPLIT IS STRUCTURAL, NOT A FILTER.** An **internal** line (`produced_by_object_id`
   set) has its head DERIVED from the org's own accepted production releases and is **never** asked of
   an index; a **third-party** line is polled and is never written by internal detection, because
   nothing declares the org its producer. Polling an internal line is **dependency-confusion shaped**:
   a stranger's package sharing the coordinate answers `9.9.9`, that overwrites the head the org's own
   `2.1.0` release put there, and every subscriber is bumped onto it — delivered by a background job on
   a daily timer, with no error anywhere. The split must therefore be **unrepresentable rather than
   remembered**: the poll's hydration narrows in SQL *and* the index seam accepts only a value whose
   sole constructor reads `produced_by_object_id`. A predicate the poll happens to apply is exactly the
   shape this repo's incomplete-call-site-census failures take.

2. **`tag_pattern` HAS ONE MEANING: the line's LITERAL VARIANT SUFFIX** (`-alpine`, `-slim`; absent =
   the plain flavour). It is not a glob and it is not "the extractor's pattern" read differently by
   different callers. One shared helper answers "is this version on this line?" — same major line at
   the line's own precision, same variant — and **both** writers call it. The defect this fixes: an
   `-alpine` line took a plain glibc tag as its head, because internal detection did not read the
   column at all while the poll did. An operator who writes something that is not a literal suffix gets
   NO eligible versions and a legible refusal, never a pattern quietly matching the wrong flavour.

3. **A HEAD NEVER MOVES BACKWARDS.** A hotfix on an older minor of the same line (`1.9.10` after
   `1.10.0`) is a genuine production release and is **not** that line's head: it is **refused with a
   named reason and recorded in the Decision**, which is where "this release happened, at this version,
   and the head did not move" belongs. The column holds the head; the Decision holds the history.
   Ordering is the shared comparator and never string order. One bounded exception, stated rather than
   discovered: a **stored value that is not on the line as it is defined now** (its variant no longer
   matches, its text no longer parses) is not a head to regress from and is replaced — refusing on it
   would wedge the line permanently, since no API can reset `latest_version`.

4. **THE VERSION AND ITS DIGEST MOVE TOGETHER.** They are written from one observation, always both.
   An unresolved digest is written as **NULL** — a true "this version's bytes were not resolved" — and
   **never** inherited across a version change. The defect this fixes: an `oci` digest lookup that
   failed left the previous version's digest standing beside the new tag, so the row asserted a
   `(tag, digest)` pair that never existed in any registry, in the one column pair whose entire purpose
   is that a mutable tag is not an identity. A restatement of the *same* version may fill a digest in,
   and a null there does not discard one already resolved for that same version.
   *Rejected alternative:* refusing to move the head at all until a digest resolves. It reads stricter
   and is worse — the operator-loaded air-gap feed carries versions and **no digests at all**, so an
   air-gapped estate could never record an image head, which is precisely §7's "an air-gapped estate
   must not look like a fully up-to-date one".

5. **TWO PROD PLACES THAT DISAGREE ARE REFUSED, NOT RESOLVED.** A component placed in several `prod`
   deployment-targets is released to all of them by one change, and their observed images can differ.
   A line has ONE head, so the evidence is weighed per LINE and not per place: identical claims record
   once; **differing claims — a different version, or the same tag at a different digest — record
   nothing**, with both places and both versions named in the Decision. Picking a winner meant picking
   by wave-target UUID order, which could equally be the OLDER release, while the run reported "0 not
   recorded" and the Decision asserted two contradictory versions for one line. A place that determined
   nothing is reported as its own refusal and does not veto a version another place did state — "this
   region reported no images" and "the regions disagree" are different facts.

6. **EVERY REFUSAL NAMES ITS OWN CAUSE.** Two reasons in the M21.4 build named something other than
   what happened, and both are the same class of error: an unrecognised **ecosystem** was reported as
   `manifest_reader_unavailable`, whose stated remedy ("wire a `readFileAtRef` reader") would fix
   nothing; and an index answering `available` with an **empty list** was reported as
   `no_versions_on_line`, conflating "this package exists and has published nothing" with "its releases
   are all on other majors" — two different operator actions. A reason named after the branch that
   matched goes false the moment that branch covers a second case; this repo has shipped that failure
   once already (ADR-0030 §2, charter principle 6). Each distinct cause gets its own reason.

Clauses 2, 3 and 4 are enforced at the **single write door** both ingresses call
(`recordDependencyLineHead`), not at each caller: the arrangement exists because the callers
demonstrably disagreed, and a rule applied by each caller has one place per caller to regress.

### 7a. WHICH VERSION did an internal release publish — one function, five strategies (2026-08-15, M21.4)

§7 defines internal detection as a derivation but does not say what **version** the release put on the
line, and **nothing in the derivation carries one**: the event is `{fromState, toState, trigger}` over
a change id (`coordination/transition.ts:361-368`), and `changes.source_ref` carries
`{repo, ref, commit, run_url, artifact_digest}` — a commit and a digest are *identities*, not versions.
So the answer is per-ecosystem, and it is written as **one function with an explicit strategy table**
(`dependencies/internal-release-version.ts`) so "which signal did we use, and why is that signal
trustworthy" is answerable by reading the code rather than inferred from whichever branch ran.

| ecosystem | signal | why it is trustworthy |
|---|---|---|
| `oci` | `change_wave_targets.observed.images` (ADR-0008) | the executor's own statement of what it deployed. Records the **tag AND the digest** — a mutable tag is not an identity (§7). |
| `go` | `changes.source_ref.ref`, only when it is `refs/tags/…` | `go.mod` declares a module **path** and no version; a Go module's version **is** its git tag. |
| `npm`, `python`, `maven` | the producing component's **own manifest**, read at the released commit with M21.2's `readFileAtRef` | the same "formulated via the users' code" ingress the inventory itself is built from. **Where** the manifest is comes from the component's already-recorded `component_dependencies.manifest_path`, never from a repo-root convention. |

Three rules bind the whole table, and each exists because its violation is invisible:

1. **A digest is not a version, a commit sha is not a version, a branch name is not a version.** Every
   undeterminable case records **NOTHING** with a named reason in the Decision. A missed bump is
   visible (`latest_version` stays null, which §7's schema already defines as "not yet observed" and
   *not* "no newer version exists"); a wrong version is invisible and makes a component look
   up-to-date at a release that never happened. A sha is the sharp case — roughly six in ten parse as
   a version.
2. **The released version must be proven to be ON THIS LINE.** A line is `(ecosystem, coordinate,
   major)` and one component legitimately produces several at once, so a released `1.9.9` recorded
   against the `2` line is not a wrong version but a version on the wrong line. The line's own major
   must prefix-match the release at the line's **own precision** (`3.18` accepts `3.18.4`, refuses
   `3.19.0`); a major line the grammar cannot compare is refused, never assumed.
3. **Maven and PEP 621 `dynamic` versions are `unresolved`, not absent.** An inherited `<parent>`
   version or a `${revision}` needs a second document or a build run — a closure walk (§4) and tooling
   execution (§8) respectively — so both are reported as such.

**Consequence, stated rather than discovered:** the language strategies need a server-side route to
`readFileAtRef`, and there was none — the hook is a `GitProviderAdapter` hook deliberately absent
from `ExecutorPlugin` (§9), and the subprocess plugin host exposed no file-read client. M21.4
therefore takes the reader as an **injected port**: with none wired, every language ecosystem records
nothing under the reason `manifest_reader_unavailable`, which is legible, rather than silently
detecting nothing.

**The port is now wired, and §7c records how.** Leaving it unwired would have made M21.2 dead code
and this whole ingress an intention: three of the five ecosystems would have recorded
`manifest_reader_unavailable` on every release, forever.

### 7c. HOW THE FILE READ AND THE INTERNAL INGRESS ACTUALLY RUN (2026-08-15, M21.4)

§7 and §7a define two derivations; neither says what CALLS them, and built without that, neither ran.
Both facts below were found by an adversarial review of the M21.4 build and are recorded normatively,
because "there is a function that does this" is not the same claim as "this happens".

1. **`readFileAtRef` CROSSES THE PLUGIN HOST AS ITS OWN CLIENT, NOT AS A FIFTH EXECUTOR VERB.** The
   route is `plugin-host/contract.ts`'s `GitFileReadPluginClient`, `host.ts`'s `gitFileRead()`, a
   `readFileAtRef` method on the wire (`rpc-protocol.ts`), and a dispatch arm in
   `subprocess-entry.ts` that resolves against the loaded **adapter** carried BESIDE the executor
   plugin — never against the plugin itself. §9 is therefore intact in the strict sense: the object
   an `ExecutorPlugin` instance exposes still has exactly observe/trigger/status/abort, and
   `createExecutorPluginFromAdapter` still refuses to surface the hook. An instance whose module has
   no adapter hook (every non-git-provider executor) **rejects the call by naming the missing hook**,
   never by answering `not_found` — the latter would be a claim about the repo.

   **WHICH instance is chosen is decided by the RELEASED REPO, never by "the org's first github
   binding".** A binding holds credentials, and one team's installation token is not authority over
   another team's repository, so the reader matches `changes.source_ref.repo` against each
   git-provider binding's own configured repo identity (`projectPath`, else `owner/repo` — the same
   fields the adapters themselves read) and refuses legibly when none matches.

2. **INTERNAL DETECTION IS EVENT-DRIVEN, THROUGH A ROUTER, BECAUSE `boss.work()` IS A COMPETING
   CONSUMER.** A second worker on `domain-events` does not add a listener, it splits the jobs — which
   is why that queue's handler only logged and nothing in the tree consumed a domain event. So an
   `scp.change.transitioned(toState=accepted)` is matched by a ROUTER on that queue, which makes one
   cheap decision and enqueues onto this capability's OWN queue; the work happens in that queue's
   worker. Doing the work inline would put a git fetch's latency and its retry budget on the shared
   event stream.

   Delivery is **at-least-once at two hops now**, and nothing on the path appends: the head goes
   through `recordDependencyLineHead` (which re-reads `FOR UPDATE` and decides), the verdict through
   `insertDecisionIfChanged`, and the change's state is **re-read** rather than trusted from the
   event.

   **The manifest fetch happens OUTSIDE any transaction**, in a middle phase between two write
   phases. Holding an RLS-scoped pooled connection across a provider round trip — against a 5s
   production `statement_timeout` and a bounded pool — is the failure the third-party poll already
   avoids by design; the two ingresses do not differ on this.

3. **THE TWO INGRESSES ARE ROLE-GUARDED DIFFERENTLY, AND THE DIFFERENCE IS THE REASONING, NOT AN
   OVERSIGHT.** §7's guard on the poll exists because it **dials the public internet on a timer**.
   Two consequences:

   - **The poll is fail-CLOSED on an undeclared deployment.** `SCP_FEDERATION_ROLE` defaults to
     `commander` (the right default for "may I serve the SPA?", which preserves every pre-M16.3
     deployment) — so a guard testing only `federationRole === "commander"` let through exactly the
     population most likely to be air-gapped: an outpost predating the setting, or a chart that omits
     it. The poll therefore requires the role to be **explicitly declared**, and it logs when it
     ALLOWS as well as when it refuses: a posture that sends traffic must not be the invisible one.
   - **Internal detection runs on EVERY federation role.** It initiates no timed egress, and the
     evidence it derives from — `change_wave_targets.status` / `observed_state.images` — exists only
     where the change EXECUTED, while a commander receives only `change_status` journal entries.
     Restricting it to a commander would make every outpost domain derive nothing forever, silently,
     which is §3's "each domain derives its own" inverted.

4. **PLUGIN INSTANCES DERIVED FROM A WORK-LIST NEED A LIFECYCLE.** Every other plugin-host caller
   starts instances from operator CONFIGURATION, which persists; the version poll is the first to
   start them from its own work-list — up to five per org, on demand. Nothing leaked per tick, so the
   symptom was a standing subprocess count that grows with TENANCY and never falls, held by a job
   that runs once a day. The sweep stops what it started, from a receipt reported by the code that
   started it rather than from a second derivation of which instances "should" be running.

### 8. The actuator is a managed class — BUILT (M21.5, 2026-08-16; §8a–§8f are the build's own clauses)

Run against ADR-0002 §3, **gate 1 fails wherever Renovate or Dependabot exists** — that is the execution
system for this class — so the router's default verdict is COORDINATE. **The owner selected Mode C
(SCP authors the commit) on 2026-08-13 with that analysis in hand.** The clause is therefore recorded
with its costs rather than a softened gate reading, and it is **contingent on the charter amendment**
adding `scp-managed-dep` to the enumerated managed-class allowlist.

To keep gate 1 coherent, **opting a component in is itself the gate-1 flip**: enabling dependency
subscriptions for a component declares SCP the execution system for that class in that domain, mirroring
ADR-0002 §4's "bundling flips gate 1" in the opposite direction. Consequently **conflict detection is
load-bearing, not a nicety** — enablement refuses where `renovate.json` or `dependabot.yml` covers the
same manifests, because two actuators editing one file is the failure mode this invites.

**Manifest-only edits. No lockfile resolution.** Running a package manager to regenerate a lockfile is
tooling execution: it breaks gate 5 ("no build farm, no compilation") and trips ADR-0002's anti-CI
corollary directly. Ecosystems with committed lockfiles rely on the org's CI to resolve. This is a real
functional limit and is stated as a scope boundary, not discovered during implementation.

**Delivery is a per-subscription choice of PR or auto-merge** (owner, 2026-08-13). Auto-merge's
CI-green condition is expressed as a governed control so the existing gate machinery decides, not new code.

`scp-managed-dep` follows the two shipped managed executors exactly: the standard executor interface,
server-injected never-tenant runner settings, single-shot ephemeral runners from a separate pinned image,
scoped vaulted credentials.

### 8a. WHAT DISPATCHES A BUMP, AND WHERE THE TRIGGER IS EMITTED (2026-08-16, M21.5)

§8 says the actuator exists and says nothing about what *calls* it, and built without that it was not
called: `recordBumpChange`, `resolveEffectiveDelivery` and `buildBumpIntentParameters` had no
non-test caller and nothing in the tree constructed a `managed-dep` `TriggerIntent`. That is the same
defect §7c records for M21.4's detection, and it is the **fourth** time in M21 a component was built
and never installed — so the wiring is now normative rather than implied.

1. **THE TRIGGER IS A LINE'S HEAD *ADVANCING*, AND IT IS EMITTED AT THE ONE WRITE DOOR.**
   `recordDependencyLineHead` writes an `scp.dependency.line_head_advanced` outbox row **in the head
   write's own transaction**. Emitting it from each ingress instead would put the rule in one place
   per caller, which is precisely the arrangement §7b's closing line rejects for the head rules
   themselves — and those two callers have already demonstrated that they disagree. A third ingress
   (an air-gap feed import, an operator-set head) therefore dispatches a bump by construction.
   **Only `advanced`, never `restated`:** the daily poll re-observes an unchanged head for every
   third-party line every day, and a job per restatement is a job per dependency per day for work
   already done.

2. **A ROUTER, NOT A SECOND WORKER** — `boss.work()` is a competing consumer, so the same shape
   §7c clause 2 established applies unchanged: route on `domain-events`, work on the capability's own
   `dependency-bump` queue.

3. **THE WORK-LIST IS §6's RESOLUTION, WITH NO SECOND FILTER.** `listSubscribedComponentLines`
   decides who is eligible. The dispatcher narrows the *scan* to the components that declare the line
   (the reverse index) and never the *answer*.

4. **IDEMPOTENT AT BOTH HOPS, AND KEYED ON EVERY FIELD OF THE SUBJECT.** An existing bump change for
   the same **(component, manifest, coordinate, target version)** is REUSED rather than re-proposed —
   its branch is the provenance join (§9), so a second change would mean two branches, two pull
   requests and two releases for one bump — and the dispatch carries
   `idempotencyKey = <changeObjectId>`, which is both what the plugin's outcome cache keys on and what
   the authored branch carries.

   **The first two fields of that key are normative, and the reason is a blocker this ADR's own §9
   inverted.** Built keyed on (coordinate, target version) alone, the lookup matched org-wide — so
   the SECOND subscribed component on a line reused the FIRST one's change and received no change, no
   branch, no dispatch and no bump, silently and forever; and its returning push then correlated to a
   change that was not about it, minting exactly the second unrelated change §9 exists to prevent. A
   dependency line **exists** to be declared by many components (that is what §3's reverse index is
   for), and `component_dependencies` is unique on `(org, component, line, manifest_path)`, so one
   component legitimately declares one line from two manifests — each of which is its own edit to its
   own file and therefore its own change. The change is what carries the subject: it records
   `source_ref.scp_authored.componentObjectId` beside the repo and ref it already claims, because a
   `targets` join is not a key and a name is not an identity.

5. **THE ROLE GUARD IS DERIVED, NOT INHERITED.** §7c clause 3's two jobs reached opposite verdicts, so
   neither verdict transfers; the QUESTION does. This job does not merely read from the internet, it
   **writes to a source repository with a credential**, which an air-gapped or high-side outpost must
   never do — and internal detection runs on every role, so heads DO advance there. It is therefore
   commander-only AND **fail-closed on an undeclared `SCP_FEDERATION_ROLE`**, and it logs when it
   allows as well as when it refuses.

6. **REFUSALS NEVER GUESS, AND EACH NAMES ITS OWN CAUSE** (§7b clause 6). An open range is refused
   rather than resolved (resolving is CI, §8); a declaration whose recorded resolved version is not a
   substring of it is refused rather than reformatted, because re-rendering from a parsed triple drops
   whatever the parser did not model *in a file this system then commits*; a base branch is taken from
   `component_dependencies.observed_ref` and never invented.

### 8b. THE DELEGATION REFUSAL NEEDED A WRITER (2026-08-16, M21.5)

§8's "conflict detection is load-bearing" was built as two readers — the authoring choke point and
the actuator seam — and **no producer**, so the charter clause was enforced by nothing end to end.
The probe now runs in the dispatch job, which is the only production path that already holds the
repository, the ref and the component's declared manifests, and which must not hold a transaction
across a provider round trip (§7c clause 2's rule, restated for a write). The verdict is persisted
with `insertDecisionIfChanged` and both readers see it.

**AN UNREADABLE REPOSITORY IS NOT AN EMPTY ONE — the probe fails CLOSED.** Built, every read failure
(a bad credential, a provider 5xx, an egress refusal, a refused blob) was collected into an
`unreadable` list and the probe returned `delegated: false` — a result **byte-identical** to a clean
repository, so an outage produced an `allow` Decision and an authored commit, and the dispatcher's
`delegation_probe_failed` branch was unreachable. "We could not check whether another dependency-update
system owns these manifests" must never resolve to "go ahead and write to them": this is the one
refusal standing between CommanderSCP and two actuators editing one file, and the two mistakes do not
cost the same. A probe is now **inconclusive** unless every candidate path was answered, an
inconclusive probe records **no verdict at all** (a weaker `allow` would be read as a standing fact
long after the outage that produced it), and the candidate is skipped with a named cause and
re-derived on the next advance. The refusal lives at the **writer**, not in the one caller, so a
second producer of this verdict inherits it. A probe that DID find a collision stays conclusive
whatever else failed to read — unread config can only add collisions, never remove one.

**The residual, stated rather than discovered:** a component that has never been a bump candidate has
no verdict, so its *first* enable is not refused at authoring time. That is exactly what "no probe on
record means NO DELEGATION HAS BEEN OBSERVED" already declares, and it is why the actuator half
exists — nothing is written to a delegating repository either way.

### 8c. AUTO-MERGE EVIDENCE IS SPECIFIC IN TWO INDEPENDENT WAYS — AND IS NOW REACHABLE (2026-08-16, M21.5)

"A governed control evidences that the component's **own** checks passed" was built as an unfiltered
read of the change's `control_runs`, so **any** passing control granted auto-merge — a scan verdict,
a webhook control pointed at an operator's own URL, a commander promotion-scan row. Each is a
governed control and none of them is CI on this bump. Two narrowings, and the second is the sharper:

1. **WHICH CONTROL.** `control_bindings.plugin_module` is the only place the KIND of question a
   control asked is recorded, so the grant is restricted to modules that answer "did THIS CHANGE'S
   OWN commit pass the component's OWN CI?" — today exactly `github-check`.

2. **WHICH COMMIT.** `github-check` falls back to its operator-pinned `expectedRef` when the change
   tracks no commit, and a bump change tracks none until its push returns — so a control could report
   CI green **for the base branch** and the bump would merge into it on that evidence. The grant
   additionally requires the run's evidence to name the commit the bump's own branch is at, which the
   webhook records onto the change when the authored push comes back.

Objection stays WIDER than the grant: any `fail`/`timed_out` from ANY control downgrades. A passing
scan is not evidence the component's checks passed; a failing one is a perfectly good reason not to
merge unattended.

**BOTH NARROWINGS ARE SATISFIABLE ONLY AFTER THE BUMP'S OWN COMMIT EXISTS AND CI HAS CONCLUDED ON IT
— WHICH IS WHY THE GRANT NEEDED A SECOND ASKING, AND WHY THE SECOND ASKING WAS THREE MISSING THINGS
RATHER THAN ONE.** This clause previously recorded auto-merge as **not reachable**, and it was right
to: at the first dispatch the branch does not exist, no push has returned, no head commit is recorded
and no CI has run, so the grant is refused and delivery is a pull request whatever the subscription
asked for — and nothing in the tree produced a second look. The only trigger was a line's head
*advancing* (§8a clause 1); an advance to a different version is a different `toVersion` and
therefore a different change, and a restatement deliberately emits nothing. **That link is now
BUILT** (2026-08-16). It is three parts, and none of them is a second gate:

1. **A GOVERNED GATE NOW RUNS *FOR* A BUMP CHANGE, AND IT IS THE EXISTING GATE.** The first missing
   thing was not a trigger but the EVIDENCE ITSELF. `control_runs` rows are deposited by the gate
   machinery on a lifecycle edge or a wave boundary, `coordination/reconcile.ts` prewarms governance
   only for changes sitting in `validating`, and a bump change sits at `proposed` from the moment
   `proposeChange` writes it — so **no control had ever run on a bump, and the evidence the grant
   requires could not exist.** `dependencies/bump-gate.ts` calls
   `governance/gate-orchestrator.ts`'s `prewarmGovernanceForChange` — unchanged, the same function
   `reconcile.ts` calls — which honours §8's "the existing gate machinery decides, not new code".

   **The change is never ADVANCED.** Driving a bump down the deploy lifecycle to make gates fire
   would coordinate a release nobody asked for; a bump is a proposed edit to a manifest, not a
   deployment. Prewarm is the right seam precisely because it runs controls and materialises
   approvals while transitioning nothing.

   The consequence, stated rather than discovered: **an org whose policies name no required control
   for the component has evidenced nothing, so its bumps stay pull requests.** That is the charter
   clause working. Absence is never permission.

2. **THE TRIGGER IS AN OBSERVED EVENT ABOUT THE BUMP, EMITTED AT THE INGRESS CHOKE POINT.**
   `coordination/webhook-processor.ts` writes an `scp.dependency.bump_observed` outbox row **in the
   ingress transaction** whenever an observed provider event correlates to a bump SCP authored; a
   ROUTER on `domain-events` enqueues onto the capability's own `dependency-bump-gate` queue (§8a
   clause 2's rule, restated — `boss.work()` is a competing consumer). Emitted at the choke point
   rather than per event kind for the same reason §8a clause 1 emits the head advance at the one head
   write door: a third observed event that attaches to a bump re-evaluates it by construction.

   **THE CI-CONCLUSION EVENT HAD TO BE MAPPED, AND THIS IS THAT STATEMENT RATHER THAN A SILENT POLL.**
   Measured: `@scp/plugin-github`'s `mapEvent` maps `push`, `pull_request`, `workflow_run`,
   `deployment` and `release` — `check_suite`/`check_run` are not mapped at all — and `workflow_run`
   carries `commitSha: workflow_run.head_sha` with **no ref**. Gitea maps no workflow event and
   GitLab maps `Pipeline Hook`; neither matters here, because only a GitHub App can mint the
   credential this class requires (§8; `repo-write.ts`'s `resolveRepoWriter` refuses the other two by
   name). Two additive changes followed: ingress's `ExtractedHint` now carries `commitSha` (every
   adapter had always produced one and ingress dropped it on the floor), and
   `matchAuthoredBumpChange` gained a **head-commit route** so a ref-less CI event attaches to the
   bump whose own recorded `scp_authored.headCommit` it names. That is still a fact SCP asserted
   rather than one the payload claimed — and it also stops such an event minting the second unrelated
   change §9 exists to prevent, arriving through a different event than §9 anticipated.

3. **MERGING IS NEW REPOSITORY-WRITE AUTHORITY AND IS GUARDED AS SUCH.** Until now the worst SCP
   could do was open a pull request a human reviews, so this is a genuine widening and is treated as
   one. It lives in the SAME place as the other write authority — inside the managed executor,
   orchestrator side (`repo-write.ts`); `GitProviderAdapter` stays READ-ONLY (§9) and gains no hook.
   It is `@scp/plugin-managed-dep`'s `action: "merge"`, and every condition on it is structural:

   * it inherits the traversal census verbatim (`assertWriteRepo`/`assertWriteBranch`/
     `assertWriteBaseBranch`/`assertBranchIsNotBase`, delegating to `assertSafeRepo`/`assertSafeRef`)
     — a property this feature has already got wrong twice;
   * **the branch is DERIVED, never supplied.** The intent has no branch field: the plugin composes
     `scp/dep-bump/<changeObjectId>` with the same function the authoring run used, and the server
     takes that id and the repository from SCP's own server-owned record of what it authored (§8f). A
     caller-supplied branch is how "merge the bump we authored" would quietly become "merge what you
     are told to";
   * **the pull request is ADDRESSED, and its base is COMPARED.** The merge names the pull request
     SCP itself opened, by the number the server recorded when the authoring run reported it — never
     the first entry of a listing filtered on the head branch, which lets provider ordering (or a
     second pull request somebody with write access opened from SCP's branch to a protected base)
     decide what merges. The provider's description of that pull request must then still agree with
     every fact the grant was about: it is open, its head is the branch this change authored, and its
     **base is the base the grant named** — a comparison that did not previously exist at all, so a
     retargeted pull request merged into a branch nobody evidenced;
   * **the evidenced commit is a PRECONDITION, not a label.** It is sent as the provider's merge
     `sha` parameter, which refuses the merge unless the pull request's head is exactly that commit —
     so "the tree that merged IS the tree the control passed" is enforced by the provider rather than
     by this process's belief about what the branch is at. A push that landed between the evidence
     and the call therefore refuses and leaves the pull request open. The same precondition is now
     REQUIRED of an authoring run's own auto-merge tail, because a publish that re-pushes the
     manifest can move the branch off the commit the grant was about;
   * it **never authors**: a closed pull request is a human's decision about that bump, and this
     action has no authoring fallback that could re-open one.

   And it **FAILS CLOSED** in every direction the charter names: no gate result; a result for a
   different commit; a subscription that no longer resolves, or resolves to `pull_request` (re-derived
   LIVE from the current resolution, so narrowing a subscription after the bump was authored stops the
   merge — the change's own recorded `delivery` is the downgraded answer and is deliberately not read
   for this); a claim whose ref is not the one this change's own bump would author; no observed head
   commit; and — **stricter than the authoring seam, deliberately** — no *conclusive* delegation
   verdict on record. §8b's inconclusive probe records no verdict at all, so "no verdict" is
   byte-identical to "we could not read the repository"; letting the authoring seam proceed on that
   absence is the stated residual there, and merging is a bigger thing to do on it.

The consequence for an operator: **`delivery: auto_merge` is accepted, resolved, recorded, and
actuated on the bump's SECOND look — never on its first.** The first dispatch is always a pull
request, and the recorded `deliveryReason` says why.

*(A redelivery of the same head-advance event also re-dispatches the same change and would take the
grant if CI had concluded in between. That remains an accident of at-least-once delivery rather than
a mechanism — but it is no longer the only way the grant can be reached, and the `sha` precondition
means such a re-dispatch cannot merge a tree its own publish just moved.)*

### 8d. `--network none` IS UNQUALIFIED FOR THIS CLASS (2026-08-16, M21.5)

The 2026-08-15 amendment states the runner's egress without qualification. `scp-managed-scan`'s
otherwise-identical clause IS qualified (2026-07-23, "excepting operator-allowlisted registry
pulls"), which is why that class reads an operator setting — and why this one must not. An
operator-settable `SCP_MANAGED_DEP_NETWORK_MODE` with a `none` default was an operator-facing way to
contradict the charter, so the value is a literal in the plugin and the setting is read by nothing.
The four containment clauses ("never runs a package manager", "never resolves or regenerates a
lockfile", "never builds, compiles, or tests", "the runner contains no package manager") are
properties of the `scp-runner-dep` image, and §8e is what makes them enforceable rather than
asserted.

### 8e. THE RUNNER IMAGE IS BUILT, PUBLISHED, PINNED BY DIGEST, AND CHECKED AS AN ARTIFACT (2026-08-16, M21.5)

An image nothing builds enforces nothing, and three separate things had to be true before the four
clauses above were more than prose:

1. **IT IS BUILT AND PUBLISHED ON THE SAME TERMS AS ITS TWO SIBLINGS.** `apps/runner-dep` existed as
   source that no CI job built, nothing bundled and nothing pinned — so the class could not be enabled
   on any shipped deployment, and `SCP_MANAGED_DEP_RUNNER_IMAGE` had no value an operator could
   name. It now rides `ci.yml`'s `runner-images` job (a content-hash tag from
   `scripts/runner-image-tags.sh`, pulled by the integration job) and `publish-images.yml`'s
   deliberate `sha-<commit>`/`latest` release tags, exactly as `scp-runner-scan` and `scp-runner-iac`
   do.

2. **THE BASE IS A LITERAL DIGEST, NOT A TAG BEHIND A BUILD ARG.** Built as
   `ARG RUNNER_DEP_BASE_IMAGE=busybox:1.36.1-musl`,
   `docker build --build-arg RUNNER_DEP_BASE_IMAGE=node:22 apps/runner-dep` produced an image tagged
   as the vetted runner carrying a full Node toolchain — every clause false — while the test that
   claimed to pin the base read the Dockerfile's TEXT and stayed green. A clause that cannot be traded
   away is not expressible as a parameter, so the base is a literal digest (`tools/busybox/pin.env`
   is the single source of truth, mirroring `tools/trivy` and `tools/openscap`, with the same
   drift test).

3. **THE CLAUSES ARE ASKED OF THE BUILT ARTIFACT.** They are statements about what the image
   CONTAINS, and a source-text test can only say what the build ADDS. Asking the artifact found the
   obvious build to be wrong on its first run: a stock BusyBox ships **`dpkg` and `rpm` applets**, so
   `FROM busybox` + a shim made "the runner contains no package manager" false. The runtime image is
   therefore **assembled rather than inherited** — an `assemble` stage copies out the one static
   multi-call binary and creates symlinks for exactly the seven applets the shim invokes, and the
   final stage is `FROM scratch`. **The residual:** BusyBox is a multi-call binary, so the code behind
   those applets is still inside `/bin/busybox`; removing it needs a custom-compiled BusyBox, i.e. a C
   toolchain in the build of the one image whose argument is that it has none. What the clauses are
   about is unaffected — `--network none` is unconditional (nothing to fetch), the only bytes present
   are the one manifest copied in (nothing to unpack), and neither dpkg nor rpm is one of the five
   ecosystems this class authors (nothing to resolve) — and the residual is pinned by a test rather
   than left in a comment.

### 8f. THE AUTHORSHIP OF A BUMP IS SERVER-OWNED STORAGE, NEVER `changes.source_ref` (2026-08-16, M21.5)

Every input that decided **whose credential merged what** — the repository, the authored ref, the base
branch, the component, the line, the branch's head commit — was read out of
`changes.source_ref.scp_authored`. `source_ref` is the raw delivery payload plus a few lifted keys and
is writable **verbatim by any authenticated principal** through `POST /api/v1/changes`; the event that
starts the merge gate is likewise producible through `POST /change-sources/{kind}/report`. A tenant
could therefore fabricate a "bump" naming **any** repository and have SCP merge into it with SCP's own
installation credential. That is a confused deputy, not a validation gap: validating an
attacker-writable field yields a well-formed attacker-supplied answer.

The rule that follows, and that §8c's clauses are each an instance of: **a merge is the one
irreversible thing this feature does, so it acts only on facts SCP itself recorded — never on a field a
tenant can write, and never on state read back from the provider.**

So migration 0063 adds `dependency_bump_authorships`: one row per bump change, written by the actuator
when SCP decides to author, by the ingress that observes SCP's own branch coming back, and by the gate
when the provider confirms a merge. No route, no IaC object type and no federation importer reaches
it. **A change with no authorship row is not a bump change and never reaches the merge path**, whatever
its `source_ref` claims. `source_ref.scp_authored` keeps being written as the human-readable
explanation (principle 6) and is read by nothing that decides a write.

Three further consequences fall out of the same table rather than needing their own mechanisms:

* the CI-conclusion correlation route (§8c clause 2) becomes **one indexed lookup**. It had been an
  unbounded, unindexed scan of every dependency-bump change in the org, comparing jsonb in TypeScript,
  **inside the ingress transaction, on essentially every webhook**;
* `merged_at` stops the audit trail lying. A merge produces its own provider events, which correlate
  back to the bump and re-run the gate; that second run found no open pull request and recorded
  `withheld / merge_refused`, so **the latest Decision for a bump that DID merge said it did not** —
  principle 6 inverted on the one irreversible action. The gate now returns before dispatching;
* the auto-merge grant binds evidence to the **component's own repository** as well as to its own
  commit. A module name is a string: a `github-check` control configured against an unrelated
  repository that happens to contain the same commit object (a fork, a mirror, a vendored copy — commit
  ids are content hashes and travel freely) satisfied the commit narrowing exactly as the component's
  own CI would. The run's evidence must now also name the repository the authorship row records.

And the module a control run was produced by is stamped **on the run** (`control_runs.plugin_module`,
same migration) rather than read from the current `control_bindings` row by join: a binding is mutable,
so re-pointing one control at `github-check` retroactively relabelled every historical pass of it as an
own-check pass, and the grant reads historical runs. Evidence about the past must not be re-narrated by
a present-tense edit (ADR-0030 §2).

### 9. The executor interface does not change

No fifth verb is added: the four-verb set **is** the structural enforcement of charter principle 1, so a
`write` verb would remove the enforcement mechanism rather than extend it. M21.4's server-side
`readFileAtRef` route does **not** breach this and §7c clause 1 says exactly how: it is a separate
plugin-host client dispatched against the loaded ADAPTER, so the object an `ExecutorPlugin` instance
exposes is unchanged and `createExecutorPluginFromAdapter` still refuses to surface the hook. It also
only READS. Authored content is **not**
threaded through `TriggerIntent.parameters` — nothing populates it today, and `managed-iac`'s
`intent.parameters.sourceFiles` is **not** a precedent (nothing ever populates it, and it writes to an
ephemeral workspace, never a repo).

A commit SCP authors is observed back in via the normal webhook path, so the bump change must be recorded
such that the returning event **correlates to it** rather than minting a second, unrelated change.

### 10. Five ecosystems, sequenced hardest-last

npm, Go, Maven/Java, Python and container images (owner, 2026-08-13), built Go → images → npm → Python →
Maven, so the end-to-end path, the air-gap shape and the lockfile limit are each proven before the
heaviest parser.

## Charter alignment

- **Principle 1 (coordination, not execution)** — **bent, by amendment.** §8 is a new enumerated managed
  class; without the amendment the clause does not ship. The four-verb interface is preserved (§9).
- **Principle 2 (graph-native)** — **scoped bend, §3.** The declared config stays graph-native; only the
  derived, high-churn inventory is tabular, on four measurements, with the no-transitive-traversal
  boundary as its limit.
- **Principle 4 (PostgreSQL the only required stateful dependency)** — unchanged; no new service.
- **Principle 5 (air-gap first-class)** — preserved by §7: operator-loaded signed feeds, an explicit
  unavailable state, and images that need no external feed at all.
- **Principle 6 (explainability)** — every enablement level contributes a recorded reason, and every
  verdict persists a Decision under `insertDecisionIfChanged`.

## Alternatives considered

- **Mode A — coordinate the org's existing Renovate/Dependabot** (rejected by the owner, 2026-08-13).
  This is what ADR-0002's router actually returns, needs no amendment and no credential. Rejected in
  favour of SCP owning the actuator.
- **Mode B — bundle Renovate as a Standard Stack backend** (rejected by the owner, 2026-08-13). It passes
  all five Mode-B criteria on paper, but extending the Standard Stack requires the same owner sign-off as
  Mode C and leaves the actuator outside SCP.
- **Graph-native inventory** (rejected, §3). Requires a URN scheme that survives package coordinates,
  accepts the measured write amplification, and makes the importer-tolerance fix a hard prerequisite.
- **Reusing `depends_on`** (rejected, §5). It would inject package-graph cycles into the plan compiler.
- **Harvesting Trivy's output as the primary inventory** (rejected as *primary*, kept as a cross-check).
  `parseTrivyResult` already receives `PkgName`/`InstalledVersion`/`PURL` and discards them
  (`promotion-scan-step.ts:687`), so it is nearly free — but it walks `Results[].Vulnerabilities[]`, which
  is the **vulnerable** package set, not a complete dependency list, and it only covers artifacts that
  pass a managed promotion scan.
- **A second fan-out engine** (rejected). Campaigns already fan one intent to N components in waves with
  gates and rollback; `provides`/`requires` already implements a real `waiting` predicate.
- **Reusing `correlation_key` as the subscription key** (rejected). It is already populated org-wide with
  colliding values (`refs/heads/main`), so the first satisfied release would satisfy every waiter.

## Consequences

**Positive**

- The two hot queries stay single-hop index lookups, avoiding the measured CTE hazard entirely.
- The enablement chain is the same pure, order-independent algebra already proven in the scan-requirement
  resolver, and it makes "instance ON silently activates everything" structurally impossible.
- Container images reuse identity (`ArtifactRef`), reach (skopeo/Harbor) and the promotion scan gate that
  already exist, and are the one ecosystem with no air-gap gap.
- Fan-out and the wait predicate reuse shipped engines rather than adding a second of each.

**Costs / honesty**

- **§8 ships only with a charter amendment.** Until it is approved, this ADR's actuator clause states
  intent, not behaviour — reading it is not evidence the code does it.
- **Gate 1 genuinely fails** for this class wherever a bot exists. The gate-1-flip framing makes the
  decision coherent; it does not make the gate pass. Conflict detection is the mitigation, and if it is
  weak, two actuators will fight over one file.
- **Manifest-only means lockfile ecosystems are partially served** — the bump lands, the lock is the
  org's CI's problem.
- **Principle 2 is bent**, and the boundary that justifies it (no transitive traversal) is a discipline
  that must be enforced by test, not by intention.
- **Domain-local internal dependencies are invisible across domains** by ADR-0031's design.
- The importer-tolerance question (proposal §10 Q6) remains open and may be a **prerequisite**: the
  subscription object type is new, and a not-yet-migrated outpost's channel is what is at risk.
