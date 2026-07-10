/**
 * All-zero UUID identifying the coordination ENGINE itself as an audit/Decision actor — used by
 * every reconciliation-loop-authored transition (coordination/reconcile.ts) and the stuck-change
 * watchdog sweep (coordination/watchdog.ts), neither of which has a human operator to attribute
 * an action to. Never a real graph object id (no `objects` row exists at this id) — audit_events
 * and decisions both store `actor_id`/`subject_id` as bare UUIDs with no FK to `objects`, so this
 * is a safe, queryable sentinel rather than a magic string.
 */
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
