# Team-pipeline IaC — worked example across a full estate

**Status:** Draft companion to [team-pipeline-iac.md](team-pipeline-iac.md), 2026-08-26. Construct shapes marked **(new)** are proposed by that doc; everything else exists in `@scp/iac` today. Property shapes on new constructs are indicative, not final.

The estate: a **commander** (with its **XO** — the designated standby member cluster, ADR-0044), the **HQ outpost** (the outpost in the commander's own trust domain), a **retrans** at the CDS boundary, one **govcloud outpost**, and one **air-gapped outpost**.

```
             commander (+ XO member cluster)          ── commercial trust domain
                │        │
        hq outpost    govcloud outpost                ── mTLS journal pull
                          │
                       retrans ══ CDS ══▶ airgap1 outpost   ── signed .scpbundle files
```

Stage names follow the GLOSSARY grammar `<domain>[-<location>]-<env>` with hyphen-free segments — hence `airgap1-prod`, not `airgap-1-prod`. Per D6, examples use `staging` (never `gamma`); `dev` lives in domain-local dev pipelines (ADR-0030) and does not appear in the global promotion path.

## 1. What is deliberately NOT in IaC

Transport identity, keys, credentials, and the XO designation are operator ceremonies. Peer rows are local, per-side, and never journaled (ADR-0022); execution-system creation holds credentials; the XO is a member-cluster designation, not an object (ADR-0044).

```console
# one-time estate ceremonies — never expressed in a manifest
$ scp federation pair --peer govcloud …                # mTLS identity + key exchange
$ scp federation pair --peer retrans-1 …
$ scp federation pair --peer airgap1 --bundle …        # pairing bundle rides sneakernet
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
    domains/{hq,govcloud,airgap1}/bindings.ts
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

The component's declaration rides the same repo that already drives its releases — one push webhook feeds both config sync (when `scp/manifest.json` changed) and release correlation (everything else). Domain HOW slices are applied by each domain's operators locally (CLI-push, D7 — for airgap1, from the same media run as the regular bundle delivery).

## 3. `platform/estate.ts` — the operator stack (applies at the commander, federates)

```ts
import { Stack, Team, DeploymentTarget, TrustTier } from "@scp/iac";
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
new Outpost(estate, "airgap1", { trustTier: TrustTier.il5 });

// -- stages: deployment-targets, GLOSSARY grammar, D6 vocabulary ------------
const stage = (id: string, environment: string, region?: string) =>
  new DeploymentTarget(estate, id, { properties: { environment, region } });

stage("commercial-amer-staging", "staging", "amer");
stage("commercial-amer-prod", "prod", "amer");
stage("commercial-emea-prod", "prod", "emea");
stage("govcloud-amer-prod", "prod", "amer");
stage("airgap1-prod", "prod");
```

## 4. `domains/govcloud/bindings.ts` — one domain's HOW (domain-local, D4)

```ts
import { Stack, ExecutorType } from "@scp/iac";
import { BindingPolicy, DeploymentTarget, ExecutionSystem } from "@scp/iac";
// BindingPolicy (new): the D4 policy effect. .ref() (new): reference an existing
// object without managing it — refs never create, update, or prune.

const bindings = new Stack("govcloud-bindings", { domainLocal: true });
// domainLocal (new): everything in this stack is born domain-local (ADR-0031) —
// it never journals, never leaves this domain.

new BindingPolicy(bindings, "prod-configuration", {
  scope: DeploymentTarget.ref("govcloud-amer-prod"),
  type: ExecutorType.configuration,
  executionSystem: ExecutionSystem.ref("argocd-govcloud"),
});
```

`domains/hq/bindings.ts` and `domains/airgap1/bindings.ts` are the same five lines pointing at `argocd-hq` / `argocd-airgap1`. This is the whole per-domain cost of joining every team's pipeline: the domain reconciler joins these policies against federated placements and materializes the `executor_bindings` itself. A placement no policy matches is **loud** (unbound status), never a silent fake-success.

## 5. The component's own repo — the headline surface (D9/D10/D15)

The platform team publishes standards once, as a versioned package on the org's own registry:

```ts
// platform/scp-standards → @corp/scp-standards (Gitea npm — air-gap-clean)
export const waves = {
  standard: [
    "commercial-amer-staging",
    "commercial-amer-prod",
    "commercial-emea-prod",
    // one wave, two security domains: ordinary promotion into govcloud, cross-domain
    // promotion into airgap1 — the CDS gate applies per crossing, not per wave
    ["govcloud-amer-prod", "airgap1-prod"],
  ],
};
```

The team's thin home (`payments/payments-team/scp/stack.ts`) declares the service once:

```ts
const home = new Stack("payments-team");
const payments = new Service(home, "payments"); // owner inferred: the registered team (D8)
```

And a component's **entire** declaration, in its own repo — the file *is* the pipeline (D15), so it roots at `Pipeline`; `App` and `Stack` never appear:

```ts
import { Pipeline, Service } from "@scp/iac";
import { waves } from "@corp/scp-standards"; // inherited repo (D10)

new Pipeline("payments-api", {
  service: Service.ref("payments"),
  waves: waves.standard,
});
```

That is the whole file: the component takes the pipeline's name, the source is the repo this manifest ships in, and the placements are the stages the waves name (D8/D9). Extra components in a multi-component repo nest under the root with their own waves.

**The shared exception (D8)** is the same class at a different scope — a `Pipeline` scoped to a *service* is the deliberate rung exception, in the team repo:

```ts
new Pipeline(payments, "payments-release", { waves: waves.standard });
// components that declare their own pipeline still win by rung (ADR-0027/0029)
```

**The widening pattern (1 → 2 → 4 → 8)** lives in the standards repo:

```ts
export const widePod = (regions: string[]) => [
  "commercial-amer-staging",
  ...widening(regions.map((r) => `commercial-${r}-prod`), { start: 1, factor: 2 }),
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
        { "name": "staging", "targets": ["commercial-amer-staging"] },
        { "name": "regulated", "mode": "parallel",
          "targets": ["govcloud-amer-prod", "airgap1-prod"] } ] } }
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
| **airgap1 outpost** | air-gapped, `trustTier: il5` | WHAT arrives as `.scpbundle` via retrans (the M13.1a inbox loop — untouched by D1); its HOW stack applied locally from the same media run |

