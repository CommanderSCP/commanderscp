-- ===========================================================================================
-- M22.5 + M22.6 (ADR-0033 §6, §6a; owner decisions D2, D3, D4, D9) — the LAST TWO exclusion
-- classes get the substrate they need, and both of them are REGISTRY data rather than tables.
--
-- Two statements, both against `object_types`:
--   1. a new `scan_override_grant` object type (D3/D4 — a standing, expiring grant per
--      (component x finding), approved at the tier that set the rule).
--   2. the `policy` type's `declared_fact` narrowing keys, restated in full (§5).
--
-- D2's component declarations get NO registry statement at all. A third statement narrowing
-- `component.properties.security` was written, and then deleted — §2a records what it claimed, why
-- that claim was false, and the federation argument that decided it.
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
-- 1. TYPED BUT OPEN — READ THIS BEFORE TIGHTENING ANY SCHEMA FROM HERE
-- ===========================================================================================
-- The grant schema below does not close `additionalProperties`, and the `component` type is not
-- narrowed at all (§2a). Neither is an oversight — both are the 0043/0051 rule, restated by
-- ADR-0033 §6 as a requirement:
--
--   `federation/import-repo.ts`'s `object_upsert` branch Ajv-validates an incoming object against
--   the registered `property_schema` with NO try/catch. ONE rejection aborts a peer's ENTIRE signed
--   bundle and wedges the channel. A CLOSED enum here would therefore turn every future property
--   addition — including one made by a NEWER peer talking to an OLDER receiver — into a fail-closed
--   version-skew hazard, on a channel whose failure mode is "no federation at all".
--
-- The strictness lives at the LOCAL AUTHOR'S DOOR instead, where a refusal costs one 400 and
-- nobody's bundle: `ComponentSecurityPropertySchema` (`z.strictObject`) is applied at
-- `graph/objects-repo.ts`'s create/update choke point, and `CreateScanOverrideGrantRequestSchema` /
-- `ApproveScanOverrideGrantRequestSchema` to the grant routes. Strict at the operator's door, open
-- on the wire — 0043's rule, applied twice.
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
-- with an unvalidated string. `properties.security` passes a declared shape at every LOCAL write
-- door (§2a); `labels` pass NOTHING, anywhere. That asymmetry is the difference that matters here,
-- and the reason ADR-0033 §6 guard 3 states it as an absolute. (It is a property of the GUARD, not
-- of this file: §2a deletes the registry fragment, so `graph/property-validation.ts` no longer
-- constrains the bag at all — which changes where the check lives, not whether one exists.)
--
-- WHAT THE DECLARATION SHAPE DELIBERATELY DOES NOT CONSTRAIN, wherever it is enforced: the
-- VOCABULARY. `egress: none` is an example, not an enum. A closed value set would be exactly the
-- SecOps-authored mapping D2 considered and DECLINED — and it would also be wrong, because the
-- vocabulary is the org's.
-- ===========================================================================================

