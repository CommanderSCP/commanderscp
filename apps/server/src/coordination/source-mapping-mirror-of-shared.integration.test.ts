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

/** The declared provenance marker on a source mapping. See docs/coordination.md §901. */
describe("source mapping: declared mirror-of-shared provenance (outpost-ui.md §9.3a)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "mirror-of-shared");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  const match = (sourceKind: string, repo: string, paths?: string[]) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchComponentForSource(tx, org.orgId, { sourceKind, repo, paths })
    );

  it("round-trips: declared at create, read back on the wire, false when omitted", async () => {
    const component = await createTestComponent(admin, { name: `mirror-rt-${uuidv7()}` });
    const sourceKind = `mirror-rt-${uuidv7()}`;

    const mirror = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "field/shared-asg-mirror",
      type: "infrastructure",
      mirrorOfShared: true
    });
    expect(mirror.mirrorOfShared).toBe(true);

    const own = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "field/network-cidr",
      type: "infrastructure"
      // omitted → domain-specific, the pre-0062 meaning of every mapping
    });
    expect(own.mirrorOfShared).toBe(false);

    const listed = await admin.changeSources.listMappings(sourceKind);
    const byRepo = new Map(listed.items.map((m) => [m.repoPattern, m.mirrorOfShared]));
    expect(byRepo.get("field/shared-asg-mirror")).toBe(true);
    expect(byRepo.get("field/network-cidr")).toBe(false);
  });

  it("is INERT for correlation: the same push routes identically with the marker on or off, and the result never carries it", async () => {
    const sourceKind = `mirror-inert-${uuidv7()}`;
    const repo = `acme/infra-${uuidv7()}`;
    const withMarker = await createTestComponent(admin, { name: `mirror-on-${uuidv7()}` });
    const without = await createTestComponent(admin, { name: `mirror-off-${uuidv7()}` });

    // Two mappings identical in every ROUTING respect (repo + path), differing ONLY in the marker.
    await admin.changeSources.createMapping(sourceKind, {
      component: withMarker.id,
      repoPattern: repo,
      pathPattern: "asg/**",
      type: "infrastructure",
      mirrorOfShared: true
    });
    await admin.changeSources.createMapping(sourceKind, {
      component: without.id,
      repoPattern: repo,
      pathPattern: "cidr/**",
      type: "infrastructure"
    });

    // Each path routes to ITS component — the marker neither promotes nor demotes a mapping in the
    // matcher's precedence, and it never blocks a match.
    const a = await match(sourceKind, repo, ["asg/main.tf"]);
    const b = await match(sourceKind, repo, ["cidr/bands.tf"]);
    expect(a?.componentObjectId).toBe(withMarker.id);
    expect(b?.componentObjectId).toBe(without.id);

    // And the correlation RESULT carries no trace of it: a change is never stamped with
    // provenance, so no gate, scan requirement or export decision can read it downstream. If this
    // key ever appears here, the inertness guarantee has been broken at the root.
    expect(a).not.toHaveProperty("mirrorOfShared");
    expect(b).not.toHaveProperty("mirrorOfShared");
    expect(a).toEqual({
      componentObjectId: withMarker.id,
      type: "infrastructure",
      classification: null
    });
  });
});
