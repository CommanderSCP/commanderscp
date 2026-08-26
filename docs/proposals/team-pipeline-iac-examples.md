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
import { App, Stack, Team, DeploymentTarget } from "@scp/iac";
import { Outpost } from "@scp/iac"; // (new) one-liner registry construct over the
                                    // `outpost` object type (migration 0043)

const app = new App();
const estate = new Stack(app, "platform-estate");

// -- teams ------------------------------------------------------------------
const platformTeam = new Team(estate, "team-platform", {});
const paymentsTeam = new Team(estate, "team-payments", {});

// -- outposts: commander-declared config only (ADR-0022 authority split) ----
// trustTier etc. — transport/keys stay in §1's ceremonies.
new Outpost(estate, "hq", { trustTier: "commercial" });
new Outpost(estate, "govcloud", { trustTier: "govcloud" });
new Outpost(estate, "airgap1", { trustTier: "il5" });

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
import { App, Stack } from "@scp/iac";
import { BindingPolicy, DeploymentTarget, ExecutionSystem } from "@scp/iac";
// BindingPolicy (new): the D4 policy effect. .ref() (new): reference an existing
// object without managing it — refs never create, update, or prune.

const app = new App();
const bindings = new Stack(app, "govcloud-bindings", { domainLocal: true });
// domainLocal (new): everything in this stack is born domain-local (ADR-0031) —
// it never journals, never leaves this domain.

new BindingPolicy(bindings, "prod-configuration", {
  scope: DeploymentTarget.ref("govcloud-amer-prod"),
  type: "configuration",
  executionSystem: ExecutionSystem.ref("argocd-govcloud"),
});
```

`domains/hq/bindings.ts` and `domains/airgap1/bindings.ts` are the same five lines pointing at `argocd-hq` / `argocd-airgap1`. This is the whole per-domain cost of joining every team's pipeline: the domain reconciler joins these policies against federated placements and materializes the `executor_bindings` itself. A placement no policy matches is **loud** (unbound status), never a silent fake-success.

## 5. The component's own repo — the headline surface (D9/D10)

The platform team publishes standards once, as a versioned package on the org's own registry:

```ts
// platform/scp-standards → @corp/scp-standards (Gitea npm — air-gap-clean)
export const standardRollout = [
  "commercial-amer-staging",
  "commercial-amer-prod",
  "commercial-emea-prod",
  // one wave, two security domains: ordinary promotion into govcloud, cross-domain
  // promotion into airgap1 — the CDS gate applies per crossing, not per wave
  ["govcloud-amer-prod", "airgap1-prod"],
];
```

The team's thin home (`payments/payments-team/scp/stack.ts`) declares the service once:

```ts
const stack = new Stack(app, "payments-team");
new Service(stack, "payments"); // owner inferred: the registered team (D8)
```

And a component's **entire** declaration, in its own repo (`payments/payments-api/scp/stack.ts`):

```ts
import { App, Stack, Service, Component } from "@scp/iac";
import { standardRollout } from "@corp/scp-standards"; // inherited repo (D10)

const app = new App();
const stack = new Stack(app, "payments-api");

