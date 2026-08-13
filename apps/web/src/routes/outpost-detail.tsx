import { useQuery } from "@tanstack/react-query";
import type { FederationPeerStatus } from "@scp/schemas";
import { client } from "../lib/client";
import { federationStatusKey } from "../lib/query-client";
import { usePeerDomainIdParam } from "../lib/use-route-params";
import { QueryErrorNotice } from "../components/query-error";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { KeyValueList } from "../components/ui/key-value-list";
import { SectionLabel } from "../components/ui/section-label";
import {
  InboundSyncCell,
  PendingExportCell,
  SourcelessCell,
  TransportCell,
  TrustTierCell,
  RecentTransfersCell,
  ObservationScopeNote,
  APPLIED_AT_PEER_TITLE,
  HEALTH_ROLLUP_TITLE,
  formatDateTime,
  roleBadge
} from "./outposts";
import { PeerSettingsSection } from "./outpost-settings";
import { OutpostConfigurationSection } from "./outpost-configuration";

/**
 * `/federation/outposts/$peerDomainId` — M16.2 phase B, one outpost.
 *
 * THE AUTHORITY SPLIT IS THE PAGE'S STRUCTURE, not a footnote on it (ADR-0022). An outpost exists
 * TWICE in a commander's database and each half owns disjoint facts, so the page has one section per
 * half and each section names the door it writes through:
 *
 *   * STATUS (this file, below) — the reading, from `GET /federation/status`. Read-only.
 *   * SETTINGS (B2) — the `federation_peers` ROW: identity, mTLS/transport, reachability. Written
 *     through the structurally KEYLESS `PATCH /v1/federation/peers/{id}`, never through pair/re-pair
 *     (a re-pair with a different `publicKey` is a KEY ROTATION that hard-revokes the old key).
 *   * CONFIGURATION (B3) — the `outpost` GRAPH OBJECT: the commander-declared `trustTier`, which
 *     rides `object_upsert` down to the outpost as a read-only replica.
 *
 * Consumes ONLY the generated SDK (charter principle 3).
 */

/** The one peer-status row this page is about, or `null` when the id names no paired peer. */
export function findPeerStatus(
  peers: FederationPeerStatus[] | undefined,
  peerDomainId: string | undefined
): FederationPeerStatus | null {
  if (!peers || !peerDomainId) return null;
  return peers.find((status) => status.peer.id === peerDomainId) ?? null;
}

/** The read-only status panel — every field rendered by the SAME cells the overview uses, so the two
 *  surfaces cannot drift into disagreeing about what is observable. */
export function OutpostStatusCard({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Status</CardTitle>
        <CardDescription>
          <ObservationScopeNote />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <KeyValueList
          columns={2}
          items={[
            { label: "Role", value: roleBadge(status.peer.role) },
            { label: "Trust tier", value: <TrustTierCell status={status} /> },
            { label: "Transport", value: <TransportCell status={status} /> },
            {
              label: "Effective sync cadence",
              value: (
                <span data-testid="outpost-effective-cadence">
                  {status.effectiveCadence ?? "unreported"}
                </span>
              )
            },
            { label: "Last sync in (from this outpost)", value: <InboundSyncCell status={status} /> },
            { label: "Exported by this side", value: <PendingExportCell status={status} /> },
            {
              label: "Applied at outpost",
              value: (
                <SourcelessCell status={status} field="appliedAtPeer" title={APPLIED_AT_PEER_TITLE} />
              )
            },
            {
              label: "Health rollup",
              value: <SourcelessCell status={status} field="healthRollup" title={HEALTH_ROLLUP_TITLE} />
            },
            {
              label: "Last poke received",
              value: (
                <span data-testid="outpost-last-poke">
                  {formatDateTime(status.lastPokeReceivedAt)}
                </span>
              )
            },
            {
              label: "Last applied sequence (from this outpost)",
              value: status.lastAppliedSequence ?? "none"
            }
          ]}
        />
        <div className="mt-6">
          <SectionLabel>Recent transfers (last 5 recorded here)</SectionLabel>
          <div className="mt-2">
            {/* `?? []` — the SAME guard `outposts.tsx` carries at the identical call, for the same
                measured reason. `recentTransfers` is required-not-optional by the schema and,
                BEFORE ADR-0023, the SDK validated no response, so a server that omitted the key
                made `transfers.length` throw a TypeError. Here that was strictly worse than on the
                overview: this card is the FIRST child of the per-outpost page, so the throw
                white-screened Status AND Settings AND Configuration together. SINCE ADR-0023 the
                SDK rejects that body and the page's `isError` branch names the operation and the
                field. The guard stays as the truthful reading of an empty ledger ("none recorded
                here") — "this side has no transfer rows to show". */}
            <RecentTransfersCell transfers={status.recentTransfers ?? []} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function OutpostDetailPage(): React.JSX.Element {
  const peerDomainId = usePeerDomainIdParam();

  const statusQuery = useQuery({
    queryKey: federationStatusKey(),
    queryFn: () => client.federation.status()
  });

  const status = findPeerStatus(statusQuery.data?.peers, peerDomainId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backTo="/federation/outposts"
        backLabel="Outposts"
        title={
          <span data-testid="outpost-detail-name">{status?.peer.name ?? peerDomainId}</span>
        }
        description={<span className="font-mono text-xs break-all">{peerDomainId}</span>}
      />

      {statusQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {/* ADR-0023: `isError` is reachable for a 200 whose body fails contract validation, and this
          page renders nothing at all for that state without this branch — the peer name above
          silently falls back to the raw id and every card below is absent, which reads exactly
          like "this peer is not paired". */}
      {statusQuery.isError && (
        <QueryErrorNotice
          error={statusQuery.error}
          what="federation status"
          testId="outpost-detail-error"
        />
      )}
      {statusQuery.data && !status && (
        <p className="text-sm text-slate-500" data-testid="outpost-not-paired">
          No peer with this trust-domain id is paired on this instance.
        </p>
      )}
      {status && <OutpostStatusCard status={status} />}
      {status && <PeerSettingsSection peer={status.peer} />}
      {status && <OutpostConfigurationSection status={status} />}
    </div>
  );
}
