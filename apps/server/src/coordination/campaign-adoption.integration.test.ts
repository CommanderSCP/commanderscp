import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, campaignWaveTargets, changes, decisions } from "../db/schema.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";
import { proposeCampaign } from "./campaign-repo.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import {
  upsertComponentDependency,
  upsertDependencyLine
} from "../dependencies/dependency-inventory-repo.js";
import { insertControlRun } from "../governance/controls-repo.js";
import {
  buildCampaignAdoptionReport,
  CAMPAIGN_ADOPTION_AUDIT_ACTION,
  CAMPAIGN_ADOPTION_DECISION_KIND,
  evaluateCampaignAdoption
} from "./campaign-adoption.js";
import type { AdoptionEvidence, CampaignRecipe } from "@scp/schemas";

/**
 * ================================================================================================
 * M25.5 — ADOPTION EVIDENCE, END TO END AGAINST REAL POSTGRES
 * ================================================================================================
 *
 * The guarantee under test is a single asymmetry: **`adopted` is only ever produced by an OBSERVED
 * fact, and every absence produces `unknown`.** M25.6's deadline lock reads this predicate and
 * nothing else, so an `adopted` conjured out of an un-ingested component or an un-orderable version
 * string is a signed governance record asserting compliance nobody verified.
 *
 * WHY THE VERDICT MATRIX LIVES HERE AND NOT IN A UNIT TEST. Two of the three kinds are ONLY
 * interesting at the join: `dependency` turns on "does this component have ANY inventory rows"
 * against "does it have one for THIS `(ecosystem, coordinate)`", which is exactly the distinction a
 * stubbed transaction defines away; `control` turns on "the LATEST run wins" and on reading
 * `plugin_module` off the row rather than re-resolving a binding. The repo's rule — integration
 * tests run against real PostgreSQL, never a mocked DB — is also the rule that makes these cases
 * mean anything. The genuinely pure parts (`positionAgainstFloor`, and the zero-query inertness
 * proof) are in `campaign-adoption.test.ts`.
 *
 * DRIVES `reconcileCampaignsOrgTick` DIRECTLY — never `withReconcileLoop`. A live loop is a
 * COMPETING CONSUMER of the very rows these cases read back (`SKIP LOCKED` makes an inline call a
 * silent no-op), and "one tick" must mean exactly one tick for "no member change was minted" to be
 * an assertion rather than a race.
 *
 * NO FIXED SLEEPS anywhere. Every wait is a tick count — a positive signal the engine writes —
 * which is what `test-support/integration-sleep-census.test.ts` exists to keep true.
 *
 * A FRESH ORG PER CASE. `reconcileCampaignsOrgTick` serves `ORDER BY updated_at ASC LIMIT 25` over
 * every campaign in the org, and several cases here assert org-wide counts ("zero Changes exist"),
 * which only mean what they say when the org holds one campaign.
 */

const PY_COORDINATE = "docker.io/library/python";

/** The motivating recipe: python2 -> python3, adopting on the component's OWN dependency inventory
 *  — the one evidence source that is standing, component-scoped and independently refreshed. */
function pythonRecipe(minVersion: string): CampaignRecipe {
  return {
    version: 1,
    trigger: { kind: "sync" },
    adoption: {
      kind: "dependency",
      ecosystem: "oci",
      coordinate: PY_COORDINATE,
      minVersion
    }
  };
}

