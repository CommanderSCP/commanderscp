import { afterEach, describe, expect, it } from "vitest";
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.js";
import {
  AUTO_RELAY_POKE_REASON,
  AUTO_RELAY_QUEUE,
  autoRelayBackoffSeconds,
  autoRelayEnabled,
  autoRelayIntervalSeconds,
  autoRelayLeaseSeconds,
  autoRelayMaxAttempts,
  startAutoRelayLoop,
  wakeAutoRelayNow,
  type AutoRelayJobData
} from "./auto-relay.js";

/**
 * M13.1b — the auto-relay's CONFIG SURFACE, unit-level. Every knob here decides how much unattended
 * work happens at a cross-domain boundary and how much permanent record a failing promotion leaves
 * behind, so each assertion pins a NUMBER a mutation would move, not a shape.
 *
 * DEFAULT-OFF is the load-bearing one: an instance whose operator never set `SCP_RETRANS_AUTO_RELAY=1`
 * must NEVER create the queue, never tick, and never move a byte across the boundary.
 */
describe("M13.1b auto-relay config", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SCP_RETRANS_AUTO_RELAY")) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) {
      if (key.startsWith("SCP_RETRANS_AUTO_RELAY") && value !== undefined) process.env[key] = value;
    }
  });

  it("autoRelayEnabled is true ONLY for the exact string '1' (default off)", () => {
    expect(autoRelayEnabled({})).toBe(false);
    expect(autoRelayEnabled({ SCP_RETRANS_AUTO_RELAY: "" })).toBe(false);
    expect(autoRelayEnabled({ SCP_RETRANS_AUTO_RELAY: "0" })).toBe(false);
    expect(autoRelayEnabled({ SCP_RETRANS_AUTO_RELAY: "true" })).toBe(false);
    expect(autoRelayEnabled({ SCP_RETRANS_AUTO_RELAY: "yes" })).toBe(false);
    expect(autoRelayEnabled({ SCP_RETRANS_AUTO_RELAY: " 1" })).toBe(false);
    expect(autoRelayEnabled({ SCP_RETRANS_AUTO_RELAY: "1" })).toBe(true);
  });

  it("an unset flag creates NO queue and returns an inert handle — an unconfigured instance never spins", async () => {
    delete process.env.SCP_RETRANS_AUTO_RELAY;
    const calls: string[] = [];
    const boss = {
      createQueue: async (name: string) => {
        calls.push(`createQueue:${name}`);
      },
      work: async (name: string) => {
        calls.push(`work:${name}`);
      },
      send: async (name: string) => {
        calls.push(`send:${name}`);
      }
    };
    const handle = await startAutoRelayLoop(
      boss as unknown as Parameters<typeof startAutoRelayLoop>[0],
      {} as unknown as Parameters<typeof startAutoRelayLoop>[1],
      Buffer.alloc(32)
    );
    await handle.stop();
    // Not "no createQueue" — NOTHING at all. A created queue would be pokeable (the M14.4 handler
    // sends to it), which is exactly the byte egress an unset flag must not permit.
    expect(calls).toEqual([]);
  });

  it("the enabled loop creates its own queue and primes an immediate first tick", async () => {
    process.env.SCP_RETRANS_AUTO_RELAY = "1";
    const calls: string[] = [];
    const boss = {
      createQueue: async (name: string) => {
        calls.push(`createQueue:${name}`);
      },
      work: async (name: string) => {
        calls.push(`work:${name}`);
      },
      send: async (name: string) => {
        calls.push(`send:${name}`);
      }
    };
    const handle = await startAutoRelayLoop(
      boss as unknown as Parameters<typeof startAutoRelayLoop>[0],
      {} as unknown as Parameters<typeof startAutoRelayLoop>[1],
      Buffer.alloc(32)
    );
    await handle.stop();
    expect(calls).toEqual([
      `createQueue:${AUTO_RELAY_QUEUE}`,
      `work:${AUTO_RELAY_QUEUE}`,
      `send:${AUTO_RELAY_QUEUE}`
    ]);
  });

  it("autoRelayIntervalSeconds defaults to 60 and floors at 5 (never a hot loop)", () => {
    expect(autoRelayIntervalSeconds({})).toBe(60);
    expect(autoRelayIntervalSeconds({ SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS: "900" })).toBe(900);
    expect(autoRelayIntervalSeconds({ SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS: "1" })).toBe(5);
    expect(autoRelayIntervalSeconds({ SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS: "0" })).toBe(5);
    expect(autoRelayIntervalSeconds({ SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS: "-30" })).toBe(5);
    expect(autoRelayIntervalSeconds({ SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS: "abc" })).toBe(60);
  });

  it("autoRelayMaxAttempts defaults to 5 and clamps to [1,20] — the verdict budget is always finite", () => {
    expect(autoRelayMaxAttempts({})).toBe(5);
    expect(autoRelayMaxAttempts({ SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS: "3" })).toBe(3);
    // 0 or negative must not mean "never give up" AND must not mean "never try" — one attempt.
    expect(autoRelayMaxAttempts({ SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS: "0" })).toBe(1);
    expect(autoRelayMaxAttempts({ SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS: "-1" })).toBe(1);
    // An operator cannot opt out of the #153 bound by setting something enormous.
    expect(autoRelayMaxAttempts({ SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS: "1000" })).toBe(20);
    // "Infinity" parses to a NUMBER that is not finite, so it takes the not-a-number branch and
    // lands on the DEFAULT (5), not the ceiling (20). Pinned deliberately: both answers are bounded,
    // and the smaller one is the right way to read "never give up" at a security boundary.
    expect(autoRelayMaxAttempts({ SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS: "Infinity" })).toBe(5);
    expect(autoRelayMaxAttempts({ SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS: "abc" })).toBe(5);
    expect(autoRelayMaxAttempts({ SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS: "2.9" })).toBe(2);
  });

  it("autoRelayLeaseSeconds defaults to 1h and clamps to [60, 86400]", () => {
    expect(autoRelayLeaseSeconds({})).toBe(3600);
    expect(autoRelayLeaseSeconds({ SCP_RETRANS_AUTO_RELAY_LEASE_SECONDS: "7200" })).toBe(7200);
    // A sub-minute lease would let a second replica reclaim a change while the first is still
    // pulling — survivable (releases are fenced) but pure waste.
    expect(autoRelayLeaseSeconds({ SCP_RETRANS_AUTO_RELAY_LEASE_SECONDS: "5" })).toBe(60);
    expect(autoRelayLeaseSeconds({ SCP_RETRANS_AUTO_RELAY_LEASE_SECONDS: "999999" })).toBe(86400);
    expect(autoRelayLeaseSeconds({ SCP_RETRANS_AUTO_RELAY_LEASE_SECONDS: "abc" })).toBe(3600);
  });

  it("autoRelayBackoffSeconds doubles per VERDICT and is capped at one hour", () => {
    expect(autoRelayBackoffSeconds(1)).toBe(60);
    expect(autoRelayBackoffSeconds(2)).toBe(120);
    expect(autoRelayBackoffSeconds(3)).toBe(240);
    expect(autoRelayBackoffSeconds(4)).toBe(480);
    expect(autoRelayBackoffSeconds(5)).toBe(960);
    // Cap holds, and holds for anything beyond — no overflow to Infinity/NaN at high counts.
    expect(autoRelayBackoffSeconds(7)).toBe(3600);
    expect(autoRelayBackoffSeconds(50)).toBe(3600);
    expect(autoRelayBackoffSeconds(1000)).toBe(3600);
    // Never below the first step, whatever a caller passes (0 would mean an immediate re-attempt,
    // i.e. a hot loop around a multi-GB skopeo pull).
    expect(autoRelayBackoffSeconds(0)).toBe(60);
    expect(autoRelayBackoffSeconds(-5)).toBe(60);
    // Monotonic non-decreasing across the whole live range.
    for (let n = 1; n < 30; n += 1) {
      expect(autoRelayBackoffSeconds(n + 1)).toBeGreaterThanOrEqual(autoRelayBackoffSeconds(n));
    }
  });

  it("the poke reason is a distinct marker — an interval tick must be distinguishable from a wake", () => {
    // The re-schedule rule keys on this exact value (a poke tick must NOT re-schedule, or a wake
    // landing in a different pg-boss singleton slot leaves two pending interval ticks).
    expect(AUTO_RELAY_POKE_REASON).toBe("poke");
    expect(AUTO_RELAY_POKE_REASON).not.toBe(undefined);
  });
});

