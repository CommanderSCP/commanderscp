import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { GeneratedKeyPair } from "@scp/cosign";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { DECLARED_COMMANDER } from "../test-support/federation-roles.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { instanceCosignKeys } from "../db/schema.js";
import { ensureInstanceCosignKey } from "../governance/cosign-keys.js";

/** COSIGN KEY CUSTODY (owner, 2026-09-16; docs/proposals/component-journey-view.md §8.9): only the
 *  commander (promotion manifests) and a retrans (relay transport integrity) hold an instance cosign
 *  key. Entered at the two routes that mint on first use — `GET /federation/self` and
 *  `GET /federation/status` — on four deployments differing ONLY in SCP_FEDERATION_ROLE. On an
 *  outpost or an undeclared deployment both answer 200 with `cosignPublicKey: null` (the field is
 *  nullable — a stated absence, no contract change) and mint nothing. */

/** Minting runs the real cosign subprocess unless faked; custody, not key validity, is under test. */
async function fakeGenerator(): Promise<GeneratedKeyPair> {
  return {
    privateKeyPem:
      "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\nFAKE-CUSTODY\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----\n",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nFAKE-CUSTODY\n-----END PUBLIC KEY-----\n"
  };
}

async function keyRows(server: TestServer, orgId: string) {
  return withTenantTx(server.deps.db, orgId, (tx) =>
    tx.select().from(instanceCosignKeys).where(eq(instanceCosignKeys.orgId, orgId))
  );
}

async function selfKey(server: TestServer, org: TestOrg): Promise<string | null | undefined> {
  const res = await server.app.inject({
    method: "GET",
    url: "/api/v1/federation/self",
    headers: { authorization: `Bearer ${org.adminToken}` }
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { cosignPublicKey?: string | null }).cosignPublicKey;
}

async function statusKey(server: TestServer, org: TestOrg): Promise<string | null | undefined> {
  const res = await server.app.inject({
    method: "GET",
    url: "/api/v1/federation/status",
    headers: { authorization: `Bearer ${org.adminToken}` }
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { self?: { cosignPublicKey?: string | null } }).self?.cosignPublicKey;
}

describe("instance cosign key custody at the routes (§8.9, owner 2026-09-16)", () => {
  let commander: TestServer;
  let retrans: TestServer;
  let outpost: TestServer;
  let undeclared: TestServer;

  beforeAll(async () => {
    [commander, retrans, outpost, undeclared] = await Promise.all([
      buildTestServer({ federationRole: "commander" }),
      buildTestServer({ federationRole: "retrans" }),
      buildTestServer({ federationRole: "outpost" }),
      buildTestServer()
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([
      commander?.close(),
      retrans?.close(),
      outpost?.close(),
      undeclared?.close()
    ]);
  });

  it("a declared COMMANDER mints on first read and serves the key from self and status", async () => {
    const org = await createTestOrg(commander, "custody-commander");
    expect(await keyRows(commander, org.orgId)).toHaveLength(0);
    const fromSelf = await selfKey(commander, org);
    expect(fromSelf).toContain("PUBLIC KEY");
    expect(await statusKey(commander, org)).toBe(fromSelf);
    expect(await keyRows(commander, org.orgId)).toHaveLength(1);
  }, 60_000);

  it("a declared RETRANS still mints — it signs the transport integrity of the bytes it relays", async () => {
    const org = await createTestOrg(retrans, "custody-retrans");
    const fromSelf = await selfKey(retrans, org);
    expect(fromSelf).toContain("PUBLIC KEY");
    expect(await keyRows(retrans, org.orgId)).toHaveLength(1);
  }, 60_000);

  it("a declared OUTPOST mints NOTHING: self and status answer 200 with cosignPublicKey null", async () => {
    const org = await createTestOrg(outpost, "custody-outpost");
    expect(await selfKey(outpost, org)).toBeNull();
    expect(await statusKey(outpost, org)).toBeNull();
    // And the minting function itself refuses, for any caller that is not one of these routes.
    await expect(
      ensureInstanceCosignKey(outpost.deps.db, org.orgId, outpost.deps.config, fakeGenerator)
    ).rejects.toMatchObject({ status: 409 });
    expect(await keyRows(outpost, org.orgId)).toHaveLength(0);
  }, 60_000);

  it("an UNDECLARED deployment mints NOTHING (fail-closed), though its role reads 'commander'", async () => {
    expect(undeclared.deps.config.federationRole).toBe("commander");
    expect(undeclared.deps.config.federationRoleDeclared).toBe(false);
    const org = await createTestOrg(undeclared, "custody-undeclared");
    expect(await selfKey(undeclared, org)).toBeNull();
    expect(await statusKey(undeclared, org)).toBeNull();
    await expect(
      ensureInstanceCosignKey(undeclared.deps.db, org.orgId, undeclared.deps.config, fakeGenerator)
    ).rejects.toMatchObject({ status: 409, detail: expect.stringContaining("FAIL-CLOSED") });
    expect(await keyRows(undeclared, org.orgId)).toHaveLength(0);
  }, 60_000);

  it("an outpost's PRE-EXISTING key is kept in storage, but neither served nor usable for signing", async () => {
    const org = await createTestOrg(outpost, "custody-outpost-legacy");
    // A key minted before the rule existed — the only way to have one now is a commander-declared call.
    const legacy = await ensureInstanceCosignKey(
      outpost.deps.db,
      org.orgId,
      DECLARED_COMMANDER,
      fakeGenerator
    );
    expect(await selfKey(outpost, org)).toBeNull();
    expect(await statusKey(outpost, org)).toBeNull();
    await expect(
      ensureInstanceCosignKey(outpost.deps.db, org.orgId, outpost.deps.config, fakeGenerator)
    ).rejects.toMatchObject({ status: 409, detail: expect.stringContaining("'outpost'") });
    // Untouched: this change never deletes key material.
    const rows = await keyRows(outpost, org.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.publicKey).toBe(legacy.publicKey);
  }, 60_000);
});
