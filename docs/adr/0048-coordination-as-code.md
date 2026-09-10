# ADR-0048: "Coordination as Code" — naming SCP's own registry-as-code, and never abbreviating it

**Status:** **Proposed.** The **name** is the owner's ruling, made in-session 2026-09-10 (the owner proposed "Coordination as Code" and rejected "Estate as Code"). The **never-abbreviate rule**, the rename scope in D3, and the migration split in D4 are proposed here and pending sign-off. This document **amends [ADR-0021](0021-terminology.md)**, which owns this repository's vocabulary.

**Numbering note (claimed 2026-09-10):** a census of `docs/adr/` on `origin/main` **and every remote branch** found `0047` the highest number anywhere, so this document takes `0048`. Per [ADR-0044](0044-multi-region-instance-resilience.md)'s numbering note, **a number claimed by census is valid only as of that census** — re-run it against `main` immediately before merge.

**Relates to:** [ADR-0021](0021-terminology.md) (the terminology ADR this amends), [ADR-0046](0046-what-how-split-config-sources-and-binding-policy.md) (the `production`-not-`prod` spell-out precedent D2 leans on, and the ADR that describes `@scp/iac`'s synth → `scp plan`/`apply` path), [ADR-0031](0031-domain-local-objects-never-federate.md) (domain-local content, the sense that keeps the name "configuration as code"), [ADR-0007](0007-executor-binding-type-taxonomy.md) (the `infrastructure` / `configuration` routing Types), [iac-stack-ownership.md](../proposals/iac-stack-ownership.md) (`managed_by_stack` pruning, which D4 declines to disturb), [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principle 1 (coordination, not execution — the verb this name takes from), [docs/GLOSSARY.md](../GLOSSARY.md) (delivered by this ADR).

---

## Context

**"IaC" carries three unrelated senses in this repository**, and [docs/GLOSSARY.md](../GLOSSARY.md) already spends a paragraph holding them apart — the `configuration as code` entry's "Not to be confused with" block names two siblings it is *not*:

1. **A tenant's content class** — declarative configuration and infrastructure kept in git and released down a pipeline like any other artifact. Frequently domain-local ([ADR-0031](0031-domain-local-objects-never-federate.md)). This is the sense the glossary defines under `configuration as code`.
2. **SCP's own registry declared as code** — `scp plan` / `apply` over SCP's *own* graph objects: services, components, ownership, placements, pipelines, policies, governance rungs. `@scp/iac` synthesises a `DesiredStateManifest`; the server diffs desired against actual (`apps/server/src/iac/plan-diff.ts`) and prunes within the stack it owns.
3. **The managed IaC executor** (`scp-managed-iac`) — an execution *mechanism*, the charter's scoped exception to principle 1, not a content class at all.

**When a term needs a standing disambiguation block against two of its own siblings, the term is doing poor work.** Sense 2 is also the one where "IaC" is simply *wrong*: nothing it declares is infrastructure. A stack file declares the organisation's model — its systems, ownership, dependencies and governance, which is the charter's opening sentence — and the platform's whole identity is that it **coordinates** that model rather than executing it. The word was borrowed early because the construct library is CDK-shaped, and the shape was mistaken for the subject.

**Why this surfaced now (2026-09-09/10).** Reviewing the homelab estate's stack declaration (`scp/homelab-gitops.stack.ts`, 623 lines, unapplied, open on PR #3 in the `homelab-gitops` repo since 2026-08-02) surfaced the cost concretely: a file that imports `@scp/iac`, is named for a *stack*, declares nothing but services and components, and spends five lines of its module docblock on the `scp:managed-by=iac` pruning marker — while sitting in a repository whose *other* meaning of "IaC" is the Kubernetes manifests in the same tree.

### The abbreviation is already taken — measured, not assumed

`CaC` is **not** free. A census (`grep -rna '\bCaC\b'`, `--text` so NUL-carrying sources are not silently dropped) finds **17 occurrences**, none casual: every one is the designed pair **"IaC/CaC"** meaning sense 1, tenant content travelling a pipeline.

| Where | Weight |
|---|---|
| [GLOSSARY.md:983](../GLOSSARY.md) (`dependency subscription`) | Normative — states the out-of-scope rule |
| [ADR-0032](0032-dependency-subscriptions.md) ×2 (§ lines 994, 1832) | Accepted ADR text |
| [outpost-ui.md](../proposals/outpost-ui.md) ×5 | **Central** — "domain-specific IaC/CaC" is the defining difference of the entire outpost site |
| [dependency-subscription-ui.md](../proposals/dependency-subscription-ui.md) | Owner-ruled scope sentence |
| [web.md](../web.md) ×3, [dependencies.md](../dependencies.md) ×2, [BUILD_AND_TEST.md:767](../BUILD_AND_TEST.md) | Delivered design text |
| `packages/schemas/src/services.ts:149`, `apps/server/src/coordination/service-board.ts:625` | **Shipped code comments** |

Introducing a second `CaC` would collide head-on with a term that is load-bearing in the outpost UI design. That constrains the abbreviation, **not** the name.

---

## Decision

### D1 — The name

Sense 2 is **Coordination as Code**. It replaces "IaC in the SCP-internal sense" in all prose, headings, glossary text, ADRs written from here on, UI copy, and CLI help.

### D2 — It is never abbreviated

**Write "Coordination as Code" in full, always.** `CaC` continues to mean *configuration as code* (sense 1) and is not to be redefined.

This is a rule the project already uses: [ADR-0046](0046-what-how-split-config-sources-and-binding-policy.md)'s vocabulary ruling (D6/D21(e), 2026-08-26) spells **`production`** out and bans `prod` for exactly this reason — an abbreviation that reads as two different things costs more than the characters it saves. A reviewer who writes `CaC` for Coordination as Code should be corrected the same way one who writes `prod` is.

### D3 — Scope of the rename: words now, identifiers later, stored values not yet

Three tiers, deliberately separated because their costs differ by orders of magnitude:

| Tier | Contents | This ADR |
|---|---|---|
| **A. Prose** | GLOSSARY entry + table row, ADR-0021 pointer, the `configuration as code` disambiguation block, new docs, UI copy, CLI help | **Rename now.** Cheap, reversible, and where the confusion actually costs review time. |
| **B. Identifiers** | `@scp/iac` package name, `apps/server/src/iac/`, `packages/iac/`, `DesiredStateManifestSchema`, type and symbol names | **Deferred, not refused.** Mechanical but wide: `@scp/iac` is imported by `packages/sdk` (including generated files), `packages/schemas`, and the CLI. Worth one focused change, not a drive-by. |
| **C. Stored values** | `MANAGED_BY_IAC_VALUE = "iac"` (`apps/server/src/iac/plan-diff.ts:38`) and the `scp:managed-by` / `scp:stack` label pair it writes into `objects.labels` and `relationships.labels` | **Explicitly out of scope.** See D4. |

### D4 — The persisted label value stays `iac` until a deliberate expand/contract migration

`scp apply` decides **what to prune** by reading the `scp:managed-by=iac` + `scp:stack=<name>` marker pair off live rows. Changing that value is a data migration against every managed object in every estate, and the failure modes are asymmetric and severe: write the new value while the reader expects the old and **apply prunes nothing**; flip the reader first and **apply treats every previously-managed object as unmanaged**. On the homelab trial alone the marker is carried by 24 objects and 59 relationships (stack `agentkit-org`).

A rename here buys nothing a user can see — the value is never displayed — so it stays `iac` until someone wants it enough to write the expand/contract change: emit both values, migrate readers, backfill, drop the old. That is a separate ADR if it ever happens.

### D5 — The other two senses are unchanged

**Sense 1 keeps "configuration as code"** — it is genuinely industry-standard and correctly named. **Sense 3 keeps `scp-managed-iac`**: it is a component name, it is charter text ("Managed Execution Exception"), and it really does execute infrastructure-as-code, so the word is accurate there.

---

## Consequences

**The glossary gains an entry and loses a disambiguation burden.** `configuration as code`'s "Not to be confused with" block stops having to explain a homonym and instead points at a distinctly-named neighbour.

**A census of tier C must use `grep -rna`, never `grep -rn`.** `apps/server/src/iac/plan-diff.ts` holds `MANAGED_BY_IAC_VALUE` and the sole label test that makes an object a *delete* candidate — and it **contains NUL bytes** (verified at byte level 2026-09-10: 56,993 bytes, 2 NUL, first at offset 11538). Every recursive search tool classifies such a file as binary and **drops it with no output and exit 1**, which is indistinguishable from "no such code exists" ([CLAUDE.md](../../CLAUDE.md), BUILD_AND_TEST.md §4.4b, `pnpm nul-census`). A tier-C census run the documented-but-wrong way misses the one file that decides deletions.

**Existing documents are not retro-edited.** Following [ADR-0021](0021-terminology.md)'s own precedent, dated records keep their original wording where they cite a real object or a measurement; rewriting them would make the record claim the project used words on a date that it did not. New and revised text uses the new term; the glossary is the current reference.

**Nothing changes in the schema, the API, or any live estate.** This ADR moves words in tier A only. `pnpm gen` output is unaffected, no migration is implied, and no running instance behaves differently.

---

## Alternatives considered

**Estate as Code (EaC)** — precise for what the construct declares, abbreviation free, and with an existing code-level anchor in `packages/iac/src/estate-program.ts`. **Rejected by the owner, 2026-09-10.**

**Graph as Code (GaC)** — `GaC` is unused, and it points at charter principle 2, since a stack file literally declares graph objects and relationships. Rejected as the weaker identity: it names the storage shape rather than the purpose, and the charter's distinguishing verb is *coordinate*.

**Registry as Code (RaC)** — matches the glossary's own "SCP's *own* registry objects" phrasing. Rejected because "registry" is overloaded toward artifact registries (ADR-0012's Gitea npm registry, `publishes_to` edges), which is a worse collision than the one being fixed.

**Platform as Code (PaC)** — rejected outright: `PaC` is widely established as *policy* as code, and SCP has policy objects, so this would manufacture a third collision.

**Keep "IaC" and rely on qualifiers** — the status quo. Rejected: the glossary has been carrying the qualifier since it was written and the collision still reached shipped code comments, two ADRs and a 623-line stack file's docblock. A disambiguation block that has to be repeated at every use site is a naming failure, not a naming solution.
