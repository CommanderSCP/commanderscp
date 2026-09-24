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
approval system beside the first. (Owner ruling 2026-09-24: keep the two-change shape.)

**1a. Separation of duties, by default.** (The proposer is the change's `propose` actor AND, for a
system-proposed change such as a change-source report, the subject who declared it —
`declarationActorId` on the propose Decision — so the human who reported a plan cannot accept it
either; re-verification finding 9.) Accepting an infrastructure PLAN change (Type
`infrastructure`, no apply declaration, and actually planned by this lane — a recorded
`infra_plan_trigger`; an infrastructure change driven by any other executor, such as a machine-image
publication, is not approving a plan for apply and keeps its old meaning) is refused when the acceptor is the change's proposer — read
from the change's `propose` transition Decision — or when no proposer is recorded
(`infra_plan_separation_of_duties`, `gates.ts`, ahead of governance on the `validating → accepted`
edge). "An approved plan" must mean someone other than the person who wanted it approved it. It is
not an opt-in policy: it is what this acceptance means. There was no existing proposer-≠-acceptor
mechanism to reuse (quorum policies count votes, not who proposed), so this is the narrowest check
at the one edge that approves.

**2. The apply gate is enforced by the server, before `trigger()`, in the claim transaction.**
`infraLaneTriggerParameters` (the seam D2 named) refuses — terminal, Decision + hash-chained audit,
`infra_apply_refused` — unless:

- the named plan change exists, is a plan (not an apply, not a rollback) and is **`accepted`**;
- it has a **succeeded** plan at *this* target, run by the **same executor instance** that would
  apply it, with a sha256 **digest** and a **recorded submission** (below);
- the target's place (`environment`, `region`, workspace, `infrastructurePath`,
  `infrastructureRepo`) and its binding's plan template **still match what the plan recorded**
  (`infra_plan_scope_changed` otherwise — verification probes A and B);
- **no newer plan** has been dispatched at this target since, in DISPATCH order — the time-ordered
  ids of the plan-trigger Decisions, not wave-target creation order;
- no other apply of this plan is **in flight**. Apply decisions for one target are serialised by a
  transaction-scoped advisory lock, so two workers cannot both see the other's claim as absent.

**What a plan submitted is recorded, and the apply reuses it — never re-derives it.** Every
plan (and apply) trigger writes an append-only `infra_plan_trigger` Decision in the claim transaction
carrying the exact template, the plan template's `-apply` sibling, the executor instance and every
parameter sent (`recordInfraTrigger`). The apply is built from that record: the same workspace,
directory, repo, commit, and the RECORDED apply template — never whatever the binding names today.
Re-deriving at apply time is how an approval of workspace `…-r1` became an apply into `…-r2` with the
old digest (probe A, measured `applied:true` against real tofu before this fix).

If an apply of this plan has already **succeeded** at this target, the new apply is a **no-op**:
the wave target succeeds, nothing is triggered, and an `allow` Decision (`infra_apply_noop`, naming
the change that did apply it) and an audit event record why.

A change that DECLARES an apply on a target whose pipeline is not this lane (managed-iac, the
default executor, any other module) is **refused** (`infra_apply_lane_absent`), never silently run as
that executor's default action.

**3. The apply is bound to the plan by digest, and the digest covers the plan's PLACE.** The digest
is sha256 over the plan's change set — `resource_changes` and `output_changes` of `tofu show -json`,
keys sorted by jq — AND its scope: environment, workspace, repo, commit, directory, and the
backend's type + a sha256 of its settings file. Never the whole document, which carries a
timestamp. Two plans with one digest make the same changes in the same state. The template re-plans
at the recorded commit, in the recorded workspace, and:

- nothing to do (`tofu plan -detailed-exitcode` = 0) → **no-op success**;
- digest ≠ approved → **refuses** (exit 3): state, inputs or place changed since approval;
- digest = approved → applies that plan file.

