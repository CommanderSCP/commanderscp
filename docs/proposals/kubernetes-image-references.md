# Kubernetes image references — reading a pinned image out of Helm values, not only out of a `FROM` line

**Status:** Proposed (2026-08-17). **BUILT (2026-08-17, M21.7) on the recommendations in §6 — Q1
yes, Q2 visibility-this-round, Q3 deferred, Q5 yes; Q4 is still open and is a behaviour question, not
a blocker.** The normative record of what shipped is [ADR-0032 §4b](../adr/0032-dependency-subscriptions.md);
this document is the derivation behind it. §7's work items are done except item 7's wording — the
pre-dispatch refusal landed in `planBump` as `manifest_not_editable_in_this_build` rather than in
`dispatchForComponent`, so it is reported through the refusal table every other "not due" reason
already goes through.

**Round-5 correction (2026-08-17), and it is a behaviour change, not a wording one:** the shapes in
§2.1/§2.2 are read only from a mapping IN IMAGE CONTEXT — see **§2.5**, which also records why an
empty coordinate is a cross-component merge rather than one bad row, why `registry: ""` is the
default registry, why a `digest:` is now shape-checked in BOTH image parsers, and two measured facts
that contradicted the parser header (`yaml`'s duplicate-key scan is quadratic in
siblings-per-mapping, and an empty `---` document was stamped `unreadable` forever).

**One correction the build measured**, recorded here because §5 rests on it: `packages/plugins/managed-dep`
does NOT ship into the `scp-runner-dep` image. `apps/runner-dep/Dockerfile` is `FROM scratch` plus a
BusyBox multi-call binary and seven applets, with no Node runtime at all — so no version of
`@scp/dependency-manifests` has ever been inside it, and adding `yaml` puts nothing new into that
image. The decision to take `yaml` is unchanged and the property is still recorded as spent; what the
property actually buys is a small auditable supply chain for the plugin subprocess and the air-gap
bundle, not runner-image portability.
**Owner ask:** M21.7. "Most Kubernetes users pin image versions in Helm values, not in a `FROM` line.
Today such an image does not appear in the inventory at all, so it reads as *no dependency* rather
than *unsupported*."
**Amends:** [dependency-subscriptions.md §6.3](dependency-subscriptions.md) — whose closing sentence
says the opposite (see §0 below).
**Relates to:** [ADR-0032](../adr/0032-dependency-subscriptions.md) §4 (direct declared dependencies),
§4a (what writes the inventory), §7 (detection), §7b clause 6 (a reason names its own cause), §8–§8f
(the actuator).

---

## 0. First, the contradiction this work walks into

`dependency-subscriptions.md` §6.3 closes with:

> Scope for the manifest source is the component's **own build input** (`Dockerfile` `FROM`), not its
> deployment manifests — a Helm values image tag is a *placement* concern and belongs to the promotion
> path that already exists, not to this feature.

That clause is repeated as a code comment in `packages/dependency-manifests/src/dockerfile.ts:31–33`
("Only build inputs… a Helm values image tag is a *placement* concern owned by the promotion path that
already exists").

The owner's ask reverses it. This is the failure mode CLAUDE.md names: an Accepted document that
contradicts another clause of itself. So the reversal is recorded **as an amendment** — §6.3 of the
older proposal is marked superseded in this same commit, and the `dockerfile.ts` comment is a named
build-round item below (§7) rather than something a future reader has to reconcile.

**Why the original clause was wrong, stated rather than just overturned.** It reasoned about *who
owns the change* (promotion owns placement), which is true, and concluded *therefore SCP should not
record the declaration*, which does not follow. The inventory records what a component's own
repository **declares**; a `tag: 1.2.3` in a values file the component's repository owns is a
declaration in exactly the sense `FROM alpine:1.2.3` is. Promotion owns moving an artifact between
stages; it does not own the fact that this repo pins that base image.

**Why a new file rather than a new §.** The older proposal is Accepted-and-built; blending a reversal
into its settled text hides that a decision changed. This document carries its own decision points
(§6) for owner sign-off and can be read as a unit.

---

## 1. WHICH FILES — recommendation: the exact basename `values.yaml`, and nothing else

### 1.1 Why globbing every YAML file is not an option we are choosing between

It is not expensive, it is **unavailable**. `GitProviderAdapter`
(`packages/plugins/git-provider-core/src/index.ts:213–284`) has exactly one file verb —
`readFileAtRef`, "Read ONE file's decoded text at a git ref". There is no list, no tree, no directory
walk, and the interface comment states the reason it stays that way ("NOT AN EXECUTOR VERB (ADR-0032
§9, charter principle 1)"). `inventory-ingestion.ts:255–266` already records the same measurement from
the other side: *"Nothing in the tree records where a component's manifests are… The plugin host
exposes no directory listing either: the only file verb is `readFileAtRef`, which takes ONE path and
refuses a directory with `not_a_file`."*

So "every `.yaml` in the repository" is a set SCP cannot enumerate. The closest thing that sees real
filenames is discovery's one-level `contents/` walk (`packages/plugins/github/src/index.ts:940–959`,
mirrored in gitea and gitlab), and it throws every name away at a `hasMarker` boolean.

