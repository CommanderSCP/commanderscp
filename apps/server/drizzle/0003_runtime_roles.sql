-- Security hardening (PR #4 review, CRITICAL 3): split database roles so the request-serving
-- pool never runs privileged.
--
--   * The bootstrap/migration user (compose POSTGRES_USER, typically a superuser) is used ONLY
--     by the migration runner and one-time role provisioning at boot (src/db/provision.ts).
--   * `scp_app` (created NOLOGIN in 0002) becomes the application's LOGIN role at boot — the
--     runtime pool connects AS scp_app, so RLS holds even if application code forgets
--     `withTenantTx` entirely (DESIGN.md §4.2's "two independent failures" property). LOGIN +
--     password are granted at boot by provision.ts (a password cannot live in committed SQL),
--     but the role's *privilege* shape is fixed here: no superuser, no BYPASSRLS (0002).
--   * `scp_relay` is the outbox relay's narrowly-scoped cross-org reader: NOLOGIN, NOBYPASSRLS,
--     granted ONLY on `outbox`, with a permissive policy on that one table. The relay reaches it
--     via `SET LOCAL ROLE scp_relay` inside its transactions (events/outbox-relay.ts) — scp_app
--     is granted membership for exactly that purpose. scp_relay has no grants on any other
--     table, so even code that hijacks the relay role cannot touch objects/relationships/
--     role_bindings/audit_events.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'scp_relay') THEN
    CREATE ROLE scp_relay NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO scp_relay;
--> statement-breakpoint
-- Outbox only: SELECT to claim rows, UPDATE to mark processed_at. Nothing else, ever.
GRANT SELECT, UPDATE ON outbox TO scp_relay;
--> statement-breakpoint
-- The runtime login role may assume the relay role inside relay transactions (SET defaults to
-- TRUE), but INHERIT FALSE is load-bearing: RLS policies naming a role also apply to members
-- that inherit from it, so a plain GRANT would silently extend relay_outbox_all's USING(true)
-- to every ordinary scp_app query on outbox — exactly the cross-org read this split exists to
-- prevent (caught by the adversarial probe suite). With INHERIT FALSE, scp_app gets relay
-- powers only inside an explicit `SET LOCAL ROLE scp_relay` transaction.
GRANT scp_relay TO scp_app WITH INHERIT FALSE;
--> statement-breakpoint
-- Cross-org visibility for the relay on outbox alone. Policies are permissive (OR'd), and this
-- one is scoped TO scp_relay, so it widens nothing for scp_app (which still hits org_isolation).
DROP POLICY IF EXISTS relay_outbox_all ON outbox;
--> statement-breakpoint
CREATE POLICY relay_outbox_all ON outbox
  FOR ALL TO scp_relay
  USING (true)
  WITH CHECK (true);
