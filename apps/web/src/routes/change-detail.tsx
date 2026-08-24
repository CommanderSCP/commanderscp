import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import type { Change, ChangeState, ChangeStageDependencyTarget } from "@scp/sdk";
// M4 governance types: @scp/schemas, not @scp/sdk — @scp/sdk's index.ts only re-exports the M3
// (and earlier) wire types; M4 never added ApprovalRequest/Freeze/etc. there. Importing
// @scp/schemas directly here is within bounds (eslint.config.mjs's own restricted-imports rule:
// "apps/web/src may import only @scp/sdk and @scp/schemas"), matching how packages/cli/src/cli.ts
// already sources these exact same types.
import type { ApprovalRequest } from "@scp/schemas";
import { client } from "../lib/client";
import { changeApprovalsKey, changeDetailKey, changeListKey } from "../lib/query-client";
import { useIdParam } from "../lib/use-route-params";
import { ForeignOriginNotice, isForeignOriginObject, useOwnDomainId } from "../lib/replica-origin";
import { DomainLocalBadge } from "../components/domain-local";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/ui/page-header";
import { Skeleton } from "../components/ui/skeleton";
import { QueryErrorNotice } from "../components/query-error";
import { stateBadgeVariant } from "../lib/change-format";
import { PipelineWaveCard } from "../components/pipeline/PipelineWaveCard";
import { useObjectNames } from "../lib/use-object-names";
import { PromotionArrow } from "../components/pipeline/PromotionArrow";
import { formatDate, wavePromotion } from "../components/pipeline/wave-status";
import { WhyLink } from "../components/decision/WhyLink";
import { ReasonDialog } from "../components/decision/ReasonDialog";
import { decisionIdOf, decisionSummary } from "../components/decision/decision-format";

// Legacy re-exports: service-board.tsx (group B) still imports these from here; the canonical home
// is the shared pipeline module (design spec §2.13). Deleted once every importer migrates.
export { formatDate, waveStatusVariant } from "../components/pipeline/wave-status";

// States from which each guarded transition (coordination/transitions.ts LEGAL_TRANSITIONS) is
// legal — mirrored here so the UI never offers an action the server would reject.
const CANCELLABLE_STATES: ChangeState[] = [
  "proposed",
  "evaluated",
  "coordinated",
  // M12 P4B: a change parked in `waiting` on a cross-change prerequisite is pre-acceptance and so is
  // cancellable (transitions.ts allows waiting->cancelled) — an operator must be able to abort a
  // waiter whose prerequisite will never arrive.
  "waiting",
  "executing",
  "validating"
];
const ACCEPTABLE_STATES: ChangeState[] = ["validating"];
const ROLLBACKABLE_STATES: ChangeState[] = ["executing", "validating", "accepted"];

/**
 * `/changes/{id}` (BUILD_AND_TEST.md §8 M3 UI requirement: "...+ wave progression view") — one
 * `client.changes.explain()` call gets the change, its compiled plan/waves, and every Decision
 * made about it. Polls every 3s (`refetchInterval`) because wave/target progress is written by
 * the server-side reconciliation loop, not user action — `scp.change.transitioned` (SSE,
 * lib/use-event-stream.ts) only fires on whole-change state transitions, not intra-wave progress,
 * so polling is the only mechanism that reliably surfaces live wave movement here.
 *
 * Body order (design spec §4C): wave progression, then Decisions — the explainability core —
 * directly after it, then Approvals/Control runs as compact cards.
 */
