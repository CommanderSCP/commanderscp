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
$ scp config-source register \
    --repo git.corp.example/platform/scp-config --ref main \
    --path 'platform/*.manifest.json' --path 'teams/*/manifest.json' \
    --stack platform-estate=team-platform \
    --stack team-payments=team-payments               # stack → team identity (D3/D7: these
                                                       # stacks are now repo-owned)
```

Nothing is ever declared *for* the XO: it serves the same instance and database, so every applied manifest is already "on" it. Its entire IaC footprint is the `#xo` dial label above.

## 2. The repo (one repo, commander's domain)

```
scp-config/
  platform/
    estate.ts                 # operator stack — global WHAT skeleton
    estate.manifest.json      # committed synth output (D2) — what SCP reads
  domains/
    hq/bindings.ts            # each domain's HOW — small, rarely changes
    govcloud/bindings.ts
    airgap1/bindings.ts
  teams/
    payments/stack.ts         # a team's WHAT
    payments/manifest.json
```

One repo holds all the code. Delivery differs per node (§6): the commander's config source syncs `platform/` and `teams/`; each domain's operators apply their `domains/<name>/` slice locally (CLI-push, D7 — for airgap1, from the same media run as the regular bundle delivery).

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

## 5. `teams/payments/stack.ts` — the team's WHAT (the headline surface)

Component-level pipelines by default, inference at synth (D8): pipeline attachment comes from construct scope, placements from the stages a component's waves name, the source mapping from `repo` (default branch, default Type), the service owner from the stack's registered team. The synthesized manifest still spells all of it out — inference never reaches the server.

```ts
import { App, Stack, Service, Component } from "@scp/iac";

const app = new App();
const stack = new Stack(app, "team-payments");

const payments = new Service(stack, "payments"); // owner inferred: the stack's team

// one wave shape, reused as a plain TS value
const rollout = [
  "commercial-amer-staging",
  "commercial-amer-prod",
  "commercial-emea-prod",
  // one wave, two security domains: ordinary promotion into govcloud, cross-domain
  // promotion into airgap1 — the CDS gate applies per crossing, not per wave
  ["govcloud-amer-prod", "airgap1-prod"],
];

new Component(payments, "payments-api", {
  repo: "git.corp.example/payments/payments-api", // source mapping inferred: default branch, Type configuration
  pipeline: { waves: rollout }, // placements inferred: payments-api × every stage named above
});

new Component(payments, "payments-worker", {
  repo: "git.corp.example/payments/payments-worker",
  pipeline: { waves: rollout }, // same shape, still its own component-level pipeline
});
```

That is the whole file. Wave shorthand: a bare string is a sequential single-stage wave; an array is a parallel wave; the full `{ name, mode, targets, requiresFanIn }` object stays available when the shorthand isn't enough. The `dev` branch is deliberately unmapped here — dev pipelines are domain-local (ADR-0030) and belong to a domain-local stack.

**The shared exception (D8):** only when components genuinely release as one unit does a pipeline move up a rung — and it is explicit:

```ts
// deliberate: one shared pipeline at the service rung (releases_via nearest-rung
// ladder, ADR-0027/0029). A component that declares its own pipeline still wins by rung.
new Pipeline(payments, "payments-release", { waves: rollout });
```

**The widening pattern (1 → 2 → 4 → 8):** when prod is many targets, the helper builds the fan-out:

```ts
const prod = regions.map((r) => `commercial-${r}-prod`);
new Component(payments, "payments-api", {
  repo: "git.corp.example/payments/payments-api",
  pipeline: {
    waves: ["commercial-amer-staging", ...waves.widening(prod, { start: 1, factor: 2 })],
  },
});
```

(Canary *percentages within* a target stay the rollout executor's job — ADR-0008. SCP orders waves of stages; it does not orchestrate traffic weights.)

## 6. Synth output and delivery, node by node

`teams/payments/manifest.json` (committed by the team's CI, D2 — excerpt). Every entry §5's inference produced — placements, per-component topology, source mapping — appears here explicitly; inference is synth-time only (D8):

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

The team merged one PR. The commander applied it once. Every domain the service is placed in — including the one behind the CDS — runs the pipeline against its own executor, and no repo, credential, or binding crossed any boundary to make that true.
