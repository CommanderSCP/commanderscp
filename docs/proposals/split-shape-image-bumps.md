# Split-shape image bumps — making `image: {repository, tag}` editable without making the verifier a parser

**Status:** **BUILT (2026-08-17), M21.7.** Proposed and built the same day; D1–D5 were all adopted as
recommended. The rule, the derivation, the runner operands, the allowlist opening and the PR-only
delivery are in the tree, and the clause recording them is
[ADR-0032 §8g](../adr/0032-dependency-subscriptions.md). §10 below marks what landed.
**Owner ask:** split-shape Helm image declarations must be BUMPABLE, not merely detected.
`image: {repository, tag}` is the most common Helm convention; today SCP can see that a newer version
exists and cannot apply it.
**Answers:** [kubernetes-image-references.md §6 Q2](kubernetes-image-references.md) — *"Should the bump
verifier be widened this round so `{repository, tag}` values are actually bumped, or is round one
visibility + a legible dispatch refusal?"* — which recommended visibility, and deferred the widening to
"its own round with its own gate". This is that round's design.
**Relates to:** [ADR-0032](../adr/0032-dependency-subscriptions.md) §8–§8f (the actuator), §9 (the
descriptor is not content); PROJECT_CHARTER.md `scp-managed-dep` (2026-08-13, qualified 2026-08-15).

**Why a new file rather than a new § in `kubernetes-image-references.md`.** That document is marked
BUILT and is the derivation behind ADR-0032 §4b; appending a fresh design to settled text hides which
parts shipped. Same reasoning its own §0 gives for existing separately from
`dependency-subscriptions.md`. A one-line pointer is added at its Q2 so a reader of the deferral finds
the round that took it.

---

## 0. What the problem is, and what it is not

**It is not a charter problem.** The `scp-managed-dep` amendment permits "editing the declared version
of an already-declared dependency in a manifest the component already contains", and
`tag: 1.2.3 -> 1.2.4` in a chart's own `values.yaml` is exactly that: the manifest exists, the
dependency is already declared in it, and only its version moves. No amendment is proposed and none is
needed.

**It is a decidability problem in one module.** `packages/plugins/managed-dep/src/bump-edit.ts` is a
refusal, not a helper (its header, lines 12–28): it enforces charter prohibitions 1 and 2 as properties
of the BYTES, because a runner image rebuilt wrong or mis-parsing a grammar can return a diff the
charter does not permit and every layer above would have no way to tell. Its rule has four clauses:

| # | Clause | Code |
|---|---|---|
| 1 | the file has the SAME number of lines | `bump-edit.ts:185` |
| 2 | exactly ONE line differs | `bump-edit.ts:197` |
| 3 | **that line names the coordinate** | `bump-edit.ts:217` |
| 4 | replacing the from-token with the to-token in the BEFORE line reproduces AFTER **exactly** | `bump-edit.ts:232` |

Clause 3 is the one a split shape cannot satisfy: the changed line is `  tag: 1.2.3` and the coordinate
`acme/api` is on a different line. For `{registry, repository, tag}` it is worse — the coordinate is a
CONSTRUCTION (`kubernetes-images.ts:705`, `${registryText}/${repository.text}`) and appears nowhere
contiguously, so even the file-level clause at `bump-edit.ts:168`
(`before.includes(spec.coordinate)` → `coordinate_not_declared`) is false.

So the question this document answers is: **what may replace clause 3 without turning the verifier into
a second implementation of the editor** — the drift its own header names as the thing to avoid.

**One shape is already bumpable and it is worth knowing why**, because it locates the gap precisely.
The flow-mapping spelling `image: {repository: acme/api, tag: 1.2.3}` puts the coordinate and the
version on ONE physical line, so today's rule handles it unchanged. The gap is a *spelling* gap, not a
*shape* gap: the same declaration, block-styled over three lines, is refused.

---

## 1. How the runner finds the line today

`apps/runner-dep/run.sh` is a BusyBox `sh` shim with one non-trivial step, the awk program at lines
126–152. Read precisely:

```awk
BEGIN { coordinate = ARGV[1]; from = ARGV[2]; to = ARGV[3];
        ARGV[1] = ""; ARGV[2] = ""; ARGV[3] = ""; candidates = 0; }
{ lines[NR] = $0;
  if (index($0, coordinate) > 0 && index($0, from) > 0) { candidates++; target = NR; } }
END { if (candidates != 1) { … exit 3; }
      at = index(lines[target], from);
      lines[target] = substr(lines[target], 1, at - 1) to substr(lines[target], at + length(from));
      for (i = 1; i <= NR; i++) printf("%s\n", lines[i]); }
```

