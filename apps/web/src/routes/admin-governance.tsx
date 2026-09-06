import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { CircleHelp, Scale } from "lucide-react";
import type {
  GovernanceMoveInstanceRung,
  GovernanceMoveRung,
  GovernanceMoveRungList,
  GovernanceMoveRungWriteResponse,
  GovernanceMoveTier,
  GraphObject,
  ObjectListResponse,
  PutGovernanceMoveRungRequest
} from "@scp/schemas";
import { ScpApiError } from "@scp/sdk";
import { client } from "../lib/client";
import { useAuth } from "../lib/auth-context";
import { governanceMoveInstanceKey, governanceMoveRungsKey } from "../lib/query-client";
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
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { PageHeader } from "../components/ui/page-header";
import { SectionLabel } from "../components/ui/section-label";
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
import { formatRelative } from "./admin-dependencies";
import type { ReadState } from "./component-dependencies";

/**
 * ADMIN › GOVERNANCE — the `governance:move` enforcement lattice
 * (docs/proposals/governance-reach-on-containment-move.md §9.2/§9.4; owner ruling 2026-08-18;
 * server routes `apps/server/src/routes/governance-move.ts`; SDK facade
 * `client.governanceMove` in `packages/sdk/src/client.ts`).
 *
 * "When enforcement is on for an object, moving it requires governance:move — held by
 * Administrators and Owners." Enforcement is a top-down monotone OR of enabled RUNGS: the
 * instance rung (deployment-wide, operator-only), the org root, or any containment domain /
 * service / assembly. An upper rung's enable cannot be undone below it — `disable` answers 409
 * naming the blocker.
 *
 * BOTH SITES CARRY THIS PAGE (unlike Admin › Dependencies, which is commander-only): enforcement
 * is PER-INSTANCE, and an outpost's own local containment moves are real moves the lattice can
 * govern just as a commander's can. No role/wire gate here — pinned by `app-shell-nav.test.tsx`
 * (both `COMMANDER_NAV` and `OUTPOST_NAV` carry `/admin/governance`).
 *
 * THREE PIECES, THREE AUTHORITIES (M16.3 offer-the-write rule: every write renders for every
 * viewer, and the server's own refusal sentence is what tells them no):
 *
 *   1. Instance rung — READ-ONLY here. The write is OPERATOR-token only (`SCP_OPERATOR_TOKEN`),
 *      never a tenant role, because it activates enforcement for every org on the deployment; the
 *      page names the CLI verb (`scp governance move-enforcement instance set --enabled
 *      true|false`) rather than offering a browser form for a credential this UI never holds.
 *   2. Org rung — a switch on the org root (`useAuth()`'s `orgId`, from `/auth/me` — ADR-0021 D4
 *      makes the org id the org root object's id). `policy:write` at-or-above the org root;
 *      offered to every viewer, and a 403 renders the server's sentence.
 *   3. Enabled rungs (containment domain / service / assembly) — a table with Disable (direct,
 *      no confirmation dialog: the consequence a confirm step would explain is already the 409
 *      sentence when disabling is refused) and an Enable at… dialog with a container picker.
 *
 * The picker reads `client.domains.list`/`.services.list`/`.assemblies.list` at `limit: 100` —
 * `ObjectListQuerySchema`'s max (packages/schemas/src/graph.ts); a larger value is a 400 on the
 * real server, invisible behind a mocked SDK, which is why the test parses the query against the
 * real schema rather than trusting the literal here.
 *
 * Honest empties throughout: an empty rungs table renders ONLY after a successful zero-row read,
 * never while pending, and a failed read shows the diagnosis instead of a table.
 */

// Refusal rendering — shared by the org switch, the enable dialog and every row's Disable.

/** Every governance:move write refusal the server sends already NAMES what is needed (403:
 *  "…lacks 'policy:write' at scope '…'"; 409: "…is also enabled at <tier> '<name>' above it…") —
 *  so this renders the server's sentence verbatim, plus a Why link only when the problem carried
 *  a `decision_id` (the disable 409 does not today; never fabricate a link the server did not
 *  offer). */
export function governanceMoveWriteRefusal(error: unknown): {
  message: string;
  decisionId?: string;
} {
  if (error instanceof ScpApiError) {
    const detail = error.problem?.detail ?? error.message;
    const decisionId = decisionIdOf(error);
    return decisionId ? { message: detail, decisionId } : { message: detail };
  }
  return { message: queryErrorMessage(error) };
}

