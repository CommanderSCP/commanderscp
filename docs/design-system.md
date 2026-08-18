# CommanderSCP Web UI Overhaul — Design Specification v1.0

Implementation teams execute this verbatim. Where a finding conflicted with a constraint, the constraint won; where two lenses proposed different treatments, this spec picks one. Tailwind v4 utilities only. No config file. No CSS-in-JS. No new API endpoints. Nav structure and labels unchanged.

**Standing decisions (apply everywhere, cite this section):**
- **Icons: `lucide-react`**, added as a normal bundled npm dependency (tree-shaken ES imports — air-gap safe, no CDN/font). The hand-rolled inline SVGs in `component-pipeline.tsx` (NODE_ICON/PipelineIcon) are replaced by lucide equivalents in group C; do not keep two icon systems.
- **Light-only by decision.** `color-scheme: light` stays. No `dark:` classes anywhere. Record this in a code comment atop `index.css`.
- **Fonts:** system stack (Tailwind default `font-sans`). No font files added.
- **Accent color: ARMY OLIVE** (owner decision 2026-08-11, two rounds; originally indigo-600 — the class-level mapping was swept, but §2.12/§3.2 below still write "indigo" in their examples: read every `indigo-*` there as the corresponding `army-*`). A custom `@theme` scale (`--color-army-50..950`, olive drab) lives in `index.css`. Round 1: accents only (primary actions, active nav, focus rings, brand mark). Round 2 ("more green undertones in the bars, tabs, and such"): the chrome carries it too — dark-olive sidebar (`bg-army-900`, light text, `army-700` active row), `army-50` table header bands and row hovers, `army-200` tab rails and header-bar border, `army-50` login/device canvas. Content cards stay white. Never for status — status keeps its own palette (§1.5) so accent and semantics never collide; the graph's categorical palette also stays blue-violet (it encodes group membership, not brand).
- **Honesty ethos:** unknown/unobservable is never painted as fine — but "unknown, operator should care" (amber dashed) is now distinct from "structurally not-yet / not-applicable" (neutral em-dash + tooltip). Both remain visually distinct from real data.
- **Test survival:** every change near a `data-testid` keeps the testid on the same logical element. Pinned copy that leaves the visible page moves into a `title=""` attribute on the replacing element (explicitly allowed). The literal class `text-amber-700` and the amber-dashed treatment pinned by `service-board-honesty.test.tsx:330,339` are preserved exactly by the Badge `unknown` tone (§2.2).

---

## 1. DESIGN LANGUAGE

### 1.1 Canvas & surfaces
| Layer | Classes |
|---|---|
| Page canvas (AppShell `<main>`) | `bg-slate-50` |
| Surface (Card, table container, dialog, sidebar, header bar) | `bg-white` |
| Inset/wells (code, raw JSON, gate sub-rows) | `bg-slate-50` inside a white card |
| Hover row/tile | `hover:bg-slate-50` |

The app today is white-on-white; moving the canvas to `bg-slate-50` is what makes cards read as cards without adding heavier borders.

### 1.2 Borders, radius, shadow
- Border color: `border-slate-200` everywhere. `border-slate-300` only for interactive controls (inputs, outline buttons) and the amber-dashed unknown treatment (`border-amber-300 border-dashed` — pinned).
- Radius: `rounded-lg` for cards/dialogs/alerts; `rounded-md` for buttons/inputs/selects/tiles; `rounded-full` for badges only.
- Shadow: `shadow-sm` on cards and dialogs' trigger surfaces; `shadow-lg` on open Dialog panels and dropdown content. Nothing else. No `shadow` / `shadow-md` anywhere.

### 1.3 Typography scale (exact classes — no other title/heading classes permitted)
| Role | Classes |
|---|---|
| Page title (h1, only inside PageHeader) | `text-2xl font-semibold tracking-tight text-slate-900` |
| Page description | `text-sm text-slate-500` |
| Section heading (CardTitle, h2) | `text-sm font-semibold text-slate-900` |
| Eyebrow / section label | `text-xs font-medium uppercase tracking-wide text-slate-500` (canonical; **slate-500, never slate-400**) |
| Body | `text-sm text-slate-700` |
| Emphasis value (stat numbers) | `text-2xl font-semibold tabular-nums text-slate-900` |
| Caption / meta / timestamps | `text-xs text-slate-500` |
| Mono (URNs, ids, versions) | `font-mono text-xs text-slate-600` |

