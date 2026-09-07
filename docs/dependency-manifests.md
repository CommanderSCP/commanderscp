# dependency-manifests

Long-form reference for the **dependency-manifests** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 101 of 109 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`packages/dependency-manifests/src/dockerfile.test.ts`](#packages-dependency-manifests-src-dockerfile-test-ts) — §1–§3
- [`packages/dependency-manifests/src/dockerfile.ts`](#packages-dependency-manifests-src-dockerfile-ts) — §4–§12
- [`packages/dependency-manifests/src/ecosystem-vocabulary.test.ts`](#packages-dependency-manifests-src-ecosystem-vocabulary-test-ts) — §13–§15
- [`packages/dependency-manifests/src/go-mod.test.ts`](#packages-dependency-manifests-src-go-mod-test-ts) — §16–§17
- [`packages/dependency-manifests/src/go-mod.ts`](#packages-dependency-manifests-src-go-mod-ts) — §18–§22
- [`packages/dependency-manifests/src/index.ts`](#packages-dependency-manifests-src-index-ts) — §23–§25
- [`packages/dependency-manifests/src/kubernetes-images.test.ts`](#packages-dependency-manifests-src-kubernetes-images-test-ts) — §26–§34
- [`packages/dependency-manifests/src/kubernetes-images.ts`](#packages-dependency-manifests-src-kubernetes-images-ts) — §35–§51
- [`packages/dependency-manifests/src/own-version.test.ts`](#packages-dependency-manifests-src-own-version-test-ts) — §52–§52
- [`packages/dependency-manifests/src/own-version.ts`](#packages-dependency-manifests-src-own-version-ts) — §53–§57
- [`packages/dependency-manifests/src/package-json.ts`](#packages-dependency-manifests-src-package-json-ts) — §58–§60
- [`packages/dependency-manifests/src/parse-contract.test.ts`](#packages-dependency-manifests-src-parse-contract-test-ts) — §61–§62
- [`packages/dependency-manifests/src/pom-xml.test.ts`](#packages-dependency-manifests-src-pom-xml-test-ts) — §63–§64
- [`packages/dependency-manifests/src/pom-xml.ts`](#packages-dependency-manifests-src-pom-xml-ts) — §65–§66
- [`packages/dependency-manifests/src/python.test.ts`](#packages-dependency-manifests-src-python-test-ts) — §67–§72
- [`packages/dependency-manifests/src/python.ts`](#packages-dependency-manifests-src-python-ts) — §73–§80
- [`packages/dependency-manifests/src/toml-lite.ts`](#packages-dependency-manifests-src-toml-lite-ts) — §81–§82
- [`packages/dependency-manifests/src/types.ts`](#packages-dependency-manifests-src-types-ts) — §83–§95
- [`packages/dependency-manifests/src/version.ts`](#packages-dependency-manifests-src-version-ts) — §96–§100
- [`packages/dependency-manifests/vitest.config.ts`](#packages-dependency-manifests-vitest-config-ts) — §101–§101

## `packages/dependency-manifests/src/dockerfile.test.ts`

### §1. A genuine multi-stage build, like this repo's own

A genuine multi-stage build of the shape this repo's own root Dockerfile uses: a builder stage, a vendored-tool stage pinned by digest, and a runtime stage that copies from both. The last two `FROM`s reference STAGES, not images.

### §2. Same file, but the third FROM is a real image

The identical file, with the one difference that the third `FROM` names a genuine second image (`alpine:3.19`) instead of the `build` stage.

Without this control, "the stage reference yields no dependency" would pass just as well if the parser dropped every third FROM, or every FROM whose operand lacks a slash, or simply returned fewer results than it should. The control proves the exclusion is driven by stage-ness.

### §3. A comment inside a continuation, which neither had

The load-bearing case the comment-skip describes, and the one neither fixture contained: both had comments only BETWEEN instructions, where stripping them changes nothing. Docker's own parser drops a comment line mid-continuation.

With the skip disabled the instruction breaks in two — `FROM alpine:3.19 # …` and a stray `AS base` — so the stage `base` is never declared and the later `FROM base` is minted as a phantom dependency on an image no registry has.

## `packages/dependency-manifests/src/dockerfile.ts`

### §4. Join continued lines into logical instructions

Join `\`-continued physical lines into logical instructions.

Docker's own parser drops comment lines that appear INSIDE a continuation, which is why comments are stripped here rather than before joining — stripping first would splice a comment's text into the middle of an instruction.

### §5. Digest algorithms and their exact hex lengths

Registered OCI digest algorithms and the EXACT length of their lowercase-hex encoding.

The length is the half that matters. A shape-only check passes `sha256:abc`, which is not a truncation of anything — it is a value that would be compared against a real 64-character digest for the rest of a subscription's life and never match.

### §6. Is this text an OCI digest?

Is this text an OCI digest?

SHARED BY BOTH IMAGE READERS, for the same reason `splitImageRef` is: `parseDockerfile` takes a digest off a `FROM …@…` and `parseKubernetesImages` takes one off a `digest:` key or off the same `@`, and both write it to `component_dependencies.resolved_digest` — the column the version poller compares a registry's answer against. A digest is IDENTITY (proposal §6.3, *"Tag ≠ identity"*), so recording a value that is not one records a pin to bytes that do not exist: strictly worse than recording no digest, because the row then reads as pinned. Fixing this in one parser and not the other would be the incomplete-census failure — the property is "a digest is written without checking it is one", and it had two instances.

Deliberately NOT a general "looks hex-ish" test, and deliberately not a full reference grammar. An unregistered algorithm is allowed at the spec's own minimum of 32 encoded characters; `sha256` and `sha512` must be exactly right.

### §7. Split an image reference, brace-aware

Split an image reference into registry+name / tag / digest, brace-aware.

EXPORTED FOR ONE OTHER READER, and deliberately not copied: `kubernetes-images.ts` splits the same one-scalar reference (`image: "localhost:5000/foo:1.2"`) out of a YAML document. A second splitter is how the port-vs-tag and the digest-colon rules below come to disagree between two parsers that must place the same image on the same `dependency_lines` row.

Brace awareness is load-bearing for exactly one construct: `${BASE:-alpine}` (Docker supports shell-style defaults in `ARG` expansion). A plain "last colon wins" split would cut that in half and report a package named `${BASE` — the classic mis-split. Depth-0 tracking also handles the ordinary registry-port case `localhost:5000/foo:1.2`, where the last depth-0 colon after the last depth-0 slash is the tag separator and the earlier one is a port.

### §8. Stage names so far, lower-cased like Docker

Stage names declared by `AS <name>` so far, lower-cased. Docker matches stage names case-insensitively, and a stage shadows any image of the same name, so membership here is decisive — we never fall back to "maybe it is also an image".

### §9. A reference to an earlier stage is not a dependency

(1) A reference to an EARLIER stage is not a dependency. This is the case a naive parser gets wrong, and it is negative-controlled in the tests: the same file with a genuine second image must still yield two.

The membership test is taken against the stages declared by earlier instructions and BEFORE this instruction's own `AS` name is added. A stage cannot reference itself, so recording first makes `FROM alpine AS alpine` — a stage named after its own base image, which is ordinary style — delete a genuine bumpable dependency. Order is the whole fix.

### §10. A malformed reference is refused, never minted

A malformed reference is refused outright rather than minted as a row. `FROM :1.0` has an EMPTY name, and an empty-string coordinate is an identity every malformed manifest in the org would collide on; `FROM alpine@` has an empty digest, which would be recorded as `pinned` — a pin to nothing. Both are the "a dependency with a wrong version is worse than a dependency that is missing" rule this package applies in `go-mod.ts:parseRequireLine`.

### §11. A real tag

A real tag. Its numeric core is extracted by the ONE shared helper — image tags are not semver, so `latest`, `stable`, `edge` and `alpine` all yield undefined here and are simply carried without a comparable version (ADR-0032 §7: skipped, never string-ordered).

Note the deliberate asymmetry with `parseImageTagVersion`: on this DECLARED side a single numeric component (`node:20`) is kept, because nothing is being ordered — there is exactly one string and it is the component's current state. On the CANDIDATE side, where a registry's whole tag list is ranked, `parseImageTagVersion` refuses precision-1 tags because a date stamp and a major line are indistinguishable there. Ordering is where the guess would happen.

### §12. The note names what was read, not what matched

The note names WHAT WAS READ, not which branch matched. "Moving tag" is only true of a tag that actually spells a partial version line (`3.19`, `3.19-alpine`). A precision-1 tag is NOT reliably one: `1a2b3c4d` (a git sha whose first character happens to be a digit) and `20240115` (a date stamp) both parse to precision 1, and telling an operator that a sha-pinned base image "names a line, not a point" is a provenance label named after the branch that matched — false the moment the branch covers a second kind of input. Precision 1 gets its own note, mirroring `parseImageTagVersion`'s default `minPrecision: 2` refusal on the candidate side, and for the same reason.

## `packages/dependency-manifests/src/ecosystem-vocabulary.test.ts`

### §13. The two ecosystem vocabularies must be one list

THE TWO ECOSYSTEM VOCABULARIES MUST BE THE SAME LIST.

This test exists because they were not. M21.2's parsers and its schema/migration were built in parallel by separate agents, and the container ecosystem was named `"image"` in `dependency-manifests/types.ts` and `"oci"` in `@scp/schemas/dependencies`. Both sides were fully green: the parsers proved they emit what they say, and the repo layer proved it stores what it accepts. Neither test crossed the boundary, so nothing failed — until ingestion (M21.3) would have tried to write a Dockerfile-derived row and been rejected by the Zod enum and the DB check constraint at the same time. Every `FROM` line in the estate, silently unsubscribable.

That is the "vacuous tests" failure mode in its cross-package form: a suite that is green for the wrong reason because the property it asserts is *local* while the property that matters is a *contract between two modules*. The fix is not to have renamed one constant — it is this file, which makes the next divergence a red test instead of a runtime rejection.

WHY THE RUNTIME IMPORT IS DEV-ONLY. `@scp/dependency-manifests` is deliberately dependency-free at runtime: the parsers are pure string->data functions, which is what lets them be unit-tested with no database, no network and no plugin host. Importing `@scp/schemas` for real would drag Zod into that. So the schema is a devDependency and appears only here, in the one place whose whole job is to compare the two lists.

`oci`, NOT `image`, is the agreed spelling: `image` is already a value of the executor `type` enum (`packages/schemas/src/executors.ts:32`) meaning "a build that PRODUCES an image artifact", where this axis records what a component CONSUMES. That is the same collision class as bare `subscription` (notification_bindings) and bare `manifest` (the promotion manifest), both settled in GLOSSARY.md.

### §14. Written as values, because `satisfies` is vacuous

The parser package's list, written out as VALUES rather than derived from the type.

A `satisfies`-only check would be vacuous: TypeScript erases at runtime, so a type-level assertion proves nothing about what `parseDockerfile` actually puts in the field. The `satisfies` clause below still earns its place — it makes this array fail to COMPILE if someone adds a member to `DependencyEcosystem` without adding it here — so the two mechanisms cover different halves: compile-time catches a missing member, the runtime comparison catches a renamed one.

### §15. The end-to-end half

The end-to-end half. The two checks above compare two hand-written lists, which drift together if someone edits both and still gets the value wrong. This one takes the value out of the PARSER'S ACTUAL OUTPUT and pushes it through the SCHEMA'S ACTUAL VALIDATOR — the same two pieces that will meet in M21.3's ingestion path.

## `packages/dependency-manifests/src/go-mod.test.ts`

### §16. A real-shaped `go.mod`

A real-shaped `go.mod`: two `require` blocks (the direct/indirect split `go mod tidy` emits), a single-line `require`, a `replace` BLOCK whose contents are line-shaped exactly like a require block, plus `exclude`, `retract` and `toolchain`.

### §17. Those blocks are rejected line by line anyway

The fixture above has replace/exclude/retract blocks, but EVERY line in them is independently rejected by `parseRequireLine`'s two-token rule — so the block-directive tracking and the token rule were each other's alibi and neither was pinned. Replacing `block === "require"` with `block !== undefined`, or deleting the `tokens.length > 2` check, left the whole suite green.

These fixtures separate them: two-token lines inside non-`require` blocks (which the token rule cannot catch) and an over-long line inside a `require` block (which the block tracking cannot).

## `packages/dependency-manifests/src/go-mod.ts`

### §18. `go.mod` require: direct requirements only

`go.mod` — the `require` directive, direct requirements only.

Go is the one ecosystem where "direct only" is not a discipline we impose from outside: the file itself marks the distinction. `go mod tidy` writes the module's own imports as plain `require` lines and everything pulled in beneath them with a trailing `// indirect` comment. So a go.mod contains BOTH the declared set and a chunk of the transitive closure, in one block, distinguished only by a comment — and a parser that ignores that comment does not merely over-report, it imports the transitive closure that ADR-0032 §4 exists to keep out (and that ADR-0013 keeps out as SBOM bytes). Dropping `// indirect` is therefore the whole point of this parser, not a detail.

Not parsed, deliberately: - `replace` — a local redirection of an existing requirement, not a new dependency. Reporting a replace target would invent a dependency the module never declared. - `exclude` / `retract` — negative statements; there is nothing to subscribe to. - `go` / `toolchain` — the language version, not a package. These are not silently skipped as a side effect of matching only `require`: the block-directive state machine below tracks WHICH directive a parenthesised block belongs to, because `replace (\n  a => b v1.0.0\n)` is line-shaped exactly like a require block and a naive "am I inside parens" parser reads its contents as dependencies.

Scope: go.mod expresses no runtime/dev/build distinction — Go test dependencies are ordinary requirements — so every result is `runtime`. Stated here rather than left to be inferred from the code, per ADR-0030 §2's "declared, never inferred".

### §19. Strip a line comment, returning code and comment

Strip a line comment, returning the code part and the comment text.

go.mod has no string literals that can contain `//` (module paths are quoted with `"` but never contain a comment marker in practice), so a first-`//` split is sufficient and is what the upstream `modfile` lexer effectively does for these directives.

### §20. Parse a `go.mod` file's direct requirements

Parse a `go.mod` file's direct requirements.

Handles both surface forms of `require`, which is not cosmetic — real modules mix them, and `go mod tidy` emits two separate blocks (direct, then indirect) in modern Go:

``` require github.com/pkg/errors v0.9.1            // single-line form require (                                        // block form github.com/spf13/cobra v1.8.1 golang.org/x/sys v0.22.0 // indirect ) ```

### §21. Independently load-bearing, not a second belt

This test is INDEPENDENTLY load-bearing, not a belt on top of `parseRequireLine`'s two-token rule. `exclude (\n\tgithub.com/broken/thing v1.2.3\n)` — exactly what `go mod edit -exclude` emits — is a two-token line, so the token rule would pass it and the module would gain a phantom DIRECT requirement on something it deliberately EXCLUDES. A `retract` block's `[v1.1.0, v1.2.0]` range is two tokens as well.

### §22. One requirement line; indirect returns undefined

One `<module-path> <version>` requirement, already stripped of its `require` keyword and comment.

Returns `undefined` for an indirect requirement (the ADR-0032 §4 exclusion) and for anything that is not two tokens — a malformed line yields nothing rather than a half-built dependency, because a dependency with a wrong version is worse than a dependency that is missing.

## `packages/dependency-manifests/src/index.ts`

### §23. The manifest parsers behind dependency inventory

`@scp/dependency-manifests` — the manifest parsers behind ADR-0032's dependency inventory: the five language/image manifests, plus the Kubernetes/Helm image reader M21.7 added.

Every export here is a **pure function of a string**. No file system, no network, no registry, no package manager, no lockfile. That is a deliberate architectural property, not an accident of scope:

- ADR-0032 §4 — **direct declared dependencies only.** A parser that could reach out would be one step from resolving a closure, which ADR-0013 keeps out of SCP as SBOM bytes. - ADR-0032 §3 — **nothing may expose a transitive traversal.** That boundary is what justifies the projection-table representation of the inventory; these functions structurally cannot breach it. - ADR-0032 §8 — **manifest-only edits, no lockfile resolution.** Invoking a package manager is tooling execution and fails gate 5 of ADR-0002's six-gate test. Nothing here can invoke one. - Charter principle 5 — **air-gap first-class.** The TOML and XML subsets are hand-rolled (`toml-lite.ts`/`pom-xml.ts`); the ONE third-party dependency is `yaml`, taken deliberately in M21.7 and recorded as a spent property in `types.ts` — it was already in the lockfile with no transitive dependencies of its own, so the offline install set did not grow by a package.

These parsers also mint no graph edges of any kind, which is ADR-0032 §5 holding by construction: package dependencies must never become `depends_on`, because that relationship type is the wave plan's toposort input and package graphs contain cycles.

## CALLER CONTRACT: THESE PARSERS THROW. AN INGESTION CALLER MUST CATCH.

Every parser below except `parseRequirementsTxt` throws `ManifestParseError` when it is handed content that is not the format at all — **including the empty string**:

| export                  | throws on                                                        |
| `parsePackageJson`      | not JSON; JSON that is not an object; a wrong-shaped deps block   | | `parseGoMod`            | no go.mod directive (`module`/`go`/`require`/…) anywhere          | | `parseDockerfile`       | no `FROM` instruction                                             | | `parsePyprojectToml`    | no TOML entries at all                                            | | `parsePomXml`           | malformed XML; no `<project>` root                                | | `parseKubernetesImages` | invalid YAML; NO MAPPING at any document root (a 404 body IS YAML) | | `parseRequirementsTxt`  | **never throws** — the format has no required construct to miss   |

This is deliberate and is the reason the package exists in this shape: "this component declares zero dependencies" and "I could not read this file" produce identical inventory rows and mean opposite things, and letting the second collapse into the first DELETES the component's whole inventory on the next ingestion pass. See `ManifestParseError`.

The consequence for the caller is the part that is easy to get wrong. A manifest fetch does not only return a manifest: a 404 HTML body, an unexpanded Git-LFS pointer, a truncated response and a path that no longer exists all arrive as *strings*, and every one of them lands on a `throw` here. A caller that does not wrap each per-manifest parse in its own try/catch turns one bad fetch into an unhandled rejection that aborts the whole ingestion run — strictly worse than the silent-empty behaviour this contract was designed to avoid. The intended handling is per-manifest: catch, record the manifest as unreadable, leave that component's existing inventory ALONE (do not write an empty set), and continue to the next manifest.

Pinned by `parse-contract.test.ts`, which asserts this table against the real exports.

### §24. The Kubernetes/Helm image reader

The Kubernetes/Helm image reader (M21.7). Same `oci` ecosystem as `parseDockerfile` — an image pinned in a chart's `values.yaml` is the same dependency line as the same image pinned in a `FROM`, read out of a different file. See `docs/proposals/kubernetes-image-references.md`.

### §25. The PRODUCER-side question

The PRODUCER-side question — "what version does this manifest declare for ITSELF?" — which every export above answers the consumer-side of. Added for M21.4's internal-release detection, where a language ecosystem's released version has no other honest signal (`changes.source_ref` carries no version and `observed.images` is the `oci` signal). Its three-way outcome (`declared`/`absent`/`unresolved`) is deliberate: see own-version.ts.

## `packages/dependency-manifests/src/kubernetes-images.test.ts`

### §26. The Kubernetes and Helm image reader, trap by trap

M21.7 — the Kubernetes/Helm image reader, trap by trap (`docs/proposals/kubernetes-image-references.md` §2 shapes, §4 traps).

EVERY ASSERTION NAMES THE SPECIFIC OUTCOME, never a count. "two declarations were returned" is satisfied by two wrong ones, and the failure this parser exists to prevent — a version read through YAML's coercion, an unreadable reference reported as absence — is invisible to a count.

The one place a count DOES appear is as a negative control beside a named assertion: e.g. that a file full of `imagePullPolicy`/`imagePullSecrets` keys yields NOTHING, which is what proves the exact-key rule is doing work rather than the fixture being uninteresting.

MUTATION LOG — ROUND 5, the false positives (each applied ALONE against a green suite, then reverted). The whole suite passed on the first run after the fix, which is the shape a vacuous test has, so every one of these was run before the round was called done.

1. Delete the image-context guard (`if (!underImageKey && image.kind !== "text") return;`) → 6 named tests red, all in "T13 — the `image` key is what makes a mapping an image". 2. `isUsableCoordinate` returns true unconditionally → 5 red, incl. the pre-existing "a malformed reference is refused outright" — so the empty-coordinate rule is one rule. 2b. Keep the empty check, delete only the per-segment check → 3 red. (Deleting only the `text === ""` clause kills NOTHING: it is redundant with the segment check, kept for legibility. Recorded rather than quietly left as an untested branch.) 3. `registryRead` drops the `.trim() !== ""` test → 4 red, incl. the two realistic-file cases. 4. Hoist the merge-key report above the context guard (the pre-fix behaviour) → 3 red. 5. `parseAllDocuments(content)` without `{ uniqueKeys: false }` → 3 red, and the timing budget fails at 7.1 s against its 2 s bound rather than passing slowly. 6. Delete the BLOCK_LITERAL/BLOCK_FOLDED refusal in `readKey` → 1 red. 7. `isDigestShaped` returns true → 3 red, ONE OF THEM IN `dockerfile.test.ts` — which is the point of putting the helper in `dockerfile.ts` rather than here. 8. `isEmptyDocument` narrowed back to `root === null` → 1 red. 9. Suppress the duplicate-image-key report → 1 red.

FIXTURE MUTATION: stripping the non-image furniture out of `REALISTIC_VALUES` leaves the suite green — expected, since removing a hazard cannot fail a test. What proves the fixture is load-bearing is mutation 1: with the guard gone, that one file alone reddens six cases.

### §27. A real digest, spelled at full length everywhere

A REAL sha256 digest, spelled at full length everywhere a fixture needs one.

`sha256:deadbeef` used to do this job, and it is not a digest — it is 8 hex characters where 64 belong. Since M21.7's own fix checks the shape, a short fixture would now pass for the wrong reason (refused as malformed) in tests written to prove the digest is CARRIED.

### §28. A values file with the furniture a real chart has

A values file with the FURNITURE a real chart carries.

Every false positive this block exists to catch comes from a file richer than a test author invents: the shapes below are taken from charts that ship — a `sources:` block that names an upstream repository and its release tag, a Kafka client's `schemaRegistry.registry`, a package feed's `registry`, a `<<:` merging resource presets, a `tag` used as a pod LABEL, and the `registry: ""` placeholder that means "the default registry". Exactly TWO images are declared in it, and a parser that reads `repository`/`registry`/`tag` off whatever mapping carries them reports six.

### §29. An all-unresolved manifest stamps unsupported

`projectIngestionStamp` stamps a manifest `unsupported` and its component `partial` when every declaration in it is unresolved, and names every unresolved one in the Decision. A parser that reported this file's `sources[0].tag`, its two non-image `registry` keys and its `resources.<<` would fire that warning on ordinary charts — and a warning that fires on everything is a warning nobody reads, which destroys the honesty mechanism M21.7 exists for.

### §30. Why this is a write-side bug, not a preference

WHY THIS IS A WRITE-SIDE BUG AND NOT A REPORTING PREFERENCE. Until M21.7 a values file was read-only, so reading `containers[].tag` as a version was merely a wrong row. Now the version's LINE is the line a bump edits (`locateVersionLine` anchors on it), so the same reading has SCP open a pull request that moves a key the API server does not look at — a diff that reviews as an upgrade and changes nothing that runs. Trap 13's rule (a) cannot tell a Container object from a chart image block; rule (b) can, and that is the discriminator.

### §31. The negative control behind the image-key rule

THE NEGATIVE CONTROL, AND IT IS THE WHOLE REASON THE RULE IS `underImageKey` RATHER THAN A LIST OF POD-SPEC KEY NAMES. ingress-nginx spells the repository under `image:` beside `registry:`, `tag:` and `digest:` — a mapping in context by rule (a) AND rule (b) — and Helm renders all of them. An exclusion that fired here would silently un-pin one of the most widely deployed charts there is, so a rule that refuses everything would pass the three cases above and fail this one.

### §32. THE SECOND CALL SITE OF THE SAME RULE

THE SECOND CALL SITE OF THE SAME RULE. T17 reports a duplicated image key because Helm takes the last and a reader takes the first. In a Container object `tag:` is read by nobody, so reporting a duplicate of it is trap 16's "a warning that fires on things that are not image references", let back in through the duplicate door. Fixing the read and not this would be the incomplete-census shape.

### §33. Not a micro-benchmark, and not a millisecond budget

NOT A MICRO-BENCHMARK, and deliberately NOT an absolute millisecond budget. `yaml`'s duplicate-key check rescans every sibling already composed for each new pair, so this input took 7.1 s with it on and 0.17 s with it off; at the 1 MiB read cap that is the difference between a minute of CPU per manifest and a fifth of a second. The header used to claim the work was "linear in the bytes the read cap already bounds", and it was not.

An absolute budget measured the RUNNER, not the parser: it passed locally at 0.18 s and failed CI at 2.6 s, where the suite runs under `--coverage` on a shared runner. The property is a SHAPE — doubling the siblings must roughly double the time, not quadruple it — so it is measured as a ratio against itself, which no machine speed or instrumentation changes.

### §34. RETRY THE MEASUREMENT, NEVER RELAX THE CLAIM

RETRY THE MEASUREMENT, NEVER RELAX THE CLAIM. A single sample of each side flaked once in a full-repo `turbo run test --force` (`expected 8.64505652940312 to be less than 8`, 1 failure in 198, green standalone and on repeat) and was reproduced here on demand under the same load. A wall-clock sample can only ever be INFLATED by a scheduler steal, never deflated, so one stolen `tLarge` — or one lucky-fast `tSmall` — moves the ratio in the failing direction while the parser is unchanged. The lowest ratio of a few matched pairs is the uninterrupted measurement.

NOTHING THE TEST CLAIMS IS WEAKENED, and that is deliberate: the bound is still 8, the sibling counts are still 8k and 32k, and the pairs are measured back to back so both halves of a ratio see the same load. A quadratic rescan lands an order of magnitude above the bound in EVERY attempt, so no number of retries can hide it. THE FIX FOR A FLAKE HERE IS MORE SAMPLES, NEVER A LARGER BOUND OR A SMALLER INPUT — those two are exactly the regression this test exists to catch, and it already had a 30 s timeout, so widening a budget could never have fixed it anyway.

IT RETRIES ONLY ON FAILURE, WHICH IS WHAT KEEPS THE FAILURE READABLE. The happy path costs one pair (~0.2 s here). A genuine quadratic regression costs three (~23 s, inside the 30 s timeout) and still fails on the RATIO with every attempt printed, rather than on a timeout that says nothing about what regressed.

## `packages/dependency-manifests/src/kubernetes-images.ts`

### §35. Kubernetes image references

Kubernetes image references — every image a YAML document PINS, whether it pins it the Helm way (`image.repository` + `image.tag` in a chart's `values.yaml`) or the pod-spec way (`spec.template.spec.containers[].image`).

WHY THIS EXISTS: ABSENT READ AS "NO DEPENDENCY", WHICH IS NOT WHAT IT MEANT
M21's inventory read image references only from `Dockerfile` `FROM` lines. Most Kubernetes users — the owner included — pin the image their component actually RUNS in Helm values, not in a `FROM`, so that image did not appear in the inventory at all. Absent renders as "this component declares no dependency"; the honest answer was "SCP cannot read where you declared it". This parser closes the first half of that, and `parseKubernetesImages`'s `unresolved` entries close the second: a reference that is FOUND but not resolvable from the file is REPORTED, never silently dropped. Design: `docs/proposals/kubernetes-image-references.md` (§2 shapes, §4 traps).

THE ECOSYSTEM IS `oci`. THERE IS NO SECOND IMAGE ECOSYSTEM.
An image pinned in a values file is the SAME `dependency_lines` row as the same image pinned in a `FROM`: same coordinate, same major, same tag pattern, same registry index, same comparator. The only thing that differs is which file the declaration was read out of, which `manifest_path` already records.

PATH-AGNOSTIC AND SHAPE-COMPLETE, ON PURPOSE
This function takes CONTENT and knows nothing about filenames. Only `values.yaml` is registered in the ingestion's parser table this round — raw Kubernetes manifests (`deployment.yaml`, `api.yaml`, `k8s/web-deploy.yaml`) are *unaddressable*, not hard: the git seam has exactly one file verb (`readFileAtRef`), there is no enumeration, and a guessed path that comes back `not_found` is the branch that PRUNES. But the pod-spec shapes are read here anyway — `containers[]`, `initContainers[]`, `ephemeralContainers[]`, a pod spec at the document root and CronJob's `spec.jobTemplate.spec.template.spec.containers[]` all end at an `image:` key, and the walk below is over every mapping in the document, so all of them are covered by construction. Turning them on later is one line in `MANIFEST_PARSERS` plus an addressability answer, not parser work.

`templates/*.yaml` is out permanently: a chart's rendered output is not in the repository, and Go template control blocks (`{{- if … }}`) make those files *not YAML at all*, so a parse failure there would be stamped `unreadable` ("may succeed next pass") — the wrong operator action, forever.

THE TRAPS, AND WHAT EACH ONE DOES HERE
1. **YAML COERCES THE VERSION AWAY.** `tag: 1.2` parses to the NUMBER 1.2; `tag: 1.20` parses to 1.2; `tag: 3.10` to 3.1. `component_dependencies.declared_version` is "the exact string the actuator has to edit; a normalised copy would be an edit target that does not appear in the file". So no version is ever read through a node's JS value — `scalarText` reads the scalar's own SOURCE TEXT, and a node whose source cannot be recovered is reported `unresolved` rather than guessed. This trap alone is why a real YAML parser is used. A BLOCK SCALAR (`tag: |`) is the one style whose source text is not the edit target: it carries the block's own trailing newline and spans lines, so `1.2.3\n` would go into the inventory as the string an actuator must find on one line. Reported `unresolved`. 2. **Go templates are not resolvable from the file.** `tag: "{{ .Chart.AppVersion }}"`, `repository: "{{ .Values.global.registry }}/api"`. Reported `unresolved` — the same rule `dockerfile.ts` applies to `ARG` interpolation, and for the same reason: resolving it would produce a confidently wrong version. (`.Chart.AppVersion` tracks the CHART's version, not the dependency's, so it would be wrong even if it were resolvable.) 3. **`latest`, `stable`, `edge`, date stamps and commit shas are not orderable.** Handled by the shared `parseComparableVersion`, which yields `undefined` for them: they are carried, they get no line row, and they are reported. A single numeric component gets its own note, because a registry cannot tell `20240115` from a major line. 4. **A bare `image: acme/api` with no tag is `unpinned`, NOT `latest`.** Kubernetes' implicit `:latest` is a RESOLUTION rule; writing "latest" into `declared` invents text the author never wrote. 5. **Digests.** `digest: sha256:…`, with or without a tag: both are carried and neither is derived from the other. Only the key literally spelled `digest` is read — a chart spelling it `sha` or `imageDigest` is not guessed at. And what it holds has to BE a digest: the value is checked against `isDigestShaped` before it is recorded, because a `digest:` carrying `latest` or a truncated hex string lands in `component_dependencies.resolved_digest` and is then compared against a registry's real digest — a pin to nothing that can never match, which is the "a wrong version is worse than a missing one" rule applied to identity. 6. **A values file for a chart the org CONSUMES vs its own chart.** Both are read and this parser does NOT branch on which it is: branching would be a label named after which condition matched, and it is wrong for umbrella charts where both are true at once. This package reports the declaration, not the consequence. STATED RESIDUE: an override key the consumed chart does not actually read is a declaration SCP will faithfully record. The mitigation is explainability — `declaredIn` carries the DOTTED KEY PATH (`postgresql.image.tag`), so a Decision names exactly which key was read. 7. **Multi-document YAML.** `---`-separated documents are ordinary here. All of them are parsed; a document whose root is not a mapping is skipped rather than fatal PROVIDED at least one root is a mapping (trap 8 is the other half of that sentence). In a multi-document stream every `declaredIn` is prefixed `doc[i].`, so two same-named keys in two documents stay distinct. 8. **Unreadable must not collapse into empty, and YAML makes that harder than JSON.** `parseGoMod` and `parsePackageJson` throw on `<!doctype html><title>404</title>` because it is not their grammar. It IS valid YAML — a plain scalar — so a naive YAML parser would return "zero images" for a 404 body and the next ingestion pass would PRUNE the component's whole image inventory. So: the EMPTY STRING throws, a YAML syntax error throws, and a stream with no mapping root but some non-null root throws. Stated cost: a genuinely zero-byte `values.yaml` is reported `unreadable` rather than `ok / 0` — a false alarm in the safe direction, because it does not prune. A comments-only file (no documents at all, but not empty) is the negative control and returns `[]`. So is a file whose only document is EMPTY (`---` on its own, or an explicit `null`): `yaml` composes that as a Scalar node holding null, not as `contents: null`, so "some root that is not a mapping" used to catch it and stamp it `unreadable` — "this attempt failed and the next may not" about a file that will fail identically forever. An empty document is an honest empty, and honest empty is `ok / 0`. 9. **The same image twice in one file is ONE row, and its bump is correctly ambiguous.** The inventory's primary key is `(org, component, line, manifest_path)`, so a Deployment and a CronJob pinning `acme/api:1.2.3` in one file collapse. Identical declarations are therefore merged into one entry HERE, and the entry's `note` names every key path that fed it — the ambiguity is reported at ingestion instead of being discovered months later as a mystery refusal from the bump verifier. The count is ALSO carried as a number (`DeclaredDependency.occurrences`), because the note is what an operator reads and a number is what a gate reads: `@scp/plugin-managed-dep` refuses to anchor a bump on a merged entry, and matching that refusal against prose would be a gate on wording. 10. **Anchors, aliases and merge keys.** `tag: *appVersion` and `<<: *defaults` are ordinary in values files, and for them the EDIT SITE IS NOT THE READ SITE: one edit to the anchor moves every alias, which a single-changed-line verifier would see as one line changed and several declarations silently moved. So an aliased value is `unresolved`, and a merge key IN IMAGE CONTEXT (trap 13) is reported as `unresolved` too — the keys it merges in are not in this mapping's AST. It is scoped to image context deliberately: a `<<: *resourceDefaults` on a resources block is ordinary YAML and reporting it stamped the whole file `unsupported` (trap 16). This also settles the billion-laughs question by construction: alias EXPANSION happens when a document is resolved to plain JS, and this parser never resolves one — it reads the AST, so there is nothing to expand. 11. **`image` is matched as an EXACT key, never as a substring.** `imagePullSecrets`, `imagePullPolicy`, `initImage`, `imageCredentials` and `global.imageRegistry` are not images. A key matched by "contains `image`" is a label named after what happened to match. 12. **The prune blast radius is larger here than for a Dockerfile.** One values file can be the sole declaration site for a dozen images, so a mis-parse returning `[]` would unsubscribe a dozen lines in one pass. That is why trap 8's root rule is a THROW and not a skip. 13. **`repository`/`registry`/`tag`/`digest` MEAN NOTHING ON THEIR OWN — the `image` key is what makes them an image.** Read off every mapping that happens to carry them, they mint phantom dependencies out of ordinary chart furniture: a `sources:` block's `repository:`, a `schemaRegistry:`'s `registry:`, a `tag:` on a label or a metrics config. The pod-spec walk already had the answer — it finds an image because the key is spelled `image`, not because the value looks like one — and that discipline is extended rather than joined by a heuristic. A mapping is IN IMAGE CONTEXT iff either (a) it carries an exact `image` key whose value is a SCALAR — the pod-spec/one-scalar shape, `containers[].image`, wherever in the tree it sits; or (b) it IS the value of an exact `image` key (directly, or as an element of a sequence that is) — Helm's `image: {repository, tag}` block, one hop, never deeper. Outside image context the four split keys are not read at all, and nothing is reported: this is not an image reference SCP failed to resolve, it is not an image reference. The `image:` key holding a MAPPING does not put its own mapping in context — that mapping is the PARENT of the image block, and reading its sibling `tag:` as a bare tag is the same phantom. STATED RESIDUE: a chart that spells the repository under `image:` beside a `registry:` (ingress-nginx does) is read by rule (a), so the coordinate is the repository alone and the sibling registry is NOT joined onto it — joining would double a registry that a pod spec's `image:` already spells in full. The un-joined `registry` is named in the entry's note. 14. **An EMPTY coordinate is not a phantom row, it is a SHARED one.** `repository: ""` is a live chart placeholder, and `dependency_lines` is keyed `(org, ecosystem, coordinate, major)` — org-scoped. So every component in the org carrying that placeholder collapses onto ONE line: one team's subscription governs another's, and a bump dispatched for it fans out across unrelated components. An empty or near-empty coordinate is therefore refused outright (`isUsableCoordinate`) rather than minted, and reported so it is visible. 15. **`registry: ""` MEANS "the default registry", not "a registry named empty".** It is the standard chart placeholder (bitnami's `global.imageRegistry` override point), so it is the COMMON case rather than an edge. Joined naively it yields `/acme/api`, which splits one image across two coordinates depending on whether a values file happened to spell the registry. An empty/whitespace registry is treated as ABSENT; a non-empty one that is not repository-shaped is reported, never joined. 16. **`unsupported` must mean "an image reference is in here that I could not resolve".** A manifest whose every declaration is unresolved is stamped `unsupported` and its component `partial` (`inventory-ingestion.ts:projectIngestionStamp`), so anything this parser reports unresolved on an ORDINARY values file destroys the honesty mechanism the round exists to provide: a warning that fires on everything is a warning nobody reads. Traps 13 and 10 are what scope it — every `unresolved` this parser emits is an image reference, in image context. 17. **DUPLICATE KEYS, and why `uniqueKeys` is off.** `yaml`'s duplicate-key check scans every sibling already composed for each new pair, which is QUADRATIC in siblings-per-mapping — a flat 218 KB mapping composes in 1.26 s and a 32 000-key one in 7.1 s, so the 1 MiB read cap bounds this ingestion-path call at roughly a minute of CPU per manifest, not at "linear in the bytes". Measured, not reasoned about: with `uniqueKeys: false` the same 32 000-key file composes in 0.18 s and the curve is linear. Turning the check off means a duplicated key arrives as two pairs, and Go's YAML — which is what Helm renders with — takes the LAST while a scan takes the first, so a duplicated image key is REPORTED rather than picked between. (The check's other effect, throwing on any duplicate key anywhere in the file, was the wrong stamp anyway: `unreadable` says "may succeed next pass" about a file that will fail forever.) 18. **A `tag:` BESIDE A POD-SPEC `image:` IS A KEY KUBERNETES NEVER READS.** `containers[].tag` is not in the Container schema; `image` there is a complete reference. Trap 13's rule (a) admits container objects and chart image blocks alike, so the sibling split keys are read only where rule (b) ALSO holds — i.e. where the mapping is the value of an `image:` key and is therefore an image block, not a container. Since M21.7 made `values.yaml` WRITABLE this stopped being a reporting question: the sibling's line is the line a bump would EDIT, so reading it would have SCP author a pull request that moves a key nothing consumes. See `unreadSiblingNote` for what is given up and how it is reported.

WHAT IS NOT READ, DELIBERATELY
`Chart.yaml`'s `dependencies[].version` names SUBCHARTS from a Helm repository — a sixth ecosystem (new enum member, new DB check-constraint value, new version index), not an image. `kustomization.yaml`'s `images: [{name, newTag}]` is bounded and resolvable and is the obvious next basename; it is deliberately not taken this round, because each basename multiplies the ingestion's per-pass read budget and one filename at a time is the measurable way to grow it.

### §36. Is this text usable as an image coordinate at all?

Is this text usable as an image coordinate at all? (trap 14)

Deliberately a SHAPE test and not a grammar: the OCI reference grammar would refuse things real registries accept, and this package's job is to refuse the values that are not coordinates at all — the empty string, whitespace, and anything that joins to a leading/doubled `/`. Those are the ones that COLLIDE: `dependency_lines` is keyed `(org, ecosystem, coordinate, major)` org-wide, so an empty coordinate is not one bad row, it is every component in the org sharing one line.

### §37. One reference as read, before identical ones merge

One image reference as it was read, before identical ones are merged.

`resolved: false` is a first-class outcome and is the point of this parser: a reference SCP FOUND and cannot honestly read must reach an operator as `unsupported`, never as absence.

### §38. ONE pass, not one per key

ONE pass, not one per key.

The previous shape ran `map.items.find(...)` six times per mapping. That was linear too, and it was never the cost that mattered — the composer's own duplicate-key scan was (trap 17) — but a single pass is what lets duplicates be SEEN at all, which turning that scan off makes necessary.

### §39. A document with NO CONTENT

A document with NO CONTENT — `---` on its own, an explicit `null`, a document that is only a comment (trap 8).

`yaml` does not report these as `contents: null`; it composes a Scalar node whose `value` is null. So the "some root is not a mapping" refusal caught them, and a `values.yaml` holding only `---` was stamped `unreadable` — "this attempt failed and the next may not" about a file whose next 10 000 passes fail identically. An empty document declares nothing, honestly.

### §40. Parse every image reference the document declares

Parse every image reference a Helm values file or a Kubernetes manifest declares.

### §41. THE AST, NEVER `toJS`

THE AST, NEVER `toJS`. That is what bounds the work rather than an alias-count cap: alias EXPANSION is a property of resolving a document to plain JS, and this parser never resolves one — it reads nodes, and an alias node is reported `unresolved` at its own site (trap 10). A billion-laughs values file is therefore linear in the bytes the read cap already bounds, with nothing to expand.

(trap 17) `uniqueKeys: false` IS A MEASURED CHOICE, NOT A LOOSENING. The default check scans every sibling already composed for each new pair — quadratic in siblings-per-mapping, and this call sits in the ingestion path behind a 1 MiB read cap: a flat 32 000-key mapping composes in 7.1 s with it on and 0.18 s with it off. What the check bought (a throw on any duplicate key) was the wrong outcome anyway — `unreadable` claims the next pass may succeed — and what it protected against is handled where it matters, on the five image keys, by `collectKeys` reporting a duplicate instead of silently taking the first.

### §42. Every mapping examined, and examined the same way

Every mapping in the document is examined, and every mapping is examined the same way.

`underImageKey` is trap 13's rule (b) and it is the ONLY context this walk carries: true for the mapping that is the value of an exact `image:` key, and for a mapping inside a sequence that is. It is not inherited any further — a mapping two hops under `image:` is ordinary again — because "somewhere below a key called image" is precisely the loose reading that mints phantoms.

### §43. Read one key, naming every not-a-text outcome

Read one key off a mapping, with every not-a-text outcome named rather than dropped.

`mappingIsAnotherMapping` is set for `image` alone, and it is what makes shape B (`image:` with `repository`/`tag` under it) work: an `image` whose value is a MAPPING is not this mapping's declaration at all — it is a nested mapping the walk reaches on its own, and reporting it here as "not a scalar" would attach an unresolved entry to every ordinary chart values file. For the four other keys a mapping value IS nonsense (`tag:` cannot be a mapping), and stays `unresolved`.

### §44. The sentence an un-read `tag:` or `digest:` gets

(trap 18) The sentence a rule-(a)-only mapping's un-read `tag:`/`digest:` gets. Naming them is the whole difference between this and the phantom-minting round 5 removed: the key is in the file, SCP saw it, and SCP is saying why it did not treat it as this image's version.

### §45. The whole shape logic, applied in image context

THE WHOLE OF THE SHAPE LOGIC, applied to every mapping IN IMAGE CONTEXT — which is what makes one parser cover both a chart's `image:` block and a pod spec's `containers[].image` with no per-convention branch, and what makes raw Kubernetes manifests a registration decision rather than parser work.

IMAGE CONTEXT IS THE WHOLE GUARD (trap 13). `repository`, `registry`, `tag` and `digest` are ordinary English words that ordinary values files use for ordinary things, and reading them off every mapping minted a dependency for each one. They are read here only when the `image` key — the same marker the pod-spec walk has always used — says this mapping is about an image.

### §46. A `tag:` beside a pod-spec `image:` is never read

(trap 18) A `tag:` BESIDE A POD-SPEC `image:` IS A KEY KUBERNETES NEVER READS.

Rule (a) — a mapping carrying an exact `image:` SCALAR — admits two populations that look identical to a walker and are not the same thing:

```text
* a chart's own image BLOCK, which happens to spell the repository under `image:` beside a
  `registry:` and a `tag:` (ingress-nginx does exactly this). That mapping is ALSO the value
  of an `image:` key, so rule (b) holds for it too, and its `tag:` is the image's version —
  Helm renders `{{ .registry }}/{{ .image }}:{{ .tag }}` out of it.
* a Kubernetes CONTAINER OBJECT — `containers[]`, `initContainers[]`, or a `sidecars:`/
  `extraContainers:` fragment a chart splices into a pod spec with `toYaml`. `image` there is
  a COMPLETE reference and `tag` is not a field of the Container schema at all: the API
  server ignores it, or with a strict decoder rejects it. Such a mapping is in context by
  rule (a) ALONE — it is never the value of an `image:` key.
```

Reading the sibling in the second population is trap 13's phantom one level in, and since M21.7 made values files WRITABLE it is no longer only a wrong row: the sibling's line is the line `locateVersionLine` would anchor a bump to, so SCP would author a pull request that moves a key nothing consumes and changes nothing that runs. `underImageKey` is the discriminator because it is the marker the rest of this parser already uses, not a new heuristic — and a rule keyed on the literal name `containers` would miss `sidecars:` and `extraContainers:`, which become container objects just the same.

WHAT IS GIVEN UP, NAMED. A flat `myapp: {image: acme/api, tag: 1.2.3}` — in context by rule (a) alone, but whose `tag:` the chart's own template really does read — is recorded `unpinned` with the un-read key named, instead of pinned to 1.2.3. This file cannot tell that from a container, and a version SCP records is a version SCP will try to bump, so the ambiguity resolves to the side that authors nothing.

Declared HERE, above the duplicate report, because that report is a call site of the same rule.

### §47. A merge key brings in keys this mapping's AST lacks

(trap 10) A MERGE KEY BRINGS IN KEYS THAT ARE NOT IN THIS MAPPING'S AST, so the only honest report is the merge itself — silence about a merged-in image block is the same absence-read-as-nothing this parser exists to remove. IN IMAGE CONTEXT ONLY (trap 16): a `<<: *resourceDefaults` on a resources or nodeSelector block is ordinary YAML, and reporting it stamped the whole manifest `unsupported`, which is a warning that fires on everything.

### §48. An empty `registry:` means the default registry

(trap 15) `registry: ""` IS "THE DEFAULT REGISTRY", which is what bitnami-style charts spell when nothing has overridden `global.imageRegistry`. Treated as text it joins to `/acme/api` and splits one image across two coordinates depending on whether a values file said the registry.

### §49. STATED RESIDUE (traps 13, 18)

STATED RESIDUE (traps 13, 18). ingress-nginx and friends put the repository under `image:` beside a `registry:`; a pod spec's `image:` is a COMPLETE reference and joining would double a registry it already spells. So the sibling is not joined — and not silently dropped either. The same sentence governs `tag:`/`digest:` beside a rule-(a)-ONLY `image:` (trap 18), except that those are not read AT ALL: an un-joined registry still leaves a usable coordinate, while a tag read off a Container object is a version nothing consumes.

### §50. (trap 5) A `digest:` KEY THAT DOES NOT HOLD A DIGEST

(trap 5) A `digest:` KEY THAT DOES NOT HOLD A DIGEST. `refDigest` came out of the one-scalar form and was already refused above; this is the split shape's own key, and a `digest: latest` or a truncated hex string here lands in `component_dependencies.resolved_digest` and is then compared against what a registry actually publishes — a pin to bytes that can never match.

Refused WITHOUT refusing the declaration: the coordinate and the tag beside it are still read correctly, so dropping them too would lose a real dependency over a bad neighbouring key. The bad digest gets its own reported entry and the surviving row says the digest was refused.

### §51. Merge the occurrences into declarations

Merge the occurrences into declarations.

(trap 9) IDENTICAL DECLARATIONS COLLAPSE, because the row they produce collapses: `component_dependencies` is keyed `(org, component, line, manifest_path)`, so a Deployment and a CronJob pinning `acme/api:1.2.3` in one file are ONE row however many times the file says it. The surviving entry NAMES every key path that fed it, so "an edit to one of these leaves the others behind" is a fact an operator reads at ingestion rather than a mystery refusal months later.

## `packages/dependency-manifests/src/own-version.test.ts`

### §52. The PRODUCER-side reader

The PRODUCER-side reader (M21.4, ADR-0032 §7a).

The property under test throughout is the THREE-WAY OUTCOME. `declared`, `absent` and `unresolved` are three different facts about a repository, and every collapse between them is a lie a caller cannot detect:

```text
- `unresolved` collapsed into `absent`  ⇒ "this project has no version", of a project that has
  one, sending whoever reads the Decision to look in the wrong place;
- `absent` collapsed into a THROW       ⇒ "we could not read the manifest", of a manifest we
  read perfectly well;
- a THROW collapsed into `absent`       ⇒ a 404 HTML body reported as "declares no version".
```

So each case below asserts the DISCRIMINANT, not merely that something non-fatal came back.

MUTATION LOG — applied, watched fail, reverted, watched pass: | Mutation | Result |
| maven: take the first `<version>` in document order (drop the `<project>`-depth check) | "never mistakes a DEPENDENCY's or the PARENT's version" FAILS with `1.0.0-parent`, and the inherited case FAILS too | | report an inherited/`dynamic` version as `absent` instead of `unresolved` | both "unresolved, not absent" cases FAIL — the collapse this file exists to prevent |

## `packages/dependency-manifests/src/own-version.ts`

### §53. What version does this manifest declare for itself

"WHAT VERSION DOES THIS MANIFEST DECLARE FOR **ITSELF**?" — the producer-side question, as opposed to every other parser in this package, which answers the consumer-side one ("what does this manifest declare about OTHER packages").

WHY IT LIVES HERE AND NOT IN THE SERVER. M21.4's internal-release detection has to answer "which version did this release publish?" for a language ecosystem, and the only honest signal is the producing component's own manifest read at the released commit (`changes.source_ref` carries repo/ref/commit/run_url/artifact_digest and NO version; `change_wave_targets.observed.images` carries an image ref, which is the `oci` signal and not a language one). Answering it needs the same TOML and XML subsets `python.ts` and `pom-xml.ts` already hand-rolled — so this file reuses them rather than growing a second TOML reader and a second XML walker inside `apps/server`, where manifest-format knowledge does not belong.

THE THREE-WAY OUTCOME IS THE WHOLE POINT (ADR-0032 §7: "unparseable tags are skipped rather than guessed"). "This manifest declares 1.4.2", "this manifest declares no version at all" and "this manifest declares a version that cannot be known without doing work we are forbidden to do" are three different facts, and collapsing the last two into a guess is how a component ends up looking up-to-date at a version it never published. A WRONG version is worse than NO version, because no version is visibly missing and a wrong one is invisibly false.

The `unresolved` outcome is not hypothetical for Maven in particular: a POM whose `<version>` is inherited from `<parent>` or written as `${revision}` is the common shape in a multi-module build, and resolving either one means reading a second document or running the build — the first is a closure walk (ADR-0032 §4) and the second is tooling execution (ADR-0032 §8, ADR-0002 gate 5). `DeclaredDependency.constraint` already models exactly this distinction as `unresolved` on the consumer side; this is the same distinction on the producer side.

SAME THROW CONTRACT AS EVERY OTHER PARSER HERE (see `index.ts`): content that is not the format at all raises `ManifestParseError`. A 404 body, an unexpanded Git-LFS pointer and a truncated response all arrive as strings, and a caller MUST catch per manifest — see the caller contract in `index.ts`.

### §54. The three ecosystems that state their own version

The three ecosystems whose manifest states the producing project's OWN version.

`go` is absent BY DESIGN, not by omission: `go.mod` declares the module PATH and never a version — a Go module's version IS its git tag — so there is nothing here to read and a caller must use the ref instead. `oci` is absent for the mirror-image reason: an image's version is the tag it was pushed under, which the registry knows and the Dockerfile does not.

### §55. `package.json`'s own `version`

`package.json`'s own `version`. The one ecosystem where the answer is a single field with no inheritance and no interpolation.

A workspace ROOT `package.json` routinely carries `"private": true` and either no `version` or a placeholder — that lands on `absent`, which is correct: the root package is not what was released. Deciding WHICH `package.json` describes the released component is the caller's problem and is answered from the component's own recorded manifest paths, never guessed here.

### §56. PEP 621's version, then Poetry's, in that order

PEP 621's `[project] version`, then Poetry's `[tool.poetry] version`, in that order — the same two tables `parsePyprojectToml` reads dependencies from, so a component whose dependencies this package can read is a component whose version it can read too.

`[project] dynamic = ["version"]` (PEP 621) is `unresolved`, NOT `absent`: the project has a version and deliberately delegates it to the build backend (setuptools-scm reading a git tag, hatch-vcs, a `__version__` attribute). Determining it means running the backend, which is tooling execution — ADR-0032 §8's scope boundary and ADR-0002's gate 5. Reporting it as `absent` would say "this project has no version", which is false and would send a reader looking in the wrong place.

### §57. The DIRECT `<version>` child of `<project>`

The DIRECT `<version>` child of `<project>` — never `<parent><version>`, never a `<dependency><version>`, never a plugin's.

A depth-tracked scan rather than a reuse of `pom-xml.ts`'s `walk`: that walker's callback surface is `onDependency`, i.e. it is shaped around the consumer-side question, and widening it to also emit arbitrary top-level elements would change a function three shipped code paths depend on for the sake of a fourth. The two share the refusal set below deliberately — an unterminated construct is a read failure in both, for the reason `ManifestParseError` states.

The two `unresolved` shapes are the ones that actually occur in multi-module builds: - no `<project><version>` but a `<project><parent>` — the version is INHERITED, and reading it means fetching a second POM (a closure walk, ADR-0032 §4); - a `${...}` interpolation (`${revision}`, `${project.parent.version}`) — resolving it means evaluating Maven's property model, which is running the build (ADR-0032 §8). Both are reported rather than guessed. A guess here writes a version into `dependency_lines` that the org never published.

## `packages/dependency-manifests/src/package-json.ts`

### §58. `package.json` dependencies, direct only

`package.json` — `dependencies`, `devDependencies` and `optionalDependencies`.

Direct only, which for npm is not merely a policy choice but a structural one: the transitive closure lives in `package-lock.json`/`pnpm-lock.yaml`, and this package never opens those. That is the same boundary from two directions — ADR-0032 §4 forbids storing the closure, and ADR-0032 §8 forbids the actuator from regenerating a lockfile at all ("Manifest-only edits. No lockfile resolution."), because running a package manager is tooling execution and breaks gate 5. A parser that read the lock to "enrich" the inventory would be the first step down exactly that path.

Included and excluded, deliberately: - `dependencies`         -> scope `runtime` - `devDependencies`      -> scope `dev` - `optionalDependencies` -> scope `runtime` (they ship; they are merely allowed to fail to install). `declaredIn` preserves which block it actually was, so nothing is lost by the mapping. - `peerDependencies` are **excluded**: a peer dependency is a compatibility *assertion about the consumer's* tree, not something this component installs. Bumping a peer range on a subscription tick would silently narrow what downstreams may use. - `bundledDependencies` / `bundleDependencies` are excluded: a name list with no versions, and every entry is already declared in one of the blocks above.

Scoped names survive verbatim (`@acme/lib` stays `@acme/lib`) — see `DeclaredDependency.coordinate` for why normalising here would re-create the URN collision that ADR-0032 Context 2 measured.

### §59. A specifier naming exactly one version

A specifier naming exactly one version: `1.2.3`, `=1.2.3`, `v1.2.3`.

Everything else with a comparator, a caret, a tilde, an `x`, a `||` or a space is a RANGE. The distinction is recorded rather than flattened because `^1.2.3` and `1.2.3` are different statements, and an actuator that rewrote one as the other would change the project's policy while claiming to have bumped a version.

### §60. The version a specifier states as its floor

The version a specifier states the component is AT OR ABOVE, or `undefined` when it states none.

Blindly stripping `^[\^~=><\s]+` makes an upper bound look like a declared version: `<2.0.0` records 2.0.0 and `<=1.9.9` records 1.9.9 — versions the component is pinned BELOW, not at. That is the same dishonesty `package-json.test.ts` already rules out for the compound range `">=3.23.8 <4"` ("producing 3.23.8 for it would assert a floor as if it were the declared version"); the rule simply was not applied to a single-clause upper bound. `>` is kept: it excludes its endpoint but still says where the line starts, which `<`/`<=` do not.

The compound-range case stays undefined for its own separate reason — after the comparator is stripped, `3.23.8 <4` still carries whitespace, and `parseComparableVersion` refuses a version token with a space in it (see the no-whitespace note in `version.ts`).

## `packages/dependency-manifests/src/parse-contract.test.ts`

### §61. The throw or no-throw contract of the entry point

THE THROW/NO-THROW CONTRACT OF THE PACKAGE'S PUBLIC ENTRY POINT.

M21.2 changed `parseGoMod` and `parseDockerfile` from returning `[]` to throwing `ManifestParseError` on unreadable content, and the empty string went with them. Nothing consumes this package yet, so nothing broke — which is exactly why it needed pinning now: M21.3's ingestion caller is the first consumer, it is being written by a different agent from a different context, and the only thing standing between it and an unhandled rejection on a 404 body is that this contract is (a) documented where a caller reading `index.ts` cannot miss it and (b) asserted somewhere that goes red if it drifts.

Two properties are asserted here that the per-parser suites structurally cannot:

1. **Imported from `./index.js`, not from the modules.** The per-parser tests import `./go-mod.js` directly, so they would stay green if an export were dropped from the entry point. The contract belongs to what a consumer can actually reach. 2. **Same input across all six.** Each parser's own suite proves its own throw with its own fixture; none of them proves the six agree on a SHARED input. `""` is that input, and it is the one an ingestion caller hits first (an empty file, an empty 200 body, a deleted path).

NEGATIVE CONTROL is `parseRequirementsTxt`, which must NOT throw. Without it every assertion here is satisfied by a package that throws on everything — the vacuous-test shape where an assertion of a behaviour is met for the wrong reason.

### §62. The interesting member: a 404 body is valid YAML

M21.7 — AND THIS IS THE INTERESTING MEMBER OF THE TABLE. The others throw on the 404 body because it is not their grammar. It IS valid YAML — a plain scalar — so `parseKubernetesImages` throws only because it was written to require a mapping at some document root. Without that rule it would report "zero images" for an error page, and one values file can be the sole declaration site for a dozen images, all of which the next pass would prune.

## `packages/dependency-manifests/src/pom-xml.test.ts`

### §63. A real-shaped Spring Boot POM

A real-shaped Spring Boot POM: a parent, a properties block, a `<dependencyManagement>` import, the project's own `<dependencies>`, a `<build><plugins>` block and a `<profiles>` section.

Four of those five blocks contain `<dependency>`-shaped or `<version>`-shaped elements that a name-matching parser would happily report.

### §64. `decodeEntities` survived being made a no-op

`decodeEntities` survived being made a no-op: no fixture carried an entity in a field the walker actually reads. Maven coordinates do not normally contain one, but every child value the walker collects goes through this function, so a silent no-op would corrupt any that did.

The ORDER is the substantive property: `&amp;` must be replaced LAST, or `&amp;lt;` decodes all the way to `<` — a double-decode that turns escaped text into markup.

## `packages/dependency-manifests/src/pom-xml.ts`

### §65. `pom.xml`: the project's own dependencies block

`pom.xml` — the project's own `<dependencies>` block.

**Two Maven features are explicitly OUT OF SCOPE for this increment, and both are reported as `unresolved` rather than guessed:**

1. **Parent-POM inheritance / `<dependencyManagement>`.** A `<dependency>` with no `<version>` is not under-specified — its version is supplied by a parent POM or a `<dependencyManagement>` section, quite possibly in a *different file in a different repository*. Resolving that means fetching and merging the parent chain, which is dependency RESOLUTION: exactly the work ADR-0032 §8 puts out of bounds ("Manifest-only edits. No lockfile resolution.") and exactly the I/O this package refuses to do. 2. **Property interpolation** — `<version>${spring.version}</version>`. The value may come from this POM's `<properties>`, from a parent's, from a profile that is only active on some machines, from `-Dspring.version=…` on the command line, or from a `settings.xml`. Even the subset that *is* resolvable from this one file is only a DEFAULT. An interpolated version is therefore reported unresolved.

Both are stated here as a scope boundary rather than discovered during implementation, per ADR-0032's own standard for the lockfile limit ("a real functional limit … stated as a scope boundary, not discovered during implementation"). A dependency reported `unresolved` is still a real inventory row — the coordinate is known and the reverse query "which components declare org.springframework:spring-core?" still answers correctly. Only the *version* is withheld, and withholding it is what stops an actuator writing a confidently wrong number into someone's POM.

**Only the project's own `<dependencies>`.** `<dependencyManagement><dependencies>` declares versions for dependencies that may never be used, `<build><plugins>` are build-tool plugins, and `<profiles>` are conditionally active. Each is excluded by matching the FULL element path (`project/dependencies/dependency`) rather than the element name — a name-matching parser reads all four blocks as one and reports dependencies the module does not have.

**Maven scopes** map as: `compile` (the default) and `runtime` -> `runtime`; `test` -> `dev`; `provided` and `system` -> `build` (available while compiling, deliberately not packaged).

### §66. Walk the document, tracking the full element path

Walk the document, tracking the full element path, and hand each `<dependency>` element's children to `onChild`.

A hand-written walker rather than an XML library for the same reason as `toml-lite.ts`: charter principle 5 (offline, vendored, no runtime network) and a deliberately dependency-free package. It handles comments, CDATA, processing instructions, self-closing elements and namespace prefixes.

WHAT IT REFUSES, precisely — the claim is narrowed to what is actually checked, because the broader "throws on a malformed document" it used to make was false: it never compared a closing tag to the stack top, so `<version>1.0</version></wrong>` was accepted as well-formed: - an unterminated comment, CDATA section, declaration or tag; - a closing tag that does not match the innermost open element; - a closing tag with nothing open (stack underflow); - a document that ends with elements still open. It is NOT a validating parser: attributes, entity declarations, duplicate roots, encoding and schema conformance are all unchecked, and a POM that passes here is not thereby valid XML.

## `packages/dependency-manifests/src/python.test.ts`

### §67. The one option argument that reads as a requirement

`--only-binary`/`--no-binary` take a distribution list, so their argument is the one option argument that would otherwise read as a requirement.

HONEST NOTE on what this pins: there is exactly ONE mechanism now. The leading-`-` guard that used to sit in `flush()` was provably unreachable (PEP508_RE is anchored on `[A-Za-z0-9]`, so no `-` line could ever reach it) and has been deleted; this test pins the OBSERVABLE property, and the invariant it depends on is documented on PEP508_RE where it is enforced. Said out loud because a test that names a mechanism it does not exercise is the vacuous-test failure in its most convincing form.

### §68. The class is "a pip VCS scheme prefix", not "git+"

The class is "a pip VCS scheme prefix", not "git+". pip documents git, hg, svn and bzr (pip docs, "VCS Support"); with only `git+` listed, the other three fell through to PEP508_RE and minted distribution rows literally named `hg`, `svn` and `bzr` — phantom packages no index resolves, attached to a real component. Asserted one scheme per line so a regression names which scheme regressed instead of collapsing into one empty-array failure.

### §69. These fail again if the guard becomes a prefix test

Without this the fix above passes just as well if the guard grew into a prefix test again. `svn`, `hgapi`, `bzrlib` and `gitpython` are all real PyPI distributions, and a component that declares `svn==1.0.1` must still get a row — it is the drop-a-real-package failure the httpx/httpcore case above was written for, one ecosystem-scheme over. `svn` is the sharp one: the coordinate is the bare scheme word.

### §70. Inputs that break if the scheme rule is loosened

SCHEME_LINE_RE keys on `+`/`:` immediately after the leading token, so these are the inputs that would break if it were loosened to "contains a `+` or `:`" — and both are ordinary: a PEP 440 local version (`+cu118`, every CUDA wheel in existence) and a PEP 508 direct reference, whose URL carries a `:` and whose specifier the parser deliberately leaves unresolved rather than reading a version out of the path.

### §71. Neither of these is a URL

Neither of these is a URL (no `//`, no scheme colon) and neither is valid PEP 508 (`+` and `:` cannot follow a distribution name). Parsed as requirements they yield the coordinates `http` and `git` — a distribution named after the scheme of the URL somebody meant to type.

This behaviour was UNPINNED IN EITHER DIRECTION: HEAD dropped both by accident (the old unanchored prefix test happened to catch them, while deleting httpx et al.), and narrowing the regex to require the delimiter turned them into phantom rows with nothing to notice. The deliberate choice is refusal, per `dockerfile.ts:209-214`: a wrong identity is worse than a missing one, and the same one guard (SCHEME_LINE_RE) delivers both verdicts because the OUTCOME for a well-formed and a malformed URL line is the same. Per-LINE refusal, not ManifestParseError — see the next assertion.

### §72. Skipped rather than guessed, for PEP 440 clauses

ADR-0032 §7's "skipped rather than guessed" applied to PEP 440 specifiers.

Nothing pinned the clause-selection rule before: no test asserted `version` for ANY multi-clause specifier, so first-clause, last-clause and "whatever parses" were indistinguishable. The rule is now: the clause that denotes a FLOOR, or undefined.

## `packages/dependency-manifests/src/python.ts`

### §73. Python: `pyproject.toml` and `requirements.txt`

Python — `pyproject.toml` **and** `requirements.txt`, because a real Python component may declare in either and many declare in both.

**"Declared vs pinned differ, record which it was."** This is the ecosystem where that matters most and where it is most often lost. `requests>=2.31` and `requests==2.31.0` are different statements about the same package: the first delegates the choice to the resolver, the second takes it. A `requirements.txt` that is machine-generated by `pip freeze` is wall-to-wall `==` pins, while a hand-written `pyproject.toml` is wall-to-wall ranges — and the SAME component often has both, one being the compiled output of the other. Flattening the two into "a version" would make an actuator rewrite a project's dependency POLICY while believing it bumped a version, so `DeclaredDependency.constraint` carries `pinned` vs `range` and `DeclaredDependency.declaredIn` carries which file section it came from.

Lockfile-adjacent files (`poetry.lock`, `Pipfile.lock`, `*.txt` produced with `--hash`) are not read: ADR-0032 §8 forbids lockfile resolution outright, and §4 forbids storing the closure. A `pip freeze`-style `requirements.txt` IS effectively a closure, but it is what the component *declares* — this package reports the declaration in the file it was handed and does not go looking for a deeper one.

Tables read from `pyproject.toml`: - `[project].dependencies`               (PEP 621)  -> runtime - `[project.optional-dependencies].<g>`  (PEP 621)  -> runtime, group in `declaredIn` - `[dependency-groups].<g>`              (PEP 735)  -> dev   (the standard dev-group mechanism) - `[build-system].requires`              (PEP 518)  -> build (genuinely build-scope: needed to produce the wheel, never shipped in it) - `[tool.poetry.dependencies]`                      -> runtime - `[tool.poetry.group.<g>.dependencies]`            -> dev - `[tool.poetry.dev-dependencies]` (legacy)         -> dev

`python = "^3.11"` inside a Poetry dependency table is EXCLUDED: it is the interpreter constraint, not a package. Subscribing a component to "the 3.x line of python" via its dependency inventory would produce a bump commit that changes the supported interpreter range.

A PEP 508 environment marker (`; python_version < "3.9"`) does not change *which* package is declared, only whether it installs somewhere. It is stripped from the specifier and does not suppress the dependency — a conditionally-installed package still needs its security bumps.

### §74. PEP 508, where the leading anchor is load-bearing

PEP 508: `name [extras] specifier ; marker` or `name @ url ; marker`.

**The leading `[A-Za-z0-9]` anchor is load-bearing, not cosmetic.** It is the sole mechanism that keeps a `requirements.txt` OPTION line out of the inventory: `--only-binary numpy`, `-r base.txt`, `--index-url …` all begin with `-`, so they cannot match here and `parseRequirementsTxt` needs no separate leading-`-` test (there used to be one; it was provably unreachable, and dead code that reads as the enforcement is its own hazard — a later editor loosening this charset would have believed the other line was still holding the door). Anything that widens this character class — PEP 625 name normalisation, say — must re-check `--only-binary numpy`, whose argument is the one option argument that reads as a requirement.

The name charset is PEP 508's own (`[A-Za-z0-9]` with `.`, `-`, `_` internally). Extras are captured separately: `celery[redis]` and `celery` are the SAME distribution with different optional features, so the coordinate is `celery` and the extras go in the note. Keeping the extras in the coordinate would split one package into N inventory identities, and the reverse query ADR-0032 §4 relies on ("which components subscribe to P?") would miss them all.

### §75. A line whose leading token is a URL scheme

A `requirements.txt` line whose leading token is a URL SCHEME rather than a distribution name.

The rule is "the leading token is immediately followed by `+` or `:`" — decidable without knowing any scheme at all, and correct in all three directions this guard has been wrong in:

- **It is a delimiter test, not a prefix test.** A prefix test (`/^(https?|git\+|file:)/i`) discards every distribution whose NAME merely begins with a scheme word — httpx, httpcore, httptools, httplib2, httpie, filelock and gitpython are all real PyPI packages, and they vanished with no row, no note and no error. Silent deletion of a real dependency is the outcome `ManifestParseError` exists to prevent; producing it from a guard is that same failure inside one parser. - **It covers the whole class, not the one scheme somebody remembered.** pip documents FOUR VCS schemes: `git+`, `hg+`, `svn+`, `bzr+` (pip docs, "VCS Support"). A version of this guard that enumerated only `git+` let `hg+https://example/x` fall through to `PEP508_RE`, which read it as a distribution named `hg` — with `svn` and `bzr` behind it. Phantom package names that no index resolves, attached to a real component. - **A MALFORMED scheme is refused too, deliberately.** `http:example` (no `//`) and `git+https//broken` (no scheme colon) are neither URLs nor valid PEP 508: the name charset is `[A-Za-z0-9._-]` and no specifier operator begins with `+` or `:`, so nothing valid can look like this. Demanding a WELL-FORMED URL here would send exactly those two on to `PEP508_RE` and mint the coordinates `http` and `git` — a distribution named after the scheme of the URL somebody meant to type. Refusing matches `dockerfile.ts:209-214`, which skips `FROM :1.0` rather than minting an empty-name coordinate: a dependency carrying a WRONG identity is worse than one that is missing, because the missing one is visibly missing.

Enumerating schemes on top of this would buy nothing and cost something. The verdict for a well-formed and for a malformed VCS URL is identical — no row — so a scheme-listing regex ahead of this one could never change an outcome, i.e. it would be the dead-guard-that-reads-as-the- enforcement hazard described on `PEP508_RE`. The scheme list belongs in this comment and in the tests, where it is a statement about the world, not a branch that can quietly stop mattering.

Refusal is per-LINE, never a `ManifestParseError`: one mistyped URL does not mean the file is not a requirements.txt, and throwing would delete the inventory of every correctly-spelled line beside it.

### §76. Parse one requirement to coordinate and constraint

Parse one PEP 508 requirement string into a coordinate plus a classified constraint.

Returns `undefined` for a string that names no distribution at all (a bare URL, an empty line) — there is nothing to subscribe to, and inventing a coordinate from a URL's path would be exactly the "inferred from a name" mistake ADR-0030 §2 warns about.

### §77. One clause of a comma-separated specifier

One clause of a comma-separated specifier: an optional operator, then the version text.

Longest-first alternation so `>=` is never read as `>` and `~=` never as `~`. Poetry's own `^`/`~` are in the same set because `comparableFrom` is shared by both the PEP 508 path and the Poetry path below — Poetry writes `^2.32.3` where PEP 508 writes `>=2.32.3,<3`.

### §78. Operators whose clause names the declared floor

Operators whose clause names the FLOOR of the declared line — the version the component is at or above today. Everything absent from this set (`!=`, `<`, `<=`) names something the component is explicitly NOT at, and recording it as `DeclaredDependency.version` inverts the field's meaning: `sqlalchemy!=1.4.0,>=1.3` would record 1.4.0, the one version the manifest FORBIDS, and `urllib3<3,>=1.21.1` would record 3.0.0, a ceiling the component may never install. A detection tick reading either sees a component "already at" a version it is nowhere near and reports no upgrade.

This is not an exotic spelling. `packaging.SpecifierSet.__str__` sorts its clauses, and both `!` (0x21) and `<` (0x3C) sort before `>` (0x3E), so exclusion-first and ceiling-first is exactly what a pip-compile or PKG-INFO round-trip emits — the first clause is routinely NOT the floor.

`>` is included: `>2.0` excludes the endpoint but still names where the line starts, whereas `!=` punches a hole in an otherwise unbounded range and `<`/`<=` say nothing about the floor at all. The empty operator is included for Poetry's bare `2.0.32`, which names exactly one version.

Where NO clause denotes a floor, the answer is `undefined` — ADR-0032 §7's "skipped rather than guessed" applied to specifiers, and `DeclaredDependency.version`'s documented first-class outcome. A missed bump costs a tick; a guessed one costs a wrong commit in someone's repo.

### §79. Parse a `requirements.txt`

Parse a `requirements.txt`.

Option lines are skipped rather than parsed (by `PEP508_RE`'s anchor — see there): `-r base.txt` and `-c constraints.txt` point at ANOTHER FILE, and following them would be this package doing I/O, which it never does — the caller that fetched this file is the only thing that can fetch a second one. `-e .` is an editable install of the component itself, not a dependency of it.

Never throws. Unlike the other four parsers (see the entry point's contract note), a `requirements.txt` has no required construct whose absence proves the file is not one, so there is nothing to distinguish "empty" from "unreadable" on.

`--hash=sha256:…` fragments appended to a requirement are stripped: they pin bytes for an already pinned version and add nothing to the coordinate.

### §80. Option lines are not filtered here, and why

Option lines (`-r base.txt`, `-e .`, `--index-url …`, `--only-binary numpy`) are NOT filtered here. PEP508_RE's leading `[A-Za-z0-9]` anchor already excludes every line beginning with `-`, so the guard that used to sit on this line could not fire for any input — and a redundant guard that reads as the enforcement is worse than none, because the next person to widen the name charset checks the guard, sees it, and never looks at the anchor. The invariant now lives on PEP508_RE itself, where it is actually enforced. `parseRequirementsTxt` option-line behaviour stays pinned by its own tests below.

## `packages/dependency-manifests/src/toml-lite.ts`

### §81. A deliberately small TOML reader

A deliberately small TOML reader — just enough of the grammar to read the six tables `pyproject.toml` keeps dependencies in, and nothing more.

**Why hand-rolled rather than a dependency.** Charter principle 5 makes air-gap and offline builds first-class ("vendored tooling", no runtime network calls), and there is no TOML parser anywhere in the tree (checked at HEAD: no `@iarna/toml`, no `smol-toml`, no `toml` in any workspace `package.json`), so using one would mean adding a genuinely new vendored dependency for six table lookups.

**AMENDED (M21.7).** This comment used to say the package "deliberately has zero third-party dependencies so it can be dropped into an ephemeral runner image". Both halves are now qualified: the package takes exactly one dependency, `yaml`, for `kubernetes-images.ts` (`types.ts` records the trade and why a hand-rolled YAML subset was refused where a hand-rolled TOML subset was taken), and the runner image never contained this package at all — `apps/runner-dep/Dockerfile` is `FROM scratch` plus BusyBox, with no Node runtime. The argument for hand-rolling THIS reader is unchanged and does not rest on either: a new vendored dependency for six table lookups is a bad trade, and a line-oriented TOML scanner's failure mode is a missing table rather than a confidently wrong tree.

**What "small" means, precisely.** This reader understands: table headers (`[a.b]`), array-of-table headers (`[[a.b]]`), bare and quoted and dotted keys, basic and literal strings including their multi-line (`"""` / `'''`) forms, arrays (nested, multi-line, trailing commas), and inline tables. It does NOT understand dates, integers-with-underscores, floats or booleans as *values* — those are read as an opaque `other`, which is correct here because every value this package cares about is a string, an array of strings, or an inline table of them.

The multi-line string and array support is not gold-plating. Both appear constantly in real `pyproject.toml` files (`description = """…"""`, `classifiers = [ … ]` spanning 30 lines), and a line-oriented scanner that did not track them would mistake a `[Programming Language :: …]` classifier entry for a TABLE HEADER and start attributing subsequent keys to a table that does not exist. That is a silent wrong-answer bug, not a missing-feature bug.

Anything the reader cannot make sense of raises `ManifestParseError` rather than being skipped, so a manifest we misread cannot masquerade as a manifest that declares nothing.

### §82. Scan a TOML document into a flat triple list

Scan a TOML document into a flat list of `(table path, key, value)`.

A flat list, rather than a nested object, because every consumer here asks "give me the entries of table X" and a flat list answers that without any merge semantics — and merge semantics are where a partial TOML implementation gets subtly wrong (dotted keys inside a table header, the same table opened twice, arrays of tables). Keeping the shape flat keeps the reader honest about how little it claims to understand.

## `packages/dependency-manifests/src/types.ts`

### §83. The vocabulary every manifest parser here speaks

The vocabulary every manifest parser in this package speaks.

SCOPE OF THIS PACKAGE (ADR-0032 §4, "Direct declared dependencies only"): these parsers return **what a component's own manifest declares, and nothing else**. They never resolve, never fetch, never walk a lockfile, and never expand a transitive closure. That is not a simplification we chose for convenience — ADR-0013 keeps SBOM bytes out of SCP deliberately, and ADR-0032 §3's "nothing in the dependency path may expose a transitive traversal" is the boundary that justifies the whole projection-table representation. A parser here that returned a transitively-resolved set would silently dissolve that justification, so every parser is a pure string -> declarations function with no I/O of any kind.

The types below deliberately have no Zod counterpart in this package. Per CLAUDE.md, Zod schemas live in `packages/schemas`; when these declarations become API-visible they get a schema there that mirrors this file.

THE ZERO-DEPENDENCY PROPERTY WAS SPENT IN M21.7, ONCE, ON `yaml` — RECORDED, NOT QUIETLY TAKEN
This package used to have NO `dependencies` block at all, and hand-rolled the TOML and XML subsets it needed rather than take a library (charter principle 5 — everything must work offline). `kubernetes-images.ts` takes `yaml@^2.9.0`, and the trade is stated rather than implied:

- WHAT IT DOES NOT COST. `yaml@2.9.0` was already in the lockfile (`tools/helm-verify` and `deploy/airgap` both declare it) and resolves with NO transitive dependencies, so the offline install set does not grow by a single package and nothing new is fetched at build or run time. - WHY A HAND-ROLLED SUBSET WAS REFUSED. `toml-lite.ts`'s own argument runs the other way here: YAML's surface is significant indentation, block and flow collections, five scalar styles, anchors/aliases/merge keys and multi-document streams, and INDENTATION is precisely where a partial implementation returns a confidently wrong tree instead of an error. One values file can be the sole declaration site for a dozen images, and a wrong tree there prunes all of them. There is also a capability argument that settles it independently of size: reading a version through a node's JS value corrupts it (`tag: 1.20` parses to 1.2), so the parser needs the scalar's own SOURCE TEXT plus document and alias structure, which `yaml` exposes and a JSON-shaped reader does not. - WHAT WAS MEASURED ABOUT THE RUNNER, correcting the claim this comment used to make. The parsers were said to be "trivially usable from a runner image". `apps/runner-dep/Dockerfile` is `FROM scratch` plus a BusyBox multi-call binary and seven applets — it contains NO Node runtime and no JS at all, so no version of this package has ever been inside it. What the property actually buys is a small, auditable supply chain for the ORCHESTRATOR (`packages/plugins/managed-dep`, which imports these parsers and runs in a plugin subprocess) and for the air-gap bundle. That is still worth keeping, which is why this is the one.

### §84. The five ecosystems in scope, `oci` among them

The five ecosystems ADR-0032 §10 puts in scope, built "Go -> images -> npm -> Python -> Maven".

`oci` is a first-class member, not an afterthought: a `FROM alpine:1.0` that should become `alpine:1.1` is the owner's headline example (proposal §6.3) and container images are the one ecosystem with no air-gap gap, because the org's own registry is the index.

MUST stay identical to `DependencyEcosystemSchema` in `@scp/schemas/dependencies` — that Zod enum is what the API, the DB check constraint and the `(org, ecosystem, coordinate, major)` identity key all validate against, so a value this package emits and that one rejects is a row that cannot be written. This package deliberately does NOT import the schema (parsers stay dependency-free and pure), which is precisely why the two drifted once already: the container ecosystem was built here as `"image"` and there as `"oci"`, and nothing caught it because neither side's tests cross the boundary. `ecosystem-vocabulary.test.ts` now pins the two lists equal.

`oci`, NOT `image`: `image` is already a value of the executor `type` enum (`packages/schemas/src/executors.ts:32`), where it means "a build that PRODUCES an image artifact". This axis is what a component CONSUMES. Reusing one word across a produces/consumes boundary is the same collision class as bare `subscription` and bare `manifest`, both settled in GLOSSARY.md. (`npm` unavoidably appears in both enums with different senses — see the glossary note.)

### §85. Why the component depends on this thing

Why the component depends on this thing. Only recorded where the manifest FORMAT expresses it — we never infer a scope from a package's name, which is the ADR-0030 §2 / provenance-label lesson ("declared, never inferred"): a label named after what happened to match goes false the moment a second kind of thing matches it.

- `runtime` — shipped with, and needed by, the running component. - `dev`     — needed only to develop/test it (npm `devDependencies`, Maven `test`, PEP 735 groups). - `build`   — needed to produce the artifact but not shipped inside it (a Dockerfile `FROM`, `[build-system].requires`, Maven `provided`/`system`).

Formats that express no distinction at all (go.mod, requirements.txt) report `runtime` — see the per-parser doc comments, each of which says so explicitly rather than leaving it implied.

### §86. How precisely the manifest pins the dependency

How precisely the manifest pins the dependency. This is the "declared vs pinned differ, record which it was" distinction: `requests>=2.0` and `requests==2.31.0` are not the same statement, and a subscription actuator that treated them alike would rewrite a range as a pin.

- `pinned`     — exactly one version is named (`==2.31.0`, `v1.2.3` in go.mod, `alpine:3.19`). - `range`      — a set of acceptable versions (`^1.2.3`, `>=2.0,<3`, `[1.0,2.0)`). - `unpinned`   — the dependency is declared with no version constraint whatsoever (`FROM alpine`, a bare `requests` line, npm `"*"`). NOTE this is NOT recorded as "latest": Docker's implicit `:latest` and npm's `*` are RESOLUTION rules, and writing them into `declared` would be inventing text the author never wrote. - `unresolved` — a version is expressed but this package cannot know it without doing work it is forbidden to do: a Maven `${property}` or parent-POM inheritance, a Dockerfile `ARG` interpolation, a `git+https://`/`workspace:` npm specifier. Reported as unresolved rather than guessed — a wrong version here becomes a wrong bump.

### §87. A numeric version core, plus comparison context

A numeric version core extracted from a version string, plus enough context that a caller can refuse to compare two things that are not comparable. Produced only by `import("./version.js").parseComparableVersion` — never assembled by a parser by hand.

### §88. How many numeric components the string carried

How many numeric components the string ACTUALLY carried: 1 for `3`, 2 for `1.2`, 3 for `1.2.3`.

`minor`/`patch` are zero-filled so the triple is always comparable, but zero-filling is an assumption and `precision` is the receipt for it. An image tag `1.2` is a MOVING tag that today points at 1.2.7; treating it as the frozen point 1.2.0 without knowing you did so is how a subscription "bumps" a component backwards.

### §89. Everything after the numeric core, uninterpreted

Everything after the numeric core, verbatim and WITHOUT interpretation — `-alpine` from `1.2.3-alpine`, `-rc.1` from `1.2.3-rc.1`, `+build.5`.

Deliberately NOT called `prerelease`, and deliberately not given semver precedence semantics: in an OCI tag `-alpine` is a VARIANT (a different flavour of the same release), while semver says `1.2.3-alpine` sorts BEFORE `1.2.3`. Applying semver precedence to image tags would order a variant line wrongly, so ordering across differing suffixes is refused outright — see `import("./version.js").compareVersions`.

### §90. The coordinate in its ecosystem's own spelling

The dependency's coordinate in its ecosystem's OWN spelling, preserved verbatim — `@acme/lib`, `github.com/Masterminds/semver/v3`, `org.springframework:spring-core`, `ghcr.io/CommanderSCP/base`.

Verbatim matters: ADR-0032 Context 2 measured that SCP's URN slug lowercases and hyphenates, collapsing `@acme/lib`, `acme/lib` and `acme-lib` into one identity. That collapse is precisely why the inventory is a projection table keyed on this string and not a graph object, so this string is the identity and normalising it here would re-create the collision the design avoids.

### §91. The comparable core, or undefined when unparsed

The comparable numeric core of `declared`, or **undefined when it could not be parsed**.

Undefined is a first-class, expected outcome (ADR-0032 §7: "unparseable tags are skipped rather than guessed"). A caller MUST treat undefined as "cannot participate in a version comparison", never as a reason to fall back to string ordering.

### §92. Which part of the manifest this came from

Which part of the manifest this came from, in the manifest's own words — `require`, `devDependencies`, `FROM`, `project.optional-dependencies.test`, `build-system.requires`, `dependencies` (Maven). Carried for explainability (charter principle 6): a Decision that refuses a bump can say which block it read.

### §93. How many declaration sites fed this entry

HOW MANY DECLARATION SITES IN THIS FILE FED THIS ENTRY. `1` for an ordinary declaration; `n` when the parser MERGED n byte-identical declarations into one entry because the inventory row they produce merges (`kubernetes-images.ts` trap 9: `component_dependencies` is keyed `(org, component, line, manifest_path)`, so a Deployment and a CronJob both pinning `acme/api:1.2.3` in one file are ONE row however many times the file says it).

**Undefined means "this parser does not merge", which is the same as `1`** — read it as `occurrences ?? 1`. Only `parseKubernetesImages` sets it, because it is the only parser that can merge; the other four emit one entry per declaration site by construction.

IT EXISTS AS A NUMBER BECAUSE IT IS A GATE INPUT. `n > 1` means an edit to ONE of those sites would leave the others behind, so a bump actuator must refuse rather than pick — and until this field existed that fact lived only inside the human-readable `note`, where a gate would have had to match prose. See `@scp/plugin-managed-dep`'s `locateVersionLine` step 5.

### §94. Set when understood but still worth surfacing

Set when the entry is understood but something about it is worth surfacing — an unresolvable `ARG` interpolation, an inherited Maven version, a non-registry npm specifier. Human-readable, never parsed.

### §95. Thrown when a manifest is not the format it claims

Thrown when a manifest is not the format it claims to be at all (unparseable JSON, XML with no `<project>`), as opposed to a manifest that legitimately declares nothing.

These two MUST NOT collapse into the same empty array. "Zero dependencies" and "I could not read this file" produce identical inventory rows but mean opposite things, and the second one silently DELETES a component's whole dependency set on the next ingestion pass. This is the vacuous-test hazard in production form: an assertion of absence that is satisfied for the wrong reason.

## `packages/dependency-manifests/src/version.ts`

### §96. The one place a version string becomes comparable

THE single place that turns a version STRING into something comparable — and the single place allowed to answer "I cannot".

Why one shared helper rather than one per ecosystem: ADR-0032 §7 makes an absolute rule out of a behaviour that is easy to breach accidentally — *"Image tags are not semver, so a line carries a tag pattern plus a parsed-version extractor, unparseable tags are **skipped rather than guessed**"* — and the milestone DoD test-pins it ("Mutation: making the extractor fall back to string ordering fails it"). A rule enforced in five parsers is a rule with five places to regress; enforced in one function it has one. Every parser in this package obtains `DeclaredDependency.version` from here and nowhere else.

The failure this guards against is concrete. String-ordering tags gives `"9" > "10"` and `"1.2.3-alpine" < "1.2.3"`, so a subscription would happily "bump" a component from 10 to 9, or from a musl variant to a glibc one. Returning `undefined` costs a missed bump; guessing costs a wrong commit in someone's repo.

### §97. Numeric core + remainder

Numeric core + remainder.

- optional leading `v`/`V` — go.mod versions are `v1.2.3` and image tags are frequently `v1.2.3`; - one to three dot-separated numeric components (`3`, `1.2`, `1.2.3`); - a remainder that must begin with a separator (`-`, `+`, `_`, `.`) or an ASCII letter and then contain NO WHITESPACE, so `1.2.3-alpine`, `1.2.3+build.5`, `1.2.3.4` (Maven's fourth component) and PEP 440's `2.0rc1` are all accepted, while `1!2.0` (a PEP 440 epoch we do not model) and `1 2` are refused rather than silently truncated to `1`.

The no-whitespace rule on the remainder is not cosmetic, and it was added because a test caught the alternative getting it wrong: with a permissive `.*` remainder, npm's compound range `>=3.23.8 <4` parses as major 3, minor 23 with the whole of `.8 <4` swallowed as a suffix — a silently WRONG version rather than an honest `undefined`. A version token has no spaces in any of the five ecosystems; a string with one is a range or an expression, and ranges are not versions.

Anything that does not match this whole shape yields `undefined`. In particular `latest`, `stable`, `edge`, `alpine` and `main` have no numeric core and are refused.

A bare git sha is NOT refused here, and saying it was is the mistake this comment used to make. Roughly six shas in ten begin with a digit, and `1a2b3c4d` matches the shape above exactly: major 1, precision 1, suffix `a2b3c4d`. Two other mechanisms — not this one — are what keep it harmless, and a caller must not assume a parse means "this is a version": - `compareVersions` refuses any pair whose suffixes differ, so `1a2b3c4d` can never be ordered against a real tagged release; and - `parseImageTagVersion` refuses precision-1 tags by default, so it never enters a registry-side ranking. Refusing it HERE is not available: the same shape is a legitimate PEP 440 version (`2rc1`) and a legitimate image tag, and this function is the single door all five ecosystems use.

### §98. Extract a comparable triple, never a guess

Extract a comparable `(major, minor, patch)` from a version string, or `undefined` when the string cannot be understood. NEVER returns a guess.

Zero-filling: `1.2` yields `{major:1, minor:2, patch:0, precision:2}`. The zero-fill is what makes the triple comparable at all, and `precision` is the receipt that says it happened — see `ComparableVersion.precision` for why that receipt matters for moving image tags.

### §99. The image-tag door, with the one rule tags need

The image-tag door onto `parseComparableVersion`, with the one extra rule that OCI tags need and semver strings do not.

**A single numeric component is refused by default.** `20240115`, `20240116`, `7` and `12` are indistinguishable as strings: the first two are date stamps, the last two are major lines, and a registry offers no way to tell them apart (proposal §6.3: *"`1.2.3`, `1.2.3-alpine`, `1.2`, `latest` and date stamps all coexist, and a registry has no notion of a major line"*). Comparing a date stamp against a major line, or "bumping" a `7` line onto a `20240115` tag, is exactly the guess ADR-0032 §7 forbids — so tags carrying only one numeric component are SKIPPED.

A subscription that genuinely tracks a date-stamped line can lower `minPrecision` to 1 for that line explicitly. That is a declaration by the subscriber, which is allowed; the default inferring it is not.

### §100. Order two parsed versions, or refuse

Order two parsed versions, or refuse.

Returns `undefined` when the two carry DIFFERENT suffixes, because such a pair is not ordered by anything this package knows. `3.19-alpine` and `3.19-slim` are two variants of one release, not an upgrade path; `1.2.3-rc.1` and `1.2.3` differ by semver precedence rules that do not hold for OCI tags. Rather than apply semver precedence to strings that are frequently not semver, the comparison is declined and the caller must compare within a suffix (i.e. within a variant line).

Two versions with the SAME suffix — including both having none — are ordered numerically on (major, minor, patch). Differing `precision` does not block the comparison, but see `ComparableVersion.precision`: `1.2` is a moving tag, and a caller bumping onto it should know it is bumping onto a label rather than a point.

## `packages/dependency-manifests/vitest.config.ts`

### §101. The hook budget: a deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.
