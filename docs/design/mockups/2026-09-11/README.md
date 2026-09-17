# Recovered design mockups — 2026-09-11

These are **recovered design mockups, not implementation.** No product code, schema, or
route was touched to produce them — every file here is a self-contained static HTML
page built during a single design-review session on 2026-09-11, used to react to and
narrow down UI direction before anything gets built against the real
`PipelineWaveCard.tsx` / `catalog-marks.tsx` components.

## Why these needed recovery

The session built the mockups under `/tmp` (by its own admission, so as not to dirty
the repo with scratch files) and served them over a local `python3 -m http.server` for
the owner to click through. A reboot took `/tmp` — and with it every file — before any
of it reached the repo. The session's own closing message flagged this risk explicitly
and proposed landing the settled parts in `docs/design-system.md`, but the owner moved
on to one more mockup (`microservice.html`) before responding, and the transcript ends
there. Nothing from this session had been committed anywhere.

## How they were recovered

Source of truth: the full session transcript (`~/.claude/projects/-home-jag8765-ws-commanderscp/120af18f-....jsonl`).
Recovery was **not** a transcription — it was a **replay**: every file-producing
`tool_use` (the `Write` calls that wrote each mockup's baseline HTML, plus every
`Bash` heredoc, `cp`, `mv`, and in-place `python3` edit that followed) was extracted
from the transcript in the order it actually ran, path-translated from `/tmp` and
`.scratch/` to a scratch sandbox, and **executed** — not just concatenated.

Executing rather than transcribing mattered concretely: four of the seven mockups
(`depot.html`, `depot2.html`, `registry.html`, `microservice.html`) were built as Bash
heredocs (`cat > file <<HTMLEOF`) that interpolated shell variables (`$SYMS`, `$BASE`,
`$EXTRA`) holding SVG `<symbol>` markup generated moments earlier by a Python script
reading real icon path data out of the installed `lucide-react` package. A naive text
extraction of the heredoc body would have left those variables as the literal string
`$SYMS` rather than the icon markup they resolved to. Replaying the actual commands —
including the Python generator step, pointed read-only at
`/home/jag8765/ws/commanderscp/node_modules/.pnpm/lucide-react@1.31.0_react@18.3.1/…`,
the real installed copy in this checkout — resolves them correctly.

For `target-redesign.html`, the session itself wrote five successive full versions to
the same path as the design iterated (each a complete `Write`, not a diff), copied the
file out to a named version twice (`cp … target-redesign-v1.html`,
`cp … target-redesign-v4-wide.html`) at specific points, and applied one further
in-place narrowing edit after the last full write. All of that is reproduced here in
the same order. `sources.html` similarly went through three in-place edits after its
initial write (a Warehouse icon swap, promoting Type to a labelled badge, and adding
the "three things can originate change" section) — replayed in order below.

No content was invented. Where a replayed edit's anchor text didn't match, that would
have been recorded and the edit skipped — **this did not happen**: every anchor
matched and every edit applied cleanly (see below).

## Replay result: no failures

All replayed edits found their anchor text and applied successfully — there were no
skipped edits and nothing was invented. One faithfully-reproduced **quirk**, not a
failure: `registry.html`'s heredoc already interpolated `$EXTRA` (five icon symbols)
inline, and a later command in the same session re-generated the same five symbols
into `extra-syms.txt` and spliced them in a second time ahead of the `crate` symbol —
the session's own fix for "symbols missing" wasn't actually needed, and it left
`registry.html` with duplicate `<symbol id="…">` definitions for `database`,
`package`, `layers`, `triangle-alert`, and `external-link`. This is harmless (SVG/HTML
resolve `<use href="#id">` against the first matching id) and is reproduced here
exactly as the original session left it, not "fixed."

## Files

