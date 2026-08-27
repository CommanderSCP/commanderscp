# Team-pipeline IaC — worked example across a full estate

**Status:** Draft companion to [team-pipeline-iac.md](team-pipeline-iac.md), 2026-08-26. Construct shapes marked **(new)** are proposed by that doc; everything else exists in `@scp/iac` today. Property shapes on new constructs are indicative, not final.

The estate: a **commander** (with its **XO** — the designated standby member cluster, ADR-0044), the **HQ outpost** (the outpost in the commander's own trust domain), a **retrans** at the CDS boundary, one **govcloud outpost**, and one **air-gapped outpost**.

```
             commander (+ XO member cluster)          ── commercial trust domain
                │        │
        hq outpost    govcloud outpost                ── mTLS journal pull
                          │
                       retrans ══ CDS ══▶ airgap outpost   ── signed .scpbundle files
```

Stage names follow the GLOSSARY grammar `<domain>[-<location>]-<env>` with hyphen-free segments — hence `airgap-amer-production` (domain `airgap`, location `amer`, env `production`). Per D6/D21, examples spell out `staging` and `production` (never `gamma`, never bare `prod`); `dev` lives in domain-local dev pipelines (ADR-0030) and does not appear in the global promotion path.

## 1. What is deliberately NOT in IaC

Transport identity, keys, credentials, and the XO designation are operator ceremonies. Peer rows are local, per-side, and never journaled (ADR-0022); execution-system creation holds credentials; the XO is a member-cluster designation, not an object (ADR-0044).

```console
# one-time estate ceremonies — never expressed in a manifest
$ scp federation pair --peer govcloud …                # mTLS identity + key exchange
$ scp federation pair --peer retrans-1 …
$ scp federation pair --peer airgap --bundle …        # pairing bundle rides sneakernet
$ scp federation peer update commander \
    --dial-urls 'https://scp.corp.example,https://scp-dr.corp.example#xo'
                                                       # ordered dial list; the #xo-labeled
                                                       # entry is the DR fallback (ADR-0044 D3)
$ scp connect argocd --name argocd-hq …                # per-domain, credential-holding
$ scp connect argo-workflows --name workflows-hq …     # the test/build runner (D11)
$ scp config-source register --repo-pattern 'git.corp.example/payments/*' \
    --team team-payments --path 'scp/manifest.json'   # ONE registration covers the team's
                                                       # whole fleet of component repos (D9)
$ scp config-source register --repo git.corp.example/platform/scp-platform \
    --team team-platform --path '**/*.manifest.json'  # the central platform repo
```

Nothing is ever declared *for* the XO: it serves the same instance and database, so every applied manifest is already "on" it. Its entire IaC footprint is the `#xo` dial label above.

## 2. The repos (D9: declarations live with the component)

```
git.corp.example/
  platform/scp-platform/            # central: the estate (§3) + per-domain HOW (§4)
    platform/estate.ts + estate.manifest.json
    domains/{hq,govcloud,airgap}/bindings.ts
  platform/scp-standards/           # central: importable standards (D10), published to
    src/index.ts                    #   the org registry as @corp/scp-standards
  payments/payments-team/           # thin team home: the service object, shared exceptions
    scp/stack.ts + scp/manifest.json
  payments/payments-api/            # the component's own repo (D9)
    src/…                           #   the component's actual code
    scp/stack.ts                    #   its SCP declaration
    scp/manifest.json               #   committed synth output (D2) — what SCP reads
  payments/payments-worker/         # same shape
```

The component's declaration rides the same repo that already drives its releases — one push webhook feeds both config sync (when `scp/manifest.json` changed) and release correlation (everything else). Domain HOW slices are applied by each domain's operators locally (CLI-push, D7 — for airgap, from the same media run as the regular bundle delivery).

## 3. `platform/estate.ts` — the operator stack (applies at the commander, federates)

```ts
import { Stack, Team, DeploymentTarget, TrustTier, Registry } from "@scp/iac";
import { Outpost } from "@scp/iac"; // (new) one-liner registry construct over the
                                    // `outpost` object type (migration 0043)

const estate = new Stack("platform-estate"); // App is synth plumbing — gone from user code (D15)

// -- teams ------------------------------------------------------------------
const platformTeam = new Team(estate, "team-platform", {});
const paymentsTeam = new Team(estate, "team-payments", {});

// -- outposts: commander-declared config only (ADR-0022 authority split) ----
// trustTier etc. — transport/keys stay in §1's ceremonies.
new Outpost(estate, "hq", { trustTier: TrustTier.commercial });
new Outpost(estate, "govcloud", { trustTier: TrustTier.govcloud });
new Outpost(estate, "airgap", { trustTier: TrustTier.il5 });

// -- the unified registry (ADR-0012): where build pipelines publish ----------
new Registry(estate, "org-registry", { url: "https://git.corp.example" }); // Gitea

// -- stages: deployment-targets, GLOSSARY grammar, D6 vocabulary ------------
const stage = (id: string, environment: string, region?: string) =>
  new DeploymentTarget(estate, id, { properties: { environment, region } });

stage("commercial-amer-staging", "staging", "amer");
stage("govcloud-amer-staging", "staging", "amer");
stage("airgap-amer-staging", "staging", "amer");
stage("commercial-amer-production", "production", "amer");
stage("commercial-emea-production", "production", "emea");
stage("commercial-apac-production", "production", "apac");
stage("commercial-mide-production", "production", "mide");
stage("govcloud-amer-production", "production", "amer");
stage("govcloud-emea-production", "production", "emea");
stage("airgap-amer-production", "production", "amer");
```

## 4. `domains/govcloud/bindings.ts` — one domain's HOW (domain-local, D4)

```ts
import { Stack, ExecutorType } from "@scp/iac";
import { BindingPolicy, DeploymentTarget, ExecutionSystem } from "@scp/iac";
// BindingPolicy (new): the D4 policy effect. fromName()/fromUrn() (new, CDK's
// fromXxx idiom): reference an existing object without managing it — returns the
// same interface type an owned construct implements; never creates or prunes.

const bindings = new Stack("govcloud-bindings", { domainLocal: true });
// domainLocal (new): everything in this stack is born domain-local (ADR-0031) —
// it never journals, never leaves this domain.

new BindingPolicy(bindings, "production-configuration", {
  scope: DeploymentTarget.fromName("govcloud-amer-production"),
  type: ExecutorType.configuration,
  executionSystem: ExecutionSystem.fromName("argocd-govcloud"),
});
```

`domains/hq/bindings.ts` and `domains/airgap/bindings.ts` are the same five lines pointing at `argocd-hq` / `argocd-airgap`. This is the whole per-domain cost of joining every team's pipeline: the domain reconciler joins these policies against federated placements and materializes the `executor_bindings` itself. A placement no policy matches is **loud** (unbound status), never a silent fake-success.

## 5. The component's own repo — the headline surface (D9/D10/D15)

The platform team publishes standards once, as a versioned package on the org's own registry:

```ts
// platform/scp-standards → @corp/scp-standards (Gitea npm — air-gap-clean)
export const waves = {
  standard: [
    // staging deploys to EVERY security domain first (D21) — the CDS crossings
    // (scan+sign at the commander, retrans into the air gap) happen here, not
    // as a production surprise. Gate applies per crossing, not per wave.
    { name: "staging",
      targets: ["commercial-amer-staging", "govcloud-amer-staging", "airgap-amer-staging"] },
    // production widens out: 1 → 2 → 4 stages
    "commercial-amer-production",
    ["commercial-emea-production", "govcloud-amer-production"],
    ["commercial-apac-production", "govcloud-emea-production",
     "airgap-amer-production", "commercial-mide-production"],
  ],
};
```

The team's thin home (`payments/payments-team/scp/stack.ts`) declares the service once:

```ts
const home = new Stack("payments-team");
const payments = new Service(home, "payments"); // owner inferred: the registered team (D8)
```

And a component's **entire** declaration, in its own repo — the file *is* the pipeline (D15) and says what kind it is (D17), so it roots at the typed pipeline class; `App` and `Stack` never appear:

```ts
import { ImagePipeline, Service } from "@scp/iac";
import { waves, repos } from "@corp/scp-standards"; // inherited repo (D10)

new ImagePipeline("payments-api", {
  service: Service.fromName("payments"),
  repo: repos("payments/payments-api"), // REQUIRED — the source is never assumed (D18)
  waves: waves.standard,
});
```

That is the whole file: the component takes the pipeline's name, the source is the repo this manifest ships in, and the placements are the stages the waves name (D8/D9). Extra components in a multi-component repo nest under the root with their own waves.

**The shared exception (D8)** is the same class at a different scope — a `Pipeline` scoped to a *service* is the deliberate rung exception, in the team repo:

```ts
new ImagePipeline(payments, "payments-release", { waves: waves.standard });
// components that declare their own pipeline still win by rung (ADR-0027/0029)
```

**The widening pattern (1 → 2 → 4 → 8)** lives in the standards repo:

```ts
export const widePod = (regions: string[]) => [
  "commercial-amer-staging",
  ...widening(regions.map((r) => `commercial-${r}-production`), { start: 1, factor: 2 }),
];
```

(Canary *percentages within* a target stay the rollout executor's job — ADR-0008. SCP orders waves of stages; it does not orchestrate traffic weights.)

## 6. Synth output and delivery, node by node

`payments/payments-api/scp/manifest.json` (committed by the component repo's CI, D2 — excerpt). Every entry §5's inference produced — placements, per-component topology, source mapping — appears here explicitly; inference is synth-time only (D8):

```json
{
  "stackName": "payments-api",
  "objects": [
    { "typeId": "service", "name": "payments", "…": "…" },
    { "typeId": "component", "name": "payments-api", "…": "…" },
    { "typeId": "release-topology", "name": "payments-api-pipeline",
      "properties": { "waves": [
        { "name": "staging", "mode": "parallel",
          "targets": ["commercial-amer-staging", "govcloud-amer-staging",
                      "airgap-amer-staging"] },
        { "name": "wave3", "mode": "parallel",
          "targets": ["commercial-apac-production", "govcloud-emea-production",
                      "airgap-amer-production", "commercial-mide-production"] } ] } }
  ],
  "relationships": [ { "typeId": "releases_via", "…": "…" } ],
  "placements": [ { "component": "payments-api", "target": "commercial-amer-staging" } ],
  "sourceMappings": [ { "repoPattern": "git.corp.example/payments/payments-api",
                        "refPattern": "refs/heads/main", "type": "configuration" } ]
}
```

| Node | What it is | How this config reaches it |
|---|---|---|
| **commander** | source of truth, commercial domain | config-source sync on merge: plan → freeze check → apply as the stack's team (D3); journal entries in the same transaction |
| **XO** | designated standby member cluster (ADR-0044) | nothing to deliver — same instance, same database; its IaC footprint is the `#xo` dial label in §1 |
| **hq outpost** | the outpost in the commander's own trust domain | WHAT via the ordinary journal path; its HOW stack (`domains/hq/`) applied by HQ operators (D7 CLI-push) |
| **govcloud outpost** | field outpost, `trustTier: govcloud` | pulls the journal over mTLS (dial list includes the XO entry); reconciler joins `domains/govcloud/` policy → local `executor_bindings` to `argocd-govcloud` |
| **retrans** | relay at the CDS boundary | nothing to declare — pairing + inbox/outbox delivery config only; relays signed bundles, validates, never terminates a promotion |
| **airgap outpost** | air-gapped, `trustTier: il5` | WHAT arrives as `.scpbundle` via retrans (the M13.1a inbox loop — untouched by D1); its HOW stack applied locally from the same media run |

## 7. The authoring surface in detail — the D15–D17 grammar

The grammar: the file roots at the **typed pipeline class** (or at `Component` when one repo holds several pipelines); **composition over configuration** — a prop that names another declared thing takes a construct, and scope chains carry the context; **closed vocabularies are closed types**, with references via CDK's `fromXxx()` statics returning interface types (`IService`) so owned and referenced objects are interchangeable. The L1 escape hatch is guaranteed (`pipeline.addManifestEntry(...)`), synth/plan errors carry the construct tree path (`payments-api/image/unit`), and every construct exports its named props interface (D16). Free text survives only where the value is genuinely operator data (names, paths, environment strings per D6). The full-featured file — one component, two pipelines, one repo:

```ts
// payments/payments-api/scp/stack.ts — the component's entire SCP footprint
import { Component, Service, ImagePipeline, InfrastructurePipeline } from "@scp/iac";
import { TargetClass, Duration, Workflow } from "@scp/iac";
import { PostMergeTest, PostDeployTest, ContinuousTest, BakeAlarms, CanaryRollout } from "@scp/iac";
import { waves, repos, registry } from "@corp/scp-standards"; // org standards (D10)
import { products } from "@corp/payments-infra"; // the infra pipeline's typed products (D20)

const api = new Component("payments-api", { service: Service.fromName("payments") });

// -- the image pipeline: what this repo builds and ships (D17) ---------------
const image = new ImagePipeline(api, {
  repo: repos("payments/payments-api"), // REQUIRED — the source is never assumed (D18)
  branch: "main",
  publishesTo: registry.repository("payments/payments-api"), // the image repo: estate registry (§3) + path
  waves: waves.standard,
});

image.placeAt(products.payBlue); // the infra pipeline's cluster — compile → plan(hard) → readiness(loud)
image.dependsOn(Component.fromName("ledger-core")); // pending until it exists (D14)

// workflows scope to their pipeline — repo + branch come from it (D11/D15)
const unit = new Workflow(image, "unit", { path: "ci/unit.yaml" });
const integration = new Workflow(image, "integration", { path: "ci/integration.yaml" });
const probe = new Workflow(image, "canary-probe", { path: "ci/canary-probe.yaml" });

new PostMergeTest(unit); //         with the build itself, gates entry to the registry step
new PostDeployTest(integration); // NO stage: → runs after EVERY wave; gates promotion out (D21)
new BakeAlarms(image, { quiet: Duration.minutes(30) }); // alarm-free bake after each wave's
//                                                         deploy — ADR-0008 observed signals (D21)
new ContinuousTest(probe, { every: Duration.minutes(5), maxAge: Duration.minutes(15) });

new CanaryRollout(image, { on: TargetClass.kubernetes, steps: [10, 50, 100] });

// -- the infra pipeline: the component's own infrastructure (D17) ------------
// Same repo because it is component-scoped — a path slice, its own cadence.
new InfrastructurePipeline(api, {
  repo: repos("payments/payments-api"), // same repo — declared again, explicitly (D18)
  path: "infra/**",
  waves: waves.standard, // share the shape by value, or diverge freely
});

/* ── pipeline: payments-api (image) ── generated by `scp iac render --write` ──
 *
 * source     git.corp.example/payments/payments-api @ main
 *
 * build      [build ✓ · unit ✓ · scan ✓] → sign(origin) → push
 *   → image  org-registry/payments/payments-api        (commercial)
 *
 * distribute (lazy — bytes move only with an admitted crossing, ADR-0019;
 *             commander signs the journey manifest per crossing, ADR-0013)
 *   govcloud-registry ← on govcloud staging admission   (mTLS pull)
 *   airgap-registry   ← on airgap staging admission     (retrans media)
 *   each transfer carries: image + test bundle (workflows @ built commit, D23)
 *
 * staging    commercial-amer-staging ∥ govcloud-amer-staging ∥ airgap-amer-staging
 *            [exit: integration ✓ · bake-alarms quiet 30m]
 *            (CDS gate per crossing; airgap bytes via retrans)
 *
 * wave 1     commercial-amer-production · pay-blue · canary 10→50→100
 *            [exit: integration ✓ · bake-alarms quiet 30m]
 * wave 2     commercial-emea-production ∥ govcloud-amer-production
 *            [exit: integration ✓ · bake-alarms quiet 30m]
 * wave 3     commercial-apac-production ∥ govcloud-emea-production ∥
 *            airgap-amer-production ∥ commercial-mide-production
 *
 * always     canary-probe every 5m (maxAge 15m) → per-target hold
 * pending    depends_on ledger-core (not yet in graph)
 * ─────────────────────────────────────────────────────────────────────────── */
```

The trailing block is **generated, committed codegen** — `scp iac render --write` regenerates it from the synthesized manifest and CI drift-checks it like everything else generated in this shop, so the picture at the bottom of the file can never quietly disagree with the declarations above it.

**One pipeline, one source, typed by what it delivers (D17).** `ImagePipeline`, `RpmPipeline`, `NpmPipeline`, …, `InfrastructurePipeline`, `ConfigurationPipeline` — generated from the closed kind vocabulary; the class implies the journey template (D13: an image builds → pushes → bumps config → syncs; an RPM builds → publishes → batch-installs) and the wire Type. The pipeline carries its own source props: `repo` is **required** (D18 — never assumed); `branch:` picks any branch (ADR-0030); `path:` slices the repo — which is exactly how the infra pipeline shares the component's repo without colliding with it. Identity stays the (repo, path, ref) tuple, so edits diff cleanly. A single-pipeline repo roots at the pipeline class (component inferred, §5); a multi-pipeline repo roots at `Component`.

**Where the code comes from, and where the image goes.** The code source is **always written by the user** — `repo` is a required prop on every pipeline, never inferred (D18); `repos()` keeps it to the org-relative part, and `branch`/`path` are per-pipeline choices. The publish destination of an `ImagePipeline` (and every build kind) is the opposite: **estate infrastructure, never a team concern** — the platform estate declares the org's unified registry once (§3, ADR-0012), the pipeline defaults its destination to that registry at a `<service>/<component>` repository path (override the path with `repository:`), recorded as the existing `publishes_to` edge at synth. Each **domain** runs its own registry (ADR-0012 — outposts are Gitea-only), declared as domain estate IaC in that domain's federating slice (D22) — bytes replicate into it **lazily**, only with an admitted crossing into that domain (ADR-0019; retrans media for the air gap), so an image that fails build/unit/scan never leaves commercial. Teams always name their source; they never type a registry URL — commercial or otherwise.

**Refs and pending dependencies (D14).** Every `fromName()` / `fromUrn()` reference resolves **server-side** at plan time; a structural ref that doesn't resolve (the service, a wave's stage, a menu selection) refuses the plan loudly. `dependsOn` is the one graceful case: a target that doesn't exist yet becomes a **pending dependency** — listed in the plan, aging in the pipeline's status, excluded from wave ordering and ADR-0028 holds — and materializes as the real edge on the first sync after the target appears. Onboarding order stops mattering; nothing is ever silently fake.

**Tests know where the code is through their pipeline.** A `Workflow` scopes to a pipeline, so it inherits the repo and branch the pipeline already declares — `path:` names the WorkflowTemplate *within that repo*; a hook scopes to its `Workflow`. `PostMergeTest(unit)` fires on merges to `image`'s branch and runs `ci/unit.yaml` from `image`'s repo, because that is what its scope chain says. Per D21, `PostDeployTest` with no `stage:` gates **every** wave's exit (a `stage:` narrows it), and `BakeAlarms` holds each wave's exit until the declared quiet window passes alarm-free after deploy. SCP **triggers** the run on the domain's Argo Workflows (resolved by binding policy) and consumes the result as gate/hold evidence — stale continuous green reads as absent (`maxAge` required). Across security domains the `path:` is a build-time capture, not a runtime fetch: the named workflows are bundled **at the built commit**, signed, distributed with the image's own crossing (D22/D23), and every domain — commercial included — runs its local, digest-pinned copy; results ride the existing upward evidence path (return media sync for the air gap). No `argo-workflows` plugin exists yet: build increment 8 (main doc §13).

```ts
new BindingPolicy(bindings, "tests", {
  scope: DeploymentTarget.fromName("commercial-amer-staging"),
  type: ExecutorType.build, // dedicated test lane vs build lane: main doc §14.11
  executionSystem: ExecutionSystem.fromName("workflows-hq"),
});
```

**Sub-targets are pipeline products (D19).** A cluster or instance group is declared by — scoped to — the Infrastructure/Configuration pipeline that manages it, at whichever rung that infra genuinely lives (component, service, or assembly):

```ts
const sharedInfra = new InfrastructurePipeline(payments, "payments-infra", {
  repo: repos("payments/payments-infra"), // REQUIRED (D18)
  waves: waves.standard,
});
const payBlue = new Cluster(sharedInfra, "pay-blue", {
  within: DeploymentTarget.fromName("commercial-amer-production"),
  account: "123456789012",
});
```

The graph object and the real cluster share one managing pipeline — provenance is honest, stack pruning applies, and "who owns this cluster" has exactly one answer. Consumers reference the product: `Cluster.fromName("pay-blue")` directly, or the generated `targets.*` handles — the `targets` module stays **codegen over the graph** (`scp iac export --handles`), regardless of who manages the objects. A placement refined onto a cluster whose managing pipeline has not yet released is **loud** (readiness surfaced, never fake success); whether the image waits for the infra stays the operator's choice (2026-07-15 ruling) — explicit dependency or topology naming, never an implicit gate. The estate declares *stages*; domain operators author only the *HOW* (binding policies); the sub-target layer between them belongs to the infra pipelines that build it.

**Importing another pipeline's products (D20).** The infra pipeline's synth emits a typed products module beside its manifest; its CI publishes it to the org registry like any package (D10). Consumers import it for compile-time safety — the wire still carries only refs:

```ts
import { products } from "@corp/payments-infra"; // typed products of the infra pipeline
// the module is interface-typed by infra KIND (D24):
//   products.payBlue: ICluster · products.payProdIg: IInstanceGroup · products.paymentsDb: IDatabase

image.placeAt(products.payBlue); //    ✓ ImagePipeline.placeAt(target: ICluster)
image.placeAt(products.paymentsDb); // ✗ COMPILE error — a Database is never a deploy target
rpm.placeAt(products.payBlue); //      ✗ COMPILE error — RpmPipeline takes IInstanceGroup

image.placeAt(products.payBlue); // no such product → COMPILE error
//                                  in graph but object missing → plan HARD-REFUSED (structural ref;
//                                  D14 pending grace is dependsOn-only, never placements)
//                                  exists but not yet provisioned → LOUD readiness (D19)
```

The ladder is compile → plan (hard) → readiness (loud), and a refused plan re-plans on every config-source sync, so infra-lands-then-image-succeeds converges without sequencing PRs. Per D24 the compile arm also checks **kind**: the artifact-class × infra-kind matrix lives once in `@scp/schemas`, the server re-checks it at plan on the explicit manifest (L1 authors cannot bypass it), and the domain reconciler only binds executor classes that serve the target's kind — RPM→cluster and image→RDS die at the earliest layer that sees them.

**Rollout: the strategy is the construct** (`CanaryRollout`, `RollingRollout` — no strategy strings), scoped to its pipeline and keyed to a `TargetClass` — an `RpmPipeline` would declare `new RollingRollout(rpm, { on: TargetClass.instanceGroup, batchPercent: 25, pauseBetween: Duration.minutes(5) })`. Authoritative for `scp-runner-*` classes; trigger-parameters-or-verified for coordinated executors (the plugin declares which, §14.8) — declared-vs-observed divergence is loud, and SCP never moves traffic itself.


## 8. The whole estate in one file — accounting for everything

In practice these live in different stacks with different owners (each block is annotated with its real home and authority). Shown as one file so every object the pipelines touch is declared on screen — nothing arrives by magic. The only things that may NOT appear here are the §1 ceremonies: execution-system connections (credentials), federation pairing, and the XO designation.

```ts
import {
  Stack, Team, Service, Component, Registry, DeploymentTarget, Cluster,
  BindingPolicy, ExecutionSystem, ExecutorType, TargetClass, Duration,
  ImagePipeline, InfrastructurePipeline, Workflow,
  PostMergeTest, PostDeployTest, ContinuousTest, BakeAlarms, CanaryRollout,
} from "@scp/iac";

// ═══ 1. PLATFORM ESTATE — platform team, applied at the commander, federates ═══
const estate = new Stack("platform-estate");

const paymentsTeam = new Team(estate, "team-payments");
const registry = new Registry(estate, "org-registry", { url: "https://git.corp.example" });

// (a SUBSET of §5's full ten-stage plan, for brevity)
const stg = new DeploymentTarget(estate, "commercial-amer-staging", {
  properties: { environment: "staging", region: "amer" },
});
const govStg = new DeploymentTarget(estate, "govcloud-amer-staging", {
  properties: { environment: "staging", region: "amer" },
});
const airgapStg = new DeploymentTarget(estate, "airgap-amer-staging", {
  properties: { environment: "staging", region: "amer" },
});
const prodAmer = new DeploymentTarget(estate, "commercial-amer-production", {
  properties: { environment: "production", region: "amer" },
});
const prodEmea = new DeploymentTarget(estate, "commercial-emea-production", {
  properties: { environment: "production", region: "emea" },
});
const govProd = new DeploymentTarget(estate, "govcloud-amer-production", {
  properties: { environment: "production", region: "amer" },
});
const airgapProd = new DeploymentTarget(estate, "airgap-amer-production", {
  properties: { environment: "production", region: "amer" },
});

// ═══ 2. TEAM HOME — the payments team's thin service stack ═══
const home = new Stack("payments-team");
const payments = new Service(home, "payments");
payments.grantOwnership(paymentsTeam); // D16 grant fluent → owns edge + role binding

// ═══ 3. SHARED INFRASTRUCTURE — clusters are pipeline PRODUCTS, not menus (D19) ═══
// The cluster the image deploys onto is itself managed by an Infrastructure
// pipeline — here at the SERVICE rung (D8's shared exception, used for what is
// genuinely shared). One managing pipeline owns the graph object AND the real thing.
const sharedInfra = new InfrastructurePipeline(payments, "payments-infra", {
  repo: "git.corp.example/payments/payments-infra", // REQUIRED (D18)
  waves: [[stg, govStg, airgapStg], prodAmer, [prodEmea, govProd], [airgapProd]],
});
const payBlue = new Cluster(sharedInfra, "pay-blue", { within: prodAmer, account: "123456789012" });
const govBlue = new Cluster(sharedInfra, "gov-blue", { within: govProd, account: "210987654321" });

// ═══ 3b. DOMAIN REGISTRIES — each domain's own (ADR-0012); outpost-origin, federates ═══
// Bytes arrive here LAZILY: only with an admitted crossing into the domain (D22).
const govEstate = new Stack("govcloud-estate");
new Registry(govEstate, "govcloud-registry", { url: "https://git.gov.example" });
// airgap-estate declares airgap-registry the same way; delivered on the media run

// ═══ 4. DOMAIN HOW — each domain's operators; domain-local, NEVER federates ═══
// (execution systems referenced here were connected in the §1 ceremony)
const hqBindings = new Stack("hq-bindings", { domainLocal: true });
new BindingPolicy(hqBindings, "deploys", {
  scope: prodAmer,
  type: ExecutorType.configuration,
  executionSystem: ExecutionSystem.fromName("argocd-hq"),
});
new BindingPolicy(hqBindings, "tests", {
  scope: stg,
  type: ExecutorType.build,
  executionSystem: ExecutionSystem.fromName("workflows-hq"),
});
// govcloud-bindings / airgap-bindings: same lines against their own executors

// ═══ 5. THE COMPONENT REPO — what a team actually writes day to day ═══
const api = new Component("payments-api", { service: payments });

const image = new ImagePipeline(api, {
  repo: "git.corp.example/payments/payments-api", // REQUIRED — never assumed (D18)
  branch: "main",
  publishesTo: registry.repository("payments/payments-api"), // default: registry + "<service>/<component>"
  waves: [[stg, govStg, airgapStg], prodAmer, [prodEmea, govProd], [airgapProd]], // staging-everywhere first (D21)
});
image.placeAt(payBlue); // references block 3's PRODUCT; readiness is loud, and
image.placeAt(govBlue); // whether image waits for infra is the operator's choice
image.dependsOn(Component.fromName("ledger-core")); // the ONE off-screen ref — pending (D14)

const unit = new Workflow(image, "unit", { path: "ci/unit.yaml" });
const integration = new Workflow(image, "integration", { path: "ci/integration.yaml" });
const probe = new Workflow(image, "canary-probe", { path: "ci/canary-probe.yaml" });

new PostMergeTest(unit); //                      with the build, gates entry to the registry
new PostDeployTest(integration); //               no stage: → gates EVERY wave's exit (D21)
new BakeAlarms(image, { quiet: Duration.minutes(30) }); // alarm-free bake per wave exit (D21)
new ContinuousTest(probe, { every: Duration.minutes(5), maxAge: Duration.minutes(15) });

new CanaryRollout(image, { on: TargetClass.kubernetes, steps: [10, 50, 100] });

// the component's OWN infra (its queues, buckets) — component rung, same repo, path slice
new InfrastructurePipeline(api, {
  repo: "git.corp.example/payments/payments-api", // same repo, declared again — explicitly (D18)
  path: "infra/**",
  waves: [[stg, govStg, airgapStg], prodAmer, [prodEmea, govProd], [airgapProd]],
});
```

Reading it for completeness: every stage a wave names is declared in block 1; every cluster a `placeAt` refines to is the declared **product of the infrastructure pipeline that manages it** (block 3), sitting `within` a block-1 stage; every executor the pipelines run against resolves through a block-4 policy — the team never names one; the registry the image publishes to is block 1, referenced rather than retyped; the service and its ownership are block 2; and the single reference to something not on this screen — `ledger-core`, another team's component — is exactly the case D14 makes safe. The `targets.*` / `stages.*` handles used in §5/§7 are nothing more than generated names for what blocks 1 and 3 declare.


## 9. The static fleet — infra + Ansible as coupled pipelines (D25)

Not a multi-source pipeline: two pipelines, one repo, one product seam. Inventory does not exist as a file anywhere.

```ts
// payments/payments-fleet/scp/stack.ts
const fleet = new Component("payments-fleet", { service: Service.fromName("payments") });

const infra = new InfrastructurePipeline(fleet, {
  repo: repos("payments/payments-fleet"),
  path: "terraform/**", //  EC2 instances + their ASG
  waves: waves.standard,
});
const ig = new InstanceGroup(infra, "pay-prod-ig", {
  within: DeploymentTarget.fromName("commercial-amer-production"),
});

const config = new ConfigurationPipeline(fleet, {
  repo: repos("payments/payments-fleet"),
  path: "ansible/**", //    roles + group_vars — the WHAT; never inventory
  waves: waves.standard,
});
config.placeAt(ig); // configuration → instance group (D24 row). Inventory DERIVES from the
//                     product's observed membership. Convergence is ON by default (D25):
//                     ASG churn re-applies the released state to the changed instances,
//                     batched by the rollout below, held loudly by freezes.
new RollingRollout(config, {
  on: TargetClass.instanceGroup,
  batchPercent: 25,
  pauseBetween: Duration.minutes(5),
});
```

A terraform change releases through `infra`'s waves; the apply mutates the product; membership observation triggers convergence on `config` for the affected target only — already-released, already-gated state, no wave re-entry, one Decision per run. Launch-time configuration belongs to a vm-image pipeline (baked AMIs); convergence is day-2 and static fleets. Ansible execution is whatever the domain's binding policy names — BYO today, `scp-runner-ops` when its charter preconditions close.
---

A component team merged one PR in its own repo. The commander applied it once. Every domain the service is placed in — including the one behind the CDS — runs the pipeline against its own executor, and no repo, credential, or binding crossed any boundary to make that true.
