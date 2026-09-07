import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleHelp, Package } from "lucide-react";
import type {
  ComponentDependencyBump,
  ComponentDependencyBumpsResponse,
  ComponentDependencyIngestionGate,
  ComponentDependencyInventoryResponse,
  ComponentDependencyInventoryRow,
  ComponentDependencyReadSubject,
  DependencySubscriptionContribution,
  DependencySubscriptionDelivery,
  DependencySubscriptionGranularity,
  DependencySubscriptionUnlock,
  DependencyLineProducerView,
  CreateObjectRequest,
  GraphObject,
  InstanceRole
} from "@scp/schemas";
import { ScpApiError } from "@scp/sdk";
import { client } from "../lib/client";
import { useAuth } from "../lib/auth-context";
import { useIdOrUrnParam } from "../lib/use-route-params";
import {
  componentDependencyBumpsKey,
  componentDependencyInventoryKey,
  dependencyProducersKey,
  dependencySubscriptionUnlockKey
} from "../lib/query-client";
import { cn, focusRing } from "../lib/utils";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import { EmptyState } from "../components/ui/empty-state";
import { KeyValueList } from "../components/ui/key-value-list";
import { Notice } from "../components/ui/notice";
import { PageHeader } from "../components/ui/page-header";
import { Skeleton } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { QueryErrorNotice, queryErrorMessage } from "../components/query-error";
import { WhyLink } from "../components/decision/WhyLink";
import { decisionIdOf } from "../components/decision/decision-format";

/** THE DEPENDENCIES TAB of one component. See docs/web.md §210. */

/** One PARALLEL read as the view sees it. See docs/web.md §211. */
export type ReadState<T> =
  { status: "pending" } | { status: "error"; error: unknown } | { status: "ok"; data: T };

// -------------------------------------------------------------------------------------------
// The two policy documents this tab authors — pure builders, exported so the exact wire shape is
// pinned by a unit test independent of the dialogs that collect their inputs.
// -------------------------------------------------------------------------------------------

/** The enabling policy for one component. See docs/web.md §212. */
export function buildEnablePolicyRequest(input: {
  component: ComponentDependencyReadSubject;
  granularity: DependencySubscriptionGranularity;
  delivery: DependencySubscriptionDelivery;
}): CreateObjectRequest {
  const { component, granularity, delivery } = input;
  return {
    name: `dependency subscription: ${component.name}`,
    domainId: component.id,
    properties: {
      enforcement: "advisory",
      scope: { objectRef: component.id },
      effects: [{ dependencySubscription: { enabled: true, granularity, delivery } }]
    }
  };
}

/** The opt-out policy for ONE major line of one component. See docs/web.md §213. */
export function buildOptOutPolicyRequest(input: {
  component: ComponentDependencyReadSubject;
  line: ComponentDependencyInventoryRow["line"];
}): CreateObjectRequest {
  const { component, line } = input;
  return {
    name: `dependency opt-out: ${line.coordinate} ${line.major} for ${component.name}`,
    domainId: component.id,
    properties: {
      enforcement: "advisory",
      scope: { objectRef: component.id },
      effects: [
        {
          dependencySubscription: {
            enabled: false,
            ecosystem: line.ecosystem,
            coordinate: line.coordinate,
            major: line.major
          }
        }
      ]
    }
  };
}

/** How a policy write's refusal is rendered. See docs/web.md §214. */
export function policyWriteRefusal(error: unknown): { message: string; decisionId?: string } {
  if (error instanceof ScpApiError) {
    const detail = error.problem?.detail ?? error.message;
    if (error.status === 403) {
      return {
        message: `Refused: this needs policy:write at this component (or above). ${detail}`
      };
    }
    const decisionId = decisionIdOf(error);
    if (error.status === 409) {
      return decisionId
        ? { message: `Refused: ${detail}`, decisionId }
        : { message: `Refused: ${detail}` };
    }
    return decisionId ? { message: detail, decisionId } : { message: detail };
  }
  return { message: queryErrorMessage(error) };
}

// Rendering vocabulary — the reason enums mapped onto Badge tones. READ, never derived.

const ROW_REASON_BADGE: Record<
  ComponentDependencyInventoryRow["subscription"]["reason"],
  { label: string; tone: "success" | "neutral" | "warning"; title: string }
> = {
  enabled: {
    label: "enabled",
    tone: "success",
    title:
      "This component follows this major line under an enabled dependency subscription: the instance is unlocked, a policy enables it and nothing opts it out."
  },
  disabled: {
    label: "opted out",
    tone: "neutral",
    title:
      "A matching policy opts this line out. An opt-out at any tier wins over every enable — open Why to see which one."
  },
  not_enabled: {
    label: "not enabled",
    tone: "neutral",
    title:
      "Nothing enables this line for this component. The instance may be unlocked; unlocking never activates anything."
  },
  instance_locked: {
    label: "instance locked",
    tone: "warning",
    title:
      "The deployment has not unlocked dependency subscriptions, so no policy can enable this line here."
  }
};

const IGNORED_TITLES: Record<string, string> = {
  malformed:
    "A contribution on a matching policy did not parse and was admitted to neither side. If it was meant as an opt-out, that opt-out did NOT apply.",
  condition_unevaluable:
    "A would-be enable on a matching policy carries a condition that cannot be evaluated here, so it cannot enable this line."
};

