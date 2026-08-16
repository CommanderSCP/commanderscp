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
 * Pinned on every PR by `outposts-honesty.test.tsx` (cheaper than the Playwright suite, which also
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
 * The honest-unknown marker — the Badge `unknown` tone (design spec §1.5/§2.2), the ONE sanctioned
 * rendering of the honesty pill app-wide, so an operator reads one visual language for "this
 * instance cannot see / is not the authority" everywhere it appears.
 *
 * Its own testid (`outpost-unknown`) rather than the board's, so the two suites cannot pass on each
 * other's markup.
 */
export function UnknownHere({ title, label = "unknown here" }: { title: string; label?: string }) {
  return (
    <Badge variant="unknown" title={title} data-testid="outpost-unknown">
      {label}
    </Badge>
  );
}

/**
 * "This side's own record — nothing here observes the peer." (spec §4E) — the ONE canonical
 * sentence replacing the three drifted paragraph variants that used to say this on `/outposts`,
 * `/outposts/$peerDomainId`, and `/federation` separately. A fragment in chrome (copy rule 1); the
 * full rationale lives in the `title` tooltip.
 */
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

/**
 * THE ATTENTION-DOT COLUMN (spec §4E) — a leading at-a-glance triage signal derived ONLY from
 * signals already computed on this row, never a new fetch or a fabricated threshold:
 *
 *   * `danger` (red) — a signal that something set up to work is NOT working: this side is opted
 *     into poke-mode but has never actually received one (the named unilateral-sparse case
 *     `outpost-configuration.tsx` also renders, computed the same way here for the overview).
 *   * `warning` (amber) — "worth a look": transport cannot be derived (no base URL or delivery
 *     target configured), or the trust tier is unset/unverified.
 *   * `nominal` (slate) — nothing above is true.
 *
 * Transport-unknown is DELIBERATELY warning, not danger (first QA pass got this wrong): a freshly
 * enrolled peer has no transport yet, and a genuinely air-gapped peer may NEVER have one — bundles
 * move by hand, which is a supported deployment shape, not a failure. Red on every fresh or
 * air-gap row is the wall-of-amber problem reborn one tier up: when everything is a fire, nothing
 * is. Red therefore requires a signal that a configured mechanism is misbehaving.
 */
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
  { tier: "unknown"; provenance: "none" } | { tier: string; provenance: "declared" | "unverified" };

/**
 * THE TIER CLAIM AND ITS QUALIFIER, DERIVED ONCE (round 3, the X4 census miss).
 *
 * `data-trust-tier` is a CLAIM, and this suite's own stated rule is that the forbidden thing is the
 * claim — the rendered word AND the machine-readable attribute. The ROW carried a bare
 * `data-trust-tier={status.trustTier ?? "unknown"}` with no qualifier beside it, so an unverified
 * hand-typed peer and a commander-declared one produced a BYTE-IDENTICAL
 * `<tr … data-trust-tier="commercial">` — and the row attribute is exactly what an E2E selector or
 * any other DOM consumer keys on. The cell inside had been fixed; the row had not, because the
 * census walked the components rather than the attributes.
 *
 * So both read this. A qualifier that is computed in one place cannot be applied in one place and
 * forgotten in the other.
 */
export function trustTierMark(status: FederationPeerStatus): TierMark {
  const tier = status.trustTier ?? null;
  if (tier === null) return { tier: "unknown", provenance: "none" };
  // TWO INDEPENDENT SIGNALS FOR ONE FACT — see `TrustTierCell` below for why they are OR'd.
  const unverified =
    (status.trustTierProvenance ?? null) === "unverified" || isPeerUnknown(status, "trustTier");
  return { tier, provenance: unverified ? "unverified" : "declared" };
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

  // TWO INDEPENDENT SIGNALS FOR ONE FACT, and the honest branch is whichever fires. The server sets
  // `trustTierProvenance: "unverified"` AND pushes `"trustTier"` into `unknownFields` for exactly this
  // case (`status-repo.ts`: `if (trustTier === null || tier?.unverified === true)`; the pairing is
  // documented on the schema field). `trustTierProvenance` is `.nullable().optional()`, so a response
  // that carries the TIER and the DECLARATION but omits the provenance is well-formed — and keying on
  // provenance alone dropped such a row through to the declared badge below, rendering a hand-typed
  // claim BYTE-IDENTICAL to a commander assertion. That is the fabrication phase A round 4 existed to
  // fix, with the honest signal already on the wire and unread. So: OR them.
  const mark = trustTierMark(status);
  if (mark.provenance === "unverified") {
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
              // The reason must be one that can be TRUE HERE. This branch is only reachable after
              // `neverExported` returned FALSE — something HAS been exported to this peer — so the
              // old copy ("nothing has been exported yet") explained the marker with the one fact
              // this code path rules out. What is actually true is narrower: the count is absent or
              // the server declared it unobservable.
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
/** Shared tooltip copy for the two sourceless columns (spec §4E: milestone codes stay out of
 *  rendered/tooltip copy — the "M16.4" citation that used to sit here moved to this comment).
 *  A return-path confirmation that would source `appliedAtPeer` is a named future increment, not a
 *  field that exists today. Shared with `outpost-detail.tsx`'s `OutpostStatusCard`, which renders
 *  the same two fields with the same honest reason. */
export const APPLIED_AT_PEER_TITLE =
  "This instance cannot observe what the outpost applied: it records only what it exported. A " +
  "return-path confirmation isn't implemented yet.";
export const HEALTH_ROLLUP_TITLE =
  "No per-outpost health signal is replicated to this instance, so there is no rollup to show.";

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
          <Badge variant="neutral" className="capitalize">
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

/**
 * THIS DOMAIN, as an outpost — ADR-0026 §9.2, owner decision D3: "a commander acting in an outpost
 * capacity IS an outpost and must be shown as one, exempt from polling and poking itself."
 *
 * Rendered as its OWN panel rather than a row in the table below, and that is the whole design.
 * ADR-0022 splits outpost authority between a `federation_peers` row (transport, keys, sync state)
 * and an `outpost` graph object (declared config) — and **this domain has neither**. Seven of the
 * table's nine columns therefore have no source for self: last sync in, exported by this side,
 * applied at outpost, health, transfers, trust tier, transport. Putting self in the table would
 * mean blanking them, which is exactly the failure this file's module doc exists to prevent — an
 * unobservable field must be an explicit unknown, never a blank. A panel has no columns to blank,
 * so it can state only what `federation_self` actually knows.
 *
 * The exemption from polling is a DATA fact, not a rendering one: this row is synthesised here and
 * is never written to `federation_peers`, because a self peer row would make the federation-sync
 * loop dial its own `base_url` and sync a journal against itself.
 *
 * Deliberately NOT shown: the stages this domain coordinates. ADR-0026 D10 makes a stage a DERIVED
 * name over a place-role deployment-target, and none of this instance's targets carry the
 * `environment` property that derivation needs — so there is nothing honest to print yet.
 */
/**
 * THE CO-LOCATED OUTPOST'S TIER (§10.5) — the same three states `TrustTierCell` renders for a peer
 * row, read off the OutpostConfig itself (this record has no peer-status row): no tier → the unknown
 * marker; a tier the server ALSO lists in `unknownFields` (an unverified hand-filled shadow) →
 * `<tier> · unverified`; else the plain badge. Never blank, never defaulted.
 */
export function SelfOutpostTier({ config }: { config: OutpostConfig }): React.JSX.Element {
  const tier = config.trustTier ?? null;
  if (tier === null) {
    return (
      <span data-testid="self-outpost-tier" data-trust-tier="unknown" data-tier-provenance="none">
        <UnknownHere
          label="no tier asserted"
          title="No trust tier has been asserted for the co-located outpost. The tier is entered by an operator and has no other source — it is not defaulted."
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

/**
 * THE CO-LOCATED OUTPOST LINE inside the self-domain panel (pipeline-substrate-registry-scan.md
 * §10.5): the `outpost` record whose `peerDomainId` is THIS instance's own domain, read off
 * `FederationStatusResponse.selfOutpost` — the ONE place a self-bound record can be read, since it
 * has no peer row and so no `peers[]` entry. Three states, each stated:
 *   * a record  → its name (linked to `/federation/outposts/$peerDomainId` with self's own id — that
 *                 page renders the co-located record), its tier, and the marker
 *                 `co-located · this instance`;
 *   * `null`    → `no outpost registered` — a stated absence, with the way to declare one (quiet);
 *   * absent    → `not reported` — an older server that does not resolve it; NOT read as "none".
 */
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
        title="This server did not report whether this domain has a co-located outpost record; it is not a statement that there is none."
      >
        not reported
      </span>
    );
  }
  if (selfOutpost === null) {
    return (
      <span
        data-testid="self-outpost"
        data-self-outpost="none"
        className="text-xs text-slate-500"
        title="No outpost record names this instance's own trust domain. Every deployment target is part of some outpost; declare the co-located one so this domain's own targets read it on their pipeline tiles."
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
        title="This record's peerDomainId is this instance's own trust domain — the outpost co-located with this instance. It has no peer row: nothing syncs to or from it."
        data-testid="self-outpost-marker"
      >
        co-located · this instance
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
              label: "Co-located outpost",
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
        description="Every outpost and retrans peer this domain syncs with."
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
