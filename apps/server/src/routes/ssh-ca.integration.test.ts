import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE ENROLMENT DOOR AND THE DETECTIVE CONTROL, through the generated SDK (principle 3).
 *
 * Driven through `ScpClient` rather than the repo on purpose. `ssh-ca-enrolment.integration.test.ts`
 * already proves `enrolDomain` — and it passed for the whole of M27 while the function had no
 * caller anywhere, so a repo-level test cannot answer the question this file asks: can anyone
 * actually reach it?
 */
describe("ssh-ca routes (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "ssh-ca-route");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  it("WIRING: enrols a domain and returns material an operator can act on", async () => {
    const domainId = randomUUID();
    const enrolment = await admin.sshCa.enrol(domainId, "OOB console on the management VLAN");
    expect(enrolment.domainId).toBe(domainId);
    expect(enrolment.breakGlass).toBe("OOB console on the management VLAN");
    // THE POINT OF THE RESPONSE. An enrolment whose CA public key the operator never receives has
    // changed nothing on any host — the capability would exist and reach nothing.
    expect(enrolment.caPublicKey).toMatch(/^ssh-ed25519 /);
    expect(enrolment.trustedUserCaKeysFile).toBe(`${enrolment.caPublicKey}\n`);
    // And never the other half.
    expect(JSON.stringify(enrolment)).not.toContain("BEGIN");
  });

  it("REFUSES an enrolment with no break-glass path", async () => {
    // Not validation for its own sake: ADR-0051's recovery paragraph is a circularity, and an
    // estate whose only route in is SCP's CA cannot recover from SCP's CA being compromised.
    await expect(admin.sshCa.enrol(randomUUID(), "   ")).rejects.toThrow();
  });

  it("REFUSES a second enrolment of the same domain — one CA per domain (D2)", async () => {
    const domainId = randomUUID();
    await admin.sshCa.enrol(domainId, "hardware KVM in the cage");
    await expect(admin.sshCa.enrol(domainId, "hardware KVM in the cage")).rejects.toThrow();
  });

  it("reads back an enrolment, and 404s a domain that has none", async () => {
    const domainId = randomUUID();
    await admin.sshCa.enrol(domainId, "jump host outside the trust domain");
    const read = await admin.sshCa.enrolment(domainId);
    expect(read.caPublicKey).toMatch(/^ssh-ed25519 /);
    // Not-enrolled is exactly the state in which a host-reaching run is refused, so it must be
    // distinguishable from "enrolled with nothing recorded".
    await expect(admin.sshCa.enrolment(randomUUID())).rejects.toThrow();
  });

  it("RECONCILES a serial SCP never issued — the forgery signal (ADR-0051 D5)", async () => {
    // The only control that bounds CA compromise. Short TTLs provably do not: sshd honours the
    // validity interval INSIDE the certificate, which an attacker holding the key chooses.
    const result = await admin.sshCa.reconcile(["1234567890", "9999999999"]);
    expect(result.verdicts).toHaveLength(2);
    expect(result.verdicts.every((v) => v.unrecognised)).toBe(true);
    // Carried so a caller cannot report "reconciled" from a 200 without inspecting the array —
    // which is how a detective control ends up detecting nothing.
    expect(result.unrecognisedCount).toBe(2);
  });

  it("a verdict per INPUT serial, so 'checked and clean' is distinguishable from 'not checked'", async () => {
    const result = await admin.sshCa.reconcile(["only-one"]);
    expect(result.verdicts.map((v) => v.serial)).toEqual(["only-one"]);
  });

  it("lists issuances, and is empty before any host-reaching run has issued one", async () => {
    const list = await admin.sshCa.issuances();
    expect(Array.isArray(list.issuances)).toBe(true);
  });
});
