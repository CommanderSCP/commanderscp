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
  BreakGlassRequired,
  activeAuthorityForDomain,
  enrolDomain,
  enrolmentForDomain
} from "./ssh-ca-repo.js";

/**
 * M27.8 — ADR-0051's recovery precondition, enforced rather than documented.
 *
 * The ADR's blast-radius analysis ends on a circularity: an estate whose ONLY access route is SCP's
 * CA cannot recover from that CA being compromised, because revocation is a fleet-wide push and the
 * push needs access. The consequence it draws is that an independent access path must be a
 * PRECONDITION OF ENROLMENT. This is where that becomes a refusal.
 */
describe("ssh CA enrolment (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  const subject = randomUUID();

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "ssh-ca-enrol");
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  function enrol(domainId: TrustDomainId, breakGlass: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      enrolDomain(tx, {
        orgId: org.orgId,
        domainId,
        publicKey: "ssh-ed25519 AAAA-ca",
        privateKeySecretKey: `ssh-ca/${domainId}`,
        breakGlass,
        recordedBySubjectId: subject
      })
    );
  }

  it("enrols a domain and keeps the recovery story beside the credential", async () => {
    const domain = randomUUID() as TrustDomainId;
    const { authorityId } = await enrol(domain, "iDRAC on the management VLAN, creds in the safe");
    const enrolment = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      enrolmentForDomain(tx, org.orgId, domain)
    );
    expect(enrolment?.authorityId).toBe(authorityId);
    expect(enrolment?.breakGlass).toContain("iDRAC");
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "   \n\t "]
  ])("REFUSES enrolment when the break-glass path is %s", async (_label, breakGlass) => {
    const domain = randomUUID() as TrustDomainId;
    await expect(enrol(domain, breakGlass)).rejects.toThrow(/independent access path/);
  });

  it("a REFUSED enrolment leaves NO certificate authority behind", async () => {
    // The two writes share a transaction precisely so this cannot happen. Split across two calls,
    // the CA could exist while the recovery story was forgotten — which is exactly the estate
    // ADR-0051 describes as unrecoverable, created by the code meant to prevent it.
    const domain = randomUUID() as TrustDomainId;
    await expect(enrol(domain, "")).rejects.toThrow(BreakGlassRequired);
    const ca = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      activeAuthorityForDomain(tx, org.orgId, domain)
    );
    expect(ca).toBeUndefined();
  });

  it("refuses a SECOND enrolment for a domain already enrolled", async () => {
    // Two enrolments would mean two CAs minting for one segment. The partial unique index on the
    // authorities table forbids that; this asserts the enrolment door reports it rather than
    // leaving a half-written pair.
    const domain = randomUUID() as TrustDomainId;
    await enrol(domain, "serial console via the OOB switch");
    await expect(enrol(domain, "serial console via the OOB switch")).rejects.toThrow();
  });

  it("a domain with no enrolment reads as not enrolled, rather than as an error", async () => {
    // "Not enrolled" is an ordinary state — most domains never use the SCP-CA path at all, because
    // ADR-0051 D1 makes BYO the default.
    const enrolment = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      enrolmentForDomain(tx, org.orgId, randomUUID() as TrustDomainId)
    );
    expect(enrolment).toBeUndefined();
  });
});
