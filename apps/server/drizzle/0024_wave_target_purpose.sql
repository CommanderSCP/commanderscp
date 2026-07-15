-- ===========================================================================================
-- P4A — carry `purpose` from the SOURCE MAPPING through to the WAVE TARGET, so reconcile can
-- trigger the right pipeline (docs/proposals/service-component-model.md).
--
-- P3 made a component able to hold BOTH an infra and a software binding, but left reconcile asking
-- for 'software' unconditionally, so an infra binding was registerable and READABLE and nothing else.
-- (0023's comment claims it was also "pollable". That was never true, and the error is instructive:
-- reconcile's status poll is only reachable AFTER a trigger, and an infra binding could not be
-- triggered; the observe() driver resolved its instance without a purpose, so it silently addressed
-- the SOFTWARE binding and never polled an infra one at all. Believing "pollable" is what let that
-- observe gap sit unnoticed — it asserts a property the code never had. Fixed in this change.)
-- This is the wire that makes an infra binding genuinely triggerable AND observable.
--
-- WHY THE MAPPING IS THE RIGHT HOME (owner, 2026-07-15). A change IS a release, and it carries the
-- source it came from (`changes.source_kind`: github|argocd|terraform|manual|...). Owner: "a release
-- comes from 1 source per pipeline… they're different repos most of the time". `source_mappings`
-- already resolves an inbound event (sourceKind + repo/path globs) to a component — so the infra repo
-- maps to (component, infra) and the app repo to (component, software), and THE RELEASE ITSELF says
-- which pipeline it is. Nobody declares it per-change.
--
-- Deliberately NOT inferred from source_kind: `github` is genuinely ambiguous (a GH Actions workflow
-- can run Terraform OR deploy an app — same sourceKind, different purpose). Inference would be a guess
-- dressed as a rule. Owner's definition for the record: infra = the IaC substrate (EC2, S3, the K8s
-- cluster itself); Argo CD is SOFTWARE, since it deploys onto that substrate.
--
-- DEFAULT 'software' on both columns is what makes this behaviour-preserving: every existing mapping
-- and every existing wave target keeps resolving exactly the binding reconcile triggers today
-- (migration 0023 labelled every pre-P3 binding 'software' for the same reason).
--
-- NOT in scope (P4B, needs its own design): COUPLED pipelines — "a software deployment can wait on an
-- infra deployment before continuing" (e.g. a feature needing a new S3 bucket must not deploy until the
-- Terraform lands). Those are ACROSS changes — different repos ⇒ different sources ⇒ separate changes
-- arriving minutes or days apart — not wave ordering inside one plan, and they raise questions this
-- migration cannot answer (how long does the waiter wait; what if the prerequisite never arrives or
-- fails). Likely home: the existing `coordinated-change` type + `correlates` (DESIGN §9.2).
-- ===========================================================================================

-- Which pipeline a source drives. The infra repo -> 'infra'; the app repo -> 'software'.
ALTER TABLE "source_mappings"
  ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'software';

-- Which pipeline THIS wave target rolls — what reconcile resolves the binding by.
ALTER TABLE "change_wave_targets"
  ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'software';
