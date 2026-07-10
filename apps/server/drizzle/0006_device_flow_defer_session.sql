-- M2 security fix (post-merge review, MAJOR): device_auth_requests.issued_token held a PLAINTEXT,
-- directly-usable 12h session bearer at rest between approval and the CLI's next poll — the lone
-- exception to "every credential is hashed at rest" (sessions: SHA-256; PATs: argon2). Fixes it by
-- deferring session creation from approve-time to claim-time (auth/device-flow.ts):
-- `approveDeviceAuth` now records only WHO approved and WHEN; `pollDeviceAuth` mints the session
-- inside the existing `FOR UPDATE` claim transaction and returns the plaintext bearer exactly
-- once, never storing it. Hand-authored, same reason as 0004/0005 (no per-migration snapshots
-- committed since 0000, so drizzle-kit's non-interactive diffing can't run here).

-- ===========================================================================================
-- 1. Record the approver instead of a token. `approved_by_user_id` is what `pollDeviceAuth`
--    passes to `createSession` at claim time (device-flow.ts, session.ts's `createSession`).
-- ===========================================================================================

ALTER TABLE device_auth_requests ADD COLUMN approved_by_user_id uuid REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE device_auth_requests ADD COLUMN approved_at timestamptz;

-- ===========================================================================================
-- 2. Drop the plaintext-token columns — the device row must never hold a usable credential.
-- ===========================================================================================

--> statement-breakpoint
ALTER TABLE device_auth_requests DROP COLUMN issued_token;
--> statement-breakpoint
ALTER TABLE device_auth_requests DROP COLUMN issued_token_expires_at;
