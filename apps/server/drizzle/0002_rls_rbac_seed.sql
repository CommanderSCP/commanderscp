-- M1 Graph Core, part 2: RLS multi-tenancy (DESIGN.md §4.2), the least-privileged `scp_app`
-- role (charter principle "app DB role without BYPASSRLS"), the audit-event immutability guard
-- (DESIGN.md §4.3), the outbox NOTIFY trigger (DESIGN.md §8), and built-in type-registry/RBAC
-- seed rows (DESIGN.md §4.1, §7). Hand-authored: RLS policies, roles, triggers, and seed data
-- are not expressible in drizzle-kit's schema diffing.

-- ===========================================================================================
-- 1. Least-privileged application role. Migrations/pg-boss/seed scripts run as the bootstrap
--    connection role (superuser in dev/compose/Testcontainers); the request-serving pool
--    `SET LOCAL ROLE scp_app` for every tenant-scoped transaction (apps/server/src/db/
--    tenant-tx.ts), so a request can never see another org's rows even if application code has
--    a bug — RLS is enforced independently of the app layer.
-- ===========================================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'scp_app') THEN
    CREATE ROLE scp_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT scp_app TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO scp_app;

GRANT SELECT, INSERT, UPDATE ON
  orgs, users, sessions,
  object_types, relationship_types, objects, relationships,
  roles, role_bindings, outbox, idempotency_keys
TO scp_app;

-- Audit log is INSERT/SELECT only — never UPDATE/DELETE, even for scp_app (DESIGN.md §4.3).
GRANT SELECT, INSERT ON audit_events TO scp_app;
REVOKE UPDATE, DELETE ON audit_events FROM scp_app;

-- `audit_events.seq` is a GENERATED ALWAYS AS IDENTITY column; its owned sequence still needs an
-- explicit grant for a non-owner role to INSERT into the table.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO scp_app;

-- ===========================================================================================
-- 2. Row-Level Security — one identical policy shape per tenant-scoped table (DESIGN.md §4.2).
--    `current_setting('app.current_org_id', true)` returns NULL (never errors) when unset, so
--    an unset session GUC fails closed (org_id = NULL is never true) rather than raising.
--    Built-in/global rows (org_id IS NULL on object_types/relationship_types/roles) stay
--    visible to every org but can never be written by the app role (WITH CHECK requires a real
--    org match), so custom types/roles created at runtime are always org-scoped.
-- ===========================================================================================

ALTER TABLE object_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_types FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON object_types;
CREATE POLICY org_isolation ON object_types
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR org_id IS NULL)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE relationship_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_types FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON relationship_types;
CREATE POLICY org_isolation ON relationship_types
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR org_id IS NULL)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON roles;
CREATE POLICY org_isolation ON roles
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR org_id IS NULL)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON objects;
CREATE POLICY org_isolation ON objects
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON relationships;
CREATE POLICY org_isolation ON relationships
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE role_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON role_bindings;
CREATE POLICY org_isolation ON role_bindings
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON audit_events;
CREATE POLICY org_isolation ON audit_events
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON outbox;
CREATE POLICY org_isolation ON outbox
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON idempotency_keys;
CREATE POLICY org_isolation ON idempotency_keys
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ===========================================================================================
-- 3. Audit-event immutability guard (belt-and-braces on top of the REVOKE above — DESIGN.md
--    §4.3). Applies to every role, including table owners/superusers running raw SQL.
-- ===========================================================================================

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update_delete ON audit_events;
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- ===========================================================================================
-- 4. Outbox NOTIFY trigger (DESIGN.md §8) — fires only after the enclosing transaction commits
--    (Postgres NOTIFY semantics), waking the worker's outbox relay and any live SSE listeners.
-- ===========================================================================================

