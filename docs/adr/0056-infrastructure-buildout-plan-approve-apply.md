# ADR-0056: Infrastructure buildout runs plan → approve → apply through Argo Workflows, and the approval is the change lifecycle SCP already has

**Status:** Accepted (2026-09-23) — realizes M28 decision D2; the two-change shape, the re-plan-and-compare binding and the template-pairing rule below are this increment's calls, and the owner is invited to overrule them
**Relates to:** [ADR-0007](0007-executor-binding-type-taxonomy.md) (the `infrastructure` Category); [ADR-0021](0021-terminology.md) D5 (`accept` is the human approval gate); [ADR-0041](0041-campaign-recipes.md) (a recipe's parameters flow verbatim into a trigger); [ADR-0049](0049-machine-image-publication.md) §3 (a deployment-level operator setting, not tenant data); [ADR-0052](0052-server-derived-run-material-wins-for-host-reaching.md) (derived bounds win the merge); [ADR-0053](0053-build-destination-by-artifact-class.md) (the typed trigger-parameter refusal this reuses); BUILD_AND_TEST.md §M28.3

## Context

The `infrastructure` Category got no trigger parameters at all (`buildLaneTriggerParameters`: "an
`infrastructure` one has no artifact at all"), so there was no infrastructure lane to drive through
an org's own executor. The only thing in the repo that plans and applies OpenTofu was `managed-iac`,
the Mode C exception — and measured on 2026-09-23, even that one's `apply` has **no production
caller**: nothing on the server sets `parameters.iacAction`, so every production managed-iac trigger
is a `plan`. Its plan evidence, though, is real and already wired end to end: `plan-summary.ts`
counts `tofu show -json`'s `resource_changes[].change.actions` into `observed.plan = { ref, add,
change, destroy }`, `observedStateFrom` persists it on the wave target, `GET /changes/{id}:explain`
serves it, and `PipelineWaveCard` renders it as the plan chip for any `infrastructure` target.

D2 fixed the rest: infrastructure executes as Argo Workflows catalog templates, plan → approve →
apply; `managed-iac` stays the Mode C fallback, unchanged; the OpenTofu state backend is a
deployment-level operator setting.

Three things had no answer:

1. **Where the approval lives.** Governance approvals exist (`approval_requests`/`approval_votes`,
   quorum policies), but they gate exactly one edge: a change's `validating → accepted`, which is
   AFTER execution. There is no mid-execution "hold this wave target for a human" primitive.
2. **How an apply is bound to the approved plan** when the plan ran in someone else's cluster and
   there is no artifact store every organization has (the build template's header records why the
   catalog must not assume an Argo artifact repository), and SCP must not hold a plan file (it
   carries state and, routinely, secret values).
3. **How an Argo-executed plan's evidence reaches SCP at all.** The argo-workflows plugin's
   `status()` returned phase and progress, nothing else.

## Decision

**1. A plan and its apply are two changes, and accepting the plan change IS approving the plan.**
A PLAN is an ordinary `infrastructure` change targeting a `deployment-target`; its wave target runs
`scp-infra-plan-v1` and comes back with `observed.plan` — **the existing evidence model, unchanged**,
so it is persisted on the same column, served by the same explain route and rendered by the same
chip. The change reaches `validating`, and `scp change accept` (or the UI's Accept) moves it to
`accepted` through the same gate every change passes: `change:accept` at every target, plus any
approval quorum bound to that edge. An APPLY is a second change declaring
`properties.infrastructure = { applyPlan: <plan change id> }` — carried on `properties` exactly as
`properties.recipe` (ADR-0041) and `properties.ops` (ADR-0052) are, so no table and no new route.

This reuses the approval model rather than building a parallel one, and that was the requirement.
The alternative — one change that pauses between a plan wave and an apply wave — needs a new
mid-execution approval primitive with its own roles, votes and Decision shape; it would be a second
approval system beside the first.

**2. The apply gate is enforced by the server, before `trigger()`, in the claim transaction.**
`infraLaneTriggerParameters` (the `infraLaneTriggerParameters` seam D2 named) refuses — terminal,
Decision + hash-chained audit, `infra_apply_refused` — unless:

- the named plan change exists, is a plan (not an apply, not a rollback) and is **`accepted`**;
- it has a **succeeded** plan at *this* target, run by the **same executor instance** that would
  apply it, with a sha256 **digest**;
- **no newer plan** has been dispatched at this target since — a plan approved and then superseded
  cannot be applied (the newest plan is what reflects the configuration now);
- no other apply of this plan is **in flight**. Apply decisions for one target are serialised by a
  transaction-scoped advisory lock, so two workers cannot both see the other's claim as absent.

If an apply of this plan has already **succeeded** at this target, the new apply is a **no-op**:
the wave target succeeds, nothing is triggered, and an `allow` Decision (`infra_apply_noop`, naming
the change that did apply it) and an audit event record why. Failing it would make an idempotent
retry of a successful apply look like a broken one.

**3. The apply is bound to the plan by digest, and the template re-plans rather than storing a plan.**
The digest is sha256 over the plan's **change set** — `resource_changes` and `output_changes` of
`tofu show -json`, keys sorted by jq — never the whole document, which carries a timestamp. Two plans
with the same digest make the same changes, before and after values included. The server carries
the approved digest into `scp-infra-apply-v1` as `planDigest`, with the PLAN change's source (not the
apply change's). The template re-plans at that commit against the same state and:

- nothing to do (`tofu plan -detailed-exitcode` = 0) → **no-op success** — applying nothing cannot
  exceed what was approved, and it is what a re-apply of an applied plan looks like from there;
- digest ≠ approved → **refuses** (exit 3): state or inputs changed since approval;
- digest = approved → applies that plan file.

Measured, not assumed (`infra-lane.integration.test.ts`, real `scp-runner-iac` image): two plans of
the same inputs produce the same digest; an apply with the approved digest applies; the re-plan
after it reports `0 add / 0 change / 0 destroy`; a re-apply is a no-op; an apply bound to a wrong
digest exits 3.

**4. The plan's evidence reaches SCP as the workflow's global outputs.** The templates export
`scpPlanDigest`, `scpPlanAdd`, `scpPlanChange`, `scpPlanDestroy` (and `scpPlanApplied`) with
`globalName`, which Argo puts on the Workflow's own `status.outputs` — the object `status()` already
fetches, so no second call and no artifact repository. The plugin reads them all-or-nothing: a
digest that is not a sha256 or a count that is not a non-negative integer drops the whole plan
(absent ≠ zero), and only a settled workflow's outputs count. An org's own template reports a plan
the same way; the names are namespaced `scp…` so none does by accident.

**5. The apply template is derived from the plan template, never bound.** An `infrastructure`
binding on Argo Workflows names its PLAN template; the apply template is its `-apply` sibling
(`scp-infra-plan-v1` → `scp-infra-apply-v1`, `acme-net-plan` → `acme-net-apply`;
`infraApplyTemplateFor`). One binding per (target, Type) stays the model, and no binding can point
a plan change's trigger at an apply. A binding whose name has no `-plan` segment is refused
(`infra_declaration_refused`). And the shipped `scp-infra-apply-v*` template is reachable ONLY
through this gate: any trigger the lane did not derive whose target ref names it — a `configuration`
binding pointed at it, with a recipe supplying a digest — is refused (`assertNotAnUngatedInfraApply`).

**6. Reserved parameters.** A recipe's parameters flow verbatim into the trigger and anyone who can
propose a change can write one. The lane's keys are bounds, not conveniences:

`environment`, `stateWorkspace`, `region`, `infraPath`, `sourceRepo`, `sourceCommit`, `sourceRef`,
`planDigest`, `planChangeObjectId`, `changeObjectId`, `targetObjectId`
(`INFRA_LANE_RESERVED_PARAMETERS`).

Two defences, deliberately both: a recipe that names any of them is **refused** with a Decision
(`infra_recipe_restates_bound`), and reconcile spreads the lane's values **last** (the ADR-0052 rule),
so even with the refusal gone the lane's digest is the one sent. Every key the script reads is
always sent — `infraPath` at its default `.` rather than omitted — so there is no key left open for a
recipe to fill. When M28.4's server-reserved-parameter table lands, these keys belong in it.

**7. Scoped to an environment; state belongs to the operator.** The wave target is a
`deployment-target`; its `properties.environment` (e.g. `prod-us-east-1`) is required and names the
state: each target gets the OpenTofu workspace `<environment>` or, for an ADR-0044 region target,
`<environment>-<region>`, so two regions of one environment never share a state. Where in the repo
the configuration lives is the target's `properties.infrastructurePath` (default the root). A plan
must be pinned to a full commit id — a branch would let the configuration move between the plan an
approver reads and the apply that follows it.

The **state backend is chart values** (`catalog.infra.stateBackend.type` + non-secret `config`),
rendered into a `-backend-config` file; the template writes an override that replaces whatever
backend the org's configuration declares. The templates **do not render until a backend is named**,
and a backend with no image fails the render. Cloud and backend credentials are an operator-
provisioned Secret in the Argo namespace (`catalog.infra.credentialsSecret`, `envFrom`); SCP holds
none and no credential grant was extended (charter principle 1). The infra pods run as their own
ServiceAccount — at the executor's `workflowtaskresults` floor — so cloud authority bound to it by
workload identity never reaches a build pod running a tenant's Dockerfile.

**8. One image.** The templates run the existing `scp-runner-iac` image (tofu 1.12.6 copied out of
the upstream image, which carries `ONBUILD RUN exit 1` and cannot be a base). It gains `jq`, the
script's only new need; managed-iac's `run.sh` and behaviour are unchanged. The script ships as
`deploy/helm-bundled/files/scp-infra.sh` in a ConfigMap, byte-identical (helm-verify) to the file the
integration test runs. The air-gap `install.sh` retargets `catalog.infra.image` to the same
digest-pinned ref it gives `managedIac.runnerImage`.

## Consequences

- **Parity.** API: `POST /changes` with `properties.infrastructure.applyPlan`; the evidence on
  `GET /changes/{id}:explain`. SDK/`ScpClient`: the existing `changes.propose`/`explain`/`accept`;
  the declaration's schema and property name are exported from `@scp/schemas`. CLI:
  `scp change propose --apply-plan <id>`, and `scp change explain` prints each target's plan.
  UI: the existing plan chip renders the evidence; an accepted plan change offers "Apply this plan";
  an apply change names its plan. IaC: the binding (`type: infrastructure`,
  `externalRef: scp-infra-plan-v1`) and the target's `environment` are already declarable through
  coordination-as-code; a plan and its apply are runtime changes, not desired state — N/A.
- **An apply has two approvals of different kinds**: the plan change's acceptance (the approval of
  the plan) and, afterwards, the apply change's own acceptance (acceptance of the result). Only the
  first gates the trigger.
- **Rollback is not replay.** A rollback of an infrastructure change through this lane is refused;
  rolling infrastructure back is planning the prior commit and applying that plan through the same
  gate.
- **Not proved here:** Argo itself. The integration test drives the real reconcile loop and the real
  plugin against a loopback Argo API and runs the real script in the real image, but no workflow
  controller ever evaluated these templates; `tools/helm-verify` holds the rendered wiring (args,
  outputs, required parameters, hardening, script bytes) to the script's contract instead. The
  `globalName` → `status.outputs` channel is Argo's documented behaviour and was not observed live.
- **Not proved here:** a real cloud provider. The counterparty run uses the local backend and the
  built-in `terraform_data` resource (no provider download, no network).
- **Two concurrent applies of the same workspace from different plans** are serialised only by the
  state backend's lock (`-lock-timeout=120s`); the server serialises decisions per target, not per
  workspace. An Argo `synchronization` mutex keyed on the workspace would close this and was not
  added untested.
- **managed-iac's own apply path still has no production caller** (above). D2 keeps it unchanged;
  this ADR records the measurement rather than acting on it.
