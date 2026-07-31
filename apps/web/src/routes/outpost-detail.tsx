import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { FederationPeerStatus } from "@scp/schemas";
import { client } from "../lib/client";
import { federationStatusKey } from "../lib/query-client";
import { usePeerDomainIdParam } from "../lib/use-route-params";
import { QueryErrorNotice } from "../components/query-error";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import {
  InboundSyncCell,
  PendingExportCell,
  SourcelessCell,
  TransportCell,
  TrustTierCell,
  RecentTransfersCell,
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

function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-1 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

/** The read-only status panel — every field rendered by the SAME cells the overview uses, so the two
 *  surfaces cannot drift into disagreeing about what is observable. */
export function OutpostStatusCard({ status }: { status: FederationPeerStatus }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Status</CardTitle>
        <CardDescription>
          This side&apos;s own record: what arrived here from this outpost, and what this side put
          on the wire for it. Nothing below observes what the outpost received or applied.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <Field label="Role">{roleBadge(status.peer.role)}</Field>
          <Field label="Trust tier">
            <TrustTierCell status={status} />
          </Field>
          <Field label="Transport">
            <TransportCell status={status} />
          </Field>
          <Field label="Effective sync cadence">
            <span data-testid="outpost-effective-cadence">
              {status.effectiveCadence ?? "unreported"}
            </span>
          </Field>
          <Field label="Last sync in (from this outpost)">
            <InboundSyncCell status={status} />
          </Field>
          <Field label="Exported by this side">
            <PendingExportCell status={status} />
          </Field>
          <Field label="Applied at outpost">
            <SourcelessCell
              status={status}
              field="appliedAtPeer"
              title={
                "This instance cannot observe what the outpost applied: it records only what it exported. " +
                "A return-path confirmation is a named future increment (M16.4), not a field that exists today."
              }
            />
          </Field>
          <Field label="Health rollup">
            <SourcelessCell
              status={status}
              field="healthRollup"
              title="No per-outpost health signal is replicated to this instance, so there is no rollup to show."
            />
          </Field>
          <Field label="Last poke received">
            <span data-testid="outpost-last-poke">{formatDateTime(status.lastPokeReceivedAt)}</span>
          </Field>
          <Field label="Last applied sequence (from this outpost)">
            {status.lastAppliedSequence ?? "none"}
          </Field>
        </dl>
        <div className="mt-6">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Recent transfers (last 5 recorded here)
          </div>
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
      <div>
        <Link to="/federation/outposts" className="text-sm text-slate-500 hover:underline">
          ← Outposts
        </Link>
        <h1
          className="mt-1 text-2xl font-semibold text-slate-900"
          data-testid="outpost-detail-name"
        >
          {status?.peer.name ?? peerDomainId}
        </h1>
        <p className="font-mono text-xs text-slate-500">{peerDomainId}</p>
      </div>

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
