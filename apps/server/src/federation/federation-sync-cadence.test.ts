import { describe, it, expect } from "vitest";
import type PgBoss from "pg-boss";
import type { FederationPeerRow } from "./peers-repo.js";
import {
  FEDERATION_SYNC_QUEUE,
  FEDERATION_SYNC_SPARSE_INTERVAL_DEFAULT_SECONDS,
  FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS,
  effectivePullIntervalSeconds,
  frequentIntervalSeconds,
  isPeerDue,
  peerSyncCadence,
  resolveSparseIntervalSeconds,
  wakeFederationSyncNow
} from "./federation-sync.js";

/**
 * M14.4 (ADR-0009; owner decisions D1–D4, 2026-07-24) — UNIT coverage, no database, for the
 * scheduler mode's two PURE pieces: the sparse-interval knob and the per-peer due-gate truth table.
 * The DB-backed behavior (the atomic claim, the reconnect leg end to end, the forced poke tick) is
 * in `federation-sync.integration.test.ts`; this file pins the decision logic itself so a regression
 * shows up as a failing truth-table row rather than a subtly denser poll in production.
 */

const FREQUENT = 60;
const SPARSE = 900;
const T0 = new Date("2026-07-24T12:00:00.000Z");

function at(offsetSeconds: number): Date {
  return new Date(T0.getTime() + offsetSeconds * 1000);
}

function peer(overrides: Partial<FederationPeerRow> = {}): FederationPeerRow {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    orgId: "org-1",
    name: "the-commander",
    role: "commander",
    baseUrl: "https://commander.example:8443",
    syncScope: { mode: "full" },
    deliveryTarget: null,
    cosignPublicKey: null,
    pokeMode: false,
    lastPullAttemptAt: null,
    lastPullSuccessAt: null,
    lastPokeReceivedAt: null,
    pairedAt: T0.toISOString(),
    publicKey: "pk",
    ...overrides
  };
}

/** A peer whose last pull SUCCEEDED `secondsAgo` ago (attempt and success at the same instant). */
function pulledOk(secondsAgo: number, overrides: Partial<FederationPeerRow> = {}) {
  const when = at(-secondsAgo).toISOString();
  return peer({ lastPullAttemptAt: when, lastPullSuccessAt: when, ...overrides });
}

const inputs = { frequent: FREQUENT, sparse: SPARSE, hasClientCerts: true };

describe("M14.4 resolveSparseIntervalSeconds — the D1 knob (env-resolved, clamped)", () => {
  it("unset -> the 900s (15 min) default", () => {
    expect(resolveSparseIntervalSeconds({})).toBe(FEDERATION_SYNC_SPARSE_INTERVAL_DEFAULT_SECONDS);
    expect(resolveSparseIntervalSeconds({})).toBe(900);
  });

  it("a value BELOW the frequent interval is raised to it (sparse is never denser than frequent)", () => {
    const env = {
      SCP_FEDERATION_SYNC_INTERVAL_SECONDS: "120",
      SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS: "30"
    };
    expect(frequentIntervalSeconds(env)).toBe(120);
    expect(resolveSparseIntervalSeconds(env)).toBe(120);
  });

  it("a value above 43200 is CAPPED (pg-boss asserts singletonSeconds <= archiveSeconds = 12h)", () => {
    expect(resolveSparseIntervalSeconds({ SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS: "86400" })).toBe(
      FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS
    );
    expect(FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS).toBe(43_200);
  });

  it("an in-range value is used verbatim; junk falls back to the default", () => {
    expect(resolveSparseIntervalSeconds({ SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS: "1800" })).toBe(
      1800
    );
    expect(resolveSparseIntervalSeconds({ SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS: "nope" })).toBe(
      900
    );
  });

  it("is resolved from the PASSED env every call — not frozen at import (a later env change is seen)", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveSparseIntervalSeconds(env)).toBe(900);
    env.SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS = "1200";
    expect(resolveSparseIntervalSeconds(env)).toBe(1200);
  });
});

