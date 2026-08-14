# ADR-0032: Dependency subscriptions — a declared inventory, a three-level enablement chain, and a managed bump actuator

**Status:** Proposed (2026-08-13) — five decision points settled with the owner on 2026-08-13; **the §8 actuator clause is contingent on the charter amendment it requires**, and is DECIDED, NOT YET BUILT.
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

### 4. Direct declared dependencies only

The inventory is what a component's own manifests **declare**. The transitive closure is not stored:
ADR-0013 keeps SBOM bytes out of SCP deliberately, and a stored closure is that by another name. Both
queries the feature needs — *"which components subscribe to P?"* and *"what does C declare?"* — are
single-hop index lookups.

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

### 7. Detection has two ingresses and an air-gap shape

- **Internal** — derived, because no event carries it: `scp.change.transitioned(toState=accepted)` → the
  change's wave targets → `deployment-target.properties.environment === 'prod'` → the component placed
  there → the lines it **declares** it publishes. Rollback changes auto-accept and are **not** releases.
  Domain-local changes do not journal (ADR-0031), so domain-local internal dependencies are
  domain-visible only — stated, not discovered later.
- **Third-party** — a daily self-rescheduling tick (there is no `boss.schedule` usage to copy) resolving
  versions through per-ecosystem **index plugins**, so the existing egress guard and host allowlist
  apply. The job is **explicitly role-guarded**: there is no trustworthy runtime commander/outpost
  predicate, so an unguarded background job runs on air-gapped outposts too.
- **Air-gap** — the Trivy-DB shape (the only shipped external-feed pattern): an operator-loaded,
  cosign-signed feed with a fail-closed staleness policy. Where neither an index nor a feed exists,
  third-party detection reports **unavailable** rather than degrading silently.
- **Container images** need none of that fallback: the org's own registry **is** the index, reached by
  the existing skopeo/Harbor path. Image tags are **not** semver, so a line carries a tag pattern plus a
  parsed-version extractor, unparseable tags are **skipped rather than guessed**, and the subscription
  records the **digest** it moved to, because a mutable tag is not an identity.

Per-tick verdicts use `insertDecisionIfChanged`; a daily poll re-writing a byte-identical "no new
version" Decision per dependency would reproduce the measured 1.44 GB/day amplification exactly.

### 8. The actuator is a managed class — DECIDED, NOT YET BUILT

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

### 9. The executor interface does not change

No fifth verb is added: the four-verb set **is** the structural enforcement of charter principle 1, so a
`write` verb would remove the enforcement mechanism rather than extend it. Authored content is **not**
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
