#!/usr/bin/env node
/**
 * Outpost review fixture — the OUTPOST half of the review pair (pipeline-substrate-registry-scan.md
 * §9.5). It (re)creates the objects that exist ONLY at the outpost site and, until this script,
 * existed only by hand on the :8082 instance: the outpost's own deployment target with its
 * substrate facet, checkout-api's three field/* source mappings (one a mirror of a commander-shared
 * repo), the placement of checkout-api on that target, the outpost's own image registry and the
 * `publishes_to` edge naming it.
 *
 * Everything goes through the PUBLIC API (charter principle 3) — no direct SQL. Idempotent by
 * GET-then-create: every object is looked up first and only created when absent, so a re-run
 * converges instead of duplicating (mappings and placements have no upsert-by-URN; the registry
 * is `domainLocal:true`, which a PUT would assert as a precondition).
 *
 * checkout-api is NOT created here — at an outpost it exists only as the commander's replica,
 * brought across by the federation import. If it is absent the script says so and skips every
 * object that depends on it, rather than inventing a second checkout-api. The same goes for this
 * outpost's OWN `outpost` record (pipeline-substrate-registry-scan.md §10.5): it is
 * commander-authored (`field-outpost`, declared by the commander fixture) and arrives replicated —
 * declaring one here would be a second writer for it. Once replicated, this site's own targets
 * read `Outpost field-outpost · il5` on their pipeline tiles (object-first resolution).
 *
 * USAGE
 *   node scripts/seed-outpost-fixture.mjs [baseUrl] [username] [password]
 *     baseUrl   default http://localhost:8082 (the OUTPOST review instance)
 *     username  default admin
 *     password  default $SCP_ADMIN_PASSWORD (the bootstrap one-time password the server printed)
 *
 * PAIRING: run `scripts/seed-review-fixture.mjs` against the commander (:8080) first, let the
 * federation import bring checkout-api across, then run this one against the outpost.
 */

const BASE = process.argv[2] ?? "http://localhost:8082";
const USER = process.argv[3] ?? "admin";
const PASS = process.argv[4] ?? process.env.SCP_ADMIN_PASSWORD;

