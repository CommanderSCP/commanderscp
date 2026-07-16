import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents } from "../db/schema.js";
import { processChangeSourceEvents } from "./webhook-processor.js";

/**
 * M12 P5 (owner ruling Q3, github-webhook path) — `discovery/accept` creates a `source_mapping` per
 * imported component so the import actually SELF-REPORTS releases via correlation, not just being
 * triggerable. Before this, imports carried no mapping, so a pulled/webhooked event correlated
 * against nothing and dropped. The load-bearing test drives a real event end-to-end.
 */
describe("source_mappings on import (M12 P5, Q3)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "src-map-import");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** Insert one unprocessed event and run the processor (bypasses HTTP/HMAC — the ingestion layer is
   *  covered elsewhere; this is about correlation). Returns the resulting change object id, or null. */
  async function reportAndProcess(sourceKind: string, repo: string): Promise<string | null> {
    const eventId = uuidv7();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(changeSourceEvents).values({
        id: eventId,
        orgId: org.orgId,
        sourceKind,
        signatureVerified: true,
        dedupeKey: `test:${eventId}`,
        headers: {},
        payload: { repo, correlationKey: "refs/heads/main" }
      })
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    return rows[0]?.resultingChangeObjectId ?? null;
  }

  it("accept creates a source_mapping per proposed mapping, listable under its source kind", async () => {
    const name = `imported-${randomUUID().slice(0, 8)}`;
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const result = await admin.discovery.accept({
      proposal: {
        objects: [{ typeId: "component", name, properties: {} }],
        relationships: [],
        sourceMappings: [
          { objectName: name, sourceKind: "github", repoPattern: repo, purpose: "software" }
        ]
      }
    });
    expect(result.createdObjectIds).toHaveLength(1);
    expect(result.createdSourceMappingIds).toHaveLength(1);

    const componentId = result.createdObjectIds[0]!;
    const mappings = await admin.changeSources.listMappings("github");
    expect(
      mappings.items.some((m) => m.componentObjectId === componentId && m.repoPattern === repo)
    ).toBe(true);
  });

  it("the imported component SELF-REPORTS: a github event on its repo correlates to a Change", async () => {
    const name = `imported-${randomUUID().slice(0, 8)}`;
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const result = await admin.discovery.accept({
      proposal: {
        objects: [{ typeId: "component", name, properties: {} }],
        relationships: [],
        sourceMappings: [{ objectName: name, sourceKind: "github", repoPattern: repo }]
      }
    });
    const componentId = result.createdObjectIds[0]!;

    // A github push to the mapped repo now correlates to the imported component — a Change is born.
    const changeId = await reportAndProcess("github", repo);
    expect(changeId).not.toBeNull();
    const change = await admin.changes.get(changeId!);
    expect(change.state).toBe("proposed");

    // Control: an event on a DIFFERENT repo has no mapping → correlates against nothing → drops (the
    // exact pre-P5 failure this closes). Proves the mapping is what wired the component, not luck.
    const orphanChange = await reportAndProcess("github", `unmapped/${randomUUID().slice(0, 8)}`);
    expect(orphanChange).toBeNull();
    expect(componentId).toBeTruthy();
  });

  it("a proposal with NO sourceMappings creates none (imports without a source stay permissive)", async () => {
    const name = `no-src-${randomUUID().slice(0, 8)}`;
    const result = await admin.discovery.accept({
      proposal: { objects: [{ typeId: "component", name, properties: {} }], relationships: [] }
    });
    expect(result.createdObjectIds).toHaveLength(1);
    expect(result.createdSourceMappingIds).toHaveLength(0);
  });

  // The AUTOMATED backfill (M12 P5 follow-up) — wires mappings onto components imported BEFORE
  // discovery emitted them (the 50 argocd orphans). Matches a proposal's sourceMappings to existing
  // components by name; creates no objects; idempotent; reports every skip.
  describe("automated backfill", () => {
    const proposalOf = (mappings: Array<{ objectName: string; repoPattern: string }>) =>
      ({
        objects: [],
        relationships: [],
        sourceMappings: mappings.map((m) => ({ ...m, sourceKind: "github" }))
      }) as never;

    it("matches existing components by name, creates mappings, is idempotent, and the component self-reports", async () => {
      // An orphan imported BEFORE mappings existed (accept with no sourceMappings).
      const name = `orphan-${randomUUID().slice(0, 8)}`;
      const repo = `acme/${randomUUID().slice(0, 8)}`;
      await admin.discovery.accept({
        proposal: { objects: [{ typeId: "component", name, properties: {} }], relationships: [] }
      });

      // Backfill from a fresh proposal's sourceMappings → matched by name, mapping created.
      const first = await admin.discovery.backfillSourceMappings(proposalOf([{ objectName: name, repoPattern: repo }]));
      expect(first.createdSourceMappingIds).toHaveLength(1);
      expect(first.skipped).toHaveLength(0);

      // The backfilled component now self-reports — a github push to its repo correlates to a Change.
      expect(await reportAndProcess("github", repo)).not.toBeNull();

      // Re-running is a no-op: the identical mapping is skipped ("already mapped"), not duplicated.
      const second = await admin.discovery.backfillSourceMappings(proposalOf([{ objectName: name, repoPattern: repo }]));
      expect(second.createdSourceMappingIds).toHaveLength(0);
      expect(second.skipped[0]).toMatchObject({ objectName: name, reason: expect.stringMatching(/already mapped/) });
    });

    it("skips (never silently drops) a mapping whose component doesn't exist", async () => {
      const ghost = `ghost-${randomUUID().slice(0, 8)}`;
      const r = await admin.discovery.backfillSourceMappings(proposalOf([{ objectName: ghost, repoPattern: "x/y" }]));
      expect(r.createdSourceMappingIds).toHaveLength(0);
      expect(r.skipped[0]).toMatchObject({ objectName: ghost, reason: expect.stringMatching(/no live component/) });
    });

    it("skips an ambiguous name (more than one live component)", async () => {
      const dup = `dup-${randomUUID().slice(0, 8)}`;
      const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
      // Two live components share a name via explicit distinct URNs (the strict route allows a urn).
      await admin.components.create({ name: dup, service: svc.id, urn: `urn:scp:x:component:${dup}-a` });
      await admin.components.create({ name: dup, service: svc.id, urn: `urn:scp:x:component:${dup}-b` });

      const r = await admin.discovery.backfillSourceMappings(proposalOf([{ objectName: dup, repoPattern: "x/y" }]));
      expect(r.createdSourceMappingIds).toHaveLength(0);
      expect(r.skipped[0]).toMatchObject({ objectName: dup, reason: expect.stringMatching(/ambiguous/) });
    });
  });
});
