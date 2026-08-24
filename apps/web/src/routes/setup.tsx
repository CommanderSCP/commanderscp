import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ClipboardList,
  EyeOff,
  GitBranch,
  Link2,
  Server,
  Snowflake,
  type LucideIcon
} from "lucide-react";
import type {
  CreateFreezeRequest,
  Freeze,
  GraphObject,
  InstanceFreeze,
  UpdateFreezeWindowRequest
} from "@scp/schemas";
import { client } from "../lib/client";
import { cn, focusRing } from "../lib/utils";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Skeleton, SkeletonRows } from "../components/ui/skeleton";
import { QueryErrorNotice, queryErrorMessage } from "../components/query-error";
import { formatDate } from "../components/pipeline/wave-status";

/**
 * `/setup` — the owner's "both" answer to outpost-ui.md §4/§8 Q1: a task-oriented setup landing
 * ALONGSIDE the in-place affordances Lane A/B already build (source-mapping authoring and
 * placements live on `component-pipeline.tsx`; the connect wizard is `routes/connect.tsx`). This
 * page adds nothing new to write — every action here is a link to a surface that already exists,
 * plus A4's freeze card, which had no UI anywhere before this.
 *
 * DATA-DRIVEN, NEVER ROLE-GATED (outpost-ui.md §2, `domain-local.tsx`'s module doc — same
 * precedent, cited here rather than re-argued): every row on this page keys on what a list call
 * actually returned. There is no read of this instance's declared federation role anywhere in
 * this file, and there must never be one — a commander-role org doing its own domain's setup
 * work is exactly the colocated case §2 exists to cover, and it needs this page rendered
 * identically to an outpost's.
 */

// -------------------------------------------------------------------------------------------
// Setup checklist (A4's sibling in Lane B) — one row per "have you connected/placed/mapped X",
// each a live count plus a link to the real authoring surface. Every count comes from a list call
// this page actually makes; nothing here is a derived or invented number (CLAUDE.md honesty
// rules — "never invent a label the API doesn't state").
// -------------------------------------------------------------------------------------------

/**
 * `sourceKind`s this wizard/pipeline knows how to route (mirrors `SOURCE_KINDS` in
 * `component-pipeline.tsx`'s A1 source-mapping panel). Kept as a separate literal rather than an
 * import: that file belongs to a different section of this same round. If the two ever diverge,
 * the fix is to hoist one shared constant — not to invent a third list.
 */
