import type { FastifyInstance } from "fastify";
import { ProblemSchema, RelayedEventSchema } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { hasPermission } from "../authz/resolve.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { SSE_RESYNC_EVENT_TYPE } from "../events/sse-bridge.js";
import { sseHub, type RelayedEvent } from "../events/sse-hub.js";
import { tooManyRequests } from "../errors.js";

/** `GET /events/stream` (DESIGN.md §6, §8). See docs/routes.md §151. */

/** How long one read verdict is reused on one connection. See docs/routes.md §152. */
const READ_MEMO_TTL_MS = 5_000;

/** The pool size this route's permission checks run on. See docs/routes.md §153. */
export const SSE_AUTHZ_POOL_MAX = 4;

/** Hard cap on memoized subjects per connection. See docs/routes.md §154. */
const READ_MEMO_MAX_SUBJECTS = 512;

/** Ceiling on frames awaiting their check on one connection. See docs/routes.md §155. */
const MAX_PENDING_FRAMES = 1_000;

/** RFC 4122 shape — see the module doc's last paragraph for why a non-UUID subject is refused
 *  before it can reach the pool. Same literal, same reason, as events/sse-bridge.ts's gate. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SSE connection caps. See docs/routes.md §156. */
const MAX_SSE_CONNS_PER_PRINCIPAL = 8;
const MAX_SSE_CONNS_GLOBAL = 2_000;
let openSseConns = 0;
const openSseConnsByPrincipal = new Map<string, number>();

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

      // Connection caps, checked BEFORE the 200 head so an over-limit caller gets a 429 (via the
      // global error handler) instead of a dead stream. Registered/incremented only after the head
      // is written, and decremented exactly once on close.
      const principalKey = auth.subjectObjectId;
      const principalConns = openSseConnsByPrincipal.get(principalKey) ?? 0;
      if (openSseConns >= MAX_SSE_CONNS_GLOBAL) {
        throw tooManyRequests("event stream connection limit reached (server) — retry shortly");
      }
      if (principalConns >= MAX_SSE_CONNS_PER_PRINCIPAL) {
        throw tooManyRequests(
          `event stream connection limit reached (${MAX_SSE_CONNS_PER_PRINCIPAL} concurrent per principal)`
        );
      }

      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      reply.raw.write(": connected\n\n");

      openSseConns += 1;
      openSseConnsByPrincipal.set(principalKey, principalConns + 1);
      let counted = true;
      const releaseConnSlot = (): void => {
        if (!counted) return;
        counted = false;
        openSseConns -= 1;
        const remaining = (openSseConnsByPrincipal.get(principalKey) ?? 1) - 1;
        if (remaining <= 0) openSseConnsByPrincipal.delete(principalKey);
        else openSseConnsByPrincipal.set(principalKey, remaining);
      };

      // Per-CONNECTION, never module-level: the memo is keyed by subject alone, so one shared
      // across connections would answer one principal's question with another's verdict.
      const readMemo = new Map<string, { allowed: boolean; expiresAt: number }>();

      // THE ISOLATED POOL. See docs/routes.md §157.
      const authzDb = deps.sseAuthzDb ?? deps.db;

      let closed = false;
      let pending = 0;
      let overflowLogged = false;

      async function mayRead(subjectObjectId: string): Promise<boolean> {
        const now = Date.now();
        const memoized = readMemo.get(subjectObjectId);
        if (memoized && memoized.expiresAt > now) return memoized.allowed;

        // FAIL CLOSED on any throw. `hasPermission` can legitimately throw (ADR-0037 converts an
        // untrustworthy deny above the containment-walk bound into a loud error), and so can the
        // pool. Neither is evidence the caller may read the object, and neither may take the
        // process down — a rejecting listener on an EventEmitter is an unhandled rejection.
        let allowed = false;
        try {
          allowed = await withTenantTx(authzDb, auth.orgId, (tx) =>
            hasPermission(tx, {
              orgId: auth.orgId,
              subjectObjectId: auth.subjectObjectId,
              permission: "object:read",
              scopeObjectId: subjectObjectId
            })
          );
        } catch (err) {
          // `subjectObjectId` is UUID-validated by the caller, so interpolating it here cannot
          // inject CRLF into a log line (events/sse-bridge.ts, review finding SEC-3).
          console.error(
            `[events] object:read check failed for subject ${subjectObjectId} — frame dropped`,
            err
          );
          return false;
        }

        readMemo.delete(subjectObjectId);
        readMemo.set(subjectObjectId, { allowed, expiresAt: now + READ_MEMO_TTL_MS });
        while (readMemo.size > READ_MEMO_MAX_SUBJECTS) {
          const oldest = readMemo.keys().next().value;
          if (oldest === undefined) break;
          readMemo.delete(oldest);
        }
        return allowed;
      }

      /** The frame to write for this event, or `undefined` to drop it. See the module doc for the
       *  null-subject and non-object-subject rules. */
      async function admittedFrame(event: RelayedEvent): Promise<RelayedEvent | undefined> {
        if (event.subject === null) {
          if (event.type !== SSE_RESYNC_EVENT_TYPE) return undefined;
          return { ...event, data: {} };
        }
        if (!UUID_RE.test(event.subject)) return undefined;
        return (await mayRead(event.subject)) ? event : undefined;
      }

      function writeFrame(event: RelayedEvent): void {
        reply.raw.write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        );
      }

      // ORDER IS THE SSE CONTRACT. See docs/routes.md §158.
      let chain: Promise<void> = Promise.resolve();

      const send = (event: RelayedEvent): void => {
        if (closed) return;
        if (pending >= MAX_PENDING_FRAMES) {
          if (!overflowLogged) {
            overflowLogged = true;
            console.warn(
              `[events] pending-frame cap (${MAX_PENDING_FRAMES}) reached for org ${auth.orgId} — ` +
                `dropping frames on this connection (best-effort; a resync recovers)`
            );
          }
          return;
        }
        pending += 1;
        chain = chain
          .then(async () => {
            // Re-checked AFTER the await, not only in `send`: the connection can close while this
            // frame was queued, and writing to a destroyed socket throws.
            if (closed) return;
            const frame = await admittedFrame(event);
            if (frame && !closed) writeFrame(frame);
          })
          .catch((err) => {
            console.error(`[events] failed to deliver frame ${event.id} — dropped`, err);
          })
          .finally(() => {
            pending -= 1;
          });
      };
      sseHub.on(auth.orgId, send);

      const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);

      request.raw.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
        sseHub.off(auth.orgId, send);
        releaseConnSlot();
        // Queued frames still resolve their in-flight checks, but the `closed` guard above stops
        // them writing to a socket that is gone.
        readMemo.clear();
      });
    }
  );
}
