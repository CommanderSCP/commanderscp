import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleHelp, Info } from "lucide-react";
import { ComponentCrate } from "../components/icons/catalog-marks";
import type {
  ServiceBoardAsOf,
  ServiceBoardAssembly,
  ServiceBoardRow,
  ServiceBoardSummary,
  ServiceBoardWave
} from "@scp/sdk";
import { client } from "../lib/client";
import { declaredUnknowns, isAbsent } from "../lib/absent";
import { serviceBoardKey } from "../lib/query-client";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { cn, focusRing } from "../lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { StatCard } from "../components/ui/stat-card";
import { EmptyState } from "../components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { stateBadgeVariant } from "../lib/change-format";
import { waveStatusVariant, formatDate } from "./change-detail";
import type { ChangeState } from "@scp/schemas";

type RouterLinkProps = React.ComponentProps<typeof Link>;

/**
 * An outline `Button`-styled router `Link` (spec §2.12/§4B: every `→` literal dies, replaced by
 * `ArrowRight` on an outline Button). `Button` itself renders a `<button>`, so a navigating control
 * cannot use it directly — this mirrors its `outline size="sm"` classes plus the shared focus ring
 * (§2.10) onto a `Link` instead of duplicating a second visual treatment.
 */
function LinkButton({
  to,
  params,
  hash,
  children,
  className,
  "data-testid": testId
}: {
  to: RouterLinkProps["to"];
  params?: Record<string, string>;
  hash?: string;
  children: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      // Same cast as PageHeader/StatCard: the non-generic Link props extraction drops the
      // object-params arm of the union; the object form is what TanStack accepts at runtime.
      params={params as unknown as RouterLinkProps["params"]}
      hash={hash}
      data-testid={testId}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-900 transition-colors hover:bg-slate-100",
        focusRing,
        className
      )}
    >
      {children}
      <ArrowRight className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
    </Link>
  );
}

/** A "Why?" link into the blocked change's Decisions timeline (its `#decision-<id>` anchor) —
 *  same explainability surface the Phase-1 pipeline view links to (charter principle 6). */
function WhyLink({
  changeId,
  decisionId
}: {
  changeId: string;
  decisionId: string;
}): React.JSX.Element {
  return (
    <Link
      to="/changes/$id"
      params={{ id: changeId }}
      hash={`decision-${decisionId}`}
      className="font-medium text-red-700 underline hover:text-red-900"
      data-testid="board-why-link"
    >
      Why?
    </Link>
  );
}

/** True when the server explicitly told us this field is NOT observable in this domain (see
 *  `ServiceBoardRow.unknownFields`) — as opposed to observed-and-empty. The two must never render
 *  the same way: an unobservable field is an honest UNKNOWN, not a clean bill of health. */
function isUnknown(row: ServiceBoardRow, field: string): boolean {
  return declaredUnknowns(row).includes(field);
}

/** The honest-unknown marker. Deliberately NOT the muted dash used for observed-and-empty, and
 *  deliberately not a success colour — an operator must be able to tell "nothing to report" from
 *  "this instance cannot see". Badge `unknown` is the ONLY sanctioned rendering of an unobservable
 *  pill (spec §1.5/§2.2) — its `text-amber-700` + dashed border are test-pinned. */
function UnknownHere({ title }: { title: string }): React.JSX.Element {
  return (
    <Badge variant="unknown" icon={CircleHelp} title={title} data-testid="board-unknown">
      unknown here
    </Badge>
  );
}

/** The per-wave status badges for a row — one badge per compiled wave, colored by wave status
 *  (reusing the Phase-1 mapping). A partial-failure wave (some targets failed) shows the count. */
function WaveStrip({ waves }: { waves: ServiceBoardWave[] }): React.JSX.Element {
  if (waves.length === 0) {
    return <span className="text-xs text-slate-400">no plan compiled</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="board-wave-strip">
      {waves.map((s) => (
        <Badge
          key={s.waveIndex}
          variant={waveStatusVariant(s.status)}
          title={`${s.name ?? `Wave ${s.waveIndex}`} — ${s.status} (${s.targetCount} target${s.targetCount === 1 ? "" : "s"}${s.failedTargets > 0 ? `, ${s.failedTargets} failed` : ""})`}
          data-testid="board-wave-badge"
        >
          {s.name ?? `W${s.waveIndex}`}: {s.status}
          {s.failedTargets > 0 ? ` (${s.failedTargets}✗)` : ""}
        </Badge>
      ))}
    </div>
  );
}