Measured (`infra-lane.integration.test.ts`, real `scp-runner-iac` image): two plans of the same inputs
share a digest; an apply with the approved digest applies; the re-plan after it reports `0 add / 0
change / 0 destroy`; a re-apply is a no-op; a wrong digest exits 3; **the same changes planned into
another workspace have a different digest, and applying the first's digest there exits 3**.

**4. The plan's evidence reaches SCP as the workflow's global outputs.** The templates export
`scpPlanDigest`, `scpPlanAdd`, `scpPlanChange`, `scpPlanDestroy` (and `scpPlanApplied`) with
`globalName`, which Argo puts on the Workflow's own `status.outputs` — the object `status()` already
fetches. The plugin reads them all-or-nothing (absent ≠ zero), and only a settled workflow's.

**5. The shipped infra templates have ONE door.** An `infrastructure` binding on Argo Workflows names
its PLAN template; the apply template is its `-apply` sibling (`infraApplyTemplateFor`), recorded at
plan time. Both `scp-infra-plan-v*` and `scp-infra-apply-v*` are reachable ONLY through this lane,
enforced twice:

- in `reconcile.ts`, with a Decision: any trigger the lane did not derive whose target ref names
  either template is refused (`infra_template_outside_lane` — a `configuration` binding pointed at
  `scp-infra-plan-v1` with a recipe steering the workspace, probe D);
- at the plugin host's executor client (`plugin-host/infra-template-guard.ts`), the one door every
  server path to an executor passes — wave triggers, declared-hook runs (`pipeline-hook-runs.ts`),
  continuous-probe schedules (`continuous-probe-driver.ts`), dependency bumps (`bump-dispatch.ts`,
  `bump-gate.ts`). A trigger naming an infra template is refused unless the intent OBJECT is the one
  the lane built (a WeakSet, so nothing in data — a parameter, a recipe, a binding, a replicated row —
  can forge it); a schedule naming one is always refused. Census of submitting sites run with no
  filters (`grep -rna '\.trigger(\|ensureSchedule('`); the host is the choke point rather than a
  guard per site because the next caller would escape a per-site census.

**6. Reserved parameters.** `environment`, `stateWorkspace`, `region`, `infraPath`, `sourceRepo`,
`sourceCommit`, `sourceRef`, `planDigest`, `planChangeObjectId`, `changeObjectId`, `targetObjectId`
(`INFRA_LANE_RESERVED_PARAMETERS`). THREE layers: the server-wide table M28.4 built
(`reserved-trigger-parameters.ts`, `RESERVED_BY_LANE.infra`, for an `infrastructure`-Category Type)
refuses a recipe naming `environment`, `stateWorkspace`, `region`, `infraPath`, `planDigest`,
`planChangeObjectId` or `targetObjectId` before any lane runs (`recipe_reserved_parameter`); the
source keys are conveniences for the build lane in that table, so the lane itself refuses a recipe
naming them (`infra_recipe_restates_bound`); and the lane's values are spread last. Outside the lane,
§5 refuses the template itself.

**7. Scoped to one target; its source is declared; state belongs to the operator.** The wave target
is a `deployment-target`, which must declare:

- `properties.environment` (e.g. `prod-us-east-1`), and optionally `region`;
- `properties.infrastructureRepo` — the ONE repo its infrastructure comes from. A plan whose
  `sourceRef.repo` is anything else is refused (`infra_source_not_declared`), and a target declaring
  none refuses every plan (`infra_source_undeclared`);
- optionally `properties.infrastructurePath` (default the repo root).

