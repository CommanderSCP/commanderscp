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
import type { CreateFreezeRequest, Freeze, GraphObject } from "@scp/schemas";
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
        <Icon className="mt-0.5 size-4 shrink-0 text-slate-400" strokeWidth={2} aria-hidden="true" />
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
        <CardDescription>What this domain has connected, placed, and mapped so far.</CardDescription>
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
// Freeze card (A4) — declare + list only. There is NO early-lift or delete endpoint
// (`apps/server/src/routes/governance.ts`'s Freezes section registers exactly `POST /freezes`,
// `GET /freezes`, `GET /freezes/{id}` — no `DELETE`, no PATCH), so this card must never offer one;
// a freeze lifts only by reaching its own `endsAt`. Every row says so in its tooltip.
// -------------------------------------------------------------------------------------------

export type FreezeWindowStatus = "active" | "upcoming" | "past";

export function freezeWindowStatus(
  freeze: Pick<Freeze, "startsAt" | "endsAt">,
  now: Date
): FreezeWindowStatus {
  const t = now.getTime();
  if (t < new Date(freeze.startsAt).getTime()) return "upcoming";
  if (t > new Date(freeze.endsAt).getTime()) return "past";
  return "active";
}

/** Active + upcoming freezes, soonest-starting first. Past ones (already lifted by their own
 *  `endsAt`) are dropped — there is nothing an operator can do about one that already ended. */
export function activeAndUpcomingFreezes(freezes: Freeze[], now: Date): Freeze[] {
  return freezes
    .filter((f) => freezeWindowStatus(f, now) !== "past")
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

const NO_EARLY_LIFT_SENTENCE =
  "This freeze lifts automatically at its end time — there is no early-lift or delete control yet, so it runs in full until then.";

export function FreezeRow({ freeze, now }: { freeze: Freeze; now: Date }): React.JSX.Element {
  const status = freezeWindowStatus(freeze, now);
  return (
    <div
      className="flex flex-col gap-1 py-3"
      data-testid="freeze-row"
      title={`${NO_EARLY_LIFT_SENTENCE} Ends ${formatDate(freeze.endsAt)}.`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-900">{freeze.name ?? "Untitled freeze"}</span>
        <Badge variant={status === "active" ? "warning" : "neutral"}>
          {status === "active" ? "Active" : "Upcoming"}
        </Badge>
      </div>
      <p className="text-xs text-slate-500">
        {formatDate(freeze.startsAt)} – {formatDate(freeze.endsAt)} · scope{" "}
        <span className="font-mono">{freeze.scopeObjectId}</span>
      </p>
      <p className="text-sm text-slate-700">{freeze.reason}</p>
    </div>
  );
}

export interface FreezeFormState {
  scopeObjectId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  reason: string;
}

export function emptyFreezeForm(): FreezeFormState {
  return { scopeObjectId: "", name: "", startsAt: "", endsAt: "", reason: "" };
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
    reason: form.reason.trim()
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
              <p className="text-xs text-slate-500" title={NO_EARLY_LIFT_SENTENCE}>
                Runs until this instant — no early lift yet.
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
            <QueryErrorNotice error={freezesQuery.error} what="freezes" testId="setup-freezes-error" />
          ) : freezes && freezes.length === 0 ? (
            <EmptyState icon={Snowflake} message="No active or upcoming freezes yet." />
          ) : (
            <div className="flex flex-col divide-y divide-slate-200" data-testid="freeze-list">
              {freezes?.map((freeze) => (
                <FreezeRow key={freeze.id} freeze={freeze} now={now} />
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
            created inside a container already declared that way — is invisible everywhere else:
            no federation peer is ever told it exists. The only way out is a deliberate, one-way
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
