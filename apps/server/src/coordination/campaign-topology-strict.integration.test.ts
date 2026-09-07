import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import {
  buildTestServer,
  createTestOrg,
  testDatabaseUrl,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { decisions } from "../db/schema.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import { CountingCelSandbox } from "./test-support/counting-cel-sandbox.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/** A malformed topology must fail as loudly on either path. See docs/coordination.md §227. */
describe("a malformed release topology is refused on the CAMPAIGN path too", () => {
  let server: TestServer;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    sandbox = new CountingCelSandbox();
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });
  });

  afterAll(async () => {
    await sandbox.stop();
    await server.close();
  });

  /** Substitutes the real component id for `__TARGET__` — see `campaignWithTopology`. */
  function withTarget(document: unknown, componentId: string): unknown {
    return JSON.parse(JSON.stringify(document).replaceAll("__TARGET__", componentId));
  }

  /** Privileged fixture surgery, bypassing Ajv. See docs/coordination.md §228. */
  async function writeRawProperties(objectId: string, properties: unknown) {
    const surgeon = new pg.Client({ connectionString: testDatabaseUrl() });
    await surgeon.connect();
    try {
      await surgeon.query("UPDATE objects SET properties = $2::jsonb WHERE id = $1", [
        objectId,
        JSON.stringify(properties)
      ]);
    } finally {
      await surgeon.end();
    }
  }

  /** A campaign over one component, carrying a topology. See docs/coordination.md §229. */
  async function campaignWithTopology(
    org: TestOrg,
    label: string,
    document: unknown,
    opts: { viaSurgery?: boolean } = {}
  ) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const component = await createObject(tx, {
        orgId: org.orgId,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "campaign-topology-strict",
        name: `${label}-comp`,
        properties: {}
      });
      const topology = await createObject(tx, {
        orgId: org.orgId,
        typeId: "release-topology",
        actorObjectId: org.orgId,
        requestId: "campaign-topology-strict",
        name: `${label}-topo`,
        properties: opts.viaSurgery
          ? {}
          : (withTarget(document, component.id) as Record<string, unknown>)
      });
      const campaign = await createObject(tx, {
        orgId: org.orgId,
        typeId: "campaign",
        actorObjectId: org.orgId,
        requestId: "campaign-topology-strict",
        name: `${label}-campaign`,
        properties: { targets: [component.id], topologyObjectId: topology.id }
      });
      return { campaignId: campaign.id, topologyId: topology.id, componentId: component.id };
    });
  }

  async function planFor(org: TestOrg, campaignObjectId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, campaignObjectId)
    );
  }

  async function blockingDecisions(org: TestOrg, campaignObjectId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, campaignObjectId),
            eq(decisions.kind, "plan_diff"),
            eq(decisions.verdict, "block")
          )
        )
    );
  }

  /** Proposes, ticks the real campaign reconciler once, and reports what it did. */
  async function compileOnce(
    org: TestOrg,
    label: string,
    document: unknown,
    opts: { viaSurgery?: boolean } = {}
  ) {
    const { campaignId, topologyId, componentId } = await campaignWithTopology(
      org,
      label,
      document,
      opts
    );
    // AFTER the creating transaction commits — see `campaignWithTopology`'s note.
    if (opts.viaSurgery) await writeRawProperties(topologyId, withTarget(document, componentId));
    // S10: the reconciler drives only campaigns this domain is authoritative for. Every campaign
    // here is created locally, so this org's own `federation_self.domain_id` is exactly what they
    // carry — see `campaign-repo.ts`'s `listActiveCampaignObjectIds`.
    const selfDomainId = (
      await withTenantTx(server.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId))
    ).domainId;
    await reconcileCampaignsOrgTick(server.deps.db, org.orgId, host, sandbox, selfDomainId);
    return {
      plan: await planFor(org, campaignId),
      blocked: await blockingDecisions(org, campaignId)
    };
  }

  it("REFUSES a `waves` that is not an array, instead of compiling one anonymous wave", async () => {
    const org = await createTestOrg(server, "camp-topo-notarray");
    const { plan, blocked } = await compileOnce(
      org,
      "notarray",
      { waves: { oops: true } },
      { viaSurgery: true }
    );

    expect(
      plan,
      "before the fix this compiled a perfectly ordinary 1-wave plan, and the junk document left no trace anywhere"
    ).toBeNull();
    expect(blocked.length, "the fault must be recorded, not just swallowed").toBeGreaterThan(0);
  });

  it("REFUSES an EMPTY `waves` array — the second instance of the same property", async () => {
    // `compilePlan`'s `length === 0` branch ALSO falls back to toposort, so an explicitly empty
    // topology was every bit as silent as a missing one. Someone wrote `waves: []` on purpose.
    const org = await createTestOrg(server, "camp-topo-empty");
    const { plan, blocked } = await compileOnce(org, "empty", { waves: [] });

    expect(plan).toBeNull();
    expect(blocked.length).toBeGreaterThan(0);
  });

  it("REFUSES an unknown wave key and a bad mode — the unchecked cast, third instance", async () => {
    // `waves as TopologyWaveSpec[]` validated nothing, so `mode: "paralel"` and a key the compiler
    // never reads both sailed through into the compiler as garbage.
    const org = await createTestOrg(server, "camp-topo-unknown");
    const unknownKey = await compileOnce(org, "unknownkey", {
      waves: [
        { name: "w1", mode: "parallel", targets: ["__TARGET__"], stages: ["commercial-gamma"] }
      ]
    });
    const badMode = await compileOnce(
      org,
      "badmode",
      { waves: [{ name: "w1", mode: "paralel", targets: ["__TARGET__"] }] },
      { viaSurgery: true }
    );

    expect(
      unknownKey.plan,
      "a key the compiler does not read would silently do nothing"
    ).toBeNull();
    expect(unknownKey.blocked.length).toBeGreaterThan(0);
    expect(badMode.plan).toBeNull();
    expect(badMode.blocked.length).toBeGreaterThan(0);
  });

  it("a topology with NO `waves` key at all still compiles — absent is not malformed", async () => {
    // The other direction, and the reason the parser distinguishes absent from empty: a topology
    // that declares no ordering is the pre-topology behaviour and is overwhelmingly the common case.
    // A fix that refused this would break far more than it caught.
    const org = await createTestOrg(server, "camp-topo-nowaves");
    const { plan, blocked } = await compileOnce(org, "nowaves", { note: "no ordering declared" });

    expect(plan, "a campaign with an orderless topology must still compile").not.toBeNull();
    expect(plan!.waves.length).toBeGreaterThan(0);
    expect(blocked, "and nothing about it is a fault").toHaveLength(0);
  });
});
