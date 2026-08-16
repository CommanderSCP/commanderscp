#!/usr/bin/env node
/**
 * Review fixture — populates a LOCAL dev instance so every UI page renders non-empty, and so that
 * across pages most states/options appear at least once.
 *
 * NOT the demo seed. `apps/server/src/seed.ts` (`pnpm seed`) is the charter's five-minute-value
 * path and is under test; this is a throwaway breadth fixture for looking at the UI. Everything
 * goes through the PUBLIC API (charter principle 3) — no direct SQL — so anything it can create,
 * a user can too.
 *
 * Idempotent: every object is upserted by URN, so re-running converges instead of duplicating.
 *
 * USAGE
 *   node scripts/seed-review-fixture.mjs [baseUrl] [username] [password]
 *     baseUrl   default http://localhost:8080 (the COMMANDER review instance)
 *     username  default admin
 *     password  default $SCP_ADMIN_PASSWORD (the bootstrap one-time password the server printed)
 *
 * PAIRING: this is the commander half of the review pair. The outpost half — the objects that exist
 * only at the outpost site (field-cluster, the field/* mirror mappings, field-registry) — is
 * `scripts/seed-outpost-fixture.mjs`, run against the outpost instance (default :8082) AFTER this
 * one has run and the federation import has brought checkout-api across.
 */

const BASE = process.argv[2] ?? "http://localhost:8080";
const USER = process.argv[3] ?? "admin";
const PASS = process.argv[4] ?? process.env.SCP_ADMIN_PASSWORD;

if (!PASS) {
  console.error("usage: node scripts/seed-review-fixture.mjs [baseUrl] [user] [password]");
  console.error("   (or set SCP_ADMIN_PASSWORD)");
  process.exit(2);
}