**7a. The repo's AUTHORITY lives on the execution system (owner ruling R1, 2026-09-24).** The target's
`infrastructureRepo` is written with `object:write`, so it alone was circular: an Operator re-declared
it as `attacker/evil` and had that planned with the plan credentials (re-verification probe C2). A
plan now runs only if its repo is ALSO in the binding's execution system's **source allowlist** —
`owner/name` or `owner/*` entries, stored in its own table (`execution_system_source_allowlists`,
migration 0123) and written through ONE door: `PUT /v1/execution-systems/{id}/source-allowlist`, with
`secret:write` at the org root (the class that sets a secret; audit event
`execution_system.source_allowlist.set`). Not a property on the execution-system object — object
properties are written with `object:write` through the object routes, coordination-as-code and
federation replication, and a look-alike `properties.sourceAllowlist` has no effect (tested). The
table is never replicated and has no IaC construct; `infra-lane-reachability.test.ts` holds that the
route is its only writer. An INLINE binding has no execution system and so no allowlist: refused
(`infra_source_no_execution_system`). The apply re-checks the recorded repo against the allowlist as
it is then (a narrowed allowlist withdraws the permission). API → SDK (`executors.put/getSourceAllowlist`)
→ CLI (`scp execution-system source-allowlist set|get`) → UI (read-only card on the execution
system's page — it is set with `secret:write`, not from a page any reader reaches). This departs from
"new concepts as graph data" deliberately, for the same reason M28.2's Argo host-ops pin does: a bound
on what runs with credentials cannot be data its own subject can write.

The plan's record also carries the execution system's identity (id, `serverUrl`, `namespace`), and
an apply is refused if the system was re-pointed since (`infra_plan_scope_changed`, probe E).

Each target gets its own OpenTofu workspace, `<environment-slug>-<12 hex>` (`deriveStateWorkspace`):
the slug is the lowercased environment and region, the digest is sha256 of org + target + region, and
the whole is a lowercase RFC 1123 label of at most 63 characters, because the strictest backend —
`kubernetes`, which labels each workspace's Secret `tfstateWorkspace=<workspace>` — caps a label value
at 63 (every earlier name was ≥ 78). A digest collision is checked, not assumed away: a plan whose
workspace another target's plan already used is refused (`infra_workspace_collision`). A plan must be
pinned to a full commit id.

The **state backend is chart values** (`catalog.infra.stateBackend.type` + non-secret `config`),
rendered into a `-backend-config` file and supplied by an override the script writes. A directory
carrying ANY other override file — `override.*` or `*_override.*` in all four spellings OpenTofu reads,
`.tf`, `.tf.json`, `.tofu`, `.tofu.json` — is **refused before init**: overrides merge in lexical order
and the last wins, and an org `zz_override.tf`, then a `zz_override.tofu` with `backend "http"`, beat
the script's override (both measured by the verification). With the script's override the ONLY one,
it replaces whatever `backend` or `cloud` block a NORMAL file declares, however written — `.tofu`,
JSON, a comment between the keyword and the label — so the script does not text-match HCL at all
(an earlier regex/`jq` pass let `state.tf.json` and `backend /* x */ "http"` through); instead, after
`init`, it reads OpenTofu's OWN record of the backend it configured (`.terraform/terraform.tfstate`
`.backend.type`) and refuses anything but the operator's. Fixtures c1–c4 from the re-verification are
permanent in `infra-lane.integration.test.ts`: the override spellings are refused, and each normal-file
backend plans against the operator's `local` state, never `http`. The templates do not render until a
backend is named, and a backend with no image fails the render.