describe("M14.4 isPeerDue — the due-gate truth table", () => {
  it("NEVER ATTEMPTED (null) is always due — pull-on-startup and every pre-0038 row survive the gate", () => {
    expect(isPeerDue(peer(), T0, inputs)).toBe(true);
    expect(isPeerDue(peer({ pokeMode: true, lastPokeReceivedAt: T0.toISOString() }), T0, inputs)).toBe(
      true
    );
  });

  it("POLL-MODE: due once per FREQUENT interval, not before", () => {
    expect(isPeerDue(pulledOk(30), T0, inputs)).toBe(false);
    expect(isPeerDue(pulledOk(FREQUENT), T0, inputs)).toBe(true);
    expect(isPeerDue(pulledOk(FREQUENT + 1), T0, inputs)).toBe(true);
  });

  it("POKE-MODE (proven): the frequent leg is DISABLED — due only once per SPARSE interval", () => {
    const proven = { pokeMode: true, lastPokeReceivedAt: at(-30).toISOString() };
    expect(peerSyncCadence(pulledOk(120, proven), inputs)).toBe("poke");
    expect(effectivePullIntervalSeconds(pulledOk(120, proven), inputs)).toBe(SPARSE);
    // Well past the frequent window, nowhere near the sparse one.
    expect(isPeerDue(pulledOk(120, proven), T0, inputs)).toBe(false);
    expect(isPeerDue(pulledOk(899, proven), T0, inputs)).toBe(false);
    // The sparse safety-net still fires — a dropped poke self-heals within a bounded window.
    expect(isPeerDue(pulledOk(SPARSE, proven), T0, inputs)).toBe(true);
  });

  it("D2 SELF-PROVING: pokeMode with NO poke ever received stays on the FREQUENT cadence", () => {
    const neverPoked = { pokeMode: true, lastPokeReceivedAt: null };
    expect(peerSyncCadence(pulledOk(120, neverPoked), inputs)).toBe("poll");
    expect(effectivePullIntervalSeconds(pulledOk(120, neverPoked), inputs)).toBe(FREQUENT);
    expect(isPeerDue(pulledOk(120, neverPoked), T0, inputs)).toBe(true);
    // …and once a poke HAS arrived, the same peer goes sparse.
    const nowPoked = { pokeMode: true, lastPokeReceivedAt: at(-10).toISOString() };
    expect(isPeerDue(pulledOk(120, nowPoked), T0, inputs)).toBe(false);
  });

  it("D4 NO CLIENT CERTS: a proven poke-mode peer falls back to the FREQUENT cadence", () => {
    const proven = { pokeMode: true, lastPokeReceivedAt: at(-30).toISOString() };
    const noCerts = { ...inputs, hasClientCerts: false };
    expect(peerSyncCadence(pulledOk(120, proven), noCerts)).toBe("poll");
    expect(isPeerDue(pulledOk(120, proven), T0, noCerts)).toBe(true);
  });

  it("RECONNECT LEG: a poke-mode peer whose LAST ATTEMPT FAILED polls frequently until one succeeds", () => {
    const proven = { pokeMode: true, lastPokeReceivedAt: at(-600).toISOString() };
    // Attempted 120s ago, last success is OLDER than that attempt => the attempt failed.
    const failing = peer({
      ...proven,
      lastPullAttemptAt: at(-120).toISOString(),
      lastPullSuccessAt: at(-500).toISOString()
    });
    expect(peerSyncCadence(failing, inputs)).toBe("poll");
    expect(isPeerDue(failing, T0, inputs)).toBe(true);

    // Never succeeded at all — same treatment.
    const neverSucceeded = peer({
      ...proven,
      lastPullAttemptAt: at(-120).toISOString(),
      lastPullSuccessAt: null
    });
    expect(peerSyncCadence(neverSucceeded, inputs)).toBe("poll");
    expect(isPeerDue(neverSucceeded, T0, inputs)).toBe(true);

    // One success re-arms sparse.
    expect(peerSyncCadence(pulledOk(120, proven), inputs)).toBe("poke");
    expect(isPeerDue(pulledOk(120, proven), T0, inputs)).toBe(false);
  });
});

describe("M14.4 wakeFederationSyncNow — the poke wake is DISTINGUISHABLE and org-scoped (S4)", () => {
  it("sends {reason:'poke', orgId} with NO singleton (a queued interval tick can never swallow it)", async () => {
    const sent: { queue: string; data: unknown; options: unknown }[] = [];
    const boss = {
      send: async (queue: string, data: unknown, options: unknown) => {
        sent.push({ queue, data, options });
        return "job-id";
      }
    } as unknown as PgBoss;

    await wakeFederationSyncNow(boss, "org-42");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.queue).toBe(FEDERATION_SYNC_QUEUE);
    expect(sent[0]!.data).toEqual({ reason: "poke", orgId: "org-42" });
    // No third argument at all -> no singletonKey (see the function's rationale comment).
    expect(sent[0]!.options).toBeUndefined();
  });

  it("omits orgId when the caller has none (an older/global wake forces every org)", async () => {
    const sent: unknown[] = [];
    const boss = {
      send: async (_queue: string, data: unknown) => {
        sent.push(data);
        return "job-id";
      }
    } as unknown as PgBoss;
    await wakeFederationSyncNow(boss);
    expect(sent[0]).toEqual({ reason: "poke" });
  });
});
