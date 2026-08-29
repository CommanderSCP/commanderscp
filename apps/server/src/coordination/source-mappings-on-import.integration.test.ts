import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import {
  createOrphanComponent,
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

  // THE THREE `accept`-BASED CASES ARE GONE WITH THE ROUTE (ADR-0047). They proved that importing
  // through `discovery/accept` also created a `source_mapping` per component, so an imported
  // component SELF-REPORTED releases instead of merely being triggerable.
  //
  // That property did not disappear — it moved. The scaffolder emits a pipeline carrying the
  // proposal's source mapping (`iac-scaffold-reader.ts`), and applying the manifest creates the
  // mapping through the ordinary `sourceMappings` collection, which `plans.integration.test.ts`'s
  // C1 round trip already covers end to end. What changed is the door, not the guarantee.
  //
  // The BACKFILL cases below stay: `POST /discovery/backfill-source-mappings` survives until the
  // estate migration completes (proposal section 7), because it is how the ~50 already-imported
  // components get mappings without re-importing anything.

  describe("automated backfill", () => {
    const proposalOf = (mappings: Array<{ objectName: string; repoPattern: string }>) =>
      ({
        objects: [],
        relationships: [],
        sourceMappings: mappings.map((m) => ({ ...m, sourceKind: "github" }))
      }) as never;

    it("matches existing components by name, creates mappings, is idempotent, and the component self-reports", async () => {
      // An orphan from BEFORE mappings existed. Made through the harness helper, which writes via
      // `graph/objects-repo.ts` — there is no HTTP door that produces an orphan now that
      // `discovery/accept` is gone, which is the point of removing it.
      const orphan = await createOrphanComponent(server, org, `orphan-${randomUUID().slice(0, 8)}`);
      const name = orphan.name;
      const repo = `acme/${randomUUID().slice(0, 8)}`;

      // Backfill from a fresh proposal's sourceMappings → matched by name, mapping created.
      const first = await admin.discovery.backfillSourceMappings(
        proposalOf([{ objectName: name, repoPattern: repo }])
      );
      expect(first.createdSourceMappingIds).toHaveLength(1);
      expect(first.skipped).toHaveLength(0);

      // The backfilled component now self-reports — a github push to its repo correlates to a Change.
      expect(await reportAndProcess("github", repo)).not.toBeNull();

      // Re-running is a no-op: the identical mapping is skipped ("already mapped"), not duplicated.
      const second = await admin.discovery.backfillSourceMappings(
        proposalOf([{ objectName: name, repoPattern: repo }])
      );
      expect(second.createdSourceMappingIds).toHaveLength(0);
      expect(second.skipped[0]).toMatchObject({
        objectName: name,
        reason: expect.stringMatching(/already mapped/)
      });
    });

    it("skips (never silently drops) a mapping whose component doesn't exist", async () => {
      const ghost = `ghost-${randomUUID().slice(0, 8)}`;
      const r = await admin.discovery.backfillSourceMappings(
        proposalOf([{ objectName: ghost, repoPattern: "x/y" }])
      );
      expect(r.createdSourceMappingIds).toHaveLength(0);
      expect(r.skipped[0]).toMatchObject({
        objectName: ghost,
        reason: expect.stringMatching(/no live component/)
      });
    });

    it("skips an ambiguous name (more than one live component)", async () => {
      const dup = `dup-${randomUUID().slice(0, 8)}`;
      const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
      // Two live components share a name via explicit distinct URNs (the strict route allows a urn).
      await admin.components.create({
        name: dup,
        service: svc.id,
        urn: `urn:scp:x:component:${dup}-a`
      });
      await admin.components.create({
        name: dup,
        service: svc.id,
        urn: `urn:scp:x:component:${dup}-b`
      });

      const r = await admin.discovery.backfillSourceMappings(
        proposalOf([{ objectName: dup, repoPattern: "x/y" }])
      );
      expect(r.createdSourceMappingIds).toHaveLength(0);
      expect(r.skipped[0]).toMatchObject({
        objectName: dup,
        reason: expect.stringMatching(/ambiguous/)
      });
    });
  });
});
