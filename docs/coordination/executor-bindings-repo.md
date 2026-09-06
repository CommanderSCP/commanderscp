# executor-bindings-repo

Reference for `apps/server/src/coordination/executor-bindings-repo.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 37 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE LANE FALLBACK, IN ONE PLACE

THE LANE FALLBACK, IN ONE PLACE (ADR-0046 section 4; proposal section 14 resolution 7).

Ask for a lane; get that lane's binding, or the BUILD lane's when the requested lane is not separately declared. The result says which happened.

WHY THIS IS A HELPER AND NOT TWO LINES AT EACH CALL SITE. There are two consumers by design — the reconciler, which must not report a spurious GAP for a test lane the build lane already covers, and the hook-run dispatcher, which must not fail to dispatch because a domain never separated its lanes. Written twice, one copy later grows a condition the other does not, and the divergence is invisible: both still return a binding, just different ones.

FALLBACK IS READ-TIME, NEVER STORED. The reconciler writes rows only for lanes someone actually declared. Materialising a test-lane row that merely duplicates the build lane would double every target's rows and leave two records to keep in step — and it would be wrong for the estates that have no binding policy at all, which is every estate today.

## §2. WHICH LANE to delete

WHICH LANE to delete. Defaults to `"build"`, which is what both existing callers (the DELETE route and `iac/plans-repo.ts`'s apply-time prune) mean.

THIS PARAMETER CLOSES A DEFECT THE LANE COLUMN OPENED, and it is worth stating plainly because the column shipped one commit earlier (migration 0105): this DELETE was keyed on `(org, target, type)`, so once a target held two lanes it deleted BOTH ROWS and then audited exactly one of them — `.returning()` destructures the first. The identity grew a dimension and three consumers had to grow with it; `getExecutorBinding` and `upsertExecutorBinding` were updated with the column, and this one was not. Latent rather than live (nothing wrote a test lane until the reconciler existed), and fixed before the reconciler starts pruning per lane.

## §3. THE GRANTED CAPABILITY

THE GRANTED CAPABILITY (owner decision 2026-08-20, ADR-0035 §6). Enabling it here is only half the change: without `secrets: create,delete` in the chart's Role the Secret POST 403s, so the chart renders the RBAC and sets this variable from the SAME value.

THE CODE DEFAULT STAYS `false` WHILE THE CHART DEFAULT IS `true`, AND THAT ASYMMETRY IS DELIBERATE. This flag does not mean "per-run Secrets are a good idea"; it means "the RBAC to create them EXISTS in this namespace", and only the thing that rendered the RBAC knows that. The chart does, so it says so. A hand-rolled Kubernetes deployment that never applied a Role does not, and for it the honest answer is the named refusal at step `secret-env` rather than a 403 from inside a promotion, minutes in. Absent env var => the deployment made no such claim. See `KubernetesRunnerLauncherConfig.perRunSecrets`.
