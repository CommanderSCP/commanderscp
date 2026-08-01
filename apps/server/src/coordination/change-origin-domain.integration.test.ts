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
 * is what `change-detail.tsx`'s `ForeignOriginNotice` provenance badge (`apps/web/src/lib/replica-
 * origin.tsx`) needs. Proves it's populated with the SAME authoritative value every other typed
 * resource's `GraphObjectSchema.originDomainId` already carries — the real HTTP + SDK round trip,
 * not a unit tautology.
 *
 * GROUNDING FINDING (REMEASURED — see the PR body's measured table): unlike components/services/
 * deployment-targets (whose `GraphObjectSchema.originDomainId` is reachable for a genuine
 * cross-domain READ-ONLY REPLICA — `federation/import-repo.ts`'s plain sync path), a Change
 * specifically has NO live path today where `GET /changes/{id}` returns a foreign `originDomainId`
 * VIA FEDERATION SYNC: `import-repo.ts`'s `object_upsert` handling explicitly documents "Never
 * creates a LOCAL `changes` state-machine row" for a synced change object, and `changes-repo.ts`'s
 * `getChange`/`getChangeRow` REQUIRE that row (an inner join) — so a plain sync-replicated change
 * 404s through the typed Change API entirely. A PROMOTION import (`federation/promotion-repo.ts`'s
 * `applyPromotionImport`) instead calls `proposeChange` fresh (no `federationImport`), so a
 * promoted change's `originDomainId` becomes the RECEIVING domain's own id — control genuinely
 * transfers on promotion, by design, so it is never "foreign" there either.
 *
 * What this field IS used for on `change-detail.tsx`: a `ForeignOriginNotice` provenance badge
 * only. It is still NOT used to disable Accept/Rollback/Cancel — but the REASON changed with S10
 * (PR #171), and the description that used to sit here is now false.
 *
 * WAS: "the `changes` state-machine transitions never route through `updateObject`'s single-writer
 * guard, so there is no server-side refusal for a client-side gate to mirror." That was true, and
 * it was a GAP — the transition verbs were the one authority hole in the system.
 * `coordination/transition.ts`'s `enforceLocalChangeAuthority` closed it: accept, rollback and
 * cancel are all refused with a 409 + `decision_id` on a foreign-origin change, in every state.
 * `foreign-origin-writes.integration.test.ts` now measures those refusals; the "answering
 * identically to a local change" and "SUCCEEDS from validating" cases cited here are gone.
 *
 * IS: the UI stays ungated on origin so the server's 409 and its `decision_id` reach the operator
 * instead of being pre-empted client-side (charter principle 6). The earlier gate removed in
 * `fe05666` was wrong because it simulated an absent enforcement; re-adding one now would be wrong
 * because it would hide a real one.
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
    const component = await createTestComponent(admin, {
      name: `origin-domain-${randomUUID().slice(0, 8)}`
    });
    const change = await admin.changes.propose({
      name: "origin-domain v1",
      targets: [component.id]
    });

    const self = await admin.federation.self();
    expect(change.originDomainId).toBe(self.domainId);

    // Round-trips identically on a fresh GET, not just the propose response.
    const fetched = await admin.changes.get(change.id);
    expect(fetched.originDomainId).toBe(self.domainId);
  });
});