let cookie = "";
const created = [];
const failed = [];

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const err = new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`
    );
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Upsert-by-URN, the idempotent write every typed registry exposes. */
async function put(resource, urn, body, label) {
  try {
    const out = await api("PUT", `/${resource}/${encodeURIComponent(urn)}`, body);
    created.push(`${resource}: ${label ?? urn}`);
    return out;
  } catch (e) {
    failed.push(`${resource} ${label ?? urn}: ${e.message}`);
    return undefined;
  }
}

/** POST that tolerates "already exists" so a re-run is a no-op rather than a failure. */
async function post(path, body, label) {
  try {
    const out = await api("POST", path, body);
    created.push(`${path}: ${label}`);
    return out;
  } catch (e) {
    if (e.status === 409) {
      created.push(`${path}: ${label} (exists)`);
      return undefined;
    }
    failed.push(`${path} ${label}: ${e.message}`);
    return undefined;
  }
}

const urn = (type, slug) => `urn:scp:default:${type}:${slug}`;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400_000).toISOString();

async function main() {
  await api("POST", "/auth/login", { username: USER, password: PASS });
  console.log("logged in");

  // ---------------------------------------------------------------- identity
  // The Identity page shows four counts; all four must be non-zero, and groups/service-accounts
  // were the two that were empty.
  for (const [slug, name] of [
    ["platform-team", "Platform Team"],
    ["payments-team", "Payments Team"],
    ["sre-team", "SRE"]
  ]) {
    await put("teams", urn("team", slug), { name });
  }
  for (const [slug, name] of [
    ["oncall", "On-call"],
    ["security-reviewers", "Security Reviewers"]
  ]) {
    await put("groups", urn("group", slug), { name });
  }
  for (const [slug, name] of [
    ["dana", "dana"],
    ["kai", "kai"]
  ]) {
    await put("users", urn("user", slug), { name });
  }
  for (const [slug, name] of [
    ["ci-bot", "ci-bot"],
    ["scanner-bot", "scanner-bot"]
  ]) {
    await put("service-accounts", urn("service-account", slug), { name });
  }

  // ------------------------------------------------------- deployment targets
  // Deliberately three DIFFERENT senses of the (intentionally broad) type — a cluster, a region
  // and a host — so the page shows the breadth the GLOSSARY warns about rather than three clusters.
  //
  // The SUBSTRATE FACET (pipeline-substrate-registry-scan.md §9.1, migration 0065): typed optional
  // `substrate / account / region / cluster` strings on the target's properties, so the stage tile
  // can answer "AWS or hardware? which account?" from STORED data — never from the name. Four AWS
  // targets in one account and two hardware-ish ones with no account, so both answers are visible.
  // `PUT` REPLACES the properties bag (objects-repo upsert), so every body carries the whole facet —
  // a `{name}`-only PUT on an existing row would silently reset it to `{}`. The existing bag is READ
  // first and the facet layered on (the same discipline as `seed-outpost-fixture.mjs`), so a
  // property a reviewer hand-added to a target survives a re-run; the fixture is authoritative for
  // its own four keys only. A 404 on the read is a fresh target — an empty bag.
  // `environment` is deliberately NOT set: a target with BOTH environment and region non-empty is
  // a "declared region target" and reconcile REFUSES its deploys without a region binding (M15.6
  // regional gate) — the facet must describe the place, not arm a gate the fixture has no binding
  // to satisfy.
  const AWS_ACCOUNT = "210987654321";
  const targets = {};
  for (const [slug, name, properties] of [
    [
      "gamma-cluster",
      "gamma-cluster (k8s)",
      { substrate: "aws", account: AWS_ACCOUNT, region: "us-east-1", cluster: "gamma-eks" }
    ],
    [
      "prod-cluster",
      "prod-cluster (k8s)",
      { substrate: "aws", account: AWS_ACCOUNT, region: "us-east-1", cluster: "prod-eks" }
    ],
    // Two prod REGIONS: the owner's example (2026-08-14) of what one wave legitimately fans out
    // to in parallel — "us-east-1-prod & us-west-1-prod in a single wave" — as opposed to gamma,
    // which is its OWN wave ahead of prod. Both are places checkout-api's prod wave deploys to.
    [
      "us-east-1-prod",
      "us-east-1-prod (k8s)",
      { substrate: "aws", account: AWS_ACCOUNT, region: "us-east-1", cluster: "prod-eks" }
    ],
    [
      "us-west-1-prod",
      "us-west-1-prod (k8s)",
      { substrate: "aws", account: AWS_ACCOUNT, region: "us-west-1", cluster: "prod-eks-west" }
    ],
    // The hardware-ish pair: no account, no cluster — the tile joins only what is present.
    ["edge-eu", "edge-eu (region)", { substrate: "vm" }],
    ["build-host-01", "build-host-01 (host)", { substrate: "bare-metal" }]
  ]) {
    const targetUrn = urn("deployment-target", slug);
    let existingProperties = {};
    try {
      const existing = await api("GET", `/deployment-targets/${encodeURIComponent(targetUrn)}`);
      if (existing?.properties && typeof existing.properties === "object") {
        existingProperties = existing.properties;
      }
    } catch (e) {
      if (e.status !== 404) {
        failed.push(`deployment-targets ${targetUrn} (read before PUT): ${e.message}`);
        continue;
      }
    }
    const t = await put("deployment-targets", targetUrn, {
      name,
      properties: { ...existingProperties, ...properties }
    });
    if (t) targets[slug] = t.id;
  }

  // ------------------------------------------------------------------ catalog
  const services = {};
  for (const [slug, name] of [
    ["checkout", "checkout"],
    ["payments-gateway", "payments-gateway"],
    ["identity", "identity"],
    ["ledger", "ledger"],
    ["notifications", "notifications"]
  ]) {
    const s = await put("services", urn("service", slug), { name });
    if (s) services[slug] = s.id;
  }

  // One service WITH an assembly rung and one WITHOUT — the optional level has to be visibly
  // optional, which is the whole point of it (GLOSSARY §assembly).
  const assemblies = {};
  for (const [slug, name] of [
    ["checkout-core", "checkout-core"],
    ["ledger-core", "ledger-core"]
  ]) {
    const a = await put("assemblies", urn("assembly", slug), { name });
    if (a) assemblies[slug] = a.id;
  }

  // An assembly must be CONTAINED by a service or its components are orphaned from the service
  // board — the board walks containment down from the service, so a standalone assembly renders
  // as an empty service with an invisible subtree. `contains` is an ordinary (non-system-managed)
  // relationship, so this is a plain edge write, the same one the API offers any user.
  const assemblyParent = { "checkout-core": "checkout", "ledger-core": "ledger" };
  for (const [asmSlug, svcSlug] of Object.entries(assemblyParent)) {
    if (!assemblies[asmSlug] || !services[svcSlug]) continue;
    await post(
      "/relationships",
      { typeId: "contains", fromId: services[svcSlug], toId: assemblies[asmSlug] },
      `${svcSlug} contains ${asmSlug}`
    );
  }

  const components = {};
  const componentSpec = [
    ["checkout-api", "checkout"],
    ["checkout-worker", "checkout"],
    ["payments-gateway-api", "payments-gateway"],
    ["identity-api", "identity"],
    ["identity-session-store", "identity"],
    ["ledger-ingest", "ledger"],
    ["ledger-reconciler", "ledger"],
    ["notifications-dispatcher", "notifications"]
  ];
  for (const [slug, svc] of componentSpec) {
    const c = await put("components", urn("component", slug), {
      name: slug,
      service: urn("service", svc)
    });
    if (c) components[slug] = c.id;
  }

  // Put two components under an assembly so the Assembly board has rows, and leave the rest
  // directly under their service so both containment shapes are visible.
  for (const slug of ["ledger-ingest", "ledger-reconciler"]) {
    if (!components[slug]) continue;
    try {
      await api("PUT", `/components/${encodeURIComponent(urn("component", slug))}/service`, {
        service: urn("assembly", "ledger-core")
      });
      created.push(`containment: ${slug} -> ledger-core`);
    } catch (e) {
      failed.push(`containment ${slug}: ${e.message}`);
    }
  }

  // --------------------------------------------------------------- placements
  // Same component in TWO stages (gamma + prod) so a component journey has more than one stage,
  // and one component placed in only ONE stage so the honest "not placed" rendering appears.
  const placements = [
    ["checkout-api", "gamma-cluster"],
    ["checkout-api", "prod-cluster"],
    ["checkout-api", "us-east-1-prod"],
    ["checkout-api", "us-west-1-prod"],
    ["checkout-worker", "gamma-cluster"],
    ["payments-gateway-api", "gamma-cluster"],
    ["payments-gateway-api", "prod-cluster"],
    ["identity-api", "prod-cluster"],
    ["notifications-dispatcher", "edge-eu"]
  ];
  for (const [c, t] of placements) {
    if (!components[c] || !targets[t]) continue;
    await post(
      "/placements",
      { component: components[c], deploymentTarget: targets[t] },
      `${c}@${t}`
    );
  }

  // ------------------------------------------------ release topology (waves, in order)
  // Owner rule (2026-08-14): "we can deploy to multiple targets (us-east-1-prod & us-west-1-prod)
  // in a single wave, but ideally gamma is in its own wave." Without a topology the pipeline view
  // can only show PLACEMENTS — every target under one label, which reads as "deploy everywhere
  // in parallel" and misled exactly that way. This is the honest journey: wave 1 = gamma alone;
  // wave 2 = prod, mode parallel, fanning out to prod-cluster + both regions. Attached to
  // checkout-api via releases_via (the same door component-pipeline.integration.test.ts uses).
  // Authored HERE, at the commander — a topology is a graph object, so it replicates to outposts
  // as a read-only replica like any other, which is what makes the outpost render the same
  // ordered journey for its own targets.
  if (components["checkout-api"] && targets["gamma-cluster"] && targets["us-east-1-prod"]) {
    const topo = await put(
      "objects/release-topology",
      urn("release-topology", "checkout-gamma-then-prod"),
      {
        name: "checkout-gamma-then-prod",
        properties: {
          waves: [
            { name: "gamma", mode: "parallel", targets: [targets["gamma-cluster"]] },
            {
              name: "prod",
              mode: "parallel",
              targets: [
                targets["prod-cluster"],
                targets["us-east-1-prod"],
                targets["us-west-1-prod"]
              ]
            }
          ]
        }
      },
      "release-topology checkout-gamma-then-prod (gamma → prod ∥ us-east-1 ∥ us-west-1)"
    );
    if (topo) {
      await post(
        "/relationships",
        { typeId: "releases_via", fromId: components["checkout-api"], toId: topo.id },
        "checkout-api releases_via checkout-gamma-then-prod"
      );
    }
  }

  // ------------------------------------------------------------------- health
  // ADR-0008 health is PUSHED — SCP never probes. Three of the four states are pushed here and
  // the rest of the estate is deliberately left `unknown`, because "nothing has reported" is the
  // honest default and the UI has to render it as its own thing, not as green.
  const health = [
    ["service", "checkout", "degraded", "p99 latency above SLO on the gamma stage"],
    ["service", "identity", "healthy", "all probes green"],
    ["component", "ledger-ingest", "down", "consumer lag unbounded since 14:02"],
    ["component", "checkout-api", "healthy", "all probes green"]
  ];
  for (const [type, slug, status, detail] of health) {
    try {
      await api("PUT", `/objects/${type}/${encodeURIComponent(urn(type, slug))}/health`, {
        status,
        detail,
        source: "review-fixture"
      });
      created.push(`health: ${slug}=${status}`);
    } catch (e) {
      failed.push(`health ${slug}: ${e.message}`);
    }
  }

  // ------------------------------------------------------------------ freezes
  // `/freezes` has no upsert-by-URN and no DELETE, so a naive re-run accumulates duplicates.
  // Check first — the fixture has to converge, not grow.
  const existingFreezes = new Set(
    ((await api("GET", "/freezes?limit=100"))?.items ?? []).map((f) => f.name)
  );
  // One ACTIVE and one IMPENDING (inside the 14-day window the dashboard design uses), so both
  // renderings have data.
  if (services["payments-gateway"] && !existingFreezes.has("Peak season freeze")) {
    await post(
      "/freezes",
      {
        scopeObjectId: services["payments-gateway"],
        name: "Peak season freeze",
        startsAt: iso(-2),
        endsAt: iso(4),
        reason: "Retail peak — no payments changes without an override"
      },
      "active freeze (payments-gateway)"
    );
  }
  if (services["ledger"] && !existingFreezes.has("Q3 financial close")) {
    await post(
      "/freezes",
      {
        scopeObjectId: services["ledger"],
        name: "Q3 financial close",
        startsAt: iso(11),
        endsAt: iso(18),
        reason: "Books close — ledger is frozen for the window"
      },
      "impending freeze (ledger, +11d)"
    );
  }

  // ------------------------------------------------------------------ changes
  // Spread across the ROUTING TYPES (ADR-0007) so the per-pipeline lanes differ between rows:
  // a software/image change, an infrastructure change, a configuration change, and an emergency.
  const changeSpec = [
    ["Ship checkout-api v2.3.1", ["checkout-api"], "image", false],
    ["Patch base AMI across clusters", ["ledger-ingest"], "infrastructure", false],
    ["Roll log4j bump", ["identity-api"], "configuration", false],
    ["identity-api hotfix", ["identity-api"], "image", true]
  ];
  for (const [name, targetSlugs, type, emergency] of changeSpec) {
    const ids = targetSlugs.map((s) => components[s]).filter(Boolean);
    if (!ids.length) continue;
    await post("/changes", { name, targets: ids, type, emergency }, name);
  }

  // ----------------------------------------------------------------- campaign
  // A campaign fans out one change per target — the "everyone upgrades" shape.
  const campaignTargets = ["checkout-api", "payments-gateway-api", "identity-api"]
    .map((s) => components[s])
    .filter(Boolean);
  if (campaignTargets.length) {
    await post(
      "/campaigns",
      {
        name: "Python 3.12 upgrade",
        description: "Move every service off 3.11 before the EOL date",
        targets: campaignTargets,
        type: "configuration"
      },
      "Python 3.12 upgrade"
    );
  }

  // ------------------------------------------------------------------ ownership
  // Owners across several services, and one service left deliberately UNOWNED — an unowned
  // service is a real and interesting state (nobody to route an approval to), not an oversight.
  const ownership = [
    ["checkout", "platform-team"],
    ["payments-gateway", "payments-team"],
    ["identity", "platform-team"],
    ["ledger", "sre-team"]
  ];
  for (const [svc, team] of ownership) {
    if (!services[svc]) continue;
    await post(
      `/services/${services[svc]}/owners`,
      { ownerIdOrUrn: urn("team", team) },
      `${svc} owned by ${team}`
    );
  }

  // --------------------------------------------------- source mappings + bindings
  // The component journey has a "Source code" section ("a push matching one of these rules starts
  // a release") and per-pipeline lanes that read "not bound" until an executor binding exists.
  // Both were empty, which made every journey look identical. Spread across the routing TYPES so
  // the three lanes differ between components rather than all showing the same thing.
  const mappings = [
    ["checkout-api", "github", "acme/checkout", "services/api/**", "image"],
    // The GLOBALLY SHARED inputs to checkout-api's pipeline (outpost-ui.md §9.3a, owner
    // 2026-08-14): the commander is the ONE place that knows the true shared repos — every outpost
    // sees only "source: the commander". The paired outpost fixture mirrors the first as
    // `field/mirror-of-shared-asg-iac` (mirrorOfShared) and overlays the second with its own
    // `field/checkout-overlays`; without these two here the commander's Infrastructure lane read
    // "no repo is mapped", which contradicted the very story the outpost tiles tell.
    ["checkout-api", "github", "acme/platform-iac", "asg/**", "infrastructure"],
    ["checkout-api", "github", "acme/checkout-config", "helm/**", "configuration"],
    ["checkout-worker", "github", "acme/checkout", "services/worker/**", "image"],
    ["identity-api", "github", "acme/identity", "**", "configuration"],
    ["ledger-ingest", "gitlab", "acme/ledger-infra", "terraform/**", "infrastructure"]
  ];
  // `POST .../mappings` has no upsert and does not 409 on an identical tuple, so a re-run silently
  // duplicates every rule — and the component journey renders each one, so the duplication is
  // visible. Read the existing set first and skip exact matches.
  const seenMappings = new Set();
  for (const sourceKind of new Set(mappings.map((m) => m[1]))) {
    const existing = (await api("GET", `/change-sources/${sourceKind}/mappings`)) ?? [];
    for (const m of Array.isArray(existing) ? existing : (existing.items ?? [])) {
      seenMappings.add([sourceKind, m.componentObjectId, m.repoPattern, m.pathPattern].join("|"));
    }
  }
  for (const [comp, sourceKind, repoPattern, pathPattern, type] of mappings) {
    if (!components[comp]) continue;
    const key = [sourceKind, components[comp], repoPattern, pathPattern].join("|");
    if (seenMappings.has(key)) {
      created.push(`mapping ${comp} <- ${repoPattern} (exists)`);
      continue;
    }
    await post(
      `/change-sources/${sourceKind}/mappings`,
      { sourceKind, component: components[comp], repoPattern, pathPattern, type },
      `mapping ${comp} <- ${repoPattern}`
    );
  }

  // Executor bindings make a pipeline lane read BOUND instead of "not bound". The config is
  // deliberately inert placeholder text: nothing here is ever dialled, and no secret is stored —
  // the binding exists so the UI has the bound case to render alongside the unbound one. Two
  // components are left entirely unbound on purpose, because "no executor" is a real state an
  // operator has to be able to recognise.
  // Each plugin validates its own config against its manifest's `configSchema`, so a binding
  // cannot be created with an empty config — these are the required fields, filled with obviously
  // fake values. They point at hosts that do not resolve, which is the intent: the binding is for
  // rendering, not for reaching anything.
  const bindings = [
    // checkout-api carries BOTH a build pipeline AND its own infrastructure pipeline (its S3
    // bucket, terraform'd) while RUNNING on clusters that platform-compute manages — the
    // owner's point (2026-08-12) that the sharing tiers COMPOSE per component: own bucket,
    // shared substrate, same journey.
    [
      "checkout-api",
      "infrastructure",
      "terraform",
      "acme/checkout-infra",
      {
        triggerUrl: "https://tfc.invalid/api/v2/runs"
      }
    ],
    [
      "checkout-api",
      "image",
      "github",
      "acme/checkout",
      {
        appId: "000000",
        installationId: "000000",
        owner: "acme",
        repo: "checkout"
      }
    ],
    [
      "identity-api",
      "configuration",
      "argocd",
      "identity-prod",
      {
        serverUrl: "https://argocd.invalid"
      }
    ],
    [
      "ledger-ingest",
      "infrastructure",
      "terraform",
      "acme/ledger-infra",
      {
        triggerUrl: "https://tfc.invalid/api/v2/runs"
      }
    ]
  ];
  for (const [comp, type, pluginModule, externalRef, config] of bindings) {
    if (!components[comp]) continue;
    try {
      await api("PUT", `/executors/${components[comp]}/binding`, {
        pluginModule,
        pluginInstanceId: `${pluginModule}-review-fixture`,
        type,
        externalRef,
        config
      });
      created.push(`binding: ${comp} -> ${pluginModule} (${type})`);
    } catch (e) {
      failed.push(`binding ${comp}: ${e.message}`);
    }
  }

  // ------------------------------------------ registry + artifact (substrate-registry-scan §9.5)
  // The commander's per-site image registry: an `execution-system` of kind gitea (ADR-0012's default
  // unified registry) created `domainLocal:true` — a registry is a place inside ONE security domain,
  // and the edge below never journals because one endpoint is domain-local, so each site's Delivery
  // lane names only its own registry (§9.2). It is NOT bound as an executor (a registry-kind system
  // cannot be: KNOWN_EXECUTOR_MODULES) — the `image` binding above is what BUILDS, this is where the
  // artifact LANDS, and `publishes_to` is the graph fact joining the two.
  // GET-then-create rather than PUT: `domainLocal:true` on a PUT is a precondition on re-runs and the
  // same one-way publish story as transit-gateway-attachments applies; a plain existence check keeps
  // this converging whatever a reviewer did to the row.
  const registryUrn = urn("execution-system", "hq-registry");
  let hqRegistry;
  try {
    hqRegistry = await api("GET", `/objects/execution-system/${encodeURIComponent(registryUrn)}`);
    created.push("execution-system: hq-registry (exists)");
  } catch (e) {
    if (e.status !== 404) {
      failed.push(`execution-system hq-registry: ${e.message}`);
    } else {
      try {
        hqRegistry = await api("POST", "/objects/execution-system", {
          urn: registryUrn,
          name: "hq-registry",
          properties: {
            kind: "gitea",
            serverUrl: "https://registry.hq.invalid",
            webUrl: "https://registry.hq.invalid"
          },
          domainLocal: true
        });
        created.push("execution-system: hq-registry (gitea, domain-local)");
      } catch (e2) {
        failed.push(`execution-system hq-registry: ${e2.message}`);
      }
    }
  }
  // checkout-api --publishes_to--> hq-registry {repository}. `POST /relationships` 409s on an exact
  // duplicate, but list the outgoing `publishes_to` edges first anyway: the projection states
  // `ambiguous` for >1 edge, and a fixture must never be the thing that makes it ambiguous.
  if (hqRegistry && components["checkout-api"]) {
    try {
      const edges =
        (
          await api(
            "GET",
            `/relationships?fromId=${components["checkout-api"]}&typeId=publishes_to&limit=100`
          )
        )?.items ?? [];
      if (edges.some((e) => e.toId === hqRegistry.id)) {
        created.push("relationship: checkout-api publishes_to hq-registry (exists)");
      } else {
        await post(
          "/relationships",
          {
            typeId: "publishes_to",
            fromId: components["checkout-api"],
            toId: hqRegistry.id,
            properties: { repository: "acme/checkout-api" }
          },
          "checkout-api publishes_to hq-registry (acme/checkout-api)"
        );
      }
    } catch (e) {
      failed.push(`relationship checkout-api publishes_to hq-registry: ${e.message}`);
    }
  }

  // A FIRST-PARTY CHANGE REPORT for checkout-api — the one typed ingress that carries an artifact
  // digest AND an SBOM reference (`POST /change-sources/{kind}/report`, M17.2). It matches the
  // `github acme/checkout services/api/**` mapping above, so the next reconcile tick correlates it
  // into an `image` change of checkout-api whose `sourceRef` holds `artifact_digest` + `sbom` — the
  // stored facts the Build and Registry tiles read (§9.3). SCP stores the SBOM REFERENCE only, never
  // bytes; the location is a stable non-resolving URL, like every other host in this file.
  // Idempotent twice over: (1) the route dedupes an identical body by its hash (same event id back,
  // no second change) — so the body below is FIXED, nothing time-dependent in it; (2) belt and
  // braces, skip the POST when a change already carries this digest, so a later edit to the body
  // (or a different serialization) can never mint a second artifact for the same digest.
  const ARTIFACT_DIGEST = "sha256:9c1f2e6b0a4d5c8e7f3b2a1d0e9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c";
  const SBOM_DIGEST = "sha256:4e2a9d7c1b6f0e3a8c5d2b7f9a1e6c3d0b8f5a2e7c4d1b9f6a3e0c7d5b2f8a4e";
  if (components["checkout-api"]) {
    let alreadyReported = false;
    try {
      let cursor;
      do {
        const page = await api(
          "GET",
          `/changes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        );
        for (const ch of page?.items ?? []) {
          const ref = ch.sourceRef ?? {};
          const digest = ref.artifact_digest ?? ref.artifactDigest;
          const digests = Array.isArray(digest) ? digest : [digest];
          if (digests.includes(ARTIFACT_DIGEST)) alreadyReported = true;
        }
        cursor = page?.nextCursor ?? undefined;
      } while (cursor && !alreadyReported);
    } catch (e) {
      failed.push(`changes scan for reported digest: ${e.message}`);
    }
    if (alreadyReported) {
      created.push("change report: checkout-api artifact (change already carries the digest)");
    } else {
      await post(
        "/change-sources/github/report",
        {
          repo: "acme/checkout",
          path: "services/api/Dockerfile",
          ref: "refs/heads/main",
          status: "applied",
          artifactDigest: ARTIFACT_DIGEST,
          sbom: {
            format: "cyclonedx",
            specVersion: "1.5",
            digest: SBOM_DIGEST,
            location: "https://ci.acme.invalid/sbom/checkout-api.cdx.json",
            mediaType: "application/vnd.cyclonedx+json",
            scanner: "syft",
            scannerVersion: "1.4.1",
            generatedAt: "2026-08-15T09:30:00.000Z"
          }
        },
        "change report: checkout-api image (artifactDigest + cyclonedx SBOM ref) — correlated by the next reconcile tick"
      );
    }
  }
  // NO SCAN EVIDENCE IS SEEDED — the Scan & sign tile honestly reads "not run" for this artifact.
  // The designed org-pipeline path (M17.1) is: a `control` object bound via
  // `PUT /controls/{id}/binding {pluginModule:"scan-result-control", config:{url}}`, a `policy` with
  // `requireControls:[control]` firing at the prod wave, and the change reaching that wave gate,
  // whereupon the worker's PLUGIN HOST calls the plugin, which PULLS a Trivy result JSON from
  // `config.url` over host-mediated HTTP (packages/plugins/scan-result-control: "a scan verdict is
  // a resource to READ, not a context to POST" — there is no inbox to post a verdict to) and
  // deposits ScanEvidence. That is not reachable from this script: it needs a subprocess plugin-host
  // round trip against a Trivy JSON document served at a URL the SERVER can fetch (a `.invalid` or
  // private-IP URL fails CLOSED to a `fail` row, and the SSRF guard blocks private ranges), and the
  // change advancing to the prod wave. Seeding a control with an unreachable URL would deposit a
  // fail-closed `fail` verdict — evidence about the fixture's plumbing, not about the artifact — so
  // nothing is bound here (no direct SQL, no invented evidence; §9.5). The commander's other scan
  // writer, the managed scan step, runs only inside `POST /federation/exports/promotion`.

  // ------------------------------------------- shared infrastructure (proposal example)
  // The worked example for docs/proposals/shared-infrastructure-pipelines.md §3: genuinely shared
  // substrate modelled as a PLATFORM COMPONENT, linked to the deployment target it provisions by a
  // `manages` relationship type registered AT RUNTIME through the type registry — no migration,
  // which is the charter-principle-2 demonstration: a new concept arrives as registry data.
  const platformSvc = await put("services", urn("service", "platform-compute"), {
    name: "platform-compute"
  });
  const eks = await put("components", urn("component", "eks-gamma"), {
    name: "eks-gamma",
    service: urn("service", "platform-compute")
  });
  if (platformSvc) {
    await post(
      `/services/${platformSvc.id}/owners`,
      { ownerIdOrUrn: urn("team", "sre-team") },
      "platform-compute owned by sre-team"
    );
  }
  if (eks) {
    // Its ONLY pipeline is infrastructure — "shared infrastructure is somebody's application".
    try {
      await api("PUT", `/executors/${eks.id}/binding`, {
        pluginModule: "terraform",
        pluginInstanceId: "terraform-platform-fixture",
        type: "infrastructure",
        externalRef: "acme/platform-eks",
        config: { triggerUrl: "https://tfc.invalid/api/v2/runs" }
      });
      created.push("binding: eks-gamma -> terraform (infrastructure)");
    } catch (e) {
      failed.push(`binding eks-gamma: ${e.message}`);
    }
    // Register `manages` (component -> deployment-target) if this instance doesn't have it yet.
    try {
      await api("POST", "/type-registry/relationship-types", {
        id: "manages",
        displayName: "Manages",
        fromTypes: ["component"],
        toTypes: ["deployment-target"],
        cardinality: "many_to_many"
      });
      created.push("relationship type: manages (component -> deployment-target)");
    } catch (e) {
      if (e.status === 409) created.push("relationship type: manages (exists)");
      else failed.push(`relationship type manages: ${e.message}`);
    }
    for (const target of ["gamma-cluster", "prod-cluster"]) {
      if (!targets[target]) continue;
      await post(
        "/relationships",
        { typeId: "manages", fromId: eks.id, toId: targets[target] },
        `eks-gamma manages ${target}`
      );
    }
  }

  // ------------------------------------------------------ domain-local (M20, ADR-0031)
  // The canonical content class from the ADR: this domain's own network configuration-as-code —
  // authored here, reviewed here, deployed here, with NO upstream original. Declared at create;
  // `domainLocal` on the upsert is a PRECONDITION on re-runs (409 on mismatch, ADR-0031 §6), so
  // this stays idempotent. Gives the review instance a row wearing the domain-local badge, a
  // detail page with the one-way publish card, and (if published during review) the edge-sweep
  // report — the withheld bucket stays empty here because its only edge is to a shared service.
  // NOT the shared `put` helper: publish is one-way, so once a reviewer clicks Publish the
  // precondition `domainLocal: true` 409s forever — that is the API being honest (there is no
  // un-publish), not a fixture failure, so a 409 here is tolerated instead of recorded as failed.
  // (The urn is deliberately one that has NEVER existed shared on this instance: an urn that was
  // ever shared — even soft-deleted — refuses to come back domain-local, ADR-0031 §6.)
  try {
    await api(
      "PUT",
      `/components/${encodeURIComponent(urn("component", "transit-gateway-attachments"))}`,
      {
        name: "transit-gateway-attachments",
        service: urn("service", "platform-compute"),
        domainLocal: true
      }
    );
    created.push("components: transit-gateway-attachments (domain-local)");
  } catch (e) {
    if (e.status === 409)
      created.push(
        "components: transit-gateway-attachments (already shared — published during review, or created before M20; left as-is)"
      );
    else failed.push(`components transit-gateway-attachments: ${e.message}`);
  }

  // M20.5 (ADR-0031 §6a) — INHERITED locality: a domain-local SERVICE whose child component is
  // created WITHOUT the flag and inherits the bit at create, one hop. The component upsert
  // deliberately omits `domainLocal` (omitted = inheritance decides; an explicit `false` inside a
  // local container is a 400 by design), so re-runs assert no precondition and stay idempotent
  // whatever the pair's current state.
  try {
    await api("PUT", `/services/${encodeURIComponent(urn("service", "secure-partition"))}`, {
      name: "secure-partition",
      domainLocal: true
    });
    created.push("services: secure-partition (domain-local container)");
  } catch (e) {
    if (e.status === 409)
      created.push(
        "services: secure-partition (already shared — published during review; left as-is)"
      );
    else failed.push(`services secure-partition: ${e.message}`);
  }
  await put(
    "components",
    urn("component", "partition-route-tables"),
    { name: "partition-route-tables", service: urn("service", "secure-partition") },
    "partition-route-tables (inherits locality from secure-partition — flag never sent)"
  );
  // A second inheritor, created after M20.7 landed, so it carries the create-time provenance
  // stamp (`domainLocalInheritedFrom` → secure-partition) and the badge tooltip's "Inherited at
  // create from …" state is visible on the review instance. partition-route-tables predates the
  // stamp and shows null — which the M20.7 contract defines as "declared", an accepted cost of
  // stamping at create only (no invented history for legacy rows).
  await put(
    "components",
    urn("component", "partition-nat-gateways"),
    { name: "partition-nat-gateways", service: urn("service", "secure-partition") },
    "partition-nat-gateways (inherits + carries the M20.7 provenance stamp)"
  );

  // ------------------------------------------------ nested domains (outpost-ui.md §5(b))
  // Owner decision 2026-08-13: containment domains nest. One top-level domain and one SUBDOMAIN
  // created inside it (domainId parent — route 1), so the domains registry shows the nesting and
  // the create form's parent-domain picker has real rows to offer. Both shared (not domain-local):
  // the locality-inheritance demo already lives on secure-partition above, and mixing the two here
  // would make it unclear which property the pair demonstrates.
  const usRegion = await put("domains", urn("domain", "us-region"), { name: "us-region" });
  if (usRegion) {
    await put(
      "domains",
      urn("domain", "us-east-enclave"),
      { name: "us-east-enclave", domainId: usRegion.id },
      "us-east-enclave (subdomain of us-region)"
    );
  }

  // --------------------------------------------------------------- federation
  // Federation status and Outposts render nothing until this instance has an identity and at
  // least one peer. Three peers across three TRUST TIERS (a commercial one, a FedRAMP one and an
  // IL5 one) so the tier-dependent rendering has more than one case to show. No real crypto is
  // involved: these peers are never dialled, they exist so the pages have rows.
  try {
    await api("POST", "/federation/init", { name: "hq-commander", role: "commander" });
    created.push("federation: self initialised as commander");
  } catch (e) {
    if (e.status !== 409) failed.push(`federation init: ${e.message}`);
  }
  const { generateKeyPairSync, randomUUID } = await import("node:crypto");
  // `GET /federation/peers` returns a BARE ARRAY, not the `{items}` page shape the typed
  // registries use — reading `.items` off it silently yielded an empty set, so a re-run minted a
  // fresh domainId for a peer that already existed and then failed to declare an outpost against
  // an unpaired id. Reuse the peer's OWN id when it is already there.
  const peerIdByName = new Map(
    ((await api("GET", "/federation/peers")) ?? []).map((p) => [p.name, p.id])
  );
  // Peer names are TRUST x GEOGRAPHY, never environments (owner, 2026-08-12): an outpost serves a
  // whole security domain as its release-and-testing mechanism; dev/gamma/prod are STAGES inside a
  // domain. The first cut named one "gamma-outpost", which encoded exactly that confusion.
  for (const [name, trustTier] of [
    ["commercial-us", "commercial"],
    ["prod-highside", "il5"],
    ["eu-edge", "fedramp-high"]
  ]) {
    let domainId = peerIdByName.get(name);
    if (!domainId) {
      domainId = randomUUID();
      const publicKey = generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString()
        .trim();
      await post(
        "/federation/peers",
        { domainId, name, role: "outpost", publicKey },
        `peer ${name}`
      );
    }
    await post(
      "/federation/outposts",
      { peerDomainId: domainId, name, trustTier },
      `outpost ${name} (${trustTier})`
    );
  }

  // THE REAL PAIRED OUTPOST (pipeline-substrate-registry-scan.md §10.2). The three fixture outposts
  // above bind to fixture peers that are never dialled; the review pair's actual outpost (:8082,
  // paired by hand as `field-outpost`) has a peer row but, until now, NO `outpost` object — so
  // every target it authored (field-cluster) read "peer field-outpost — no outpost record" on the
  // pipeline tiles. Register the object against THAT peer's id, read off `GET /federation/peers`
  // (never minted here — the pairing owns the id), idempotent GET-then-create. If the pair has not
  // been made on this instance, say so and move on: the fixture must not invent a peer.
  {
    const fieldPeer = ((await api("GET", "/federation/peers")) ?? []).find(
      (p) => p.name === "field-outpost" && p.role === "outpost"
    );
    if (!fieldPeer) {
      console.log(
        "  - skip: no paired peer named 'field-outpost' with role 'outpost' — the field-cluster " +
          "tiles will read 'peer … no outpost record' / 'origin domain not known here' until the " +
          "review pair is paired ('scp federation pair')"
      );
    } else {
      let existing;
      try {
        existing = await api("GET", `/federation/outposts/${fieldPeer.id}`);
      } catch (e) {
        if (e.status !== 404) failed.push(`outpost field-outpost lookup: ${e.message}`);
      }
      if (existing) {
        created.push(`/federation/outposts: outpost field-outpost (il5) (exists)`);
      } else {
        await post(
          "/federation/outposts",
          { peerDomainId: fieldPeer.id, name: "field-outpost", trustTier: "il5" },
          "outpost field-outpost (il5) — the real paired outpost"
        );
      }
    }
  }

  console.log(`\n=== created/upserted (${created.length}) ===`);
  for (const c of created) console.log("  +", c);
  if (failed.length) {
    console.log(`\n=== FAILED (${failed.length}) ===`);
    for (const f of failed) console.log("  !", f);
  }
}

main().catch((e) => {
  console.error("fixture failed:", e.message);
  process.exit(1);
});
