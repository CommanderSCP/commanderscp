-- THE `executorBinding` POLICY EFFECT, AND THE LANE A BINDING SERVES
-- (ADR-0046 section 4; team-pipeline-iac section 6, D4, and section 14 resolutions 2 and 7).
--
-- Two statements. The first lets a domain DECLARE which of its execution systems serves which
-- targets for which Type; the second lets a binding row say which LANE it is in, so a test hook can
-- run somewhere other than the deploy executor.
--
-- ===========================================================================================
-- 1. THE POLICY DOCUMENT SCHEMA - ADDITIVE, AND IT CODIFIES RATHER THAN RESTRICTS
-- ===========================================================================================
-- Authored exactly as 0029 (`scanThreshold`) and 0062 (`dependencySubscription`) were: one more
-- optional key inside an `effects[]` item. The UPDATE re-states 0075's whole document because
-- `property_schema` is a single jsonb value; the only difference is the `executorBinding` block.
--
-- MEASURED BEFORE WRITING IT: the `effects` ITEM carries no `additionalProperties: false` (only the
-- individual effect objects do), so a policy document carrying this key ALREADY passes Ajv on an
-- outpost that has not run this migration. That matters because `policy` is journaled and
-- Ajv-validated on the RECEIVING side of federation with no try/catch (`federation/import-repo.ts`),
-- so a restriction here would fail a peer's whole signed bundle. This adds none: existing documents
-- are unaffected, and a peer one migration behind keeps accepting the ones that carry the new key.
--
-- `type` AND `lane` ARE PLAIN STRINGS HERE, NOT ENUMS, AND THAT IS DELIBERATE. The closed sets live
-- once, in Zod (`ExecutorTypeSchema`, `ExecutorLaneSchema`), and every authoring door parses through
-- them. An enum in THIS document would be the wedge the paragraph above avoids: the first time a
-- Type or a lane is added, a not-yet-upgraded outpost's Ajv would reject the entire sync bundle
-- rather than one entry. Same rule the wave-gate work recorded (proposal section 14 res 5), applied
-- before it could bite rather than after.

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
                  "declaredFact": { "type": "string", "minLength": 1, "maxLength": 64 },
                  "declaredValue": { "type": "string", "minLength": 1, "maxLength": 128 },
                  "reason": { "type": "string", "maxLength": 500 }
                }
              }
            }
          },
          "executorBinding": {
            "type": "object",
            "required": ["executionSystemUrn", "type"],
            "additionalProperties": false,
            "properties": {
              "executionSystemUrn": { "type": "string", "minLength": 1, "maxLength": 512 },
              "type": { "type": "string", "minLength": 1, "maxLength": 64 },
              "lane": { "type": "string", "minLength": 1, "maxLength": 32 },
              "externalRef": { "type": "string", "minLength": 1, "maxLength": 512 }
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
--> statement-breakpoint

-- ===========================================================================================
-- 2. THE LANE, AND THE IDENTITY IT WIDENS
-- ===========================================================================================
-- `lane` is 'build' | 'test' TODAY, declared as plain text with a DEFAULT and no CHECK - the same
-- treatment `executor_bindings.type` and `source_mappings.type` already get, and for the same
-- reason: the closed set lives once in Zod, and a duplicate here would be a second definition to
-- keep in step.
--
-- DEFAULT 'build' IS WHAT MAKES THIS ADDITIVE. Every existing row is in the build lane, because
-- that is what every binding in every estate is today - there was no other lane to be in. Nothing
-- re-reads differently, and a deployment that never separates lanes never sees the column.
--
-- ===========================================================================================
-- THE UNIQUE KEY MUST WIDEN, AND THIS IS THE SAME SHAPE AS THE 0026 `purpose` FIX
-- ===========================================================================================
-- `UNIQUE (org_id, target_object_id, type)` says "one binding per target per Type" - which is
-- exactly right until a lane exists, and then it says something false: it forbids a target from
-- having BOTH a build-lane and a test-lane binding for one Type, which is the entire feature.
--
-- So it widens to `(org_id, target_object_id, type, lane)`. The old constraint is DROPPED rather
-- than left beside the new one: leaving it would make the widened key decorative, and the failure
-- would be a confusing unique violation on a write the design permits.
--
-- CENSUS OF EVERY CONSUMER OF THE OLD CONSTRAINT NAME (filterless, `grep -rna` over apps/ and
-- packages/, run for this migration):
--   * `db/schema.ts` - the drizzle `unique(...)` declaration. Updated in the same commit.
--   * `coordination/executor-bindings-repo.ts:511` - `isUniqueViolation(err, '<name>')` in the
--     RELABEL path, which turns the violation into a 409. Updated to the new name; a stale name
--     there would silently rethrow a raw 500 instead of the intended conflict.
-- No other module names the constraint, and no other module inserts into this table.
--
-- ===========================================================================================
-- PROVENANCE IS READ FROM THE ROW, NEVER INFERRED (ADR-0046 section 4)
-- ===========================================================================================
-- `managed_by_policy_id` is NULL for a hand-authored binding and carries the winning policy's object
-- id for one the domain reconciler derived. That is what lets the reconciler PRUNE its own rows
-- without ever touching a one-off an operator wrote by hand - which the ADR requires, and which a
-- rule like "prune anything that no longer matches a policy" would get wrong for exactly the rows a
-- human cared most about.
--
-- Nullable and unconstrained by a foreign key ON DELETE: deleting the policy must not delete the
-- binding out from under a running deployment. The reconciler notices on its next tick and prunes
-- deliberately, which is a visible act with an audit event rather than a cascade nobody sees.

ALTER TABLE executor_bindings
  ADD COLUMN IF NOT EXISTS "lane" text NOT NULL DEFAULT 'build';
--> statement-breakpoint

ALTER TABLE executor_bindings
  ADD COLUMN IF NOT EXISTS "managed_by_policy_id" uuid;
--> statement-breakpoint

ALTER TABLE executor_bindings
  DROP CONSTRAINT IF EXISTS "executor_bindings_org_target_type_key";
--> statement-breakpoint

ALTER TABLE executor_bindings
  ADD CONSTRAINT "executor_bindings_org_target_type_lane_key"
  UNIQUE ("org_id", "target_object_id", "type", "lane");
--> statement-breakpoint

-- The reconciler's own sweep: every row it manages, for one policy or across the domain.
CREATE INDEX IF NOT EXISTS "executor_bindings_managed_by_policy"
  ON "executor_bindings" ("org_id", "managed_by_policy_id")
  WHERE "managed_by_policy_id" IS NOT NULL;
--> statement-breakpoint

COMMENT ON COLUMN executor_bindings.lane IS
  'build | test (ExecutorLaneSchema). DEFAULT build: every pre-lane row is in the build lane, which is what every binding was before lanes existed. A test-lane request with no test declaration FALLS BACK to the build lane at resolution time (proposal section 14 res 7) - the fallback is not stored, so the row always says which lane it actually serves.';
--> statement-breakpoint

COMMENT ON COLUMN executor_bindings.managed_by_policy_id IS
  'ADR-0046 section 4: NULL for a hand-authored binding, the winning executorBinding policy for one the domain reconciler derived. Provenance is READ FROM THE ROW, never inferred from which policy happens to match now - which is what lets the reconciler prune its own rows without touching a hand-authored one-off.';
