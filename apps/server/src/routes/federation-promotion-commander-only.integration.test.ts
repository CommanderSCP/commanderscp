import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { instanceCosignKeys } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { pairPeer } from "../federation/peers-repo.js";
import { exportPromotionBundle } from "../federation/promotion-repo.js";
import { DECLARED_RETRANS } from "../test-support/federation-roles.js";

/** SCAN AND SIGN RUN ON THE COMMANDER ONLY (docs/proposals/component-journey-view.md §8.9).
 *
 *  Entered at the outermost layer — the HTTP route — on four deployments that differ ONLY in
 *  SCP_FEDERATION_ROLE. Each gets the same fixture: an org whose bootstrap admin holds
 *  `federation:write`, a paired peer, and a metadata-only change (nothing to scan, so the export
 *  reaches the signature on a commander without a scan runner). The refused cases also assert that
 *  NO cosign key was minted for the org: the export mints on first use, so a guard placed after that
 *  point would still leave an outpost holding a signing key. */

interface Fixture {
  org: TestOrg;
  peerName: string;
  changeId: string;
}

async function fixture(server: TestServer, label: string): Promise<Fixture> {
  const org = await createTestOrg(server, label);
  const peerName = `peer-${randomUUID().slice(0, 8)}`;
  const { publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" }
  }) as unknown as { publicKey: Buffer };
  await withTenantTx(server.deps.db, org.orgId, async (tx) => {
    await ensureFederationSelf(tx, org.orgId);
    await pairPeer(tx, {
      orgId: org.orgId,
      domainId: asTrustDomainId(randomUUID()),
      name: peerName,
      role: "outpost",
      publicKey: publicKey.toString("base64")
    });
  });
  const target = await withTenantTx(server.deps.db, org.orgId, (tx) =>
    createObject(tx, {
      orgId: org.orgId,
      domainId: null,
      typeId: "service",
      actorObjectId: org.orgId,
      requestId: `sign-target-${randomUUID()}`,
      name: `sign-target-${randomUUID()}`
    })
  );
  const { change } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
    proposeChange(tx, {
      orgId: org.orgId,
      actorObjectId: org.orgId,
      requestId: `sign-change-${randomUUID()}`,
      name: `sign-${randomUUID()}`,
      targets: [target.id],
      type: "configuration",
      sourceRef: {}
    })
  );
  return { org, peerName, changeId: change.id };
}

async function exportPromotion(server: TestServer, f: Fixture) {
  return server.app.inject({
    method: "POST",
    url: "/api/v1/federation/exports/promotion",
    headers: { authorization: `Bearer ${f.org.adminToken}` },
    payload: { peer: f.peerName, change: f.changeId }
  });
}

async function cosignKeyRows(server: TestServer, orgId: string) {
  return withTenantTx(server.deps.db, orgId, (tx) =>
    tx.select().from(instanceCosignKeys).where(eq(instanceCosignKeys.orgId, orgId))
  );
}

describe("POST /federation/exports/promotion is COMMANDER-ONLY (§8.9)", () => {
  let commander: TestServer;
  let outpost: TestServer;
  let retrans: TestServer;
  let undeclared: TestServer;

  beforeAll(async () => {
    [commander, outpost, retrans, undeclared] = await Promise.all([
      buildTestServer({ federationRole: "commander" }),
      buildTestServer({ federationRole: "outpost" }),
      buildTestServer({ federationRole: "retrans" }),
      buildTestServer()
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([
      commander?.close(),
      outpost?.close(),
      retrans?.close(),
      undeclared?.close()
    ]);
  });

  it("a declared COMMANDER exports and cosign-signs the manifest (the positive control)", async () => {
    const f = await fixture(commander, "sign-commander");
    expect(await cosignKeyRows(commander, f.org.orgId)).toHaveLength(0);

    const res = await exportPromotion(commander, f);
    expect(res.statusCode, res.body).toBe(200);
    const bundle = res.json() as { manifestSignature?: string; promotionManifest?: unknown };
    expect(bundle.promotionManifest).toBeTruthy();
    expect(bundle.manifestSignature).toBeTruthy();
    // Signed with THIS org's key, minted by the export on first use.
    expect(await cosignKeyRows(commander, f.org.orgId)).toHaveLength(1);
  }, 60_000);

  it("a declared OUTPOST is refused 409 — naming the role — and mints NO cosign key", async () => {
    const f = await fixture(outpost, "sign-outpost");
    const res = await exportPromotion(outpost, f);
    // 409 not 403: the caller is the org's bootstrap admin and holds federation:write; what is wrong
    // is the deployment.
    expect(res.statusCode, res.body).toBe(409);
    const detail = (res.json() as { detail?: string }).detail ?? "";
    expect(detail).toContain("'outpost'");
    expect(detail).toMatch(/COMMANDER-ONLY/);
    expect(detail).toMatch(/signed promotion bundle/);
    expect(await cosignKeyRows(outpost, f.org.orgId)).toHaveLength(0);
  }, 60_000);

  it("a declared RETRANS is refused 409 and mints NO cosign key through this path", async () => {
    const f = await fixture(retrans, "sign-retrans");
    const res = await exportPromotion(retrans, f);
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { detail?: string }).detail ?? "").toContain("'retrans'");
    expect(await cosignKeyRows(retrans, f.org.orgId)).toHaveLength(0);
  }, 60_000);

  it("a deployment that never DECLARED its role is refused FAIL-CLOSED, though its role reads 'commander'", async () => {
    // The trap the guard exists for: undeclared DEFAULTS to commander.
    expect(undeclared.deps.config.federationRole).toBe("commander");
    expect(undeclared.deps.config.federationRoleDeclared).toBe(false);

    const f = await fixture(undeclared, "sign-undeclared");
    const res = await exportPromotion(undeclared, f);
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { detail?: string }).detail ?? "").toMatch(/not declared.*FAIL-CLOSED/);
    expect(await cosignKeyRows(undeclared, f.org.orgId)).toHaveLength(0);
  }, 60_000);

  it("BELOW the route: exportPromotionBundle itself refuses a non-commander declaration and mints nothing", async () => {
    // Any future caller that skips the route (a loop, a CLI-side server path) meets the same rule.
    const f = await fixture(commander, "sign-repo-door");
    await expect(
      exportPromotionBundle(commander.deps.db, {
        federation: DECLARED_RETRANS,
        orgId: f.org.orgId,
        peerIdOrName: f.peerName,
        changeIdOrUrn: f.changeId
      })
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(/'retrans'.*COMMANDER-ONLY/)
    });
    expect(await cosignKeyRows(commander, f.org.orgId)).toHaveLength(0);
  }, 60_000);
});
