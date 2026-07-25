import type { ServiceBoardAsOf } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import type { FederationPeerRow } from "./peers-repo.js";
import { lastConfirmedSyncImportAt } from "./bundle-transfers-repo.js";
import {
  effectivePullIntervalSeconds,
  federationClientCertsUsable,
  frequentIntervalSeconds,
  resolveSparseIntervalSeconds,
  type PeerCadenceInputs
} from "./federation-sync.js";

/**
 * UPSTREAM FRESHNESS — the "as of &lt;bundle/date&gt;" label DESIGN.md §13 requires, computed for a
 * read projection that renders another domain's data.
 *
 * §13, verbatim: *"the commander UI labels air-gapped domains \"as of &lt;bundle/date&gt;\" and never
 * presents stale data as live status"*, and *"for air-gapped outposts it is explicitly last-known-as-of
 * the latest returned bundle"*. `GET /federation/status` already honors this (`lastSyncedAt`, rendered
 * as `asOf` by the CLI and the federation-status route). The SERVICE BOARD did not: it renders rows
 * whose change objects arrived over the journal and said nothing about when. The ban — "never presents
 * stale data as live status" — is stated as a general prohibition, so it applies in the other direction
 * too: an OUTPOST rendering a board over commander-driven changes has the identical property.
 *
 * THE ANCHOR IS `bundle_transfers`, NOT `federation_peers.lastPullSuccessAt`. See
 * {@link lastConfirmedSyncImportAt}: the pull columns are stamped only by the live-pull scheduler,
 * which iterates `role === "commander" && baseUrl`, so on an air-gapped instance they are NULL
 * forever and a label derived from them would read "never synced" on an instance that imports bundles
 * weekly. Every import path — live pull, `POST /v1/federation/imports`, the unattended inbox loop —
 * records a confirmed import transfer.
 *
 * THE STALENESS THRESHOLD IS THE PEER'S OWN EFFECTIVE CADENCE, not a constant. `effectivePullIntervalSeconds`
 * is the interval the scheduler would actually use for this peer right now: the frequent poll
 * (`SCP_FEDERATION_SYNC_INTERVAL_SECONDS`, default 60s) or, for a peer genuinely on the proven sparse
 * poke cadence, the sparse safety net (`SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS`, default 900s).
 * Using the peer's own number is what keeps a deliberately-sparse peer from being reported as late for
 * being exactly as sparse as it was configured to be.
 *
 * WHERE THERE IS NO CADENCE, `stale` IS `null` — NOT `false`. This instance only ever dials peers with
 * `role === "commander"` and a `baseUrl` (§13 outpost-initiated-only). For an air-gapped peer, or for a
 * commander looking DOWN at an outpost, no schedule exists that the data could be late against, and
 * claiming `stale: false` would assert a freshness nobody measured — the same fabrication the board's
 * `unknownFields` exists to prevent. `null` means "no cadence applies; read `at` and `via`", which is
 * precisely §13's bounded air-gap contract: a label, never a live-status claim.
 */

/** How the freshest state got here. Derived, not stored — see {@link upstreamFreshness}. */
export type UpstreamArrival = ServiceBoardAsOf["via"];

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
  /** The `confirmedAt` of the newest confirmed inbound sync bundle from this peer; null = none ever. */
  lastConfirmedImportAt: Date | null;
  now: Date;
  cadence: PeerCadenceInputs;
}

/**
 * PURE. One peer's freshness reading. Kept DB-free so the truth table is unit-testable, mirroring
 * `federation-sync.ts`'s own `peerSyncCadence` / `isPeerDue`.
 *
 * `ageSeconds` falls back to `pairedAt` when nothing has ever arrived: a peer paired an hour ago on a
 * 60-second cadence with no confirmed import is genuinely overdue, and measuring from "never" as if it
 * were age zero would hide exactly the misconfiguration this is for.
 *
 * `via` distinguishes live-pull from bundle delivery by the one fact that separates them: the pull
 * scheduler stamps `lastPullSuccessAt` AFTER the import transaction that wrote the transfer row, so a
 * pull-delivered bundle always has `lastPullSuccessAt >= at`. A file- or inbox-delivered bundle leaves
 * that column untouched (null, or older than `at` from some earlier pull).
 */
