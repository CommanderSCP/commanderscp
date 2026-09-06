import type { FastifyInstance } from "fastify";
import { ProblemSchema, RelayedEventSchema } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { hasPermission } from "../authz/resolve.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { SSE_RESYNC_EVENT_TYPE } from "../events/sse-bridge.js";
import { sseHub, type RelayedEvent } from "../events/sse-hub.js";
import { tooManyRequests } from "../errors.js";

/**
 * `GET /events/stream` (DESIGN.md §6, §8) — Server-Sent Events fed from this process's in-process
 * `sseHub`, scoped to the caller's org. Since M26.1 (proposal multi-region-instance-resilience.md
 * §7.1 item 1), `sseHub` is fed by events/sse-bridge.ts's LISTEN on `scp_sse_events`, not directly
 * by the outbox relay (events/outbox-relay.ts) — the relay and this route can run in different
 * pods under the default chart topology, so only a Postgres NOTIFY can cross that boundary.
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
 *
 * ## RBAC IS ENFORCED PER FRAME, AT FAN-OUT — the boundary below tenancy
 *
 * `sseHub` keys its channels by `orgId`, so a subscription enforces the TENANCY boundary and
 * nothing else (events/sse-hub.ts's own doc says exactly that, and says only that). Until this
 * change this route stopped there: it called `requireAuth` and subscribed, making it the ONE read
 * surface in the codebase with no permission demand — every `scp.object.*` / `scp.change.*` frame
 * in the org, each carrying a `subject` object id and a `data` payload, was pushed to ANY
 * authenticated principal in that org, INCLUDING one with zero role bindings. Every REST read
 * demands `object:read` at a resolved scope (services/objects-service.ts, routes/components.ts,
 * routes/changes.ts, …), so a Viewer bound at one service can read that subtree and nothing else;
 * the stream handed that same Viewer the whole org.
 *
 * So each frame is now admitted per connection by `object:read` at `event.subject`, using the same
 * `authz/resolve.ts` walk every REST read uses — same subject/group expansion, same upward-only
 * containment expansion, same deny-override. There is no second implementation of "may this
 * principal read this object" to drift.
 *
 * The subscription is still to the whole ORG (one `sseHub` listener keyed by `auth.orgId`), which
 * is deliberate: `sseHub.activeOrgIds()` — the bridge's work-gate and its reconnect resync
 * broadcast (events/sse-bridge.ts) — is defined as "org ids with a connected client", and a
 * narrower subscription key would silently break both. Filtering happens on the way OUT, not by
 * subscribing to less.
 *
 * ### Null `subject`: dropped, except the one contentless synthetic frame
 *
 * `RelayedEvent.subject` is nullable, and an event with no subject names no object to check
 * `object:read` against. Failing OPEN on null would be a hole a future publisher could walk
 * through without noticing. So null fails CLOSED, with exactly one allowlisted exception:
 * `scp.sse.resync` (events/sse-bridge.ts `makeResyncEvent`), which is not a domain event at all —
 * it is the synthetic "your LISTEN connection was down, some window of events may be missing"
 * signal, minted in-process on every bridge (re)connection, carrying `data: {}` and naming no
 * object. It leaks nothing, and dropping it would break M26.1's catch-up path outright: the
 * client's response to it is a wholesale query-cache invalidation (apps/web/src/lib/
 * use-event-stream.ts), and every refetch that triggers goes through the REST API, which enforces
 * RBAC properly. A principal with zero bindings therefore gets the nudge and still sees nothing.
 *
 * Because that exception is keyed on the event TYPE, and `type` is just a column any writer of an
 * `outbox` row chooses, the passthrough frame is rebuilt with `data: {}` rather than forwarded
 * as-is. A frame that skipped the permission check must carry no payload; the only legitimate
 * resync frame already has an empty `data`, so this costs nothing and removes the ability to
 * smuggle a body past the gate by naming that type.
 *
 * CENSUS (2026-08-25, `grep -rna` over every `eventBus.publish` / `writeOutboxEvent` call): every
 * production publisher sets a non-null subject — graph/objects-repo.ts (created/updated/deleted),
 * graph/relationships-repo.ts (created/deleted), coordination/transition.ts,
 * dependencies/dependency-inventory-repo.ts, coordination/webhook-processor.ts. The resync frame is
 * the only null-subject event that exists, so this allowlist is exactly one synthetic frame wide
 * and a NEW null-subject publisher must argue its own scope rather than inherit an opening.
 *
 * ### A subject that is not a readable object is dropped too — including relationship events
 *
 * `scp.relationship.*` sets `subject` to the RELATIONSHIP id, not an object id. The containment
 * walk starts at `objects`, so such a subject expands to nothing, matches no binding, and the frame
 * is dropped for EVERY principal — an org-root Owner included. That is a real behaviour change and
 * it is the correct direction: nothing in this repo consumes those frames (apps/web's
 * `use-event-stream.ts` dispatches only on `scp.object.*`, `scp.change.transitioned` and
 * `scp.sse.resync`; there is no other subscriber), and the alternative — treating "the subject
 * isn't an object" as permission to deliver — is precisely the hole this route just closed. If
 * relationship frames are wanted on the stream later, the fix is to give them a scope this walk can
 * reach (e.g. publish the edge's `from` object as the subject), NOT to weaken this gate.
 *
 * A subject that is not even UUID-shaped is rejected before it reaches the pool, the same gate and
 * for the same reason as events/sse-bridge.ts's `UUID_RE` on the NOTIFY pointer: `scopeObjectId` is
 * cast `::uuid` inside the permission CTE, so a malformed value would otherwise buy an attacker a
 * full connect + BEGIN + SET ROLE + recursive-CTE parse per frame before failing on `22P02`.
 */

