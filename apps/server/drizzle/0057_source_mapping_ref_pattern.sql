-- ===========================================================================================
-- `source_mappings.ref_pattern` + `source_mappings.classification` — dev pipelines are SELECTED
-- by source ref, and dev-ness is READ from the operator-declared mapping (ADR-0030 §1/§2).
--
-- ## ref_pattern — the third routing glob
--
-- `matchComponentForSource` (coordination/correlation.ts) matched and ranked on `repo_pattern` and
-- `path_pattern` ONLY, so a push to `dev` and a push to `main` in the same repository correlated to
-- the SAME component and the SAME routing Type — the same pipeline. The git ref was already being
-- carried (the github adapter sets `correlationKey: refs/heads/<branch>`) and already being
-- discarded for routing: it is read downstream only to GROUP changes onto a `coordinated-change`
-- object. There was therefore no way to express "the dev branch drives the dev pipeline" at all.
--
-- This is a pure ADDITIVE EXPAND. The column is NULLABLE and the matcher SKIPS a null one, exactly
-- as it already skips a null `repo_pattern`/`path_pattern` — so a NULL `ref_pattern` matches EVERY
-- ref and every mapping that exists today keeps its current behaviour byte-for-byte. No backfill.
--
-- It joins the precedence contract as a PEER of the other two globs, not above them: rule 1
-- (most-constrained) now counts three globs, rules 2a/2b (narrowest wildcard, most literal text) sum
-- across three columns, and rule 3 (oldest, then id) is untouched and still total. Paths and refs are
-- orthogonal — the same directory on two branches is two pipelines, which no path glob can express.
--
-- ## classification — declared, never inferred
--
-- Which pipeline is "the dev pipeline" is a property the OPERATOR DECLARES on this row. Nothing
-- parses the branch name looking for `dev`. A label named after WHICH BRANCH MATCHED goes false the
-- moment that branch covers a second kind — already shipped once in this repo, in a Decision where it
-- had been wrong since before the level that exposed it (charter principle 6). Reading the declared
-- property instead survives a repo whose `dev` branch legitimately drives a second pipeline kind.
--
-- ## What this column is NOT
--
-- It is NOT an input to the cross-boundary export gate. `evaluatePromotionScanGate`
-- (federation/promotion-repo.ts) takes `(substantiveArtifacts, controlOutcomes)` and gains no source,
-- ref, or classification input here: a dev-built digest promoted across a boundary is still refused
-- unless a passing, digest-bound scan exists — scanned AT THE CROSSING, not grandfathered
-- (ADR-0017 E6, ADR-0018 §2, ADR-0030 §3). Forging or removing this value changes NO gate outcome.
--
-- Plain text with no pg enum / CHECK, matching `type` beside it: the closed value set is enforced in
-- packages/schemas (Zod).
-- ===========================================================================================

ALTER TABLE "source_mappings" ADD COLUMN IF NOT EXISTS "ref_pattern" text;

ALTER TABLE "source_mappings" ADD COLUMN IF NOT EXISTS "classification" text;

COMMENT ON COLUMN "source_mappings"."ref_pattern" IS
  'Glob matched against the event git ref (refs/heads/dev). NULL matches every ref, so pre-0056 mappings are unchanged. Ranked as a peer of repo_pattern/path_pattern (ADR-0030 §1).';

COMMENT ON COLUMN "source_mappings"."classification" IS
  'Operator-declared pipeline classification (dev|beta), UI/reporting ONLY. NEVER an enforcement input — forging or removing it changes no gate outcome (ADR-0030 §2/§3).';