**Credentials are per phase.** `scp-infra-plan-credentials` and `scp-infra-apply-credentials`, each an
operator-provisioned Secret mounted with `envFrom`, and each phase its own ServiceAccount
(`scp-infra-plan` / `scp-infra-apply`, both at the executor's `workflowtaskresults` floor) for workload
identity. **The plan's cloud credentials must be read-only**: a plan runs the repository's code
before anyone has approved anything. Its state-backend access is read + lock (a consistent plan
takes the lock) plus creating the workspace on an environment's first plan. Only the apply identity,
reached solely through the gate, may change infrastructure. SCP holds none of these; no credential
grant was extended (charter principle 1).

**Concurrency.** Both templates hold the Argo mutex `scp-infra-{{workflow.parameters.stateWorkspace}}`
(`spec.synchronization.mutexes`, present in the vendored v4.0.7 Workflow CRD as "v3.6 and after"), so
a plan and an apply of one workspace — or two applies of different plans — queue instead of racing
the backend's lock. That a mutex NAME may be parameterised is Argo's documented form; the CRD only
types it as a string, and no live controller in this repo has evaluated it.

**8. One image.** The templates run the existing `scp-runner-iac` image (tofu 1.12.6 copied out of
the upstream image, which carries `ONBUILD RUN exit 1` and cannot be a base). It gains `jq`, the
script's only new need (owner ruling 2026-09-24: acceptable in the shared image); managed-iac's
`run.sh` and behaviour are unchanged. The script ships as `deploy/helm-bundled/files/scp-infra.sh` in a
ConfigMap, byte-identical (helm-verify) to the file the integration test runs. The air-gap
`install.sh` retargets `catalog.infra.image` to the same digest-pinned ref it gives
`managedIac.runnerImage`.

## Consequences

- **Parity.** API: `POST /changes` with `properties.infrastructure.applyPlan`; the evidence on
  `GET /changes/{id}:explain`. SDK/`ScpClient`: the existing `changes.propose`/`explain`/`accept`;
  the declaration's schema and property name are exported from `@scp/schemas`. CLI:
  `scp change propose --apply-plan <id>`, and `scp change explain` prints each target's plan (both
  proved through commander end to end). UI: the existing plan chip renders the evidence; an accepted
  plan change offers "Apply this plan" — only for a plan the Argo lane ran; an apply change names its
  plan. IaC: the binding (`type: infrastructure`, `externalRef: scp-infra-plan-v1`) and the target's
  `environment`/`infrastructureRepo` are declarable through coordination-as-code; a plan and its
  apply are runtime changes, not desired state — N/A.
- **An apply has two approvals of different kinds**: the plan change's acceptance (the approval of
  the plan, by someone other than its proposer) and, afterwards, the apply change's own acceptance.
  Only the first gates the trigger.
- **Rollback is not replay.** Rolling infrastructure back is planning the prior commit and applying
  that plan through the same gate.
- **A pruned plan-trigger Decision fails closed**: an apply whose plan's record is gone is refused
  (`infra_plan_record_missing`), never re-derived.
- **Not proved here:** Argo itself (no workflow controller evaluated these templates; helm-verify
  holds the rendered wiring, and `globalName` → `status.outputs` and a templated mutex name are
  Argo's documented behaviour, not observed live); a real cloud provider (local backend,
  `terraform_data`).
- **managed-iac's apply** has no production caller (nothing sets `iacAction`). Owner ruling
  2026-09-24: bind it to an accepted plan's digest by this lane's rule, in a separate follow-on PR in
  M28.

## Addendum (2026-09-24) — what the adversarial verification of PR #415 found, and the fix

Two blocking holes, both found by probes that went red against the first version: the apply re-derived
its place at apply time and the digest did not cover the place (probe A: approved for region r1,
applied into r2, `applied:true` against real tofu; probe B: plan template swapped after approval); and
a plan ran whatever repo the proposer named with the operator's credentials (probe C). Plus: the
side-door guard covered only the apply template and only the wave-trigger path (probe D); an org
override file could replace the state backend; a declared apply on a non-Argo executor was silently
ignored; no separation of duties; state shared by environment name across targets and orgs. Each is
fixed above (§1a, §2, §3, §5, §7) and each fix has a test that goes red when it is removed (PR body).
The build lane had the same repo property; see ADR-0053's addendum.

**Re-verification (2026-09-24, second round)** found the repo binding circular (the target's
`infrastructureRepo` is `object:write`; probe C2) and the backend refusal incomplete (`.tofu`
overrides, a JSON backend and a commented `backend` keyword passed the regex/`jq` checks). Fixed by
§7a (the execution system's source allowlist, owner ruling R1) and by refusing every override
spelling and reading OpenTofu's own configured-backend record instead of parsing HCL (§7). Also: the
workspace now fits a Kubernetes label (≤ 63, finding 10); separation of duties reads the declarer of a
system-proposed plan (finding 9); the plan's record carries the execution system's identity (NIT);
the lane's keys are registered in M28.4's reserved-key table (§6); and the build lane refuses a
component with no source mapping of its Type (owner ruling R2, ADR-0053 addendum).
