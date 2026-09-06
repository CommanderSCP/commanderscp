# promotion-scan-step

Reference for `apps/server/src/federation/promotion-scan-step.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 25 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE COMMANDER-SIDE PROMOTION SCAN STEP

THE COMMANDER-SIDE PROMOTION SCAN STEP (ADR-0020 §1, proposal §13.3, charter's Managed Execution Exception 2026-07-23 amendment) — the crux of first-class commander scanning.

This is a step of the COMMANDER's promotion/export journey, NOT a tenant executor binding. For a change being exported it deposits, for EACH substantive artifact (the E6 `substantiveArtifacts` set — everything except `type: "blob"`), a digest-bound `control_runs` scan outcome, so that the UNCHANGED E6 gate (`evaluatePromotionScanGate`, promotion-repo.ts) then reads those rows and PASSES for a clean artifact / REFUSES for a dirty-or-unscanned one. This module writes evidence; it does not touch the gate.

PER ARTIFACT (proposal §13.3): (a) SHORT-CIRCUIT — if a covering org-pipeline (or prior managed) `control_runs` scan outcome already covers this digest, SKIP the managed run: org evidence wins, the D1 alternate ingress, and the runner is never invoked. "Covering" is not enumerated here on purpose — this list used to spell it as "status `pass` + `ScanEvidenceSchema` valid + `digestMatch` + `artifactDigest` match, the exact E6 predicate", which stopped being the whole rule the moment E6 grew producer admission, supersession, the instance floor and (M22.9) exclusion-set currency. It is ONE function, `evaluateScanCoverage` in `scan-evidence.ts`, and that module doc is where the rule is stated. (b) SCANNER SELECTION — `resolveScannersForType(the artifact's ExecutorType)` → methods. If EMPTY, NO managed evidence is produced (fail-closed: E6 will refuse — we never fabricate a pass for an unassigned type). (c) THE SERVER pulls the artifact's bytes BY DIGEST over the allowlisted skopeo channel (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS`, ADR-0019 §4) into a scratch OCI layout — the runner itself gets NO network. (d) run the `scp-managed-scan` plugin per method (`--network none` ephemeral container). (e) evaluate the returned `severityCounts` against the resolved M17.5 threshold (`resolveEffectiveScanThreshold` — reused, not reimplemented) → status pass/fail. (f) DEPOSIT a `control_runs` row (`insertControlRun`) whose evidence is a valid `ScanEvidence` with `scanner = method`, `artifactDigest =` the pulled+normalized digest (which MUST equal the promoted digest for `digestMatch: true`), and the threshold provenance.

FAIL-CLOSED throughout: an unassigned type, an unavailable dispatch/runner, an unresolvable pull ref, or a scanner error all yield NO passing managed evidence — so E6 refuses (never a fabricated pass). The one scan runs once at the commander before signing (ADR-0020 §4); downstream never re-scans.

## §2. THE EXCLUSION SET IN FORCE FOR A CHANGE

THE EXCLUSION SET IN FORCE FOR A CHANGE — one resolution, because the export path now has TWO consumers of the answer and a difference between them is indistinguishable from a withdrawn waiver.

The step below resolves the set to APPLY it (exclude-before-counting, phase B) and stamps `scanExclusionSetHash` onto every verdict it deposits. `promotion-repo.ts`'s E6 gate resolves it to CHECK that a cached verdict was judged under it (M22.9). If the two assembled their inputs separately — a target list read differently, a firing set resolved from a different CEL pass, a different actor — the two hashes would differ for a reason nobody authored, and EVERY export of a change carrying an exclusion would refuse `stale_exclusion_set` forever. That is the failure this function exists to make unreachable; the alternative considered was a second copy of these ~20 lines in `promotion-repo.ts`, kept in step by a comment.

`matches`/`fired` come back with the answer because the CEILING dimension resolves off the SAME firing set (below) — re-running the CEL evaluation to obtain it a second time would be both a wasted worker round-trip and a second chance for the two dimensions to disagree.

M22.2 — THE FIRING SET, FOR REAL. This used to be `firedPolicies: []`.

An empty firing set admits the instance-level floors (platform/trust_domain, always read) plus the fail-closed default, and NOTHING authored at org, containment domain, service, assembly or component. That was a documented follow-on and it was defensible while the only dimension was a TIGHTENING — the 0/0 default already refuses any Critical or High, so a missing scoped ceiling could only ever make this step stricter than the gate.

It stops being defensible the moment a LOOSENING exists. An exclusion resolved by the lifecycle gate would be invisible here, so the commander's own managed scan would count findings the gate had agreed not to count — the two paths disagreeing about the same artifact at exactly the boundary where evidence is FROZEN into a signed bundle and the E6 export gate reads it. So both dimensions resolve off the SAME firing set the gate would compute.

THIS IS A BEHAVIOUR CHANGE FOR THE CEILING TOO, and in both directions — stated rather than buried. A scoped policy that sets `maxHigh: 5` now applies here, where before this step used the 0/0 default; a scoped policy that sets `maxHigh: 0` now applies where before nothing did. Convergence with the lifecycle gate is the point: two verdicts about one artifact must not be produced under two different rules.

The sandbox is a THUNK. `new CelSandbox()` spawns its worker pool in the constructor, and `resolveFiredPolicies` calls `evaluate` only for a contributor that actually carries a `condition` — so an org whose policies have no conditions spins up no worker threads.

RESOLVED AS THE ACTOR WHO IS CROSSING THE BOUNDARY, which is a real and accepted limitation: an exclusion policy scoped to an ACTING GROUP resolves differently for the exporter than it did for the engineer whose gate run stamped the evidence, and the difference reads here as a moved set. The consequence is a refusal (or a re-scan), never a crossing — the direction a boundary check is allowed to be wrong in.

## §3. M22.1b — `never`, not "empty"

M22.1b — `never`, not "empty". An XCCDF rule-result has no package, no purl, no `FixedVersion` and no `Class`, so there is no per-finding material for an exclusion to match on and no way to invent one. Typed as `never` so an attempt to populate it is a COMPILE error rather than a runtime surprise — but note the enforcement that matters is `persistScanFindings` refusing on the METHOD, which holds even for a caller that never sees this type.
