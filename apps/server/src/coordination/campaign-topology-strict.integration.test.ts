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

/**
 * A MALFORMED RELEASE TOPOLOGY MUST FAIL AS LOUDLY ON THE CAMPAIGN PATH AS ON THE CHANGE PATH.
 *
 * ============================================================================================
 * THE PROPERTY, AND WHY THIS SUITE EXISTS AT ALL
 * ============================================================================================
 * `parseTopologyWaves` used to return `undefined` for anything it did not understand, and
 * `compilePlan` reads `undefined` as "no topology" and falls back to a bare toposort. So a junk
 * topology compiled CLEANLY to one anonymous wave: the operator saw a topology attached, a plan
 * compiled and a release run, with nothing anywhere saying the document was garbage. A
 * silently-ignored configuration is worse than a rejected one.
 *
 * That was fixed on the change side, and the fix named the property precisely — one property, three
 * instances. It was then applied to ONE of the property's TWO call sites. `campaign-plan-service.ts`
 * held its own copy of the parser, in the exact pre-fix shape, so every instance stayed live for
 * campaigns: a junk topology ran as one undifferentiated wave, exactly as before.
 *
 * The parser is now a shared module (`topology-waves.ts`) rather than a second copy, which is the
 * only form of the fix that cannot regress the same way. These tests are the campaign half of the
 * evidence — the change half lives in `stage-compilation.integration.test.ts`.
 *
 * ============================================================================================
 * WHAT IS ASSERTED, AND WHY IT IS NOT THE ERROR MESSAGE
 * ============================================================================================
 * The campaign path does not throw to a caller: `campaign-reconcile.ts` catches a compile fault,
 * records a `plan_diff` block Decision and retries next tick. So the observable behaviour of the fix
 * is the pair "NO plan compiled" + "a blocking Decision exists" — and the first half is the one that
 * matters, because compiling a WRONG plan is the failure being fixed. Asserting the message text
 * would pin wording rather than behaviour; a test that stays green while the campaign silently runs
 * one anonymous wave is exactly the kind this codebase has been burned by.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | restore `campaign-plan-service.ts`'s own lenient `parseTopologyWaves` | the three malformed tests FAIL — each compiles a 1-wave plan instead of refusing, which is precisely the bug |
 * | `topology-waves.ts`: drop the `waves.length === 0` branch | the EMPTY-array test FAILS (a plan compiles) |
 * | `topology-waves.ts`: drop the unknown-key check | the unknown-key test FAILS (a plan compiles) |
 * | `topology-waves.ts`: throw on an ABSENT `waves` key too | the non-regression test FAILS — refusing a topology-less campaign would break the overwhelming majority of real ones |
 *
 * TWO of these tests were WRONG when first written, and both were caught by mutation rather than by
 * reading — which is the whole argument for running them:
 *
 *  1. the fixture surgery ran INSIDE the creating transaction, on the surgeon's own connection, so
 *     it updated nothing and the topology stayed `{}` — a legal document. The test would have
 *     compiled a plan and passed while measuring an empty document.
 *  2. the unknown-key case named a made-up target id, so `compilePlan` refused it for a reason that
 *     had nothing to do with the parser. It stayed GREEN under a mutation removing the very guard it
 *     claimed to test. It now names the campaign's real target, isolating the guard.
 */
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

  /**
   * Privileged fixture surgery, bypassing Ajv — and the honest reachability story for two of the
   * four cases below.
   *
   * `release-topology`'s registered property schema (migration 0007 §9) already rejects a non-array
   * `waves` and a bad `mode` at the write door, so the API is NOT how such a document arrives. What
   * reaches the parser unvalidated comes from elsewhere: a federated `object_upsert` applied against
   * a DIFFERENT schema version, a row predating a schema tightening, or the `topology_document`
   * SNAPSHOT copied into `campaign_plans` at compile time, which Ajv never re-validates. The other
   * two cases — an empty `waves` array and an unknown wave key — the registered schema PERMITS, so
   * they arrive through the front door and need no surgery at all.
   */
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

  /**
   * A campaign over one real component, carrying `document` as its release topology. When `document`
   * is one the registered schema refuses, pass `viaSurgery` — the topology is created empty and the
   * document is written underneath it by `compileOnce`, AFTER this transaction commits.
   *
   * `__TARGET__` anywhere in `document` is replaced with the real component id. That is not sugar:
   * a wave naming a target the change does not carry makes `compilePlan` itself refuse, so a test
   * written with a made-up target id passes whether or not the PARSER validates anything — which is
   * exactly how the unknown-key case below was first written, and it stayed green under a mutation
   * that removed the guard it claimed to test.
   *
   * The commit ordering is load-bearing and was also got wrong once here: the surgeon holds its OWN connection,
   * so an UPDATE issued while this transaction is still open cannot see the uncommitted row and
   * silently updates NOTHING. The topology then stays `{}`, which parses as "no waves key at all" —
   * a perfectly legal document — and the test compiles a plan and passes for entirely the wrong
   * reason. It was caught only because the assertion pointed at `null`.
   */
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
