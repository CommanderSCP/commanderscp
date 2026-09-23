# M28 kickoff prompt

Paste the block below into a fresh session. It is written to be self-contained: it assumes no
memory of the M27 session, and it front-loads the things that were expensive to learn.

---

Build **M28** in `~/ws/commanderscp`, as specified in `docs/BUILD_AND_TEST.md` under
`### M28 — every kind of work reaches a real executor`. Read that section first; it is
authoritative for scope, and it records the measured gap and three decisions (D1–D3) that are
already made. Do not re-litigate D1–D3 and do not re-derive the gap — it was censused on
2026-09-23 and the findings are written down.

**The owner's standing direction on this milestone, verbatim:** *"This all needs to be part of
M28. I'm tired of this getting put off again and again after each agent takes it on."* No
sub-milestone may be deferred to a successor milestone. If you believe one should be, stop and
ask rather than shipping the rest and noting the omission.

## What M28 is

M27 delivered host-reaching execution on the **Mode C** path — SCP launching an ephemeral
container itself, which is the charter's *scoped exception* for orgs with no execution system.
The charter's **default** — SCP driving work through the execution system an org already runs —
exists today for exactly one kind of work: container image builds, via the single shipped Argo
Workflows catalog template `scp-build-image-v1`.

M28 closes that for everything else: **RPM builds, infrastructure buildout for an environment
(the `prod-us-east-1` case), host ops through Argo Workflows, and deployment via ArgoCD +
Argo Rollouts.** Five sub-milestones, M28.1–M28.5, each with a machine-checked DoD in
BUILD_AND_TEST.md.

## Start here, in this order

1. Read `docs/BUILD_AND_TEST.md` §M28 in full.
2. Read `PROJECT_CHARTER.md`'s "Managed Execution Exception" and principle 1. M28 is mostly
   *outside* the exception — it is the coordinate-don't-execute default — so the exception's
   constraints are not the binding ones here.
3. Read `docs/adr/0008-*.md` §3 before touching anything rollout-shaped. It forbids *driving*
   Argo Rollouts state. D3 says SCP may **author** a Rollout manifest and must still only
   **observe** its steps. That distinction is the whole design; get it wrong and M28.4 violates
   an accepted ADR.
4. `apps/server/src/coordination/build-trigger-parameters.ts` is where M28.1 starts. Note it
   derives container-shaped destinations (`imageRepository`, `imageDestination`, `dockerfile`)
   for the *entire* `build` Category — so an `rpm` binding is handed a container registry today.
   **That is a live defect, not a blank slate.** Assert the wrong behaviour red first.
5. `deploy/helm-bundled/templates/argo-workflows-catalog.yaml` is the shipped catalog and the
   model for every new template. Its header comment records why rootless BuildKit was chosen and
   the exact securityContext relaxations that were *measured* to be load-bearing — copy the
   method, not the settings.

## Working rules the owner has set

- **Cut a PR per sub-milestone. Merge when CI is green.** Do not batch sub-milestones into one PR.
- **Docs-only changes may go straight to `main`** and skip PR CI. Everything else goes through a PR.
- **Run to completion.** Do not stop at clean checkpoints. Stop only when genuinely blocked on an
  owner decision or an owner action — and when you do, give 2–4 options and say which you'd take.
- **The owner runs cluster mutations and secret operations themselves.** Ask; don't `kubectl apply`.
- Verification commands: `pnpm check` runs **no tests**. You need `pnpm check` **and** `pnpm -w test`,
  and "the unit suite" means all ~76 packages, not `apps/server`'s. Integration tests need
  `--config vitest.integration.config.ts` or they are silently excluded.
- Node 22 is at `~/.local/node22/bin` — prepend it to PATH in every shell call. System node is 18.

## Failure modes that cost the most time in M27 — do not rediscover these

- **"Built, never installed" is the dominant defect class in this repo, and it is what reopened
  M27.** Every M27 increment passed a DoD that never required the capability to be *reachable*:
  five functions shipped with zero production callers. **The only check that finds it is to delete
  the wiring and watch a test go red.** Write that test for every lane in M28.
- **Census with no grep filters, and use `grep -rna` (never `grep -rn`).** Some tracked source
  files contain literal NUL bytes; every search tool silently drops them from a recursive search
  with exit 1 — indistinguishable from "no such code exists". `pnpm nul-census` lists them.
- **Mutation-prove every guard test.** Several M27 tests passed for reasons other than their claim
  — e.g. `rejects.toThrow()` satisfied by a `TypeError` from a wrong call signature rather than by
  the constraint under test. Break the thing; confirm red.
- **A vacuous skip is not a pass.** `it.runIf(cond)` evaluates at collection time and reports
  "skipped" with exit 0. Use the repo's visible-skip `expectSkipped()` pattern.
- **`apps/server` integration tests run against `dist`** and import `@scp/schemas` from `dist`.
  A source-only change is a silent no-op and a false green. Rebuild first.
- **Turbo strict env mode** strips any env var not declared in `passThroughEnv`, which silently
  changed an image ref to a local build in M27. There is now a permanent gate in
  `packages/source-census/src/ci-gate-census.test.ts` — extend it for any new image ref.
- **Migrations must be `drizzle-kit generate`d**, never hand-written; snapshot-freshness and
  schema-DDL-drift gates will catch a hand-edit. Append GRANT/RLS by hand afterward. RLS predicate
  convention is `NULLIF(current_setting('app.current_org_id', true), '')::uuid`.
  **A new write verb needs its GRANT and its RLS policy** — the integration superuser hides the
  omission, so it surfaces as a 500 on an authorized request.
- **Migration numbers and ADR numbers are serial in merge order.** Re-check against `main` at merge
  time; a number reserved by an earlier census goes stale.
- **When polling CI with `gh`**, poll the run whose `headSha` **is** the PR head. The PR check
  rollup can return the *previous* run's green checks after a push, and an empty rollup means a
  stale base rather than a passing build.
- **String-replace edits silently no-op** when prettier has reformatted the anchor, and an anchor
  can occur twice (e.g. helm vs compose mode in `install.sh`). Assert the match count.
- **CI blackholes egress.** Anything a test pulls must be in `tools/ci-mirror/images.list`, and
  `apk add` / `pip install` inside a test will hang rather than fail fast.
- **Codegen outputs are committed.** After any route/schema change run `pnpm gen`; CI fails on
  drift. Note also that `pnpm gen` writes the *generated* client, while the hand-written `ScpClient`
  wrapper is what the CLI and UI import — nothing gates that, so a new route is unreachable from the
  CLI until you add it by hand.

## Charter constraints that bind this milestone

- **Coordination, not execution** (principle 1). M28 is the default path: SCP triggers and observes
  someone else's executor. The verbs are `observe`/`trigger`/`status`/`abort` and nothing else.
- **API-first parity** (principle 3): every capability is API → SDK → CLI → IaC → UI, and nothing
  may bypass the public API.
- **Graph-native** (principle 2): new concepts arrive as relationship/policy/registry data, not as
  new top-level tables. This is the reasoning behind D1 (a package repo is a `registry` kind).
- **Air-gap is first-class** (principle 5): every new catalog image must be carried by the air-gap
  bundle, retargeted by `install.sh`, and `@scp/airgap` will fail the build if it is not.

Begin with M28.1. Confirm the plan in two or three sentences, then build.