| File | What it shows |
|---|---|
| `target-redesign.html` | **Final** state of the pipeline-wave target row redesign — narrow ~610px card, `TargetReticle` mark, status as a coloured outline (dashed = idle), the four-slot checks rail (post-merge / post-deploy / continuous / bake), always rendered whether bound or not. |
| `target-redesign-v1.html` | An earlier iteration, preserved by the session's own `cp` before it moved on — first pass at using the existing military-materiel mark family (`ServiceGuidon`/`AssemblyStack`/`ComponentCrate`) instead of generic icons. |
| `target-redesign-v4-wide.html` | The wide (1040px, 4-across checks) version of the redesign, preserved by the session's own `cp` immediately before narrowing it down to the final ~610px/2×2 layout. |
| `pipeline.html` | A full multi-wave pipeline view covering all 11 executor Types across 3 waves (build → staging → production), with gated connectors carrying fan-in/approval counts and density that switches by Category (compact line for build, full card for infra/config). |
| `sources.html` | The source-mapping tile: `Warehouse` mark, `any ref` worded explicitly for `refPattern: null`, Type shown as a labelled badge + row (declared, not inferred), a precedence view for competing mappings, and a closing section distinguishing source mappings from registries and dependency lines. |
| `depot.html` | A comparison sheet of lucide-react candidate icons for the Sources mark (`Barrel`, `Dock`, `Container`, `Archive`, etc.) rendered from real path data — superseded once `Warehouse` was picked. |
| `depot2.html` | A follow-up, narrower comparison of just `Container` / `Dock` / `Warehouse` at large size, on a size ramp, and against the existing mark family — the one that led to the `Warehouse` decision. |
| `registry.html` | The registry tile (`ComponentPipelineRegistrySchema`): `Container` mark, all three states (`declared` / `ambiguous` / `none`), no deep links, no inferred `kind`, no invented winner on `ambiguous`, both publish-target and webhook-source role chips. |
| `microservice.html` | A full source-to-production pipeline for one Kubernetes microservice using the complete settled mark vocabulary — **the newest work, and a proposal the owner never responded to** (see below). |

## Owner decisions from this session

Quoted verbatim from the session transcript's user turns. **Approved** = the owner
picked or confirmed it explicitly. **Open / never decided** = the assistant asked and
the owner moved on without answering, or answered a different question. **Proposal,
no response** = built but the session ended before the owner reacted at all.

### Approved

- **Target mark, no per-type glyph, status as outline.** In response to the second
  iteration: *"Better! Though I think we need icons for the different types. So
  targets would have a good military-escque target icon. Then we show the type of
  target, though icon not needed. We can have a colored outline indicating status."*
  Confirmed by the assistant as three concrete changes and shipped: *"a proper
  military target reticle, type as plain text (no glyph), and status moved from a
  filled plate to a coloured outline."*
- **Card size, not a stretched bar.** *"No need then. Though lets relook the sizing of
  the entire target box. It should be a normal size, not hyperwide."* → the page
  narrowed from 1040px to 700px, putting the target card at **~610px**, and the
  4-across checks rail became 2×2 (fixed slot position preserved so the column stays
  scannable).
- **Full pipeline, one wave per target Type.** *"Much better. Now show me a full
  pipeline. Ideally one for each target type"* → `pipeline.html`.
- **A Sources tile.** *"Better. What about a new symbol and tile for Sources (repos,
  config, etc.)?"* → `sources.html` was born, first with a custom hand-drawn
  pitched-roof "SourceDepot" mark.
- **Reject the custom house mark; look at lucide depot icons.** *"I don't like the
  house, but depot sounds good. What icons for a depot do we have?"* → `depot.html`.
- **Container exists; show Dock and Warehouse too.** *"Do we have a shipping
  container? I'd like to see the Dock and Warehouse"* → `depot2.html`.
- **`Warehouse` for Source.** The owner's entire response to the depot2.html
  comparison was one word: *"warehouse"*. This is the mark used in every later file.
- **`sourceKind` (github/gitea/gitlab) is not the Type.** *"GitHub is a source, not
  type"* and *"exactly. Is it a code repo, chart repo, image repo, etc."* — this
  separated the source's *kind* (git host) from the routing *Type* (`configuration` /
  `infrastructure` / `chart` / `image`, operator-declared, never inferred from kind),
  and led to Type being promoted to its own labelled badge + row.
- **Registries are a separate concept, and `Container` is their mark.** *"I'm fine
  with registries being the containers"* — settled the last open slot in the mark
  vocabulary. The assistant's own closing summary of the fully settled table:

  | | mark | source |
  |---|---|---|
  | Service | `ServiceGuidon` | custom (already existed) |
  | Assembly | `AssemblyStack` | custom (already existed) |
  | Component | `ComponentCrate` | custom (already existed) |
  | Target | `TargetReticle` | custom — **needs adding** to `catalog-marks.tsx` |
  | Source | `Warehouse` | lucide import |
  | Registry | `Container` | lucide import |