**What it keys on, precisely:** the conjunction of TWO substrings occurring on ONE physical line —
`index($0, coordinate) > 0 && index($0, from) > 0` (`run.sh:134`). The selector is **content-addressed
and position-blind**: the line's number is recorded (`target = NR`) only after the content test picked
it, and is never an input. Exactly one line must satisfy the conjunction; zero means the manifest
disagrees with the inventory, more than one means the target is ambiguous, and both are refusals
(`run.sh:144`, exit 3).

Three properties of the surrounding shim matter to any change here:

- **The three tenant strings are awk OPERANDS, not `-v` assignments** (`run.sh:117–120` comment): `-v`
  processes escape sequences, so a coordinate or version containing a backslash would arrive as
  something other than what the manifest holds. They are read in `BEGIN` and blanked so awk does not
  then treat them as input filenames. Blanking in `BEGIN` also immunises them against awk's
  `name=value` operand-assignment rule, because operand processing happens after `BEGIN` runs.
- **Matching and replacement are `index()`/`substr()`, never regex and never `sub()`** — a coordinate
  (`@acme/lib`, `com.acme:lib`) and a declared version (`^1.2.3`, `3.18-alpine`) are arbitrary tenant
  text, and treating either as a pattern is how a `.` silently matches a line the bump was never about.
- **The input's trailing-newline byte shape is measured before the edit and restored after it**
  (`run.sh:105–115`, `tail -c 1` / `wc -c` / `head -c`), because awk always terminates its last record
  with a newline and a gained or lost trailing newline is a LINE-COUNT change the verifier refuses
  outright as `line_count_changed`.
- **`$1` (ecosystem) is validated and deliberately not branched on** (`run.sh:93–98`), and `$2`
  (manifest path) is never opened — the subject is always `/work/in/manifest`.

**The reference edit the runner must agree with** is `applyManifestBump`
(`bump-edit.ts:330–345`) and it is the same rule in TypeScript: collect every line index where
`line.includes(coordinate) && line.includes(fromVersion)`; `if (candidates.length !== 1) return
undefined` (`:340`); otherwise `replaceFirst` on that one line. `runner-shim.test.ts` runs the real
`run.sh` and this function over the same fixtures and requires identical bytes, so the two cannot drift
silently.

---

## 2. What can bind a changed line to the right declaration when the coordinate is not on it

### 2.1 An anchor supplied by the parser, expressed as a dotted key path (`controller.image.tag`)

The parser already computes it — `DeclaredDependency.declaredIn` for this parser is the version node's
dotted key path (`kubernetes-images.ts:892`, `declaredIn: first.keyPath`).

**Rejected in this form.** To *use* a key path as the anchor, the verifier must resolve it — walk a YAML
document to the scalar at `controller.image.tag` and check the changed line is that scalar's line. That
is the verifier understanding YAML structure, which is precisely what `bump-edit.ts:24–28` warns
against, and it would need the same resolution inside the runner (§4), which has no parser and no
language runtime to host one. **The key path is the right piece of evidence and the wrong shape of
anchor.**

### 2.2 A line-number anchor captured at ingestion

**Rejected, and it is worse than the brief suggests.** `component_dependencies` has no line column at
all (`apps/server/src/db/schema.ts:1868–1918` — `manifest_path`, `declared_version`,
`resolved_version`, `resolved_digest`, `observed_repo`, `observed_ref`, `observed_at`), so this option
starts with a migration. And it would store a number derived from a read at one ref and spend it
against a read at another: ingestion runs on its own schedule, the actuator reads the manifest fresh
at `descriptor.baseBranch` (`index.ts:813`). A stale line number is a *confidently wrong edit*, which is
the failure mode the whole module exists to prevent.

### 2.3 A neighbourhood rule — "the changed line is in the same mapping as a line naming the coordinate"

**Rejected as the rule.** "Same mapping" is a structural claim about YAML expressed textually through
indentation, and indentation-based reasoning is not decidable without a parser:

- **Block scalars.** Inside `notes: |`, a line reading `  tag: 1.2.3` is *text*, not a key. Nothing
  about its indentation distinguishes it from a real key; only knowing the enclosing node's style does.
- **Sequence items.** `- repository: acme/api` and `  tag: 1.2.3` are siblings in one mapping at
  *different* leading-space counts, so "same indentation" is wrong; and the following `- name: other`
  is a *different* mapping at the same indentation, so "same indentation" is also insufficient.
- **Flow mappings.** `{repository: a, tag: b}` has no indentation to reason about at all.
- **Anchors and merge keys.** `<<: *defaults` brings keys into a mapping that are not written in it, so
  a coordinate can be "in the same mapping" and nowhere near the line — the parser reports these
  `unresolved` for exactly this reason (`kubernetes-images.ts` trap 10), but a textual neighbourhood
  rule would not know it was looking at one.