This fixes the two drifted page titles (`component-pipeline.tsx:1035`, `service-infrastructure.tsx:47`) mechanically: they migrate to PageHeader.

### 1.4 Spacing rhythm
- Page: `p-6` from AppShell; page content is `flex flex-col gap-6` (sections), `gap-4` within a section, `gap-2` within a row. `max-w-5xl` on sparse pages (assembly detail, identity, registry detail, settings pages); full width on boards/tables/graph.
- Card density comes only from the Card `size` prop (§2.4). No ad hoc padding overrides on CardContent.

### 1.5 Status color system (soft-tint)
Solid saturated badge fills are retired. One system, six tones, used by Badge, Alert, StatCard deltas, and table state cells:

| Tone | Classes | Meaning |
|---|---|---|
| `neutral` | `bg-slate-100 text-slate-700 border-transparent` | inert/categorical (roles, kinds, dates never — see copy rules) |
| `info` | `bg-blue-50 text-blue-700 border-blue-200` | in progress, validating |
| `success` | `bg-emerald-50 text-emerald-700 border-emerald-200` | succeeded, healthy, applied |
| `warning` | `bg-amber-50 text-amber-800 border-amber-200` | needs attention, degraded, frozen |
| `danger` | `bg-red-50 text-red-700 border-red-200` | failed, blocked, emergency |
| `unknown` | `bg-amber-50 text-amber-700 border-amber-300 border-dashed` | unobservable/unverified where an operator should notice. **Keeps literal `text-amber-700` — test-pinned.** |

Structurally-expected absence (fresh outpost with zero syncs, Layer B unmodeled fields) is NOT a badge: it renders `—` in `text-slate-400` with a `title=""` tooltip carrying the honesty sentence. Amber is thereby reserved for signal (fixes the /federation/outposts wall-of-amber).

