-- M2 stage 2: AuthN expansion (BUILD_AND_TEST.md §8 M2 item 3) — Personal Access Tokens, generic
-- OIDC JIT-provisioned users, and SCP's own device-authorization flow. Hand-authored (like
-- 0002/0003): the two new tables need the same "auth substrate, no RLS" GRANT treatment as
-- orgs/users/sessions (0002 §1), which drizzle-kit's schema diffing cannot express.

-- ===========================================================================================
-- 1. `users`: local password becomes optional (OIDC-provisioned accounts authenticate solely via
--    the IdP — auth/local-auth.ts `login()` treats NULL the same as a wrong password), plus the
--    `sub` claim binding used to recognize a returning OIDC user on their second-and-later login
--    (auth/oidc.ts). Unique per-org: an org may have local-auth users and OIDC users side by
--    side, but a given (org, sub) pair JIT-provisions at most one account.
-- ===========================================================================================

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN oidc_subject text;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_org_id_oidc_subject_key UNIQUE (org_id, oidc_subject);

-- ===========================================================================================
-- 2. Personal Access Tokens (Part A) — see db/schema.ts doc comment for the tokenId/tokenHash
--    split rationale (argon2 output isn't equality-comparable the way SHA-256 is).
-- ===========================================================================================

CREATE TABLE personal_access_tokens (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id),
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  token_id text NOT NULL,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CONSTRAINT personal_access_tokens_token_id_unique UNIQUE (token_id)
);
--> statement-breakpoint
CREATE INDEX pat_org_user ON personal_access_tokens (org_id, user_id);

-- ===========================================================================================
-- 3. Device authorization requests (Part C) — see db/schema.ts doc comment for the security
--    rationale behind briefly storing a plaintext session token in `issued_token`.
-- ===========================================================================================

CREATE TABLE device_auth_requests (
  id uuid PRIMARY KEY,
  device_code_hash text NOT NULL,
  user_code text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  org_id uuid REFERENCES orgs(id),
  issued_token text,
  issued_token_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_auth_requests_device_code_hash_unique UNIQUE (device_code_hash),
  CONSTRAINT device_auth_requests_user_code_unique UNIQUE (user_code)
);

-- ===========================================================================================
-- 4. Auth-substrate grants (mirrors 0002 §1 — orgs/users/sessions: SELECT/INSERT/UPDATE, no RLS,
--    since these tables are read/written before tenant resolution — `require-auth.ts` resolves
--    `app.current_org_id` FROM these rows, not the other way around).
-- ===========================================================================================

GRANT SELECT, INSERT, UPDATE ON personal_access_tokens, device_auth_requests TO scp_app;