-- ===========================================================================================
-- 2a. THE COMPONENT FRAGMENT THAT USED TO BE HERE, AND WHY IT IS GONE
-- ===========================================================================================
-- An earlier revision of this migration carried a third statement — an
-- `UPDATE object_types ... WHERE id = 'component'` narrowing `properties.security` to
-- `{"declarations": {<key>: <string, 1..128>}}`. It is deleted. `component.property_schema` stays at
-- the 0002 seed's `{"type":"object"}` (0002_rls_rbac_seed.sql:154).
--
-- ITS OWN COMMENT WAS FALSE, and that is recorded rather than quietly dropped, because the false
-- sentence is why nobody looked further. It claimed the narrowing left "everything else exactly as
-- permissive as it was, so no existing component object can fail validation on its next write". The
-- 0002 seed left `security` entirely UNCONSTRAINED, so it was reachable: a component already
-- carrying `{"security": "restricted"}`, or a declaration value longer than 128 characters, starts
-- failing Ajv on its NEXT WRITE and becomes un-editable until someone rewrites the bag out of it.
--
-- THAT IS NOT THE DECIDING ARGUMENT. §1 is. TYPING a key is the same version-skew hazard as CLOSING
-- a key set, and the cost is paid on the same channel: `import-repo.ts`'s `object_upsert` branch
-- Ajv-validates an incoming object against this registered schema with NO try/catch, so a peer whose
-- components carry any `security` shape this fragment did not describe loses its ENTIRE signed
-- bundle — not one object. `component` is among the most-federated types in the graph, which makes
-- it the worst place in the file to spend that risk. The identical tightening was implemented,
-- measured against the import path and REVERTED on this same migration's `expiresAt` field (§3); a
-- narrowed `properties.security` is that hazard wearing a third keyword, on a hotter type.
--
-- NOTHING THAT DECIDES LOSES A CHECK — verified by reading the call sites before deleting, not by
-- assuming. `assertValidComponentSecurityDeclarations`
-- (`governance/component-declaration-guard.ts`) runs at `graph/objects-repo.ts`'s `createObject`
-- and `updateObject` — the choke point every LOCAL write door funnels through — and again in
-- `federation/handfill-repo.ts`, which wears the `federationImport` exemption and so calls it
-- explicitly. It is STRICTLY TIGHTER than the deleted fragment: being `z.strictObject` with a
-- REQUIRED `declarations`, it also refuses `{"declarationz": ...}` and `{"security": {}}`, both of
-- which the fragment accepted. At the gate, `parseDeclaredFacts` re-parses with the same schema and
-- contributes nothing for a bag that fails it. The ONE path the fragment covered that these do not
-- is federation import — which is exactly the path where its failure mode is a wedged channel.
-- ===========================================================================================

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
--
-- `expiresAt` STAYS AN UNCONSTRAINED STRING, AND THAT IS A DECISION, NOT AN OVERSIGHT.
--
-- This field is the one property here whose SHAPE, not merely its meaning, can break something: it
-- is read back by a `::timestamptz` cast inside the gate's own query
-- (`governance/scan-override-grants.ts`). A value Postgres cannot cast would throw inside EVERY gate
-- evaluation for the org — prewarm, wave boundary, `POST /policy-evaluate` and the commander
-- promotion scan — rather than failing that one grant. Fail-open by way of a crash.
--
-- AN ADVERSARIAL REVIEW PROPOSED TIGHTENING THIS FIELD HERE. It was implemented, measured against
-- the import path, and REVERTED. Adding a `pattern` moves the failure from one grant to the WHOLE
-- CHANNEL: §1 above is not decoration — `import-repo.ts`'s `object_upsert` branch calls
-- `upsertObjectByUrn` (import-repo.ts:208) with no try/catch, and that calls `validateProperties`
-- (objects-repo.ts:269/870), so a registry rejection aborts the peer's entire signed bundle and
-- wedges federation for that peer until an operator intervenes. Trading a per-grant denial of
-- service for a per-CHANNEL one is not a fix. The identical argument already governs
-- `additionalProperties` two sections up; a `pattern` is the same hazard wearing a different keyword.
--
-- (For the next person who reaches for it anyway: `"format": "date-time"` would not even be the
-- lesser evil, it would be nothing at all. `ajv-formats` is not a dependency of this repo and
-- `graph/property-validation.ts` builds Ajv with `strict: false`, so an unknown `format` is silently
-- ignored — a constraint that reads as enforcement and enforces nothing.)
--
-- THE FIX LIVES AT THE READ, WHERE IT COSTS NOTHING TO GET WRONG: the resolver wraps its cast in a
-- `CASE ... ~ pattern`, exactly as `graph/containment.ts` wraps its `::uuid`, so a malformed value
-- yields NULL and the grant is simply NOT LIVE. That is fail-CLOSED, it degrades one grant instead
-- of one tenant, and it also covers every row written before any future tightening — which a schema
-- change never could.
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