/**
 * How long ONE `object:read` verdict is reused for on ONE connection.
 *
 * WHY A MEMO AT ALL: without one, every frame costs one tenant transaction and one recursive-CTE
 * permission query PER CONNECTED CLIENT — an org with N open streams turns a single object update
 * into N walks, and a bulk import into N × rows. The memo makes a burst touching the same objects
 * cost one query per (connection, subject) per window instead.
 *
 * WHAT IT COSTS, EXPLICITLY: a binding revoked mid-connection keeps working on this stream for up
 * to READ_MEMO_TTL_MS after the last verdict, or until the client reconnects (a new connection
 * starts with an empty memo). Five seconds is the deliberate bound — long enough to collapse the
 * burst that motivates the memo, short enough that "revocation takes effect within seconds" is
 * still true, and short compared to the SSE reconnect/heartbeat cadence. It is a CACHE OF A
 * VERDICT, never of a frame: an object the caller has never been able to read is never delivered,
 * whatever the memo holds. Do not raise this without saying what the new revocation lag is.
 */
const READ_MEMO_TTL_MS = 5_000;

/**
 * `max` for the pool this route's permission checks run on — `main.ts`'s `sseAuthzPool`, which
 * imports this constant so the number and its justification cannot drift apart.
 *
 * WHY A SEPARATE POOL AT ALL. These checks are NOT request-shaped work. Their volume is set by
 * event volume × connected clients, both influenceable from outside any request, and each one is a
 * tenant transaction (`SET LOCAL ROLE` + `set_config` + a recursive-CTE containment walk). The
 * chain below serializes checks WITHIN a connection, so one connection holds at most one checkout —
 * but N connections mean up to N concurrent checkouts, and `deps.db` is the request-serving pool
 * built in `main.ts` with no `max`, i.e. pg's default of 10. Since `createPool` sets
 * `connectionTimeoutMillis: 5000` (db/client.ts), SSE load spilling onto that pool surfaces as
 * REQUEST TIMEOUTS on unrelated API calls. `main.ts` already made exactly this call one layer up —
 * the SSE bridge gets its own `max: 2` pool (review finding SEC-1) because its work is driven by a
 * NOTIFY channel any DB login can write to. This is the same decision for the same path, and
 * `main.ts` documents them as one block.
 *
 * WHY FOUR, not two and not ten. The memo above collapses REPEATED subjects on one connection; it
 * does nothing for a stream of DISTINCT subjects (bulk import, backfill, reconcile sweep), which is
 * precisely the load that matters. Two — the bridge's number — would serialize every connected
 * client's stream behind two walks, and the bridge gets away with two because it has ONE consumer,
 * not one per client. Four keeps a slow walk on one connection from head-of-line-blocking every
 * other client's stream while still capping this process's extra connections at four (six with the
 * bridge's two) — a fixed, small addition to the per-pod connection budget, not one per client.
 *
 * WHAT STARVATION COSTS, EXPLICITLY: a checkout that cannot be served within
 * `connectionTimeoutMillis` throws, `mayRead` FAILS CLOSED, and the frame is dropped on that
 * connection. That is the stream's existing contract under load (see `MAX_PENDING_FRAMES` below,
 * and ADR-0025 D4: no replay) — a dropped frame is recovered by the resync/cache-invalidation path.
 * It is never a failed API request, which is the whole point of not sharing `deps.db`.
 */
