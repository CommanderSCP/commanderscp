import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { sseHub, type RelayedEvent } from "../events/sse-hub.js";

/**
 * `GET /events/stream` (DESIGN.md §6, §8) — Server-Sent Events fed from the outbox relay
 * (events/outbox-relay.ts) via the in-process `sseHub`, scoped to the caller's org. Not a
 * Zod/OpenAPI route (like `/healthz`, `/ui`) — SSE is a raw streaming response, not a JSON
 * request/response pair the contract pipeline models.
 */
export function registerEventStreamRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/v1/events/stream", async (request, reply) => {
    const auth = await requireAuth(deps, request);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    reply.raw.write(": connected\n\n");

    const send = (event: RelayedEvent): void => {
      reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    sseHub.on(auth.orgId, send);

    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      sseHub.off(auth.orgId, send);
    });
  });
}
