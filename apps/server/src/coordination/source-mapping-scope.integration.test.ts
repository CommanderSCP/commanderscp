import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { matchComponentForSource } from "./correlation.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `source_mappings.scope` — the DECLARED reach of a mapping's repo (migration 0066,
 * pipeline-substrate-registry-scan.md §10.6, owner 2026-08-16: "Global sources should be labeled as
 * such in pipelines (and our CommanderSCP IaC, SDK, CLI)").
 *
 * `global` = a cross-domain shared repo tracked at the commander; `domain` = tracked only in one
 * domain; NULL = NOT DECLARED. Three properties are pinned here:
 *
 *   1. ROUND-TRIP through the public API incl. NULL: declared at create, read back on the wire
 *      (create / list / the component pipeline projection), and OMITTED means null — a pre-0066 row
 *      is not thereby anything. Nothing infers a value from the site's federation role.
 *   2. The by-id PATCH `.../mappings/{id}/scope` sets and CLEARS it — a sibling of the pause switch,
 *      not a field on it: `setSourceMappingEnabled`'s contract is untouched, and labelling a row never
 *      restates (or clobbers) its pause state. Addressed by id: a byte-identical sibling is untouched.
 *   3. INERTNESS: the correlation matcher does not read it. A global-scope and a domain-scope mapping
 *      identical in every ROUTING respect route identically, and the correlation result carries no
 *      trace of it — the same discipline `mirrorOfShared` and `classification` are held to, so no one
 *      makes it a routing input silently.
 */
