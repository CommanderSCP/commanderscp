import { z } from "zod";

/** The live event stream's wire contract. See docs/schemas.md §180. */
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
