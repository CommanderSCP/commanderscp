# scan-requirements

Reference for `apps/server/src/governance/scan-requirements.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 25 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. The six-tier label for a graph object type

The six-tier label for a graph object type. Only used for EXPLAINABILITY (which tier set the ceiling) — never for precedence, because there is no precedence in a MIN. An object type outside the four org-and-below tiers is reported at the `component` (deepest) label with its real `objectTypeId` carried alongside, so the mapping stays auditable instead of silently lying.

THIS IS ONLY AS HONEST AS THE ANCHOR IT IS GIVEN. It reads `match.matchedAt.objectId`'s type, so a scope kind with no anchor of its own reports the tier of wherever it was parked. `scope.group`'s ACTING half parks at the org root (`typeId: "organization"`), so it is reported as `org` — which is the truthful answer for a ceiling that genuinely applies org-wide whenever a member acts. Its OWNING half (ADR-0016 §2a) anchors at the actually-owned object, so it reports that object's real tier. Before the owning half existed, EVERY group-scoped ceiling read `org` regardless of what it governed, quietly breaking ADR-0016 §5's promise that a block can show which tier set the floor.

## §2. M22.0 (ADR-0033 §5)

M22.0 (ADR-0033 §5). The OPTIONAL rung between a service and its components (migration 0055). It shipped AFTER this function was written and fell through to `component` below, so an assembly-anchored ceiling enforced correctly and reported the WRONG tier — the same class of defect §2a fixed for group scope, at a rung added later. Nothing about the MERGE changes: `mergeScanThresholds` never reads a tier.

WALKING a rung is edge-generic and free (`containmentChain` matches on the `contains` edge, never on the parent's type, which is why 0055 shipped no resolver edit). NAMING one is not. If a third container level is ever added, every hardcoded rung list must be revisited — this switch and `APPROVAL_SCOPE_KEYWORDS` in gate-orchestrator.ts are the two that 0055 silently missed.

## §3. THE PER-TARGET GATHER

THE PER-TARGET GATHER — every input the pure AND consumes, built from the graph, for each target independently.

EXTRACTED IN M22.8, NOT REWRITTEN. `GET /components/{idOrUrn}/scan-requirements` has to answer "which exclusion classes are admitted here, and where would a clause have effect" — which is a question about ADMISSIONS and REPRESENTED TIERS, neither of which survives into `EffectiveScanExclusions` (that type carries only the clauses that already won). Rebuilding the gather in the read module would have produced a second construction of the AND's inputs, one edit away from the read surface and the gate disagreeing about what is admitted — which is the exact class of divergence M22.2 closed at `promotion-scan-step.ts`'s `firedPolicies: []`.

So there is ONE gather, and both consumers call it. `resolveEffectiveScanExclusionsForTargets` feeds it to the pure resolver and then attaches the per-class FACTS; the read surface feeds it to the same pure resolver and reads the admissions off it directly, resolving no facts.

## §4. M22.6 (D3), THE DERIVED BAR

M22.6 (D3), THE DERIVED BAR — the tier an override grant must have been approved at-or-above, read off the RULE rather than off the request.

PURE, and the one place the bar is computed. The ceiling's `contributors` are the provenance M22.0 put into the gate Decision precisely so a block could name the tier that bound it; this is the second consumer of that provenance and the reason it had to be recorded rather than merged away.

THE MOST SENIOR CONTRIBUTOR WINS, not the one whose value happens to be the per-severity MIN. Excluding a finding removes it from the COUNT, which loosens EVERY ceiling on that severity at once — a count of 6 dropping to 5 satisfies a platform ceiling of 5 exactly as it satisfies the service ceiling of 0 that produced the block. Keying on the binding contributor alone would let a junior tier defeat a senior tier's ceiling indirectly, which is the escalation D3 exists to forbid.

THERE IS NO SUCH THING AS "NO CEILING", WHICH IS WHY THE BAR NEVER FALLS BELOW `org`.

This docblock used to say the opposite — that with no contributors the bar is `component`, i.e. no bar, because "there is no constraint stricter than the requester's own authority to escalate past, and the control falls back to its own per-binding `config.threshold`". That sentence names the counter-example in its own final clause and was wrong on both halves:

```text
* `config.threshold` IS a constraint. It is authored at the CONTROL object's scope
  (`routes/governance.ts`'s `PUT /controls/:idOrUrn/binding`, guarded by `policy:write` AT THE
  CONTROL), which is nowhere on the component's containment chain. A service- or component-scoped
  principal cannot author it and therefore must not be able to waive it.
* When neither a policy nor the binding config decides a severity, the plugin does not stop
  enforcing — it applies its historical fail-closed default of `maxCritical`/`maxHigh` = 0
  (`scan-result-control/src/index.ts`, `critical.value ?? 0`, and that module's own docblock says
  so). That is a PLATFORM-SHIPPED rule no tenant can edit at all.
```

Exclusions are applied BEFORE the counts are compared, so an approved grant on the only CRITICAL turns a fail into a pass against whichever of those ceilings is in force. With the bar at `component`, every candidate that merely sat on the chain cleared it — so a team lead holding a routine service-scoped `policy:write` could raise and approve a waiver against a ceiling they had no standing over. That is precisely the escalation D3 exists to forbid.

THE FLOOR IS `org` (owner decision, 2026-08-18), and it is a floor rather than the fully-derived answer on purpose. Deriving the true bar — injecting the binding config and the 0/0 default as synthetic contributors — was costed and REJECTED because it makes every grant inert on any deployment that authored no `scanThreshold` policy and no `config.threshold`, killing the feature outright for the common case. `org` is the most senior rung a TENANT can author at, so it is the strongest bar that still leaves the override usable: a component-, assembly-, service- or containment-domain-scoped grant can never clear it, while an org-tier grant keeps working.

WHAT THE FLOOR DOES NOT CLOSE, stated because a partial guard read as a total one is worse than none: an ORG-tier approver can still waive a `config.threshold` authored at control scope. Closing that requires the full derivation above and its cost. `platform`/`trust_domain` contributions still raise the bar past `org` normally — the floor only ever tightens the bottom, never loosens the top.