The other two costs are real but secondary:

- **Read budget.** `candidateManifestPaths` generates `prefixes × MANIFEST_PARSERS.keys()` and clamps
  at `MAX_MANIFEST_READS = 40` (`inventory-ingestion.ts:393, 404–432`). Every filename added to the
  table is a multiplier on every prefix. Six filenames × 5 prefixes is 30 reads; ten filenames × 5 is
  50, i.e. ten real manifests silently frozen behind `read_budget_exhausted` on every pass.
- **`manifest_path` is part of the identity.** `component_dependencies`' primary key is
  `(org_id, component_object_id, line_id, manifest_path)` (`apps/server/src/db/schema.ts:1920–1923`),
  and the prune is per `(repo, manifest_path)` (`inventory-ingestion.ts:1039–1044`). A path is a
  *durable key*, not a scan target: probing 300 YAML files would mint up to 300 keyed row-sets per
  component and make every subsequent pass responsible for re-probing all of them to avoid a stale
  prune.

### 1.2 The rule

**Add exactly one entry to `MANIFEST_PARSERS`: `values.yaml`.** Probed under the *existing* prefix
derivation, with no new prefix invention, no glob, and no conventional-directory list.

`values.yml` is deliberately excluded. Helm does not read it: a chart's default values file is named
`values.yaml` by Helm itself, so a `values.yml` in a repository is not a chart's values file and
guessing that it is would be a filename-shaped inference of the kind ADR-0032 §7b clause 6 refuses.

`Chart.yaml` is excluded for a different reason: its `dependencies[].version` names **subcharts from a
Helm repository**, which is a sixth ecosystem — a new `DependencyEcosystemSchema` member, a new DB
check-constraint value, and a new version-index plugin. Out of scope; named in §6 as a question.

### 1.3 Why one exact basename actually reaches the owner's estate

`repoManifestScope` (`inventory-ingestion.ts:297–343`) derives probe prefixes from the **literal head**
of each `source_mappings.path_pattern` that names this repository. A pattern `chart/**` yields
prefix `chart`; a candidate `chart/values.yaml` is then generated and accepted by `scopeClaims`,
because `globMatch("chart/**", "chart/values.yaml")` compiles to `^chart/.*$`
(`apps/server/src/coordination/glob-match.ts:8–16`).

And those patterns already exist and already point at chart directories. The Argo CD importer writes
one `source_mappings` row per Application source with
`pathPattern = ${src.path}/**` (`packages/plugins/argocd/src/index.ts:742–760`), whose comment records
the measurement: *"The 43 components that DID have path patterns (added by hand for homelab-gitops)
routed correctly"*, against 19 that had only bare repo patterns.

So for a component whose chart directory is its Argo source path, `values.yaml` becomes reachable the
moment the basename is in the table — no new machinery at all.

### 1.4 The explicit per-component declaration already exists — and it is not free

For a chart at `charts/<name>/values.yaml` where `<name>` is not a prefix any mapping yields, the
escape hatch is a `source_mappings` row whose `path_pattern` **names the file**:
`charts/api/values.yaml`. `repoManifestScope` handles that case deliberately — a wildcard-free pattern
whose last segment is a known manifest filename is read as a FILE, and its parent becomes the prefix
(`inventory-ingestion.ts:337–339`). Adding `values.yaml` to `MANIFEST_PARSERS` is therefore what makes
this addressing work at all today.

**Stated cost, because it is not a free knob:** a `source_mappings` row is also a *correlation* rule —
`correlation.ts` routes pushes to components by the same `(repo_pattern, path_pattern)` pair. Adding
one changes which pushes reach this component. Here the coupling points the right way (a change to
that values file *is* a change to that component), but it is a side effect and an operator must be
told about it, not surprised by it.

**Rejected: a new policy effect.** A `dependencySubscription` effect (`packages/schemas/src/dependencies.ts:361–373`)
is a `strictObject` whose selectors are `(ecosystem, coordinate, major)` — it selects **lines**, and it
resolves through a **monotone AND where the deepest level may only subtract** (ADR-0032 §6). A
manifest-path declaration is *additive* and is about *files*, so it is a category error on both axes.
A second effect type would be a new authoring surface, a new Ajv block in a migration, new resolution,
and new UI, to replace a `source_mappings` row that already works.

### 1.5 The residue, stated

