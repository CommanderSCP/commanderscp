import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { BundleTransfer, FederationPeerStatus } from "@scp/schemas";
import { client } from "../lib/client";
import { federationStatusKey } from "../lib/query-client";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";

/**
 * `/federation/outposts` — M16.2 phase B (B1), THE OUTPOSTS OVERVIEW: every outpost/retrans peer
 * this instance syncs with, in one table.
 *
 * WHAT THIS FILE IS ACTUALLY ABOUT. Phase A (ADR-0022) spent four review rounds making the
 * `/federation/status` response say only what it can source: an unasserted trust tier is `null` and
 * named in `unknownFields`; a peer with no transport configured is `null`, NOT `air-gap`; every
 * export figure measures WHAT THIS SIDE PUT ON THE WIRE and there is deliberately no
 * applied-at-the-peer field at all. A browser that paints those nulls as blanks — or, worse, as
 * green ticks — undoes every one of those rounds in one render pass. So the rule here is the same
 * rule `service-board.tsx` follows, applied to federation:
 *
 *   AN UNOBSERVABLE FIELD IS AN EXPLICIT UNKNOWN. It is never blank, never a zero, never a default,
 *   and never a success colour — and no string on this page may read as "the outpost has this".
 *
 * Consumes ONLY the generated SDK (`client.federation.status()`), per charter principle 3.
 * Pinned on every PR by `outposts-honesty.test.tsx` (Playwright is main-only in this repo, so the
 * guarantees that must not regress live in plain vitest + `renderToStaticMarkup`).
 */

/** The peer roles this page is ABOUT (ADR-0004). A `commander` peer is another instance's view of
 *  us, not an outpost we manage, so it is excluded — and the count of what was excluded is shown,
 *  because a filtered list that hides its own filter is its own small dishonesty. */
export const OUTPOST_PEER_ROLES = ["outpost", "retrans"] as const;

export function isOutpostPeer(status: FederationPeerStatus): boolean {
  return (OUTPOST_PEER_ROLES as readonly string[]).includes(status.peer.role);
}

/** True when the server explicitly declared this peer-status field UNOBSERVABLE
 *  (`FederationPeerStatusSchema.unknownFields`) — as opposed to observed-and-empty. `unknownFields`
 *  is optional on the wire (additivity): an older server that never declares anything must not be
 *  read as declaring everything observable, so `undefined` means "nothing declared", and the
 *  per-cell renderers below still refuse to paint a bare `null` as a reading. */
export function isPeerUnknown(status: FederationPeerStatus, field: string): boolean {
  return (status.unknownFields ?? []).includes(field);
}

/**
 * The honest-unknown marker — deliberately the SAME dashed-amber idiom as `service-board.tsx`'s
 * `UnknownHere` and `replica-origin.tsx`'s `ForeignOriginNotice`, so an operator reads one visual
 * language for "this instance cannot see / is not the authority" across the whole app.
 *
 * Its own testid (`outpost-unknown`) rather than the board's, so the two suites cannot pass on each
 * other's markup.
 */
