# Guide: organizing waves

How to shape a pipeline's rollout — which stages ship together, in what order — using the
`@scp/iac` wave helpers (design: [`docs/proposals/team-pipeline-iac.md`](../proposals/team-pipeline-iac.md)
§8, D6/D8/D21). This guide is for whoever is writing a component's `scp/stack.ts`, not for reading
the design rationale.

## The one boundary that matters most

**A wave orders stages. It does not orchestrate traffic.** `waves.*` decides *which stages release
in which order, and how many at once* — it never decides what percentage of traffic a target gets
mid-rollout. That is the rollout executor's job (Argo Rollouts, [ADR-0008](../adr/0008-observe-enrichment-signals.md)):
declare it with `CanaryRollout`/`RollingRollout` on the pipeline itself, scoped to a `TargetClass`.
Reach for a wave when the question is "which stages, in what sequence"; reach for a rollout
declaration when the question is "how a single target absorbs traffic while it deploys". Mixing
the two up produces a wave list with a `weightPercent`-shaped hole in it, or a rollout declaration
trying to name a whole fleet of stages — neither compiles, and neither is what either mechanism is
for.

## Vocabulary

Every stage name in this guide (and every scaffolder/template default) uses `staging` and
`production` — never `gamma`, never bare `prod` (D6/D21e). `dev` exists as an environment, but it
normally belongs to a domain-local dev pipeline
([ADR-0030](../adr/0030-dev-branch-pipelines.md)), not the global promotion path these helpers
shape. Stage names otherwise follow the GLOSSARY grammar: `<domain>[-<location>]-<env>`
(`commercial-amer-production`, `airgap-amer-production`).

## What a pipeline's `waves` prop actually takes

