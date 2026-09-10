# dependencies

Long-form reference for the **dependencies** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 447 of 447 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/dependencies/bump-actuator.ts`](#apps-server-src-dependencies-bump-actuator-ts) — §1–§16
- [`apps/server/src/dependencies/bump-authorship-repo.ts`](#apps-server-src-dependencies-bump-authorship-repo-ts) — §17–§28
- [`apps/server/src/dependencies/bump-dispatch.integration.test.ts`](#apps-server-src-dependencies-bump-dispatch-integration-test-ts) — §29–§69
- [`apps/server/src/dependencies/bump-dispatch.test.ts`](#apps-server-src-dependencies-bump-dispatch-test-ts) — §70–§78
- [`apps/server/src/dependencies/bump-dispatch.ts`](#apps-server-src-dependencies-bump-dispatch-ts) — §79–§95
- [`apps/server/src/dependencies/bump-freeze-redrive.ts`](#apps-server-src-dependencies-bump-freeze-redrive-ts) — §96–§101
- [`apps/server/src/dependencies/bump-gate.test.ts`](#apps-server-src-dependencies-bump-gate-test-ts) — §102–§107
- [`apps/server/src/dependencies/bump-gate.ts`](#apps-server-src-dependencies-bump-gate-ts) — §108–§119
- [`apps/server/src/dependencies/bump-merge-freeze.ts`](#apps-server-src-dependencies-bump-merge-freeze-ts) — §120–§122
- [`apps/server/src/dependencies/bump-provenance.integration.test.ts`](#apps-server-src-dependencies-bump-provenance-integration-test-ts) — §123–§129
- [`apps/server/src/dependencies/commander-only.test.ts`](#apps-server-src-dependencies-commander-only-test-ts) — §130–§142
- [`apps/server/src/dependencies/commander-only.ts`](#apps-server-src-dependencies-commander-only-ts) — §143–§146
- [`apps/server/src/dependencies/component-ingestion-gate.test.ts`](#apps-server-src-dependencies-component-ingestion-gate-test-ts) — §147–§149
- [`apps/server/src/dependencies/delegation-detection.test.ts`](#apps-server-src-dependencies-delegation-detection-test-ts) — §150–§152
- [`apps/server/src/dependencies/delegation-detection.ts`](#apps-server-src-dependencies-delegation-detection-ts) — §153–§163
- [`apps/server/src/dependencies/dependency-inventory-repo.ts`](#apps-server-src-dependencies-dependency-inventory-repo-ts) — §164–§184
- [`apps/server/src/dependencies/dependency-inventory-routes.integration.test.ts`](#apps-server-src-dependencies-dependency-inventory-routes-integration-test-ts) — §185–§186
- [`apps/server/src/dependencies/dependency-inventory.integration.test.ts`](#apps-server-src-dependencies-dependency-inventory-integration-test-ts) — §187–§203
- [`apps/server/src/dependencies/dependency-read-surface.ts`](#apps-server-src-dependencies-dependency-read-surface-ts) — §204–§209
- [`apps/server/src/dependencies/ingestion-stamp-repo.test.ts`](#apps-server-src-dependencies-ingestion-stamp-repo-test-ts) — §210–§210
- [`apps/server/src/dependencies/ingestion-stamp-repo.ts`](#apps-server-src-dependencies-ingestion-stamp-repo-ts) — §211–§219
- [`apps/server/src/dependencies/internal-release-detection.integration.test.ts`](#apps-server-src-dependencies-internal-release-detection-integration-test-ts) — §220–§227
- [`apps/server/src/dependencies/internal-release-detection.ts`](#apps-server-src-dependencies-internal-release-detection-ts) — §228–§238
- [`apps/server/src/dependencies/internal-release-loop.test.ts`](#apps-server-src-dependencies-internal-release-loop-test-ts) — §239–§242
- [`apps/server/src/dependencies/internal-release-loop.ts`](#apps-server-src-dependencies-internal-release-loop-ts) — §243–§246
- [`apps/server/src/dependencies/internal-release-version.test.ts`](#apps-server-src-dependencies-internal-release-version-test-ts) — §247–§249
- [`apps/server/src/dependencies/internal-release-version.ts`](#apps-server-src-dependencies-internal-release-version-ts) — §250–§258
- [`apps/server/src/dependencies/inventory-ingestion-loop.test.ts`](#apps-server-src-dependencies-inventory-ingestion-loop-test-ts) — §259–§261
- [`apps/server/src/dependencies/inventory-ingestion-loop.ts`](#apps-server-src-dependencies-inventory-ingestion-loop-ts) — §262–§267
- [`apps/server/src/dependencies/inventory-ingestion.integration.test.ts`](#apps-server-src-dependencies-inventory-ingestion-integration-test-ts) — §268–§286
- [`apps/server/src/dependencies/inventory-ingestion.test.ts`](#apps-server-src-dependencies-inventory-ingestion-test-ts) — §287–§293
- [`apps/server/src/dependencies/inventory-ingestion.ts`](#apps-server-src-dependencies-inventory-ingestion-ts) — §294–§319
- [`apps/server/src/dependencies/line-head-restatement-pin.integration.test.ts`](#apps-server-src-dependencies-line-head-restatement-pin-integration-test-ts) — §320–§320
- [`apps/server/src/dependencies/line-head.test.ts`](#apps-server-src-dependencies-line-head-test-ts) — §321–§325
- [`apps/server/src/dependencies/line-head.ts`](#apps-server-src-dependencies-line-head-ts) — §326–§336
- [`apps/server/src/dependencies/managed-dep-instance.ts`](#apps-server-src-dependencies-managed-dep-instance-ts) — §337–§340
- [`apps/server/src/dependencies/manifest-reader.test.ts`](#apps-server-src-dependencies-manifest-reader-test-ts) — §341–§341
- [`apps/server/src/dependencies/manifest-reader.ts`](#apps-server-src-dependencies-manifest-reader-ts) — §342–§347
- [`apps/server/src/dependencies/producer-declaration.ts`](#apps-server-src-dependencies-producer-declaration-ts) — §348–§358
- [`apps/server/src/dependencies/subscription-authoring-guard.integration.test.ts`](#apps-server-src-dependencies-subscription-authoring-guard-integration-test-ts) — §359–§361
- [`apps/server/src/dependencies/subscription-authoring-guard.test.ts`](#apps-server-src-dependencies-subscription-authoring-guard-test-ts) — §362–§364
- [`apps/server/src/dependencies/subscription-authoring-guard.ts`](#apps-server-src-dependencies-subscription-authoring-guard-ts) — §365–§369
- [`apps/server/src/dependencies/subscription-guard-write-doors.integration.test.ts`](#apps-server-src-dependencies-subscription-guard-write-doors-integration-test-ts) — §370–§371
- [`apps/server/src/dependencies/subscription-resolution.integration.test.ts`](#apps-server-src-dependencies-subscription-resolution-integration-test-ts) — §372–§374
- [`apps/server/src/dependencies/subscription-resolution.test.ts`](#apps-server-src-dependencies-subscription-resolution-test-ts) — §375–§376
- [`apps/server/src/dependencies/subscription-resolution.ts`](#apps-server-src-dependencies-subscription-resolution-ts) — §377–§400
- [`apps/server/src/dependencies/version-index-feed.test.ts`](#apps-server-src-dependencies-version-index-feed-test-ts) — §401–§402
- [`apps/server/src/dependencies/version-index-feed.ts`](#apps-server-src-dependencies-version-index-feed-ts) — §403–§408
- [`apps/server/src/dependencies/version-index.test.ts`](#apps-server-src-dependencies-version-index-test-ts) — §409–§412
- [`apps/server/src/dependencies/version-index.ts`](#apps-server-src-dependencies-version-index-ts) — §413–§419
- [`apps/server/src/dependencies/version-poll.integration.test.ts`](#apps-server-src-dependencies-version-poll-integration-test-ts) — §420–§428
- [`apps/server/src/dependencies/version-poll.test.ts`](#apps-server-src-dependencies-version-poll-test-ts) — §429–§434
- [`apps/server/src/dependencies/version-poll.ts`](#apps-server-src-dependencies-version-poll-ts) — §435–§447

## `apps/server/src/dependencies/bump-actuator.ts`

### §1. M21.5 — THE ACTUATOR SEAM

M21.5 — THE ACTUATOR SEAM: what the server decides BEFORE `scp-managed-dep` is dispatched, and what it records so the commit that comes back is recognised as its own.

Three things live here, and nothing else does. The plugin performs the edit and the write; the subscription resolution (M21.3) decides who is subscribed; this is only the narrow band between them where the SERVER has to make a decision the plugin structurally cannot.

```text
1. THE DELEGATION RE-CHECK (`assertComponentNotDelegated`) — the other half of the
   authoring-time refusal, for the components the authoring-time refusal cannot see.
2. THE DELIVERY RESOLUTION (`resolveEffectiveDelivery`) — auto-merge is downgraded to a
   pull request unless a governed control already evidenced the component's own checks passed.
3. THE BUMP CHANGE (`recordBumpChange`) — recorded so that the push webhook this bump
   eventually produces CORRELATES TO IT rather than minting a second, unrelated change.
```

### §2. The branch prefix `@scp/plugin-managed-dep` authors under

The branch prefix `@scp/plugin-managed-dep` authors under. Restated here rather than imported so the server does not take a build-time dependency on a plugin package for a string the CORRELATION path needs; `delegation-detection.test.ts`'s "the authored-branch contract" block pins the two against each other — along with the descriptor `buildBumpIntentParameters` emits — which is the seam where a drift would actually hurt.

### §3. Can this build's runner edit a manifest at this path

CAN THIS BUILD'S RUNNER EDIT A MANIFEST AT THIS PATH FOR THIS ECOSYSTEM?

`@scp/plugin-managed-dep`'s `MANIFEST_MATCHERS` is the charter-enforcement allowlist — "SCP never edits a file that declares no dependency", made structural and fail-closed inside the plugin. This is a RESTATEMENT of the same closed set on the dispatch side, following the convention `BUMP_BRANCH_PREFIX` already sets: the server does not take a build-time dependency on a plugin package, and `bump-dispatch.test.ts`'s "the write allowlist, pinned across the two modules that restate it" block proves the two agree — including on what each one REFUSES, which is the half a subset check would miss.

WHY THE SERVER ASKS AT ALL, when the plugin refuses anyway. The allowlist is CLOSED and fail-closed on both sides; this only decides WHERE the refusal is said, and it says it before a container exists. Without it the dispatcher would start a container, hand it a file the plugin's allowlist refuses, and surface `not_a_known_manifest`, which reads to an operator as "the runner is broken" rather than as "this build cannot author into that file".

`values.yaml` MOVED FROM REFUSED TO ACCEPTED in M21.7's split-shape round, and D4 of `docs/proposals/split-shape-image-bumps.md` is why it opens WHOLESALE rather than conditionally. What actually decides whether a chart's image can be edited is whether the manifest's own parser resolves that declaration to a single line carrying its version — and the server holds no file content, so it cannot ask that question. It can only ask about the basename. The consequence is deliberate and stated: `manifest_not_editable_in_this_build` stops being the reason for values files, and the residue (a stale inventory row, an image declared identically in two places, a templated tag) is refused plugin-side as `anchor_not_derivable`, which names its own cause instead of borrowing this one's (ADR-0032 §7b clause 6).

### §4. THE DELEGATION RE-CHECK

THE DELEGATION RE-CHECK — the half the authoring-time refusal structurally cannot cover
`subscription-authoring-guard.ts`'s `assertNoDelegatedDependencyUpdates` refuses a policy whose `scope.objectRef` names a component with a standing delegation verdict. It CANNOT refuse a `selector`-scoped enable, because a selector names no component — by design, since a selector is meant to match objects that do not exist yet.

So the same stored verdict is read again here, immediately before SCP would write to the repository. That is not belt-and-braces: it is the only point at which the component is known for a selector-scoped enable, and it is also what makes a delegation ADDED AFTER the policy was authored stop the writes rather than only the policy. One stored fact, two readers, neither of them fail-open.

### §5. The controls whose verdict is the component's own checks

The control plugin modules whose verdict IS "the component's own checks passed", and the ONLY ones a grant may be built on.

There is exactly one, and naming it as a set rather than as an `=== "github-check"` is not anticipation: it is so that adding a second (a GitLab pipeline control, a Gitea Actions control) is an edit to one named list whose doc comment states the admission test, rather than a condition somebody widens in passing.

THE ADMISSION TEST, stated so a future addition is decidable: the module must answer "did THIS CHANGE'S OWN commit pass the component's OWN CI?", bound to the change's commit rather than to an operator-typed constant. `@scp/plugin-github-check` does exactly that — it reads the component's repository's Check Runs for `req.context.commitSha`, "the change's OWN tracked source commit (`governance/gate-orchestrator.ts`'s `resolveChangeCommitSha`), never an operator-typed value alone" (that plugin's own module doc).

WHO IS EXCLUDED, AND WHY EACH EXCLUSION IS THE CHARTER RATHER THAN TASTE: * `scan-result-control` — a scan verdict about an ARTIFACT. Real governed evidence, and not a statement about the component's checks: a clean CVE scan of last week's image says nothing about whether this bump compiles. * `webhook-control` — "POSTing to an operator-configured arbitrary URL" is that plugin's own description of itself. Whatever it evidences is whatever the operator pointed it at. * `null` (no binding) — the commander's promotion scan step deposits rows under a synthetic control id with no binding, and `ensureControlRun` deposits a `fail` row when a binding is missing. Neither is a component's CI.

### §6. Auto-merge is evidenced on the bump's own commit

AUTO-MERGE IS EVIDENCED BY THE COMPONENT'S OWN CHECKS, ON THE BUMP'S OWN COMMIT
The charter: "automatic merge is permitted only where a governed control evidences that the component's OWN checks passed". ADR-0032 §8: "Auto-merge's CI-green condition is expressed as a governed control so the existing gate machinery decides, not new code."

So this function INVENTS NOTHING and RUNS NOTHING. It reads the rows the existing machinery already deposits (`governance/control-runner.ts`'s `ensureControlRun` for a wave-boundary gate, `coordination/gates.ts` for a lifecycle edge) and decides which of them the charter's sentence is actually about. Two independent narrowings, and each one closes a way of merging into somebody's default branch on evidence that was never about this bump:

1. WHICH CONTROL. The first cut read `listControlRunsForChange` unfiltered, so ANY passing control granted auto-merge — a Trivy scan-result verdict, a webhook control pointed at an operator's own URL, a commander promotion-scan row. Every one of those is a governed control and none of them is "the component's own checks". `control_runs.plugin_module` is the only place the KIND of question is recorded, so the grant is restricted to `COMPONENT_OWN_CHECK_CONTROL_MODULES`.

```text
  THE MODULE IS READ OFF THE RUN, NEVER OFF THE CURRENT BINDING (migration 0063). It used to be
  a LEFT JOIN to `control_bindings`, which meant re-pointing one binding at `github-check`
  retroactively relabelled every historical pass of that control as an own-check pass — and this
  function grants an unattended merge by reading historical runs.
```

2. WHICH REPOSITORY. A module name is a string, and on its own it binds the evidence to NOTHING: a `github-check` control configured against an UNRELATED repository that happens to contain the same commit object (a fork, a mirror, a vendored copy — commit ids are content hashes and travel between repositories freely) satisfied narrowing 3 exactly as the component's own CI would. The comment here used to assert the opposite while nothing enforced it. So the run's evidence must ALSO name the repository the bump is being authored into, which `@scp/plugin-github-check` records as the API URL it queried (`{apiBaseUrl}/repos/{owner}/{repo}/commits/{ref}/check-runs`) — see `evidenceNamesRepo`. Evidence this cannot attribute to the component's own repository is NOT a grant.

3. WHICH COMMIT. Narrowing to `github-check` alone is NOT enough, and this is the sharper half. That plugin falls back to its operator-pinned `config.expectedRef` when the change tracks no commit — and a bump change tracks none until its push comes back. So a `github-check` control could have reported CI green FOR THE BASE BRANCH and the bump would have merged on it: green on `main` used as proof that the edit to `main` is safe. The grant therefore additionally requires the run's evidence to name the commit the bump's OWN branch is at, which `coordination/webhook-processor.ts` writes to `dependency_bump_authorships.head_commit` when the authored push returns. SERVER-OWNED, deliberately: the readable copy on the change (`source_ref.scp_authored.headCommit`) is writable by any authenticated principal through `POST /api/v1/changes` and is never the authority here. No recorded head commit ⇒ no grant.

WHEN THIS FUNCTION IS ASKED, AND WHY IT IS ASKED TWICE (ADR-0032 §8c)
Both narrowings above are satisfiable only AFTER the bump's own commit exists and CI on it has concluded. At the FIRST dispatch none of that is true — the branch does not exist, no push has returned, no head commit is recorded and no control has run — so the first answer is always `pull_request`, whatever the subscription asked for, and the downgrade is recorded with its reason so the option is visibly declined rather than silently ignored.

The second asking is `bump-gate.ts`'s job, and it exists because until M21.5's auto-merge link NOTHING produced one: the only trigger was a line's head advancing, an advance to a different version is a different change, and a restatement deliberately emits nothing — so `auto_merge` resolved, recorded and downgraded forever. The link is three parts, none of which is a second gate:

```text
1. `coordination/webhook-processor.ts` emits `scp.dependency.bump_observed` in the ingress
   transaction whenever an observed provider event correlates to a bump change SCP authored —
   the authored push (which records the head commit) and, once CI concludes on it, the
   `workflow_run` that names that same commit;
2. `bump-gate.ts` routes that event onto its own queue and runs
   `governance/gate-orchestrator.ts`'s EXISTING `prewarmGovernanceForChange` FOR the bump
   change, so the required controls a policy already names actually run against it and deposit
   real `control_runs` with real evidence. No lifecycle edge is crossed and the change is never
   advanced: a bump is not a deployment;
3. that same job re-asks THIS function with the recorded head commit, and dispatches the merge
   only if it grants.
```

So the two narrowings below are now REACHED rather than merely correct. Nothing about what they require changed; what changed is that the evidence they require can now exist.

WHY IT IS A DOWNGRADE RATHER THAN A REFUSAL. `pull_request` is the more restrictive member of the pair and the resolver already treats it as such (`DependencySubscriptionDeliverySchema`: "auto-merge is the privileged option and is acquired unanimously"). A bump whose checks have not gone green is not a bump that must not happen — it is one that must be delivered the safe way. Throwing here would withhold the pull request the checks need in order to run at all.

FAIL-CLOSED IN EVERY DIRECTION THAT MATTERS: * no control run at all                       -> pull_request ("absent never means passed") * only `expired` runs (CI in flight)          -> pull_request * ANY `fail`/`timed_out`, from ANY control    -> pull_request, even if an own-check passed * a pass from a control that is not an own-check          -> pull_request * an own-check pass whose evidence names another repository -> pull_request * an own-check pass whose evidence names another commit   -> pull_request * an own-check pass on the bump's own repository AND head commit -> auto_merge, named in the reason

The "any fail wins, from any control" rule is deliberately WIDER than the grant rule, and the asymmetry is the point: a passing scan is not evidence the component's checks passed, but a FAILING scan is a perfectly good reason not to merge unattended. It is the same asymmetry the subscription merge itself uses — one objecting contribution defeats any number of permitting ones, because the cost of the two mistakes is not symmetric.

### §7. Does this control run's evidence name `repo`?

Does this control run's evidence name `repo`?

`@scp/plugin-github-check` records the API URL it actually queried — `{apiBaseUrl}/repos/{owner}/{repo}/commits/{ref}/check-runs` — which is the only field in the evidence that says WHICH REPOSITORY the verdict is about. The `/repos/<owner>/<name>/` segment pair is lifted out of it and compared case-insensitively, the same rule `dependencies/manifest-reader.ts`'s `normalizeRepoIdentity` states for repository paths.

A shape this cannot read is NOT a match — the fail-closed direction, and it costs a pull request rather than an unattended merge on evidence nobody can attribute. That includes an evidence payload with no `url` at all: a control that does not say what it looked at has not said it looked at this component.

### §8. Does this control run's evidence name `commit`?

Does this control run's evidence name `commit`?

`@scp/plugin-github-check` records `{url, ref, checkRuns}` where `ref` is the commit it queried. Read as `unknown` at this boundary because `control_runs.evidence` is jsonb written by a plugin: a row from an older build, or from a module added to `COMPONENT_OWN_CHECK_CONTROL_MODULES` later, can carry anything. A shape this cannot read is NOT a match — the fail-closed direction, which costs a pull request rather than an unattended merge on evidence nobody can attribute.

Compared case-insensitively: git object ids are hex, and providers spell them in either case. Never a prefix comparison — an abbreviated sha is a different string and matching on a prefix is how a 7-character `evidence.ref` would satisfy any commit that happens to start the same way.

### §9. The id is chosen by the caller, and why

THE ID, CHOSEN BY THE CALLER, because two things need it before the row exists.

It used to be minted inside this function, which made the ordering impossible: the branch is `scp/dep-bump/<changeObjectId>` and the DELIVERY is resolved against the change's control runs, so both the ref written into `source_ref` and `resolveEffectiveDelivery`'s argument need the id that `proposeChange` had not yet returned. Minting in the caller also lets a RE-DISPATCH pass the id of the bump change that already exists, which is what makes a retry converge on one branch and one pull request rather than opening a second.

### §10. The dependency line this bump is for

The dependency line this bump is for.

Recorded because the SECOND asking of the delivery question (`bump-gate.ts`) has only the change in hand and must re-derive the subscription's CURRENT resolution rather than trust the one recorded here — which is the DOWNGRADED answer by construction. Re-deriving is what makes a subscription narrowed to `pull_request`, or switched off entirely, after the bump was authored stop the merge; and `listSubscribedComponentLines` is keyed on (component, line), so the line is the field that has to be on the change. A `targets` join would give the component and nothing would give the line.

### §11. EVERY manifest path this component's inventory declares

EVERY manifest path this component's inventory declares (ADR-0032 §3 projection rows), not just the one being edited.

It is here because the plugin's manifest-only verifier refuses a target the component does not declare — "a manifest the component already contains", in the charter's words — and the only place that fact exists is the server's inventory. Sending just `manifestPath` and letting the plugin default the set to it would make that gate compare a value with itself and pass vacuously; the plugin therefore REQUIRES this and refuses a descriptor without it.

It is a descriptor, not content: a list of references to files that already exist, exactly the category `manifestPath` itself is in (ADR-0032 §9's distinction).

### §12. THE PROVENANCE LOOP

THE PROVENANCE LOOP — a commit SCP authors must come back as ITSELF
ADR-0032 §9's closing sentence: "A commit SCP authors is observed back in via the normal webhook path, so the bump change must be recorded such that the returning event CORRELATES TO IT rather than minting a second, unrelated change."

That sentence describes a real hazard rather than a tidiness concern. Today EVERY change is minted by `coordination/webhook-processor.ts` from an OBSERVED event: it extracts a hint, matches `source_mappings`, and calls `proposeChange`. A bump SCP authors produces a perfectly ordinary push to the component's repository, which matches that component's perfectly ordinary source mapping — so without something to stop it, one bump becomes TWO changes: the one SCP recorded when it decided to author, and the one the webhook minted when the commit arrived. They would gate independently, appear as two releases of the same component, and neither would know about the other.

THE JOIN IS THE BRANCH, AND IT IS DECLARED ON BOTH SIDES. The change is recorded FIRST, so its id exists; the branch the plugin authors is `scp/dep-bump/<changeObjectId>`, so the id is carried in the one field a git push always has. The change ALSO records the repo and ref it claims, under `source_ref.scp_authored`. Correlation then requires BOTH: the incoming ref must name a change, and that change must claim this repo and this ref.

REQUIRING BOTH IS THE WHOLE POINT, not defensiveness. A branch name is attacker-typable — anyone who can push to any repository this instance observes could create `scp/dep-bump/<some-uuid>` and, with a one-sided check, attach their push to somebody else's change. Reading the change's own declaration is what makes the correlation a fact SCP asserted rather than a claim the payload made. It is the same "declared, never inferred" rule ADR-0030 §2 states for pipeline classification and that this repository's own provenance-label lesson learned the hard way.

WHY THE BRANCH AND NOT THE COMMIT SHA. The sha is only known after the push, so a webhook that arrives before the actuator has finished recording it would find nothing — a race whose losing side is exactly the double-change this exists to prevent. The branch is chosen BEFORE anything is written and is therefore race-free.

...AND THE DECLARATION THAT DECIDES A WRITE LIVES SOMEWHERE ONLY THE SERVER CAN WRITE
`source_ref.scp_authored` is written here and is the human-readable half: it is what makes "why was this not auto-merged?" answerable from the change alone (principle 6). It is NOT the authority for anything, and it never can be — `source_ref` is the raw delivery payload plus a few lifted keys, writable verbatim by any authenticated principal through `POST /api/v1/changes`. Reading the repository, the base branch or the head commit out of it to decide a MERGE is a confused deputy: the tenant names the repository, SCP supplies the credential.

So the same facts are recorded a second time in `dependency_bump_authorships` (migration 0063), in the SAME transaction as the change, and every decision that leads to a repository write reads THAT. A change with no authorship row is not a bump change, whatever its `source_ref` claims.

### §13. WHOSE BUMP THIS IS

WHOSE BUMP THIS IS. Recorded because the change's own declaration is the ONLY place the subject of a bump exists in a form `findOpenBumpChange` can read: `changes.targets` is a join it would have to widen, and a name is not an identity. Without it that lookup matched on (coordinate, toVersion) across the whole org, so a SECOND component declaring the same dependency line re-used the FIRST one's change — no change of its own, no branch, no pull request, and a returning push that minted an unrelated second change for every component after the first, which is exactly what ADR-0032 §9 exists to prevent.

### §14. What the server hands the runner: a descriptor

What the server hands `scp-managed-dep` as `intent.parameters` — a DESCRIPTOR, and every field of it names something that already exists in the component's repository or is a version token.

Deliberately built in ONE place: the plugin refuses any parameter that could hold authored file content (`CONTENT_BEARING_KEYS`), and a caller assembling this object ad hoc is how such a key eventually gets added by someone who finds it convenient. There is no `sourceFiles` here and there is nowhere to put one.

### §15. What the server hands the runner to merge its own bump

What the server hands `scp-managed-dep` to MERGE a bump it already authored.

EVERY FIELD COMES FROM `dependency_bump_authorships` — the server-owned record of what SCP itself did (migration 0063), never from `changes.source_ref`, which any authenticated principal can write verbatim. `repo` and `baseBranch` are what SCP recorded when it decided to author; `expectedHeadCommit` and `pullRequestNumber` are what SCP recorded when its own push came back and when its own authoring run reported the pull request it opened.

`pullRequestNumber` IS THE ADDRESS OF THE MERGE, and it is the field that closes the widest hole this action ever had. Without it the plugin listed open pull requests filtered on `head=owner:<our branch>` and merged `list[0]` — so WHICH pull request got merged was provider list ordering, and its base was never compared to anything. Anyone with write or triage on the repository could retarget SCP's pull request, or open a second one from SCP's branch to a protected branch, and SCP would merge a tree the governed grant never authorised while recording a `merged` Decision naming the base it thought it was merging into.

There is still NO branch field: the plugin composes the head branch from `changeObjectId` with the same function the authoring run used, so the only branch this intent can reach is the branch that change's own bump authored.

Built in ONE place for the same reason `buildBumpIntentParameters` is: the plugin refuses any parameter that could carry authored content, and an ad-hoc caller is how such a key gets added.

### §16. Reads a change's authored-bump declaration, or nothing

Read a change's authored-bump declaration, or `undefined` when it has none.

THIS IS THE READABLE EXPLANATION. IT IS NEVER THE AUTHORITY FOR A WRITE.
`source_ref` is the raw delivery payload plus a few lifted keys, and ANY authenticated principal can write it verbatim through `POST /api/v1/changes`. Everything that leads to a repository write — which repository, which base branch, which commit, which pull request — reads `dependency_bump_authorships` instead (`bump-authorship-repo.ts`, migration 0063), because a merge must act only on facts SCP itself recorded. What remains here is the human-readable half that makes "why was this not auto-merged?" answerable from the change alone (principle 6), plus the declaration `correlation.ts`'s branch route compares against.

Every field is validated as a string before it is returned. `source_ref` is jsonb, so a row from an older build or a hand-edited record can carry anything; a shape this cannot read is treated as NO CLAIM rather than as a partially-trusted one.

## `apps/server/src/dependencies/bump-authorship-repo.ts`

### §17. The one place that answers whether we authored this

THE ONE PLACE THAT ANSWERS "DID COMMANDERSCP AUTHOR THIS, AND WHAT DID IT AUTHOR?" (migration 0063, ADR-0032 §8/§9, charter `scp-managed-dep` amendment)

A MERGE IS THE ONE IRREVERSIBLE THING THIS FEATURE DOES, SO IT ACTS ONLY ON FACTS SCP ITSELF RECORDED. That single rule is what this module exists to make structural, and it has two halves that are easy to conflate:

```text
* NEVER A FIELD A TENANT CAN WRITE. The merge path used to read the repository, the base branch,
  the component, the line and the branch's head commit out of `changes.source_ref.scp_authored`.
  `source_ref` is the raw delivery payload plus a few lifted keys and is writable verbatim by any
  authenticated principal through `POST /api/v1/changes`; the event that starts the gate is
  likewise producible through `POST /change-sources/{kind}/report`. So a tenant could fabricate a
  bump naming ANY repository and have SCP merge into it with SCP's credential. That is a confused
  deputy, not a validation gap — validating an attacker-writable field yields a well-formed
  attacker-supplied answer.
* NEVER STATE READ BACK FROM THE PROVIDER. The pull request a merge targets is the one SCP
  OPENED, identified by the number SCP recorded when it opened it — not "the first open pull
  request whose head is our branch", which is provider list ordering deciding what gets merged.
```

WHO MAY WRITE HERE, exhaustively: `bump-dispatch.ts` (through `bump-actuator.ts`'s `recordBumpAuthorship`) when SCP decides to author and again when the authoring run reports the pull request it opened; `coordination/webhook-processor.ts` when SCP's OWN branch is observed back through the two-sided branch check; and `bump-gate.ts` when the provider confirms a merge. There is no route, no IaC object type and no federation importer that reaches this table.

`changes.source_ref.scp_authored` KEEPS BEING WRITTEN and is no longer READ by anything that decides a write: it is the human-readable explanation on the change (principle 6, "why was this not auto-merged?"). Deleting it would remove an explanation, not a control.

### §18. That pull request's URL, as the provider returned it

That pull request's web URL, AS THE PROVIDER RETURNED IT (migration 0066).

`undefined` means SCP RECORDED NO LINK — a row written before the column existed, an authoring run whose outcome carried no readable `html_url`, or a value that was not an absolute http(s) URL. It NEVER means "compose one from `repo` and `pullRequestNumber`": that composition is true of github.com and of nothing else, and this row does not record which provider authored the bump. See `recordBumpPullRequest`.

### §19. Record that SCP is authoring this bump

Record that SCP is authoring this bump. Written in the SAME transaction as the bump change itself, so a change without an authorship (or an authorship without a change) is not a state a crash can produce.

IDEMPOTENT AND NON-CLOBBERING under redelivery: a re-dispatch of the same bump re-states the same facts, and `DO NOTHING` keeps the observed columns (`head_commit`, `pull_request_number`, `merged_at`) that a later ingress wrote. Re-authoring must never un-record that SCP's branch has already merged.

### §20. The open bump already authored for that exact target

The open bump SCP already authored for this (component, manifest, coordinate, target version), or `undefined`.

EVERY COLUMN OF THE KEY IS COMPARED, and the first two are why: a dependency LINE exists to be declared by many components, and one component legitimately declares one line from two manifests. Keyed on (coordinate, toVersion) alone — which is what the jsonb predecessor effectively did — the second component to reach this reused the first one's change, so it got no change, no branch and no bump, and the returning push then correlated to a change that was not about it.

A MERGED bump is excluded: it is not open, and reusing its change would author a second commit onto a branch that has already landed.

### §21. Every OPEN bump SCP authored for one coordinate

Every OPEN bump SCP authored for one coordinate — what a producer retraction reports and CANNOT recall (ADR-0032 §7e, proposal §12.3.2).

READ-ONLY, DELIBERATELY, and the caller must do nothing else with the result. A dispatched bump has left SCP: it is a pull request in another team's repository, or under `auto_merge` a commit on their branch. Closing or rewriting these rows would make SCP assert it closed a PR it did not close — a false record, which is worse than an open one. Retraction stops FUTURE triggers only; this list exists so an operator has the set to go and close by hand.

`merged_at IS NULL` is what "open" means, the same predicate `findOpenBumpAuthorship` uses. Matched on `(ecosystem, coordinate)` as a PAIR: a coordinate carries no ecosystem in itself.

### §22. Every bump opened and not yet merged: the work list

Every bump SCP has opened a pull request for and not yet merged — the work-list of `bump-freeze-redrive.ts`'s per-minute sweep.

THE TWO PREDICATES ARE THE TWO HALVES OF "THERE IS STILL A MERGE TO MAKE", and both are needed: `merged_at IS NULL` is what "open" means everywhere else in this file, and `pull_request_number IS NOT NULL` is the gate's own `no_recorded_pull_request` refusal — a bump with no recorded pull request can never merge, so re-driving its gate would only re-record that refusal once a minute.

BOUNDED BY REVIEW THROUGHPUT, NOT BY HISTORY. Merged rows accumulate for ever and are excluded in SQL; what is returned is the set of dependency pull requests currently awaiting a merge, which is a small number on any real estate. READ-ONLY, like every other list here.

### §23. The bump whose own branch head is that commit

The bump whose OWN branch head is `commit` in `repo`, or `undefined` — the CI-conclusion correlation route (GitHub's `workflow_run` names a commit and no ref).

BOUNDED AND INDEXED, which its predecessor was not: that one loaded EVERY dependency-bump change in the org, unfiltered, inside the ingress transaction, on essentially every webhook, and compared jsonb in TypeScript. Here the org, the head commit and the repository are all SQL predicates served by `dependency_bump_authorships_org_head_commit`, and the columns are typed `text` rather than `unknown`-out-of-jsonb, so there is nothing left to compare in the application.

The comparisons are the ones the jsonb version documented and they are kept exactly: the commit case-insensitively (git object ids are hex and providers spell them either way) and NEVER by prefix — an abbreviated sha is a different string, and a prefix match is how a 7-character value would attach to any commit that happens to start the same way. The repository case-insensitively, because all three providers address repository paths that way.

### §24. Record which commit SCP's authored branch is now at

Record which commit SCP's authored branch is now at.

A LATER PUSH TO THE SAME BRANCH OVERWRITES IT, deliberately: the bump's head IS the newest commit on its branch, and leaving the first one standing would let evidence about a superseded commit authorise merging a different tree. Idempotent under redelivery — the same push writes the same value.

### §25. A provider-supplied URL this table is willing to store

A provider-supplied web URL this table is willing to STORE, or `undefined`.

The value arrives as `html_url` out of a provider's JSON body, relayed through the plugin's `status().stateRef`. Three things are therefore true of it and each is a reason this exists:

```text
* IT MAY BE ABSENT OR EMPTY. `packages/plugins/managed-dep/src/repo-write.ts`'s
  `readPullRequest` degrades an `html_url` it cannot read to `""`, deliberately, because every
  one of ITS callers compares that field rather than displaying it. Storing `""` here would
  turn "the provider told us nothing" into a value a consumer has to special-case, when the
  column already has a way to say it: NULL.
* IT IS NOT A SCHEME WE CHOSE. The only consumer of this column is something rendering a link,
  and a `javascript:` or `data:` href is script execution in whatever renders it. Refusing any
  scheme but http/https AT THE WRITE DOOR is what lets every reader treat the column as safe,
  rather than each reader remembering to sanitise it. Sanitising in n readers is the shape this
  repo keeps paying for; refusing in the one writer is not.
* IT IS UNBOUNDED. `text` has no length limit, so a hostile or broken provider response would
  be stored whole. 2048 is past every real forge URL and short of anything worth storing.
```

Refused values are recorded as NOTHING, never as a repaired or synthesised value: an absent link is a missing feature, an invented one is a lie with a working underline.

The provider's OWN string is returned (trimmed), not `new URL(...).href` — normalising would silently re-spell a URL the provider issued, and the column's contract is what the provider returned.

### §26. Record the pull request the authoring run reported opening

Record the pull request the authoring run reported opening — its NUMBER, and the URL the provider returned for it.

WRITE-ONCE, and the predicate is the control rather than a convenience: the number is what the merge is addressed to, so a later run must not be able to re-point it at a different pull request. A retry of the same bump converges on the same branch and therefore on the same pull request, so re-stating it is redundant rather than necessary; a DIFFERENT number arriving later is the case this refuses to honour — and it refuses the URL that came with it too, since a link that names a different pull request from the number beside it is worse than no link.

THE ONE CASE THE PREDICATE DELIBERATELY ADMITS is a re-statement of the SAME number carrying a URL for a row that has none: a row written before migration 0066, or one whose first authoring run got a provider response with no readable `html_url` (that plugin's 201 path degrades it to `""`, and its 422 retry path re-reads the pull request and usually does have one). Filling the URL in cannot re-point anything — the number is already fixed and is being compared, not overwritten — so the narrower "number is null" predicate would only have meant the link stayed missing forever. Once BOTH are recorded the statement matches no row and writes nothing at all, which is what keeps a redelivery from costing a dead tuple per hop (ADR-0024).

THE URL IS NEVER SYNTHESISED. `repo` + `pullRequestNumber` composes a working link for github.com and for nothing else, and this row does not record which provider authored the bump — see `BumpAuthorship.pullRequestUrl` and migration 0066.

### §27. Record that the provider confirmed the merge

Record that the provider confirmed the merge.

This is what makes the audit trail stop lying. The merge produces its OWN provider events — the merge commit's push, and whatever CI runs on the base branch afterwards — which correlate straight back to this bump and re-run the gate. That second run finds no OPEN pull request, records `withheld / merge_refused`, and the LATEST Decision for a bump that DID merge then says it did not: charter principle 6 inverted, on the one irreversible action in the feature. With this stamped, the gate returns before dispatching anything.

### §28. THE READ SURFACE'S DOOR

THE READ SURFACE'S DOOR — every bump SCP authored for ONE component, newest first, keyset-paged (M21.6, `GET /components/{idOrUrn}/dependency-bumps`).

This is the first LIST over this table, and it is deliberately narrow: ONE component, served by `dependency_bump_authorships_org_subject` (which leads with `component_object_id`), bounded by `limit`, and read-only. It reads facts SCP itself recorded — the module doc's rule — and hands back nothing a merge decision could be confused by, because nothing here is written back.

ORDER IS `(created_at DESC, change_object_id DESC)` — the dispatch order, newest first — and the cursor is the last row's pair, compared as a row so a page boundary that falls inside one millisecond neither repeats nor drops a row (the same reasoning `pagination.ts`'s `keysetAfter` records for the ascending lists; this is its descending twin, written here because the shared helper is ascending-only and a bump list is read newest-first).

## `apps/server/src/dependencies/bump-dispatch.integration.test.ts`

### §29. The bump is actually dispatched, through the real path

M21.5 — THE BUMP IS ACTUALLY DISPATCHED, THROUGH THE REAL PATH (ADR-0032 §8/§9).

WHY THIS FILE EXISTS, AND WHY THE REST OF M21.5's SUITE COULD NOT CATCH WHAT IT CATCHES
`recordBumpChange`, `resolveEffectiveDelivery` and `buildBumpIntentParameters` were built, tested and correct, and NOTHING constructed a `managed-dep` `TriggerIntent`: no job, no route, no loop. A suite that drives a function proves the function and says nothing about whether anything calls it — which is how the same failure landed four times in M21. So every test below enters through the PRODUCTION SEAM and never through the function under test:

```text
recordDependencyLineHead (the ONE head write door)
  -> an `scp.dependency.line_head_advanced` OUTBOX row, in the head write's own transaction
  -> the domain-event job shape the outbox relay actually sends
  -> advancedLineHeadRouter (registered WITH pg-boss, because `boss.work()` is a competing
     consumer and a second worker on `domain-events` would steal M21.4's events)
  -> the `dependency-bump` queue
  -> startBumpDispatchLoop's worker
  -> a bump change, and a `trigger()` on the `managed-dep` plugin instance.
```

DELETE ANY LINK OF THAT CHAIN AND THESE TESTS FAIL. Removing the outbox emit fails the first block; removing the router registration or the loop fails the second; removing the dispatch fails the trigger assertions.

AND THE SAME DISCIPLINE FOR THE AUTO-MERGE LINK (block 2b, ADR-0032 §8c)
`resolveEffectiveDelivery` was the FIFTH instance of the same failure: correct, tested, and unreachable — no control ever ran on a bump change (they sit at `proposed`, and governance prewarm only sweeps `validating`), nothing re-evaluated a bump after its pull request opened, and there was no merge anywhere in the tree. So block 2b enters through the webhook ingress too:

```text
a raw github `push` / `workflow_run` row in `change_source_events`
  -> the REAL `processChangeSourceEvents` -> `matchAuthoredBumpChange` (branch route, then the
     HEAD-COMMIT route a ref-less CI event needs)
  -> an `scp.dependency.bump_observed` OUTBOX row, in the ingress transaction
  -> observedBumpRouter -> the `dependency-bump-gate` queue -> startBumpGateLoop's worker
  -> `prewarmGovernanceForChange` (the EXISTING gate) -> a real `control_runs` row
  -> `resolveEffectiveDelivery` -> a `managed-dep` MERGE intent.
```

Nothing in that block calls `runBumpGateJob`, `prewarmGovernanceForChange` or `resolveEffectiveDelivery` directly.

AND THE DELEGATION REFUSAL IS PROVEN WITH A REAL PROBE, NOT A PLANTED VERDICT
`bump-provenance.integration.test.ts` plants the `dependency_delegation` Decision with `insertDecision` — correct for testing the READERS, and it would pass unchanged with no writer anywhere in the tree, which is exactly the state M21.5 was in. Here the verdict is written by the dispatch job READING A `renovate.json` OUT OF THE REPOSITORY through the plugin host's `readFileAtRef` client, and the enablement refusal is then driven through the AUTHORING CHOKE POINT — the typed `/policies` route AND a free-form-`typeId` door — because `subscription-authoring-guard.ts`'s header measured that the route was never the boundary.

### §30. Every gate evaluation, with the change it was about

Every `evaluate()` the governance gate performed, with the CHANGE it was about and the commit it was asked about — which is the field the whole auto-merge grant turns on.

THE CHANGE ID IS RECORDED, and that is not cosmetic. Every test in the auto-merge block uses the same `BUMP_COMMIT` constant, and these accumulators were module-level and never reset — so `expect(controlEvaluations.map(e => e.commitSha)).toContain(BUMP_COMMIT)`, written to prove a control ran for THIS change, was satisfied forever by the first test that ran one. It could not fail. The `beforeEach` below resets them and the assertions now name the change.

### §31. The URL the fixture provider hands back, deliberately

The web URL the fixture PROVIDER hands back for a pull request it opened.

DELIBERATELY NOT A GITHUB URL, and that is the whole point of the column it feeds (migration 0066): this is an outpost-local Gitea (M15), so it is a different HOST and it spells the path `/pulls/` where github.com spells `/pull/`. A consumer composing a link from `repo` + `pull_request_number` would emit `https://github.com/<repo>/pull/<n>`, which 404s here — so an assertion that this exact string reached the database cannot be satisfied by a synthesiser.

### §32. Accumulators are reset per test, a correctness fix

ACCUMULATORS ARE RESET PER TEST, and this is a correctness fix rather than tidiness.

They were module-level and never cleared, so any assertion of the form `toContain(<a constant every test in the file uses>)` was satisfied by whatever an earlier test had already pushed. `expect(controlEvaluations.map(e => e.commitSha)).toContain(BUMP_COMMIT)` — written into the "checks passed for a DIFFERENT commit" test to prove a control HAD run for this bump — CANNOT FAIL under those conditions: the first test in the block runs a control for `BUMP_COMMIT` and every later one inherits its evidence. That is this repo's own recurring "green for the wrong reason" shape.

`openedPullRequests` and `relayed` are deliberately NOT reset: they are per-change state the fixture keeps for the lifetime of the changes themselves, not per-test observations.

### §33. An authoring run opens a pull request

AN AUTHORING RUN OPENS A PULL REQUEST, and this run's outcome is the only place its number and its URL exist. The server reads both back off `status().stateRef` and records them: the merge is ADDRESSED to the number rather than found by listing (so a fixture reporting no number would make every merge below unreachable), and the URL is unrecoverable afterwards because nothing on the row says which provider this was.

### §34. A subscribed component declaring that range

A subscribed component that declares `@acme/lib@^1.2.3` from `package.json` in its own repository, with the git binding that names that repository — the binding is what chooses the credential, so without it there is no repository to author into.

`lineId` and `manifestPaths` are options rather than constants BECAUSE THE ABSENCE OF THEM IS WHAT LET A BLOCKER SHIP. Every fixture in the first cut of this file minted its own line with a coordinate unique to itself and declared it from exactly one manifest, so the suite could not see that `findOpenBumpChange` keyed on (coordinate, toVersion) alone: a second component on the same line, and a second manifest in the same component, both collapsed onto one bump change.

### §35. THE LINK IS CAPTURED HERE OR NOWHERE

THE LINK IS CAPTURED HERE OR NOWHERE (migration 0066, M21.7 item C)
0064 recorded `repo` and `pull_request_number` and no URL, on the reasoning that the two compose one. They compose one for github.com. They compose a 404 for an outpost-local Gitea (M15) — a different host, and `/pulls/` rather than `/pull/` — and for GitHub Enterprise, and nothing on the authorship row records which provider authored the bump. So the URL the provider itself returned has to be persisted at the one moment it exists: the authoring run's outcome.

This test enters through the SAME production seam as the rest of the file — head write door -> outbox -> router -> queue -> loop -> dispatch -> phase 5 -> `recordBumpPullRequest` — and never calls the repo function. Delete the URL from phase 5's read of `status().stateRef`, or delete the phase-5 write entirely, and this goes red.

### §36. A dependency line exists to be declared by many

A dependency LINE EXISTS TO BE DECLARED BY MANY COMPONENTS — that is the entire point of the M21.3 reverse index — so "two subscribed components on one line" is the ordinary case, not an edge one. It had no fixture, and `findOpenBumpChange` accepted a `componentObjectId` it never compared: the second component to reach the lookup reused the FIRST one's change, so it got no change, no branch, no dispatch and no bump, silently and forever. Worse, ADR-0032 §9's provenance loop then inverted — the returning push correlated to a change that was not about this component, and every component after the first minted the second, unrelated change §9 exists to prevent.

### §37. The other half of the same key, not a defensive extra

The other half of the same key, and it is not a defensive extra: `component_dependencies` is unique on `(org, component, line, manifest_path)`, so ONE component legitimately declares one line from two manifests — a workspace root and a service's own `package.json`. A bump change declares exactly ONE `manifestPath`, so two manifests must be two changes; keyed without it, one file was edited and the other silently was not.

### §38. An auto-merge's first dispatch is still a pull request

THE FIRST DISPATCH OF AN `auto_merge` SUBSCRIPTION IS ALWAYS A PULL REQUEST (ADR-0032 §8c)
This test was originally written as a record that auto-merge did nothing at all, with a note saying it was EXPECTED TO FAIL once something re-enqueued the bump after the component's checks concluded. That link is now built (`bump-gate.ts`), so the note is gone — but the behaviour it pins is not, and it is the more important half of the charter clause:

```text
at the FIRST dispatch the branch does not exist, no push has returned, no commit is recorded
and no control has run — so `auto_merge` is refused and delivery is a pull request, whatever
the subscription asked for.
```

"The bump merges on its second look, never on its first" is the property, and this is where it is pinned. The block below ("the auto-merge link") is where the SECOND look is proven.

The downgrade is also RECORDED with its reason, which is the difference between an operator who can see why the privileged option was declined and one who wonders whether they mis-authored the policy.

### §39. Every link of the chain; deleting any one fails this

EVERY LINK OF THE CHAIN, AND DELETING ANY ONE OF THEM FAILS THIS BLOCK
```text
a provider webhook row (github `push`, then github `workflow_run`)
  -> the REAL `processChangeSourceEvents`
  -> `matchAuthoredBumpChange` (branch route for the push, HEAD-COMMIT route for the CI event)
  -> the `scp.dependency.bump_observed` OUTBOX row, in the ingress transaction
  -> the domain-event job shape the outbox relay actually sends
  -> `observedBumpRouter` (registered WITH pg-boss)
  -> the `dependency-bump-gate` queue
  -> `startBumpGateLoop`'s worker
  -> `prewarmGovernanceForChange` — the EXISTING gate — which runs the component's own
     required control against the bump's OWN commit and deposits a real `control_runs` row
  -> `resolveEffectiveDelivery` grants
  -> a `managed-dep` MERGE intent.
```

Nothing below calls `runBumpGateJob`, `prewarmGovernanceForChange` or `resolveEffectiveDelivery` directly. That is the point: M21's standing failure is components that are correct and have no caller, and a suite that drives the component proves the component.

### §40. A bound control plus a policy naming it, together

A `control` bound to `github-check` PLUS a required policy naming it — which together are what makes the governance gate run anything at all for this component. The module matters: `bump-actuator.ts` grants only on modules that answer "did THIS CHANGE'S OWN commit pass the component's OWN CI?", so a `scan-result-control` binding here would (correctly) grant nothing.

### §41. It is then CONSUMED WITHOUT BEING RELAYED

It is then CONSUMED WITHOUT BEING RELAYED. In production that evaluation runs and refuses (`github-check` answers `expired` — CI has not concluded on the commit the push just announced), which is the FIRST-dispatch behaviour already pinned above. Relaying it here would re-prove that and make every assertion below race a second, identical gate job for the same change, so each test drives exactly one evaluation: the one triggered by CI.

### §42. The checks went green for the bump's own commit

The component's checks went green FOR THE BUMP'S OWN COMMIT. EVIDENCE NAMES THE COMPONENT'S OWN REPOSITORY as well as the bump's own commit — the URL `@scp/plugin-github-check` records is the only field that says which repository a verdict is about, and a commit id travels between repositories freely (a fork, a mirror, a vendored copy), so the module name alone bound the evidence to nothing.

### §43. A real control ran, asked about the bump's own commit

(1) A REAL CONTROL RAN, and it was asked about the bump's own commit — not the base branch, which is what `github-check` would have fallen back to before the push was recorded. BOUND TO THIS CHANGE, not merely to the shared commit constant: every test in this block uses the same `BUMP_COMMIT`, so an assertion over the commit alone was satisfied by any earlier test's evaluation.

### §44. (3) THE VERDICT IS EXPLAINABLE

(3) THE VERDICT IS EXPLAINABLE (charter principle 6). WAITED FOR, not read straight after the merge intent. `recordMergeVerdict` is deliberately written AFTER the provider attempt and in its OWN transaction (bump-gate.ts — "a Decision that recorded 'merge authorised' and then [failed] ... leaves the merge unrecorded"), so the intent appearing does NOT imply the Decision has landed. Reading it synchronously passed on timing and failed on a loaded CI shard.

### §45. The checks must bind to the component's repository

"THE COMPONENT'S OWN CHECKS" MUST BE BOUND TO THE COMPONENT'S OWN REPOSITORY
The grant used to be enforced as a MODULE-NAME STRING plus a commit id, and neither binds the evidence to this component: a `github-check` control an operator configured against a DIFFERENT repository that happens to contain the same commit object — a fork, a mirror, a vendored copy; commit ids are content hashes and travel freely — reported green for exactly the commit the bump is at, and the merge was granted. The code comment asserted the opposite while nothing enforced it.

### §46. Stricter here than at the authoring seam, deliberately

STRICTER HERE THAN AT THE AUTHORING SEAM, and deliberately. `assertComponentNotDelegated` refuses only when a verdict SAYS delegated, because the authoring path is what PRODUCES the verdict. An INCONCLUSIVE probe (a bad credential, a provider 5xx, an egress refusal) records no verdict at all — so "no verdict" is byte-identical to "we could not read the repository", and merging is a bigger thing to do on that than opening a pull request is.

### §47. Erase the allow verdict the probe itself recorded

Erase the `allow` verdict the dispatch job's own probe recorded — which is exactly the state an inconclusive probe leaves behind, since `recordDelegationProbe` refuses to write one.

Over the ADMIN connection, because `decisions` is append-only to the tenant role (no DELETE grant) — a property worth noticing rather than working around: the state under test is one production reaches by a probe never CONCLUDING, never by a verdict being removed.

### §48. A bump naming another repository merges nothing

A FABRICATED "BUMP" NAMING SOMEBODY ELSE'S REPOSITORY MERGES NOTHING (ADR-0032 §8f)
THE CONFUSED DEPUTY THIS CLOSES. Every input that decided whose credential merged what was read from `changes.source_ref.scp_authored` — a field `POST /api/v1/changes` writes VERBATIM for any authenticated principal — and the event that starts the gate is producible through `POST /change-sources/{kind}/report`. So an ordinary tenant could declare a bump against a repository they do not own and have SCP merge into it with SCP's installation credential.

This test is the forgery itself, through the PUBLIC API, with a `source_ref` that names every field the old merge path read and names them correctly. What stops it is not a validation of that field — validating an attacker-writable field yields a well-formed attacker-supplied answer — but that the merge path reads `dependency_bump_authorships`, which no route can write, and a change with no row there is not a bump change.

IT ENTERS THROUGH THE GATE JOB ITSELF rather than through the webhook, so the assertion is about the decision and not about whether an event happened to correlate.

### §49. The audit trail must not lie about the one merge

THE AUDIT TRAIL MUST NOT LIE ABOUT THE ONE IRREVERSIBLE ACTION (principle 6)
A merge produces its OWN provider events — the merge commit's push, whatever CI runs after — which correlate straight back to this bump and re-run the gate. That second run found no OPEN pull request, dispatched a doomed merge and recorded `withheld / merge_refused`, so the LATEST Decision for a bump that DID merge said it did not.

Driven the way production reaches it: the same CI conclusion delivered TWICE.

### §50. TWO CONCURRENT JOBS, TWO PLUGIN-INSTANCE NAMESPACES

TWO CONCURRENT JOBS, TWO PLUGIN-INSTANCE NAMESPACES (ADR-0032 §7c clause 4)
`bump-dispatch.ts` (authoring) and `bump-gate.ts` (merging) both act on the SAME component binding, both start a `managed-dep` instance for it, and both tear it down in a `finally`. The id used to be `managed-dep:<bindingId>` for both — one shared subprocess — so whichever job finished first killed the other's in flight, including a `status()` call issued AFTER the provider had already merged. A head advance and a CI conclusion are unrelated events; nothing orders them.

### §51. The operator's container runtime reaches this runner

THE OPERATOR'S CONTAINER RUNTIME REACHES THE RUNNER THIS PATH STARTS (2026-08-16)
`@scp/plugin-managed-dep` runs `execFile(config.dockerBinary ?? "docker", …)`, and `SCP_MANAGED_RUNNER_DOCKER_BINARY` is how an operator points that at podman — the sanctioned runtime on the RHEL/air-gapped estates this class ships into (docs/container-runtimes.md).

ASSERTED HERE, SEPARATELY FROM THE BINDING PATH, because this class has two ways of being constructed and this is the one that runs. `routes/executors.integration.test.ts` covers `resolveExecutorPluginInstance`, the path taken only for a `managed-dep` binding an operator makes BY HAND; ordinary dispatch never touches it — `managed-dep-instance.ts` builds the instance itself from `managedDepServerSettings()`. When the runtime knob was first wired, both of this class's paths were missed while its two sibling classes were wired correctly, so an operator on podman got a silent hardcoded `docker` for every ordinary bump. A test on the binding path alone would have stayed green through exactly that.

The value is deliberately NOT `"docker"`: asserting the fallback would pass whether or not anything was injected at all.

### §52. Widened from one field to the whole launcher slice

M23.2 WIDENS THIS CASE FROM ONE FIELD TO THE WHOLE LAUNCHER SLICE, and the widening is not housekeeping — it is the same defect one level up. The adapter SELECTION (`SCP_MANAGED_RUNNER_LAUNCHER`) travels the identical route and has a larger blast radius: omitted from THIS path, the ordinary bump dispatch would keep shelling out to `docker` on a Kubernetes deployment while every bound executor moved to Jobs — i.e. M21's actuator would remain exactly as dead as M23 exists to fix, on the path that actually runs. The unit-level `managed-runner-selection.test.ts` covers `managedDepServerSettings()`; only THIS test can see what `managed-dep-instance.ts` puts in the instance config it starts.

### §53. A refusal raised in phase four carries a decision id

A REFUSAL RAISED IN PHASE 4 CARRIES A `decision_id` LIKE EVERY OTHER ONE (principle 6)
"Every blocked response carries a `decision_id`." A throw out of the dispatch itself — the runner image not configured on this deployment, an unresolvable binding, an unreachable plugin host — was the one class of merge refusal that left NO Decision at all: the job logged and moved on, and an operator had nowhere to see that a merge had been authorised and had not happened.

### §54. The freeze, and the one act that merges into a repo

M25.8 — THE FREEZE, AND THE ONE ACT THAT MERGES INTO A TENANT REPOSITORY (owner decision D8)
WHAT WAS TRUE BEFORE, MEASURED RATHER THAN ASSERTED: `grep -rna "freeze"` over `apps/server/src/dependencies/` returned four hits, every one an unrelated comment about an inventory "freezing"; the same grep over `apps/server/src/governance/` returns 512, which is the known-positive control that makes the first number evidence instead of an empty result. The actuator entered no governance gate at all, so a declared change freeze did not stop SCP from opening AND auto-merging a version bump into the frozen org's repositories.

D8's boundary is narrower than "refuse the bump": a freeze blocks AUTO-MERGE and does NOT block PR authoring. So the cases below are paired that way — the merge is withheld, and the pull request is asserted to be open and to stay open in the same breath.

EVERY CASE DRIVES `runBumpGateJob` DIRECTLY, which is the exact function the gate worker runs (`gateDeps()` exists for this). It is not a shortcut past the production seam: `authoredAndPushed` deliberately consumes the authored push's observed-bump event without relaying it, so no gate job is queued and there is no loop to race. That determinism is what makes the dedup case below able to count Decisions at all.

### §55. A bump that is authored, pushed, and EVIDENCED GREEN

A bump that is authored, pushed, and EVIDENCED GREEN — every input the auto-merge grant reads is in place and satisfied.

That is the whole point of the fixture: after this, the only thing in the world that can withhold the merge is a freeze. A case built on a bump that could not merge anyway would pass against an implementation that reads no freeze at all, which is this repo's recurring "green for the wrong reason" shape.

### §56. Declared at the org root, not at the component

DECLARED AT THE ORG ROOT, NOT AT THE COMPONENT, and that is the assertion inside the assertion. A freeze above the component reaches it only through `containmentChain`; the hand-rolled `domain_id`-only walk `freeze-scope.ts`'s header records made exactly this shape fail OPEN, silently, because a freeze that stops matching produces the same `allow` a freeze that never existed would. A component-scoped fixture would pass against that bug.

### §57. Stated the other way too, for the same reason

…and stated the other way too, because the assertion above is also satisfied by a context that records `endsAt` AND a timestamp beside it. Nothing anywhere in this context may be an instant from around the moment the verdict was taken: that is the property that makes the row dedup, and recording the clock instead is what produced a measured 1.44 GB/day in production (ADR-0024).

### §58. Deployment-wide, and that is forced rather than chosen

DEPLOYMENT-WIDE, and that is FORCED rather than preferred. The freeze is resolved against the COMPONENT whose dependency is being bumped; a component is not a placement and declares no stage coordinate, so `readStageCoordinate` answers null and an environment-addressed platform freeze covers nothing here. `bump-merge-freeze.ts` states that consequence in prose; this is the case that makes the statement checkable.

### §59. The other act named merge, in a different file

THE OTHER ACT NAMED "MERGE", and the one that does not live in a file called `bump-gate.ts`. `@scp/plugin-managed-dep`'s `publishBump` returns early after opening the pull request ONLY when `delivery === "pull_request"`; otherwise it falls through to its step 6 auto-merge tail, reaching the provider through the same call the standalone merge action uses. So guarding the gate alone would have guarded one of the two and left the other open — an instance fixed rather than a class.

### §60. The gate runs and refuses

The gate runs and refuses — but it DEPOSITS the `control_runs` row on its way through, which is exactly what makes the next dispatch's `resolveEffectiveDelivery` able to GRANT auto_merge. That grant is the precondition of this case: before it, a first dispatch has no evidence and resolves to `pull_request` for reasons that have nothing to do with a freeze, and the assertion below would pass against no freeze check at all.

### §61. The producer of the next attempt, driven differently

M25.8b — THE PRODUCER OF "THE NEXT ATTEMPT"

Every case above drives the gate by CALLING `runGate` — including "when the freeze is LIFTED, the very next attempt MERGES", which is why that case, though correct, is structurally incapable of seeing the defect these three close: it PERFORMS BY HAND the attempt production never scheduled. The only producer of gate jobs is `observedBumpRouter`, driven by a provider webhook about the bump's branch; a freeze expiring, being lifted or being shortened touches no repository and produces no such event; and `runBumpGateJob` returns normally on a `frozen` refusal, so pg-boss never retries it. The three cases below therefore go through `runBumpFreezeRedriveSweep` — the thing that did not exist — and never through `runGate`.

### §62. AND THE ENQUEUE IS REAL WORK, NOT A RETURN VALUE

AND THE ENQUEUE IS REAL WORK, NOT A RETURN VALUE. The job lands on the same `dependency-bump-gate` queue `observedBumpRouter` uses and is drained by the REAL `startBumpGateLoop` worker this file started in `beforeAll` — so what is asserted here is the merge itself, reached with no test in the path between the sweep and the provider. `merged_at` is the engine's own durable write (`markBumpMerged`), polled for rather than slept on.

### §63. With no required checks, the gate names no control

No `requireOwnChecks`, so the governed gate names no control for this component and grants nothing: `not_evidenced`. The bump is open, has a recorded pull request, and NO freeze stands over it — so the ONLY thing keeping it off the work-list is the refusal it carries. A sweep keyed on "open bump" instead would re-drive every dependency pull request anybody has left waiting on CI, and the gate's PHASE 2 deposits `control_runs` rows each time.

### §64. An unreadable repository is not an empty repository

AN UNREADABLE REPOSITORY IS NOT A REPOSITORY WITH NOTHING IN IT
`probeDependencyUpdateDelegation` used to swallow every read failure into `unreadable` and return `delegated: false`, which is byte-identical to a clean repository — so a bad credential produced an `allow` Decision and an authored commit, and the `delegation_probe_failed` branch this asserts was UNREACHABLE. It is the one refusal standing between SCP and two actuators editing one file, so "we could not check" must never resolve to "go ahead and write to it".

Driven through `runBumpDispatchJob` — the exact function the worker runs — because the outcome this needs to assert (the NAMED skip) is that function's return value, and the loop swallows it into a log line.

### §65. The refusals that keep the class off unusable providers

4. THE REFUSALS THAT KEEP THE CLASS OFF, AND OFF THE PROVIDERS IT MAY NOT USE

Each of the three below survived DELETION with both the unit suite and this integration suite green — including the one that keeps the whole class off by default. They are the seam between "an operator enabled managed execution" and "a container ran with a repository-write credential", so each gets an assertion of its own rather than a comment claiming it is there.

### §66. The refusal lands before anything is started

The refusal lands BEFORE anything is started, which is the whole shape of ADR-0006: no container could have been launched and no credential minted.

ASSERTED AS AN EMPTY SET, not as "does not contain `managed-dep:<pluginInstanceId>`". That form CANNOT FAIL: the id this code builds is `managed-dep:<bindingRowId>:<runToken>`, so the string it asserted the absence of is one nothing has ever produced — with the accumulator module-level and never reset, it was a negative assertion about a value from no code path.

### §67. The clause is about credentials, not provider preference

The charter clause this enforces is a CREDENTIAL clause, not a provider preference: Gitea and GitLab tokens are standing credentials scoped to a user or a group, and the amendment authorising this class requires "issued per run, scoped to the single repository under change". `repo-write.ts`'s `resolveRepoWriter` refuses them too; refusing HERE is what makes the message name the binding and the component rather than surfacing as a plugin error with neither in it.

### §68. THE BUG THIS PINS

THE BUG THIS PINS. `baseBranch` came from `dueDeclarations[0].observedRef` and was then applied to EVERY due declaration, so the second manifest here was edited on `main` although it was only ever read at `dev`. The module's own comment states the invariant it broke — "a bump composed against `main` but observed on another ref would be built on a file this component may not have there" — and enforced it for one declaration out of two.

A REFUSAL RATHER THAN A PER-BRANCH DISPATCH, deliberately: the `dependency_delegation` verdict is keyed on the COMPONENT, so probing two sources in one run would write two verdicts under one subject and let an `allow` earned by one stand as the answer for the other.

### §69. That helper is not the only way the instance can arise

`startManagedDepInstance` is not the only way a `managed-dep` plugin instance can come into being: an operator can create an `executor_bindings` row for it by hand, and that path goes through `resolveExecutorPluginInstance` instead. Two doors, one class, so the off-by-default refusal has to be on both — and the SIBLING classes' identical refusals in that same function (`managed-iac`, `managed-scan`) are asserted beside it, because a refusal with no test is what this block exists to stop being normal.

## `apps/server/src/dependencies/bump-dispatch.test.ts`

### §70. The three pure decisions the dispatcher makes

M21.5 — the three pure decisions the bump dispatcher makes, pinned without a database.

The WIRING is proven in `bump-dispatch.integration.test.ts`, through the router, the queue and the loop; this file covers the parts that would otherwise only be exercised incidentally by it — the role guard's two axes, the router's predicate, and the plan that decides what a bump would SAY.

### §71. The census the integration suite structurally cannot do

THE CENSUS THAT `bump-dispatch.integration.test.ts` STRUCTURALLY CANNOT DO
That file registers the router and starts the loop ITSELF, because that is the only way to drive them deterministically against a Testcontainers database. Which means it would keep passing if the composition root never wired either one — the production process would start with no router on `domain-events` and no worker on `dependency-bump`, and every subscribed component would receive nothing, forever, with a green suite. That is the EXACT failure this milestone exists to close, four times over, so it gets an assertion of its own rather than a reviewer's attention.

BOTH HALVES ARE NOW ASSERTED BY RUNNING THEM, and neither is a substring any more.

The ROUTER half moved first (M21.7): the router list lives in `events/domain-event-registry.ts`, a pure importable value. The LOOP half followed (2026-08-17): the eleven loop startups moved out of `main.ts` into `background-work.ts`'s `BACKGROUND_LOOPS`, for exactly the same reason and after exactly the same measurement.

WHAT THE SUBSTRING VERSION OF THIS BLOCK WAS WORTH, measured twice: - commenting out `const bumpDispatchLoop = await startBumpDispatchLoop(boss, {…})` left this describe block — INCLUDING the case named "starts the worker, and stops it on shutdown" — passing 20/20, and the whole apps/server unit suite green at 972/972 (M21.7, on RAW text); - flipping `main.ts`'s background-work condition to `false`, killing this loop and ten others, left it green again — this time even with comments stripped, because stripping cannot see a dead branch.

So the claim below is now membership in a registry that `background-work.test.ts` STARTS, checked by FUNCTION IDENTITY. `@scp/source-census`'s package doc lists what the text version could never have proven; this file no longer relies on any of it.

### §72. Identity, not name

Identity, not name: the mis-binding this rules out is the registry pairing this router with some OTHER capability's guard, and thereby authoring repository writes from an outpost. Until ADR-0032 §7d (2026-08-17) that hazard was concrete — internal detection's guard allowed every federation role, so binding to it would have been a live escape. Every dependency guard now reaches the same verdict (`commander-only.test.ts` proves that across the full matrix), which makes this assertion a defence against the NEXT divergence rather than a current one — and that is exactly when an identity check is worth keeping rather than deleting.

### §73. `boss.work` on `domain-events` does not deduplicate

`boss.work` on `domain-events` does not deduplicate — a second worker there STEALS M21.4's events and receives roughly half of its own. An ABSENCE assertion, so it deliberately reads the files RAW: a comment marker only makes a violation harder to hide, and stripping would narrow what counts as one (`@scp/source-census`'s hash.ts doc states this rule).

Both composition files, because the loops MOVED: checking only `main.ts` after 2026-08-17 would be a census aimed at where the code used to be — the exact "fixed some call sites" failure CLAUDE.md names.

### §74. OPTIONS ARE CAPTURED AND ASSERTED EMPTY on purpose

OPTIONS ARE CAPTURED AND ASSERTED EMPTY on purpose. This used to send `{ singletonKey: lineId }` with a comment claiming it collapsed a redelivery; pg-boss scopes every `singleton_key` uniqueness index to the `short`/`singleton`/`stately` policies, and this queue is created with the default `standard`, so the key was recorded and ignored. An inert option is invisible unless something looks at it — so this looks.

### §75. A file KIND the write allowlist does not name

A file KIND the write allowlist does not name — `kustomization.yaml` is inventoried nowhere and writable nowhere, and it is the shape that stays refused now that M21.7's split-shape round opened `values.yaml`. Refused here so the Decision carries a reason an operator can act on; dispatched, it would come back as the plugin's own `not_a_known_manifest`, which reads as a broken runner.

### §76. The behaviour change the split-shape round exists for

This is the behaviour change the split-shape round exists for. Until it landed, an image pinned in Helm values was visible-but-unbumpable: SCP could see 3.19.1 existed and refused to author the edit. The `values.yaml` basename is now on both restatements of the write allowlist, and the plugin locates `image: {repository, tag}` by an anchor derived from the manifest's own parse.

### §77. A declaration pinned by a digest as well as a tag

ADR-0032 §8i — A DECLARATION PINNED BY A DIGEST AS WELL AS A TAG.

The defect this pins was silent and complete: the whole pipeline ACCEPTED a tag-only edit of `{repository, tag, digest}` (and of `FROM alpine:3.19@sha256:…`), every verifier agreed, and the pull request merged — while containerd went on resolving by the untouched digest, so the running image never moved. Nothing errored. The only observable was a manifest that named 1.2.4 in its tag and 1.2.3's bytes in its digest.

### §78. The write allowlist, pinned across both modules

THE WRITE ALLOWLIST, PINNED ACROSS THE TWO MODULES THAT RESTATE IT.

`manifestIsEditableInThisBuild` (server) and `manifestParserFor` (`@scp/plugin-managed-dep`'s `MANIFEST_MATCHERS`) are the same closed set written twice — the convention `BUMP_BRANCH_PREFIX` already follows, because the server may not take a build-time dependency on a plugin package. Two copies of an allowlist is precisely the incomplete-census shape, so this is where they are proven equal, IN BOTH DIRECTIONS: a path the server would let through and the plugin refuses is a wasted container and a misleading verdict; a path the server refuses and the plugin would accept is a bump this build silently stops authoring.

## `apps/server/src/dependencies/bump-dispatch.ts`

### §79. The thing that actually proposes and dispatches a bump

M21.5 — THE THING THAT ACTUALLY PROPOSES AND DISPATCHES A BUMP (ADR-0032 §8/§9).

WITHOUT THIS FILE, M21.5 WAS THREE FUNCTIONS NOBODY CALLED
`recordBumpChange`, `resolveEffectiveDelivery` and `buildBumpIntentParameters` were built, tested and correct, and measured filterlessly at the time NOTHING in the tree constructed a `managed-dep` `TriggerIntent`: no job, no route, no loop, no worker. A subscriber to a line whose head advanced received nothing, forever, with no error anywhere. That is the fourth time in M21 something was built and never installed, which is why the definition of done for this increment is WIRED — and why the test that proves it drives the ROUTER and the JOB rather than the functions.

THE SHAPE: ROUTE ON THE SHARED STREAM, WORK ON THIS CAPABILITY'S OWN QUEUE
```text
recordDependencyLineHead (the ONE write door, both ingresses)
   -> outbox `scp.dependency.line_head_advanced`   [same transaction as the head write]
   -> domain-events -> `advancedLineHeadRouter` (one cheap predicate + one enqueue)
   -> `DEPENDENCY_BUMP_QUEUE` -> this file's worker -> a change, then a dispatch.
```

`boss.work()` is a COMPETING consumer, so this cannot be a second worker on `domain-events`: it would steal roughly half of M21.4's internal-release events and receive roughly half of its own (`events/pgboss.ts`'s `DomainEventRouter`). The router is the fan-out point and does no work — a repository write's latency and retry budget must not sit on the shared event stream.

WHY THE EVENT IS EMITTED AT THE WRITE DOOR rather than by each ingress is argued where it is emitted (`dependency-inventory-repo.ts`): the two ingresses have already demonstrated that a rule applied per caller regresses per caller.

THE WORK-LIST IS M21.3'S RESOLUTION. THERE IS NO SECOND FILTER HERE.
`listSubscribedComponentLines` returns exactly the (component, line) pairs whose monotone AND resolved TRUE, so an unsubscribed component is never bumped BY CONSTRUCTION (ADR-0032 §6). This file writes no predicate over enablement — not a `WHERE`, not an `if`. The one narrowing it does apply is `componentObjectIds`, which is a narrowing of the SCAN (the components that declare this line, from the reverse index) and not of the ANSWER: every candidate still goes through the merge.

IDEMPOTENT UNDER REDELIVERY, AT EVERY HOP
The outbox->pg-boss path is at-least-once and there are two hops that can redeliver. Nothing on this path appends:

- a bump change is looked up BEFORE it is proposed (`findOpenBumpAuthorship`), keyed on the (component, manifest, coordinate, target version) SCP ITSELF RECORDED in `dependency_bump_authorships` — so a redelivery re-uses the existing change and its existing branch instead of minting a second, while two components subscribed to the SAME line each get their own (that function's header says why every field of that key has to be compared, and what happened when two of them were not); - the dispatch carries `idempotencyKey = <changeObjectId>`, which is what the plugin's own outcome cache keys on, and the branch it authors carries that same id — so a retry that gets past the cache still converges on one branch and one pull request; - the verdict goes through `insertDecisionIfChanged`, whose inputs here are stable facts only; - the head is RE-READ from the row rather than trusted from the event.

THE ROLE GUARD — COMMANDER-ONLY, WITH ITS OWN REASON ON TOP OF THE SHARED ONE
Since ADR-0032 §7d (owner decision, 2026-08-17) EVERY dependency job is commander-only, so this verdict is no longer the strict one in a split field — it is the shared rule, and the shared reason lives in `commander-only.ts`: dependency automation exists to pull from PUBLIC repositories, which a FIELD outpost has no need to do, because the resulting change is pushed down the global pipeline the commander manages. ("Field" is load-bearing — an HQ outpost is the outpost in the commander's own trust domain and is this very process; see `commander-only.ts`, which reads that out of the code. Every deployment this guard actually refuses is a field outpost, so the refusal strings below say "outpost" exactly.) (This paragraph used to open by contrasting M21.4's two jobs, which "reached OPPOSITE verdicts on the federation axis"; they no longer do, and internal detection no longer "runs everywhere" — §7d marks that clause reversed.)

THIS JOB'S OWN REASON SURVIVES THE CONVERGENCE AND IS STILL WORTH STATING, because it is what would keep the guard here even if the shared rule were ever relaxed: it does not merely READ from the internet, it WRITES to somebody's source repository, with a credential, on a trigger nobody watched. An air-gapped or high-side outpost must never do that. The guard is fail-CLOSED on an UNDECLARED deployment, because `SCP_FEDERATION_ROLE` defaults to `commander` for deployments that predate the setting — and that is exactly the population most likely to be air-gapped. It also logs when it ALLOWS: a posture that writes to a user's repository must not be the invisible one.

The process axis (`SCP_ROLE`) applies unchanged — background work belongs to `all`/`worker`.

WHAT IT REFUSES TO GUESS
Every branch that cannot state the bump precisely records a NAMED reason and dispatches nothing. A missed bump is visible (the component keeps declaring the old version); a wrong one is a commit in somebody else's repository. The named reasons are `BumpRefusalReason` and each is its own cause — a reason named after the branch that matched goes false the moment that branch covers a second case (ADR-0032 §7b clause 6, charter principle 6).

### §80. No dedup option, and the comment that was here was false

NO DEDUP OPTION, DELIBERATELY, AND THE COMMENT THAT USED TO BE HERE WAS FALSE.

This passed `{ singletonKey: lineId }` and claimed it "collapses a redelivery of the SAME advance that arrives while an earlier job for it is still queued". It does not: pg-boss enforces `singleton_key` uniqueness through three PARTIAL indexes, every one of them scoped `WHERE ... policy = 'short' | 'singleton' | 'stately'` (`pg-boss/src/plans.js`). This queue is created with `boss.createQueue(name)` and therefore has the DEFAULT `standard` policy, for which no such index exists — so the key was recorded and ignored, and the sentence describing it was a control that did not exist.

The queue keeps `standard`, and that is the deliberate half. `short` WOULD make the key bite, by REJECTING a send while an earlier job for the same key is still `created` — and this job's whole safety story is that it is idempotent and RE-DERIVES from the row rather than trusting the event, so collapsing was only ever an optimisation ("never the correctness argument", as the old comment itself said). Trading a queue's rejection semantics for an optimisation that is not load-bearing is the wrong direction; an inert option with a sentence explaining its importance is worse than neither.

### §81. Is a bump due for THIS declaration, and what would it say?

Is a bump due for THIS declaration, and what would it say?

THE EDIT IS COMPOSED BY SUBSTITUTION, NOT BY FORMATTING. `component_dependencies.declared_version` is what the manifest literally holds (`^1.2.3`, `~=1.4`, `v1.2.3`, `3.18-alpine`) and `resolved_version` is the concrete version parsed OUT of it. The new text is the declaration with that concrete substring replaced by the head — so `^1.2.3` becomes `^1.3.0` and keeps its range operator, and `v1.2.3` keeps its `v`. Re-rendering a declaration from a parsed triple would silently drop whatever the parser did not model, in a file this system then commits.

A declaration whose resolved version is not a substring of it is REFUSED rather than reformatted: the two columns disagree about what the file says, and every way of proceeding from there is a guess about somebody else's manifest.

### §82. A DECLARATION PINNED TWICE

A DECLARATION PINNED TWICE (ADR-0032 §8i). `alpine:3.19@sha256:…` in a Dockerfile and `{repository, tag, digest}` in a chart's values both name the release AND the bytes, and every container runtime resolves by the DIGEST when one is present — the tag is then a label. So an edit that moves the version text alone changes the manifest and not the image that runs: the pull request reads as an upgrade, delivers nothing, and leaves the file asserting one release in its tag and another's bytes in its digest.

NOT GUESSED AT, EITHER WAY. The digest for `head` is known — `dependency_lines.latest_digest`, written by the same poll that moved `latest_version` and never inherited across a version change (`line-head.ts`) — so the data for a correct two-token edit exists. What does not exist is a one-line edit that carries it in the SPLIT shape, and `verifyManifestBump`'s "exactly ONE line differs" is a charter-enforcing refusal that is not widened to a pair as a side effect of this. Refused with its own name, and the follow-up is `split-shape-image-bumps.md` §11.

ASKED BEFORE EDITABILITY, and the honest reason is narrower than it looks: EITHER order refuses the same set — a digest-pinned Dockerfile is a writable kind, so it reaches this check whichever side of it the allowlist question sits on. What the order decides is which reason the Decision CARRIES when both apply, and "your declaration pins bytes as well as a version" is a fact about the manifest the team owns, while "this build does not write that file kind" is a fact about SCP. The first is the one they can act on.

### §83. Run ONE queued job

Run ONE queued job. Exported so an integration test drives the exact function the worker runs.

PHASES, and the split is the one M21.4 §7c clause 2 already established: read in a transaction, do provider I/O OUTSIDE any transaction, write in a transaction. Holding an RLS-scoped pooled connection across a git round trip — against a 5s production `statement_timeout` and a bounded pool — is the failure both M21.4 ingresses are arranged to avoid, and a repository WRITE is a longer round trip than either of them.

### §84. The system actor, exactly as the two ingresses resolve

The system actor, exactly as M21.4's two ingresses resolve. It has no `objects` row and so is a transitive `member_of` nothing — which is NOT, as this comment used to claim, the reason a GROUP-scoped `dependencySubscription` effect is refused at authoring time. Group scope's OWNING half ignores the actor entirely, so such a policy can match right here (ADR-0032 §6a-ii). The refusal is about a reach decided by mutable `owns` edges instead of by the author.

### §85. PLUGIN INSTANCES DERIVED FROM A WORK-LIST NEED A LIFECYCLE

PLUGIN INSTANCES DERIVED FROM A WORK-LIST NEED A LIFECYCLE (ADR-0032 §7c clause 4). These instances come from this job's own candidate list — up to one per component per org, started on demand — not from operator configuration that persists. Stopped from a RECEIPT of what this code started, never from a second derivation of what "should" be running. (The git-provider instances the delegation probe starts are the OTHER kind — ordinary binding instances the reconcile/observe loops also hold — and `manifest-reader.ts` documents why those are left up.)

### §86. One repository and ref for the dispatch, grouped for

ONE (repository, ref) FOR THE WHOLE DISPATCH, AND IT IS GROUPED FOR RATHER THAN ASSUMED.

The paragraph above states the invariant — observed_ref is the only honest base for an edit — and the code enforced it for the FIRST due declaration only: `dueDeclarations[0].observedRef` became `baseBranch` and every other declaration was then dispatched against it. A component may legitimately declare one line from several manifests observed in DIFFERENT repositories or at different refs — `ingestion-stamp-repo.ts` names the shape ("`acme/widgets` (a go.mod) and `acme/charts` (a Dockerfile) each produce their own pass") — and every such declaration after the first was edited on a branch it was never read at.

REFUSED, NOT DISPATCHED PER GROUP, and the reason is the delegation verdict rather than effort. `readStandingDelegationVerdict` reads the LATEST `dependency_delegation` Decision for the COMPONENT: one verdict per component, not per repository. Probing two repositories in one run would write two verdicts under one subject, they would alternate on every advance, and an `allow` earned by repo B would then stand as the answer for repo A — a fail-open in the one guard that keeps two actuators off one file. Per-repository dispatch needs a per-repository verdict first; until then the honest answer is to author nothing and say why.

### §87. AND THE BINDING MUST NAME THAT REPOSITORY

AND THE BINDING MUST NAME THAT REPOSITORY. `pickComponentGitBinding` sorts the component's git-provider bindings by id and takes the first, which for a component bound to two repositories is an arbitrary choice — so without this the credential and the repository path could both come from a binding that has nothing to do with the manifest being edited. `observedRepo` NULL is "the repository was not recorded" (drizzle/0063), not a disagreement, so it falls through to the binding exactly as before.

### §88. Phase two: provider I/O, outside any transaction

---- PHASE 2 (provider I/O, OUTSIDE any transaction) --------------------------------------- DOES THIS REPOSITORY ALREADY DELEGATE ITS DEPENDENCY UPDATES TO SOMEBODY ELSE?

This is the WRITER the charter clause needed. `probeDependencyUpdateDelegation` and `recordDelegationProbe` existed with two readers and no producer, so "CommanderSCP refuses to enable dependency subscriptions for a component whose repository already delegates the same manifests to another dependency-update system" was enforced by nothing end to end: the authoring-time guard and the actuator re-check both read a verdict that was never written.

It runs HERE, and here is the only place it can: answering it requires reading files out of the repository, `graph/objects-repo.ts`'s choke point runs inside a transaction holding two per-org advisory locks, and this is the one production path that already has the repository, the ref and the component's declared manifests in hand. The verdict is persisted as a Decision (`insertDecisionIfChanged` — this path repeats per advance, which is the write-amplification shape that cost 1.44 GB/day elsewhere), and BOTH readers then see it: the actuator seam below refuses this very dispatch, and the authoring choke point refuses the next enable.

THE RESIDUAL, stated rather than hidden: a component that has never been a bump candidate has no verdict, so its first enable is not refused at authoring time. That is exactly what `delegation-detection.ts`'s "WHAT ABSENT MEANS" already declares ("no probe on record means NO DELEGATION HAS BEEN OBSERVED"), and it is why the actuator half exists — nothing is written to a delegating repository either way.

### §89. A probe that could not read is not one that found none

A PROBE THAT COULD NOT READ IS NOT A PROBE THAT FOUND NOTHING, and the two are byte-identical in the result unless this is asked: a bad credential, a provider 5xx and an egress refusal all yield `configs: []`, `collisions: []`, `delegated: false`. Treating that as "no delegation here" is the fail-OPEN this whole module exists to prevent, so it is a skip with its cause and NOTHING — no dispatch, and no `allow` Decision either (`recordDelegationProbe` refuses to write one, which is where the rule lives so a second producer inherits it).

### §90. Per declaration, so one refusal cannot stop another

PER DECLARATION, so one component's refused bump cannot stop another's. A thrown refusal here is the delegation conflict (a 409 from `assertComponentNotDelegated`) or a provider failure; both are legible in the skip, and both are re-derivable on the next advance. `ProblemError.message` is the STATUS TEXT ("Conflict"); the sentence an operator can act on is in `detail`. Reading it here is what keeps the delegation refusal legible in the log and in the outcome, rather than reducing "this repository delegates to renovate.json" to a status word.

### §91. Already proposed: a redelivery, or a second advance

ALREADY PROPOSED? A redelivery, or a second advance while the first bump's pull request is still open, must reuse the existing change — its branch is the provenance join and a second change would mean two branches, two pull requests and two releases for one bump.

ASKED OF SCP'S OWN RECORD, not of `changes.source_ref`. The predecessor scanned every dependency-bump change in the org and compared jsonb keys a tenant can write; this is one indexed lookup over server-owned columns (`bump-authorship-repo.ts`, migration 0063).

### §92. M25.8 — THE FREEZE, AT THE SEAM WHERE THIS PATH CAN MERGE

M25.8 — THE FREEZE, AT THE SEAM WHERE THIS PATH CAN MERGE (owner decision D8)
THIS FUNCTION CAN MERGE, and that is the whole reason the check is here rather than only in `bump-gate.ts`. `buildBumpIntentParameters` attaches `expectedHeadCommit` exactly when the resolved delivery is `auto_merge`, and `@scp/plugin-managed-dep`'s `publishBump` then takes its AUTO-MERGE TAIL through the same provider call the standalone merge action uses (`repo-write.ts`: "Both the publish tail and the standalone merge action reach the provider through here"). Guarding only the file named `bump-gate.ts` would have guarded ONE of the two acts named "merge" and left the other open — an instance fixed, not a class.

A DOWNGRADE, NOT A REFUSAL, and that is D8 stated exactly: "a freeze blocks AUTO-MERGE; it does NOT block PR authoring". `pull_request` is already this resolver's more restrictive member and its own documented answer to "this must not merge unattended" — so the trigger below still fires, the branch is still authored and the pull request is still opened, and only the tail is withheld. Refusing the dispatch instead would withhold the visible, queued work D8 exists to preserve, and would ALSO withhold the pull request the component's checks need in order to run at all.

REACHABLE, ON THE SECOND DISPATCH AND AFTER. A first dispatch has no authorship row, so no head commit, so `resolveEffectiveDelivery` has already downgraded and this asks nothing. A redelivery — or a second advance while the first bump's pull request is open, with a control that has since passed for its recorded head commit — is the case that grants, and it is the case that would have merged into a frozen org.

### §93. Absent when nothing is frozen, so the context matches

M25.8 — ABSENT when nothing is frozen, so the context of an unfrozen org is byte-identical to what it was before this increment and no standing Decision is churned by the upgrade. Each entry carries the freeze's `endsAt` and NEVER `now`: this whole path re-runs on every head advance for the length of a window, and recording the clock instead of the boundary is what produced a measured 1.44 GB/day in production (ADR-0024).

### §94. Phase five: record which pull request was opened

---- PHASE 5 (record WHICH PULL REQUEST SCP OPENED) ---------------------------------------- The merge is later addressed to this number rather than found by listing open pull requests on the branch — see `buildBumpMergeIntentParameters`. The only place the number exists is the authoring run's own outcome, so it is ASKED for here (`trigger()` runs this class synchronously to completion, so `status()` reports a finished run) and written to the server-owned authorship row. Recording it is what makes "the pull request SCP itself opened" a fact on disk instead of a search performed against a mutable provider.

THE URL IS TAKEN FROM THE SAME OUTCOME, AND THIS IS THE ONLY MOMENT IT EXISTS. The plugin gets it from the provider's own response (`html_url` on the created pull request, or on the one its 422 retry path re-reads) and hands it back on the same `stateRef` as the number. Nothing downstream can recover it: `repo` + number composes a working link for github.com and for nothing else, and an outpost-local Gitea (M15) is both a different host AND a different path segment. A consumer that synthesised one would render a confidently-broken link on every Gitea-authored bump, so the honest value is captured here or not at all (migration 0066). `recordBumpPullRequest` decides what is storable — this path does not repair or compose one.

A FAILURE HERE IS NOT A FAILED BUMP. The pull request may well exist; what is missing is our record of its number, and the consequence is that the merge gate refuses for lack of one — the fail-closed direction. So it is logged and swallowed rather than thrown, exactly as the rest of this per-declaration path treats a partial outcome.

### §95. Register the capability's worker

Register the capability's worker. Returns nothing the caller has to remember to wire: the ROUTER is registered separately, by `events/domain-event-registry.ts` under `bumpDispatchRoleGuard` — this same guard, by import rather than by copy — and a refused guard contributes NO router, so an event is not even enqueued for a queue nothing will drain.

A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the same shape the version poll, the internal-release loop and the inbox loop use, and for the same reason: a process that merely skipped the work inside the handler would still hold a worker for a queue it will never act on.

## `apps/server/src/dependencies/bump-freeze-redrive.ts`

### §96. M25.8b — THE PRODUCER OF "THE NEXT ATTEMPT"

M25.8b — THE PRODUCER OF "THE NEXT ATTEMPT" (owner decision D8, the half that was missing).

THE DEFECT THIS FILE CLOSES: A REFUSAL THAT PROMISED A RETRY NOTHING SCHEDULED
M25.8 made the auto-merge gate consult freezes (`bump-gate.ts` PHASE 3b) and refuse with `frozen`. The Decision an operator reads says the pull request "stays open … and the next attempt after the window closes merges it". There was no next attempt, and each link was measured rather than assumed:

```text
* The ONLY producer of `DEPENDENCY_BUMP_GATE_QUEUE` jobs was `observedBumpRouter` — one
  `boss.send`, driven by a PROVIDER WEBHOOK correlated to the bump's branch or to its recorded
  head commit. A freeze does not touch the tenant's repository, so no provider event exists.
* A freeze EXPIRING emits nothing at all — expiry is a clock passing a `ends_at` column, not a
  write. Being LIFTED (`DELETE /v1/freezes/{id}`) or SHORTENED (`PATCH`) writes the row but
  emits no outbox event that any dependency consumer subscribes to.
* `runBumpGateJob` RETURNS NORMALLY on a `frozen` refusal (it is a verdict, not a fault), so
  pg-boss records the job complete and never retries it.
```

Net effect, and it is strictly worse than the bug D8 closed: before M25.8 a bump merged during a freeze; after it the bump NEVER merged, silently, with the pull request stranded and the latest Decision asserting the opposite. The wave side never had this shape because `reconcile.ts` re-READS the freeze predicate every tick; the bump side is event-driven and had no equivalent. This file is that equivalent.

WHY A SWEEP AND NOT A JOB SCHEDULED AT `endsAt`
A freeze stops covering a bump three different ways, and only one of them is `endsAt`:

```text
1. the window simply CLOSES;
2. an operator LIFTS it early (`DELETE /v1/freezes/{id}`, `DELETE /v1/instance/freezes/{key}`);
3. an operator SHORTENS it (`PATCH /v1/freezes/{id}`, `PUT /v1/instance/freezes/{key}`).
```

A delayed job posted at refusal time for `endsAt` covers (1) and MISSES (2) and (3) — which are the two an operator performs deliberately and then watches for. Worse, (3) can also move `endsAt` LATER, so a job pinned to the old boundary would re-drive into a still-standing freeze. A sweep that RE-ASKS the question covers all three with one mechanism and needs no event from the freeze doors at all, which is also what keeps M25.1/M25.2/M25.3's write surfaces free of a coupling to this feature.

THE CANDIDATE PREDICATE IS `frozen`, SPECIFICALLY — NOT "EVERY OPEN BUMP"
The narrowing is the whole safety argument. Re-driving every open bump would re-enter gates that are legitimately waiting for CI to conclude, and PHASE 2 of that gate RUNS CONTROLS — a real control plugin call against a real provider, depositing `control_runs` rows — once a minute, forever, for every bump anybody left open. So a candidate is an open bump whose LATEST `DEPENDENCY_BUMP_MERGE_DECISION_KIND` Decision says `refusal: "frozen"`: the gate itself has already decided that everything except the calendar was satisfied.

That predicate is also SELF-LIMITING in the direction that matters. A re-driven gate writes a new latest Decision — `merged`, or some other refusal — and the bump stops being a candidate at once. Only a bump that is STILL frozen (or freshly frozen again between this read and the job) stays on the list, which is exactly the set that should be re-asked.

ONE FREEZE RESOLVER, IMPORTED — NEVER A SECOND WINDOW PREDICATE
"Does anything still cover this bump?" is answered by `checkBumpMergeFreeze`, the SAME function `bump-gate.ts` refuses on, which is itself `freeze-scope.ts`'s `freezesByTarget`. Nothing here re-derives a window comparison, a tier union or a containment walk. A hand-rolled `domain_id`-only walk once made a SERVICE-scoped freeze fail OPEN (see `bump-merge-freeze.ts`'s header); the same hand-rolling here would fail in the OTHER direction — a bump re-driven while a freeze it could not see still stands — and the gate would then merge it, because the gate is what this sweep hands the decision to. The gate re-asks too, so the sweep's answer is an admission filter and not the last word; but a filter that disagrees with the gate is a filter that wakes the gate for nothing at best, and this way there is only one answer in the tree.

WHAT IT COSTS WHEN NOTHING IS FROZEN
One indexed read per org per minute for the OPEN bumps (`merged_at IS NULL AND pull_request_number IS NOT NULL` — the set is bounded by how many dependency pull requests are awaiting a merge, i.e. by human review throughput, not by history), then one single-row Decision probe per open bump served by `decisions_org_subject_kind_created`. `checkBumpMergeFreeze` — the only part that walks a containment chain — is reached ONLY for a bump already refused `frozen`, so a deployment that has never declared a freeze pays no freeze resolution at all.

### §97. Sixty seconds, and the number is a judgement

60 SECONDS, and the number is a judgement rather than a copy.

The daily cadence the version poll uses is right for reaching out to package indexes and wrong here: an operator who lifts a freeze at 09:00 expects the queued pull requests to land, and "some time in the next 24 hours" reads as broken. A minute is the coarsest interval that still reads as "it happened when I lifted it", and the tick is two indexed reads per org when nothing is frozen. It is NOT the reconcile loop's ~1 s either: nothing here is a lifecycle transition a user is watching a spinner for, and the act at the end is a repository write.

### §98. One org, one tick

One org, one tick. Exported so a test can drive a single tenant, and so the sweep below is nothing but the per-org call in a loop.

READS IN ONE TRANSACTION, ENQUEUES OUTSIDE IT — the split `bump-gate.ts` documents as ADR-0032 §7c clause 2. `boss.send` reaches a different database (`pgBossDatabaseUrl`) and cannot be part of the tenant transaction, so holding the transaction open across it would only lengthen it.

AT-LEAST-ONCE, DELIBERATELY. A crash between the send and the gate running re-drives on the next tick, because nothing here records that it enqueued — the CANDIDATE PREDICATE is the state. A duplicate gate job is harmless by construction: `runBumpGateJob` re-derives every fact from `dependency_bump_authorships`, and a bump that merged in the meantime is stamped `merged_at` and returns before dispatching anything.

### §99. The shipped resolver, on the component the gate uses

THE SHIPPED RESOLVER, ON THE COMPONENT THE GATE ITSELF RESOLVES AGAINST — called ONCE for every frozen candidate in this org's tick rather than once per bump, so `freezesByTarget`'s two guard reads (its own doc: "two indexed queries are what make a change with nothing frozen cost nothing") run once instead of N times whenever a freeze withholds several bumps at once, the realistic case. An empty `freezes` list is the only admitting answer, meaning precisely "nothing covers this any more" — expired, lifted or shortened, indistinguishably, which is why one mechanism covers all three release paths. `freezesByTarget` returns one entry per input id in order, so the result zips back onto `frozenBumps` by index.

### §100. The same job shape, onto the same queue

The SAME job shape `observedBumpRouter` sends, onto the SAME queue, so the re-drive and a provider event are indistinguishable to the worker — there is one gate path, not two. No dedup option, for the reason that router states: this queue carries pg-boss's default `standard` policy, which maintains no `singleton_key` index, so the option would be recorded and ignored.

### §101. Self-rescheduling pg-boss loop

Self-rescheduling pg-boss loop — `startDependencyVersionPollLoop`'s `startAfter` + `singletonKey` shape exactly (there is no `boss.schedule` usage anywhere in this tree to copy, ADR-0032 §7), at a per-minute rather than a daily cadence.

THE ROLE GUARD IS `bumpDispatchRoleGuard`, IMPORTED RATHER THAN RESTATED — the same object `startBumpGateLoop` and `startBumpDispatchLoop` consult. It has to be the same one in both directions: an outpost must never initiate a repository write (so this must not run there), and a refused gate loop never CREATES `DEPENDENCY_BUMP_GATE_QUEUE`, so a sweep that ran anyway would send to a queue that does not exist and fail every tick loudly for no purpose.

A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the shape every other background loop uses. A process that merely skipped the work inside the handler would still be waking every minute to decide to do nothing.

## `apps/server/src/dependencies/bump-gate.test.ts`

### §102. M21.5's AUTO-MERGE LINK

M21.5's AUTO-MERGE LINK — the parts of it that are decidable without a database.

The behaviour is proven end to end in `bump-dispatch.integration.test.ts` ("the auto-merge link"), through the real ingress, the real router, the real queue, the real worker and the real governance gate. This file covers the two things that suite structurally cannot: that the COMPOSITION ROOT wires the router and the loop at all, and that the merge intent's parameter shape is the one the plugin will accept.

### §103. The census, because the integration registers the router

THE CENSUS — because the integration suite registers the router ITSELF
This is the identical hazard `bump-dispatch.test.ts` records, one link further down the chain: an integration test that starts its own pg-boss and its own loop passes whether or not `main.ts` ever builds them, and a production process with no router on `domain-events` and no worker on `dependency-bump-gate` would resolve `auto_merge`, downgrade it forever, and be green everywhere. That is the fifth instance of "built and never installed" this milestone exists to not become a sixth of, so it is asserted rather than reviewed.

THIS BLOCK NO LONGER READS `main.ts` AT ALL, and the history of why is the point.

It used to be three substring assertions. Measured on this very block (M21.7): commenting out `const bumpGateLoop = await startBumpGateLoop(boss, {…})` and its `.stop()` left all 11 cases green — and not only the two `toMatch`es. The "hands it the SHARED CEL sandbox" arm sliced the call out with a regex and asserted on its TEXT, so it happily read `getSharedCelSandbox()` and `host: pluginHost` out of the COMMENTED-OUT call.

Stripping comments (`readStripped`) fixed that one case and not the class: a call in a DEAD BRANCH survives stripping untouched, and on 2026-08-17 flipping `main.ts`'s background-work condition to `false` left this file green again with the gate loop never starting.

So the loop startups moved into `background-work.ts`'s importable `BACKGROUND_LOOPS`, and every assertion below RUNS the registry entry instead of reading about it. The one census left in this file is an ABSENCE assertion (no competing consumer), which is deliberately raw — see its comment.

### §104. This was a regex over text, and what replaced it

WAS a regex that sliced `startBumpGateLoop(…)` out of `main.ts` and asserted on its TEXT. That check was satisfied by a COMMENTED-OUT call (measured, M21.7), and once comments were stripped it would still have been satisfied by a dead branch. It is now a question about what the registry entry DOES: does it take the sandbox from the one shared context, or fetch its own?

The observable is the READ. If this entry were changed back to `sandbox: getSharedCelSandbox()` — the pre-extraction shape, which relied on that function memoising — `ctx.sandbox` would never be touched and this goes red.

### §105. `boss.work` on `domain-events` does not deduplicate

`boss.work` on `domain-events` does not deduplicate — a second worker there steals M21.4's and the dispatcher's events and receives roughly half of its own. An ABSENCE assertion, so it reads RAW on purpose: a comment marker only makes a violation harder to hide, and anchoring would narrow what counts as one (`@scp/source-census`'s hash.ts doc states that rule).

BOTH composition files, because the loop startups moved out of `main.ts` on 2026-08-17 — a census still aimed only at the old location is the "fixed some call sites" failure CLAUDE.md names as recurring here.

### §106. The producer: the one place the trigger is emitted

THE PRODUCER — the one place the trigger is emitted
The gate job is worthless without something enqueuing it, and the enqueue is worthless without an outbox row. `bump-dispatch.integration.test.ts` proves the whole chain against a real database; this pins the SITE, because the emit lives in `coordination/webhook-processor.ts` — a file the dependencies suite has no other reason to look at, and a place a later edit could quietly drop it from while every dependency test stayed green.

Stripped for the same reason as the block above, and here the raw read was arguably worse: this census slices a BRANCH out with `/if \(authoredChangeId\) \{[\s\S]*?continue;/` and asks what is inside it. Comments are the bulk of that branch's text, so a `writeOutboxEvent` named only in a comment explaining the emit satisfied the assertion just as well as the emit did.

### §107. The merge descriptor the server builds is one accepted

THE MERGE DESCRIPTOR THE SERVER BUILDS IS ONE THE PLUGIN ACCEPTS
Same reasoning as `delegation-detection.test.ts`'s equivalent block for the authoring descriptor: the server BUILDS this object and the plugin PARSES it, across a plugin-host RPC boundary where the wire type is `Record<string, unknown>`. Typechecking proves nothing about that seam; only a test that runs both halves does.

## `apps/server/src/dependencies/bump-gate.ts`

### §108. M21.5 — THE AUTO-MERGE LINK

M21.5 — THE AUTO-MERGE LINK: what asks the delivery question a SECOND time, and what actuates the answer (ADR-0032 §8c, charter `scp-managed-dep` amendment).

WHAT WAS MISSING, AND WHY IT WAS THREE THINGS RATHER THAN ONE
`resolveEffectiveDelivery` was built correct and unreachable. It grants `auto_merge` only on a governed control run that evidences the component's OWN checks passed FOR THE BUMP'S OWN COMMIT — both narrowings right, and both satisfiable only after the branch exists and CI has concluded on it. Nothing in the tree produced that moment:

```text
1. NO CONTROL EVER RAN ON A BUMP CHANGE. `control_runs` rows are deposited by the gate machinery
   on a lifecycle edge or a wave boundary; `coordination/reconcile.ts` prewarms governance only
   for changes sitting in `validating`, and a bump change sits at `proposed` from the moment
   `proposeChange` writes it. So the evidence the grant requires could not exist.
2. NOTHING RE-EVALUATED THE CHANGE AFTER ITS PULL REQUEST WAS OPENED. The only trigger was a
   line's head advancing, an advance to a different version is a DIFFERENT change, and a
   restatement deliberately emits nothing.
3. THERE WAS NO MERGE. The only merge in the tree was the tail of an authoring run — reachable
   only by a run that had just created the very commit it would merge, which is the one commit a
   control cannot have passed beforehand.
```

This file is (1) and (2); (3) is `@scp/plugin-managed-dep`'s `action: "merge"`.

(1) THE GATE IS THE EXISTING GATE. NO SECOND GATE PATH IS CREATED.
ADR-0032 §8: "Auto-merge's CI-green condition is expressed as a governed control so the EXISTING gate machinery decides, not new code." So this job calls `governance/gate-orchestrator.ts`'s `prewarmGovernanceForChange` — the same function `coordination/reconcile.ts` calls for a validating change, unchanged — which resolves the component's effective policies, evaluates each contributor's own condition, and runs the required controls those FIRED policies name, threading the change's own `commit_sha` into every control context. What comes out is ordinary `control_runs` rows with ordinary evidence, which `resolveEffectiveDelivery` then reads exactly as it always did.

WHAT THIS DELIBERATELY DOES NOT DO IS ADVANCE THE CHANGE. Driving a bump down the deploy lifecycle to make gates fire would coordinate a release nobody asked for: a bump is a proposed edit to a manifest, not a deployment of anything. `prewarmGovernanceForChange` is the right seam precisely because it RUNS controls and materialises approvals while transitioning nothing — its own doc calls that out ("Runs (never blocks, never writes a Decision)"), and `reconcile.ts` relies on the same property.

A CONSEQUENCE WORTH STATING: if an org's policies name no required control for this component, no control run appears, `resolveEffectiveDelivery` finds nothing, and the bump is delivered as a pull request. That is the charter clause working, not a gap — "automatic merge is permitted only where a governed control evidences that the component's own checks passed", and an org that has declared no such control has evidenced nothing. Absence is never permission.

(2) THE TRIGGER IS AN OBSERVED EVENT ABOUT THE BUMP, AND IT IS EMITTED AT ONE DOOR
```text
a provider webhook -> change_source_events
  -> processChangeSourceEvents -> matchAuthoredBumpChange (BOTH routes: the authored ref, and
     the bump's own recorded head commit)
  -> outbox `scp.dependency.bump_observed`   [in the ingress transaction]
  -> domain-events -> `observedBumpRouter` (one cheap predicate, one enqueue, no work)
  -> `DEPENDENCY_BUMP_GATE_QUEUE` -> this file's worker.
```

WHICH REAL EVENT CARRIES "THE CHECKS WENT GREEN", measured rather than assumed: `@scp/plugin-github`'s `mapEvent` maps `push`, `pull_request`, `workflow_run`, `deployment` and `release` — `check_suite`/`check_run` are not mapped at all — and `workflow_run` carries `commitSha: workflow_run.head_sha` with NO ref. That is the conclusion event, and reaching it needed two additive changes stated here rather than left to be discovered: `ExtractedHint` now carries `commitSha` (the adapter had always produced one and ingress dropped it), and `matchAuthoredBumpChange` gained a head-commit route so a ref-less CI event attaches to the bump whose commit it names instead of minting a second, unrelated change. Gitea maps no workflow event and GitLab maps `Pipeline Hook`; neither matters for this path, because a bump can only be authored through a GitHub App (`repo-write.ts`'s `resolveRepoWriter` refuses the other two by name).

A ROUTER, NOT A SECOND WORKER — `boss.work()` is a COMPETING consumer, so a second `work()` on `domain-events` would steal roughly half of M21.4's and M21.5's events and receive roughly half of its own (`events/pgboss.ts`'s `DomainEventRouter`). It is likewise its OWN queue rather than a second worker on `dependency-bump`, for the identical reason.

IDEMPOTENT AND RE-DERIVED. Nothing is trusted from the event but the change id: the claim, the head commit, the delegation verdict, the subscription and the control runs are all re-read. A redelivery therefore reaches the same answer, and a merge that already happened finds no OPEN pull request and refuses (the plugin never re-opens one).

(3) FAIL-CLOSED, IN EVERY DIRECTION THE CHARTER NAMES
"Delivery is a pull request by default, and automatic merge is permitted only where a governed control evidences that the component's own checks passed." Every one of these is a REFUSAL with its own named cause (`BumpGateRefusal`), never a fallthrough:

```text
* SCP recorded no authorship for this change                         -> no merge
* the recorded ref is not the ref this change's own bump would author -> no merge
* no head commit observed back yet                                    -> no merge
* SCP never recorded which pull request it opened                     -> no merge
* the component has NO conclusive delegation verdict on record        -> no merge
* the repository delegates its dependency updates to somebody else    -> no merge
* the subscription no longer resolves, or resolves to `pull_request`  -> no merge
* the governed gate does not grant `auto_merge` for THIS commit       -> no merge
```

EVERY ONE OF THOSE INPUTS IS A FACT SCP ITSELF RECORDED (migration 0063)
The repository, the base branch, the component, the line, the branch's head commit and the pull request number are read from `dependency_bump_authorships` — server-owned storage written only by the actuator, by the ingress that observes SCP's own branch back, and by this file.

They used to be read from `changes.source_ref.scp_authored`. `source_ref` is the raw delivery payload plus a few lifted keys and is writable verbatim by ANY authenticated principal through `POST /api/v1/changes`; the event that starts this job is producible through `POST /change-sources/{kind}/report`. So a tenant could fabricate a "bump" naming any repository and have this job merge into it with SCP's credential — a confused deputy, and one no amount of validating that field could close. A change with no authorship row is not a bump change and stops at the first refusal below.

THE DELEGATION RULE IS STRICTER HERE THAN AT THE AUTHORING SEAM, and deliberately. `assertComponentNotDelegated` refuses when a standing verdict SAYS delegated; absence of a verdict is permissive there, because the authoring path is the thing that produces the verdict in the first place (ADR-0032 §8b's stated residual). A merge produces nothing and requires more: an INCONCLUSIVE probe writes no verdict at all, so "no verdict" is exactly what an unreadable repository looks like, and the requirement here is a POSITIVE, conclusive "this repository does not delegate". Absence of evidence is not evidence.

THE ROLE GUARD IS THE DISPATCHER'S, AND IT IS IMPORTED RATHER THAN RESTATED
`bumpDispatchRoleGuard` asks "may this process write to a source repository with a credential?" and answers commander-only, fail-closed on an undeclared `SCP_FEDERATION_ROLE`. That is the same question this job asks — merging is a repository write, and a strictly more consequential one than opening a pull request — so the guard is the same object, not a copy of its verdict. A copy is where the two would drift, and the direction they would drift is toward an outpost merging into somebody's default branch.

### §109. Run ONE queued job

Run ONE queued job. Exported so an integration test drives the exact function the worker runs.

PHASES, and the split is the one ADR-0032 §7c clause 2 established: read in a transaction, do provider I/O OUTSIDE any transaction, write in a transaction. The governance prewarm is the exception and it is the SHIPPED exception — `coordination/reconcile.ts` calls it inside a transaction too, because `ensureControlRun` writes its `control_runs` row in the same transaction that decided it, which is what makes a control outcome a durable historical fact rather than something a crash can lose after the external call was already made.

### §110. Phase one: the read

---- PHASE 1 (read) ----------------------------------------------------------------------- Everything is RE-READ, and every fact that leads to a repository write is read from SCP'S OWN RECORD (`dependency_bump_authorships`) rather than from `changes.source_ref`, which any authenticated principal can write. The event carries a change id and nothing else is trusted from it.

### §111. Already merged, and this is checked first of all

ALREADY MERGED — and this is checked FIRST, before any refusal can be recorded.

A merge produces its own provider events: the merge commit's push to the base branch, and whatever CI runs on it. Those correlate straight back to this bump (the head-commit route) and re-run this job. That second run finds no OPEN pull request and would record `withheld / merge_refused`, so the LATEST Decision for a bump that DID merge said it did not — charter principle 6 inverted, on the one irreversible action in the whole feature.

### §112. Controls only, and why the prewarm is narrowed

CONTROLS ONLY. `prewarmGovernanceForChange` exists to make a change's gate outcomes READABLE by the time a human calls `POST /changes/{id}/accept` — which is why it also MATERIALISES every firing policy's approval requests. That is right for a change on its way through the lifecycle and wrong here: a bump change is deliberately never advanced (a bump is not a deployment), so nothing will ever consume those approval requests and every bump would leave a permanently-pending approval task in somebody's queue, once per firing policy, forever.

The CONTROLS are what this job needs — they are the evidence the charter's clause is about — and they are unaffected.

### §113. Phase three-b: the freeze

---- PHASE 3b (M25.8 — THE FREEZE, owner decision D8) -------------------------------------- THE LAST QUESTION BEFORE THE ONE IRREVERSIBLE ACT, and its position is the argument.

It is asked AFTER the governed gate rather than with the cheap refusals above, and that costs a control run during a freeze window on purpose: the gate's `control_runs` rows are the evidence the grant reads, and depositing them WHILE the window stands is what makes "pull requests accumulate during the freeze and merge when it closes" true on the NEXT attempt instead of requiring CI to conclude all over again afterwards. It also keeps the two refusals distinct — a bump refused here has been proven safe and is held by the calendar, which is a different sentence from `not_evidenced` and resolves by a different act.

AND "THE NEXT ATTEMPT" IS A THING SOMETHING PRODUCES (M25.8b). This job is enqueued by `observedBumpRouter` off a PROVIDER WEBHOOK about the bump's branch, and a freeze expiring, being lifted or being shortened touches no repository — so for one release the refusal below promised a retry nothing scheduled, and every bump refused inside a window was stranded for ever. `dependencies/bump-freeze-redrive.ts` is the producer: a 60s sweep that re-asks `checkBumpMergeFreeze` for exactly the bumps this refusal named and re-enqueues them here.

It is asked AFTER the binding check for the complementary reason: a component with no git binding can never merge, freeze or no freeze, and reporting `frozen` for it would promise an outcome at `endsAt` that will not arrive.

NOT A PAUSE, and the honest boundary is `freeze-hold.ts`'s: `ExecutorPlugin` has no advance/pause/resume verb (ADR-0008 forbids adding one). A freeze withholds a call SCP has not made yet; it cannot un-merge one already handed to a provider.

### §114. Phase four: actuate, outside any transaction

---- PHASE 4 (actuate — outside any transaction) ------------------------------------------- THIS RUN's own plugin-instance namespace. `bump-dispatch.ts` is a concurrent consumer of the same component binding and also stops its instances in a `finally`; a shared id meant either job could tear down the other's subprocess mid-RPC — including the `status()` call below, which is issued AFTER the provider may already have merged. See `managed-dep-instance.ts`.

### §115. ASKED, NOT ASSUMED

ASKED, NOT ASSUMED — and asked with the ref the plugin ITSELF returned rather than one this file recomposed from the idempotency key. `trigger()` returns the run ref, this class runs synchronously to completion, so `status()` is the honest record of whether the merge HAPPENED rather than of whether a dispatch was made. A provider refusal (branch protection, a required review, a check that went red since the gate) is a `failed` phase with the reason in `detail`.

### §116. A THROW HERE USED TO LEAVE NO DECISION AT ALL

A THROW HERE USED TO LEAVE NO DECISION AT ALL — the one class of merge refusal where charter principle 6's "every blocked response carries a `decision_id`" was not honoured. The reachable causes are ordinary: the runner image is not configured on this deployment, the binding cannot be resolved, the plugin host is unreachable. Nothing merged, and an operator must be able to see why from the same place every other refusal is recorded.

### §117. THE MERGE HAPPENED

THE MERGE HAPPENED — record that BEFORE the Decision, because it is what stops the merge's own provider events from re-running this job and overwriting the verdict below with a refusal. A crash between the two leaves the merge stamped and the Decision missing, which is the recoverable direction: the next observed event returns "already merged" and writes nothing, rather than writing "not merged" about a merge that happened.

### §118. One Decision per verdict, and why it is if-changed

One Decision per verdict, through `insertDecisionIfChanged`.

WHY `IfChanged` AND WHY THE INPUTS ARE STABLE FACTS ONLY: this path repeats per observed event on the bump's branch, which is the write-amplification shape that cost 1.44 GB/day elsewhere in this tree. A redelivered event, or a second CI event on the same commit, re-derives the same refusal and writes no new row.

WRITTEN AFTER THE ATTEMPT, not before it: a Decision that recorded "merge authorised" and then failed to say what happened is the record charter principle 6 is least useful as. The cost is that a crash between the provider's merge and this write leaves the merge unrecorded — recoverable, because the next observed event re-runs the job and finds no OPEN pull request.

### §119. Register the capability's worker

Register the capability's worker. The ROUTER is registered separately, by `events/domain-event-registry.ts` under the SAME guard as the dispatcher's, and a refused guard contributes no router — so an event is not even enqueued for a queue nothing will drain.

A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE, the same shape every other background loop uses and for the same reason: a process that merely skipped the work inside the handler would still hold a worker for a queue it will never act on.

## `apps/server/src/dependencies/bump-merge-freeze.ts`

### §120. M25.8 — THE DEPENDENCY ACTUATOR'S FREEZE CHECK

M25.8 — THE DEPENDENCY ACTUATOR'S FREEZE CHECK (owner decision D8).

WHAT WAS TRUE BEFORE THIS FILE
The dependency-subscription actuator consulted NO freeze and NO governance gate at all. Measured filterlessly (`grep -rna "freeze" apps/server/src/dependencies/`, against a known-positive control over `apps/server/src/governance/` so an empty result could be read as evidence): the word did not occur in this directory outside unrelated comments.

The path never enters `evaluateGovernanceGate` — that function has exactly two callers, both in `coordination/gates.ts`. `bump-gate.ts` calls `prewarmGovernanceForChange`, which RUNS controls and blocks on nothing, and never calls `checkFreeze`. The bookkeeping Change this path creates is documented as deliberately never advanced, so it never reaches the wave gate either. The consequence: a declared change freeze over an org did not stop SCP from opening AND AUTO-MERGING a version bump into that org's repositories — the most freeze-relevant act on the instance, and the one that was unguarded.

THE BOUNDARY IS D8's, AND IT IS NARROWER THAN "REFUSE THE BUMP"
A freeze blocks AUTO-MERGE. It does NOT block PR authoring. Opening the bump pull request during a freeze is allowed — the work stays visible and queued, which is what preserves the value of the subscription — and merging it into the tenant's default branch is refused, with a Decision. Pull requests accumulate during the window and merge when it closes.

"AND MERGE WHEN IT CLOSES" NAMES A PRODUCER, and it has to, because for one release it did not. The only thing that enqueues an auto-merge gate job is `observedBumpRouter`, driven by a PROVIDER WEBHOOK about the bump's branch — and a freeze expiring, being lifted or being shortened touches no repository and therefore produces no such event. So the sentence above was, briefly, an assurance with nothing behind it: a bump refused here stayed refused for ever, silently, with the pull request stranded and its latest Decision promising the opposite. What makes it true is `dependencies/bump-freeze-redrive.ts` — a per-minute sweep that re-asks `checkBumpMergeFreeze` for exactly the bumps this file's refusal named and re-drives the gate for the ones nothing covers any more. It is a SWEEP rather than a job scheduled at `endsAt` on purpose: a lift and a shortening both happen BEFORE `endsAt`, and a shortening can move `endsAt` later.

So this module is consulted at BOTH of the actuator's two `trigger()` calls, and it does two different things at them, because they are two different acts:

```text
* `bump-gate.ts` — the STANDALONE merge (`action: "merge"`). Its whole purpose is the merge, so a
  covering freeze is a REFUSAL with its own named cause and its own Decision.
* `bump-dispatch.ts` — the AUTHORING run (`action: "bump"`). This one is not obviously a merge
  and that is the trap: `@scp/plugin-managed-dep`'s `publishBump` has an AUTO-MERGE TAIL, taken
  whenever the descriptor's `delivery` is `auto_merge` and an `expectedHeadCommit` rides along
  (`repo-write.ts`: "Both the publish tail and the standalone merge action reach the provider
  through here"). A freeze there therefore DOWNGRADES the delivery to `pull_request` rather than
  refusing: the trigger still fires, the branch is still authored, the pull request is still
  opened, and the tail does not merge. That IS D8 expressed at that seam, not a workaround for
  it. Guarding only the file with "merge" in its name would have left the other half of the same
  act open — the incomplete-call-site census failure this repo has paid for before.
```

`freezesByTarget`, NEVER A HAND-ROLLED WALK, AND NEVER A SECOND WINDOW PREDICATE
The resolution is `governance/freeze-scope.ts`'s, unchanged and shared with the wave gate and the per-target hold. Two properties come with it and neither is re-derived here:

```text
* it walks `containmentChain`, so a freeze declared at the component's SERVICE, its domain or
  the org root covers the component. A hand-rolled `domain_id`-only walk once made a
  service-scoped freeze fail OPEN — silently, because a freeze that stops matching produces the
  same `allow` a freeze that never existed would; and
* it returns BOTH TIERS. A platform freeze declared by this deployment's operator blocks an
  auto-merge exactly as an org freeze does, with no per-tier branch anywhere below.
```

INERTNESS comes with it too: an org with no active freeze pays two indexed window reads and walks no containment chain at all.

WHAT THIS DELIBERATELY DOES NOT MODEL
NO OVERRIDE. `gate-orchestrator.ts`'s `checkFreeze` admits a change when every covering freeze is individually overridden by an actor holding `freeze:override` at that freeze's own scope, with a reason. There is no such actor here and there cannot be one: both call sites run under `SYSTEM_ACTOR_ID` on a background queue with no HTTP request in scope, so an override could only ever be a constant in this file — which is a freeze that overrides itself. The operator's remedy is the shipped one: lift or shorten the freeze (`DELETE`/`PATCH /v1/freezes/{id}`, or `DELETE`/`PUT /v1/instance/freezes/{key}` for the platform tier) — and the next attempt, which `bump-freeze-redrive.ts` schedules within a minute of the freeze releasing, merges. That producer is named because "the next attempt" was for one release a thing nothing produced; see the header above.

NO `atomic`. That bit restores whole-wave semantics by making a freeze over ANY target of a set cover EVERY target of it. A bump has exactly one target — the component — so the union of one target's covering freezes and the atomic freezes over the same single target is that same set. Reading it would be a no-op dressed as a rule.

READS ONLY, on a `TenantTx` the caller owns, exactly as `freezesByTarget` itself does: each caller decides what to persist and does it in its own transaction.

### §121. A covering freeze set, projected for a Decision

A covering freeze set, projected for a Decision's `inputContext`.

`endsAt` AND NEVER `now`. This is the whole anti-write-amplification contract and it is copied from `coordination/freeze-hold.ts`'s `describeFreezes`, which copied it from the gate's freeze-block context. Recording the window BOUNDARY makes the refusal byte-identical on every attempt for the length of the freeze, so `insertDecisionIfChanged` suppresses all but the first. Recording the clock instead is what produced a measured 1.44 GB/day in production (ADR-0024) — and this path is re-entered on every provider event about the bump's branch, which is precisely the repeat-evaluation shape that bill was run up on.

SORTED BY ID for the same reason: `restatesDecision` canonicalizes object KEYS but array ORDER is significant, and `activeFreezesInWindow` has no `ORDER BY`, so an unsorted array would let a reordered query result make an unchanged situation look new.

### §122. Every active freeze covering the component, both tiers

Every active freeze covering `componentObjectId`, from both tiers, or `null` when nothing covers it.

`null` RATHER THAN AN EMPTY VERDICT, deliberately and for the reason `evaluateFreezeHolds` states for its map: the caller's seam is `const frozen = await checkBumpMergeFreeze(...); if (frozen) { refuse } `, and a present-but-empty verdict would make that `if` true for every bump on the instance.

THE SCOPE IS THE COMPONENT WHOSE DEPENDENCY IS BEING BUMPED, and it is the only object either call site could honestly resolve against: the bump is an edit to that component's manifest in that component's repository, and both seams already hold its id from server-owned storage (`bump-dispatch.ts` from the subscription resolution's `componentObjectId`, `bump-gate.ts` from `dependency_bump_authorships.component_object_id`, which no tenant can write). Everything wider — the service, the domain, the org root — is reached by `containmentChain` from it, so a freeze declared at any of those covers the bump without this file naming them.

A CONSEQUENCE OF THAT CHOICE, STATED. A component is not a placement and declares no stage coordinate, so `readStageCoordinate` answers `null` for it and an ENVIRONMENT-ADDRESSED platform freeze (`match: { environment: "prod" }`) does not cover a bump. A DEPLOYMENT-WIDE one (`matchAllEnvironments`) does, and covers it unconditionally. That is the honest answer rather than a convenient one: a manifest edit on a branch happens in no environment, so there is no coordinate to match and inventing one would make "freeze prod" mean something different here than it means everywhere else it is read.

`now` is injectable for the same reason `evaluateFreezeHolds` takes it — the window boundary is testable without a real sleep, and this repo's integration suite has a CI gate against fixed sleeps. Production passes nothing.

## `apps/server/src/dependencies/bump-provenance.integration.test.ts`

### §123. The two things the server side has to get right

M21.5 — THE TWO THINGS THE SERVER SIDE OF `scp-managed-dep` HAS TO GET RIGHT, END TO END (charter amendment 2026-08-13; ADR-0032 §8, §9).

1. THE ENABLEMENT-TIME CONFLICT REFUSAL — at the choke point, not at the route
"CommanderSCP refuses to enable dependency subscriptions for a component whose repository already delegates the same manifests to another dependency-update system." That refusal is what makes "opting a component in is itself the gate-1 flip" (ADR-0032 §8) a true statement instead of an aspiration: a flip only means something if it is exclusive, and two actuators editing one file is the failure it invites.

It is installed at `graph/objects-repo.ts`'s `createObject`/`updateObject` for exactly the reasons `subscription-authoring-guard.ts`'s header sets out and `subscription-guard-write-doors.integration.test.ts` MEASURED for its sibling: the typed `/policies` route is not the boundary, and three free-form-`typeId` doors reach `createObject` with the same document. So this file exercises the typed route AND the IaC door AND hand-fill, because a refusal installed in one of them is a refusal with three holes.

2. THE PROVENANCE LOOP — SCP's own commit must come back as itself
ADR-0032 §9: "A commit SCP authors is observed back in via the normal webhook path, so the bump change must be recorded such that the returning event CORRELATES TO IT rather than minting a second, unrelated change."

The webhook is REPLAYED here, through the real `extractHint` → real github adapter → real `processChangeSourceEvents`, with a real GitHub push payload. The assertion that matters is the NEGATIVE one: no second change object exists afterwards. A test that only checked the event was attached would pass while a duplicate sat beside it.

The forgery case is the other half and is not optional: the branch name is attacker-typable, so a push to `scp/dep-bump/<some-uuid>` from a repository the change never claimed must NOT attach.

### §124. The module name binds the evidence to nothing alone

THE MODULE NAME BINDS THE EVIDENCE TO NOTHING ON ITS OWN
"The component's OWN checks" was enforced as a MODULE-NAME STRING plus a commit id. A commit id is a content hash and travels between repositories freely — a fork, a mirror, a vendored copy — so a `github-check` control an operator configured against an UNRELATED repository containing the same commit object reported green for exactly the right commit and the merge was granted.

### §125. A re-pointed binding must not re-narrate an old run

A BINDING RE-POINTED LATER MUST NOT RE-NARRATE WHAT AN OLD RUN EVIDENCED
The module used to be read from the CURRENT `control_bindings` row by LEFT JOIN, and a binding is mutable: re-pointing one control from `webhook-control` to `github-check` retroactively relabelled every historical pass of that control as an own-check pass — and this grant reads historical runs. It is now stamped on the run at insert (migration 0063).

### §126. What will and will not go into the stored URL

WHAT `recordBumpPullRequest` WILL AND WILL NOT PUT IN `pull_request_url` (migration 0066)
These drive the write door directly and make NO claim that anything calls it — that claim is `bump-dispatch.integration.test.ts`'s "records the pull request URL THE PROVIDER RETURNED, on the real authoring path", which enters through the head write door, the queue and the loop. What is tested here is the SEMANTICS the door owes every caller, and each case below is a value a real provider response can carry: the plugin degrades an unreadable `html_url` to `""` (`packages/plugins/managed-dep/src/repo-write.ts`'s `readPullRequest`), a self-hosted forge can answer with anything at all, and a redelivery can restate a pull request the row already has.

### §127. The number is recorded and the URL is not

The number is recorded and the URL is NOT, for every value that is not an absolute http(s) URL. Absent has to mean "SCP recorded no link": storing `""` would make a consumer special-case a value the column can already express as NULL, and storing a `javascript:` or `data:` value would ship a script-execution hazard to whatever renders it as an href — refused at the ONE writer rather than sanitised in every reader.

Each case gets its OWN row, so one refusal cannot be hidden behind another's leftovers.

### §128. THE WRITE-ONCE CONTROL, WHICH THE URL MUST NOT WEAKEN

THE WRITE-ONCE CONTROL, WHICH THE URL MUST NOT WEAKEN. The number is what a merge is addressed to, so a later run naming a DIFFERENT pull request is refused — and the URL that arrived with it is refused too. A link pointing at pull request 99 sitting beside the number 7 is worse than no link: it sends a human to read one pull request while SCP merges another.

### §129. ...AND THE ONE CASE THE PREDICATE DELIBERATELY ADMITS

...AND THE ONE CASE THE PREDICATE DELIBERATELY ADMITS. A row from before this column existed, or one whose first authoring run got a provider response with no readable `html_url`, has a number and no link. A restatement of THE SAME number carrying a URL cannot re-point anything — the number is compared, not overwritten — so filling the link in is safe, and refusing it would only mean the link stayed missing forever.

## `apps/server/src/dependencies/commander-only.test.ts`

### §130. All dependency automation is commander-only, and agrees

ADR-0032 §7d — ALL DEPENDENCY AUTOMATION IS COMMANDER-ONLY, AND ALL OF IT AGREES
The owner's decision (2026-08-17) is a statement about the WHOLE feature, not about one job: a FIELD outpost never ORIGINATES a dependency bump, it RECEIVES the resulting change down the global pipeline the commander manages. ("Field" is load-bearing — an HQ outpost is the outpost in the COMMANDER'S OWN trust domain and is not a second deployment, so every config below that declares `federationRole: "outpost"` is a field outpost; `commander-only.ts` reads that out of the code.) A rule that holds for a feature and is implemented once per job is the property CLAUDE.md's census rule names — it regresses per job, and the branch that regresses first is the fail-closed one, which is false on every developer machine, on every declared commander, and in every test that does not deliberately construct it.

So the DECISION is asserted here across every guard at once, over the FULL config matrix rather than a sample. Two of the guards keep bespoke bodies on purpose (their refusal TEXT carries capability-specific facts a shared string cannot); this file is what makes that safe, because it does not care how a guard is implemented — only that they all answer the same question the same way, and in the same ORDER.

WHY `DEPENDENCY_JOBS` IS DISCOVERY-CHECKED AND NOT JUST WRITTEN DOWN (M21.7 follow-up)
The list this file iterates USED TO BE hand-maintained while its own comment claimed the opposite — "add a sixth dependency job, forget to guard it, and the entry added here fails", which was false in the only direction that matters: DROPPING AN ENTRY WAS FULLY GREEN, and so was adding an unguarded job and never listing it. A completeness claim that is not checked is worse than no claim, because a reviewer greps for the guarantee, finds the sentence, and stops looking.

The census that made the claim true also settled a discrepancy the previous round left open — FIVE production loops, FOUR guards, FOUR entries:

```text
startDependencyVersionPollLoop  → dependencyVersionPollRoleGuard
startInternalReleaseLoop        → internalReleaseDetectionRoleGuard
startInventoryIngestionLoop     → inventoryIngestionRoleGuard
startBumpDispatchLoop           → bumpDispatchRoleGuard
startBumpGateLoop               → bumpDispatchRoleGuard   ← THE FIFTH LOOP
```

The fifth is the AUTO-MERGE GATE. It has no guard of its own: `bump-gate.ts` IMPORTS the dispatcher's, deliberately — merging is a repository write and a strictly more consequential one than opening the pull request — so four guard functions cover five loops and nothing is missing. That is now a derived fact rather than a remembered one: `JOB_GUARDS` is computed from `DEPENDENCY_JOBS` by de-duplicating on guard IDENTITY, so a loop that quietly grew its own copy of the predicate appears as a fifth guard and gets checked like the rest.

M25.8b ADDED A SIXTH LOOP — `startBumpFreezeRedriveLoop`, on `bumpDispatchRoleGuard` again — and the census is what said so: it landed in `unclassified` on the first run after the file was created, before anyone thought to come here. That is the sentence above being true rather than merely written down.

### §131. Starts that loop in its own calling convention

Starts that loop against a probe `boss`, in ITS OWN calling convention — the poll takes `(boss, db, host, config)` and the other four take `(boss, deps)`. This adapter is the ONE hand-written thing per job and it is what makes the check behavioural instead of declarative: `guard` above says what the job SHOULD decide, and this actually runs the loop to find out what it DOES. Deleting a loop's guard consult — the exact regression that was fully green earlier in M21.7, because every fixture boots as a declared commander — makes the probe start a loop the guard refuses, and that is a failure.

### §132. THE SIXTH LOOP

THE SIXTH LOOP (M25.8b), and the SECOND to import the dispatcher's guard rather than declare one. It has to be that guard, in both directions: this sweep exists to re-drive the auto-merge gate, so an outpost running it would initiate exactly the repository write the gate refuses to initiate there — and a refused gate loop never CREATES `dependency-bump-gate`, so a sweep that ran anyway would send to a queue that does not exist, once a minute, for ever.

### §133. The distinct guards, derived by function identity

The DISTINCT guards, derived from `DEPENDENCY_JOBS` by function identity — never listed separately, so the two lists cannot drift and a job whose loop grows a private copy of the predicate shows up here as a new guard rather than disappearing into an existing row. The label joins every job a guard covers, which is what makes "bump dispatch + auto-merge gate" a derived string rather than a remembered one.

### §134. A loop starter, by RETURN TYPE

A loop starter, by RETURN TYPE — `Promise<…LoopHandle>`, which is the shape all eleven in this tree share — OR by NAME, `startXLoop`. The union is deliberate and both halves are load-bearing in principle even though every loop today satisfies both: a new loop that returns `Promise<PollerHandle>` is caught by the name, and one called `startDependencyReaper` is caught by the return type. Matching on either is how a census avoids being a census of what it expects.

### §135. `readStripped`, NOT a bare `readFileSync`

`readStripped`, NOT a bare `readFileSync` — the shared module exports it for exactly this.

A `export function startSomethingLoop(` inside a `/* … *\/` block — a loop commented out during a revert, or one quoted in a module doc explaining the shape — was DISCOVERED, then `import`ed, then found to export no such name, and landed in `unclassified` as "add it to DEPENDENCY_JOBS". A false RED, and a confusing one: the failure names a loop that does not exist and cannot be fixed by adding a table entry. Stripping comments is what makes the census a census of the CODE.

THIS NOTE USED TO END "…and this census was the one consumer still reading raw text". THAT WAS FALSE WHEN IT WAS WRITTEN, and it is worth leaving the correction here rather than deleting the sentence, because the sentence is the bug. Six other censuses were reading raw text — including the OTHER read in `events/domain-event-routers.test.ts`, the very file converted alongside this one, three functions above the line that was fixed. Every one of them was then measured passing over commented-out wiring (2026-08-17): `bump-dispatch.test.ts` 20/20, `bump-gate.test.ts` 11/11, `inventory-ingestion.test.ts` 38/38, `candidate-loop-registry.test.ts` 5/5 with a round-robin bump deleted, and `watchdog-tenant-predicates.test.ts` 1/1 over a tenant query left scoped by RLS alone.

Two lessons, both already in CLAUDE.md and both re-learned the expensive way: - a census with a FILTER hides the next instance. The sweep that produced "the one consumer" looked at census-shaped tests in `dependencies/`; the misses were in `coordination/`, `events/` and `deploy/`, and one was a second call site in an already-visited file. - a WELL-WRITTEN COMMENT NAMING A HAZARD IS A SIGNAL TO SWEEP, NOT EVIDENCE IT WAS HANDLED. This paragraph is not evidence either. Re-derive it.

And stripping is only the first of the things a text census cannot do — the rest are enumerated on `readStripped` in `@scp/source-census`. Read them before trusting one.

### §136. The loops that are not dependency automation

The loops that are NOT dependency automation, each with the reason it is out of scope — listed rather than filtered out by directory, because "only look in `dependencies/`" is precisely where the next instance hides (CLAUDE.md: census with no grep filters). A dependency loop parked in another directory would be silently exempt under a path filter; here it is an unclassified loop and it fails.

Every entry but the last is a COORDINATION or FEDERATION loop, and every one of those runs on an outpost BY DESIGN: an outpost reconciles its own domain, watches its own timeouts, drains its own inbox and relays its own journals. That is the opposite posture from ADR-0032 §7d's, which is exactly why the two sets have to be kept apart on purpose rather than by a wildcard. The last entry is exempt for a STRUCTURAL reason instead, and says so.

### §137. NOT a loop at all

NOT a loop at all — the only entry exempt for a structural reason rather than a federation posture. It is the composition root's RUNNER (`background-work.ts`): it starts whatever `BACKGROUND_LOOPS` holds, and has no guard of its own DELIBERATELY, because the guard belongs to each job — giving the runner one would put a second, coarser answer in front of the four this file checks. Discovered by the return-type arm (`Promise<BackgroundLoopHandle>`).

### §138. THE GUARD IS NOT MERELY COMPUTED

THE GUARD IS NOT MERELY COMPUTED — IT DECIDES WHETHER THE LOOP STARTS
A verdict that is calculated, logged and then structurally ignorable is this codebase's worst shape, and it is not hypothetical here: earlier in M21.7, deleting the guard CONSULT from `startInventoryIngestionLoop` left the WHOLE suite green — unit and integration — because every fixture boots as a declared commander, so the refusal branch was never taken by anything.

So each loop is actually STARTED, against a `boss` that throws the moment it is touched. A refused loop must return its inert handle having touched nothing; an allowed loop must reach the queue. The second half is the negative control: without it, three passing refusals would be satisfied just as well by a loop that never starts anywhere.

### §139. The order is pinned WITHOUT pinning any wording

The order is pinned WITHOUT pinning any wording. For each guard, the refusal it gives for a deployment wrong on SEVERAL axes must be IDENTICAL to the refusal that same guard gives for the axis that should win, violated ALONE. Rewrite a sentence and this still passes; reorder a branch and it fails — which is the right sensitivity, because the wording is deliberately capability-specific and the order deliberately is not.

### §140. THE BUG THIS EXISTS TO PREVENT

THE BUG THIS EXISTS TO PREVENT: applying the job guard to a route would 4xx every backfill call on a correctly-deployed commander that runs `SCP_ROLE=api` in front of `SCP_ROLE=worker`.

`role` IS AN INPUT HERE, which it was not until M21.7's follow-up round: it was interpolated into the assertion label and nowhere else, so the config passed in was the same object three times and mutating the loop to nonsense role strings left the file 11/11 green. A test that reads as coverage of a property while checking nothing of it is worse than no test — a reviewer greps, finds it, and is told the property holds.

### §141. The same verdict, shaped as an answer not a refusal

`dependencyManagementOf` — THE SAME VERDICT, SHAPED AS AN ANSWER RATHER THAN A REFUSAL
The guards above produce refusals. The tenant-facing resolve route does not refuse: it answers `enabled` on an outpost, correctly computed from federated policies that NOTHING THERE WILL ACT ON. The envelope is what qualifies that answer, so what has to be true of it is (a) it never disagrees with the guard that actually gates the work, and (b) `role_undeclared` is its own value — the branch that reads as `commander` on the config value alone, and is the exact opposite of it.

### §142. A value nobody can produce is a lie in the contract

A value nobody can produce is a lie in the contract: a consuming client would branch on it forever and never see it.

THE ORACLE IS DERIVED FROM THE SCHEMA, NOT COPIED FROM IT. This list used to be hand-typed here, which cannot detect the one thing the test claims to detect: a FIFTH member added to `DependencyManagementReasonSchema` with no config that produces it would be absent from both sides and the comparison would still pass. `.options` is the enum's own member list, so the schema is imported as a VALUE (not `import type`) precisely so this cannot drift.

## `apps/server/src/dependencies/commander-only.ts`

### §143. The one predicate for may this deployment automate

THE ONE PREDICATE FOR "MAY THIS DEPLOYMENT RUN DEPENDENCY AUTOMATION?" (ADR-0032 §7d).

THE RULE, AND THE REASON IT IS THE RULE
ALL dependency automation is COMMANDER-ONLY (owner decision, 2026-08-17). No FIELD outpost runs a dependency job or holds a dependency inventory. The reasoning is what belongs here, because it is what tells the next reader whether a NEW job falls on this side of the line:

```text
the point of dependency automation is to PULL FROM PUBLIC REPOSITORIES — python library
versions, CDK versions, base-image versions. That is not needed from a FIELD outpost's
standpoint, because the resulting change GETS PUSHED DOWN THE GLOBAL PIPELINE THE COMMANDER
MANAGES.
```

So a field outpost never ORIGINATES a bump; it RECEIVES the resulting change through the ordinary promotion path. The accepted cost — dependencies declared in DOMAIN-SPECIFIC repositories the commander never sees are OUT OF SCOPE — and the two clauses this reverses (§4a clause 7, §7c clause 3) are in ADR-0032 §7d, preserved verbatim beside what overturned them. Each caller's module doc restates it locally; this file is the machinery.

"FIELD" IS LOAD-BEARING, AND WHY THIS PREDICATE CANNOT SEE THE OTHER KIND
This block said "Outposts run no dependency job and hold no dependency inventory" until M21.7's follow-up round, and that is TOO WIDE in the one direction that misleads. An **HQ outpost** is the outpost in the COMMANDER'S OWN trust domain, so its dependency inventory simply IS the commander's — the same rows, in the same database, written by the commander's own jobs. Only a **field outpost**, one in ANOTHER trust domain, runs no dependency job and holds no inventory. (Both terms: GLOSSARY.md's `HQ outpost` / `field outpost` entries, ADR-0021 D7; ADR-0032 §7d's vocabulary note cross-references them.)

READ OUT OF THE CODE, not from the names, because the naming is exactly what lets the wrong reading survive a review. Two facts settle it:

```text
1. `SCP_FEDERATION_ROLE` IS ONE VALUE PER DEPLOYMENT — `config.federationRole` is
   `"commander" | "outpost" | "retrans"` (`config.ts`), a single scalar set once at install.
   No process is "a commander, and also an outpost".
2. THIS PREDICATE READS THE ROLE AND NEVER AN `outpost` GRAPH OBJECT — and it cannot read the
   object, because an `outpost` object CAN name the commander's own trust domain: that record
   IS the HQ outpost, commander-declared (pipeline-substrate-registry-scan.md §10.5;
   `assertOutpostPeerBinding` in `federation/outpost-binding.ts` accepts
   `properties.peerDomainId` = `federation_self.domainId` only from a `commander`-role
   instance, with NO `federation_peers` row behind it — an instance is never its own peer,
   `initFederationSelf` writes `federation_self`). Every other `outpost` object must resolve to
   an already-PAIRED `federation_peers` row holding role `outpost`, i.e. it describes a field
   outpost. The object says which outpost a record DESCRIBES; only the install-time role says
   what THIS DEPLOYMENT is — and the deployment is what this predicate is about.
```

So the HQ outpost is NOT A SEPARATE DEPLOYMENT (it may be a separate record — the §10.5 object — but never a second process with tables of its own): it is the commander instance itself filling the outpost role for its own trust domain, which is the model statement ADR-0011 already makes ("a non-federated single-instance install is its own commander+outpost"). There is no second process here to refuse and no second store to exempt. A FIELD outpost is the only outpost that is a running process with tables of its own, which is why it is the only one the rule above is about.

ONE CONSEQUENCE FOR THE REFUSAL STRINGS BELOW, so the next sweep does not "correct" them: every refusal here is returned to a deployment that DECLARED `SCP_FEDERATION_ROLE=outpost`, and by (1) and (2) that deployment IS a field outpost. Saying "outpost" to it is exact, not loose. The word needs the qualifier only where a sentence quantifies over outposts as a CLASS — which is what the sentence at the top of this block used to do, and the whole class of error this note closes.

WHY ONE FUNCTION AND NOT A THREE-BRANCH `if` PER CALLER
Five callers now ask this question, and one of the three refusals — the UNDECLARED case — is FAIL-CLOSED, which makes it the branch that regresses invisibly: it is false on every developer machine, on every declared commander, and in every test that does not deliberately construct it. A predicate applied per caller regresses per caller (CLAUDE.md's census rule), so the callers share ONE implementation and differ only in the noun they interpolate.

`version-poll.ts` and `bump-dispatch.ts` keep their own bodies deliberately: their refusal TEXT carries capability-specific facts a shared string cannot ("dials package registries from an air-gapped site", "writes to a source repository with a credential"). TWO things must still be identical across all three copies, and `commander-only.test.ts` asserts both rather than assuming them, over the full 3x3x2 config matrix:

```text
1. THE VERDICT. A divergence introduced in any copy fails there.
2. THE ORDER THE AXES ARE TESTED IN — added in M21.7's follow-up round, because the order is
   what an OPERATOR acts on. A deployment wrong on two axes gets exactly ONE sentence, and it
   used to be a different sentence per job: the poll tested federation first and said
   "federationRole is 'outpost'"; the dispatcher tested the process split first and said
   "SCP_ROLE is 'api'". Same deployment, two different settings to go change, and which one an
   operator saw decided by which job happened to log. The test pins the order WITHOUT pinning
   any wording — for each guard it compares a multi-axis refusal against that same guard's
   refusal for each axis violated ALONE — so a reordered branch fails and a rewritten sentence
   does not.
```

TWO AXES — AND A ROUTE DOES NOT GET BOTH
- THE FEDERATION AXIS (`SCP_FEDERATION_ROLE`) is the operator's INSTALL-TIME declaration of what this deployment IS. It applies to every caller. Deliberately NOT `self_domain.role`, which is per-org, set lazily post-install, and advisory (config.ts says so at length). - THE PROCESS AXIS (`SCP_ROLE`) applies to BACKGROUND WORK ONLY. A queue worker belongs to an `all`/`worker` process. It must NOT be applied to a ROUTE: in the split topology (`SCP_ROLE=api` serving HTTP, `SCP_ROLE=worker` draining queues) EVERY request arrives at an api process, so a route carrying the process axis would refuse every caller on a perfectly correct commander. `commanderOnlyFederationVerdict` is the half a route asks; `commanderOnlyJobVerdict` is the whole question a job asks.

THE FAIL-CLOSED BRANCH IS THE POINT. `config.federationRole` DEFAULTS to `commander` when `SCP_FEDERATION_ROLE` is unset, because that is right for "may I serve the SPA?" and preserves every pre-M16.3 deployment. It is wrong for "am I the commander?": an outpost predating the setting, or a chart omitting it, is indistinguishable from a declared commander here — and that is exactly the population most likely to be air-gapped. An undeclared deployment is REFUSED, never assumed; the remedy is one env var an operator can set truthfully either way.

### §144. THE FEDERATION AXIS ALONE

THE FEDERATION AXIS ALONE — the question a ROUTE asks.

`what` names the capability in the operator's own words and is interpolated into every reason, so a refusal says which capability refused instead of repeating one generic sentence five times.

### §145. BOTH AXES — the question a BACKGROUND JOB asks

BOTH AXES — the question a BACKGROUND JOB asks. The process split is checked FIRST so an `api` process is told it is the wrong PROCESS rather than being told something about federation, which would send an operator to change the wrong setting.

### §146. THE SAME QUESTION, SHAPED FOR AN API RESPONSE

THE SAME QUESTION, SHAPED FOR AN API RESPONSE — "does dependency management HAPPEN on this deployment, and why?" (`DependencyManagementSchema`, ADR-0032 §7d).

WHY THIS EXISTS AT ALL — A CORRECT ANSWER NOBODY WILL ACT ON IS NOT AN EXPLAINED ANSWER
The guards above answer a question a JOB or a ROUTE asks about ITSELF, and their product is a refusal. But the tenant-facing resolve route does not refuse: it answers `enabled` on an outpost, computed from policies that federated down correctly, for a subscription that NOTHING ON THAT DEPLOYMENT WILL EVER ACT ON. That is charter principle 6 failing rather than being satisfied — an answer whose REASON is unavailable — and it is the same shape as an unattributed ingestion stamp one layer down. This function is what lets every such answer carry the missing qualifier.

ONE PREDICATE, NOT A SECOND OPINION
`managedHere` IS `commanderOnlyFederationVerdict`'s verdict — called, not re-derived. A parallel `federationRole === "commander" && federationRoleDeclared` written here would be the fifth copy of a rule whose fail-closed branch is invisible on every developer machine, which is precisely the property CLAUDE.md's census rule names. `reason` adds nothing to the DECISION: it is a pure LABEL of what the operator declared, so the two cannot disagree about the verdict, and `managedHere === (reason === "commander")` is a property a test can pin rather than an invariant a reader has to trust. (`commander-only.test.ts` pins it over the full config matrix.)

THE FEDERATION AXIS ONLY. This is a fact about the DEPLOYMENT, not about the process serving the request — an `SCP_ROLE=api` process on a correct commander must not report that dependencies are unmanaged there just because the jobs drain on its `worker` sibling. Same reason a route asks `commanderOnlyFederationVerdict` and a job asks `commanderOnlyJobVerdict`.

## `apps/server/src/dependencies/component-ingestion-gate.test.ts`

### §147. The gate that decides whether manifests are fetched

M21.2 — THE GATE THAT DECIDES WHETHER A COMPONENT'S MANIFESTS ARE FETCHED AT ALL (ADR-0032 §6).

ADR-0032 §6 states the consequence in two deliberately different verbs: "a disabled component is never FETCHED and an opted-out dependency is never POLLED". Ingestion is a fetch, so it is gated by the chain's first two conjuncts — and the whole point of `mergeComponentIngestionGate` is that it decides that by running the REAL merge over witness lines rather than by writing `instanceUnlocked && candidates.some(...)` a second time.

These tests are therefore about EXACTNESS, not about the boolean. An approximate gate is defensible in the safe direction and would still be wrong: a component whose org-wide enable survives one narrow opt-out must still be fetched, or its inventory freezes for a reason nobody can see. Each case below is paired with what `mergeDependencySubscription` itself says about a concrete line, so a drift between the two is a failure rather than a matter of opinion.

### §148. And the witness itself, which the verdict does not cover

AND THE WITNESS ITSELF, which the verdict above does not cover. It used to be "the first selector that opened the gate", taken from a candidate list that arrives in the order an UNORDERED SELECT returned — so two identical runs could disagree. Any consumer that records it (the ingestion Decision did) then re-opens the persist-on-change guard, which exists because a churning Decision measured 1.44 GB/day (ADR-0024).

### §149. The fresh-value trick is right for open strings only

The fresh-value trick is right for `coordinate` and `major` — open strings, where a value no selector names is a value some real line could have. It is WRONG for `ecosystem`, whose whole domain is the five members of the enum. A witness carrying an invented sixth is matched by no ecosystem-scoped opt-out at all.

## `apps/server/src/dependencies/delegation-detection.test.ts`

### §150. The conflict detection, at the layer that always runs

The conflict detection, at the layer that always runs.

The rule these assertions encode is stated once in the module doc and is the reason every ambiguous case below resolves the way it does: WHEN IN DOUBT, IT COVERS. A wrong "covers" costs a legible refusal naming a file; a wrong "does not cover" puts two actuators on one manifest, which is the failure the whole feature is gated on preventing.

### §151. "WE COULD NOT CHECK" IS NOT "NOTHING TO FIND"

"WE COULD NOT CHECK" IS NOT "NOTHING TO FIND" — EACH FAILURE MODE, SEPARATELY
The probe used to swallow every read failure into `unreadable` and return `delegated: false`, so a bad credential, a provider 5xx, an egress refusal and a refused blob all produced a result BYTE-IDENTICAL to a clean repository: `configs: []`, `collisions: []`, `delegated: false`. The dispatcher then wrote an `allow` Decision and authored the bump, and the `delegation_probe_failed` branch it has for exactly this was unreachable.

Each mode is asserted on its own rather than as one "the reader failed" case, because they arrive through DIFFERENT limbs — three of them as a THROW from the reader (the git adapter's own auth/HTTP failure, and the plugin host's egress guard) and one as a `refused` OUTCOME the reader returns normally. A single test would have proven only whichever limb it happened to take.

### §152. The other half of the seam, easy to leave untested

THE OTHER HALF OF THE SAME SEAM, and the one easy to leave untested because both sides compile fine without it: the server BUILDS the descriptor and the plugin PARSES it, across a plugin-host RPC boundary where the type on the wire is `Record<string, unknown>`. Nothing but a test can say the two agree.

It is not hypothetical. The plugin REQUIRES `declaredManifestPaths` — it refuses to default that set to the target manifest, because a default would make its "must be a manifest the component already contains" gate compare a value with itself — so a server that did not send it would fail every bump at dispatch with both packages green.

## `apps/server/src/dependencies/delegation-detection.ts`

### §153. Does this repository already delegate its updates

M21.5 — DOES THIS REPOSITORY ALREADY DELEGATE ITS DEPENDENCY UPDATES TO SOMEBODY ELSE? (charter `scp-managed-dep` amendment 2026-08-13; ADR-0032 §8.)

THIS IS LOAD-BEARING, NOT A NICETY, AND ADR-0032 §8 SAYS WHY IN ONE LINE
ADR-0002 §3's gate 1 asks whether an execution system for this class of change already exists. For dependency bumps the honest answer is that **gate 1 FAILS wherever Renovate or Dependabot exists** — that IS the execution system for this class — so the router's default verdict is COORDINATE and the owner's Mode C selection was made with that analysis in hand. What keeps gate 1 coherent is that **opting a component in is itself the gate-1 flip**: enabling dependency subscriptions declares CommanderSCP the execution system for this class in that domain.

A flip can only mean something if it is exclusive. If a component enables subscriptions while its repository still delegates the same manifests to Renovate, then *two actuators edit one file* — which is not a merge conflict to be resolved but a pair of systems each believing it owns the declared version, racing on every release of every line. So the refusal below is not defensive hygiene; it is the condition that makes the gate-1 flip a true statement.

WHY A STORED PROBE RATHER THAN A READ AT THE MOMENT OF AUTHORING
The refusal belongs at the choke point M21.3's sibling guard already uses — `graph/objects-repo.ts`'s `createObject`/`updateObject` — for exactly the reasons that guard's header sets out: the typed `/policies` route is NOT the boundary, and three free-form-`typeId` doors reach `createObject` with the same document. But answering "does this repository delegate?" requires READING FILES OUT OF A REPOSITORY, and `createObject` runs inside a tenant transaction that already holds two per-org advisory locks to commit. Doing provider I/O there would hold those locks across a network call.

So the question is answered ASYNCHRONOUSLY, where the repository is already being read — the same `readFileAtRef` route M21.4 built for the inventory — and the ANSWER is persisted as a `Decision`. The choke-point guard then performs one indexed read (`decisions_org_subject_kind_created`, the exact shape `latestDecisionForSubjectKind` was indexed for) inside the transaction and refuses on a `block`.

A Decision is the right home for this and not a convenient one: it is the platform's own explainability substrate (charter principle 6 — "every engine verdict persists a Decision record with its inputs; every blocked response carries a `decision_id`"), it is org-scoped and RLS-covered like everything else, `insertDecisionIfChanged` already solves the daily-re-probe write amplification that cost 1.44 GB/day elsewhere, and the refusal the operator reads can hand back the very `decision_id` that explains itself. A bespoke table would have been a fifth place to migrate and a second place to explain from.

WHAT ABSENT MEANS, STATED RATHER THAN LEFT TO INFERENCE
No probe on record means NO DELEGATION HAS BEEN OBSERVED — not "delegation is unknown, refuse". That is the charter's own reading: it refuses to enable "for a component whose repository ALREADY delegates the same manifests", which is a refusal predicated on an observed fact. Requiring a positive clean probe first would make enablement depend on an ingestion having run, and an operator would meet a refusal that named nothing.

The cost of that reading is real and is covered rather than accepted: a policy authored BEFORE the probe would stand. The actuator seam (`bump-actuator.ts`) re-checks the same stored verdict before every single authored bump, so a delegation discovered later stops the writes even though it did not stop the policy. Two halves, one stored fact, neither of them fail-open.

WHEN IN DOUBT, IT COVERS
Every ambiguity in `delegationCoversManifest` resolves towards "yes, it covers" — an unparseable `renovate.json`, a `dependabot.yml` naming an ecosystem this code does not map, a config shape newer than this parser. Guessing "no" would let two actuators loose on one file, which is the failure this whole module exists to prevent; guessing "yes" costs a legible refusal that names the file and can be resolved by deleting it. The asymmetry is not close.

### §154. Every path a delegating configuration is known to live at

Every path a delegating configuration is known to live at.

Renovate's own documented discovery order plus Dependabot's single location. `.renovaterc` (no extension) is JSON despite the name — that is Renovate's convention, not an assumption made here. A `renovate` key inside `package.json` is deliberately NOT probed: it would require reading and parsing every component manifest for a config that Renovate itself deprecated, and the residual is recorded in `probeDependencyUpdateDelegation` rather than hidden.

### §155. The provider's ecosystem values mapped into our five

Dependabot's `package-ecosystem` values mapped into ADR-0032's five. Only the five matter: a `cargo`/`bundler`/`nuget` entry is real delegation but of a class SCP does not author, so it cannot collide and is not a reason to refuse.

An UNRECOGNISED value is NOT dropped — see `parseDependabotConfig`, where it widens the config to `coversEverything`. A value this map has not learned yet is exactly the case where guessing "does not collide" is the dangerous guess.

### §156. Reads a delegating configuration, or returns nothing

Read a delegating configuration, or return `undefined` when this file is not one.

PARSING IS DELIBERATELY SHALLOW. Renovate's config language is large (presets, `packageRules`, regex managers, inherited org config) and Dependabot's is small; reimplementing either faithfully would be a second, drifting copy of somebody else's product. What this needs to decide is one boolean — could this config edit the same manifest SCP is about to edit? — and every shortcut below widens rather than narrows the answer.

### §157. Dependabot's `updates:` list, read WITHOUT a YAML parser

Dependabot's `updates:` list, read WITHOUT a YAML parser.

The server has no YAML dependency and adding one to answer a boolean would be a new required dependency for a probe. What is needed is the set of `package-ecosystem` and `directory` values, both of which are scalar keys on list items — a line scan finds them, and anything the line scan cannot make sense of widens the result to `coversEverything` rather than narrowing it.

The honest bound, stated rather than discovered: a `dependabot.yml` using YAML anchors, flow mappings, or multi-line strings for these keys is not narrowed by this reader — it is reported as covering everything, which refuses more than strictly necessary and never less.

### §158. Every entry naming an ecosystem we do not author for

EVERY entry named an ecosystem SCP does not author bumps for (bundler, cargo, nuget, …), so no collision with a bump SCP would write is possible. The unmapped names are carried through as the config's `ecosystems` — a NON-EMPTY list disjoint from SCP's, which is what makes `delegationCoversManifest` answer "does not cover". Leaving the list empty here would have meant "unrestricted" and refused every enablement in the org, which is the opposite claim and is the defect `delegation-detection.test.ts`'s bundler case caught.

### §159. Does `config` claim the manifest at `manifestPath`

Does `config` claim the manifest at `manifestPath` (declaring a dependency of `ecosystem`)?

Directory matching is by PREFIX on path segments, which is how both tools scope themselves: a `directory: /services/api` claims `services/api/package.json` and does not claim `services/api-v2/package.json`. `/` claims everything under it — for Dependabot that is the documented meaning of the repository root, and it is also the shape a bare `directory: "/"` takes.

### §160. True only when every candidate path was answered

True only when EVERY candidate path in `DELEGATION_CONFIG_PATHS` was answered — found or genuinely absent. False the moment one of them could not be read.

It is a separate field from `delegated` because the two answer different questions and the difference is the whole refusal: `delegated: false` means "no delegating config was found", which is a claim about the repository, and it may only be made when the repository was actually readable. See `delegationProbeIsInconclusive`.

### §161. Could not check must never resolve to go ahead

"WE COULD NOT CHECK" MUST NEVER RESOLVE TO "GO AHEAD AND WRITE TO IT"
A probe that read nothing looks EXACTLY like a probe that found nothing — same `configs: []`, same `collisions: []`, same `delegated: false` — and that is how a bad credential, a provider 5xx or an egress refusal turned into an `allow` verdict and an authored commit. This is the one refusal standing between CommanderSCP and two actuators editing one file, and the cost of the two mistakes is not symmetric: a refused bump is a component that keeps declaring an older version and says so; a wrong one is a commit in somebody else's repository, racing Renovate on every release.

So an inconclusive probe is not a verdict at all. It is recorded as NOTHING — `recordDelegationProbe` refuses to persist it rather than writing a weaker `allow`, because a stored `allow` would then be read as a standing fact by both readers long after the outage that produced it. The dispatcher skips the candidate with a named cause and re-derives on the next advance.

A probe that DID find a collision is conclusive enough to refuse whatever else failed to read: more unread config could only add collisions, never remove the one already found. That is why the test is `!delegated && !conclusive` rather than `!conclusive`.

### §162. Reads every candidate config and decides whether any

Read every candidate config out of the component's repository and decide whether any of them claims a manifest this component declares.

`reader` is M21.4's `ManifestReader` — the SAME server-side route to `readFileAtRef` the inventory uses, which resolves the git-provider binding CONFIGURED FOR THAT REPO and refuses to read one repository with another binding's credential. Reusing it is deliberate: a second way to read a user's repo would be a second place for that restraint to be forgotten.

RESIDUAL, stated rather than hidden: a `renovate` key inside `package.json` is a supported (if deprecated) Renovate config location and is not probed here, because probing it means parsing every component manifest for a config. A repository configured that way is not detected, and the actuator's re-check inherits the same blind spot — this is the known bound of the detection, not a bug in it.

### §163. Persist the probe's verdict against the component

Persist the probe's verdict against the component.

`insertDecisionIfChanged` rather than `insertDecision`, and that is not an optimisation: this probe is re-run on a TIMER (every ingestion pass over a component), which is the exact writer shape that produced 1.44 GB/day of byte-identical rows elsewhere in this system. A repository's delegation status changes when somebody adds or deletes a file; the verdict should be written then and not once per pass.

AN INCONCLUSIVE PROBE IS REFUSED HERE, not merely skipped by the one caller that exists today. The refusal belongs at the WRITER because that is the only place every future producer of this verdict must pass through: a caller that forgot the check would otherwise persist an `allow` that both readers then treat as a standing fact about a repository nobody could read. It throws BEFORE touching `tx`, so it is a decision about the argument rather than a database outcome.

## `apps/server/src/dependencies/dependency-inventory-repo.ts`

### §164. M21.2 — the DEPENDENCY INVENTORY repo

M21.2 — the DEPENDENCY INVENTORY repo (ADR-0032 §3/§4/§5/§7).

Every function here is a SINGLE-HOP index lookup or a single-row write. That is not an accident of the current feature set, it is the boundary that justifies the inventory being tables at all (ADR-0032 §3): the moment a transitive traversal appears on this path, the graph representation becomes necessary again and the measured `impact-of` recursive-CTE hazard applies. There is deliberately no `listTransitiveDependencies`, no recursive CTE, and no reachability walk in this file — and `dependency-inventory.integration.test.ts` pins that absence with a source-level census rather than trusting the intention.

NOTHING HERE WRITES A RELATIONSHIP. Package dependencies mint no `depends_on` edge (ADR-0032 §5): that type is the wave-plan toposort input and the `impact-of`/`blast-radius` default relType, a cycle among co-placed targets is a hard plan-compile error, and package graphs routinely contain cycles. `relationships` is not imported by this module, which is the enforcement.

All reads and writes run inside `withTenantTx`, so the `org_isolation` RLS policy on both tables is the outer barrier and the explicit `eq(*.orgId, orgId)` predicates below are the inner one — DESIGN §4.2's "cross-tenant leakage requires two independent failures".

### §165. `tag_pattern` is meaningful for `oci` ONLY

`tag_pattern` is meaningful for `oci` ONLY. The four language ecosystems carry their own version grammar, so a tag pattern on one of them would be a field nothing reads that a later parser could mistake for configuration. Normalised to NULL at the one write choke point rather than validated at each call site.

### §166. Insert or return the line identified by that key

Insert-or-return the line identified by `(orgId, ecosystem, coordinate, major)`.

The conflict target is the NATURAL KEY, never a URN — `graph/urn.ts`'s `slugify` collapses `@acme/lib`, `acme/lib` and `acme-lib` into one slug, so a URN-keyed upsert would silently merge three different packages into one subscription target and then 409 (ADR-0032 §3, Context 2). The coordinate goes in verbatim, case preserved; no normalisation is applied anywhere on this path.

The update branch touches ONLY `tag_pattern` (and only when a non-null one is supplied). It deliberately cannot reach the `latest_*` observation columns, which belong to M21.4 detection. Two different ingresses writing one row must not be able to clobber each other's fields. It cannot reach the PRODUCER DECLARATION either, and since drizzle/0068 that is structural rather than a matter of this SET list: the declaration is a row of `dependency_line_producers`, a table `inventory-ingestion.ts` does not import.

NOTHING BUT THE LITERAL SET LIST BELOW ENFORCES THAT — no constraint, no trigger, no column-level grant. Widening the set by one key is a one-line change that type-checks and that every round-trip test still passes, so the property is pinned behaviourally instead: see "manifest re-ingestion cannot clobber a declared producer or an observed head" in `dependency-inventory.integration.test.ts`. That test is the guard; this paragraph is not.

### §167. DECLARE the component that produces this COORDINATE

DECLARE the component that produces this COORDINATE — the ONE way a coordinate becomes internal (ADR-0032 §7/§7e, ADR-0030 §2). Idempotent: re-declaring restates the producer and re-stamps the provenance.

IT IS A SEPARATE VERB FROM `upsertDependencyLine`, AND THAT IS THE WHOLE PROPERTY. If ingestion could pass a producer alongside a coordinate it just observed, "declared, never inferred" would survive only as long as every ingestion call site remembered to leave the field unset — and this repo has already shipped a provenance label that went false the moment its matcher covered a second case (charter principle 6). The split removes the capability FROM INGESTION rather than guarding it there, and since 0068 it is stronger than a split verb: the producer lives in a DIFFERENT TABLE that `inventory-ingestion.ts` does not import at all.

THE GRAIN IS THE COORDINATE. It used to be the line, i.e. one major; see 0068's header for why that re-armed dependency confusion at every major bump.

WHAT THIS FUNCTION DOES NOT DO, and must not be read as doing: it does not make the declaration HUMAN, it does not check that `producerObjectId` names a live in-org `component`, and it does not clear the affected lines' heads. Those are the ROUTE's obligations (`routes/dependency-producers.ts`) — the org-unbound `objects(id)` reference here is the mitigation 0061's header said an eventual route owed, and `resetLineHead` below is the head half.

### §168. Retract the declaration, returning the removed row

RETRACT the declaration for one coordinate, returning the row that was removed, or `null` when there was none.

Retraction is a DELETE rather than a `retracted_at` flag, which is why 0068 grants DELETE on this table and 0061 deliberately withheld it on `dependency_lines`. The row's EXISTENCE is the declaration; a tombstone column would put the table back in the business of representing a half-state, which is exactly the shape the retired `dependency_lines_internal_is_declared` CHECK existed to police.

IT DOES NOT CLEAR THE HEADS, AND IT MUST BE CALLED WITH SOMETHING THAT DOES. See `resetLineHead`.

### §169. The coordinates a set of components is DECLARED to produce

The coordinates a set of components is DECLARED to produce — the FIRST hop of M21.4's internal-release derivation, served by `dependency_line_producers_org_producer`.

This replaces the partial index on the old column. It returns DECLARATIONS, not lines: the caller resolves each coordinate's lines with `listDependencyLinesForCoordinates`, whose predicate is a prefix of `dependency_lines_identity`.

### §170. The declarations for a set of coordinates in one trip

The declarations for a SET OF COORDINATES in one round trip — the inventory read surface's batched producer hydration (`dependency-read-surface.ts`): a page of lines names its coordinates, and each row's `producer` is the declaration for that row's `(ecosystem, coordinate)`, or none.

`IN` over `coordinate` inside the `org_id` prefix of the primary key, then the ecosystem is matched in JS — coordinates are ecosystem-native and rarely collide across ecosystems, and a tuple `IN` buys nothing over that here. Byte equality on the coordinate, as everywhere in this table. Empty keys ⇒ empty result, no scan.

### §171. EVERY MAJOR LINE of one coordinate

EVERY MAJOR LINE of one coordinate — the set a producer declaration covers, and the set whose heads both verbs clear.

One index descent on the `(org_id, ecosystem, coordinate)` PREFIX of `dependency_lines_identity`. An EMPTY result is ordinary and correct: a producer may be declared before any consumer's manifest has minted a line, which is exactly what per-coordinate grain exists to make representable.

### §172. The CloudEvents `type` emitted when a line's head ADVANCES

The CloudEvents `type` emitted when a line's head ADVANCES (M21.5). Declared here — beside the only function that can emit it — and consumed by `dependencies/bump-dispatch.ts`'s router, so the producer and the consumer read one constant rather than two string literals.

### §173. THE ONE WRITER OF THE `latest_*` TRIO

THE ONE WRITER OF THE `latest_*` TRIO — both M21.4 ingresses (internal detection and the third-party poll) reach those columns only through here.

It writes only that trio, so it cannot disturb the identity columns or the declared producer link. What is new in M21.4 is that it also DECIDES rather than obeying: every rule about what `latest_version`/`latest_digest` MEAN is applied here, once, instead of at each caller — because the two callers demonstrably meant different things by them. `line-head.ts` states the meaning in full; the FOUR rules enforced here are:

0. THE INGRESS MUST OWN THE LINE — THIS ONE, not a line of its category. A `third_party` write is refused while any producer is declared for the coordinate; an `internal` write is refused while none is, AND refused while the standing declaration names a DIFFERENT component than the one the release was derived from (`line_transferred`). See `ingress` below — this is the only one of the four that is about WHO is writing rather than about the version, and it is therefore decided FIRST: "you may not write here" dominates "that version is behind the head". 1. THE VERSION MUST BE ON THIS LINE — the same major line at the line's own precision, and for `oci` the same variant `tag_pattern` names. A `1.9.9` on the `2` line, or a plain tag on an `-alpine` line, is refused rather than written. 2. THE HEAD NEVER MOVES BACKWARDS. A hotfix on an older minor of the same line is a real release and is not its head: it is refused with `behind_head`, and it belongs in the caller's Decision, which is where "this release happened and the head did not move" is recorded. 3. THE DIGEST BELONGS TO THE VERSION. It is written from the SAME observation as the version and is never inherited across a version change, so the row cannot assert a (tag, digest) pair that never existed in any registry. A restatement of the SAME version may fill a digest in, and a null there does not erase the digest already resolved for that same version — nothing is claimed that was not seen, and nothing true is discarded.

The row is taken FOR UPDATE first, because the decision reads the current head and both ingresses can run at once (a daily tick, an accepted change): reading without the lock would let two transactions each decide "I am ahead" against the same stale value and let the loser land last.

AND THAT SAME LOCK IS WHAT MAKES RULE 0 A RULE RATHER THAN A NARROWER WINDOW
The declaration is read AFTER the `FOR UPDATE` succeeds and in a separate statement, which under READ COMMITTED (the isolation `withTenantTx` runs at) takes a snapshot at statement start — i.e. after the lock. Both producer verbs call `resetLineHead` on every line of the coordinate in the SAME transaction as the declaration write, so they take the same row lock. The two orders are therefore both correct and there is no third:

```text
- the verb commits FIRST: this call blocks on `FOR UPDATE`, then reads the committed
  declaration and refuses. Nothing is written and no bump event is emitted.
- this call gets the lock FIRST: the verb blocks, this head write lands on a line that really
  was third-party at that instant, and the verb's own `resetLineHead` then clears it — which is
  exactly what `resetLineHead` exists to do.
```

A coordinate with NO line row yet is covered too: there is nothing for the verb to reset, and this function refuses on the declaration alone.

### §174. WHICH INGRESS IS ASKING

WHICH INGRESS IS ASKING — REQUIRED, and there is deliberately no default (an omitted argument does not compile). A default would mean "whatever the last caller to be written meant", which is precisely the per-caller divergence `line-head.ts` was created to end; and defaulting to either value silently authorizes the other ingress's race.

It cannot be the `ThirdPartyLine` brand instead: that brand is minted in an EARLIER transaction, so it carries a compile-time fact about a world that may have changed by the time this transaction opens. `HeadWriteIngress` carries the caller's claim; the declaration read below carries the world; the disagreement between them is the refusal.

AND THE `internal` ARM MUST NAME ITS PRODUCER (a required field of that arm, so it cannot be omitted any more than the argument itself can). The claim being checked is "this component's production release owns this line", and a claim with no subject can only be checked against the coordinate's category — which is how a TRANSFERRED coordinate's former producer went on writing heads and fanning bumps out of them.

### §175. Re-read the producer state here, under the lock taken

RULE 0 — re-read the producer state HERE, under the lock taken one statement ago, and compare it with what the caller claims to be. The point of the whole exercise is that this read happens inside the writing transaction: every earlier read of the same fact (the poll's work-list SQL, `asThirdPartyLine`, internal detection's phase-1 producer query) is a read of a world the network round trip between then and now gave an operator time to change.

### §176. THE PAIR MOVES TOGETHER

THE PAIR MOVES TOGETHER. On an ADVANCE the digest is whatever THIS observation resolved — including `null`, which honestly says "this version's bytes were not resolved" and is the only way the previous version's digest cannot survive beside a new tag. On a RESTATEMENT the stored digest already belongs to this same version, so a null leaves it and a non-null (a repointed tag) replaces it.

### §177. AND THIS IS WHERE THE BUMP STARTS

AND THIS IS WHERE THE BUMP STARTS — EMITTED AT THE WRITE DOOR, NOT AT EACH INGRESS (M21.5)
"A new head on a subscribed line produces a bump" is the whole point of M21.5, and it has to be true of BOTH ingresses and of any third one. Emitting it here rather than in `internal-release-detection.ts` and `version-poll.ts` is the same argument that put the head RULES here (this function's own header; ADR-0032 §7b's closing line): a fact applied by each caller has one place per caller to regress, and this file exists precisely because the two callers demonstrably disagreed about what these columns meant. A future ingress — an air-gap feed import, an operator-supplied head — dispatches a bump by construction rather than by remembering to.

ONLY ON `advanced`, never on `restated`. A restatement is the same point on the line re-observed: the daily poll re-reads an unchanged head every day for every third-party line, and enqueuing a job for each of those is a per-day-per-dependency job for work already done. Nothing is lost — a component still declaring an older version is picked up by the next advance, and the dispatch job re-derives from the row rather than from the event.

The event rides the ORDINARY OUTBOX in this same transaction (DESIGN §8), so it is atomic with the head write: a head that moved cannot fail to notify, and an event cannot name a head whose transaction rolled back. Its consumer is a ROUTER on `domain-events` (`dependencies/bump-dispatch.ts`), never a second worker on that queue — see `events/pgboss.ts`'s `DomainEventRouter` for why that distinction is load-bearing.

### §178. The one exception to that function being the sole writer

THE ONE EXCEPTION TO "`recordDependencyLineHead` IS THE ONLY WRITER OF THE `latest_*` TRIO", and it is named here rather than discovered (ADR-0032 §7e, proposal §12.3.2).

It sets the trio back to NULL — "not observed", which is exactly the state — and it is reachable ONLY from the two producer verbs. It is deliberately IN THIS MODULE, beside the writer whose monopoly it qualifies, under the same `FOR UPDATE`: a second module writing these columns is how two ingresses come to disagree about what they mean, which is the failure `line-head.ts` exists to have prevented once already.

WHY BOTH VERBS MUST CALL IT — AND WHY THIS IS A SECURITY FIX, NOT A TIDINESS ONE
A head, once written, has NO RESET PATH: `recordDependencyLineHead` refuses backward movement (`evaluateHeadMovement`), §7b clause 3's bounded exception rescues only a stored value that is not on the line as defined now, and no API resets the column.

- RETRACTION must clear it. The coordinate returns to third-party polling carrying a head that the ORG'S OWN releases put there. In the ordinary case — internal `2.7.0` against upstream `2.3.1` — the line is WEDGED: the poll refuses every real public version until upstream passes `2.7.0`, and refuses it as `behind_head`, which reads as normal operation.

```text
 And a wedge is the mild reading. `latest_version` IS NOW A SECURITY-GATE INPUT: the M22 vendor
 rule grants a scan pass when a component is on the latest of its major line. A stale head left
 over from the internal era, on a coordinate that is third-party again, can therefore grant a
 VENDOR PASS AGAINST A VERSION NO REGISTRY EVER PUBLISHED. That is a gate answering yes on
 evidence the world never produced, which is a different class of defect from a stalled poll.
```

- DECLARATION must clear it too, symmetrically. A poisoned public head — the stranger's `9.9.9` — would otherwise survive the very declaration that exists to undo the confusion, and internal detection could never move the head back down to the org's real `2.1.0`, because that is backward movement and the door refuses it. Clearing is what makes the declaration an actual remedy rather than a change of ingress with the damage left in place.

WHAT CLEARING DOES *NOT* DO — AND WHAT DOES IT (corrected 2026-08-17, measured)
This function used to be described as making the remedy DURABLE. It does not, and could not: it clears the head STANDING AT THIS INSTANT, and both ingresses straddle a transaction boundary, so an in-flight poll can hold an answer it fetched BEFORE the declaration and write it AFTER. That was measured end to end: a public `2.99.0` landed on a just-declared internal line, fanned a bump out, and became unfixable — the poll's work-list no longer visits an internal line, and the legitimate internal `2.1.0` is refused as `behind_head`.

DURABILITY IS RULE 0 AT THE WRITE DOOR, not this clearing: `recordDependencyLineHead` takes the ingress it serves and re-reads the declaration under the same `FOR UPDATE`. The two are complementary and neither is redundant — this clears what was written BEFORE the declaration, rule 0 refuses what would be written AFTER it.

NO EVENT IS EMITTED. `DEPENDENCY_LINE_HEAD_ADVANCED_EVENT` means "a newer version exists"; a reset means "we no longer know", and dispatching bumps off a clearing would be a fan-out from an absence.

Returns the head as it stood BEFORE, so the caller's Decision and its response can report what was discarded rather than only that something was.

### §179. Insert or update one declaration read from one manifest

Insert-or-update one DECLARATION read out of one dependency manifest.

Keyed on `(orgId, componentObjectId, lineId, manifestPath)` — the manifest path is part of the identity because one component can legitimately declare the same line from two manifests (two Dockerfiles; a root and a workspace `package.json`), and collapsing them would make a prune of one silently delete the other's declaration.

`createdAt` is NOT in the update set: it records when this declaration was first seen, and re-observing an unchanged manifest must not reset it. `observedAt` IS, because that is the "we looked" timestamp. Both halves are pinned by "re-observing preserves createdAt and advances observedAt" in `dependency-inventory.integration.test.ts` — as with the line upsert above, the absence of a key from a SET list is enforced by nothing except the literal.

### §180. FORWARD lookup — "what does component C declare?"

FORWARD lookup — "what does component C declare?" (ADR-0032 §4). One index descent on the primary key's `(org_id, component_object_id)` prefix. Optionally narrowed to a single dependency manifest.

DIRECT DECLARATIONS ONLY. This returns what C's own manifests say and nothing further; there is no option, flag or overload that walks into the returned lines' own dependencies. The transitive closure is an SBOM by another name and ADR-0013 keeps SBOM bytes out of SCP deliberately.

### §181. REVERSE lookup — "which components declare line L?"

REVERSE lookup — "which components declare line L?" (ADR-0032 §4). One index descent on `component_dependencies_org_line`. This is the fan-out list a dependency subscription resolves against, and it is single-hop for the same reason as above: the subscribers of L are the components that DECLARE L, never the components that transitively reach it.

### §182. Prune the declarations for ONE

Prune the declarations for ONE (component, REPOSITORY, dependency manifest) down to exactly `keepLineIds` — the "the manifest dropped a dependency" path, and the reason `component_dependencies` carries a DELETE grant while `dependency_lines` does not (0060 header; the precedent is 0050, which added `source_mappings`' DELETE grant for the same "the declaration went away" reason).

THE SCOPE IS THE EVIDENCE, and it has three parts because a caller only ever has evidence about all three:

- ONE COMPONENT, because this is that component's inventory; - ONE REPOSITORY (`observedRepo`), because an ingestion pass reads exactly one, and "there is no `package.json` here" is a statement about the repo that was read and about no other. Without this conjunct a pass over a component fed by two repositories deleted the OTHER repository's declarations on every release — silently unsubscribing the component, since `listSubscribedComponentLines` derives subscription from these rows (drizzle/0063); - ONE MANIFEST PATH, because a `go.mod` re-read must never prune what a `Dockerfile` declared — a run that parsed one manifest would otherwise empty the inventory one ecosystem at a time.

A row whose `observed_repo` is NULL is matched by NO repository and is therefore never pruned. That is deliberate rather than incidental: the column records where a declaration came from, and a row that never recorded one cannot be shown stale by evidence from anywhere. Stale and visible beats deleted and silent; a re-observation stamps the column and the row becomes prunable again.

Returns the number of rows removed so a caller can tell a real prune from a no-op.

An EMPTY `keepLineIds` means "this manifest now declares nothing" and removes every row for it — which is a legitimate outcome, so it is expressed rather than short-circuited. `notInArray` with an empty list is not portable-safe, hence the explicit branch.

### §183. The lines named by a set of ids, in one round trip

The lines named by a set of ids, in one round trip — the hydration step after either single-hop lookup above. Returns nothing for an empty id list rather than scanning the org.

This is a BATCHED POINT LOOKUP, not a traversal: the ids come from rows the caller already holds, and the function performs no further expansion of what it returns.

### §184. The same batched lookup, narrowed to third-party lines

The same batched point lookup, NARROWED IN SQL TO THIRD-PARTY LINES — the poll's only door onto `dependency_lines` (ADR-0032 §7's ingress split).

An INTERNAL line (`produced_by_object_id IS NOT NULL`) has its head DERIVED from the org's own production releases and must never be asked of a public index: a stranger's package sharing the coordinate would otherwise overwrite the org's own `2.1.0` with `9.9.9` and every subscriber would be bumped onto it. That is dependency confusion, delivered by a background job on a timer.

TWO INDEPENDENT BARRIERS, deliberately, because a filter is precisely what a caller forgets: 1. this predicate, so an internal line is never even loaded into the work-list; and 2. the `ThirdPartyLine` brand this returns — `queryLineHead` accepts nothing else, so a future caller that hydrates lines some other way does not compile rather than silently polling. The SQL `NOT EXISTS` is what makes barrier 1 real and `asThirdPartyLine` re-reads the same fact for barrier 2, so removing either alone still leaves the other refusing.

SINCE drizzle/0068 THE PREDICATE IS AN ANTI-JOIN, not `produced_by_object_id IS NULL`, and the change is the point of the migration rather than a mechanical port. The declaration is keyed by `(org_id, ecosystem, coordinate)`, so a BRAND-NEW MAJOR of a declared coordinate is excluded from the poll the instant ingestion mints it — under the old per-line column that row carried a NULL producer nobody had filled in, and the poll handed the org's own coordinate to a public index.

## `apps/server/src/dependencies/dependency-inventory-routes.integration.test.ts`

### §185. The read surface, against real Postgres and the real app

M21.6 — THE READ SURFACE against real Postgres and the real app (docs/proposals/dependency-subscription-ui.md §3.1/§3.2/§5).

```text
GET /components/{idOrUrn}/dependency-inventory
GET /components/{idOrUrn}/dependency-bumps
```

What this file pins, and why each pin is the shape it is:

1. DELETE-THE-WIRING. Both routes are requested THROUGH THE APP and asserted 200. Remove either `typed.route({...})` registration in `routes/dependency-subscriptions.ts` and the matching test 404s. (Proven once at authoring time; this test is what keeps it proven.) 2. ONE ROW PER (line, dependency manifest). `manifestPath` is in `component_dependencies`' key, so a line declared from two manifests is two rows — a consumer that wants one-per-line groups. 3. NO SECOND AND. Every row's `subscription` is BYTE-EQUAL (JSON.stringify) to what `GET /components/{id}/dependency-subscription` returns THE SAME CALLER for THE SAME LINE. That equality dies the moment anyone recomputes `enabled` locally in the read path — mutated once to watch it die, then restored. 4. `componentGate` EQUALS the ingestion gate — the same `resolveComponentIngestionGate` answer for the same actor, not a re-derivation. 5. `ingestion` IS THE M21.7 STAMP, read in the same transaction: `null` (never attempted) and a null `lastIngestionDecision` UNTIL an ingested pass writes both — then the stamp carries the pass's outcome/source/rows and its per-repo `manifests[]`, and the Decision its id and manifest paths. Mutation: `ingestion: null` hard-coded in the route → the ingested case RED. 5a. BOTH responses carry `dependencyManagement` from `dependencyManagementOf(config)` — on this file's DECLARED commander `{ managedHere: true, reason: "commander" }`, and on an UNDECLARED server (a second harness) `{ managedHere: false, reason: "role_undeclared" }` with the same 200 and the same RBAC (the reads do not refuse; the envelope qualifies). Mutation: drop the spread from either route → the response serializer refuses the missing required field. 6. RBAC IS AT THE COMPONENT: a Viewer bound at the component 200s, a principal bound nowhere near it 403s, an unknown component 404s. This is the property that makes the inventory reachable to a component team at all (`GET /changes` / `GET /decisions` are org-scoped and would 403 them). 7. THE COORDINATE TRAVELS VERBATIM (`@acme/lib`). 8. PAGINATION terminates and neither drops nor repeats a row; a syntactically valid but semantically garbage cursor (a non-uuid id, an unparseable date) is the FIRST PAGE, not a 500. 8a. RESOLVED AS THE CALLER — not merely "byte-equal to resolve() for the admin". The objectRef policies above match independently of the actor, so the admin and the SYSTEM sentinel gather the SAME candidates and a read path that hard-coded `SYSTEM_ACTOR_ID` (or dropped the parameter) would leave every other pin green. The one place the actor changes the answer is a group-only enable (acting half `via: "group"` — no `owns` edge), which the authoring guard refuses at every local door but which reaches the DB over the `federationImport` exemption. A member of that group reads `enabled` and the org admin reads `not_enabled` for the SAME row; both byte-equal to THEIR OWN resolve(). Mutated once (actor → SYSTEM sentinel in `dependency-read-surface.ts`): this pin RED, everything else green; restored. 9. BUMPS: rows are joined to the change name and to the newest merge Decision (drop the join and the test dies — mutated once), `pullRequestUrl` is READ off the authorship row (the URL the provider returned, stored by `recordBumpPullRequest`) — present on the row that has one, `null` on the row that does not, never composed — newest dispatch first, the dispatch Decision's delivery is read (not the tenant-writable `source_ref`), and RBAC is at the component.

INSTANCE-GLOBAL FIXTURE: the unlock singleton is deleted at teardown however this file exits.

### §186. A DECLARED producer on the wanted COORDINATE

A DECLARED producer on the wanted COORDINATE (ADR-0032 §7e — the grain is the coordinate, `dependency_line_producers`, not the line), and an OBSERVED head — so `producer` and `head` are asserted against stored facts rather than against nulls that would pass for the wrong reason. The opted-out line's coordinate (`acme-lib`, the slug-colliding spelling) is NOT declared: a producer read that matched by URN slug instead of by verbatim coordinate would show a producer on that row too.

## `apps/server/src/dependencies/dependency-inventory.integration.test.ts`

### §187. M21.2 — the dependency inventory substrate

M21.2 — the dependency inventory substrate (ADR-0032 §3/§4/§5/§7, migration 0060).

Five properties are load-bearing and each is pinned here rather than left to the migration's comments, because a comment naming a hazard is a signal to sweep, not evidence it was handled (CLAUDE.md, "census by property"):

```text
1. The tables ROUND-TRIP, and both hot queries are the single-hop lookups ADR-0032 §4 promises.
2. RLS ISOLATES TWO ORGS. A dependency inventory is a map of an org's entire software estate;
   this is the one that leaks something if it is wrong, so it is probed with a RAW `scp_app`
   connection (no application code, no `withTenantTx`) exactly as `graph/rls.integration.test.ts`
   does — the database's own defenses, independent of whether the repo layer remembers to filter.
3. `@acme/lib` and `acme-lib` are DIFFERENT LINES. This is the URN-collision case that is the
   whole reason the inventory is tabular, and the test asserts the collision is REAL by running
   the coordinates through `slugify` itself rather than asserting against a remembered claim.
4. NO `depends_on` EDGE, and no relationship at all, is minted by any of it (ADR-0032 §5).
5. THE THREE INGRESSES DO NOT CLOBBER EACH OTHER. Manifest ingestion, operator declaration and
   registry observation write disjoint column sets of one `dependency_lines` row, and the ONLY
   thing enforcing that is the literal SET list of each write (ADR-0032 §7 is why the verbs are
   separate at all). No constraint, no trigger and no type catches a widened SET list.
```

```text
   Asserting that field-by-field is necessary but NOT sufficient, and the earlier draft of this
   header claimed the field-by-field assertions settled it. They do not: a clobber is only
   observable if no LATER write restores the field, so each pair of ingresses has to be
   exercised in the order that puts the suspect verb LAST. Both tests here that combined
   declaration with observation declared first, which made a `latest_*` clobber inside
   `declareDependencyLineProducer` invisible to all of them. The three pairs are now covered in
   the orders that can see a clobber: ingestion last ("manifest re-ingestion cannot clobber..."),
   observation last ("records an observed line head..."), declaration last ("declaring a
   producer AFTER the head was observed..."), each with a negative control proving the suspect
   write did land on the row.
```

Every absence assertion below carries a NEGATIVE CONTROL in the same test — a test proving nothing happened is vacuous unless it also proves the thing that SHOULD happen did.

### §188. A declaration row is a snapshot, not an accumulator

A declaration row is a SNAPSHOT OF ONE MANIFEST READ, not an accumulator. The update branch writes `resolvedVersion`/`resolvedDigest`/`observedRef` as `input ?? null` (dependency-inventory-repo.ts:298-304), so a re-read that resolves nothing CLEARS what the last read resolved — the same instinct as `recordDependencyLineHead`'s digest rule (a digest always belongs to the version stored beside it) applied to the row that carries it: these three are only what THIS manifest said THIS time, and a stale digest beside a fresh `declaredVersion` would claim bytes nobody resolved.

Pinned because nothing else did: deleting all three keys from that SET list left every other test in this file green. If M21.3 ever wants preserve-on-omit here, this assertion is the conversation — change both halves together, not one.

### §189. The prune's condition has three predicates, not one

The prune's WHERE has three predicates and the test above exercised only one component, so `manifest_path` alone reproduced every assertion it made: dropping `eq(componentDependencies.componentObjectId, input.componentObjectId)` from `scope` (dependency-inventory-repo.ts:378-382) left all 23 tests green. Two components declaring the same line from a file with the same NAME is not an exotic case — `package.json` is the path for every npm component in the org — so under that mutation one component's re-ingestion deletes every OTHER component's declarations read from any file also called `package.json`, emptying the org's npm inventory one ingestion at a time while the function returns a rowCount the caller reads as a successful prune.

The `keepLineIds` list is non-empty here for a second reason: the only other prune test passes `[]`, which takes the short-circuit branch, so the `notInArray` half of that ternary (repo:386-388) — the branch real re-ingestion always takes — had no coverage at all.

### §190. Two timestamps with opposite rules, and what separates

Two timestamps with opposite rules, and the difference between them is one key's presence in an ON CONFLICT SET list — nothing structural. `createdAt` answers "how long has this component been on this line?", which a poll that reset it every few hours would make permanently read "minutes"; `observedAt` answers "when did we last look?", which a poll that failed to move it would make a stale inventory indistinguishable from a fresh one.

### §191. ...and so is the producer declaration

...and so is the producer declaration. Registry observation and operator declaration are different ingresses (ADR-0032 §7), and since drizzle/0068 they are different TABLES — which is a stronger separation than the old disjoint SET list, because widening `latest_*`'s writer by one key can no longer reach the declaration at all. Asserted rather than assumed: the two could still be conflated by a future verb that wrote both.

### §192. The mirror of the test above, and the order is the point

The MIRROR of the test above, and the ORDER is the entire content of it. Every test in this file that combined these two verbs declared the producer FIRST and observed SECOND, so a `latest_*` clobber by `declareDependencyLineProducer` was always overwritten by the later observation and could not be seen by any assertion: adding `latestVersion: null, latestDigest: null, latestObservedAt: null` to that function's SET list (dependency-inventory-repo.ts:207-212) left all 23 tests green. A disjointness test only pins the writer that runs LAST — each pair of ingresses has to be asserted in the order that puts the SUSPECT verb after the field it must not touch.

What the widened SET list would cost: an operator marking a line internal wipes M21.4's observed head, and the line then reads NULL — which 0061:215-217 defines as "NOT YET OBSERVED", not "no newer version exists" (absent never means zero). A dependency subscription resolving against that line is silently starved of exactly the bump it exists to fire, with nothing erroring and nothing to distinguish it from a line the poll has not reached yet.

### §193. Where the property changed shape rather than weakening

AND THIS IS WHERE THE PROPERTY CHANGED SHAPE RATHER THAN WEAKENING (ADR-0032 §7e). Declaring a producer DOES clear the head — that is deliberate, because a poisoned public head would otherwise survive the declaration that exists to undo it. But the clearing is a SEPARATE, NAMED writer (`resetLineHead`) that the two verbs in `routes/dependency-producers.ts` call explicitly. The repo verb above still writes only the declaration, so the "one writer of the latest_* trio" property is intact with exactly one documented exception rather than dissolved into whichever function happened to need it.

### §194. For `oci`, the digest is what a version claim MEANS

For `oci`, the digest is what a version claim MEANS (ADR-0032 §7) — "we are on 3.20" is a statement about bytes. The defect this pins is what an OPTIONAL digest allowed: a writer that moved `latest_version` and omitted the digest left the PREVIOUS version's digest standing beside the new tag, so the row asserted a (tag, digest) pair that never existed in any registry. The field is required now, and this asserts the rule that makes it coherent: the pair moves TOGETHER on an advance, and a restatement of the SAME version may fill a digest in but a null does not throw away one already resolved for that same version.

### §195. The three ingresses of one `dependency_lines` row

The three ingresses of one `dependency_lines` row — manifest ingestion (this test's re-upsert), operator declaration and registry observation — write disjoint column sets, and separate verbs are the whole reason ADR-0032 §7 splits them. Nothing but the literal ON CONFLICT SET list in `upsertDependencyLine` enforces the disjointness: widening it to `latest_*` or `produced_by_*` type-checks, and every round-trip test in this file still passes. This is the test that does not.

### §196. The other half of that permitted column, unheld before

The OTHER half of that one permitted column, which had nothing holding it: an ingestion that OMITS the pattern must not erase one. `coalesce(excluded.tag_pattern, existing)` (dependency-inventory-repo.ts:132-134) is the whole mechanism — replacing it with a plain `excluded.tag_pattern` left all 25 tests green, and omission is the COMMON case, not the exotic one: a Dockerfile parser has no notion of a tag pattern, so every sweep would clear the one an operator set and M21.4 would be left following a line with no shape to follow. The negative control is the assertion two lines up — the same branch, given a pattern, wrote it — so this is not "the upsert cannot write tag_pattern at all".

### §197. Three DISTINCT ROWS is the unique index's doing

Three DISTINCT ROWS is the unique index's doing. Retrieving each one BY ITS OWN KEY is a different property with a different mechanism — `getDependencyLineByKey`'s own four-predicate WHERE (dependency-inventory-repo.ts:153-160) — and two of those four had nothing pinning them: dropping `eq(ecosystem)` or `eq(major)` from it left all 25 tests green, because every other lookup in this file uses coordinates unique within the org. With `.limit(1)` and no ORDER BY, the caller then silently gets an ARBITRARY sibling: an M21.3 ingestion resolving `major: "2"` would hang its declarations off the `major: "1"` row, and a subscription on one major would fire on the other's head.

### §198. Barrier 2 (0060 header)

Barrier 2 (0060 header): the composite `(org_id, line_id)` foreign key. RLS's WITH CHECK only pins the row's OWN org_id, so without this key org B could stamp a row with its own org_id pointing at org A's line — a dangling cross-tenant reference that no read would reveal. The failure here is an FK violation, NOT an RLS one, which is what proves the second barrier is the thing doing the work.

### §199. The composite key covers the line and nothing else

Barrier 2 (the composite key) covers `line_id` AND NOTHING ELSE. `component_object_id`, `produced_by_object_id` and `produced_by_declared_by_object_id` are plain, ORG-UNBOUND `REFERENCES objects(id)` — `objects` has no `(org_id, id)` unique constraint to hang a composite key on. Referential-integrity triggers are not subject to RLS, so the FK check reads org A's row and passes.

This test asserts the CURRENT behaviour rather than the desired one, because 0060's header claimed "two structural barriers keep a cross-org reference impossible" without saying WHICH reference, and an unasserted scope is how that claim stayed unexamined. A future migration that binds `objects` by `(org_id, id)` SHOULD break this test — that is the point of it.

### §200. ...and THAT is the disclosure

...and THAT is the disclosure: an id naming nothing is rejected, so success-versus-FK-failure is an existence oracle over another tenant's object ids for anything already holding a raw `scp_app` connection. Not reachable through the API today (M21.2 has no route); the mitigation an M21.3 route owes is to resolve caller-supplied object ids under the CALLER's own org before they reach this table.

### §201. The boundary justifying the tabular form is a discipline

The boundary that justifies the whole tabular representation is a DISCIPLINE, and ADR-0032 says in as many words that it "must be enforced by test, not by intention".

The census reads the WHOLE DIRECTORY, not one named file. M21.3 (ingestion) and M21.4 (detection) land siblings here, and a census that names its one file is exactly where the next instance hides — census with no filters (CLAUDE.md).

### §202. The live database's own description of the table agrees

THE LIVE DATABASE'S OWN DESCRIPTION OF THE TABLE AGREES WITH §7d (M21.7 follow-up, LOW 6)
`drizzle/0061` ended `dependency_lines`'s COMMENT with "Does NOT federate; each domain derives its own." ADR-0032 §7d (2026-08-17) reverses the second half: all dependency automation is commander-only, so no domain but the commander derives anything here and an EMPTY inventory on an outpost is the correct state.

WHY A TEST AND NOT JUST A MIGRATION. This is the exact artefact CLAUDE.md's census rule warns about — a well-written comment that talks the next reader into deleting a guard. An operator running `\d+ dependency_lines` on an outpost, or an engineer reading the catalog while wondering why the ingestion loop refuses there, meets ONE authoritative-looking sentence, and it used to say the guard was wrong. 0061 is merged and cannot be edited in place, so `drizzle/0066` restates it — and this asserts the RESTATEMENT REACHED THE DATABASE rather than only the file, which is the difference between a migration that is written and a migration that is journalled and applied.

Read over the RAW `scp_app` connection: the catalog is what an operator sees, not what the ORM believes.

### §203. The reversed clause appears once, and only marked

THE REVERSED CLAUSE APPEARS EXACTLY ONCE AND ONLY IN ITS MARKED FORM. It is quoted rather than deleted, per the ADR-0026 D4 convention this milestone's docs follow — an original clause is preserved verbatim beside what overturned it, never silently rewritten, because a reader who remembers the old rule has to be able to find out what happened to it. But a `\d+` reader sees one paragraph with no section headings, so the quote MUST NOT be able to drift away from its marker: this asserts the two as one string, which is the only form in which the sentence is safe to leave in the catalog.

## `apps/server/src/dependencies/dependency-read-surface.ts`

### §204. The read surface over the inventory and bump history

M21.6 — THE READ SURFACE over the dependency inventory and the bump history, for ONE component (docs/proposals/dependency-subscription-ui.md §3.1/§3.2, owner decisions §8 Q1/Q4).

Two assemblers, both READ-ONLY, both scoped to one component, both paged. They exist so that the route handlers in `routes/dependency-subscriptions.ts` stay thin and so that the joins are testable through the same functions the routes call.

THE ONE RULE THIS MODULE MUST NOT BREAK: IT WRITES THE AND ZERO TIMES, AND IT HAS NO GATHER-AND-MERGE LOOP OF ITS OWN. Every per-row `subscription` comes from `resolveDeclaredComponentLines(..., { includeDisabled: true })` — THE SAME function the ingestion work-list is the enabled-only projection of, one gather + one unlock read per request — and the component gate comes from `mergeComponentIngestionGate` over the candidates and instance THAT call returned. Nothing here tests `enabled`, filters on it, or infers a tier. That is what makes `rows[].subscription` byte-equal to the resolution GET for the same actor and line (pinned in `dependency-inventory-routes.integration.test.ts`), and what would silently stop being true the day someone "optimised" the per-row merge into a local predicate — or copied the work-list's loop "minus its filter" into this file (the M21.7 review note on the proposal, §3.4, names exactly that fork as the thing a fix round would have to undo).

THE ACTOR IS THE CALLER. Both assemblers take `actorObjectId` and thread it exactly as the resolution GET does (`auth.subjectObjectId`), so a human reading their component's page sees the same enablement the resolution GET would report to them — and, as documented on `GatherSubscriptionCandidatesInput.actorObjectId`, that can differ from what the SYSTEM actor's jobs see for a `scope.group` policy. This module reports; it does not reconcile the two.

DIRECT DECLARATIONS ONLY, NO TRAVERSAL, NO RELATIONSHIP — the inventory repo's boundary (ADR-0032 §3/§4/§5) holds here: one keyset page of `component_dependencies`, one batched line hydration, one batched producer-declaration lookup (by coordinate — ADR-0032 §7e) plus one batched producer-name lookup, one batched Decision lookup per kind. Nothing walks.

### §205. The inventory page cursor

The inventory page cursor — the last row's `(lineId, manifestPath)`, which is the tail of the `component_dependencies` primary key and therefore a total order over one component's rows. Opaque on the wire (base64url JSON), like every other cursor in this codebase.

### §206. The newest ingestion Decision about this component

The newest `dependency_inventory_ingestion` Decision about this component, projected LENIENTLY — `inputContext.manifestPathsRead/Absent` and `reasonTree.skipped[{path, reason}]` are read as written by `inventory-ingestion.ts` and anything malformed reads as empty rather than throwing. `null` when no such Decision exists (never ingested, OR refused as not-enabled / not-addressable / superseded — none of which write one).

### §207. The declared producers, in one batched lookup

The DECLARED producers, one batched lookup on `dependency_line_producers` — keyed by (ecosystem, coordinate), the COORDINATE grain ADR-0032 §7e moved the declaration to (0071/0072 dropped `dependency_lines.produced_by_*`): every major line of a declared coordinate is internal, so a row's producer is its coordinate's declaration. Then the producers' names, one more lookup. `producerObjectId` carries a foreign key, so a declaration always names an object; a producer that has since been soft-deleted still resolves here (the declaration is a stored fact and the name is what it was).

### §208. The newest Decision of a kind per subject, one query

The newest Decision of one `kind` for EACH of a set of subjects, in ONE query — `DISTINCT ON (subject_id)` over the `decisions_org_subject_kind_created` index. The per-change join the bump list needs, written once and used for both the dispatch and the merge Decision.

### §209. One page of the bumps authored for a component

One page of the bumps SCP authored for a component, newest first, each joined to its change's name, its line's major, the newest `dependency_bump_dispatch` Decision (delivery + reason) and the newest `dependency_bump_merge` Decision (the second look). `pullRequestUrl` is the provider-returned URL the authorship row stores (`pull_request_url`, M21.7) when one was recorded, else `null` — never composed from `repo` + number.

## `apps/server/src/dependencies/ingestion-stamp-repo.test.ts`

### §210. M21.7 — THE STAMP MERGE

M21.7 — THE STAMP MERGE (ADR-0032 §4, drizzle/0065).

`mergeIngestionStamp` is where the table's whole correctness argument lives, so it is pure and it is asserted here without a database. The behaviour against real Postgres — that the ingestion actually calls it, with the repository it read — is pinned in `inventory-ingestion.integration.test.ts`; these are the rules themselves.

TWO DEFECTS SHAPED THIS FUNCTION, both of which turned "this component's manifests could not be read" into "this component genuinely declares nothing":

1. A refusal for a repository the component is NOT MAPPED TO overwrote a good stamp with `unreadable`. A pass that reached no provider holds no evidence about any manifest. 2. The row is per COMPONENT but ingestion is per (COMPONENT, REPOSITORY). A successful `acme/charts` pass replaced the whole row and erased a failed `acme/widgets` read.

## `apps/server/src/dependencies/ingestion-stamp-repo.ts`

### §211. M21.7 — THE DEPENDENCY-INGESTION STAMP repo

M21.7 — THE DEPENDENCY-INGESTION STAMP repo: one row per component, saying whether that component's dependency manifests were ever read, when, by which producer, and with what result (ADR-0032 §4; migration 0065 carries the full derivation).

WHAT IT IS FOR, IN ONE SENTENCE
`component_dependencies.observed_at` is PER ROW, so a component with ZERO rows carries no timestamp at all and three different truths collapse into one empty list — never ingested; ingested fine and genuinely declares nothing; ingestion ran and every manifest was unreadable. A reader that cannot tell them apart has to render "no dependencies" over all three, and the third rendered as the second is the class of dishonesty this codebase treats as a defect.

THE ROW IS PER COMPONENT; THE EVIDENCE IS PER (COMPONENT, REPOSITORY). THE WRITER MERGES.
This was wrong in the first cut and it produced exactly the lie above, by two routes:

- A COMPONENT IS FED BY SEVERAL REPOSITORIES. `source_mappings` is many-per-component and a pass reads exactly ONE repository, so `acme/widgets` (a `go.mod`) and `acme/charts` (a `Dockerfile`) each produce their own pass. Replacing the whole row, a widgets pass whose read FAILED wrote `unreadable`, and a charts pass minutes later wrote `ok` over it. State (iii) became state (ii) on a component whose manifests could not be read. - A REFUSAL FOR AN UNMAPPED REPOSITORY IS NOT EVIDENCE ABOUT THE MANIFESTS. An accepted change can target a component from a repository none of its mappings names; the ingestion refuses it without fetching (correctly — see `repoManifestScope`). Written as `unreadable` over the row, that refusal destroyed the good receipt the previous pass had just written. "This repository is not this component's" and "this component's manifests are unreadable" are different facts.

So `mergeIngestionStamp` — pure, and the whole of the decision — folds a pass into the stored row: it replaces the `(repo, *)` slice the pass holds evidence over, KEEPS every other repository's slice, and recomputes the component-level `outcome` and `rows_written` ACROSS the merged set. A pass that read no repository at all (the gate was closed, no repository was named, the named one is unmapped) replaces nothing.

The primary key is unchanged — `(org_id, component_object_id)`, one row per component — because the question the stamp answers ("what does this component's empty inventory mean?") is asked of a COMPONENT. Repository-level detail lives inside the jsonb, where a reader that does not care about it does not have to fold rows to get a component-level answer.

THREE FUNCTIONS TOUCH THE TABLE, AND ONLY ONE OF THEM WRITES
`recordIngestionStamp` is the ONE write door and it is called from exactly one place — `inventory-ingestion.ts`'s `ingestComponentManifests`, which is the choke point BOTH producers go through (the event-driven loop and the operator backfill). That is deliberate: a stamp written at each producer would be two places for "did we remember to stamp?" to diverge, and the third producer would arrive without one. `source` is a required input of `ingestComponentManifests` rather than something this function infers, because a label derived from which caller-shaped field happened to be set is exactly the provenance-label mistake this repo has already shipped once (ADR-0030 §2, charter principle 6).

The two reads are point lookups on the primary key. There is no list-the-org read and no join: everything here descends `(org_id, component_object_id)`.

### §212. One manifest entry as a pass produces it, unattributed

One manifest entry as a PASS produces it — before the write door attributes it to a repository and to an instant.

`repo` and `at` are deliberately NOT the caller's to supply: they are the same for every entry of one pass, and a caller that could set them per entry could also fabricate a slice belonging to a repository it never read, which is the merge's whole safety property.

### §213. The repository this pass holds evidence about, or null

THE REPOSITORY THIS PASS HOLDS EVIDENCE ABOUT, or `null` when it holds none.

`null` is not "unknown", it is a CLAIM: this pass looked at no repository, so it may not replace any slice and may not turn a good receipt into a bad one. The three callers that pass it are the gate refusal, the "no repo was named" refusal and the "no mapping names this repository" refusal — the last of which is the one that used to overwrite a healthy stamp with `unreadable`. Over an existing row the latter two are a complete no-op; only the gate refusal carries a fact about the component (`not_enabled`) and so is allowed to restate the row.

Non-null means the pass reached the read phase for that repository and its `manifests` are the COMPLETE current picture of it: every candidate path lands in exactly one of read / absent / skipped, so a path missing from the slice is a path that is genuinely no longer known there. That is why a slice is REPLACED rather than unioned per path — a per-path union would keep an `ok` entry for a manifest that has since been deleted, forever.

### §214. FOLD ONE PASS INTO THE STORED ROW

FOLD ONE PASS INTO THE STORED ROW. Pure, exported, and unit-tested directly — the ordering rules below are the whole of the correctness argument for this table and they must be assertable without a database.

WHAT REPLACES WHAT
- A pass that reached NO repository and resolved no component-level fact returns the stored row untouched — see the early return, which is the whole of the unmapped-repository fix. - Otherwise the pass replaces the slice for ITS OWN repository, and only if it is at least as recent as the newest entry stored for that repository. Every other repository's slice is carried forward untouched. - `outcome` and `rows_written` are then RECOMPUTED over the merged set: `ok` when every entry was read, `unreadable` when none was, `partial` for the mixed case — which is now reachable ACROSS repositories, and is the reading a component with one healthy and one broken source actually deserves. - `last_attempt_at`, `source` and `detail` describe the LATEST attempt on the component, so a late-delivered older pass leaves them alone even where its own slice still applies.

WHY ORDERING IS PER REPOSITORY AND `>=` RATHER THAN `>`
Both delivery hops are at-least-once and the ingestion queue is a competing consumer, so a retry of an earlier accept can be delivered after a later one. Ordering has to be per repository: ordering the whole row would DROP an older-but-only pass over repository B whenever a newer pass over repository A had landed first, which loses B's verdict entirely — the same silence this table replaces, arriving by a race instead of by a bug.

`>=` because two passes stamped within the same millisecond carry no order between them, so either winning is equally correct, and `>=` lets a re-run at the same instant refresh the slice rather than silently doing nothing.

THE RESIDUE, STATED: this orders passes by WHEN THEY LOOKED, not by commit ancestry — the same residue, for the same reason, that `inventory-ingestion.ts`'s row-level guard names (two commit shas carry no order between them and this system has no history walk behind the plugin seam). The next accepted change, or a backfill, re-derives the truth.

`not_enabled` IS AN OVERRIDE, NOT AN ENTRY
A closed gate is a fact about the COMPONENT — nothing was fetched, in any repository — so it cannot be expressed as evidence about a path and it dominates the computed outcome while it is the latest word. The stored entries are kept rather than cleared: the `component_dependencies` rows they describe are still there (a closed gate prunes nothing), so deleting the explanation for rows that still exist would trade one silence for another.

### §215. A pass that reached no repository changes nothing

A PASS THAT REACHED NO REPOSITORY AND RESOLVED NO COMPONENT-LEVEL FACT CHANGES NOTHING.
The unmapped-repository refusal, and the "no repo was named" one. Neither looked at a manifest, so neither may revise the verdict — that was the defect. Neither may advance `last_attempt_at` either, and that is the same argument rather than a separate one: the column is what a reader means by FRESHNESS, and moving it for a pass that read nothing would report a three-month-old inventory as looked at a minute ago. The refusal is still worth logging, and the loop and the backfill response both do; it is not worth overwriting a receipt with.

With NO row it is a different question — "never attempted" is the absence of a row, and this component HAS been attempted — so the refusal falls through and creates one.

`null` rather than a copy of the stored row, so the write door can skip the UPDATE entirely: on any real estate these refusals are the common case (an org-wide backfill refuses for every unsubscribed component), and restating a byte-identical row per accepted change is the persist-on-change shape ADR-0024's 1.44 GB/day measurement is about, in dead tuples instead of appended rows.

### §216. NO EVIDENCE, AND THIS PASS IS THE LATEST WORD

NO EVIDENCE, AND THIS PASS IS THE LATEST WORD. Either it looked and every probe came back "not there" — `ok` with 0 rows, "we looked and it genuinely declares nothing", the whole reason this table exists — or it is the first attempt on this component and it refused, which is exactly what the row is for saying (the alternative, no row at all, would mean "never attempted" and be false). The early return above is what keeps the first reading out of reach of a pass that did NOT look.

### §217. Restate what is known, folding in what this pass found

RESTATE what is known about this component, folding in what this pass established. Upserted on `(org_id, component_object_id)` — one row per component, forever.

READ-MODIFY-WRITE, SERIALISED BY THE SAME ADVISORY LOCK THE INGESTION'S PHASE 3 TAKES. The merge needs the stored row, so two concurrent passes over the same component would otherwise both read the pre-state and the second would write back a row missing the first's slice — the lost update that per-repository merging exists to prevent, reintroduced at the write. The key is identical to `ingestComponentManifests`' (`hashtext(org), hashtext(component)`), so a phase-3 caller already holds it and re-taking it is free.

WHAT THAT LINE ACTUALLY BUYS, STATED HONESTLY, because a guard nobody can redden is a guard nobody should trust: every pass that writes a SLICE goes through phase 3, which already holds this lock, so the concurrency test in `inventory-ingestion.integration.test.ts` stays green with the line deleted (measured). The one writer outside that lock is the gate refusal, and it can only race an ingest of the same component if the gate FLIPS between the two passes' gate reads — an operator disabling a component mid-release. Its lost update would write stale manifests back over a slice the ingest had just written, until the next pass re-derives. That interleaving cannot be produced deterministically from a test without a seam invented for the test, so the line is defence in depth carrying a stated residue rather than a pinned property. The refusals that establish nothing now write nothing at all (see the fold), which removes the other two.

`createdAt` is deliberately absent from the update set: it records when this component was FIRST attempted, and a re-observation must not reset it — the same reason `upsertComponentDependency` keeps `created_at` out of its own set list. Nothing but the literal list below enforces that, so it is pinned behaviourally in `inventory-ingestion.integration.test.ts` rather than by this paragraph.

### §218. THE STAMP FOR ONE COMPONENT, or `null` when there is none

THE STAMP FOR ONE COMPONENT, or `null` when there is none.

`null` MEANS "NEVER ATTEMPTED" and nothing else — there is no `outcome` value for it, because the only writer of "we have never looked" would be a pass that ran. A caller must not render `null` as "no dependencies"; that is the exact conflation this table exists to break.

One index descent on the primary key.

### §219. The same lookup for MANY components in ONE round trip

The same lookup for MANY components in ONE round trip — the list view's read.

It is a genuine batch and not a loop wearing a batch's name: `IN` over the primary key's second column, inside its `org_id` prefix, so the whole call is one index range scan rather than N descents. A component with no stamp is ABSENT from the result rather than present as a null — the caller keys the array by `componentObjectId` and a missing key is "never attempted", which is the same reading `findIngestionStampByComponent`'s `null` carries.

Returns nothing for an empty id list rather than scanning the org.

## `apps/server/src/dependencies/internal-release-detection.integration.test.ts`

### §220. M21.4 — INTERNAL DETECTION AGAINST REAL POSTGRES

M21.4 — INTERNAL DETECTION AGAINST REAL POSTGRES (ADR-0032 §7).

The version STRATEGY is proven without a database in `internal-release-version.test.ts`. What only a real database and the real coordination tables can prove is the DERIVATION itself — that the chain from an accepted change to a dependency line's head is wired to the columns it claims to read, and that each of its exclusions actually excludes:

```text
1. A ROLLBACK IS NOT A RELEASE, with the positive control that an otherwise identical forward
   accept IS. Without the control, the rollback assertion is satisfied by a derivation that
   never records anything at all — which is exactly what a wrong join, a wrong status filter or
   a missing fixture produces.
2. A NON-PROD TARGET DOES NOT TRIGGER — again against the prod control, since "prod" is a
   deployment-target PROPERTY and not a table.
3. A COMPONENT THAT DECLARES NO PRODUCED LINE IS A NO-OP — and writes no Decision, which is what
   keeps a per-accept Decision off every change in the org.
4. THE `oci` VERSION COMES FROM `observed.images`, tag AND digest.
5. A LANGUAGE VERSION COMES FROM THE PRODUCER'S MANIFEST, read at the released commit.
6. AN UNDETERMINABLE VERSION RECORDS NOTHING AND SAYS WHY — the line's `latest_*` stays null and
   the Decision names the reason.
```

FIXTURE DISCIPLINE. Every fixture that a test's conclusion depends on is READ BACK before it is relied on (the change really is `accepted`, the wave target really is `succeeded`, the producer link really landed). A silently-inapplicable fixture makes an absence assertion pass for the wrong reason, which is this repo's second-most-common recurring test defect.

MUTATION LOG — each row applied, watched fail, reverted, watched pass
| Mutation | Result |
| drop the `rollbackOfObjectId` check (treat every accept as a release) | "a rollback is NOT a release" FAILS — the withdrawn version is recorded as the line's head | | drop the `environment === 'prod'` filter | "a non-prod release does not move the head" FAILS | | accept every wave-target status, not just `succeeded` | "a failed wave target is not a release" FAILS | | fall back to the digest when the image ref carries no tag | "records NOTHING for a digest-only ref" FAILS — `latest_version` reads `sha256:…` | | drop `lineAcceptsVersion` (record any determined version on any produced line) | "a release on a DIFFERENT major line" FAILS — the 2.x line's head reads 1.9.9 | | `insertDecision` instead of `insertDecisionIfChanged` | "a redelivered accept appends no second Decision" FAILS with 2 rows | | OMIT `latestDigest` when none was observed instead of writing an explicit null | "CLEARS a stale digest" FAILS. **This mutant SURVIVED the first version of this suite** — every other case builds a fresh line, which has no stale digest to leave behind, so the test was added for the mutant rather than the mutant found by the test | | drop the subscriber gate (record for every produced line) | "no subscriber ⇒ nothing is fetched" FAILS | | drop the VARIANT half of `lineAcceptsVersion` (the pre-M21.4 internal reading, which compared only the numeric core) | "does NOT take a PLAIN tag as the head of an `-alpine` VARIANT line" FAILS — the alpine line's head reads a glibc tag | | make `evaluateHeadMovement` never return `behind_head` | "a HOTFIX on an older minor does not walk the head backwards" FAILS — the head reads 1.9.10 | | drop the `distinctClaims.length > 1` refusal (take the first place's answer) | "REFUSES to pick when two prod places disagree" FAILS — a winner is picked by wave-target UUID order |

### §221. A line, its declared producer, and a subscriber

A dependency line, its DECLARED producer, and a subscriber — the three facts the derivation needs before it will record anything.

The subscriber is a SECOND component that declares the line, plus a policy enabling it at `objectRef` scope. It is not decoration: the derivation refuses to fetch or record for a line nobody subscribes to (ADR-0032 §6, "the ingestion work-list is derived from this resolution"), and `objectRef` rather than `group` because the authoring guard refuses a group-scoped `dependencySubscription` effect outright, in both directions (§6a). NOT, as this used to say, because the job runs as the system actor: group scope's owning half ignores the actor and would match here if this fixture minted an `owns` edge — which is precisely the unstated, mutable reach §6a-ii refuses to let a subscription rest on.

### §222. A component placed and released there by a change

A component placed at `target`, released there by a change that reached `succeeded`, and then put into `accepted`.

The plan is compiled directly rather than waited for from the reconcile loop — the same shortcut `component-pipeline.integration.test.ts` takes, and for the same reason: compilation is what writes the `change_wave_targets` rows this derivation reads, and the loop's own job (locking, transitions) is covered elsewhere. The topology names the PLACE, so the wave target IS the placement (`plan-service.ts:110`).

### §223. One change releasing a component to several places

ONE change releasing a component to SEVERAL prod places at once, each with its own observed images — the shape a component deployed to two regions actually has, and the one a single-target helper cannot express.

### §224. The mutation this exists for survived the first version

The mutation this exists for survived the first version of this suite: writing `latestDigest` only when one was observed leaves the PREVIOUS release's digest sitting beside the NEW version, so the line reads "1.4.0 is these bytes" about 1.3.0's bytes — a false statement in an audit record, and one no fresh-line test can see because there is nothing stale to leave behind. `recordDependencyLineHead` distinguishes an omitted key from an explicit null precisely so a caller can choose; this asserts which one this caller chooses.

### §225. A component in two regions, rolled by one change

A component placed in two prod regions, rolled by ONE change, whose executors report different images. The previous behaviour recorded both in turn and the last writer won — ordered by wave-target UUID, so the winner could equally be the OLDER release — while the run reported "0 not recorded" and the Decision asserted two contradictory versions for one line. A line has ONE head; two places disagreeing means the org has no single answer, and inventing one is the wrong-version failure the whole module is arranged to avoid.

### §226. A pool of exactly one connection is the experiment

A POOL OF EXACTLY ONE CONNECTION IS THE WHOLE EXPERIMENT.

The reader below needs a connection of its own. If the derivation were still holding a transaction open across the fetch — which is what it did, and is why a registry or a git provider taking 15s pinned an RLS-scoped pooled connection for the whole call against a 5s production `statement_timeout` — there would be none left, and `connectionTimeoutMillis` turns that into a fast, legible failure instead of a hang. With the reads moved out, the one connection is free and the read succeeds.

This is the production hazard in miniature rather than an analogy for it: a bounded pool plus a held connection is exactly the shape, and the third-party poll already does the opposite ("the network call happens OUTSIDE any transaction").

### §227. Every test above calls the function directly

EVERY TEST ABOVE CALLS `detectInternalReleases` DIRECTLY, AND NOTHING IN PRODUCTION DID.

That is the gap this block closes, and it is worth stating why the rest of the file could not catch it: a suite that drives a function directly proves the function, and says nothing about whether anything ever calls it. Measured filterlessly before this: the only references to `detectInternalReleases` in the tree were its own definition and this file, and `scp.change.transitioned` had ZERO server-side consumers — `DOMAIN_EVENTS_QUEUE`'s handler only logged. The whole internal ingress was dead code behind a green suite.

So this drives the REAL PATH, from the shape the outbox relay actually puts on the domain-event queue:

```text
domain-events job → acceptedChangeRouter → dependency-internal-release queue → the loop's
worker → detectInternalReleases → the manifest read through `host.gitFileRead` → the head.
```

It is also the only test that exercises M21.2's `readFileAtRef` through the plugin-host client M21.4 added: the reader is no longer a parameter a test supplies, it is resolved from the released repo's OWN git binding by `manifest-reader.ts`.

## `apps/server/src/dependencies/internal-release-detection.ts`

### §228. M21.4 — INTERNAL DETECTION

M21.4 — INTERNAL DETECTION: "an internal dependency was released to production" (ADR-0032 §7).

THERE IS NO EVENT FOR THIS. IT IS DERIVED. (measured at HEAD)
ADR-0032 §7 calls internal detection "derived, because no event carries it", and that is literal:

```text
- the ONLY change event is `scp.change.transitioned`, whose payload is `{fromState, toState,
  trigger}` over a subject that is the change object id (`coordination/transition.ts:361-368`).
  No component, no target, no environment, no version.
- per-place success is `change_wave_targets.status = 'succeeded'` — a plain UPDATE. No event,
  no audit row, nothing to subscribe to.
- "prod" is not a table. It is `deployment-target.properties.environment`, the same convention
  `coordination/regional-executors.ts:94,196-214` reads.
```

So this module reconstructs the fact from the coordination record, in the order §7 states:

```text
  accepted change
    -> its wave targets that SUCCEEDED
    -> each target's deployment-target
    -> environment === 'prod'
    -> the component placed there
    -> the dependency_lines that component is the DECLARED producer of
    -> the version that release published        (internal-release-version.ts)
    -> recordDependencyLineHead                  (M21.2)
```

A ROLLBACK IS NOT A RELEASE, AND EXCLUDING IT IS LOAD-BEARING
`validating -> accepted` is a HUMAN gate for a forward change, but a ROLLBACK change auto-accepts itself (`coordination/reconcile.ts:1893-1948`: "rollback changes need no human acceptance gate"). So `toState === 'accepted'` alone does NOT mean "this was released" — roughly the opposite for the auto-accepting half.

Treating a rollback as a release would publish, to every subscriber of that line, the version the org has just decided to WITHDRAW. That is not a missed detection, it is an active fan-out of a known-bad release, which is why the exclusion is a first-class branch with its own Decision rather than a predicate tucked into a WHERE clause. `changes.rollback_of_object_id` is the structural test — DESIGN §9.4's "a rollback is its own Change, linked to the original" — never the free-text `rollback_trigger_reason`, which is an English sentence a refactor can change.

DOMAIN-LOCAL CHANGES ARE OUT OF SCOPE. STATED, NOT WORKED AROUND.
A domain-local change does not journal (`transition.ts:337-360`, ADR-0031): its `change_status` entry is deliberately withheld, because "the commander doesn't need to know when these deploy out" is exactly what domain-locality means. Until 2026-08-17 this module ran on every federation role, so the head it recorded for such a release was a fact in THAT domain's `dependency_lines` that travelled nowhere — "domain-visible only", the consequence ADR-0032 §7 records.

SINCE ADR-0032 §7d (owner decision, 2026-08-17) THIS MODULE RUNS ON THE COMMANDER ONLY, so the statement is now stronger: a domain-local release at a FIELD outpost reaches no detection at all, and its head is recorded NOWHERE. That is the same class as §7d clause 1's field-outpost-only repositories and is accepted on the same terms — a field outpost never ORIGINATES a bump, it receives the resulting change down the global pipeline the commander manages. Nothing here tries to route around it: a feature that federated what locality withheld would defeat the locality decision, not extend it.

"FIELD" IS THE QUALIFIER THAT MAKES THIS TRUE (ADR-0032 §7d's vocabulary note). A domain-local change in the COMMANDER'S OWN trust domain — the HQ outpost, which is not a second deployment but this process (`dependencies/commander-only.ts` reads that out of the code) — never journals either, but it does not need to: this module runs here, over those rows, so its head IS recorded. The loss is confined to domains the commander is not.

WHAT KEEPS THIS FROM WRITING 1.44 GB/DAY
Two independent things, because the amplification ADR-0024 measured came from a writer that had neither:

1. EVERY VERDICT GOES THROUGH `insertDecisionIfChanged`. This path is event-driven, but the outbox -> pg-boss delivery is AT-LEAST-ONCE, so a redelivered accept must not append a second byte-identical Decision. `inputContext`/`reasonTree` are therefore built from stable facts only — never a timestamp, never a wall clock — and are sorted, so a redelivery collapses. 2. ONE DECISION PER DETECTION RUN, not one per line, and NONE AT ALL when the released component declares no produced line. Most accepted changes in an org produce nothing; a Decision per accept saying "this released no declared line" would be a row per change forever, learnable from exactly once. A per-line Decision would be worse still under redelivery: each write would differ from the previous line's, so `insertDecisionIfChanged` would suppress nothing.

THE SUBSCRIBER GATE COMES FROM M21.3'S RESOLUTION, NOT FROM A SECOND FILTER
ADR-0032 §6: "the ingestion work-list is derived from this resolution", so a disabled component is never fetched and an opted-out line is never polled. Determining a LANGUAGE version means fetching the producer's manifest out of a user repo, which is exactly the fetch that rule governs — so a produced line that no enabled component subscribes to is skipped BEFORE any read happens, and the subscriber set is read from `listSubscribedComponentLines` (M21.3), narrowed by `listComponentsDeclaringLine` (M21.2's reverse lookup). The AND is not re-expressed here; this module cannot disagree with a UI verdict because it does not compute one.

THAT IS ALSO WHY THE GROUP-SCOPE GUARD CHANGED — though NOT for the reason this comment used to give. It said a group-scoped ENABLE is INERT here because this job resolves as `SYSTEM_ACTOR_ID`, a sentinel with NO `objects` row (`coordination/system-actor.ts:9`) and therefore a member of no group. The membership fact is still true; the conclusion is FALSE (ADR-0032 §6a-ii). `matchPoliciesForTargets` also matches a group-scoped policy through its OWNING half, which never reads the actor (`governance/policy-resolve.ts:313`, `:150-173`), so such a policy DOES contribute here wherever the group owns something on the component's chain. What the guard actually refuses is a reach nobody declared: membership plus mutable `owns` edges, in place of what the author wrote. See `subscription-authoring-guard.ts` and ADR-0032 §6a-ii.

### §229. One produced line, with every place it was released

ONE produced line, with EVERY prod place this change released it at.

The grouping is load-bearing rather than tidy. A line has ONE head, so the question "what version did this change put on line L?" must be answered once, over all the evidence, and not once per place — which is what a flat (line, place) list produced: two places running different images each wrote the head in turn and the last writer won, ordered by wave-target UUID. Each place keeps the images observed AT THAT PLACE rather than a union, so a disagreement can be reported with the places that disagreed rather than as one incoherent set.

### §230. Run the derivation for ONE accepted change

Run the derivation for ONE accepted change.

THREE PHASES, AND THE MIDDLE ONE HOLDS NO DATABASE CONNECTION
This takes a `Db` and opens its own transactions rather than borrowing a caller's `tx`, and the reason is not symmetry with the poll — it is that phase 2 REACHES A USER'S GIT PROVIDER. Three of the five ecosystems resolve their released version by reading the producer's own manifest at the released commit (ADR-0032 §7a), which is a network round trip through the plugin host with a host-enforced timeout measured in seconds. Doing that inside the caller's transaction pinned an RLS-scoped pooled connection open for the whole fetch, against a production `statement_timeout` of 5s and a bounded pool — one slow provider would hold a connection per accepted change. The third-party poll deliberately does the opposite ("the network call happens OUTSIDE any transaction"), and there is no reason for the two ingresses to differ.

```text
phase 1 (tx)  — read the change, derive the prod releases and produced lines, apply the
                rollback and subscriber gates, read the producers' manifest paths.
phase 2 (NO tx) — ask, per line and per place, what version this release published.
phase 3 (tx)  — move the heads through the write door and persist ONE Decision.
```

Phase 1 and phase 3 are separate transactions, so this is not atomic across the fetch — and it does not need to be. Both writes are idempotent restatements of an observation: the head goes through `recordDependencyLineHead`, which re-reads `FOR UPDATE` and decides for itself, and the Decision goes through `insertDecisionIfChanged`. A crash between the phases re-derives the same answer on redelivery and appends nothing.

Idempotent by construction, therefore: a redelivered `scp.change.transitioned` writes no new row.

### §231. PHASE 2 — NO TRANSACTION IS OPEN HERE

PHASE 2 — NO TRANSACTION IS OPEN HERE. Three of the five ecosystems fetch a manifest out of a user repo through the plugin host; a registry/provider that takes 15s must not be doing so behind a held, RLS-scoped pooled connection.

### §232. THE WRITE DOOR DECIDES whether this becomes the head

THE WRITE DOOR DECIDES whether this becomes the head: it applies line membership (major AND image variant), the never-regress rule, and the version/digest pairing — the same rules, in the same function, that the third-party poll is subject to. This module deliberately holds no second copy of any of them, which is why a `1.9.9` hotfix landing after `1.10.0` is refused here rather than silently walking the head backwards.

AND IT DECIDES WHETHER THIS INGRESS STILL OWNS THE LINE. Phase 1 read the declaration; the manifest fetch in phase 2 happens with NO transaction open, so a `POST /dependencies/producers/retract` can land in between and this phase-3 write would otherwise put the org's own version onto a coordinate that is third-party again — the direction `resetLineHead`'s header calls a security fix rather than a wedge fix, because `latest_version` is an M22 vendor-rule input. The `internal` ingress is what lets the door refuse it (`line_is_third_party`), and the refusal is reported as a skip like every other.

AND IT NAMES THE PRODUCER THIS RELEASE WAS DERIVED FROM. `producerComponentObjectId` is phase 1's own answer — the component `listProducedLines` matched this line's declaration to — carried down here rather than recomputed. Without it the door could only ask "is this coordinate internal?", which a TRANSFER (`POST /dependencies/producers` over an existing declaration) leaves true while making this component the WRONG writer: its version would become the head, fan bump PRs into every subscriber's repo, and wedge the new producer's genuine release behind `behind_head` with no way back.

### §233. `changes.source_ref`'s canonical keys, defensively

`changes.source_ref`'s canonical keys, defensively. The column is `jsonb` holding the raw delivery payload PLUS the keys `webhook-processor.ts`'s `canonicalizeSourceRef` lifted out of it (`db/schema.ts:423-437`), so every field is optional in practice and a hand-created or imported change may carry none of them. Only the three this derivation reads are lifted, and a non-string is dropped rather than coerced.

### §234. The succeeded wave targets, resolved to their pairs

The change's SUCCEEDED wave targets, resolved to the (component, prod deployment-target) pairs they represent.

SUCCEEDED, not merely planned. `change_wave_targets.status = 'succeeded'` is the only per-place record that a place actually took the release — there is no event and no audit row for it — so a failed, aborted or `no_executor` target must not contribute a release. (`no_executor` in particular is ADR-0006's fail-closed terminal: the target had bindings but none for this Type, so reconcile refused to fake-succeed the gap. Counting it would resurrect exactly the masking failure that terminal state exists to prevent.)

A WAVE TARGET IS NOT ALWAYS A PLACEMENT, and the non-placement case yields NOTHING rather than a guess. Under stage-shaped compilation `target_object_id` IS a `placement` object (`coordination/plan-service.ts:110`, `component-pipeline.ts:189-190`) and carries both halves of the pair in its properties. Under LEGACY compilation the same column holds the change's own target — a component or service — and there is no deployment-target on it at all, so its environment is unknowable and it cannot be shown to be prod. Inferring one (from a name, from the component's single placement, from a binding) would be the provenance-label mistake again: a label named after what happened to match.

### §235. `change_wave_targets.observed_state`'s `images` array

`change_wave_targets.observed_state`'s `images` array (ADR-0008 / P4C), read defensively: the column is raw `jsonb`, is null until the first successful observe, and a status() that carried no images leaves it absent. Non-string entries are dropped rather than stringified.

A TRUNCATION MARKER IS DELIBERATELY KEPT, NOT FILTERED OUT. `observed_state` is bounded at the store, and an over-long list comes back with its tail replaced by a recognisable entry (`isPersistedJsonEntriesElision`, `@scp/runner-launcher`). It is not an image ref and never matches a coordinate — but it is the ONLY evidence that this list is incomplete, `resolveReleased Version` reads it to tell a miss from a cut, and it is what lands in the Decision's `inputContext`. Stripping it here would look like tidying and would delete the record.

EXPORTED for `observed-state-gate-critical-leaf.integration.test.ts`: the defect the marker exists for is only visible end to end — a real bounded row, read by THIS function, judged by `resolveReleasedVersion` — and a test that re-implemented this read would be pinning its own copy.

### §236. The lines each released component is the producer of

The lines each released component is the DECLARED producer of — TWO indexed reads since drizzle/0068, because the declaration moved off the line row and onto the COORDINATE.

Hop 1 is `dependency_line_producers_org_producer` ("which coordinates does component X produce?"), replacing the partial index the old column carried. Hop 2 narrows `dependency_lines` by `(org_id, ecosystem, coordinate)` — a PREFIX of the existing `dependency_lines_identity` — so no index was added to make this work.

THE REGRAIN IS WHY THIS IS RIGHT NOW AND WAS NOT BEFORE. Under the per-line column, a component that had declared `@acme/lib` and then cut a `3.0.0` derived NO head for the freshly minted `3` line: that row's producer was NULL because nobody had re-declared it, and the version poll cheerfully fetched the org's own coordinate from a public index. Keyed by coordinate, every major is here from the instant a consumer's manifest mints it.

DECLARED, NEVER INFERRED (ADR-0032 §7, ADR-0030 §2). Nothing here looks at the component's name, its repo, or the registry a coordinate points at. `dependency_line_producers` is written only by the two verbs in `routes/dependency-producers.ts`, and `inventory-ingestion.ts` does not import the table at all — that absence is the enforcement, not this comment.

SINGLE HOP THROUGH THE GRAPH, AND ONLY THE COMPONENT. This derivation asks only about the component the placement names; it does not walk up to that component's service or down to a service's components. A SERVICE-VALUED declaration would therefore derive no head at all, which is exactly why the declare verb REFUSES a service in the first cut (ADR-0032 §7e) instead of accepting one that silently does only the harmful half — removing the coordinate from the third-party poll — and none of the useful half. ADR-0032 §3's "nothing in the dependency path may expose a transitive traversal" is what justifies the projection-table representation at all; a containment walk here would spend it.

### §237. The column is plain `text` with no CHECK

The column is plain `text` with no CHECK (0061's header: packages/schemas is the only enforcement point), so a row written before an ecosystem left the enum must still be resolvable. Cast rather than re-validate — the same reading `subscription-resolution.ts:640` makes — and note that an unrecognised value falls into `resolveReleasedVersion`'s explicit refusal arm, never into a version.

### §238. Is ANY enabled component subscribed to this line?

Is ANY enabled component subscribed to this line?

Derived from M21.3, in two shipped single-hop lookups and no new predicate: the components that DECLARE the line (`listComponentsDeclaringLine`, M21.2's reverse lookup — the subscribers of L are the components that declare L, never the components that transitively reach it), narrowed into `listSubscribedComponentLines`, which applies `mergeDependencySubscription` itself. The AND is not restated here, so this gate cannot disagree with what a UI or a Decision reports.

THE ACTOR IS THE SYSTEM SENTINEL, and the consequence worth naming at the call site is NOT the one that used to be written here ("it is a member of no group, so a `group`-scoped effect NEVER contributes for this job"). That is false — group scope's owning half ignores the actor, so such an effect contributes wherever the group owns something on the chain (ADR-0032 §6a-ii). The real consequence: whether it contributes is decided by ownership data this job never looks at and the author never wrote, which is why the authoring guard refuses group scope in both directions.

## `apps/server/src/dependencies/internal-release-loop.test.ts`

### §239. The fan-out point that turns the event into detection

M21.4 BLOCKER A — the fan-out point that turns `scp.change.transitioned` into internal detection.

The predicate and the routing are pinned separately from the detection itself because they are the half that decides whether detection ever RUNS. Before this, `detectInternalReleases` had no production caller at all and `scp.change.transitioned` had no server-side consumer.

### §240. THE ROLE REASONING, AFTER THE 2026-08-17 REVERSAL

THE ROLE REASONING, AFTER THE 2026-08-17 REVERSAL (ADR-0032 §7d).

This block used to assert "runs on EVERY federation role, including an outpost and a retrans node", and it was green, because the guard really did allow them. The owner's decision changed the question, not the mechanics: dependency automation exists to pull from PUBLIC repositories, which a FIELD outpost has no need to do, because the resulting change is pushed down the global pipeline the commander manages. A field outpost RECEIVES a dependency bump through the ordinary promotion path and never originates one — so it detects no internal releases either. ("Field" is the qualifier that makes the sentence true: an HQ outpost is the outpost in the COMMANDER'S OWN trust domain and is this process, so its releases ARE detected here. Every deployment this guard refuses has DECLARED `SCP_FEDERATION_ROLE=outpost` — `commander-only.ts` reads that out of the code.)

The measurement the old block rested on survives and is now a STATED COST rather than a counter-argument (ADR-0032 §7d clause 2): the wave-target evidence really does exist only where the change executed, so an internal line released to prod only at a FIELD outpost keeps a NULL head — an honest "not observed", never a wrong version. A component that releases to prod in the HQ domain is unaffected: that evidence is written locally, and the derivation runs here.

Shape matched to `bump-dispatch.test.ts`'s role-guard block, because these are now one guard.

### §241. The wiring: a predicate nothing consults is the defect

THE WIRING. A correct predicate nothing consults is this codebase's most-shipped defect, so the binding between THIS router and THIS guard is asserted, which the generic registry census in `domain-event-routers.test.ts` structurally cannot do.

### §242. THE WORKER HALF ACTUALLY CONSULTS THE GUARD

THE WORKER HALF ACTUALLY CONSULTS THE GUARD — MEASURED, NOT ASSUMED.

Deleting `startInternalReleaseLoop`'s `if (!guard.allowed) return` left the whole suite green: every integration test boots the loop as a declared commander, so the refusal branch is never taken, and the router census above covers only the ROUTER half. The guard was computed, logged, and structurally ignorable — present but not consulted.

A REFUSED ROLE MUST NEVER CREATE THE QUEUE, not merely skip work inside the handler: a process that created it would hold a pg-boss worker for a queue it will never act on, and would drain events the router (equally refused there) should never have enqueued. Same shape as `version-poll.test.ts`'s "a refused role returns an inert handle and NEVER CREATES THE QUEUE".

## `apps/server/src/dependencies/internal-release-loop.ts`

### §243. The production caller for internal release detection

M21.4 — THE PRODUCTION CALLER FOR INTERNAL RELEASE DETECTION (ADR-0032 §7).

WITHOUT THIS FILE, HALF THE FEATURE NEVER RAN
`detectInternalReleases` is the whole internal ingress: it is what puts a head on a line the org PRODUCES, and it is what the third-party poll is forbidden to touch (§7b clause 1). It was built with no caller. Measured filterlessly at the time: the only references to it in the tree were its own definition and its own test, and `scp.change.transitioned` — the event it derives from — had ZERO server-side consumers, because `DOMAIN_EVENTS_QUEUE`'s handler only logged. A subscriber to an internal line would have waited forever, with `latest_version` null and no error anywhere.

THE SHAPE: ROUTE ON THE SHARED STREAM, WORK ON THIS CAPABILITY'S OWN QUEUE
`boss.work()` is a competing consumer, so this cannot be a second worker on the domain-event queue (see `events/pgboss.ts`'s `DomainEventRouter`). Instead:

```text
outbox → domain-events → `acceptedChangeRouter` (one cheap predicate + one enqueue)
       → `INTERNAL_RELEASE_QUEUE` → this file's worker → detectInternalReleases
```

which is exactly the one-queue-per-capability pattern reconcile/observe/watchdog/inbox/auto-relay and the dependency version poll already use in `main.ts` — the difference being that those are self-rescheduling TIMERS and this one is EVENT-DRIVEN, because a release is an event and a daily sweep over every accepted change would be both slower and heavier.

IDEMPOTENT UNDER REDELIVERY, AT EVERY HOP
The outbox→pg-boss path is AT-LEAST-ONCE, and there are now two hops that can each redeliver. It does not matter, because nothing on this path appends:

- the head write goes through `recordDependencyLineHead`, which re-reads `FOR UPDATE` and DECIDES — a restatement of the same version is a no-op write of the same values; - the verdict goes through `insertDecisionIfChanged`, whose inputs are stable facts only (no timestamps, everything sorted), so a second derivation of the same accept compares equal and writes NO new row; - the state is re-READ rather than trusted from the event, so a change that has since moved on yields `not_applicable` instead of a stale derivation.

A permanent test drives the same change twice and asserts the second run creates nothing.

THE ROLE REASONING — COMMANDER-ONLY (ADR-0032 §7d, owner decision 2026-08-17)
The version poll is guarded on TWO axes (`dependencyVersionPollRoleGuard`): the PROCESS split (`SCP_ROLE`) and the DEPLOYMENT's declared federation role (`SCP_FEDERATION_ROLE` — commander only, and explicitly declared). BOTH apply here too.

This paragraph previously argued the opposite — at length, citing ADR-0032 §3 clause 3, and concluding that "restricting to a commander would break the feature". That argument is WRONG. It is restated and answered here rather than deleted, because it is persuasive and the next reader of this file is exactly the person who could remove the guard on the strength of it; ADR-0032 §7d preserves the original clause verbatim beside the reasoning that overturned it.

- THE PROCESS AXIS APPLIES UNCHANGED. This is background work; an `api` process must stay a request server. Same rule, same reason, and `main.ts` additionally only reaches this inside its `runsBackgroundWork` branch — the guard is what makes that a property of the job rather than of where someone happened to call it.

- THE FEDERATION AXIS APPLIES TOO: commander only, fail-closed on an undeclared role. THE OWNER'S REASON is not about egress at all. The point of dependency automation is to PULL FROM PUBLIC REPOSITORIES — Python library versions, CDK versions, base-image versions — which is not needed from a FIELD outpost's standpoint, because the resulting change GETS PUSHED DOWN THE GLOBAL PIPELINE THE COMMANDER MANAGES. A field outpost never ORIGINATES a dependency bump; it RECEIVES the resulting change through the ordinary promotion path. So a field outpost derives no inventory and detects no releases for this feature, and what it used to derive fed nothing: the only consumer is a bump, and `bumpDispatchRoleGuard` has been commander-only since M21.5.

```text
 "FIELD" IS LOAD-BEARING HERE, NOT DECORATION (GLOSSARY `HQ outpost` / `field outpost`, ADR-0021
 D7; ADR-0032 §7d's vocabulary note). An HQ outpost — the outpost in the commander's own trust
 domain — is not a deployment this guard could refuse: `SCP_FEDERATION_ROLE` is one value per
 process (`config.ts`), and this guard reads THAT, never an `outpost` graph object — an
 `outpost` object CAN name the commander's own domain (the commander-declared HQ outpost record,
 pipeline-substrate-registry-scan.md §10.5, `federation/outpost-binding.ts`), but that record
 describes which outpost, not what this deployment is. A release into the HQ domain is therefore
 detected by THIS loop, in this process, and needs no exemption from the rule above.
```

```text
 THE OLD ARGUMENT'S MEASUREMENT SURVIVES AND BECOMES THE STATED COST. It is true that a FIELD
 outpost is where the evidence LIVES: `change_wave_targets.status`/`observed_state.images` are
 written where the change executed, while a commander receives only `change_status` journal
 entries (`{objectId, fromState, toState, trigger}` — no wave targets, no images). So an
 internal line whose component releases to prod only at a FIELD outpost keeps a NULL
 `latest_version`. ADR-0032 §7's schema note already defines NULL as "not observed" and
 explicitly NOT "nothing newer exists", so a subscriber sees an honest absence rather than a
 wrong version — which is the ordering §7a rule 1 fixes. This is a real reduction in reach and
 is recorded as ADR-0032 §7d clause 2, not papered over. It does NOT apply to a component that
 releases to prod in the HQ domain: that evidence is written locally and the derivation runs.
```

```text
 THE OTHER ACCEPTED CONSEQUENCE: dependencies declared in DOMAIN-SPECIFIC repositories —
 FIELD-outpost-only IaC/CaC the commander never sees — are OUT OF SCOPE for dependency
 subscriptions. The owner accepted that explicitly; there is no workaround, and the shape that
 would be one is a field-outpost-side job. A repository specific to the HQ domain is in scope
 like any other the commander can see.
```

Scope of the reversal: the SUBSCRIPTION still federates (a `dependencySubscription` effect on an ordinary `policy` object, ADR-0032 §3a) and still reaches a field outpost. Only the JOBS and the projection tables they write are commander-only.

### §244. MAY THIS PROCESS DERIVE INTERNAL RELEASES?

MAY THIS PROCESS DERIVE INTERNAL RELEASES? See the module doc for why this asks the poll's two questions and now keeps BOTH of them, and `commander-only.ts` for why the predicate is SHARED rather than re-spelled here — the fail-closed undeclared branch has five callers and is the one that regresses invisibly.

### §245. The fan-out point on the shared domain-event stream

The fan-out point on the shared domain-event stream: one predicate, one enqueue, no work.

The subject of `scp.change.transitioned` IS the change object id (`coordination/transition.ts`), which is the only identifier this capability needs — it re-derives everything else from the row.

### §246. Register the capability's worker

Register the capability's worker. The ROUTER half is registered separately, by `events/domain-event-registry.ts` under this module's own guard, so the two halves are wired without either knowing about the other's internals.

A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the same shape the version poll, the inbox loop and the auto-relay loop use, and for the same reason: a process that merely skipped the work inside the handler would still hold a pg-boss worker for a queue it will never act on.

## `apps/server/src/dependencies/internal-release-version.test.ts`

### §247. M21.4 — THE VERSION STRATEGY, without a database

M21.4 — THE VERSION STRATEGY, without a database (BUILD_AND_TEST.md §4.1).

`resolveReleasedVersion` is where the whole feature's honesty lives: it either points at a signal or says why it cannot, and the failure mode that matters is the QUIET one — a plausible-looking version derived from something that is not a version. So the assertions below are almost all of the shape "records NOTHING, and here is the reason", each paired with the positive control that makes the refusal about the input rather than about a function that always refuses.

MUTATION LOG — applied, watched fail, reverted, watched pass: | Mutation | Result |
| fall back to the digest when the observed ref carries no tag | "records NOTHING for a digest-only ref" FAILS | | read the manifest at `source_ref.ref` instead of `.commit` | "reads package.json AT THE RELEASED COMMIT" and "records NOTHING when the change carries no released commit" both FAIL | THE LINE GUARD MOVED OUT OF THIS FILE. `lineAcceptsVersion` now lives in `line-head.ts` — it was a SECOND implementation of a question the third-party poll also answers, and the two disagreed about what `tag_pattern` means. Its tests moved with it, to `line-head.test.ts`. (The per-ecosystem refusals are additionally mutation-proven end to end in `internal-release-detection.integration.test.ts` — see its own log.)

### §248. `dependency_lines.ecosystem` is plain `text` with no CHECK

`dependency_lines.ecosystem` is plain `text` with no CHECK (0061), so a row can outlive the enum and a sixth ecosystem lands here first. The REFUSAL was always right; the LABEL was not. It reported `manifest_reader_unavailable`, whose stated remedy is "wire a readFileAtRef reader" — which would fix nothing here. That is the provenance-label failure this repo has shipped once already: a reason named after the branch that matched, false as soon as the branch covers a second case (charter principle 6, ADR-0030 §2).

### §249. MEDIUM (M23.0 verification pass 8)

MEDIUM (M23.0 verification pass 8) — A MISS AFTER A CUT IS NOT A MISS.

`observed_state` is bounded at the store, and an Argo CD Application's `status.summary.images` is the uncapped image list across every managed resource — an umbrella app overflows the whole-value budget on its own, at a measured 73 refs. The bound truncates the array's tail and leaves a recognisable marker; this function then found no match and reported `no_matching_image_ref`, which is a claim about the EXECUTOR ("it deployed these and none was yours") for something the platform did. Fail-silent: the internal release's `latest_version` is never determined and no dependant is ever bumped, with a reason that sends the reader to the pipeline instead of to the bound.

The end-to-end arm — a REAL bounded row, read by the real `observedImagesOf` — is `coordination/observed-state-gate-critical-leaf.integration.test.ts`. These pin the branch.

## `apps/server/src/dependencies/internal-release-version.ts`

### §250. M21.4 — WHICH VERSION DID THIS RELEASE PUBLISH?

M21.4 — WHICH VERSION DID THIS RELEASE PUBLISH? (ADR-0032 §7)

THE QUESTION THE ADR DOES NOT ANSWER, AND WHY IT NEEDS ONE FUNCTION WITH FIVE STRATEGIES
ADR-0032 §7 defines internal detection as a DERIVATION — an accepted change, its wave targets, a `prod` deployment-target, the component placed there, the lines that component is declared to produce. It says nothing about what VERSION that release put on those lines, and the derivation does not carry one:

```text
- `scp.change.transitioned` publishes `{fromState, toState, trigger}` and a subject that is the
  change object id (`coordination/transition.ts:361-368`). No component, no target, no version.
- `changes.source_ref` carries `{repo, ref, commit, run_url, artifact_digest, sbom}`
  (`db/schema.ts:423-437`). A commit and a digest are IDENTITIES; neither is a version.
- `change_wave_targets.observed.images` carries the deployed image refs — `ghcr.io/x/y:1.2.3`
  or `...@sha256:...` (`packages/schemas/src/changes.ts:264-272`, ADR-0008 decision 1/2). That
  IS a version signal, and it is the only one in the coordination record.
```

So the answer is per-ecosystem, and this module is ONE function with an explicit strategy per ecosystem rather than five scattered lookups, so that "which signal did we use, and why is that signal trustworthy" is answerable by reading `resolveReleasedVersion` instead of inferred from whichever branch happened to run. Each strategy names its signal in the result (`ReleasedVersion.signal`), and that label is READ FROM THE STRATEGY THAT RAN — never derived from the shape of the answer, which is the provenance-label failure this repo has already shipped once (a Decision whose label named the branch that matched, and went false the moment the branch covered a second kind).

NEVER GUESS A VERSION. NOT ONCE, NOT AS A FALLBACK (ADR-0032 §7)
Every path here ends in either a version this code can point at a source for, or `{determined: false}` with a reason. There is no default, no "best effort", and in particular:

```text
- a DIGEST IS NOT A VERSION. `ghcr.io/x/y@sha256:ab…` identifies bytes and answers "which
  bytes", never "which release". Recording a digest in `latest_version` would make
  `dependency_lines` read as though the line had a head when nobody knows what it is.
- a COMMIT SHA IS NOT A VERSION, for the same reason and with the extra hazard that a sha is
  often numerically PARSEABLE (`1a2b3c4d` parses as major 1 — see `version.ts`'s note), so a
  careless parse produces a confident wrong answer rather than an error.
- a BRANCH NAME IS NOT A VERSION. `refs/heads/main` is where the release came from, not what it
  was called.
```

The cost of refusing is a missed bump, which is visible: `latest_version` stays null, which ADR-0032's schema already defines as "not yet observed" and explicitly NOT as "no newer version exists". The cost of guessing is a component that LOOKS up to date at a version that was never published — invisible, and it silences the whole feature for that line. That asymmetry is why every refusal below is a named reason rather than a fallback.

THE LINE GUARD IS PART OF THE ANSWER, NOT A SEPARATE NICETY
A dependency line is `(ecosystem, coordinate, MAJOR)` — one component legitimately produces several lines at once (a `1.x` maintenance line and a `2.x` line). A released `1.9.9` recorded against the `2` line is not merely a wrong version, it is a version on the wrong line, and it would make every `2.x` subscriber look ahead of a head that is behind them. So `lineAcceptsVersion` refuses the pair unless the line's own major is a PREFIX of the released version's numeric core AT THE LINE'S OWN PRECISION — `3.18` accepts `3.18.4` and refuses `3.19.0`, `v2` accepts `v2.1.0` and refuses `1.9.9`. A major line the version grammar cannot compare is refused too, never assumed to match.

### §251. Reading ONE file out of a user repo at a ref

Reading ONE file out of a user repo at a ref — the ingress M21.2 built as the `readFileAtRef` `GitProviderAdapter` hook (`packages/plugins/git-provider-core/src/read-file.ts`), taken here as an injected port rather than reached for directly.

WHY A PORT, STATED RATHER THAN DISCOVERED: `readFileAtRef` is an ADAPTER hook and is deliberately NOT surfaced on `ExecutorPlugin` (ADR-0032 §9 — the four verbs ARE the structural enforcement of charter principle 1). Measured at HEAD: nothing under `apps/server/src` calls it, and the subprocess plugin host exposes no RPC for it either — NOT ONE of `plugin-host/contract.ts`'s per-kind client shapes carries a file-read method (stated as a property of the whole set rather than as a count of it, because a count goes stale the next time a plugin kind is added). So the server-side route from "a component's git binding" to "this hook, in its subprocess, under the egress guard" DOES NOT EXIST YET; building it means changing `rpc-protocol.ts`, `subprocess-entry.ts`, `contract.ts` and `host.ts`, which is a plugin-host change, not a dependency-detection one.

Taking it as a port keeps that gap HONEST instead of hidden: with no reader wired, every language ecosystem resolves to `manifest_reader_unavailable` and records NOTHING, which is exactly the behaviour this module promises for anything it cannot determine — rather than a silent never-detects-anything that reads like "no releases happened".

### §252. Splits an image reference in each of its three forms

Split `ghcr.io/acme/api:1.2.3`, `ghcr.io/acme/api@sha256:ab…` and `ghcr.io/acme/api:1.2.3@sha256:ab…` into repository / tag / digest.

The digest is split off FIRST, then the tag — and the tag search starts after the last `/`, because a registry host may carry a PORT (`registry.internal:5000/acme/api:1.2.3`) and a naive "split on the last colon" reads `5000/acme/api` as the tag on a ref with no tag at all. That is a silently wrong parse, which is the class of bug this whole module exists to refuse.

### §253. WHICH LINE A RELEASE LANDS ON IS NOT DECIDED IN THIS FILE

WHICH LINE A RELEASE LANDS ON IS NOT DECIDED IN THIS FILE — it is `line-head.ts`'s `lineAcceptsVersion`, the SAME function the third-party poll's ranking uses, re-exported here so this module's callers keep one import.

It used to be a second implementation living here, and the two disagreed in a way no type could catch: this one compared only the numeric core, so an `oci` line declared as the `-alpine` VARIANT took a plain glibc tag as its head, while the poll — reading the same `tag_pattern` as the literal variant suffix — would never have offered one. `tag_pattern` had two meanings; it now has one, in one place, and this file has no reading of its own left to drift.

```text
  line `1`                  accepts 1.2.3, 1.0.0      refuses 2.0.0
  line `v2`                 accepts v2.1.0, 2.1.0     refuses 1.9.9
  line `3.18`               accepts 3.18.4            refuses 3.19.0
  line `3.18` + `-alpine`   accepts 3.18.4-alpine     refuses 3.18.4 and 3.18.4-slim
```

### §254. THE one entry point

THE one entry point. Given a line and everything the coordination record knows about the release that just happened, return the version it published — or the reason there is none.

The switch below IS the per-ecosystem strategy table, and each arm states its own signal:

```text
`oci`                  the deployed image ref (`observed.images`). Records the TAG as the
                       version and the DIGEST alongside it, because a mutable tag is not an
                       identity (ADR-0032 §7).
`go`                   the git TAG in `source_ref.ref`. `go.mod` declares a module PATH and no
                       version — a Go module's version IS its tag — so a non-tag ref yields
                       nothing rather than a guess.
`npm`/`python`/`maven` the producing component's OWN manifest, read at the released COMMIT.
                       This is the same "formulated via the users' code" ingress the inventory
                       itself is built from (M21.2's `readFileAtRef`), so it inherits its
                       decode bound, its URL-safety asserts and its egress guard.
```

### §255. The version signal already in the coordination record

`oci` — the version signal that already exists in the coordination record.

`observed.images` is what the executor reported it actually deployed (ADR-0008 decision 1/2), so for an internal release it is a first-hand statement about bytes that reached prod, not a registry ranking. Matching is by REPOSITORY, compared VERBATIM against the line's coordinate — the same rule the whole inventory keys on (`DependencyCoordinateSchema`: `@acme/lib`, `acme/lib` and `acme-lib` collapse under slugification and must not be merged here either).

A digest-only ref determines NOTHING. It is the single most tempting place in this file to fall back — the digest is right there, it is unambiguous, and it would make the line look observed — and it is exactly the fallback ADR-0032 §7 forbids: `latest_version` is a version, and a digest answers a different question.

### §256. A MATCH IN A TRUNCATED LIST STILL DETERMINES, and says so

A MATCH IN A TRUNCATED LIST STILL DETERMINES, and says so. Refusing would silence the feature for exactly the large applications the truncation happens to; but the checks above — "observed at more than one tag", "at more than one digest" — could only see the refs that were recorded, so the `why` states the limit of what was compared rather than implying a whole-list agreement nobody verified.

### §257. `go` — the git tag, and only a git tag

`go` — the git tag, and only a git tag.

There is no version in `go.mod` to read: it declares the module PATH, and the Go toolchain resolves a version from the repository's tags. So `source_ref.ref` is the whole signal, and it determines a version only when it IS a tag. `refs/heads/main` is where the release came from, not what it was called — and a bare commit sha parses as a version (`1a2b3c4d` → major 1; see `version.ts`), so accepting anything but an explicit `refs/tags/` ref would produce confident nonsense rather than an error.

### §258. `npm` / `python` / `maven`

`npm` / `python` / `maven` — the producing component's own manifest at the released commit.

WHERE the manifest is comes from the component's OWN INVENTORY (`component_dependencies`'s `manifest_path`, written by M21.2 ingestion), never from a convention: a monorepo component's `package.json` is at `services/api/package.json` and guessing the repo root would read a different package's version and be confidently wrong. A component whose inventory records no manifest of the right kind yields `no_manifest_path_known` — a legible "we have never seen this component's manifest", which is true.

WHICH COMMIT is `source_ref.commit`, not a branch: `readFileAtRef` returns the commit a ref RESOLVED to precisely because a branch name is not an identity, and reading at a branch would report whatever HEAD says now rather than what was released.

TWO CANDIDATES THAT DISAGREE REFUSE. A component with a root and a workspace `package.json` in its inventory has two plausible identities; picking the first would make the answer depend on sort order.

## `apps/server/src/dependencies/inventory-ingestion-loop.test.ts`

### §259. The fan-out point and the role guard for ingestion

M21.2 — THE FAN-OUT POINT AND THE ROLE GUARD for dependency-inventory ingestion.

Pinned separately from the ingestion itself because this is the half that decides whether it ever RUNS — the exact half that was missing for the four M21 components that shipped inert.

### §260. THE GUARD, AFTER THE 2026-08-17 REVERSAL

THE GUARD, AFTER THE 2026-08-17 REVERSAL (ADR-0032 §7d).

This block used to assert the OPPOSITE — "RUNS ON EVERY FEDERATION ROLE" and "is not fail-closed on an UNDECLARED deployment" — and it passed, because the guard really did allow both. Nothing about ingestion's own mechanics changed; the owner's decision changed which question the guard answers. A FIELD outpost never ORIGINATES a dependency bump — it RECEIVES the resulting change down the global pipeline the commander manages — so a field outpost derives no inventory at all. ("Field" is the qualifier that makes that true: an HQ outpost is the outpost in the COMMANDER'S OWN trust domain, so its inventory IS the commander's. Every deployment this guard refuses has DECLARED `SCP_FEDERATION_ROLE=outpost` and is therefore a field outpost — `commander-only.ts` reads that out of the code.)

Kept in the same shape `bump-dispatch.test.ts` uses for its role guard, because these two are now the same guard: all three refusals and the accepted case, one `it` each.

### §261. THE WORKER HALF ACTUALLY CONSULTS THE GUARD

THE WORKER HALF ACTUALLY CONSULTS THE GUARD — MEASURED, NOT ASSUMED.

This block exists because deleting `startInventoryIngestionLoop`'s `if (!guard.allowed) return` left the ENTIRE suite green, integration tests included: every one of them boots the loop as a declared commander, where the refusal branch is never taken, and the router census only covers the ROUTER half. So the guard was computed, logged, and structurally ignorable — a guard present but not consulted, which CLAUDE.md names as this codebase's most common defect.

A REFUSED ROLE MUST NEVER CREATE THE QUEUE, not merely skip the work inside the handler: a process that created it would still hold a pg-boss worker for a queue it will never act on, and an outpost would drain ingestion jobs it is forbidden to perform. Same shape and same reason as `version-poll.test.ts`'s "a refused role returns an inert handle and NEVER CREATES THE QUEUE".

## `apps/server/src/dependencies/inventory-ingestion-loop.ts`

### §262. The production caller for dependency-inventory ingestion

M21.2 — THE PRODUCTION CALLER FOR DEPENDENCY-INVENTORY INGESTION (ADR-0032 §4, §6, §7c).

WITHOUT THIS FILE, THE INVENTORY IS EMPTY FOREVER
`upsertComponentDependency` / `pruneComponentDependencies` had no non-test caller, so `component_dependencies` was never written on a real deployment and every capability above it — the enablement work-list, the third-party poll, internal detection's manifest-path lookup — was inert against an empty table. That is the fifth "built and never installed" component in M21, so this file is not an afterthought to the ingestion; it is half of it.

THE SHAPE: ROUTE ON THE SHARED STREAM, WORK ON THIS CAPABILITY'S OWN QUEUE
`boss.work()` is a COMPETING CONSUMER — a second worker on `domain-events` does not add a listener, it splits the jobs (`events/pgboss.ts`). So this registers a ROUTER on that queue and its own worker on its own queue, exactly as M21.4's internal detection does:

```text
outbox → domain-events → `inventoryIngestionRouter` (one predicate, one enqueue)
       → `INVENTORY_INGESTION_QUEUE` → this file's worker → ingestComponentManifests
```

IT SHARES M21.4'S PREDICATE RATHER THAN COPYING IT. `isAcceptedChangeEvent` is imported from `internal-release-loop.ts`; two capabilities reacting to the same event with two hand-written copies of "is this an accepted change?" is two places for that test to drift. The two routers are separate objects with separate queues, which is what keeps them from stealing each other's work.

WHY AN ACCEPTED CHANGE IS THE TRIGGER
A push is what changes a manifest, and the correlated push is already in the tree as a Change — `webhook-processor.ts` matches the delivery to exactly one component through `source_mappings` and records the repo, ref and commit on `changes.source_ref`. Reacting to the ACCEPT rather than to the proposal is deliberate:

- the accepted state is the one this domain has decided is real, and it is the same point M21.4 derives an internal release from, so the inventory and the released version are read at the SAME commit rather than at two different ones; - `scp.change.transitioned` is the only change event that exists at all (`coordination/transition.ts`), and a proposal emits nothing to route on; - a proposed-but-never-accepted change is a release this domain did not take, and recording its manifests as the component's inventory would describe a state the domain never ran.

The cost, stated rather than discovered: a component whose manifests change without a correlated, accepted change is not re-ingested. That is exactly what the operator BACKFILL exists for (`POST /api/v1/dependencies/inventory/backfill`), which is also the only way a component that has never pushed since enablement gets a first inventory at all.

THE ROLE GUARD — COMMANDER-ONLY (ADR-0032 §7d, owner decision 2026-08-17)
BOTH axes apply. This module doc previously argued at length that only the process axis did, and that a commander-only guard "would break the feature"; that argument is WRONG and is recorded as reversed in ADR-0032 §7d, which preserves it verbatim beside the reasoning that overturned it. It is spelled out again here rather than merely cited, because whoever reads this file next is exactly the person who could delete the guard on the strength of the old paragraph.

- THE PROCESS AXIS APPLIES, unchanged. This is background work driven by a queue; an `api` process must stay a request server. `main.ts` additionally only reaches this inside its `runsBackgroundWork` branch, and the guard is what makes that a property of the job rather than of where it happens to be called.

- THE FEDERATION AXIS APPLIES TOO: this runs on a COMMANDER ONLY, fail-closed on an undeclared `SCP_FEDERATION_ROLE`, like every other job in this feature. THE OWNER'S REASON, which is not an argument about egress: the point of dependency automation is to PULL FROM PUBLIC REPOSITORIES — Python library versions, CDK versions, base-image versions — and that is not needed from a FIELD outpost's standpoint, because the resulting change GETS PUSHED DOWN THE GLOBAL PIPELINE THE COMMANDER MANAGES. A field outpost never ORIGINATES a bump; it RECEIVES the resulting change through the ordinary promotion path, as it receives every other change. So a field outpost needs no inventory, and the inventory it used to derive fed nothing that could act on it: the only consumer of an inventory is a bump, and `bumpDispatchRoleGuard` has been commander-only since M21.5 because writing to a source repository with a credential is a thing an air-gapped or high-side field outpost must never do.

```text
 "FIELD" IS LOAD-BEARING HERE, NOT DECORATION (GLOSSARY `HQ outpost` / `field outpost`, ADR-0021
 D7; ADR-0032 §7d's vocabulary note). An HQ outpost — the outpost in the commander's own trust
 domain — is not a second deployment this guard could refuse: `SCP_FEDERATION_ROLE` is one value
 per process (`config.ts`), and this guard reads THAT, never an `outpost` graph object — an
 `outpost` object CAN name the commander's own domain (the commander-declared HQ outpost record,
 pipeline-substrate-registry-scan.md §10.5, `federation/outpost-binding.ts`), but that record
 describes which outpost, not what this deployment is. So THE HQ OUTPOST'S DEPENDENCY INVENTORY
 IS THE COMMANDER'S — the same rows, in this database, written by this loop. Do not read "an
 outpost holds no inventory" as covering it; the correct statement is that the inventory exists
 in exactly one place.
```

```text
 WHAT THE OLD PARAGRAPH GOT RIGHT, AND WHY IT STILL LOST. Its facts hold — ingestion really
 does initiate no timed egress, and `changes`/`source_mappings` really are this domain's own
 records. What it got wrong was treating a per-domain inventory as THE GOAL rather than as a
 substrate for an action only the commander performs.
```

```text
 THE ACCEPTED COST, stated rather than left to be discovered: dependencies declared in
 DOMAIN-SPECIFIC repositories — FIELD-outpost-only IaC/CaC the commander never sees — are OUT OF
 SCOPE for dependency subscriptions. The owner accepted that explicitly. A component whose
 manifests live only in a repository the commander has no `source_mappings` for gets no
 inventory and no bump, and the shape that would fix it is a field-outpost-side job, which is the
 thing this decision removes. A repository specific to the HQ DOMAIN is not excluded by this —
 the commander can see it, so it is an ordinary in-scope repository.
```

Note the scope of the reversal: the SUBSCRIPTION still federates (it is a `dependencySubscription` effect on an ordinary `policy` object, ADR-0032 §3a), and a field outpost still receives it. What is commander-only is the JOBS and the projection tables they write.

### §263. MAY THIS PROCESS INGEST DEPENDENCY INVENTORY?

MAY THIS PROCESS INGEST DEPENDENCY INVENTORY? See the module doc for the derivation, and `commander-only.ts` for why the predicate is SHARED rather than re-spelled here — the fail-closed undeclared branch is the one that regresses invisibly, and it now has five callers.

### §264. The fan-out point on the shared domain-event stream

The fan-out point on the shared domain-event stream: one predicate, one enqueue, no work.

Doing the read inline here would put a git provider's latency and its retry budget on the shared event stream, where one slow provider would hold up every other capability's events.

### §265. Ingest the inventory of every component a change targets

Ingest the dependency inventory of every COMPONENT an accepted change targets, at the commit that change came from.

THE STATE IS RE-READ, never trusted from the event: `scp.change.transitioned` is delivered at-least-once and out of band, so by the time this runs the change may have moved on.

THE REF IS THE COMMIT WHERE THERE IS ONE. `changes.source_ref.commit` is the identity of what was released; `ref` (a branch) is the fallback and is honestly weaker — a branch name is not an identity, which is why `readFileAtRef` returns the commit it RESOLVED to and why that resolved commit is what lands in `component_dependencies.observed_ref` rather than whatever was asked for.

### §266. `changes.source_ref`'s canonical keys, defensively

`changes.source_ref`'s canonical keys, defensively — the same three `internal-release-detection.ts` reads, and read the same way, because they are the same claim about the same release. The column is `jsonb` holding the raw delivery payload plus the keys `webhook-processor.ts` lifted out of it, so every field is optional in practice.

### §267. Register the capability's worker

Register the capability's worker. Returns nothing but the handle; the router half is registered with `startPgBoss` by `events/domain-event-registry.ts`, under this module's own guard, so neither knows the other's internals.

A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the same shape every other loop uses, and for the same reason: a process that merely skipped the work inside the handler would still hold a worker for a queue it will never act on.

## `apps/server/src/dependencies/inventory-ingestion.integration.test.ts`

### §268. Dependency-inventory ingestion against real Postgres

M21.2 — DEPENDENCY-INVENTORY INGESTION AGAINST REAL POSTGRES (ADR-0032 §4, §6).

WHAT THIS FILE IS FOR
`upsertComponentDependency` and `pruneComponentDependencies` had NO non-test caller, so `component_dependencies` was empty on every real deployment and every capability above it — the enablement work-list, the version poll, internal detection's manifest-path lookup — resolved over nothing. Four earlier M21 components failed the same way and every one had passing tests, because the tests called the component directly.

So the assertions here are about the REAL PATH: the worker's own job function (`runInventoryIngestionJob`), driving the real change row, the real `source_ref`, the real enablement resolution and the real repo functions. Only the git provider is faked — and it is faked with a RECORDER, not a mock, because the load-bearing claim about a disabled component is that NOTHING WAS FETCHED, and the only honest evidence for that is an empty recording.

THE FIVE PROPERTIES
1. WIRED — the exact function the pg-boss worker calls, given the change id its router enqueues, writes the component's inventory. Deleting the wiring makes this red. 2. GATED BY CONSTRUCTION — a component with no enabling subscription produces ZERO recorded reads, and the caller cannot opt out of that. 3. UNREADABLE IS NOT EMPTY — each failure mode separately: a 404 HTML body, an LFS pointer, a truncated file, a size refusal, a reader throw, a missing REF. Every one leaves the existing inventory intact. A missing PATH is the one case that does prune, because it is the one case that is evidence about the manifest. 4. IDEMPOTENT — a second pass over unchanged manifests adds no row, deletes no row, preserves `created_at`, and writes NO new Decision. 5. PRUNE IS PER MANIFEST PATH — re-reading a `go.mod` never deletes what a `Dockerfile` declared.

### §269. A recording fake git provider

A recording fake git provider.

IT RECORDS EVERY CALL, and that is the point rather than a convenience: "a disabled component is never fetched" is an assertion about calls that did NOT happen, and a mock's `not.toHaveBeenCalled` proves the same thing only if the mock is the ONLY route to the provider. A recorder that the ingestion is handed, and whose log is asserted empty, is evidence about this run.

### §270. An accepted change targeting it, with the canonical ref

An ACCEPTED change targeting `componentObjectId`, carrying the canonical `source_ref` keys the webhook ingress now lifts.

The state is set directly because this file is about ingestion, not about the acceptance gate — and it is READ BACK, because a fixture that silently did not apply would make every assertion below pass for the wrong reason (`changes` is under `org_isolation` RLS, so a write on the bare pool matches zero rows and says so nowhere).

### §271. THE WIRING ASSERTION

THE WIRING ASSERTION. The job read the change row, resolved its target to this component, passed the enablement gate and reached the provider — which legibly refuses, because this test org has no git-provider binding for `acme/widgets` and SCP will not read one repo with another binding's credential (`manifest-reader.ts`). Every hop except the provider is real, and the refusal is the receipt that the last hop was attempted.

### §272. ON `requirements.txt` DELIBERATELY

ON `requirements.txt` DELIBERATELY. A pointer handed to `parseGoMod` throws and lands in the parse-error arm anyway, so a go.mod case would pass with the LFS guard deleted and prove nothing. `parseRequirementsTxt` NEVER throws (the format has no required construct to miss), so the pointer's own lines would become this component's python inventory and the prune would then delete the real declarations. This is the case the guard exists for.

### §273. An image pinned in Helm values, and the wiring gate

5b. M21.7 — AN IMAGE PINNED IN HELM VALUES

THE WIRING GATE FOR THIS ROUND. `parseKubernetesImages` is a pure function with its own unit suite, and that suite stays green whether or not anything ever calls it — which is this repository's single most common defect and M21's own record (six components built and never installed, one of them a live RCE). The only thing that installs a parser is its entry in `MANIFEST_PARSERS`, and these tests reach it through `ingestComponentManifests`: delete `["values.yaml", …]` from that map and the first one goes red, because the candidate path is never generated, the file is never read, and no row is written.

### §274. THE HONESTY MECHANISM ONLY WORKS IF IT IS QUIET

THE HONESTY MECHANISM ONLY WORKS IF IT IS QUIET. A values file's `sources[].repository`, a Kafka client's `schemaRegistry.registry`, a `<<:` merging resource presets and a `tag` used as a pod label each used to mint either a phantom dependency or an unresolved declaration — and a file whose declarations are all unresolved stamps the manifest `unsupported` and the component `partial`. That fires on ordinary charts, and a warning that fires on everything is a warning nobody reads.

### §275. THE BLOCKER, in the shape no path-scoped rule can resolve

THE BLOCKER, in the shape no path-scoped rule can resolve: BOTH mappings constrain no path, so both passes probe exactly the same root candidates. Repo A has the `go.mod`, repo B has the `Dockerfile`, and each pass therefore sees the OTHER's manifest as `not_found: "path"` — the one branch that prunes. Attribution has to be on the row (`observed_repo`) or it is not recoverable at all.

### §276. `parseRequirementsTxt` cannot throw

`parseRequirementsTxt` cannot throw (its format has no required construct to miss), so a body cut in half parses "successfully" as FEWER dependencies and the prune deletes the rest. The structural guard for that is the byte count, not the text — `decodeBoundedBase64` refuses a payload shorter than the size the provider declares, and it arrives here as a refusal, which this module already treats as "the file is there and was not read".

### §277. Nothing orders two passes

Nothing orders two passes: both delivery hops are at-least-once and the queue is a competing consumer, so a retry of an earlier accept can arrive after a later one. Applied out of order, the older pass prunes each manifest down to what the OLDER commit declared.

The interleave is REAL here, not simulated by editing a timestamp: the old pass's reader blocks inside phase 2 until the newer pass has fully committed, then returns.

### §278. The dedup key used to include the witness

The dedup key used to include the witness — ONE line the merge happened to be satisfied on, taken as the first selector out of `matchPoliciesForTargets`' UNORDERED result. Two identical runs could therefore disagree, and `insertDecisionIfChanged` compares against the LATEST row, so an alternating value appends forever (ADR-0024's measured 1.44 GB/day).

The order is now canonical (pinned behaviourally in `component-ingestion-gate.test.ts`, where reversing the candidate list must produce the same witness) AND the Decision does not carry it at all. This asserts the second half against the PERSISTED row: `contributions` survives, so "which level decided this" is still answerable, and the witness does not.

### §279. EVERY TEST ABOVE CALLS `ingestComponentManifests`

EVERY TEST ABOVE CALLS `ingestComponentManifests` (or the job function) DIRECTLY, and the one that claimed to be "the real path" reached the provider and had EVERY READ FAIL — the rows it asserted came from a separate call with a hand-supplied reader. So the suite proved the repo layer and proved nothing about the path that fills the table in production.

Two distinct gaps close here, and they are distinct on purpose:

A. THE WIRING IS EXECUTED. Deleting `startInventoryIngestionLoop`'s `boss.createQueue` AND its `boss.work` left the ENTIRE suite green — only a substring match on `main.ts` still passed, and a substring match is not a test of behaviour. This drives the real loop over a real pg-boss, from the exact payload `events/outbox-relay.ts` puts on the domain-event queue.

B. A ROW REACHES THE TABLE THROUGH IT. The manifest read goes through `createGitProviderManifestReader` -> the repo's own git binding -> `host.gitFileRead`, so the only thing faked is the provider itself.

```text
outbox -> domain-events -> inventoryIngestionRouter -> dependency-inventory-ingestion queue
       -> this loop's worker -> ingestComponentManifests -> component_dependencies
```

### §280. The posture the loop requires, stated by the fixture

THE POSTURE THE LOOP REQUIRES, STATED BY THE FIXTURE RATHER THAN INHERITED (ADR-0032 §7d). Ingestion is commander-only and FAIL-CLOSED on an undeclared `SCP_FEDERATION_ROLE`, and the harness deliberately leaves that env var unset — so `server.deps.config` alone is a defaulted, UNdeclared commander and this loop would return an inert handle, silently. That is the guard working; the fixture has to declare the posture it wants to test.

### §281. THE SAME WIRING QUESTION, ASKED OF THE STAMP

THE SAME WIRING QUESTION, ASKED OF THE STAMP (M21.7).

The stamp's whole purpose is to explain an EMPTY inventory, so a test that asserts rows cannot notice the stamp is missing — and "built, and nothing calls it" is this milestone's dominant defect, six times over. This therefore drives the production path end to end (the outbox payload -> router -> queue -> worker -> `ingestComponentManifests`) and asserts the STAMP: for a component that ingests, and for one the gate refuses.

Deleting the `recordIngestionStamp` call from `inventory-ingestion.ts` makes this test RED at the `waitUntil`. No test that calls the repo function directly can do that.

### §282. That timestamp is per row, so no rows means none

`component_dependencies.observed_at` is per ROW, so a component with no rows carries no timestamp anywhere and three truths look identical: never ingested; ingested and genuinely declares nothing; ingestion ran and every manifest was unreadable. Each test below pins ONE of those readings against real Postgres, through the real ingestion.

### §283. The row count is the sum over the merged set

`rowsWritten` is the SUM of `manifests[].rows` over the MERGED set, not what this pass wrote. It is 0 here because this component has exactly one repository, whose slice the failed pass just replaced with an `unreadable` entry carrying `rows: 0` — so the only contribution to the sum is 0. The `component_dependencies` rows themselves survive (asserted next): "unreadable is not empty" is about the inventory, not about this column.

### §284. THE DEFECT THIS PINS

THE DEFECT THIS PINS: the refusal above and the good pass below are about DIFFERENT FACTS — "this repository is not this component's" versus "this component's manifests cannot be read" — and the stamp used to write the first over the second. An accepted change reaching a component from an unmapped repo is ordinary (`source_mappings` is a glob-matched correlation), so a healthy component's receipt was destroyed by the next unrelated release.

### §285. The merge is read-modify-write, so it must serialise

The merge is a READ-MODIFY-WRITE, so it is only correct while it is serialised: two passes that both read the pre-state would each write a row missing the other's slice, and the per-repository merge would be defeated at the write by the very race it exists to survive. `recordIngestionStamp` therefore takes the same transaction-scoped advisory lock `ingestComponentManifests`' phase 3 already holds.

WHAT THIS TEST DOES AND DOES NOT PIN. It pins the per-repository MERGE under concurrency. It does NOT pin the lock line inside `recordIngestionStamp`: every pass that writes a slice arrives through phase 3, which already holds that lock, so deleting the `pg_advisory_xact_lock` from `recordIngestionStamp` leaves this test GREEN (measured, 3 of 3 runs). That line is defence in depth for the one writer outside phase 3 — the gate refusal — and the residue is stated in full in the doc comment above `recordIngestionStamp` in `ingestion-stamp-repo.ts`. Read that before assuming a mutation here would catch you.

Eight repositories rather than two: a lost update needs an interleaving, and one pair can serialise by luck where eight cannot.

### §286. Nor can a stranger write a row stamped with this org

WITH CHECK: nor can a stranger WRITE a row stamped with this org's id. Without that half a policy is a read filter only, and a stranger could plant a receipt on somebody else's component.

TWO THINGS THIS TEST HAD TO LEARN BY MUTATION rather than by reading the policy, both of which had left the earlier version asserting almost nothing:

1. THE SUBJECT MUST HAVE NO ROW YET. Aimed at a component that already had one, the refusal came from the upsert's ON CONFLICT DO UPDATE meeting a row the USING clause hides — Postgres refuses that with 42501 too, whatever WITH CHECK says. 2. THE STATEMENT MUST BE A PLAIN INSERT. `recordIngestionStamp` is an upsert, and for an INSERT ... ON CONFLICT Postgres also checks the policy's USING qual against the PROPOSED row — so a cross-org upsert is refused ("new row violates row-level security policy", `ExecWithCheckOptions`) even with `WITH CHECK (true)` installed. MEASURED: no route through the write door can distinguish the WITH CHECK half at all.

Hence both writes below. The raw INSERT isolates WITH CHECK — it is the only statement whose refusal that clause alone produces, and `WITH CHECK (true)` lets it through. The write door then proves the real writer is refused as well, which `USING (true)` breaks.

## `apps/server/src/dependencies/inventory-ingestion.test.ts`

### §287. M21.2 — the PURE half of dependency-inventory ingestion

M21.2 — the PURE half of dependency-inventory ingestion (BUILD_AND_TEST.md §4.1: anything testable as a pure function must be written as one). The database-backed behaviour — the enablement gate refusing to fetch, the per-manifest failure handling, the prune, idempotency, and the fact that anything CALLS the ingestion at all — is in `inventory-ingestion.integration.test.ts`.

### §288. Six for the five ecosystems, plus M21.7's `values.yaml`

Six for the five ecosystems, plus M21.7's `values.yaml` — the Helm/Kubernetes image reader, which emits into the SAME `oci` ecosystem a Dockerfile does.

PINNED AS A LIST rather than as a size, because the cost of a new entry is not one read: it is one read PER PROBE PREFIX (`candidateManifestPaths` is a cross product), against `MAX_MANIFEST_READS`. Adding a filename here without re-deriving that budget freezes real manifests behind `read_budget_exhausted`, silently, on every pass.

### §289. Helm only reads one filename, so the other is not one

Helm itself only ever reads `values.yaml`, so a `values.yml` in a repository is not a chart's values file — treating it as one would be a filename-shaped inference. `Chart.yaml` is a different refusal: its `dependencies[].version` names SUBCHARTS from a Helm repository, which is a sixth ecosystem (a new enum member, a new DB check-constraint value and a new version index), not an image.

### §290. M21.7's class fix

M21.7's class fix. `ok / 0 rows` is this table's own words for "read fine, genuinely declares nothing", and a file that DECLARED something SCP could not read is the opposite statement. Nothing here is YAML-specific: the fixture is a DOCKERFILE, because the defect predates the YAML parser by four milestones (`FROM ${BASE}` and a `pom.xml` of `${revision}` both hit it) and fixing only the instance that exposed it is the incomplete-census failure.

### §291. The one reason pushed by two different branches

The one reason pushed by two different branches: a malformed body (fix the file, and the next pass may succeed) and "no parser is registered for this filename in this build" (nothing to fix). They are told apart by asking MANIFEST_PARSERS the same question the skipping branch asked — the alternative, matching on the detail sentence, is a label named after a string that any reword breaks.

### §292. Four components shipped with no production caller

M21 has shipped FOUR components with no production caller (a guard reaching one of four doors, a detection with no caller, an actuator with no dispatcher, a config schema never registered), and this ingestion was the fifth. Every one of them had passing tests, because tests called the component directly.

So the acceptance criterion is not "the function works", it is WIRED — and the only thing that can regress the wiring is an edit to the composition root, which no unit or integration test of this module would otherwise touch.

NEITHER HALF IS A SUBSTRING ANY MORE, and it took three rounds to get here — which is the most useful thing this comment can record.

Round 1: both halves matched text in `main.ts`. Deleting `startInventoryIngestionLoop`'s OWN `boss.createQueue`/`boss.work` left this green and left the entire suite green, because nothing executed the loop. Round 2 (M21.7): the ROUTER list moved into the importable `events/domain-event-registry.ts` and its registration became a real assertion. The LOOP half stayed text, and was read RAW, so commenting the whole `startInventoryIngestionLoop` block out left all 38 cases green. `readStripped` closed the comment case and no other. Round 3 (2026-08-17): stripping was still not enough — flipping `main.ts`'s background-work condition to `false` killed this loop with the file green, because text cannot see a dead branch. The loop startups moved into `background-work.ts`'s importable `BACKGROUND_LOOPS`, and the assertions below now RUN the registry entry.

The end-to-end half is still `inventory-ingestion.integration.test.ts`'s "the production path" block: a real pg-boss, this capability's real router, `startInventoryIngestionLoop` itself, and the assertion that a domain event lands ROWS IN THE TABLE.

### §293. An outpost no longer gets it, by owner decision

AN OUTPOST NO LONGER GETS IT (ADR-0032 §7d, owner decision 2026-08-17). This assertion was the exact inverse until then — "every federation role, deliberately (§3: each domain derives its OWN inventory)" — and it was green, because that is precisely what the guard did. The decision reversed the QUESTION, not the mechanics: a FIELD outpost never ORIGINATES a dependency bump, it RECEIVES the resulting change down the global pipeline the commander manages, so the inventory it used to derive fed nothing that could ever act on it. A deployment that declares `SCP_FEDERATION_ROLE=outpost` — the config below — IS a field outpost; an HQ outpost is the commander itself and is the accepted case above (ADR-0032 §7d's vocabulary note, read out of the code in `commander-only.ts`).

## `apps/server/src/dependencies/inventory-ingestion.ts`

### §294. M21.2 — DEPENDENCY-INVENTORY INGESTION

M21.2 — DEPENDENCY-INVENTORY INGESTION: the thing that JOINS the parsers to the tables (ADR-0032 §3, §4, §6).

WHAT WAS MISSING, MEASURED
M21.2 built five manifest parsers, a `readFileAtRef` hook and two projection tables, and M21.3–5 built an enablement chain, a detection pass and a dispatcher on top of them. Nothing read a component's manifests and wrote `component_dependencies`: `upsertComponentDependency` and `pruneComponentDependencies` had NO non-test caller anywhere in the tree. On a real deployment the table was therefore empty forever, and everything above it was inert — `listSubscribedComponentLines` derives its work-list FROM that table, so it returned nothing unconditionally, before any policy was consulted; the third-party poll had an empty work-list; and M21.4's internal detection could not find a producing component's manifest path, so `npm`/`python`/`maven` internal releases recorded `no_manifest_path_known` too.

This is the FIFTH component in M21 built and never installed. So the property that matters here is not that the function exists but that something CALLS it: the production caller is `inventory-ingestion-loop.ts` (a router on the domain-event stream plus this capability's own queue), the operator caller is `POST /api/v1/dependencies/inventory/backfill`, and both are pinned by tests that drive the real path rather than this function directly.

THE GATE IS THE FIRST ACT, AND IT IS THE MERGE — NOT A FILTER
ADR-0032 §6: "a disabled component is never fetched". That is a property of THIS function, not of its callers: `ingestComponentManifests` resolves `resolveComponentIngestionGate` before it looks at a repo, a ref or a reader, and returns without having called the reader once when the gate is closed. A caller cannot opt out of it, and there is no flag that skips it. `dependency-inventory-ingestion.integration.test.ts` proves it with a RECORDING fake reader — zero recorded reads — rather than with a mock assertion.

The gate is the chain's first TWO conjuncts (`instance_unlocked AND component_enabled`); the third (`NOT dependency_opted_out`) subtracts individual lines downstream, where the poll and the bump read them. See `subscription-resolution.ts`'s `ComponentIngestionGate` for why an opt-out must not remove a row from the INVENTORY: this function prunes each manifest down to the lines it just read, so an opt-out that suppressed the write would DELETE the record that the component declares that dependency at all.

UNREADABLE IS NOT EMPTY. THIS IS THE WHOLE REASON THE PARSERS THROW.
`@scp/dependency-manifests`' contract is explicit: "'this component declares zero dependencies' and 'I could not read this file' produce identical inventory rows and mean opposite things, and letting the second collapse into the first DELETES the component's whole inventory on the next ingestion pass". A deleted inventory is not a cosmetic loss — `listSubscribedComponentLines` derives subscription from those rows, so a component whose inventory is emptied is silently UNSUBSCRIBED from everything.

So this module has exactly one rule about pruning, and it is stated as a rule rather than left to fall out of the control flow:

```text
**A manifest path is pruned ONLY when this run has POSITIVE evidence about its content, IN THE
REPOSITORY THAT EVIDENCE CAME FROM** — either it was read and parsed (prune to what it
declares), or the provider said the PATH is not there (prune to nothing; the file was deleted).
Every other outcome — a throw from the reader, a missing REF, an indeterminate not-found, a
size/type/encoding refusal, a Git-LFS pointer, an incomplete body, an unparseable body — leaves
that path's existing rows exactly as they are and is reported as its own named reason.
```

THE SECOND CLAUSE IS NOT DECORATION, and it is the one that was missing. A pass reads ONE repository. A component fed by two (`source_mappings` is many-per-component, and the webhook correlator matches on `repo_pattern`) used to have every one of its known manifest paths probed in whichever repo the release came from; the `not_found: "path"` that came back for the OTHER repo's paths is the branch that prunes, so a release from repo B emptied repo A's inventory — every time, silently. Both halves of the fix are structural rather than a call-site check: `component_dependencies.observed_repo` records where each row was observed and `pruneComponentDependencies` cannot delete outside it (drizzle/0063), and `repoManifestScope` derives the candidate paths from the mappings that name THIS repo, so the other repo's paths are not probed in the first place.

`not_found` is split deliberately (`missing: "path" | "ref" | "unknown"`). Only `path` is evidence about the manifest. A missing `ref` is evidence about the REF — a force-pushed branch, a commit garbage-collected out of the repo — and treating it as "the file is gone" would empty the inventory of every component in a repo whose ref moved. `unknown` is GitLab, which answers both questions in one call and distinguishes them only in prose (`read-file.ts` refuses to infer a label from that prose, and so does this).

IDEMPOTENT: RE-INGESTING AN UNCHANGED MANIFEST CHANGES NOTHING
The two hops that deliver this job are at-least-once, and a component is re-ingested on every accepted change, so a pass over unchanged manifests must write nothing new:

- `upsertDependencyLine` and `upsertComponentDependency` are upserts on natural keys; the second deliberately keeps `created_at` out of its update set, so a re-observation preserves when the declaration was first seen; - the prune keeps exactly the lines just read, so an unchanged manifest deletes zero rows; - the Decision goes through `insertDecisionIfChanged`, and NOTHING IT CARRIES MOVES WHEN ONLY THE COMMIT DOES. That is deliberate and slightly counter-intuitive: including the commit would make every push write a new Decision saying the same thing about the same dependencies, which is precisely the shape that measured 1.44 GB/day in production (ADR-0024). WHEN each declaration was observed, and AT WHICH REF, is on the row itself (`component_dependencies.observed_ref` / `observed_at`) — the Decision answers "what does this component declare, and what could not be read", which does not change when only the commit does.

```text
 That claim is a PROPERTY OF EVERY FIELD, not of the two obvious ones, and it was false in
 three places until each was removed: a skip `detail` interpolated the ref (so a component
 whose commit never resolved wrote a fresh Decision per accepted change), a manifest's `pruned`
 count describes the PREVIOUS state rather than this observation, and the gate `witness` is one
 line the merge happened to be satisfied on. Each is named at its own removal site below; the
 rule is that a Decision field must be a function of what the component DECLARES.
```

AND THE PASS LEAVES A STAMP — BECAUSE AN EMPTY INVENTORY HAS THREE MEANINGS (M21.7, 0065)
Everything above describes what a pass WRITES when it finds something. What it finds is often nothing, and `component_dependencies.observed_at` is per ROW — so a component with no rows carries no timestamp anywhere and "never ingested", "ingested fine and genuinely declares nothing" and "ran, and every manifest was unreadable" are the same absence. This function already computed which one; it now also PERSISTS it, one upserted row per component in `dependency_ingestion_stamps` (`projectIngestionStamp` does the mapping).

THIS FUNCTION IS WHERE THE STAMP IS WRITTEN, AND THAT IS THE DESIGN, not a convenience. It is the choke point both producers already go through — the event-driven loop and the operator backfill — so "did this producer remember to stamp?" is not a question that can be asked of either. A third producer inherits it, and must name itself through the required `source` input.

IT IS WRITTEN ON THE REFUSED PATHS TOO, where no Decision is written, because those are precisely the components whose empty inventory needs explaining. The one path that does NOT stamp is `superseded`, for a reason stated at that branch.

AND IT IS WRITTEN AS EVIDENCE ABOUT ONE REPOSITORY, NOT AS THE COMPONENT'S WHOLE STORY. This function reads one repository per pass and a component is routinely fed by two, so the stamp is merged per `(repo, path)` and the component-level verdict is recomputed across the merged set (`mergeIngestionStamp`). The first cut replaced the row wholesale and produced the very lie the table was built to prevent, twice over: a successful `acme/charts` pass erased a failed `acme/widgets` read minutes later, and a refusal for a repository the component is not mapped to overwrote a healthy receipt with `unreadable`. Both are stated where they are fixed — the `refuse` helper below, and `repo:` on the phase-3 write.

### §295. The manifest filenames this reads, and their parsers

The dependency-manifest filenames this ingestion knows how to read, and the parser for each.

The map is keyed on the file's BASENAME because that is what the ecosystems standardise: a `go.mod` is a `go.mod` wherever it sits. The ECOSYSTEM is deliberately NOT read from this map — every parser stamps `DeclaredDependency.ecosystem` itself, and `pyproject.toml` legitimately emits `python` entries from three different blocks. Reading the ecosystem off the filename would be a label named after which branch matched (charter principle 6).

`Cargo.toml` is absent even though `discovery`'s component-marker list carries it: Rust is not one of ADR-0032 §10's five ecosystems and there is no parser for it. A sixth ecosystem adds a parser and one line here.

`values.yaml` — M21.7, AND WHY EXACTLY ONE NEW BASENAME
Most Kubernetes users pin the image their component RUNS in a chart's values file, not in a `FROM` line, and until this entry existed such an image did not appear in the inventory at all — which renders as "declares no dependency" rather than "SCP cannot read where you declared it".

ONE EXACT BASENAME, deliberately (`docs/proposals/kubernetes-image-references.md` §1): - "every `.yaml` in the repository" is not a cost we declined, it is a set SCP CANNOT ENUMERATE. The git seam has exactly one file verb, `readFileAtRef`; there is no list, no tree and no walk (the same measurement `repoManifestScope` records below). - every filename in this map is a MULTIPLIER on every probe prefix, against `MAX_MANIFEST_READS` — which is re-derived below rather than left at its old value. - a probed path is a DURABLE IDENTITY KEY (`component_dependencies` is keyed on `manifest_path`) and a `not_found` on one is the branch that PRUNES, so guessing paths is unsafe, not merely wasteful. `values.yml` is excluded because Helm itself only ever reads `values.yaml`, so a `values.yml` is not a chart's values file and treating it as one would be a filename-shaped inference. `Chart.yaml` is excluded because its `dependencies[].version` names SUBCHARTS from a Helm repository — a sixth ecosystem, not an image. `kustomization.yaml` is the obvious next basename and is deliberately not taken in the same round as the first.

The parser itself is path-agnostic and reads pod specs too, so registering a raw-manifest basename later is one line here plus an addressability answer — not parser work.

### §296. Is this body an LFS pointer rather than the manifest

Is this body a Git-LFS pointer rather than the manifest itself?

Necessary because a pointer is VALID TEXT and reads back as a successful file read, so nothing upstream can catch it — and one of the five parsers, `parseRequirementsTxt`, never throws. Handed a pointer it would return the pointer's own lines as "declared dependencies" and this run would then PRUNE the manifest's real declarations away in favour of them. The other four throw `ManifestParseError`, which is already handled, but a rule that holds for four of five parsers is not a rule.

The test is the pointer format's own required first line (`git-lfs/lfs-pointer-file-spec`): the `version` key is mandatory and must come first, and the URL is part of the specification rather than of any one server's implementation.

### §297. WHAT THIS COMPONENT OWNS **IN ONE REPOSITORY**

WHAT THIS COMPONENT OWNS **IN ONE REPOSITORY** — the scope of an ingestion pass, and therefore the scope of everything it may prune.

WHY THIS IS PER-REPOSITORY, AND WHY THAT IS THE WHOLE POINT
A pass reads exactly ONE repository. Two defects followed from deriving its candidate paths without that fact:

- THE REPO ROOT WAS EVERY ENABLED COMPONENT'S OWN. The prefix set was seeded with `""` unconditionally, so two components sharing a monorepo each ingested the root `package.json` as their own declarations — even when `source_mappings.path_pattern` scoped them to different subdirectories. The root is now a prefix only when a mapping FOR THIS REPO actually yields it. - A PASS PRUNED ANOTHER REPOSITORY'S PATHS. Prefixes were derived from every mapping the component has, in every repository, so a release from repo B probed repo A's manifest paths in repo B, got `not_found`, and deleted repo A's inventory (see `pruneComponentDependencies` and drizzle/0063 for the other half of that fix).

WHY THIS IS A PROBE AND NOT A LOOKUP — measured, not assumed
Nothing in the tree records where a component's manifests are. `source_mappings.path_pattern` is NULLABLE and, where discovery writes one, it is a directory GLOB (`services/api/**`, `packages/plugins/github/src/index.ts`). A glob is a CONTAINMENT PREDICATE: it can answer "is `services/api/go.mod` mine?" and cannot enumerate it — `glob-match.ts` is used as a boolean and nothing in the tree expands one. The plugin host exposes no directory listing either: the only file verb is `readFileAtRef`, which takes ONE path and refuses a directory with `not_a_file`. (Discovery's walk DOES see the marker filenames and throws them away at the `hasMarker` boolean; widening it to report them is the honest long-term fix and is a change to three adapters plus the `DiscoveryProposal` shape, so it is not made here.)

So the candidate set is GENERATED from prefixes and then FILTERED back through the mapping's own predicate (`scopeClaims`) — generation guesses, the predicate decides. `read-file.ts` explicitly sanctions the probing half: "'this component has no `go.mod`' is the expected response for four of the five ecosystems on any given component, so it must not throw".

A WILDCARD-FREE PATTERN IS AMBIGUOUS, AND THE AMBIGUITY IS RESOLVED BY THE CLOSED SET
`services/api/go.mod` and `services/api` are both legal wildcard-free `path_pattern`s and mean different things — one names a file, one names a directory. Treating every wildcard-free pattern as a FILE (stripping its last segment) meant a directory-shaped pattern never probed the component's own directory at all. Nothing in the data distinguishes them in general, so the one closed set that IS knowable decides: a pattern whose last segment is one of the six dependency manifest filenames names that manifest; anything else is read BOTH ways — as a file (its parent directory is the prefix) and as a directory (the pattern itself is the prefix). The claim predicate then discards whichever reading generated paths the mapping does not cover.

### §298. Is this path one the component's mappings cover

Is this path one the component's mappings FOR THIS REPOSITORY actually cover?

The generator above is allowed to over-produce; this is what makes over-production harmless. Each pattern is applied in the two readings a `path_pattern` genuinely has — as a glob over file paths (what `correlation.ts` does with it) and, when it is wildcard-free, as a directory prefix.

### §299. The repository the mappings name, when exactly one

The repository a component's `source_mappings` name, when they name exactly one LITERALLY.

The event-driven path never needs this — `changes.source_ref.repo` says which repo the release came from — but the BACKFILL has no change to read, so it must derive the repo from declared config or refuse. Both refusals are returned as `null` and reported by the caller, never guessed:

- a pattern containing a GLOB metacharacter is a matching rule, not an address. `acme/*` names no single repo and picking one would be reading a predicate as a value. - two different literal repos on one component is a real shape (a component fed by two sources), and there is no basis for choosing between them, so the backfill reports it instead.

### §300. How many provider reads ONE component's ingestion may make

How many provider reads ONE component's ingestion may make. A bound is required because the candidate set is a cross product (prefixes x `MANIFEST_PARSERS`) and `source_mappings` is operator-authored — a component with twenty mappings would otherwise dial a user's git provider 140 times per accepted change.

RE-DERIVED WHENEVER THE PARSER TABLE GROWS, and that is a rule rather than a courtesy: every new filename multiplies EVERY prefix, so a constant left alone quietly buys fewer prefixes than it did. The budget is stated as SIX PREFIXES' worth of the full cross product — six is what 40 bought against the original six filenames — so M21.7's `values.yaml` moves it from 6x6 to 6x7. A component over the budget is not broken, but every path past it is frozen at its last-known contents until the next pass, and the paths are REPORTED by name (`read_budget_exhausted`) rather than counted: an operator can act on "this manifest was not read", not on "42 were not".

### §301. The paths this run will ask for, in a stable order

The paths this run will ask for, in a stable order.

KNOWN PATHS COME FIRST, and that ordering is load-bearing rather than tidy. A path already in `component_dependencies` is one this component demonstrably had a manifest at — including at a non-standard location a probe would never guess, and including one that has since been DELETED, which is only prunable if it is asked for. Spending the read budget on probes before re-reading what is known would let a large probe set silently freeze the real inventory.

### §302. A declaration read but impossible to place on a line

One declaration inside a manifest that WAS read, which cannot be placed on a line.

TWO REASONS, AND THEY CARRY DIFFERENT OPERATOR ACTIONS — which is the only test for whether a reason deserves its own name (ADR-0032 §7b clause 6):

- `no_comparable_version` — the declaration NAMES its dependency and the version text has no numeric core to order on (`FROM alpine`, `image: acme/api:latest`, a bare `requests`). Pin a parseable version, or accept that this one is not subscribable. - `unresolved_declaration` — the manifest declares SOMETHING SCP COULD NOT READ FROM IT: a Dockerfile `ARG`-interpolated tag, a Maven `${revision}`, a Helm values `tag:` with no repository beside it, a Go-templated value, a value behind a YAML alias. Nothing about pinning a version fixes any of those, and telling an operator that a `{{ .Chart.AppVersion }}` "has no comparable numeric core" points them at the wrong repair entirely.

THE SPLIT IS STRUCTURAL — taken from `DeclaredDependency.constraint`, which every parser sets deliberately — and never from matching the note's prose. That is `manifestStampOutcome`'s own discipline applied one level down: a reason picked by reading a sentence is a label named after a string, and any reword breaks it silently.

### §303. How many declarations could not be resolved from it

How many declarations this manifest MADE that SCP could not resolve from it — the `unresolved_declaration` half of `SkippedDeclaration`, counted per manifest.

REQUIRED, not optional, because it is what separates the two meanings of `declared: 0`: "read fine and genuinely declares nothing" from "read fine and every declaration in it was unreadable". `projectIngestionStamp` maps the second to `unsupported`, and an optional field would let a future producer reach that branch by forgetting rather than by deciding.

### §304. Which producer is running this pass, on the stamp

WHICH PRODUCER IS RUNNING THIS PASS, recorded on the per-component ingestion stamp.

REQUIRED, and deliberately not derived. The two producers differ in exactly one other input (the backfill passes `actorObjectId`, the loop does not), so `source` could be inferred from that — which is precisely the provenance-label mistake this repo has already shipped: a label named after which branch matched goes false the moment the branch covers a second case (ADR-0030 §2, charter principle 6). A third producer must name itself, and until it does it does not compile.

### §305. This pass's own row count, not the stamp's

THIS PASS'S OWN row count, and deliberately NOT what lands in `dependency_ingestion_stamps. rows_written`.

A pass speaks for ONE repository; the column is per COMPONENT and a component is routinely fed by two. Handing a per-pass total straight to a per-component column is how a one-row `acme/charts` pass came to report the whole component's inventory as one row, erasing what `acme/widgets` had contributed. The column is therefore summed at the write door over the MERGED per-repository entries (each carries its own `rows`), and this number is the pass's own — the quantity the projection's arithmetic is pinned on, and what a caller reporting on a single pass means by "rows written".

### §306. Is this a file we cannot read, or failed to read now

IS THIS SKIP A FILE SCP CANNOT READ AT ALL, OR ONE IT FAILED TO READ THIS TIME?

The split is by OPERATOR ACTION, which is the only test that keeps a reason honest (ADR-0032 §7b clause 6). `unsupported` means re-running changes nothing — the bytes are there and SCP structurally does not decode them; `unreadable` means this attempt failed and the next may not.

`manifest_unparseable` is the one reason covering BOTH causes, because it is pushed by two branches: a genuinely malformed body (fix the file) and "no parser is registered for this filename in this build" (nothing to fix). They are told apart STRUCTURALLY — by asking `MANIFEST_PARSERS` the same question the skipping branch asked — never by matching on the skip's prose, which would be a label named after a sentence.

### §307. Project a completed pass onto the stamp

Project a completed pass onto the stamp — pure, so the mapping is testable without a database and the write door below has nothing to decide.

`ok` / `partial` / `unreadable` is decided by COUNTING EVIDENCE, not by the verdict:

- a manifest in `manifests` is one this pass has POSITIVE evidence about — read and parsed, or found gone and pruned to nothing. Both are answers. - a manifest in `skipped` is one it does not.

So no skips at all is `ok`; some of each is `partial` (the mixed case the per-path array exists for); and only skips is `unreadable`. NEITHER, which is a component whose every probe came back "not there" with nothing previously known, is `ok` WITH `rowsWritten: 0` — "we looked, and it genuinely declares nothing". That is the state the whole stamp exists to make expressible, and it is why the empty case falls to `ok` rather than to `unreadable`.

A MANIFEST WHOSE EVERY DECLARATION IS UNRESOLVED IS `unsupported`, NOT `ok / 0 rows` (M21.7)
This was a defect the moment the table shipped, and it has NOTHING TO DO WITH YAML — it is fixed as a class because fixing only the instance that exposed it is the incomplete-census failure this repo has shipped before. Every parsed manifest used to map to `outcome: "ok", rows: declared`, and `declared` counts rows WRITTEN. So:

```text
- a `Dockerfile` that is entirely `FROM ${BASE}` stamped `ok / 0 rows`,
- a `pom.xml` whose every version is `${revision}` stamped `ok / 0 rows`,
- and now a `values.yaml` of `tag:` keys with no repository would too —
```

and `ok / 0 rows` is the table's own words for "we read it and it genuinely declares nothing". It is the exact lie the stamp exists to prevent, one level further in: the file DECLARED something, SCP could not read it, and the receipt said there was nothing to read.

`unsupported` is the right member and it is already in the per-path enum ("a file SCP structurally cannot read"; re-running changes nothing), so this needs no schema and no migration — it is a consumer of machinery that was already here. A MIXED manifest stays `ok`, because rows WERE written; its unresolved declarations are named in the Decision's `declarationsSkipped`, and the per-path enum has no `partial` to express the middle.

### §308. Computed from the entries, not the manifest split

COMPUTED FROM THE ENTRIES, not from the manifests/skipped split, so the pass-level verdict and the per-path evidence cannot disagree — an `unsupported` entry is not a manifest this pass can claim it read. This is also exactly how `mergeIngestionStamp` recomputes the row across every repository's slice (`ok` counts entries whose outcome is `ok`), so a pass and the merge that folds it now answer the same question the same way.

### §309. Ingest ONE component's dependency manifests at ONE ref

Ingest ONE component's dependency manifests at ONE ref.

THREE PHASES, AND THE MIDDLE ONE HOLDS NO DATABASE CONNECTION — the same arrangement `internal-release-detection.ts` uses and for the same measured reason: phase 2 reaches a user's git provider through the plugin host, and holding an RLS-scoped pooled connection across that round trip pins a connection per in-flight component against a 5s production `statement_timeout` and a bounded pool (ADR-0032 §7c clause 2, which is normative about exactly this).

```text
phase 1 (tx)    — the enablement gate, the known manifest paths, the probe prefixes.
phase 2 (NO tx) — read and parse each candidate. No writes, no database.
phase 3 (tx)    — upsert lines and declarations, prune per manifest path, persist ONE Decision.
```

The phases are separate transactions, so a crash between them leaves a partial pass — which costs nothing, because every write is an idempotent restatement of an observation and the next accepted change (or a backfill) re-derives the same answer.

### §310. PHASE 1 — the gate FIRST, then what to ask for

PHASE 1 — the gate FIRST, then what to ask for.

EVERY REFUSAL IS STAMPED IN THIS SAME TRANSACTION, beside the gate resolution that decided it. Not in a transaction of its own afterwards: a refusal is the common case on any real estate (an org-wide backfill refuses for every unsubscribed component), so a second round trip per refused component would double the transaction count of the whole pass to say "nothing happened".

### §311. A refusal, its stamp written before it is returned

A refusal, its stamp written before it is returned. The stamp is the ONLY record of these paths: no Decision is written for them (see below), so without it a refused component is indistinguishable from one nothing has ever looked at.

EVERY REFUSAL PASSES `repo: null`, AND THAT IS THE FIX FOR THE WORST THING THIS FUNCTION DID. None of them reached a provider, so none holds evidence about any repository's manifests — including the "no mapping names this repository" refusal, where a repository IS named. That one is the sharp case: an accepted change can target a component from a repo it is not mapped to, and stamping the refusal as this component's manifest verdict overwrote the good receipt a real pass had just written, with `unreadable`, on a component whose manifests were fine. "This repository is not this component's" and "this component's manifests cannot be read" are different facts, and only the second belongs in a slice. With `null`, the merge replaces nothing and the standing evidence still decides the outcome.

### §312. NOT FETCHED, and no Decision

NOT FETCHED, and no Decision: a component that is simply not subscribed is the overwhelmingly common case on any estate, and a Decision per accepted change per component saying "still not enabled" is write amplification with nothing to learn from row 2 onward (the same reasoning `internal-release-detection.ts` applies to `no_declared_producer`). The STAMP is the exception to that argument rather than a contradiction of it: it is ONE UPSERTED ROW per component, so restating it costs a dead tuple instead of an appended row, and it is the only thing that can tell an operator this component's empty inventory is explained by enablement rather than by a manifest nobody could read.

### §313. KNOWN PATHS FROM THIS REPOSITORY ONLY

KNOWN PATHS FROM THIS REPOSITORY ONLY. A row observed in another repo is not evidence about where this repo's manifests are, and probing it here is how a pass acquired `not_found` "evidence" it then pruned the other repository's inventory with. A row with NO recorded repository (written before drizzle/0063) is included so a re-observation stamps it and it heals; until then it is unprunable by construction.

### §314. WHEN THIS PASS LOOKED

WHEN THIS PASS LOOKED — captured before the first read, and the ONLY thing that orders two overlapping passes over the same component.

`observed_ref` cannot do it, and that is worth stating rather than leaving as an omission: it holds a COMMIT SHA, two shas carry no order between them, and deciding which is the descendant needs a git-history walk this system does not do (the plugin seam has exactly one file verb, `readFileAtRef`, and ADR-0032 §9 keeps it that way). What the ref DOES do is name what was read; what the read TIME does is say which of two readings is the later evidence. So the row carries both, this compares the second, and the honest residue is named on the guard in phase 3.

### §315. THE ORDERING GUARD

THE ORDERING GUARD — an OLDER pass must not land after a newer one.

Nothing orders two ingestion passes for the same component: both hops are at-least-once, the queue is a competing consumer, and a retry of an earlier accept can be delivered after a later one. Applied out of order, the older pass prunes each manifest down to what the OLDER commit declared and deletes the declarations the newer commit added — the same silent unsubscription this whole module exists to prevent, arriving by a race instead of a bug.

WHAT IS COMPARED, AND WHY IT IS NOT THE REF. `observed_ref` holds a commit sha; two shas have no order between them, and deciding which is the descendant needs a history walk that does not exist behind this seam (`readFileAtRef` is the only file verb, ADR-0032 §9). What IS orderable is WHEN each pass read the manifests, so that is what the row records (`observed_at` is stamped from phase 2, not from this write) and what this compares.

THE RESIDUE, STATED: this orders passes by when they LOOKED, not by commit ancestry. Two passes whose reads and whose commits are ordered oppositely — a job for a newer commit that read first — still land in the wrong order. Closing that needs ancestry, which this system deliberately cannot ask for; the next accepted change or a backfill re-derives the truth.

### §316. NOTHING IS WRITTEN

NOTHING IS WRITTEN — not the rows, not the prune, not a Decision AND NOT A STAMP.

The stamp is deliberately in that list. It describes WHAT THE INVENTORY IS, and this pass established nothing about that: its manifests are stale evidence that was not applied. A stamp here would publish per-path entries counting rows that are not in the table. (`mergeIngestionStamp` would refuse the slice anyway, because the winner read this same repository later — but relying on that would make the honest answer an accident of two guards agreeing rather than a decision made here.)

"Never attempted is the absence of a row" survives this: being superseded REQUIRES a newer pass to have written rows for the same component, and that pass stamped. A Decision here would alternate with the ordinary one for the same component and re-open the persist-on-change guard (`insertDecisionIfChanged` compares against the LATEST row, so alternating verdicts append forever); and there is nothing to explain that the winning pass's Decision does not already say.

### §317. PATH AND REASON, NEVER THE DETAIL

PATH AND REASON, NEVER THE DETAIL. A detail carries provider prose, an error message and (before this) the ref itself — all of which vary per commit, so a component whose ref never resolves wrote a fresh Decision per accepted change while its own doc claimed the inputs carry no commit. The REASON is the stable, explanatory half; the detail stays on the returned outcome, where the operator and the log read it.

### §318. The stamp, in the same transaction as the rows

THE STAMP, IN THE SAME TRANSACTION AS THE ROWS IT DESCRIBES
Atomicity is the point of writing it here rather than after the transaction commits: a stamp saying `ok / 0 rows` that survived while the declarations it counted rolled back would be a receipt for writes that never landed — a lie with a timestamp on it, which is worse than the silence this table replaces.

`readAt`, not `now()`: the stamp records WHEN THIS PASS LOOKED, on the same clock the rows' `observed_at` carries, so the stamp and the inventory cannot disagree about which pass is the later evidence.

### §319. Upsert the line and the declaration; return the line

Upsert the LINE a declaration belongs to and the declaration itself; return the line id, or `null` when the declaration names no comparable version.

THE LINE IS THE MAJOR, and that is a decision worth stating. `dependency_lines` is keyed on `(ecosystem, coordinate, major)` and the subscription's `granularity` (`patch` vs `minor_and_patch`) is what decides how far a subscriber MOVES within its line — so putting the minor in the line identity would make `alpine:3.18` and `alpine:3.19` two unrelated lines and leave `minor_and_patch` with nothing to express. `major` is therefore `String(version.major)`; `line-head.ts`'s `isOnLine` reads the line's own precision, so a finer-grained major written by an operator still behaves exactly as ADR-0032 §7a describes.

`tagPattern` is the LITERAL VARIANT SUFFIX and `oci` only (ADR-0032 §7b clause 2) — `-alpine` off a `3.18-alpine` tag. It is taken from the parsed version's `suffix`, which `version.ts` extracts verbatim and WITHOUT interpretation, and the write door normalises it to NULL for the four language ecosystems, so a language line can never acquire one from here.

NOTHING HERE CAN DECLARE A PRODUCER. `upsertDependencyLine` cannot reach `produced_by_object_id` at all (that is a separate verb, `declareDependencyLineProducer`), which is what makes "declared, never inferred" a property of the API rather than of this call site remembering to leave a field unset (ADR-0032 §7, ADR-0030 §2).

## `apps/server/src/dependencies/line-head-restatement-pin.integration.test.ts`

### §320. That timestamp means when we last looked, not moved

STOP. `latest_observed_at` MEANS "WHEN WE LAST LOOKED", NOT "WHEN THE HEAD LAST MOVED".

If you are here because you changed `evaluateHeadMovement` or `recordDependencyLineHead` — most likely to make the daily poll cheaper by writing only when the head actually advances — READ THIS BEFORE YOU CHANGE THE ASSERTION. The optimisation is reasonable-looking, it passes every other dependency test in this tree, and it breaks a SECURITY GATE two packages away.

WHO DEPENDS ON IT: `governance/scan-vendor-latest.ts` — the M22.4 vendor rule (ADR-0033, owner decision D1). A scan finding is excluded before it is counted when the component is on the LATEST VERSION OF THAT MAJOR LINE, and "latest" is only usable as evidence if it was observed RECENTLY: `vendorLatestStalenessBoundMs` refuses any head whose `latest_observed_at` is older than three poll cycles, because a stale observation is a claim about a world that has since moved.

SO THE FAILURE MODE IS INVERTED FROM WHAT YOU WOULD EXPECT. If a no-op restatement stops refreshing the timestamp, then a dependency that is genuinely current — its head has simply not moved for a month, which is the NORMAL state of a mature package — starts looking STALE, and the gate stops granting vendor-passes it should grant. Nobody notices, because the symptom is a scan that fails "correctly". The inverse mistake (making the write door refresh nothing at all) is worse: findings would be excluded on the strength of an observation from an arbitrarily long time ago.

THE TWO HALVES ARE PINNED SEPARATELY because they can regress independently: 1. `evaluateHeadMovement` must report an identical re-observation as `moves: true` with movement `restated`. Flipping it to `moves: false` is the natural shape of "only write when it moves". 2. `recordDependencyLineHead` must actually ADVANCE `latest_observed_at` on that restatement. Moving `latestObservedAt` out of the SET list, or gating the UPDATE on `advanced`, is the other natural shape.

WHAT YOU MAY CHANGE FREELY, so this pin is not read as more than it is: the `advanced`-only OUTBOX EVENT is deliberately not restated and this file asserts nothing about it. Suppressing a bump job per dependency per day is exactly right. The TIMESTAMP is the part with an outside consumer.

If the poll genuinely must stop writing on a restatement, the vendor rule needs a different freshness source (a per-line "last polled" column, or the poll's own Decision row) BEFORE this test is deleted — not after.

## `apps/server/src/dependencies/line-head.test.ts`

### §321. What the head fields mean, pinned without a database

M21.4 — WHAT `latest_version`/`latest_digest` MEAN, pinned without a database (BUILD_AND_TEST.md §4.1).

Every assertion here is about a disagreement that ACTUALLY EXISTED between the two writers of those columns — internal detection and the third-party poll — and that no type could catch, because both wrote a `string` into a `text` column:

```text
- `tag_pattern` meant "the literal variant suffix" to one and NOTHING to the other, so an
  `-alpine` line took a plain glibc tag as its head.
- the column was "the head" to one and "the last thing I saw" to the other, so a hotfix on an
  older minor moved it backwards.
- `produced_by_object_id` split the two ingresses in the ADR and in NEITHER writer.
```

MUTATION LOG — each applied, watched fail, reverted, watched pass: | Mutation | Result |
| drop the variant check from `lineAcceptsVersion` (compare only the numeric core, the pre-fix internal reading) | "an `-alpine` line REFUSES the plain flavour" FAILS | | make `evaluateHeadMovement` always return `advanced` | "a hotfix behind the head does not move it" FAILS | | `asThirdPartyLine` returns the line regardless of `produced_by_object_id` | "an internal line is not a pollable line" FAILS |

### §322. THE DEFECT THIS PINS

THE DEFECT THIS PINS: internal detection ignored `tag_pattern` entirely, so an image line declared as the alpine variant happily took `3.18.4` — a glibc image — as its head, and every subscriber tracking the alpine variant would have been bumped across flavours. The poll, using the same column as a literal suffix, would never have offered that tag. One column, two meanings; now one.

### §323. WHY THIS CASE EXISTS

WHY THIS CASE EXISTS (drizzle/0068). Under the old signature the internal-ness fact was a COLUMN on the line row, and the dangerous path was a row whose column was NULL because nobody had ever written it — a brand-new major of a coordinate the org publishes. `asThirdPartyLine` dutifully returned a pollable line, and the org's own package went to a public index.

The fact is now a required second parameter, so "I did not look" is not expressible: the two call sites below are the only two answers, and there is no third that means "unknown". This asserts the SHAPE — `asThirdPartyLine.length === 2` — because the whole guarantee is that the argument cannot be omitted, and a one-argument overload would restore the old hole with every other test still green.

### §324. Why this exists alongside the ingress splitter

WHY THIS EXISTS ALONGSIDE `asThirdPartyLine`, WHICH ALREADY SPLITS THE INGRESSES.

`asThirdPartyLine` mints a COMPILE-TIME brand, and it is minted in an EARLIER TRANSACTION than the head write — both ingresses deliberately do their network work with no transaction open ("a registry that takes 15s must never hold a tenant transaction"). So the brand asserts "no declaration existed when the work-list was built", which a declare landing in that window makes false. Measured: a public `2.99.0` landed on a just-declared internal line, fanned a bump out, and was then unfixable — the poll no longer visits an internal line, and the org's real `2.1.0` is refused as `behind_head`.

This is the runtime half, re-checked at the write door inside the writing transaction. The end-to-end replay of the race is `version-poll.integration.test.ts` (6); this pins the rule itself, all three directions, without a database.

MUTATION LOG — applied, watched fail, reverted, watched pass: | Mutation | Result |
| `return { authorized: true }` unconditionally | the three refusal cases FAIL (3 of 6) | | drop the `line_is_third_party` arm (guard the confusion direction alone) | ONE failure — "an INTERNAL write onto a RETRACTED coordinate is refused", and note WHY only one: a null declaration then falls into the transfer arm and is refused as `line_transferred`, which is the wrong REASON rather than a wrong verdict. Two arms that both refuse are still two facts, and the audit record has to carry the right one | | drop the transfer arm — i.e. restore the pre-2026-08-17 rule, which is exactly what `{ hasDeclaredProducer: boolean }` could express | ONE failure, and it is "a TRANSFER refuses the FORMER producer". THE OTHER FIVE STAY GREEN, which is the whole reason that case had to be written rather than assumed covered | | keep the transfer arm but report it as `line_is_third_party` | same one failure, on the reason alone — the write is refused and the Decision then says the coordinate is third-party when it is internal and owned by Q |

### §325. THE BUG THIS ARM EXISTS FOR, measured

THE BUG THIS ARM EXISTS FOR, measured. `POST /dependencies/producers` UPSERTS, so declaring a coordinate that already has a producer TRANSFERS it (the route records `displacedProducerObjectId` precisely because that happens). Under the previous shape this rule was handed `hasDeclaredProducer: true` in exactly this situation and authorized P's write: P's version became the head, `line_head_advanced` fanned bump PRs into every subscriber's repo, and Q's genuine release was then refused `behind_head` FOREVER — the poll never visits a declared line, backward movement is refused, and no API resets the column.

## `apps/server/src/dependencies/line-head.ts`

### §326. What the head fields mean, in one place

M21.4 — WHAT `dependency_lines.latest_version` / `latest_digest` MEAN, IN ONE PLACE (ADR-0032 §7).

WHY THIS FILE EXISTS: TWO WRITERS THAT DISAGREED
Two ingresses write that column pair, and before this module they meant different things by it:

```text
- INTERNAL detection (`internal-release-detection.ts`) — DERIVED from an accepted change that
  reached a `prod` deployment-target, for a line the org DECLARES it produces.
- THE THIRD-PARTY POLL (`version-poll.ts`) — POLLED from an ecosystem index, for a line nobody
  in the org produces.
```

Left to themselves they disagreed on three questions, and each disagreement is a wrong claim in an audit record rather than a crash:

1. WHAT `tag_pattern` IS. The poll read it as the line's literal variant suffix (`-alpine`); internal detection ignored it, so an `-alpine` line took a plain glibc tag as its head. 2. WHETHER THE COLUMN IS A HEAD. The poll wrote the max of what an index offered; internal detection wrote whatever the last accepted change published — so a hotfix on an older minor of the same line moved `latest_version` BACKWARDS, and every subscriber already on the newer release looked ahead of its own line's head. 3. WHETHER `latest_digest` BELONGS TO `latest_version`. The poll could write a new tag while RETAINING the previously stored digest, so the row asserted a (tag, digest) pair that never existed in any registry — and ADR-0032 §7's "a mutable tag is not an identity" makes that pair the whole claim.

So the meaning is stated here, once, and both writers reach it through `recordDependencyLineHead` — which is the only function in the tree that writes the `latest_*` trio and which applies every rule below itself. A rule applied by each caller is a rule with one place per caller to regress; applied at the write door it has one.

THE MEANING
```text
`latest_version` is the HEAD of the line: the greatest version ON this line that this domain
has observed. It never moves backwards, it is never a version from another line or another
image variant, and NULL means "not yet observed" — never "no newer version exists"
(migration 0061, and `scan_requirement_floors`' "absent never means zero").
```

```text
`latest_digest` is the digest OF THAT version, observed in the same act. It is written together
with the version or not at all; a digest never survives a version change, so the row cannot
assert a pair nobody ever saw. NULL means "this version's digest was not resolved", which is a
true statement — unlike the previous version's bytes sitting beside a new tag.
```

A digest that could not be resolved does NOT block the observation, and that is a deliberate choice with a measured reason rather than a softening: the operator-loaded air-gap feed carries versions and NO digests at all (`version-index-feed.ts`), so requiring one would make an air-gapped estate unable to ever record an image head — the exact "an air-gapped estate is indistinguishable from a fully up-to-date one" failure §7 is arranged to avoid.

AND WHO MAY WRITE IT — THE INGRESS SPLIT (ADR-0032 §7)
The two ingresses are not two ways of doing one job; they own DIFFERENT LINES. An internal line's head is derived from the org's own production release and must never be polled, because a public index that happens to carry the same coordinate would overwrite the org's own `2.1.0` with a stranger's `9.9.9` and every subscriber would be bumped onto it. That is dependency confusion, arriving through a background job nobody watches.

`asThirdPartyLine` is how the split is enforced: `queryLineHead` accepts ONLY a `ThirdPartyLine`, and the only way to obtain one is to hand that function a line TOGETHER WITH the joined fact that no producer declaration exists for its coordinate (drizzle/0068 moved the declaration off the line row and onto `dependency_line_producers`). A caller that "forgets the filter" does not compile — and, since the fact is now an argument rather than a column that may simply never have been written, a caller that never looked cannot supply it either.

### §327. A line whose head the THIRD-PARTY POLL is allowed to move

A line whose head the THIRD-PARTY POLL is allowed to move: NO producer declaration exists for its COORDINATE.

The brand is not decoration. It is the difference between "the poll happens to filter internal lines out today" and "the poll cannot be handed one" — and this repo has already shipped the first shape twice (the incomplete call-site census). `queryLineHead` takes this type, so a new caller, a new work-list, or a test that assembles a line by hand must go through `asThirdPartyLine` and get a `null` for an internal line rather than a silent registry fetch.

### §328. The ONE constructor of a {@link ThirdPartyLine}

The ONE constructor of a `ThirdPartyLine` — `null` for an internal line.

THE INTERNAL-NESS FACT IS AN ARGUMENT, NOT A FIELD ON THE LINE (drizzle/0068, ADR-0032 §7e). It used to read `line.producedByObjectId`, back when the declaration was a per-major column. It is now per COORDINATE, so the caller must have JOINED `dependency_line_producers` and passes what that join found.

The lost convenience is the point. A caller who has not looked cannot supply the argument and so cannot obtain a `ThirdPartyLine` by forgetting to check — whereas under the old signature the forgetful path was a row whose column was NULL because NOBODY HAD EVER WRITTEN IT, and that path polled the org's own package against a public index. The barrier could not protect a column nobody filled in; it can refuse an argument nobody supplied.

"Declared, never inferred" is why the declaration is the test: nothing here looks at the coordinate for the org's name, or at a registry host.

A BOOLEAN IS THE RIGHT SHAPE *HERE*, unlike in `evaluateIngressAuthority` — said out loud because the two now differ and the difference is a decision, not an oversight. This function answers for the THIRD-PARTY ingress, which speaks for no component and makes no claim of its own: ANY declaration, to anybody, makes the line somebody else's, so WHICH component holds it cannot change the answer. The internal ingress DOES make a claim, about a named component, which is exactly why its rule needs the identity and why a boolean there was a bug.

Those are the only two places in the tree that ask this question. Census taken 2026-08-17 with no grep filters: `listThirdPartyDependencyLinesByIds` passes `false` after an SQL anti-join has already excluded every declared coordinate, and `@scp/schemas`' `isInternalDependencyLine` — which is the same `declaration !== null` reduction — has NO call sites anywhere, only mentions in prose.

### §329. Which ingress a head write is coming from

WHICH INGRESS A HEAD WRITE IS COMING FROM — the argument the write door re-checks the world against, INSIDE the transaction that writes.

WHY A RUNTIME ARGUMENT WHEN `ThirdPartyLine` ALREADY EXISTS (measured, not theorised)
The brand above is a COMPILE-TIME fact, and it is minted in a DIFFERENT TRANSACTION from the one that writes. Both ingresses deliberately straddle a transaction boundary, because a registry that takes 15s must never hold a tenant transaction open:

```text
version-poll.ts            buildLineWorkList (tx1) -> queryLineHead (NO tx) -> write (tx2)
internal-release-detection producer read (tx1)     -> resolution (NO tx)    -> write (tx3)
```

A `ThirdPartyLine` therefore says "no declaration existed when tx1 ran", which is not the same claim as "no declaration exists now". The gap was measured end to end against real Postgres: a `POST /dependencies/producers` landing between tx1 and tx3 confirmed the head cleared to null, and the poll's own in-flight write then put a PUBLIC `2.99.0` back on the just-declared internal line and fanned a bump out from it. The line was then PERMANENTLY WRONG — the poll's work-list excludes it (it is internal now, so nothing re-visits it) and internal detection's legitimate `2.1.0` is refused as `behind_head`. That is dependency confusion arriving through the one door built to end it.

So the fact is re-read at the write door under the same `FOR UPDATE` that guards the head, and this argument is what the door compares it against. It lives HERE, beside the three head rules, for the reason this module's opening states: a rule applied by each caller has one place per caller to regress.

AND THE INTERNAL ARM NAMES *WHICH* PRODUCER — because "is a producer declared?" is the wrong QUESTION, not merely a coarse answer (measured 2026-08-17)
The first cut of this type was the two bare strings `"third_party" | "internal"`, and the declaration it was compared against was a `boolean`. That asked whether the coordinate HAS a producer and never whether it has THIS one — so the whole rule was blind to the one act that changes a producer without removing it. A TRANSFER is ordinary and supported: `POST /dependencies/producers` upserts, and `routes/dependency-producers.ts` records `displacedProducerObjectId` precisely because coordinates move between components.

Replayed at the same seam as the two races above — declare to P, transfer to Q, then P's own in-flight phase-3 write:

```text
  { "recorded": true, "movement": "advanced", "detail": "'2.9.9' is the first head observed …" }
  outbox: line_head_advanced -> bump PRs authored into every subscriber's repo, onto P's version
```

and Q's genuine `2.4.0` is then refused `behind_head` FOREVER: the third-party poll never visits a declared line, backward movement is refused, and no API resets `latest_version`. That is the same permanence rule 0 was written to end, one level finer.

WHY THE IDENTITY RIDES ON THE INGRESS AND NOT ON `ObserveDependencyLineHeadInput`. That input is the OBSERVATION — the `latest_*` trio and nothing else — and it is a Zod schema in `@scp/schemas`, i.e. a shared contract shape. The producer id is not something observed about the line; it is the CLAIM the writer is making about its own standing, which is exactly what this type already is. Putting it on the input would also have to make it optional (the poll has none), and an optional field is a field an internal caller can omit — restoring, one level down, the same "I did not look" hole that made `ingress` a required argument in the first place. As the required member of the `internal` arm, an internal write that cannot name its producer DOES NOT COMPILE.

### §330. MAY THIS INGRESS MOVE THIS LINE'S HEAD?

MAY THIS INGRESS MOVE THIS LINE'S HEAD? Pure, so the rule is testable without a database; called by `recordDependencyLineHead` with a declaration read in the SAME transaction as the write.

ALL THREE DIRECTIONS ARE REFUSALS, not one guard and two conveniences. A retraction landing mid-flight of an internal-detection pass is the first race with the arrow reversed, and its outcome is the worse-reading of the two (`resetLineHead`'s header: a stale internal head on a coordinate that is third-party again is a security-gate input, not merely a stalled poll). A TRANSFER landing in the same window is the third, and it is the one the boolean form of this function could not express at all — see `HeadWriteIngress`.

THE DECLARATION IS PASSED AS AN IDENTITY-OR-NULL, NEVER AS A BOOLEAN, and that shape is the fix rather than a consequence of it. While the parameter was `{ hasDeclaredProducer: boolean }` the caller had to answer a question the caller could not get wrong — and the rule could not ask the question that mattered. `null` still means "no declaration"; anything else is the component that holds the coordinate right now.

It is a REFUSAL AND NOT A THROW because both callers already have a refusal path that records the reason in their Decision (`version-poll.ts`'s `not_recorded` verdict, `internal-release-detection.ts`'s `SkippedInternalRelease`). A throw would abort a sweep over other lines for a fact about one, and would put nothing on the record.

### §331. The component named as this line's producer

The component `dependency_line_producers` names for this line's `(org, ecosystem, coordinate)` AS READ INSIDE THE WRITING TRANSACTION, or `null` when the coordinate carries no declaration at all.

THE IDENTITY, NOT `hasDeclaredProducer`. A boolean here is what let a transferred coordinate's former producer keep writing its head.

### §332. Which suffix class this line lives in: one meaning

Which suffix class this line lives in — THE single meaning of `tag_pattern`.

`tag_pattern` is the line's LITERAL VARIANT SUFFIX (`-alpine`, `-slim`), or absent for the plain flavour. It is NOT a glob, and it is not a "shape" some other reader may interpret differently: migration 0061 stores it verbatim and this is the only function that reads it.

Why a suffix at all: `compareVersions` REFUSES to order two versions whose suffixes differ, because `3.19-alpine` and `3.19-slim` are two flavours of one release rather than an upgrade path, and `1.2.3-rc.1` vs `1.2.3` is a semver precedence rule that does not hold for OCI tags. A head must therefore be picked WITHIN one suffix class, and a release outside the line's class is not a candidate for its head at all.

- the four language ecosystems: the empty suffix, i.e. STABLE RELEASES ONLY. A prerelease (`2.0.0-rc.1`, PEP 440's `2.0rc1`, `v2.0.0-beta`) never becomes a line's head. That is a deliberate functional limit — a subscription that bumped a component onto a release candidate would be doing something nobody asked for — and it is why `tag_pattern` is normalised to NULL for them at the write door (`tagPatternFor`). - `oci`: the line's own `tagPattern`, or the empty suffix when it has none. An operator who writes something that is not a literal suffix gets NO eligible tags and a legible refusal naming the line, rather than a glob quietly matching the wrong flavour.

### §333. Parse a version string AS THIS LINE'S ECOSYSTEM SPELLS ONE

Parse a version string AS THIS LINE'S ECOSYSTEM SPELLS ONE — the single door both writers use.

`oci` goes through `parseImageTagVersion`, which refuses a single-component tag: `20240115` and `7` are indistinguishable as strings (a date stamp and a major line) and a registry offers no way to tell them apart, so treating either as a version is exactly the guess ADR-0032 §7 forbids. The four language ecosystems go through the plain parser.

Both writers use this door, which is the point: before it, the poll refused a bare `7` while internal detection accepted it, so the same tag meant two different things depending on which ingress saw it first.

### §334. Is `candidate` a member of the line `major` names?

Is `candidate` a member of the line `major` names?

The test is STRUCTURAL, not textual: both sides are parsed, and the candidate must agree with the line on every numeric component the line actually SPELLS (`ComparableVersion.precision` is the receipt for how many that is). So `3` matches 3.x.y, `1.2` matches 1.2.z, and Go's `v2` matches 2.x.y. Comparing the strings instead would fail on `v2` vs `2.1.0` and would accept `3` against `30.1.0` by prefix.

### §335. Does `version` belong to THIS line

Does `version` belong to THIS line — same major line, same variant?

BOTH halves, in one function, because that is the fix for the disagreement this module opens with: internal detection tested only the major and the poll tested only within its own selection loop. There is no second reading of `tag_pattern` left in the tree.

### §336. THE head rule, shared by both writers

THE head rule, shared by both writers: A HEAD NEVER MOVES BACKWARDS.

The case that made this necessary is ordinary, not exotic: a `1` line publishes `1.10.0`, then a hotfix ships `1.9.10` on the maintenance branch. Both are genuine production releases of the same line. Internal detection applied no ordering check at all, so the second one moved the column back and every subscriber already on 1.10.0 looked ahead of its own line's head — a subscription that would then never fire again for them, silently.

A release that is genuinely older is NOT lost: it is refused HERE with `behind_head` and recorded in the caller's Decision, which is where "this release happened, at this version, and the head did not move" belongs. The column holds the head; the Decision holds the history.

A STORED VALUE THAT IS NOT ON THE LINE AS DEFINED NOW IS NOT A HEAD. If an operator repoints a line's `tag_pattern` (or its stored head predates a definition it no longer satisfies), the stored text is incomparable to every new candidate — and refusing on that would wedge the line forever with no remedy, since nothing in the API can reset `latest_version`. So such a value is discarded and the candidate becomes the head, with the discarded value named in the detail. Regression is only ever *demonstrable* between two versions that are both on the line, which is exactly where the hotfix case lives.

## `apps/server/src/dependencies/managed-dep-instance.ts`

### §337. HOW A `managed-dep` INSTANCE IS BUILT

HOW A `managed-dep` INSTANCE IS BUILT — in ONE place, because there are now two callers.

`bump-dispatch.ts` builds one to AUTHOR a bump; `bump-gate.ts` builds one to MERGE a bump that was already authored. Those are different acts with different preconditions, but "which credential, from whose binding, with which server-governed runner settings, and which providers are refused" is one question with one answer — and a second copy of that answer is the property CLAUDE.md's census rule is about. It is extracted rather than duplicated the moment the second caller exists, not after the two have drifted.

WHAT COMES FROM WHERE, because the trust tiers must not blur: * the GIT IDENTITY (App id, installation, the vaulted private-key reference and the API base) is the TENANT's, taken from the binding their team already configured for that repository — resolved through `resolveExecutorPluginInstance`, so the secret is decrypted by the same code path and under the same rules as every other plugin's; * the RUNNER SETTINGS are the SERVER's, from `managedDepServerSettings`, spread LAST so they win. With `SCP_MANAGED_DEP_RUNNER_IMAGE` unset that function yields no image and this throws BEFORE a container could be launched or a credential minted — the deployment-level expression of "managed execution is never a default" (ADR-0006) for the one class that writes to a user's repository. It gates the MERGE path too, deliberately: a deployment that has not enabled dependency authoring must not be able to merge one either. * there is NO network mode to inject: the plugin passes `--network none` as a literal (charter 2026-08-15, unqualified for this class).

IT IS ASSEMBLED FROM THE COMPONENT'S OWN GIT BINDING, not from an `executor_bindings` row of its own — and `executor-bindings-repo.ts`'s `managedDepServerSettings` doc says why there is no such row to have: a dependency bump fits none of the six executor Types honestly, and the precedent for a managed class dispatched without one is `scp-managed-scan`, which `federation/promotion-scan-step.ts` constructs directly.

THE INSTANCE ID IS PER RUN, NOT PER BINDING — AND THAT IS A CORRECTNESS PROPERTY
It used to be `managed-dep:<bindingId>` alone. Two DIFFERENT jobs act on the same component's binding — `bump-dispatch.ts` authors, `bump-gate.ts` merges — and both are ordinary background workers that can be in flight at the same moment for the same component (a head advance and a CI conclusion are unrelated events). Each ends with `host.stopInstances([...])` in a `finally`, so with one shared id EITHER JOB TEARS DOWN THE OTHER'S SUBPROCESS MID-RPC — including a `status()` call issued AFTER the provider has already merged, which turns a completed irreversible act into an unreadable outcome the gate then records as a refusal.

The `runToken` is the caller's receipt of its OWN run. Within one job it is a constant, so the same component still reuses one subprocess across that job's candidates and the set a caller stops is exact; across jobs the ids are disjoint, so no `finally` can reach another run's instance. It is the same "stopped from a RECEIPT of what this code started, never from a second derivation of what should be running" rule (ADR-0032 §7c clause 4), applied to the ID as well as to the set.

### §338. The component's git-provider binding

The component's git-provider binding — the one that holds the credential for its repository.

DETERMINISTIC BY BINDING ID when a component somehow has several, so two callers looking at the same component reach the same repository. The repo itself is read from the binding rather than from a source mapping's glob or from a name: one team's installation token is not authority over another team's repository (`manifest-reader.ts` states the rule this follows).

### §339. Build and start the instance for this repository

Build and start the `managed-dep` instance for this component's repository. Returns the instance id, which the caller is responsible for stopping (see `bump-dispatch.ts`'s `startedInstances` receipt — stopped from what this code STARTED, never from a second derivation of what "should" be running), and which is namespaced by `runToken` so one job's teardown cannot reach another's in-flight RPC.

### §340. The operator's runtime, and the launcher selection

The operator's container runtime, and since M23.2 the launcher SELECTION with it. This is the path that runs in production (the binding path below it is the hand-made rarity), so omitting `dockerBinary` here meant `scp-managed-dep` `execFile`d a hardcoded `docker` on every ordinary bump however the deployment was configured — while its two sibling managed classes honoured the setting. The launcher selection has the SAME shape and a larger blast radius: omitted here, the ordinary bump path would stay on Docker on a Kubernetes deployment, i.e. M21's actuator would remain exactly as dead as M23 exists to fix.

## `apps/server/src/dependencies/manifest-reader.test.ts`

### §341. M21.4 — WHICH BINDING MAY READ WHICH REPO

M21.4 — WHICH BINDING MAY READ WHICH REPO (ADR-0032 §7a).

The read is the first time SCP reaches into a user repo for the DEPENDENCY path, and the binding it goes through carries credentials. So the match is exact and by the provider's own repo identity: "any github binding in the org" would read one team's repo with another team's installation token whenever the first binding happened to be sorted first.

## `apps/server/src/dependencies/manifest-reader.ts`

### §342. The server-side route from a git binding to a read

M21.4 — THE SERVER-SIDE ROUTE FROM "a component's git binding" TO `readFileAtRef` (ADR-0032 §7a).

WHAT WAS MISSING, AND WHY IT MADE M21.2 DEAD CODE
ADR-0032 §7a resolves the released version of an `npm`/`python`/`maven` line by reading the PRODUCING COMPONENT'S OWN MANIFEST at the released commit — "the same 'formulated via the users' code' ingress the inventory itself is built from". M21.2 built the primitive for that as `GitProviderAdapter.readFileAtRef`, and §7a then recorded, honestly, that **no server-side route to it existed**: it is deliberately not an `ExecutorPlugin` verb (§9), and the subprocess plugin host exposed no file-read client. Three of the five ecosystems therefore recorded nothing, every time, under `manifest_reader_unavailable`.

The plugin-host half of that route now exists (`plugin-host/contract.ts`'s `GitFileReadPluginClient`, `host.ts`'s `gitFileRead()`, `subprocess-entry.ts`'s `readFileAtRef` dispatch). THIS file is the other half: which INSTANCE to ask.

THE BINDING IS CHOSEN BY THE REPO, DECLARED, NEVER GUESSED
A read is addressed to a repo — `changes.source_ref.repo`, the repo the release actually came from — and the instance that may read it is the git-provider binding CONFIGURED FOR THAT REPO. Nothing here picks "the org's first github binding", and that restraint is the whole point: those bindings hold credentials, and one binding's installation token is not authority over another team's repository. A repo no binding names yields a legible failure, never a read attempted with somebody else's credential.

The identity a binding names is the provider's own: `projectPath` when it has one (GitLab groups nest), else `owner/repo` (GitHub and Gitea address a repo as exactly two segments). Matching is case-insensitive because all three providers treat repository paths that way, and it is exact — never a prefix, or `acme/widgets` would match `acme/widgets-fork`.

IT READS. THAT IS ALL IT CAN DO.
The client this reaches has exactly one method and it is a GET (charter principle 1, ADR-0032 §9). There is no branch, commit or PR behind this seam, and the bump actuator ADR-0032 §8 describes is explicitly NOT reached this way — it is a managed executor class contingent on a charter amendment.

### §343. The repository a git binding is configured for

The repository a git-provider binding is configured for, as the provider spells it — or `null` when the config names none.

Read from the SAME fields the adapters themselves read (`GithubConfig`/`GiteaConfig` require `owner` + `repo`; `GitlabConfig` prefers `projectPath` and falls back to `owner/repo`, exactly as its own `projectPathOf` does). Reading a different field here than the adapter uses would make this match a binding that then addresses somewhere else.

### §344. The same identity, VERBATIM

The same identity, VERBATIM — the form a request is ADDRESSED to rather than compared with.

`bindingRepoIdentity` case-folds, which is right for deciding "is this the binding for that repo?" and wrong for everything else: `owner/Repo` and `owner/repo` are the same repository to all three providers, but a branch created under the folded spelling is a different string in every audit record and in the pull request's own URL. M21.5's bump dispatcher authors INTO the repo, so it needs what the operator actually configured.

Two functions rather than one with a flag, because the two answers are used for different things and a caller that picked the wrong one would still work — until the first binding configured with a capital letter.

### §345. A reader that resolves the right provider per call

A `ManifestReader` that resolves the right git-provider instance PER CALL and asks it.

Resolution is cached per repo for the life of the reader (one detection run = one change = one repo, so this is normally one resolution serving several manifest paths). The cache is per READER, never module-level: it holds a resolved instance config carrying decrypted secret material, and a process-lifetime cache of that is a different object with different rules.

FAILURES THROW, and that is the port's contract rather than a shortcut: `resolveReleasedVersion` catches a reader throw PER MANIFEST and records `manifest_unreadable` with the message, which is already where an auth failure, a 5xx and an egress refusal land. "No binding names this repo" joins them as one more thing that stopped the file being read, with the cause in the detail — it is not silently treated as "the file is not there", which would be a claim about the repo.

### §346. Several bindings legitimately name one repo

Several bindings legitimately name one repo (a monorepo with a binding per component, or a build and a deploy pipeline on the same repo). They share a repo AND a provider, so any of them reads the same bytes; sorted by binding id so the choice is deterministic across runs rather than whatever order the query happened to return — a reader that resolved differently between two runs of the same change would make the Decision's detail unstable.

### §347. Not stopped afterwards, per the lifecycle rule

NOT `stopInstances`d afterwards, and that is consistent with M21.4's lifecycle rule rather than an omission of it. That rule distinguishes instances derived from a WORK-LIST (the version poll's per-ecosystem indexes — unbounded in tenancy, started on demand, stopped when the sweep ends) from instances derived from operator CONFIGURATION. This is the latter: it is an ordinary executor binding's instance, the same one `reconcile.ts` and `observe.ts` start and leave running, addressed by the same id — so stopping it here would tear down a subprocess those loops are using and force a respawn on their next tick.

## `apps/server/src/dependencies/producer-declaration.ts`

### §348. THE PRODUCER DECLARATION'S EFFECTS, IN ONE PLACE

THE PRODUCER DECLARATION'S EFFECTS, IN ONE PLACE — shared by every door that may write one.

WHY THIS MODULE EXISTS RATHER THAN A SECOND COPY IN THE IaC APPLY PATH
`routes/dependency-producers.ts` was the only writer when it was built. Adding the IaC surface (charter principle 3: API -> SDK -> CLI -> IaC) makes `coordination-as-code/plans-repo.ts`'s apply a SECOND door into `dependency_line_producers`, and a declaration is not a field write — three things happen around it, and every one of them is a correctness or security obligation rather than a nicety:

1. THE HEADS OF EVERY COVERED LINE ARE CLEARED. `resetLineHead`'s own header is the argument, in both directions: on a DECLARE a poisoned public head would otherwise survive the very declaration that exists to undo it (and could never be walked back down, because the write door refuses backward movement); on a RETRACT a head the org's own releases put there is a M22 vendor-scan-rule INPUT, so it can grant a pass against a version no registry published. A door that writes the row and skips this is a door that arms the exact failures the verb exists to prevent. 2. A DECISION IS RECORDED. `routes/dependency-producers.ts` documents `GET /decisions?kind=dependency_line_producer` as answering "every producer declaration ever made in this org". A second writer that skips the Decision makes that sentence FALSE — the class of self-contradiction this repo keeps finding in its own accepted documents — and breaks charter principle 6 for whichever declarations happened to arrive through IaC. 3. AN AUDIT EVENT IS APPENDED, hash-chained in the same transaction as the write.

The three are inseparable from the row, so they live WITH the row rather than beside each caller. `coordination-as-code/plans-repo.ts` and the route call the same two functions; neither reimplements any of it.

WHAT IS *NOT* HERE, AND WHY
The RESOLUTION of a caller-supplied producer reference to a live in-org `component`. The route does it with `assertDeclarableProducer` against an id-or-URN string; IaC does it against the plan diff, where the object's `typeId` is already known and the answer must be re-derivable from the STORED diff at apply time (`plan-diff.ts`'s `invalidProducerDeclarations`). Same rule, two genuinely different inputs — folding them together would mean a DB read on the IaC path that the fail-closed re-check is specifically designed not to need.

### §349. The Decision kind both verbs write

The Decision kind both verbs write. One kind, so `GET /decisions?kind=dependency_line_producer` answers "every producer declaration ever made in this org" in one index descent — a claim that only stays true while EVERY door writes this record, which is why the doors share this module.

AND THESE ACTS DO NOT USE PERSIST-ON-CHANGE (corrected 2026-08-17)
They used to. `insertDecisionIfChanged` keys on `(subject_id, kind)` and the subject here is the PRODUCER, so the comparison asked "is this the last thing this component was said to produce?" — a question about the wrong noun, which SUPPRESSED THE RECORD OF A REAL CHANGE:

```text
declare `@acme/lib` -> P     row written
declare `@acme/lib` -> Q     row written (subject Q; P's declaration is gone — the producers
                             table is keyed on the COORDINATE, so Q displaced P)
declare `@acme/lib` -> P     byte-identical to P's row above -> SUPPRESSED. The coordinate just
                             moved back to P and the Decision log says nothing happened.
```

PUTTING THE COORDINATE IN THE IDENTITY DOES NOT FIX THAT, which is why it is not what was done. The only identity columns are `subject_id` (a `uuid`, and a coordinate is not one) and `kind` — and `kind` is documented in `decisions-repo.ts` as "the caller's own constant, never user input", with an exact-match operator filter and a b-tree behind it; a coordinate string there is unbounded, request-controlled cardinality in an operator's index. More decisively, an identity of `(producer, coordinate)` STILL SUPPRESSES the sequence above: P's last row for this coordinate is still byte-identical to the candidate.

So the suppression is removed instead of re-keyed, and the reason it was never appropriate is in `insertDecisionIfChanged`'s own header: it is "the write-side guard for every Decision writer that re-evaluates on a TIMER rather than on an event". These are neither. Each call is one authorized act by a principal at a wall-clock instant — there is no tick, no at-least-once redelivery, and nothing here re-evaluates. The same header states the pairing rule that made the mismatch visible: "a caller that pairs the Decision with a hash-chained audit event must suppress that event on the same condition (`created === false`)". Both verbs append their audit event UNCONDITIONALLY, and correctly so — the operator really did call the verb. It is the Decision that was wrong to go missing. Growth is bounded by human action, not by a 2s loop.

### §350. THE AUTHORITY EVERY PRODUCER WRITE TAKES

THE AUTHORITY EVERY PRODUCER WRITE TAKES — `policy:write` AT THE ORG ROOT (owner decision, 2026-08-17), expressed ONCE so the route and the IaC apply path cannot drift apart.

Declaring "X produces @acme/lib" changes behaviour for EVERY other component in the org that depends on that coordinate, in two directions at once: their bumps start being triggered by X's production releases, AND the coordinate stops being polled against its public index. The declarer is affecting objects they may not own.

`object:write` at X is INSUFFICIENT on this repo's own precedent — `governance/policy-scope-authz.ts` is the authority: custody of a row is not jurisdiction over what it reaches, and an actor holding authority at a single component "must still be refused an org-wide scope". The mechanics agree: `scopeExpandCte` expands strictly UPWARD, so a component-bound principal reaches nothing sideways, and the consumers of `@acme/lib` are siblings, not descendants.

`policy:write` at the ORG ROOT is what that same file already requires for "anything broader … which can match objects org-wide … has org-wide blast radius". The producer declaration has org-wide blast radius in exactly that sense, so the established rule lands on the established answer — with NO new `Permission` union member, no seed change and no new binding to provision. A dedicated `dependency_producer:write` buys real least-privilege and is the named upgrade path; until every estate's bindings are provisioned it would be open only to principals who already hold this, so it is not the first cut.

THE SHAPE IS A PAIR, NOT A CALL, because the two doors consume authority differently and must still agree on it: the route authorizes inline, while `coordination-as-code/plans-repo.ts` pushes every check into one list its route drains to completion BEFORE any mutation runs. Both read this function, so the permission AND the scope have exactly one definition. The org root object id IS the org id (bootstrap invariant), the same scope `assertPolicyScopeWithinAuthority` uses.

### §351. The names behind a set of object ids

The names behind a set of object ids — ONE batched `objects` read, in the org, tombstones INCLUDED (a declaration is a stored fact; the name is what it was — the same reading the inventory row's `producer` takes in `dependency-read-surface.ts`). An id that names no row in this org resolves to `""`, never to a throw: the wire view is a courtesy on top of the id, and a dangling reference is the id's problem to report, not the name's.

### §352. THE WIRE VIEW of stored declarations

THE WIRE VIEW of stored declarations — the rows plus the producer's and the declarer's names (dependency-subscription-ui.md §12.6 Q1, owner 2026-08-18). One batched lookup for the whole list, so `GET /dependencies/producers` costs two queries however long the org's list is.

### §353. THE BLAST RADIUS

THE BLAST RADIUS: every major line of the coordinate, its current head, and WHICH COMPONENTS are subscribed to it.

The subscriber set is derived from M21.3's resolution and is NOT re-expressed here — the components that DECLARE the line (`listComponentsDeclaringLine`, M21.2's reverse lookup) narrowed through `listSubscribedComponentLines`, which applies `mergeDependencySubscription` itself. This report therefore cannot disagree with what the resolve API or a UI says.

THE ACTOR IS THE REQUESTING PRINCIPAL, not the system sentinel, for the same reason the inventory backfill threads it: `matchPoliciesForTargets` resolves `scope.group` against the actor, so a human running this sees the same enablement the resolution API reports to them.

### §354. Declare: write the row, clear the heads, record it

DECLARE: write the row, clear every covered line's head, record the Decision, append the audit event. The whole act, so no door can perform a fraction of it.

`declaredByObjectId` is `actorObjectId` and is NEVER caller-supplied (principle 6 — a provenance label the asserter typed is not an answer to "who asserted this"). Both doors take it from authenticated state: the route from the bearer subject, IaC apply from the applying principal.

### §355. Read before the upsert, since the write overwrites it

READ BEFORE THE UPSERT, because `declareDependencyLineProducer` overwrites it. Whether this act TRANSFERS the coordinate from another component is the single most consequential thing a declare can do that the request does not say, and until it went on the record nothing distinguished "P is declared" from "the coordinate was taken from Q and given to P" (charter principle 6). `null` means the coordinate was third-party until now.

### §356. CLEARING THE HEAD IS PART OF DECLARING

CLEARING THE HEAD IS PART OF DECLARING: a poisoned public head (the stranger's `9.9.9`) would otherwise survive the declaration that exists to undo it, and internal detection could never move the head back down to the org's real `2.1.0` because that is backward movement and the write door refuses it.

IT CLEARS WHAT IS STANDING; IT DOES NOT KEEP THE LINE CLEAN. A poll that fetched its answer BEFORE this transaction can commit it AFTER, which was measured to put a public `2.99.0` back on the line permanently. What makes the remedy durable is rule 0 at the write door — `recordDependencyLineHead` re-reads this declaration under the same `FOR UPDATE` — so an in-flight poll is refused with `line_is_internal`. This clears the past; rule 0 refuses the future; removing either re-opens the hole in its own direction.

### §357. Retract: delete the row, clear the heads, report

RETRACT: delete the row, clear every covered line's head, report the bumps already in flight, record the Decision, append the audit event.

`existing` is passed in rather than re-read because both doors have already had to establish it: the route 400s when nothing is declared, and IaC apply reaches here only from a `delete` diff entry whose row it has just looked up.

### §358. Clearing the head is part of retracting, and is security

CLEARING THE HEAD IS PART OF RETRACTING, and this is the direction that is a security fix rather than a wedge fix — see `resetLineHead`'s header. `latest_version` is an input to the M22 vendor scan rule, so a head left over from the internal era, on a coordinate that is third-party again, can grant a vendor-pass against a version no registry published.

AND THE SYMMETRIC RACE IS CLOSED AT THE WRITE DOOR, not here: an internal-release derivation already past its phase-1 producer read can commit its phase-3 head write after this transaction and re-poison the line. `recordDependencyLineHead`'s rule 0 refuses that with `line_is_third_party`, because this loop and that write take the same `FOR UPDATE`.

## `apps/server/src/dependencies/subscription-authoring-guard.integration.test.ts`

### §359. THE GUARD IS WIRED

THE GUARD IS WIRED — proven through the real HTTP routes, not by calling the function.

`subscription-authoring-guard.test.ts` proves the guard DECIDES correctly. It cannot prove the guard RUNS: it calls `assertEnforceableDependencySubscriptionScope` directly, so deleting its installation leaves that whole suite green. Measured, not assumed — that mutation was applied and the unit suite stayed at 649 passed (the count before this round's cases were added).

That is this repo's documented "green for the wrong reason" class in its most ordinary form: a correct component and an unpinned installation look identical from the component's own tests. So this file exercises the policy routes themselves.

THREE THINGS IT PINS, and each exists because it caught something:

1. ALL THREE VERBS. `typed-registries.ts` reaches the write path from POST, from PATCH-with-properties and from PUT. The first cut of this file used POST for all four cases, so a guard installed on only one of the three would have looked fully covered.

2. THE NARROWING. A policy carrying `group` AND `objectRef` is PERMITTED, because `matchPoliciesForTargets` records the `objectRef` match independently of the group branch — the policy contributes for every caller and the hazard is absent. The first cut refused it, which is a 400 telling the author to do exactly what they had already done.

3. THE OTHER COMPOSED CHECK, PROVEN BY A REFUSAL. `validateWrite` still runs `assertPolicyScopeWithinAuthority`. The first cut "proved" that by asserting a policy write SUCCEEDS — which cannot distinguish "the check ran and passed" from "the check was deleted", while this header claimed it proved the latter. It now asserts a refusal ONLY that check can produce (a service-scoped author declaring an org-wide scope → 403), which fails the moment the check is removed.

The refusal itself no longer lives in the route — it moved to `graph/objects-repo.ts`'s `createObject`/`updateObject` choke point; see `subscription-guard-write-doors.integration.test.ts` for the three other doors that exposed why. This file stays route-level on purpose: the typed `/policies` routes are the surface an author actually types at, and "the refusal reaches the wire with its remedy intact" is a property of the whole stack, not of a repo function.

### §360. This used to be the guard's narrowness control

This case USED to be the guard's narrowness control, on M21.3's reasoning that failing to match leaves it not-enabled and nothing is lost. M21.4 refused it on a reason that has since been retired as FALSE (ADR-0032 §6a-ii): "the jobs resolve as `SYSTEM_ACTOR_ID`, which is `member_of` nothing, so the enable never contributes for them". Group scope's OWNING half ignores the actor, so it can contribute. The refusal stands on the ground that survived: a group-scoped effect's reach is decided by membership and by mutable `owns` edges rather than by what the author wrote, in either direction. The narrowness controls the direction axis no longer provides are supplied by the objectRef and no-scope cases below and beside it.

### §361. THE NEGATIVE CONTROL THE WIDENING NEEDS

THE NEGATIVE CONTROL THE WIDENING NEEDS. Without it, the refusal above is equally satisfied by a guard that rejects every group-scoped policy or every dependencySubscription enable — exactly the over-broad shape clause 6a-i(b) narrowed away, and the one a direction widening is most likely to reintroduce. The `objectRef` branch reaches exactly what it names, for every caller, so this enable's reach is what the author wrote and is not fail-open.

## `apps/server/src/dependencies/subscription-authoring-guard.test.ts`

### §362. The guard's whole value is that it is NARROW

The guard's whole value is that it is NARROW: it refuses exactly one authoring SCOPE and leaves everything else alone. So the negative controls below carry as much weight as the refusal — a guard that rejected more than it should would be indistinguishable, from the refusal test alone, from one that works.

M21.4 WIDENED IT BY ONE AXIS AND ONE ONLY (ADR-0032 §6a, 2026-08-15): the refusal covers a group-scoped ENABLE as well as a group-scoped opt-out. Every OTHER narrowing is unchanged and is still pinned below — the scope narrowing especially, since widening the direction axis is exactly the kind of edit that quietly widens a second one.

WHY M21.4 WIDENED IT IS NOT WHY IT STAYS WIDE (ADR-0032 §6a-ii, 2026-08-17). M21.4's stated reason — "the acting job is the system sentinel, which belongs to no group, so a group-scoped enable is permanently inert" — is FALSE, and was false on the day it was written: ADR-0016 §2a shipped group scope's OWNING half (`policy-resolve.ts:313`, `:150-173`), which never reads the actor, so such an enable DOES fire for `SYSTEM_ACTOR_ID` wherever the group owns anything on the chain (`governance/group-scope-ownership.integration.test.ts:188`). The refusal now rests on ONE ground in both directions: a group-scoped effect's reach is decided by membership and by MUTABLE `owns` edges rather than by what the author wrote — which for an opt-out is a fail-open, and a trapdoor, because deleting an `owns` edge silently re-subscribes. The assertions below are on the message's CLAIM, so they fail if that reasoning is ever reverted into the message.

### §363. M21.4 refused this case

M21.4 refused this case (ADR-0032 §6a) on the reasoning that the acting job is the system sentinel and so the enable is permanently INERT. §6a-ii retired that reasoning as false — the owning half of group scope ignores the actor entirely — while keeping the refusal. What the message must now say is the true failure: a group-scoped enable applies wherever the group OWNS something on the chain, a set the author never named and that changes when ownership is edited.

### §364. The narrowing: group must be the only scope to refuse

THE NARROWING: `group` must be the ONLY scope for the refusal to fire.

`matchPoliciesForTargets` runs the three scope branches INDEPENDENTLY — `objectRef` (policy-resolve.ts:271-279) and `selector` (:281-290) each record a match before the `group` branch (:292-322) is reached. So a policy carrying group AND one of the others contributes for every caller through that other route, the hazard is absent, and the 400 was telling the author to do what they had already done.

## `apps/server/src/dependencies/subscription-authoring-guard.ts`

### §365. A group-scoped effect is refused at authoring time

A GROUP-SCOPED `dependencySubscription` EFFECT IS REFUSED AT AUTHORING TIME — IN BOTH DIRECTIONS — because neither direction can be relied on to do what it says.

WHY THIS GUARD EXISTS AND WHY IT LIVES HERE RATHER THAN IN THE MATCHER
A `scope.group` policy matches on EITHER of two independent halves (DESIGN §10.1's "acting or owning subject"; `governance/policy-resolve.ts:292-322`): (i)  THE ACTING HALF (`:298`, via `isMemberOf` at `:104-123`) — the ACTING SUBJECT is a transitive `member_of` the group. (ii) THE OWNING HALF (`:313`, via `ownedByGroupOrItsMembers` at `:150-173`) — the group, or any transitive `member_of` member of it, holds an `owns` edge on SOMETHING IN THE TARGET'S CONTAINMENT CHAIN. This half NEVER READS `actorObjectId`. Either is right for "this rule governs work done by, or on the things owned by, this group". Neither is sufficient for a CONSTRAINT, because a constraint that fails to match is a constraint that does not apply — and whether either half matches is a fact about membership and ownership, never a fact about what the author wrote.

THE OPT-OUT DIRECTION — fails OPEN, AND SINCE 2026-08-17 THIS IS THE SOLE GROUND FOR THE REFUSAL (ADR-0032 §6a-ii). Where the named group owns nothing on the component's chain and the actor is not a member, a group-scoped OPT-OUT contributes nothing: `disabledBy` is never set (`subscription-resolution.ts:342-348`) and the AND at `:402` returns STILL-ENABLED. SCP then authors a bump for a dependency a team explicitly opted out of, which is precisely the case the opt-out exists to serve: "one or more dependencies are causing issues when upgraded, so we want to handle that manually" (the owner's stated requirement, proposal §1).

IT IS NOT A CORNER CASE. The ENABLE routinely arrives from a broader, actor-independent scope — an org- or service-wide `objectRef`, or a `selector` — while the opt-out is the narrow, team-shaped thing someone writes at group scope. NOTHING TIES THE TWO SCOPES' REACH TOGETHER, so "the enable applied here" implies nothing whatever about "the opt-out will apply here".

The failure is silent in both halves — the matcher returns fewer rows, the merge sees fewer contributions, and `enabled: true` is a perfectly ordinary-looking answer. Nothing errors and nothing logs. An operator would learn about it from a pull request they explicitly asked never to receive.

AND THE OWNING HALF SHARPENED THIS RATHER THAN SOFTENING IT: ITS REACH IS MUTABLE GRAPH DATA. `owns` edges are created and deleted at runtime through the ordinary ownership API (`routes/ownership.ts:156-165` creates one, `:235-262` deletes one, both plain `relationship:write`). For a policy that TIGHTENS — every enforcing consumer ADR-0016 §2a was written for — that is exactly right and monotone. For an OPT-OUT the same property is a FAIL-OPEN TRAPDOOR: revoking an `owns` edge, in a re-org or a cleanup that is not about this policy at all, silently RE-SUBSCRIBES a component whose team opted out. No error, no log, and no Decision that says a subscription came back.

THE ENABLE DIRECTION — STILL REFUSED, BUT NOT FOR THE REASON THIS FILE USED TO GIVE (ADR-0032 §6a-ii, 2026-08-17)
M21.3 permitted a group-scoped ENABLE on the reasoning that failing to match yields NOT-enabled, which is the safe direction. M21.4 refused it on the reasoning that it is PERMANENTLY INERT: the background jobs resolve as `SYSTEM_ACTOR_ID` — the all-zero sentinel which by its own doc comment is "never a real graph object id (no `objects` row exists at this id)" (`coordination/system-actor.ts:9`) — and a principal with no `objects` row is a transitive `member_of` nothing.

THAT SECOND REASONING IS FALSE, and was already false the day it was written. ADR-0016 §2a (PR #237, 2026-08-15 — the same date M21.4 widened this guard) shipped the OWNING half above, and that half does not consult the actor at all. So a group-scoped ENABLE **does** fire for `SYSTEM_ACTOR_ID` wherever the group owns anything on the chain; `governance/group-scope-ownership.integration.test.ts:188` ("it applies to SYSTEM_ACTOR_ID too") pins exactly that. Do not re-derive "inert" from the sentinel's membership: that fact is still true, and it is now irrelevant.

WHAT THE ENABLE DIRECTION RESTS ON NOW, stated honestly rather than re-justified: its own original ground is gone and no equally strong one replaces it. What remains is the same mutable-reach property read the other way — such an enable fires exactly where the group HAPPENS to own something on the chain, which is a fact about the ownership graph rather than a set the author named, and it changes whenever an `owns` edge does. It is kept in the refusal for three reasons, in decreasing weight: the remedy is identical (`objectRef`/`selector`), so the cost of keeping it is only ergonomic; one scope kind must not mean two different things depending on the sign of `enabled`, or authors end up reasoning about this guard instead of about scope; and re-permitting it would reopen the narrowing below, which is proven and load-bearing.

THIS CAN BE RELAXED for the enable direction if a future design resolves subscriptions PER OWNER DELIBERATELY — taking each subscribing component's own team as an explicit input rather than inheriting whatever the ownership graph happens to say. NOTE THE TRIGGER HAS MOVED: the old wording ("once the actor is no longer the system sentinel") no longer names anything, because the owning half made the actor irrelevant.

SO WHY NOT FIX THE MATCHER? The matcher WAS fixed, on its OTHER consumer's terms: ADR-0016 §2a added the owning half for `scanThreshold`, in the TIGHTENING direction, which is why it needed no permission from this feature. What survives of the original argument is its boundary, not its prohibition — this guard governs THIS FEATURE'S USE of the matcher and changes no matcher behaviour. A group-scoped scan CEILING that matches on neither half still leaves the effective threshold LOOSER than the operator authored; that residue belongs to the matcher, is tracked for both consumers at once, and is not touched here.

What this guard does instead is REFUSE TO DEPEND ON A REACH NOBODY DECLARED. It converts a silent fail-open at evaluation time into a loud refusal at authoring time, which is the same move `0061`'s declared-producer CHECK makes: make the unusable state unrepresentable rather than guarded. An author who wants a group-wide opt-out writes it at `objectRef`/`selector` scope, whose reach is exactly what the author wrote down.

WHERE IT IS INSTALLED — THE CHOKE POINT, NOT THE ROUTE (M21.3 review round)
First cut installed this in ONE place: the composed `validateWrite` of the typed `/policies` routes. Its sibling check `assertPolicyScopeWithinAuthority` was already installed in THREE (that same config, plus `coordination-as-code/plans-repo.ts`'s create and update branches) — which is the tell that "the typed route" was never the boundary. Measured, not reasoned about: a manifest declaring `{typeId:"policy", properties:{scope:{group:"team-platform"}, effects:[{dependencySubscription: {enabled:false, coordinate:"acme-lib"}}]}}` applied cleanly through `POST /plans` + `/plans/{id}/apply` and the object read back, while `POST /api/v1/federation/hand-fill` and `POST /api/v1/federation/overlays` (free-form `typeId`, `object:write`) planted the same document.

The fix is NOT a fourth, fifth and sixth call — that is the same rake, and the seventh door would miss it again. It is installed at `graph/objects-repo.ts`'s `createObject`/`updateObject`, the ONE choke point every local write door funnels through, following the M16.2 clause-(4) precedent that already lives there. See those two call sites for the exemption and its census.

STILL DELIBERATELY NARROW, in two ways rather than the original three. Only the `policy` TYPE is inspected, and only when `group` is the ONLY scope the policy carries. Every other effect type is untouched and every other object type is untouched — this guard must not become the place where unrelated policy rules accumulate. What it no longer narrows on is the effect's DIRECTION: both `enabled: false` and `enabled: true` are refused — since ADR-0032 §6a-ii, on ONE ground rather than two.

WHY `group` MUST BE THE *ONLY* SCOPE FOR THIS TO REFUSE
`matchPoliciesForTargets` evaluates the three scope kinds INDEPENDENTLY, not as alternatives: the `objectRef` branch (`policy-resolve.ts:271-279`) and the `selector` branch (:281-290) each record a match on their own, before the `group` branch (:292-322) is even reached, and the `record()` map dedups by (policy, matched object). So a policy carrying BOTH `group` and `objectRef` contributes for EVERY caller through the `objectRef` route, whatever the group's membership or ownership says. The hazard this guard exists for is simply absent there, and refusing it would emit a 400 telling the author to do the thing they had already done.

RESIDUAL, stated rather than papered over: "carries an `objectRef`/`selector`" is a STRUCTURAL test, not a proof that the non-group scope will actually match something. An `objectRef` naming a URN that resolves to nothing, or a `selector` whose labels no object carries today, leaves the group branch as the only live route and the original hazard with it. That is deliberate and it is not fixable at this layer: a `selector` is designed to match objects that do not exist yet, so "does this scope match anything right now?" is not a question authoring time can answer for the general case — and answering it for `objectRef` alone would make the guard's behaviour depend on which of two equally-broad scope kinds the author happened to pick. The over-broad refusal this narrowing removes was a certain, everyday false positive; the residual is a dangling reference, which is already broken in ways this guard is not responsible for.

### §366. The object type being written

The object type being written. The guard applies to `policy` ONLY — `listPolicyCandidates` (`policy-resolve.ts:71-87`) selects `type_id = 'policy'` and nothing else, so a `dependencySubscription` effect on any other type is never resolved and carries no hazard. Taken as an argument rather than checked by each caller so that every installation site — including the free-form-`typeId` doors (hand-fill, overlay, IaC manifests) — is correct by construction instead of by remembering.

### §367. Mirrors the matcher's own truthiness tests exactly

Mirrors the matcher's own truthiness tests exactly, because what matters is whether the OTHER branch runs, not whether the field looks plausible: - `if (scope.objectRef)` at :271 — a non-string or empty value reaches `resolveRef` and resolves to nothing, so it is not a live route; - `if (scope.selector?.labels)` at :281 — note `{}` IS live: `labelsMatch` is an `every()` over zero entries, which is `true` for every ancestor. `selector: {}` with no `labels` is not.

### §368. BOTH DIRECTIONS, ONE REMEDY, ONE GROUND

BOTH DIRECTIONS, ONE REMEDY, ONE GROUND (ADR-0032 §6a-ii) — the message names the direction's own failure, because "scope it differently" without the reason is an instruction an author has to take on faith. It must NOT say "the job belongs to no group": that was the M21.4 wording and it is false (§6a-ii), and an author who checks it will find a counter-example and dismiss the whole refusal.

### §369. Enabling for a component whose repository delegates

M21.5 — ENABLING SUBSCRIPTIONS FOR A COMPONENT WHOSE REPOSITORY ALREADY DELEGATES IS REFUSED (charter `scp-managed-dep` amendment 2026-08-13; ADR-0032 §8)
"CommanderSCP refuses to enable dependency subscriptions for a component whose repository already delegates the same manifests to another dependency-update system."

WHY IT LIVES BESIDE THE SCOPE GUARD, AND AT THE SAME CHOKE POINT. Everything this file's header establishes about WHERE an authoring-time refusal belongs applies here unchanged and is not re-argued: the typed `/policies` route was never the boundary, three free-form-`typeId` doors (`POST /plans` + apply, `POST /federation/hand-fill`, `POST /federation/overlays`) reach `createObject` with the same document, and adding a fourth, fifth and sixth call rebuilds the same rake. So this is installed at `graph/objects-repo.ts`'s `createObject`/`updateObject` — the ONE choke point every local write door funnels through — with the identical `federationImport` exemption and the identical closing of that exemption at `handfill-repo.ts`.

WHY IT IS ASYNC WHEN ITS SIBLING IS NOT. The sibling decides from the DOCUMENT alone. This one needs a fact about a repository, and the fact cannot be fetched here: `createObject` runs inside a tenant transaction holding two per-org advisory locks to commit, and provider I/O there would hold them across a network call. The fact is therefore probed asynchronously (where the repository is already being read) and persisted as a Decision; this performs ONE indexed read of it. See `delegation-detection.ts`'s module doc for why a Decision is the right home rather than a convenient one, and for what an ABSENT probe means.

ONLY AN ENABLE IS REFUSED. An `enabled: false` effect is an OPT-OUT, and refusing to author an opt-out for a delegating component would refuse the very document that turns SCP's authoring OFF — the direction the conflict wants. So the direction is read, not just the presence of the effect. (Note the contrast with the scope guard above, which refuses BOTH directions: there, both directions were broken; here, only one of them can collide with another actuator.)

ONLY AN `objectRef` SCOPE CAN BE DECIDED HERE, AND THE RESIDUAL IS COVERED ELSEWHERE. A `selector`-scoped enable names no component — by design, since "a `selector` is designed to match objects that do not exist yet" (this file's own residual note on the sibling guard). There is therefore no repository to have probed, and no refusal that could be issued honestly. That gap is NOT left open: `dependencies/bump-actuator.ts` re-reads the same standing verdict before every authored bump, so a component reached by a selector-scoped enable is refused at the moment SCP would write to it. One stored fact, two readers, neither fail-open.

A 409 RATHER THAN A 400, carrying the probe's `decision_id`. This is not a malformed document — it is a well-formed one that conflicts with the state of the world, which is what 409 means; and charter principle 6 requires every blocked response to carry a `decision_id`, which here is the probe that found the file. An operator can `GET /decisions/{id}` and see exactly which config was read, at which ref, and which manifests it claimed.

## `apps/server/src/dependencies/subscription-guard-write-doors.integration.test.ts`

### §370. ADR-0032 §6a AT THE CHOKE POINT

ADR-0032 §6a AT THE CHOKE POINT — EVERY LOCAL WRITE DOOR, AND THE ONE EXEMPTION.

THE HOLE
M21.3 installed the group-scoped-opt-out refusal in ONE place: the composed `validateWrite` of the typed `/policies` routes. Its SIBLING in that same composition, `assertPolicyScopeWithinAuthority`, was installed in THREE (that config plus `coordination-as-code/plans-repo.ts`'s create and update branches) — the tell that the typed route was never the boundary. Censusing the sibling turned up three doors that reach `createObject` with a free-form `typeId` and free-form `properties` and never pass through `typed-registries.ts` at all. Each was REPRODUCED with the exact document the typed route answers 400 to, before the fix:

```text
1. IaC — `POST /plans` + `POST /plans/{id}/apply` applied a manifest declaring
   `{typeId:"policy", properties:{scope:{group:"team-platform"}, effects:[{dependencySubscription:
   {enabled:false, coordinate:"acme-lib"}}]}}`, and the object read back. `routes/plans.ts`
   claims IaC enforces "the exact same governance gates the typed /policies routes enforce";
   M21.3 made that comment false.
2. HAND-FILL — `POST /api/v1/federation/hand-fill`, free-form `typeId` + `properties`, any
   `federation:write` holder.
3. OVERLAY — `POST /api/v1/federation/overlays` with `typeId: "policy"`, authorized with plain
   `object:write`.
```

The fix is NOT three more calls — that is the same rake, and the fourth door would miss it again (BUILD_AND_TEST.md §4.4). It moved to `graph/objects-repo.ts`'s `createObject`/`updateObject`, the one choke point every local write door funnels through, following the M16.2 clause-(4) precedent that already lives there.

WHAT THIS FILE ASSERTS, AND WHY THE LAST CASE IS THE IMPORTANT ONE
Each door refuses AND writes nothing — a refusal that still stored the row would satisfy a status assertion. Then the negative control: a policy carrying the IDENTICAL document, arriving over a genuinely signed federation bundle, is ACCEPTED and does not abort its bundle.

That exemption is narrow and deliberate. `federation/import-repo.ts`'s `object_upsert` branch has NO try/catch, so a throw there aborts the WHOLE bundle and wedges the channel (proposal §10 Q6); the authoring instance is where an authoring-time refusal belongs. But `federationImport` is set by TWO modules, not one — `import-repo.ts` and `federation/handfill-repo.ts` (census re-run filterless for this change; there is no third) — and hand-fill is a local operator action with no channel to wedge. So hand-fill calls the guard for itself, and case 2 below is what proves the exemption did not swallow it.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
See the PR body. Every case here was watched fail against the pre-fix tree.

### §371. THE EXEMPTION, AND ITS EXACT WIDTH

THE EXEMPTION, AND ITS EXACT WIDTH — a REAL federation import of the very same document.

This is the negative control for everything above: if the choke-point guard had been installed without the `federationImport` skip, this bundle would abort at `import-repo.ts`'s `object_upsert` branch (which has no try/catch) and wedge the channel for every later entry too — proposal §10 Q6. If the skip had instead been made blanket, DOOR 2 above would be green-by-accident.

The exporter plants the entry with `appendJournalEntry` rather than through a route, because the commander's OWN guard refuses to author this document — which is the point of the whole clause. What arrives is therefore exactly what a peer running a build without the guard (or a future build with a different rule) would ship: a properly chained, properly signed `policy_upsert` carrying a group-only opt-out.

## `apps/server/src/dependencies/subscription-resolution.integration.test.ts`

### §372. M21.3 — THE ENABLEMENT CHAIN AGAINST REAL POSTGRES

M21.3 — THE ENABLEMENT CHAIN AGAINST REAL POSTGRES (ADR-0032 §3a/§6, migration 0062).

The pure algebra is proven without a database in `subscription-resolution.test.ts`. THIS file proves the five things that only a real database and the real policy machinery can:

```text
1. THE SUBSTRATE LANDED. `dependency_subscription_unlock` exists, ships EMPTY (no row = locked),
   is tenant-READABLE and tenant-UNWRITABLE — both barriers from 0062's header, probed with a
   RAW `scp_app` connection rather than through application code.
2. A `dependencySubscription` EFFECT VALIDATES on a real `policy` object, and the malformed
   shapes are refused at AUTHORING TIME (400) rather than resolving to nothing later. That is
   the half of "absent never means enabled" that lives in the JSON Schema.
3. THE WORK-LIST IS DERIVED, NOT FILTERED. A disabled component and an opted-out line are absent
   from `listSubscribedComponentLines`, and the enabled ones are present — the negative control
   without which the absences prove nothing.
4. TIER LABELS COME FROM `typeId`, NOT FROM POSITION, over a REAL four-rung containment chain
   (org -> containment domain -> service -> component). `containmentChain` can hand back a chain
   whose index 0 is not the org (BUILD_AND_TEST.md M21.3's "root labels can lie"), so this is
   asserted rather than assumed.
5. THE CEL-CONDITION WIRING EXISTS, over a policy whose `condition` was AUTHORED THROUGH THE
   API. The pure merge honours `candidate.conditional`, but the line that SETS it from
   `match.condition` was pinned by NOTHING — deleting it left every unit and every integration
   test green while a conditional ENABLE silently became an unconditional one.
```

Plus the property that makes ADR-0032 §3a consequence 4 true rather than merely intended: a policy carrying a `dependencySubscription` effect adds NOTHING to what the gate enforces.

INSTANCE-GLOBAL FIXTURE, HANDLED LIKE THE SCAN FLOORS. `dependency_subscription_unlock` has no `org_id` and the integration suite runs `singleFork` against ONE shared Postgres, so the row is deleted at teardown no matter how this file exits — a stray unlock is inert for every other suite today, but "inert today" is not a reason to leak deployment state out of a test file.

### §373. The same property as the enum above, one level up

THE SAME PROPERTY AS THE ECOSYSTEM ENUM ABOVE, one level up: a selector that fails to bind must void ITSELF, not the constraint. Ajv is compiled with `strict: false` (`graph/property-validation.ts:14`), so without `additionalProperties: false` an unknown key raises nothing here AND is then STRIPPED by the resolver's parse — arriving at the merge as an effect with NO selectors, i.e. a WILDCARD. One transposed character would subscribe every dependency line in the scope, and the same typo on an opt-out would wildcard the DISABLE.

### §374. (5) A REAL CEL `condition` ON A REAL POLICY

(5) A REAL CEL `condition` ON A REAL POLICY — the wiring, not just the flag

The pure merge honours `candidate.conditional` and `subscription-resolution.test.ts` pins both of its directions. What NOTHING pinned is the line that SETS it: `gatherSubscriptionCandidates` reading `match.condition` off the matched policy. Deleting that one spread left all 26 unit and all 13 integration tests green, because every test that exercised a condition hand-built the flag instead of authoring a policy that carries one. With the wiring gone a conditional ENABLE becomes an unconditional one, and `{"condition": "env == \"prod\""}` subscribes a component the condition excludes — the exact fail-open the module doc calls out as load-bearing.

So this suite authors the condition through the API and reads the flag back out of the real matcher. Nothing here hand-sets `conditional`.

## `apps/server/src/dependencies/subscription-resolution.test.ts`

### §375. M21.3 — THE ENABLEMENT MERGE, as a pure function

M21.3 — THE ENABLEMENT MERGE, as a pure function (ADR-0032 §6).

```text
  effective_enabled(component, line) =
      instance_unlocked  AND  component_enabled  AND  NOT line_opted_out
```

Every property below is a property of the ALGEBRA, not of a database, which is exactly why the merge was extracted as a pure function (BUILD_AND_TEST.md §4.1). No Postgres here; the DB-backed half is proven in `subscription-resolution.integration.test.ts`.

Seven properties are load-bearing and each is asserted in the direction that can FAIL OPEN:

1. ABSENT NEVER MEANS ENABLED. No contributions ⇒ not enabled. 2. THE INSTANCE LEVEL UNLOCKS AND NEVER ACTIVATES. `unlocked` alone enables nothing (ADR-0006: managed execution is never a default). 3. A DISABLE ALWAYS WINS over any number of enables at any tier. 4. ORDER-INDEPENDENCE — proven by exhausting every permutation of the contribution list, not by one hand-picked shuffle. 5. MOST-RESTRICTIVE-WINS for `granularity` and `delivery`; auto-merge is never acquired by merging two policies that each meant something safer. 5b. SILENCE IS A VOTE, NOT AN ABSTENTION. (5) only ever composes two DECLARED values, and the composition that can fail open is SILENT + DECLARED — a component that authored `{enabled: true}` beside an org-wide `auto_merge`. Pinned in both arrangements. 6. A MISTYPED SELECTOR KEY IS REFUSED, NOT STRIPPED INTO A WILDCARD — on an enable AND on an opt-out, the two directions being loose in different senses. 7. A WILDCARD IS RECORDED EXPLICITLY (`selector: {}`), so an explanation never leaves "matched everything on purpose" and "matched everything by accident" looking alike.

Every assertion of an ABSENCE carries a NEGATIVE CONTROL in the same test — a test proving nothing happened is vacuous unless it also proves the thing that SHOULD happen did. Concretely: each "not enabled" case is re-run with the one blocking element removed, and must come out enabled.

### §376. (5b) SILENCE IS A VOTE, NOT AN ABSTENTION

(5b) SILENCE IS A VOTE, NOT AN ABSTENTION — the silent+declared composition

Every case above compares two DECLARED values, which is the composition that cannot fail open. The one that CAN is silent-plus-declared: a component team authors `{enabled: true}` and says nothing about delivery, and an ORG-WIDE policy declares `auto_merge`. If absence were "no opinion", the MIN would be taken over the declared value alone and the team would be handed the privileged option — SCP merging commits into their repo with no pull request — by a policy they do not own and never read. ADR-0032 §8 puts the choice with the TEAM; 0062's header says auto-merge is "never inherited from silence".

So a silent contribution votes for the DEFAULT, and the answer to "may a broader scope grant auto-merge to a narrower one that stayed silent?" is NO, pinned in both directions below.

## `apps/server/src/dependencies/subscription-resolution.ts`

### §377. M21.3 — DEPENDENCY-SUBSCRIPTION ENABLEMENT RESOLUTION

M21.3 — DEPENDENCY-SUBSCRIPTION ENABLEMENT RESOLUTION (ADR-0032 §3a, §6).

Computes whether ONE (component, dependency line) pair is subscribed, as a MONOTONE AND across three levels, top-down:

```text
  effective_enabled(component, line) =
      instance_unlocked  AND  component_enabled  AND  NOT line_opted_out
```

A DEPENDENCY SUBSCRIPTION IS NOT AN OBJECT TYPE. It is a `dependencySubscription` EFFECT on an ordinary `policy` object (ADR-0032 §3a), so the entire org-and-below half of this module reuses the EXISTING machinery unchanged: `matchPoliciesForTargets` (org-rooted policy matching over `containmentChain`) gathers the contributing documents and this file only reads an effect out of them and folds it into the AND. No new resolution engine, no new matching rules, no new tables below the instance level. That is the same division of labour `governance/scan-requirements.ts` has, and this module is deliberately its structural twin.

ATTACHMENT IS THE POLICY'S `scope`, NOT A `governed_by` EDGE. ADR-0032 §3a describes the subscription as attached by `governed_by`, and `governed_by` is indeed the registered (organization|domain|service|component|team) -> policy relationship — but NOTHING in policy resolution reads it today: `policy-resolve.ts:22` records it as the natural later optimization behind the same function signature, and the shipped matcher works off `scope.objectRef` / `scope.selector` / `scope.group`. Mirroring `scanThreshold` "in every structural respect" means mirroring THAT, so a subscription is authored at a scope exactly as a scan ceiling is. If `governed_by` is ever materialised into the matcher, this module inherits it for free.

ABSENT NEVER MEANS ENABLED. The AND's default is OFF at every level: no unlock row means locked, no matching contribution means not enabled, and an effect with no `enabled` key does not parse at all (0062's JSON Schema requires it, so it is refused at authoring time too). This is §6's reading of the "absent never means zero" rule `scan_requirement_floors` established — with the inversion that matters, because there "absent = 0" would have been the TIGHTEST reading and here "absent = enabled" would be the LOOSEST.

ABSENT IS NEVER THE LOOSER OPTION FOR THE SETTINGS EITHER, AND THAT IS A SEPARATE RULE. `enabled` is required; `granularity` and `delivery` are optional, and an omitted one is NOT an abstention — it is a vote for the most restrictive value (`patch`, `pull_request`). The MIN is therefore taken over EVERY enabling contribution, silent ones included, so auto-merge is reached only when every contribution that enabled this pair asked for it. A BROADER SCOPE MAY NOT GRANT AUTO-MERGE (OR A LOOSER GRANULARITY) TO A NARROWER ONE THAT STAYED SILENT — see the comment at the MIN itself for the failure this rules out and the ergonomic cost it accepts.

A MISTYPED SELECTOR KEY IS REFUSED, NOT STRIPPED. `DependencySubscriptionEffectSchema` is a `strictObject`, so `{enabled: true, coordinat: "@acme/lib"}` does not parse. A plain `z.object` would have STRIPPED the unknown key and handed `effectMatchesLine` an effect with no selectors — a WILDCARD — so one transposed character would subscribe every line in the scope, and the same typo on an opt-out would wildcard the DISABLE. That is the property 0062 already argues for a bad ecosystem VALUE ("a voided selector fails OPEN"), and a key is the other half of it. 0062's `additionalProperties: false` refuses it at authoring time; this refuses it wherever else a document comes from.

THE INSTANCE LEVEL UNLOCKS AND NEVER ACTIVATES. `instanceUnlocked` is a conjunct, never a disjunct and never a source of enablement: with the deployment unlocked and no enabling policy anywhere, every pair resolves NOT enabled. An instance flag that silently activated authoring on every component would violate ADR-0006's "managed execution is never a default", and the AND makes that structurally impossible rather than a rule someone has to remember (ADR-0032 §6).

A DISABLE ALWAYS WINS, AT ANY TIER. The deepest level may only SUBTRACT (§6), and so may every other level: one matching `enabled: false` defeats any number of enables from any tier. That asymmetry is why this is an AND of "some enable" with "no disable" rather than a nearest-scope-wins override — see the ORDER-INDEPENDENCE note below for why an override could not be well-defined here at all.

ORDER-INDEPENDENT BY CONSTRUCTION. The merge is an existential over a SET (`some enabling`, `no disabling`) plus a MIN over a total order for `granularity`/`delivery`; both are commutative and associative, so the result cannot depend on the order contributions are visited in — and the returned `contributions` array is sorted on a canonical key so even the EXPLANATION is order-independent. That is not a nicety: `graph/containment.ts:60-73` DOCUMENTS that containment-domain-vs-service is NOT a strict ordering, so two ancestors of different kinds can be exactly equidistant from a component and TIE. "Most specific wins" would be undefined at that tie; a monotone AND has no such failure mode. DO NOT add precedence logic here.

TIER LABELS ARE DERIVED FROM `typeId`, NEVER FROM POSITION. `containmentChain` bounds its recursion at `WHERE c.depth < 10` and does NOT error at the bound — it stops expanding, then computes `maxDepth` over the rows it actually returned and inverts, so THE ORG CAN ARRIVE AT A NONZERO DEPTH WHILE A TOP-LEVEL DOMAIN OCCUPIES INDEX 0 (BUILD_AND_TEST.md M21.3, "a ceiling whose ROOT LABELS CAN LIE"; measured and escalated by the outpost-UI session, pinned upstream in `nested-domains.integration.test.ts`'s "AT THE BOUND"). M21 inherits that rather than adding a seventh copy of the bound, so nothing here reads `chain[0]` and nothing here reads `depth`. `tierForObjectType` below is the only mapping, and it is fed each entry's own `typeId`.

A CEL `condition` MAY NEVER ENABLE, AND STILL DISABLES. A policy may carry a CEL `condition`, and enablement resolution has NO change context to evaluate one against — there is no proposed change here, only a component and a line. The two directions are therefore treated differently, in the only way that cannot fail open: - a conditional ENABLE is admitted to neither side and recorded as `ignored` (`condition_unevaluable`), because an unevaluable condition that enabled would let `when env == "prod"` subscribe a component in dev; - a conditional DISABLE is admitted in full, because subtracting can only ever leave FEWER pairs subscribed, and dropping it would leave a line subscribed that its opt-out named. This is the same fail-in-the-safe-direction reasoning `scan-requirements.ts` applies to an ERRORING condition, resolved for the case ADR-0032 §6 does not mention.

MALFORMED CONTRIBUTES NOTHING, BUT IS REPORTED. An effect that does not parse is admitted to neither side rather than throwing — an unparseable subscription must never turn a background tick into a 500. Unlike a malformed scan ceiling, though, it is NOT harmless in one direction only: a malformed OPT-OUT fails open. So it is recorded in `contributions` as `ignored` (`malformed`) instead of being dropped silently, and the operator's real defence is 0062's JSON Schema, which refuses it at authoring time.

THE INGESTION WORK-LIST IS DERIVED FROM THIS RESOLUTION. `listSubscribedComponentLines` filters on the SAME `mergeDependencySubscription` result rather than re-expressing the AND, which is what makes "ingestion only happens for enabled components" true BY CONSTRUCTION rather than by a filter a caller can forget (ADR-0032 §6, BUILD_AND_TEST.md M21.3). The AND appears exactly once in this file — in `mergeDependencySubscription` — and every other function calls it.

WHAT THIS MODULE DOES NOT DO. It writes nothing, it mints no relationship, and it exposes no transitive traversal: the pairs it reads are `component_dependencies` rows, which are DIRECT declarations only (ADR-0032 §3/§4). Adding a walk here would invalidate the reason the inventory is tabular at all.

### §378. A `dependencySubscription` effect on a policy document

A `dependencySubscription` effect on a policy document — the authoring surface (`effects: [{ dependencySubscription: { enabled: true } }]`, validated by the policy JSON Schema updated in drizzle/0062). Deliberately NOT added to `policy-model.ts`'s `PolicyEffect` union, exactly as `scanThreshold` is not: that union drives the GATE's require/approve enforcement, and an enablement bit is not an "unsatisfied effect" a change can fail on. `mergeContributorEffects` already ignores effect shapes it does not recognize, so existing enforcement is untouched — pinned by "an unrecognised effect shape leaves gate enforcement untouched" in `subscription-resolution.test.ts` rather than asserted here.

### §379. One candidate contribution, as gathered from a policy

ONE candidate contribution, as gathered from a matched policy (or the instance row) and BEFORE any of it is admitted to the AND. `effect` is deliberately `unknown`: parsing happens inside the pure merge so the malformed path is unit-testable with no database.

### §380. Same shape, and the reason it exists at all

Same shape, and the reason it exists at all: AUTO-MERGE IS THE PRIVILEGED OPTION (ADR-0032 §8). Taking the MIN over every enabling contribution — silent ones included, at `pull_request` — means auto-merge is reached ONLY when every contribution that enabled this pair declared it. Two policies that each asked for `pull_request` cannot combine into an auto-merge, and a policy that never asked for auto-merge cannot be handed it by a sibling OR BY A BROADER SCOPE.

### §381. The five-tier label for a graph object type

The five-tier label for a graph object type. EXPLAINABILITY ONLY — there is no precedence in an AND. Fed each chain entry's own `typeId`, NEVER its position (see the module doc: index 0 is not reliably the org). An object type outside the four org-and-below tiers is reported at the `component` (deepest) label with its real `objectTypeId` carried alongside, so the mapping stays auditable instead of silently lying — the same convention `scan-requirements.ts` uses.

### §382. Does a parsed effect's selector set match this line?

Does a parsed effect's selector set match this line? EVERY PRESENT selector must EQUAL the line's value; an ABSENT selector is a WILDCARD (ADR-0032 §6 authoring surface).

COMPARISON IS VERBATIM — no case folding, no normalisation, and above all no `slugify`. `graph/urn.ts` collapses `@acme/lib`, `acme/lib` and `acme-lib` into one slug, so a normalising comparison would let ONE opt-out silently un-subscribe three different packages, and one enable silently subscribe two nobody named. That the coordinate is stored verbatim (0061's "THE COORDINATE IS NOT A URN") is only half the property; comparing it verbatim is the other half.

### §383. The selectors, echoed so the why is answerable

The selectors, echoed into the contribution so "why did this apply to THIS line?" is answerable from the result alone. Keys are emitted in a fixed order — the contribution sort key below is built by `JSON.stringify`, and a varying key order would make it unstable.

ALWAYS RETURNS AN OBJECT, `{}` INCLUDED. An effect with no selectors matched this line because it matches EVERY line, and the explanation must say which of the two wildcards it was: deliberate, or the residue of a selector that failed to bind. Omitting the key for a wildcard made those two indistinguishable in a Decision. They are no longer even both reachable — `DependencySubscriptionEffectSchema` is a `strictObject` and 0062 sets `additionalProperties: false`, so a mistyped selector key is refused rather than stripped — but an explanation that has to be read alongside a schema to be unambiguous is not an explanation (charter principle 6). `{}` says "every selector deliberately absent". The key's ABSENCE is reserved for the two contributions that have no selectors to report at all: the instance `unlock`/`lock`, which is not a policy effect, and a `malformed` one, which never parsed.

### §384. The merge: pure, total, order-independent, testable

THE MERGE — pure, total, order-independent, and unit-testable WITHOUT a database.

```text
  enabledBy  = any matching contribution with enabled === true   (and no unevaluable condition)
  disabledBy = any matching contribution with enabled === false
  effective  = instanceUnlocked AND enabledBy AND NOT disabledBy
```

Extracted as a pure function per BUILD_AND_TEST.md §4.1 ("anything testable as a pure function must be written as a pure function"), which is what lets the four load-bearing properties — absent-never-enables, instance-unlocks-but-never-activates, a-disable-always-wins, and order-independence — be pinned without Postgres.

THIS IS THE ONLY PLACE THE AND IS WRITTEN. `resolveDependencySubscription` and `listSubscribedComponentLines` both route through it; neither re-expresses it, and the work-list filters on `.enabled` from this result. Writing the AND a second time anywhere is the specific mistake that would let the work-list and a UI verdict disagree.

### §385. Most restrictive wins, over the contributions that enabled

MOST RESTRICTIVE WINS, over the contributions that actually ENABLED — a `granularity` or `delivery` sitting on an OPT-OUT is inert, because the `continue` above means it never reaches this line — and SILENCE VOTES FOR THE DEFAULT rather than abstaining. `?? DEFAULT_*` is the whole of that second half, and the whole of the fix it encodes: an enabling contribution that declared no `delivery` did not express "no opinion", it declined to ask for the privileged option, so it votes `pull_request` and the MIN carries that vote.

Taking the MIN over DECLARED values only (and applying the default once at the end) reads absence as an abstention, and that is a genuinely different — and looser — resolver: a component team's `{"enabled": true}` composed with an org-wide `{"enabled": true, "delivery": "auto_merge"}` would resolve to `auto_merge`, i.e. SCP merging commits into that team's repo with no pull request, on the strength of a policy the team does not own and never read. The owner's requirement is that TEAMS choose PR-or-auto-merge (ADR-0032 §8), and auto-merge is the privileged option; a resolver in which the privileged option arrives from above by default does not implement that requirement. So, plainly: A BROADER SCOPE MAY NOT GRANT AUTO-MERGE (OR A LOOSER GRANULARITY) TO A NARROWER SCOPE THAT STAYED SILENT. It may only ever RESTRICT what the narrower scope asked for.

The cost, stated rather than discovered: a team that DOES want auto-merge cannot reach it while ANY other enabling contribution is silent — every enabler must declare it. That is unanimity, it is the direction that fails safe, and it is why `enabled` is required while these two are optional: the settings have a safe default and the switch does not.

### §386. The `??` here covers ONE case only

The `??` here covers ONE case only — NO enabling contribution at all, where the accumulator was never written and the pair is not subscribed anyway. It is NOT where an individual contribution's silence is handled: that happens per-contribution inside the loop, because handling it only here would let a declared `auto_merge` win over another contribution's silence. Absent is never the looser option, at either level.

### §387. The chain's three levels do not answer the same question

ADR-0032 §6's chain has three levels, and they do not all answer the same question:

```text
  effective_enabled(component, line) =
      instance_unlocked  AND  component_enabled  AND  NOT dependency_opted_out
```

The ADR then states the consequence in two halves that are deliberately different verbs — "a disabled component is never FETCHED and an opted-out dependency is never POLLED". Ingestion is a FETCH, so it is gated by the first two conjuncts; the third subtracts individual lines from what is POLLED and BUMPED, downstream, in `listSubscribedComponentLines`.

THAT SPLIT IS LOAD-BEARING, NOT A CONVENIENCE. Ingestion prunes each manifest down to exactly the lines it just read, so if an opted-out line were also excluded from what ingestion WRITES, the opt-out would delete the component's record that it declares that dependency at all — and the inventory, the UI and the M21.5 conflict check would all stop being able to see a dependency the team merely asked not to be bumped on. An opt-out subtracts a SUBSCRIPTION, never an observation.

### §388. When the gate is OPEN

When the gate is OPEN: the line the merge was satisfied on, chosen in a canonical order so it is the same answer on every run over the same inputs.

It is EVIDENCE FOR A READER, not a Decision input — the ingestion deliberately keeps it out of the Decision it writes, because it moves whenever a policy anywhere in the chain is added, removed or re-worded, for a component whose declared dependencies did not change, and a Decision field that moves without the subject moving is the persist-on-change hazard (ADR-0024).

### §389. A value for one selector field that NO candidate names

A value for one selector field that NO candidate names — so a witness built with it is matched only by contributions that leave that field WILDCARD.

THE LOOP is what makes the gate exact, not the starting string: whatever an adversarial selector spells, the result differs from every value any candidate named. The starting string is therefore chosen purely to be READABLE, because the witness is carried into the ingestion Decision and "which line was this gate satisfied on?" should be answerable by reading it.

PLAIN PRINTABLE ASCII, deliberately. The first cut used a NUL as an "impossible" value; it is impossible in the right way and unstorable in a fatal one — Postgres refuses a NUL inside `jsonb` outright (`22P05: unsupported Unicode escape sequence`), so every Decision carrying this witness failed to insert. Caught by the integration test rather than by reading it, which is most of the argument for having one.

### §390. The ingestion gate, computed by the merge itself

THE INGESTION GATE, COMPUTED BY `mergeDependencySubscription` ITSELF — never by a second expression of the AND.

The question is existential: *is there ANY line this component would be subscribed to?* If there is not, nothing this component declares could ever be subscribed, so fetching its manifests is work that can produce no subscription — and ADR-0032 §6 says such a component is never fetched.

WHY A WITNESS RATHER THAN A RE-WRITTEN PREDICATE. The tempting implementation is `instance.unlocked && candidates.some(isEnabling)`. That is the AND's first two conjuncts written a SECOND time, in a place no test of the merge can reach — the specific mistake `listSubscribedComponentLines` already refuses to make ("writing the AND a second time anywhere is the specific mistake that would let the work-list and a UI verdict disagree"). So the gate instead builds candidate LINES and asks the real merge about them.

WHY THE WITNESSES ARE EXACT, NOT A SAMPLE. A `dependencySubscription` selector is a conjunction of EQUALITIES over three fields, so for each candidate `E` the set of lines it matches is "every line agreeing with E on the fields E spells". Take E's own fields and fill the rest with values nothing names: a disabling candidate `D` matches that witness **iff** every field D spells is also spelled by E with the same value — which is exactly the condition under which D covers ALL of E's lines. So the witness is subscribed iff E subscribes something, and the existential is decided, not sampled. Concretely: an org-wide `enabled: true` beside `{coordinate: "left-pad", enabled: false}` leaves the gate OPEN (every other line is still subscribed), while the same enable beside a selector-free `enabled: false` closes it.

The witnesses come from EVERY candidate, enabling or not — deciding which candidates are enabling is the merge's job, and duplicating that test here is the same second-expression hazard one level down. The selector parse below reads only the three selector fields; it never reads `enabled`.

`ecosystem` IS A CLOSED ENUM, SO A "VALUE NOTHING NAMES" IS NOT A LINE THAT CAN EXIST
The fresh-value trick is correct for `coordinate` and `major`, which are open strings: a value no selector names is a value some real line could have. It is WRONG for `ecosystem`, whose entire domain is the five members of `DependencyEcosystemSchema`. A witness carrying a sixth, invented ecosystem is matched by no per-ecosystem opt-out at all — so a component with an org-wide enable and one opt-out per ecosystem (five effects that between them cover every line that could ever exist) had an OPEN gate, and was therefore fetched, and therefore pruned, on every accepted change, forever, for a subscription that can never produce a single subscribed line.

So a selector that names no ecosystem expands to one witness PER REAL ECOSYSTEM. The existential stays exact in both directions: opt out of `npm` alone and the `oci` witness still opens the gate; opt out of all five and nothing does.

THE WITNESSES ARE TRIED IN A CANONICAL ORDER
`input.candidates` arrives in whatever order `matchPoliciesForTargets` returned, which is a relevance-ordered SELECT and not a total order — two rows tying on every ordering key can come back either way round. "The first selector that opens the gate" is therefore not a stable answer, and the witness used to be carried into the ingestion Decision, where an unstable value re-opens the persist-on-change guard that exists because a churning Decision measured 1.44 GB/day (ADR-0024). The Decision no longer carries it, and the order is canonical anyway: a value that changes between two identical runs is a hazard whichever consumer happens to read it today.

### §391. NOTHING OPENED IT. The explanation still comes from the merge

NOTHING OPENED IT. The explanation still comes from the merge — run once over a line no contribution names — so a locked deployment reports the instance `lock` contribution rather than an empty array, and "which level turned this off" stays answerable. The ecosystem here is a real one for the same reason as above: an invented member would be matched by no ecosystem-scoped contribution, and this call exists to surface the contributions.

### §392. The instance-scoped unlock, read through the tenant path

The instance-scoped unlock singleton, read through the ORDINARY tenant transaction under the table's tenant-read RLS policy — no privileged connection is needed to RESOLVE an enablement, exactly as `readInstanceScanFloors` needs none to evaluate a gate (ADR-0016 §3's stated reason for preferring this shape). Writes are operator-only over the admin connection; see drizzle/0062.

NO ROW MEANS LOCKED. The table ships empty and is never seeded, because absent never means enabled (ADR-0032 §6): defaulting a missing row to unlocked would invert the whole chain.

### §393. The acting subject, required for group matching

The acting subject, for `scope.group` matching's ACTING half (DESIGN §10.1) — REQUIRED and threaded exactly as `resolveEffectiveScanThreshold` threads it. It is only ONE of the two halves: `matchPoliciesForTargets` also matches a group-scoped policy when the group OWNS something on the component's containment chain, and that half never reads this field (`governance/policy-resolve.ts:292-322`, owning half at `:150-173`).

INHERITED HAZARD, stated rather than discovered (ADR-0032 §6a-ii): where NEITHER half matches — the actor is not a member and the group owns nothing on the chain — a group-scoped OPT-OUT does not subtract, which is the fail-open direction. Worse, the owning half's reach is MUTABLE: an `owns` edge deleted through the ordinary ownership API silently takes the opt-out with it. It is inherited from `matchPoliciesForTargets` rather than introduced here (`scanThreshold` has the identical exposure: a group-scoped ceiling that matches neither half leaves the ceiling looser), and the fix belongs in the matcher, for both consumers at once. Author opt-outs at an `objectRef` scope — which is why `subscription-authoring-guard.ts` refuses the group-scoped shape outright.

### §394. Gathers every subscription effect a policy carries

Gathers every `dependencySubscription` effect that a policy matching this component's containment chain carries — the impure "gather" half, mirroring `resolveEffectiveScanThreshold`'s.

Exported and taken per-COMPONENT rather than per-(component, line) so the work-list can gather once and merge many times: the candidate set depends on the component's chain, never on the line.

The tier label for each match is looked up from the SAME `containmentChain` the matcher itself walked, so a label can never describe a containment relationship the matcher did not use — and it is keyed by each entry's own `typeId`, never by its index (module doc: index 0 is not reliably the org).

### §395. Resolves the enablement of ONE

Resolves the enablement of ONE (component, line) pair, with its full explanation.

This is the single-pair convenience over the same three inputs the work-list uses — it gathers, reads the unlock, and hands both to `mergeDependencySubscription`. It re-expresses none of the AND.

### §396. MAY THIS COMPONENT'S DEPENDENCY MANIFESTS BE FETCHED?

MAY THIS COMPONENT'S DEPENDENCY MANIFESTS BE FETCHED? (ADR-0032 §6, M21.2 ingestion.)

The same two calls `resolveDependencySubscription` makes — the instance unlock and this component's matched policy contributions — handed to `mergeComponentIngestionGate`, which decides by running the real merge. No new query, no new predicate, no second AND.

THIS IS NOT A FILTER A CALLER APPLIES. `inventory-ingestion.ts` calls it as its FIRST act, before it holds a repo, a ref or a reader, so "a disabled component is never fetched" is a property of the ingestion function rather than of its call sites — the distinction ADR-0032 §6 draws when it says the work-list is DERIVED from this resolution rather than filtered by one.

THE ACTOR IS THE SYSTEM SENTINEL on the event-driven path. That does NOT mean a `group`-scoped effect never contributes here — this comment used to say so and it was wrong (ADR-0032 §6a-ii). The sentinel is `member_of` nothing, so group scope's ACTING half never fires for it, but the OWNING half ignores the actor and fires wherever the group owns something on the component's chain. What is actually true, and is why the authoring guard refuses group scope in both directions: whether a group-scoped effect contributes here is decided by membership and by mutable `owns` edges, never by what the author wrote.

### §397. `false` (the default)

`false` (the default): ONLY pairs whose effective enablement is TRUE — the work-list, and the only shape a job may consume. `true`: EVERY declared pair with its verdict, disabled and not-enabled included — the M21.6 read surface, which exists to EXPLAIN, and must show the opted-out line beside the subscribed one.

ONE PARAMETER ON ONE FUNCTION, deliberately, rather than a second loop "minus the filter" somewhere else: two gather-and-merge loops would be two places to thread `actorObjectId`, two places to forget `conditional`, two places for the work-list and a UI verdict to drift apart. The filter lives HERE, on the merge's own result — never at a call site.

### §398. The candidates gathered per component

The candidates gathered per component — ONE gather per component. Populated for every component that had a declared pair, and ALSO for every component NAMED in `componentObjectIds` even when it declares nothing, so a caller can ask `mergeComponentIngestionGate` about a named component from the SAME inputs the pairs were merged from (the M21.6 read surface's `componentGate`) without a second gather.

### §399. THE ONE RESOLUTION CORE over DECLARED pairs

THE ONE RESOLUTION CORE over DECLARED pairs — `component_dependencies` ⋈ `dependency_lines`, gathered once per component, merged once per (component, line), filtered on the merge's own `.enabled` unless `includeDisabled`.

Both the ingestion work-list (`listSubscribedComponentLines`) and the M21.6 read surface (`dependency-read-surface.ts`) call THIS; neither has a loop of its own. See `ResolveDeclaredComponentLinesInput.includeDisabled` for why that is a rule and not a tidiness.

NO SHORT-CIRCUIT ON THE UNLOCK. It is tempting to return `[]` early when the deployment is locked, and it would even be correct today — but it would be the AND's first conjunct written a SECOND time, in a place no test of the merge can reach. The locked case falls out of the merge instead, at the cost of one policy walk per component on a deployment that has nothing to do.

COST, STATED: one `matchPoliciesForTargets` + one `containmentChain` per COMPONENT (not per pair), over a full scan of the org's `policy` objects. That is the same "honest, simple MVP choice" `policy-resolve.ts:20-24` records for the gate path, on the same expectation of dozens of policies per org, and it sits behind this signature if profiling ever demands better.

DIRECT DECLARATIONS ONLY, AND NO TRAVERSAL. The pairs come from `component_dependencies` joined to `dependency_lines` on `(org_id, id)` — one join, no recursion, no reachability walk. The moment a traversal appears here, the reason the inventory is a table at all stops holding (ADR-0032 §3).

### §400. THE INGESTION WORK-LIST

THE INGESTION WORK-LIST — every (component, line) pair whose effective enablement is TRUE.

THIS IS WHAT MAKES "INGESTION ONLY FOR ENABLED COMPONENTS" TRUE BY CONSTRUCTION (ADR-0032 §6, BUILD_AND_TEST.md M21.3). It is derived from `mergeDependencySubscription` — the same merge a UI or a Decision reads — rather than from a re-implementation of the AND or a filter at the call site, so a disabled component cannot be fetched and an opted-out line cannot be polled by a caller that simply forgot. A caller that wants "everything, enabled or not" calls `resolveDeclaredComponentLines` with `includeDisabled: true` and gets each pair's full verdict; it cannot get it by passing a flag HERE, and it must not build a loop of its own.

This is the enabled-only PROJECTION of `resolveDeclaredComponentLines` — same gather, same merge, same filter — kept as the job-facing signature so a job cannot accidentally receive a disabled pair.

## `apps/server/src/dependencies/version-index-feed.test.ts`

### §401. The air-gap feed's job is to be REFUSABLE

The air-gap feed's job is to be REFUSABLE. Every test here is about a way the feed can be wrong, and the assertion is always the same shape: the wrong feed produces an explicit refusal, never a quiet "this coordinate has no newer version".

### §402. HIGH CLASS, LOW BLAST RADIUS

HIGH CLASS, LOW BLAST RADIUS (M23.0 verification pass 7's census of "slice a string at a code-unit offset, then persist it"; fixed pass 8).

WHERE THIS MESSAGE GOES, which is the whole reason it is not a log-line concern:

```text
parseDependencyIndexFeed throws
  -> readDependencyIndexFeed catches   -> FeedRead.detail
  -> version-index.ts                  -> unavailableOutcome(...).detail
  -> version-poll.ts `decisionFor`     -> reasonTree.detail
  -> insertDecision                    -> a `Decision`'s JSONB
```

`JSON.stringify` escapes lone surrogates and U+0000 to ASCII, so the ONLY way an ill-formed string gets out of `.slice(0, 120)` is a WELL-FORMED astral pair straddling the cut — and that is reachable, not theoretical: measured, an 86-character `coordinate` followed by an emoji does it. `jsonb` then refuses the row, so a malformed feed entry would take the poll's own Decision with it and the operator would be told nothing at all.

## `apps/server/src/dependencies/version-index-feed.ts`

### §403. M21.4 — THE AIR-GAP VERSION FEED

M21.4 — THE AIR-GAP VERSION FEED (ADR-0032 §7, charter principle 5).

A disconnected commander cannot reach `proxy.golang.org`, and it must not pretend otherwise. The ONLY external-feed pattern this platform has ever shipped is the Trivy scanner DB (`governance/scan-db.ts`, migrations 0035/0036), and this module copies its shape deliberately rather than inventing a second one:

| Trivy DB (shipped)                       | dependency version feed (here)                  |
| operator-invoked connected refresh        | `buildDependencyIndexFeed` at the connected side | | cosign detached-signature operator-load   | `loadDependencyIndexFeedBlob`             | | digest binding over the signature         | `expectedDigest`, same defence in depth         | | atomic install, never a partial cache     | staging file + `rename`                         | | fail-closed staleness policy              | `readDependencyIndexFeed`'s `hard` class  | | no cache ⇒ no scan ⇒ E6 refuses           | no feed ⇒ `unavailable`, never "no new version" |

WHY FAIL-CLOSED STALENESS IS THE LOAD-BEARING PART. A stale feed does not merely miss a bump: it ASSERTS a head that has since moved, and every subscriber then looks up to date against a version that is months old. That is the "wrong version is worse than no version" rule (ADR-0032 §7) in its air-gap form, so a feed past the operator's hard bound is REFUSED, not used with a warning.

WHAT THIS IS NOT. It is not a mirror, not a cache of a live index, and not something SCP fetches. The bytes are produced at the connected side, signed there, carried across the CDS by an operator, and loaded here — the same walk the scanner DB blob makes, for the same reason: an air-gapped domain has no other honest way to learn a fact about the outside world.

SCOPE, STATED RATHER THAN DISCOVERED: this feed is INSTANCE-scoped operator infrastructure on disk, exactly as the Trivy cache is. It is not a graph object, does not federate, and carries no org data — it is a list of public version strings.

### §404. Parse and VALIDATE a feed document

Parse and VALIDATE a feed document. Throws on anything it cannot fully understand.

Strict on purpose, and this is the same argument `@scp/dependency-manifests`'s parsers make for themselves: "this feed lists no versions for X" and "I could not read this feed" produce identical downstream behaviour (no bump) and mean opposite things. A tolerant parser that dropped malformed entries would turn a corrupted transfer into a silently smaller feed, and the estate would look up to date on every coordinate that fell out.

### §405. `boundText`, NOT `.slice(0, 120)`

`boundText`, NOT `.slice(0, 120)` (HIGH class, M23.0 verification pass 8). This message reaches a DATABASE ROW: `readDependencyIndexFeed` turns the throw into `FeedRead.detail` -> `unavailableOutcome(...).detail` -> `decisionFor`'s `reasonTree.detail` -> a `Decision`'s jsonb. A slice at a UTF-16 CODE-UNIT offset can land inside a surrogate pair, and `jsonb` refuses an ill-formed string. `JSON.stringify` escapes lone surrogates and NUL to ASCII, so the ONLY way through is a well-formed astral pair straddling the cut — and that is reachable: measured, a `coordinate` of 86 characters followed by an emoji makes `.slice(0, 120)` ill-formed. A malformed feed entry would then take the poll's Decision with it instead of being reported.

### §406. The versions this feed carries for one coordinate

The versions this feed carries for one coordinate, or `null` when it carries the coordinate not at all.

`null` VERSUS `[]` IS THE WHOLE POINT, and it is the same distinction `ManifestParseError` draws: an empty array is "the connected side looked and this package has published nothing", while `null` is "nobody looked" — which the caller reports as unavailable rather than as up-to-date.

Comparison is VERBATIM (`===`), never normalised: `graph/urn.ts`'s slug would collapse `@acme/lib`, `acme/lib` and `acme-lib` into one key, so a normalising lookup could answer one package's question with another package's versions.

### §407. Serialize a feed at the CONNECTED side

Serialize a feed at the CONNECTED side — the bytes an operator then `cosign sign-blob`s and carries across the CDS.

Keys are emitted in a fixed order and entries are sorted on their natural key, so re-generating a feed over an unchanged estate produces BYTE-IDENTICAL output. That is not cosmetic: it lets an operator diff two feeds, and it means a re-signed feed with no changes has the same digest.

### §408. Air-gap operator load: verify a signed feed, then install

AIR-GAP OPERATOR-LOAD — verify a cosign-signed feed, then install it. `loadScanDbBlob`'s shape, clause for clause.

ORDER IS THE SECURITY PROPERTY: digest cross-check, then signature verification, then PARSE, and only then the atomic install. Nothing is written until all three pass, so a tampered, wrongly signed, or malformed feed leaves the previously installed one untouched — a failed load must never be able to empty the feed, because an empty feed would make every coordinate look unlisted while looking like a successful operation.

## `apps/server/src/dependencies/version-index.test.ts`

### §409. M21.4 — the NEVER-GUESS properties

M21.4 — the NEVER-GUESS properties (ADR-0032 §7), pinned as pure-function tests.

Every assertion below is about the same rule from a different angle: a version that cannot be DETERMINED must produce NOTHING, with a legible reason. The failure these guard against is not a crash — it is a plausible-looking wrong answer that makes a component look up to date.

### §410. The query accepts only a third-party line

`queryLineHead` accepts ONLY a `ThirdPartyLine`, so even a test has to come through `asThirdPartyLine` — which is the ingress split working (ADR-0032 §7): an INTERNAL line cannot be handed to an index by anyone, including a test that means to.

### §411. M21.4 added a THIRD copy of one vocabulary

M21.4 added a THIRD copy of one vocabulary (`@scp/schemas`' Zod enum, `@scp/dependency- manifests`' parser type, and now `@scp/plugin-api`'s plugin-contract type). The first two drifted already — `image` vs `oci` — with both sides fully green, because no test crossed the boundary; `packages/dependency-manifests/src/ecosystem-vocabulary.test.ts` exists for exactly that. This is the same check for the third copy.

`INDEX_MODULE_BY_ECOSYSTEM` is what makes it a RUNTIME check rather than an erased type assertion: it is declared `Record<DependencyIndexEcosystem, PluginModule>`, so a missing key and an extra key are both compile errors, and its KEYS are therefore that type's members observable at runtime.

### §412. An unresolvable digest does not void the observation

A digest that cannot be resolved does NOT void the observation — the tag is still the head, and the air-gap feed carries no digests at all, so requiring one would make an air-gapped estate unable to record an image head ever. It travels as an EXPLICIT null, never as an absent field: an absent one let the PREVIOUS version's digest stay beside the new tag, and the row then asserted a (tag, digest) pair that never existed in any registry (ADR-0032 §7).

## `apps/server/src/dependencies/version-index.ts`

### §413. M21.4 — THE THIRD-PARTY VERSION INDEX SEAM

M21.4 — THE THIRD-PARTY VERSION INDEX SEAM (ADR-0032 §7).

Two jobs, and keeping them in one file is deliberate:

1. REACH an index for one ecosystem — through the plugin host, so `egress-guard.ts` and the per-instance `allowedHosts` allowlist apply to an operator-configurable registry URL — or say precisely why it could not be reached. 2. RANK what came back, in the ONE place ranking is allowed to happen.

NEVER GUESS A VERSION (ADR-0032 §7). This is the rule the whole module is arranged around, so it is worth stating as the property rather than the behaviour: **if a version cannot be determined, NOTHING is recorded and the reason is legible.** A wrong version is worse than no version, because a wrong one makes a component look up to date — a missed bump is a delay, a wrong bump is a commit in someone's repository. Concretely:

- ordering is `@scp/dependency-manifests`'s `compareVersions` and nothing else. There is no string comparison of versions anywhere in this file, and there must never be: string order gives `"9" > "10"` and `"1.2.3-alpine" < "1.2.3"`. - a candidate whose text does not parse is SKIPPED and COUNTED, never coerced. - a line whose own `major` does not parse yields `undetermined`, not a scan of everything. - `unavailable` (nothing answered) is a DIFFERENT outcome from `undetermined` (something answered and nothing on the line could be understood) and from a head being unchanged. Collapsing any two of those makes an air-gapped estate indistinguishable from a fully up-to-date one.

THE INDEXES ARE OPERATOR CONFIG, NOT TENANT CONFIG. Each ecosystem's base URL comes from this process's own environment, is unset by default, and reaches the plugin instance as its config together with an `allowedHosts` entry derived from that same URL. An unset URL is not a degradation to "no new version" — it is `not_configured`, the air-gap default (charter principle 5: nothing phones home because someone installed the chart).

IMAGES NEED NO FALLBACK. `oci` is configured from the allowlist the deployment ALREADY has (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS`) and the vendored skopeo it ALREADY resolves, so in an air-gapped domain the org's own registry is a working index while the four language ecosystems report unavailable. `version-poll.integration.test.ts` pins exactly that asymmetry.

### §414. The index config for one ecosystem, or null

The plugin-instance config for one ecosystem's index, or `null` when this deployment has none.

`allowedHosts` is derived from the operator's OWN url rather than taken from anywhere a tenant can write — the same discipline `executor-bindings-repo.ts` applies — so the egress allowlist and the target can never disagree. `allowInternalEgress` is deliberately NOT set: a language index is a registry, and pointing one at `127.0.0.1`/`10.x` is the SSRF shape MAJOR #6 closed. An operator running an in-cluster mirror reaches it the same way every other tenant-configurable plugin does (the two-layer `SCP_INTERNAL_EGRESS_HOSTS` + execution-system declaration), which this path deliberately does not shortcut.

### §415. THE HEAD OF A LINE

THE HEAD OF A LINE — the single ranking function.

Pure and total: no I/O, no throw, and every rejected candidate is accounted for in the returned counts. Extracted as a pure function per BUILD_AND_TEST.md §4.1 so the never-guess properties are pinned without a database, a network, or a plugin host.

A caller MUST treat `head === undefined` as "record nothing". There is deliberately no "best-effort" branch and no `?? versions[0]`: the moment such a fallback exists, the failure mode is a plausible-looking wrong answer instead of a visible absence.

### §416. The version and its digest, always both

The version AND the digest that belongs to it, always both — `digest: null` means "this version's bytes were not resolved" (a language ecosystem has none, the air-gap feed carries none, an inspect can fail). It is NOT optional, because an ABSENT digest is what let a previous version's digest survive beside a new tag: the pair moves together (ADR-0032 §7, `line-head.ts`).

### §417. Called with the id of an instance this call started

Called with the id of an index instance this call STARTED (or re-used), immediately after `host.start()` returns, so the caller can stop it when its sweep is over (M21.4 lifecycle).

REPORTED, NEVER INFERRED. The caller could compute the same ids by re-running `resolveIndexInstanceConfig` over the ecosystems in its work-list — and that is precisely the shape that goes wrong later: it would be a SECOND derivation of "which instances are running", true only while the two agree. This one is a receipt from the code that actually started them, so an instance the sweep starts can never be one the sweep forgets to stop.

### §418. Resolve ONE line's head

Resolve ONE line's head.

Order of resort, and why it is this order: 1. THE INDEX PLUGIN, when this deployment configures one for the ecosystem. Live, authoritative. 2. THE OPERATOR-LOADED SIGNED FEED, when it does not — the air-gap path (see `version-index-feed.ts`, which copies the Trivy-DB shape verbatim). A HARD-STALE feed is refused rather than used, fail-closed, exactly as a hard-stale scanner DB is. 3. UNAVAILABLE. Never "no new version".

A feed is not consulted when a live index answered — including when it answered `unknown_coordinate` or `unauthorized`. A live index's "I do not have this package" is a real answer about the world, and letting a months-old operator snapshot override it is how a subscription gets bumped onto a version that was withdrawn.

IT TAKES A `ThirdPartyLine`, AND THAT IS THE INGRESS SPLIT, NOT A TYPE FLOURISH (ADR-0032 §7). An INTERNAL line's head is DERIVED from the org's own production releases; polling one against a public index lets a stranger's package that shares the coordinate overwrite the org's own `2.1.0` with `9.9.9`, and every subscriber is then bumped onto it — dependency confusion, arriving on a daily timer. The brand means a caller cannot pass an internal line by forgetting a filter: the only constructor is `asThirdPartyLine`, which reads `produced_by_object_id`.

### §419. A MUTABLE TAG IS NOT AN IDENTITY

A MUTABLE TAG IS NOT AN IDENTITY (ADR-0032 §7): for images the digest is what the version claim actually means, so it is resolved for the head and only the head — one extra call per line, not one per tag.

AN UNRESOLVED DIGEST IS `null`, NEVER ABSENT. A digest that cannot be resolved does not void the observation — the tag is still the head, and the air-gap feed carries no digests at all, so requiring one would make an air-gapped estate unable to record an image head ever. But it must travel as an explicit `null`: while this field was optional, an unresolved digest left the PREVIOUS version's digest standing beside the NEW tag, and the row asserted a (tag, digest) pair that never existed in any registry. The pair moves together — `recordDependencyLineHead` writes both from this one observation.

## `apps/server/src/dependencies/version-poll.integration.test.ts`

### §420. M21.4 — THE DAILY VERSION POLL AGAINST REAL POSTGRES

M21.4 — THE DAILY VERSION POLL AGAINST REAL POSTGRES (ADR-0032 §7).

The ranking algebra is proven without a database in `version-index.test.ts`, and each index plugin against recorded fixtures in its own package. THIS file proves the four things only the real database, the real enablement resolver and the real plugin code can:

1. PERSIST-ON-CHANGE HOLDS ACROSS TWO TICKS. A second, identical poll writes ZERO new `decisions` rows. A daily poll restating a byte-identical verdict per dependency is exactly the shape that produced the measured 1.44 GB/day flood (ADR-0024). 2. THE WORK-LIST IS M21.3'S RESOLUTION. A component whose subscription is not enabled, and a line that is opted out, are never polled at all — no Decision, no observation — and the enabled ones ARE, which is the negative control without which those absences prove nothing. 3. AN UNAVAILABLE INDEX RECORDS NOTHING ON THE LINE. `latest_version` stays NULL, the verdict is `unavailable`, and the reason is readable. "No index answered" must never look like "up to date". 5. THE INGRESS SPLIT HOLDS (ADR-0032 §7). An INTERNAL line — one this org DECLARES it produces — is NEVER asked of an index, with the negative control that a third-party line IS. That is the dependency-confusion failure: a stranger's package sharing the coordinate answering `9.9.9` and overwriting the head the org's own production release put there. 4. THE AIR-GAP ASYMMETRY IS REAL. With ONLY a local registry configured — no `SCP_DEPENDENCY_INDEX_*_URL`, no operator feed — image detection works END TO END (head tag plus content digest) while all four language ecosystems report unavailable. That is ADR-0032 §7's "images need no fallback" as a behaviour rather than an intention.

MUTATION LOG — each applied, watched fail, reverted, watched pass: | Mutation | Result |
| drop `produced_by_object_id IS NULL` from the poll's hydration AND make `asThirdPartyLine` return every line (the pre-fix state — BOTH barriers) | "an INTERNAL line is NEVER asked of an index" FAILS: `npm:@acme/internal-lib` appears in the fetched coordinates | | drop the SQL predicate ALONE | still PASSES — the `ThirdPartyLine` brand's own read of the same column refuses it. That is the defence-in-depth claim measured rather than asserted: either barrier alone still holds, and the test is written against the state where neither does | | inherit the stored digest when an advance resolves none (`input.latestDigest ?? before.latestDigest`) | "a NEW tag whose digest cannot be resolved never inherits the PREVIOUS version's digest" FAILS — the row reads 3.19.2 with 3.19.1's bytes | | make `evaluateHeadMovement` never return `behind_head` | "an index that no longer offers the head does NOT walk the line backwards" FAILS — the head drops to 4.17.21 |

The plugin host here is IN-PROCESS but the PLUGINS ARE THE REAL ONES, constructed by their real factories from the real `resolveIndexInstanceConfig` output — only the subprocess transport is skipped (the `createInMemoryFakeHost` precedent). A stub returning canned versions would have proven the test's own fixture, not the plugin.

### §421. No acting-user lookup here, and that is the point

NOTE there is no acting-user lookup here, and that is the point: the tick threads `SYSTEM_ACTOR_ID` into the resolution (`version-poll.ts`'s `buildLineWorkList`), because a background job has no human actor. Every policy below is therefore authored at an `objectRef` scope, which matches for any caller — a `group`-scoped ENABLE would resolve NOT-enabled here, the safe direction §6 guarantees.

### §422. A daily job that never stops what it starts accumulates

A DAILY JOB THAT NEVER STOPS WHAT IT STARTS ACCUMULATES WITH TENANCY.

Every other plugin-host caller starts instances derived from operator CONFIGURATION (an executor binding), which persists — leaving those children up between ticks is right. This job is the first whose instances come from its own WORK-LIST: up to five per org, started on demand by `queryLineHead`. Nothing leaked per tick (`start()` skips an id it already holds), which is exactly why this was invisible: the symptom is a standing subprocess count that grows with the number of orgs and never falls, held for the worker's lifetime by a job that runs once a day.

The set stopped is a RECEIPT from `queryLineHead` (`onIndexInstanceStarted`), not a second derivation of which instances "should" be running — so an instance this sweep starts cannot be one it forgets to stop.

### §423. The row asserts a PAIR

The row asserts a PAIR — "3.19.1 is these bytes" — because a mutable tag is not an identity (ADR-0032 §7). While `latestDigest` was optional, a poll that moved the version and omitted the digest left the previous version's bytes standing beside the new tag, and the row then claimed a (tag, digest) combination that never existed in any registry. Nothing errors, and an operator reading it has no way to know.

### §424. THE FAILURE THIS PINS IS DEPENDENCY CONFUSION

THE FAILURE THIS PINS IS DEPENDENCY CONFUSION. `@acme/internal-lib` is published by this org and its head is DERIVED from the org's own accepted production releases (`internal-release-detection.ts`). A public npm index that happens to carry a package of the same name answers `9.9.9`; polling it overwrites the head the org's own release put there and every subscriber is bumped onto a stranger's package. The split is not a filter in the poll — it is `listThirdPartyDependencyLinesByIds`'s SQL plus the `ThirdPartyLine` brand that `queryLineHead` demands.

### §425. Replay of the measured race, at the exact seam

REPLAY OF THE MEASURED RACE, at the seam where the interleaving is exact.

Test (5) above proves the poll never ASKS about a line that is internal when the work-list is built. It cannot prove anything about a line that becomes internal AFTERWARDS, and that gap was not hypothetical — it was measured end to end against this same Postgres:

```text
t0  buildLineWorkList (tx1) returns the coordinate as a THIRD-PARTY line
t1  the producer is declared; the head is confirmed cleared to null
t2  the poll's own write call lands  -> {"recorded":true,"movement":"advanced"}
    head = 2.99.0, and one `scp.dependency.line_head_advanced` row: THE BUMP FAN-OUT FIRED
then the line is internal, so buildLineWorkList never visits it again to correct itself,
    and internal detection's real 2.1.0 is refused as `behind_head` — PERMANENTLY WRONG
```

WHY THE INTERLEAVING IS DRIVEN AND NOT AWAITED. Both ingresses deliberately do their network work with NO transaction open, so the window is a real wall-clock gap in production; here it is produced by calling the three steps in order, which is `boundary-segment.integration.test.ts`'s precedent ("the deterministic form of the race, driven at the repo seam so the interleaving is exact"). `recordDependencyLineHead(..., "third_party")` is verbatim what `pollWork` calls — same function, same arguments — so nothing here is a re-implementation of the path under test.

MUTATION LOG — applied, watched fail, reverted, watched pass: | Mutation | Result |
| delete rule 0 from `recordDependencyLineHead` (the pre-fix state) | BOTH tests below FAIL: the public 2.99.0 records and advances, one outbox row appears, and the internal 2.1.0 is then refused `behind_head` | | keep rule 0 but read the declaration BEFORE the `FOR UPDATE` | still passes here (this is a same-connection replay), which is why the ordering argument lives in `recordDependencyLineHead`'s header rather than in an assertion |

### §426. THE SAME RACE WITH THE ARROW REVERSED

THE SAME RACE WITH THE ARROW REVERSED — a RETRACTION landing mid-flight of an internal-release derivation. `internal-release-detection.ts` reads the producer in phase 1, fetches the producer's manifest from a git provider in phase 2 with NO transaction open, and writes in phase 3; a retract in that window used to let the org's own version land on a coordinate that is third-party again.

IT IS THE WORSE-READING DIRECTION, not the tidier one (`resetLineHead`'s header): a stale internal head on a third-party coordinate wedges the poll behind a version no registry ever published, AND `latest_version` is an input to the M22 vendor scan rule, so it can grant a scan pass against evidence the world never produced.

### §427. THE SAME RACE ONE LEVEL FINER

THE SAME RACE ONE LEVEL FINER — a TRANSFER, not a retraction.

The two tests above prove rule 0 refuses an ingress writing to a line of the wrong CATEGORY. They cannot prove anything about the wrong MEMBER of the right category, and that gap was the previous fix's own bug: `evaluateIngressAuthority` took `{ hasDeclaredProducer: boolean }` and `recordDependencyLineHead` supplied it as `declaration !== null`, so the door asked "is a producer declared?" and never "is THIS producer declared?".

A TRANSFER IS AN ORDINARY, SUPPORTED ACT, which is why this is not an exotic interleaving: `POST /dependencies/producers` upserts, and the last commit added `displacedProducerObjectId` to that route's Decision precisely because coordinates move between components. Measured at this seam before the fix:

```text
t0  declare -> P; P's internal detection reads the declaration in phase 1
t1  declare -> Q  (the transfer; the verb clears the head, as both verbs do)
t2  P's in-flight phase-3 write lands
    {"recorded":true,"movement":"advanced","detail":"'2.9.9' is the first head observed…"}
    outbox: line_head_advanced -> bump PRs into every subscriber's repo, onto P's version
then Q's genuine 2.4.0 is refused `behind_head` FOREVER — the poll never visits a declared
    line, backward movement is refused, and no API resets `latest_version`.
```

DRIVEN, NOT AWAITED, for the same reason as (6): the window is a real wall-clock gap in production (phase 2 fetches a manifest out of a user repo with no transaction open), and `recordDependencyLineHead(..., { kind: "internal", producerObjectId })` is verbatim what `internal-release-detection.ts:526` calls with `item.identity.producerComponentObjectId`.

MUTATION LOG — applied, watched fail, reverted, watched pass: | Mutation | Result |
| revert the identity check — drop the transfer arm, which is all `{ hasDeclaredProducer: boolean }` could express | THIS test FAILS at the first assertion, and the pre-fix state past that point was MEASURED rather than described: `{"recorded":true,"movement":"advanced","detail":"'2.9.9' is the first head observed on this line"}`, outbox delta **+1** (`line_head_advanced` fired), and Q's genuine `2.4.0` then `{"recorded":false,"reason":"behind_head"}` — permanently, since the poll never visits a declared line. The other two race tests in this block STAY GREEN, which is why this case had to be written separately | | keep the identity but report the refusal as `line_is_third_party` | FAILS on the reason assertion only: the write is refused, but the Decision then asserts the coordinate is third-party when it is internal and owned by Q |

### §428. The refusal's explanation, read back from the table

THE REFUSAL'S EXPLANATION, READ BACK OUT OF THE `decisions` TABLE — the CALL SITE, not the helper.

`norecordFor` is pinned pure in `version-poll.test.ts`, and that unit case is necessary and not sufficient: restoring the ONE FIXED SENTENCE this function replaced ("a head never moves backwards and never leaves the line it names") at the call site left 352 tests green. A rule proven in isolation while its only consumer is free to ignore it is the same shape as a guard nobody exercises — the explanation the operator actually reads comes from `decisionFor`, and nothing asserted what `decisionFor` put there.

SO THE DECLARE LANDS INSIDE THE REAL POLL, not at the repo seam. `pollOrgDependencyVersions` builds its work-list in one transaction, does the index round trip with NO transaction open, and writes in another — so a host whose `listVersions` declares the producer occupies exactly the window the race replay above drives by hand, with the difference that this one goes on to write the Decision. That is the only way to read the persisted text of a `line_is_internal` refusal.

MUTATION — applied, watched fail, reverted, watched pass: | Mutation | Measured |
| `norecord: norecordFor(refusal.reason)` -> the old fixed sentence at the `not_recorded` call site | this case fails on BOTH halves: the ownership sentence is absent, and the version sentence is present on a refusal that is not about the version |

## `apps/server/src/dependencies/version-poll.test.ts`

### §429. THE ROLE GUARD

THE ROLE GUARD (ADR-0032 §7, BUILD_AND_TEST.md M21.4).

The hazard is specific and is not hypothetical: there is no trustworthy RUNTIME commander/outpost predicate — `self_domain.role` is per-ORG, set lazily post-install through the federation API, and advisory — so a background job with no explicit guard runs on AIR-GAPPED OUTPOSTS too, dialling package registries that are unreachable by design and writing a Decision per dependency about it, every day, forever.

Both directions are pinned here. A test that only asserted the refusals would pass just as well against a guard that refuses EVERYTHING, i.e. against a feature that never runs at all — so the negative control (a commander worker DOES run it, and really creates the queue) is the half that makes the rest mean something.

### §430. The air-gap sentence is this capability's own reason

The air-gap sentence is THIS capability's own reason for the FEDERATION axis, so it belongs to the federation branch and only to it. On an `api` process the guard refuses on the PROCESS axis first (M21.7 follow-up, LOW 5 — all three hand-written copies now test the axes in one order, so a given misconfiguration sends an operator to ONE setting rather than to whichever one the job that complained happened to check first); telling that operator about air-gaps would be naming the wrong remedy.

### §431. The guard was fail-open, and that is a third axis

THE GUARD WAS FAIL-OPEN, AND THAT IS A THIRD AXIS, NOT A SHADE OF THE FIRST (M21.4 MINOR D).

`config.federationRole` DEFAULTS to `commander` when `SCP_FEDERATION_ROLE` is unset (config.ts), because that default is right for the question it was introduced to answer — "may this process serve the SPA?" — where it preserves every pre-M16.3 deployment byte-for-byte. It is the WRONG default for "may this process dial package registries on a daily timer?": an outpost installed before that env var existed, or from a chart that omits it, is indistinguishable from a declared commander. The deployments most likely to be air-gapped are exactly the ones most likely to be undeclared, so the pre-fix guard let precisely the wrong population through — silently, since "allowed" also logged nothing.

These pin the safe default and its remedy. Note the FIRST test would pass against the old guard too — it is the second one that is the fix, and the third is the negative control that stops the fix from degenerating into "never poll".

### §432. §4-A4/M26.1, CORRECTED TWICE

§4-A4/M26.1, CORRECTED TWICE: the startup kick is sent UNKEYED, with no singleton options at all, because it must ALWAYS insert. Keying it to the chain's `"tick"` killed the loops (a completed job holds pg-boss's singleton slot); moving it to its own key + window then broke crash resumption (a worker restarting inside the window had its kick swallowed by its own previous boot). A4's replica-dedupe was an efficiency win and is deliberately given up — redundant sweeps are safe, a dead loop is not. See events/pgboss.ts's LOOP_STARTUP_SEND_IS_UNKEYED and the census in coordination/loop-startup-singleton.test.ts.

### §433. The explanation must name the rule that actually refused

THE DECISION'S PLAIN-ENGLISH EXPLANATION MUST NAME THE RULE THAT ACTUALLY REFUSED (principle 6).

The defect this pins was one fixed sentence — "a head never moves backwards and never leaves the line it names" — appended to EVERY `not_recorded` verdict. It is true of the version rules and it is not the rule that fires for an OWNERSHIP refusal: `line_is_internal` says the coordinate has a declared producer, which is not a statement about the version at all, and the index's answer may have been perfectly ahead of the standing head. An operator reading that Decision goes looking for a version-ordering problem on a line whose actual problem is a declaration — a Decision that explains the wrong rule is worse than one that says nothing.

MUTATION LOG — applied, watched fail, reverted, watched pass: | Mutation | Result |
| restore the single fixed sentence for every reason (the pre-fix state) | TWO failures — the ownership case, and "`behind_head` and `different_major_line` do not share one sentence either". The second is the collapse one step smaller, and it falls out of the same mutation | | give the ownership reasons the version wording and vice versa | TWO failures, one per grouped case: the mapping is pinned in BOTH directions, so "the strings merely differ" does not satisfy it |

### §434. What this does not do, so it is not read as the gate

WHAT THIS DOES NOT DO, stated so nobody reads it as the exhaustiveness gate: the two lists above are hand-maintained, so a NEW `HeadRefusalReason` is not covered here at all. What covers it is the compiler — `norecordFor`'s switch has no `default:` arm and the package sets `noImplicitReturns`, so an unexplained reason fails to build. That gate lives in the source, not in this file, and adding a `default:` arm would silently remove it.

## `apps/server/src/dependencies/version-poll.ts`

### §435. M21.4 — THE DAILY THIRD-PARTY VERSION POLL

M21.4 — THE DAILY THIRD-PARTY VERSION POLL (ADR-0032 §7).

A self-rescheduling pg-boss tick that asks, for every (component, dependency line) pair a dependency subscription actually enables, "what is the head of this line now?" — and records either an observation or a legible reason there is none.

SIX PROPERTIES CARRY THIS FILE. Each one is a specific failure that was possible before it:

0. IT POLLS THIRD-PARTY LINES ONLY, AND THE SPLIT IS STRUCTURAL (ADR-0032 §7). An INTERNAL line — one the org DECLARES it produces (`produced_by_object_id`) — has its head DERIVED from its own accepted production releases (`internal-release-detection.ts`), and asking a public index about it is dependency confusion with a scheduler attached: a stranger's package sharing the coordinate answers `9.9.9`, that overwrites the head the org's own release put there, and every subscriber is bumped onto it. This file therefore holds NO `produced_by` predicate of its own, because a predicate here is a predicate to forget. `listThirdPartyDependencyLinesByIds` narrows in SQL and returns a branded `ThirdPartyLine`, which is the ONLY type `queryLineHead` accepts — so an internal line is neither loaded nor passable.

1. THE WORK-LIST IS M21.3'S RESOLUTION, NOT A FILTER HERE. `listSubscribedComponentLines` returns exactly the pairs whose monotone AND resolved TRUE, so a disabled component is never fetched and an opted-out line is never polled BY CONSTRUCTION (ADR-0032 §6). This file writes no second predicate over enablement — not a `WHERE`, not an `if`. A second filter is a place for the work-list and a UI verdict to disagree, and the resolver's own module doc says the AND appears exactly once on purpose.

2. IT IS EXPLICITLY ROLE-GUARDED, AND THE GUARD IS THE POINT. There is no trustworthy runtime commander/outpost predicate (`self_domain.role` is per-ORG, set lazily post-install, and advisory — config.ts:36-56 says so at length), so an UNGUARDED background job runs on AIR-GAPPED OUTPOSTS TOO, where it would spend every day dialling registries that are unreachable by design and writing an `unavailable` Decision per dependency for it. The guard is install-time `config.federationRole` (commander only) AND the `SCP_ROLE` process split (`all`/`worker` — an api-only process owns no background work). See `dependencyVersionPollRoleGuard`.

3. EVERY VERDICT GOES THROUGH `insertDecisionIfChanged`. A daily poll that re-wrote a byte- identical "no new version" Decision per dependency reproduces the MEASURED 1.44 GB/day amplification exactly (ADR-0024; `decisions-repo.ts` carries the measurement). Nothing in the Decision this file builds is time-varying — no timestamps, no durations, no counters that move on their own — which is what makes suppression actually fire rather than merely be called.

4. NOTHING HERE CAN DELETE INVENTORY. The poll writes ONLY the `latest_*` observation trio via `recordDependencyLineHead`. `pruneComponentDependencies` is not imported, and the manifest parsers are not called at all — so the "an unreadable fetch treated as an empty parse DELETES the component's declarations" failure (`@scp/dependency-manifests`'s caller contract) is absent from this path rather than guarded on it. Every per-line failure is caught per line, so one bad index can neither reject the job nor stop the other lines in the estate being polled.

5. THE INDEX SUBPROCESSES IT STARTS ARE STOPPED WHEN THE SWEEP ENDS. This is the only caller in the tree whose plugin instances come from a WORK-LIST rather than from operator configuration, so it is the only one for which "start on demand and never stop" accumulates with tenancy. See `pollOrgDependencyVersions`.

### §436. MAY THIS PROCESS RUN THE POLL?

MAY THIS PROCESS RUN THE POLL?

Two independent axes, both required, and they are different questions:

- `config.federationRole` is the OPERATOR'S INSTALL-TIME declaration of what this deployment IS (`SCP_FEDERATION_ROLE`, Helm's `federationRole`). Only a `commander` polls. An `outpost` is frequently air-gapped or high-side and must never initiate outbound registry traffic on a timer — that is the exact hazard ADR-0032 §7 names when it calls the guard explicit. A `retrans` node sits ON a CDS boundary and runs less than an outpost, not more. - `config.role` is the PROCESS SPLIT (`SCP_ROLE`). Background work belongs to `all`/`worker`; an `api` process must stay a request server, exactly as the reconcile/observe/watchdog loops already require (`main.ts`'s `runsBackgroundWork`).

Deliberately NOT derived from `self_domain.role`: that value is per-org, set lazily through the federation API, and advisory (config.ts's own doc comment, and M15.4's helm-verify note). A background job that decided whether to reach the internet from tenant-writable data would be exactly the runtime/install-time fork M15.4 declined to create.

THE BRANCH ORDER IS PART OF THE CONTRACT, NOT A DETAIL OF THIS COPY (M21.7 follow-up, LOW 5). This body is hand-written rather than delegating to `commanderOnlyJobVerdict` because its refusal TEXT carries a fact a shared string cannot ("dials package registries from an air-gapped site") — but the VERDICT and the ORDER the axes are tested in are shared. It used to test federation first, so a deployment misconfigured on more than one axis was sent to a DIFFERENT setting depending on which job complained: the poll said "federationRole is 'outpost'", the dispatcher said "SCP_ROLE is 'api'", for one and the same deployment. Process axis FIRST, then the undeclared case, then the declared non-commander — the order `commanderOnlyJobVerdict` documents and `commander-only.test.ts` pins across every copy by comparing each multi-axis refusal against the single-axis refusal it must be identical to.

### §437. THE GUARD USED TO BE FAIL-OPEN HERE, and silently

THE GUARD USED TO BE FAIL-OPEN HERE, and silently. `config.federationRole` DEFAULTS to `commander` when `SCP_FEDERATION_ROLE` is unset (config.ts), which is the right default for "may I serve the SPA?" — it preserves every pre-M16.3 deployment — and the wrong one for "may I dial the public internet every day?". An outpost installed before M16.3, or from a chart that omits the value, presents as a declared commander and would poll: precisely the air-gapped, high-side deployment ADR-0032 §7 makes this guard explicit to protect.

So the SAFE DEFAULT for reaching the internet is DO NOT, and the remedy is one env var that an operator can set truthfully either way. This costs a deployment that really is a commander one explicit declaration; it saves an undeclared outpost from a daily outbound sweep nobody asked for. Nothing else about the `commander` default moves.

### §438. Build this org's work-list

Build this org's work-list: the enabled pairs, collapsed to distinct LINES.

The collapse is not an optimisation detail — polling the same coordinate once per subscribing component would multiply an org's registry traffic by its fan-out and would write N identical Decisions about one line. The line is the subject; the components are an input to it.

### §439. A background tick has no human actor

A background tick has no human actor. `SYSTEM_ACTOR_ID` is the same sentinel the reconcile loop threads into `matchPoliciesForTargets`. This comment used to draw a conclusion from that which is FALSE (ADR-0032 §6a-ii): "it is a member of no group, so a `group`-scoped ENABLE does not contribute for this caller — the SAFE direction". The sentinel's membership is still nothing, but group scope's OWNING half never reads the actor, so a group-scoped enable DOES contribute here wherever that group owns something on the component's chain. Neither direction is therefore inert for this caller; what makes both safe is upstream, not here — ADR-0032 §6a refuses authoring a group-scoped effect at all, in either direction.

### §440. The resolution carries the natural key only

The resolution carries the line's NATURAL KEY only; `tagPattern` (which an image line's head selection depends on) lives on the row, so the rows are hydrated in one batched point lookup.

THAT LOOKUP IS THE THIRD-PARTY ONE (property 0). An internal line is dropped IN SQL here, not by an `if` below: the poll may not move a head that the org's own production release owns. The enablement AND is still not re-expressed — this narrows by PRODUCER, which is a different question from "is anyone subscribed", and a subscribed internal line is legitimately in the work-list of `internal-release-detection.ts` instead.

### §441. The Decision for one polled line

The Decision for one polled line.

NOTHING TIME-VARYING MAY ENTER THIS OBJECT. `insertDecisionIfChanged` compares the candidate's `verdict` + `inputContext` + `reasonTree` against the latest row of the same kind for the same subject; a timestamp, an age, or an elapsed-ms field would make every daily comparison unequal and restore the unbounded write with no visible symptom — the 1.44 GB/day shape. "When did we last look" is already recorded, in the place that belongs to observation state rather than to a verdict: `dependency_lines.latest_observed_at`.

`detail` on an `unavailable` outcome IS included even though it is the one field that can vary between two failures. That is deliberate: two DIFFERENT failure texts are two different facts about the deployment (a redirect today, a refused connection tomorrow) and principle 6 wants both on the record. Two IDENTICAL failures — the steady state, and the only one that could amplify — still compare equal and are still suppressed.

THE WRITE DOOR'S `advanced`/`restated` LABEL IS DELIBERATELY NOT CARRIED HERE, for the same rule one paragraph up: it describes a TRANSITION, so the first tick that sees a head says `advanced` and every identical tick after it says `restated` — a field that differs between two otherwise byte-identical verdicts, which is precisely how persist-on-change is defeated without a symptom. A REFUSAL is carried, because it is a statement about the world (this index is behind this line's head) that stays true, and therefore compares equal, for as long as it holds.

### §442. Why nothing was recorded, in the terms of the rule

THE PLAIN-ENGLISH "WHY NOTHING WAS RECORDED", IN THE TERMS OF THE RULE THAT ACTUALLY REFUSED.

This used to be one fixed sentence — "a head never moves backwards and never leaves the line it names" — appended to every refusal. That sentence is TRUE of the version rules and simply not the rule that fired for an OWNERSHIP refusal: `line_is_internal` is not a statement about the version at all, and the index's answer may be perfectly ahead of the standing head. A Decision that explains the wrong rule is worse than one that says nothing, because it is read as the answer (charter principle 6): an operator reading it would go looking for a version-ordering problem on a line whose actual problem is that a producer was declared for it.

THE SWITCH IS EXHAUSTIVE AND HAS NO `default`, which is the standing gate rather than a style: with `noImplicitReturns`, a new `HeadRefusalReason` that nobody explains here does not compile. MEASURED rather than assumed — adding one reason to that union yields exactly `version-poll.ts: error TS2366: Function lacks ending return statement`. A `default` arm would silence that gate and hand the next reason the same wrong explanation this function exists to fix.

`reasonTree.reason` and `reasonTree.detail` carry the machine-readable name and the door's own specific text beside this; the three are not redundant — the door's `detail` names the fact (which producer, which version), this names the RULE.

EXPORTED for `version-poll.test.ts`, and only because there is no other way in: the refusal that exposed the defect (`line_is_internal`) needs a declaration to land BETWEEN `buildLineWorkList` and the write, and `pollOrgDependencyVersions` owns both ends of that window. The rule is pure, so it is pinned pure — the same split as `evaluateIngressAuthority` (unit) and the race replay (integration).

AND THE CALL SITE IS PINNED SEPARATELY, because the pure test is NOT sufficient: restoring the old fixed sentence at `decisionFor`'s `not_recorded` arm leaves all 16 of that file's cases green (measured) — a rule proven in isolation while its only consumer is free to ignore it. The pin is `version-poll.integration.test.ts`'s "the PERSISTED Decision for a line_is_internal refusal explains OWNERSHIP", which declares a producer from INSIDE the index round trip and reads the stored text back out of `decisions`.

### §443. Unreachable from THIS ingress

Unreachable from THIS ingress — both are refusals of an `internal` write, and this module only ever writes as `third_party`. Explained rather than asserted away, because `HeadRefusalReason` is one type shared by both ingresses and a future third one: an ownership refusal must never fall through to a version explanation, which is the defect this function exists to have fixed once.

### §444. The index subprocesses have a lifecycle, ending here

PROPERTY 5 — THE INDEX SUBPROCESSES HAVE A LIFECYCLE, AND IT ENDS HERE.

Every other plugin-host caller in this tree starts instances derived from operator CONFIGURATION (an executor binding), which persists, so leaving those children up between ticks is right. This job is the first whose instances are derived from its own WORK-LIST: up to five per org, started on demand by `queryLineHead`. Without a stop they were never torn down — `host.start()` skips an id it already holds, so nothing leaked per tick, and the symptom was instead a standing child-process count that grows with TENANCY and never falls, held for the lifetime of the worker by a job that runs once a DAY. On a multi-tenant commander that is 5×N idle subprocesses for 86,399 of every 86,400 seconds.

The set is a RECEIPT from `queryLineHead` (`onIndexInstanceStarted`), not a re-derivation of which instances "should" be running — see that option's doc for why the difference matters.

### §445. Observation state, not a verdict

Observation state, not a verdict — a single-row UPDATE of the `latest_*` trio, bounded by the number of lines and therefore not a growth source. The door DECIDES: the version and its digest move together (an unresolved digest is an explicit `null`, never the previous version's bytes left standing beside a new tag), the head never moves backwards and never leaves the line it names. Whatever it refuses is reported, not swallowed.

`"third_party"` IS NOT DECORATION, AND THE `ThirdPartyLine` BRAND DOES NOT COVER IT. The brand was minted in `buildLineWorkList`'s transaction, before the registry round trip above; a `POST /dependencies/producers` landing in that window makes this line internal, and writing a public head onto it was measured to be PERMANENT (the poll stops visiting the line and the real internal head is then refused as `behind_head`). The door re-reads the declaration under its own `FOR UPDATE` and refuses with `line_is_internal`, which lands in this line's Decision like any other refusal.

### §446. Self-rescheduling pg-boss loop

Self-rescheduling pg-boss loop — `startObserveLoop`'s `startAfter` + `singletonKey` shape exactly (there is no `boss.schedule` usage anywhere in this tree to copy, ADR-0032 §7), at a daily rather than a 60s cadence.

A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the shape `startAutoRelayLoop` and `startInboxLoop` already use for default-off loops. That matters beyond tidiness: an outpost that merely *skipped the work* inside the handler would still have created the queue and still be waking every day to decide to do nothing.

### §447. AND IT SAYS SO WHEN IT ALLOWS, TOO

AND IT SAYS SO WHEN IT ALLOWS, TOO. A guard that logs only its refusals makes the ON state the invisible one — an operator reading a boot log could not tell "this deployment polls package registries daily" from "this line of code does not exist", which is the wrong way round for the posture that actually sends traffic. Both verdicts are now on the record (principle 6), and this one names the cadence so the log answers "how often" as well as "whether".
