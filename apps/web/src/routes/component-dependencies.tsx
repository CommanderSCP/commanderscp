import { useState } from "react";
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

/**
 * THE DEPENDENCIES TAB of one component (docs/proposals/dependency-subscription-ui.md §4).
 *
 * It answers, per component: what do I depend on, what is the head of each major line, am I
 * subscribed and why, what has been bumped, and can I enable / opt out here. Everything rendered
 * is READ off three server responses — the instance unlock, the component's dependency inventory
 * (rows carry each line's resolved dependency subscription, resolved AS THE CALLER, plus the
 * component-level ingestion gate) and the bumps SCP authored — and NOTHING is recomputed here:
 *
 *   - the badge on a row switches on `subscription.reason`; the header's component line switches on
 *     `componentGate.reason` (a different vocabulary, deliberately: the gate is existential over
 *     lines). This file never writes the enablement AND. A UI that ORed the contributions itself
 *     would be the second copy of the merge that lets the work-list and the screen disagree.
 *   - an `ignored` contribution (a malformed effect, or an enable behind a condition that cannot be
 *     evaluated here) is rendered as an amber pill on the row and never hidden: hiding it hides
 *     exactly the opt-out an operator believed had applied.
 *   - `head.latestVersion: null` renders as `—` "not observed yet" — never "nothing newer".
 *   - `producer` renders only when DECLARED; nothing is inferred from a coordinate.
 *   - an empty inventory is NEVER "No dependencies" unless an ingestion record says the manifests
 *     were read and declared none. `ingestion: null` beside `lastIngestionDecision: null` is
 *     "status not recorded" (amber `unknown`), because the wire cannot distinguish never-attempted
 *     from not-recorded.
 *
 * WRITES ARE OFFERED, REFUSALS RENDERED (M16.3 rule; owner decision §8 Q3). There is no
 * permission introspection, so the enable and opt-out offers render for every viewer and the
 * server's refusal is shown verbatim: 403 names the permission and where it is needed, 409 (a
 * standing delegation to another tool) carries a `decision_id` and gets a Why link. Both writes are
 * ORDINARY POLICY OBJECTS through `client.policies.create` — a dependency subscription IS a
 * `dependencySubscription` effect on a policy — with `scope.objectRef` = this component and the
 * effect-level line selector for an opt-out. This form NEVER offers a group scope (the server
 * refuses a sole-group scope in both directions) and never a per-line "enable" (the chain enables;
 * a line-level enable beside an org-level one would only be explainable, never effective on its own).
 *
 * The instance unlock is READ-ONLY here (owner decision §8 Q2): the write needs a deployment
 * secret no tenant role can hold, so the pointer is the CLI verb.
 *
 * `instanceRole` is a PARAMETER of the bumps section (read by the page off `useAuth()` and threaded
 * down, like the pipeline page does) so the renderers stay provider-free in tests. Third-party
 * polls and bump dispatch run only on a declared commander; on any other role the section says so
 * instead of drawing an empty table that would look up to date.
 */

/**
 * One PARALLEL read as the view sees it. The page renders as soon as the inventory resolves; the
 * unlock and the bumps are separate queries that may still be pending or may have failed. The
 * view is told WHICH, so a read that has not finished is never painted as "could not be read", and
 * a read that failed is never painted as "none" — the same honesty rule the inventory's empty
 * states follow ("never No <noun> for an unknown").
 */
export type ReadState<T> =
  { status: "pending" } | { status: "error"; error: unknown } | { status: "ok"; data: T };

// -------------------------------------------------------------------------------------------
// The two policy documents this tab authors — pure builders, exported so the exact wire shape is
// pinned by a unit test independent of the dialogs that collect their inputs.
// -------------------------------------------------------------------------------------------

/**
 * The enabling policy for one component: `scope.objectRef` = the component, one
 * `dependencySubscription` effect `enabled: true` with the chosen granularity/delivery,
 * `enforcement: "advisory"` (the policy document requires an enforcement; the resolver never reads
 * it). `domainId` is THE COMPONENT ITSELF (its own object id): `objects.domain_id` is a general
 * containment-parent pointer (any org object is accepted), `POST /policies` authorizes
 * `policy:write` at `domainId ?? org` and RBAC expands UPWARD from there — so a principal bound at
 * the component, at its containment domain, or at the org all pass, and the written policy is
 * contained by the component, where its team can later PATCH/DELETE it (those routes authorize at
 * the policy's own id). Sending the containment domain instead would refuse the component-bound
 * team; omitting it would refuse everyone below the org root.
 */
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

/**
 * The opt-out policy for ONE major line of one component: the SAME `scope.objectRef` (the
 * component — never a line selector in the scope, which has no such thing) and the line named at
 * the EFFECT level (`ecosystem`, `coordinate` VERBATIM, `major` as the ecosystem spells it), with
 * `enabled: false`. A disable at any tier wins, so this opts the line out whatever enabled it.
 * `domainId` = the component itself, for the reasons on `buildEnablePolicyRequest`.
 */
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