A chart at a path no mapping's literal head reaches, and for which nobody authors a mapping, stays
invisible — and its stamp reads `ok / 0 rows`, i.e. "declares nothing". That is the same class of
dishonesty as the one being fixed, one level up, and this round does not close it. The honest fix is
already named in the code (`inventory-ingestion.ts:263–266`): widen discovery's walk to **report** the
filenames it already sees instead of collapsing them to `hasMarker`. That is a change to three
adapters plus the `DiscoveryProposal` shape and belongs in its own round.

---

## 2. WHICH SHAPES

Written against `DeclaredDependency` (`packages/dependency-manifests/src/types.ts:111–153`) — the same
vocabulary `parseDockerfile` emits. **The ecosystem stays `oci`.** No new ecosystem, no new line
identity, no new index plugin, no new version comparator: `dependency_lines` is keyed
`(ecosystem, coordinate, major)` with `tag_pattern` as the literal variant suffix, and an image pinned
in a values file is the same line as the same image pinned in a `FROM`.

### 2.1 Read, and a row is written

| # | Shape | Coordinate | Declared | Bumpable today |
|---|---|---|---|---|
| A | `image: "repo/name:tag"` (one scalar) | `repo/name` | `tag` | **yes** |
| B | `image: {repository, tag}` | `repository` | `tag` | no — §2.3 |
| C | `image: {registry, repository, tag}` | `registry/repository` | `tag` | no — §2.3 |
| D | any of A–C carrying `digest:` (with or without a tag) | as above | tag if present | no — no comparable version when digest-only |

**Every row of this table and the next is conditioned on IMAGE CONTEXT — see §2.5**, which is a
round-5 correction to the build, not a refinement of it. `repository`, `registry`, `tag` and `digest`
read off any mapping that carries them are false positives on ordinary charts.

Shape A is split with the *same* rules `splitImageRef` (`dockerfile.ts:101–143`) already applies: last
depth-0 colon after the last depth-0 slash is the tag (so `localhost:5000/foo:1.2` is a port plus a
tag), `@` is cut before the colon so a digest's own `algo:hex` colon is not read as a tag separator.
Do not write a second splitter — reuse that one.

Shape C joins `registry` and `repository` with a single `/`. That join is a **construction**, and §2.3
is the consequence.

Shape D carries `digest` verbatim on `DeclaredDependency.digest`; a digest-only pin has no comparable
version, so it is reported and no line row is written — exactly `dockerfile.ts:249–267`.

### 2.2 Reported `unsupported`, and never silently absent — the point of the work

| # | Shape | Why | Behaviour |
|---|---|---|---|
| E | a bare `tag:` **in image context** whose mapping declares no `image`/`repository` | the image name is in the chart's templates or hardcoded — **not resolvable from this file** | `constraint: "unresolved"`, coordinate = the dotted key path (`controller.image.tag`), no row, named in the Decision |
| F | any of `registry`/`repository`/`image`/`tag` whose scalar text contains `{{` | a Go template; not resolvable from the file (§4 T2) | as E |
| G | a value reached through a YAML alias, or a `<<:` merge key **in image context** | the edit site is not the read site (§4 T10) | as E |
| H | `tag:` whose node is not a scalar (a sequence, a mapping, a block scalar) | not a version, or not one a single line of a diff can rewrite | as E |
| I | `repository`/`registry` that is empty or not repository-shaped, or a `digest:` that is not `algorithm:hex` | an empty coordinate MERGES components across the org; a non-digest can never match a registry's answer | as E (§2.5) |
| J | one of the five image keys spelled TWICE in one mapping | Helm's Go YAML takes the last, a scan takes the first — which one this image uses is not knowable | as E (§2.5) |

Shape E is the case the owner's brief calls out, and it is handled with the package's own precedent:
`dockerfile.ts:218–230` already emits an entry whose coordinate is *the raw unresolvable text* with
`constraint: "unresolved"` when the image name is `ARG`-interpolated. Such an entry has no
`version`, so `placeDeclarationOnLine` returns `null` (`inventory-ingestion.ts:1209`) and it can never
mint a phantom `dependency_lines` row. ADR-0032 §7's "skipped rather than guessed" holds.

### 2.3 The visibility mechanism — three changes, none of them a migration

An `unresolved` declaration today lands in `ComponentIngestionOutcome.declarationsSkipped` with the
**single** reason `no_comparable_version` and a detail about a missing "numeric core"
(`inventory-ingestion.ts:466–473, 1021–1031`). For shape E that detail is about the wrong thing
entirely — the operator action is "declare the repository beside the tag, or point the mapping at the
chart", not "pin a parseable version".

1. **`SkippedDeclaration.reason` gains a second member** — chosen **structurally**, from
   `declaration.constraint === "unresolved"`, never by matching on the note's prose. This is
   `manifestStampOutcome`'s own discipline (`inventory-ingestion.ts:574–598`) applied one level down.