export const SSE_AUTHZ_POOL_MAX = 4;

/**
 * Hard cap on memoized subjects per connection — an SSE connection lives for hours and sees an
 * unbounded number of distinct subject ids, so an unbounded map here is a memory leak with a
 * timer, not a cache. Oldest-inserted entries are evicted first; an evicted subject simply costs
 * one more query next time it appears.
 */
const READ_MEMO_MAX_SUBJECTS = 512;

/**
 * Ceiling on frames awaiting their permission check on ONE connection (the same bounded-backpressure
 * idiom as events/sse-bridge.ts's `MAX_INFLIGHT_FETCHES`). The check is async and the hub's emit is
 * synchronous, so frames queue behind the serialization chain below; a burst arriving faster than
 * the database answers must not grow that queue without limit. Past this many pending, further
 * frames are dropped — best-effort is the stream's own contract (ADR-0025 D4: no replay), and a
 * genuine miss is recovered by the resync/cache-invalidation path, never by unbounded queueing.
 */
const MAX_PENDING_FRAMES = 1_000;

/** RFC 4122 shape — see the module doc's last paragraph for why a non-UUID subject is refused
 *  before it can reach the pool. Same literal, same reason, as events/sse-bridge.ts's gate. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SSE connection caps. Each open stream holds a socket, a DB-check queue, and a hub listener for its
 * connection lifetime, so an authenticated caller who opens streams in a loop can exhaust the pod's
 * file descriptors / the SSE authz pool without ever tripping a request-rate limit (the connection
 * is long-lived, not a burst of requests). A per-principal cap stops one identity monopolising the
 * budget; a global cap stops a fleet of identities doing the same. Both refuse with 429 BEFORE the
 * 200 head is written, so the caller sees a clean error rather than a stream that never delivers.
 */
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

      // THE ISOLATED POOL (see `SSE_AUTHZ_POOL_MAX` above and `main.ts`'s two-pool block), resolved
      // per connection rather than at route-registration time because `main.ts` assigns
      // `deps.sseAuthzDb` AFTER `buildApp` — the same late-assignment idiom as `deps.pluginHost`.
      //
      // THE FALLBACK IS EXPLICIT, NOT INCIDENTAL. `buildApp` is also called by `openapi:emit` and
      // by test-support/harness.ts, which build deps by hand as `{ db, config }`. Those callers get
      // `deps.db` — the pre-existing behaviour, correct but UNISOLATED. It is deliberately a
      // fallback and not a throw: refusing to serve the stream because a hand-built deps lacks a
      // performance isolation would trade a load-shedding property for an availability one. Any
      // process built by `main.ts` — i.e. every deployed process, in every role — has the isolated
      // pool, and routes/events-authz.integration.test.ts asserts both halves of that.
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

      // ORDER IS THE SSE CONTRACT: a stream is a sequence, so the per-frame permission check —
      // which is async, while `sseHub`'s emit is synchronous — must not let a fast verdict overtake
      // a slow one. Every frame is appended to ONE promise chain per connection, so checks are
      // serialized in the exact order the hub emitted them. Each link carries its own `catch`,
      // attached synchronously, so a rejection can never surface as an unhandled rejection (which
      // in Node 22 terminates the process by default) and can never break the chain for the frames
      // behind it.
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
