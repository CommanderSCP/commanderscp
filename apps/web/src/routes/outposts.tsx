import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { CommanderStar, OutpostFort, RetransMast } from "../components/icons/federation-roles";
import type {
  BundleTransfer,
  FederationPeerStatus,
  FederationStatusResponse,
  OutpostConfig
} from "@scp/schemas";
import { client } from "../lib/client";
import { isAbsent } from "../lib/absent";
import { cn } from "../lib/utils";
import { federationStatusKey } from "../lib/query-client";
import { Badge } from "../components/ui/badge";
import { QueryErrorNotice } from "../components/query-error";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { KeyValueList } from "../components/ui/key-value-list";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";

/** `/federation/outposts` — M16.2 phase B (B1), THE OUTPOSTS OVERVIEW. See docs/web.md §422. */

/** The peer roles this page is ABOUT (ADR-0004). A `commander` peer is another instance's view of
 *  us, not an outpost we manage, so it is excluded — and the count of what was excluded is shown,
 *  because a filtered list that hides its own filter is its own small dishonesty. */
export const OUTPOST_PEER_ROLES = ["outpost", "retrans"] as const;

export function isOutpostPeer(status: FederationPeerStatus): boolean {
  return (OUTPOST_PEER_ROLES as readonly string[]).includes(status.peer.role);
}

/** True when the server declared this field unobservable. See docs/web.md §423. */
export function isPeerUnknown(status: FederationPeerStatus, field: string): boolean {
  return (status.unknownFields ?? []).includes(field);
}

/** The honest-unknown marker. See docs/web.md §424. */
export function UnknownHere({ title, label = "unknown here" }: { title: string; label?: string }) {
  return (
    <Badge variant="unknown" title={title} data-testid="outpost-unknown">
      {label}
    </Badge>
  );
}

/** "This side's own record. See docs/web.md §425. */
export function ObservationScopeNote(): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-slate-500"
      data-testid="observation-scope-note"
      title={
        "Every figure here is this side's own record: what arrived here, and what this side put on " +
        "the wire. Nothing here observes what a peer received, applied, or is doing right now."
      }
    >
      This side&apos;s own record — nothing here observes the peer.
      <Info className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}

/** THE ATTENTION-DOT COLUMN. See docs/web.md §426. */
export type AttentionLevel = "danger" | "warning" | "nominal";

export function attentionLevel(status: FederationPeerStatus): AttentionLevel {
  const mark = trustTierMark(status);
  const transportUnknown = status.transportMode === null;
  const pokeStuck = status.peer.pokeMode === true && (status.lastPokeReceivedAt ?? null) === null;
  if (pokeStuck) return "danger";
  if (transportUnknown || mark.provenance !== "declared") return "warning";
  return "nominal";
}

const ATTENTION_TITLE: Record<AttentionLevel, string> = {
  danger: "Needs attention: poke-mode is enabled but no poke has ever arrived.",
  warning:
    "Worth a look: no transport is configured (expected for a new or air-gapped peer), or the trust tier is unset/unverified.",
  nominal: "Nothing here needs attention."
};

function AttentionDot({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  const level = attentionLevel(status);
  return (
    <span
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        level === "danger" && "bg-red-500",
        level === "warning" && "bg-amber-400",
        level === "nominal" && "bg-slate-300"
      )}
      data-testid="outpost-attention"
      data-attention={level}
      title={ATTENTION_TITLE[level]}
    />
  );
}

/** ABSENT — `null` OR `undefined`. Moved to `lib/absent.ts` in round 3 so every route shares ONE
 *  guard instead of re-deriving the half-guarded `=== null` form; re-exported here because this file
 *  is where the rule was written down and where its callers look for it. */
export { isAbsent };

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

/** The ADR-0004 role marks (components/icons/federation-roles.tsx) — `unset` stays icon-less:
 *  an undesignated role has no insignia, and inventing one would assert a designation. */
