import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
import type { DoctorReport } from "@scp/schemas";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { federationSelf, objects, orgs } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureFederationSelf } from "./self-repo.js";
import {
  describeFederationSelfOriginFinding,
  inspectFederationSelfOrigin,
  warnOnFederationSelfOriginDivergence
} from "./self-origin-check.js";

/**
 * THE SILENT-STOP DETECTOR (federation/self-origin-check.ts).
 *
 * PR #221 made every reconcile candidate query filter on `objects.origin_domain_id =
 * federation_self.domain_id`. That closes a real single-writer hole, but it introduces an exposure
 * the un-filtered loops did not have: if the identity ever stops matching the origins already
 * stamped on an org's objects, every batch returns zero rows and ALL coordination for that org stops
 * with no error and no log line. Indistinguishable from "nothing to do" — the exact shape of the
 * 13-day outage in `coordination/executing-batch-starvation.integration.test.ts`.
 *
 * WHAT MAKES THIS SUITE NON-VACUOUS. Three of the four fixtures below are HEALTHY, and two of them
 * (the single-domain org and the replica-holding federated org) exist specifically to fail if the
 * predicate is widened from "none of this org's objects are mine" to "some of this org's objects are
 * not mine". A partial mismatch IS the normal steady state of a federated estate; a check that warns
 * on it is an alarm operators mute, which is worse than no alarm at all. The divergent fixture alone
 * would go green under a check that simply warned about everything.
 *
 * The assertions on the message deliberately pin the IDS IT MUST CARRY (org, identity, the origins
 * actually present) rather than its prose: an operator who cannot get both sides of the mismatch out
 * of the log line has to reverse-engineer the cause at 2am, and that is a behaviour, not wording.
 */
