# Guide: coupling two pipelines (M12 P4B)

A software release can wait on an infra release — or on another software release — before it
executes, so a deploy never runs ahead of the prerequisite it actually needs. This is **coupled
pipelines** (design: [`docs/proposals/coupled-pipelines.md`](../proposals/coupled-pipelines.md)).
This guide is for whoever is wiring up the CI step, not for reading the design rationale.

## The most important fact in this guide

**A raw provider push webhook cannot carry a coupling key.** GitHub's (or GitLab's, or Gitea's)
push payload has no field for "the key this release provides" or "the key this release needs" —
CommanderSCP does not invent one on your behalf, and it never will (a synthesized key is exactly
the kind of silent inference this feature refuses to do). If your pipeline's only signal to SCP is
a push webhook, `provides`/`requires` are simply absent, and **the change proceeds immediately,
exactly as it does today, uncoupled.**

To declare a coupling, your pipeline must run **`scp change-source report`** as an explicit CI
step — a PAT-authenticated, typed call your pipeline makes itself, after the work it's reporting
on has actually happened (e.g. after `terraform apply`, after `docker push`). This is the *only*
channel that can carry `--provides`/`--requires`. If you keep the push webhook wired up
*alongside* a report step for the same repo, you'll double-ingress: the webhook-born change
carries no coupling and ships immediately, while the reported one waits. That's not a bug you can
configure around — the fix is to make the report step your pipeline's only trigger for repos that
declare a coupling.

## The two CI snippets

Owner example: a software release needs an S3 bucket that only exists once an infra release has
run. The infra pipeline declares it made the bucket available; the software pipeline declares it
needs that fact before it deploys.

**Register the source mappings once, up front** (so `--repo`/`--path` resolve to the right
component):

```sh
scp change-source create-mapping terraform \
  --repo 'acme/infra-us-east-1' \
  --component us-east-1 \
  --type infrastructure

scp change-source create-mapping github \
  --repo 'acme/payments-api' \
  --component payments-api \
  --type image
```

**Infra pipeline — provides** (a CI step run after `terraform apply` succeeds):

```sh
scp change-source report terraform \
  --status applied \
  --repo "$CI_REPO_SLUG" \
  --provides feature-a
```

`--provides` is a bare, opaque key list — no scope is given here, because the provider's scope
is already what it targeted (`us-east-1`, resolved via the `source_mappings` row above).

**Software pipeline — requires** (a CI step run before the deploy executor fires — actually, this
step *is* what lets the deploy proceed; it does not trigger the deploy itself):

```sh
scp change-source report github \
  --status applied \
  --repo "$CI_REPO_SLUG" \
  --requires feature-a@us-east-1
```

`us-east-1` here is the id or URN of the **deployment-target** (or component) graph object the key
must be true at — not a free-text region string. Look it up once (`scp deployment-target get
us-east-1`) and hardcode the id/URN in your pipeline config, the same way you'd hardcode any other
infra reference.

Both flags also exist on `scp change propose` (`--provides <keys>` / `--requires
key@objectIdOrUrn,...`) if you're proposing a change directly against the API rather than through
a change-source report — same syntax, same semantics.

## The `at`-scoping rules

- `requires` is `{key, at}` — `at` is **mandatory**, and it is a real graph object id or URN, not
  a substring embedded in the key. `feature-a@us-east-1` and `feature-a@eu-west-1` are unrelated
  requirements; a provider at one scope never satisfies a requirement at the other.
- **Region = a deployment-target.** Shared infra binds `at` a deployment-target
  (`us-east-1`, `us-west-2`, …). Component-owned infra (e.g. "the image must exist before the
  ArgoCD app that deploys it") binds `at` the component itself.
- `at` is resolved to an object id **at propose/report time** — an id or URN that doesn't resolve
  to a real object is a **400/404 immediately**, never a silent forever-wait. Only the *key* can be
  typo'd silently (see "did you mean?" below); the scope half is protected.
- `provides` carries no scope of its own — the provider's scope is whatever it already targeted
  (`--targets`, or the component the report's `--repo`/`--path` resolved to via `source_mappings`).
- Comma-separate multiple entries: `--requires feature-a@us-east-1,feature-b@payments-api`.

## What waiting looks like

A change with an unsatisfied `requires` enters a `waiting` state (visible in `scp change list
--state waiting` and the UI) instead of executing. It releases the moment every requirement is
satisfied — some *other* change reaching `validating` or `promoted` while providing that key at
that scope. Three ways to see the live status of a waiting (or already-released) change:

**CLI, focused view** — `scp change wait-status <id>` prints only the coupling status, nothing
else:

```
$ scp change wait-status 019f-...-abcd
Waiting on 1 of 1 prerequisite(s):
  - feature-a @ us-east-1 (019f-...-1234): OUTSTANDING
      did you mean one of: feature-b, feature-c?
```

Once satisfied:

```
$ scp change wait-status 019f-...-abcd
Coupled prerequisites (1, all satisfied):
  - feature-a @ us-east-1 (019f-...-1234): satisfied by change 019f-...-5678
```

**CLI, full picture** — `scp change explain <id>` shows the same coupling section alongside the
compiled plan and every Decision made about the change.

**UI** — the change detail page (and the pipeline board) render an "Upstream prerequisites" /
"Waiting on" panel from the same data, each outstanding requirement linking to what it's waiting
on and each satisfied one linking to the change that satisfied it.

**"Did you mean?"** — for an outstanding requirement, both surfaces also list the `provides` keys
that have actually been declared at that scope (org-scoped, exact — it's asking about the same
resolved object your `at` names, not a fuzzy string match). If your requirement never shows up
there, either nobody has provided that key at that scope yet (the ordinary case — you may just be
early), or you've typo'd the key and the suggestion is your fix.

## The 24-hour watchdog

A `waiting` change gets the same SLA as `validating` (24 hours — both are "an expected wait, not a
stall"). If it's still parked past that, the watchdog writes a Decision (and, once notification
bindings are configured, a notification) naming the actual outstanding `{key, at}` pairs — not a
generic "stalled" message. Nothing times out and nothing gives up: `wait forever, warn at a
threshold` is the deliberate behavior (a dead/cancelled prerequisite is indistinguishable from a
slow one). If you see this warning, either the provider pipeline hasn't run yet, or check the key
and scope for a typo via `wait-status`'s "did you mean?".

## Promotion (federation): the commander's go-ahead, not a second wait

The coupling is evaluated **only at the commander**. A software change waits at the commander
until its `requires` are satisfied there; the commander's promotion of that change into an outpost
**is** the go-ahead — the outpost does not, and must not, re-evaluate the coupling locally. In
practice: `requires` is stripped from the change's properties on promotion import (with a Decision
recording that it was "satisfied upstream at commander"), so a promoted change never parks in
`waiting` at the outpost. `provides` is preserved across promotion — a promoted infra change can
still satisfy a locally-authored outpost waiter.

**Consequence for pipeline authors:** if your two coupled pipelines run against *different*
outposts rather than through the commander, there is no local provider for the requirer to find,
and it will wait forever. This is a known non-goal (see the proposal's §8), not a bug — coupling is
a commander-side concept.
