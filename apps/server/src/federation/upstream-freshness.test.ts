import { describe, expect, it } from "vitest";
import { upstreamFreshness } from "./upstream-freshness.js";
import type { FederationPeerRow } from "./peers-repo.js";
import type { TrustDomainId } from "@scp/schemas";

/**
 * UNIT coverage (no database) for the "as of &lt;bundle/date&gt;" reading DESIGN.md §13 requires —
 * the same shape `federation-sync-cadence.test.ts` gives `peerSyncCadence`/`isPeerDue`, and for the
 * same reason: the truth table is where the dishonesty would hide, and it must be checkable without
 * standing up two domains.
 *
 * The three properties that matter, and each has a case below:
 *
 *  1. THE ANCHOR IS TRANSPORT-AGNOSTIC. A bundle that arrived by file/inbox reads as `via: "bundle"`
 *     and still carries a real timestamp — the air-gapped case, where the live-pull columns are NULL
 *     forever and a pull-derived label would say "never synced" on an instance syncing weekly.
 *  2. THE THRESHOLD IS THE PEER'S OWN CADENCE. A peer proven onto the sparse poke cadence is NOT
 *     late for being exactly as sparse as it was configured to be — the same age is stale on the
 *     frequent cadence and fresh on the sparse one.
 *  3. NO CADENCE ⇒ `stale: null`, NEVER `false`. This instance dials only `role: "commander"` peers
 *     with a `baseUrl`. For anything else there is no schedule for the data to be late against, and
 *     `false` would assert a freshness nobody measured.
 */

const NOW = new Date("2026-07-25T12:00:00.000Z");
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();
const agoDate = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

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
      lastConfirmedImportAt: agoDate(10),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.via).toBe("live-pull");
    expect(reading.ageSeconds).toBe(10);
    expect(reading.expectedWithinSeconds).toBe(60);
    expect(reading.stale).toBe(false);
  });

  it("past the peer's own cadence it is STALE", () => {
    const reading = upstreamFreshness({
      peer: peer({ lastPullAttemptAt: ago(61), lastPullSuccessAt: ago(61) }),
      lastConfirmedImportAt: agoDate(61),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.stale).toBe(true);
    expect(reading.ageSeconds).toBe(61);
  });

  it("a DELIBERATELY SPARSE peer is not late for being sparse — the threshold is its own cadence", () => {
    // Same age (5 minutes) that is stale on the frequent cadence above...
    const sparsePeer = peer({
      pokeMode: true,
      lastPokeReceivedAt: ago(120),
      lastPullAttemptAt: ago(300),
      lastPullSuccessAt: ago(300)
    });
    const sparse = upstreamFreshness({
      peer: sparsePeer,
      lastConfirmedImportAt: agoDate(300),
      now: NOW,
      cadence: CADENCE
    });
    expect(sparse.expectedWithinSeconds).toBe(900);
    expect(sparse.stale).toBe(false);

    // ...is stale for a peer on the frequent poll, at the identical age. Nothing about the DATA
    // changed; only the cadence the scheduler would actually use for that peer.
    const frequent = upstreamFreshness({
      peer: peer({ lastPullAttemptAt: ago(300), lastPullSuccessAt: ago(300) }),
      lastConfirmedImportAt: agoDate(300),
      now: NOW,
      cadence: CADENCE
    });
    expect(frequent.expectedWithinSeconds).toBe(60);
    expect(frequent.stale).toBe(true);
  });

  it("an AIR-GAPPED peer: a real timestamp, `via: bundle`, and `stale: null` — never `false`", () => {
    const reading = upstreamFreshness({
      // No baseUrl: nothing here ever dials it, so the pull columns stay NULL forever.
      peer: peer({ baseUrl: null, role: "outpost" }),
      lastConfirmedImportAt: agoDate(7 * 86_400),
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
      lastConfirmedImportAt: agoDate(10),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.via).toBe("bundle");
    expect(reading.stale).toBe(false);
  });

  it("NOTHING EVER ARRIVED: age is measured from pairing, so a scheduled peer reads stale", () => {
    const reading = upstreamFreshness({
      peer: peer({ pairedAt: ago(3600) }),
      lastConfirmedImportAt: null,
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

  it("an outpost seen from the COMMANDER has no cadence — §13 is outpost-initiated-only", () => {
    const reading = upstreamFreshness({
      peer: peer({ role: "outpost", baseUrl: "https://outpost.example" }),
      lastConfirmedImportAt: agoDate(99_999),
      now: NOW,
      cadence: CADENCE
    });
    expect(reading.expectedWithinSeconds).toBeNull();
    expect(reading.stale).toBeNull();
  });
});