/** The attention cell — the BLOCKED signal surfaced in red (with the decision_id "Why?" link where
 *  present), plus awaiting-approval and emergency chips. Stable/clean rows read as a muted dash. */
function AttentionCell({ row }: { row: ServiceBoardRow }): React.JSX.Element {
  const { attention, latestChangeId } = row;
  // Never render "nothing needs you" from data this instance does not hold: blocked-ness and
  // pending approvals live in local-only tables that never replicate, so on a read-only replica
  // the false/null zeros below are placeholders, not observations.
  if (isUnknown(row, "attention.blocked")) {
    return (
      <UnknownHere title="Blocked / awaiting-approval state is not observable in this domain — the block Decisions and approval requests behind it stay in the driving domain and never replicate." />
    );
  }
  const clean = !attention.blocked && !attention.awaitingApproval && !attention.emergency;
  if (clean) return <span className="text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="board-attention">
      {attention.blocked && (
        <span
          className="inline-flex items-center gap-1.5 rounded bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700"
          data-testid="board-blocked"
        >
          Blocked
          {latestChangeId && attention.decisionId && (
            <WhyLink changeId={latestChangeId} decisionId={attention.decisionId} />
          )}
        </span>
      )}
      {attention.awaitingApproval && (
        <Badge variant="warning" data-testid="board-awaiting">
          Awaiting approval
        </Badge>
      )}
      {attention.emergency && (
        <Badge variant="danger" data-testid="board-emergency">
          Emergency
        </Badge>
      )}
    </div>
  );
}

/**
 * One component's row. EXPORTED for `service-board-honesty.test.tsx`, which renders it directly:
 * the unknown-vs-observed distinction below is the whole point of this view, and it must be pinned
 * by a check that runs on every PR — not only by the Playwright suite, which is main-only.
 */
/**
 * THE PER-PIPELINE STATE of one row, as one chip per ADR-0007 Category.
 *
 * The board used to say ONE thing per component — its latest change — about a component that runs
 * several independent pipelines. Whichever moved most recently spoke for all of them, so a pipeline
 * that had never run was indistinguishable from one that had just succeeded (owner, 2026-08-10).
 *
 * `not bound` is rendered, not omitted: a component with no infrastructure pipeline is a fact, and
 * an absent chip would read as "this board does not show infra". Same rule as the component
 * pipeline's lanes.
 */
/** The exact ADR-0007 Category spellings — the owner's consistency rule (2026-08-11): rendered
 *  copy uses the wire vocabulary verbatim; "infra"/"config" abbreviations were drift. */
export const CATEGORY_LABEL: Record<string, string> = {
  build: "build",
  infrastructure: "infrastructure",
  configuration: "configuration"
};

export function PipelineChips({ row }: { row: ServiceBoardRow }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="board-pipelines">
      {row.pipelines.map((p) => {
        const label = CATEGORY_LABEL[p.category] ?? p.category;
        // Not-bound and bound-but-never-run are EXPECTED states, not signals — they recede as plain
        // text instead of an actionable Badge competing for the same attention (spec §4B PIPELINES
        // column). Only a real run outcome earns a tone.
        if (!p.bound || p.status === null) {
          const state = !p.bound ? "not bound" : "never run";
          return (
            <span
              key={p.category}
              className="whitespace-nowrap text-xs text-slate-400"
              data-testid="board-pipeline-chip"
              data-category={p.category}
              data-bound={String(p.bound)}
              title={
                p.bound
                  ? undefined
                  : `no ${p.category} executor is bound for this component, so nothing can run it`
              }
            >
              {label} · {state}
            </span>
          );
        }
        const tone =
          p.status === "succeeded"
            ? "success"
            : p.status === "failed" || p.status === "blocked"
              ? "danger"
              : "info";
        return (
          <Badge
            key={p.category}
            variant={tone}
            className="whitespace-nowrap"
            data-testid="board-pipeline-chip"
            data-category={p.category}
            data-bound="true"
            title={`${p.category} pipeline — ${p.status}`}
          >
            {label} · {p.status}
          </Badge>
        );
      })}
    </div>
  );
}