### 1.6 Icon rules
- Library: `lucide-react`. Import icons individually.
- Sizes: `size-4` (16px) beside `text-sm`; `size-3.5` inside badges/captions/table cells; `size-5` in nav and EmptyState; `strokeWidth={2}` at ≤16px, `1.75` at 20px+.
- Every icon is `aria-hidden="true"` unless it is the sole content of a control, in which case the control gets `aria-label`.
- Federation role marks (custom, `src/components/icons/federation-roles.tsx`, built via `createLucideIcon` — owner direction 2026-08-11): commander `CommanderStar` (general's star over a base bar), outpost `OutpostFort` (crenellated fort tower), retrans `RetransMast` (antenna mast with signal arcs on BOTH flanks — receive/resend). Used in every role badge and the Outposts nav entry; `unset` deliberately has no mark.
- Catalog marks (custom, `src/components/icons/catalog-marks.tsx` — owner direction 2026-08-11): service `ServiceGuidon` (swallow-tail unit standard), assembly `AssemblyStack` (crate stack — materiel grouped for movement), component `ComponentCrate` (cross-braced ammo crate — the unit that ships). Used in the nav, StatCards, and — via `lib/graph-glyphs.ts` data-URI rasterization of the SAME path data — painted white inside graph canvas nodes (glyph supplements shape+colour, never replaces them). The sidebar also wears an instance-role chip (post-auth only — the login page deliberately never learns the role: pre-auth topology disclosure).
- Canonical vocabulary (no substitutes): forward/drill-in `ArrowRight`; back `ArrowLeft`; external (leaves CommanderSCP) `ExternalLink` at `size-3.5`, gap `gap-1`, always after the text; pass `Check`; fail `X`; pending `Circle`; partial/in-progress `CircleDashed`; warning `TriangleAlert`; error/blocked `CircleAlert`; unknown/unobservable `CircleHelp`; info affordance `Info`; select chevron `ChevronDown`.

---

## 2. SHARED COMPONENTS (`src/components/ui/` unless noted)

### 2.1 PageHeader — new
```tsx
<PageHeader title description? actions? backTo? backLabel? meta? />
```
- `title`: h1 per §1.3. `backTo/backLabel`: renders `ArrowLeft size-4` + label as a link above the title (`text-sm text-slate-500 hover:text-slate-900`, focus ring per §2.10) — replaces every `← X` literal. `actions`: right-aligned slot (`flex items-center gap-2`). `meta`: optional row of Badges/fragments under the description (the compressed component-pipeline intro lives here). Layout: `flex items-start justify-between gap-4`, bottom margin from the page's `gap-6`.
- Migrate all 20 routes listed in the primitives findings. No route may render its own h1 afterward.

### 2.2 Badge — rewrite
- Keep the cva shell; replace the variant set with the six tones of §1.5 plus a size axis: `sm` (`px-2 py-0.5 text-xs`) default, no other sizes.
- Legacy variant names remain as deprecated aliases mapping onto tones (`default→neutral`, `secondary→neutral`, `destructive→danger`, `info→info`, `success→success`, `outline→neutral`) so untouched call sites don't break mid-migration; delete the aliases at the end of group E.
- Optional `icon` prop rendering a `size-3.5` lucide icon before the label.
- Migrate every hand-rolled pill (service-board, component-pipeline, outposts, outpost-configuration, dashboard) onto it. The `unknown` tone is the ONLY sanctioned rendering of the honesty pill.

### 2.3 Alert — new
```tsx
<Alert tone="info"|"warning"|"danger"|"neutral" title? children icon? />
```
- `rounded-lg border p-3 text-sm` + tone tints from §1.5 (info/warning/danger/neutral bg-*-50, border-*-200, text-*-800). Default icons: `Info`, `TriangleAlert`, `CircleAlert`, none. Prove it by converging `error-boundary.tsx` + `query-error.tsx` first, then migrate all ~14 hand-rolled callouts in `outpost-configuration.tsx`, `outpost-settings.tsx`, `registry-list.tsx`. `QueryErrorNotice` re-renders through `<Alert tone="danger">` internally (its diagnosis content unchanged).

### 2.4 Card — restyle
- `rounded-lg border border-slate-200 bg-white shadow-sm` (unchanged shell) + new `size` prop: `default` (CardContent `p-6 pt-0`), `compact` (`p-4 pt-0`), `flush` (`p-0`). Routes select a size; arbitrary padding overrides are removed in the same PR that touches the route.

### 2.5 StatCard — new
```tsx
<StatCard label value? icon? to? badge? hint? />
```
- Built on `Card size="compact"`. `value` in emphasis-value type (§1.3); `label` in eyebrow type; optional lucide `icon` at `size-5 text-slate-400` top-right; `to` makes the whole card a Link with `hover:border-slate-300 hover:bg-slate-50` and focus ring. Replaces dashboard registry tiles, identity count cards, and service-board `SummaryStat` — one component, three call sites.

### 2.6 SectionLabel — new
- Renders the canonical eyebrow (§1.3). Replaces all 18+ copy-pasted eyebrow strings; deletes the slate-400/500 split.

### 2.7 KeyValueList — new
```tsx
<KeyValueList items={[{label, value, tooltip?}]} columns={1|2} />
```
- `<dl>`: `dt` = SectionLabel, `dd` = body text (mono where the value is a URN/id). Replaces per-file dt/dd in outpost-detail, outposts, federation-status, and the registry-detail Properties card (§4E).

### 2.8 EmptyState — new
```tsx
<EmptyState icon message action? />
```
- Centered, `py-10`: lucide icon `size-5 text-slate-400` in a `size-10 rounded-full bg-slate-100 flex items-center justify-center` disc, message in body type, optional Button. Used everywhere zero-result copy appears (campaign-list, registry-list, board sub-lists).

### 2.9 Skeleton — new
- `<Skeleton className>` = `animate-pulse rounded-md bg-slate-200`; plus `SkeletonRows n` (table rows) and `SkeletonCard`. Replace every text-only "Loading…" app-wide. One line of layout-matching skeleton per surface; don't reproduce full layouts.

### 2.10 Focus ring standard
- Shared constant (in `lib/utils.ts`): `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2`. Applied to Button/Input/Select (restyle), `navLinkClass`, PageHeader back links, StatCard links, and every inline link component. No interactive element ships without it.

### 2.11 Notice — new (small)
- `<Notice tone="success"|"danger">` one-line mutation feedback (device.tsx approve flow, dialogs): `flex items-center gap-2 text-sm` with `Check`/`CircleAlert` icon, `text-emerald-700`/`text-red-700`. Query failures always use QueryErrorNotice, never Notice.

### 2.12 Button / Input / Select / Table / Dialog — restyles
- **Button** `default`: `bg-indigo-600 text-white hover:bg-indigo-500` (accent lands on every primary action: Sign in, New, Create Campaign, Accept). `outline`/`ghost`/`destructive` unchanged in structure, all get §2.10 ring. Optional leading icon at `size-4`. Replace the raw `<button>`s in graph-landing (dashboard-mock is deleted).
- **Input/Select**: `rounded-md border-slate-300 text-sm` + §2.10 ring. **Select chevron: replace the `▾` literal in `select.tsx:22` with `ChevronDown size-4 text-slate-500`** — one edit fixes every Select.
- **Table**: header row `bg-slate-50` with eyebrow-type `th` (`text-xs font-medium uppercase tracking-wide text-slate-500`), `divide-y divide-slate-200`, cell `py-2.5 px-3 text-sm`, row `hover:bg-slate-50`. Wrap in `overflow-x-auto rounded-lg border border-slate-200`.
- **Dialog**: panel `rounded-lg shadow-lg`, title = section-heading type, footer `flex justify-end gap-2 border-t border-slate-200 pt-4`. Complex forms group with `<fieldset>` + SectionLabel legends (the outpost-settings pattern is canonical).

### 2.13 Shared pipeline/decision module — `src/components/pipeline/` & `src/components/decision/`
- Extract from change-detail/campaign-detail into shared modules: `waveStatusTone()` (status→Badge tone), `waveStatusBorder()`, `decisionSummary()`, `<WhyLink/>`, `<ReasonDialog/>` (shell shared by transition-reason and rollback-campaign). Generalize `PipelineWaveCard` to accept either `ChangeWaveTarget` or `CampaignWaveTarget` (they mirror). `PromotionArrow` becomes the ONLY renderer of wave-to-wave connectors (a `state="pending"` plain style covers connectors with no gate verdict).

---

## 3. NAV / SHELL SPEC (AppShell.tsx)

Nav **structure, order, labels, and hrefs unchanged** (test-pinned owner decisions). Changes are purely presentational.

### 3.1 Icons per entry (exact lucide names, `size-4`, `text-slate-400`, active `text-indigo-600`)
| Entry | Icon |
|---|---|
| Dashboard | `LayoutDashboard` |
| Campaigns | `Flag` |
| Graph | `Waypoints` |
| Services | `Layers` |
| Assemblies | `Package` |
| Components | `Box` |
| Outposts | `RadioTower` |
| Federation status | `Globe` |
| Identity | `Users` |
| Plugins | `Puzzle` |
| Access Tokens | `KeyRound` |
| Dependencies (Admin › dependency producers; commander nav only) | `Package` |

Catalog entries come from `REGISTRIES`; add an `icon` field to the registry config so the allow-list mapping stays data-driven.

### 3.2 Link + section treatment
- `navLinkClass`: `flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900` + focus ring (§2.10).
- Active: `bg-indigo-50 font-medium text-indigo-700` plus icon `text-indigo-600` (replaces the faint gray tint — the accent's second sanctioned home).
- Section headings (`Catalog`, `Federation`, `Admin`): SectionLabel, `mt-5 mb-1 px-2`.
- **Sticky fix (high-severity visual bug):** `<aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white p-4">`. Verify on the tallest real pages (component journey, change detail with many decisions).

### 3.3 Brand mark + header bar
- Sidebar top: inline-SVG brand mark — a `size-7 rounded-md bg-indigo-600` tile containing `Waypoints` in white at `size-4` — beside the "CommanderSCP" wordmark (`text-lg font-semibold`). This same mark is reused on /login.
- Header bar: unchanged contents (`current-org` testid stays), restyled: org · username gets a leading `CircleUser size-4 text-slate-400`. The header remains the only home of account chrome — the dashboard's duplicate is deleted (§4A).

### 3.4 Login page
- Canvas `bg-slate-50`; card `max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm` with a `border-t-2 border-t-indigo-600` accent edge.
- Brand mark (from §3.3, at `size-10`) centered above the wordmark; one line of context under it: "Federated systems coordination." (caption type). Form fields unchanged; submit = Button default (indigo). Device flow link unchanged. No imagery, no split layout — restraint over decoration, keeps air-gap trivially satisfied.

---

## 4. PER-PAGE WORKLIST

### Group A — dashboard + activity
**Cleanup (do first):**
- Delete `routes/dashboard-mock.tsx` and `routes/nav-mock.tsx`, their imports, router defs (router.tsx ~62–75), and any nav link to them. Their decided-upon ideas are absorbed below; nothing else from them survives.

**dashboard.tsx:**
- Remove the org-name/"Signed in as" block (header bar owns it).
- Replace the 9-tile REGISTRIES link grid with: (1) a "Services" section — real service rows from the existing services registry-list SDK call, each row: `Layers` icon, name, `ArrowRight`, linking to `/services/$id` (the board is the service homepage); (2) below it, a compact StatCard row for catalog registries **with object counts** (counts via the same list SDK calls identity.tsx already uses). No count fetched = show the tile without a number, not "0".
- Keep Live activity, demoted to the bottom, restyled as a timeline: icon disc per event kind (`Check`/`CircleAlert`/`ArrowRight` per §1.6), caption-type timestamps, `divide-y`.
- Full "Needs you" dashboard remains blocked on the future board aggregate endpoint — out of scope; leave a code comment pointing at `docs/proposals/homepage-dashboard.md`.

### Group B — service board / detail / infrastructure + assembly
**service-board.tsx:**
- Drop the "Version / Health" column entirely (always `—`; the honesty fact moves to one tooltip on the Components card title). Frees a 7th column.
- Replace both bottom honesty paragraphs with Badge `unknown` pills + `Info` icon: "Change visibility limited" / "Freeze visibility limited"; full existing sentences move into `title=""`. **Keep `data-testid="board-change-visibility-unknown"` / `"board-freeze-visibility-unknown"` on the pills.**
- Delete the three-sentence footer paragraph (lines 678–684); its facts live in the column tooltip and per-row markers.
- Drop "· Layer A (real data only)" from the subtitle.
- BoardSummary scope-note: compose one string — "2 more in assemblies below (directly-held components only)" — preserving pinned substrings "directly-held components only" and "2 more in" verbatim inside it; keep amber classes.
- SummaryStat → StatCard.
- BoardAssemblies → same Table treatment as the Components table below it (Name | Components | link), `size="compact"` rows.
- "Open pipeline →" / "Service detail →" → `Button variant="outline" size="sm"` with `ArrowRight size-4` (all `→` literals die).
- PIPELINES column: "not bound"/"never run" chips become plain `text-xs text-slate-400` text (expected, recede); only actionable states get Badge tones. Emergency stays `danger`.

**service-infrastructure.tsx:**
- Migrate to PageHeader (fixes the `text-xl` title drift).
- Empty state → one line: "Nothing bound at the service — every pipeline here is declared per component." Explanatory paragraph moves to `title=""` on an `Info` icon beside the tab header.
- `↗` → `ExternalLink` per §1.6.

**assembly-detail.tsx:**
- PageHeader with `backTo`. Page gets `max-w-5xl`.
- Add a StatCard row above the table: component count (+ anything already in the payload — no new endpoints).
- Component/URN table → restyled Table; "Pipeline →" links → outline Buttons with `ArrowRight`.

### Group C — component pipeline / detail + change detail / pipeline
**component-pipeline.tsx:**
- PageHeader (fixes title drift). The inherited-topology prose (1049–1075) compresses into PageHeader `meta`: `Badge neutral "Topology: agentkit-bootstrap"` · "inherited from service" · "reaches 3/4 stages" — full sentence into `title=""`.
- Replace NODE_ICON/PipelineIcon inline SVGs with lucide (`GitBranch`, `Wrench`, `Package`, `Server` as kinds map); delete the local SVG set.
- CheckMark unicode (✓ ✗ ! ◐ ○) → `Check` / `X` / `CircleAlert` / `CircleDashed` / `Circle` with the same state colors.
- GateSubnode: policies/approvals/checks re-render as a 2-column mini KeyValueList (requirement | verdict-with-icon), `text-xs`, replacing the ` · `/`; `-joined prose block.
- ConsoleLink `↗` → shared `ExternalLink` treatment. All `→` literals → `ArrowRight`.

**change-detail.tsx:**
- Compact header rail via PageHeader: state Badge, source kind, correlation key (mono), emergency Badge `danger`, actions (Accept/Rollback) in the `actions` slot.
- Body order: Wave progression, then Decisions (the explainability core gets a `size="default"` Card directly after the waves), then Approvals/Control runs as `compact` cards.
- Replace WaveCard with the generalized `PipelineWaveCard` (§2.13) — the detail tab must never show less than the pipeline tab.
- Wave connectors: `PromotionArrow`, never `text-xl text-slate-300 →`.
- **Resolve wave-target UUIDs to component/service display names, hyperlinked to `/components/$id`** (data already fetched elsewhere on the page; census all target-id render sites, not just this one).
- "Waiting on N prerequisite(s)" → real pluralization. "Full change detail →" / "Pipeline view →" cross-tab links → outline Buttons with `ArrowRight`.

**change-pipeline.tsx:**
- Drop "· Layer A (real data only)" subtitle.
- Empty-plan message → "No plan compiled yet."
- Cross-nav links → outline Buttons.

### Group D — graph pages + campaigns
**graph-landing.tsx / graph-explorer.tsx / component-graph.tsx:**
- **Auto-fit on load**: compute node bounding box, scale/center to container; add zoom in/out/fit controls (Buttons `ghost size-sm` with `ZoomIn`/`ZoomOut`/`Maximize` icons, top-right of canvas). Applies to both service and component graphs.
- Swap hand-rolled red `<p>` errors for QueryErrorNotice (unpinned — verified).
- `← Service graph` → PageHeader `backTo`.
- graph-landing raw `<button>`s → Button.
- GraphLegend clip-path swatches: replace star/hexagon/pentagon with lucide `Star`/`Hexagon`/`Pentagon` at `size-3`; keep circles/squares as divs.

**campaign-list.tsx:**
- PageHeader; "No campaigns yet." → EmptyState (`Flag` icon, action = New Campaign button).
- Create dialog: Targets → `<textarea>`, one id/URN per line, inline per-line validation styling (`text-red-600 text-xs` under the field); Topology likewise. Fieldset grouping per §2.12. (Token/multi-select picker is a follow-up, not this pass.)

**campaign-detail.tsx:**
- Adopt shared module (§2.13): generalized PipelineWaveCard (campaigns get version/executor/rollout detail parity), PromotionArrow connectors, shared WhyLink/decisionSummary/ReasonDialog.
- **Resolve Wave-board target UUIDs to names + links** (same class as change-detail — 2nd census hit).
- "View Change →" → outline Button with `ArrowRight`. Header rail treatment as change-detail.

### Group E — registries / identity / plugins / pats / outposts / federation / login / device
**registry-list.tsx:**
- "Updated" column: plain caption-type text, no Badge (dates are not statuses).
- QueryErrorNotice for errors; "Unknown registry" → `Alert tone="danger"`; "No {registry} yet." → EmptyState with the registry's nav icon.

**registry-detail.tsx:**
- Properties: KeyValueList with type-aware formatting (booleans/numbers plain, nested objects collapsed with a "view raw" toggle exposing the current `<pre>`). No default JSON dump.
- **Owners / Consumes / Depends-on: resolve each related id to object name + type Badge, linked to its detail page** (existing list/get SDK calls; the main table already proves the pattern). Raw UUID only as mono fallback while unresolved.
- Empty copy: "No properties set." / "No labels set." / "No owners." / "No consumed components." / "No dependencies." ("Nothing." dies.)
- Delete the "Decision links… (M4)" footer entirely.
- Detach button gets `Unlink size-4`; not-found → `Alert tone="danger"`.

**identity.tsx:** count cards → StatCard (shared with dashboard); under each, a compact preview list of the first 5 names (existing list SDK calls) with "View all →" as ghost Button. Page `max-w-5xl`.

**plugins.tsx:**
- Intro → "Configure an executor or notification binding, or run a discovery scan, from each plugin's declared settings." (DESIGN §11 citation deleted.)
- Kind badges: executor `info`, discovery `neutral` with `Search` icon, notification `warning` with `Bell` icon — three distinguishable at a glance.
- ConfigureDialog: three fieldsets — "Binding", "Configuration", "Egress & delivery" (§2.12).
- Discovery proposal: summarized table (action | type | name/urn) with counts headline; raw JSON behind a "View raw" toggle.

**pats.tsx:** h1 → "Access tokens" (nav label "Access Tokens" is pinned and unchanged; page echoes it in sentence case per copy rule 7). PageHeader, Table restyle, Skeletons.

**federation-status.tsx:**
- h1 → "Federation status" (matches the nav label clicked).
- Intro → "Snapshot as of this domain's last sync — not a live probe." with full rationale (DESIGN §13 citation removed) in `title=""` on an `Info` icon.
- dt/dd → KeyValueList; introduce `<ObservationScopeNote/>` — one canonical sentence ("This side's own record — nothing here observes the peer.") rendered as caption + `Info` tooltip — replacing the three drifted paragraph variants here, outposts.tsx, and outpost-detail.tsx.

**outposts.tsx:**
- Table hierarchy: new leading attention column — `size-2 rounded-full` dot: `bg-red-500` (danger), `bg-amber-400` (unknown-needing-attention), `bg-slate-300` (nominal) — derived from existing signals only.
- Structurally-expected empties (fresh outpost: Transport/Exported/Applied/Health/Transfers before first sync) → `—` `text-slate-400` + `title=""` honesty sentence. Badge `unknown` only where attention is meaningful. This collapses the ~15-amber-pill wall to signal only.
- Column grouping: identity (Outpost/Role/Trust tier) visually separated from sync columns via a slightly darker group border; eyebrow-type headers per Table restyle.
- ObservationScopeNote replaces the intro paragraph.

**outpost-detail.tsx / outpost-configuration.tsx / outpost-settings.tsx:**
- `← Outposts` → PageHeader `backTo`.
- All hand-rolled callouts → Alert (§2.3).
- Poke-mode paragraph (`poke-mode-both-sides-note` testid) → caption "This side's half only — the outpost must opt in too." + full 3-sentence text in `title=""`; **testid stays on the caption element**.
- Strip milestone/ADR codes from visible copy: "(M16.4)" tooltip → "A return-path confirmation isn't implemented yet."; "(M15, ADR-0010)" → "Created or imported at the outpost — the commander has no writable model for it, so it's configured there."
- dt/dd → KeyValueList; eyebrows → SectionLabel.

**login.tsx:** per §3.4.

**device.tsx:** approve success/error paragraphs → `Notice` (§2.11); page inherits login's card treatment.

---

## 5. COPY RULES (every page, every PR)

1. **Fragments in chrome, sentences in tooltips.** Subtitles, captions, empty states, and scope notes are one fragment (≤ ~8 words). The full-sentence rationale — when it must exist — lives in a `title=""` tooltip on the fragment or an `Info` icon. Test-pinned sentences may make this move (explicitly allowed).
2. **No internal vocabulary in rendered copy.** No milestone codes (M4, M15, M16.4), no ADR/DESIGN citations, no "Layer A"/"real data only". Those belong in code comments beside the copy they used to be.
3. **Say a fact once per page.** A caveat carried by a per-row marker or column tooltip is never also a standing paragraph. When compressing, the tooltip is the surviving home.
4. **Honesty compresses, it never disappears.** Unknown/unobservable keeps a visible, distinct marker (Badge `unknown` or `—`+tooltip per §1.5); the words may shorten, the signal may not, and expected-absence must not borrow attention colors.
5. **Empty states follow "No ⟨noun⟩ yet."** — specific noun, no vagueness ("Nothing." is banned), optional action button via EmptyState.
6. **Real pluralization, always.** `${n} prerequisite${n === 1 ? "" : "s"}` — the "(s)" construction is banned.
7. **A page h1 echoes the nav label that reached it** (sentence case; nav labels themselves are pinned and never change): "Federation status", "Access tokens".
8. **The code trio is `application` / `configuration` / `infrastructure`** (owner ruling 2026-08-11, aligning UI copy with ADR-0007's Category facet `build|infrastructure|configuration`): application source code builds artifacts (`image/rpm/deb/npm`); configuration-as-code (helm values, k8s manifests — Argo CD is this) is NEVER called "software"; infrastructure-as-code stands up substrate. The per-component journey that carries BOTH application and configuration pipelines is labelled **Delivery** (its old "Software" label committed exactly this category error). Machine ids (`lane key "software"`, `component-tab-software`) keep their historical names.
9. **Sentence case everywhere** except the pinned nav labels and eyebrow labels (which are styled uppercase by CSS, authored in sentence case).