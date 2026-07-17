# oasdiff breaking-change exceptions

The `/v1` API is additive-only; `tools/openapi/check.sh` runs `oasdiff breaking` between the
committed spec at the merge base with `main` and the freshly emitted spec, and fails on any
ERR-level (breaking) change. That gate is **not** self-overriding — `check.sh`'s own header records
that an intentional breaking change requires an explicit **`api-v2-exception`** label + review
(BUILD_AND_TEST.md §7 "API breaking change" row, `.github/workflows/ci.yml`). This file is the
durable record of each such exception so the label is never a mystery in the git history.

## Log

### ADR-0007 — executor binding `purpose` → Type taxonomy (2026-07-17)

**Spec:** [docs/adr/0007-executor-binding-type-taxonomy.md](../../docs/adr/0007-executor-binding-type-taxonomy.md),
[docs/proposals/executor-type-taxonomy.md](../../docs/proposals/executor-type-taxonomy.md).
Migration: `apps/server/drizzle/0026_executor_binding_type.sql`.

**What breaks (deliberate, one-time):** the flat routing key `purpose ∈ {infra, software}` is
replaced by the two-level Category/Type taxonomy and the wire field is renamed `purpose → type`. In
**request** positions this is oasdiff-breaking:

- `?purpose=` query params renamed to `?type=` on `GET/DELETE/PATCH /executors/{idOrUrn}/binding`
  (parameter removed + added; enum values `infra`/`software` removed).
- request-body property `purpose` renamed to `type`, with the enum changed from
  `{infra, software}` to `{image, rpm, deb, npm, infrastructure, configuration}`, on
  `POST /changes`, `POST /campaigns`, `POST /change-sources/{sourceKind}/mappings`, the discovery
  `sourceMappings[]`, and `PATCH /executors/{idOrUrn}/binding`.
- response field `movedBindingPurposes` renamed to `movedBindingTypes` on `POST /components/{idOrUrn}/merge`.

Additive-in-response parts (the new `type`/`category` fields on binding / source-mapping /
wave-target responses) are **not** breaking.

**Why it is acceptable here:** owner decision D3 (ADR-0007) — a hard cutover with no legacy aliases,
safe because there is a **single instance** (homelab) and therefore no federation version-skew and
no external SDK consumer to break. This is explicitly **not** a precedent for post-GA `/v1`
breakage; a post-federation cutover would instead require a lockstep fleet upgrade.

**How the gate is satisfied:** the PR carries the **`api-v2-exception`** label; reviewers approve the
break against this record. `check.sh` still reports the breaking change (by design) — the label is
the branch-protection override, not a suppression in the script.
