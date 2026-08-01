import type { FastifyInstance } from "fastify";
import { ProblemSchema, RelayedEventSchema } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { sseHub, type RelayedEvent } from "../events/sse-hub.js";

/**
 * `GET /events/stream` (DESIGN.md §6, §8) — Server-Sent Events fed from the outbox relay
 * (events/outbox-relay.ts) via the in-process `sseHub`, scoped to the caller's org.
 *
 * DECLARED IN THE CONTRACT, like everything else. The frames are not a JSON request/response pair,
 * so the 200 cannot be a Fastify response schema (nothing for Fastify to serialize — the handler
 * writes to `reply.raw`); it is declared via `config.openapi.eventStream`, which the emitter turns
 * into `content: { "text/event-stream": … }` (openapi/build-document.ts). That is what lets the
 * generator produce a real `streamEvents` operation, so `apps/web` consumes the stream through the
 * SDK instead of a hand-built URL and a raw `EventSource` — charter principle 3, and the closing of
 * the one exemption `apps/web/e2e/openapi-conformance.ts` used to carry.
 *
 * `Last-Event-ID` (sent by both `EventSource` and the SDK's SSE client on reconnect) is accepted
 * and IGNORED: `sseHub` is an in-process fan-out of live rows with no per-connection replay
 * buffer, so a reconnecting client resumes at "now" and re-syncs through the query cache it
 * invalidates. That is exactly the behaviour before this change — it is stated here rather than
 * left to be inferred from the absence of code.
 */
export function registerEventStreamRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    "/api/v1/events/stream",
    {
      // Only the error responses are Fastify-serialized; the 200 never passes through `reply.send`.
      schema: { response: { 401: ProblemSchema, 403: ProblemSchema } },
      config: {
        openapi: {
          operationId: "streamEvents",
          summary: "Live event stream for the caller's org (Server-Sent Events)",
          tags: ["events"],
          eventStream: RelayedEventSchema
        }
      }
    },
    async (request, reply) => {
      const auth = await requireAuth(deps, request);

      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      reply.raw.write(": connected\n\n");

      const send = (event: RelayedEvent): void => {
        reply.raw.write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        );
      };
      sseHub.on(auth.orgId, send);

      const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        sseHub.off(auth.orgId, send);
      });
    }
  );
}
