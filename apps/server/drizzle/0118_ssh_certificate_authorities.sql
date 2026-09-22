-- `ssh_certificate_authorities` + `ssh_certificate_issuances` — M27.5, ADR-0051.
--
-- ===========================================================================================
-- ONE CA PER DOMAIN, NEVER FLEET-WIDE (ADR-0051 D2)
-- ===========================================================================================
-- The managed-execution tier already forbids a runner bridging network segments. A single
-- fleet-wide signing key would contradict that at the credential layer: one compromise would
-- reach every host in every domain, which is precisely the "fleet-wide crown jewel" the guardian
-- review flagged. Scoping the CA to a domain bounds a compromise to that domain's hosts.
--
-- THE PRIVATE KEY IS NOT STORED HERE. `private_key_secret_key` references the org-scoped
-- encrypted secret store; the material is decrypted only at use. ADR-0051 D3 is the owner's
-- deliberate relaxation of ADR-0002's "HSM/KMS or offline signing" clause, with the trade written
-- down — cloud KMS is unreachable air-gapped (principle 5) and minutes-TTL per-run issuance rules
-- out pure offline signing. Keeping the material one indirection away means a row leak is not a
-- key leak, which is a smaller claim than HSM custody and is the honest one.
--
-- ===========================================================================================
-- WHY `status` RATHER THAN ONE ROW PER DOMAIN
-- ===========================================================================================
-- Rotation is TWO pushes, not one: every host must trust the incoming CA BEFORE the outgoing one
-- is withdrawn, or the rotation locks the fleet out. So a domain mid-rotation legitimately has an
-- `active` and a `retiring` CA at once — and doubled blast radius for that window, which is a real
-- cost of rotation rather than a free mitigation. A one-row-per-domain shape could not express the
-- window, so it would be implemented by deleting and recreating, which is the lockout.
--
-- ===========================================================================================
-- `ssh_certificate_issuances` IS THE DETECTIVE CONTROL (ADR-0051 D5)
-- ===========================================================================================
-- Short TTLs do NOT bound CA compromise: sshd honours the validity interval INSIDE the
-- certificate, and an attacker holding the key picks it. Minutes-TTL binds only SCP. Against key
-- compromise the controls are revocation, rotation and DETECTION — and this table is detection.
-- sshd logs the serial of every certificate it accepts (measured: it appears in ordinary
-- `Accepted publickey ... ID <key-id> (serial N) CA ...` output, no special logging needed), so a
-- serial a host honoured with no row here is evidence of forgery.
--
-- BOTH CREDENTIAL PATHS ARE RECORDED. A BYO issuance has no `authority_id` — SCP holds no key that
-- minted it — but it still gets a row, because the question reconciliation asks is "did SCP cause
-- this certificate to exist?", and on the BYO path SCP requested it. Recording only SCP-CA
-- issuances would leave the blind spot exactly where the STRONGER credential path is used.
--
-- `serial` is TEXT: Vault returns decimal strings, and SCP generates `scp-local:<uuid>` when an
-- authority returns none. One column that holds every real serial beats a numeric column plus a
-- nullable fallback that every reconciliation query would have to check twice.

CREATE TABLE IF NOT EXISTS ssh_certificate_authorities (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  domain_id uuid NOT NULL,
  public_key text NOT NULL,
  private_key_secret_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT ssh_ca_status_known CHECK (status IN ('active', 'retiring', 'retired'))
);

CREATE INDEX IF NOT EXISTS ssh_ca_org_domain_idx
  ON ssh_certificate_authorities (org_id, domain_id, status);

-- At most ONE active CA per domain. Partial, so the `retiring` row a rotation needs is still
-- allowed alongside it — the constraint that matters is "never two things minting at once".
CREATE UNIQUE INDEX IF NOT EXISTS ssh_ca_one_active_per_domain
  ON ssh_certificate_authorities (org_id, domain_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ssh_certificate_issuances (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  authority_id uuid,
  authority_name text NOT NULL,
  serial text NOT NULL,
  key_id text NOT NULL,
  principals text[] NOT NULL,
  target_hosts text[] NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ssh_issuance_org_serial_uq
  ON ssh_certificate_issuances (org_id, serial);

-- A new write verb needs its GRANT and its RLS policy. The integration superuser hides an
-- omission, so it would surface as a 500 on an authorized request, or as nothing at all.
GRANT SELECT, INSERT, UPDATE, DELETE ON ssh_certificate_authorities TO scp_app;
GRANT SELECT, INSERT ON ssh_certificate_issuances TO scp_app;

ALTER TABLE ssh_certificate_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ssh_certificate_issuances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation ON ssh_certificate_authorities;
CREATE POLICY org_isolation ON ssh_certificate_authorities
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS org_isolation ON ssh_certificate_issuances;
CREATE POLICY org_isolation ON ssh_certificate_issuances
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- NO UPDATE OR DELETE GRANT ON `ssh_certificate_issuances`, deliberately. It is an append-only
-- evidence log: an attacker who can delete the record of a certificate they minted defeats the
-- reconciliation that exists to catch them. Retention is a separate, deliberate operator act.