A pipeline's `waves:` prop is an array of **wave items**, in the relaxed shape every helper below
produces (`@scp/iac`'s `WaveItem`):

- a bare target — a single-member wave (`"commercial-amer-production"`, or a construct/reference);
- a bare array of targets — one unnamed PARALLEL wave (`[a, b, c]`);
- an object — full control: `{ name?, targets, mode?: "parallel" | "sequential", requiresFanIn? }`.

Synth normalizes every item into the manifest's `release-topology` document. An item with no
`name` gets one automatically — `wave1`, `wave2`, … **by position**, regardless of which earlier
items were named — so `[{ name: "staging", targets: [...] }, prodAmer, [a, b]]` names its third
item `wave3`. `mode` defaults to `"parallel"` unless you say otherwise. This is exactly what lands
in the committed `scp/manifest.json` — the wave shape you write is the wave shape a reviewer reads,
byte for byte (D2/D8: inference is synth-time, the manifest is always explicit).

**Placements are inferred from the stages your waves name (D8).** You never call
`component.placeAt(stage)` for every stage in a normal pipeline — every stage a wave targets
becomes a placement automatically, visible as an explicit entry in the synthesized manifest and as
an ordinary plan line. Remove a stage from the waves and its placement disappears the same way —
as a visible `delete` line in the next plan, never silently. An explicit `component.placeAt(...)`
declaration for the same pair always wins over the inferred one; it is never duplicated.

## The three helpers

```ts
import { waves } from "@scp/iac";
```

### `waves.linear(stages)` — a straight sequence

The simplest shape: each element is one step, released in order. An element may itself be a group
(an array) when one step legitimately fans out to several targets at once — `linear` does not
reorder or merge, it is a typed pass-through so the call site reads "this is the ordered stage
list" instead of an unlabeled array literal.

```ts
waves.linear([
  "commercial-amer-staging",
  "commercial-amer-production",
]);
```

### `waves.widening(targets, { start, factor })` — geometric fan-out

The canonical production shape (D21): **1 → 2 → 4 → 8**. Give it a flat target list and a starting
size/multiplier; it buckets the list into waves whose size grows geometrically. The final wave
holds whatever remains, even short of the "ideal" size — that is not padded or refused, because
shipping the stragglers sooner is the entire point of the tail wave.

```ts
waves.widening(
  [
    "commercial-amer-production",
    "commercial-emea-production",
    "govcloud-amer-production",
    "commercial-apac-production",
    "govcloud-emea-production",
    "airgap-amer-production",
    "commercial-mide-production",
  ],
  { start: 1, factor: 2 },
);
// → [1 target] , [2 targets] , [4 targets] , (nothing left for a 5th wave of 8)
```

### `waves.byDomain(...groups)` — security-domain ordering

One wave per security-domain group, **in the order you give them** — `commercial` before
`govcloud` before the air gap, matching the CDS crossing gate (D22): a target in a later domain
never widens ahead of a crossing an earlier domain hasn't cleared yet.

```ts
waves.byDomain(
  ["commercial-amer-production", "commercial-emea-production"],
  ["govcloud-amer-production"],
  ["airgap-amer-production"],
);
```

## The three worked patterns end to end

**Pattern 1 — staging then a single production stage.** The smallest legal shape for a component
that has exactly one production target:

```ts
new ImagePipeline("payments-worker", {
  service: Service.fromName("payments"),
  repo: repos("payments/payments-worker"),
  waves: waves.linear([
    "commercial-amer-staging",
    "commercial-amer-production",
  ]),
});
```

**Pattern 2 — staging across every domain at once, production widening out.** D21's canonical
journey: staging spans every security domain *before any production wave*, so a cross-domain
failure surfaces at staging, never as a production surprise; production then widens 1 → 2 → 4.

```ts
new ImagePipeline(api, {
  repo: repos("payments/payments-api"),
  waves: [
    {
      name: "staging",
      targets: [
        "commercial-amer-staging",
        "govcloud-amer-staging",
        "airgap-amer-staging",
      ],
    },
    ...waves.widening(
      [
        "commercial-amer-production",
        "commercial-emea-production",
        "govcloud-amer-production",
        "commercial-apac-production",
        "govcloud-emea-production",
        "airgap-amer-production",
      ],
      { start: 1, factor: 2 },
    ),
  ],
});
```

**Pattern 3 — domain-ordered rollout.** When an estate wants a deliberate domain sequence rather
than a single mixed-domain widening — for example, a commercial-only bake before anything crosses
into a regulated domain:

```ts
new ImagePipeline(api, {
  repo: repos("payments/payments-api"),
  waves: [
    { name: "staging", targets: ["commercial-amer-staging"] },
    ...waves.byDomain(
      ["commercial-amer-production", "commercial-emea-production"],
      ["govcloud-amer-production"],
      ["airgap-amer-production"],
    ),
  ],
});
```

All three patterns compile to the same thing: an ordinary `release-topology` document, a
`releases_via` attachment, and — because every target named above is a stage — a fully explicit,
plan-reviewable set of inferred placements. Nothing here is a new mechanism; it is the same
wave/placement machinery every pipeline already uses, shaped by these three helpers instead of a
hand-rolled array.

## Sharing a wave shape without sharing an attachment

Reusing a wave *shape* across components is plain TypeScript value reuse and still yields
per-component pipelines — export the array (or a function returning one) from your org's standards
package and call it from each component:

```ts
// @corp/scp-standards
export const standardWaves = waves.linear([
  "commercial-amer-staging",
  "commercial-amer-production",
]);
```

```ts
// payments-api/scp/stack.ts
import { standardWaves } from "@corp/scp-standards";
new ImagePipeline("payments-api", { service: Service.fromName("payments"), repo: repos("payments/payments-api"), waves: standardWaves });
```

Sharing the *attachment* itself — one topology object serving several components — is a different,
deliberate act: scope the same pipeline class to a `Service` instead of a `Component` (D8's shared-
rung exception), documented in `team-pipeline-iac.md` D8 and D17. Reach for that only when the
release cadence is genuinely shared, not merely similarly shaped.
