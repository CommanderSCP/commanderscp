# supply-chain

Reference for `packages/schemas/src/supply-chain.ts`. The source carries a one-line headline at each site and points here.

> Partial: 14 of 70 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE SHARED TRIVY PARSE

THE SHARED TRIVY PARSE — the single source of truth for both verdict producers.

This lives here rather than being duplicated because an earlier draft of ADR-0033 asserted that "a plugin cannot import `@scp/schemas`" and designed a duplicated parser with a cross-boundary conformance test to keep the copies honest. That premise was FALSE: `@scp/plugin-scan-result-control` already declares `@scp/schemas` as a dependency and already imports values from it. Two hand-synced parse loops with identical semantics is precisely the shape where a fix lands in one and the paths diverge silently, so the copies are now one function.

TOTAL AND DEFENSIVE, exactly as both originals were: a malformed or partial document yields an empty array (and therefore zero counts) rather than throwing. The runner already fails the run for a broken scan, so this path normally sees a real result.

PER-ENTRY, NOT PER-CVE. One finding per `Vulnerabilities[]` element, with no de-duplication — the same CVE affecting three packages counts three times, because that is what both parsers did before this. De-duplicating would be defensible and is NOT done here: it would change every operator's numbers on the day this ships.

`UNKNOWN` (and any unrecognized severity) is dropped, unchanged from both originals.

## §2. The class a finding row is written with

The class a finding row is written with. M22.2 landed the exclusion dimension, so the `E` arm is now REACHED in production: a finding an admitted clause excluded is accepted-risk evidence explaining a live verdict, and is written `E` in the same transaction as the verdict itself. Every other row stays `O` — telemetry about what a scanner saw.

## §3. M22.4 (ADR-0033 D1)

M22.4 (ADR-0033 D1) — THE VENDOR RULE'S FACTS.

The owner's headline rule: a vendor dependency is accepted only if we are on the LATEST VERSION OF A MAJOR VERSION. That maps exactly onto `dependency_lines`' identity `(org_id, ecosystem, coordinate, major)` — being "at the head" of the line a declaration sits on.

WHY THE FACTS TRAVEL AS DATA RATHER THAN BEING LOOKED UP. The exclusion set is resolved at GATE time, before any scan has been read, and it is then handed to a PLUGIN that has no database and no lookup ability. So every fact the rule needs is resolved server-side against the ADR-0032 inventory and serialized here; the matcher below is pure and reaches nothing.

THREE FINDING CLASSES, TWO REACHABLE (ADR-0033 "costs/honesty"): - `os-pkgs`   — attributable to the BASE IMAGE line. `dockerfile.ts` parses every real `FROM` into a declared `oci` dependency, so "we are on the latest base image" is a fact about that line and it earns every OS-package finding a pass. - `lang-pkgs` with a DECLARED line — attributable to its own line, via `packageKeys`, AND ONLY AT THE VERSION THE ARTIFACT ACTUALLY SHIPS (see `vendorLatestPackageKey`). - `lang-pkgs` TRANSITIVE — NO line of its own, and so no key of its own. This line used to read "and therefore NO pass", which was FALSE for as long as the key carried no version: a transitive `lodash@3.10.1` matched the key emitted for a DECLARED `lodash@4.17.21` at head, because the two differed only in the field the key threw away. With the version in the key, a transitive is excused only when it sits at exactly the version some declared line is at the head of — the same bytes the manifest asked for, which is not a transitive escaping the rule. Anything else is fixed by moving the DIRECT parent that pulls it, and that parent has a line of its own.

## §4. purl `type` → this project's `DependencyEcosystem`

purl `type` → this project's `DependencyEcosystem`. A purl whose type is not one of the four LANGUAGE ecosystems (an `apk`/`deb`/`rpm` OS package, an unknown type, a malformed string) yields `undefined`, and a finding with no ecosystem can match no package key — the fail-closed direction. `oci` is deliberately ABSENT from this map: an image is never a `lang-pkgs` finding, and the base image is reached through `ScanVendorLatestFactsSchema.baseImageAtLatest` instead.

## §5. THE REQUEST-BODY VALIDATOR

THE REQUEST-BODY VALIDATOR — `z.strictObject`, and this is the guard ADR-0033 §6 names explicitly.