function RefusalAlert({
  error,
  testId
}: {
  error: unknown;
  testId: string;
}): React.JSX.Element | null {
  if (error === null || error === undefined) return null;
  const refusal = governanceMoveWriteRefusal(error);
  return (
    <Alert tone="danger" data-testid={testId}>
      {refusal.message}
      {refusal.decisionId ? (
        <>
          {" "}
          <WhyLink decisionId={refusal.decisionId} data-testid={`${testId}-why`} />{" "}
          <span className="font-mono text-xs" data-testid={`${testId}-decision-id`}>
            {refusal.decisionId}
          </span>
        </>
      ) : null}
    </Alert>
  );
}

// -------------------------------------------------------------------------------------------
// Container tiers the Enable at… picker offers. "org" is deliberately absent — the org root has
// its own switch above the table, so there is exactly one write surface per subject.
// -------------------------------------------------------------------------------------------

type ContainerTier = "containment_domain" | "service" | "assembly";

const CONTAINER_TIERS: readonly { tier: ContainerTier; label: string; basePath: string }[] = [
  { tier: "containment_domain", label: "Containment domain", basePath: "domains" },
  { tier: "service", label: "Service", basePath: "services" },
  { tier: "assembly", label: "Assembly", basePath: "assemblies" }
];

/** The registered detail-page path for a rung's tier, or `null` for `org` — the org root has no
 *  registry detail page, and its row is rendered by the switch above, never this table. */
function basePathForTier(tier: GovernanceMoveTier): string | null {
  return CONTAINER_TIERS.find((c) => c.tier === tier)?.basePath ?? null;
}

function containerMatches(c: GraphObject, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return c.name.toLowerCase().includes(q) || c.urn.toLowerCase().includes(q) || c.id === q;
}

const selectClass = cn(
  "flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 py-1 text-sm shadow-sm",
  focusRing
);

// Tier badge — six-tone system, neutral (a tier is a fact, not a status).

function TierBadge({ tier }: { tier: GovernanceMoveTier }): React.JSX.Element {
  return (
    <Badge variant="neutral" data-testid="rung-tier">
      {tier}
    </Badge>
  );
}