const SOURCE_KINDS = ["github", "gitea", "gitlab"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * The raw list-call results this page's checklist is built from — shaped exactly like what each
 * `useQuery`/`useQueries` call below actually returns, so a test can hand this component a fixture
 * without standing up React Query at all. A field left `undefined` means "still loading" (or never
 * fetched); an object present, even with an empty `items`, means the call answered.
 */
export interface SetupChecklistData {
  executionSystems?: { items: unknown[] };
  deploymentTargets?: { items: unknown[] };
  placements?: { items: unknown[] };
  /** ONE PAGE of components (`limit: 100`) — the only thing `domainLocal` count below is counted
   *  over. There is no `domainLocal` filter on `ObjectListQuerySchema` (measured), so a true org-
   *  wide count would mean walking every page; this page shows the honest partial instead. */
  componentsSample?: { items: Pick<GraphObject, "domainLocal">[] };
  /** Present only once EVERY kind in `SOURCE_KINDS` has resolved — a partial sum would silently
   *  under-report while the remaining kinds are still in flight. */
  sourceMappingCounts?: Partial<Record<SourceKind, number>>;
}

export interface ChecklistRowView {
  key: string;
  icon: LucideIcon;
  label: string;
  description: string;
  /** `undefined` = the underlying call hasn't answered yet (renders a skeleton, never a fake 0). */
  count: number | undefined;
  hint?: string;
  to: string;
  actionLabel: string;
  testId: string;
}

/**
 * Pure data → row-view mapping, kept separate from rendering so the honesty math (the "of the
 * first N" caveat, the "not a count of X" caveat) is testable without a DOM at all.
 */
export function buildChecklistRows(data: SetupChecklistData): ChecklistRowView[] {
  const targetsCount = data.deploymentTargets?.items.length;
  const sampleSize = data.componentsSample?.items.length;
  const domainLocalCount = data.componentsSample?.items.filter((c) => c.domainLocal).length;
  const mappingCounts = data.sourceMappingCounts;
  const mappingsTotal = mappingCounts
    ? SOURCE_KINDS.reduce((sum, kind) => sum + (mappingCounts[kind] ?? 0), 0)
    : undefined;
  const mappingsBreakdown = mappingCounts
    ? SOURCE_KINDS.map((kind) => `${mappingCounts[kind] ?? 0} ${kind}`).join(" · ")
    : undefined;

  return [
    {
      key: "execution-systems",
      icon: Link2,
      label: "Execution systems",
      description: "Argo CD, Gitea, or GitLab, each with its own connect wizard.",
      count: data.executionSystems?.items.length,
      to: "/connect/argocd",
      actionLabel: "Connect Argo CD",
      testId: "setup-row-execution-systems"
    },
    {
      key: "deployment-targets",
      icon: Server,
      label: "Deployment targets",
      description: "Where a component can be placed and deployed.",
      count: targetsCount,
      to: "/deployment-targets",
      actionLabel: "Add a target",
      testId: "setup-row-deployment-targets"
    },
    {
      key: "placements",
      icon: ClipboardList,
      label: "Placements",
      description: "Component-to-target pairings declared so far.",
      count: data.placements?.items.length,
      hint:
        targetsCount !== undefined
          ? `across ${targetsCount} deployment target${targetsCount === 1 ? "" : "s"} — not a count of components still missing one`
          : undefined,
      to: "/components",
      actionLabel: "Place a component",
      testId: "setup-row-placements"
    },
    {
      key: "domain-local",
      icon: EyeOff,
      label: "Domain-local objects",
      description: "Objects declared to never leave this domain.",
      count: domainLocalCount,
      hint: sampleSize !== undefined ? `of the first ${sampleSize} components fetched` : undefined,
      to: "/components",
      actionLabel: "View components",
      testId: "setup-row-domain-local"
    },
    {
      key: "source-mappings",
      icon: GitBranch,
      label: "Source mappings",
      description: "Repos routed to components, by source kind.",
      count: mappingsTotal,
      hint: mappingsBreakdown,
      to: "/components",
      actionLabel: "Map a source",
      testId: "setup-row-source-mappings"
    }
  ];
}

type RouterLinkProps = React.ComponentProps<typeof Link>;

/**
 * Outline-Button-styled router `Link` (design spec §2.12/§4B: every `→` literal dies, replaced by
 * `ArrowRight` on an outline Button). `Button` itself renders a `<button>`, so a navigating control
 * can't use it directly — same shape as `service-board.tsx`'s (unexported) `LinkButton`, duplicated
 * here rather than imported since that file belongs to a different section of this round.
 */
function LinkButton({
  to,
  children,
  testId
}: {
  to: RouterLinkProps["to"];
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      data-testid={testId}
      className={cn(
        "inline-flex h-8 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-900 transition-colors hover:bg-slate-100",
        focusRing
      )}
    >
      {children}
      <ArrowRight className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
    </Link>
  );
}

function ChecklistRow({ row }: { row: ChecklistRowView }): React.JSX.Element {
  const Icon = row.icon;
  return (
    <div className="flex items-center justify-between gap-4 py-3" data-testid={row.testId}>
      <div className="flex items-start gap-3">
        <Icon
          className="mt-0.5 size-4 shrink-0 text-slate-400"
          strokeWidth={2}
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-medium text-slate-900">{row.label}</p>
          <p className="text-xs text-slate-500">{row.description}</p>
          {row.hint !== undefined && <p className="text-xs text-slate-400">{row.hint}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {row.count === undefined ? (
          <Skeleton className="h-7 w-8" />
        ) : (
          <span
            className="text-2xl font-semibold tabular-nums text-slate-900"
            data-testid={`${row.testId}-count`}
          >
            {row.count}
          </span>
        )}
        <LinkButton to={row.to} testId={`${row.testId}-link`}>
          {row.actionLabel}
        </LinkButton>
      </div>
    </div>
  );
}

export function SetupChecklistCard({ data }: { data: SetupChecklistData }): React.JSX.Element {
  const rows = buildChecklistRows(data);
  return (
    <Card data-testid="setup-checklist-card">
      <CardHeader>
        <CardTitle>Setup checklist</CardTitle>
        <CardDescription>
          What this domain has connected, placed, and mapped so far.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-slate-200">
        {rows.map((row) => (
          <ChecklistRow key={row.key} row={row} />
        ))}
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------------------------------------
// Freeze card (A4) — declare, list, lift, and (M25.UI increment 3) adjust the window.
// `apps/server/src/routes/governance.ts`'s Freezes section registers `POST /freezes`,
// `GET /freezes`, `GET /freezes/{id}`, `DELETE /freezes/{id}` (M25.1, lift) and
// `PATCH /freezes/{id}` (M25.1, `updateWindow` — move `endsAt` in either direction). The
// pre-M25.1 claim that this card could only ever declare and list is stale; see `FreezeRow` for
// both write controls it now offers.
// -------------------------------------------------------------------------------------------

export type FreezeWindowStatus = "active" | "upcoming" | "past" | "lifted";

/**
 * `lifted` is checked FIRST and outranks the window, because after M25.1 the window is no longer
 * the only thing that ends a freeze: `liftFreeze` retracts one immediately, whatever `endsAt`
 * says. Reading the window first would render a lifted-but-not-yet-expired freeze as `active` —
 * the UI asserting a freeze is in force that the engine has already stopped enforcing.
 */
export function freezeWindowStatus(
  freeze: Pick<Freeze, "startsAt" | "endsAt" | "liftedAt">,
  now: Date
): FreezeWindowStatus {
  if (freeze.liftedAt !== null) return "lifted";
  const t = now.getTime();
  if (t < new Date(freeze.startsAt).getTime()) return "upcoming";
  if (t > new Date(freeze.endsAt).getTime()) return "past";
  return "active";
}

/**
 * Active + upcoming freezes, soonest-starting first — plus freezes LIFTED early whose window has
 * not yet passed.
 *
 * That last clause is the whole reason this is not a one-line filter. A lift is a governance act
 * with a mandatory reason, and if the row vanished the instant it succeeded the operator would get
 * no confirmation that the thing they just retracted is actually retracted — the surface would go
 * silent at exactly the moment it should be most legible. Keeping it visible until the window it
 * WOULD have run to has passed bounds the list (it does not accumulate lifted rows forever) while
 * still showing the outcome. A freeze that simply expired is dropped as before: nothing was done
 * to it and there is nothing to confirm.
 */
export function activeAndUpcomingFreezes(freezes: Freeze[], now: Date): Freeze[] {
  return freezes
    .filter((f) => {
      if (now.getTime() > new Date(f.endsAt).getTime()) return false; // window gone, lifted or not
      return true;
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

/**
 * REPLACES the pre-M25.1 `NO_EARLY_LIFT_SENTENCE`, which said "there is no early-lift or delete
 * control yet". That was true of the server it was written against and became false the moment
 * `DELETE /api/v1/freezes/{id}` shipped. It is replaced in the SAME change that wires the Lift
 * control, so there is never a build in which the sentence and the surface disagree.
 */
const LIFT_SENTENCE =
  "This freeze runs until its end time unless it is lifted early. Lifting takes effect immediately and needs a reason.";

function freezeStatusBadge(status: FreezeWindowStatus): {
  label: string;
  variant: "warning" | "neutral" | "success";
} {
  if (status === "active") return { label: "Active", variant: "warning" };
  if (status === "lifted") return { label: "Lifted", variant: "success" };
  return { label: "Upcoming", variant: "neutral" };
}

/** `<input type="datetime-local">`'s value is LOCAL wall-clock time with no offset — the exact
 *  inverse of `buildCreateFreezePayload`'s `new Date(form.startsAt)` parse, and the one this
 *  module needs to PREFILL the window-edit input from a wire `endsAt` (a UTC ISO instant). Local
 *  getters (`getFullYear`/`getMonth`/…), never UTC ones — a UTC read would silently shift the
 *  prefilled value by the viewer's own offset. */
export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Shapes the `PATCH /freezes/{id}` body from the window-edit form's raw strings — mirrors
 *  `buildCreateFreezePayload`'s local->instant conversion exactly, so the two forms cannot drift
 *  on what a `datetime-local` value means. */
export function buildUpdateWindowPayload(
  endsAtLocal: string,
  reason: string
): UpdateFreezeWindowRequest {
  return { endsAt: new Date(endsAtLocal).toISOString(), reason: reason.trim() };
}

export interface FreezeRowProps {
  freeze: Freeze;
  now: Date;
  /** Omitted on a read-only render (and in the unit tests that assert copy). When present, the row
   *  offers Lift. */
  onLift?: (id: string, reason: string) => void;
  liftPending?: boolean;
  liftError?: unknown;
  /** M25.UI increment 3 — omitted on a read-only render, same idiom as `onLift`. When present AND
   *  the freeze is not lifted, the row offers "Adjust window" (`PATCH /freezes/{id}`, either
   *  direction — the server audits which). Independent of `onLift`: a caller may offer one write
   *  without the other, though `SetupPage` always wires both. */
  onUpdateWindow?: (id: string, payload: UpdateFreezeWindowRequest) => void;
  updateWindowPending?: boolean;
  updateWindowError?: unknown;
}

export function FreezeRow({
  freeze,
  now,
  onLift,
  liftPending = false,
  liftError,
  onUpdateWindow,
  updateWindowPending = false,
  updateWindowError
}: FreezeRowProps): React.JSX.Element {
  const status = freezeWindowStatus(freeze, now);
  const badge = freezeStatusBadge(status);
  const [reason, setReason] = useState("");
  const [windowOpen, setWindowOpen] = useState(false);
  const [newEndsAt, setNewEndsAt] = useState(() => toDatetimeLocalValue(freeze.endsAt));
  const [windowReason, setWindowReason] = useState("");
  const lifted = status === "lifted";

  return (
    <div
      className="flex flex-col gap-1 py-3"
      data-testid="freeze-row"
      title={`${LIFT_SENTENCE} Ends ${formatDate(freeze.endsAt)}.`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-900">
          {freeze.name ?? "Untitled freeze"}
        </span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <p className="text-xs text-slate-500">
        {formatDate(freeze.startsAt)} – {formatDate(freeze.endsAt)} · scope{" "}
        <span className="font-mono">{freeze.scopeObjectId}</span>
        {freeze.atomic ? " · atomic" : null}
      </p>
      <p className="text-sm text-slate-700">{freeze.reason}</p>

      {/* A lifted freeze keeps its row rather than disappearing: the lift reason and instant ARE
          the record an operator came back to read, and a `freeze_admission` Decision still cites
          this freeze's id (charter principle 6). */}
      {lifted ? (
        <p className="text-xs text-slate-500" data-testid="freeze-lifted-note">
          Lifted {formatDate(freeze.liftedAt!)}
          {freeze.liftReason ? ` — ${freeze.liftReason}` : null}
        </p>
      ) : null}

      {/* OFFERED UNCONDITIONALLY, never role-gated — this page's standing rule (outpost-ui.md §2/§6:
          "client-side pre-blocking of writes" is rejected). `freeze:write` is checked server-side AT
          THE FREEZE'S OWN SCOPE, so a caller who may lift one freeze on this list may legitimately
          be refused another; only the server knows which. The refusal is rendered verbatim. */}
      {onLift && !lifted ? (
        <form
          className="mt-1 flex flex-col gap-2"
          data-testid="freeze-lift-form"
          onSubmit={(e) => {
            e.preventDefault();
            onLift(freeze.id, reason.trim());
          }}
        >
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <label
                htmlFor={`freeze-lift-reason-${freeze.id}`}
                className="text-xs font-medium text-slate-700"
              >
                Reason for lifting
              </label>
              <Input
                id={`freeze-lift-reason-${freeze.id}`}
                data-testid="freeze-lift-reason-input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="why this freeze is being retracted early"
                required
              />
            </div>
            <Button type="submit" variant="outline" disabled={liftPending}>
              {liftPending ? "Lifting…" : "Lift"}
            </Button>
          </div>
          {liftError ? (
            <Alert tone="danger" data-testid="freeze-lift-error">
              {queryErrorMessage(liftError)}
            </Alert>
          ) : null}
        </form>
      ) : null}

      {/* M25.UI increment 3 — beside Lift, only while the freeze is not lifted: a lifted freeze's
          window is moot (retraction already ended it). Both directions are offered (the label
          says so) because the server audits which one happened; this UI does not decide. */}
      {onUpdateWindow && !lifted ? (
        <div className="mt-1 flex flex-col gap-2" data-testid="freeze-window-section">
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="freeze-window-toggle"
              onClick={() => setWindowOpen((v) => !v)}
            >
              {windowOpen ? "Cancel" : "Adjust window"}
            </Button>
          </div>
          {windowOpen ? (
            <form
              className="flex flex-col gap-2"
              data-testid="freeze-window-form"
              onSubmit={(e) => {
                e.preventDefault();
                onUpdateWindow(freeze.id, buildUpdateWindowPayload(newEndsAt, windowReason));
              }}
            >
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={`freeze-window-ends-${freeze.id}`}
                    className="text-xs font-medium text-slate-700"
                  >
                    New end time
                  </label>
                  <Input
                    id={`freeze-window-ends-${freeze.id}`}
                    type="datetime-local"
                    data-testid="freeze-window-ends-input"
                    value={newEndsAt}
                    onChange={(e) => setNewEndsAt(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <label
                    htmlFor={`freeze-window-reason-${freeze.id}`}
                    className="text-xs font-medium text-slate-700"
                  >
                    Reason
                  </label>
                  <Input
                    id={`freeze-window-reason-${freeze.id}`}
                    data-testid="freeze-window-reason-input"
                    value={windowReason}
                    onChange={(e) => setWindowReason(e.target.value)}
                    placeholder="why the window is moving"
                    required
                  />
                </div>
                <Button type="submit" variant="outline" disabled={updateWindowPending}>
                  {updateWindowPending ? "Updating…" : "Update"}
                </Button>
              </div>
              <p className="text-xs text-slate-500">
                Shortening ends the freeze sooner; extending keeps it in force longer. Both are
                allowed — the server records which direction this was.
              </p>
              {updateWindowError ? (
                <Alert tone="danger" data-testid="freeze-window-error">
                  {queryErrorMessage(updateWindowError)}
                </Alert>
              ) : null}
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface FreezeFormState {
  scopeObjectId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  /** D5's escape hatch. Default OFF, matching the server default — per-target admission is the
   *  normal behaviour and all-or-nothing is the deliberate exception. */
  atomic: boolean;
}

export function emptyFreezeForm(): FreezeFormState {
  return { scopeObjectId: "", name: "", startsAt: "", endsAt: "", reason: "", atomic: false };
}

/**
 * Shapes the `POST /freezes` body from the form's raw strings — exactly `CreateFreezeRequest`'s
 * fields, no more: `scopeObjectId`, an omit-when-blank `name` (optional per
 * `CreateFreezeRequestSchema`), `startsAt`/`endsAt` (the `<input type="datetime-local">` values,
 * local time with no offset, converted to the `z.string().datetime()` instants the wire schema
 * requires), and `reason`.
 */
export function buildCreateFreezePayload(form: FreezeFormState): CreateFreezeRequest {
  const trimmedName = form.name.trim();
  return {
    scopeObjectId: form.scopeObjectId.trim(),
    ...(trimmedName ? { name: trimmedName } : {}),
    startsAt: new Date(form.startsAt).toISOString(),
    endsAt: new Date(form.endsAt).toISOString(),
    reason: form.reason.trim(),
    // Sent explicitly rather than omitted-when-false. `atomic` changes what the freeze DOES to a
    // multi-target wave, so the request should say which behaviour was chosen instead of relying
    // on a server default the operator never saw.
    atomic: form.atomic
  };
}

export interface DeclareFreezeFormProps {
  value: FreezeFormState;
  onChange: (next: FreezeFormState) => void;
  onSubmit: (e: React.FormEvent) => void;
  pending: boolean;
  error?: unknown;
}

/**
 * The card's write surface — offered unconditionally (outpost-ui.md §6: "client-side pre-blocking
 * of writes" is rejected). `createFreeze` (governance.ts) answers 400/401/403 with no `decision_id`
 * (freezes have no gate-orchestrator Decision — measured, unlike change lifecycle transitions), so
 * the refusal is rendered verbatim through the same `queryErrorMessage` every other mutation here
 * uses, with no `decision_id`/"Why?" link to fabricate.
 */
export function DeclareFreezeForm({
  value,
  onChange,
  onSubmit,
  pending,
  error
}: DeclareFreezeFormProps): React.JSX.Element {
  function set<K extends keyof FreezeFormState>(key: K, next: FreezeFormState[K]): void {
    onChange({ ...value, [key]: next });
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit} data-testid="declare-freeze-form">
      <fieldset className="rounded border border-slate-200 p-3">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-500">
          Declare a freeze
        </legend>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="freeze-scope" className="text-sm font-medium text-slate-700">
              Scope
            </label>
            <Input
              id="freeze-scope"
              data-testid="freeze-scope-input"
              value={value.scopeObjectId}
              onChange={(e) => set("scopeObjectId", e.target.value)}
              placeholder="domain or service id / URN"
              required
            />
            <p className="text-xs text-slate-500">
              Any object id or URN — commonly a domain or service. Resolved server-side; changes
              scoped under it are frozen for the window below.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="freeze-name" className="text-sm font-medium text-slate-700">
              Name (optional)
            </label>
            <Input
              id="freeze-name"
              data-testid="freeze-name-input"
              value={value.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="freeze-starts" className="text-sm font-medium text-slate-700">
                Starts
              </label>
              <Input
                id="freeze-starts"
                type="datetime-local"
                data-testid="freeze-starts-input"
                value={value.startsAt}
                onChange={(e) => set("startsAt", e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="freeze-ends" className="text-sm font-medium text-slate-700">
                Ends
              </label>
              <Input
                id="freeze-ends"
                type="datetime-local"
                data-testid="freeze-ends-input"
                value={value.endsAt}
                onChange={(e) => set("endsAt", e.target.value)}
                required
              />
              <p className="text-xs text-slate-500" title={LIFT_SENTENCE}>
                Runs until this instant unless lifted early.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="freeze-reason" className="text-sm font-medium text-slate-700">
              Reason
            </label>
            {/* No shared Textarea primitive exists yet (ui/README.md) — matches Input's own
                classes (§2.12) exactly, same as campaign-list.tsx's Targets field. */}
            <textarea
              id="freeze-reason"
              data-testid="freeze-reason-input"
              value={value.reason}
              onChange={(e) => set("reason", e.target.value)}
              required
              rows={2}
              className={cn(
                "flex w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-50",
                focusRing
              )}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                data-testid="freeze-atomic-input"
                checked={value.atomic}
                onChange={(e) => set("atomic", e.target.checked)}
                className={cn("mt-0.5 size-4 rounded border-slate-300", focusRing)}
              />
              <span className="font-medium">Hold the whole wave</span>
            </label>
            <p className="text-xs text-slate-500">
              By default a freeze holds only the targets it covers, and a wave still deploys to the
              rest — freezing one region does not stop the other three. Tick this to hold every
              target in any wave this freeze touches, including ones it does not cover.
            </p>
          </div>

          {error !== undefined && (
            <Alert tone="danger" data-testid="declare-freeze-error">
              {queryErrorMessage(error)}
            </Alert>
          )}

          <div>
            <Button type="submit" disabled={pending} data-testid="declare-freeze-submit">
              {pending ? "Declaring…" : "Declare freeze"}
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}

// -------------------------------------------------------------------------------------------
// Platform freezes card (M25.UI increment 3) — READ-ONLY. `apps/server/src/routes/
// instance-freezes.ts`'s module doc states the reason at length: WRITE is operator-only, gated on
// `SCP_OPERATOR_TOKEN` presented as `x-scp-operator-token` — a deployment-level credential this
// browser session never holds and must never be asked to type into a form (same posture as
// `admin-governance.tsx`'s instance rung — see that file's "NO BROWSER WRITE HERE, DELIBERATELY"
// comment, mirrored below). READ is tenant-facing (`GET /v1/instance/freezes` needs no operator
// token): a platform freeze is the one freeze a tenant cannot author and by default cannot
// override, so a tenant that cannot even SEE it cannot be told why its release stopped (charter
// principle 6) — hence a card at all, where the sibling instance-scan-floors doors have none yet.
// -------------------------------------------------------------------------------------------

/** WHERE a platform freeze applies, in one structural phrase — never a raw `match` dump. Mirrors
 *  `freeze-hold.ts`'s server-side `freezeAddress` idiom, at the UI's own altitude: this is
 *  read-only rendering of a wire object the server already validated, not a policy statement. */
export function platformFreezeMatchLabel(match: InstanceFreeze["match"]): string {
  if (match.allEnvironments) return "All environments";
  if (match.region) return `${match.environment} / ${match.region}`;
  return `${match.environment} (every region)`;
}

/**
 * One platform freeze, read-only. `freezeWindowStatus`/`freezeStatusBadge` above are reused
 * UNCHANGED — `InstanceFreeze` carries the identical `startsAt`/`endsAt`/`liftedAt` shape `Freeze`
 * does, so a second copy of the same window arithmetic is not needed and would be exactly the kind
 * of drift risk this codebase's census discipline exists to catch.
 */
export function PlatformFreezeRow({
  freeze,
  now
}: {
  freeze: InstanceFreeze;
  now: Date;
}): React.JSX.Element {
  const status = freezeWindowStatus(freeze, now);
  const badge = freezeStatusBadge(status);
  const lifted = status === "lifted";

  return (
    <div className="flex flex-col gap-1 py-3" data-testid="platform-freeze-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-900">{freeze.name ?? "Untitled"}</span>
        <div className="flex items-center gap-1.5">
          {freeze.atomic ? <Badge variant="neutral">atomic</Badge> : null}
          {freeze.overridable ? <Badge variant="neutral">overridable</Badge> : null}
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        <span className="font-mono">{freeze.key}</span> · {platformFreezeMatchLabel(freeze.match)}
      </p>
      <p className="text-xs text-slate-500">
        {formatDate(freeze.startsAt)} – {formatDate(freeze.endsAt)}
      </p>
      <p className="text-sm text-slate-700">{freeze.reason}</p>

      {/* RETRACTED ROWS RENDER DISTINCTLY, NEVER DISAPPEAR — same reasoning as the org-tier
          card's `freeze-lifted-note`: a `gate`/`freeze_admission` Decision still cites this
          freeze's id forever (charter principle 6). */}
      {lifted ? (
        <p className="text-xs text-slate-500" data-testid="platform-freeze-lifted-note">
          Lifted {formatDate(freeze.liftedAt!)}
          {freeze.liftReason ? ` — ${freeze.liftReason}` : null}
        </p>
      ) : null}
    </div>
  );
}

export interface PlatformFreezeCardProps {
  /** `undefined` = still loading (or the call hasn't answered). An empty array is a real,
   *  honest "none declared" — never conflated with "not loaded yet". */
  freezes?: InstanceFreeze[];
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  now: Date;
}

/** Factored out from `SetupPage` the same way `SetupChecklistCard` is (pure presentational, fed
 *  already-resolved query state) — the only way to unit-test the empty state and the CLI-pointer
 *  copy without standing up React Query. */
export function PlatformFreezeCard({
  freezes,
  isLoading,
  isError,
  error,
  now
}: PlatformFreezeCardProps): React.JSX.Element {
  return (
    <Card data-testid="platform-freeze-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Snowflake className="size-4 text-slate-400" strokeWidth={2} aria-hidden="true" />
          Platform freezes
        </CardTitle>
        <CardDescription>
          Operator-declared, instance-wide — binds every org on this deployment.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <SkeletonRows n={2} />
        ) : isError ? (
          <QueryErrorNotice error={error} what="platform freezes" testId="platform-freezes-error" />
        ) : freezes && freezes.length === 0 ? (
          <EmptyState icon={Snowflake} message="No platform freezes declared." />
        ) : (
          <div
            className="flex flex-col divide-y divide-slate-200"
            data-testid="platform-freeze-list"
          >
            {freezes?.map((freeze) => (
              <PlatformFreezeRow key={freeze.id} freeze={freeze} now={now} />
            ))}
          </div>
        )}

        {/* NO BROWSER WRITE HERE, DELIBERATELY (mirrors admin-governance.tsx's instance rung):
            declaring, editing or lifting a platform freeze needs the deployment's
            `SCP_OPERATOR_TOKEN`, a credential this UI never holds. There is no `scp` CLI verb
            for this tier yet either (unlike the org tier's `scp freeze`) — the operator's own
            door is the raw route. */}
        <p className="text-xs text-slate-500" data-testid="platform-freeze-cli-pointer">
          Operator-only, never a browser write:{" "}
          <code className="font-mono">{"PUT /v1/instance/freezes/{key}"}</code> to declare or edit,{" "}
          <code className="font-mono">{"DELETE /v1/instance/freezes/{key}"}</code> to lift — both
          requiring an <code className="font-mono">x-scp-operator-token</code> header.
        </p>
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------------------------------------
// The page
// -------------------------------------------------------------------------------------------

export function SetupPage(): React.JSX.Element {
  const executionSystemsQuery = useQuery({
    queryKey: ["setup", "execution-systems"],
    queryFn: () => client.object("execution-system").list({ limit: 100 })
  });
  const deploymentTargetsQuery = useQuery({
    queryKey: ["setup", "deployment-targets"],
    queryFn: () => client.deploymentTargets.list({ limit: 100 })
  });
  const placementsQuery = useQuery({
    queryKey: ["setup", "placements"],
    queryFn: () => client.placements.list({ limit: 100 })
  });
  const componentsSampleQuery = useQuery({
    queryKey: ["setup", "components-sample"],
    queryFn: () => client.components.list({ limit: 100 })
  });
  const sourceMappingQueries = useQueries({
    queries: SOURCE_KINDS.map((kind) => ({
      queryKey: ["setup", "source-mappings", kind],
      queryFn: () => client.changeSources.listMappings(kind)
    }))
  });
  const sourceMappingCounts: SetupChecklistData["sourceMappingCounts"] = sourceMappingQueries.every(
    (q) => q.isSuccess
  )
    ? SOURCE_KINDS.reduce<Partial<Record<SourceKind, number>>>((acc, kind, i) => {
        acc[kind] = sourceMappingQueries[i]!.data!.items.length;
        return acc;
      }, {})
    : undefined;

  const checklistData: SetupChecklistData = {
    executionSystems: executionSystemsQuery.data,
    deploymentTargets: deploymentTargetsQuery.data,
    placements: placementsQuery.data,
    componentsSample: componentsSampleQuery.data,
    sourceMappingCounts
  };

  const freezesQuery = useQuery({
    queryKey: ["setup", "freezes"],
    queryFn: () => client.freezes.list()
  });
  const queryClient = useQueryClient();
  const [freezeForm, setFreezeForm] = useState<FreezeFormState>(emptyFreezeForm());
  const createFreeze = useMutation({
    mutationFn: (req: CreateFreezeRequest) => client.freezes.create(req),
    onSuccess: () => {
      setFreezeForm(emptyFreezeForm());
      void queryClient.invalidateQueries({ queryKey: ["setup", "freezes"] });
    }
  });

  function submitFreeze(e: React.FormEvent): void {
    e.preventDefault();
    createFreeze.mutate(buildCreateFreezePayload(freezeForm));
  }

  /**
   * Lift, scoped per row. `variables` is read back for the error case so a refusal renders under
   * the row it belongs to: `freeze:write` is checked AT EACH FREEZE'S OWN SCOPE, so a caller can
   * legitimately be allowed to lift one freeze in this list and refused another, and a single
   * card-level error banner would attribute the refusal to whichever row was clicked last.
   */
  const liftFreeze = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      client.freezes.lift(id, { reason }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["setup", "freezes"] })
  });

  /** M25.UI increment 3 — scoped per row for the same reason `liftFreeze` is: a refusal must
   *  render under the row it belongs to, not a card-level banner attributing it to the last click. */
  const updateFreezeWindow = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateFreezeWindowRequest }) =>
      client.freezes.updateWindow(id, payload),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["setup", "freezes"] })
  });

  const platformFreezesQuery = useQuery({
    queryKey: ["setup", "instance-freezes"],
    queryFn: () => client.instanceFreezes.list()
  });

  // One `now` per render, not per row: two rows straddling the instant a render happens must
  // still agree on which side of it they're on.
  const now = new Date();
  const freezes = freezesQuery.data
    ? activeAndUpcomingFreezes(freezesQuery.data.items, now)
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Domain setup"
        description="Connect systems, place components, and govern this domain's changes."
      />

      <SetupChecklistCard data={checklistData} />

      <Card data-testid="freeze-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Snowflake className="size-4 text-slate-400" strokeWidth={2} aria-hidden="true" />
            Freezes
          </CardTitle>
          <CardDescription>Pause changes under a scope for a fixed window.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {freezesQuery.isLoading ? (
            <SkeletonRows n={2} />
          ) : freezesQuery.isError ? (
            <QueryErrorNotice
              error={freezesQuery.error}
              what="freezes"
              testId="setup-freezes-error"
            />
          ) : freezes && freezes.length === 0 ? (
            <EmptyState icon={Snowflake} message="No active or upcoming freezes yet." />
          ) : (
            <div className="flex flex-col divide-y divide-slate-200" data-testid="freeze-list">
              {freezes?.map((freeze) => (
                <FreezeRow
                  key={freeze.id}
                  freeze={freeze}
                  now={now}
                  onLift={(id, reason) => liftFreeze.mutate({ id, reason })}
                  liftPending={liftFreeze.isPending && liftFreeze.variables?.id === freeze.id}
                  liftError={
                    liftFreeze.isError && liftFreeze.variables?.id === freeze.id
                      ? liftFreeze.error
                      : undefined
                  }
                  onUpdateWindow={(id, payload) => updateFreezeWindow.mutate({ id, payload })}
                  updateWindowPending={
                    updateFreezeWindow.isPending && updateFreezeWindow.variables?.id === freeze.id
                  }
                  updateWindowError={
                    updateFreezeWindow.isError && updateFreezeWindow.variables?.id === freeze.id
                      ? updateFreezeWindow.error
                      : undefined
                  }
                />
              ))}
            </div>
          )}

          <DeclareFreezeForm
            value={freezeForm}
            onChange={setFreezeForm}
            onSubmit={submitFreeze}
            pending={createFreeze.isPending}
            error={createFreeze.isError ? createFreeze.error : undefined}
          />
        </CardContent>
      </Card>

      <PlatformFreezeCard
        freezes={platformFreezesQuery.data}
        isLoading={platformFreezesQuery.isLoading}
        isError={platformFreezesQuery.isError}
        error={platformFreezesQuery.error}
        now={now}
      />

      {/*
       * "What stays in this domain" — one paragraph, keyed on the same OBJECT-level fact
       * `domain-local.tsx`'s `DomainLocalBadge`/`DomainLocalCreateField` render (that file's module
       * doc is the precedent this whole page follows for staying data-driven, never role-gated).
       * ADR-0031 §1/§6/§6a in a comment, not in the rendered copy (design spec copy rule 2).
       */}
      <Card size="compact" data-testid="domain-local-note-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <EyeOff className="size-4 text-slate-400" strokeWidth={2} aria-hidden="true" />
            What stays in this domain
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-slate-700">
            An object declared to stay in this domain — directly, or inherited the moment it's
            created inside a container already declared that way — is invisible everywhere else: no
            federation peer is ever told it exists. The only way out is a deliberate, one-way
            publish, taken per object; there is no bulk or automatic promotion.
          </p>
          <div>
            <LinkButton to="/components" testId="domain-local-note-link">
              See domain-local components
            </LinkButton>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
