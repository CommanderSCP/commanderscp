-- `ssh_ca_enrolments` — M27.8, ADR-0051's recovery precondition made enforceable.
--
-- ADR-0051's blast-radius analysis ends on a circularity: an estate whose ONLY access route is
-- SCP's CA cannot recover from SCP's CA being compromised. Revocation is a fleet-wide push, and
-- the push needs access. So an INDEPENDENT access path is a precondition of enrolment rather than
-- something discovered during an incident, and this table is where it is recorded.
--
-- `break_glass` is FREE TEXT, deliberately. SCP cannot verify that an out-of-band console, a jump
-- host or a hardware KVM actually works; asserting a structure over it would be theatre. What SCP
-- can do is refuse to enrol a domain where nobody wrote the answer down, and keep that answer
-- beside the credential it is the recovery for. The CHECK enforces "non-empty after trimming",
-- which is the strongest claim this column can honestly make.

CREATE TABLE "ssh_ca_enrolments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"authority_id" uuid NOT NULL,
	"break_glass" text NOT NULL,
	"recorded_by_subject_id" uuid NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_ca_enrolment_break_glass_present" CHECK (length(btrim("ssh_ca_enrolments"."break_glass")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_ca_enrolment_one_per_domain" ON "ssh_ca_enrolments" USING btree ("org_id","domain_id");
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON ssh_ca_enrolments TO scp_app;--> statement-breakpoint
-- NO UPDATE: the break-glass path recorded at enrolment is the one that was accepted. Changing it
-- in place would rewrite the record of what an operator agreed to without leaving a trace; a
-- changed recovery story is a re-enrolment (DELETE then INSERT), which is visible.

ALTER TABLE ssh_ca_enrolments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON ssh_ca_enrolments;--> statement-breakpoint
CREATE POLICY org_isolation ON ssh_ca_enrolments
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