## 7. The authoring surface in detail — the D15 grammar

Three grammar rules (D15): the file roots at **`Pipeline`**; **composition over configuration** — a prop that names another declared thing takes a construct, and scope chains carry the context; **closed vocabularies are closed types** — `Artifact.image`, `TargetClass.kubernetes`, `ExecutorType.build`, strategy-as-class, `minutes(5)`/`percent(25)` instead of `"5m"`/`"25%"`. Free text survives only where the value is genuinely operator data (names, paths, environment strings per D6). The full-featured file:

```ts
import { Pipeline, Service, Component, Artifact, TargetClass, minutes, percent } from "@scp/iac";
import {
  BuildSource, InfrastructureSource, Workflow,
  PostMergeTest, PostDeployTest, ContinuousTest,
  CanaryRollout, RollingRollout,
} from "@scp/iac";
import { stages, targets, waves, repos } from "@corp/scp-standards"; // typed handles (D10)

const pipeline = new Pipeline("payments-api", {
  service: Service.ref("payments"),
  waves: waves.standard,
});

// -- sources: the Type is the class; this repo is the default (D13) ----------
const build = new BuildSource(pipeline, { artifact: Artifact.image });
new InfrastructureSource(pipeline, { repo: repos("payments/payments-infra") });

// -- where it lands: typed menu handles (§14.9) ------------------------------
pipeline.placeAt(targets.commercialAmerProd.payBlue); // a Cluster
pipeline.placeAt(targets.govcloudAmerProd.payProdIg); // an InstanceGroup

// -- dependencies: pending until the target exists (D14) ---------------------
pipeline.dependsOn(Component.ref("ledger-core"));

// -- tests: a Workflow scopes to a SOURCE — that is how it knows where the
//    code and the template live (D11/D15). path is within the source's repo.
const unit = new Workflow(build, "unit", { path: "ci/unit.yaml" });
const integration = new Workflow(build, "integration", { path: "ci/integration.yaml" });
const probe = new Workflow(build, "canary-probe", { path: "ci/canary-probe.yaml" });

new PostMergeTest(unit); //                       fires on merge to build's branch; gates wave 1
new PostDeployTest(integration, { stage: stages.commercialAmerStaging }); // gates promotion out
new ContinuousTest(probe, { every: minutes(5), maxAge: minutes(15) }); //   per-target hold

// -- rollout: the strategy is the class; the target class is an enum (D12) ---
new CanaryRollout(pipeline, { on: TargetClass.kubernetes, steps: [10, 50, 100] });
new RollingRollout(pipeline, {
  on: TargetClass.instanceGroup,
  batch: percent(25),
  pauseBetween: minutes(5),
});
```

