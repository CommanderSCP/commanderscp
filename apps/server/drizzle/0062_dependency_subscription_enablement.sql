-- ===========================================================================================
-- M21.3 — THE DEPENDENCY-SUBSCRIPTION ENABLEMENT SUBSTRATE (ADR-0032 §3a, §6).
--
-- Two things, and only two:
--   1. `dependency_subscription_unlock` — the INSTANCE-SCOPED singleton that UNLOCKS the feature
--      for the deployment. It never ACTIVATES anything (see below).
--   2. one more optional key inside a `policy` document's `effects[]` items, so a
--      `dependencySubscription` effect VALIDATES. That effect IS the dependency subscription.
--
-- WHAT IS DELIBERATELY NOT HERE: no object type, no relationship type, no per-subscription table.
-- ADR-0032 §3a settles that a dependency subscription is a `dependencySubscription` EFFECT on an
-- ordinary `policy` object, resolved by the existing `matchPoliciesForTargets` / `containmentChain`
-- machinery — exactly as `scanThreshold` (ADR-0016) is, and for the same reasons:
--
--   * It federates ALREADY. `policy` is a built-in type on every instance and the importer's
--     `policy_upsert` shares the `object_upsert` case, so there is no new journal entry kind, no new
--     type registration, and nothing for a not-yet-migrated outpost to be missing. A NEW built-in
--     type would have walked into the hazard 0061's header records as reason 3 (`import-repo.ts`'s
--     `object_upsert` branch has no try/catch), which is why that hazard is ABSENT here rather than
--     merely mitigated.
--   * Charter principle 2 is satisfied in its own words — "new concepts arrive as
--     relationship/POLICY/registry data" — rather than bent a second time (0061 bent it once, for
--     the derived high-churn inventory, on four measurements).
--
-- ===========================================================================================
-- WHY THIS IS 0062, AND WHY THE `when` IS THE HALF THAT BITES
--
-- 0061's header records the three-way 0060 collision in full; the rule it distils applies verbatim
-- here and is not re-argued: drizzle gates on `when` ALONE (`idx` orders the array and decides
-- nothing), and it SILENTLY SKIPS an entry whose `when` does not exceed what a database has already
-- applied — no error, no warning, surfacing later as a missing table. So a `when` is only correct
-- relative to what a database has actually applied and can only be finalised at MERGE time.
--
-- This entry's `when` (1788069137000) was set strictly greater than main's actual maximum at the
-- time of writing (1788059137000, `0061_dependency_inventory`), read from the journal rather than
-- inferred. If this branch merges behind another migration, BOTH `idx` AND `when` must be bumped
-- again — the check is "strictly greater than every entry now ahead of it", never "different from
-- them". `src/db/journal-ordering.test.ts` is what catches a violation, and it guards the FILE, so
-- a long-lived dev instance that applied a branch migration before the merge order settled is
-- outside it (read `drizzle.__drizzle_migrations` directly for those).
--
-- ===========================================================================================
-- THE INSTANCE LEVEL UNLOCKS AND NEVER ACTIVATES (ADR-0032 §6, ADR-0006)
--
-- Enablement is a monotone AND across three levels:
--
--     effective_enabled(component, line) =
--         instance_unlocked  AND  component_enabled  AND  NOT line_opted_out
--
-- This row is the FIRST conjunct and nothing else. Setting `unlocked = true` on a deployment where
-- no policy carries an enabling `dependencySubscription` effect subscribes exactly zero components:
-- an instance flag that silently activated authoring on every component would violate ADR-0006's
-- "managed execution is never a default", and the AND is what makes that structurally impossible
-- rather than a rule someone has to remember. `subscription-resolution.ts`'s pure merge is where
-- that AND lives, and `subscription-resolution.test.ts` pins it
-- ("the instance level unlocks and NEVER activates").
--
-- NO ROW MEANS LOCKED. The table ships EMPTY and is not seeded, because ABSENT NEVER MEANS ENABLED
-- (§6's reading of "absent never means zero"): a reader that found no row and defaulted to unlocked
-- would invert the whole chain's default. `unlocked` is additionally `NOT NULL DEFAULT false`, so
-- an INSERT that omits the column locks rather than unlocks — the two defaults agree, in the safe
-- direction, from both sides.
--
-- SINGLETON — one unlock per deployment. `id` is pinned to the literal `'default'` by a CHECK, so
-- the table holds at most one row and an operator PUT is a plain upsert on that key. Copied from
-- `scan_db_staleness_policy` (0036), which copied it from `scan_requirement_floors` (0029).
--
-- INSTANCE-SCOPED, SO NO `org_id` — the same documented exception to DESIGN §4.2's "org_id NOT NULL
-- on every tenant-scoped table" that 0029/0035/0036 carry. Whether this DEPLOYMENT may author
-- dependency bumps at all is a fact about the deployment, identical for every org hosted on it, and
-- ADR-0032 §3a states it directly: "the instance-level unlock is not a policy: it is instance-scoped
-- rather than org-scoped, so it follows the singleton-table precedent (migrations 0029/0035/0036)
-- with operator-token-gated writes".
--
-- TENANT-READ / OPERATOR-WRITE, with TWO INDEPENDENT BARRIERS against a tenant write (DESIGN §4.2's
-- "cross-tenant leakage requires two independent failures"), mirrored from 0029/0036:
--   1. GRANT: `scp_app` (the request-serving login role, NOSUPERUSER/NOBYPASSRLS) gets SELECT only.
--      INSERT/UPDATE/DELETE are explicitly REVOKEd.
--   2. RLS: the only policy is `FOR SELECT`. There is NO permissive policy for INSERT/UPDATE/DELETE,
--      so even a future migration that mistakenly re-granted write privileges would still see every
--      tenant write denied by RLS.
-- Read is tenant-facing on purpose: a component team that cannot see WHY their subscription is
-- inert has been handed an unexplainable verdict (charter principle 6), and resolution runs inside
-- the ordinary tenant transaction so no derivation path ever needs the privileged connection
-- (ADR-0016 §3's stated reason for preferring this shape). The row holds no per-tenant data at all,
-- so `USING (true)` exposes nothing of another tenant's.
--
-- WRITE IS OPERATOR-ONLY AND DELIBERATELY NOT AN RBAC PERMISSION: this unlock binds every org on the
-- deployment, so no tenant role may grant it. Operator writes run over the ADMIN connection with the
-- deployment-level `SCP_OPERATOR_TOKEN`, exactly as `routes/instance-scan-floors.ts` and
-- `routes/scan-db.ts` do.
--
-- Hand-authored (same convention as 0002/0007/0010/0011/0014/0017/0028/0029/0035/0036/0061): RLS
-- and grants are never expressible in drizzle-kit's schema diffing.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "dependency_subscription_unlock" (
  "id" text NOT NULL DEFAULT 'default',
  -- The FIRST conjunct of §6's AND. `false` (and the absence of the row entirely) mean LOCKED;
  -- `true` means "components in this deployment MAY be subscribed", never "are subscribed".
  "unlocked" boolean NOT NULL DEFAULT false,
  -- Why the operator set it — carried so the unlock itself can explain its own presence.
  "note" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dependency_subscription_unlock_pk" PRIMARY KEY ("id"),
  CONSTRAINT "dependency_subscription_unlock_singleton_ck" CHECK ("id" = 'default')
);
--> statement-breakpoint

-- Barrier 1 — the request-serving role may only READ.
GRANT SELECT ON dependency_subscription_unlock TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON dependency_subscription_unlock FROM scp_app;
--> statement-breakpoint

-- Barrier 2 — RLS with a SELECT-only policy. `USING (true)`: the row is instance-wide config holding
-- NO per-tenant data, so it exposes no cross-tenant visibility. The ABSENCE of any
-- INSERT/UPDATE/DELETE policy is the write denial.
ALTER TABLE dependency_subscription_unlock ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dependency_subscription_unlock FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON dependency_subscription_unlock;
--> statement-breakpoint
CREATE POLICY tenant_read ON dependency_subscription_unlock FOR SELECT USING (true);
--> statement-breakpoint

COMMENT ON TABLE dependency_subscription_unlock IS
  'ADR-0032 §6: the instance-scoped singleton that UNLOCKS dependency subscriptions for this deployment. It unlocks and NEVER activates — with no enabling dependencySubscription policy effect, unlocked = true subscribes exactly zero components (ADR-0006: managed execution is never a default). No row means LOCKED: absent never means enabled. Instance-scoped (no org_id, the 0029/0035/0036 exception to DESIGN §4.2); tenant-read, operator-write.';
--> statement-breakpoint

-- ===========================================================================================
-- Policy document schema — the `dependencySubscription` EFFECT (ADR-0032 §3a).
--
-- ADDITIVE, and authored the same way 0029 added `scanThreshold`: one more optional key inside an
-- `effects[]` item, alongside `requireControls` / `requireApprovals` / `scanThreshold`. The UPDATE
-- below re-states 0029's whole document because `property_schema` is a single jsonb value; the only
-- difference from 0029 is the `dependencySubscription` block. Existing documents are unaffected (no
-- `additionalProperties: false` was ever set here, so this codifies rather than restricts).
--
-- A component team subscribes by authoring, at their own component:
--     {"dependencySubscription": {"enabled": true}}
-- and opts one line back out at the same or a deeper scope:
--     {"dependencySubscription": {"coordinate": "@acme/lib", "enabled": false}}
-- Every present selector must EQUAL the line's value; an ABSENT selector is a wildcard. That is what
-- makes "subscribe my component" and "…but not that one package" both expressible without a second
-- authoring surface.
--
-- `enabled` IS REQUIRED, and that is load-bearing rather than tidy. Absent never means enabled
-- (§6), so a document that omitted it would have to be read as `false` — at which point a typo in
-- the key name would silently produce an inert OPT-OUT-shaped effect that opts nothing out.
-- Requiring it turns both mistakes into a 400 at authoring time.
--
-- `ecosystem` CARRIES ITS ENUM HERE even though 0061 deliberately left the ecosystem set to
-- packages/schemas alone (no pg enum, no CHECK on `dependency_lines.ecosystem`). The two cases are
-- not alike and the difference is the direction each fails in: an unrecognised ecosystem on an
-- INVENTORY row is data that simply never matches anything, whereas an unrecognised ecosystem on a
-- SELECTOR silently voids the selector — and a voided selector on an OPT-OUT fails OPEN, leaving a
-- line subscribed that an operator believed they had excluded. Refusing `{"ecosystem": "nmp",
-- "enabled": false}` at authoring time is worth the second copy of the list. The price is stated
-- rather than discovered: adding a sixth ecosystem is now a migration here AS WELL AS the
-- `DependencyEcosystemSchema` edit, and `subscription-resolution.integration.test.ts` pins that the
-- two lists agree.
--
-- `additionalProperties: false` ON THE `dependencySubscription` BLOCK, AND THAT IS THE SAME
-- ARGUMENT ONE LEVEL UP FROM THE ECOSYSTEM ENUM. The property the enum protects is "A SELECTOR THAT
-- FAILS TO BIND MUST VOID ITSELF, NOT THE CONSTRAINT" — and a mistyped KEY fails to bind exactly as
-- a mistyped VALUE does, only more quietly. Without this line `{"enabled": true, "coordinat":
-- "@acme/lib"}` is ACCEPTED here (nothing forbade the extra key, and `graph/property-validation.ts`
-- compiles Ajv with `strict: false`, so an unknown keyword raises nothing) and then STRIPPED by the
-- resolver's Zod parse, arriving at the merge as `{enabled: true}` — an effect with NO selectors,
-- which is a WILDCARD. One transposed character would subscribe every dependency line in the scope
-- instead of one npm package; the same typo on an opt-out would wildcard the DISABLE across every
-- line of it. `DependencySubscriptionEffectSchema` is a `strictObject` for the same reason, so the
-- document is refused at BOTH layers: here for an authoring write, there for a document that
-- reached the resolver by any other route.
--
-- WHAT IS DELIBERATELY *NOT* CONSTRAINED, AND WHY — stated rather than left to be rediscovered. The
-- enclosing `effects[]` ITEM still has no `additionalProperties: false`, so a typo in the OUTER key
-- (`{"dependencySubscriptio": {...}}`) is still accepted and makes the whole effect VANISH — which
-- is safe for an enable and fails OPEN for an opt-out, the same direction as above. Closing it is a
-- one-line change and it was NOT made here because it is a product-wide governance change, not a
-- dependency-feature change: 0010 and 0029 both left the item open, `effects[]` is a free-form
-- document in practice, and the tree already contains a policy authored with an effect shape the
-- schema never listed (`governance/service-policy-scope.integration.test.ts:43` writes
-- `{"kind": "requireApproval", "quorum": 1, "role": "Approver"}`). Restricting the item would refuse
-- that document and every other unlisted shape on its next write, for `scanThreshold` and
-- `requireControls` authors as much as for this feature — which is precisely the "a governance
-- change gets made as a side effect of a dependency feature" that ADR-0032 §6a refuses to do. It
-- needs its own decision, taken for all four effect kinds at once.
--
-- `granularity` and `delivery` are optional and their ABSENCE IS NOT "NO OPINION" — it is a vote for
-- the MOST RESTRICTIVE option (`patch`, `pull_request`), and `subscription-resolution.ts` takes the
-- MIN over every enabling contribution INCLUDING the silent ones. So auto-merge must be ACQUIRED by
-- an explicit declaration on EVERY contribution that enabled the pair: it is never inherited from
-- silence, never assembled out of two policies that each meant something safer, and A BROADER SCOPE
-- CANNOT GRANT IT TO A NARROWER ONE THAT STAYED SILENT. An org-wide `{"enabled": true, "delivery":
-- "auto_merge"}` over a component's own `{"enabled": true}` resolves to `pull_request` — the
-- component team never asked for commits to land in their repo unreviewed, and a policy they do not
-- own may not answer that question for them.
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
