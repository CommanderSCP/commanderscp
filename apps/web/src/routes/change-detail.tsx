import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScpApiError, type Change, type ChangeState, type ChangeWave, type ChangeWaveTarget, type Decision } from "@scp/sdk";
import { client } from "../lib/client";
import { changeDetailKey, changeListKey } from "../lib/query-client";
import { useIdParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge, type BadgeProps } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import { stateBadgeVariant } from "./change-list";

// States from which each guarded transition (coordination/transitions.ts LEGAL_TRANSITIONS) is
// legal — mirrored here so the UI never offers an action the server would reject.
const CANCELLABLE_STATES: ChangeState[] = [
  "proposed",
  "evaluated",
  "coordinated",
  "executing",
  "validating"
];
const PROMOTABLE_STATES: ChangeState[] = ["validating"];
const ROLLBACKABLE_STATES: ChangeState[] = ["executing", "validating", "promoted"];

function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Wave/wave-target `status` -> Badge variant. Values are free-form strings server-side
 *  (ChangeWaveSchema/ChangeWaveTargetSchema), but the reconciliation loop only ever writes
 *  pending/running/succeeded/failed (DESIGN.md §9.3) — anything else falls back to `secondary`. */
function waveStatusVariant(status: string): BadgeProps["variant"] {
  switch (status) {
    case "running":
      return "info";
    case "succeeded":
      return "success";
    case "failed":
      return "destructive";
    case "pending":
      return "outline";
    default:
      return "secondary";
  }
}

/** The currently-active wave (`running`) gets a highlighted border; `failed` a red one; others muted. */
function waveCardClass(status: string): string {
  switch (status) {
    case "running":
      return "border-blue-500 ring-1 ring-blue-500";
    case "failed":
      return "border-red-400";
    case "succeeded":
      return "border-green-300";
    default:
      return "border-slate-200 opacity-75";
  }
}