/** The amber pill for an `ignored` contribution — its label reads the recorded reason: a
 *  `condition_unevaluable` is by contract only ever a would-be enable; a `malformed` effect never
 *  parsed, so its direction is unknown and the hazard the pill exists for is the opt-out. */
function ignoredPillLabel(reasons: readonly (string | undefined)[]): string {
  const hasUnknownDirection = reasons.some((r) => r !== "condition_unevaluable");
  return hasUnknownDirection ? "opt-out ignored" : "enable ignored";
}

function IgnoredPill({
  contributions,
  testId
}: {
  contributions: readonly DependencySubscriptionContribution[];
  testId: string;
}): React.JSX.Element | null {
  const ignored = contributions.filter((c) => c.contributed === "ignored");
  if (ignored.length === 0) return null;
  const reasons = ignored.map((c) => c.ignoredReason);
  const title = reasons
    .map((r) => (r && IGNORED_TITLES[r]) ?? "A contribution was admitted to neither side.")
    .join(" ");
  return (
    <Badge variant="unknown" icon={CircleHelp} title={title} data-testid={testId}>
      {ignoredPillLabel(reasons)}
    </Badge>
  );
}

function formatWhen(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "";
}

function contributionSelector(c: DependencySubscriptionContribution): string {
  if (!c.selector) return "";
  const parts = [c.selector.ecosystem, c.selector.coordinate, c.selector.major].filter(
    (p): p is string => typeof p === "string"
  );
  return parts.length === 0 ? "* (every line)" : parts.join(" ");
}

