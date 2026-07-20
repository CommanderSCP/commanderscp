-- ===========================================================================================
-- M17.3 E4 — the org-scoped cosign MANIFEST-SIGNING keypair table (`instance_cosign_keys`).
--
-- WHAT THIS IS. Each org's commander signs its OWN promotion manifests (M17.3 E6) with a cosign
-- keypair; outposts verify that org's public key. This table holds exactly one such keypair per
-- org: the cosign PRIVATE key (stored as cosign's empty-password *encrypted* PEM — the exact bytes
-- of `cosign.key`) and the matching PUBLIC key PEM (`cosign.pub`). No key material is ever seeded
-- here — like `instance_keys`, the row is created lazily on first use by
-- `governance/cosign-keys.ts`'s `ensureInstanceCosignKey` (key material must never live in
-- committed SQL).
--
-- WHY A DEDICATED TABLE, NOT THE SECRETS VAULT (owner decision, M17.3 grounding Area C). The
-- AES-GCM `secrets` table is reachable by `secrets/secrets-repo.ts` `resolveSecretRefs`: any
-- `executor_bindings.secretRefs` entry an org authors names a `secrets` ROW by key, and
-- `plugin-host/host.ts` injects the resolved plaintext into a plugin subprocess' env. Putting the
-- SCP signing key in `secrets` would make it pullable into a plugin that way. A DEDICATED table is
-- STRUCTURALLY unreachable by `resolveSecretRefs` — it queries `secrets` only and has no code path
-- to `instance_cosign_keys` — so the vault-exfiltration hole cannot apply. Proven by test
-- (governance/cosign-keys.integration.test.ts, the "exfiltration guard" case).
--
-- WHY NOT `instance_keys` EITHER. `instance_keys` holds the org's *Ed25519* identity key
-- (approval attestations + federation journal signing, DESIGN §10.2/§13). The cosign key is a
-- different key type, for a different verifier (cosign's own `verify-blob`), with a different
-- lifecycle (E5 distributes the public half to outposts). Keeping them in separate tables keeps
-- each key's blast radius and rotation independent. This table MIRRORS `instance_keys`' posture
-- exactly: ORG-SCOPED (one row per org), unique(org_id), and full `org_isolation` RLS
-- (drizzle/0016_instance_keys_rls.sql) so an org can only ever see its own row.
--
-- ON THE EMPTY-PASSWORD PEM. `cosign generate-key-pair` is run with COSIGN_PASSWORD='' (the same
-- non-interactive posture deploy/airgap/src/cosign.ts already uses), so the stored PEM is
-- cosign's encrypted-PEM envelope with an empty passphrase. The REAL protection is this table's
-- RLS + dedicated-table isolation — exactly the same narrow "plaintext-with-RLS" exception
-- `instance_keys` documents (db/schema.ts). Documented honestly rather than implying the PEM's
-- own passphrase is doing the protecting.
--
-- Hand-authored (same convention as 0002/0007/0010/0011/0014/0016/0029): RLS/grants are never
-- expressible in drizzle-kit's schema diffing.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "instance_cosign_keys" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  -- cosign's empty-password encrypted PEM (the exact bytes of `cosign.key`). Server-side only;
  -- NEVER returned over any HTTP API or SDK type (E6 materializes it to an ephemeral tmpfile at
  -- sign time; E4 only exposes an internal accessor for that future use).
  "private_key" text NOT NULL,
  -- the matching cosign public-key PEM (`cosign.pub`). A public key is not a secret; E5 distributes
  -- this half to outposts for verification.
  "public_key" text NOT NULL,
  -- SHA-256 (hex) of the public-key PEM bytes — a stable, non-secret identifier for the keypair,
  -- convenient for E5's distribution/selection without parsing the PEM. Nullable/derived, not a key.
  "fingerprint" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- One keypair per org (each org's commander signs its own promotions). Same shape as
-- `instance_keys_org_id_key`; makes `ensureInstanceCosignKey`'s race-safe INSERT ... ON CONFLICT
-- (org_id) DO NOTHING converge on a single row under concurrent first-use.
CREATE UNIQUE INDEX IF NOT EXISTS "instance_cosign_keys_org_id_key" ON "instance_cosign_keys" USING btree ("org_id");
--> statement-breakpoint

-- Grants — MIRROR `instance_keys` (drizzle/0010_governance.sql): `scp_app` gets SELECT + INSERT
-- only, never UPDATE/DELETE. Lazy first-use provisioning only ever SELECTs then INSERTs (with
-- ON CONFLICT DO NOTHING); the keypair is never mutated or deleted over the request-serving role.
GRANT SELECT, INSERT ON "instance_cosign_keys" TO scp_app;
--> statement-breakpoint

-- RLS — identical `org_isolation` shape as `instance_keys` (drizzle/0016_instance_keys_rls.sql)
-- and every other tenant table: an org sees and writes ONLY its own row; a forgotten `WHERE
-- org_id = ...` in any future code path still cannot cross tenants (DESIGN §4.2's "two independent
-- failures" invariant). `ensureInstanceCosignKey` always runs inside `withTenantTx`, so this
-- closes the gap with zero impact on the legitimate access path.
ALTER TABLE "instance_cosign_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "instance_cosign_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON "instance_cosign_keys";
--> statement-breakpoint
CREATE POLICY org_isolation ON "instance_cosign_keys"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
