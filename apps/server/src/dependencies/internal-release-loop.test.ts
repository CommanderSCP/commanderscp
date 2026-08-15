import type PgBoss from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type { DomainEventJob } from "../events/pgboss.js";
import {
  ACCEPTED_STATE,
  CHANGE_TRANSITIONED_EVENT,
  INTERNAL_RELEASE_QUEUE,
  acceptedChangeRouter,
  internalReleaseDetectionRoleGuard,
  isAcceptedChangeEvent
} from "./internal-release-loop.js";

/**
 * M21.4 BLOCKER A — the fan-out point that turns `scp.change.transitioned` into internal detection.
 *
 * The predicate and the routing are pinned separately from the detection itself because they are
 * the half that decides whether detection ever RUNS. Before this, `detectInternalReleases` had no
 * production caller at all and `scp.change.transitioned` had no server-side consumer.
 */

function event(overrides: Partial<DomainEventJob> = {}): DomainEventJob {
  return {
    id: "evt-1",
    orgId: "org-1",
    type: CHANGE_TRANSITIONED_EVENT,
    source: "/changes/chg-1",
    subject: "chg-1",
    data: { fromState: "validating", toState: ACCEPTED_STATE, trigger: null },
    ...overrides
  };
}

describe("isAcceptedChangeEvent", () => {
  it("matches a change that reached `accepted`", () => {
    expect(isAcceptedChangeEvent(event())).toBe(true);
  });

  it("does NOT match another state of the same event — a router firing per transition would enqueue a job per tick", () => {
    expect(isAcceptedChangeEvent(event({ data: { toState: "executing" } }))).toBe(false);
    expect(isAcceptedChangeEvent(event({ data: { toState: "failed" } }))).toBe(false);
  });

  it("does NOT match another event type, however shaped", () => {
    expect(
      isAcceptedChangeEvent(event({ type: "scp.object.updated", data: { toState: "accepted" } }))
    ).toBe(false);
  });

  it("does not throw on a payload that is not an object", () => {
    for (const data of [null, undefined, "accepted", 42, []]) {
      expect(isAcceptedChangeEvent(event({ data }))).toBe(false);
    }
  });
});

describe("acceptedChangeRouter", () => {
  function fakeBoss() {
    return { send: vi.fn(async () => "job-id") } as unknown as PgBoss & {
      send: ReturnType<typeof vi.fn>;
    };
  }

  it("enqueues the change id onto the capability's OWN queue", async () => {
    const boss = fakeBoss();
    await acceptedChangeRouter().route(boss, event());
    expect(boss.send).toHaveBeenCalledTimes(1);
    const [queue, payload] = boss.send.mock.calls[0]!;
    expect(queue).toBe(INTERNAL_RELEASE_QUEUE);
    expect(payload).toEqual({ orgId: "org-1", changeObjectId: "chg-1" });
  });

  it("enqueues NOTHING for a transition to any other state", async () => {
    const boss = fakeBoss();
    await acceptedChangeRouter().route(boss, event({ data: { toState: "executing" } }));
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("enqueues nothing when the event names no subject — the change id is the whole payload", async () => {
    const boss = fakeBoss();
    await acceptedChangeRouter().route(boss, event({ subject: null }));
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("declares the queue it sends to, so startPgBoss can create it before any event is routed", () => {
    expect(acceptedChangeRouter().queue).toBe(INTERNAL_RELEASE_QUEUE);
  });
});

/**
 * THE ROLE REASONING IS THE POLL'S, APPLIED — NOT THE POLL'S VERDICT, COPIED.
 *
 * The version poll refuses on any federation role but an explicitly-declared `commander`, because it
 * DIALS THE PUBLIC INTERNET ON A TIMER. Asking the same question here gives the opposite answer for
 * the federation axis and the same answer for the process axis, and both halves are pinned: a guard
 * that copied the poll's verdict would make every outpost domain derive nothing forever, silently,
 * even though the wave-target evidence a release is derived from exists ONLY where the change
 * executed and ADR-0032 §3 says each domain derives its own inventory.
 */
describe("internalReleaseDetectionRoleGuard", () => {
  it("runs on EVERY federation role, including an outpost and a retrans node", () => {
    for (const federationRole of ["commander", "outpost", "retrans"] as const) {
      expect(
        internalReleaseDetectionRoleGuard({ role: "worker", federationRole }).allowed,
        `federationRole ${federationRole}`
      ).toBe(true);
    }
  });

  it("does NOT run on an api-only process — background work belongs to all/worker", () => {
    const verdict = internalReleaseDetectionRoleGuard({
      role: "api",
      federationRole: "commander"
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/SCP_ROLE/);
  });

  it("runs on both background-work process roles", () => {
    for (const role of ["all", "worker"] as const) {
      expect(internalReleaseDetectionRoleGuard({ role, federationRole: "commander" }).allowed).toBe(
        true
      );
    }
  });
});