new Component(stack, "payments-api", {
  service: Service.ref("payments"),
  pipeline: { waves: standardRollout },
  // inferred (D8/D9): repo + source mapping = the repo this manifest ships in;
  // placements = payments-api × every stage the waves name
});
```

Three hundred component repos are three hundred copies of that file with a different name — and when the platform team publishes a new `@corp/scp-standards`, the **dependency-subscription machinery (M21) delivers the bump to every subscribed repo as a PR**. Pipeline structure standards roll out like any other dependency.

Divergence is explicit and plain TypeScript: `waves: [...standardRollout, "one-more-stage"]`, or a fully local shape. Wave shorthand: a bare string is a sequential single-stage wave; an array is a parallel wave; the full `{ name, mode, targets, requiresFanIn }` object stays available. The `dev` branch is deliberately unmapped — dev pipelines are domain-local (ADR-0030).

**The shared exception (D8):** only when components genuinely release as one unit does a pipeline move up a rung — explicitly, in the team repo:

```ts
// deliberate: one shared pipeline at the service rung (releases_via nearest-rung
// ladder, ADR-0027/0029). A component that declares its own pipeline still wins by rung.
new Pipeline(payments, "payments-release", { waves: standardRollout });
```

**The widening pattern (1 → 2 → 4 → 8)** lives naturally in the standards repo too:

```ts
export const widePod = (regions: string[]) => [
  "commercial-amer-staging",
  ...waves.widening(regions.map((r) => `commercial-${r}-prod`), { start: 1, factor: 2 }),
];
```

(Canary *percentages within* a target stay the rollout executor's job — ADR-0008. SCP orders waves of stages; it does not orchestrate traffic weights.)

## 6. Synth output and delivery, node by node

`payments/payments-api/scp/manifest.json` (committed by the component repo's CI, D2 — excerpt). Every entry §5's inference produced — placements, per-component topology, source mapping — appears here explicitly; inference is synth-time only (D8):

```json
{
  "stackName": "team-payments",
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

## 7. The authoring surface in detail

**Refs are real or the plan refuses.** Every `.ref()` compiles to a name/URN reference in the manifest; at plan time the **server** resolves each one against the live graph. An unresolvable ref refuses the whole plan — a Decision is recorded and the config-source status goes loud; nothing is created from a ref, ever (only entries a stack *declares* can create/adopt/prune, and create-strict still applies to those). Cross-repo ordering converges the same way: if `payments-api` syncs before the team repo has declared the `payments` service, that plan refuses loudly and the next sync after the service lands succeeds.

**Sources.** The host prefix is imported, not retyped; the Type is a closed enum; the branch is the team's choice:

```ts
import { repos } from "@corp/scp-standards"; // central git host + namespace defaults (D10)

sources: [
  {}, //                                      this repo, default branch, Type configuration
  { repo: repos("payments/payments-infra"), //  team types only the org-relative part
    type: "infrastructure" }, //               ExecutorType: closed TS literal union backed by
  //                                           the same Zod enum on the wire — an untrusted
  //                                           value fails at compile time AND at the contract
  { branch: "release-2026" }, //               pick any branch: sugar for ref (ADR-0030)
  { path: "services/api/**" }, //              monorepo path slice
]
```

**Targets: select, don't create.** The platform declares stages (§3); each domain declares the infrastructure *menu* beneath its stages — clusters, instance groups, accounts — as child deployment-targets (so a freeze, binding policy, or scan policy can scope to one cluster via the existing containment routes). Teams **select** from the menu per stage:

```ts
pipeline: {
  waves: standardRollout,
  place: {
    "commercial-amer-prod": { cluster: "pay-blue", account: "123456789012" },
    "govcloud-amer-prod": { instanceGroup: "pay-prod-ig" },
  },
}
```

Selections are refs — naming a cluster the domain never declared refuses at plan. An org that wants teams creating their own sub-targets grants scoped write at a container (the authz model already supports it): selection is the default, creation is a deliberate delegation, and either way the estate menu stays governable.

**Dependencies (`dependsOn`).** Already a fluent method on every construct; it gains refs to objects the team does not own — components, assemblies, or services:

```ts
api.dependsOn(Component.ref("ledger-core")); // another team's component
api.dependsOn(Service.ref("identity"));      // or a service / assembly
```

`depends_on` is what the plan compiler topo-sorts by absent an explicit topology, and what drives ADR-0028 stage-dependency holds — a dependency holds *your* rollout behind theirs, never the reverse, which is why a component owner may declare one against anything visible. (Endpoint authorization: main doc §14.)

**Tests (D11) — SCP triggers, Argo Workflows executes.** Three hook points, one contract: the run happens on the org's (or bundled) Argo Workflows, and the *result* is gate/hold evidence:

```ts
pipeline: {
  waves: standardRollout,
  tests: {
    postMerge: workflows.run("payments-unit"), //        after merge on the mapped branch;
    //                                                   gates the first wave
    postDeploy: {
      "commercial-amer-staging": workflows.run("payments-integration"),
    }, //                                                after deploy into that env;
    //                                                   gates promotion out of it
    continuous: workflows.cron("payments-canary-probe", { every: "5m", maxAge: "15m" }),
    //                                                   always running; latest fresh result
    //                                                   is a per-target hold — stale = absent
  },
}
```

The WorkflowTemplate / CronWorkflow definitions live in the team's own repos; IaC names them; the domain binding policy resolves which Workflows instance runs them per stage. SCP never executes a test — it triggers, observes, and gates.

**Rollout (D12) — declared in code, keyed by target class:**

```ts
rollout: {
  kubernetes: { strategy: "canary", steps: [10, 50, 100] },
  instanceGroup: { strategy: "rolling", batch: "25%", pauseBetween: "5m" },
}
```

For SCP-managed executor classes (`scp-runner-*`) the declaration is **authoritative** — SCP instructs the batches. For coordinated executors it rides the trigger as parameters where the plugin declares support, and is otherwise **verified**: SCP observes actual weights (ADR-0008) and declared-vs-actual divergence is loud. SCP instructs or verifies the executor that moves traffic; it never moves traffic itself.

**Type and artifact class (D13).** Type stays the closed taxonomy — `build` / `infrastructure` / `configuration`. A `build` source also declares **what it produces**, because the journey shape differs per artifact class:

```ts
sources: [
  { type: "build", artifact: "image" }, // build → push → config bump → sync
  { type: "build", artifact: "rpm" },   // build → publish → batch-install to instance groups
]
```

Declared, then **verified** against build/registry evidence — a source that declares `rpm` while its builds publish images is a loud mismatch, never a silent relabel. Bindings stay 1:N per target keyed by Type; the domain binding policy resolves (target, Type) → executor, and the artifact class selects the journey template within it.

---

A component team merged one PR in its own repo. The commander applied it once. Every domain the service is placed in — including the one behind the CDS — runs the pipeline against its own executor, and no repo, credential, or binding crossed any boundary to make that true.