2. **A manifest whose every declaration is unresolved is stamped `unsupported`, not `ok`.** This is
   the class fix, and **it is a defect that exists today, independently of YAML.**
   `projectIngestionStamp` (`inventory-ingestion.ts:616–656`) maps every parsed manifest to
   `outcome: "ok", rows: manifest.declared`, and `declared` is the count of rows *written*. A
   Dockerfile that is entirely `FROM ${BASE}` therefore stamps `ok / 0 rows` — the table's own words
   for "read fine, genuinely declares nothing" — on a file that declared a base image SCP could not
   resolve. Same for a `pom.xml` that is all `${revision}`. `IngestedManifest` needs one more field
   (declarations seen but unresolved); no schema and no migration, since `IngestionStampManifest.outcome`
   already carries `unsupported` (`apps/server/src/db/schema.ts:1954–1959`).
3. **A mixed file stays `ok`** (rows were written) with the unresolved entries named in the stamp
   entry's `detail` and in the Decision's `declarationsSkipped`. The per-path enum has no `partial`;
   the component-level one does, and it is computed across the merged set.

### 2.4 Shapes B and C are read but **cannot be bumped**, and that must be visible too

This is the sharpest finding of the review and it is not a parser question.

`verifyManifestBump` (`packages/plugins/managed-dep/src/bump-edit.ts:212–220`) refuses unless **the
single changed line names the coordinate**:

```
if (!beforeLine.includes(spec.coordinate)) {
  return { ok: false, reason: "wrong_declaration_changed", … };
}
```

and `applyManifestBump` (`:330–345`) requires *exactly one* line containing **both** the coordinate and
`fromVersion`. In shapes B and C the coordinate is on the `repository:` line and the version is on the
`tag:` line — and in shape C the coordinate does not appear as a contiguous string anywhere in the
file. Every split-shape bump therefore fails as `wrong_declaration_changed`, which reads to an operator
as *"the runner image is broken"*.

There is a third gate: `MANIFEST_MATCHERS` in `packages/plugins/managed-dep/src/write-guard.ts:428–467`
is an `(ecosystem, basename)` allowlist, and its `oci` entry accepts only Dockerfile spellings. A
`values.yaml` is refused there as `not_a_known_manifest` — correctly, and fail-closed.

**Recommended round-one behaviour: leave the write allowlist closed, and refuse at dispatch.**

- `values.yaml` is **not** added to `MANIFEST_MATCHERS`. Fail-closed stays the default: no bump can
  ever be authored into a values file in this build.
- `bump-dispatch.ts` gains a **pre-dispatch** check so the refusal is a named reason on the Decision
  rather than a runner round-trip that ends in a misleading verdict. It already has the channel —
  `skip(reason, detail, manifestPath)` (`apps/server/src/dependencies/bump-dispatch.ts:518–521`).
- Consequence, stated plainly: a values-file line is **inventoried, subscribable, and polled** — the
  operator learns a newer `alpine` exists — and the bump is **refused with a legible reason**. That is
  strictly better than today's silence, and it is not the whole feature.

Bumping shapes B and C requires widening the verifier from "the changed line names the coordinate" to
"the changed line is the `tag` node of the image block the inventory row came from". That is a change
to a **charter-enforcement surface** whose entire design is "deliberately ecosystem-agnostic and
deliberately textual" (`bump-edit.ts:24–28`), so it is §6 Q2, not an implementation detail.

### 2.5 IMAGE CONTEXT — the round-5 correction, and why it is the load-bearing rule

**Measured after the build, on the code as shipped.** The first implementation applied §2.1's shapes
to *every mapping in the document*, which read as elegant ("one rule, no per-convention branch") and
was a false-positive generator. `repository`, `registry`, `tag` and `digest` are ordinary English
words. A real values file spends them on ordinary things:

```yaml
sources:                                  # upstream provenance, not an image
  - repository: https://github.com/acme/api
    tag: v2.4.0
kafka:
  schemaRegistry:
    registry: http://schema-registry.kafka.svc:8081   # a URL, not an image host
npm:
  registry: https://registry.npmjs.org               # a package feed
controller:
  resources:
    <<: *presets                          # ordinary YAML
  podLabels:
    tag: canary                           # a label
```

Each of those minted a dependency that does not exist, or an unresolved declaration — and §2.3's
class fix stamps a manifest whose declarations are ALL unresolved as `unsupported` and its component
`partial`. So the honesty mechanism this whole document exists to build would have fired on nearly
every chart in the estate, and **a warning that fires on everything is a warning nobody reads.** A
phantom coordinate is worse than the noise: it makes SCP author a bump against something that does
not exist, or rewrite the wrong line in a real file.

**The rule, and it is not a heuristic — it is the discipline the pod-spec walk already had.** A pod
spec is found because the key is spelled `image`, never because a value looks image-ish. A mapping is
IN IMAGE CONTEXT iff:

- (a) it carries an exact `image` key whose value is a SCALAR — the one-scalar shape, `containers[]`
  or anywhere else in the tree; or
