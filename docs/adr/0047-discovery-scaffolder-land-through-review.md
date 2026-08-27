# ADR-0047: Discovery is a scaffolder — scaffold permissively, land through review

**Status:** **Accepted** — owner ruling D1, made in-session 2026-08-26 and recorded in [docs/proposals/team-pipeline-iac.md](../proposals/team-pipeline-iac.md) §0 and §7, with the sunset timing settled by §14 resolution 3. This ADR is that acceptance, and it **amends [ADR-0005](0005-component-create-strict.md)**'s "import surfaces stay permissive by design" clause.

**Numbering note (claimed 2026-08-26):** a census of `docs/adr/` on `origin/main` **and every remote branch** found `0045` the highest number anywhere; this document takes `0047` behind [ADR-0046](0046-what-how-split-config-sources-and-binding-policy.md). Per [ADR-0044](0044-multi-region-instance-resilience.md)'s numbering note, **a number claimed by census is valid only as of that census** — re-run against `main` immediately before merge.

**Relates to:** [ADR-0005](0005-component-create-strict.md) (create-strict / import-permissive — **amended here**), [ADR-0046](0046-what-how-split-config-sources-and-binding-policy.md) (the config-source delivery path scaffold output lands through), [ADR-0002](0002-execution-strategy.md) (three modes; Mode A "import & coordinate an existing execution system" is the workflow discovery serves), [ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) (the fake-success an unbound imported placement reaches), [ADR-0017](0017-ownership-refinement.md), [import-existing-executors.md](../proposals/import-existing-executors.md), [post-import-configuration.md](../proposals/post-import-configuration.md), [organize-after.md](../proposals/organize-after.md) (M12 P5, the proposal ADR-0005 came from), [BUILD_AND_TEST.md §6](../BUILD_AND_TEST.md) (`/v1` additive-only, `tools/openapi/check.sh`, the `api-v2-exception` process).

---

## Context

The owner's ask included, verbatim in substance: **remove auto-import — import happens via IaC.**

Grounding established what that does and does not refer to, and the distinction matters enough to state before anything else.

**Nothing in the tree named "auto-import" creates graph objects.** The only literal occurrence of that string is the M13.1a **federation inbox loop**, which replicates promotion bundles between domains. It is unrelated to this decision and is **untouched**. Removing it would break federation.

What the ask actually names is **`POST /discovery/accept`**. Discovery (`discovery/run` + `discovery/accept`) is the **only observation-driven graph-write path in the platform**. Everything else fails closed: the observe and webhook loops will not create an object without a `source_mappings` row. Accept is the sole committing path, and — per ADR-0005's own design — it is *permissive*: it bypasses strict create.

That permissiveness has a measured cost. The homelab's **~50 imported components landed as RBAC orphans** — components belonging to no service, reachable only from the org root and from no service-scoped role binding. ADR-0005 anticipated this and paired it with "organize-after" (the `move` verb) as the remedy. In practice the remedy did not run: nothing forces the organizing step, and an orphan is not visibly broken until someone needs service-scoped authorization or a placement to bind. An imported placement that never got bound then reaches the [ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) case (a) hazard, where it **fake-succeeds** under stage-shaped compilation.

The diagnosis is not that discovery is wrong. Discovery is genuinely useful, and Mode A ("bring your existing Argo CD") depends on it. The diagnosis is that **the grouping decision — which components belong to which service — requires a human, and accept is the one point in the flow where no human is present.** A one-click accept is precisely the ceremony that lets fifty ungrouped objects into the graph in a single motion.

Meanwhile [ADR-0046](0046-what-how-split-config-sources-and-binding-policy.md) makes a reviewed, auditable landing path exist for the first time: a manifest in a repo, merged through the team's own PR review, applied as that team's identity, with a Decision per plan. That is the path discovery's output should join, rather than a second, weaker write door beside it.

---

## Decision

**Discovery is demoted to a scaffolder. Its output is code, not a graph write.**

### 1. What discovery becomes

`discover()` stays — it is the scaffolder's engine, and `POST /discovery/run` is unchanged. What changes is what happens to its findings:

`scp iac scaffold --from <execution-system-urn> [--repo-pr]` runs the existing discovery and renders the proposal as **`@scp/iac` construct code plus the synthesized manifest**, grouped into services interactively or by flag, and optionally opens a **PR against the config repo**.

**The orphan problem is solved at authoring time, where a human is present.** Grouping happens in the scaffolder's interactive step or in the PR review, not in a graph write nobody looks at. The scaffolder also emits a commented starter wave topology, so the output is a working declaration rather than a bag of objects.

The `/connect` wizards become **scaffolder UI** — same user journey, different terminal step: instead of "accept these 50 things into the graph," it is "here is the code for these 50 things; review and merge it."

### 2. What is removed, and when

**`POST /discovery/accept` is removed in the same increment that ships the scaffolder** (proposal §13 increment 6). Not deprecated-then-removed; removed, with the replacement landing beside it in one change.