export function UnknownHere({ title, label = "unknown here" }: { title: string; label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800"
      title={title}
      data-testid="outpost-unknown"
    >
      {label}
    </span>
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

/** A bundle checksum, abbreviated for a table cell but recoverable via `title`. This is the "as of
 *  ⟨bundle⟩" identifier DESIGN §13 requires beside every federated reading. */
export function ChecksumRef({ checksum }: { checksum: string }): React.JSX.Element {
  return (
    <span
      className="font-mono text-xs text-slate-500"
      title={checksum}
      data-testid="outpost-bundle-ref"
    >
      as of {checksum.slice(0, 12)}…
    </span>
  );
}

export function roleBadge(role: string): React.JSX.Element {
  return (
    <Badge variant={role === "commander" ? "info" : "secondary"} className="capitalize">
      {role}
    </Badge>
  );
}

/**
 * TRUST TIER — the field with no source but an operator's own keystrokes, and three distinct states
 * that must never be shown alike (ADR-0022):
 *
 *   * NO TIER — `trustTier: null`, declared unknown. Renders the unknown marker. It must NEVER
 *     render blank and must never render `commercial`: "the operator has not decided" and "the
 *     operator asserted the lowest tier" are opposite facts, and defaulting one to the other is the
 *     invented posture this whole milestone exists to prevent.
 *   * DECLARED — a tier this instance is authoritative for (its own local-origin `outpost` object on
 *     a commander; the signature-verified commander replica on an outpost). A plain badge.
 *   * UNVERIFIED — the only tier available came from a `provenance:'manual'` HAND-FILLED SHADOW
 *     (DESIGN §13 hand-fill). The value rides the wire, and the server ALSO lists `trustTier` in
 *     `unknownFields` for exactly this case. Rendering it as a commander assertion is the
 *     fabrication phase A's review round 4 fixed on the server; this is the rendering half.
 */
export function TrustTierCell({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  const tier = status.trustTier ?? null;
  const provenance = status.trustTierProvenance ?? null;

  if (tier === null) {
    return (
      <span data-testid="outpost-tier" data-trust-tier="unknown" data-tier-provenance="none">
        <UnknownHere
          title={
            "No trust tier has been asserted for this outpost. The tier is entered by an operator and " +
            "has no other source — it is not derived from transport, and it is not defaulted."
          }
        />
      </span>
    );
  }

  if (provenance === "unverified") {
    return (
      <span data-testid="outpost-tier" data-trust-tier={tier} data-tier-provenance="unverified">
        <span
          className="inline-flex items-center gap-1 rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800"
          title={
            `'${tier}' comes from an UNVERIFIED hand-filled shadow copy, not from this instance's own ` +
            "assertion and not from a signature-verified replica. Reconcile the outpost's config to adopt " +
            "or replace it before relying on this value."
          }
          data-testid="outpost-tier-unverified"
        >
          {tier} · unverified
        </span>
      </span>
    );
  }

  return (
    <span data-testid="outpost-tier" data-trust-tier={tier} data-tier-provenance="declared">
      <Badge variant="secondary" data-testid="outpost-tier-declared">
        {tier}
      </Badge>
    </span>
  );
}

/**
 * TRANSPORT MODE — config-derived, never an observation (phase A replaced a `connectivity` field
 * whose `connected` value asserted reachability nobody had measured).
 *
 *   * `dialable` — an https/mTLS base URL is CONFIGURED. It does not say the peer was ever reached;
 *     the reachability observations are `lastPullAttemptAt`/`lastPullSuccessAt`/`effectiveCadence`,
 *     rendered beneath it.
 *   * `air-gap` — no base URL, a delivery target: a file/object channel.
 *   * `null` — NOT DERIVABLE, and emphatically NOT air-gap. Either nothing is configured at all, or
 *     a base URL federation refuses to dial (plain http) is configured. Reading "no transport" as
 *     "air-gapped" is the same class of fabrication as reading "no tier" as "commercial".
 */
export function TransportCell({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  const mode = status.transportMode ?? null;
  if (mode === null) {
    return (
      <span data-testid="outpost-transport" data-transport-mode="unknown">
        <UnknownHere
          title={
            "No transport channel can be derived for this peer: either no base URL and no delivery target " +
            "are configured, or a base URL federation refuses to dial (plain http) is. This is a " +
            "configuration to fix — it is NOT an air-gap posture."
          }
        />
      </span>
    );
  }
  return (
    <span data-testid="outpost-transport" data-transport-mode={mode}>
      <Badge variant="outline">{mode}</Badge>
      <div className="mt-1 text-xs text-slate-500">
        {mode === "dialable"
          ? `last pull ${formatDateTime(status.lastPullSuccessAt)}`
          : "carried by bundle"}
      </div>
    </span>
  );
}

/** INBOUND — what arrived here FROM this outpost. Legitimately observable: it is this side's own
 *  confirmed-import ledger row. The bundle checksum beside it is DESIGN §13's "as of ⟨bundle⟩". */
export function InboundSyncCell({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  const checksumUnknown = isPeerUnknown(status, "lastSyncedBundleChecksum");
  return (
    <div data-testid="outpost-inbound">
      <div className="text-sm text-slate-900">{formatDateTime(status.lastSyncedAt)}</div>
      <div className="mt-1">
        {checksumUnknown || !status.lastSyncedBundleChecksum ? (
          <UnknownHere
            label="no bundle named"
            title={
              "No confirmed inbound sync bundle carries a recorded checksum for this peer, so there is no " +
              "bundle to name this reading 'as of'."
            }
          />
        ) : (
          <ChecksumRef checksum={status.lastSyncedBundleChecksum} />
        )}
      </div>
    </div>
  );
}

/**
 * OUTBOUND — PENDING-EXPORT, AND NOTHING MORE.
 *
 * Every figure here measures what THIS SIDE PUT ON THE WIRE. The commander cannot observe what a
 * peer applied (`sync_cursors` records only what WE applied FROM a peer; `bundle_transfers` export
 * rows are INSERT-only and never advance), so there is no "up to date", no "in sync", no green tick
 * — a zero backlog means only that this side has bundled everything it has authored, which says
 * nothing whatsoever about whether the outpost received or applied any of it.
 */
export function PendingExportCell({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  // BELT AND BRACES, and not decoration. `unknownFields` is OPTIONAL on the wire (additivity), so an
  // older server sends a NULL sequence and declares nothing — and keying only on the declaration
  // would then render "exported through #" with an empty number, i.e. paint a peer that was never
  // exported to as one that was. The value's own absence is checked too. (`InboundSyncCell` above
  // already does this for the checksum; this cell was the outlier.)
  const neverExported =
    isPeerUnknown(status, "lastExportedThroughSequence") ||
    status.lastExportedThroughSequence === null ||
    status.lastExportedThroughSequence === undefined;
  if (neverExported) {
    return (
      <div data-testid="outpost-export" data-export-state="none-recorded">
        <UnknownHere
          label="no export recorded"
          title={
            "No export bundle addressed to this outpost is recorded on this side. That is a statement about " +
            "this side's own ledger — it is not a statement about what the outpost holds."
          }
        />
      </div>
    );
  }
  const backlogUnknown = isPeerUnknown(status, "pendingExportEntryCount");
  const checksumUnknown = isPeerUnknown(status, "lastExportedBundleChecksum");
  return (
    <div data-testid="outpost-export" data-export-state="exported-handoff-unknown">
      <div className="text-sm text-slate-900">
        exported through #{status.lastExportedThroughSequence} on{" "}
        {formatDateTime(status.lastExportedAt)}
      </div>
      <div className="mt-1 text-xs text-slate-600">
        {backlogUnknown || status.pendingExportEntryCount === null ? (
          <UnknownHere
            label="backlog unknown"
            title="Nothing has been exported to this peer yet, so a pending-export backlog cannot be derived."
          />
        ) : (
          <span data-testid="outpost-export-backlog">
            {status.pendingExportEntryCount} of this domain&apos;s own journal entries not yet put
            on the wire for it
          </span>
        )}
      </div>
      <div className="mt-1">
        {checksumUnknown || !status.lastExportedBundleChecksum ? (
          <UnknownHere
            label="no bundle named"
            title="That export ledger row predates checksum recording, so there is no bundle to name."
          />
        ) : (
          <ChecksumRef checksum={status.lastExportedBundleChecksum} />
        )}
      </div>
    </div>
  );
}

/**
 * THE TWO PROMISED-BUT-SOURCELESS COLUMNS, kept VISIBLE as explicit unknowns rather than quietly
 * dropped (the proposal promised both; a reader who remembers the promise and sees no column
 * assumes it is fine).
 *
 *   * `appliedAtPeer` — what the outpost applied. ABSENT from the schema by design; there will be no
 *     such field until M16.4 builds a return path that can observe it.
 *   * `healthRollup` — the observe-enrichment health rollup. ABSENT from the schema: no health signal
 *     is replicated per peer.
 *
 * Both are named by the server in `unknownFields`. The `false` branch is not decorative: if a future
 * server stops declaring the name (because it grew a real field, or because it regressed), this
 * renders "not reported" — still never a clean reading, and visibly different from the declared case
 * so the change is noticed rather than silently absorbed.
 */
export function SourcelessCell({
  status,
  field,
  title
}: {
  status: FederationPeerStatus;
  field: string;
  title: string;
}): React.JSX.Element {
  return isPeerUnknown(status, field) ? (
    <span data-testid={`outpost-${field}`} data-declared="unknown">
      <UnknownHere title={title} />
    </span>
  ) : (
    <span
      data-testid={`outpost-${field}`}
      data-declared="undeclared"
      className="text-xs text-slate-500"
      title={`${title} This build has no field for it and the server did not declare it unknown either.`}
    >
      not reported
    </span>
  );
}

function transferStatusBadge(status: string): React.JSX.Element {
  const variant = status === "confirmed" ? "success" : status === "submitted" ? "info" : "outline";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

/**
 * RECENT TRANSFERS — the last five rows of THIS instance's own per-hop ledger, labelled as such.
 *
 * Deliberately NOT rendered as a "pending transfers" COUNT: `recentTransfers` is capped at five by
 * the server, so any total derived from it would be a number with no source. A `created` EXPORT row
 * means this side produced a bundle; it never advances, because only the RECEIVER can confirm, in
 * its own database.
 */
export function RecentTransfersCell({
  transfers
}: {
  transfers: BundleTransfer[];
}): React.JSX.Element {
  if (transfers.length === 0) {
    return (
      <span className="text-sm text-slate-400" data-testid="outpost-transfers-none">
        none recorded here
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="outpost-transfers">
      {transfers.slice(0, 5).map((transfer) => (
        <div key={transfer.id} className="flex items-center gap-1.5 text-xs">
          <Badge variant="outline" className="capitalize">
            {transfer.direction}
          </Badge>
          <span className="text-slate-500">{transfer.kind}</span>
          {transferStatusBadge(transfer.status)}
          <span className="text-slate-400">{formatDateTime(transfer.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

/** One outpost's row. EXPORTED for `outposts-honesty.test.tsx`, which renders it directly — the
 *  unknown-vs-observed distinction is the whole point of this view and must be pinned by a check
 *  that runs on every PR, not only by the main-only Playwright suite. */
export function OutpostRow({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  const { peer } = status;
  return (
    <TableRow
      data-testid="outpost-row"
      data-peer-id={peer.id}
      data-trust-tier={status.trustTier ?? "unknown"}
      data-transport-mode={status.transportMode ?? "unknown"}
    >
      <TableCell>
        <Link
          to="/federation/outposts/$peerDomainId"
          params={{ peerDomainId: peer.id }}
          className="font-medium text-slate-900 hover:underline"
          data-testid="outpost-link"
        >
          {peer.name}
        </Link>
        <div className="font-mono text-xs text-slate-500">{peer.id}</div>
      </TableCell>
      <TableCell>{roleBadge(peer.role)}</TableCell>
      <TableCell>
        <TrustTierCell status={status} />
      </TableCell>
      <TableCell>
        <TransportCell status={status} />
      </TableCell>
      <TableCell>
        <InboundSyncCell status={status} />
      </TableCell>
      <TableCell>
        <PendingExportCell status={status} />
      </TableCell>
      <TableCell>
        <SourcelessCell
          status={status}
          field="appliedAtPeer"
          title={
            "This instance cannot observe what the outpost applied: it records only what it exported. " +
            "A return-path confirmation is a named future increment (M16.4), not a field that exists today."
          }
        />
      </TableCell>
      <TableCell>
        <SourcelessCell
          status={status}
          field="healthRollup"
          title="No per-outpost health signal is replicated to this instance, so there is no rollup to show."
        />
      </TableCell>
      <TableCell>
        <RecentTransfersCell transfers={status.recentTransfers} />
      </TableCell>
    </TableRow>
  );
}

export function OutpostsPage(): React.JSX.Element {
  const statusQuery = useQuery({
    queryKey: federationStatusKey(),
    queryFn: () => client.federation.status()
  });

  const peers = statusQuery.data?.peers ?? [];
  const outposts = peers.filter(isOutpostPeer);
  const otherPeers = peers.length - outposts.length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Outposts</h1>
        <p className="text-sm text-slate-500">
          Every outpost and retrans peer this domain syncs with. Every figure below is{" "}
          <strong>this side&apos;s own record</strong> — what arrived here, and what this side put
          on the wire. Nothing here observes what an outpost received or applied (DESIGN §13), so no
          column claims it.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Enrolled outposts</CardTitle>
          <CardDescription>
            Trust tier is entered by an operator and syncs down as commander-origin config;
            transport mode is derived from this peer&apos;s configured base URL / delivery target
            and never claims the peer was reached.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statusQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {statusQuery.isError && (
            <p className="text-sm text-red-700" data-testid="outposts-error">
              Could not load federation status.
            </p>
          )}
          {statusQuery.data && outposts.length === 0 && (
            <p className="text-sm text-slate-500" data-testid="outposts-empty">
              No outpost or retrans peers are paired yet. Pair one with{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5">scp federation pair</code>.
            </p>
          )}
          {outposts.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Outpost</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Trust tier</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead>Last sync in (from it)</TableHead>
                  <TableHead>Exported by this side</TableHead>
                  <TableHead>Applied at outpost</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Recent transfers (last 5)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outposts.map((status) => (
                  <OutpostRow key={status.peer.id} status={status} />
                ))}
              </TableBody>
            </Table>
          )}
          {otherPeers > 0 && (
            <p className="mt-3 text-xs text-slate-500" data-testid="outposts-filtered-note">
              {otherPeers} other paired peer{otherPeers === 1 ? "" : "s"} (role commander or unset){" "}
              {otherPeers === 1 ? "is" : "are"} not listed here — see{" "}
              <Link to="/federation" className="underline">
                Federation status
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
