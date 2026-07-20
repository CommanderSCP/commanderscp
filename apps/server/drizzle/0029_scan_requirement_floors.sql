-- ===========================================================================================
-- M17.5 — the INSTANCE-SCOPED scan-requirement floor table (ADR-0016 §3).
--
-- ADR-0016 makes scan pass-criteria scoped + most-restrictive-wins over SIX tiers:
--
--   platform -> trust domain (partition) -> org -> containment domain -> service -> component
--
-- The four ORG-AND-BELOW tiers are ordinary graph/policy data resolved by the EXISTING stricter-
-- wins machinery (`governance/policy-resolve.ts` `matchPoliciesForTargets` + `graph/containment.ts`
-- `containmentChain`), unchanged — nothing here. The two ABOVE-ORG tiers cannot be expressed there
-- at all: `containmentChain` is org-rooted and org-filtered on every join, so it structurally
-- cannot reach above org. They get exactly ONE new structure, this table.
--
-- TWO SENSES OF "DOMAIN" (ADR-0016 terminology). The `tier` literal is spelled `trust_domain`,
-- NEVER bare `domain`: the trust domain (partition) is the AMBIENT FEDERATION boundary ABOVE org,
-- whereas `domain` is already taken by the intra-org containment `domain` OBJECT TYPE seeded in
-- 0002_rls_rbac_seed.sql:152, which sits BELOW org (`db/schema.ts:944-947` records that these are
-- different concepts). Spelling the value `trust_domain` makes the two impossible to confuse in
-- stored data.
--
-- NO `org_id` COLUMN — deliberately, and it is the documented exception to DESIGN §4.2's
-- "`org_id NOT NULL` on every tenant-scoped table" invariant. A deployment is in exactly ONE
-- partition (ambient, like an AWS partition), so a trust-domain floor applies to EVERY org hosted
-- on the deployment; per-org rows would encode a fact already true of the whole deployment and
-- would invite a tenant-writable surface. `origin` records whether a row was authored by this
-- deployment's operator (`local`) or arrived over federation from the commander (`federated`,
-- DESIGN §13 "the commander is the source of truth for global config; outposts hold it read-only").
--
-- TENANT-READ / OPERATOR-WRITE, following the PATTERN of the nullable-org_id global rows on
-- object_types/relationship_types/roles (0002_rls_rbac_seed.sql:44-70 — operator-set, tenant-
-- readable, never tenant-writable) but as its OWN table, precisely because that pattern cannot be
-- applied in place: the `objects` RLS policy deliberately has NO `OR org_id IS NULL` escape
-- (0002:73-77), and ADR-0016 §3 explicitly REJECTS both (a) adding one (it would widen the
-- tenant-isolation blast radius of every graph object) and (b) a privileged table living outside
-- tenant RLS read over the privileged connection (every read path would then have to hand-guarantee
-- what RLS guarantees structurally).
--
-- TWO INDEPENDENT BARRIERS keep a tenant from writing (DESIGN §4.2's "cross-tenant leakage requires
-- two independent failures"):
--   1. GRANT: `scp_app` (the request-serving login role, NOSUPERUSER/NOBYPASSRLS) gets SELECT only.
--      INSERT/UPDATE/DELETE are explicitly REVOKEd.
--   2. RLS: the only policy is `FOR SELECT`. There is NO permissive policy for INSERT/UPDATE/DELETE,
--      so even if a future migration mistakenly re-granted write privileges, every tenant write
--      would still be denied by RLS.
-- Operator writes therefore run over the ADMIN/superuser connection (routes/instance-scan-floors.ts),
-- never over the request-serving pool. Reads stay inside ordinary tenant-scoped access, so no gate
-- evaluation path ever needs the privileged connection (ADR-0016 §3's stated reason for preferring
-- this over rejected option (b)).
--
-- EVERY SEVERITY CEILING IS NULLABLE. NULL means "this tier sets no ceiling for this severity" and
-- therefore does not contribute to the per-severity MIN. "No floor" is NEVER read as 0 — 0 is the
-- TIGHTEST possible ceiling, so defaulting absent tiers to 0 would silently block everything.
--
-- Hand-authored (same convention as 0002/0007/0010/0011/0014/0017/0028): RLS/grants are never
-- expressible in drizzle-kit's schema diffing.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "scan_requirement_floors" (
  "tier" text NOT NULL,
  "origin" text NOT NULL DEFAULT 'local',
  "max_critical" integer,
  "max_high" integer,
  "max_medium" integer,
  "max_low" integer,
  "note" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "scan_requirement_floors_pk" PRIMARY KEY ("tier", "origin"),
  -- The literal is `trust_domain`, never bare `domain` (see the header) — enforced in the DB so a
  -- future writer cannot store the ambiguous spelling.
  CONSTRAINT "scan_requirement_floors_tier_ck" CHECK ("tier" IN ('platform', 'trust_domain')),
  CONSTRAINT "scan_requirement_floors_origin_ck" CHECK ("origin" IN ('local', 'federated')),
  CONSTRAINT "scan_requirement_floors_nonneg_ck" CHECK (
    ("max_critical" IS NULL OR "max_critical" >= 0)
    AND ("max_high" IS NULL OR "max_high" >= 0)
    AND ("max_medium" IS NULL OR "max_medium" >= 0)
    AND ("max_low" IS NULL OR "max_low" >= 0)
  )
);
--> statement-breakpoint

