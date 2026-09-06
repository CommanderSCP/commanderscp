# bump-actuator

Reference for `apps/server/src/dependencies/bump-actuator.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 16 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE DELEGATION RE-CHECK

THE DELEGATION RE-CHECK — the half the authoring-time refusal structurally cannot cover
`subscription-authoring-guard.ts`'s `assertNoDelegatedDependencyUpdates` refuses a policy whose `scope.objectRef` names a component with a standing delegation verdict. It CANNOT refuse a `selector`-scoped enable, because a selector names no component — by design, since a selector is meant to match objects that do not exist yet.

So the same stored verdict is read again here, immediately before SCP would write to the repository. That is not belt-and-braces: it is the only point at which the component is known for a selector-scoped enable, and it is also what makes a delegation ADDED AFTER the policy was authored stop the writes rather than only the policy. One stored fact, two readers, neither of them fail-open.

## §2. Does this control run's evidence name `repo`?

Does this control run's evidence name `repo`?

`@scp/plugin-github-check` records the API URL it actually queried — `{apiBaseUrl}/repos/{owner}/{repo}/commits/{ref}/check-runs` — which is the only field in the evidence that says WHICH REPOSITORY the verdict is about. The `/repos/<owner>/<name>/` segment pair is lifted out of it and compared case-insensitively, the same rule `dependencies/manifest-reader.ts`'s `normalizeRepoIdentity` states for repository paths.

A shape this cannot read is NOT a match — the fail-closed direction, and it costs a pull request rather than an unattended merge on evidence nobody can attribute. That includes an evidence payload with no `url` at all: a control that does not say what it looked at has not said it looked at this component.

## §3. The dependency line this bump is for

The dependency line this bump is for.

Recorded because the SECOND asking of the delivery question (`bump-gate.ts`) has only the change in hand and must re-derive the subscription's CURRENT resolution rather than trust the one recorded here — which is the DOWNGRADED answer by construction. Re-deriving is what makes a subscription narrowed to `pull_request`, or switched off entirely, after the bump was authored stop the merge; and `listSubscribedComponentLines` is keyed on (component, line), so the line is the field that has to be on the change. A `targets` join would give the component and nothing would give the line.

## §4. THE PROVENANCE LOOP

THE PROVENANCE LOOP — a commit SCP authors must come back as ITSELF
ADR-0032 §9's closing sentence: "A commit SCP authors is observed back in via the normal webhook path, so the bump change must be recorded such that the returning event CORRELATES TO IT rather than minting a second, unrelated change."

That sentence describes a real hazard rather than a tidiness concern. Today EVERY change is minted by `coordination/webhook-processor.ts` from an OBSERVED event: it extracts a hint, matches `source_mappings`, and calls `proposeChange`. A bump SCP authors produces a perfectly ordinary push to the component's repository, which matches that component's perfectly ordinary source mapping — so without something to stop it, one bump becomes TWO changes: the one SCP recorded when it decided to author, and the one the webhook minted when the commit arrived. They would gate independently, appear as two releases of the same component, and neither would know about the other.

THE JOIN IS THE BRANCH, AND IT IS DECLARED ON BOTH SIDES. The change is recorded FIRST, so its id exists; the branch the plugin authors is `scp/dep-bump/<changeObjectId>`, so the id is carried in the one field a git push always has. The change ALSO records the repo and ref it claims, under `source_ref.scp_authored`. Correlation then requires BOTH: the incoming ref must name a change, and that change must claim this repo and this ref.

REQUIRING BOTH IS THE WHOLE POINT, not defensiveness. A branch name is attacker-typable — anyone who can push to any repository this instance observes could create `scp/dep-bump/<some-uuid>` and, with a one-sided check, attach their push to somebody else's change. Reading the change's own declaration is what makes the correlation a fact SCP asserted rather than a claim the payload made. It is the same "declared, never inferred" rule ADR-0030 §2 states for pipeline classification and that this repository's own provenance-label lesson learned the hard way.

WHY THE BRANCH AND NOT THE COMMIT SHA. The sha is only known after the push, so a webhook that arrives before the actuator has finished recording it would find nothing — a race whose losing side is exactly the double-change this exists to prevent. The branch is chosen BEFORE anything is written and is therefore race-free.

...AND THE DECLARATION THAT DECIDES A WRITE LIVES SOMEWHERE ONLY THE SERVER CAN WRITE
`source_ref.scp_authored` is written here and is the human-readable half: it is what makes "why was this not auto-merged?" answerable from the change alone (principle 6). It is NOT the authority for anything, and it never can be — `source_ref` is the raw delivery payload plus a few lifted keys, writable verbatim by any authenticated principal through `POST /api/v1/changes`. Reading the repository, the base branch or the head commit out of it to decide a MERGE is a confused deputy: the tenant names the repository, SCP supplies the credential.

So the same facts are recorded a second time in `dependency_bump_authorships` (migration 0063), in the SAME transaction as the change, and every decision that leads to a repository write reads THAT. A change with no authorship row is not a bump change, whatever its `source_ref` claims.