export function ChangeDetailPage(): React.JSX.Element {
  const id = useIdParam();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detailKey = changeDetailKey(id ?? "");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const { domainId: ownDomainId } = useOwnDomainId();

  const explainQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => client.changes.explain(id!),
    enabled: !!id,
    refetchInterval: 3000
  });

  async function invalidate(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: detailKey });
    await queryClient.invalidateQueries({ queryKey: changeListKey() });
  }

  const cancelMutation = useMutation({
    mutationFn: (reason: string) => client.changes.cancel(id!, reason || undefined),
    onSuccess: async () => {
      setCancelOpen(false);
      await invalidate();
    },
    // A blocked cancel still wrote a Decision (coordination/transition.ts always writes exactly
    // one, allow or block) — refetch so the "Why?" link below resolves to a row that's actually
    // in the timeline, not one still sitting behind a stale cached explain() response.
    onError: () => invalidate()
  });

  const acceptMutation = useMutation({
    mutationFn: () => client.changes.accept(id!),
    onSuccess: async () => {
      await invalidate();
    },
    onError: () => invalidate()
  });

  const rollbackMutation = useMutation({
    mutationFn: (reason: string) => client.changes.rollback(id!, reason),
    onSuccess: async (created: Change) => {
      setRollbackOpen(false);
      await invalidate();
      await navigate({ to: "/changes/$id", params: { id: created.id } });
    },
    onError: () => invalidate()
  });

  const approvalsKey = changeApprovalsKey(id ?? "");
  // DESIGN §10.2: "approval control instances materialize as approval tasks — actionable via
  // API, UI, and CLI." `GET /approvals` is always scoped to one changeId (routes/governance.ts),
  // so this lives on the change detail view rather than a standalone approvals page.
  const approvalsQuery = useQuery({
    queryKey: approvalsKey,
    queryFn: () => client.approvals.list({ changeId: id!, limit: 20 }),
    enabled: !!id,
    refetchInterval: 5000
  });

  const [voteError, setVoteError] = useState<string | null>(null);
  const voteMutation = useMutation({
    mutationFn: (approvalId: string) => client.approvals.vote(approvalId),
    onSuccess: async () => {
      setVoteError(null);
      await queryClient.invalidateQueries({ queryKey: approvalsKey });
      // A vote can be the one that satisfies quorum and unblocks a gate — refetch the change/
      // decision timeline too, not just the approval list.
      await invalidate();
    },
    onError: (err: unknown) => {
      setVoteError(err instanceof Error ? err.message : "Failed to cast vote");
    }
  });

  // Wave targets arrive as bare object ids (no name, no URN) — resolve them before the early
  // returns so the hook order is stable (spec §4C; supply side of PipelineWaveCard's `nameOf`).
  const targetNames = useObjectNames(
    (explainQuery.data?.plan?.waves ?? []).flatMap((w) => w.targets.map((t) => t.targetObjectId))
  );

  if (!id) {
    return <p className="text-sm text-red-600">Not found.</p>;
  }
  if (explainQuery.isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (explainQuery.isError || !explainQuery.data) {
    return <QueryErrorNotice error={explainQuery.error ?? "Not found"} what="this change" />;
  }

  const { change, plan, decisions, controlRuns, waitStatus, stageDependencyStatus } =
    explainQuery.data;
  // These three gate ONLY on change STATE — whether the button is offered AT ALL for this lifecycle
  // state.
  //
  // Accept/Rollback/Cancel are deliberately NOT additionally gated on the change's federation
  // origin — and that is STILL correct, though for the opposite reason it used to be.
  //
  // WAS (M16.3 P2): the server did not refuse these on a foreign-origin change at all, so a UI
  // gate would have simulated an enforcement that did not exist — which is exactly the defect PR
  // #152 removed. That open question ("whether the server SHOULD refuse an accept on a change
  // another domain drives") is now ANSWERED: S10 / PR #171 added
  // `coordination/transition.ts`'s `enforceLocalChangeAuthority`, and all three verbs are refused
  // with a 409 carrying `decision_id`. `foreign-origin-writes.integration.test.ts` measures the
  // refusals; the "cancel SUCCEEDS" and "accept/rollback SUCCEED from validating" cases this
  // comment used to cite no longer exist.
  //
  // IS: the buttons stay ungated on origin because the server's refusal is the thing worth
  // showing. Blocking client-side would swallow the 409 and its `decision_id` — the record that
  // makes the block explainable (charter principle 6) — and would re-introduce a second copy of an
  // authority rule that lives in one place on the server. State remains the only client-side gate.
  const canCancel = CANCELLABLE_STATES.includes(change.state);
  const canAccept = ACCEPTABLE_STATES.includes(change.state);
  const canRollback = ROLLBACKABLE_STATES.includes(change.state);
  // Provenance badge only — never a gate (see above).
  const foreign = isForeignOriginObject(change.originDomainId, ownDomainId);
  const waves = plan?.waves ?? [];
  // ADR-0028 increment 4 — mirrors `change-pipeline.tsx`'s `holdFor` exactly (M25.UI review minor
  // finding 1). Without this, `heldTargetCount`'s badge here (composed from BOTH the freeze and
  // stage-dependency halves — routes/changes.ts) told an operator "see each target's own hold
  // line for which" while no stage-dependency hold line existed on this page at all: `explain`
  // was already loaded, `stageDependencyStatus` was already sitting on the response, and the only
  // thing missing was threading it through.
  function holdFor(target: { targetObjectId: string }): ChangeStageDependencyTarget | null {
    const found = stageDependencyStatus?.targets.find(
      (entry) => entry.targetObjectId === target.targetObjectId
    );
    return found?.held ? found : null;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={<span data-testid="change-name">{change.name}</span>}
        description={
          <>
            {change.sourceKind ? `Source: ${change.sourceKind}` : "No source kind"}
            {change.correlationKey && (
              <>
                {" · Correlation key: "}
                <span className="break-all font-mono text-xs text-slate-600">
                  {change.correlationKey}
                </span>
              </>
            )}
          </>
        }
        meta={
          <>
            <Badge variant={stateBadgeVariant(change.state)} data-testid="change-state-badge">
              {change.state}
            </Badge>
            {change.emergency && <Badge variant="danger">Emergency</Badge>}
            {/* M20-A3 (ADR-0031 §5) — the same badge every domain-local object wears, keyed on this
                change's own wire `domainLocal` (inherited from its targets at propose). */}
            {change.domainLocal && <DomainLocalBadge />}
            {foreign && change.originDomainId && (
              <ForeignOriginNotice originDomainId={change.originDomainId} />
            )}
            {change.rollbackOfObjectId && (
              <span className="text-xs text-slate-500">
                Rollback of{" "}
                <Link
                  to="/changes/$id"
                  params={{ id: change.rollbackOfObjectId }}
                  className="font-mono text-slate-700 hover:underline"
                >
                  {change.rollbackOfObjectId}
                </Link>
              </span>
            )}
          </>
        }
        actions={
          <>
            <Link to="/changes/$id/pipeline" params={{ id }} data-testid="view-pipeline-link">
              <Button variant="outline" size="sm">
                Pipeline view
                <ArrowRight className="size-4" strokeWidth={2} aria-hidden="true" />
              </Button>
            </Link>
            {canAccept && (
              <Button
                onClick={() => acceptMutation.mutate()}
                disabled={acceptMutation.isPending}
                data-testid="accept-change-button"
              >
                {acceptMutation.isPending ? "Accepting…" : "Accept"}
              </Button>
            )}
            {canRollback && (
              <Button
                variant="outline"
                onClick={() => setRollbackOpen(true)}
                data-testid="rollback-change-button"
              >
                Rollback
              </Button>
            )}
            {canCancel && (
              <Button
                variant="destructive"
                onClick={() => setCancelOpen(true)}
                data-testid="cancel-change-button"
              >
                Cancel
              </Button>
            )}
          </>
        }
      />

      {acceptMutation.isError && (
        <p className="text-sm text-red-600" data-testid="accept-error">
          {acceptMutation.error instanceof Error
            ? acceptMutation.error.message
            : "Failed to accept"}
          {decisionIdOf(acceptMutation.error) && (
            <>
              {" "}
              <WhyLink decisionId={decisionIdOf(acceptMutation.error)!} />
            </>
          )}
        </p>
      )}

      {waitStatus && (
        <Card size="compact" data-testid="wait-status-card">
          <CardHeader>
            <CardTitle>
              {waitStatus.waiting
                ? (() => {
                    const outstanding = waitStatus.requirements.filter((r) => !r.satisfied).length;
                    // Real pluralization (copy rule 6) — never "(s)".
                    return `Waiting on ${outstanding} prerequisite${outstanding === 1 ? "" : "s"}`;
                  })()
                : "Coupled prerequisites"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {waitStatus.requirements.map((req) => (
              <div
                key={`${req.key}@${req.at}`}
                className="flex items-center justify-between gap-4 text-sm"
                data-testid="wait-requirement"
              >
                <span className="font-mono text-slate-700">
                  {req.key} @ {req.atName ?? req.at}
                </span>
                {req.satisfied ? (
                  <Badge variant="success">
                    satisfied
                    {req.satisfiedByChangeId && (
                      <>
                        {" · "}
                        <Link
                          to="/changes/$id"
                          params={{ id: req.satisfiedByChangeId }}
                          className="underline"
                        >
                          by change
                        </Link>
                      </>
                    )}
                  </Badge>
                ) : (
                  <Badge variant="neutral">outstanding</Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Wave progression</CardTitle>
        </CardHeader>
        <CardContent>
          {!plan && (
            <p className="text-sm text-slate-500" data-testid="no-plan-message">
              No plan compiled yet.
            </p>
          )}
          {plan && waves.length === 0 && (
            <p className="text-sm text-slate-500">Plan compiled with no waves.</p>
          )}
          {plan && waves.length > 0 && (
            // Vertical, with PromotionArrow connectors — the same shape as the pipeline tab
            // (§2.13: PromotionArrow is the only wave connector; the generalized PipelineWaveCard
            // means this tab never shows less than the pipeline tab).
            <div className="flex flex-col items-center gap-1" data-testid="wave-progression">
              {waves.map((wave, index) => {
                const next = waves[index + 1];
                const promo = next ? wavePromotion(wave, next) : undefined;
                return (
                  <div key={wave.id} className="flex w-full flex-col items-center gap-1">
                    {/* `testIdPrefix="wave"` keeps this tab's historical `wave-card` /
                        `wave-status-badge` / `wave-target-row` testids on the same elements. */}
                    <PipelineWaveCard
                      wave={wave}
                      waveNumber={index + 1}
                      testIdPrefix="wave"
                      nameOf={(tid) => targetNames.get(tid)?.name}
                      holdFor={holdFor}
                    />
                    {promo && <PromotionArrow state={promo.state} label={promo.label} />}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Decisions</CardTitle>
        </CardHeader>
        <CardContent>
          {decisions.length === 0 ? (
            <p className="text-sm text-slate-500">No decisions yet.</p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="decision-timeline">
              {decisions.map((decision) => {
                // Whichever blocked action (if any) is currently displaying a "Why?" link that
                // points here — highlighted so following the link visibly lands on its target,
                // not just scrolls the page with no feedback.
                const isLinkedFromError =
                  decision.id === decisionIdOf(acceptMutation.error) ||
                  decision.id === decisionIdOf(cancelMutation.error) ||
                  decision.id === decisionIdOf(rollbackMutation.error);
                return (
                  <li
                    key={decision.id}
                    id={`decision-${decision.id}`}
                    className={`rounded-md border p-3 text-sm ${
                      isLinkedFromError ? "border-red-400 ring-2 ring-red-300" : "border-slate-200"
                    }`}
                    data-testid="decision-row"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900">{decision.kind}</span>
                      <Badge variant={decision.verdict === "allow" ? "success" : "danger"}>
                        {decision.verdict}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{formatDate(decision.createdAt)}</p>
                    <p className="mt-1 text-slate-600">{decisionSummary(decision)}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {approvalsQuery.data && approvalsQuery.data.items.length > 0 && (
        <Card size="compact">
          <CardHeader>
            <CardTitle>Approvals</CardTitle>
          </CardHeader>
          <CardContent>
            {voteError && (
              <p className="mb-2 text-sm text-red-600" data-testid="vote-error">
                {voteError}
              </p>
            )}
            <ul className="flex flex-col gap-3" data-testid="approval-list">
              {approvalsQuery.data.items.map((approval: ApprovalRequest) => (
                <li
                  key={approval.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-3 text-sm"
                  data-testid="approval-row"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900">
                        {approval.voteCount} / {approval.requiredCount} from {approval.fromRole}
                      </span>
                      <Badge variant={approval.status === "satisfied" ? "success" : "neutral"}>
                        {approval.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      Requested {formatDate(approval.createdAt)}
                    </p>
                  </div>
                  {approval.status !== "satisfied" && (
                    <Button
                      size="sm"
                      onClick={() => voteMutation.mutate(approval.id)}
                      disabled={voteMutation.isPending}
                      data-testid="approve-button"
                    >
                      {voteMutation.isPending ? "Voting…" : "Approve"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {controlRuns.length > 0 && (
        <Card size="compact">
          <CardHeader>
            <CardTitle>Control runs</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Evidence lives here, not on the Decision above — the Decision only ever carries
                the outcome STATUS per control (reasonTree.policies[].effects[].detail); joined by
                controlObjectId, this is the other half of "explain reconstructs policy version +
                control outcome + evidence" (DESIGN §10.4). */}
            <ul className="flex flex-col gap-3" data-testid="control-run-list">
              {controlRuns.map((run) => (
                <li
                  key={run.id}
                  className="rounded-md border border-slate-200 p-3 text-sm"
                  data-testid="control-run-row"
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="break-all font-mono text-xs text-slate-900">
                      {run.controlObjectId}
                    </span>
                    <Badge
                      variant={
                        run.status === "pass"
                          ? "success"
                          : run.status === "warning"
                            ? "warning"
                            : "danger"
                      }
                    >
                      {run.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{formatDate(run.createdAt)}</p>
                  {run.detail && <p className="mt-1 text-slate-600">{run.detail}</p>}
                  {Object.keys(run.evidence).length > 0 && (
                    <pre className="mt-1 overflow-x-auto rounded-md bg-slate-50 p-2 text-xs text-slate-600">
                      {JSON.stringify(run.evidence, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <ReasonDialog
        open={cancelOpen}
        title="Cancel change"
        description="Cancelling stops this change before it is accepted. This cannot be undone."
        reasonRequired={false}
        pending={cancelMutation.isPending}
        errorMessage={
          cancelMutation.isError
            ? cancelMutation.error instanceof Error
              ? cancelMutation.error.message
              : "Failed to cancel"
            : null
        }
        errorDecisionId={decisionIdOf(cancelMutation.error)}
        onOpenChange={setCancelOpen}
        onSubmit={(reason) => cancelMutation.mutate(reason)}
        submitLabel="Cancel change"
        testIdPrefix="cancel-change"
      />

      <ReasonDialog
        open={rollbackOpen}
        title="Rollback change"
        description="Creates a new Change that rolls back this one. A reason is required."
        reasonRequired
        pending={rollbackMutation.isPending}
        errorMessage={
          rollbackMutation.isError
            ? rollbackMutation.error instanceof Error
              ? rollbackMutation.error.message
              : "Failed to roll back"
            : null
        }
        errorDecisionId={decisionIdOf(rollbackMutation.error)}
        onOpenChange={setRollbackOpen}
        onSubmit={(reason) => rollbackMutation.mutate(reason)}
        submitLabel="Roll back"
        testIdPrefix="rollback-change"
      />
    </div>
  );
}
