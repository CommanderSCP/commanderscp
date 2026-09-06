import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it, expect, vi } from "vitest";
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.js";
import type { FederationPeerRow } from "./peers-repo.js";
import {
  FEDERATION_CERT_WARNING_REWARN_INTERVAL_MS,
  federationClientCertsUsable,
  resetFederationCertWarningDedupe,
  FEDERATION_SYNC_QUEUE,
  FEDERATION_SYNC_SPARSE_INTERVAL_DEFAULT_SECONDS,
  FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS,
  effectivePullIntervalSeconds,
  frequentIntervalSeconds,
  isPeerDue,
  peerSyncCadence,
  resolveSparseIntervalSeconds,
  startFederationSyncLoop,
  wakeFederationSyncNow,
  type FederationSyncJobData
} from "./federation-sync.js";
import { asTrustDomainId } from "@scp/schemas";

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
    id: asTrustDomainId("00000000-0000-0000-0000-0000000000aa"),
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
    expect(
      resolveSparseIntervalSeconds({ SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS: "86400" })
    ).toBe(FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS);
    expect(FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS).toBe(43_200);
  });

  it("an in-range value is used verbatim; junk falls back to the default", () => {
    expect(
      resolveSparseIntervalSeconds({ SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS: "1800" })
    ).toBe(1800);
    expect(
      resolveSparseIntervalSeconds({ SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS: "nope" })
    ).toBe(900);
  });

  it("is resolved from the PASSED env every call — not frozen at import (a later env change is seen)", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveSparseIntervalSeconds(env)).toBe(900);
    env.SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS = "1200";
    expect(resolveSparseIntervalSeconds(env)).toBe(1200);
  });
});

describe("M14.4 isPeerDue — the due-gate truth table", () => {
  // NOTE: this is NOT what makes pull-on-(re)connect work. `last_pull_attempt_at` SURVIVES a
  // restart, so a peer that has ever pulled comes back non-NULL; the startup tick FORCES instead
  // (see FEDERATION_SYNC_STARTUP_REASON). What NULL-is-due buys is drizzle/0038 needing no backfill.
  it("NEVER ATTEMPTED (null) is always due — every pre-0038 row survives the gate untouched", () => {
    expect(isPeerDue(peer(), T0, inputs)).toBe(true);
    expect(
      isPeerDue(peer({ pokeMode: true, lastPokeReceivedAt: T0.toISOString() }), T0, inputs)
    ).toBe(true);
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

    expect(peerSyncCadence(pulledOk(120, proven), inputs)).toBe("poke");
    expect(isPeerDue(pulledOk(120, proven), T0, inputs)).toBe(false);
  });
});

/**
 * M14.4 fix (N6) — the D4 cert warning is RATE-LIMITED, not once-per-process.
 *
 * The warning is the ONLY operator-visible signal that this instance is silently running every
 * poke-mode peer at the frequent cadence because its client-cert material stopped resolving. Deduped
 * with no time window, a worker that emitted its single line at boot leaves someone debugging the
 * divergence six hours later with nothing in the log window they are looking at. It must recur — just
 * not once a minute per org.
 */
