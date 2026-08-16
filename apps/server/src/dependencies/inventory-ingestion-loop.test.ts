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
  inventoryIngestionRouter
} from "./inventory-ingestion-loop.js";

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

describe("inventoryIngestionRoleGuard", () => {
  it("refuses an api process — this is background work", () => {
    const verdict = inventoryIngestionRoleGuard({ role: "api", federationRole: "commander" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("SCP_ROLE");
  });

  it("allows `all` and `worker`", () => {
    expect(inventoryIngestionRoleGuard({ role: "all", federationRole: "commander" }).allowed).toBe(
      true
    );
    expect(
      inventoryIngestionRoleGuard({ role: "worker", federationRole: "commander" }).allowed
    ).toBe(true);
  });

  it("RUNS ON EVERY FEDERATION ROLE — the difference from the version poll, not a copy of it", () => {
    // The poll is commander-only because it dials PUBLIC PACKAGE REGISTRIES ON A TIMER, and it is
    // fail-closed on an undeclared role for that reason. Ingestion initiates no timed egress: it
    // reacts to this domain's own accepted change and reads through the git binding this domain's
    // executors already coordinate over. ADR-0032 §3 says each domain derives its own inventory, so
    // a commander-only guard would leave every outpost's `component_dependencies` empty forever —
    // which is the same silent inertness this whole milestone exists to fix.
    for (const federationRole of ["commander", "outpost", "retrans"] as const) {
      expect(inventoryIngestionRoleGuard({ role: "worker", federationRole }).allowed).toBe(true);
    }
  });

  it("is not fail-closed on an UNDECLARED deployment, and says why in its own reason", () => {
    // `SCP_FEDERATION_ROLE` defaults to `commander`, so a guard that required an explicit
    // declaration would be refusing the population most likely to be air-gapped. That refusal is
    // right for outbound registry traffic and wrong here — the cost of being wrong is an outpost
    // with a permanently empty inventory, not unexpected egress.
    const verdict = inventoryIngestionRoleGuard({ role: "worker", federationRole: "commander" });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toContain("every federation role");
  });
});
