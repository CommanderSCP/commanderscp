import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_RELAY_POKE_REASON,
  AUTO_RELAY_QUEUE,
  autoRelayBackoffSeconds,
  autoRelayEnabled,
  autoRelayIntervalSeconds,
  autoRelayLeaseSeconds,
  autoRelayMaxAttempts,
  startAutoRelayLoop
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
