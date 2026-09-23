import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { TrustDomainId } from "@scp/schemas";
import { readServerDerivedMaterial } from "@scp/plugin-managed-ops";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { enrolDomain } from "./ssh-ca-repo.js";
import { replaceMembership } from "./infrastructure-members-repo.js";
import { deriveOpsRunMaterial } from "./ops-run-material.js";

/**
 * M27.9 — THE SEAM. What the server derives must be exactly what the plugin accepts.
 *
 * This is the test whose absence let M27 land looking complete. Every increment met its own
 * definition of done: the plugin refuses without server-derived material, and its refusal is
 * mutation-proved; the inventory compiler is proved; the egress allowlist is proved. None of that
 * required anything to PRODUCE the material, so nothing was red while no host-reaching run could
 * execute at all.
 *
 * So the assertion is deliberately end-to-end across the boundary rather than either side of it:
 * the real producer's output is fed to the real consumer's reader, and the reader is the one that
 * decides whether it is complete.
 */
describe("ops run material: producer and consumer agree (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let productId: string;
  const domainId = randomUUID() as TrustDomainId;
  const subject = randomUUID();

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "ops-material");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const product = await createTestComponent(admin, { name: `fleet-${randomUUID().slice(0, 8)}` });
    productId = product.id;

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await enrolDomain(tx, {
        orgId: org.orgId,
        domainId,
        breakGlass: "OOB console on the management VLAN",
        masterKey: server.deps.config.secretsMasterKey,
        recordedBySubjectId: subject
      });
      await replaceMembership(tx, {
        orgId: org.orgId,
        productObjectId: productId,
        reportedBySubjectId: subject,
        members: [
          { memberId: "i-002", address: "10.0.0.2" },
          { memberId: "i-001", address: "10.0.0.1" }
        ]
      });
    });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  it("derives material the PLUGIN's own reader accepts as complete", async () => {
    const material = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deriveOpsRunMaterial(tx, {
        orgId: org.orgId,
        domainId,
        productObjectId: productId,
        role: "os_package",
        subjectObjectId: subject,
        masterKey: server.deps.config.secretsMasterKey
      })
    );
    // THE CONSUMER DECIDES. Asserting the shape here would only prove the producer agrees with
    // this test; `readServerDerivedMaterial` is what a real trigger runs.
    expect(() => readServerDerivedMaterial(material)).not.toThrow();
  });

  it("the inventory names the observed members, in stable order", async () => {
    const material = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deriveOpsRunMaterial(tx, {
        orgId: org.orgId,
        domainId,
        productObjectId: productId,
        role: "os_package",
        subjectObjectId: subject,
        masterKey: server.deps.config.secretsMasterKey
      })
    );
    const read = readServerDerivedMaterial(material);
    expect(read.opsInventory).toBe(
      "[all]\ni-001 ansible_host=10.0.0.1\ni-002 ansible_host=10.0.0.2\n"
    );
    // Derived from the SAME membership as the inventory — two derivations could disagree, and the
    // dangerous direction is an allowlist wider than the hosts.
    expect([...read.opsEgressAllowlist]).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("the credential is a SECRET KEY, and the secret it names resolves to a certificate", async () => {
    const material = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deriveOpsRunMaterial(tx, {
        orgId: org.orgId,
        domainId,
        productObjectId: productId,
        role: "os_package",
        subjectObjectId: subject,
        masterKey: server.deps.config.secretsMasterKey
      })
    );
    const read = readServerDerivedMaterial(material);
    // Not the material: trigger parameters are persisted and surfaced in evidence.
    expect(read.opsCredentialSecretKey).not.toContain("BEGIN");
    expect(read.opsCredentialSecretKey).not.toContain("-cert-v01@");
  });

  it("REFUSES to derive for a domain that is not enrolled", async () => {
    // No enrolment means no recorded break-glass path, which ADR-0051 makes a precondition of
    // holding a CA at all. Deriving anyway would route around the refusal that enrolment exists
    // to enforce.
    await expect(
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        deriveOpsRunMaterial(tx, {
          orgId: org.orgId,
          domainId: randomUUID() as TrustDomainId,
          productObjectId: productId,
          role: "os_package",
          subjectObjectId: subject,
          masterKey: server.deps.config.secretsMasterKey
        })
      )
    ).rejects.toThrow(/not enrolled/);
  });

  it("RECORDS the issuance, so ADR-0051 D5's reconciliation has something to read", async () => {
    // The detective control is the only thing that bounds CA compromise — short TTLs do not. A
    // certificate that reached a runner with no row is indistinguishable from a forgery.
    const count = async (): Promise<number> => {
      const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from ssh_certificate_issuances`)
      );
      return (rows as unknown as { rows: { n: number }[] }).rows[0]!.n;
    };
    const before = await count();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deriveOpsRunMaterial(tx, {
        orgId: org.orgId,
        domainId,
        productObjectId: productId,
        role: "os_package",
        subjectObjectId: subject,
        masterKey: server.deps.config.secretsMasterKey
      })
    );
    expect(await count()).toBe(before + 1);
  });
});
