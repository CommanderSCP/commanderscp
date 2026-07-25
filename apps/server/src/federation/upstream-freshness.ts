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
 * being exactly as sparse as it was configured to be — and {@link FRESHNESS_GRACE_FACTOR} is what
 * keeps it from shouting once per cycle for being normally late.
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

/**
 * HOW MUCH LATER THAN ITS OWN CADENCE a peer may be before the label calls it stale.
 *
 * The threshold cannot be the cadence verbatim. `ageSeconds` is measured from the moment the LAST
 * import CONFIRMED, and the next one cannot land sooner than a full interval later: the due-gate
 * (`claimPeerPull`) only admits a peer once `lastPullAttemptAt <= now - interval`, and on top of
 * that sits the sweep's own tick granularity plus however long the dial + verify + apply takes. So a
 * perfectly healthy peer's age passes `interval` on EVERY cycle, by construction — with the cadence
 * used verbatim, a working 60s peer reads `stale` for part of every single minute. A label that
 * shouts on healthy operation trains its reader to ignore it, which costs exactly the incident it
 * exists to catch.
 *
 * 2 is chosen because it is the smallest factor with a MEANING rather than a feel: at `> 2 ×
 * interval`, at least one whole cadence window has come and gone producing nothing, so `stale: true`
 * says "a cycle was missed" instead of "we are mid-cycle". A tighter factor (1.5) would still fire
 * on a slow import; a looser one would hide a genuinely missed cycle.
 */
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

/**
 * PURE. One peer's freshness reading. Kept DB-free so the truth table is unit-testable, mirroring
 * `federation-sync.ts`'s own `peerSyncCadence` / `isPeerDue`.
 *
 * `ageSeconds` falls back to `pairedAt` when nothing has ever arrived: a peer paired an hour ago on a
 * 60-second cadence with no confirmed import is genuinely overdue, and measuring from "never" as if it
 * were age zero would hide exactly the misconfiguration this is for.
 *
 * `via` IS READ FROM THE TRANSFER ROW (`transport`, drizzle/0041), not inferred. The inference it
 * replaces — `lastPullSuccessAt >= at` — rested on the claim that the scheduler stamps the success
 * column after the import transaction. It does not: `federationSyncOrgTick` captures `now` once at
 * TICK START and hands that same value to `markPeerPullSuccess`, so a live pull's success stamp is
 * always EARLIER than the `confirmed_at` its own import wrote. The predicate was false for every real
 * live pull, and reported all of them as bundle imports — precisely backwards, and worse than saying
 * nothing, because "as of 3 days ago via bundle" (a healthy air-gapped domain) and "as of 3 days ago
 * via a wedged poller" (an incident) are different operator situations. A row written before 0041
 * reports `"unknown"`; it is never guessed.
 *
 * `stale` IS NEVER `false` WHEN NOTHING HAS EVER ARRIVED. A peer inside its first cadence window with
 * no confirmed import used to read `stale: false` — an assertion of freshness about data that does
 * not exist. Freshness is a claim about DELIVERED data; with none delivered there is nothing fresh to
 * report, so a scheduled peer reads `true` (and `via: "never"`, `at: null` say exactly why) until its
 * first import lands.
 */
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

  const stale =
    expectedWithinSeconds === null
      ? null
      : at === null
        ? true
        : ageSeconds > expectedWithinSeconds * FRESHNESS_GRACE_FACTOR;

  return {
    peerDomainId: peer.id,
    peerName: peer.name,
    at: at?.toISOString() ?? null,
    via,
    ageSeconds,
    expectedWithinSeconds,
    stale
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
 * THE BOUND IS AGE, FULL STOP. An earlier pass let `stale === true` win unconditionally, which meant
 * a barely-late CONNECTED peer (61s past a 60s cadence) MASKED a genuinely ancient air-gapped one
 * (three weeks, `stale: null` because no cadence applies to it) — and the label then under-reported
 * the board's own freshness bound by orders of magnitude, while its docstring promised the oldest.
 * `stale` is a per-peer verdict against that peer's own schedule; it is not a comparator between
 * peers, and using it as one inverts the very ordering this function exists to compute. Greatest
 * `ageSeconds` wins; `stale === true` breaks an exact tie, which is the honest direction.
 *
 * Callers pass only the peers whose scope can actually carry the data being rendered — a peer that
 * structurally cannot send change objects does not bound the freshness of change objects; it is
 * covered by the blindness caveat instead.
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
        lastConfirmedImport: await lastConfirmedSyncImportAt(tx, orgId, peer.id),
        now,
        cadence
      })
    )
  );
  return oldestReading(readings);
}

/** PURE — {@link limitingUpstreamFreshness}'s selection rule, split out so the ordering itself is
 *  unit-testable without two databases (it is where the masking bug lived). Assumes a non-empty
 *  input; the caller has already handled the single-domain case. */
export function oldestReading(readings: ServiceBoardAsOf[]): ServiceBoardAsOf {
  return readings.reduce((oldest, candidate) => {
    if (candidate.ageSeconds !== oldest.ageSeconds) {
      return candidate.ageSeconds > oldest.ageSeconds ? candidate : oldest;
    }
    return candidate.stale === true && oldest.stale !== true ? candidate : oldest;
  });
}
