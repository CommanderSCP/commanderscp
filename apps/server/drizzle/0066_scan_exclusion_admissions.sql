-- ===========================================================================================
-- M22.2 — THE EXCLUSION DIMENSION'S ADMISSION SUBSTRATE (ADR-0033 §1, §7a).
--
-- Two things, and only two:
--   1. `scan_exclusion_admissions` — the INSTANCE-SCOPED `platform` and `trust_domain` rungs of the
--      monotone AND. A row says "this deployment admits exclusions of CLASS X beneath this tier".
--   2. one more optional key inside a `policy` document's `effects[]` items, so a `scanExclusion`
--      effect VALIDATES. That effect carries BOTH org-and-below halves — a tier's `admit` of a
--      class, and a tier's `exclude` clause.
--
-- ===========================================================================================
-- WHY THE INSTANCE TIERS GET A TABLE AND THE ORG-AND-BELOW TIERS GET NOTHING
--
-- Identical to ADR-0016 §3's split, for the identical reason: `containmentChain` is org-rooted and
-- org-filtered on every join, so it structurally cannot reach ABOVE org. The four org-and-below
-- tiers are ordinary policy data on the existing `matchPoliciesForTargets` resolver and need no
-- storage at all (charter principle 2 — new concepts arrive as relationship/POLICY/registry data).
-- Only the two above-org rungs are new structure, and they share ONE table.
--
-- ===========================================================================================
-- INSTANCE-SCOPED, SO NO `org_id` — THE SAME DOCUMENTED EXCEPTION, A SECOND INSTANCE OF IT
--
-- ADR-0033 §7a is explicit that this is "the SAME documented exception to the DESIGN §4.2 `org_id
-- NOT NULL` invariant, for the same reason — an admission is an operator statement about the
-- DEPLOYMENT, not tenant data. It is a second instance of that exception, not a second kind of
-- exception." The precedent chain is 0029 (`scan_requirement_floors`) -> 0035 -> 0036 -> 0062, and
-- this table mirrors 0029 column-for-column in its access shape.
--
-- READ THE NEIGHBOUR CAREFULLY BEFORE COPYING, because M22's two new tables are deliberately
-- OPPOSITE and one M22.1b reviewer nearly transposed them:
--   * `scan_findings` (0065) is ORDINARY TENANT DATA — `org_id NOT NULL`, standard `org_isolation`
--     RLS. It records what a scanner saw for one tenant's artifact.
--   * THIS table is INSTANCE CONFIG — no `org_id`, operator-write / tenant-read. It records what
--     the deployment's operator will tolerate, identically for every org hosted here.
--
-- TWO INDEPENDENT BARRIERS keep a tenant from writing (DESIGN §4.2's "cross-tenant leakage requires
-- two independent failures"), copied verbatim from 0029:
--   1. GRANT: `scp_app` (the request-serving login role, NOSUPERUSER/NOBYPASSRLS) gets SELECT only.
--      INSERT/UPDATE/DELETE are explicitly REVOKEd.
--   2. RLS: the only policy is `FOR SELECT`. There is NO permissive policy for INSERT/UPDATE/DELETE,
--      so even a future migration that mistakenly re-granted write privileges would still see every
--      tenant write denied by RLS.
-- Reads stay inside ordinary tenant-scoped access, so NO gate evaluation path needs the privileged
-- connection (ADR-0016 §3's stated reason for preferring this over a privileged table).
--
-- ===========================================================================================
-- THE TABLE SHIPS EMPTY, AND THAT IS THE FEATURE
--
-- A ROW IS AN ADMISSION; NO ROW IS NO ADMISSION. There is no "default admitted" and no seed. With
-- this table empty — its state on every existing deployment the moment this migration runs — the
-- `platform` rung admits nothing, every clause beneath it fails the AND, and behaviour is
-- byte-identical to pre-M22.2. That is ADR-0033 §1's "default admission is EMPTY at every tier",
-- expressed as the absence of rows rather than as a boolean somebody could default the wrong way.
--
-- Note the sign is the OPPOSITE of 0029's neighbour and must not be reasoned about by analogy: on
-- `scan_requirement_floors` an absent row means NO CEILING (a loosening); here an absent row means
-- NO ADMISSION (a tightening). Both are the safe direction for their own dimension, which is the
-- whole of ADR-0033 §1 — a tightening and a loosening cannot share a default.
--
-- `class` CARRIES ITS ENUM AS A CHECK, unlike 0061's deliberate refusal to constrain
-- `dependency_lines.ecosystem`, and for the reason 0062's header gives one level down: the
-- direction of failure differs. An unrecognised value on an OBSERVATION row is data that never
-- matches; an unrecognised value HERE is an admission that admits nothing recognisable — which is
-- safe — but far more importantly it is an operator's typo silently producing an admission they
-- believe they granted, and the clause beneath it staying inert with no error anywhere. Refusing
-- `'no_fix_availble'` at write time is worth the second copy of the list. The price is stated
-- rather than discovered: a fifth exclusion class is a migration HERE as well as a
-- `ScanExclusionClassSchema` edit, and `scan-exclusions.integration.test.ts` pins that the two
-- lists agree.
--
-- ===========================================================================================
-- WHY THIS IS 0066
--
-- drizzle gates on `when` ALONE (`idx` orders the array and decides nothing) and it SILENTLY SKIPS
-- an entry whose `when` does not exceed what a database has already applied — no error, no warning,
-- surfacing later as a missing table. This entry's `when` (1788109137000) was set strictly greater
-- than main's actual maximum at the time of writing (1788099137000, `0065_scan_findings`), read
-- from the journal rather than inferred. If this branch merges behind another migration, BOTH `idx`
-- AND `when` must be bumped again — the check is "strictly greater than every entry now ahead of
-- it", never "different from them". `src/db/journal-ordering.test.ts` guards the FILE.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "scan_exclusion_admissions" (
  "tier" text NOT NULL,
  "class" text NOT NULL,
  "origin" text NOT NULL DEFAULT 'local',
  "note" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "scan_exclusion_admissions_pk" PRIMARY KEY ("tier", "class", "origin"),
  -- The literal is `trust_domain`, never bare `domain` — the trust domain (partition) is the
  -- AMBIENT federation boundary ABOVE org, while `domain` is the intra-org containment object type
  -- BELOW org (0029's header records the two senses in full).
  CONSTRAINT "scan_exclusion_admissions_tier_ck" CHECK ("tier" IN ('platform', 'trust_domain')),
  -- Must agree with `ScanExclusionClassSchema` in packages/schemas/src/supply-chain.ts.
  CONSTRAINT "scan_exclusion_admissions_class_ck" CHECK (
    "class" IN ('no_fix_available', 'vendor_latest', 'declared_fact', 'approved_override')
  ),
  CONSTRAINT "scan_exclusion_admissions_origin_ck" CHECK ("origin" IN ('local', 'federated'))
);
--> statement-breakpoint

-- Barrier 1 — the request-serving role may only READ.
GRANT SELECT ON scan_exclusion_admissions TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON scan_exclusion_admissions FROM scp_app;
--> statement-breakpoint

-- Barrier 2 — RLS with a SELECT-only policy. USING (true): the row set is instance-wide config
-- holding NO per-tenant data at all, so it exposes no cross-tenant visibility (there is nothing of
-- another tenant's in it). The absence of any INSERT/UPDATE/DELETE policy is the write denial.
ALTER TABLE scan_exclusion_admissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scan_exclusion_admissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON scan_exclusion_admissions;
--> statement-breakpoint
CREATE POLICY tenant_read ON scan_exclusion_admissions FOR SELECT USING (true);
--> statement-breakpoint

-- ===========================================================================================
-- Policy document schema — the `scanExclusion` EFFECT (ADR-0033 §1).
--
-- ADDITIVE, authored the way 0029 added `scanThreshold` and 0062 added `dependencySubscription`:
-- one more optional key inside an `effects[]` item. The UPDATE re-states the WHOLE document because
-- `property_schema` is a single jsonb value; diff this against 0062 to see only what changed.
--
-- ONE EFFECT KIND CARRYING BOTH HALVES, not two. A tier admits a CLASS beneath it:
--     {"scanExclusion": {"admit": ["no_fix_available"]}}
-- and a tier contributes a CLAUSE:
--     {"scanExclusion": {"exclude": {"class": "no_fix_available", "pkgName": "openssl"}}}
-- Splitting these into two effect keys would let a reader of a document believe an `admit` had been
-- authored where an `exclude` was — and the two are opposite ends of the same monotone AND, so a
-- document that carries one is always read in the context of the other.
--
-- `class` IS REQUIRED ON A CLAUSE, and it is load-bearing rather than tidy: the class is the
-- ADMISSION KEY, so a clause without one could never be admitted by anything, and a document that
-- omitted it would be an exclusion nobody above ever agreed to. Requiring it turns that into a 400
-- at authoring time.
--
-- `additionalProperties: false` ON THE `scanExclusion` BLOCK AND ON ITS `exclude` SUB-OBJECT, and
-- here the argument is STRONGER than 0062's. For an opt-out, a mistyped selector key voids the
-- selector and fails open. For an EXCLUSION, a mistyped NARROWING key is stripped by the resolver's
-- Zod parse and the clause arrives with FEWER matchers — which is a WIDENING of a loosening.
-- `{"class": "no_fix_available", "pkgNmae": "openssl"}` would silently become "every finding with
-- no fix, anywhere in this scope". Refused here for an authoring write, and refused again by
-- `ScanExclusionClauseSchema`'s `z.strictObject` for a document that reached the resolver by any
-- other route.
--
-- `additionalProperties: false` IS ALSO ADDED TO `requireApprovals` AND `scanThreshold` — every
-- effect kind that is an OBJECT is now closed (`dependencySubscription` already was; `requireControls`
-- is an array of strings and has nothing to close). A mistyped key INSIDE a listed effect block is
-- stripped and the effect silently means something looser than it reads: `{"scanThreshold":
-- {"maxHgh": 0}}` currently writes cleanly and sets no ceiling at all.
--
-- ===========================================================================================
-- WHAT IS DELIBERATELY *NOT* CLOSED, AND WHY — read this before "finishing the job".
--
-- The enclosing `effects[]` ITEM still has NO `additionalProperties: false`, so a typo in the OUTER
-- key (`{"scanTreshold": {...}}`, `{"scanExclusio": {...}}`) is still accepted and makes the whole
-- effect VANISH. 0062's header names this as owed and says, correctly, that "it needs its own
-- decision, taken for all four effect kinds at once". That decision has NOT been taken, and
-- ADR-0033 does not take it. Two measured reasons it is not taken here as a side effect of a scan
-- feature:
--
--   1. IT WOULD REFUSE DOCUMENTS THAT EXIST. `effects[]` is a free-form document in practice — 0010
--      and 0029 both left the item open, and this tree already contains a policy authored with an
--      effect shape the schema never listed (`governance/service-policy-scope.integration.test.ts`
--      writes `{"kind": "requireApproval", "quorum": 1, "role": "Approver"}`). Closing the item
--      refuses that document and every other unlisted shape on its NEXT write, for `requireControls`
--      and `scanThreshold` authors as much as for this feature.
--   2. IT WOULD WEDGE FEDERATION. `import-repo.ts`'s `object_upsert` branch Ajv-validates with NO
--      try/catch, so ONE peer policy carrying an unlisted effect shape aborts that peer's ENTIRE
--      signed bundle. That is the same hazard 0061's header records as reason 3 and that 0062
--      deliberately avoided; it is not a hazard worth introducing to catch a typo.
--
-- The right lever for the outer typo is authoring-time refusal on the ROUTE (M22.8 already plans
-- one: refuse a `scanThreshold`/`scanExclusion` policy naming no scan control in `requireControls`),
-- which can reject with a message naming the unknown key and cannot abort a peer's bundle.
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
            "additionalProperties": false,
            "properties": {
              "count": { "type": "integer", "minimum": 1 },
              "fromRole": { "type": "string" },
              "scope": { "type": "string" }
            }
          },
          "scanThreshold": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "maxCritical": { "type": "integer", "minimum": 0 },
              "maxHigh": { "type": "integer", "minimum": 0 },
              "maxMedium": { "type": "integer", "minimum": 0 },
              "maxLow": { "type": "integer", "minimum": 0 }
            }
          },
          "scanExclusion": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "admit": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": ["no_fix_available", "vendor_latest", "declared_fact", "approved_override"]
                }
              },
              "exclude": {
                "type": "object",
                "required": ["class"],
                "additionalProperties": false,
                "properties": {
                  "class": {
                    "type": "string",
                    "enum": ["no_fix_available", "vendor_latest", "declared_fact", "approved_override"]
                  },
                  "vulnerabilityId": { "type": "string", "minLength": 1, "maxLength": 256 },
                  "pkgName": { "type": "string", "minLength": 1, "maxLength": 512 },
                  "purl": { "type": "string", "minLength": 1, "maxLength": 1024 },
                  "findingClass": { "type": "string", "minLength": 1, "maxLength": 128 },
                  "reason": { "type": "string", "maxLength": 500 }
                }
              }
            }
          },
          "dependencySubscription": {
            "type": "object",
            "required": ["enabled"],
            "additionalProperties": false,
            "properties": {
              "ecosystem": {
                "type": "string",
                "enum": ["npm", "go", "maven", "python", "oci"]
              },
              "coordinate": { "type": "string", "minLength": 1, "maxLength": 512 },
              "major": { "type": "string", "minLength": 1, "maxLength": 64 },
              "enabled": { "type": "boolean" },
              "granularity": { "type": "string", "enum": ["patch", "minor_and_patch"] },
              "delivery": { "type": "string", "enum": ["pull_request", "auto_merge"] }
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
