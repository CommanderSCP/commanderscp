-- ===========================================================================================
-- M22.5 + M22.6 (ADR-0033 §6, §6a; owner decisions D2, D3, D4, D9) — the LAST TWO exclusion
-- classes get the substrate they need, and both of them are REGISTRY data rather than tables.
--
-- Two statements, both against `object_types`:
--   1. `component.property_schema` learns the `security.declarations` bag (D2 — component info
--      encodes the override directly).
--   2. a new `scan_override_grant` object type (D3/D4 — a standing, expiring grant per
--      (component x finding), approved at the tier that set the rule).
--
-- NO NEW TABLE. Charter principle 2: new concepts arrive as relationship/policy/REGISTRY data, not
-- as new top-level tables. A grant is a governed thing with an owner, an authority, a lifecycle and
-- a need to FEDERATE (D9) — which is precisely the list of properties `objects` already provides and
-- a bespoke table would have to re-implement, journal entry kind included. ADR-0026 D9 made the same
-- call for `placement` and 0051's header records the deciding fact: `JournalEntryKindSchema` admits
-- exactly nine kinds and none of them is a bespoke row, so anything stored outside `objects` could
-- never cross a federation boundary at all.
--
-- ===========================================================================================
-- 1. TYPED BUT OPEN — READ THIS BEFORE TIGHTENING EITHER SCHEMA
-- ===========================================================================================
-- Neither schema below closes `additionalProperties`, and that is not an oversight — it is the
-- 0043/0051 rule, restated by ADR-0033 §6 as a requirement:
--
--   `federation/import-repo.ts`'s `object_upsert` branch Ajv-validates an incoming object against
--   the registered `property_schema` with NO try/catch. ONE rejection aborts a peer's ENTIRE signed
--   bundle and wedges the channel. A CLOSED enum here would therefore turn every future property
--   addition — including one made by a NEWER peer talking to an OLDER receiver — into a fail-closed
--   version-skew hazard, on a channel whose failure mode is "no federation at all".
--
-- The strictness lives at the LOCAL AUTHOR'S DOOR instead, where a refusal costs one 400 and
-- nobody's bundle: `ComponentSecurityPropertySchema` (`z.strictObject`) is applied to the component
-- write routes, and `CreateScanOverrideGrantRequestSchema` / `ApproveScanOverrideGrantRequestSchema`
-- to the grant routes. Strict at the operator's door, open on the wire — 0043's rule, applied twice.
--
-- `required` carries none of that risk and IS used on the grant, exactly as 0051 used it: the four
-- required fields are CONSTITUTIVE (a grant that names no component, no finding, no tier and no
-- status is not a grant), so no future authority would ever author one without them, and requiring
-- them enforces the shape at EVERY write door rather than only at the API.
--
-- ===========================================================================================
-- 2. WHY THE DECLARATION IS A PROPERTY AND NEVER A LABEL
-- ===========================================================================================
-- `labels` are tenant-writable, carry no schema, have no reserved namespace, and are ALREADY a live
-- evasion path for selector-scoped policies (PR #247, tracked separately). Keying a loosening on
-- them would mean any holder of `object:write` could move themselves into or out of a policy's reach
-- with an unvalidated string. `properties` under a registered `property_schema` is validated on
-- every write door through `graph/property-validation.ts` — which is the difference that matters
-- here, and the reason ADR-0033 §6 guard 3 states it as an absolute.
--
-- WHAT THIS SCHEMA DELIBERATELY DOES NOT CONSTRAIN: the declaration VOCABULARY. `egress: none` is an
-- example, not an enum. A closed value set here would be exactly the SecOps-authored mapping D2
-- considered and DECLINED — and it would also be wrong, because the vocabulary is the org's.
-- ===========================================================================================

-- The `component` type's schema is `{"type":"object"}` today (0002 seed), i.e. wide open. This
-- narrows the ONE key this feature reads and leaves everything else exactly as permissive as it was,
-- so no existing component object can fail validation on its next write. A component that has never
-- declared anything simply has no `security` key.
UPDATE object_types
   SET property_schema = '{
         "type": "object",
         "properties": {
           "security": {
             "type": "object",
             "properties": {
               "declarations": {
                 "type": "object",
                 "additionalProperties": { "type": "string", "minLength": 1, "maxLength": 128 }
               }
             }
           }
         }
       }'::jsonb
 WHERE id = 'component'
   AND org_id IS NULL;