WHY STRICT HERE AND OPEN IN THE MIGRATION, which is not an inconsistency but the whole design. `import-repo.ts`'s `object_upsert` branch Ajv-validates an incoming object against the registered `property_schema` with NO `try/catch`, so ONE rejection aborts a peer's ENTIRE signed bundle and wedges the channel. A closed schema in the registry would therefore make every future property addition a fail-closed version-skew hazard — 0043's rule, and 0051's header restates it. So the registry stays OPEN and the strictness moves to the LOCAL author's door, where a refusal costs one 400 and nobody's bundle.

The strictness is load-bearing rather than tidy: `{"declarationz": {...}}` or `{"declarations": {...}, "egress": "none"}` would otherwise be stored, read as NO declarations, and the component owner would believe they had declared something. For a LOOSENING that mistake is only ever fail-closed — but it is silent, and the author has no way to discover it.

## §6. THE DERIVED BAR

THE DERIVED BAR (D3). The most senior tier that set any part of the ceiling this exclusion would loosen, and never below `org` — a bar of `component` used to mean "no tier set one", which was false: the control binding's `config.threshold` and the plugin's shipped fail-closed 0/0 are ceilings no tenant below `org` can author. See `requiredOverrideApprovalTier`. Present whenever the override dimension was resolved — it is the rule the grants above were measured against, and a Decision that named the grants without naming the bar would explain half of the verdict.

## §7. A grant's lifecycle, held in `properties.status`

A grant's lifecycle, held in `properties.status`.

FOUR STATES, and `expired` is deliberately NOT one of them. Expiry is a READ-TIME SQL WINDOW (ADR-0033 §6a) — `expiresAt > now()` evaluated by the resolver on every read — never a status a background job flips, because there is no sweeper anywhere in this tree and no `boss.schedule` usage to build one on. A fifth `expired` value would be a promise that something transitions rows into it, and nothing would.

`denied` and `revoked` are distinct on purpose: one is "this was never granted", the other is "this was granted and has been taken back", and an auditor reading a Decision that cites a grant needs to be able to tell those apart.

## §8. RAISING a request

RAISING a request. `tierObjectId` names the object whose tier set the rule the requester wants waived. It is constitutive of the request rather than something the approver supplies later.

IT IS A CLAIM, NOT A GRANT OF STANDING, and the difference is load-bearing. The first version of this comment said "naming a tier confers nothing: the approval check runs against the named object" — which was false in the one direction that mattered. `authz/resolve.ts`'s `scopeExpandCte` expands UPWARD, so naming a LOWER object strictly WIDENS the set of principals whose bindings satisfy the approve check. A requester could therefore select their own approver standing by naming an object they already held `policy:write` at, and waive a ceiling set far above it. Three derived checks now bound the claim, none of which trusts it:

```text
1. AT RAISE — the named object must lie on the component's own containment chain
   (`assertOverrideTierStanding`). An object elsewhere in the graph has no standing over this
   component at all.
2. AT APPROVE — the same chain check, re-derived, plus a refusal when an INSTANCE floor
   (`platform`/`trust_domain`) contributes any ceiling: those rungs are operator-authored and no
   tenant object maps to them, so such a grant could never apply and approving it would leave
   the approver with a false belief.
3. AT THE GATE — the decisive one. The resolver places `tierObjectId` on the target's chain,
   reads its TIER from that placement, and drops the grant unless that tier is at-or-above the
   most senior tier that contributed to the effective ceiling. That comparison is derived from
   `EffectiveScanThreshold.contributors`, which M22.0 recorded precisely so a verdict can name
   the tier that bound it.
```

## §9. WHY EVERY EXCLUSION FOR A SCAN WAS REFUSED

WHY EVERY EXCLUSION FOR A SCAN WAS REFUSED — a positive statement, never an inference from an empty applied list.

```text
`truncated`    — the persisted finding set hit `SCAN_FINDINGS_PERSIST_CAP`. "You cannot except
                 what you did not record" (ADR-0033 §7).
`unsupported`  — this scanner family carries no per-finding material at all. OpenSCAP: XCCDF
                 rule-results have no package, no purl, no `FixedVersion`, no `Class`, and
                 XCCDF emits no `critical`. ADR-0033's consequences list requires this be
                 explicit and tested rather than left to "there were no findings to exclude".
`not_recorded` — no finding set was recorded at all (a pre-M22.1b verdict, or a producer whose
                 payload did not survive validation).
```

## §10. THE CLASS'S OWN PREDICATE