export function OrgRungSwitch({
  orgId,
  orgName,
  rung,
  enable,
  disable,
  onChanged
}: {
  orgId: string;
  orgName: string;
  rung: GovernanceMoveRung | undefined;
  enable: (idOrUrn: string) => Promise<GovernanceMoveRungWriteResponse>;
  disable: (idOrUrn: string) => Promise<GovernanceMoveRungWriteResponse>;
  onChanged: (response: GovernanceMoveRungWriteResponse) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const enabled = rung !== undefined;

  const doToggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = enabled ? await disable(orgId) : await enable(orgId);
      onChanged(response);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="org-rung-switch">
      <div className="flex items-center justify-between gap-4">
        <div>
          <SectionLabel as="span">Org root</SectionLabel>
          <p className="text-sm text-slate-700" data-testid="org-rung-name">
            {orgName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={enabled ? "success" : "neutral"} data-testid="org-rung-state">
            {enabled ? "Enabled" : "Disabled"}
          </Badge>
          <Button
            variant={enabled ? "destructive" : "default"}
            size="sm"
            disabled={busy}
            onClick={() => void doToggle()}
            data-testid="org-rung-toggle"
          >
            {busy ? "…" : enabled ? "Disable" : "Enable at org root"}
          </Button>
        </div>
      </div>
      <RefusalAlert error={error} testId="org-rung-error" />
    </div>
  );
}

// One enabled (containment_domain | service | assembly) rung — the table row.

function RungRow({
  rung,
  disable,
  onDisabled,
  now
}: {
  rung: GovernanceMoveRung;
  disable: (idOrUrn: string) => Promise<GovernanceMoveRungWriteResponse>;
  onDisabled: (response: GovernanceMoveRungWriteResponse) => void;
  now: number;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const basePath = basePathForTier(rung.tier);

  const doDisable = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await disable(rung.subjectObjectId);
      onDisabled(response);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <TableRow data-testid="rung-row" data-tier={rung.tier}>
      <TableCell>
        <TierBadge tier={rung.tier} />
      </TableCell>
      <TableCell data-testid="rung-name">
        {basePath ? (
          <Link
            to="/$basePath/$idOrUrn"
            params={{ basePath, idOrUrn: rung.subjectObjectId }}
            className={cn("text-sm text-slate-900 underline", focusRing)}
            data-testid="rung-link"
          >
            {rung.name}
          </Link>
        ) : (
          <span className="text-sm text-slate-900">{rung.name}</span>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs text-slate-600" data-testid="rung-enabled-by">
        {rung.enabledByObjectId}
      </TableCell>
      <TableCell className="text-xs text-slate-600">
        <span title={rung.enabledAt} data-testid="rung-enabled-at">
          {formatRelative(rung.enabledAt, now)}
        </span>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          {/* Direct, no confirmation dialog: the 409 sentence already explains the consequence a
              confirm step would exist to preview, when disabling is refused. */}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void doDisable()}
            data-testid="rung-disable"
          >
            {busy ? "…" : "Disable"}
          </Button>
          <RefusalAlert error={error} testId="rung-disable-error" />
        </div>
      </TableCell>
    </TableRow>
  );
}

export type ContainersRead = Record<ContainerTier, ReadState<readonly GraphObject[]>>;

export function EnableDialogBody({
  containers,
  run,
  onEnabled,
  onCancel
}: {
  containers: ContainersRead;
  run: (
    idOrUrn: string,
    req: PutGovernanceMoveRungRequest
  ) => Promise<GovernanceMoveRungWriteResponse>;
  onEnabled: (response: GovernanceMoveRungWriteResponse) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [tier, setTier] = useState<ContainerTier>("containment_domain");
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const idOrUrn = pick ? pick.id : query.trim();
  const complete = idOrUrn !== "";
  const list = containers[tier];
  const matches = list.status === "ok" ? list.data.filter((c) => containerMatches(c, query)) : [];
  const tierLabel = CONTAINER_TIERS.find((c) => c.tier === tier)?.label ?? tier;

  const doEnable = async () => {
    if (!complete) return;
    setBusy(true);
    setError(null);
    try {
      const response = await run(idOrUrn, note.trim() !== "" ? { note: note.trim() } : {});
      onEnabled(response);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-3 text-sm text-slate-600" data-testid="enable-body">
        <p>
          Enables governance:move enforcement at one container — every containment move of an object
          under it then requires governance:move at-or-above the object AND at-or-above the
          destination. Idempotent.
        </p>
        <label className="block">
          <SectionLabel as="span">Container type</SectionLabel>
          <select
            className={cn(selectClass, "mt-1")}
            value={tier}
            disabled={busy}
            onChange={(e) => {
              setTier(e.target.value as ContainerTier);
              setPick(null);
              setQuery("");
            }}
            data-testid="enable-tier"
          >
            {CONTAINER_TIERS.map((c) => (
              <option key={c.tier} value={c.tier}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className="block">
          <SectionLabel as="span">Container</SectionLabel>
          <Input
            className="mt-1"
            value={query}
            disabled={busy}
            onChange={(e) => {
              setQuery(e.target.value);
              setPick(null);
            }}
            placeholder="Search by name or URN, or paste an id / URN"
            data-testid="enable-search"
          />
          {pick ? (
            <p className="mt-1 text-xs text-slate-700" data-testid="enable-picked">
              Selected: <span className="font-medium">{pick.name}</span>{" "}
              <span className="font-mono text-slate-500">{pick.id}</span>
            </p>
          ) : list.status === "pending" ? (
            <Skeleton className="mt-1 h-5 w-40" data-testid="enable-list-pending" />
          ) : list.status === "error" ? (
            <Badge
              variant="unknown"
              icon={CircleHelp}
              className="mt-1"
              title={`The ${tierLabel} list could not be read: ${queryErrorMessage(list.error)}. An id or URN typed above is still sent as-is.`}
              data-testid="enable-list-unreadable"
            >
              List could not be read
            </Badge>
          ) : (
            <ul
              className="mt-1 max-h-40 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200"
              data-testid="enable-matches"
            >
              {matches.slice(0, 25).map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full flex-col items-start px-2 py-1 text-left hover:bg-slate-50",
                      focusRing
                    )}
                    onClick={() => {
                      setPick({ id: c.id, name: c.name });
                      setQuery(c.name);
                    }}
                    data-testid="enable-match"
                    data-id={c.id}
                  >
                    <span className="text-sm text-slate-900">{c.name}</span>
                    <span className="font-mono text-xs text-slate-500">{c.urn}</span>
                  </button>
                </li>
              ))}
              {matches.length === 0 ? (
                <li className="px-2 py-1 text-xs text-slate-500" data-testid="enable-no-matches">
                  No listed {tierLabel.toLowerCase()} matches
                  {query.trim() !== "" ? " — the text above is sent as an id / URN as typed." : "."}
                </li>
              ) : null}
            </ul>
          )}
        </div>
        <label className="block">
          <SectionLabel as="span">Note (optional)</SectionLabel>
          <Input
            className="mt-1"
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            placeholder="why this rung was enabled"
            data-testid="enable-note"
          />
        </label>
        <RefusalAlert error={error} testId="enable-error" />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() => void doEnable()}
          disabled={busy || !complete}
          data-testid="enable-confirm"
        >
          {busy ? "Enabling…" : "Enable"}
        </Button>
      </DialogFooter>
    </>
  );
}

// The page's whole rendering off already-loaded reads, and the page (hooks).

export function GovernanceView({
  orgId,
  orgName,
  rungList,
  instance,
  containers,
  enable,
  disable,
  onRungChanged,
  lastSuccess,
  now = Date.now()
}: {
  orgId: string;
  orgName: string;
  rungList: GovernanceMoveRungList;
  instance: ReadState<GovernanceMoveInstanceRung>;
  containers: ContainersRead;
  enable: (
    idOrUrn: string,
    req?: PutGovernanceMoveRungRequest
  ) => Promise<GovernanceMoveRungWriteResponse>;
  disable: (idOrUrn: string) => Promise<GovernanceMoveRungWriteResponse>;
  onRungChanged: (response: GovernanceMoveRungWriteResponse) => void;
  lastSuccess: { message: string; decisionId: string | null } | null;
  now?: number;
}): React.JSX.Element {
  const [enableOpen, setEnableOpen] = useState(false);

  const orgRung = rungList.rungs.find((r) => r.tier === "org");
  const containerRungs = rungList.rungs.filter((r) => r.tier !== "org");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Move governance"
        description="when enforcement is on for an object, moving it requires governance:move — held by Administrators and Owners"
      />

      {lastSuccess ? (
        <Notice tone="success" data-testid="rung-write-success">
          {lastSuccess.message}
          {lastSuccess.decisionId ? (
            <>
              {" "}
              <WhyLink decisionId={lastSuccess.decisionId} data-testid="rung-write-why" />{" "}
              <span className="font-mono text-xs" data-testid="rung-write-decision-id">
                {lastSuccess.decisionId}
              </span>
            </>
          ) : null}
        </Notice>
      ) : null}

      <Card size="compact" data-testid="instance-card">
        <CardHeader>
          <CardTitle>Instance (commander) rung</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {instance.status === "pending" ? (
            <Skeleton className="h-6 w-48" data-testid="instance-pending" />
          ) : instance.status === "error" ? (
            <QueryErrorNotice
              error={instance.error}
              what="the instance governance:move rung"
              testId="instance-error"
            />
          ) : (
            <div className="flex flex-col gap-1" data-testid="instance-state">
              <div className="flex items-center gap-2 text-sm text-slate-700">
                <Badge
                  variant={instance.data.enabled ? "success" : "neutral"}
                  data-testid="instance-badge"
                >
                  {instance.data.enabled ? "Enabled" : "Disabled"}
                </Badge>
                <span>
                  {instance.data.enabled
                    ? "— activates governance:move enforcement for every org on this deployment; no org may disable it."
                    : "— nothing is enforced at the instance level."}
                </span>
              </div>
              <p className="text-xs text-slate-500" data-testid="instance-updated-at">
                {instance.data.updatedAt !== null ? (
                  <span title={instance.data.updatedAt}>
                    updated {formatRelative(instance.data.updatedAt, now)}
                  </span>
                ) : (
                  "(never set)"
                )}
              </p>
            </div>
          )}
          {/* NO BROWSER WRITE HERE, DELIBERATELY: the instance rung binds every org on the
              deployment and is gated by SCP_OPERATOR_TOKEN, a credential this UI never holds. */}
          <p className="text-xs text-slate-500" data-testid="instance-cli-pointer">
            Operator-only, never a browser write:{" "}
            <code className="font-mono">
              scp governance move-enforcement instance set --enabled true|false
            </code>
          </p>
        </CardContent>
      </Card>

      <Card size="compact" data-testid="org-rung-card">
        <CardHeader>
          <CardTitle>Org rung</CardTitle>
        </CardHeader>
        <CardContent>
          <OrgRungSwitch
            orgId={orgId}
            orgName={orgName}
            rung={orgRung}
            enable={(id) => enable(id)}
            disable={disable}
            onChanged={onRungChanged}
          />
        </CardContent>
      </Card>

      <Card size="compact">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Enabled rungs</CardTitle>
            <Button size="sm" onClick={() => setEnableOpen(true)} data-testid="enable-open">
              Enable at…
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {containerRungs.length === 0 ? (
            <EmptyState
              icon={Scale}
              message="No rungs enabled below the org root."
              data-testid="rungs-empty"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead>Container</TableHead>
                  <TableHead>Enabled by</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {containerRungs.map((rung) => (
                  <RungRow
                    key={rung.subjectObjectId}
                    rung={rung}
                    disable={disable}
                    onDisabled={onRungChanged}
                    now={now}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={enableOpen} onOpenChange={(open) => !open && setEnableOpen(false)}>
        <DialogContent data-testid="enable-dialog">
          <DialogHeader>
            <DialogTitle>Enable at…</DialogTitle>
            <DialogDescription>
              Pick a container — a containment domain, a service, or an assembly.
            </DialogDescription>
          </DialogHeader>
          {enableOpen ? (
            <EnableDialogBody
              containers={containers}
              run={enable}
              onEnabled={(response) => {
                setEnableOpen(false);
                onRungChanged(response);
              }}
              onCancel={() => setEnableOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toContainerRead(
  query: UseQueryResult<ObjectListResponse>
): ReadState<readonly GraphObject[]> {
  if (query.error) return { status: "error", error: query.error };
  if (query.data) return { status: "ok", data: query.data.items };
  return { status: "pending" };
}

/** `/admin/governance` — the page: the three reads (rungs, instance, the three container-picker
 *  lists) and the two verbs threaded into the provider-free view. No role/wire gate — enforcement
 *  is per-instance, so both the commander and outpost sites read and write the same lattice. */
export function AdminGovernancePage(): React.JSX.Element {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [lastSuccess, setLastSuccess] = useState<{
    message: string;
    decisionId: string | null;
  } | null>(null);

  const rungsQuery = useQuery({
    queryKey: governanceMoveRungsKey(),
    queryFn: () => client.governanceMove.rungs()
  });
  const instanceQuery = useQuery({
    queryKey: governanceMoveInstanceKey(),
    queryFn: () => client.governanceMove.instance()
  });
  // `limit: 100` is ObjectListQuerySchema's MAX (packages/schemas/src/graph.ts) — a larger value
  // is a 400 before auth, which every other picker in this app also respects.
  const domainsQuery = useQuery({
    queryKey: ["governance-move", "containers", "containment_domain", { limit: 100 }],
    queryFn: () => client.domains.list({ limit: 100 })
  });
  const servicesQuery = useQuery({
    queryKey: ["governance-move", "containers", "service", { limit: 100 }],
    queryFn: () => client.services.list({ limit: 100 })
  });
  const assembliesQuery = useQuery({
    queryKey: ["governance-move", "containers", "assembly", { limit: 100 }],
    queryFn: () => client.assemblies.list({ limit: 100 })
  });

  if (rungsQuery.isLoading)
    return <Skeleton className="h-24 w-full" data-testid="governance-pending" />;
  if (rungsQuery.error) {
    return (
      <QueryErrorNotice
        error={rungsQuery.error}
        what="the governance:move lattice"
        testId="rungs-error"
      />
    );
  }
  const rungList = rungsQuery.data;
  if (!rungList || !user) {
    return <Skeleton className="h-24 w-full" data-testid="governance-pending" />;
  }

  const instance: ReadState<GovernanceMoveInstanceRung> = instanceQuery.error
    ? { status: "error", error: instanceQuery.error }
    : instanceQuery.data
      ? { status: "ok", data: instanceQuery.data }
      : { status: "pending" };

  const containers: ContainersRead = {
    containment_domain: toContainerRead(domainsQuery),
    service: toContainerRead(servicesQuery),
    assembly: toContainerRead(assembliesQuery)
  };

  const refresh = () => void queryClient.invalidateQueries({ queryKey: governanceMoveRungsKey() });

  return (
    <GovernanceView
      orgId={user.orgId}
      orgName={user.orgName}
      rungList={rungList}
      instance={instance}
      containers={containers}
      enable={(idOrUrn, req = {}) => client.governanceMove.enable(idOrUrn, req)}
      disable={(idOrUrn) => client.governanceMove.disable(idOrUrn)}
      onRungChanged={(response) => {
        setLastSuccess({
          message: `${response.enabled ? "Enabled" : "Disabled"} at ${response.tier} '${response.subjectObjectId}' — the list below is re-read from the server.`,
          decisionId: response.decisionId
        });
        refresh();
      }}
      lastSuccess={lastSuccess}
    />
  );
}