describe("campaign adoption evidence: observed, never asserted (M25.5)", () => {
  let server: TestServer;
  let host: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    // Long auto-succeed so a member change that IS minted stays durably in flight rather than
    // racing the assertions to completion.
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 10 * 60_000 });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  async function inject(
    org: TestOrg,
    url: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  /** A fresh org with one service and one component, plus an Owner who may author campaigns over it
   *  (`proposeCampaign` authorizes `object:write` at EVERY target — an org admin token is not
   *  enough on its own). */
  async function fixture(label: string): Promise<{ org: TestOrg; componentId: string }> {
    const org = await createTestOrg(server, label);
    const service = await inject(org, "/api/v1/services", { name: `svc-${label}` });
    const component = await inject(org, "/api/v1/components", {
      name: `comp-${label}`,
      service: service.id
    });
    return { org, componentId: component.id as string };
  }

  async function campaignFor(
    org: TestOrg,
    componentId: string,
    recipe?: CampaignRecipe
  ): Promise<string> {
    const owner = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { campaign } = await proposeCampaign(tx, {
        orgId: org.orgId,
        actorObjectId: owner.objectId,
        requestId: "campaign-adoption-test",
        name: `campaign-${randomUUID().slice(0, 8)}`,
        targets: [componentId],
        ...(recipe ? { recipe } : {})
      });
      return campaign.id;
    });
  }

  async function tick(org: TestOrg, times = 1): Promise<void> {
    const selfDomainId = (
      await withTenantTx(server.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId))
    ).domainId;
    for (let i = 0; i < times; i++) {
      await reconcileCampaignsOrgTick(
        server.deps.db,
        org.orgId,
        host,
        server.deps.celSandbox!,
        selfDomainId
      );
    }
  }

  /** Seed one manifest declaration into the component's dependency inventory — the same two verbs
   *  `dependencies/inventory-ingestion.ts` uses when it re-reads a repository, so these rows are the
   *  shape ingestion actually writes rather than a test-only approximation. */
  async function declare(
    org: TestOrg,
    componentObjectId: string,
    input: {
      coordinate?: string;
      ecosystem?: "npm" | "go" | "maven" | "python" | "oci";
      major: string;
      manifestPath: string;
      declaredVersion: string;
      /** NULL = the manifest pins no concrete version (an open range). */
      resolvedVersion: string | null;
    }
  ): Promise<void> {
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const line = await upsertDependencyLine(tx, org.orgId, {
        ecosystem: input.ecosystem ?? "oci",
        coordinate: input.coordinate ?? PY_COORDINATE,
        major: input.major
      });
      await upsertComponentDependency(tx, org.orgId, {
        componentObjectId,
        lineId: line.id,
        manifestPath: input.manifestPath,
        declaredVersion: input.declaredVersion,
        resolvedVersion: input.resolvedVersion
      });
    });
  }

  function evaluate(
    org: TestOrg,
    campaignObjectId: string,
    targetObjectId: string,
    recipe: CampaignRecipe | undefined
  ) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      evaluateCampaignAdoption(tx, org.orgId, campaignObjectId, targetObjectId, recipe)
    );
  }

  const planFor = (org: TestOrg, campaignObjectId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, campaignObjectId)
    );

  const changeCount = async (org: TestOrg): Promise<number> => {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ n: count() }).from(changes).where(eq(changes.orgId, org.orgId))
    );
    return Number(rows[0]?.n ?? 0);
  };

  const decisionsOfKind = (org: TestOrg, subjectId: string, kind: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, subjectId),
            eq(decisions.kind, kind)
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );

  // ===========================================================================================
  // A — `dependency`: every verdict, and the two absences that must never become `adopted`
  // ===========================================================================================

  /**
   * THE CASE THE WHOLE FEATURE IS SHAPED AROUND. "Never ingested" and "declares nothing" are
   * different facts; the first is a statement about CommanderSCP, not about the component. Reading
   * it as "declares no python2, therefore migrated" would hand `adopted` to every component in an
   * estate that has not wired inventory ingestion — i.e. it would fail open at the largest scale.
   */
  it("A1: ZERO inventory rows is `unknown` and explicitly NOT `adopted` — never ingested is not nothing declared", async () => {
    const { org, componentId } = await fixture("adopt-a1");
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));

    const result = await evaluate(org, campaignId, componentId, pythonRecipe("3.0"));

    expect(result.verdict).toBe("unknown");
    expect(result.verdict).not.toBe("adopted");
    expect(result.summary).toContain("NO dependency inventory rows");
    expect(result.observations).toEqual([]);
  });

  it("A2: a declaration BELOW the floor is `not_adopted`, and the record names the manifest and both versions", async () => {
    const { org, componentId } = await fixture("adopt-a2");
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));
    await declare(org, componentId, {
      major: "2",
      manifestPath: "Dockerfile",
      declaredVersion: "2.7-slim",
      resolvedVersion: "2.7-slim"
    });

    const result = await evaluate(org, campaignId, componentId, pythonRecipe("3.0"));

    expect(result.verdict).toBe("not_adopted");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toContain("Dockerfile");
    expect(result.observations[0]).toContain("2.7-slim");
    expect(result.observations[0]).toContain("below");
  });

  it("A3: every declaration at or above the floor is `adopted` — including a variant tag (`3.12-slim` vs `3.0`)", async () => {
    const { org, componentId } = await fixture("adopt-a3");
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));
    await declare(org, componentId, {
      major: "3",
      manifestPath: "Dockerfile",
      declaredVersion: "3.12-slim",
      resolvedVersion: "3.12-slim"
    });
    await declare(org, componentId, {
      major: "3",
      manifestPath: "tools/Dockerfile",
      declaredVersion: "3.11-alpine",
      resolvedVersion: "3.11-alpine"
    });

    const result = await evaluate(org, campaignId, componentId, pythonRecipe("3.0"));

    expect(result.verdict).toBe("adopted");
    expect(result.observations).toHaveLength(2);
    // SORTED — the same array reaches a Decision's `inputContext`, where array ORDER is significant
    // to `restatesDecision` and Postgres guarantees no row order.
    expect(result.observations).toEqual(
      [...result.observations].sort((a, b) => a.localeCompare(b))
    );
  });

  /**
   * A NULL `resolved_version` means "the manifest does not pin one" (an open range), never "we did
   * not look" — a real observation that still cannot satisfy a floor, because a range's floor is not
   * what will be installed.
   */
  it("A4: a NULL resolved_version (an open range) is `unknown`, never `adopted`", async () => {
    const { org, componentId } = await fixture("adopt-a4");
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));
    await declare(org, componentId, {
      ecosystem: "python",
      coordinate: "requests",
      major: "2",
      manifestPath: "requirements.txt",
      declaredVersion: ">=2.0",
      resolvedVersion: null
    });

    const openRange: CampaignRecipe = {
      version: 1,
      trigger: { kind: "sync" },
      adoption: {
        kind: "dependency",
        ecosystem: "python",
        coordinate: "requests",
        minVersion: "3.0"
      }
    };
    const result = await evaluate(org, campaignId, componentId, openRange);

    expect(result.verdict).toBe("unknown");
    expect(result.verdict).not.toBe("adopted");
    expect(result.observations[0]).toContain("the manifest pins no concrete version");
  });

  it("A5: positive evidence of a laggard WINS over an indeterminate sibling — one pinned 2.7 plus one open range is `not_adopted`", async () => {
    const { org, componentId } = await fixture("adopt-a5");
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));
    await declare(org, componentId, {
      major: "2",
      manifestPath: "Dockerfile",
      declaredVersion: "2.7",
      resolvedVersion: "2.7"
    });
    await declare(org, componentId, {
      major: "3",
      manifestPath: "tools/Dockerfile",
      declaredVersion: "3",
      resolvedVersion: null
    });

    const result = await evaluate(org, campaignId, componentId, pythonRecipe("3.0"));
    expect(result.verdict).toBe("not_adopted");
  });

  /**
   * INGESTED, BUT NOTHING ON THIS COORDINATE. This is the case the "zero rows" clause buys: the
   * manifests HAVE been read and the laggard declaration is simply gone — a Dockerfile that moved
   * off a python base entirely. That is an observation, not a silence, which is exactly why the two
   * must not be collapsed.
   */
  it("A6: ingested with NO row for this coordinate is `adopted` — the laggard declaration is observably gone", async () => {
    const { org, componentId } = await fixture("adopt-a6");
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));
    await declare(org, componentId, {
      ecosystem: "npm",
      coordinate: "@acme/lib",
      major: "4",
      manifestPath: "package.json",
      declaredVersion: "4.1.0",
      resolvedVersion: "4.1.0"
    });

    const result = await evaluate(org, campaignId, componentId, pythonRecipe("3.0"));

    expect(result.verdict).toBe("adopted");
    expect(result.summary).toContain("none of them declares");
  });

  /**
   * THE FALSE-`adopted` GENERATOR. `3f2a1b9c` is a git sha whose first character happens to be a
   * digit; `parseComparableVersion` reads it as major 3 with suffix `f2a1b9c`. A numeric-core
   * comparison that ignored suffix SHAPE would rank it at or above a floor of `3.0` and report a
   * sha-pinned base image as migrated.
   */
  it("A7: a sha-shaped tag is `unknown` — a numeric core that is not a version can never be evidence", async () => {
    const { org, componentId } = await fixture("adopt-a7");
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));
    await declare(org, componentId, {
      major: "3",
      manifestPath: "Dockerfile",
      declaredVersion: "3f2a1b9c",
      resolvedVersion: "3f2a1b9c"
    });

    const result = await evaluate(org, campaignId, componentId, pythonRecipe("3.0"));

    expect(result.verdict).toBe("unknown");
    expect(result.verdict).not.toBe("adopted");
    expect(result.observations[0]).toContain("incomparable");
  });

  it("A8: another ORG's identical inventory is invisible — the coordinate join is tenant-scoped", async () => {
    const a = await fixture("adopt-a8-a");
    const b = await fixture("adopt-a8-b");
    const campaignId = await campaignFor(a.org, a.componentId, pythonRecipe("3.0"));
    await declare(b.org, b.componentId, {
      major: "3",
      manifestPath: "Dockerfile",
      declaredVersion: "3.12",
      resolvedVersion: "3.12"
    });

    const result = await evaluate(a.org, campaignId, a.componentId, pythonRecipe("3.0"));
    expect(result.verdict).toBe("unknown");
  });

  const DELIVERED: AdoptionEvidence = { kind: "delivered" };
  const deliveredRecipe: CampaignRecipe = {
    version: 1,
    trigger: { kind: "sync" },
    adoption: DELIVERED
  };

  it("B1: no wave target for this component is `unknown` — there is nothing to have been delivered", async () => {
    const { org, componentId } = await fixture("adopt-b1");
    const campaignId = await campaignFor(org, componentId, deliveredRecipe);

    // No tick: no plan has been compiled, so the campaign has no wave target for anything.
    const result = await evaluate(org, campaignId, componentId, deliveredRecipe);

    expect(result.verdict).toBe("unknown");
    expect(result.verdict).not.toBe("adopted");
    expect(result.observations).toEqual([]);
  });

  it("B2: a wave target that has been fanned out but not accepted is `not_adopted`", async () => {
    const { org, componentId } = await fixture("adopt-b2");
    const campaignId = await campaignFor(org, componentId, deliveredRecipe);
    await tick(org, 1);

    const result = await evaluate(org, campaignId, componentId, deliveredRecipe);

    expect(result.verdict).toBe("not_adopted");
    expect(result.observations[0]).toContain("change_proposed");
  });

  it("B3: a `succeeded` wave target is `adopted`, and the wording says DELIVERED rather than migrated", async () => {
    const { org, componentId } = await fixture("adopt-b3");
    const campaignId = await campaignFor(org, componentId, deliveredRecipe);
    await tick(org, 1);
    const plan = await planFor(org, campaignId);
    const targetRowId = plan!.waves[0]!.targets[0]!.id;
    // Drive the wave target terminal directly: what is under test is how the PREDICATE reads a
    // `succeeded` row, not the member-change lifecycle that produces one (which
    // `campaign.integration.test.ts` already covers end to end).
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(campaignWaveTargets)
        .set({ status: "succeeded" })
        .where(
          and(eq(campaignWaveTargets.orgId, org.orgId), eq(campaignWaveTargets.id, targetRowId))
        )
    );

    const result = await evaluate(org, campaignId, componentId, deliveredRecipe);

    expect(result.verdict).toBe("adopted");
    expect(result.summary).toContain("delivered");
    expect(result.summary).not.toContain("migrated");
  });

  const controlRecipe = (controlObjectId: string): CampaignRecipe => ({
    version: 1,
    trigger: { kind: "sync" },
    adoption: { kind: "control", controlObjectId }
  });

  it("C1: no member change is `unknown` — a control run is recorded against a change, so none could exist", async () => {
    const { org, componentId } = await fixture("adopt-c1");
    const controlId = randomUUID();
    const campaignId = await campaignFor(org, componentId, controlRecipe(controlId));

    const result = await evaluate(org, campaignId, componentId, controlRecipe(controlId));

    expect(result.verdict).toBe("unknown");
    expect(result.verdict).not.toBe("adopted");
  });

  it("C2: a member change with NO run of the named control is `unknown`", async () => {
    const { org, componentId } = await fixture("adopt-c2");
    const controlId = randomUUID();
    const campaignId = await campaignFor(org, componentId, controlRecipe(controlId));
    await tick(org, 1);

    const result = await evaluate(org, campaignId, componentId, controlRecipe(controlId));

    expect(result.verdict).toBe("unknown");
    expect(result.observations[0]).toContain("no run of control");
  });

  it("C3: a run that is not `pass` is `not_adopted`", async () => {
    const { org, componentId } = await fixture("adopt-c3");
    const controlId = randomUUID();
    const campaignId = await campaignFor(org, componentId, controlRecipe(controlId));
    await tick(org, 1);
    const plan = await planFor(org, campaignId);
    const memberChangeObjectId = plan!.waves[0]!.targets[0]!.memberChangeObjectId!;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      insertControlRun(tx, {
        orgId: org.orgId,
        controlObjectId: controlId,
        changeObjectId: memberChangeObjectId,
        gateKind: "wave_boundary",
        gateRef: { waveIndex: 0 },
        status: "fail",
        evidence: {},
        pluginModule: "webhook-control"
      })
    );

    const result = await evaluate(org, campaignId, componentId, controlRecipe(controlId));

    expect(result.verdict).toBe("not_adopted");
    expect(result.observations[0]).toContain("'fail'");
  });

  /**
   * `plugin_module` IS READ OFF THE RUN ROW. The column is stamped at insert (drizzle/0063) so that
   * re-pointing a binding cannot retroactively relabel a historical pass — a provenance label read
   * from the resolved row, never inferred from which binding matches now.
   */
  it("C4: the LATEST run wins, and the observation names the module STAMPED ON THE ROW", async () => {
    const { org, componentId } = await fixture("adopt-c4");
    const controlId = randomUUID();
    const campaignId = await campaignFor(org, componentId, controlRecipe(controlId));
    await tick(org, 1);
    const plan = await planFor(org, campaignId);
    const memberChangeObjectId = plan!.waves[0]!.targets[0]!.memberChangeObjectId!;

    for (const [status, module] of [
      ["fail", "webhook-control"],
      ["pass", "github-check"]
    ] as const) {
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        insertControlRun(tx, {
          orgId: org.orgId,
          controlObjectId: controlId,
          changeObjectId: memberChangeObjectId,
          gateKind: "wave_boundary",
          gateRef: { waveIndex: 0 },
          status,
          evidence: {},
          pluginModule: module
        })
      );
    }

    const result = await evaluate(org, campaignId, componentId, controlRecipe(controlId));

    expect(result.verdict).toBe("adopted");
    expect(result.observations[0]).toContain("'pass'");
    expect(result.observations[0]).toContain("github-check");
    expect(result.observations[0]).not.toContain("webhook-control");
  });

  it("C5: a run of a DIFFERENT control does not answer for this one", async () => {
    const { org, componentId } = await fixture("adopt-c5");
    const controlId = randomUUID();
    const campaignId = await campaignFor(org, componentId, controlRecipe(controlId));
    await tick(org, 1);
    const plan = await planFor(org, campaignId);
    const memberChangeObjectId = plan!.waves[0]!.targets[0]!.memberChangeObjectId!;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      insertControlRun(tx, {
        orgId: org.orgId,
        controlObjectId: randomUUID(),
        changeObjectId: memberChangeObjectId,
        gateKind: "wave_boundary",
        gateRef: { waveIndex: 0 },
        status: "pass",
        evidence: {},
        pluginModule: "github-check"
      })
    );

    const result = await evaluate(org, campaignId, componentId, controlRecipe(controlId));
    expect(result.verdict).toBe("unknown");
    expect(result.verdict).not.toBe("adopted");
  });

  // ===========================================================================================
  // D — CONSUMER 1: THE ACTUATOR. `adopted` => terminalize, and NO member change is proposed.
  // ===========================================================================================

  /**
   * MUTATION-PROVEN. Deleting the `adopted => terminalize, skip proposeChange` branch from
   * `campaign-reconcile.ts` fails this case on its first assertion:
   *
   *   AssertionError: an already-migrated component must have NO member Change minted for it:
   *   expected 1 to be +0
   *
   * A test one has not watched fail is not evidence, and "the campaign completed" would pass against
   * the bug: the fan-out succeeds either way. The only assertion that separates a campaign that
   * RECOGNISED an already-migrated component from one that re-ran the migration on it is the absence
   * of the Change.
   */
  it("D1: a component already at 3.12 gets NO member Change and terminalizes `succeeded`, with one deduped Decision", async () => {
    const { org, componentId } = await fixture("adopt-d1");
    await declare(org, componentId, {
      major: "3",
      manifestPath: "Dockerfile",
      declaredVersion: "3.12-slim",
      resolvedVersion: "3.12-slim"
    });
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));

    await tick(org, 6);

    expect(
      await changeCount(org),
      "an already-migrated component must have NO member Change minted for it"
    ).toBe(0);

    const plan = await planFor(org, campaignId);
    const target = plan!.waves[0]!.targets[0]!;
    expect(target.status).toBe("succeeded");
    expect(target.memberChangeObjectId).toBeNull();
    // ...and the campaign finishes rather than parking: the wave terminalizes on the next tick,
    // which is what makes a campaign IDEMPOTENT against an estate that has already migrated.
    expect(plan!.waves[0]!.status).toBe("succeeded");

    // ONE Decision over six ticks. Both the `pending`-guarded terminalize and
    // `insertDecisionIfChanged` bound this; the count is asserted so that removing either is visible.
    const rows = await decisionsOfKind(org, campaignId, CAMPAIGN_ADOPTION_DECISION_KIND);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("allow");

    // THE CONTEXT CARRIES EVIDENCE AND NOTHING CLOCK-SHAPED. Asserted as an exact key census rather
    // than as "does not contain `now`": a census fails when a NEW clock-shaped key is added, which
    // is how this defect actually arrives (ADR-0024's 1.44 GB/day incident).
    const context = rows[0]!.inputContext as Record<string, unknown>;
    expect(Object.keys(context).sort()).toEqual([
      "coordinate",
      "ecosystem",
      "evidenceKind",
      "minVersion",
      "observations",
      "targetObjectId",
      "waveId",
      "waveIndex"
    ]);
    const observations = context.observations as string[];
    expect(observations).toEqual([...observations].sort((a, b) => a.localeCompare(b)));
    expect(observations[0]).toContain("3.12-slim");

    // One hash-chained audit event, paired on the Decision actually having been created.
    const audits = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, org.orgId),
            eq(auditEvents.action, CAMPAIGN_ADOPTION_AUDIT_ACTION)
          )
        )
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decisionId).toBe(rows[0]!.id);
  });

  it("D2: a component still at 2.7 DOES get a member Change — `not_adopted` never short-circuits the campaign", async () => {
    const { org, componentId } = await fixture("adopt-d2");
    await declare(org, componentId, {
      major: "2",
      manifestPath: "Dockerfile",
      declaredVersion: "2.7-slim",
      resolvedVersion: "2.7-slim"
    });
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));

    await tick(org, 2);

    expect(await changeCount(org)).toBe(1);
    const plan = await planFor(org, campaignId);
    expect(plan!.waves[0]!.targets[0]!.status).toBe("change_proposed");
    expect(plan!.waves[0]!.targets[0]!.memberChangeObjectId).not.toBeNull();
    expect(await decisionsOfKind(org, campaignId, CAMPAIGN_ADOPTION_DECISION_KIND)).toHaveLength(0);
  });

  /**
   * THE ASYMMETRY, ASSERTED AT THE ACTUATOR. `unknown` and `adopted` must never be treated alike: a
   * component whose manifests have never been ingested is one the campaign still has work to do for.
   */
  it("D3: ZERO inventory rows is `unknown` and the campaign STILL FANS OUT — unknown is never adopted", async () => {
    const { org, componentId } = await fixture("adopt-d3");
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));

    const verdict = await evaluate(org, campaignId, componentId, pythonRecipe("3.0"));
    expect(verdict.verdict).toBe("unknown");

    await tick(org, 2);

    expect(await changeCount(org), "an unknown verdict must not short-circuit the fan-out").toBe(1);
    const plan = await planFor(org, campaignId);
    expect(plan!.waves[0]!.targets[0]!.status).toBe("change_proposed");
    expect(await decisionsOfKind(org, campaignId, CAMPAIGN_ADOPTION_DECISION_KIND)).toHaveLength(0);
  });

  it("D4: a campaign whose recipe declares NO adoption is untouched — it fans out and writes no adoption Decision", async () => {
    const { org, componentId } = await fixture("adopt-d4");
    const campaignId = await campaignFor(org, componentId, {
      version: 1,
      trigger: { kind: "sync" }
    });
    await declare(org, componentId, {
      major: "3",
      manifestPath: "Dockerfile",
      declaredVersion: "3.12",
      resolvedVersion: "3.12"
    });

    await tick(org, 2);

    // The inventory says 3.12, but nothing asked — so the campaign does exactly what it did before
    // M25.5. Inertness, asserted at the actuator rather than only in the predicate's unit test.
    expect(await changeCount(org)).toBe(1);
    expect(await decisionsOfKind(org, campaignId, CAMPAIGN_ADOPTION_DECISION_KIND)).toHaveLength(0);
  });

  // ===========================================================================================
  // E — CONSUMER 2: the read surface, over the SAME predicate
  // ===========================================================================================

  it("E1: GET /campaigns/{id}/adoption reports the per-target verdict, the evidence source and the observations", async () => {
    const { org, componentId } = await fixture("adopt-e1");
    await declare(org, componentId, {
      major: "2",
      manifestPath: "Dockerfile",
      declaredVersion: "2.7",
      resolvedVersion: "2.7"
    });
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));

    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/adoption`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      campaignObjectId: string;
      evidence: { kind: string; coordinate?: string } | null;
      targets: { targetObjectId: string; verdict: string; observations: string[] }[];
      unresolvedTargets: string[];
    };

    expect(body.campaignObjectId).toBe(campaignId);
    expect(body.evidence).toEqual({
      kind: "dependency",
      ecosystem: "oci",
      coordinate: PY_COORDINATE,
      minVersion: "3.0"
    });
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]!.targetObjectId).toBe(componentId);
    expect(body.targets[0]!.verdict).toBe("not_adopted");
    expect(body.targets[0]!.observations[0]).toContain("2.7");
    expect(body.unresolvedTargets).toEqual([]);
  });

  it("E2: a campaign with no recipe reports `evidence: null` and every target `unknown`", async () => {
    const { org, componentId } = await fixture("adopt-e2");
    const campaignId = await campaignFor(org, componentId);

    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/adoption`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      evidence: unknown;
      targets: { verdict: string }[];
    };
    expect(body.evidence).toBeNull();
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]!.verdict).toBe("unknown");
  });

  it("E3: the same report is produced by the repo function the route calls — one core, no second reader", async () => {
    const { org, componentId } = await fixture("adopt-e3");
    await declare(org, componentId, {
      major: "3",
      manifestPath: "Dockerfile",
      declaredVersion: "3.12",
      resolvedVersion: "3.12"
    });
    const campaignId = await campaignFor(org, componentId, pythonRecipe("3.0"));

    const report = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      buildCampaignAdoptionReport(tx, org.orgId, campaignId)
    );
    expect(report.targets.map((t) => t.verdict)).toEqual(["adopted"]);
  });
});
