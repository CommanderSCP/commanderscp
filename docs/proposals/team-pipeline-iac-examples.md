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

```ts
import { App, Stack, Service, Component, Placement, Team, DeploymentTarget } from "@scp/iac";
import { Pipeline, waves } from "@scp/iac"; // (new) composite construct + helpers

const app = new App();
const stack = new Stack(app, "team-payments");

// -- the service and its components -----------------------------------------
const payments = new Service(stack, "payments", {
  owner: Team.ref("team-payments"),
});
const api = new Component(stack, "payments-api", { service: payments });
const worker = new Component(stack, "payments-worker", { service: payments });

// -- where they run: placements = component × stage --------------------------
const stages = [
  DeploymentTarget.ref("commercial-amer-staging"),
  DeploymentTarget.ref("commercial-amer-prod"),
  DeploymentTarget.ref("commercial-emea-prod"),
  DeploymentTarget.ref("govcloud-amer-prod"),
  DeploymentTarget.ref("airgap1-prod"),
];
for (const component of [api, worker])
  for (const target of stages)
    new Placement(stack, `${component.id}@${target.id}`, { component, target });

// -- the pipeline: waves of stages, attached once at the service rung ---------
new Pipeline(stack, "payments-pipeline", {
  attachTo: payments, // releases_via at the service rung — both components inherit
  waves: [
    { name: "staging", targets: ["commercial-amer-staging"] },
    { name: "prod-amer", targets: ["commercial-amer-prod"] },
    { name: "prod-emea", targets: ["commercial-emea-prod"] },
    // one wave, two stages, two security domains: advancing it is an ordinary
    // promotion into govcloud and a cross-domain promotion into airgap1 — the
    // CDS gate (scan/sign at the commander) applies per crossing, not per wave.
    { name: "regulated", mode: "parallel", targets: ["govcloud-amer-prod", "airgap1-prod"] },
  ],
});

// -- routing: which pushes drive this pipeline (source_mappings) --------------
stack.sourceMapping({
  repo: "git.corp.example/payments/payments-api",
  ref: "refs/heads/main",
  component: api,
  type: "configuration",
});
// The dev branch is NOT mapped here: dev pipelines are domain-local (ADR-0030)
// and belong to a domain-local stack, not the global promotion path.
```

Team members never mention an executor, a credential, or an outpost: the WHAT above federates everywhere, and §4's per-domain policies supply the HOW.

**The widening pattern (1 → 2 → 4 → 8):** when prod is many targets rather than three, the helper builds the fan-out:

```ts
const prodTargets = regions.map((r) => DeploymentTarget.ref(`commercial-${r}-prod`));
new Pipeline(stack, "payments-pipeline", {
  attachTo: payments,
  waves: [
    { name: "staging", targets: ["commercial-amer-staging"] },
    ...waves.widening(prodTargets, { start: 1, factor: 2 }), // 1, 2, 4, 8, … targets/wave
    { name: "regulated", mode: "parallel", targets: ["govcloud-amer-prod", "airgap1-prod"] },
  ],
});
```

(Canary *percentages within* a target stay the rollout executor's job — ADR-0008. SCP orders waves of stages; it does not orchestrate traffic weights.)

## 6. Synth output and delivery, node by node

`teams/payments/manifest.json` (committed by the team's CI, D2 — excerpt):

```json
{
  "stackName": "team-payments",
  "objects": [
    { "typeId": "service", "name": "payments", "…": "…" },
    { "typeId": "component", "name": "payments-api", "…": "…" },
    { "typeId": "release-topology", "name": "payments-pipeline",
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
