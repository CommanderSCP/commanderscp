# ADR-0030: Dev pipelines are selected by source ref, and the exemption stays operator-declared

**Status:** Proposed — §1/§2 implemented, §3 pending owner review (owner-directed 2026-08-10; supersedes part of [ADR-0018](0018-domain-local-dev-pipelines.md) §1/§4 if accepted)
**Context doc:** [BUILD_AND_TEST.md §8 M18](../BUILD_AND_TEST.md); [ADR-0018](0018-domain-local-dev-pipelines.md)
**Relates to:** [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (scan is a *boundary-crossing* authorization gate); [ADR-0016](0016-scoped-scan-requirement-policies.md) (scoped scan-requirement policies — the *local* gate); [ADR-0017](0017-ownership-refinement.md) (E6, the export-time gate); [ADR-0007](0007-executor-type-taxonomy.md) (the routing Type a mapping carries); charter principle 1 (coordinate, not execute), principle 6 (explainability)

## Context

The owner's direction (2026-08-10): **"the dev pipeline should be based off of the `dev` branch of the relevant repo(s)."**

ADR-0018 assumed a dev pipeline is recognised by *where it deploys* (an operator label on a
`deploymentTarget`) and that the scan exemption falls out of *path* (a domain-local change targets no
federation peer → never enters `exportPromotionBundle` → the cross-boundary gate structurally never
applies). The new direction says a dev pipeline is recognised by *what drove it* — the source ref.

### The measured gap this exposes

Grounded in code on 2026-08-10, not inferred:

- **`source_mappings` has no ref/branch column.** `matchComponentForSource`
  (`apps/server/src/coordination/correlation.ts:190-197`) matches and ranks on `repoPattern` and
  `pathPattern` **only**. A push to `dev` and a push to `main` in the same repo therefore correlate to
  the **same component and the same routing Type** — the same pipeline. *There is today no way to
  express the owner's request at all.*
- **The ref is already carried, and already discarded for routing purposes.** The GitHub adapter sets
  `correlationKey: p.ref` (`packages/plugins/github/src/index.ts:300`), i.e. `refs/heads/<branch>`.
  That value is used downstream only to **group** changes onto a `coordinated-change` object
  (`correlation.ts:204-240`); it is never consulted when selecting the mapping.
- **The export gate has no source input whatsoever.** `evaluatePromotionScanGate`
  (`federation/promotion-repo.ts:136-160`) takes `(substantiveArtifacts, controlOutcomes)`. It knows
  nothing about branches, refs, or origin. Making a branch relax it is therefore **not** "removing a
  check" — it is **adding new plumbing to carry a source-derived string into a fail-closed gate so
  that the gate can be bypassed**.

### The distinction that decides this ADR

Discussion of "the dev pipeline skips the scan" conflates **two different gates**. They have different
purposes, different blast radii, and only one of them is contentious:

| | **Gate 1 — the local scan Control** | **Gate 2 — E6, the export gate** |
|---|---|---|
| What it is | An *optional* operator-attached scan requirement on a pipeline ([ADR-0016](0016-scoped-scan-requirement-policies.md), `governance/scan-requirements.ts`) | The fail-closed cross-boundary authorization gate ([ADR-0017](0017-ownership-refinement.md) §2, `exportPromotionBundle`) |
| Purpose | Local **quality** gate — an org's own policy | **Authorization** to cross a security boundary |
| Default | **Off.** A domain-local pipeline is ungated today | **On, universal, fail-closed.** Missing scan ≡ failed scan |
| Blast radius if skipped | A dev deploy inside one domain is unscanned — the domain's own risk, contained | **Unscanned bytes cross a CDS boundary into the high side** |
| Exempting dev is… | **Free and already true today**, and entirely reasonable to make explicit | The [ADR-0018](0018-domain-local-dev-pipelines.md) rejected alternative "Relax E6 for dev-originated digests" |

**Domain-local dev deploys are already unscanned**, by path, with no branch involved
(`coordination/pre-deploy-gate.ts` exempts any change without `importedFromDomain`). So a
branch-driven exemption changes observable behaviour in **exactly one case**: a `dev`-built digest
being **promoted across a domain boundary**. Everywhere else, options "routing only" and "branch
grants the exemption" are indistinguishable.

### Why a raw branch name must not be the enforcement input

If the exemption keys on the *string* `refs/heads/dev`:

- **A branch name is not an authorization boundary.** Anyone with push access can create a branch
  named `dev`. The bypass becomes "push a branch called `dev`."
- **The exempting branch is the *less* protected one.** Branch protection conventionally guards
  `main`; `dev` typically has weaker or no protection. The exemption would attach to the weakest ref
  in the repo.
- **The bit would travel with the digest.** A digest built from `dev` is the same digest. Honouring
  its origin at E6 re-opens precisely the hole [ADR-0018](0018-domain-local-dev-pipelines.md) §2 closes,
  and contradicts its own rejected alternative.
- **Prior art in this repo.** A label named after *which branch matched* goes false the moment that
  branch covers a second kind — already shipped once here, in a Decision where it had been wrong since
  before the level that exposed it (charter principle 6).

## Decision

### 1. Dev pipelines are SELECTED by source ref — a third routing glob (uncontentious)

`source_mappings` gains a nullable **`ref_pattern`** glob, matched against the event's git ref
(`refs/heads/dev`, `refs/heads/release/*`). It joins the existing precedence contract as a peer of
`repoPattern`/`pathPattern`:

- **Rule 1** (most constrained) counts three globs, not two.
- **Rule 2a/2b** (narrowest wildcard, most literal text) sum across three columns.
- **Rule 3** (oldest, then id) is unchanged and still total.
- A **null** `ref_pattern` matches every ref — so every existing mapping keeps its current behaviour
  exactly, and this is a pure additive expand.

An event whose ref is unknown fails a ref-scoped mapping, matching the existing fail-closed treatment
of an unknown path (`matchesAnyPath`) — a ref-scoped mapping must never claim a release it cannot
prove is its own.

### 2. Dev-ness is READ from the matched mapping, never inferred from the branch string

The operator declares *"this mapping is the dev pipeline"* on the `source_mappings` row. The UI and
every report read that declared property; nothing parses the branch name looking for `dev`. This is
the owner's decision on the M18.3 label (2026-08-10) and it survives a repo whose `dev` branch
legitimately drives a second pipeline kind — the failure mode named above.

### 3. The dev loop is made FAST by moving the scan left — not by exempting the crossing

**Owner input, 2026-08-10, which decides this clause:**

| Question | Answer | Consequence |
|---|---|---|
| What is the friction? | **Dev iteration speed — scanning is too slow** | The problem is LATENCY, not the gate's existence. That admits fixes that do not touch E6. |
| Which boundary? | **Commercial/routine crossings only, never CDS** | A carve-out would have to be boundary-scoped… but see below: the chosen fix needs no carve-out at all. |
| Who can push `dev`? | **Wider — anyone with repo write** | **Decisive.** The branch cannot carry enforcement weight: the set that can mint the exemption is strictly larger than the set that can authorize a promotion. |

The third answer settles the security question on its own. An exemption keyed on `refs/heads/dev`
would be **mintable by anyone with repo write** — a strictly wider trust set than promotion approval,
on the branch that conventionally carries the *weakest* protection. That is not a policy this ADR can
write defensibly at any boundary, commercial included.

But the first answer reframes the problem, and the fix already exists and is already shipped.

#### The scan is slow because it is ON the promotion critical path — and it does not have to be

The cost is not the vulnerability database (baked into the runner image; scans run
`--skip-db-update --offline-scan`, so nothing is downloaded per scan). It is that
`runPromotionScanStep` **pulls the image and scans it at export time**, while the operator waits.

`runPromotionScanStep` already has the fix as its **first branch — the (a) SHORT-CIRCUIT**: if a
passing, digest-bound scan outcome *already covers* the digest, it scans nothing at all. The predicate
it uses (`isCoveringScanOutcome`) is deliberately the **exact predicate E6 applies**, so "already
covered here" means "E6 will accept it there" — the two ingresses are tied by construction.

So the decision is:

- **Dev pipelines scan at BUILD time, in their own CI, via the shipped `scan-result-control`
  ControlPlugin** (M17.1, digest-binding). The scan runs while the engineer is doing something else,
  off the promotion critical path entirely.
- **A later crossing then costs nothing.** The promotion step short-circuits, E6 reads the existing
  evidence, and the export is as fast as an exempt one would have been.
- **E6 is untouched.** No source, ref, or classification input; fail-closed and universal.

This is strictly better than the exemption on every axis that was in tension:

- It **removes the latency** — the thing actually asked for — rather than removing the control.
- It is **not forgeable**: the evidence is a digest-bound control run, not a branch name, so "anyone
  with repo write" buys nothing. A dev who tampers with the scan result produces evidence that does
  not match the promoted digest, and `digestMatch: false` fails exactly like a missing scan.
- It **needs no commercial-only carve-out**. The same mechanism works at a CDS boundary, so the
  high-side guarantee is preserved without a second policy to reason about.
- The artifact **is genuinely scanned**, so the answer to "was this scanned?" stays *yes* everywhere —
  no class of promoted artifact becomes unauditable (charter principle 6).

#### If that is still not fast enough

The fallback is **not** an exemption; it is [ADR-0016](0016-scoped-scan-requirement-policies.md)'s
scoped scan-requirement policies, which already express exactly the owner's boundary answer: a
**permissive per-severity threshold on the commercial trust domain** and a strict one at the CDS
partition. That mechanism is **operator-declared** (a policy row written through an authorized API,
not a string in a `git push`), **boundary-scoped by design**, and **already built and tested**. It
makes the gate cheaper to satisfy without making it absent, and it is not mintable by a pusher.

#### The latency is taken on report, not measured (owner decision, 2026-08-10)

How long a promotion scan actually takes on the live estate — and what fraction is the skopeo pull
versus the Trivy run — was **not** measured; the owner declined the measurement as unnecessary. The
design does not depend on the split: moving the scan off the promotion critical path removes whatever
that cost is, whichever component dominates, because the crossing then does no pull and no scan at
all. Recorded here so a future reader does not mistake the latency premise for something this ADR
established.

## Charter alignment

- **Coordinate, not execute (1):** unchanged — ref matching is correlation of observed events.
- **Graph-native (2):** `ref_pattern` is correlation/registry data on an existing table, not a new
  concept or a new top-level table.
- **Explainability (6):** a dev-routed release records the mapping that matched, so "why did this go to
  the dev pipeline?" is answerable from the Decision; an E6 refusal of a dev digest still persists a
  block Decision + `decision_id`.
- **Simplicity (7, first priority):** one nullable column and three symmetrical additions to an
  existing ranking — no new enforcement primitive.

## Alternatives considered

- **Branch name as the enforcement input at E6 (rejected on measured trust, 2026-08-10).** The
  owner's direction taken literally. Rejected for the four reasons in Context — forgeable by any
  pusher, attaches to the least-protected ref, travels with the digest, and requires new plumbing into
  a fail-closed gate whose entire value is having no such input — and **decisively** by the owner's
  own answer that push access to `dev` is WIDER than promotion-approval authority. It is also, on the
  stated motivation, unnecessary: §3's scan-left path removes the latency without removing the
  control. Adopting it anyway would need a superseding ADR amending
  [ADR-0018](0018-domain-local-dev-pipelines.md) §2 and a rewrite of the M18.1 leakage guarantee,
  which would then be provably false as written — the inertness test in
  `federation.integration.test.ts` is mutation-proven to go red on exactly this change.
- **A separate `dev_pipelines` table (rejected).** A pipeline is not a first-class object
  (component + Type + binding); ref matching is correlation config and belongs beside the other globs
  (principle 2, and Simplicity).
- **Inferring dev-ness from the branch string for display (rejected).** See §2 — a label named after
  which branch matched goes false when the branch covers a second kind.
- **Leaving routing to `pathPattern` (rejected).** Paths and refs are orthogonal: the same directory on
  two branches is two pipelines, which no path glob can express.

## Consequences

**Positive**
- The owner's request becomes expressible at all — today it is not.
- Existing mappings are untouched (null `ref_pattern` matches every ref): a pure additive expand.
- The M18.1 leakage test gets a strictly stronger claim to prove.

**Costs / honesty**
- **§3 narrows the owner's stated direction and is pending sign-off.** Everything in §1/§2 is
  independent of that and safe to build either way; only §3's E6 clause is contested.
- The precedence contract gets a third dimension. Rule 2's ranking was already subtle enough to have
  produced one real misrouting on the live estate (`correlation.ts:69-77`); a third glob widens the
  space of ambiguous configurations, so the ordering test matrix must cover ref-vs-repo-vs-path ties.
- `ref_pattern` only helps sources that actually carry a ref. Registry/package pushes (harbor, gitea
  `package`) carry none, so a ref-scoped mapping will never match them — correct, but an operator who
  sets one and sees nothing route needs the UI to say why.
