-- ================================================================================================
-- INSTANCE-TIER CREDENTIALS — role-model.md §5 step 9, §3B ("SCP_OPERATOR_TOKEN stands, pending
-- credential redesign")
-- ================================================================================================
--
-- WHAT IS BEING REPLACED. Eight operator write doors authenticate with `SCP_OPERATOR_TOKEN`: ONE
-- shared static string, set as an environment variable on every api and worker pod, compared with
-- `timingSafeEqual`. The comparison is the only part of it that was ever right.
--
-- WHY THAT IS THE WRONG SHAPE FOR THE AUTHORITY IT CARRIES. These doors author config that binds
-- EVERY org on the deployment — platform freezes that stop releases estate-wide, scan floors no
-- tenant may loosen, the governance:move rung. The credential guarding them:
--
--   * CANNOT BE ROTATED without redeploying every pod that holds it, so in practice it is not
--     rotated;
--   * CANNOT BE REVOKED FOR ONE PERSON — there is one secret and everyone who has ever operated the
--     deployment has it, including people who have left;
--   * HAS NO EXPIRY, so a value pasted into a runbook in 2026 still opens every door in 2029;
--   * IS NOT ATTRIBUTABLE ON ITS OWN. The routes do also `requireAuth`, so the audit chain names a
--     principal — but the AUTHORITY is the shared string, so "who was entitled to do this" has the
--     same answer for everyone who has ever seen it;
--   * SITS IN PLAINTEXT in pod specs, `kubectl describe`, and every process environment.
--
-- WHAT REPLACES IT: named, hashed, individually revocable, optionally expiring credentials, modelled
-- exactly on `personal_access_tokens` (auth/pat.ts) rather than on a new invention — same
-- `<prefix><tokenId>.<secret>` shape, same argon2-at-rest, same cleartext indexed lookup id, same
-- revoked/expires/last-used columns. Reusing that shape means the verification path is one already
-- reviewed in this codebase, and an operator who understands PATs already understands these.
--
-- THE ENV TOKEN IS NOT DELETED, AND THAT IS DELIBERATE. It remains accepted, because removing it in
-- the same change would (a) lock out every existing deployment on upgrade and (b) leave no way to
-- mint the FIRST credential — a chicken-and-egg that would make this table unreachable. It is now
-- the BOOTSTRAP credential: use it once to mint a real one, then unset it. `auth/operator-auth.ts`
-- records that and reports which mechanism admitted each request.
--
-- ------------------------------------------------------------------------------------------------
-- NO ORG COLUMN, AND NO RLS ISOLATION TO SPEAK OF — stated rather than implied
-- ------------------------------------------------------------------------------------------------
-- This is instance tier: one row set for the deployment, exactly like `instance_freezes` (the
-- DESIGN §4.2 exception). There is no `org_id` to isolate on.
--
-- The read policy admits `scp_app` because VERIFICATION RUNS ON THE REQUEST PATH, as the ordinary
-- request-serving role, on every operator call. So RLS is NOT what keeps a tenant from reading this
-- table — nothing here separates "the verifier selecting a row" from "a tenant route selecting a
-- row", because both are `scp_app`. What keeps it private is that NO ROUTE PROJECTS IT: the listing
-- endpoint returns names and timestamps and is itself operator-gated, and the hash column is never
-- serialized anywhere. Saying so plainly is better than naming the policy `tenant_read` and
-- implying an isolation that does not exist.
--
-- The stored material is argon2 output, so a read discloses no usable secret — but it would
-- disclose how many credentials exist and when they were last used, which is why the door above
-- matters and is asserted in `auth/operator-credentials.integration.test.ts`.

CREATE TABLE IF NOT EXISTS instance_operator_credentials (
  id                 uuid PRIMARY KEY,
  -- Human label, so a revoke names something an operator recognises ("ci-runner", "alice-laptop").
  name               text NOT NULL,
  -- CLEARTEXT indexed lookup key. argon2 output is salted and non-comparable, so a presented
  -- credential cannot be found by hashing it and matching a row; the same reason `pats.token_id`
  -- exists.
  token_id           text NOT NULL,
  token_hash         text NOT NULL,
  -- The graph object of whoever minted it, for attribution. NULLABLE and deliberately NOT a foreign
  -- key: the minter is an ordinary org principal, this table is instance-tier and outside any org,
  -- and an FK from an instance row to an org-scoped row would make deleting an org fail on a
  -- credential that has nothing to do with it. A dangling id here is a weaker record than an FK and
  -- a far weaker coupling; that trade is the right one at this boundary. NULL means "minted with
  -- the bootstrap env token", which is a real and reportable state.
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz,
  revoked_at         timestamptz,
  last_used_at       timestamptz
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "instance_operator_credentials_token_id_key"
  ON instance_operator_credentials (token_id);
--> statement-breakpoint

ALTER TABLE instance_operator_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE instance_operator_credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- READ: the verifier, on the request path, as `scp_app`. Named `operator_verify` and NOT
-- `tenant_read` precisely because it is not a tenant-facing read — see the header.
DROP POLICY IF EXISTS operator_verify ON instance_operator_credentials;
--> statement-breakpoint
CREATE POLICY operator_verify ON instance_operator_credentials
  FOR SELECT USING (true);
--> statement-breakpoint
GRANT SELECT ON instance_operator_credentials TO scp_app;
--> statement-breakpoint

-- `last_used_at` is stamped by the verifier ON THE REQUEST PATH, so `scp_app` needs UPDATE — but a
-- BLANKET update grant here is an escalation path, not a convenience. With it, anything running as
-- the request-serving role could clear `revoked_at` and RESURRECT A REVOKED CREDENTIAL, which is
-- precisely the capability this whole table exists to make real. So the grant is COLUMN-SCOPED: the
-- verifier can stamp when a credential was last used and can change nothing else about it.
--
-- Both halves again: the column grant AND a `FOR UPDATE` policy. FORCE RLS with only the SELECT
-- policy above denies the update outright — and the verifier's stamp is deliberately best-effort
-- (`.catch(() => undefined)`, so a transient failure never refuses a valid operator request), which
-- means that denial is SILENT. It presented as `last_used_at` staying NULL forever with no error
-- anywhere; the integration test is what surfaced it.
GRANT UPDATE (last_used_at) ON instance_operator_credentials TO scp_app;
--> statement-breakpoint
DROP POLICY IF EXISTS operator_touch ON instance_operator_credentials;
--> statement-breakpoint
CREATE POLICY operator_touch ON instance_operator_credentials
  FOR UPDATE TO scp_app USING (true) WITH CHECK (true);
--> statement-breakpoint

-- WRITE: minting and revoking, via the `scp_operator` connection. Both halves required under FORCE
-- RLS, and `WITH CHECK` spelled out — an omitted one on a FOR ALL policy is silent (0086).
GRANT SELECT, INSERT, UPDATE, DELETE ON instance_operator_credentials TO scp_operator;
--> statement-breakpoint
DROP POLICY IF EXISTS operator_write ON instance_operator_credentials;
--> statement-breakpoint
CREATE POLICY operator_write ON instance_operator_credentials
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint

COMMENT ON TABLE instance_operator_credentials IS
  'role-model.md §5 step 9: named, hashed, individually revocable instance-tier operator credentials, replacing the single shared SCP_OPERATOR_TOKEN. Instance tier — no org_id, binds the whole deployment (the DESIGN §4.2 exception, as instance_freezes). Token shape scp_op_<token_id>.<secret>, argon2 at rest, modelled on personal_access_tokens. The env token remains accepted as the BOOTSTRAP credential so upgrades do not lock out and so the first row can be minted.';