if (!PASS) {
  console.error("usage: node scripts/seed-outpost-fixture.mjs [baseUrl] [user] [password]");
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

/** GET by id-or-URN, returning `undefined` on 404 and throwing on anything else. */
async function getOr404(path) {
  try {
    return await api("GET", path);
  } catch (e) {
    if (e.status === 404) return undefined;
    throw e;
  }
}

/** Walk a cursor-paged list to the end. */
async function listAll(path) {
  const out = [];
  let cursor;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const page = await api(
      "GET",
      `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    out.push(...(page?.items ?? []));
    cursor = page?.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

async function main() {
  await api("POST", "/auth/login", { username: USER, password: PASS });
  console.log("logged in");

  // ------------------------------------------------------------- checkout-api (replica)
  // The component is the commander's, imported by federation under the commander's URN. Resolve by
  // the well-known URN first, then by exact name across the list — never create it. The org
  // namespace of every URN this script mints is taken from the replica's own URN, so a pair whose
  // org is not literally "default" still gets consistent URNs.
  let checkoutApi = await getOr404(
    `/components/${encodeURIComponent("urn:scp:default:component:checkout-api")}`
  );
  if (!checkoutApi) {
    const all = await listAll("/components");
    const byName = all.filter((c) => c.name === "checkout-api");
    if (byName.length === 1) checkoutApi = byName[0];
    else if (byName.length > 1)
      console.log(
        `! ${byName.length} components named checkout-api — refusing to guess; skipping the checkout-api dependents`
      );
  }
  const orgNs = (checkoutApi?.urn ?? "").split(":")[2] || "default";
  const urn = (type, slug) => `urn:scp:${orgNs}:${type}:${slug}`;
  if (!checkoutApi) {
    console.log(
      "! checkout-api is not present on this instance (it arrives only via the federation import " +
        "from the commander) — the mappings, placement and publishes_to edge that depend on it are SKIPPED; " +
        "field-cluster and field-registry are still created."
    );
  } else {
    created.push(`component: checkout-api resolved (${checkoutApi.urn})`);
  }

  // ------------------------------------------------------------- field-cluster (target)
  // The outpost's own on-prem k8s — the SUBSTRATE FACET (§9.1) says `kubernetes`, cluster
  // `field-eks`, no account: the "hardware, not AWS" answer beside the commander's AWS targets.
  // Measured first: the live outpost already has one by hand — match its URN slug or its name so
  // this never duplicates it, and PUT by ITS urn with ITS name. PUT replaces the properties bag, so
  // the existing bag is carried through with the facet layered on. `domainLocal` is deliberately
  // omitted on the PUT (omitted = no precondition, ADR-0031 §6), so an existing row keeps whatever
  // locality it was created with; a fresh one is a plain target, like the commander fixture's.
  // `environment` is NOT set (M15.6 regional gate arms on environment+region both non-empty).
  const FIELD_FACET = { substrate: "kubernetes", cluster: "field-eks" };
  let fieldCluster;
  try {
    const existingTargets = await listAll("/deployment-targets");
    const match =
      existingTargets.find((t) => t.urn?.endsWith(":deployment-target:field-cluster")) ??
      existingTargets.find((t) => t.name === "field-cluster (k8s)") ??
      existingTargets.find((t) => typeof t.name === "string" && t.name.startsWith("field-cluster"));
    const targetUrn = match?.urn ?? urn("deployment-target", "field-cluster");
    const name = match?.name ?? "field-cluster (k8s)";
    fieldCluster = await api("PUT", `/deployment-targets/${encodeURIComponent(targetUrn)}`, {
      name,
      properties: { ...(match?.properties ?? {}), ...FIELD_FACET }
    });
    created.push(
      `deployment-targets: ${name} ${match ? "(existing, facet set)" : "(created)"} — ${JSON.stringify(FIELD_FACET)}`
    );
  } catch (e) {
    failed.push(`deployment-target field-cluster: ${e.message}`);
  }

  // ------------------------------------------------ source mappings (outpost-ui.md §9.3a)
  // The outpost's OWN repos for checkout-api's pipeline, in its own gitea: a MIRROR of the
  // commander-shared ASG IaC (`mirrorOfShared` — "source: the commander"), the outpost's own network
  // CIDR IaC, and its own config overlays. `POST .../mappings` has no upsert and does not 409 on an
  // identical tuple, so read the existing set first and skip exact matches — the same discipline as
  // the commander fixture, and for the same reason (the journey renders every rule).
  //
  // §10.6: every `field/*` mapping is `scope: "domain"` — tracked only in this domain. The mirror
  // KEEPS `mirrorOfShared` and is ALSO `domain` scope (the two are orthogonal: a domain-scope row
  // that mirrors a global one; the tile's eyebrow lets the mirror win). Existing rows that pre-date
  // 0066 sit at scope NULL — converged with the by-id scope PATCH so a re-run is idempotent.
  if (checkoutApi) {
    const mappings = [
      ["gitea", "field/mirror-of-shared-asg-iac", "asg/**", "infrastructure", true],
      ["gitea", "field/checkout-network-cidr", "cidr/**", "infrastructure", false],
      ["gitea", "field/checkout-overlays", "prod/**", "configuration", false]
    ];
    const seen = new Map();
    try {
      const existing = (await api("GET", "/change-sources/gitea/mappings")) ?? [];
      for (const m of Array.isArray(existing) ? existing : (existing.items ?? [])) {
        seen.set([m.componentObjectId, m.repoPattern, m.pathPattern].join("|"), m);
      }
    } catch (e) {
      failed.push(`list gitea mappings: ${e.message}`);
    }
    for (const [sourceKind, repoPattern, pathPattern, type, mirrorOfShared] of mappings) {
      const key = [checkoutApi.id, repoPattern, pathPattern].join("|");
      const existing = seen.get(key);
      if (existing) {
        if (existing.scope === "domain") {
          created.push(`mapping checkout-api <- ${repoPattern} (exists, scope domain)`);
          continue;
        }
        try {
          await api("PATCH", `/change-sources/${sourceKind}/mappings/${existing.id}/scope`, {
            scope: "domain"
          });
          created.push(`mapping checkout-api <- ${repoPattern} (exists; scope -> domain)`);
        } catch (e) {
          failed.push(`set scope on mapping checkout-api <- ${repoPattern}: ${e.message}`);
        }
        continue;
      }
      await post(
        `/change-sources/${sourceKind}/mappings`,
        {
          sourceKind,
          component: checkoutApi.id,
          repoPattern,
          pathPattern,
          type,
          scope: "domain",
          ...(mirrorOfShared ? { mirrorOfShared: true } : {})
        },
        `mapping checkout-api <- ${repoPattern} (scope domain${mirrorOfShared ? ", mirror of shared" : ""})`
      );
    }
  }

  // ------------------------------------------------------------------- placement
  // checkout-api runs on field-cluster. `POST /placements` 409s on a duplicate pair, so a re-run is
  // a tolerated no-op.
  if (checkoutApi && fieldCluster) {
    await post(
      "/placements",
      { component: checkoutApi.id, deploymentTarget: fieldCluster.id },
      "checkout-api@field-cluster"
    );
  }

  // ------------------------------------------------- field-registry (§9.2, domain-local)
  // The outpost's OWN image registry: an `execution-system` of kind gitea created `domainLocal:true`
  // — a registry is a place inside one security domain; the `publishes_to` edge below never journals
  // because one endpoint is domain-local, so this site's Delivery lane names ONLY this registry and
  // the commander's names only hq-registry. Not bound as an executor (a registry-kind system cannot
  // be). GET-then-create: `domainLocal:true` on a PUT is a precondition on re-runs.
  const registryUrn = urn("execution-system", "field-registry");
  let fieldRegistry;
  try {
    fieldRegistry = await getOr404(`/objects/execution-system/${encodeURIComponent(registryUrn)}`);
    if (fieldRegistry) {
      created.push("execution-system: field-registry (exists)");
    } else {
      fieldRegistry = await api("POST", "/objects/execution-system", {
        urn: registryUrn,
        name: "field-registry",
        properties: {
          kind: "gitea",
          serverUrl: "https://registry.field.invalid",
          webUrl: "https://registry.field.invalid"
        },
        domainLocal: true
      });
      created.push("execution-system: field-registry (gitea, domain-local)");
    }
  } catch (e) {
    failed.push(`execution-system field-registry: ${e.message}`);
  }

  // checkout-api --publishes_to--> field-registry {repository}. Listed first: the projection states
  // `ambiguous` for >1 edge at a site, and the fixture must never be what makes it so.
  if (checkoutApi && fieldRegistry) {
    try {
      const edges =
        (await api("GET", `/relationships?fromId=${checkoutApi.id}&typeId=publishes_to&limit=100`))
          ?.items ?? [];
      if (edges.some((e) => e.toId === fieldRegistry.id)) {
        created.push("relationship: checkout-api publishes_to field-registry (exists)");
      } else {
        await post(
          "/relationships",
          {
            typeId: "publishes_to",
            fromId: checkoutApi.id,
            toId: fieldRegistry.id,
            properties: { repository: "acme/checkout-api" }
          },
          "checkout-api publishes_to field-registry (acme/checkout-api)"
        );
      }
    } catch (e) {
      failed.push(`relationship checkout-api publishes_to field-registry: ${e.message}`);
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
