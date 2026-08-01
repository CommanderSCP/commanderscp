import { describe, expect, it } from "vitest";
import { listenTestServer, type ListeningTestServer } from "../test-support/harness.js";

/**
 * M16.3 P3 (owner decision 2026-07-29) — "a retrans must not serve the SPA"
 * (BUILD_AND_TEST.md M13.1 — cited by MILESTONE, not by line number, since that file shifts under
 * every milestone that lands: the retrans deployment profile is "no local Gitea/registry, no
 * executor coordination, no deploy machinery, no UI"). Before this suite (and the `app.ts`/
 * `config.ts` change it pins), SPA registration was UNCONDITIONAL — a `role: retrans` relay served
 * the full management UI at the most sensitive point in the topology (a CDS boundary).
 *
 * WHICH ROLE AXIS GOVERNS, and why (see `config.ts`'s doc comment on `ServerConfig.federationRole`
 * for the full reasoning): this gates on `SCP_FEDERATION_ROLE` — a NEW, install-time/deployment-
 * wide config value, distinct from BOTH:
 *   - `SCP_ROLE` (`main.ts`'s `config.role`, `api`|`worker`|`all`) — proven below to be the WRONG
 *     axis: every `SCP_ROLE` value calls `buildApp` + `app.listen` unconditionally (`main.ts`), so
 *     today EVERY process role serves the SPA regardless — `SCP_ROLE` governs which BACKGROUND
 *     LOOPS run in-process, nothing about HTTP surface.
 *   - `federation/self-repo.ts`'s `FederationSelf.role` (`self_domain.role` in the DB) — ORG-scoped
 *     (self-repo.ts's own module doc: "kept org-scoped, not instance-wide"), set lazily post-
 *     install via the federation API, and explicitly declared ADVISORY by M15.4's own guardrail
 *     (`tools/helm-verify`'s doc comment: using it for an install-time render/boot decision would
 *     be exactly the runtime/install-time FORK the owner declined to create there). It is also
 *     simply unusable here: `app.ts` registers routes ONCE at process boot, before any request (or
 *     tenant) context exists to look a per-org DB row up against.
 *
 * MUTATION-PROVEN (reported in the PR body, not just asserted here): with the `app.ts` gate
 * removed, this suite's first test goes RED (a retrans-role instance serves real HTML at `GET
 * '/'`) — confirming the test actually exercises the gate rather than passing vacuously.
 */
describe("M16.3 P3: a role:retrans instance never serves the management SPA", () => {
  it("retrans: GET '/' does not serve the SPA (JSON 404, not the built index.html)", async () => {
    const server: ListeningTestServer = await listenTestServer({ federationRole: "retrans" });
    try {
      const rootOrigin = new URL(server.baseUrl).origin;
      const res = await fetch(`${rootOrigin}/`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/json/);
      const body = await res.text();
      expect(body).not.toContain('<div id="root">');

      // A client-side SPA route must not fall through to the built shell either — there is no
      // shell to fall through to.
      const spaRoute = await fetch(`${rootOrigin}/services/anything`);
      expect(spaRoute.status).toBe(404);
      expect(spaRoute.headers.get("content-type")).toMatch(/json/);
    } finally {
      await server.close();
    }
  });

  it("retrans: the API surface (/api/*) and /healthz still work — only the UI is withheld", async () => {
    const server: ListeningTestServer = await listenTestServer({ federationRole: "retrans" });
    try {
      const rootOrigin = new URL(server.baseUrl).origin;
      const health = await fetch(`${rootOrigin}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      // A real (if unauthenticated) API route still resolves as the API, not the withheld UI —
      // proves this is a UI-specific gate, not "retrans breaks HTTP".
      const apiRoute = await fetch(`${rootOrigin}/api/v1/auth/login`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" }
      });
      expect(apiRoute.status).not.toBe(404);
      expect(apiRoute.headers.get("content-type")).toMatch(/json/);
    } finally {
      await server.close();
    }
  });

  it("commander/outpost (and unset ⇒ commander default) keep serving the SPA unchanged", async () => {
    for (const federationRole of ["commander", "outpost", undefined] as const) {
      const server: ListeningTestServer = await listenTestServer(
        federationRole ? { federationRole } : {}
      );
      try {
        const rootOrigin = new URL(server.baseUrl).origin;
        const res = await fetch(`${rootOrigin}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        const body = await res.text();
        expect(body).toContain('<div id="root">');
      } finally {
        await server.close();
      }
    }
  });
});