describe("M14.4 D4 cert probe — never throws, warns, and RE-WARNS on an interval", () => {
  const MISSING = {
    SCP_FEDERATION_MTLS_CERT_FILE: path.join(tmpdir(), "scp-cadence-nope.crt"),
    SCP_FEDERATION_MTLS_KEY_FILE: path.join(tmpdir(), "scp-cadence-nope.key")
  };

  afterEach(() => {
    vi.restoreAllMocks();
    resetFederationCertWarningDedupe();
  });

  it("configured-but-missing files: usable=false (never throws) and the warn REPEATS hourly, not once", () => {
    resetFederationCertWarningDedupe();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let clock = Date.parse("2026-07-24T12:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    // The fault itself: the paths are set (so the CHEAP presence check would say "configured"), the
    // files are gone, and the probe degrades instead of throwing.
    expect(federationClientCertsUsable(MISSING)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("owner decision D4");

    // Every tick of every org inside the window is still suppressed — that is what the dedupe buys.
    clock += 60_000;
    expect(federationClientCertsUsable(MISSING)).toBe(false);
    clock += FEDERATION_CERT_WARNING_REWARN_INTERVAL_MS - 60_000 - 1;
    expect(federationClientCertsUsable(MISSING)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    // …but once the window elapses the UNFIXED fault says so again, so it is present in whatever log
    // window the operator is actually reading.
    clock += 1;
    expect(federationClientCertsUsable(MISSING)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);

    // And it keeps recurring for as long as the fault does.
    clock += FEDERATION_CERT_WARNING_REWARN_INTERVAL_MS;
    expect(federationClientCertsUsable(MISSING)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("a HALF-configured pair also degrades (no throw) and warns", () => {
    resetFederationCertWarningDedupe();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(federationClientCertsUsable({ SCP_FEDERATION_MTLS_CERT_FILE: "/c" })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("NO material configured at all is not a fault: usable=false, and it does NOT warn", () => {
    resetFederationCertWarningDedupe();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(federationClientCertsUsable({})).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a successful resolve CLEARS the suppression — a recurrence warns immediately", () => {
    resetFederationCertWarningDedupe();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let clock = Date.parse("2026-07-24T12:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    expect(federationClientCertsUsable(MISSING)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    // The operator remounts the secret (here: the deployment simply has no mTLS configured, which
    // resolves cleanly) — the suppression is dropped…
    expect(federationClientCertsUsable({})).toBe(false);
    // …so the very next recurrence is reported, without waiting out the interval.
    clock += 1000;
    expect(federationClientCertsUsable(MISSING)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
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

/**
 * M14.4 fix — FORCE and RESCHEDULE are TWO INDEPENDENT FLAGS, unit-pinned at the handler level.
 *
 *  - the STARTUP tick FORCES past the due-gate (its DB-observable half is pinned in
 *    `federation-sync-loop.integration.test.ts`) but MUST still re-schedule: it is the tick that
 *    BOOTSTRAPS the interval chain, so collapsing the two flags into one boolean either kills the
 *    loop ("forced ⇒ no re-schedule") or duplicates interval jobs ("forced ⇒ re-schedule");
 *  - the re-schedule is keyed on "the batch contains a NON-POKE job", not on "no poke is present".
 *    pg-boss 10.4.2 defaults `batchSize` to 1 so a poke and an interval tick cannot arrive together
 *    TODAY — but with a larger batch the old rule would CONSUME the pending interval job and skip
 *    its re-schedule, permanently killing the self-rescheduling chain until process restart.
 */
describe("M14.4 loop handler — force vs. reschedule are two flags", () => {
  /** A db whose org list is empty, so a sweep is a no-op and only the SCHEDULING is under test. */
  const emptyDb = { select: () => ({ from: async () => [] }) } as unknown as Db;

  type Sent = { queue: string; data: FederationSyncJobData; options?: unknown };

  async function startLoop() {
    const previous = process.env.SCP_FEDERATION_SYNC_LOOP;
    process.env.SCP_FEDERATION_SYNC_LOOP = "1"; // the loop is DEFAULT-OFF without this.
    try {
      const sends: Sent[] = [];
      let handler: ((jobs: { data?: FederationSyncJobData }[]) => Promise<void>) | undefined;
      const boss = {
        createQueue: async () => undefined,
        work: async (
          _queue: string,
          h: (jobs: { data?: FederationSyncJobData }[]) => Promise<void>
        ) => {
          handler = h;
          return "worker-id";
        },
        send: async (queue: string, data: FederationSyncJobData, options?: unknown) => {
          sends.push({ queue, data, options });
          return "job-id";
        }
      } as unknown as PgBoss;
      const handle = await startFederationSyncLoop(boss, emptyDb);
      return {
        sends,
        handle,
        run: (jobs: { data?: FederationSyncJobData }[]) => handler!(jobs)
      };
    } finally {
      if (previous === undefined) delete process.env.SCP_FEDERATION_SYNC_LOOP;
      else process.env.SCP_FEDERATION_SYNC_LOOP = previous;
    }
  }

  /** Did the handler re-schedule? The re-schedule is the only send carrying a `singletonKey`. */
  function rescheduled(sends: Sent[]): number {
    return sends.filter(
      (s) => (s.options as { singletonKey?: string } | undefined)?.singletonKey === "tick"
    ).length;
  }

  it("the PULL-ON-(RE)CONNECT tick carries reason 'startup' — not an anonymous {} the due-gate would swallow", async () => {
    const { sends, handle } = await startLoop();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.queue).toBe(FEDERATION_SYNC_QUEUE);
    expect(sends[0]!.data).toEqual({ reason: "startup" });
    // IMMEDIATE AND UNKEYED — no startAfter, no singletonKey, no singletonSeconds, so pg-boss has no
    // singleton slot to drop it into. This assertion was previously the exact inverse (it required
    // `{singletonKey: "startup", singletonSeconds: 10}`), which pinned a real defect: `job_i4`
    // counts COMPLETED jobs, so a worker restarting inside its own 10s window had this send silently
    // dropped and came back with no pull-on-(re)connect at all. The shared "tick" key remains off
    // limits for the separate reason the original note gave — a pending interval tick would absorb
    // it — and unkeyed is immune to both.
    expect(sends[0]!.options ?? {}).toEqual({});
    await handle.stop();
  });

  it("a STARTUP job RE-SCHEDULES (it bootstraps the interval chain)", async () => {
    const { sends, run, handle } = await startLoop();
    sends.length = 0;
    await run([{ data: { reason: "startup" } }]);
    expect(rescheduled(sends)).toBe(1);
    await handle.stop();
  });

  it("a POKE job does NOT re-schedule (it rides alongside the still-pending interval job)", async () => {
    const { sends, run, handle } = await startLoop();
    sends.length = 0;
    await run([{ data: { reason: "poke" } }]);
    expect(rescheduled(sends)).toBe(0);
    await handle.stop();
  });

  it("an INTERVAL job re-schedules", async () => {
    const { sends, run, handle } = await startLoop();
    sends.length = 0;
    await run([{ data: {} }]);
    expect(rescheduled(sends)).toBe(1);
    await handle.stop();
  });

  it("B3: a MIXED batch (interval + poke) still re-schedules — a poke must never consume the chain", async () => {
    const { sends, run, handle } = await startLoop();
    sends.length = 0;
    await run([{ data: {} }, { data: { reason: "poke" } }]);
    expect(rescheduled(sends)).toBe(1);
    await handle.stop();
  });

  it("B3: a MIXED batch (startup + poke) still re-schedules", async () => {
    const { sends, run, handle } = await startLoop();
    sends.length = 0;
    await run([{ data: { reason: "startup" } }, { data: { reason: "poke" } }]);
    expect(rescheduled(sends)).toBe(1);
    await handle.stop();
  });

  it("an EMPTY batch is treated as an interval tick — the chain can never stall", async () => {
    const { sends, run, handle } = await startLoop();
    sends.length = 0;
    await run([]);
    expect(rescheduled(sends)).toBe(1);
    await handle.stop();
  });
});