A rule that is right for well-formatted values files and wrong for four ordinary YAML constructs is the
provenance-label failure — a rule named after the shape that happened to match.

### 2.4 Rejected outright: the orchestrator sends finished bytes, or the runner gets a YAML parser

The first deletes the containment precondition (the isolated runner would become decorative and the
orchestrator would be authoring repository content, which `bump-edit.ts:53–58` explicitly refuses). The
second contradicts the image (§4): `scratch` + one BusyBox binary + seven applet names, no runtime.

### 2.5 Recommended: **the parsed line anchor, admitted only if that line carries the declared version — and the coordinate rule keeps a veto**

The insight is that clause 3 is not the only thing binding a changed line to a coordinate, and it is
not even the strongest thing. **The two verifiers already partition the property**, and the second one
is structural:

`verifyManifestOnlyEdit` (`write-guard.ts:756`) re-parses BOTH sides with the registered parser and
- **gate 5** (`:818`) requires the declaration sets to be identical element-for-element on
  `coordinate`, `scope`, `declaredIn` and `line`, positionally — which also refuses a reorder;
- **gate 6** (`:873`) requires that the one declaration whose version moved has
  `coordinate === the subscribed coordinate` (`coordinate_not_expected`), with an unchanged constraint
  kind;
- **gate 7** (`:902`, `assertChangeConfinedToVersionText` at `:966`) measures the whole-file differing
  span between the longest common prefix and suffix and requires it to lie *inside the parsed
  declaration's own version text* on both sides.

None of those three needs the coordinate to be on the changed line. They bind the change to the right
declaration through the PARSE, they mint the HMAC proof without which nothing can be written
(`index.ts:868`, `repo-write.ts:192–203`), and **they already work for split shapes today** — they are
simply unreachable, because `verifyManifestBump` refuses first (`index.ts:855`) and
`manifestParserFor` has no `values.yaml` entry (`write-guard.ts:429–467`).

So the recommendation does not invent a binding. It supplies the one missing piece — *which line* — as
descriptor data derived from the same parse, and keeps every textual clause that can still be checked.

---

## 3. The recommended rule

### 3.1 The anchor, and where it comes from

`ManifestBumpSpec` gains an optional field:

```ts
/** The line the bump must edit, when the coordinate is not on it. DERIVED, never transported. */
anchor?: { readonly line: number; /** 1-based */ readonly text: string };
```

It is **plugin-internal**. `ManifestBumpSpec` is constructed inside the orchestrator by
`parseBumpDescriptor` from the intent parameters (`index.ts:278–287`), and the anchor is derived from
bytes the plugin has already fetched. `buildBumpIntentParameters`
(`apps/server/src/dependencies/bump-actuator.ts:591–615`) does not change, so there is **no wire schema
change, no `pnpm gen`, no oasdiff exposure, and no migration**.

**Derivation** — a new `locateVersionLine(before, spec)` beside `manifestParserFor` in `write-guard.ts`,
because that file already owns the per-format table and already parses both sides:

1. `parser = manifestParserFor(spec.ecosystem, spec.manifestPath)` — the same allowlist entry the
   verifier will use, so an unlisted basename never reaches step 2.
2. `candidates = parser(before).filter(d => d.coordinate === spec.coordinate && d.declared === spec.fromVersion)`.
3. `candidates.length === 1`, else **no anchor**.
4. The candidate carries `line`, and `before.split("\n")[line - 1]` **contains `spec.fromVersion`**,
   else **no anchor**.
5. The candidate is not a merged multi-site declaration (§7, and the `occurrences` field in §9 D3),
   else **no anchor**.