/**
 * How a policy write's refusal is rendered (charter principle 6: every blocked response is
 * explained). 403 → the permission and where it is needed (`POST /policies` authorizes
 * `policy:write` at the body's `domainId` — this component — and RBAC expands upward, so a binding
 * at the component or anywhere above it passes) plus the server's own detail; 409 → the server's
 * detail (a standing delegation names the file/tool
 * that owns this repo's updates) plus the `decision_id` for a Why link; anything else → the
 * message as received. Never a fabricated Why link: `decisionId` is set only when the problem
 * body carried one.
 */
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

// -------------------------------------------------------------------------------------------
// Rendering vocabulary — the reason enums mapped onto Badge tones. READ, never derived.
// -------------------------------------------------------------------------------------------

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

/**
 * The Why dialog's CONTENT, portal-free — exported for the test (Radix portals nothing under
 * renderToStaticMarkup). One row per contribution, exactly as the server recorded it: tier, source,
 * what it contributed, its selector, the granularity/delivery it DECLARED (absent = carried at the
 * most restrictive default) and, for an ignored one, why. Same body for a row's resolution and
 * for the component gate.
 */
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

// -------------------------------------------------------------------------------------------
// Header strip — the chain, honestly.
// -------------------------------------------------------------------------------------------

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

/**
 * The enable dialog's CONTENT, portal-free — exported for the test. Collects granularity and
 * delivery; the confirm is the ONLY thing that fires the write. States plainly that the first bump
 * is always a pull request whatever the delivery, and that auto-merge needs every enabling policy
 * to agree — both are the server's rules, repeated so the picker does not misrepresent them.
 */
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
          only when every enabling policy asks for it.
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

// -------------------------------------------------------------------------------------------
// The inventory table and its empty states.
// -------------------------------------------------------------------------------------------

/**
 * What to show when there are NO rows, keyed on the ingestion stamp, then the newest ingestion
 * Decision, then nothing — never collapsing to "No dependencies" without a record that says the
 * manifests were read and declared none.
 */
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
                <li key={m.path}>
                  {m.path} — {m.outcome}
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
              <li key={m.path}>
                {m.path} — {m.outcome}
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
  // Neither a stamp nor a Decision: UNKNOWN. Not "never attempted" (a refused or unreadable pass
  // writes no Decision, and the stamp is not on record), and never "no dependencies".
  return (
    <div className="flex flex-col gap-2" data-testid="inventory-empty" data-kind="not-recorded">
      <Badge
        variant="unknown"
        icon={CircleHelp}
        title="No ingestion attempt is on record for this component, so whether it declares dependencies is not known here."
      >
        Ingestion status not recorded
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

// -------------------------------------------------------------------------------------------
// Bumps section.
// -------------------------------------------------------------------------------------------

/**
 * The Merge cell — READ off what is stored, never inferred: `mergedAt` (a confirmed merge) → "merged
 * <date>"; else the newest merge Decision's verdict; else, when a pull request NUMBER is on record,
 * "not merged" (the stated absence — the server never observes a close-without-merge, so "open" would
 * be a claim it cannot make); else `—`, because with no pull request reported there is nothing whose
 * merge state could be described.
 */
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

/** The bumps section — a table on the commander; on any other role a sentence, because third-party
 *  polls and bump dispatch run only on a declared commander and an empty table there would look
 *  up to date. On the commander the read's STATE decides: pending → a skeleton row; failed → an
 *  amber `unknown` line (the page's error notice carries the diagnosis); only a SUCCESSFUL read
 *  with zero rows says "No bumps yet." */
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
        {instanceRole !== "commander" ? (
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
                        rel="noreferrer"
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

// -------------------------------------------------------------------------------------------
// The view (provider-free) and the page (hooks).
// -------------------------------------------------------------------------------------------

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

/**
 * The tab's whole rendering off already-loaded data. `onEnable`/`onOptOut` receive the EXACT policy
 * document to write; `writeState` is the page's mutation state so the open dialog can render the
 * refusal. Provider-free so tests can render it with `renderToStaticMarkup`.
 */
export function DependenciesView({
  unlock,
  inventory,
  bumps,
  instanceRole,
  onWrite,
  writeState
}: {
  unlock: ReadState<DependencySubscriptionUnlock>;
  inventory: ComponentDependencyInventoryResponse;
  bumps: ReadState<ComponentDependencyBumpsResponse>;
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
    queryFn: () => client.dependencySubscriptions.unlock()
  });
  const inventoryQuery = useQuery({
    queryKey: componentDependencyInventoryKey(idOrUrn ?? ""),
    queryFn: () => client.dependencySubscriptions.inventory(idOrUrn!, { limit: 200 }),
    enabled: Boolean(idOrUrn)
  });
  const bumpsQuery = useQuery({
    queryKey: componentDependencyBumpsKey(idOrUrn ?? ""),
    queryFn: () => client.dependencySubscriptions.bumps(idOrUrn!, { limit: 100 }),
    enabled: Boolean(idOrUrn)
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