const ROLE_ICONS: Partial<Record<string, LucideIcon>> = {
  commander: CommanderStar,
  outpost: OutpostFort,
  retrans: RetransMast
};

export function roleBadge(role: string): React.JSX.Element {
  return (
    <Badge
      variant={role === "commander" ? "info" : "neutral"}
      className="capitalize"
      icon={ROLE_ICONS[role]}
    >
      {role}
    </Badge>
  );
}

export type TierMark =
  | { tier: "unknown"; provenance: "none" }
  | { tier: string; provenance: "declared" | "unverified" }
  | { tier: "not-applicable"; provenance: "not-applicable" };

/** THE TIER CLAIM AND ITS QUALIFIER, DERIVED ONCE. See docs/web.md §427. */
export function trustTierMark(status: FederationPeerStatus): TierMark {
  // A `retrans` peer is a STRONGER claim than "unobservable". See docs/web.md §428.
  if (status.peer.role === "retrans")
    return { tier: "not-applicable", provenance: "not-applicable" };
  const tier = status.trustTier ?? null;
  if (tier === null) return { tier: "unknown", provenance: "none" };
  // TWO INDEPENDENT SIGNALS FOR ONE FACT — see `TrustTierCell` below for why they are OR'd.
  const unverified =
    (status.trustTierProvenance ?? null) === "unverified" || isPeerUnknown(status, "trustTier");
  return { tier, provenance: unverified ? "unverified" : "declared" };
}

