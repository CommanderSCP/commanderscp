import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  type TestServer,
  type TestOrg
} from "../test-support/harness.js";

/** THE RETRANS INIT DOOR. See docs/federation.md §291. */
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
