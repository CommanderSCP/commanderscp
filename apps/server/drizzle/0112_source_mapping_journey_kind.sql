-- 0112 — `source_mappings.journey_kind`: WHICH RELEASE PATH a change from this source takes.
-- `source` enters the journey at the source-code node and runs the whole spine (source → build →
-- scan/sign → registry → config → waves); `config` enters at the config node and goes straight to
-- the waves (docs/proposals/component-journey-view.md §8.14, owner decision 2026-09-14 option ii).
--
-- ## WHY A SECOND COLUMN AND NOT `type`, which is the whole reason this exists
--
-- `source_mappings.type` was doing TWO jobs: "what kind of change is this" (the journey) and "which
-- executor pipeline rolls it" (ADR-0007's routing key). The chain from the second job is unbroken —
-- `coordination/correlation.ts` returns the matched row's `type`, `webhook-processor.ts` hands it to
-- `proposeChange`, `plan-service.ts` snapshots it onto every wave target, and `reconcile.ts` resolves
-- the executor binding BY it. So describing a service repo's journey by typing its mapping `image`
-- also re-routed every release from it to a `build` binding that does not exist on this estate.
--
-- That was MEASURED, through the real reconcile loop, on one component with two placements and a
-- `configuration` binding on each (§8.14):
--
--     type: configuration  ->  wave target at gamma `triggered`, dispatched
--     type: image, same    ->  wave target at gamma `no_executor`, plugin null
--
-- The retyping pass that had been decided would therefore have STOPPED releases for the 49 service
-- repos rather than merely mislabelling them. Splitting the journey off into its own column is what
-- lets a mapping say "this is a source-code change" while still routing to the config pipeline.
--
-- ## NEVER AN ENFORCEMENT INPUT — and this one is load-bearing, not boilerplate
--
-- A LABEL, the genus of `classification` (0057 / ADR-0030 §2), `mirror_of_shared` (0078) and `scope`
-- (0082): the correlation matcher does not read it, no gate, plan-compilation or export decision
-- consults it, and forging or clearing it changes no routing outcome. Pinned by
-- `source-mapping-journey-kind.integration.test.ts`, whose control/subject pair is the test that
-- would have caught §8.14 before it was decided: a `source`-journey mapping and a `config`-journey
-- mapping over the same component route IDENTICALLY, and both DISPATCH rather than terminalising
-- `no_executor`. If a future change makes the journey kind reach `resolveBindingForTarget`, that test
-- fails, which is the point.
--
-- ## NULL = NOT DECLARED -> the view falls back, nothing is inferred
--
-- Nullable with no default, for `scope`'s reason: "source" vs "config" has no honest pre-column
-- meaning for an existing row. All 148 mappings on the estate read NULL, the lane builder keeps its
-- pre-0112 Category reading (which cannot tell the two paths apart — that is §8.2, still latent), and
-- nothing parses the repo name, path glob or the site's role to fill it in. Repo-identity was
-- considered as the discriminator and REJECTED by the owner (§8.3) despite fitting this estate
-- exactly, so inferring it here would be re-adopting a rejected design silently.
--
-- Carries a CHECK for `scope`'s reason: the value set is closed at both ends (Zod on the wire, this
-- constraint at rest) because a third value would render as no label at all, silently.
--
-- Idempotent (IF NOT EXISTS / DO $$ … $$ guarded constraint), like every migration since the
-- 2026-08-13 three-branch `when` collision.

ALTER TABLE "source_mappings" ADD COLUMN IF NOT EXISTS "journey_kind" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'source_mappings_journey_kind_check'
  ) THEN
    ALTER TABLE "source_mappings"
      ADD CONSTRAINT "source_mappings_journey_kind_check"
      CHECK ("journey_kind" IS NULL OR "journey_kind" IN ('source', 'config'));
  END IF;
END $$;
