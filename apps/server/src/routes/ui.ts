import type { FastifyInstance } from "fastify";
import { ScpClient } from "@scp/sdk";
import type { ServiceObject } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { extractToken } from "../auth/require-auth.js";
import { verifyToken } from "../auth/local-auth.js";

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

type PageData = { loggedIn: false } | { loggedIn: true; org: string; items: ServiceObject[] };

function renderPage(data: PageData): string {
  const body = !data.loggedIn
    ? `<p id="auth-state" data-state="anonymous">Not logged in. Log in with <code>scp login</code> (or POST
       <code>/api/v1/auth/login</code>), which also sets the session cookie this page reads.</p>`
    : `
      <p id="auth-state" data-state="authenticated">Org: <strong>${escapeHtml(data.org)}</strong></p>
      <h2>Service objects</h2>
      ${
        data.items.length === 0
          ? '<p id="empty-state">No service objects yet — try <code>scp object create service --name billing</code>.</p>'
          : `<ul id="service-objects">${data.items
              .map((o) => `<li data-object-id="${escapeHtml(o.id)}">${escapeHtml(o.name)}</li>`)
              .join("")}</ul>`
      }
    `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>CommanderSCP</title>
  <link rel="stylesheet" href="/static/style.css" />
</head>
<body>
  <h1>CommanderSCP — walking skeleton</h1>
  ${body}
</body>
</html>
`;
}

/**
 * M0 UI stub (BUILD_AND_TEST.md §8 M0): server-rendered directly inside apps/server (the real
 * apps/web SPA, which per DESIGN.md §3/§15 consumes only @scp/sdk client-side, lands in M2).
 * Renders by calling the public API through the generated SDK against this same process's
 * loopback address — never touching Drizzle directly — so the page never gets ahead of what the
 * API itself would return.
 */
export function registerUiRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/ui", async (request, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");

    const token = extractToken(request);
    const auth = token ? await verifyToken(deps.db, token) : null;
    if (!token || !auth) {
      reply.status(200).send(renderPage({ loggedIn: false }));
      return;
    }

    const client = new ScpClient({ baseUrl: deps.config.internalBaseUrl, token });
    const page = await client.objects.service.list({ limit: 100 });

    reply.status(200).send(renderPage({ loggedIn: true, org: auth.orgName, items: page.items }));
  });
}