Step 4 is what makes the derivation self-selecting and format-agnostic: `pom-xml.ts` records the line
of the `<dependency>` OPEN TAG while the version sits several lines below it (`write-guard.ts` says so
and is the reason gate 5's line check is scoped the way it is), so a Maven declaration never yields an
anchor and Maven's path never changes. **The anchor exists exactly where it is honest.**

> **CORRECTED 2026-08-17.** This paragraph said step 4 "keeps the four working ecosystems untouched *by
> construction*", and that was false of three of them — the claim generalised Maven's behaviour to
> everything that was not the new shape. Measured: an anchor **is** derived for `go` (go.mod),
> `python`'s `requirements*.txt` and `oci`'s Dockerfile, whose parsers report the line the version is
> written on. Only `npm` and `pyproject.toml` (which report no `line` at all) and `maven` (which
> reports the wrong one) yield none.
>
> What keeps the anchored three unchanged is **§3.2's clause (c)**, not the absence of an anchor. Those
> parsers take the coordinate verbatim off the same line as the version, so the anchor line names the
> coordinate too — it is therefore a candidate of the coordinate rule itself, and the veto admits it
> only when it is the sole candidate (the unanchored rule's own condition) and refuses when there are
> several (the unanchored rule's own refusal). Both paths select the same line and emit the same bytes,
> which `runner-shim.test.ts` proves by running both. The anchor can never redirect an edit for them,
> because a line naming the coordinate is never a line the coordinate rule is silent about, and silence
> is the only gap an anchor fills. The per-ecosystem map is now an enumerated test rather than prose.

### 3.2 The rule the runner and the verifier both apply

> **THE ANCHOR SELECTS; THE COORDINATE RULE KEEPS A VETO.**
> The target is the anchor line. The edit is refused unless
> **(a)** the file's line at the anchor index equals the anchor text byte-for-byte,
> **(b)** that line contains `fromVersion`, and
> **(c)** the set of lines naming BOTH the coordinate and `fromVersion` is either **empty** or
> **exactly {the anchor line}**.
> With no anchor supplied, today's rule runs unchanged.

Clause (c) is the load-bearing one for safety. It means the anchored mode is **a widening only where
the textual rule was silent**: whenever any line does name both, the anchor must agree with it, and a
disagreement or an ambiguity reproduces today's refusal exactly. Nothing that works today gets weaker,
and every refusal that fires today still fires.

Clause (a) makes the anchor **compared, never emitted**. The output line is always built from the
file's own bytes by `substr`; the anchor text is only ever an equality test, so it cannot smuggle
content into the repository even if the descriptor were wrong.

`verifyManifestBump` then becomes, in the anchored branch: clause 1 and 2 unchanged; clause 3 replaced
by (a)+(b)+(c) above with `changed[0] === anchor.line - 1`; clause 4 unchanged; and the file-level
`before.includes(spec.coordinate)` guard at `:168` replaced by the anchor checks, because a constructed
coordinate is legitimately absent from the text (§8). Two new refusal reasons —
`anchor_line_not_changed` and `anchor_text_mismatch` — plus `coordinate_rule_disagrees` for (c).

---

## 4. What is preserved, what is given up, and the residual risk

**The property that must survive:** *the right declaration was touched, and only its version token
changed.*

**Preserved in full, for every ecosystem and shape that works today.** The veto (c) reproduces the
current selector's verdict wherever the current selector has one. Clauses 1, 2 and 4 are untouched, so
"only its version token changed" is still a byte-for-byte reconstruction and still refuses a line that
also gained a flag or a second declaration.

**Preserved, structurally, for split shapes:** "the right declaration" is proved by
`verifyManifestOnlyEdit` gates 5–7 on the returned bytes, before the proof is minted and therefore
before anything can be written. Gate 6 is genuinely independent of the anchor derivation: it asks a
different question (which parsed declaration's version moved?) of different bytes (the AFTER file). If
the derivation picked the wrong declaration's line, the runner edits that declaration, and gate 6
refuses `coordinate_not_expected`. **A wrong SELECTION is caught.**

**Given up, and only here:** for a declaration where *no line names the coordinate at all*, the
line→coordinate binding is no longer parser-independent. It rests on
`parseKubernetesImages`'s association of a `tag` scalar with its sibling `repository` — and gate 6,
though independent of the *derivation*, uses the *same parser*, so a wrong ASSOCIATION is common-mode
and is not caught. Nothing gives that up that has it today: these declarations are refused outright
today, so the comparison is "refused" versus "bumped under a parser-associativity assumption", never
"strong guarantee" versus "weak one".

**Residual risk, named:** a `parseKubernetesImages` bug that pairs a `tag` with the wrong `repository`
produces a correct-looking bump of the wrong image's version *within the same file*. Blast radius is one
values file in the component's own repository; gate 7 still confines the change to a version text, so it
cannot become an arbitrary edit. Three mitigations, in order of cheapness:

1. The association is a pure function of a string and is differentially testable: fixtures where every
   block has a *distinct* repository and a *distinct* tag, plus a mutation that swaps two siblings, kill
   a mis-association directly.
2. Every split-shape bump is delivered as a pull request, never auto-merged, in this round (§9 D2) — a
   human sees the diff and the PR body names the dotted key path the parse read.
3. The Decision already carries `declaredIn` (`postgresql.image.tag`), so "which key was read" is
   answerable from the record rather than by re-deriving it.

---

## 5. Does the verifier stay ecosystem-agnostic?

**Yes, and deliberately so: the widening is expressed as DESCRIPTOR DATA, not as a per-format arm.**
`bump-edit.ts` gains an optional field, three refusal reasons and one branch — *is an anchor present* —
and imports nothing new. It learns no YAML, no `oci` special case, and no notion of a key path. It
still cannot locate a declaration; it can only check the one it was told about, and check it against the
textual clauses it already had.

**Is `verifyJsonDeclarationSets` a precedent for a per-format branch, and does its reasoning transfer?**
It is a precedent for *a* branch — `if (spec.ecosystem === "npm")` at `bump-edit.ts:241` — and its
reasoning transfers **only in part**, which is why the design is shaped this way:

| | `verifyJsonDeclarationSets` | A hypothetical `if (ecosystem === "oci" && yaml)` locator |
|---|---|---|
| Direction | **Narrows** — an additional refusal on top of the textual verdict | **Widens** — admits an edit the textual rule refuses |
| Dependency | `JSON.parse`, a language built-in | a third-party YAML parser inside the refusal module |
| Role | asks "was a dependency added or removed?" | *chooses the edit target* |
| Failure mode | a bug makes it refuse a valid bump | a bug makes it accept a wrong one |

The transferable rule is: **a per-format branch is acceptable when it can only refuse more.** A branch
that widens, or that locates, is not the same thing, and putting one in `bump-edit.ts` is exactly the
"second implementation of the editor" its header names. The structural knowledge therefore stays in
`write-guard.ts`, which already holds the format table (`MANIFEST_MATCHERS`, `:429`) and already runs
both parses — one parser table, one place, no second copy to drift.

`write-guard.ts` does gain a `values.yaml` → `parseKubernetesImages` entry for `oci`, and
`manifestIsEditableInThisBuild` (`bump-actuator.ts:65`) gains the matching basename. Those two restate
one closed set and `bump-dispatch.test.ts` already pins them against each other including on what each
one refuses; that test must move with them.

---

## 6. What the runner needs — checked against the image, not assumed

`apps/runner-dep/Dockerfile` builds a `scratch` image containing one static BusyBox binary and exactly
seven applet symlinks (`:121–133`): `sh awk tail wc head rm mv`. The count is asserted at build time
(`entries -eq 8`) and again against the built artifact by `runner-image.integration.test.ts`. Launch is
`--network none` with no environment and no mount.

**What the recommended rule needs:** an integer comparison against `NR`, a string equality test, and
`index()`/`substr()` — all POSIX awk, all already used. **No eighth applet, no new binary, no parser.**
The build-time count assertion and the integration test's applet list are untouched. This is the second
reason §2.1 is rejected: a key-path anchor would need a YAML reader here, and the image has no runtime
to host one — that is a finding about the design, not a detail of it.

**How the anchor arrives:** two more argv operands (`$6` = anchor line number, `$7` = anchor text),
read and blanked in `BEGIN` exactly as `ARGV[1..3]` are — same verbatim-text reason (no `-v` escape
processing) and same immunity to awk's `name=value` operand rule. The line number is forced numeric
with `+ 0`. The trailing-newline restoration is unchanged.

**Version skew is fail-closed in both directions, and that must be stated in the shim:**

| | new orchestrator (7 operands) | old orchestrator (5 operands) |
|---|---|---|
| **old image** | ignores `$6`/`$7`, runs the coordinate rule → identical bytes for contiguous shapes; **exit 3 (refusal)** for split shapes | unchanged |
| **new image** | anchored rule | anchor absent → today's rule, unchanged |

The shim must therefore treat a missing `$6` as *not supplied*, never as line 0 — an unset positional
defaulting to `0` would select nothing and `${6:-}` guards it the same way the five existing arguments
are guarded (`run.sh:61–65`).

---

## 7. The multi-match hazard

**The version token's multiplicity never enters the selector.** Today's rule searches for a token;
the anchored rule addresses a line by number. That is the whole answer, and the adversarial case shows
it:

```yaml
# charts/api/values.yaml
global:
  imageTag: 1.2.3                 # not an `image` key — trap 11, never read
api:
  image:
    repository: acme/api          # line 6
    tag: 1.2.3                    # line 7   <- the target
worker:
  image:
    repository: acme/worker       # line 10
    tag: 1.2.3                    # line 11
appVersion: 1.2.3                 # line 12
podLabels:
  version: "1.2.3"                # line 14
```

Bump `acme/api` `1.2.3 -> 1.2.4`.

- **Today:** zero lines name both `acme/api` and `1.2.3`, so `candidates == 0` → exit 3. Safe, useless.
- **Anchored:** the parse yields two resolved declarations, `acme/api` at line 7 and `acme/worker` at
  line 11 (the parser records the *version* node's line, `kubernetes-images.ts:752`, `:893`). Exactly
  one matches `(coordinate, declared)`; line 7 contains `1.2.3`; the coordinate-rule set is empty, so
  the veto is satisfied. The runner edits line 7 by `NR`. Lines 11, 12 and 14 are never examined —
  they are not candidates, because there are no candidates, only an address.
- **The other four occurrences of `1.2.3` are irrelevant by construction**, which is a stronger
  statement than "we disambiguated them".

Three further adversarial cases:

- **Two declarations of the same coordinate at different versions** (`acme/api` at `1.2.3` and at
  `1.3.0`): step 2 filters on `declared === fromVersion`, so exactly one matches. The parser already
  flags the file as one where "a bump cannot be applied by matching the coordinate alone"
  (`kubernetes-images.ts:871`).
- **The same image pinned identically twice** (a Deployment and a CronJob at `acme/api:1.2.3`): the
  parser MERGES them into one declaration, because the inventory row merges (trap 9). Editing one line
  would leave the other behind. Step 5 must refuse this — and if it did not, gate 5 would: one
  declaration before the edit becomes two after it, `dependency_set_changed`. It is fail-closed either
  way, but refusing at derivation costs no container run and yields a legible reason. This is why §9 D3
  asks for the occurrence count as a NUMBER: today the fact exists only in a human-readable `note`, and
  a fact that only exists as prose cannot be a gate.
- **The token twice on the anchor line** (`tag: 1.2.3 # bumped from 1.2.3`): `replaceFirst` edits the
  first occurrence and clause 4's reconstruction reproduces the result exactly, so it is accepted with
  the stale comment intact. That is the author's text, unchanged — not a wrong edit.

---

## 8. Shape C — `{registry, repository, tag}`

**In scope, and it costs nothing extra.** The coordinate is a construction
(`kubernetes-images.ts:705`), the parser already records it and already states on the entry that it
"appears nowhere contiguously in this file" (`:712`). The anchored rule never asks for the coordinate to
appear anywhere in the text, so shape C is covered by the same mechanism as shape B, with one
consequence to be explicit about:

**The file-level clause `before.includes(spec.coordinate)` (`bump-edit.ts:168`) must be replaced in the
anchored branch, not merely supplemented.** It is *false* for shape C and would refuse every such bump
as `coordinate_not_declared`. The question it asks — does this file declare this coordinate? — is
answered instead by the derivation itself (step 2 found a parsed declaration with that exact
coordinate) and re-answered independently on the returned bytes by write-guard gate 6's
`baseDeps.some(dep => dep.coordinate === coordinate)` (`write-guard.ts:867`).

Deliberately excluding shape C would cost MORE code than including it: the verifier would have to
recognise that a coordinate containing a `/` might be constructed, which is a shape-specific inference
of exactly the kind this design avoids.

**What stays out of scope, explicitly, and is unchanged by this round:** digest-only pins (no comparable
version to move); values reached through a YAML alias or a `<<` merge key (reported `unresolved`, never
inventoried, therefore never bumped — trap 10); templated values (`{{ … }}`); a bare `tag:` with no
sibling repository (shape E — reported, no row, nothing to bump); `Chart.yaml` subchart versions (a
sixth ecosystem); and `kustomization.yaml`.

---

## 9. Decision points for the owner

**D1 — Adopt the anchored rule of §3?** The alternative is leaving split shapes visible-but-unbumpable,
which is where M21.7 left them. *Recommended: yes.*

**D2 — Are split-shape bumps PR-only this round, regardless of a subscription's `auto_merge`?** The
residual risk in §4 is a parser-association bug, and a human reading the diff is the cheapest control
for it. It is a one-line resolution in the delivery seam and it is reversible.
*Recommended: yes, PR-only for anchored bumps this round.*

**D3 — Add an occurrence COUNT to `DeclaredDependency`** (how many key paths fed a merged entry), so §7's
merged-declaration case is refused by a number rather than by matching a note's prose? The parser
already computes it (`kubernetes-images.ts:864`, `members.length`) and discards it into a sentence.
*Recommended: yes — it is a gate input that currently exists only as English.*

**D4 — `manifestIsEditableInThisBuild` opens for `values.yaml` wholesale.** The server has no file
content, so it cannot ask whether an anchor is derivable; it can only ask about the basename. The
consequence is that `manifest_not_editable_in_this_build` stops being the reason for values files and a
new plugin-side `anchor_not_derivable` refusal takes over the residue (a stale inventory row, a merged
multi-site declaration). *Recommended: yes, with the new named refusal so the reason still names its own
cause (ADR-0032 §7b clause 6).*

**D5 — Does the anchored path apply to `npm`, `go` and `oci`-Dockerfile too, or only where the coordinate
rule finds nothing?** §3.2's veto makes the question almost moot — the anchor must agree with the
coordinate rule wherever that rule speaks — but it decides whether those ecosystems' runner invocation
changes shape at all. *Recommended: derive the anchor whenever step 4 admits one (so the veto is a real,
exercised cross-check on the ecosystems that already worked, not dead code), and never make its absence
an error.* **DECIDED AS RECOMMENDED, and the measured consequence is in §3.1's correction note: `go`,
`requirements*.txt` and Dockerfile do take the anchored branch; `npm`, `pyproject.toml` and `maven` do
not.**

---

## 10. Build-round work items — ALL LANDED (2026-08-17)

Each has its own named test and a mutation that kills it; the mutations were run one at a time and
each killed a NAMED test, not just "something".

**Two things this round changed against the design, both narrowings, both stated:**

- **§3.1's derivation lives in `write-guard.ts` as written, but `coordinateRuleCandidates` was
  factored out of `bump-edit.ts` and is called by the orchestrator too.** The veto and the reference
  edit must consult the IDENTICAL set — a second, subtly different scan is how a veto comes to permit
  what the selector refuses — and D4's `anchor_not_derivable` needs to know whether that set is empty
  before it starts a container. It MEASURES; it never authors.
- **§3.2's clause (b) is not new code.** The existing `from_version_not_on_line` clause already
  measures the changed line, and the anchored branch has already proven the changed line IS the
  anchor line, so (b) is that clause unchanged rather than a fourth check. Stated because "three
  clauses replace clause 3" and "two new checks plus one existing one" are different diffs.

1. `packages/dependency-manifests/src/types.ts` — the occurrence count field (D3), with its contract
   stated: how many key paths fed this entry, `1` for an unmerged one.
2. `packages/dependency-manifests/src/kubernetes-images.ts` — populate it from `members.length`; keep
   the prose note as well, since the note is what an operator reads.
3. `packages/plugins/managed-dep/src/write-guard.ts` — the `values.yaml` → `parseKubernetesImages`
   entry in `MANIFEST_MATCHERS`, and `locateVersionLine` (§3.1) beside `manifestParserFor`. Test: a
   `pom.xml` yields NO anchor (step 4 refuses it), plus the enumerated per-ecosystem map added by the
   2026-08-17 follow-up round — which is what actually pins which ecosystems anchor, after the
   "untouched by construction" claim turned out to be true only of Maven.
4. `packages/plugins/managed-dep/src/bump-edit.ts` — the optional `anchor` on `ManifestBumpSpec`, the
   anchored branch of `verifyManifestBump`, the three new refusal reasons, and the same anchored branch
   in `applyManifestBump` so the reference edit still matches the shim. Header updated: clause 3 is now
   "that line names the coordinate, **or is the line the descriptor anchors to and the coordinate rule
   does not disagree**".
5. `apps/runner-dep/run.sh` — `$6`/`$7`, blanked in `BEGIN`, the anchored selection, and the veto. The
   argv contract comment and the "five argv strings" sentences in `index.ts:822` and the Dockerfile
   move with it.
6. `packages/plugins/managed-dep/src/runner-shim.test.ts` — split-shape fixtures added to the
   both-implementations-agree comparison, INCLUDING the refusal cases (a disagreeing coordinate rule, a
   mismatched anchor text), since agreement on refusals is the half a happy-path fixture misses.
7. `packages/plugins/managed-dep/src/index.ts` — derive the anchor from `original.content` between the
   read (`:813`) and the container launch (`:826`); pass it through `runEditorContainer` (`:593`).
   Delete-the-wiring gate: remove the anchor from the `docker create` argv and a NAMED split-shape test
   must die.
8. `apps/server/src/dependencies/bump-actuator.ts` + `bump-dispatch.ts` — `values.yaml` in
   `manifestIsEditableInThisBuild`, the D2 delivery decision, and the pinned cross-module allowlist
   test updated on BOTH the accepts and the refuses.
9. `docs/adr/0032-dependency-subscriptions.md` — a clause recording the anchored rule, D1–D5, and the
   residual risk of §4 as a stated, accepted risk rather than an omission.
10. `docs/proposals/kubernetes-image-references.md` §6 Q2 — pointer to this document (done in this
    commit).

### Incidental finding — FIXED in this round, since it touched the parser

`packages/dependency-manifests/src/kubernetes-images.ts` contains three literal **NUL bytes**, used as
separators in the group key at `toDeclarations` (`` `r ${coordinate}\0${declared}\0${digest}\0${pinned}` ``).
They are deliberate and correct as a separator choice, but they make `file(1)` report the source as
`data` and make **`grep` skip the file silently** — a filterless census with grep cannot see this file
at all, which is precisely the hazard CLAUDE.md's census rule is about. This round touched the parser
(D3's occurrence count), so the one-line change was taken: they are now `\u0000` escapes, the
separator is unchanged, and `file(1)` reports UTF-8 text.

---

## 11. Follow-up: a declaration pinned TWICE is refused, and moving both tokens is the next round

**Found and closed 2026-08-17, in the follow-up round to §10.** Written up here rather than fixed
whole, because the fix that would make these bumps *work* is materially larger than the one that
makes them *safe*.

### 11.1 The defect, as it actually behaved

A values file — or a Dockerfile — can pin an image twice:

```yaml
image:
  repository: acme/api
  tag: 1.2.3
  digest: sha256:aaaa…          # the SAME image, named a second time
```

```dockerfile
FROM alpine:3.19@sha256:aaaa…
```

The anchor lands on the `tag:` line (or on the `FROM` line), the runner replaces `1.2.3` with
`1.2.4`, and **every gate agrees**: one line changed, the reconstruction matches, the declaration set
is identical, exactly one declared version moved, and gate 7's confinement passes because
`versionTextOf` joins `declared` and `digest` into `1.2.3@sha256:aaaa…`, which contains the span that
moved. The pull request opens, and merges under `auto_merge` for the contiguous Dockerfile shape.

And **nothing changes**. Docker and containerd resolve by the digest whenever one is present; the tag
is a label. So SCP authors a change that reads as an upgrade, delivers none, and leaves the manifest
self-contradictory — a tag naming 1.2.4 beside a digest naming 1.2.3's bytes. That is worse than the
refusal it replaced: a refusal is legible and a silent no-op is not, and the next reader has to
reconcile two statements the file makes about itself.

Reproduced end to end before the fix, on both shapes, through `locateVersionLine` →
`applyManifestBump` → `verifyManifestBump` → `verifyManifestOnlyEdit`: proof minted, `1.2.3 -> 1.2.4`.

### 11.2 What was decided, and against what

The two candidates were **refuse** and **bump both tokens**. Bumping both is not blocked by missing
data — `dependency_lines.latest_digest` sits on the same row as `latest_version` and is written by
the same poll, so the new digest IS available — it is blocked by shape: in the split form it is a
**two-line edit**, and clause 2 of `verifyManifestBump` is *exactly one line differs*. Widening a
charter-enforcing refusal from "one line" to "an anchored pair" is a bigger change to the narrowest
control in this class than a follow-up round should make in passing, and it would have to be made in
three implementations at once (the verifier, the reference edit, and `run.sh`).

So: **refused, in two places, for two different audiences.**

1. **`planBump` → `declaration_pinned_by_digest`** (`bump-dispatch.ts`). Pre-dispatch, before a
   credential is minted or a container starts, with a Decision that names the digest and says the
   bump *was* due — the same shape as `manifest_not_editable_in_this_build`. Asked BEFORE the
   editability question, deliberately: a digest-pinned `Dockerfile` is in a perfectly writable file,
   so a rule ordered after it would leave the commonest case with no refusal at all.
2. **`verifyManifestOnlyEdit` gate 6 → `digest_pin_not_moved`** (`write-guard.ts`). The structural
   half, on the bytes the runner returned, before the proof is minted — so the refusal holds for any
   caller and any authoring strategy, not only for what the dispatcher chose to send.

The condition is **"the digest did not move"**, never "a digest exists". An edit that moves the tag
and its digest together is a correct bump and stays accepted (there is a named test on that exact
literal), as does a digest-only move. This keeps the door open for §11.3 without a second decision.

### 11.3 The next round — moving both tokens

What it needs, and why each part is not free:

- **A two-token anchor.** The descriptor would carry a second (line, text, from, to) — or, for the
  contiguous `name:tag@digest` literal, one line and two substitutions.
- **Clause 2 becomes "exactly one line, OR exactly the two lines the anchor names."** This is the
  load-bearing change and the reason it is deferred: the widening has to preserve the property that
  every refusal firing today still fires, and it has to be argued once and implemented three times
  (`verifyManifestBump`, `applyManifestBump`, `run.sh`).
- **`latest_digest` has to be threaded to the actuator.** It is on the line row, not on
  `component_dependencies`, and `planBump` does not read it today.
- **The pairing must be verified, not assumed.** `line-head.ts` already guarantees the stored digest
  belongs to the stored version and is never inherited across a version change, which is exactly the
  guarantee a two-token edit rests on — so the work is to *use* it, and to refuse when
  `latest_digest` is NULL rather than move the tag alone and re-open this defect from the other side.
