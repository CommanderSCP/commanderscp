import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrustDomainId } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  activeAuthorityForDomain,
  createAuthority,
  recordIssuance,
  reconcileSerials
} from "./ssh-ca-repo.js";

/**
 * M27.5 storage, against a real database — the constraints here are the control, not the comments.
 *
 * ADR-0051 D2 (one active CA per domain) and D5 (every issuance recorded, so an unrecorded serial
 * is forgery) are both enforced by the schema. A test that only exercised the repo functions would
 * pass against a schema missing the index that actually holds the line.
 */
describe("ssh CA storage (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  const domainA = randomUUID() as TrustDomainId;
  const domainB = randomUUID() as TrustDomainId;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "ssh-ca");
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  it("stores an active CA per domain and reads it back", async () => {
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await createAuthority(tx, {
        orgId: org.orgId,
        domainId: domainA,
        publicKey: "ssh-ed25519 AAAA-domain-a",
        privateKeySecretKey: "ssh-ca/domain-a"
      });
      const found = await activeAuthorityForDomain(tx, org.orgId, domainA);
      expect(found?.publicKey).toBe("ssh-ed25519 AAAA-domain-a");
      // The private key is a REFERENCE, never the material — a row leak must not be a key leak.
      expect(found?.privateKeySecretKey).toBe("ssh-ca/domain-a");
      expect(JSON.stringify(found)).not.toContain("BEGIN PRIVATE KEY");
    });
  });

  it("REFUSES a second active CA for the same domain", async () => {
    // ADR-0051 D2's "never two things minting at once", enforced by the partial unique index. A
    // race between two callers must end as a write failure, not as two CAs.
    await expect(
      withTenantTx(server.deps.db, org.orgId, async (tx) => {
        await createAuthority(tx, {
          orgId: org.orgId,
          domainId: domainA,
          publicKey: "ssh-ed25519 AAAA-domain-a-second",
          privateKeySecretKey: "ssh-ca/domain-a-2"
        });
      })
    ).rejects.toThrow();
  });

  it("a different domain gets its own CA — the bound is per domain, not global", async () => {
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await createAuthority(tx, {
        orgId: org.orgId,
        domainId: domainB,
        publicKey: "ssh-ed25519 AAAA-domain-b",
        privateKeySecretKey: "ssh-ca/domain-b"
      });
      expect((await activeAuthorityForDomain(tx, org.orgId, domainB))?.publicKey).toBe(
        "ssh-ed25519 AAAA-domain-b"
      );
      // And domain A's CA is untouched — a fleet-wide CA would have collided here.
      expect((await activeAuthorityForDomain(tx, org.orgId, domainA))?.publicKey).toBe(
        "ssh-ed25519 AAAA-domain-a"
      );
    });
  });

  it("names a serial SCP never issued as unrecognised, and one it did as known", async () => {
    const issuedSerial = "8123456789012345678";
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await recordIssuance(tx, {
        orgId: org.orgId,
        authorityName: "scp-ca",
        serial: issuedSerial,
        keyId: "scp-ops:scp-ops:8123456789012345678",
        principals: ["scp-ops"],
        targetHosts: ["10.0.0.7"],
        expiresAt: new Date(Date.now() + 300_000)
      });

      const verdicts = await reconcileSerials(tx, org.orgId, [issuedSerial, "999-forged"]);
      // A VERDICT PER INPUT, not a filtered list: the caller must tell "checked and recognised"
      // from "checked and not recognised", which an empty match list makes indistinguishable.
      expect(verdicts).toHaveLength(2);
      expect(verdicts.find((v) => v.serial === issuedSerial)?.unrecognised).toBe(false);
      expect(verdicts.find((v) => v.serial === "999-forged")?.unrecognised).toBe(true);
    });
  });

  it("records a BYO issuance too, so the stronger path is not the blind spot", async () => {
    // A Vault-issued certificate has no authorityId — SCP holds no key that minted it — but the
    // reconciliation question is "did SCP cause this to exist?", and it did.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await recordIssuance(tx, {
        orgId: org.orgId,
        authorityName: "vault-ssh",
        serial: "scp-local:byo-1",
        keyId: "run-byo",
        principals: ["scp-ops"],
        targetHosts: ["10.0.0.8"],
        expiresAt: new Date(Date.now() + 300_000)
      });
      const [verdict] = await reconcileSerials(tx, org.orgId, ["scp-local:byo-1"]);
      expect(verdict?.unrecognised).toBe(false);
      expect(verdict?.authorityName).toBe("vault-ssh");
    });
  });

  it("refuses to record the same serial twice", async () => {
    // Without this, one certificate could appear as two issuances and a reconciliation would still
    // call it recognised — but the evidence trail would be wrong about what happened.
    await expect(
      withTenantTx(server.deps.db, org.orgId, async (tx) => {
        await recordIssuance(tx, {
          orgId: org.orgId,
          authorityName: "scp-ca",
          serial: "8123456789012345678",
          keyId: "duplicate",
          principals: ["scp-ops"],
          targetHosts: ["10.0.0.7"],
          expiresAt: new Date(Date.now() + 300_000)
        });
      })
    ).rejects.toThrow();
  });
});