### Open / never explicitly decided

- **Reticle vs. `TargetLock` (HUD corner brackets).** The owner said "better" on the
  version using the reticle but never explicitly picked between the two options the
  assistant offered side by side. The assistant proceeded on the assumption of
  reticle; this was never confirmed in words.
- **Whether the status word next to the outline can be dropped.** Kept for
  accessibility (outline-alone makes colour the sole carrier of status, which fails
  colour-blind readers) — the assistant flagged this as the owner's call and it was
  never answered either way.
- **The checks/canary rail's honesty gap was raised, and the fix was declined.** The
  owner asked to *"always show the canary/integration tests. That way we know what
  targets have them and what targets don't."* Building it faithfully, the assistant
  found the real data doesn't reach the UI today (`ChangeWaveTargetSchema` only
  carries a currently-*holding* continuous hook; `postMerge`/`postDeploy`/`bakeAlarms`
  aren't on the wave-target payload at all; no route exposes `pipeline_hook_runs`),
  and asked: *"Want me to spec that API addition?"* The owner's answer — *"No need
  then."* — declined the API work. The checks rail therefore stays as a **visual
  fixture only** in `target-redesign.html` and `pipeline.html`; nothing was
  commissioned to make it reflect real data, and the mockups should not be read as a
  wired feature. This is the "canary checks dropped" item: not removed from the
  drawings, but explicitly descoped as a real, truthful feature.
- **`config-source` vs. `source_mappings` as one tile or two.** The assistant flagged
  that a source mapping (a routing rule) and a `config-source` object (a synced repo)
  are different enough that "Sources" may need two tile shapes, not one stretched to
  fit both. The owner never responded to this distinction.
- **Landing the settled decisions in `docs/design-system.md`.** The assistant's
  closing message in the settled-vocabulary exchange proposed writing the mark
  vocabulary, status-as-outline convention, and source-tile rules into
  `docs/design-system.md` as a docs-only change, and asked: *"Want me to write that
  up, or keep designing?"* The owner's next message was *"Draw up a full pipeline for
  a K8s microservice"* — implicitly "keep designing," never explicitly answering the
  docs question. **`docs/design-system.md` was never updated with any of this**,
  which is the whole reason this session's work was only ever a browser tab.

### Proposal, no response (the newest work — treat as unapproved)

`microservice.html` was the last thing built before the transcript ends; the owner's
request was only *"Draw up a full pipeline for a K8s microservice,"* and the session
ended immediately after the assistant presented the result — there is no owner
reaction to any of it. It should be read as a proposal, not a decision. Per the
assistant's own presentation, the grammar it introduces is:

- **Scan sits on the connector, not inside a wave** — commander-side, running once per
  promotion journey over the artifact digest, with an explicit `digestMatch` callout
  (*"true iff the scanned digest equals the promoted one"* — drawn explicitly because
  without it a PASS proves nothing about what shipped).
- **Fan-in and approval are chips on the connector between waves**, each carrying a
  count (`fan-in 2/2`, `approval 1 of 2`), not folded into either wave.
- **Rollout is a discrete pip-stepper**, not a continuous bar — canary steps are
  discrete, so a bar would overstate what's known.
- **An unstarted bake is a dashed chip**, distinct from no bake at all — "declared but
  not started" and "absent" are different facts and are drawn differently.

The assistant's own standing caveat applies to every fixture in this session, restated
here because it matters for anyone picking this up: *"this is a fixture — your estate
has one `releases_via` edge, zero registries and zero source mappings, so this is the
shape a K8s microservice would take, not a reading of your data."*

## Offline / air-gap check

All nine HTML files are fully self-contained: inlined `<style>`, no `<link>`/`<script>`
pulling from a CDN, no `@font-face` or `@import`, no analytics. Verified with a
recursive scan for `http(s)://` and for CDN/font-host domains — the only matches are
two **inert placeholder strings** inside `registry.html`'s tile copy
(`https://harbor.example.com`, `https://git.example.com`), which are display text for
a fictional console link whose actual `href="#"` does nothing; they are not resource
loads and do not require network access. Every file opens correctly as a local
`file://` URL with no console errors expected from external fetches.
