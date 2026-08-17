import type PgBoss from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type { DomainEventJob } from "../events/pgboss.js";
import {
  ACCEPTED_STATE,
  CHANGE_TRANSITIONED_EVENT,
  INTERNAL_RELEASE_QUEUE
} from "./internal-release-loop.js";
import {
  INVENTORY_INGESTION_QUEUE,
  inventoryIngestionRoleGuard,
  inventoryIngestionRouter,
  startInventoryIngestionLoop
} from "./inventory-ingestion-loop.js";
import type { Db } from "../db/client.js";
import type { PluginHost } from "../plugin-host/contract.js";

/**
 * M21.2 — THE FAN-OUT POINT AND THE ROLE GUARD for dependency-inventory ingestion.
 *
 * Pinned separately from the ingestion itself because this is the half that decides whether it ever
 * RUNS — the exact half that was missing for the four M21 components that shipped inert.
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

function fakeBoss() {
  return { send: vi.fn(async () => "job-id") } as unknown as PgBoss & {
    send: ReturnType<typeof vi.fn>;
  };
}

describe("inventoryIngestionRouter", () => {
  it("enqueues the change id onto THIS capability's own queue", async () => {
    const boss = fakeBoss();
    await inventoryIngestionRouter().route(boss, event());
    expect(boss.send).toHaveBeenCalledWith(
      INVENTORY_INGESTION_QUEUE,
      { orgId: "org-1", changeObjectId: "chg-1" },
      { singletonKey: "chg-1" }
    );
  });

  it("uses a DIFFERENT queue from internal detection — `boss.work()` is a competing consumer", () => {
    // Both capabilities react to the SAME event. Sharing a queue would not give them each a copy;
    // it would split the jobs between their workers at random, so roughly half of every org's
    // accepted changes would be ingested and never detected, and half the reverse.
    expect(INVENTORY_INGESTION_QUEUE).not.toBe(INTERNAL_RELEASE_QUEUE);
    expect(inventoryIngestionRouter().queue).toBe(INVENTORY_INGESTION_QUEUE);
  });

  it("ignores every other transition — a router matching too widely enqueues a job per tick", async () => {
    const boss = fakeBoss();
    const router = inventoryIngestionRouter();
    await router.route(boss, event({ data: { toState: "executing" } }));
    await router.route(boss, event({ type: "scp.object.updated" }));
    await router.route(boss, event({ data: null }));
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("ignores an accepted change with no subject — there is nothing to ingest for", async () => {
    const boss = fakeBoss();
    await inventoryIngestionRouter().route(boss, event({ subject: null }));
    await inventoryIngestionRouter().route(boss, event({ subject: "" }));
    expect(boss.send).not.toHaveBeenCalled();
  });
});

/**
 * THE GUARD, AFTER THE 2026-08-17 REVERSAL (ADR-0032 §7d).
 *
 * This block used to assert the OPPOSITE — "RUNS ON EVERY FEDERATION ROLE" and "is not fail-closed
 * on an UNDECLARED deployment" — and it passed, because the guard really did allow both. Nothing
 * about ingestion's own mechanics changed; the owner's decision changed which question the guard
 * answers. An outpost never ORIGINATES a dependency bump — it RECEIVES the resulting change down
 * the global pipeline the commander manages — so an outpost derives no inventory at all.
 *
 * Kept in the same shape `bump-dispatch.test.ts` uses for its role guard, because these two are now
 * the same guard: all three refusals and the accepted case, one `it` each.
 */
