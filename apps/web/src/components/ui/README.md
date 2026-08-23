# `src/components/ui/` — primitive API reference

Foundation for the UI overhaul (design spec §2). Page code composes ONLY these primitives — no
hand-rolled pills, callouts, eyebrows, dt/dd lists, empty states, or `▾`/`→`/`←`/`↗` literals.
All icons come from `lucide-react`, imported individually. Section references (§) cite the design
spec.

## Typography scale (§1.3 — no other title/heading classes permitted)

| Role                                    | Classes                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| Page title (h1, only inside PageHeader) | `text-2xl font-semibold tracking-tight text-slate-900`                                        |
| Page description                        | `text-sm text-slate-500`                                                                      |
| Section heading (CardTitle, h2)         | `text-sm font-semibold text-slate-900`                                                        |
| Eyebrow / section label (SectionLabel)  | `text-xs font-medium uppercase tracking-wide text-slate-500` (slate-500, **never** slate-400) |
| Body                                    | `text-sm text-slate-700`                                                                      |
| Emphasis value (stat numbers)           | `text-2xl font-semibold tabular-nums text-slate-900`                                          |
| Caption / meta / timestamps             | `text-xs text-slate-500`                                                                      |
| Mono (URNs, ids, versions)              | `font-mono text-xs text-slate-600`                                                            |

## Status tones (§1.5 — used by Badge, Alert, StatCard badges, table state cells)

| Tone      | Classes (Badge)                                             | Meaning                                                            |
| --------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `neutral` | `bg-slate-100 text-slate-700 border-transparent`            | inert/categorical (roles, kinds — never dates)                     |
| `info`    | `bg-blue-50 text-blue-700 border-blue-200`                  | in progress, validating                                            |
| `success` | `bg-emerald-50 text-emerald-700 border-emerald-200`         | succeeded, healthy, applied                                        |
| `warning` | `bg-amber-50 text-amber-800 border-amber-200`               | needs attention, degraded, frozen                                  |
| `danger`  | `bg-red-50 text-red-700 border-red-200`                     | failed, blocked, emergency                                         |
| `unknown` | `bg-amber-50 text-amber-700 border-amber-300 border-dashed` | unobservable where an operator should notice (test-pinned classes) |

Structurally-expected absence is NOT a badge: render `—` in `text-slate-400` with a `title=""`
tooltip carrying the honesty sentence. The accent (army olive, `army-*` scale) is never a status color.

## Icon vocabulary (§1.6 — canonical, no substitutes)

- Sizes: `size-4` beside `text-sm`; `size-3.5` in badges/captions/cells; `size-5` in EmptyState;
  nav is `size-4` (§3.1). `strokeWidth={2}` at ≤16px, `1.75` at 20px+.
- Every icon `aria-hidden="true"` unless it is a control's sole content (then the control gets
  `aria-label`).
- forward/drill-in `ArrowRight` · back `ArrowLeft` · external link `ExternalLink` (`size-3.5`,
  `gap-1`, always after the text) · pass `Check` · fail `X` · pending `Circle` · partial
  `CircleDashed` · warning `TriangleAlert` · error/blocked `CircleAlert` · unknown `CircleHelp` ·
  info affordance `Info` · select chevron `ChevronDown`.

## Shared constants

- `focusRing` (from `src/lib/utils.ts`, §2.10): apply to EVERY interactive element you render
  yourself (inline links, custom buttons). All primitives below already carry it.
- Registry nav icons live on `REGISTRIES[n].icon` (`src/lib/registries.ts`) — use them for
  registry empty states; never hand-pick a second icon for a registry.
- Brand mark: `import { BrandMark } from "../components/layout/BrandMark"` — `size="sm"`
  (sidebar) | `"lg"` (login, §3.4).

---

## Badge — `badge.tsx`

Props: `variant` (tone: `neutral|info|success|warning|danger|unknown`; deprecated aliases
`default|secondary→neutral`, `destructive→danger`, `outline→neutral`, `info`, `success`),
`size` (`sm` only, default), `icon?: LucideIcon` (leading, `size-3.5`), plus div props.
`unknown` is the ONLY sanctioned honesty pill. Idiom: an empty server-enriched name renders the id
plus this badge reading "unnamed" (design-system.md §6.4) — never a bare id with no signal, and
never silently in one cell of a row while a sibling cell in the same row stays silent.

```tsx
<Badge
  variant="unknown"
  icon={Info}
  data-testid="board-change-visibility-unknown"
  title="Full sentence lives here."
>
  Change visibility limited
</Badge>
```

## Button — `button.tsx`

Props: `variant` (`default` army-olive primary | `outline` | `ghost` | `destructive` | `link`),
`size` (`default|sm|lg|icon`), `icon?: LucideIcon` (leading, `size-4`), plus button props.

```tsx
<Button variant="outline" size="sm" icon={ArrowRight}>
  Open pipeline
</Button>
```

## Input — `input.tsx` / Select — `select.tsx`

Unchanged APIs (Input = input props; Select = Radix compound: `Select`, `SelectTrigger`,
`SelectValue`, `SelectContent`, `SelectItem`, `SelectGroup`). Chevron is built in (`ChevronDown`)
— never add one.

```tsx
<Select value={v} onValueChange={setV}>
  <SelectTrigger>
    <SelectValue placeholder="Pick one" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="a">A</SelectItem>
  </SelectContent>
</Select>
```

## Card — `card.tsx`

`Card` takes `size?: "default" | "compact" | "flush"` — the ONLY density control (§2.4); never
override CardContent padding. Compound: `CardHeader`, `CardTitle` (section-heading type),
`CardDescription`, `CardContent`, `CardFooter` — padding follows the Card's size automatically.

