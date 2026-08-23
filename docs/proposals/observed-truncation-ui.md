# Proposal: rendering truncated-versus-absent observed state (M23.1g handoff)

**Status:** v0.1 — designed 2026-08-18 on `claude/ui-review-worktree-efc42b`; **build gated on PR #264 (M23) merging to main** and this branch then merging main, because the `truncation` field exists only in #264's generated SDK and the web consumes only the generated SDK (charter principle 3). The design judgment was deliberately left to the UI side by M23.1g (its BUILD_AND_TEST entry records the handoff).

## 1. What the server now does (M23.1g, on `feat/m23-0-golden-argv` / PR #264 — relayed + shape read from the handoff, to re-verify against the merged SDK at build time)

Every plugin-supplied value is bounded before it reaches `change_wave_targets.observed_state` (an untrusted executor previously wrote 500,093 bytes into a permanent row). Cuts keep both ends and mark the elision. The wire signal is `ChangeWaveTarget.observed.truncation` — a record keyed by **root field name**: `{ dropped: boolean, droppedCharacters?, droppedEntries?, droppedFields? }`. `dropped: true` is the load-bearing bit: it is the only thing separating "we cut it" from "the executor never reported it". Additive-optional — pre-M23.1g rows carry no key and cannot be backfilled (the content is gone), so **no key = no claim of a cut**. A cut array's last element is a literal elision-marker string; the UI must NOT pattern-match markers (that would re-implement server semantics — the record is the contract).

**Measured by the M23 session against the built package (2026-08-18), not relayed from memory:** the whole-state case is NEVER a string — `boundPersistedJson`'s fallback ladder is `{__scpElided: "<diagnostic sentence>"}` → `{__scpElided: true}` → `null`, so **`__scpElided`'s value is `string | true`** (do not type-guard on `typeof === "boolean"`); rungs 2–3 need a budget under ~120 vs the shipped 8,000, but the type admits them, so the UI handles all three. `observed` is `.nullable()`: **`null` after a bound (everything discarded) is NOT the same as never-observed** — the `dropped: true` signal is what separates them, and the discarded case gets the "observed state truncated" pill, never the "not observed yet" placeholder. **RESOLVED (M23 session, measured against the store's composition, 2026-08-18):** `observed` is **never `null` after a bound** — `observedStateForRow` (`wave-targets-repo.ts:398` on #264) returns `null` only for never-observed, and otherwise spreads `bounded.value` (a spread of `null` is a no-op) plus `truncation` and `observedAt` back onto the row — so rung 3 is still an object `{truncation, observedAt}`. **The guard is two branches:** `observed === null` → never-observed (today's placeholder); `observed.truncation` present → we cut something. No `__scpElided` type guard is needed for the pill (present at rung 1, absent at rung 3, while `truncation` is present at both — key off the one the wire guarantees); rung 1's diagnostic string, when present, goes in the tooltip. Rungs 2–3 are **unreachable in production** (the shipped budget is the constant 7,584 and rung 1's ~140-char diagnostic always fits), so the case actually met is rung 1. Grep trap for the build round: `supply-chain.test.ts` "preserves a producer's truncation flag" is a **different, pre-existing concept** (producer-supplied flag on supply-chain evidence) — do not wire the two together. Deliberate asymmetry: `revision` is bounded but carries **no** truncation signal (its reader is the plugin, not an operator — `packages/schemas/src/changes.ts:264` on #264); the UI therefore renders revision as-is and makes no claim about it.

## 2. The three read sites (`apps/web/src/components/pipeline/PipelineWaveCard.tsx`, HEAD 6b01afe5)

| Site | Today | How it can now mislead |
|---|---|---|
| `:320` `observed?.images?.[0]` → "version \<tag\>" | first entry; tail is what gets cut | safe for the rendered value; but if `images` itself is `dropped`, the slot falls to the `—` placeholder titled "not observed yet" — a wrong cause |
| `:321` `observed?.revision` | `(rev abc1234)` | can be a cut string; **no signal by design** — nothing to render differently |
| `:368` `observed?.rollout` | omitted when falsy ("no rollout observed") | `dropped: true` renders as *nothing* — the exact truncated-as-absent lie, principle 6 |

Plus the rare whole-state case: `observed` replaced by a diagnostic sentence (0 firings / 150k shapes now, but possible).

## 3. Design (follows the design system; the honesty pill is the amber-dashed `Badge unknown`)

**Rule: the pill appears exactly where a rendered claim would otherwise be false; cuts that do not change what is rendered go in the tooltip, not the row** (the compact-tiles noise rule).

1. **`truncation.rollout?.dropped`** → in the rollout slot, instead of nothing: `Badge unknown` **"rollout truncated"**, tooltip: *"The executor's rollout report exceeded the stored bound and was elided (N fields / N chars removed). This is not 'no rollout observed'."* — counts from the record, omitted when absent.
2. **`truncation.images?.dropped`** (the whole list cut away) → the version slot renders `Badge unknown` **"version truncated"** with the same-shape tooltip, never the `—` "not observed yet" placeholder.
3. **`truncation.images` present but `images[0]` renders** (tail entries removed) → rendered value unchanged; the existing tooltip gains one line: *"image list truncated — N more entries removed"*. No pill (the claim shown is true).
4. **Any other root key with `dropped: true` that the card renders in future** inherits rule 1 by construction: one helper `truncatedBadge(truncation, field)` used at every observed read, so a new read site cannot silently re-introduce the lie.
5. **Whole-state elision** → keyed off `truncation` alone (`observed` is never `null` after a bound; every rung keeps the record — see §1): when the record marks the state's own fields dropped and nothing renderable survives, the version slot shows `Badge unknown` **"observed state truncated"**, with rung 1's `__scpElided` diagnostic sentence in the tooltip when present (`string | true` — used for copy only, never as the guard); rollout slot stays empty (covered by the same pill). `observed === null` = never observed = today's placeholder.
6. **Absent without a truncation key** → exactly today's rendering (placeholder / omitted). Pre-M23.1g rows are indistinguishable by design and make no claim.

Tests (build time): each of 1/2/3/5 pinned with fixtures carrying the record; mutation — rendering the empty state when `dropped: true` goes red; a marker string in a fixture array must never appear in the DOM (pin: the UI never pattern-matches, but also never *renders* a marker as an image ref, which rule 3 guarantees by only rendering `images[0]` when it is real per the record).

## 4. Sequencing

Blocked on #264 → main → this branch's next main-merge (which also renumbers migrations 0073–0079 and re-runs the E6 byte-equality pin). At build time: re-verify the shape against the merged `types.gen.ts` rather than this relay (read-never-infer), then implement §3 + tests in `PipelineWaveCard.tsx`.