-- ===========================================================================================
-- 3. THE GRANT OBJECT
-- ===========================================================================================
-- `status` lives in `properties` and NOT as a state machine anywhere else, and the enum stops at
-- four values on purpose: there is NO `expired`. Expiry is a READ-TIME SQL WINDOW evaluated by the
-- resolver on every read (`governance/scan-override-grants.ts`, following `freezes-repo.ts`'s
-- `activeFreezesForScopes`), never a column a background job flips — there is no sweeper anywhere in
-- this tree and no `boss.schedule` usage to build one on. A fifth `expired` value would be a promise
-- that something transitions rows into it, and nothing would; every reader that forgot to ALSO check
-- the timestamp would then be honouring an expired grant.
--
-- FEDERATION (D9): grants federate FULLY, as ordinary federated objects. Summary-only was
-- recommended and declined. Nothing here opts out, because `objects.domain_local` already defaults
-- to `false` (0059) — so "federates" is the EXISTING default and this migration selects it by adding
-- nothing. The accepted cost is recorded in ADR-0033 §8: a list of accepted risks is a map of
-- deliberately-tolerated weaknesses, and federating it distributes that map into every domain that
-- receives the journal, including lower-trust ones.
INSERT INTO object_types (id, org_id, display_name, property_schema, is_builtin) VALUES
  (
    'scan_override_grant',
    NULL,
    'Scan Override Grant',
    '{
       "type": "object",
       "properties": {
         "componentId":      { "type": "string", "minLength": 1 },
         "vulnerabilityId":  { "type": "string", "minLength": 1 },
         "pkgName":          { "type": "string", "minLength": 1 },
         "tierObjectId":     { "type": "string", "minLength": 1 },
         "status":           { "type": "string", "enum": ["requested","approved","denied","revoked"] },
         "reason":           { "type": "string", "minLength": 1 },
         "expiresAt":        { "type": "string" },
         "decidedByActorId": { "type": "string" },
         "decidedAt":        { "type": "string" },
         "decisionReason":   { "type": "string" },
         "requestedByActorId": { "type": "string" }
       },
       "required": ["componentId", "vulnerabilityId", "tierObjectId", "status"]
     }'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================================
-- 4. WHAT IS NOT HERE, AND WHY
-- ===========================================================================================
-- NO `relationship_types` WIDENING. A grant is not a containment node: it does not contain, is not
-- contained, owns nothing and is owned by nobody. It NAMES a component and a tier object by id in
-- its properties, which is a reference and not an edge, and the resolver looks it up by that id.
-- Adding it to `contains` would put it on every containment chain the policy resolver, the freeze
-- scope walk and the RBAC scope expansion walk — i.e. it would silently become a governance SCOPE,
-- which is the one thing a waiver must never be.
--
-- NO INDEX on `properties->>'componentId'`. The resolver's read is already org-scoped and
-- type-scoped through `objects`' existing `(org_id, type_id)` access path, and the population is one
-- row per accepted risk — a number bounded by human approvals, not by machine events. An index on a
-- jsonb expression is cheap to add later against a measured plan; adding one now against a guess is
-- the write amplification ADR-0024 §D0 warns about, in index form.
-- ===========================================================================================

-- ===========================================================================================
-- 5. THE POLICY SCHEMA, RESTATED — the `declared_fact` clause's two new narrowing keys
-- ===========================================================================================
-- `property_schema` is a single jsonb value, so the whole document is restated and only the two
-- lines inside `effects[].scanExclusion.exclude` are new (diff this against 0074). That is the
-- 0029 -> 0062 -> 0066 pattern and it is not avoidable: there is no JSON-patch verb for a jsonb
-- column, and a partial `jsonb_set` on a nested path is far harder to review than a full restatement.
--
-- WHY THE TWO KEYS HAD TO LAND HERE AND NOT IN THE ZOD SCHEMA ALONE. 0066 closed
-- `additionalProperties: false` on the `exclude` sub-object, deliberately and for a strong reason: a
-- mistyped NARROWING key on a loosening is a WIDENING. That closure is exactly what refuses a
-- `declared_fact` clause today — `{"class":"declared_fact","declaredFact":"egress"}` is a 400 at the
-- authoring route until this migration runs. Found by a test against the real `/policies` route, not
-- by reading: the Zod schema accepted the clause and the DATABASE-registered JSON Schema did not, and
-- the two live in different files.
--
-- BOTH KEYS ARE OPTIONAL HERE, and the requirement that a `declared_fact` clause carry BOTH is
-- enforced in the PREDICATE instead (`scanExclusionClassPredicate` yields no exclusion when either is
-- missing). That split is deliberate: JSON Schema cannot express "required only when `class` equals
-- this value" without a `if/then` or `oneOf` construction, and a conditional schema on a document
-- that federation Ajv-validates with no try/catch is exactly the version-skew hazard 0043's header
-- warns about. A clause missing half of the pair is therefore ACCEPTED at the door and INERT at the
-- gate — the fail-closed direction, and one an operator can see in the Decision's exclusion list.
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
                  "declaredFact": { "type": "string", "minLength": 1, "maxLength": 64 },
                  "declaredValue": { "type": "string", "minLength": 1, "maxLength": 128 },
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
