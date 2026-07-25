import { describe, expect, it } from "vitest";
import {
  FRESHNESS_GRACE_FACTOR,
  oldestReading,
  summarizeReadings,
  upstreamFreshness
} from "./upstream-freshness.js";
import type { FederationPeerRow } from "./peers-repo.js";
import type { ServiceBoardAsOf, TrustDomainId } from "@scp/schemas";

/**
 * UNIT coverage (no database) for the "as of &lt;bundle/date&gt;" reading DESIGN.md §13 requires —
 * the same shape `federation-sync-cadence.test.ts` gives `peerSyncCadence`/`isPeerDue`, and for the
 * same reason: the truth table is where the dishonesty would hide, and it must be checkable without
 * standing up two domains.
 *
 * The properties that matter, each with a case below:
 *
 *  1. THE ANCHOR IS TRANSPORT-AGNOSTIC. A bundle that arrived by file/inbox reads as `via: "bundle"`
 *     and still carries a real timestamp — the air-gapped case, where the live-pull columns are NULL
 *     forever and a pull-derived label would say "never synced" on an instance syncing weekly.
 *  2. THE TRANSPORT IS READ, NOT INFERRED. A live pull says `live-pull` even though the scheduler
 *     stamps `lastPullSuccessAt` BEFORE the import it triggers confirms.
 *  3. THE THRESHOLD IS THE PEER'S OWN CADENCE, PLUS GRACE. A peer proven onto the sparse poke cadence
 *     is NOT late for being exactly as sparse as configured; and no peer is late for the ordinary
 *     overshoot every healthy cycle produces.
 *  4. NO CADENCE ⇒ `stale: null`, NEVER `false`; NOTHING DELIVERED ⇒ `stale: true`, NEVER `false`.
 *  5. THE LIMITING PEER IS THE OLDEST. `stale` is a per-peer verdict, never a cross-peer comparator.
 *  6. ...AND THEREFORE STALENESS IS AN ANY-PEER PREDICATE, computed separately from the label —
 *     reading it off the label's own `stale` loses every overdue peer that is not also the oldest.
 *  7. THE THRESHOLD IS ON THE WIRE (`staleAfterSeconds`), so no client re-derives the grace factor
 *     or mistakes the cadence for the bound.
 */

const NOW = new Date("2026-07-25T12:00:00.000Z");
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();
const agoDate = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const arrived = (
  seconds: number,
  transport: "live-pull" | "bundle" | null
): { at: Date; transport: "live-pull" | "bundle" | null } => ({
  at: agoDate(seconds),
  transport
});

const CADENCE = { frequent: 60, sparse: 900, hasClientCerts: true };

function peer(overrides: Partial<FederationPeerRow> = {}): FederationPeerRow {
  return {
    id: "11111111-1111-1111-1111-111111111111" as TrustDomainId,
    orgId: "22222222-2222-2222-2222-222222222222",
    name: "commander-1",
    role: "commander",
    baseUrl: "https://commander.example",
    syncScope: { mode: "full" },
    deliveryTarget: null,
    pairedAt: ago(86_400),
    publicKey: "k",
    cosignPublicKey: null,
    pokeMode: false,
    lastPullAttemptAt: null,
    lastPullSuccessAt: null,
    lastPokeReceivedAt: null,
    ...overrides
  };
}