export function BoardRow({ row }: { row: ServiceBoardRow }): React.JSX.Element {
  // "No change here" is only an observation when this deployment can actually see the changes its
  // peers drive. When the server names `latestChangeId` unobservable (a peer's sync scope withholds
  // change objects), the empty cell must read as UNKNOWN, not as "no active change" — the row would
  // otherwise be the board's most confident all-clear built on the least evidence.
  const changeUnknown = isUnknown(row, "latestChangeId");
  return (
    <TableRow
      data-testid="board-row"
      /* "unknown" — not "false" — when blocked is unobservable here. A bare
         data-blocked="false" is a machine-readable NOT-BLOCKED assertion over a
         field this row lists in unknownFields, which reintroduces in the DOM the
         exact confusion the response shape removes on the wire. */
      data-blocked={isUnknown(row, "attention.blocked") ? "unknown" : String(row.attention.blocked)}
      /* "none" — not "true" — when the server sent no driver at all. `driver` is nullable (no
         latest change to attribute), and defaulting an ABSENT driver to `true` made a row with
         nothing to drive machine-readable as one this domain DRIVES, indistinguishable from a
         real local-origin row. Same class as `data-blocked` above, and as the bare row-level
         `data-trust-tier` fixed in `routes/outposts.tsx`. */
      data-driven-here={row.driver ? String(row.driver.drivenHere) : "none"}
    >
      <TableCell>
        <Link
          to="/$basePath/$idOrUrn"
          params={{ basePath: "components", idOrUrn: row.component.id }}
          className="font-medium text-slate-900 hover:underline"
          data-testid="board-component-link"
        >
          {row.component.name}
        </Link>
        {row.activeFreeze && (
          <Badge
            variant="warning"
            className="ml-2"
            title={`Frozen until ${formatDate(row.activeFreeze.endsAt)}: ${row.activeFreeze.reason}`}
            data-testid="board-component-freeze"
          >
            Frozen
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <PipelineChips row={row} />
      </TableCell>
      <TableCell>
        {/* The pipeline link points at the COMPONENT, always — a pipeline is durable and exists with
            nothing in flight. It used to be conditional on `latestChangeId`, which is how a stable
            component ended up with no pipeline to open at all (coordination-ui-views.md §2). */}
        <div className="flex flex-col gap-1">
          <LinkButton
            to="/components/$idOrUrn"
            params={{ idOrUrn: row.component.id }}
            className="w-fit"
            data-testid="board-pipeline-link"
          >
            Open pipeline
          </LinkButton>
        </div>
        {row.latestChangeId ? (
          <div className="mt-1 flex flex-col gap-0.5">
            <Link
              to="/changes/$id/pipeline"
              params={{ id: row.latestChangeId }}
              className="inline-flex items-center gap-1 text-xs text-slate-600 underline hover:text-slate-900"
              data-testid="board-run-link"
            >
              {row.changeName ?? "Latest run"}
              <ArrowRight className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            </Link>
            {isUnknown(row, "changeState") ? (
              // The driving domain has not reported a lifecycle state for this
              // replica yet (the `object_upsert` normally lands before the first
              // `change_status`). Rendering nothing would be indistinguishable from a
              // row with no change at all — the exact confusion this board refuses.
              <span>
                <UnknownHere title="The domain that drives this change has not reported a lifecycle state for it here yet — its state is unknown from this instance, not absent." />
              </span>
            ) : (
              row.changeState && (
                <span>
                  <Badge variant={stateBadgeVariant(row.changeState as ChangeState)}>
                    {row.changeState}
                  </Badge>
                </span>
              )
            )}
            {row.driver && !row.driver.drivenHere && (
              <Badge
                variant="unknown"
                className="w-fit"
                title={`This change is driven by domain ${row.driver.originDomainId ?? "(unknown)"} and replicated here read-only. Its state above is what that domain last reported; its waves, blocked state, approvals${isUnknown(row, "activeFreeze") ? " and any freeze it declared" : ""} are not observable from this instance.`}
                data-testid="board-not-driven-here"
              >
                Not driven here
              </Badge>
            )}
          </div>
        ) : changeUnknown ? (
          <UnknownHere title="Whether a change is rolling through this component is not observable here: a federation peer's sync scope does not carry change objects, so this instance receives that peer's change STATUS without the change itself. An empty cell means 'none was sent to me', not 'none exists'." />
        ) : (
          <span className="text-sm text-slate-400" data-testid="board-no-change">
            no active change
          </span>
        )}
      </TableCell>
      <TableCell>
        {isUnknown(row, "currentWave") ? (
          <UnknownHere title="The driving domain's wave progress is not replicated here." />
        ) : row.currentWave ? (
          <span className="text-sm text-slate-700">{row.currentWave}</span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </TableCell>
      <TableCell>
        {isUnknown(row, "waves") ? (
          <UnknownHere title="Plans and waves are local to the domain that drives the change — they never replicate, so an empty strip here would not mean 'no plan compiled'." />
        ) : (
          <WaveStrip waves={row.waves} />
        )}
      </TableCell>
      <TableCell>
        <AttentionCell row={row} />
      </TableCell>
    </TableRow>
  );
}

/**
 * The releasing / blocked / stable / not-driven-here strip. EXPORTED for the same reason
 * {@link BoardRow} is: `Not driven here` must never be dressed as a success, and `Stable` must stop
 * being dressed as one the moment the server declares it unobservable.
 */
/**
 * The two BOARD-LEVEL unknowns, exported so the WIRING is gated and not just the components it
 * feeds. Reading a literal field name out of `unknownFields` inline is exactly the kind of line a
 * later edit silently changes: nothing would fail, and the caveat would just stop appearing.
 */
export function changeVisibilityUnknownOf(board: { unknownFields: string[] }): boolean {
  // The server names `summary.stable` unobservable for THREE distinct reasons, all of which mean
  // the same thing to this badge — the count is not an all-clear:
  //   (1) a peer paired at a scope that does not carry change objects (`status_only` sends change
  //       STATUS without the change; `policies_only` sends neither);
  //   (2) evidence of a change in flight on a peer that this instance could not attach to anything
  //       local — which is what catches the SENDING side being the narrow one;
  //   (3) the upstream this board depends on is overdue by its own sync cadence.
  // Which one it is shows in the "as of" line (3) and the row-level markers (1, 2).
  return declaredUnknowns(board).includes("summary.stable");
}

export function freezeVisibilityUnknownOf(board: { unknownFields: string[] }): boolean {
  return declaredUnknowns(board).includes("rows[].activeFreeze");
}

/**
 * DESIGN §13's "as of &lt;bundle/date&gt;" label — the requirement paired with an explicit ban on
 * *"presenting stale data as live status"*, and the UI is the layer §13 names as responsible for it.
 * A board on a federated instance renders another domain's changes; without this line nothing on
 * screen distinguishes a live view from a snapshot taken last quarter.
 *
 * THREE READINGS, THREE TREATMENTS — and `null` is deliberately not one of the other two:
 *  - `stale === true`  → the upstream is past the age at which a cycle counts as missed. Warned, and
 *    the server has additionally named `summary.stable` unobservable, so the Stable badge drops its
 *    green in the same render.
 *  - `stale === false` → not overdue. A plain, quiet timestamp.
 *  - `stale === null`  → this instance schedules no pulls for that peer at all (an air-gapped peer;
 *    an outpost seen from the commander). There is no schedule for the data to be late against, so
 *    rendering it as "fresh" would assert something nobody measured. It renders as the bare as-of
 *    label, which is exactly the bounded guarantee §13 grants for an air-gapped domain.
 *
 * THE THRESHOLD IS `staleAfterSeconds`, NEVER `expectedWithinSeconds`. The two differ by the
 * server's grace factor, and this tooltip used to quote the cadence as if it were the bound —
 * telling an operator that 90-second-old data was "within" a 60-second cadence, which is false and
 * is exactly the kind of number a reader checks against a clock. Both are shown, each named for
 * what it is; the factor between them is never recomputed here.
 */
export function BoardAsOfLabel({
  asOf
}: {
  asOf: ServiceBoardAsOf | null;
}): React.JSX.Element | null {
  if (!asOf) return null;
  const when = asOf.at ? formatDate(asOf.at) : "never";
  // Exhaustive on purpose: "unknown" is a transfer recorded before the transport was stored, and it
  // must read as "we do not know" rather than fall through to "nothing received" (a different, and
  // false, statement).
  const arrival: string = {
    "live-pull": "live pull",
    bundle: "bundle import",
    never: "nothing received",
    unknown: "transport not recorded"
  }[asOf.via];
  return (
    <p
      className={`mt-1 text-xs ${asOf.stale === true ? "font-medium text-amber-700" : "text-slate-500"}`}
      data-testid="board-as-of"
      title={
        asOf.stale === true
          ? `Overdue: nothing has arrived from ${asOf.peerName} for ${asOf.ageSeconds}s, past the ${asOf.staleAfterSeconds}s after which a sync cycle counts as missed (its effective sync cadence is ${asOf.expectedWithinSeconds}s, plus the grace a healthy peer needs — data is always at least one cadence old by the time the next import lands). This board may not reflect changes already in flight upstream.`
          : isAbsent(asOf.stale)
            ? `This instance runs no pull schedule for ${asOf.peerName}, so there is no cadence for this data to be late against. It is last-known state as of the bundle named here — not live status (DESIGN §13).`
            : `Not overdue: this data is ${asOf.ageSeconds}s old and ${asOf.peerName} is not counted late until ${asOf.staleAfterSeconds}s (its effective sync cadence is ${asOf.expectedWithinSeconds}s, plus the grace a healthy peer needs — data is always at least one cadence old by the time the next import lands).`
      }
    >
      {asOf.stale === true ? "STALE — as of " : "As of "}
      {when} · {arrival} · {asOf.peerName}
    </p>
  );
}

export function BoardSummary({
  summary,
  stableUnknown,
  componentsBelowAssemblies = 0
}: {
  summary: ServiceBoardSummary;
  stableUnknown: boolean;
  /**
   * How many components sit under an ASSEMBLY of this service rather than directly under it.
   *
   * The four buckets are computed over `rows`, and `rows` is deliberately direct-children-only
   * (intermediate-grouping D3 — an assembly is reported separately, never flattened into its
   * descendants). That is a decided model, and this does not change it. What it changes is the
   * READING: a service whose components all live in an assembly renders four honest zeroes, and
   * four zeroes with no qualifier says "nothing here" when the true statement is "nothing HELD
   * DIRECTLY here". Same class as `stableUnknown` above — a number that is arithmetically right
   * and, unlabelled, tells the operator something false.
   */
  componentsBelowAssemblies?: number;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="board-summary">
      <StatCard
        data-testid="board-summary-releasing"
        label={<Badge variant="info">Releasing</Badge>}
        value={summary.releasing}
      />
      <StatCard
        data-testid="board-summary-blocked"
        label={<Badge variant="danger">Blocked</Badge>}
        value={summary.blocked}
      />
      {/* `success` ONLY while the count is a real observation. When a peer's sync scope withholds
          change objects, this number mixes settled components with components whose change simply
          never arrived — a green badge over it is the fabricated all-clear in its purest form. */}
      <StatCard
        data-testid="board-summary-stable"
        label={
          <Badge
            variant={stableUnknown ? "unknown" : "success"}
            icon={stableUnknown ? CircleHelp : undefined}
            title={
              stableUnknown
                ? "NOT an all-clear on this deployment. Either a federation peer is not sending this instance the change objects it would need (its own scope, or the sending side's), or the upstream this board depends on is overdue by its own sync cadence — see the 'as of' line under the service name. Counted for shape, not asserted as fact."
                : undefined
            }
          >
            Stable
          </Badge>
        }
        value={summary.stable}
      />
      <StatCard
        data-testid="board-summary-not-driven-here"
        label={
          <Badge
            variant="warning"
            title="Rows whose latest change is another domain's — replicated here read-only. Their waves, blocked state and approvals are NOT observable from this instance; they are deliberately not counted as stable."
          >
            Not driven here
          </Badge>
        }
        value={summary.notDrivenHere}
      />
      {componentsBelowAssemblies > 0 && (
        <span
          className="inline-flex items-center gap-1 text-xs text-amber-700"
          data-testid="board-summary-scope-note"
          title="These four counts are computed over components held DIRECTLY by this service. Components inside an assembly are counted on that assembly's own board, not here."
        >
          <Info className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          {componentsBelowAssemblies} more in assemblies below (directly-held components only)
        </span>
      )}
    </div>
  );
}

/**
 * `/services/{id}/board` — the Service release board (coordination-ui-views.md § "Service release
 * board", Phase 2, Layer A). One scannable table of the service's components: each row shows that
 * component's latest change per-wave status, its current wave, and any attention signal (the
 * BLOCKED component surfaced in red with a decision_id "Why?" link), and opens the Phase-1 component
 * pipeline. A summary strip counts releasing / blocked / stable / not-driven-here.
 *
 * Strictly Layer A — real data only. Per-wave image versions/digests and component health are Layer
 * B (not modeled yet); they are shown as an explicit placeholder, never fabricated. The same rule
 * governs federation: a change this instance does not DRIVE (`row.driver.drivenHere === false`)
 * arrives as a read-only replica WITHOUT its plan, Decisions, approvals or freezes, so every field
 * the server named in `row.unknownFields` renders as an explicit "unknown here" marker — visually
 * distinct from both a clean row and the stable count, never a fourth flavour of fine. Freezes are
 * READ-ONLY status here; declaring/lifting one is a controls-phase concern (Phase 5), so the
 * "Freeze service" affordance is present but disabled.
 */
/**
 * ASSEMBLY children of this service (migration 0055, intermediate-grouping D3).
 *
 * Their own card rather than rows in the components table: an assembly is a different KIND of child,
 * and a component COUNT is not a release status — putting it in a status column would read as one.
 * Renders nothing at all when there are none, which is every service on the estate today; unlike the
 * pipeline chips, an empty list here is not a fact worth a card, just a service whose components sit
 * directly under it.
 */
export function BoardAssemblies({ assemblies }: { assemblies: ServiceBoardAssembly[] }) {
  if (assemblies.length === 0) return null;
  return (
    <Card size="compact" data-testid="board-assemblies">
      <CardHeader>
        <CardTitle className="text-base">Assemblies ({assemblies.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Components</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {assemblies.map((a) => (
              <TableRow key={a.id} data-testid="board-assembly">
                <TableCell className="font-medium text-slate-900">{a.name}</TableCell>
                <TableCell className="text-slate-600">
                  {a.componentCount} component{a.componentCount === 1 ? "" : "s"}
                </TableCell>
                <TableCell className="text-right">
                  <LinkButton to="/$basePath/$idOrUrn" params={{ basePath: "assemblies", idOrUrn: a.id }}>
                    Open
                  </LinkButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function ServiceBoardPage(): React.JSX.Element {
  const id = useIdOrUrnParam();

  const boardQuery = useQuery({
    queryKey: serviceBoardKey(id ?? ""),
    queryFn: () => client.services.board(id!),
    enabled: !!id,
    refetchInterval: 4000
  });

  if (!id) return <p className="text-sm text-red-600">Not found.</p>;
  if (boardQuery.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (boardQuery.isError || !boardQuery.data) {
    return (
      <p className="text-sm text-red-600">
        {boardQuery.error instanceof Error ? boardQuery.error.message : "Not found"}
      </p>
    );
  }

  const board = boardQuery.data;
  const { service, rows, summary, serviceFreeze } = board;
  const componentsBelowAssemblies = board.childAssemblies.reduce(
    (n, a) => n + a.componentCount,
    0
  );
  // BOARD-LEVEL unknowns (as opposed to a row's own): today, freeze visibility on a federated
  // deployment. Freezes never ride the sync journal in either direction, so on an instance with a
  // federation peer NO row's "not frozen" — driven here or not — can be read as "no freeze applies".
  const freezeVisibilityUnknown = freezeVisibilityUnknownOf(board);
  // The other board-level unknown: a peer paired at a sync scope that does not carry change objects
  // (`status_only` sends change STATUS without the change; `policies_only` sends neither) leaves this
  // instance unable to tell "nothing is rolling through this component" from "the change rolling
  // through it was never sent to me". The stable COUNT is then not an all-clear, and says so.
  const changeVisibilityUnknown = changeVisibilityUnknownOf(board);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1
              className="text-2xl font-semibold tracking-tight text-slate-900"
              data-testid="board-service-name"
            >
              {service.name}
            </h1>
            {serviceFreeze && (
              <Badge
                variant="warning"
                title={`Frozen until ${formatDate(serviceFreeze.endsAt)}: ${serviceFreeze.reason}`}
                data-testid="board-service-freeze"
              >
                Frozen
              </Badge>
            )}
          </div>
          <p className="break-all font-mono text-xs text-slate-500">{service.urn}</p>
          <p className="mt-1 text-sm text-slate-500">Service release board</p>
          {/* DESIGN §13: label the upstream the board depends on, never present it as live status. */}
          <BoardAsOfLabel asOf={board.asOf} />
        </div>
        <div className="flex items-center gap-2">
          <LinkButton
            to="/$basePath/$idOrUrn"
            params={{ basePath: "services", idOrUrn: service.id }}
            data-testid="board-to-detail-link"
          >
            Service detail
          </LinkButton>
          {/* Operator control — deferred to the controls phase (Phase 5). Present to match the
              mockup, but intentionally NOT wired to a mutation here (honesty over completeness). */}
          <Button
            variant="outline"
            size="sm"
            disabled
            title="Declaring a freeze window is a controls-phase feature (Phase 5) — not available on the read board yet."
            data-testid="board-freeze-service"
          >
            Freeze service
          </Button>
        </div>
      </div>

      {/* Summary strip: releasing / blocked / stable / not driven here. The fourth is NOT a fourth
          flavour of fine — it is the count of rows whose latest change this instance does not drive
          and therefore cannot assess, so it carries a warning (never `success`) treatment. */}
      <BoardSummary
        summary={summary}
        stableUnknown={changeVisibilityUnknown}
        componentsBelowAssemblies={componentsBelowAssemblies}
      />

      <BoardAssemblies assemblies={board.childAssemblies} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5 text-base">
            Components ({rows.length})
            {/* Layer B — never a fabricated version/health. The column this used to be a header
                tooltip on is gone; the one honest fact left about it lives here instead. */}
            <span title="Per-wave image version/digest and component health are not captured yet.">
              <Info className="size-3.5 text-slate-400" strokeWidth={1.75} aria-hidden="true" />
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              icon={ComponentCrate}
              data-testid="board-empty"
              message={
                componentsBelowAssemblies > 0
                  ? /* "This service contains no components" was simply FALSE here: the service has
                       components, they sit one rung down inside an assembly. A board that reports a
                       service as empty while the graph holds its components is the same failure as
                       a fabricated all-clear — it is just the emptier direction. */
                    `No components are held directly by this service — ${componentsBelowAssemblies} ` +
                    `${componentsBelowAssemblies === 1 ? "component sits" : "components sit"} in the ` +
                    `${board.childAssemblies.length === 1 ? "assembly" : "assemblies"} above.`
                  : "No components yet."
              }
            />
          ) : (
            <Table data-testid="board-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Component</TableHead>
                  {/* The ADR-0007 Category grouping is explained in the PipelineChips doc comment
                      above, not repeated here — copy rule 2 keeps ADR citations out of rendered
                      (including hover) copy. */}
                  <TableHead title="One chip per pipeline this component runs">Pipelines</TableHead>
                  <TableHead>Latest change</TableHead>
                  <TableHead>Current wave</TableHead>
                  <TableHead>Waves</TableHead>
                  <TableHead>Attention</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <BoardRow key={row.component.id} row={row} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {changeVisibilityUnknown && (
        <Badge
          variant="unknown"
          icon={Info}
          className="w-fit"
          data-testid="board-change-visibility-unknown"
          title="Change visibility is limited on this instance: a federation peer's sync scope does not carry change objects, so a component with no change here may simply be one whose change was never sent. The Stable count is not an all-clear."
        >
          Change visibility limited
        </Badge>
      )}

      {freezeVisibilityUnknown && (
        <Badge
          variant="unknown"
          icon={Info}
          className="w-fit"
          data-testid="board-freeze-visibility-unknown"
          title={`Freeze visibility is limited to this domain: freezes are never replicated between federated instances, so an unfrozen row means "no freeze declared here" — not "no freeze applies".`}
        >
          Freeze visibility limited
        </Badge>
      )}
    </div>
  );
}
