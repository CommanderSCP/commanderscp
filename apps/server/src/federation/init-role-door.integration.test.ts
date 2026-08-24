import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  type TestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * THE RETRANS INIT DOOR (owner decision 2026-08-24) — `POST /federation/init` refuses `retrans`
 * unless the DEPLOYMENT declares it
 * ================================================================================================
 * An org whose `federation_self.role` is `retrans` activates relay machinery and flips that org's
 * dependencyManagement to `managedHere: false`. Correct at a CDS boundary; a stray config anywhere
 * else. The deployment is the arbiter: `SCP_FEDERATION_ROLE=retrans` is the same install-time axis
 * that withholds the SPA (`retrans-no-spa.integration.test.ts`), so the door keys on
 * `config.federationRole`, not on anything a tenant can write.
 *
 * BOTH ARMS ON PURPOSE (vacuous-test discipline): the refusal arm asserts the door's OWN sentence
 * (an outcome only this check produces — a 400 from schema validation would read differently), and
 * the acceptance arm proves the door keys on the deployment profile rather than refusing retrans
 * everywhere. MUTATION-PROVEN (reported in the PR body): with the guard in `routes/federation.ts`
 * deleted, the refusal arm goes RED (200 where 400 was pinned).
 */
describe("POST /federation/init: the retrans role door", () => {
  describe("on a non-retrans deployment (default commander profile)", () => {
    let server: TestServer;
    let org: TestOrg;

    beforeAll(async () => {
      server = await buildTestServer();
      org = await createTestOrg(server, "init-door-commander");
    });
    afterAll(async () => {
      await server.close();
    });

    function authHeader(token: string): Record<string, string> {
      return { authorization: `Bearer ${token}` };
    }

    it("refuses role=retrans with the door's own sentence, and writes nothing", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/v1/federation/init",
        headers: authHeader(org.adminToken),
        payload: { name: "stray-retrans", role: "retrans" }
      });
      expect(res.statusCode, res.body).toBe(400);
      // The door's OWN refusal, not a generic validation 400 — the wire enum still carries
      // "retrans", so schema validation cannot be what refused it.
      expect(res.body).toContain("SCP_FEDERATION_ROLE=retrans");
      expect(res.body).toContain("this deployment: 'commander'");

      // Nothing was written: the identity is still un-initialized (role unset), so the refused
      // call left no partial state for a later init to trip over.
      const self = await server.app.inject({
        method: "GET",
        url: "/api/v1/federation/self",
        headers: authHeader(org.adminToken)
      });
      expect(self.statusCode, self.body).toBe(200);
      expect(self.json().role).toBe("unset");
    });

    it("still accepts commander and outpost — the door is exactly as narrow as its sentence", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/v1/federation/init",
        headers: authHeader(org.adminToken),
        payload: { name: "hq", role: "outpost" }
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().role).toBe("outpost");
    });
  });

  describe("on a retrans deployment (SCP_FEDERATION_ROLE=retrans)", () => {
    it("accepts role=retrans — the door keys on the deployment profile, not the value", async () => {
      const server = await buildTestServer({ federationRole: "retrans" });
      try {
        const org = await createTestOrg(server, "init-door-retrans");
        const res = await server.app.inject({
          method: "POST",
          url: "/api/v1/federation/init",
          headers: { authorization: `Bearer ${org.adminToken}` },
          payload: { name: "cds-edge", role: "retrans" }
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().role).toBe("retrans");
      } finally {
        await server.close();
      }
    });
  });
});