describe("upstreamFreshness — DESIGN §13 'as of' reading", () => {
  it("a live pull inside the frequent cadence is fresh, and says so was a pull", () => {
    const reading = upstreamFreshness({
      peer: peer({ lastPullAttemptAt: ago(10), lastPullSuccessAt: ago(10) }),
      lastConfirmedImport: arrived(10, "live-pull"),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.via).toBe("live-pull");
    expect(reading.ageSeconds).toBe(10);
    expect(reading.expectedWithinSeconds).toBe(60);
    expect(reading.stale).toBe(false);
  });

  it("REGRESSION: a live pull reads `live-pull` even though its success stamp PRECEDES the import", () => {
    // `federationSyncOrgTick` captures `now` ONCE at tick start and hands that same value to
    // `markPeerPullSuccess`, so `lastPullSuccessAt` is always EARLIER than the `confirmed_at` the
    // import it triggered wrote. The old attribution inferred the transport from
    // `lastPullSuccessAt >= at` and therefore reported EVERY real live pull as a bundle import —
    // exactly backwards. This pins the ordering that used to break it.
    const pullSuccessAt = ago(12);
    const confirmed = arrived(9, "live-pull");
    // The premise, stated: the success stamp is strictly EARLIER than the confirmation it produced.
    expect(Date.parse(pullSuccessAt)).toBeLessThan(confirmed.at.getTime());

    const reading = upstreamFreshness({
      peer: peer({ lastPullAttemptAt: ago(12), lastPullSuccessAt: pullSuccessAt }),
      lastConfirmedImport: confirmed,
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.via).toBe("live-pull");
  });

  it("a transfer written before the transport column reads `unknown` — never a guess", () => {
    const reading = upstreamFreshness({
      peer: peer({ lastPullAttemptAt: ago(10), lastPullSuccessAt: ago(10) }),
      lastConfirmedImport: arrived(10, null),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.via).toBe("unknown");
  });

  it("a DELIBERATELY SPARSE peer is not late for being sparse — the threshold is its own cadence", () => {
    // Same age (25 minutes) that is stale on the frequent cadence...
    const sparsePeer = peer({
      pokeMode: true,
      lastPokeReceivedAt: ago(120),
      lastPullAttemptAt: ago(1500),
      lastPullSuccessAt: ago(1500)
    });
    const sparse = upstreamFreshness({
      peer: sparsePeer,
      lastConfirmedImport: arrived(1500, "live-pull"),
      now: NOW,
      cadence: CADENCE
    });
    expect(sparse.expectedWithinSeconds).toBe(900);
    expect(sparse.stale).toBe(false);

    // ...is stale for a peer on the frequent poll, at the identical age. Nothing about the DATA
    // changed; only the cadence the scheduler would actually use for that peer.
    const frequent = upstreamFreshness({
      peer: peer({ lastPullAttemptAt: ago(1500), lastPullSuccessAt: ago(1500) }),
      lastConfirmedImport: arrived(1500, "live-pull"),
      now: NOW,
      cadence: CADENCE
    });
    expect(frequent.expectedWithinSeconds).toBe(60);
    expect(frequent.stale).toBe(true);
  });

  it("GRACE: the ordinary per-cycle overshoot is not staleness; a MISSED cycle is", () => {
    // The due-gate admits the next pull only once a full interval has passed since the last ATTEMPT,
    // and the anchor is stamped when the import CONFIRMS — so a perfectly healthy 60s peer crosses
    // 60s of age on every single cycle. With the cadence used verbatim the label shouted once a
    // minute, forever, on a working system.
    const healthy = upstreamFreshness({
      peer: peer({ lastPullAttemptAt: ago(75), lastPullSuccessAt: ago(75) }),
      lastConfirmedImport: arrived(75, "live-pull"),
      now: NOW,
      cadence: CADENCE
    });
    expect(healthy.expectedWithinSeconds).toBe(60);
    expect(healthy.stale).toBe(false);

    // Past 2x the interval, a whole cadence window has produced nothing — that IS late.
    const missed = upstreamFreshness({
      peer: peer({ lastPullAttemptAt: ago(121), lastPullSuccessAt: ago(121) }),
      lastConfirmedImport: arrived(121, "live-pull"),
      now: NOW,
      cadence: CADENCE
    });
    expect(missed.stale).toBe(true);

    // The boundary is exactly the documented factor, not a feel.
    const onTheLine = upstreamFreshness({
      peer: peer(),
      lastConfirmedImport: arrived(60 * FRESHNESS_GRACE_FACTOR, "live-pull"),
      now: NOW,
      cadence: CADENCE
    });
    expect(onTheLine.stale).toBe(false);
  });

  it("`staleAfterSeconds` IS the threshold, and it is not the cadence", () => {
    // The UI quotes this number. When it quoted `expectedWithinSeconds` instead, it told the
    // operator that 90-second-old data was "within" a 60-second cadence — checkably false.
    const reading = upstreamFreshness({
      peer: peer(),
      lastConfirmedImport: arrived(90, "live-pull"),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.expectedWithinSeconds).toBe(60);
    expect(reading.staleAfterSeconds).toBe(60 * FRESHNESS_GRACE_FACTOR);
    // The reading is genuinely NOT stale at an age well past the cadence — which is exactly why the
    // cadence cannot be presented as the bound.
    expect(reading.ageSeconds).toBeGreaterThan(reading.expectedWithinSeconds!);
    expect(reading.stale).toBe(false);
    // And the flip happens at the advertised number, never somewhere else.
    const justPast = upstreamFreshness({
      peer: peer(),
      lastConfirmedImport: arrived(reading.staleAfterSeconds! + 1, "live-pull"),
      now: NOW,
      cadence: CADENCE
    });
    expect(justPast.stale).toBe(true);
  });

  it("no cadence ⇒ no threshold either: `staleAfterSeconds` is null, not a fabricated number", () => {
    const reading = upstreamFreshness({
      peer: peer({ baseUrl: null, role: "outpost" }),
      lastConfirmedImport: arrived(7 * 86_400, "bundle"),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.expectedWithinSeconds).toBeNull();
    expect(reading.staleAfterSeconds).toBeNull();
    expect(reading.stale).toBeNull();
  });

  it("an AIR-GAPPED peer: a real timestamp, `via: bundle`, and `stale: null` — never `false`", () => {
    const reading = upstreamFreshness({
      // No baseUrl: nothing here ever dials it, so the pull columns stay NULL forever.
      peer: peer({ baseUrl: null, role: "outpost" }),
      lastConfirmedImport: arrived(7 * 86_400, "bundle"),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.via).toBe("bundle");
    expect(reading.at).toBe(agoDate(7 * 86_400).toISOString());
    expect(reading.expectedWithinSeconds).toBeNull();
    // The load-bearing one. A week-old air-gap bundle must not read as "fresh"; §13's contract is
    // the LABEL, not a live-status claim, and `null` is how that is said on the wire.
    expect(reading.stale).toBeNull();
  });

  it("a bundle that arrived by FILE on a connected peer still reads `bundle`, not `live-pull`", () => {
    const reading = upstreamFreshness({
      // A pull succeeded long ago; the newest thing that actually landed came in some other way.
      peer: peer({ lastPullAttemptAt: ago(5000), lastPullSuccessAt: ago(5000) }),
      lastConfirmedImport: arrived(10, "bundle"),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.via).toBe("bundle");
    expect(reading.stale).toBe(false);
  });

  it("NOTHING EVER ARRIVED: age is measured from pairing, so a scheduled peer reads stale", () => {
    const reading = upstreamFreshness({
      peer: peer({ pairedAt: ago(3600) }),
      lastConfirmedImport: null,
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.via).toBe("never");
    expect(reading.at).toBeNull();
    // Measuring from "never" as if it were age zero would hide exactly the misconfiguration this is
    // for: a peer paired an hour ago on a 60-second cadence with nothing to show for it.
    expect(reading.ageSeconds).toBe(3600);
    expect(reading.stale).toBe(true);
  });

  it("NOTHING EVER ARRIVED, still inside the first window: `stale` is TRUE, never `false`", () => {
    // Paired 10 seconds ago on a 60-second cadence — nothing is overdue yet by the clock, and the
    // old rule therefore asserted `stale: false`. But freshness is a claim about DELIVERED data and
    // none has been delivered; `false` here is an all-clear over an empty upstream.
    const reading = upstreamFreshness({
      peer: peer({ pairedAt: ago(10) }),
      lastConfirmedImport: null,
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.ageSeconds).toBe(10);
    expect(reading.via).toBe("never");
    expect(reading.stale).toBe(true);
  });

  it("an outpost seen from the COMMANDER has no cadence — §13 is outpost-initiated-only", () => {
    const reading = upstreamFreshness({
      peer: peer({ role: "outpost", baseUrl: "https://outpost.example" }),
      lastConfirmedImport: arrived(99_999, "bundle"),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.expectedWithinSeconds).toBeNull();
    expect(reading.stale).toBeNull();
  });
});

describe("oldestReading — the LIMITING upstream is the oldest, full stop", () => {
  const reading = (over: Partial<ServiceBoardAsOf>): ServiceBoardAsOf => ({
    peerDomainId: "p",
    peerName: "p",
    at: null,
    via: "bundle",
    ageSeconds: 0,
    expectedWithinSeconds: null,
    staleAfterSeconds: null,
    stale: null,
    ...over
  });

  it("REGRESSION: a barely-late CONNECTED peer does not mask an ancient AIR-GAPPED one", () => {
    const barelyLate = reading({
      peerName: "connected",
      ageSeconds: 130,
      expectedWithinSeconds: 60,
      stale: true
    });
    const ancient = reading({ peerName: "air-gapped", ageSeconds: 21 * 86_400, stale: null });
    // Letting `stale === true` win unconditionally reported "130 seconds" as the bound of a board
    // whose other upstream had not been heard from in three weeks — an under-report by four orders
    // of magnitude, and the exact opposite of the docstring's promise.
    expect(oldestReading([barelyLate, ancient]).peerName).toBe("air-gapped");
    expect(oldestReading([ancient, barelyLate]).peerName).toBe("air-gapped");
  });

  it("at EQUAL age, the stale verdict wins — the honest direction for a genuine tie", () => {
    const fresh = reading({ peerName: "fresh", ageSeconds: 300, stale: false });
    const late = reading({ peerName: "late", ageSeconds: 300, stale: true });
    expect(oldestReading([fresh, late]).peerName).toBe("late");
    expect(oldestReading([late, fresh]).peerName).toBe("late");
  });

  it("a single reading is its own bound", () => {
    const only = reading({ peerName: "solo", ageSeconds: 5 });
    expect(oldestReading([only])).toBe(only);
  });

  /**
   * THE SECOND HALF OF THE SAME MISTAKE. Fixing the label to be the oldest reading (above) then
   * broke the caveat that used to be read off it: the service board derived its staleness unknown
   * from `asOf.stale === true`, so a genuinely overdue peer that was NOT the oldest lost its caveat
   * entirely — and the masking peer is, typically, an air-gapped one whose `stale` is `null` because
   * no cadence applies to it. The label answers "how old is the oldest thing here"; the caveat
   * answers "is anything late". Different questions, answered separately.
   */
  it("REGRESSION: an overdue peer that is NOT the oldest still sets `anyStale`", () => {
    // Peer A — a commander on a 60s cadence whose last import confirmed an hour ago. Overdue.
    const overdueCommander = reading({
      peerName: "commander",
      ageSeconds: 3600,
      expectedWithinSeconds: 60,
      staleAfterSeconds: 120,
      stale: true
    });
    // Peer B — air-gapped, no baseUrl, 21 days old. OLDER, so it wins the label, but `stale` is
    // `null`: no schedule exists for it to be late against.
    const ancientAirGapped = reading({
      peerName: "air-gapped",
      ageSeconds: 21 * 86_400,
      stale: null
    });

    for (const order of [
      [overdueCommander, ancientAirGapped],
      [ancientAirGapped, overdueCommander]
    ]) {
      const summary = summarizeReadings(order);
      // The label is still the true oldest bound...
      expect(summary.label.peerName).toBe("air-gapped");
      // ...and the caveat still fires for the peer that is actually late.
      expect(summary.anyStale).toBe(true);
    }
  });

  it("no peer stale ⇒ no caveat, whichever reading wins the label", () => {
    const summary = summarizeReadings([
      reading({ peerName: "air-gapped", ageSeconds: 21 * 86_400, stale: null }),
      reading({ peerName: "commander", ageSeconds: 30, expectedWithinSeconds: 60, stale: false })
    ]);
    expect(summary.label.peerName).toBe("air-gapped");
    // `stale: null` is not staleness — asserting one from the mere absence of a schedule would
    // caveat every air-gapped deployment forever.
    expect(summary.anyStale).toBe(false);
  });
});