-- Barrier 1 — the request-serving role may only READ.
GRANT SELECT ON scan_requirement_floors TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON scan_requirement_floors FROM scp_app;
--> statement-breakpoint

-- Barrier 2 — RLS with a SELECT-only policy. USING (true): the row set is instance-wide config
-- holding NO per-tenant data at all, so it exposes no cross-tenant visibility (there is nothing of
-- another tenant's in it). The absence of any INSERT/UPDATE/DELETE policy is the write denial.
ALTER TABLE scan_requirement_floors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scan_requirement_floors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON scan_requirement_floors;
--> statement-breakpoint
CREATE POLICY tenant_read ON scan_requirement_floors FOR SELECT USING (true);
--> statement-breakpoint

-- ===========================================================================================
-- Policy document schema — the org-and-below tiers' scan ceilings, as ORDINARY POLICY DATA
-- (charter principle 2: new concepts arrive as relationship/policy data, not new tables).
--
-- ADDITIVE: one more optional key inside an `effects[]` item, alongside `requireControls` /
-- `requireApprovals` (0010_governance.sql:209-226). A policy authored at an org / containment
-- domain / service / component declares `{"scanThreshold": {"maxHigh": 0}}`; the gate resolves the
-- per-severity MIN across every matched policy's contribution plus the instance floors above.
-- Existing documents are unaffected (no `additionalProperties: false` was ever set, so this
-- codifies rather than restricts).
-- ===========================================================================================

UPDATE object_types SET property_schema = '{
  "type": "object",
  "required": ["enforcement"],
  "properties": {
    "scope": {
      "type": "object",
      "properties": {
        "selector": {
          "type": "object",
          "properties": { "labels": { "type": "object" } }
        },
        "objectRef": { "type": "string" },
        "group": { "type": "string" }
      }
    },
    "enforcement": { "type": "string", "enum": ["advisory", "recommended", "required"] },
    "condition": { "type": "string" },
    "effects": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "requireControls": { "type": "array", "items": { "type": "string" } },
          "requireApprovals": {
            "type": "object",
            "required": ["count", "fromRole"],
            "properties": {
              "count": { "type": "integer", "minimum": 1 },
              "fromRole": { "type": "string" },
              "scope": { "type": "string" }
            }
          },
          "scanThreshold": {
            "type": "object",
            "properties": {
              "maxCritical": { "type": "integer", "minimum": 0 },
              "maxHigh": { "type": "integer", "minimum": 0 },
              "maxMedium": { "type": "integer", "minimum": 0 },
              "maxLow": { "type": "integer", "minimum": 0 }
            }
          }
        }
      }
    },
    "emergencyPolicy": { "type": "boolean" },
    "autoRollbackOnFailure": { "type": "boolean" }
  }
}'::jsonb
WHERE id = 'policy';
