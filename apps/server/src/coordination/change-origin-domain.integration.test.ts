import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * M16.3 P2 — `Change.originDomainId` is a NEW additive wire field (packages/schemas/src/
 * changes.ts, `changes-repo.ts`'s `toChangeShape`) closing a real gap: before it, the ONLY
 * SDK-reachable domain-identity field on a `Change` was `importedFromDomain` (promotion-bundle
 * provenance only — null for every non-promotion change), so there was no SDK-reachable way for
 * `apps/web` to compare a change's authoritative origin against this instance's own domain, which
 * is what `change-detail.tsx`'s Accept/Rollback/Cancel gating (`apps/web/src/lib/replica-
 * origin.ts`) needs. Proves it's populated with the SAME authoritative value every other typed
 * resource's `GraphObjectSchema.originDomainId` already carries — the real HTTP + SDK round trip,
 * not a unit tautology.
 *
 * GROUNDING FINDING (recorded in the PR body's `surprises`, and worth restating here): unlike
 * components/services/deployment-targets (whose `GraphObjectSchema.originDomainId` is reachable
 * for a genuine cross-domain READ-ONLY REPLICA — `federation/import-repo.ts`'s plain sync path),
 * a Change specifically has NO live path today where `GET /changes/{id}` returns a foreign
 * `originDomainId`: `import-repo.ts`'s `object_upsert` handling explicitly documents "Never
 * creates a LOCAL `changes` state-machine row" for a synced change object, and `changes-repo.ts`'s
 * `getChange`/`getChangeRow` REQUIRE that row (an inner join) — so a plain sync-replicated change
 * 404s through the typed Change API entirely, never reaching `change-detail.tsx`'s render path at
 * all. A PROMOTION import (`federation/promotion-repo.ts`'s `applyPromotionImport`) instead calls
 * `proposeChange` fresh (no `federationImport`), so a promoted change's `originDomainId` becomes
 * the RECEIVING domain's own id — control genuinely transfers on promotion, by design, so it is
 * never "foreign" there either. The Accept/Rollback/Cancel gate this milestone adds is therefore
 * correct, additive, and forward-looking defense-in-depth (and the identical mechanism the
 * `registry-detail.tsx` census below DOES find live, reachable foreign-origin objects for) rather
 * than closing an exploitable hole specific to changes today — see `surprises` in the PR body.
 */
describe("Change.originDomainId (M16.3 P2): the SDK-reachable single-writer-authority field", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "change-origin-domain");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("a locally-proposed change's originDomainId is this instance's own federation domain id", async () => {
    const component = await createTestComponent(admin, { name: `origin-domain-${randomUUID().slice(0, 8)}` });
    const change = await admin.changes.propose({ name: "origin-domain v1", targets: [component.id] });

    const self = await admin.federation.self();
    expect(change.originDomainId).toBe(self.domainId);

    // Round-trips identically on a fresh GET, not just the propose response.
    const fetched = await admin.changes.get(change.id);
    expect(fetched.originDomainId).toBe(self.domainId);
  });
});