- Removal of an operation is a `/v1` break, handled by the established **`api-v2-exception`** process exactly as [ADR-0005](0005-component-create-strict.md) and ADR-0004 handled theirs: the label plus conscious reviewer sign-off on the PR, a human override of `tools/openapi/check.sh`'s exit code — **not** a code or CI-config change, and not something the check grants itself. This ADR is the record that the break is deliberate.
- **No deprecation window and no transition flag.** The platform is pre-release with no external usage (owner's development-stage note, 2026-08-26), so there is no un-regenerated client to strand, and a flag would only preserve the write path this decision exists to close. Every first-party consumer (UI, CLI, IaC) regenerates from the SDK.
- **`backfill-source-mappings` survives until the estate migration completes** (proposal §9, increment 7) and is then **removed the same way** — same exception process, same reasoning. It exists to repair estates imported the old way; when the homelab estate has converted, its subject no longer exists.
- **The M13.1a federation inbox loop is untouched.** Stated here because it is the only thing in the tree literally called "auto-import" and is the obvious thing for a future reader to remove by mistake.

### 3. The ADR-0005 amendment

ADR-0005 established **"create is strict, import is permissive."** Its create-strict half is untouched and remains correct: `POST /components` requires `service`, the generic `/objects/component` route refuses write verbs, and the invariant holds at every direct-create surface.

Its import-permissive half is **restated, not abandoned**:

> **Scaffold permissively, land through review.**

The *spirit* — never block a user from bringing their estate in — survives intact and is arguably better served: the scaffolder will happily render whatever it finds, however messy, with no strictness applied to the *proposal*. What moves is the **graph write**, which now happens through the reviewed manifest path where strict create applies like it does to everything else.

Two precision points, because "import surfaces" in ADR-0005 named three things and only one of them is affected:

- **`discovery/accept` — removed.** This is the amendment.
- **Federation journal replay — unchanged, and not an "import surface" in this sense.** Replay is single-writer authority materializing another domain's authored state; it is not a user importing an estate, and nothing here touches it.
- **Overlay — unchanged.**

For estates that already exist, the supported path is **adopt and export** (proposal §9, increment 7): `scp iac export` reverse-generates constructs and manifest from live state, and plan/apply gains explicit *adopt* semantics so an existing unmanaged object can be taken into a stack. Adoption is how the homelab's imported estate converts, and how a future customer brings an existing estate in — it is full product surface, not a migration script.

---

## Consequences

**Positive**

- The orphan class is closed **at its source** rather than remediated after the fact. A component cannot enter the graph without a service, because the only remaining entry is the strict-create path.
- The single observation-driven write path in the platform goes away, leaving one authored, reviewed, audited way for objects to appear. Every landing carries a PR, a reviewer, a commit SHA, and a Decision.
- Discovery's actual value — *finding* things — is kept whole; only the committing verb moves.
- Import stops being a place where the platform quietly disagrees with its own create rules.

**Negative, and accepted**

- **One-click import is gone.** Bringing in an estate now costs a PR. For a 50-component estate this is the intended cost: a human decides the grouping once, instead of the graph carrying the ambiguity forever. The scaffolder's `--repo-pr` flag keeps the ceremony to a single review.
- A `/v1` operation is removed. Mitigated by the exception process and by the development-stage posture; the blast radius is first-party regenerated clients only.
- Orgs without a config repo still need somewhere for the scaffold output to land. [ADR-0046](0046-what-how-split-config-sources-and-binding-policy.md) D7 keeps **CLI-push first-class**, so `scp apply` against the scaffolded manifest works with no repo registration at all — the scaffolder writes files, and where they go is the org's choice.
- Existing orphaned components in the homelab estate are not fixed by this ADR. They are fixed by increment 7's adopt/export conversion, which this ADR makes the only remaining path.

---

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Keep `accept` behind a feature flag** | Preserves the write path this decision exists to close, and guarantees it stays reachable in exactly the estates least likely to review it. Dev-stage means there is no compatibility argument for the flag to carry. |
| **Deprecate with a transition window, remove later** | The window's only beneficiary is an external client, and there are none (development-stage note, 2026-08-26). A window also splits the scaffolder's arrival from accept's departure, leaving two import doors open simultaneously — the worst configuration for a reviewer trying to understand how an object got there. §14 resolution 3 ruled removal in the scaffolder's own increment. |
| **Make `accept` strict instead of removing it** | Does not solve the actual problem. The grouping decision needs a human; a strict accept just fails 50 times with nobody positioned to answer. And it keeps a second graph-write path alive, so "how did this object get here?" retains two answers. |
| **Have the scaffolder write to the graph directly, but require an interactive confirmation** | A confirmation prompt is not a review — it is not diffable, not attributable, not re-readable six months later, and not something CODEOWNERS can route. The whole value of landing through review is the artifact it leaves behind. |
| **Remove `discovery/run` as well** | Discovery is the scaffolder's engine and Mode A depends on it. Nothing about *observing* an execution system was ever the problem. |
| **Remove the M13.1a federation inbox loop** (the only literal "auto-import" in the tree) | Unrelated to this decision; it replicates promotion bundles between domains. Removing it would break federation. Named explicitly in §2 above so a future reader does not make this mistake. |

---

## Charter check

| Principle | Verdict |
|---|---|
| 1 Coordination, not execution | **Holds.** Discovery still only observes; the scaffolder emits files. Nothing new is executed and no new credentials are held. |
| 2 Graph-native | **Holds.** No new object type; the change is which door graph writes come through. |
| 3 API-first parity | **Holds.** `scp iac scaffold` lands API → SDK → CLI → IaC → UI, and the `/connect` wizards become its UI rather than a separate flow. |
| 4 PostgreSQL only | **Holds.** No new dependency. |
| 5 Air-gap first-class | **Holds.** Scaffolding runs where discovery runs; output is files, which travel as files. |
| 6 Explainability | **Improved.** "How did this object get here?" acquires a single answer with a commit SHA and a Decision behind it, replacing a write path with no review artifact. |
| 7 Priorities | Simplicity first: one write door instead of two, at the cost of one click. |