function WaveCard({ wave }: { wave: ChangeWave }): React.JSX.Element {
  return (
    <Card className={`w-80 shrink-0 ${waveCardClass(wave.status)}`} data-testid="wave-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            Wave {wave.waveIndex}
            {wave.name ? `: ${wave.name}` : ""}
          </CardTitle>
          <Badge variant={waveStatusVariant(wave.status)} data-testid="wave-status-badge">
            {wave.status}
          </Badge>
        </div>
        <p className="text-xs text-slate-500">
          Started {formatDate(wave.startedAt)} · Completed {formatDate(wave.completedAt)}
          {wave.requiresFanIn ? " · requires fan-in" : ""}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {wave.targets.length === 0 && <p className="text-sm text-slate-500">No targets.</p>}
        {wave.targets.map((target: ChangeWaveTarget) => (
          <div
            key={target.id}
            className="rounded border border-slate-200 p-2 text-xs"
            data-testid="wave-target-row"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-900">
                {target.targetName ?? target.targetUrn ?? target.targetObjectId}
              </span>
              <Badge variant={waveStatusVariant(target.status)}>{target.status}</Badge>
            </div>
            <p className="mt-1 text-slate-500">
              attempt {target.attempt} · last observed {formatDate(target.lastObservedAt)}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function decisionSummary(decision: Decision): string {
  const summary = decision.reasonTree.summary;
  if (typeof summary === "string") return summary;
  return JSON.stringify(decision.reasonTree);
}

/** Every gate/policy block surfaces as a 4xx carrying `decision_id` (DESIGN §6/§10.4) — this is
 *  the UI's one "Why?" plumbing point: pull it back out of a thrown `ScpApiError` so a failed
 *  promote/cancel/rollback can link straight to the Decision record that explains it, instead of
 *  just showing an opaque error string. */
function decisionIdOf(error: unknown): string | undefined {
  return error instanceof ScpApiError ? error.problem?.decision_id : undefined;
}

/** Anchors to the matching row already rendered in the Decisions timeline below (never a
 *  separate page — every Decision this change could ever be blocked by is already in that list)
 *  and gives it a moment of highlight so "Why?" visibly lands somewhere. */
function WhyLink({ decisionId }: { decisionId: string }): React.JSX.Element {
  return (
    <a
      href={`#decision-${decisionId}`}
      className="font-medium text-red-700 underline hover:text-red-900"
      data-testid="why-link"
      onClick={() => {
        document.getElementById(`decision-${decisionId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }}
    >
      Why?
    </a>
  );
}

/**
 * Small reusable dialog for the two reason-carrying transitions (cancel/rollback). `reasonRequired`
 * drives client-side enforcement of `RollbackChangeRequestSchema`'s `reason: z.string().min(1)`
 * (packages/schemas/src/changes.ts) — cancel's reason is optional server-side, so it stays
 * submittable empty.
 */
function TransitionReasonDialog({
  open,
  title,
  description,
  reasonRequired,
  pending,
  errorMessage,
  errorDecisionId,
  onOpenChange,
  onSubmit,
  submitLabel,
  testIdPrefix
}: {
  open: boolean;
  title: string;
  description: string;
  reasonRequired: boolean;
  pending: boolean;
  errorMessage: string | null;
  errorDecisionId?: string | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => void;
  submitLabel: string;
  testIdPrefix: string;
}): React.JSX.Element {
  const [reason, setReason] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = reason.trim();
    if (reasonRequired && !trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason("");
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid={`${testIdPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`${testIdPrefix}-reason`}
              className="text-sm font-medium text-slate-700"
            >
              Reason{reasonRequired ? "" : " (optional)"}
            </label>
            <Input
              id={`${testIdPrefix}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required={reasonRequired}
              data-testid={`${testIdPrefix}-reason-input`}
            />
          </div>
          {errorMessage && (
            <p className="text-sm text-red-600">
              {errorMessage}
              {errorDecisionId && (
                <>
                  {" "}
                  <WhyLink decisionId={errorDecisionId} />
                </>
              )}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || (reasonRequired && reason.trim().length === 0)}
              data-testid={`${testIdPrefix}-submit`}
            >
              {pending ? "Submitting…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `/changes/{id}` (BUILD_AND_TEST.md §8 M3 UI requirement: "...+ wave progression view") — one
 * `client.changes.explain()` call gets the change, its compiled plan/waves, and every Decision
 * made about it. Polls every 3s (`refetchInterval`) because wave/target progress is written by
 * the server-side reconciliation loop, not user action — `scp.change.transitioned` (SSE,
 * lib/use-event-stream.ts) only fires on whole-change state transitions, not intra-wave progress,
 * so polling is the only mechanism that reliably surfaces live wave movement here.
 */
export function ChangeDetailPage(): React.JSX.Element {
  const id = useIdParam();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detailKey = changeDetailKey(id ?? "");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);

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

  const promoteMutation = useMutation({
    mutationFn: () => client.changes.promote(id!),
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

  if (!id) {
    return <p className="text-sm text-red-600">Not found.</p>;
  }
  if (explainQuery.isLoading) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  if (explainQuery.isError || !explainQuery.data) {
    return (
      <p className="text-sm text-red-600">
        {explainQuery.error instanceof Error ? explainQuery.error.message : "Not found"}
      </p>
    );
  }

  const { change, plan, decisions } = explainQuery.data;
  const canCancel = CANCELLABLE_STATES.includes(change.state);
  const canPromote = PROMOTABLE_STATES.includes(change.state);
  const canRollback = ROLLBACKABLE_STATES.includes(change.state);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-slate-900" data-testid="change-name">
              {change.name}
            </h1>
            <Badge variant={stateBadgeVariant(change.state)} data-testid="change-state-badge">
              {change.state}
            </Badge>
            {change.emergency && <Badge variant="destructive">Emergency</Badge>}
          </div>
          <p className="text-sm text-slate-500">
            {change.sourceKind ? `Source: ${change.sourceKind}` : "No source kind"}
            {change.correlationKey ? ` · Correlation key: ${change.correlationKey}` : ""}
          </p>
          {change.rollbackOfObjectId && (
            <p className="text-sm text-slate-500">
              Rollback of{" "}
              <Link
                to="/changes/$id"
                params={{ id: change.rollbackOfObjectId }}
                className="font-mono text-xs text-slate-700 hover:underline"
              >
                {change.rollbackOfObjectId}
              </Link>
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {canPromote && (
            <Button
              onClick={() => promoteMutation.mutate()}
              disabled={promoteMutation.isPending}
              data-testid="promote-change-button"
            >
              {promoteMutation.isPending ? "Promoting…" : "Promote"}
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
        </div>
      </div>

      {promoteMutation.isError && (
        <p className="text-sm text-red-600" data-testid="promote-error">
          {promoteMutation.error instanceof Error ? promoteMutation.error.message : "Failed to promote"}
          {decisionIdOf(promoteMutation.error) && (
            <>
              {" "}
              <WhyLink decisionId={decisionIdOf(promoteMutation.error)!} />
            </>
          )}
        </p>
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
          {plan && plan.waves.length === 0 && (
            <p className="text-sm text-slate-500">Plan compiled with no waves.</p>
          )}
          {plan && plan.waves.length > 0 && (
            <div className="flex gap-4 overflow-x-auto pb-2" data-testid="wave-progression">
              {plan.waves.map((wave, index) => (
                <div key={wave.id} className="flex items-center gap-4">
                  <WaveCard wave={wave} />
                  {index < plan.waves.length - 1 && (
                    <span className="shrink-0 text-xl text-slate-300" aria-hidden="true">
                      →
                    </span>
                  )}
                </div>
              ))}
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
            <p className="text-sm text-slate-500">No decisions recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="decision-timeline">
              {decisions.map((decision) => {
                // Whichever blocked action (if any) is currently displaying a "Why?" link that
                // points here — highlighted so following the link visibly lands on its target,
                // not just scrolls the page with no feedback.
                const isLinkedFromError =
                  decision.id === decisionIdOf(promoteMutation.error) ||
                  decision.id === decisionIdOf(cancelMutation.error) ||
                  decision.id === decisionIdOf(rollbackMutation.error);
                return (
                  <li
                    key={decision.id}
                    id={`decision-${decision.id}`}
                    className={`rounded border p-3 text-sm ${
                      isLinkedFromError ? "border-red-400 ring-2 ring-red-300" : "border-slate-200"
                    }`}
                    data-testid="decision-row"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900">{decision.kind}</span>
                      <Badge variant={decision.verdict === "allow" ? "success" : "destructive"}>
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

      <TransitionReasonDialog
        open={cancelOpen}
        title="Cancel change"
        description="Cancelling stops this change before it promotes. This cannot be undone."
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

      <TransitionReasonDialog
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
