import { ScpClient } from "@scp/sdk";

/**
 * The ONE `ScpClient` instance the whole SPA shares (DESIGN.md §14 "consumes only @scp/sdk").
 * Relative `baseUrl` — the SPA is always served BY the same Fastify process the API lives on
 * (apps/server/src/app.ts's static mount, Part D), so this works unmodified in dev (behind
 * Vite's `/api` proxy — vite.config.ts), in the built app served by `scpd`, and in the
 * Playwright e2e suite (apps/web/e2e) regardless of which port the test server happens to bind.
 *
 * No token is passed at construction: auth is the browser's automatic same-origin
 * `scp_session` cookie (httpOnly, set by `POST /auth/login`) — there is no client-side token to
 * manage (auth/require-auth.ts, routes/auth.ts).
 */
export const client = new ScpClient({ baseUrl: "/api/v1" });
