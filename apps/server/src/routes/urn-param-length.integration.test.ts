import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { URN_MAX_PARAM_LENGTH } from "../http-limits.js";

/**
 * Defect 1 (measured live 2026-09-19): EVERY `:idOrUrn`/`:urn` route param can carry a
 * percent-encoded object URN, but Fastify/find-my-way's default `maxParamLength` (100 chars) 414s
 * a real one before its Zod schema ever runs — reproduced live against
 * `DELETE /api/v1/executors/{urn}/binding` with a placement URN. See http-limits.ts's
 * `URN_MAX_PARAM_LENGTH` for the fix and its derivation, and app.ts's `frameworkErrors` wiring for
 * why the over-long case now answers `application/problem+json` instead of a bare 414 body.
 *
 * Both cases below are asserted at the HTTP layer via `app.inject()`, which drives the SAME
 * find-my-way router a real request would (routing happens before any transport concern), exactly
 * as `error-handler-status.test.ts` and `host-bootstrap.integration.test.ts` already do for other
 * framework-raised errors.
 */
describe("URN-addressed route params past Fastify's default maxParamLength (100 chars)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "urn-param-length");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  it("a real placement URN longer than 100 encoded chars reaches its handler and answers normally", async () => {
    // The exact live shape that 414'd in production: a placement URN built from a realistic
    // component name and stage name, joined by '/' — encodeURIComponent's escaping of the URN's
    // colons and that slash pushes it well past 100 chars long before any pathological input is
    // involved.
    const component = await createTestComponent(admin, {
      name: "homelab-agentkit-linux-general-runner"
    });
    const target = await admin.deploymentTargets.create({ name: "gamma-self-host-canary" });
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: target.id
    });

    const encoded = encodeURIComponent(placement.urn);
    expect(encoded.length).toBeGreaterThan(100);
    expect(encoded.length).toBeLessThanOrEqual(URN_MAX_PARAM_LENGTH);

    // `GET /executors/{idOrUrn}/bindings` is a 200-with-possibly-empty-list read for any real
    // target — reaching that answer (rather than a 414) proves the ROUTER accepted the param and
    // dispatched to the handler.
    const listRes = await server.app.inject({
      method: "GET",
      url: `/api/v1/executors/${encoded}/bindings`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toEqual({ items: [] });

    // The EXACT live repro: `DELETE .../binding?type=configuration&lane=build`. Its normal answer
    // for a real target with no binding configured is a 404 naming the missing binding — reaching
    // THAT (rather than a 414) is the same proof for the verb the defect was actually filed against.
    const deleteRes = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/executors/${encoded}/binding?type=configuration&lane=build`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(deleteRes.statusCode).toBe(404);
    expect(deleteRes.json()).toMatchObject({
      detail: expect.stringContaining(
        "no 'configuration' executor binding on lane 'build' configured for"
      ) as unknown as string
    });
  });

  it.each(["GET", "DELETE", "PUT", "PATCH"] as const)(
    "an over-long path param on a %s request is refused as problem+json, not a bare 414 body",
    async (method) => {
      // No real object needs to exist behind this — the router refuses the request before any
      // handler, auth check, or DB read runs, purely on the segment's raw length. Every verb is
      // checked because the SPA fallback used to be a REGISTERED `/*` route matched only for GET —
      // which silently swallowed an over-long param into a plain "route not found" for GET while
      // DELETE/PUT/PATCH correctly 414'd (fixed by switching to `setNotFoundHandler`, app.ts §109).
      const overLong = "x".repeat(URN_MAX_PARAM_LENGTH + 500);

      const res = await server.app.inject({
        method,
        url: `/api/v1/executors/${overLong}/bindings`,
        headers: { authorization: `Bearer ${org.adminToken}` }
      });

      expect(res.statusCode).toBe(414);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.json()).toMatchObject({
        status: 414,
        title: "URI Too Long",
        detail: expect.stringContaining("max param length") as unknown as string
      });
    }
  );

  it("a genuinely wrong API path still 404s as problem+json (not the bare Fastify default)", async () => {
    // The `setNotFoundHandler` rework (app.ts §109) changes how a truly unmatched `/api/` path is
    // produced too — pinned here so a future revert back to a registered `/*` route (which would
    // reopen the GET swallow above) shows up as a content-type/shape regression, not just a status
    // code coincidence.
    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/totally-bogus-route",
      headers: { authorization: `Bearer ${org.adminToken}` }
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({
      status: 404,
      title: "Not Found",
      detail: "Route GET:/api/v1/totally-bogus-route not found"
    });
  });
});
