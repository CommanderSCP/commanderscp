import type PgBoss from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type { DomainEventJob } from "../events/pgboss.js";
import {
  DOMAIN_EVENT_ROUTERS,
  domainEventRouters,
  type RouterGuardConfig
} from "../events/domain-event-registry.js";
import {
  ACCEPTED_STATE,
  CHANGE_TRANSITIONED_EVENT,
  INTERNAL_RELEASE_QUEUE,
  acceptedChangeRouter,
  internalReleaseDetectionRoleGuard,
  isAcceptedChangeEvent,
  startInternalReleaseLoop
} from "./internal-release-loop.js";
import type { Db } from "../db/client.js";
import type { PluginHost } from "../plugin-host/contract.js";

/** The fan-out point that turns the event into detection. See docs/dependencies.md §239. */

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

/** THE ROLE REASONING, AFTER THE 2026-08-17 REVERSAL. See docs/dependencies.md §240. */
describe("internalReleaseDetectionRoleGuard — commander-only since ADR-0032 §7d", () => {
  const base = {
    role: "worker" as const,
    federationRole: "commander" as const,
    federationRoleDeclared: true
  };

  it("allows a background-work process on an explicitly declared commander", () => {
    expect(internalReleaseDetectionRoleGuard(base).allowed).toBe(true);
    expect(internalReleaseDetectionRoleGuard({ ...base, role: "all" }).allowed).toBe(true);
  });

  it("does NOT run on an api-only process — background work belongs to all/worker", () => {
    const verdict = internalReleaseDetectionRoleGuard({ ...base, role: "api" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/SCP_ROLE/);
  });

  it("is FAIL-CLOSED on an UNDECLARED federation role, which is the branch that regresses silently", () => {
    // `federationRole` DEFAULTS to `commander` (config.ts), so a guard reading only the VALUE lets
    // through exactly the deployments most likely to be outposts — ones predating the setting, or a
    // chart that omits it. Nothing else in the suite constructs this combination.
    const verdict = internalReleaseDetectionRoleGuard({ ...base, federationRoleDeclared: false });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/not declared/);
  });

  it("refuses a declared outpost or retrans, and the reason says WHERE to run it instead", () => {
    for (const federationRole of ["outpost", "retrans"] as const) {
      const verdict = internalReleaseDetectionRoleGuard({ ...base, federationRole });
      expect(verdict.allowed, federationRole).toBe(false);
      expect(verdict.reason, federationRole).toMatch(/COMMANDER-ONLY/);
    }
  });
});

/** The wiring: a predicate nothing consults is the defect. See docs/dependencies.md §241. */
describe("the internal-release router is registered under this capability's own guard", () => {
  it("pairs the router with `internalReleaseDetectionRoleGuard`, by identity", () => {
    const entries = DOMAIN_EVENT_ROUTERS.filter((entry) => entry.factory === acceptedChangeRouter);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.guard).toBe(internalReleaseDetectionRoleGuard);
  });

  it("registers on a declared commander worker, and on NOTHING else", () => {
    const queuesFor = (config: RouterGuardConfig): string[] =>
      domainEventRouters(config).map((router) => router.queue);
    expect(
      queuesFor({ role: "worker", federationRole: "commander", federationRoleDeclared: true })
    ).toContain(INTERNAL_RELEASE_QUEUE);
    expect(
      queuesFor({ role: "api", federationRole: "commander", federationRoleDeclared: true })
    ).not.toContain(INTERNAL_RELEASE_QUEUE);
    expect(
      queuesFor({ role: "worker", federationRole: "outpost", federationRoleDeclared: true })
    ).not.toContain(INTERNAL_RELEASE_QUEUE);
    expect(
      queuesFor({ role: "worker", federationRole: "commander", federationRoleDeclared: false })
    ).not.toContain(INTERNAL_RELEASE_QUEUE);
  });
});

/** THE WORKER HALF ACTUALLY CONSULTS THE GUARD. See docs/dependencies.md §242. */
describe("startInternalReleaseLoop consults the guard before it touches pg-boss", () => {
  function recordingBoss() {
    return {
      createQueue: vi.fn(async () => undefined),
      work: vi.fn(async () => "worker-id"),
      send: vi.fn(async () => "job-id")
    };
  }
  const deps = (config: {
    role: "all" | "api" | "worker";
    federationRole: "commander" | "outpost" | "retrans";
    federationRoleDeclared: boolean;
  }) => ({
    db: {} as Db,
    host: {} as PluginHost,
    config: { ...config, secretsMasterKey: Buffer.alloc(32) }
  });

  it("REFUSES a declared outpost with an inert handle and NEVER CREATES THE QUEUE", async () => {
    const boss = recordingBoss();
    const handle = await startInternalReleaseLoop(
      boss as unknown as PgBoss,
      deps({ role: "worker", federationRole: "outpost", federationRoleDeclared: true })
    );
    await handle.stop();
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it("REFUSES an UNDECLARED deployment, the branch that looks identical to a commander", async () => {
    const boss = recordingBoss();
    const handle = await startInternalReleaseLoop(
      boss as unknown as PgBoss,
      deps({ role: "worker", federationRole: "commander", federationRoleDeclared: false })
    );
    await handle.stop();
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it("REFUSES an api process", async () => {
    const boss = recordingBoss();
    const handle = await startInternalReleaseLoop(
      boss as unknown as PgBoss,
      deps({ role: "api", federationRole: "commander", federationRoleDeclared: true })
    );
    await handle.stop();
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL — a declared commander worker DOES create the queue and take a worker", async () => {
    const boss = recordingBoss();
    const handle = await startInternalReleaseLoop(
      boss as unknown as PgBoss,
      deps({ role: "worker", federationRole: "commander", federationRoleDeclared: true })
    );
    await handle.stop();
    expect(boss.createQueue).toHaveBeenCalledWith(INTERNAL_RELEASE_QUEUE);
    expect(boss.work).toHaveBeenCalledTimes(1);
  });
});
