import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { initFederationSelf } from "./self-repo.js";

/**
 * M16.3 P1 ("PROVE IT SERVES") — grounding found the one-binary outpost-local UI was ASSUMED
 * "free by construction" and never actually verified. `app.ts` registers `@fastify/static` +
 * the SPA catch-all UNCONDITIONALLY (`registerHealthRoutes(app, deps); app.get("/healthz", ...);`
 * then the `webDistRoot` static registration — see `app.ts`'s module doc right above it), with no
 * gate on this org's/instance's federation role. This suite pins that a `role: outpost` domain
 * genuinely gets both halves of "the same one-binary UI, scoped to its local domain":
 *
 *   1. the SPA is served at all (GET '/' returns real `text/html`, not a 404/503 stub), and
 *   2. the outpost's OWN local-domain graph (a component that exists only here, never federated
 *      anywhere) round-trips through the generated SDK on that exact same running instance —
 *      i.e. this is not just a static file server bolted on beside a broken API.
 *
 * Deliberately integration-level, not browser/Playwright level (BUILD_AND_TEST.md: Playwright e2e
 * costs minutes where this costs seconds) — modeled on the `bootDomain` pattern in
 * `federation-poke-chain.integration.test.ts`, but far simpler: no mTLS, no second domain, no
 * federation transport at all is needed to prove "this one instance serves its own UI + API".
 */
describe("M16.3 P1: an outpost instance serves its own local UI (apps/web/dist)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let rootOrigin: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "outpost-local-ui");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // Designate this domain `outpost` (DESIGN §13 / ADR-0004) — the scenario M16.3 is actually
    // about: an outpost domain instance, not a bare/unset one.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: org.orgId,
        name: `outpost-${randomUUID().slice(0, 8)}`,
        role: "outpost"
      })
    );

    // `server.baseUrl` is `${address}/api/v1` (test-support/harness.ts) — strip the API prefix to
    // get back the bare origin the SPA/static routes live at.
    rootOrigin = new URL(server.baseUrl).origin;
  });

  afterAll(async () => {
    await server?.close();
  });

  it("serves real text/html at GET '/' on a role:outpost instance", async () => {
    const res = await fetch(`${rootOrigin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    // The built Vite SPA shell (apps/web/dist/index.html) — not the M0 server-rendered stub (long
    // deleted, app.ts's own doc comment) and not the "Web UI is not built" 503 fallback string.
    expect(body).toContain('<div id="root">');
    expect(body).not.toContain("Web UI is not built");
  });

  it("also serves html at a client-side SPA route, and still 404s JSON for an unknown API path", async () => {
    // A client-side route with no matching file on disk (e.g. `/services/abc`) must fall through
    // to the SAME index.html shell — that's the whole point of the catch-all (app.ts's doc
    // comment: "this only ever runs for SPA client-side routes... that have no matching file").
    const spaRoute = await fetch(`${rootOrigin}/services/${randomUUID()}`);
    expect(spaRoute.status).toBe(200);
    expect(spaRoute.headers.get("content-type")).toMatch(/text\/html/);

    // The explicit `/api/` guard in the catch-all must still 404 (as JSON, via `reply.callNotFound()`)
    // rather than silently handing back the HTML shell for a bad API path.
    const badApi = await fetch(`${rootOrigin}/api/v1/this-route-does-not-exist`);
    expect(badApi.status).toBe(404);
    expect(badApi.headers.get("content-type")).toMatch(/json/);
  });

  it("a domain-local component round-trips through the generated SDK on this same outpost instance", async () => {
    const created = await createTestComponent(admin, {
      name: `outpost-local-${randomUUID().slice(0, 8)}`
    });
    const fetched = await admin.components.get(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe(created.name);

    // Never federated anywhere — this domain is its own authoritative origin for it (single-writer
    // authority, graph/objects-repo.ts's module doc), exactly what "the domain-specific pipelines
    // the commander doesn't track" (BUILD_AND_TEST.md M16.3) means in practice.
    const self = await admin.federation.self();
    expect(fetched.originDomainId).toBe(self.domainId);
  });
});
