import type { ServiceBoardAsOf } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import type { FederationPeerRow } from "./peers-repo.js";
import { lastConfirmedSyncImportAt, type BundleTransport } from "./bundle-transfers-repo.js";
import {
  effectivePullIntervalSeconds,
  federationClientCertsUsable,
  frequentIntervalSeconds,
  resolveSparseIntervalSeconds,
  type PeerCadenceInputs
} from "./federation-sync.js";

/** Upstream freshness: the as-of label the design requires. See docs/federation.md §567. */

/** How the freshest state got here. Derived, not stored — see {@link upstreamFreshness}. */
export type UpstreamArrival = ServiceBoardAsOf["via"];

/** How much later than its cadence a peer may be. See docs/federation.md §568. */
export const FRESHNESS_GRACE_FACTOR = 2;

export interface UpstreamFreshnessInput {
  peer: Pick<
    FederationPeerRow,
    | "id"
    | "name"
    | "role"
    | "baseUrl"
    | "pairedAt"
    | "pokeMode"
    | "lastPokeReceivedAt"
    | "lastPullAttemptAt"
    | "lastPullSuccessAt"
  >;
  /** The newest confirmed inbound sync bundle from this peer, and how it travelled; null = none
   *  ever. `transport: null` is a pre-drizzle/0041 row whose transport was never recorded. */
  lastConfirmedImport: { at: Date; transport: BundleTransport | null } | null;
  now: Date;
  cadence: PeerCadenceInputs;
}

/** Pure: one peer's freshness reading, kept database-free. See docs/federation.md §569. */
export function upstreamFreshness(input: UpstreamFreshnessInput): ServiceBoardAsOf {
  const { peer, lastConfirmedImport, now, cadence } = input;
  const at = lastConfirmedImport?.at ?? null;

  const via: UpstreamArrival =
    lastConfirmedImport === null ? "never" : (lastConfirmedImport.transport ?? "unknown");

  const anchorMs = at !== null ? at.getTime() : Date.parse(peer.pairedAt);
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - anchorMs) / 1000));

  // The peers this instance actually SCHEDULES pulls for — `federationSyncOrgTick`'s own filter.
  // Anything else (an air-gapped peer with no baseUrl, or an outpost seen from the commander) has no
  // cadence to be late against.
  const scheduled = peer.role === "commander" && peer.baseUrl !== null;
  const expectedWithinSeconds = scheduled ? effectivePullIntervalSeconds(peer, cadence) : null;
  // THE ACTUAL THRESHOLD, computed once here and put on the wire. `expectedWithinSeconds` is the
  // cadence, not the bound — a client that renders the cadence as the bound tells the operator that
  // 90-second-old data is "within a 60s cadence". The grace factor lives in exactly one place.
  const staleAfterSeconds =
    expectedWithinSeconds === null ? null : expectedWithinSeconds * FRESHNESS_GRACE_FACTOR;

  const stale =
    staleAfterSeconds === null ? null : at === null ? true : ageSeconds > staleAfterSeconds;

  return {
    peerDomainId: peer.id,
    peerName: peer.name,
    at: at?.toISOString() ?? null,
    via,
    ageSeconds,
    expectedWithinSeconds,
    staleAfterSeconds,
    stale
  };
}

/** The cadence inputs a read projection needs, resolved once. See docs/federation.md §570. */
export function resolveCadenceInputs(env: NodeJS.ProcessEnv = process.env): PeerCadenceInputs {
  return {
    frequent: frequentIntervalSeconds(env),
    sparse: resolveSparseIntervalSeconds(env),
    hasClientCerts: federationClientCertsUsable()
  };
}

/** THE UPSTREAM BOUND for a read projection over `peers`. See docs/federation.md §571. */
export interface UpstreamBound {
  /** The oldest reading — the "as of" label. `null` only when `peers` was empty. */
  label: ServiceBoardAsOf | null;
  /** True when ANY peer read `stale: true`, whether or not it is the peer behind `label`. */
  anyStale: boolean;
}

export async function limitingUpstreamFreshness(
  tx: TenantTx,
  orgId: string,
  peers: FederationPeerRow[],
  now: Date = new Date(),
  cadence: PeerCadenceInputs = resolveCadenceInputs()
): Promise<UpstreamBound> {
  if (peers.length === 0) return { label: null, anyStale: false };
  const readings = await Promise.all(
    peers.map(async (peer) =>
      upstreamFreshness({
        peer,
        lastConfirmedImport: await lastConfirmedSyncImportAt(tx, orgId, peer.id),
        now,
        cadence
      })
    )
  );
  return summarizeReadings(readings);
}

/** PURE — {@link limitingUpstreamFreshness}'s two selection rules, split out so both are unit-
 *  testable without two databases (this is where BOTH bugs lived). Assumes a non-empty input; the
 *  caller has already handled the single-domain case. */
export function summarizeReadings(
  readings: ServiceBoardAsOf[]
): { label: ServiceBoardAsOf } & UpstreamBound {
  return { label: oldestReading(readings), anyStale: readings.some((r) => r.stale === true) };
}

/** PURE — the LABEL rule alone: greatest `ageSeconds` wins; `stale === true` breaks an exact tie,
 *  which is the honest direction. */
export function oldestReading(readings: ServiceBoardAsOf[]): ServiceBoardAsOf {
  return readings.reduce((oldest, candidate) => {
    if (candidate.ageSeconds !== oldest.ageSeconds) {
      return candidate.ageSeconds > oldest.ageSeconds ? candidate : oldest;
    }
    return candidate.stale === true && oldest.stale !== true ? candidate : oldest;
  });
}
