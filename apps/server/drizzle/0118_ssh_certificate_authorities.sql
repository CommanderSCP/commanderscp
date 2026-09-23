-- `ssh_certificate_authorities` + `ssh_certificate_issuances` — M27.5, ADR-0051.
--
-- ONE CA PER DOMAIN, NEVER FLEET-WIDE (D2). The managed-execution tier already forbids a runner
-- bridging network segments; one fleet-wide signing key would contradict that at the credential
-- layer, since a single compromise would reach every host in every domain. Scoping the CA to a
-- domain bounds a compromise to that domain's hosts.
--
-- THE PRIVATE KEY IS NOT STORED HERE. `private_key_secret_key` references the org-scoped encrypted
-- store; material is decrypted only at use. D3 is the owner's deliberate relaxation of ADR-0002's
-- "HSM/KMS or offline signing" clause — cloud KMS is unreachable air-gapped (principle 5), and
-- minutes-TTL per-run issuance rules out pure offline signing. "A row leak is not a key leak" is a
-- smaller claim than HSM custody and it is the honest one.
--
-- WHY `status` AND A PARTIAL INDEX RATHER THAN ONE ROW PER DOMAIN. Rotation is TWO pushes: every
-- host must trust the incoming CA BEFORE the outgoing one is withdrawn, or the rotation locks the
-- fleet out. A domain mid-rotation therefore legitimately holds an `active` AND a `retiring` row,
-- with doubled blast radius for that window. A one-row-per-domain shape could not express it and
-- would be implemented by delete-then-recreate, which IS the lockout. The partial unique index
-- enforces the invariant that actually matters: never two authorities minting at once.
--
-- `ssh_certificate_issuances` IS THE DETECTIVE CONTROL (D5). Short TTLs do NOT bound CA
-- compromise — sshd honours the validity interval INSIDE the certificate, and an attacker holding
-- the key picks it, so minutes-TTL binds only SCP. Against key compromise the controls are
-- revocation, rotation and DETECTION. sshd logs the serial of every certificate it accepts
-- (measured: ordinary `Accepted publickey ... ID <key-id> (serial N) CA ...` output, no special
-- logging), so a serial a host honoured with no row here is evidence of forgery.
--
-- BOTH CREDENTIAL PATHS ARE RECORDED. A BYO issuance has no `authority_id` — SCP holds no key that
-- minted it — but it still gets a row, because the question reconciliation asks is "did SCP cause
-- this certificate to exist?", and on the BYO path SCP requested it. Recording only SCP-CA
-- issuances would leave the blind spot exactly where the STRONGER path is used.
--
-- `serial` is TEXT: Vault returns decimal strings and SCP generates `scp-local:<uuid>` when an
-- authority returns none. One column holding every real serial beats a numeric column plus a
-- nullable fallback every reconciliation query would have to check twice.
--
-- The DDL below is drizzle-kit generated from schema.ts; the GRANTs and RLS policies after it are
-- hand-written, because drizzle emits neither.

CREATE TABLE "ssh_certificate_authorities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"private_key_secret_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "ssh_ca_status_known" CHECK ("ssh_certificate_authorities"."status" IN ('active', 'retiring', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "ssh_certificate_issuances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"authority_id" uuid,
	"authority_name" text NOT NULL,
	"serial" text NOT NULL,
	"key_id" text NOT NULL,
	"principals" text[] NOT NULL,
	"target_hosts" text[] NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ssh_ca_org_domain_idx" ON "ssh_certificate_authorities" USING btree ("org_id","domain_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_ca_one_active_per_domain" ON "ssh_certificate_authorities" USING btree ("org_id","domain_id") WHERE "ssh_certificate_authorities"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_issuance_org_serial_uq" ON "ssh_certificate_issuances" USING btree ("org_id","serial");
--> statement-breakpoint
-- A new write verb needs its GRANT and its RLS policy. The integration superuser hides an
-- omission, so it would surface as a 500 on an authorized request — or as nothing at all.
GRANT SELECT, INSERT, UPDATE, DELETE ON ssh_certificate_authorities TO scp_app;--> statement-breakpoint
-- NO UPDATE OR DELETE on issuances, deliberately: this is an append-only evidence log, and an
-- attacker who can delete the record of a certificate they minted defeats the control that exists
-- to catch them. Retention is a separate, deliberate operator act.
GRANT SELECT, INSERT ON ssh_certificate_issuances TO scp_app;--> statement-breakpoint

ALTER TABLE ssh_certificate_authorities ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ssh_certificate_issuances ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS org_isolation ON ssh_certificate_authorities;--> statement-breakpoint
CREATE POLICY org_isolation ON ssh_certificate_authorities
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS org_isolation ON ssh_certificate_issuances;--> statement-breakpoint
CREATE POLICY org_isolation ON ssh_certificate_issuances
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
