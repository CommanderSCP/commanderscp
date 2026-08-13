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
 *   node scripts/seed-review-fixture.mjs [baseUrl] [username] [password]
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
    const err = new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
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
  const targets = {};
  for (const [slug, name] of [
    ["gamma-cluster", "gamma-cluster (k8s)"],
    ["prod-cluster", "prod-cluster (k8s)"],
    ["edge-eu", "edge-eu (region)"],
    ["build-host-01", "build-host-01 (host)"]
  ]) {
    const t = await put("deployment-targets", urn("deployment-target", slug), { name });
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
    const c = await put("components", urn("component", slug), { name: slug, service: urn("service", svc) });
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
    ["checkout-worker", "gamma-cluster"],
    ["payments-gateway-api", "gamma-cluster"],
    ["payments-gateway-api", "prod-cluster"],
    ["identity-api", "prod-cluster"],
    ["notifications-dispatcher", "edge-eu"]
  ];
  for (const [c, t] of placements) {
    if (!components[c] || !targets[t]) continue;
    await post("/placements", { component: components[c], deploymentTarget: targets[t] }, `${c}@${t}`);
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
    ["checkout-api", "infrastructure", "terraform", "acme/checkout-infra", {
      triggerUrl: "https://tfc.invalid/api/v2/runs"
    }],
    ["checkout-api", "image", "github", "acme/checkout", {
      appId: "000000",
      installationId: "000000",
      owner: "acme",
      repo: "checkout"
    }],
    ["identity-api", "configuration", "argocd", "identity-prod", {
      serverUrl: "https://argocd.invalid"
    }],
    ["ledger-ingest", "infrastructure", "terraform", "acme/ledger-infra", {
      triggerUrl: "https://tfc.invalid/api/v2/runs"
    }]
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

  // ------------------------------------------- shared infrastructure (proposal example)
  // The worked example for docs/proposals/shared-infrastructure-pipelines.md §3: genuinely shared
  // substrate modelled as a PLATFORM COMPONENT, linked to the deployment target it provisions by a
  // `manages` relationship type registered AT RUNTIME through the type registry — no migration,
  // which is the charter-principle-2 demonstration: a new concept arrives as registry data.
  const platformSvc = await put("services", urn("service", "platform-compute"), {
    name: "platform-compute"
  });
  const eks = await put(
    "components",
    urn("component", "eks-gamma"),
    { name: "eks-gamma", service: urn("service", "platform-compute") }
  );
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
      created.push("services: secure-partition (already shared — published during review; left as-is)");
    else failed.push(`services secure-partition: ${e.message}`);
  }
  await put(
    "components",
    urn("component", "partition-route-tables"),
    { name: "partition-route-tables", service: urn("service", "secure-partition") },
    "partition-route-tables (inherits locality from secure-partition — flag never sent)"
  );

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
      await post("/federation/peers", { domainId, name, role: "outpost", publicKey }, `peer ${name}`);
    }
    await post(
      "/federation/outposts",
      { peerDomainId: domainId, name, trustTier },
      `outpost ${name} (${trustTier})`
    );
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