describe("source mapping: declared scope (migration 0066, §10.6)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "mapping-scope");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  const match = (sourceKind: string, repo: string, paths?: string[]) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchComponentForSource(tx, org.orgId, { sourceKind, repo, paths })
    );

  it("round-trips incl. NULL: declared at create, read back on create/list/pipeline; omitted = null (not declared)", async () => {
    const component = await createTestComponent(admin, { name: `scope-rt-${uuidv7()}` });
    const sourceKind = `scope-rt-${uuidv7()}`;

    const global = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/platform-iac",
      type: "infrastructure",
      scope: "global"
    });
    expect(global.scope).toBe("global");

    const domain = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "field/network-cidr",
      type: "infrastructure",
      scope: "domain"
    });
    expect(domain.scope).toBe("domain");

    const undeclared = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/legacy",
      type: "infrastructure"
      // omitted → NOT declared. Not "global because this is the commander", not anything.
    });
    expect(undeclared.scope).toBeNull();

    const listed = await admin.changeSources.listMappings(sourceKind);
    const byRepo = new Map(listed.items.map((m) => [m.repoPattern, m.scope]));
    expect(byRepo.get("acme/platform-iac")).toBe("global");
    expect(byRepo.get("field/network-cidr")).toBe("domain");
    expect(byRepo.get("acme/legacy")).toBeNull();

    // The pipeline projection carries it READ, per source — the eyebrow the web renders is off this.
    const pipeline = await admin.components.pipeline(component.id);
    const projected = new Map(pipeline.sources.map((s) => [s.repoPattern, s.scope]));
    expect(projected.get("acme/platform-iac")).toBe("global");
    expect(projected.get("field/network-cidr")).toBe("domain");
    expect(projected.get("acme/legacy")).toBeNull();
  });

  it("PATCH .../mappings/{id}/scope sets and CLEARS it, by id, without touching the pause state or a sibling", async () => {
    const component = await createTestComponent(admin, { name: `scope-patch-${uuidv7()}` });
    const sourceKind = `scope-patch-${uuidv7()}`;

    // Two byte-identical rows (the table has no unique constraint; the homelab has such pairs).
    const declare = () =>
      admin.changeSources.createMapping(sourceKind, {
        component: component.id,
        repoPattern: "acme/shared",
        type: "infrastructure",
        enabled: false // paused — the PATCH below must leave this exactly as it is
      });
    const a = await declare();
    const b = await declare();
    expect(a.scope).toBeNull();
    expect(a.enabled).toBe(false);

    const set = await admin.changeSources.setMappingScope(sourceKind, a.id, "global");
    expect(set.id).toBe(a.id);
    expect(set.scope).toBe("global");
    // Pause state untouched — this is the point of the sibling route.
    expect(set.enabled).toBe(false);
    expect(set.effectivelyEnabled).toBe(false);

    // The byte-identical sibling is NOT relabelled: by-id means one row.
    const listed = await admin.changeSources.listMappings(sourceKind);
    expect(listed.items.find((m) => m.id === b.id)?.scope).toBeNull();
    expect(listed.items.find((m) => m.id === a.id)?.scope).toBe("global");

    // Re-declare, then CLEAR with null: back to "not declared".
    const redeclared = await admin.changeSources.setMappingScope(sourceKind, a.id, "domain");
    expect(redeclared.scope).toBe("domain");
    const cleared = await admin.changeSources.setMappingScope(sourceKind, a.id, null);
    expect(cleared.scope).toBeNull();
    expect(cleared.enabled).toBe(false);

    // A miss on the id (or the source kind) is a 404, never a silent no-op.
    await expect(
      admin.changeSources.setMappingScope(sourceKind, uuidv7(), "global")
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      admin.changeSources.setMappingScope(`other-${sourceKind}`, a.id, "global")
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a value outside global|domain at the wire — the CHECK never gets to see one", async () => {
    const component = await createTestComponent(admin, { name: `scope-bad-${uuidv7()}` });
    const sourceKind = `scope-bad-${uuidv7()}`;
    const res = await fetch(`${server.baseUrl}/change-sources/${sourceKind}/mappings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${org.adminToken}` },
      body: JSON.stringify({
        sourceKind,
        component: component.id,
        repoPattern: "acme/x",
        scope: "regional"
      })
    });
    expect(res.status).toBe(400);

    // Same at the sibling PATCH — and a well-formed create first, so the 400 is the VALUE's, not a 404.
    const created = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/y"
    });
    const patched = await fetch(
      `${server.baseUrl}/change-sources/${sourceKind}/mappings/${created.id}/scope`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${org.adminToken}` },
        body: JSON.stringify({ scope: "regional" })
      }
    );
    expect(patched.status).toBe(400);
  });

  it("is INERT for correlation: a global-scope and a domain-scope mapping route identically, and the result never carries scope", async () => {
    const sourceKind = `scope-inert-${uuidv7()}`;
    const repo = `acme/infra-${uuidv7()}`;
    const globalOwner = await createTestComponent(admin, { name: `scope-global-${uuidv7()}` });
    const domainOwner = await createTestComponent(admin, { name: `scope-domain-${uuidv7()}` });

    // Two mappings identical in every ROUTING respect (repo + path shape), differing ONLY in scope.
    await admin.changeSources.createMapping(sourceKind, {
      component: globalOwner.id,
      repoPattern: repo,
      pathPattern: "asg/**",
      type: "infrastructure",
      scope: "global"
    });
    await admin.changeSources.createMapping(sourceKind, {
      component: domainOwner.id,
      repoPattern: repo,
      pathPattern: "cidr/**",
      type: "infrastructure",
      scope: "domain"
    });

    // Each path routes to ITS component — scope neither promotes nor demotes a row in the matcher's
    // precedence, and it never blocks a match. Then flip both scopes and the routing is unchanged.
    const a = await match(sourceKind, repo, ["asg/main.tf"]);
    const b = await match(sourceKind, repo, ["cidr/bands.tf"]);
    expect(a?.componentObjectId).toBe(globalOwner.id);
    expect(b?.componentObjectId).toBe(domainOwner.id);

    const listed = await admin.changeSources.listMappings(sourceKind);
    for (const m of listed.items) {
      await admin.changeSources.setMappingScope(
        sourceKind,
        m.id,
        m.scope === "global" ? "domain" : "global"
      );
    }
    const a2 = await match(sourceKind, repo, ["asg/main.tf"]);
    const b2 = await match(sourceKind, repo, ["cidr/bands.tf"]);
    expect(a2?.componentObjectId).toBe(globalOwner.id);
    expect(b2?.componentObjectId).toBe(domainOwner.id);

    // And the correlation RESULT carries no trace of it: a change is never stamped with scope, so
    // no gate, scan requirement or export decision can read it downstream.
    expect(a).not.toHaveProperty("scope");
    expect(a).toEqual({
      componentObjectId: globalOwner.id,
      type: "infrastructure",
      classification: null
    });
  });
});