```tsx
<Card size="compact">
  <CardHeader>
    <CardTitle>Components</CardTitle>
  </CardHeader>
  <CardContent>…</CardContent>
</Card>
```

## PageHeader — `page-header.tsx`

Props: `title` (the page's ONLY h1), `description?`, `actions?` (right slot), `backTo?` (route
path) + `backParams?` + `backLabel?` (replaces every `← X` literal), `meta?` (Badge/fragment row).

```tsx
<PageHeader
  title="Outpost"
  description="Snapshot as of this domain's last sync."
  backTo="/federation/outposts"
  backLabel="Outposts"
  actions={<Button>New</Button>}
  meta={<Badge variant="neutral">Topology: agentkit-bootstrap</Badge>}
/>
```

## Alert — `alert.tsx`

Props: `tone` (`info|warning|danger|neutral`), `title?` (ReactNode bold first line), `icon?`
(`LucideIcon | null` to override/suppress the tone default: `Info`/`TriangleAlert`/`CircleAlert`/
none), children, plus div props (`role`, `data-testid` pass through). Query failures use
`QueryErrorNotice` (which renders through Alert), not a bare Alert.

```tsx
<Alert tone="warning" title="Frozen">
  Deploys to this stage are paused.
</Alert>
```

## StatCard — `stat-card.tsx`

Props: `label` (eyebrow), `value?` (omit when unknown — never show a fabricated "0"), `icon?`
(top-right `size-5`), `to?` + `params?` (makes the whole card a focus-ringed Link), `badge?`,
`hint?` (caption), `className?`, `data-testid?`.

```tsx
<StatCard
  label="Services"
  value={services?.items.length}
  icon={Layers}
  to="/$basePath"
  params={{ basePath: "services" }}
/>
```

## SectionLabel — `section-label.tsx`

Props: `as?: "div"|"span"|"dt"|"h2"|"h3"` (default `div`), plus element props. The canonical
eyebrow — author in sentence case (CSS uppercases, copy rule 8).

```tsx
<SectionLabel as="h2">Sync status</SectionLabel>
```

## KeyValueList — `key-value-list.tsx`

Props: `items: { label, value, tooltip?, mono? }[]`, `columns?: 1|2` (2 collapses to 1 below
`sm:`), `className?`. `tooltip` is the `title=""` home for full honesty sentences; `mono` for
URNs/ids.

```tsx
<KeyValueList
  columns={2}
  items={[
    { label: "URN", value: outpost.urn, mono: true },
    {
      label: "Applied",
      value: "—",
      tooltip: "No sync has completed yet, so nothing has been applied."
    }
  ]}
/>
```

## EmptyState — `empty-state.tsx`

Props: `icon: LucideIcon`, `message` ("No ⟨noun⟩ yet." — copy rule 5), `action?` (Button),
`className?`, `data-testid?`.

```tsx
<EmptyState icon={Flag} message="No campaigns yet." action={<Button>New Campaign</Button>} />
```

## Skeleton — `skeleton.tsx`

`<Skeleton className="h-8 w-full" />` (shape via className), `<SkeletonRows n={5} />` (table),
`<SkeletonCard />` (stat/card). Replaces every text-only "Loading…". One layout-matching line per
surface — don't reproduce full layouts.

## Notice — `notice.tsx`

Props: `tone: "success"|"danger"`, children, plus `<p>` props. One-line MUTATION feedback only
(approve flows, dialog submits) — failed reads always use `QueryErrorNotice`.

```tsx
<Notice tone="success" data-testid="device-approved">
  Device approved.
</Notice>
```

## Dialog — `dialog.tsx`

Radix compound, unchanged API: `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`,
`DialogTitle` (section-heading type), `DialogDescription`, `DialogFooter` (right-aligned, top
rule), `DialogClose`. Complex forms group fields with `<fieldset>` + a `SectionLabel` legend
(§2.12).

## Table — `table.tsx`

Compound, unchanged API: `Table` (self-wraps in `overflow-x-auto rounded-lg border`), `TableHeader`
(`bg-slate-50` band), `TableBody` (divided rows), `TableRow` (hover), `TableHead` (eyebrow type),
`TableCell`. Don't add your own border/rounded wrapper around `Table`.

```tsx
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>gateway</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

---

## Copy rules digest (spec §5 — every string you touch)

Fragments in chrome, sentences in `title=""` tooltips · no milestone/ADR codes or "Layer A" in
rendered copy (move to code comments) · say a fact once per page · honesty compresses but never
disappears · "No ⟨noun⟩ yet." empty states · real pluralization (`${n} wave${n === 1 ? "" : "s"}`)
· h1 echoes the nav label in sentence case · sentence case everywhere except pinned nav labels.

## Federation role marks (`src/components/icons/federation-roles.tsx`)

Custom lucide-compatible icons (createLucideIcon — same props as any lucide glyph):
`CommanderStar` (general's star over a bar) · `OutpostFort` (crenellated tower) · `RetransMast`
(mast with receive/resend arcs). Render roles ONLY through `roleBadge` (routes/outposts.tsx),
which owns the role→mark mapping; `unset` has no mark by design.

## Catalog marks (`src/components/icons/catalog-marks.tsx`)

`ServiceGuidon` (unit standard) · `AssemblyStack` (crate stack) · `ComponentCrate` (ammo crate).
Registry config (`lib/registries.ts`) wires them into the nav and StatCards; `lib/graph-glyphs.ts`
rasterizes the SAME path data into white canvas glyphs for graph nodes — never redraw a mark, and
never import Layers/Package/Box for these three concepts again.
