import { z } from "zod";

/**
 * The live event stream's wire contract (`GET /events/stream`, DESIGN.md §6/§8) — one `data:`
 * frame per relayed outbox row, org-scoped by the server.
 *
 * This schema is the whole point of the SSE API-parity work: until it existed the stream was the
 * one endpoint absent from `openapi.v1.json`, so no generated operation, no generated type, and no
 * `responseValidator` covered it — `apps/web` cast raw network bytes to an interface it declared
 * itself (ADR-0023's "GET /events/stream is not in the spec at all"). Declaring it here puts every
 * frame through the same Zod validation as every JSON response body: the generated SSE client
 * awaits `responseValidator` on each parsed frame before yielding it.
 *
 * The CloudEvents-shaped envelope mirrors `events/outbox-repo.ts`; `data` is deliberately
 * unconstrained — it is the per-event-type payload, and pinning a union here would make every new
 * event type a breaking contract change for a field no consumer dispatches on (they dispatch on
 * `type`).
 */
export const RelayedEventSchema = z.object({
  /** The outbox row id — also the SSE frame's `id:`, echoed back as `Last-Event-ID` on reconnect. */
  id: z.string(),
  orgId: z.string(),
  /** CloudEvents `type`, e.g. `scp.object.created` — also the SSE frame's `event:`. */
  type: z.string(),
  source: z.string(),
  /** The affected object's id, when the event names one. */
  subject: z.string().nullable(),
  data: z.unknown(),
  createdAt: z.string()
});
export type RelayedEvent = z.infer<typeof RelayedEventSchema>;