/**
 * M13.1b — THE RE-SCHEDULE MATRIX, the M14.4 rule applied to this loop (its sibling proof for the
 * sync loop is `federation-sync-cadence.test.ts`'s "force vs. reschedule are two flags").
 *
 * WHY IT MATTERS HERE. pg-boss computes a singleton slot from `now()` AT INSERT, so a poke wake
 * landing in a different slot than the already-pending interval tick is NOT deduped. If a poke tick
 * re-scheduled, every poke would leave a second pending interval job and the "reliable floor" would
 * quietly densify — at a CDS boundary, where each tick can pull GBs through skopeo. And the inverse
 * regression is worse and completely silent: if an INTERVAL tick stopped re-scheduling, the
 * self-rescheduling chain dies at the first tick and the boundary stalls forever with no error
 * anywhere. Both directions have to be pinned, which is why this is a matrix and not one case.
 *
 * The batch cases exist because the keying is "the batch contains a NON-POKE job", not "no poke is
 * present": pg-boss 10.4.2 defaults `batchSize` to 1, so a mixed batch is hardening rather than a
 * live bug — but a future `batchSize > 1` would otherwise let one poke consume the pending interval
 * job AND suppress its re-schedule, permanently killing the chain until a process restart.
 */
describe("M13.1b auto-relay loop — force vs. re-schedule", () => {
  /** A db whose org list is empty, so the sweep is a no-op and only SCHEDULING is under test. */
  const emptyDb = { select: () => ({ from: async () => [] }) } as unknown as Db;

  type Sent = { queue: string; data: AutoRelayJobData; options?: unknown };

  async function startLoop() {
    const previous = process.env.SCP_RETRANS_AUTO_RELAY;
    process.env.SCP_RETRANS_AUTO_RELAY = "1"; // DEFAULT-OFF without this.
    try {
      const sends: Sent[] = [];
      let handler: ((jobs: { data?: AutoRelayJobData }[]) => Promise<void>) | undefined;
      const boss = {
        createQueue: async () => undefined,
        work: async (_q: string, h: (jobs: { data?: AutoRelayJobData }[]) => Promise<void>) => {
          handler = h;
          return "worker-id";
        },
        send: async (queue: string, data: AutoRelayJobData, options?: unknown) => {
          sends.push({ queue, data, options });
          return "job-id";
        }
      } as unknown as PgBoss;
      const handle = await startAutoRelayLoop(boss, emptyDb, Buffer.alloc(32));
      return { sends, handle, boss, run: (jobs: { data?: AutoRelayJobData }[]) => handler!(jobs) };
    } finally {
      if (previous === undefined) delete process.env.SCP_RETRANS_AUTO_RELAY;
      else process.env.SCP_RETRANS_AUTO_RELAY = previous;
    }
  }

  /** Did the handler re-schedule? The re-schedule is the only send carrying a `singletonKey`. */
  function rescheduled(sends: Sent[]): number {
    return sends.filter(
      (s) => (s.options as { singletonKey?: string } | undefined)?.singletonKey === "tick"
    ).length;
  }

  it("an INTERVAL tick re-schedules — this is the self-rescheduling chain, and the reliable floor", async () => {
    const { sends, run, handle } = await startLoop();
    sends.length = 0;
    await run([{ data: {} }]);
    expect(rescheduled(sends)).toBe(1);
    await handle.stop();
  });

  it("a POKE tick does NOT re-schedule — it rides alongside the still-pending interval job", async () => {
    const { sends, run, handle } = await startLoop();
    sends.length = 0;
    await run([{ data: { reason: AUTO_RELAY_POKE_REASON } }]);
    expect(rescheduled(sends)).toBe(0);
    await handle.stop();
  });

  it("a MIXED batch re-schedules — one poke can never consume the interval job and kill the chain", async () => {
    const { sends, run, handle } = await startLoop();
    sends.length = 0;
    await run([{ data: { reason: AUTO_RELAY_POKE_REASON } }, { data: {} }]);
    expect(rescheduled(sends)).toBe(1);
    await handle.stop();
  });

  it("an EMPTY batch re-schedules — a delivery that carries no job must not silently end the chain", async () => {
    const { sends, run, handle } = await startLoop();
    sends.length = 0;
    await run([]);
    expect(rescheduled(sends)).toBe(1);
    await handle.stop();
  });

  it("the re-scheduled tick carries the LIVE interval, not an import-frozen constant", async () => {
    const previous = process.env.SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS;
    process.env.SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS = "123";
    try {
      const { sends, run, handle } = await startLoop();
      sends.length = 0;
      await run([{ data: {} }]);
      const tick = sends.find(
        (s) => (s.options as { singletonKey?: string } | undefined)?.singletonKey === "tick"
      );
      expect(tick?.options).toMatchObject({ startAfter: 123, singletonSeconds: 123 });
      await handle.stop();
    } finally {
      if (previous === undefined) delete process.env.SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS;
      else process.env.SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS = previous;
    }
  });

  it("wakeAutoRelayNow sends an IMMEDIATE, non-singleton job — a queued interval tick must never swallow a wake", async () => {
    const sends: Sent[] = [];
    const boss = {
      send: async (queue: string, data: AutoRelayJobData, options?: unknown) => {
        sends.push({ queue, data, options });
        return "job-id";
      }
    } as unknown as PgBoss;
    await wakeAutoRelayNow(boss);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.queue).toBe(AUTO_RELAY_QUEUE);
    expect(sends[0]!.data).toEqual({ reason: AUTO_RELAY_POKE_REASON });
    // No singletonKey and no startAfter: a wake deduped into the pending interval slot would be a
    // poke that does nothing, which is precisely the latency the poke chain exists to remove.
    expect(sends[0]!.options).toBeUndefined();
  });
});