**Refs and pending dependencies (D14).** Every `.ref()` resolves **server-side** at plan time; a structural ref that doesn't resolve (the service, a wave's stage, a menu selection) refuses the plan loudly. `dependsOn` is the one graceful case: a target that doesn't exist yet becomes a **pending dependency** — listed in the plan, aging in the pipeline's status, excluded from wave ordering and ADR-0028 holds — and materializes as the real edge on the first sync after the target appears. Onboarding order stops mattering; nothing is ever silently fake.

**Sources.** `BuildSource` / `InfrastructureSource` / `ConfigurationSource` — the Type cannot be mistyped because it is the class, and per-Type props are compile-checked: only `BuildSource` has (and requires) `artifact`, from the closed `Artifact` enum (image, rpm, npm, maven, python, go, chart, vmImage). Omitted `repo` = the repo the manifest ships in; `branch:` picks any branch (ADR-0030 ref pattern under the hood); `path:` slices monorepos. Identity stays the (repo, path, ref) tuple, so edits diff cleanly.

**Tests know where the code is through their scope chain.** A `Workflow` scopes to a source, so it inherits the repo and branch the source already declares — `path:` names the WorkflowTemplate *within that repo*; a hook scopes to its `Workflow`. Nothing is repeated: `PostMergeTest(unit)` fires on merges to `build`'s branch and runs `ci/unit.yaml` from `build`'s repo, because that is what its scope chain says. SCP **triggers** the run on the domain's Argo Workflows (resolved by binding policy, one line on the domain side) and consumes the result as gate/hold evidence — stale continuous green reads as absent (`maxAge` required). No `argo-workflows` plugin exists yet: this is build increment 8 (main doc §13).

```ts
new BindingPolicy(bindings, "tests", {
  scope: DeploymentTarget.ref("commercial-amer-staging"),
  type: ExecutorType.build, // dedicated test lane vs build lane: main doc §14.11
  executionSystem: ExecutionSystem.ref("workflows-hq"),
});
```

**The target menu is constructs** published by domain operators — `Cluster` / `InstanceGroup`, sugar over child deployment-targets, so a freeze or binding policy can scope to one cluster. The menu stack **federates** (outpost-origin, §14.9): team placements at the commander must resolve against it; only the binding policies stay domain-local.

```ts
new Cluster(menu, "pay-blue", {
  within: DeploymentTarget.ref("commercial-amer-prod"),
  account: "123456789012",
});
new InstanceGroup(menu, "pay-prod-ig", {
  within: DeploymentTarget.ref("govcloud-amer-prod"),
});
```

Teams `placeAt()` handles the standards package re-exports (`targets.commercialAmerProd.payBlue`, regenerable via `scp iac export --handles`) — selecting something the domain never declared fails at compile (no handle) or at plan (bad ref). Sub-target *creation* by a team is a scoped write grant: selection is the default, creation is deliberate delegation.

**Rollout: the strategy is the construct** (`CanaryRollout`, `RollingRollout` — no strategy strings), keyed to a `TargetClass`. Authoritative for `scp-runner-*` classes; trigger-parameters-or-verified for coordinated executors (the plugin declares which, §14.8) — declared-vs-observed divergence is loud, and SCP never moves traffic itself.

---

A component team merged one PR in its own repo. The commander applied it once. Every domain the service is placed in — including the one behind the CDS — runs the pipeline against its own executor, and no repo, credential, or binding crossed any boundary to make that true.
