import { describe, expect, it } from "vitest";
import { listenTestServer, type ListeningTestServer } from "../test-support/harness.js";

/** A retrans must not serve the single-page application. See docs/federation.md §469. */
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