/** Trust tier: the field with no source but a keystroke. See docs/web.md §429. */
export function TrustTierCell({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  // THE RETRANS BRANCH, DERIVED ONCE. See docs/web.md §430.
  const rowMark = trustTierMark(status);
  if (rowMark.tier === "not-applicable") {
    return (
      <span
        data-testid="outpost-tier"
        data-trust-tier="not-applicable"
        data-tier-provenance="not-applicable"
      >
        <span
          className="text-slate-400"
          data-testid="retrans-tier-na"
          title={
            "Not applicable: this peer's federation role is 'retrans'. A trust tier is commander-declared " +
            "config bound through an 'outpost' graph object, and this instance refuses (400) to bind one " +
            "to a peer that is not an outpost — a retrans validates and forwards signed bundles across a " +
            "CDS boundary and holds no commander-declared configuration of its own (ADR-0004)."
          }
        >
          —
        </span>
      </span>
    );
  }

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

  // Two independent signals for one fact, and which is honest. See docs/web.md §431.
  if (rowMark.provenance === "unverified") {
    return (
      <span data-testid="outpost-tier" data-trust-tier={tier} data-tier-provenance="unverified">
        <Badge
          variant="unknown"
          title={
            provenance === "unverified"
              ? `'${tier}' comes from an UNVERIFIED hand-filled shadow copy, not from this instance's own ` +
                "assertion and not from a signature-verified replica. Reconcile the outpost's config to adopt " +
                "or replace it before relying on this value."
              : `'${tier}' rides the wire, but the server declared this field one it cannot observe, so it is ` +
                "NOT an assertion this instance stands behind. Reconcile the outpost's config before relying " +
                "on this value."
          }
          data-testid="outpost-tier-unverified"
        >
          {tier} · unverified
        </Badge>
      </span>
    );
  }

  return (
    <span data-testid="outpost-tier" data-trust-tier={tier} data-tier-provenance="declared">
      <Badge variant="neutral" data-testid="outpost-tier-declared">
        {tier}
      </Badge>
    </span>
  );
}

/** TRANSPORT MODE — config-derived, never an observation. See docs/web.md §432. */
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
      <Badge variant="neutral">{mode}</Badge>
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

/** OUTBOUND — PENDING-EXPORT, AND NOTHING MORE. See docs/web.md §433. */
export function PendingExportCell({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  // BELT AND BRACES, and not decoration. `unknownFields` is OPTIONAL on the wire (additivity), so an
  // older server sends an ABSENT sequence and declares nothing — and keying only on the declaration
  // would then render "exported through #" with an empty number, i.e. paint a peer that was never
  // exported to as one that was. The value's own absence is checked too, in BOTH its legal forms.
  const neverExported =
    isPeerUnknown(status, "lastExportedThroughSequence") ||
    isAbsent(status.lastExportedThroughSequence);
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
        {backlogUnknown || isAbsent(status.pendingExportEntryCount) ? (
          <UnknownHere
            label="backlog unknown"
            title={
              // The reason must be one that can be TRUE HERE. See docs/web.md §434.
              "This side has exported to this peer, but no pending-export backlog is available: the " +
              "server did not report a count, or declared it one it cannot observe. It is NOT a " +
              "statement that nothing is pending."
            }
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

/** The two promised-but-sourceless columns, kept visible. See docs/web.md §435. */
/** Shared tooltip copy for the two sourceless columns. See docs/web.md §436. */
export const APPLIED_AT_PEER_TITLE =
  "This instance cannot observe what the peer applied: it records only what it exported. A " +
  "return-path confirmation isn't implemented yet.";
export const HEALTH_ROLLUP_TITLE =
  "No per-peer health signal is replicated to this instance, so there is no rollup to show.";

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
  const variant = status === "confirmed" ? "success" : status === "submitted" ? "info" : "neutral";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

/** The byte-relay tag beside a transfer row, for one channel. See docs/web.md §437. */
function TransferChannelTag({
  channel
}: {
  channel: BundleTransfer["channel"];
}): React.JSX.Element | null {
  if (channel !== "bytes") return null;
  return (
    <Badge
      variant="neutral"
      data-testid="outpost-transfer-byte-relay"
      title="The retrans byte-relay hop: a signed artifact tarball moved to/from CDS staging, distinct from an ordinary metadata .scpbundle handoff."
    >
      byte relay
    </Badge>
  );
}

/** Recent transfers: the last rows of this instance's ledger. See docs/web.md §438. */
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
          <Badge variant="neutral" className="capitalize">
            {transfer.direction}
          </Badge>
          <span className="text-slate-500">{transfer.kind}</span>
          {transferStatusBadge(transfer.status)}
          <TransferChannelTag channel={transfer.channel} />
          <span className="text-slate-400">{formatDateTime(transfer.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

/** One outpost's row. EXPORTED for `outposts-honesty.test.tsx`, which renders it directly — the
 *  unknown-vs-observed distinction is the whole point of this view and must be pinned by a check
 *  that runs on every PR at unit-test cost, alongside the Playwright suite. */
export function OutpostRow({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  const { peer } = status;
  // THE ROW'S OWN CLAIM CARRIES ITS OWN QUALIFIER. `data-trust-tier` here used to be bare, so an
  // unverified peer and a declared one produced byte-identical row markup even after the CELL
  // learned to tell them apart. Both now read `trustTierMark`, so they cannot disagree.
  const mark = trustTierMark(status);
  return (
    <TableRow
      data-testid="outpost-row"
      data-peer-id={peer.id}
      data-trust-tier={mark.tier}
      data-tier-provenance={mark.provenance}
      data-transport-mode={status.transportMode ?? "unknown"}
    >
      <TableCell>
        <AttentionDot status={status} />
      </TableCell>
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
        <SourcelessCell status={status} field="appliedAtPeer" title={APPLIED_AT_PEER_TITLE} />
      </TableCell>
      <TableCell>
        <SourcelessCell status={status} field="healthRollup" title={HEALTH_ROLLUP_TITLE} />
      </TableCell>
      <TableCell>
        {/* `?? []` — FAIL LOUD IS BETTER THAN FAIL DISHONEST, but a WHITE SCREEN is neither.
            `recentTransfers` is required-not-optional by the schema, and BEFORE ADR-0023 the SDK
            validated no response, so a server that omitted it made `transfers.length` throw a
            TypeError that took the ENTIRE page down — including every honest unknown on every other
            row. SINCE ADR-0023 the SDK rejects that body and the `isError` branch below names the
            operation and the field. The guard stays as the truthful reading of an empty ledger
            ("none recorded here") — "this side has no transfer rows to show". */}
        <RecentTransfersCell transfers={status.recentTransfers ?? []} />
      </TableCell>
    </TableRow>
  );
}

/** THIS DOMAIN, as an outpost. See docs/web.md §439. */
/** THE HQ OUTPOST'S TIER. See docs/web.md §440. */
export function SelfOutpostTier({ config }: { config: OutpostConfig }): React.JSX.Element {
  const tier = config.trustTier ?? null;
  if (tier === null) {
    return (
      <span data-testid="self-outpost-tier" data-trust-tier="unknown" data-tier-provenance="none">
        <UnknownHere
          label="no tier asserted"
          title="No trust tier has been asserted for the HQ outpost (the outpost in this instance's own trust domain). The tier is entered by an operator and has no other source — it is not defaulted."
        />
      </span>
    );
  }
  const unverified = (config.unknownFields ?? []).includes("trustTier");
  return (
    <span
      data-testid="self-outpost-tier"
      data-trust-tier={tier}
      data-tier-provenance={unverified ? "unverified" : "declared"}
    >
      <Badge
        variant={unverified ? "unknown" : "neutral"}
        title={
          unverified
            ? `'${tier}' comes from an UNVERIFIED hand-filled shadow copy, not from this instance's own assertion. Reconcile the record before relying on it.`
            : undefined
        }
      >
        {unverified ? `${tier} · unverified` : tier}
      </Badge>
    </span>
  );
}

/** THE HQ OUTPOST LINE inside the self-domain panel. See docs/web.md §441. */
export function SelfOutpostLine({
  self,
  selfOutpost
}: {
  self: NonNullable<FederationStatusResponse["self"]>;
  selfOutpost: OutpostConfig | null | undefined;
}): React.JSX.Element {
  if (selfOutpost === undefined) {
    return (
      <span
        data-testid="self-outpost"
        data-self-outpost="unreported"
        className="text-xs text-slate-500"
        title="This server did not report whether this domain has an HQ outpost record (the outpost in this instance's own trust domain); it is not a statement that there is none."
      >
        not reported
      </span>
    );
  }
  if (selfOutpost === null) {
    // The declare offer is made ONLY where the server accepts the write. See docs/web.md §442.
    return self.role === "commander" ? (
      <span
        data-testid="self-outpost"
        data-self-outpost="none"
        className="text-xs text-slate-500"
        title="No outpost record names this instance's own trust domain. Every deployment target is part of some outpost; declare the HQ outpost (the outpost in this instance's own trust domain) so this domain's own targets read it on their pipeline tiles."
      >
        no outpost registered —{" "}
        <Link
          to="/federation/outposts/$peerDomainId"
          params={{ peerDomainId: self.domainId }}
          className="underline"
          data-testid="self-outpost-declare-link"
        >
          declare one
        </Link>
      </span>
    ) : (
      <span
        data-testid="self-outpost"
        data-self-outpost="none"
        data-self-outpost-authority="commander"
        className="text-xs text-slate-500"
        title={`No outpost record names this instance's own trust domain. This instance's federation role is '${self.role}': its own record is commander-declared and arrives replicated from the commander — declare it there.`}
      >
        no outpost registered — declared at the commander
      </span>
    );
  }
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1.5"
      data-testid="self-outpost"
      data-self-outpost="registered"
      data-object-id={selfOutpost.objectId}
    >
      <Link
        to="/federation/outposts/$peerDomainId"
        params={{ peerDomainId: self.domainId }}
        className="font-medium text-slate-900 hover:underline"
        data-testid="self-outpost-link"
      >
        {selfOutpost.name}
      </Link>
      <SelfOutpostTier config={selfOutpost} />
      <Badge
        variant="info"
        icon={OutpostFort}
        title="This record's peerDomainId is this instance's own trust domain — the HQ outpost (the outpost in this instance's own trust domain, not a field outpost in another one). It has no peer row: nothing syncs to or from it."
        data-testid="self-outpost-marker"
      >
        HQ outpost · this instance
      </Badge>
    </span>
  );
}

export function SelfDomainPanel({
  self,
  selfOutpost
}: {
  self: FederationStatusResponse["self"];
  /** §10.5 — `FederationStatusResponse.selfOutpost`; omitted = an older server (rendered as
   *  "not reported", never as "none"). */
  selfOutpost?: OutpostConfig | null | undefined;
}): React.JSX.Element | null {
  if (!self) return null;
  const roleDeclared = self.role !== "unset";
  return (
    <Card data-testid="self-domain-panel">
      <CardHeader>
        <CardTitle>This domain</CardTitle>
        <CardDescription>
          Where this instance&apos;s own changes execute. It is <strong>not a paired peer</strong>:
          it never syncs with, exports to, or pokes itself, so the sync columns below do not apply
          to it and are not shown for it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <KeyValueList
          columns={2}
          className="sm:grid-cols-3"
          items={[
            {
              label: "Domain",
              value: <span data-testid="self-domain-name">{self.name}</span>
            },
            {
              label: "Declared role",
              value: (
                <span data-testid="self-domain-role">
                  {roleDeclared ? (
                    /* Through roleBadge so the self-domain declaration wears the same insignia
                       (CommanderStar et al.) as every peer row — one role→mark mapping, no drift. */
                    roleBadge(self.role)
                  ) : (
                    /* `unset` is the lazily-minted default, not a role anyone chose — say so rather
                     * than printing the literal, which reads like a fourth role beside
                     * commander/outpost/retrans. */
                    <span className="text-amber-700">
                      not designated — run{" "}
                      <code className="rounded bg-slate-100 px-1 py-0.5">scp federation init</code>
                    </span>
                  )}
                </span>
              )
            },
            { label: "Domain id", value: self.domainId, mono: true },
            {
              label: "HQ outpost",
              value: <SelfOutpostLine self={self} selfOutpost={selfOutpost} />
            }
          ]}
        />
      </CardContent>
    </Card>
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
      <PageHeader
        title="Outposts"
        description="Every field outpost (an outpost in another trust domain) this domain syncs with, plus every retrans peer relaying this domain's promotions across a CDS boundary."
        meta={<ObservationScopeNote />}
      />

      {statusQuery.data && (
        <SelfDomainPanel self={statusQuery.data.self} selfOutpost={statusQuery.data.selfOutpost} />
      )}

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
          {/* NOT a fixed string (ADR-0023). "Could not load federation status." is what this
              rendered before, and it reads identically for a 401, an unreachable instance, and a
              version skew — three faults with three different remedies. The SDK boundary now
              produces the operation and the offending field; discarding that here would have
              thrown away the single thing the boundary exists to make. */}
          {statusQuery.isError && (
            <QueryErrorNotice
              error={statusQuery.error}
              what="federation status"
              testId="outposts-error"
            />
          )}
          {statusQuery.data && outposts.length === 0 && (
            /* "No outposts" would now contradict the panel directly above, which says this domain
               is one. Scoped to PAIRED peers, which is what this table is actually about. */
            <p className="text-sm text-slate-500" data-testid="outposts-empty">
              No <strong>other</strong> outpost or retrans peers are paired yet — this domain
              coordinates its own, shown above. Pair another with{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5">scp federation pair</code>.
            </p>
          )}
          {outposts.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <span className="sr-only">Attention</span>
                  </TableHead>
                  <TableHead>Outpost</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Trust tier</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead>Last sync in (from it)</TableHead>
                  <TableHead>Exported by this side</TableHead>
                  <TableHead>Applied at peer</TableHead>
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