describe("federation identity divergence: an org orphaned from its own domain id", () => {
  let server: TestServer;

  /** All objects authored locally — the ordinary non-federated instance. */
  let singleDomain: TestOrg;
  /** Locally authored objects PLUS a majority of replicas — an ordinary outpost. MUST stay quiet. */
  let federated: TestOrg;
  /** Objects intact, identity replaced — a partial restore / recreated `federation_self` row. */
  let divergent: TestOrg;
  /** A bare org row with no graph objects at all — nothing to be orphaned from. */
  let emptyOrgId: string;

  /** The peer domain whose replicas the federated org legitimately holds. */
  const PEER = asTrustDomainId(randomUUID());
  /** What `ensureFederationSelf` would mint after the row went missing: a brand-new uuid. */
  const RECREATED_IDENTITY = asTrustDomainId(randomUUID());
  /** The origin the divergent org's objects still carry — i.e. its ORIGINAL identity. */
  let divergentOriginalDomainId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    singleDomain = await createTestOrg(server, "self-origin-single");
    federated = await createTestOrg(server, "self-origin-federated");
    divergent = await createTestOrg(server, "self-origin-divergent");

    // Every org already has locally-authored objects from `ensureBootstrapAdmin` (the `organization`
    // root and the admin's `user`); a couple of components each make the tallies less trivially small.
    for (const org of [singleDomain, federated, divergent]) {
      await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        for (const label of ["alpha", "beta"]) {
          await createObject(tx, {
            orgId: org.orgId,
            typeId: "component",
            actorObjectId: org.orgId,
            requestId: "self-origin-check",
            name: `${label}-${randomUUID()}`,
            properties: {}
          });
        }
      });
    }

    // --- the FEDERATED fixture: a heap of replicas alongside the local rows -------------------
    // Created locally then flipped, which is byte-for-byte the row state `import-repo.ts`'s
    // `object_upsert` branch produces for a peer-authored object (the same surgery
    // `coordination/foreign-origin-campaign.integration.test.ts` uses).
    const replicaIds: string[] = [];
    await withTenantTx(server.deps.db, federated.orgId, async (tx) => {
      for (let i = 0; i < 6; i++) {
        const created = await createObject(tx, {
          orgId: federated.orgId,
          typeId: "component",
          actorObjectId: federated.orgId,
          requestId: "self-origin-check",
          name: `replica-${randomUUID()}`,
          properties: {}
        });
        replicaIds.push(created.id);
      }
    });
    await withTenantTx(server.deps.db, federated.orgId, async (tx) => {
      for (const id of replicaIds) {
        await tx
          .update(objects)
          .set({ originDomainId: PEER })
          .where(and(eq(objects.orgId, federated.orgId), eq(objects.id, id)));
      }
    });

    // --- the DIVERGENT fixture: objects untouched, IDENTITY replaced --------------------------
    // This is the failure as it actually presents in production. The objects are fine; it is
    // `federation_self` that no longer describes them, because it was recreated (self-repo.ts mints
    // a fresh uuidv7 whenever the row is absent) or restored from a different database.
    divergentOriginalDomainId = (
      await withTenantTx(server.deps.db, divergent.orgId, (tx) =>
        ensureFederationSelf(tx, divergent.orgId)
      )
    ).domainId;
    await withTenantTx(server.deps.db, divergent.orgId, (tx) =>
      tx
        .update(federationSelf)
        .set({ domainId: RECREATED_IDENTITY })
        .where(eq(federationSelf.orgId, divergent.orgId))
    );

    // --- the EMPTY fixture: an org row and nothing else ---------------------------------------
    // Never touched by `createObject`, so `federation_self` has no row for it either — which is also
    // the strongest available proof that this check does not lazily mint one (asserted below).
    emptyOrgId = randomUUID();
    await server.deps.db
      .insert(orgs)
      .values({ id: emptyOrgId, name: `self-origin-empty-${emptyOrgId}` });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  function inspect(orgId: string) {
    return withTenantTx(server.deps.db, orgId, (tx) => inspectFederationSelfOrigin(tx, orgId));
  }

  it("fixture check: the three orgs really are in the states this suite claims", async () => {
    expect(
      RECREATED_IDENTITY,
      "the divergent fixture is vacuous if the 'new' identity is the original"
    ).not.toBe(divergentOriginalDomainId);

    const fed = await inspect(federated.orgId);
    expect(fed.selfOriginObjectCount, "the federated org must still own SOME rows").toBeGreaterThan(
      0
    );
    expect(
      fed.foreignOrigins.map((o) => o.domainId),
      "and must genuinely hold replicas, or it is just a single-domain org"
    ).toContain(PEER);
    expect(
      fed.foreignOrigins.reduce((n, o) => n + o.objectCount, 0),
      "replicas should OUTNUMBER local rows — the case a 'some are foreign' predicate gets wrong"
    ).toBeGreaterThan(fed.selfOriginObjectCount);
  });

  it("a healthy SINGLE-DOMAIN org is quiet", async () => {
    const finding = await inspect(singleDomain.orgId);
    expect(finding.diverged).toBe(false);
    expect(finding.liveObjectCount).toBeGreaterThan(0);
    expect(finding.selfOriginObjectCount).toBe(finding.liveObjectCount);
    expect(finding.foreignOrigins).toEqual([]);
  });

  it("a healthy FEDERATED org holding legitimate replicas is quiet", async () => {
    const finding = await inspect(federated.orgId);
    // The point of the whole predicate: a mostly-replica org is a working outpost, not a fault.
    expect(finding.diverged).toBe(false);
  });

  it("an org with no graph objects yet is quiet — and the check does NOT mint an identity for it", async () => {
    const finding = await inspect(emptyOrgId);
    expect(finding.diverged).toBe(false);
    expect(finding.liveObjectCount).toBe(0);
    expect(finding.selfDomainId).toBeNull();

    // READ-ONLY, proven against the database rather than against a comment: `ensureFederationSelf`
    // would have created this row, and a diagnostic that creates the identity it is diagnosing would
    // manufacture the very divergence it exists to report.
    const rows = await withTenantTx(server.deps.db, emptyOrgId, (tx) =>
      tx.select().from(federationSelf).where(eq(federationSelf.orgId, emptyOrgId))
    );
    expect(rows).toHaveLength(0);
  });

  it("a DIVERGENT org is detected, and the message names the org and BOTH ids", async () => {
    const finding = await inspect(divergent.orgId);
    expect(finding.diverged).toBe(true);
    expect(finding.liveObjectCount).toBeGreaterThan(0);
    expect(finding.selfOriginObjectCount).toBe(0);
    expect(finding.selfDomainId).toBe(RECREATED_IDENTITY);
    expect(finding.foreignOrigins.map((o) => o.domainId)).toEqual([divergentOriginalDomainId]);

    const message = describeFederationSelfOriginFinding(finding);
    // Not prose-pinning: these are the four facts an operator cannot act without — which tenant,
    // what the instance believes its identity is, what the objects say it was, and the column to fix.
    expect(message).toContain(divergent.orgId);
    expect(message).toContain(divergent.orgName);
    expect(message).toContain(RECREATED_IDENTITY);
    expect(message).toContain(divergentOriginalDomainId);
    expect(message).toContain("federation_self.domain_id");
  });

  it("the STARTUP check warns once for the divergent org and stays silent about the healthy ones", async () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const count = await warnOnFederationSelfOriginDivergence(server.deps.db, {
      warn: (msg) => warnings.push(msg),
      error: (msg) => errors.push(msg)
    });

    expect(errors).toEqual([]);
    // Scoped to THIS suite's orgs rather than asserting a global count: integration files share a
    // worker database, so an absolute total would be a false failure the day another file runs first.
    const mine = warnings.filter(
      (w) =>
        w.includes(divergent.orgId) ||
        w.includes(singleDomain.orgId) ||
        w.includes(federated.orgId) ||
        w.includes(emptyOrgId)
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain(divergent.orgId);
    expect(count).toBeGreaterThanOrEqual(1);

    // And it changed nothing: the identity it complained about is still exactly as it found it.
    const after = await withTenantTx(server.deps.db, divergent.orgId, (tx) =>
      tx.select().from(federationSelf).where(eq(federationSelf.orgId, divergent.orgId))
    );
    expect(after[0]?.domainId).toBe(RECREATED_IDENTITY);
  });

  it("`GET /doctor` reports the same verdict over the public API (`scp doctor`)", async () => {
    const doctorFor = async (org: TestOrg): Promise<DoctorReport> => {
      const res = await server.app.inject({
        method: "GET",
        url: "/api/v1/doctor",
        headers: { authorization: `Bearer ${org.adminToken}` }
      });
      expect(res.statusCode).toBe(200);
      return res.json() as DoctorReport;
    };

    const healthy = await doctorFor(federated);
    const healthyCheck = healthy.checks.find((c) => c.id === "federation-self-origin");
    expect(healthyCheck?.status).toBe("ok");

    const broken = await doctorFor(divergent);
    const brokenCheck = broken.checks.find((c) => c.id === "federation-self-origin");
    expect(brokenCheck?.status).toBe("warn");
    expect(brokenCheck?.detail).toContain(RECREATED_IDENTITY);
    expect(brokenCheck?.detail).toContain(divergentOriginalDomainId);
  });

  it("`GET /doctor` refuses an unauthenticated caller", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(res.statusCode).toBe(401);
  });
});