describe("inventoryIngestionRoleGuard — commander-only since ADR-0032 §7d", () => {
  const base = {
    role: "worker" as const,
    federationRole: "commander" as const,
    federationRoleDeclared: true
  };

  it("allows a background-work process on an explicitly declared commander", () => {
    expect(inventoryIngestionRoleGuard(base).allowed).toBe(true);
    expect(inventoryIngestionRoleGuard({ ...base, role: "all" }).allowed).toBe(true);
  });

  it("refuses an api-only process — background work belongs to all/worker", () => {
    const verdict = inventoryIngestionRoleGuard({ ...base, role: "api" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/SCP_ROLE/);
  });

  it("is FAIL-CLOSED on an UNDECLARED federation role, which is the branch that regresses silently", () => {
    // `federationRole` DEFAULTS to `commander` so every pre-M16.3 deployment keeps serving the SPA.
    // A guard testing only the VALUE therefore allows exactly the population most likely to be an
    // outpost: one deployed before the setting existed, or from a chart that omits it. This branch
    // is false on every developer machine and every declared commander, so nothing else catches it.
    const verdict = inventoryIngestionRoleGuard({ ...base, federationRoleDeclared: false });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/not declared/);
  });

  it("refuses a declared outpost or retrans, and the reason says WHERE to run it instead", () => {
    for (const federationRole of ["outpost", "retrans"] as const) {
      const verdict = inventoryIngestionRoleGuard({ ...base, federationRole });
      expect(verdict.allowed, federationRole).toBe(false);
      // The remedy, not just the refusal: an operator reading this log line has to learn that the
      // answer is "the commander does this", never "your deployment is broken".
      expect(verdict.reason, federationRole).toMatch(/COMMANDER-ONLY/);
    }
  });
});

// The ROUTER half's wiring census — that the registry pairs `inventoryIngestionRouter` with THIS
// guard, and what that pairing registers on each deployment shape — already lives in
// `inventory-ingestion.test.ts`'s "the wiring census" block, and is updated there for §7d rather
// than duplicated here. A second copy of an identity assertion is a second place to forget.

/**
 * THE WORKER HALF ACTUALLY CONSULTS THE GUARD — MEASURED, NOT ASSUMED.
 *
 * This block exists because deleting `startInventoryIngestionLoop`'s `if (!guard.allowed) return`
 * left the ENTIRE suite green, integration tests included: every one of them boots the loop as a
 * declared commander, where the refusal branch is never taken, and the router census only covers
 * the ROUTER half. So the guard was computed, logged, and structurally ignorable — a guard present
 * but not consulted, which CLAUDE.md names as this codebase's most common defect.
 *
 * A REFUSED ROLE MUST NEVER CREATE THE QUEUE, not merely skip the work inside the handler: a
 * process that created it would still hold a pg-boss worker for a queue it will never act on, and
 * an outpost would drain ingestion jobs it is forbidden to perform. Same shape and same reason as
 * `version-poll.test.ts`'s "a refused role returns an inert handle and NEVER CREATES THE QUEUE".
 */
describe("startInventoryIngestionLoop consults the guard before it touches pg-boss", () => {
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
    const handle = await startInventoryIngestionLoop(boss as unknown as PgBoss, {
      ...deps({ role: "worker", federationRole: "outpost", federationRoleDeclared: true })
    });
    await handle.stop();
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it("REFUSES an UNDECLARED deployment, the branch that looks identical to a commander", async () => {
    const boss = recordingBoss();
    const handle = await startInventoryIngestionLoop(boss as unknown as PgBoss, {
      ...deps({ role: "worker", federationRole: "commander", federationRoleDeclared: false })
    });
    await handle.stop();
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it("REFUSES an api process", async () => {
    const boss = recordingBoss();
    const handle = await startInventoryIngestionLoop(boss as unknown as PgBoss, {
      ...deps({ role: "api", federationRole: "commander", federationRoleDeclared: true })
    });
    await handle.stop();
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL — a declared commander worker DOES create the queue and take a worker", async () => {
    // Without this the three refusals above are satisfied by a loop that never starts at all.
    const boss = recordingBoss();
    const handle = await startInventoryIngestionLoop(boss as unknown as PgBoss, {
      ...deps({ role: "worker", federationRole: "commander", federationRoleDeclared: true })
    });
    await handle.stop();
    expect(boss.createQueue).toHaveBeenCalledWith(INVENTORY_INGESTION_QUEUE);
    expect(boss.work).toHaveBeenCalledTimes(1);
  });
});