/** The Why dialog's CONTENT, portal-free. See docs/web.md §215. */
export function ContributionsBody({
  heading,
  contributions
}: {
  heading: string;
  contributions: readonly DependencySubscriptionContribution[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 text-sm text-slate-700" data-testid="contributions-body">
      <span className="sr-only">{heading}</span>
      {contributions.length === 0 ? (
        <p className="text-sm text-slate-500" data-testid="contributions-none">
          No contributions recorded — nothing at any tier matched.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tier</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Contributed</TableHead>
              <TableHead>Selector</TableHead>
              <TableHead>Granularity / delivery</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contributions.map((c, i) => (
              <TableRow key={`${c.source}:${i}`} data-testid="contribution-row">
                <TableCell>{c.tier.replaceAll("_", " ")}</TableCell>
                <TableCell className="font-mono text-xs text-slate-600">{c.source}</TableCell>
                <TableCell>
                  {c.contributed}
                  {c.contributed === "ignored" && c.ignoredReason ? (
                    <span
                      className="text-xs text-amber-700"
                      data-testid="contribution-ignored-reason"
                    >
                      {" "}
                      ({c.ignoredReason.replaceAll("_", " ")})
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs text-slate-600">
                  {contributionSelector(c) || (
                    <span
                      className="text-slate-400"
                      title="This contribution carries no line selector."
                    >
                      —
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-slate-600">
                  {c.granularity ?? "—"} / {c.delivery ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** The instance line: three states off `{unlocked, updatedAt}`. `updatedAt: null` with
 *  `unlocked: false` is "never set" — a different operator situation from a deliberate re-lock. */
export function InstanceUnlockLine({
  unlock
}: {
  unlock: DependencySubscriptionUnlock;
}): React.JSX.Element {
  const cli = "scp dependency-subscriptions set-unlock --unlocked";
  const pointer = "Set by the platform operator with the operator token — not from this UI: " + cli;
  if (unlock.unlocked) {
    return (
      <span data-testid="instance-unlock" data-state="unlocked" title={pointer}>
        <Badge variant="success">unlocked</Badge> by the platform operator
        {unlock.updatedAt ? ` · ${formatWhen(unlock.updatedAt)}` : ""}
        {unlock.note ? <span className="text-slate-500"> — {unlock.note}</span> : null}
      </span>
    );
  }
  if (unlock.updatedAt) {
    return (
      <span data-testid="instance-unlock" data-state="locked" title={pointer}>
        <Badge variant="warning">locked</Badge> set by the platform operator ·{" "}
        {formatWhen(unlock.updatedAt)}
        {unlock.note ? <span className="text-slate-500"> — {unlock.note}</span> : null}
      </span>
    );
  }
  return (
    <span data-testid="instance-unlock" data-state="never-set" title={pointer}>
      <Badge variant="warning">locked</Badge> (never set)
    </span>
  );
}

/** The component line, off `componentGate` — the ingestion gate's own vocabulary. */
export function ComponentGateLine({
  gate,
  onWhy
}: {
  gate: ComponentDependencyIngestionGate;
  onWhy: () => void;
}): React.JSX.Element {
  const enablers = gate.contributions.filter((c) => c.contributed === "enable");
  const why = (
    <button
      type="button"
      className={cn("rounded text-xs font-medium text-slate-600 underline", focusRing)}
      onClick={onWhy}
      data-testid="component-gate-why"
    >
      Why?
    </button>
  );
  switch (gate.reason) {
    case "enabled":
      return (
        <span data-testid="component-gate" data-reason="enabled">
          <Badge variant="success">enabled</Badge>{" "}
          {enablers.length === 1 ? (
            <>
              via <span className="font-mono text-xs">{enablers[0]!.source}</span> (
              {enablers[0]!.tier.replaceAll("_", " ")})
            </>
          ) : (
            <>via {enablers.length} enabling policies</>
          )}{" "}
          {why}
        </span>
      );
    case "instance_locked":
      return (
        <span data-testid="component-gate" data-reason="instance_locked">
          <Badge variant="warning">instance locked</Badge> {why}
        </span>
      );
    case "no_enabling_contribution":
      return (
        <span data-testid="component-gate" data-reason="no_enabling_contribution">
          <Badge variant="neutral">not enabled</Badge> — no enabling policy at any tier {why}
        </span>
      );
  }
}

/** The enable dialog's CONTENT, portal-free. See docs/web.md §216. */
export function EnableDialogBody({
  component,
  busy,
  error,
  onConfirm,
  onCancel
}: {
  component: ComponentDependencyReadSubject;
  busy: boolean;
  error: unknown;
  onConfirm: (input: {
    granularity: DependencySubscriptionGranularity;
    delivery: DependencySubscriptionDelivery;
  }) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [granularity, setGranularity] = useState<DependencySubscriptionGranularity>("patch");
  const [delivery, setDelivery] = useState<DependencySubscriptionDelivery>("pull_request");
  const refusal = error === null || error === undefined ? null : policyWriteRefusal(error);
  return (
    <>
      <span className="sr-only">Enable dependency subscriptions for {component.name}</span>
      <div className="flex flex-col gap-3 text-sm text-slate-600" data-testid="enable-body">
        <p>
          Authors a policy scoped to{" "}
          <span className="font-mono text-slate-900">{component.name}</span> that enables dependency
          subscriptions for every major line it declares. Updates within each line arrive as code
          changes SCP authors; opt individual lines out afterwards from the table.
        </p>
        <fieldset className="flex flex-col gap-1.5" data-testid="enable-granularity">
          <legend className="text-xs font-medium text-slate-700">Granularity</legend>
          {(
            [
              ["patch", "Patch releases only"],
              ["minor_and_patch", "Minor and patch releases"]
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="enable-granularity"
                value={value}
                className="accent-army-600"
                checked={granularity === value}
                onChange={() => setGranularity(value)}
                data-testid={`enable-granularity-${value}`}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5" data-testid="enable-delivery">
          <legend className="text-xs font-medium text-slate-700">Delivery</legend>
          {(
            [
              ["pull_request", "Pull request"],
              ["auto_merge", "Auto-merge"]
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="enable-delivery"
                value={value}
                className="accent-army-600"
                checked={delivery === value}
                onChange={() => setDelivery(value)}
                data-testid={`enable-delivery-${value}`}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-slate-500" data-testid="enable-first-bump-note">
          The first bump is always a pull request. Auto-merge applies from the second look on, and
          only when every enabling policy asks for it. An active change freeze over this component
          withholds the merge itself — the pull request still opens, and the merge lands on its own
          within about a minute of the freeze lifting.
        </p>
        {refusal ? (
          <Alert tone="danger" data-testid="enable-error">
            {refusal.message}
            {refusal.decisionId ? (
              <>
                {" "}
                <WhyLink decisionId={refusal.decisionId} data-testid="enable-error-why" />{" "}
                <span className="font-mono text-xs" data-testid="enable-error-decision-id">
                  {refusal.decisionId}
                </span>
              </>
            ) : null}
          </Alert>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() => onConfirm({ granularity, delivery })}
          disabled={busy}
          data-testid="enable-confirm"
        >
          {busy ? "Enabling…" : "Enable"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The opt-out dialog's CONTENT, portal-free — exported for the test. Names the exact line
 *  (coordinate verbatim); the confirm is the only thing that fires the write. */
export function OptOutDialogBody({
  component,
  line,
  busy,
  error,
  onConfirm,
  onCancel
}: {
  component: ComponentDependencyReadSubject;
  line: ComponentDependencyInventoryRow["line"];
  busy: boolean;
  error: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const refusal = error === null || error === undefined ? null : policyWriteRefusal(error);
  return (
    <>
      <span className="sr-only">
        Opt {component.name} out of {line.coordinate}
      </span>
      <div className="flex flex-col gap-3 text-sm text-slate-600" data-testid="opt-out-body">
        <p>
          Authors a policy scoped to{" "}
          <span className="font-mono text-slate-900">{component.name}</span> that opts it out of the
          major line{" "}
          <span className="font-mono text-slate-900">
            {line.ecosystem} {line.coordinate} {line.major}
          </span>
          . An opt-out wins over every enable at every tier; the other lines are unaffected.
        </p>
        {refusal ? (
          <Alert tone="danger" data-testid="opt-out-error">
            {refusal.message}
            {refusal.decisionId ? (
              <>
                {" "}
                <WhyLink decisionId={refusal.decisionId} data-testid="opt-out-error-why" />{" "}
                <span className="font-mono text-xs" data-testid="opt-out-error-decision-id">
                  {refusal.decisionId}
                </span>
              </>
            ) : null}
          </Alert>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={onConfirm}
          disabled={busy}
          data-testid="opt-out-confirm"
        >
          {busy ? "Opting out…" : "Opt out"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** What to show when there are no rows, keyed on the stamp. See docs/web.md §217. */
export function InventoryEmptyState({
  inventory
}: {
  inventory: ComponentDependencyInventoryResponse;
}): React.JSX.Element {
  const gateOpen = inventory.componentGate.reason === "enabled";
  const howToIngest = (
    <p className="text-xs text-slate-500" data-testid="inventory-how-to-ingest">
      The inventory is read when a release is accepted or an operator runs{" "}
      <code className="font-mono">scp dependency-subscriptions backfill-inventory</code>.
      {gateOpen ? "" : " Ingestion runs only for enabled components."}
    </p>
  );
  const stamp = inventory.ingestion ?? null;
  if (stamp) {
    if (stamp.outcome === "not_enabled") {
      return (
        <div className="flex flex-col gap-2" data-testid="inventory-empty" data-kind="not-enabled">
          <p className="text-sm text-slate-700">
            Not ingested — this component was not enabled when ingestion last ran (
            {formatWhen(stamp.lastAttemptAt)}, {stamp.source}).
          </p>
          {howToIngest}
        </div>
      );
    }
    if (stamp.outcome === "ok") {
      const n = stamp.manifests.length;
      return (
        <div
          className="flex flex-col gap-2"
          data-testid="inventory-empty"
          data-kind="none-declared"
        >
          <EmptyState
            icon={Package}
            message={`No dependencies declared — read ${n} dependency manifest${n === 1 ? "" : "s"} · ${formatWhen(stamp.lastAttemptAt)}`}
          />
          {n > 0 ? (
            <ul className="font-mono text-xs text-slate-600" data-testid="inventory-manifest-list">
              {stamp.manifests.map((m) => (
                <li key={`${m.repo}:${m.path}`}>
                  {m.repo}:{m.path} — {m.outcome}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    }
    // partial | unreadable — the file list with each outcome. Unreadable is not empty.
    return (
      <div className="flex flex-col gap-2" data-testid="inventory-empty" data-kind={stamp.outcome}>
        <Alert
          tone="warning"
          title={
            <>
              Ingestion {stamp.outcome === "partial" ? "partially read" : "could not read"} the
              dependency manifests
            </>
          }
        >
          <ul className="font-mono text-xs" data-testid="inventory-manifest-list">
            {stamp.manifests.map((m) => (
              <li key={`${m.repo}:${m.path}`}>
                {m.repo}:{m.path} — {m.outcome}
                {m.detail ? `: ${m.detail}` : ""}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">
            Last attempt {formatWhen(stamp.lastAttemptAt)} ({stamp.source}). Files that could not be
            read are left as they were — they are not read as declaring nothing.
          </p>
        </Alert>
      </div>
    );
  }
  const decision = inventory.lastIngestionDecision;
  if (decision) {
    if (decision.skipped.length > 0) {
      return (
        <div className="flex flex-col gap-2" data-testid="inventory-empty" data-kind="partial">
          <Alert
            tone="warning"
            title="Some dependency manifests could not be read on the last recorded ingestion"
          >
            <ul className="font-mono text-xs" data-testid="inventory-manifest-list">
              {decision.manifestPathsRead.map((p) => (
                <li key={`read:${p}`}>{p} — read</li>
              ))}
              {decision.skipped.map((s) => (
                <li key={`skipped:${s.path}`}>
                  {s.path} — skipped: {s.reason}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs">First observed {formatWhen(decision.firstObservedAt)}.</p>
          </Alert>
        </div>
      );
    }
    const n = decision.manifestPathsRead.length;
    return (
      <div className="flex flex-col gap-2" data-testid="inventory-empty" data-kind="none-declared">
        <EmptyState
          icon={Package}
          message={`No dependencies declared — read ${n} dependency manifest${n === 1 ? "" : "s"}`}
        />
        {n > 0 ? (
          <ul className="font-mono text-xs text-slate-600" data-testid="inventory-manifest-list">
            {decision.manifestPathsRead.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-slate-500">
          First observed {formatWhen(decision.firstObservedAt)}
          {decision.manifestPathsAbsent.length > 0
            ? ` · absent: ${decision.manifestPathsAbsent.join(", ")}`
            : ""}
        </p>
      </div>
    );
  }
  // Neither a stamp nor a Decision: NEVER ATTEMPTED. Since M21.7 every pass that runs writes a
  // stamp (`ingestion-stamp-repo.ts`: `null` means "never attempted" and nothing else) — and this
  // branch is reached only when the server also said dependencies ARE managed here (a
  // `managedHere: false` answer never gets this far). Still never "no dependencies".
  return (
    <div className="flex flex-col gap-2" data-testid="inventory-empty" data-kind="not-recorded">
      <Badge
        variant="unknown"
        icon={CircleHelp}
        title="No ingestion attempt is on record for this component — never attempted (every pass that runs leaves a stamp) — so whether it declares dependencies is not known here."
      >
        Ingestion status not recorded — never attempted
      </Badge>
      {howToIngest}
    </div>
  );
}

function InventoryRowView({
  row,
  onWhy,
  onOptOut
}: {
  row: ComponentDependencyInventoryRow;
  onWhy: () => void;
  onOptOut: () => void;
}): React.JSX.Element {
  const badge = ROW_REASON_BADGE[row.subscription.reason];
  return (
    <TableRow data-testid="dependency-row" data-reason={row.subscription.reason}>
      <TableCell className="font-mono text-xs text-slate-900" data-testid="dependency-coordinate">
        {row.line.coordinate}
        {row.producer ? (
          <span className="ml-2 text-slate-500" data-testid="dependency-producer">
            internal ({row.producer.name})
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-xs text-slate-600">
        {row.line.ecosystem} · {row.line.major}
      </TableCell>
      <TableCell className="font-mono text-xs text-slate-600">{row.manifestPath}</TableCell>
      <TableCell className="font-mono text-xs text-slate-600" data-testid="dependency-declared">
        {row.declaredVersion} →{" "}
        {row.resolvedVersion ?? (
          <span className="text-slate-400" title="The manifest pins no concrete version.">
            —
          </span>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs text-slate-600" data-testid="dependency-latest">
        {row.head.latestVersion ?? (
          <span
            className="text-slate-400"
            title="Not observed yet — no poll has recorded a head for this line. This never means nothing newer exists."
          >
            —
          </span>
        )}
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={badge.tone} title={badge.title} data-testid="dependency-subscription">
            {badge.label}
          </Badge>
          <IgnoredPill contributions={row.subscription.contributions} testId="dependency-ignored" />
          {row.subscription.enabled ? (
            <span className="text-xs text-slate-500" data-testid="dependency-terms">
              {row.subscription.granularity.replaceAll("_", " ")} ·{" "}
              {row.subscription.delivery.replaceAll("_", " ")}
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell>
        <button
          type="button"
          className={cn("rounded text-xs font-medium text-slate-600 underline", focusRing)}
          onClick={onWhy}
          data-testid="dependency-why"
        >
          Why?
        </button>
      </TableCell>
      <TableCell>
        <Button variant="outline" size="sm" onClick={onOptOut} data-testid="dependency-opt-out">
          Opt out
        </Button>
      </TableCell>
    </TableRow>
  );
}

/** The Merge cell. See docs/web.md §218. */
function bumpProgress(bump: ComponentDependencyBump): React.JSX.Element {
  if (bump.mergedAt) return <>merged {formatWhen(bump.mergedAt)}</>;
  if (bump.merge) return <>{bump.merge.verdict}</>;
  if (bump.pullRequestNumber === null) {
    return (
      <span
        className="text-slate-400"
        title="Dispatched — no pull request has been reported for this bump yet, so there is no merge to describe."
      >
        —
      </span>
    );
  }
  return (
    <span title="No merge has been recorded for this pull request. A close without a merge is not observed here.">
      not merged
    </span>
  );
}

/** The bumps section. See docs/web.md §219. */
/** What an OUTPOST. See docs/web.md §220. */
export function ManagedAtCommanderNotice({
  reason,
  role
}: {
  /** The server's own `dependencyManagement.reason` when the pointer is rendered off the WIRE
   *  (`managedHere: false`) rather than off the role gate — stated, so an operator can tell an
   *  outpost from an undeclared role (different remedies). */
  reason?: string;
  /** The client's own `instanceRole` when the pointer is rendered off the ROLE GATE (no read was
   *  issued, so there is no wire reason). Only ever a non-commander role here. */
  role?: string;
} = {}): React.JSX.Element {
  // Name the topology ONLY when someone stated it. "This outpost" is true when the server's reason
  // or the client's role says `outpost`; a retrans or an undeclared role is NOT an outpost, and
  // saying so would name a topology nobody stated (the undeclared-role remedy is one env var at
  // THIS deployment, not a call to the commander).
  const isOutpost = reason === "outpost" || (reason === undefined && role === "outpost");
  return (
    <Card data-testid="dependencies-managed-at-commander" data-reason={reason}>
      <CardHeader>
        <CardTitle>Dependencies</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-slate-600">
          Dependency subscriptions are managed at the commander. Version bumps are authored there
          and reach{" "}
          {isOutpost
            ? "this outpost through the promotion pipeline; this site holds"
            : "field outposts through the promotion pipeline; this deployment holds"}{" "}
          no dependency inventory of its own.
          {reason ? (
            <>
              {" "}
              <span data-testid="dependencies-managed-reason">
                (This deployment reports: dependency management is not run here — {reason}.)
              </span>
            </>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
}

export function BumpsSection({
  bumps,
  instanceRole
}: {
  bumps: ReadState<ComponentDependencyBumpsResponse>;
  instanceRole: InstanceRole | undefined;
}): React.JSX.Element {
  return (
    <Card size="compact">
      <CardHeader>
        <CardTitle>Bumps</CardTitle>
      </CardHeader>
      <CardContent>
        {instanceRole !== "commander" ||
        (bumps.status === "ok" && bumps.data.dependencyManagement.managedHere === false) ? (
          // The role gate, AND the server's own word (`dependencyManagement`, ADR-0032 §7d): a bump
          // list from a deployment that does not manage dependencies is empty by construction and
          // must not read as "no bumps yet".
          <p className="text-sm text-slate-600" data-testid="bumps-not-commander">
            Bumps are dispatched by the commander.
          </p>
        ) : bumps.status === "pending" ? (
          <Skeleton className="h-6 w-full" data-testid="bumps-pending" />
        ) : bumps.status === "error" ? (
          <Badge
            variant="unknown"
            icon={CircleHelp}
            title={`The bumps could not be read: ${queryErrorMessage(bumps.error)}`}
            data-testid="bumps-unreadable"
          >
            Bumps could not be read
          </Badge>
        ) : bumps.data.rows.length === 0 ? (
          <EmptyState icon={Package} message="No bumps yet." data-testid="bumps-empty" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dependency</TableHead>
                <TableHead>Manifest</TableHead>
                <TableHead>From → to</TableHead>
                <TableHead>PR</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead>Dispatched</TableHead>
                <TableHead>Merge</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bumps.data.rows.map((b) => (
                <TableRow key={`${b.changeId}:${b.manifestPath}`} data-testid="bump-row">
                  <TableCell className="font-mono text-xs text-slate-900">
                    {b.line.coordinate}{" "}
                    <span className="text-slate-500">
                      {b.line.ecosystem} · {b.line.major}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-slate-600">
                    {b.manifestPath}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-slate-600">
                    {b.fromVersion} → {b.toVersion}
                  </TableCell>
                  <TableCell className="text-xs" data-testid="bump-pr">
                    {b.pullRequestNumber === null ? (
                      <span
                        className="text-slate-400"
                        title="No pull request has been reported for this bump yet."
                      >
                        —
                      </span>
                    ) : b.pullRequestUrl ? (
                      <a
                        href={b.pullRequestUrl}
                        className={cn("rounded underline", focusRing)}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="bump-pr-link"
                      >
                        #{b.pullRequestNumber}
                      </a>
                    ) : (
                      // The number only: the URL is not stored, and it is never composed from
                      // repo + number (the provider is not known here).
                      <span
                        title={`Pull request #${b.pullRequestNumber} on ${b.repo} — the link is not stored here.`}
                      >
                        #{b.pullRequestNumber}
                      </span>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-xs text-slate-600"
                    title={b.deliveryReason ?? undefined}
                  >
                    {b.delivery ? (
                      b.delivery.replaceAll("_", " ")
                    ) : (
                      <span
                        className="text-slate-400"
                        title="No dispatch record is on file for this bump."
                      >
                        —
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-slate-600">
                    {formatWhen(b.dispatchedAt)}
                  </TableCell>
                  <TableCell className="text-xs text-slate-600" data-testid="bump-merge">
                    {bumpProgress(b)}
                    {b.merge ? (
                      <>
                        {" "}
                        <WhyLink
                          decisionId={b.merge.decisionId}
                          changeId={b.changeId}
                          data-testid="bump-merge-why"
                        />
                      </>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// The "Produces" strip (dependency-subscription-ui.md §12.4, owner decision 2026-08-18 Q2).

/** "This component is the declared producer of `npm @acme/lib`, …. See docs/web.md §221. */
export function ProducesStrip({
  produces
}: {
  produces: ReadState<readonly DependencyLineProducerView[]>;
}): React.JSX.Element | null {
  if (produces.status === "pending") return null;
  if (produces.status === "error") {
    return (
      <Badge
        variant="unknown"
        icon={CircleHelp}
        title={`Whether this component is a declared producer could not be read: ${queryErrorMessage(produces.error)}`}
        data-testid="produces-unreadable"
      >
        Producer declarations could not be read
      </Badge>
    );
  }
  if (produces.data.length === 0) return null;
  return (
    <p className="text-sm text-slate-700" data-testid="produces-strip">
      This component is the declared producer of{" "}
      {produces.data.map((p, i) => (
        <span key={`${p.ecosystem} ${p.coordinate}`}>
          {i > 0 ? ", " : ""}
          <span className="font-mono text-xs text-slate-900" data-testid="produces-coordinate">
            {p.ecosystem} {p.coordinate}
          </span>
        </span>
      ))}{" "}
      —{" "}
      <Link
        to="/admin/dependencies"
        className={cn("rounded text-slate-900 underline", focusRing)}
        data-testid="produces-admin-link"
      >
        Admin › Dependencies
      </Link>
    </p>
  );
}

type WhyTarget =
  | { kind: "gate"; contributions: readonly DependencySubscriptionContribution[] }
  | { kind: "row"; row: ComponentDependencyInventoryRow };

/** The dialog descriptions — Radix portals them away from a static render, so they are exported
 *  as strings and swept by the vocabulary test alongside the rendered markup and its titles. */
export const DIALOG_COPY = {
  whyRow: "every contribution the merge saw, as recorded.",
  whyGate: "Every contribution the gate merge saw, as recorded.",
  enable: "Writes an ordinary policy at this component with a dependency-subscription effect.",
  optOut: "Writes an ordinary policy at this component with an opt-out effect naming the line."
} as const;

/** The tab's whole rendering off already-loaded data. See docs/web.md §222. */
export function DependenciesView({
  unlock,
  inventory,
  bumps,
  produces,
  instanceRole,
  onWrite,
  writeState
}: {
  unlock: ReadState<DependencySubscriptionUnlock>;
  inventory: ComponentDependencyInventoryResponse;
  bumps: ReadState<ComponentDependencyBumpsResponse>;
  /** The org's producer declarations FOR THIS COMPONENT (§12.4) — filtered by the page; absent
   *  (older call sites, tests) renders no strip. */
  produces?: ReadState<readonly DependencyLineProducerView[]>;
  instanceRole: InstanceRole | undefined;
  onWrite: (request: CreateObjectRequest, done: () => void) => void;
  writeState: { busy: boolean; error: unknown; reset: () => void; lastSuccess: string | null };
}): React.JSX.Element {
  const [why, setWhy] = useState<WhyTarget | null>(null);
  const [enableOpen, setEnableOpen] = useState(false);
  const [optOut, setOptOut] = useState<ComponentDependencyInventoryRow | null>(null);
  const component = inventory.component;
  const stamp = inventory.ingestion ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={<span data-testid="component-name">{component.name}</span>}
        description="Dependencies — declared major lines, their heads, and this component's dependency subscriptions."
      />

      {produces ? <ProducesStrip produces={produces} /> : null}

      <Card size="compact">
        <CardHeader>
          <CardTitle>Enablement</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <KeyValueList
            columns={1}
            items={[
              {
                label: "Instance",
                value:
                  unlock.status === "ok" ? (
                    <InstanceUnlockLine unlock={unlock.data} />
                  ) : unlock.status === "pending" ? (
                    <Skeleton className="h-5 w-40" data-testid="instance-unlock-pending" />
                  ) : (
                    <span
                      className="text-slate-400"
                      title={`The instance unlock could not be read: ${queryErrorMessage(unlock.error)}`}
                      data-testid="instance-unlock-unreadable"
                    >
                      —
                    </span>
                  )
              },
              {
                label: "This component",
                value: (
                  <ComponentGateLine
                    gate={inventory.componentGate}
                    onWhy={() =>
                      setWhy({ kind: "gate", contributions: inventory.componentGate.contributions })
                    }
                  />
                )
              }
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                writeState.reset();
                setEnableOpen(true);
              }}
              data-testid="enable-open"
            >
              Enable dependency subscriptions for this component
            </Button>
            <span className="text-xs text-slate-500">
              Authors a policy at this component; the server decides whether you may.
            </span>
          </div>
          {writeState.lastSuccess ? (
            <Notice tone="success" data-testid="write-success">
              {writeState.lastSuccess}
            </Notice>
          ) : null}
        </CardContent>
      </Card>

      <Card size="compact">
        <CardHeader>
          <CardTitle>Inventory</CardTitle>
          {stamp ? (
            <p className="text-xs text-slate-500" data-testid="inventory-stamp">
              Last read {formatWhen(stamp.lastAttemptAt)} ({stamp.source}) — {stamp.outcome},{" "}
              {stamp.rowsWritten} row{stamp.rowsWritten === 1 ? "" : "s"} written
            </p>
          ) : inventory.lastIngestionDecision ? (
            <p className="text-xs text-slate-500" data-testid="inventory-stamp">
              Ingestion state first observed{" "}
              {formatWhen(inventory.lastIngestionDecision.firstObservedAt)}
            </p>
          ) : null}
        </CardHeader>
        <CardContent>
          {inventory.rows.length === 0 ? (
            <InventoryEmptyState inventory={inventory} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dependency</TableHead>
                  <TableHead>Line</TableHead>
                  <TableHead>Manifest</TableHead>
                  <TableHead>Declared → resolved</TableHead>
                  <TableHead>Latest</TableHead>
                  <TableHead>Dependency subscription</TableHead>
                  <TableHead />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {inventory.rows.map((row) => (
                  <InventoryRowView
                    key={`${row.line.id}:${row.manifestPath}`}
                    row={row}
                    onWhy={() => setWhy({ kind: "row", row })}
                    onOptOut={() => {
                      writeState.reset();
                      setOptOut(row);
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {inventory.nextCursor ? (
            <p className="mt-2 text-xs text-slate-500" data-testid="inventory-more">
              More rows exist than are shown here.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <BumpsSection bumps={bumps} instanceRole={instanceRole} />

      <Dialog open={why !== null} onOpenChange={(open) => !open && setWhy(null)}>
        <DialogContent data-testid="why-dialog">
          <DialogHeader>
            <DialogTitle>
              {why?.kind === "row"
                ? `Why: ${why.row.line.coordinate} ${why.row.line.major}`
                : "Why: this component's ingestion gate"}
            </DialogTitle>
            <DialogDescription>
              {why?.kind === "row"
                ? `Resolved ${why.row.subscription.reason.replaceAll("_", " ")} — ${DIALOG_COPY.whyRow}`
                : DIALOG_COPY.whyGate}
            </DialogDescription>
          </DialogHeader>
          {why ? (
            <ContributionsBody
              heading={why.kind === "row" ? "Row contributions" : "Gate contributions"}
              contributions={
                why.kind === "row" ? why.row.subscription.contributions : why.contributions
              }
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={enableOpen} onOpenChange={(open) => !open && setEnableOpen(false)}>
        <DialogContent data-testid="enable-dialog">
          <DialogHeader>
            <DialogTitle>Enable dependency subscriptions for {component.name}</DialogTitle>
            <DialogDescription>{DIALOG_COPY.enable}</DialogDescription>
          </DialogHeader>
          <EnableDialogBody
            component={component}
            busy={writeState.busy}
            error={writeState.error}
            onConfirm={({ granularity, delivery }) =>
              onWrite(buildEnablePolicyRequest({ component, granularity, delivery }), () =>
                setEnableOpen(false)
              )
            }
            onCancel={() => setEnableOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={optOut !== null} onOpenChange={(open) => !open && setOptOut(null)}>
        <DialogContent data-testid="opt-out-dialog">
          <DialogHeader>
            <DialogTitle>Opt out of a major line</DialogTitle>
            <DialogDescription>{DIALOG_COPY.optOut}</DialogDescription>
          </DialogHeader>
          {optOut ? (
            <OptOutDialogBody
              component={component}
              line={optOut.line}
              busy={writeState.busy}
              error={writeState.error}
              onConfirm={() =>
                onWrite(buildOptOutPolicyRequest({ component, line: optOut.line }), () =>
                  setOptOut(null)
                )
              }
              onCancel={() => setOptOut(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** `/components/$idOrUrn/dependencies` — the page: reads, the one policy-write mutation, and the
 *  instance role off `useAuth()`, threaded into the provider-free view. */
export function ComponentDependenciesPage(): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  const { user } = useAuth();
  const instanceRole = user?.instanceRole;
  const queryClient = useQueryClient();
  const [lastSuccess, setLastSuccess] = useState<string | null>(null);

  const unlockQuery = useQuery({
    queryKey: dependencySubscriptionUnlockKey(),
    queryFn: () => client.dependencySubscriptions.unlock(),
    enabled: instanceRole === "commander"
  });
  const inventoryQuery = useQuery({
    queryKey: componentDependencyInventoryKey(idOrUrn ?? ""),
    queryFn: () => client.dependencySubscriptions.inventory(idOrUrn!, { limit: 200 }),
    enabled: Boolean(idOrUrn) && instanceRole === "commander"
  });
  const bumpsQuery = useQuery({
    queryKey: componentDependencyBumpsKey(idOrUrn ?? ""),
    queryFn: () => client.dependencySubscriptions.bumps(idOrUrn!, { limit: 100 }),
    enabled: Boolean(idOrUrn) && instanceRole === "commander"
  });
  // The org's producer declarations (§12.4) — ONE unpaged org list, filtered below to this
  // component; the same role gate as every other read here (an outpost issues NO calls).
  const producersQuery = useQuery({
    queryKey: dependencyProducersKey(),
    queryFn: () => client.dependencyProducers.list(),
    enabled: instanceRole === "commander"
  });

  const write = useMutation({
    mutationFn: (request: CreateObjectRequest): Promise<GraphObject> =>
      client.policies.create(request),
    onSuccess: (created) => {
      setLastSuccess(
        `Policy “${created.name}” written — the resolutions below are re-read from the server.`
      );
      void queryClient.invalidateQueries({
        queryKey: componentDependencyInventoryKey(idOrUrn ?? "")
      });
    }
  });

  if (!idOrUrn) return <p className="text-sm text-red-600">Not found.</p>;
  // Commander-only feature (owner rule 2026-08-17): any other install-time role gets the pointer,
  // whatever the reads would have said. Read from `instanceRole`, never inferred from data.
  if (instanceRole !== "commander") return <ManagedAtCommanderNotice role={instanceRole} />;
  if (inventoryQuery.isLoading) return <Skeleton className="h-24 w-full" />;
  if (inventoryQuery.error) {
    return (
      <QueryErrorNotice
        error={inventoryQuery.error}
        what="this component's dependency inventory"
        testId="dependency-inventory-error"
      />
    );
  }
  const inventory = inventoryQuery.data;
  if (!inventory) return <p className="text-sm text-slate-500">No dependency inventory yet.</p>;
  // THE SERVER IS THE AUTHORITY. See docs/web.md §223.
  if (inventory.dependencyManagement.managedHere === false) {
    return <ManagedAtCommanderNotice reason={inventory.dependencyManagement.reason} />;
  }

  const unlock: ReadState<DependencySubscriptionUnlock> = unlockQuery.error
    ? { status: "error", error: unlockQuery.error }
    : unlockQuery.data
      ? { status: "ok", data: unlockQuery.data }
      : { status: "pending" };
  const bumps: ReadState<ComponentDependencyBumpsResponse> = bumpsQuery.error
    ? { status: "error", error: bumpsQuery.error }
    : bumpsQuery.data
      ? { status: "ok", data: bumpsQuery.data }
      : { status: "pending" };
  const produces: ReadState<readonly DependencyLineProducerView[]> = producersQuery.error
    ? { status: "error", error: producersQuery.error }
    : producersQuery.data
      ? {
          status: "ok",
          data: producersQuery.data.producers.filter(
            (p) => p.producerObjectId === inventory.component.id
          )
        }
      : { status: "pending" };

  return (
    <>
      {unlockQuery.error ? (
        <QueryErrorNotice
          error={unlockQuery.error}
          what="the instance dependency-subscription unlock"
          testId="dependency-unlock-error"
        />
      ) : null}
      {bumpsQuery.error ? (
        <QueryErrorNotice
          error={bumpsQuery.error}
          what="this component's dependency bumps"
          testId="dependency-bumps-error"
        />
      ) : null}
      <DependenciesView
        unlock={unlock}
        inventory={inventory}
        bumps={bumps}
        produces={produces}
        instanceRole={instanceRole}
        onWrite={(request, done) => {
          setLastSuccess(null);
          write.mutate(request, { onSuccess: () => done() });
        }}
        writeState={{
          busy: write.isPending,
          error: write.error,
          reset: () => write.reset(),
          lastSuccess
        }}
      />
    </>
  );
}