THE CLASS'S OWN PREDICATE — the half of a clause that the class name promises.

A clause is `class` + narrowing matchers, and the class is NOT merely a label for admission: it is an assertion about the finding. A `no_fix_available` clause that excluded a finding which HAS a fix would make the Decision misdescribe its own inputs (charter principle 6), so the class is enforced as a conjunct, not trusted as a name.

`undefined` means THIS CLAUSE CANNOT BE RESOLVED, and it then yields NO exclusion. All four classes are now built (`vendor_latest` an ADR-0032 inventory join, `declared_fact` a typed component property, `approved_override` a standing grant with a read-time expiry window), so `undefined` no longer means "not written yet" — it means THE FACTS THIS CLAUSE NEEDS WERE NOT RESOLVED, which is the ordinary shape of every one of ADR-0033's fail-closed cases: no inventory, no declaration, no live grant. That the two states share a return value is deliberate and the reason is unchanged: a clause whose input is missing must fail CLOSED rather than degrade into "the matchers alone". Degrading would mean `{"class": "approved_override", "pkgName": "openssl"}` excluded every openssl finding — a blanket waiver written as an exception.

EXHAUSTIVE over `ScanExclusionClass` on purpose: a fifth class added later is a compile error here, forcing a decision, rather than silently inheriting either arm.

## §11. A LANGUAGE PACKAGE → ITS OWN DECLARED LINE

A LANGUAGE PACKAGE → ITS OWN DECLARED LINE. `pkgName` is the join key rather than the purl's own name segment because Trivy spells a package the way its ecosystem does — `@babel/core`, `com.acme:lib`, `github.com/acme/lib` — which is exactly how the manifest parsers spell a coordinate. The purl is read for the ECOSYSTEM only, and a finding with no purl (or a purl of an OS type) yields no ecosystem and therefore no match: the alternative, matching a bare name across all four ecosystems, would let a transitive npm `requests` be excused by a declared Python `requests` at head.

## §12. NO `InstalledVersion` ⇒ NO PASS

NO `InstalledVersion` ⇒ NO PASS. `parseTrivyFindings` retains an entry on its severity alone, so a finding with no installed version is a real shape, and it is one this rule cannot answer: the facts say which VERSION of a package is at head, and a finding that will not say which version it is cannot be shown to be that one.

MEASURED, NOT ASSUMED: deleting this line alone changes no behaviour — every key in the set is built from a non-null `resolved_version`, so a `…|undefined` lookup misses anyway, and the mutation run confirmed the suite stays green. It is kept because it is what makes the required third parameter below type-check, and that is the load-bearing part: without it the only way to compile is to coerce the missing version or to drop it from the lookup, and THAT mutation (degrading to a name-prefix match) kills four tests. Stated here rather than left as a line a future reader deletes as dead.

## §13. WHICH scan method produced this verdict

WHICH scan method produced this verdict. Widened from `z.literal("trivy")` to `ScanMethodSchema` (ADR-0020 §2 / proposal §13.3, 13.3a) — this was designed as a field "so a future second scanner slots in without a shape change", and `openscap` is that second scanner (`trivy-vm`, the machine-image arm, is the third). The widening is strictly ADDITIVE and GATE-INVISIBLE: `trivy` is still accepted, so every existing evidence document (and the E6 export gate's `ScanEvidenceSchema.safeParse`, promotion-repo.ts) parses byte-for-byte unchanged; the gate reads only `digestMatch`/`artifactDigest`, never `scanner`.

## §14. A REFERENCE to a build-time SBOM

A REFERENCE to a build-time SBOM. Never the document itself.

`digest` is the SBOM DOCUMENT's own content digest (what the reader must verify the fetched bytes hash to) — it is NOT the artifact digest; the artifact this SBOM describes is the change's own `sourceRef.artifact_digest`, which travels alongside it on the same report.

M10.6 `.strict()`: this is the field-level half of the M10.6 discipline (`ChangeReportRequestSchema`'s own doc comment) — SCP has no column, no codec, and no route that stores SBOM bytes, and this is what makes "no way to smuggle the document inside the reference" an ENFORCED refusal (400 naming the unknown key) rather than a silent strip. A REFERENCE has a small, closed field set on purpose; an SBOM DOCUMENT (e.g. a `document`/`bomFormat`/`components` field) is exactly what `.strict()` now refuses.