- (b) it IS the value of an exact `image` key, directly or as an element of a sequence that is —
  Helm's `image: {repository, tag}` block. **One hop**, never inherited deeper, because "somewhere
  below a key called image" is the loose reading that mints the phantoms back.

An `image:` key whose value is a MAPPING does not put its own mapping in context: that mapping is the
PARENT of the image block, and reading its sibling `tag:` (a chart version, typically) as the image's
tag is the same defect. Outside image context nothing is read and **nothing is reported** — this is
not an image reference SCP failed to resolve, it is not an image reference.

> **AMENDED 2026-08-17 (trap 18; ADR-0032 §4b clause 7).** Rule (a) admits two populations that are
> not the same thing: a chart's image block that happens to spell the repository under `image:`
> (ingress-nginx does), and a Kubernetes **Container object**, where `image` is a complete reference
> and `tag` is not a field of the schema at all. Once [split-shape bumps](split-shape-image-bumps.md)
> made `values.yaml` WRITABLE, a container's sibling `tag:` stopped being merely a wrong row and
> became the line a bump would EDIT — a key nothing consumes, authored into by SCP. So the sibling
> `tag:`/`digest:` are read only where rule (b) ALSO holds: an image block is the value of an
> `image:` key, a container never is. Scoping it by pod-spec key NAMES was rejected — charts splice
> `sidecars:` and `extraContainers:` into pod specs, and a name list misses both.

Three refusals follow from the same "skipped rather than guessed" rule (ADR-0032 §7), each reported
so it is visible rather than dropped:

1. **An empty or near-empty coordinate is refused.** `repository: ""` is a live chart placeholder,
   and `dependency_lines` is keyed `(org, ecosystem, coordinate, major)` **org-wide**. An empty
   coordinate is therefore not one bad row — it is a cross-component MERGE: every component in the
   org carrying that placeholder collapses onto ONE line, one team's subscription silently governs
   another's, and a bump dispatched for it fans out across components that never declared it.
2. **`registry: ""` is the DEFAULT registry, not a registry named empty.** It is the standard
   placeholder a chart ships so `global.imageRegistry` can override it — the common case, not an
   edge. Joined it yields `/acme/api`, so the same image sits on two different lines depending on
   whether a values file happened to spell the registry. Empty is treated as absent; a non-empty
   registry that is not repository-shaped is reported rather than joined.
3. **A `digest:` must BE a digest** — `algorithm:hex`, at the registered length for sha256/sha512.
   `resolved_digest` is what the version poller compares a registry's answer against, so
   `sha256:feedface` is a row that reads as identity-pinned and can never match. **Fixed in both
   image parsers**: `parseDockerfile` had the identical hole on `FROM …@…`, and fixing one would
   have been the incomplete-census failure. A bad `digest:` beside a good tag does not lose the
   declaration — the digest is refused and reported, and the tag-pinned row survives without it.

**Two things the round measured rather than reasoned about.** `yaml`'s duplicate-key check rescans
every sibling already composed for each new pair, which is **quadratic in siblings-per-mapping** — a
flat 32 000-key mapping composes in 7.1 s with it on and 0.18 s with it off, and this call is in the
ingestion path behind a 1 MiB read cap. The parser header claimed the work was "linear in the bytes
the read cap already bounds"; it was not. The check is off (`uniqueKeys: false`) and the five image
keys carry their own duplicate report, because Helm's Go YAML takes the LAST duplicate where a scan
takes the first. Separately, `yaml` composes an empty document (`---`) as a Scalar node holding null
rather than as `contents: null`, so T8's "no mapping at any root" refusal caught it and the manifest
was stamped `unreadable` — "this attempt failed and the next may not" — about a file that fails
identically forever. An empty document is an honest empty: `ok / 0 rows`.

---

## 3. KUBERNETES MANIFESTS — recommendation: out of scope, and not because of the shapes

`spec.template.spec.containers[].image` is the **easiest** shape in this whole document: it is shape A,
a single scalar carrying `repo:tag`, on one line, with the coordinate and the version adjacent — the
only shape the existing bump verifier can already handle unchanged.

They are out of scope because they are **unaddressable**. `deployment.yaml`, `api.yaml`,
`k8s/web-deploy.yaml` are arbitrary names, there is no enumeration verb (§1.1), and a bounded
convention list (`k8s/deployment.yaml`, `manifests/deployment.yaml`, …) would find a minority, burn the
read budget, and report the rest as `not_found` — which is *positive evidence of absence* and prunes
(`inventory-ingestion.ts:855–861`). Guessing paths in a system whose prune rule is "a `not_found` on
the path is evidence the file is gone" is worse than not guessing.

Two consequences for how the parser is written now:

- **Write it path-agnostic and shape-complete from day one.** One `parseKubernetesImages(content)` that
  walks a parsed YAML document for *both* conventions — the Helm-values shapes of §2 **and** the
  pod-spec shapes: `spec.template.spec.containers[]`, `initContainers[]`, `ephemeralContainers[]`,
  a pod spec at the document root, and CronJob's `spec.jobTemplate.spec.template.spec.containers[]`.
  Registration in `MANIFEST_PARSERS` is then the only thing gating them, so turning k8s manifests on
  later is one map line plus an addressability answer, not parser work.
- **`kustomization.yaml` is the one exact-basename k8s win** (its `images: [{name, newTag}]` block is
  bounded and resolvable). Named here as the obvious second basename, deliberately **not** taken this
  round: each basename is a multiplier on a 40-read budget (§1.1) and one new filename at a time is the
  measurable way to do it.
- **`templates/*.yaml` is out, permanently.** A chart's rendered output is not in the repo, and Go
  template control blocks (`{{- if … }}`) make the file *not YAML at all*. It is not reachable by the
  prefix derivation today (a `chart/**` pattern yields the prefix `chart`, not `chart/templates`), and
  it should stay that way: a permanent parse failure would be stamped `unreadable` ("may succeed on
  the next pass"), which is the wrong operator action.

Many repos do have both a chart and raw manifests. That is fine and is not double-counting: two
manifest paths declaring the same line are two `component_dependencies` rows by the primary key, and
`bump-dispatch` already iterates **per declaration**, so each gets its own bump. See §6 Q4 — two PRs
for one logical bump is an owner question, not a bug.

---

## 4. THE TRAPS

In the spirit of `dockerfile.ts`'s header. Each names a behaviour, not a caveat.

**T1 — YAML coerces the version away, and this is the one that silently corrupts an edit target.**
`tag: 1.2` parses to the number `1.2`; `tag: 1.20` parses to `1.2`; `tag: 3.10` to `3.1`. The declared
text is not decoration — `component_dependencies.declared_version` is "the exact string the M21.5
actuator has to edit; a normalised copy would be an edit target that does not appear in the file"
(`schema.ts:1885–1888`). **Behaviour: never read a version through the node's JS value. Read the
scalar's own source text** (`Scalar.source` / the node range). A `tag` node whose source cannot be
recovered is shape H, not a guess. This trap is on its own the strongest argument in §5.

**T2 — Templated values are not resolvable from the file.** `tag: "{{ .Chart.AppVersion }}"`,
`repository: "{{ .Values.global.registry }}/api"`. Reported `unresolved` (shape F), never resolved.
This is `dockerfile.ts` trap 3 — `ARG` interpolation — with different syntax and the same rule:
"resolving it would produce a confidently wrong version". `.Chart.AppVersion` in particular tracks the
*chart's* version, not the dependency's, so resolving it would be wrong even if we could.

**T3 — `latest`, `stable`, `edge`, date stamps and shas are not orderable.** Handled by the shared
`parseComparableVersion`, which yields `undefined` for them — carried, no line row, reported. And
precision-1 tags (`20240115`, `1a2b3c4d`) get `dockerfile.ts:296–306`'s note verbatim in substance: a
registry cannot tell a date stamp from a major line, so they must not be ordered.

**T4 — A bare `image: acme/api` with no tag is `unpinned`, NOT `latest`.** Kubernetes' implicit
`:latest` is a resolution rule; writing "latest" into `declared` invents text the author never wrote
(`dockerfile.ts` trap 4, `types.ts:66–69`).

**T5 — Digest pins.** `digest: sha256:…` with or without a tag. Both are carried and neither is derived
from the other; digest-only has no comparable version. Only the key literally spelled `digest` is read
— a chart spelling it `sha` or `imageDigest` is not guessed at.

**T6 — A values file for a chart the org CONSUMES vs its own chart.** Both are read, and the parser
does **not** branch on which it is. Branching would be a label named after which condition matched
(charter principle 6) and would be wrong for umbrella charts, where both are true at once. The package's
own contract covers it: "this package reports the declaration, not the consequence"
(`dockerfile.ts:35–36`). **Stated residue:** an override key that the consumed chart does not actually
read is a declaration SCP will faithfully record and (once bumpable) faithfully bump, changing nothing
deployed. Mitigation is explainability, not cleverness — `declaredIn` carries the **dotted key path**
(`postgresql.image.tag`), so a Decision names exactly which key was read.

**T7 — Multi-document YAML.** `---`-separated documents are ordinary in this file class. Parse **all**
documents; a document that is not a mapping is skipped rather than fatal, provided at least one is.
Entries carry the document index in `declaredIn` so two same-named keys in two documents are
distinguishable in a Decision.

**T8 — Unreadable must not collapse into empty, and YAML makes that harder than JSON.** `parseGoMod`
and `parsePackageJson` throw on `<!doctype html><title>404</title>` because it is not their grammar.
**It is valid YAML** — a plain scalar string — so a naive YAML parser returns "zero images" for a 404
body and the next ingestion pass **prunes the component's whole image inventory**. This is
`ManifestParseError`'s stated reason for existing (`types.ts:155–171`) and `parse-contract.test.ts`'s
whole subject. **Behaviour: the root of at least one document must be a mapping** (or the document
must be null/empty); a non-null scalar or sequence root throws `ManifestParseError`. And **the empty
string throws**, joining the five throwers in `parse-contract.test.ts` rather than the one negative
control. Cost, stated: a genuinely zero-byte `values.yaml` is reported `unreadable` rather than
`ok / 0`. That is a false alarm in the safe direction — it does not prune.

**T9 — The same image twice in one file collapses to one row, and its bump is correctly ambiguous.**
The primary key is `(org, component, line, manifest_path)` (`schema.ts:1920–1923`), so a Deployment and
a CronJob pinning `acme/api:1.2.3` in the same file are ONE row. `applyManifestBump` then finds two
candidate lines and returns `undefined` (`bump-edit.ts:337–339`) — the right answer, since editing one
would leave two versions of one image in one manifest. **Behaviour: the ambiguity must be reported at
ingestion (the entry carries how many occurrences fed it), not discovered as a mystery refusal
months later.**

**T10 — Anchors, aliases and merge keys.** `<<: *defaults` and `tag: *appVersion` are ordinary in
values files. The value's **edit site is not its read site**, and one edit to the anchor moves every
alias — which the single-changed-line verifier would see as one line changed and several declarations
silently moved. **Behaviour: a value reached through an alias or a merge key is `unresolved`** (shape
G). Related: cap alias expansion (the `yaml` reader's `maxAliasCount`) so a billion-laughs file cannot
turn a 4 MB read (`HARD_MAX_FILE_BYTES`, `git-provider-core/src/read-file.ts:169`) into unbounded work.

**T11 — `image` is matched as an exact key, never as a substring.** `imagePullSecrets`,
`imagePullPolicy`, `initImage`, `imageCredentials` are not images. A key matched by "contains `image`"
is a label named after what happened to match — the exact failure this repo has shipped once
(ADR-0030 §2).

**T12 — The prune blast radius is larger here than for a Dockerfile.** One values file can be the sole
declaration site for a dozen images, so a mis-parse that returns `[]` unsubscribes a dozen lines in one
pass. That is why T8's root-mapping rule is a throw and not a skip.

---

## 5. IS THERE A YAML PARSER AVAILABLE OFFLINE?

**Yes — `yaml@2.9.0`, already in the workspace.** Recommendation: **take it**, as a dependency of
`packages/dependency-manifests`, and pay the stated cost consciously.

**What is already true.** `tools/helm-verify/package.json` and `deploy/airgap/package.json` both declare
`"yaml": "^2.9.0"` as a runtime `dependencies` entry, and the lockfile resolves it once:
`pnpm-lock.yaml` line 8738 reads `yaml@2.9.0: {}` — **no transitive dependencies at all**. So the
offline install set does not grow by a single package, nothing new is fetched at build or run time, and
charter principle 5 (vendored tooling, no network calls) is untouched. This is not a new supply-chain
entry; it is a second consumer of one already inside the air-gap bundle's own build tool.

**What it costs, and this is the real trade.** `packages/dependency-manifests` has **no `dependencies`
block whatsoever**, and that is deliberate and stated twice:

- `types.ts:13–18` — *"Keeping the parsers dependency-free also keeps them trivially usable from a
  runner image (charter principle 5 …), so this package pulls in no third-party TOML or XML library and
  hand-rolls the small subsets it needs."*
- `toml-lite.ts:1–27` — *"this package deliberately has zero third-party dependencies so it can be
  dropped into an ephemeral runner image without dragging a resolver behind it."*

That property is not abstract: `packages/plugins/managed-dep/src/write-guard.ts` imports these parsers,
and that package ships into the `scp-runner-dep` image — the isolated, `--network none`, charter-gated
container. Adding `yaml` puts a third-party package into that image's supply chain for the first time.
**The zero-dependency property of this package is spent, once, and should be recorded as spent.**

**Why not hand-roll a `yaml-lite`, the way `toml-lite.ts` was hand-rolled.** Because it is not the same
trade, and `toml-lite.ts`'s own header explains why in advance. It is 353 lines for six table lookups,
and its stated justification is that a line-oriented scanner "would mistake a `[Programming Language ::
…]` classifier entry for a TABLE HEADER… That is a silent wrong-answer bug, not a missing-feature bug."
YAML's equivalent surface is much larger — significant indentation, block and flow collections, five
scalar styles, anchors/aliases/merge keys, multi-document streams, tag resolution — and **indentation
is precisely the part where a partial implementation returns a confidently wrong tree rather than an
error**. Combined with T12 (one mis-parse unsubscribes a dozen lines), a hand-rolled YAML subset is a
silent-wrong-answer machine pointed at the prune path.

There is also a capability argument that settles it independently of size: **T1 requires the verbatim
source text of a scalar, and T7/T10 require document and alias structure.** `yaml@2` exposes both
(`Scalar.source`, node ranges, `parseAllDocuments`, `maxAliasCount`); `JSON.parse`-shaped access does
not, and a hand-rolled reader would have to reimplement source-range tracking correctly to be usable at
all.

**Rejected alternatives, briefly.** (a) `JSON.parse` on YAML — YAML is not a JSON superset in the ways
that matter here and this loses T1 outright. (b) A regex line scanner for `tag:`/`repository:` — cannot
tell nesting from siblings, so it would pair a `tag` with the wrong `repository`; that is a wrong bump,
which the whole feature's design ranks as worse than a missing one (`dockerfile.ts:209–214`). (c) Put
the YAML parser in a separate package so the runner does not take it — the runner **does** need it:
`verifyManifestOnlyEdit` re-parses both sides with the same parser to prove the declaration set is
unchanged (`write-guard.ts:48–51`).

**Build-round checks this dependency must pass** (not assumed here): its license recorded in whatever
inventory the air-gap bundle keeps, and the `scp-runner-dep` image rebuild confirmed to still resolve
offline.

---

## 6. Decision points for the owner

**Q1 — Is `values.yaml` alone the right round-one file set,** with `charts/<name>/values.yaml` reachable
only via an explicit `source_mappings` path (§1.4), and `kustomization.yaml` deferred (§3)?
*Recommended: yes.*

**Q2 — Should the bump verifier be widened this round so `{repository, tag}` values are actually
bumped (§2.4), or is round one visibility + a legible dispatch refusal?** This is the one that decides
whether the owner's own deployments get bumps or only get seen. Widening touches a charter-enforcement
surface. *Recommended: visibility this round; widening as its own round with its own gate.*
**ANSWERED — visibility shipped in M21.7; the widening round's design is
[split-shape-image-bumps.md](split-shape-image-bumps.md) (2026-08-17, proposed, not built).**

**Q3 — Does `Chart.yaml` (subchart `dependencies[].version`) become a sixth ecosystem later?** It needs
a new `DependencyEcosystemSchema` member, a DB check-constraint value, and a Helm-repository version
index. *Recommended: not now; record the question.*

**Q4 — A component that pins the same image in both its `Dockerfile` and its `values.yaml` gets TWO
bump changes and therefore two PRs,** because `bump-dispatch` iterates per declaration. Is that the
wanted behaviour, or should one line's bump be one change spanning several manifests?

**Q5 — Should the class fix in §2.3(2) ship in this round?** It corrects `ok / 0 rows` on existing
Dockerfile and Maven manifests whose declarations are all unresolved — i.e. it changes what already-
deployed estates report about files that have nothing to do with YAML. *Recommended: yes — it is the
same defect, and fixing only the YAML instance is the incomplete-census failure this repo has shipped
before.*

---

## 7. Build-round work items (for the round that follows sign-off)

Each needs its own named test and a mutation that kills it; none of it is written yet.

1. `packages/dependency-manifests/src/kubernetes-images.ts` — the parser, path-agnostic and
   shape-complete (§2, §3), with a header in `dockerfile.ts`'s style naming T1–T12.
2. `packages/dependency-manifests/package.json` — `yaml@^2.9.0`, and the zero-dependency claims in
   `types.ts:13–18` and `toml-lite.ts:1–27` amended to say the property was spent and on what.
3. `parse-contract.test.ts` — the new parser joins the throwers (T8), with the HTML-404 body as its
   fixture *because it is valid YAML*, and a comments-only values file as the negative control.
4. `MANIFEST_PARSERS` — one entry, `values.yaml`. `inventory-ingestion.test.ts:36`'s pinned key list and
   the cross-product assertions at `:228, :251` move with it. Re-derive `MAX_MANIFEST_READS` against the
   new cross-product rather than leaving 40 unexamined.
5. `SkippedDeclaration.reason` — the second member, selected structurally from `constraint` (§2.3(1)).
6. `projectIngestionStamp` / `IngestedManifest` — the all-unresolved manifest stamps `unsupported`
   (§2.3(2)). This is the class fix, so its test must cover a **Dockerfile** as well as a values file.
7. `bump-dispatch.ts` — the pre-dispatch refusal for a manifest this build cannot edit (§2.4), so no
   runner is dispatched to produce a diff the verifier will reject as `wrong_declaration_changed`.
8. `packages/dependency-manifests/src/dockerfile.ts:31–33` — the "not deployment manifests" comment is
   now false. Correct it and point at this document (§0).
9. `docs/adr/0032-dependency-subscriptions.md` — a new clause recording the amended scope and Q1/Q2's
   answers.