CREATE OR REPLACE FUNCTION outbox_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('scp_outbox_insert', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outbox_notify_trigger ON outbox;
CREATE TRIGGER outbox_notify_trigger
  AFTER INSERT ON outbox
  FOR EACH ROW EXECUTE FUNCTION outbox_notify();

-- ===========================================================================================
-- 5. Built-in object types (DESIGN.md §4.1 — all 16, org_id NULL = global/built-in).
-- ===========================================================================================

INSERT INTO object_types (id, org_id, display_name, property_schema, is_builtin) VALUES
  ('organization',       NULL, 'Organization',       '{"type":"object"}'::jsonb, true),
  ('domain',              NULL, 'Domain',              '{"type":"object"}'::jsonb, true),
  ('service',             NULL, 'Service',             '{"type":"object"}'::jsonb, true),
  ('component',           NULL, 'Component',           '{"type":"object"}'::jsonb, true),
  ('team',                NULL, 'Team',                '{"type":"object"}'::jsonb, true),
  ('group',               NULL, 'Group',               '{"type":"object"}'::jsonb, true),
  ('user',                NULL, 'User',                '{"type":"object"}'::jsonb, true),
  ('service-account',     NULL, 'Service Account',     '{"type":"object"}'::jsonb, true),
  ('deployment-target',   NULL, 'Deployment Target',   '{"type":"object"}'::jsonb, true),
  ('contract',            NULL, 'Contract',            '{"type":"object"}'::jsonb, true),
  ('policy',              NULL, 'Policy',              '{"type":"object"}'::jsonb, true),
  ('control',             NULL, 'Control',             '{"type":"object"}'::jsonb, true),
  ('change',              NULL, 'Change',              '{"type":"object"}'::jsonb, true),
  ('campaign',            NULL, 'Campaign',            '{"type":"object"}'::jsonb, true),
  ('initiative',          NULL, 'Initiative',          '{"type":"object"}'::jsonb, true),
  ('release-topology',    NULL, 'Release Topology',    '{"type":"object"}'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================================
-- 6. Built-in relationship types (DESIGN.md §4.1 — all 12, with endpoint + cardinality
--    constraints). `annotates` (federation overlays, §13) is intentionally unconstrained.
-- ===========================================================================================

INSERT INTO relationship_types (id, org_id, display_name, from_types, to_types, cardinality, is_builtin) VALUES
  ('owns',               NULL, 'Owns',
    ARRAY['team','group','user','service-account'],
    ARRAY['service','component','domain','deployment-target','contract'],
    'one_to_many', true),
  ('consumes',           NULL, 'Consumes',
    ARRAY['service','component'], ARRAY['service','component'], 'many_to_many', true),
  ('depends_on',         NULL, 'Depends On',
    ARRAY['service','component'], ARRAY['service','component'], 'many_to_many', true),
  ('communicates_with',  NULL, 'Communicates With',
    ARRAY['service','component'], ARRAY['service','component'], 'many_to_many', true),
  ('hosted_on',          NULL, 'Hosted On',
    ARRAY['service','component'], ARRAY['deployment-target'], 'many_to_many', true),
  ('governed_by',        NULL, 'Governed By',
    ARRAY['organization','domain','service','component','team'], ARRAY['policy'], 'many_to_many', true),
  ('deploys_to',         NULL, 'Deploys To',
    ARRAY['service','component','change','campaign'], ARRAY['deployment-target'], 'many_to_many', true),
  ('coordinates',        NULL, 'Coordinates',
    ARRAY['campaign','initiative'], ARRAY['change','campaign'], 'many_to_many', true),
  ('synchronizes_with',  NULL, 'Synchronizes With',
    ARRAY['domain'], ARRAY['domain'], 'many_to_many', true),
  ('member_of',          NULL, 'Member Of',
    ARRAY['user','service-account','group','team'], ARRAY['group','team'], 'many_to_many', true),
  ('approves',           NULL, 'Approves',
    ARRAY['user','service-account'], ARRAY['change','campaign'], 'many_to_many', true),
  ('annotates',          NULL, 'Annotates', NULL, NULL, 'many_to_many', true)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================================
-- 7. Built-in roles (DESIGN.md §7 — org_id NULL = built-in template; permissions are M1's
--    enforced set, additive as later milestones introduce e.g. change:promote, policy:write).
-- ===========================================================================================

INSERT INTO roles (id, org_id, name, permissions) VALUES
  (gen_random_uuid(), NULL, 'Viewer',
    ARRAY['object:read','relationship:read','type_registry:read','graph:query','audit:read']),
  (gen_random_uuid(), NULL, 'Operator',
    ARRAY['object:read','relationship:read','type_registry:read','graph:query','audit:read',
          'object:write','relationship:write']),
  (gen_random_uuid(), NULL, 'Approver',
    ARRAY['object:read','relationship:read','type_registry:read','graph:query','audit:read',
          'object:write','relationship:write','approval:write']),
  (gen_random_uuid(), NULL, 'Administrator',
    ARRAY['object:read','relationship:read','type_registry:read','graph:query','audit:read',
          'object:write','relationship:write','approval:write',
          'type_registry:write','role_binding:write']),
  (gen_random_uuid(), NULL, 'Owner',
    ARRAY['object:read','relationship:read','type_registry:read','graph:query','audit:read',
          'object:write','relationship:write','approval:write',
          'type_registry:write','role_binding:write','org:admin'])
ON CONFLICT DO NOTHING;