export function upstreamFreshness(input: UpstreamFreshnessInput): ServiceBoardAsOf {
  const { peer, lastConfirmedImportAt, now, cadence } = input;
  const at = lastConfirmedImportAt;
  const pullSuccessMs = peer.lastPullSuccessAt ? Date.parse(peer.lastPullSuccessAt) : null;

  const via: UpstreamArrival =
    at === null
      ? "never"
      : pullSuccessMs !== null && pullSuccessMs >= at.getTime()
        ? "live-pull"
        : "bundle";

  const anchorMs = at !== null ? at.getTime() : Date.parse(peer.pairedAt);
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - anchorMs) / 1000));

  // The peers this instance actually SCHEDULES pulls for — `federationSyncOrgTick`'s own filter.
  // Anything else (an air-gapped peer with no baseUrl, or an outpost seen from the commander) has no
  // cadence to be late against.
  const scheduled = peer.role === "commander" && peer.baseUrl !== null;
  const expectedWithinSeconds = scheduled ? effectivePullIntervalSeconds(peer, cadence) : null;

  return {
    peerDomainId: peer.id,
    peerName: peer.name,
    at: at?.toISOString() ?? null,
    via,
    ageSeconds,
    expectedWithinSeconds,
    stale: expectedWithinSeconds === null ? null : ageSeconds > expectedWithinSeconds
  };
}

/** The cadence inputs a read projection needs, resolved once per request from live env + the runtime
 *  cert probe. `federationClientCertsUsable` is the scheduler's OWN never-throwing probe (it answers
 *  "did the material actually READ?", not "are the paths set?") — the same call
 *  `federation/status-repo.ts` already makes per request, for the same reason: a cadence report must
 *  not be the thing that hides a cadence divergence. */
export function resolveCadenceInputs(env: NodeJS.ProcessEnv = process.env): PeerCadenceInputs {
  return {
    frequent: frequentIntervalSeconds(env),
    sparse: resolveSparseIntervalSeconds(env),
    hasClientCerts: federationClientCertsUsable()
  };
}

/**
 * THE LIMITING UPSTREAM for a read projection over `peers` — the one whose staleness bounds what the
 * projection can claim, i.e. the OLDEST reading among them. `null` when `peers` is empty: a
 * single-domain org's projection is a complete local observation and must not claim an ignorance it
 * does not have.
 *
 * A stale peer wins over a fresh one at equal age (the honest direction), and otherwise the greatest
 * `ageSeconds` wins. Callers pass only the peers whose scope can actually carry the data being
 * rendered — a peer that structurally cannot send change objects does not bound the freshness of
 * change objects; it is covered by the blindness caveat instead.
 */
export async function limitingUpstreamFreshness(
  tx: TenantTx,
  orgId: string,
  peers: FederationPeerRow[],
  now: Date = new Date(),
  cadence: PeerCadenceInputs = resolveCadenceInputs()
): Promise<ServiceBoardAsOf | null> {
  if (peers.length === 0) return null;
  const readings = await Promise.all(
    peers.map(async (peer) =>
      upstreamFreshness({
        peer,
        lastConfirmedImportAt: await lastConfirmedSyncImportAt(tx, orgId, peer.id),
        now,
        cadence
      })
    )
  );
  return readings.reduce((worst, candidate) => {
    if (candidate.stale === true && worst.stale !== true) return candidate;
    if (worst.stale === true && candidate.stale !== true) return worst;
    return candidate.ageSeconds > worst.ageSeconds ? candidate : worst;
  });
}
