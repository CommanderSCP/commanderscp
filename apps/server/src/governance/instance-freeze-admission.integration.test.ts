import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { GraphObject, PutInstanceFreezeRequest } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  RawScpAppClient,
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { getOrgRootObjectId } from "../graph/objects-repo.js";
import { evaluateGovernanceGate } from "./gate-orchestrator.js";
import { getSharedCelSandbox } from "./cel-sandbox.js";

/**
 * M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER, end to end against real Postgres
 * (drizzle/0086, docs/proposals/campaigns-rework.md §2, owner decision D1).
 *
 * The guarantee under test: *a freeze declared by this DEPLOYMENT'S OPERATOR, addressed by stage
 * coordinate and carrying no `org_id` at all, holds the targets it covers in EVERY org on the
 * instance — including an org that has declared no freeze of its own and cannot author or (by
 * default) override one.*
 *
 * ============================================================================================
 * WHAT EACH CASE IS FOR, AND WHY NONE OF THEM IS THE OBVIOUS ONE-DIRECTION SHAPE
 * ============================================================================================
 *  A. WIRING — the route is INSTALLED, not merely written. Delete the `registerInstanceFreezeRoutes`
 *     line in `app.ts` and this goes red; nothing else here would notice, because every other case
 *     could reach the table through the repo layer.
 *  B. THE TWO CREDENTIALS — an authenticated tenant Owner cannot write this surface; the operator
 *     token can. A one-directional version (only the success) would pass against a door with no
 *     lock at all.
 *  C. THE BLOCK ACROSS THE TIER BOUNDARY — an org with no freeze of its own, blocked.
 *  D. ADDRESSING, BOTH WIDTHS — `environment` alone reaches every region of it; `environment` +
 *     `region` reaches exactly one and admits its siblings (D5 per-target admission, proving that
 *     property is NOT tier-specific).
 *  E. THE OVERRIDE RULING, BOTH DIRECTIONS — the SAME org-root Owner holding `freeze:override` is
 *     REFUSED against a non-overridable platform freeze and ADMITTED once the operator sets
 *     `overridable`. Either direction alone is the vacuous shape: refusal alone passes against a
 *     freeze nobody can ever override, admission alone passes against no check at all.
 *  F. CRITICAL #2 ACROSS TIERS — a change covered by an org freeze AND a platform freeze needs
 *     BOTH satisfied, and satisfying one is not authority over the other.
 *  G. RLS UNDER A REAL LEAST-PRIVILEGED PRINCIPAL — `RawScpAppClient` authenticates as `scp_app`,
 *     NOT as the Testcontainers superuser. This is non-negotiable and it is why it exists:
 *     migrations 0029/0035/0036/0074 all shipped operator-write tables with NO WRITABLE PRINCIPAL
 *     AT ALL and the suite was green throughout, because the bootstrap user bypasses grants and
 *     RLS unconditionally. 0083 §2 then did it AGAIN. The `scp_operator` half is probed with
 *     `has_table_privilege` and `pg_policies` for the same reason — the superuser connection every
 *     other case runs on is structurally incapable of observing either.
 *
 * EVERY CASE USES A UNIQUE `environment` LABEL. The instance tier has no `org_id`, so within this
 * file's database (isolation is per FILE — see `vitest.integration.config.ts`) one case's freeze is
 * live for every other case. A shared environment name would make the cases order-dependent in a
 * way that reads as flake; a `matchAllEnvironments` freeze is authored in exactly ONE case and
 * lifted before that case returns.
 */

const OPERATOR_TOKEN = "m25-3-instance-freeze-operator-token";

describe("instance-scoped (platform) freezes: the tier above org (M25.3)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let orgRootId: string;

  beforeAll(async () => {
    server = await listenTestServer({ operatorToken: OPERATOR_TOKEN });
    org = await createTestOrg(server, "instfreeze");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    orgRootId = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getOrgRootObjectId(tx, org.orgId)
    );
  });

  afterAll(async () => {
    await server?.close();
  });

  const uniq = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;

  /** A `deployment-target` DECLARING where it runs — the M15.6 / ADR-0017 §3 convention a platform
   *  freeze addresses. `region` omitted means the stage declares an environment and no region,
   *  which case D relies on being a real and distinct shape. */
  const stage = (environment: string, region?: string) =>
    admin.deploymentTargets.create({
      name: uniq(region ?? environment),
      properties: region === undefined ? { environment } : { environment, region }
    });

  /** A component with one placement per stage. A stage-shaped wave target is the PLACEMENT, which
   *  carries no environment/region of its own — the placement -> deployment-target hop inside
   *  `readStageCoordinate` is the only reason an environment-addressed freeze reaches it. */
  async function componentAt(label: string, stages: GraphObject[]) {
    const component = await createTestComponent(admin, { name: uniq(label) });
    const placementByStage = new Map<string, string>();
    for (const s of stages) {
      const placement = await admin.placements.create({
        component: component.id,
        deploymentTarget: s.id
      });
      placementByStage.set(s.id, placement.id);
    }
    return { id: component.id, at: (s: GraphObject) => placementByStage.get(s.id)! };
  }

  const openWindow = () => ({
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 3_600_000).toISOString()
  });

  /** Author a platform freeze THROUGH THE SHIPPED OPERATOR DOOR (SDK -> route -> `scp_operator`
   *  connection), never by poking the table: a fixture that wrote the row directly would leave the
   *  door itself untested while every downstream case looked healthy. */
  const platformFreeze = (
    key: string,
    match: PutInstanceFreezeRequest["match"],
    extra: Partial<PutInstanceFreezeRequest> = {}
  ) =>
    admin.instanceFreezes.put(
      key,
      { ...openWindow(), reason: `${key}: integration fixture`, match, ...extra },
      OPERATOR_TOKEN
    );

  /** The ORG-tier freeze beside the platform one, authored through the ordinary operator door.
   *
   *  M25.9 MOVED THIS OFF THE REPO SEAM. It used to insert the row directly with
   *  `createdByActorId: org.orgId` — the ORG object, which is nobody's subject — and cases F and I
   *  below then retract it as `admin`. Owner ruling D1 made lifting a freeze you did not declare
   *  cost `freeze:override`, so a fixture attributed to the org root turned both of those lifts into
   *  a 403 for a reason neither case is about. Authored through `POST /api/v1/freezes` as `admin`,
   *  the creator IS the retracting subject and the lift stays the plain `freeze:write` act the
   *  cases mean it to be. The platform tier's fixture already went through its own shipped door for
   *  the same reason (see `platformFreeze`). */
  const orgFreezeAt = (scopeObjectId: string, name: string) =>
    admin.freezes.create({
      ...openWindow(),
      scopeObjectId,
      name,
      reason: `${name}: org-tier integration fixture`
    });

  const waveGate = (targetObjectIds: string[], changeObjectId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      evaluateGovernanceGate(tx, getSharedCelSandbox(), null, {
        orgId: org.orgId,
        changeObjectId,
        targetObjectIds,
        actorObjectId: org.orgId,
        emergency: false,
        gateKind: "wave_boundary",
        gateRef: { waveIndex: 0 }
      })
    );

  /** The LIFECYCLE edge, deliberately: it keeps any-target-frozen => block (there is no such thing
   *  as accepting three quarters of a change) and it is the ONLY path on which the override loop is
   *  reachable at all — `EvaluateWaveGateContext` carries no `overrideFreeze` field. That is the
   *  proposal's "honest limit" and it is pre-existing, not created by M25.3.
   *
   *  `targetObjectIds` MUST BE THE CHANGE'S DECLARED TARGETS — components/services — and never a
   *  placement, because that is what the production caller supplies. `coordination/gates.ts`'s
   *  `evaluateLifecycleGate` builds this set as `targetObjectIdsOf(changeObject.properties)`; only
   *  the WAVE boundary ever sees placements (the plan compiler expands targets into them). Passing
   *  a placement here was a review finding: it made cases E and F green in a configuration the
   *  lifecycle edge cannot produce, and it is the reason case E2 below exists — a component target
   *  declares no stage coordinate, so at this edge ONLY a deployment-wide platform freeze matches. */
  const acceptGate = (
    targetObjectIds: string[],
    changeObjectId: string,
    actorObjectId: string,
    overrideFreeze?: { reason: string }
  ) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      evaluateGovernanceGate(tx, getSharedCelSandbox(), null, {
        orgId: org.orgId,
        changeObjectId,
        targetObjectIds,
        actorObjectId,
        emergency: false,
        gateKind: "lifecycle_edge",
        gateRef: { fromState: "validating", toState: "accepted" },
        overrideFreeze
      })
    );

  const propose = (label: string, targets: string[]) =>
    admin.changes.propose({ name: uniq(label), targets });

  /** The wave boundary FOR A ROLLBACK — the D7 exemption path (case I). `isRollback` lives on the
   *  shared `GateContext` and only `evaluateWaveGate` ever sets it in production. */
  const rollbackWaveGate = (targetObjectIds: string[], changeObjectId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      evaluateGovernanceGate(tx, getSharedCelSandbox(), null, {
        orgId: org.orgId,
        changeObjectId,
        targetObjectIds,
        actorObjectId: org.orgId,
        emergency: false,
        gateKind: "wave_boundary",
        gateRef: { waveIndex: 0 },
        isRollback: true
      })
    );

  // ============================================================================================
  // A — WIRING. Built, and INSTALLED.
  // ============================================================================================
  it("A: the operator door is registered on the running server (delete the app.ts line, this goes red)", async () => {
    const items = await admin.instanceFreezes.list();
    expect(Array.isArray(items)).toBe(true);
  });

  // ============================================================================================
  // B — TWO AUDIENCES, TWO CREDENTIALS. Both directions.
  // ============================================================================================
  it("B: an org Owner cannot author a platform freeze; the operator token can — and the tenant can READ it", async () => {
    const key = uniq("b-two-credentials");
    const body: PutInstanceFreezeRequest = {
      ...openWindow(),
      reason: "B: authored without a token",
      match: { environment: uniq("b-env") }
    };

    // The org's ADMIN token — the most privileged tenant credential this org has. `freeze:write` is
    // not added at this tier and no role, including Owner, can author one.
    await expect(
      admin.instanceFreezes.put(key, body, "not-the-operator-token")
    ).rejects.toBeInstanceOf(ScpApiError);
    await expect(admin.instanceFreezes.list()).resolves.toEqual(
      expect.not.arrayContaining([expect.objectContaining({ key })])
    );

    const written = await admin.instanceFreezes.put(key, body, OPERATOR_TOKEN);
    expect(written.key).toBe(key);
    expect(written.overridable, "a loosening never defaults on").toBe(false);
    expect(written.atomic).toBe(false);

    // READ is tenant-facing (charter principle 6): the one freeze a tenant can neither author nor
    // override is the one it most needs to be able to see.
    const listed = await admin.instanceFreezes.list();
    expect(listed.map((f) => f.key)).toContain(key);

    // And the retraction is the operator's too, with a mandatory reason.
    const lifted = await admin.instanceFreezes.lift(
      key,
      { reason: "B: fixture cleanup" },
      OPERATOR_TOKEN
    );
    expect(lifted.liftedAt).not.toBeNull();
    // A retraction is FINAL — 0085's ruling one tier up. A re-PUT of the key is refused rather
    // than silently resurrecting a row every Decision citing its id already describes.
    await expect(admin.instanceFreezes.put(key, body, OPERATOR_TOKEN)).rejects.toBeInstanceOf(
      ScpApiError
    );
    // LIFTED IS A FIELD, NOT AN ABSENCE: the row is still listed, so a months-old block Decision's
    // freeze id still resolves.
    expect((await admin.instanceFreezes.list()).map((f) => f.key)).toContain(key);
  });

  it("B2: a body with neither addressing form is refused — an absent environment is NOT deployment-wide", async () => {
    // THE DEPARTURE FROM THE PROPOSAL, asserted rather than only argued in a header. The proposal
    // read `match_environment IS NULL` as deployment-wide; a dropped empty string or a typo'd key
    // would then author the widest governance act on the instance with no error anywhere.
    await expect(
      admin.instanceFreezes.put(
        uniq("b2-neither"),
        {
          ...openWindow(),
          reason: "B2: neither form",
          match: {} as PutInstanceFreezeRequest["match"]
        },
        OPERATOR_TOKEN
      )
    ).rejects.toBeInstanceOf(ScpApiError);
    // Both forms at once is equally refused — the two are exclusive, not a precedence.
    await expect(
      admin.instanceFreezes.put(
        uniq("b2-both"),
        {
          ...openWindow(),
          reason: "B2: both forms",
          match: { allEnvironments: true, environment: "prod" }
        },
        OPERATOR_TOKEN
      )
    ).rejects.toBeInstanceOf(ScpApiError);
  });

  // ============================================================================================
  // C — THE POINT OF THE TIER: an org that declared nothing is still blocked.
  // ============================================================================================
  it("C: a platform freeze blocks a wave in an org that has declared no freeze of its own", async () => {
    const env = uniq("c-env");
    const prod = await stage(env, "amer");
    const component = await componentAt("c-component", [prod]);
    const change = await propose("c-change", [component.id]);

    const before = await waveGate([component.at(prod)], change.id);
    expect(before.verdict, "nothing is frozen yet — the control").toBe("allow");

    const freeze = await platformFreeze(uniq("c-platform"), { environment: env });

    const after = await waveGate([component.at(prod)], change.id);
    expect(
      after.verdict,
      "the merge across tiers is a UNION: the empty org set contributes FALSE to an OR"
    ).toBe("block");
    const blocked = after.inputContext.freeze as {
      id: string;
      tier: string;
      scopeObjectId: string | null;
      match: { environment: string | null };
    };
    expect(blocked.id).toBe(freeze.id);
    // The Decision names WHICH SURFACE resolves this id. Without `tier` a reader would try
    // `GET /v1/freezes/{id}`, which is org-scoped, and get a 404 for a freeze that is in force.
    expect(blocked.tier).toBe("platform");
    expect(blocked.scopeObjectId, "no object id exists across orgs — that is the whole tier").toBe(
      null
    );
    expect(blocked.match.environment).toBe(env);

    await admin.instanceFreezes.lift(freeze.key, { reason: "C: cleanup" }, OPERATOR_TOKEN);
    const released = await waveGate([component.at(prod)], change.id);
    expect(released.verdict, "a lift retires it on every path at once").toBe("allow");
  });

  // ============================================================================================
  // D — ADDRESSING AT BOTH WIDTHS, and D5 per-target admission at the platform tier.
  // ============================================================================================
  it("D: environment alone reaches every region of it; environment+region reaches exactly one and admits its siblings", async () => {
    const env = uniq("d-env");
    const amer = await stage(env, "amer");
    const emea = await stage(env, "emea");
    // A stage that declares the environment and NO region — a real shape, and the one an
    // `environment`-only freeze must still cover while a region-narrowed one must not.
    const unlabelled = await stage(env);
    const elsewhere = await stage(uniq("d-other-env"), "amer");

    const component = await componentAt("d-component", [amer, emea, unlabelled, elsewhere]);
    const targets = [
      component.at(amer),
      component.at(emea),
      component.at(unlabelled),
      component.at(elsewhere)
    ];
    const change = await propose("d-change", [component.id]);

    // --- WIDE: environment only.
    const wide = await platformFreeze(uniq("d-wide"), { environment: env });
    const wideGate = await waveGate(targets, change.id);
    const coveredBy = (outcome: Awaited<ReturnType<typeof waveGate>>) =>
      (outcome.frozenTargets ?? [])
        .filter((e) => e.freezes.length > 0)
        .map((e) => e.targetObjectId)
        .sort();
    expect(
      coveredBy(wideGate),
      "'freeze prod' means prod — including the stage that declared no region, and excluding another environment's amer"
    ).toEqual([component.at(amer), component.at(emea), component.at(unlabelled)].sort());
    expect(
      wideGate.verdict,
      "three of four covered, none atomic — the wave gate stands aside and the per-target loop withholds exactly the covered ones (D5)"
    ).toBe("allow");
    await admin.instanceFreezes.lift(wide.key, { reason: "D: narrowing" }, OPERATOR_TOKEN);

    // --- NARROW: environment + region.
    const narrow = await platformFreeze(uniq("d-narrow"), { environment: env, region: "amer" });
    const narrowGate = await waveGate(targets, change.id);
    expect(
      coveredBy(narrowGate),
      "exactly one stage — a target that declares no region has not said it is that region"
    ).toEqual([component.at(amer)]);
    expect(
      narrowGate.verdict,
      "D5 per-target admission is NOT tier-specific: a platform freeze on one region holds that region and admits its siblings"
    ).toBe("allow");

    await admin.instanceFreezes.lift(narrow.key, { reason: "D: cleanup" }, OPERATOR_TOKEN);
  });

  // ============================================================================================
  // E — THE OVERRIDE RULING. BOTH DIRECTIONS, SAME ACTOR.
  // ============================================================================================
  it("E: an org-root Owner with freeze:override CANNOT override a non-overridable platform freeze, and CAN once the operator admits it", async () => {
    const env = uniq("e-env");
    const prod = await stage(env, "amer");
    const component = await componentAt("e-component", [prod]);
    const change = await propose("e-change", [component.id]);
    // THE TARGETS THE LIFECYCLE EDGE ACTUALLY BUILDS — the change's DECLARED targets, never its
    // placements (see `acceptGate`). An earlier version of this case passed `component.at(prod)`,
    // which no production caller of `lifecycle_edge` supplies, and paired it with an
    // environment-addressed freeze — a combination that only matches because of the placement.
    const declared = [component.id];
    // THE MOST PRIVILEGED TENANT PRINCIPAL THIS ORG CAN HAVE: Owner at the ORG ROOT, which is the
    // widest scope `hasPermission`'s org-filtered `scopeExpandCte` can express. If anyone could
    // override a platform freeze, it would be this actor.
    const owner = await createTestUser(server, org, [{ role: "Owner", scope: orgRootId }]);

    const key = uniq("e-platform");
    // DEPLOYMENT-WIDE, AND THAT IS THE POINT, not a convenience: `allEnvironments` is the ONE
    // addressing form that reaches a component-shaped target, so it is the only form under which
    // this edge — the only edge the override loop runs on — can reach the ruling at all. Case E2
    // pins the other half of that fact. Authored and lifted inside this case, per the file header.
    await platformFreeze(key, { allEnvironments: true }); // overridable defaults to false

    const refused = await acceptGate(declared, change.id, owner.objectId, {
      reason: "E: incident bridge approved"
    });
    expect(
      refused.verdict,
      "not overridable by ANY tenant role, however privileged — it was declared by the deployment's operator about the deployment"
    ).toBe("block");
    expect(refused.inputContext.overrideRejected).toEqual(
      expect.stringContaining("no tenant role can override it")
    );
    // The refusal names the REMEDY that does exist, because a refusal an operator cannot act on is
    // the same as an unexplained one.
    expect(refused.inputContext.overrideRejected).toEqual(
      expect.stringContaining(`/v1/instance/freezes/${key}`)
    );

    // THE OTHER DIRECTION. Same freeze key, same actor, same reason — one operator-set bit apart.
    // Without this arm the assertion above would pass just as well against a tier nobody can ever
    // override for any reason, which is not what was ruled.
    await platformFreeze(key, { allEnvironments: true }, { overridable: true });

    const admitted = await acceptGate(declared, change.id, owner.objectId, {
      reason: "E: incident bridge approved"
    });
    expect(
      admitted.verdict,
      "the operator ADMITS tenant override per freeze; the tenant must still hold freeze:override at its org root and still must give a reason"
    ).toBe("allow");
    expect(admitted.freezeOverrides?.map((o) => o.scopeObjectId)).toEqual([orgRootId]);

    // AND THE REASON IS STILL MANDATORY under the admitted bit — the two authorities are
    // independent and both are required, so admitting override does not admit an unreasoned one.
    const noReason = await acceptGate(declared, change.id, owner.objectId, {
      reason: "   "
    });
    expect(noReason.verdict).toBe("block");

    // AND A PRINCIPAL WITHOUT THE PERMISSION IS STILL REFUSED under the admitted bit.
    const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: orgRootId }]);
    const unprivileged = await acceptGate(declared, change.id, viewer.objectId, {
      reason: "E: let me through"
    });
    expect(unprivileged.verdict).toBe("block");

    await admin.instanceFreezes.lift(key, { reason: "E: cleanup" }, OPERATOR_TOKEN);
  });

  // ============================================================================================
  // E2 — WHERE THE OVERRIDE RULING CAN AND CANNOT BE REACHED. The limit, pinned rather than
  // described, because it is the shape a reviewer found cases E and F passing in.
  // ============================================================================================
  it("E2: an environment-addressed platform freeze holds at the WAVE boundary and is invisible at the LIFECYCLE edge — so `overridable` is only reachable deployment-wide", async () => {
    const env = uniq("e2-env");
    const prod = await stage(env, "amer");
    const component = await componentAt("e2-component", [prod]);
    const change = await propose("e2-change", [component.id]);
    const owner = await createTestUser(server, org, [{ role: "Owner", scope: orgRootId }]);

    const key = uniq("e2-platform");
    // AUTHORED `overridable: true`, so an allow below cannot be read as "the operator forbade it".
    await platformFreeze(key, { environment: env }, { overridable: true });

    // THE CONTROL — it really is in force, at the boundary where a stage coordinate exists. Without
    // this the assertion underneath would pass just as well against a freeze that was never written.
    const held = await waveGate([component.at(prod)], change.id);
    expect(
      held.verdict,
      "the wave boundary resolves a PLACEMENT, whose deployment-target declares the environment"
    ).toBe("block");

    // THE LIMIT. `evaluateLifecycleGate` evaluates the change's DECLARED targets — a component,
    // which is not a deployment-target and declares no stage coordinate — so
    // `instanceFreezeCovers` is false for every form except `allEnvironments`. The accept edge
    // therefore ALLOWS while the wave boundary blocks.
    const accepted = await acceptGate([component.id], change.id, owner.objectId, {
      reason: "E2: would override if there were anything to override"
    });
    expect(
      accepted.verdict,
      "an environment-addressed platform freeze does not reach the accept edge: the target declares no stage"
    ).toBe("allow");
    // AND THE ALLOW IS "NOTHING MATCHED", NOT "OVERRIDDEN" — the distinction the whole case turns
    // on. An override would have produced an entry here and a `freeze.override` audit event.
    expect(
      accepted.freezeOverrides ?? [],
      "nothing was overridden, because nothing matched — which is why `overridable` buys nothing for an environment-addressed freeze"
    ).toEqual([]);

    // THE CONSEQUENCE, STATED SO IT CHANGES LOUDLY: `EvaluateWaveGateContext` carries no
    // `overrideFreeze` (pre-existing, and true at the org tier too), so the override loop runs ONLY
    // on `validating -> accepted`. Combine the two facts and `overridable: true` is exercisable for
    // `allEnvironments` freezes and for nothing else. If a later change gives the wave boundary an
    // override path, or expands a component target to its placements at the accept edge, this
    // assertion goes red and the ADR-0040 §7 limit has to be rewritten rather than quietly lapsing.
    await admin.instanceFreezes.lift(key, { reason: "E2: cleanup" }, OPERATOR_TOKEN);
  });

  // ============================================================================================
  // F — CRITICAL #2 ACROSS THE TIER BOUNDARY.
  // ============================================================================================
  it("F: an org freeze AND a platform freeze over one change both have to be satisfied", async () => {
    const env = uniq("f-env");
    const prod = await stage(env, "amer");
    const component = await componentAt("f-component", [prod]);
    const change = await propose("f-change", [component.id]);
    const owner = await createTestUser(server, org, [{ role: "Owner", scope: orgRootId }]);
    // The lifecycle edge's REAL target set (see `acceptGate` and case E2).
    const declared = [component.id];

    const key = uniq("f-platform");
    // The platform freeze is authored OVERRIDABLE from the start, so this case measures the
    // quantifier and not the ruling case E already owns — and DEPLOYMENT-WIDE, because that is the
    // only form that reaches a component-shaped target at this edge (case E2).
    await platformFreeze(key, { allEnvironments: true }, { overridable: true });
    const orgFreeze = await orgFreezeAt(component.id, "f-component-freeze");

    // Satisfying the platform freeze alone is not authority over the org freeze. The org-root Owner
    // holds `freeze:override` at the root, which EXPANDS DOWN to the component — so to make the
    // quantifier the thing under test, the actor here holds it nowhere.
    const nobody = await createTestUser(server, org, [{ role: "Viewer", scope: orgRootId }]);
    const neither = await acceptGate(declared, change.id, nobody.objectId, {
      reason: "F: attempt"
    });
    expect(neither.verdict).toBe("block");

    // THE SHARP ARM, and the one the `nobody` arm above does NOT measure: an actor who holds
    // `freeze:override` SOMEWHERE — enough to satisfy the org freeze at its own scope — and not at
    // the org root, where the admitted platform freeze is checked. A Viewer proves nothing about
    // the quantifier because it fails both halves; this principal fails exactly one, which is what
    // "every freeze, at ITS OWN scope" means. Scope expansion runs DOWNWARD, so an Owner at the
    // component reaches the component and never the root above it.
    const componentOwner = await createTestUser(server, org, [
      { role: "Owner", scope: component.id }
    ]);
    const partial = await acceptGate(declared, change.id, componentOwner.objectId, {
      reason: "F: authority over the org freeze only"
    });
    expect(
      partial.verdict,
      "authority over one freeze is not authority over the other — the quantifier is universal"
    ).toBe("block");
    expect(
      partial.inputContext.overrideRejected,
      "and the refusal names the tier and the scope it was checked at, not merely 'blocked'"
    ).toEqual(expect.stringContaining(orgRootId));

    // The org-root Owner satisfies BOTH — the platform freeze at the org root (admitted), and the
    // org freeze at the component (reached by org-root scope expansion). Both overrides are
    // recorded INDIVIDUALLY: one audited override per freeze, never one for the set.
    const both = await acceptGate(declared, change.id, owner.objectId, {
      reason: "F: incident bridge approved"
    });
    expect(both.verdict).toBe("allow");
    expect(
      [...(both.freezeOverrides ?? [])].map((o) => o.freezeId).sort(),
      "CRITICAL #2 spans the tier boundary: one override per active freeze from EITHER tier"
    ).toEqual(
      [orgFreeze.id, (await admin.instanceFreezes.list()).find((f) => f.key === key)!.id].sort()
    );

    // AND THE PLATFORM FREEZE CANNOT BE SUBTRACTED BY THE ORG. Retract the ORG freeze and the
    // platform one still blocks an actor with no override at all — the floor property, which lives
    // entirely in `overridable` and never in the merge.
    await admin.freezes.lift(orgFreeze.id, { reason: "F: org lifts its own" });
    const stillPlatform = await acceptGate(declared, change.id, nobody.objectId);
    expect(stillPlatform.verdict).toBe("block");
    expect((stillPlatform.inputContext.freeze as { tier: string }).tier).toBe("platform");

    await admin.instanceFreezes.lift(key, { reason: "F: cleanup" }, OPERATOR_TOKEN);
  });

  // ============================================================================================
  // H — WHITESPACE IN THE OPERATOR'S MATCH VALUE. A freeze that reads as in force and holds
  // NOTHING is the one failure mode this tier must not have.
  // ============================================================================================
  it("H: an environment authored with stray whitespace is trimmed and still holds — it does not silently match nothing", async () => {
    const env = uniq("h-env");
    const prod = await stage(env, "amer");
    const component = await componentAt("h-component", [prod]);
    const change = await propose("h-change", [component.id]);

    // THE FIXTURE IS THE BUG: `readStageCoordinate` trims what the GRAPH declares and
    // `instanceFreezeCovers` compares with `!==`, so an untrimmed `" env "` on the operator's side
    // matched nothing at all while `PUT` returned 200 and `GET /v1/instance/freezes` listed the row
    // cleanly. 0086's `instance_freezes_match_ck` cannot close it — `length(btrim(...)) > 0` TESTS
    // a value, it does not STORE one.
    const key = uniq("h-platform");
    const written = await platformFreeze(key, { environment: `  ${env}  `, region: " amer " });
    expect(
      written.match.environment,
      "the value is trimmed where it ENTERS, so what is stored is what will be compared"
    ).toBe(env);
    expect(written.match.region).toBe("amer");

    const gate = await waveGate([component.at(prod)], change.id);
    expect(
      gate.verdict,
      "and it therefore actually holds — the assertion that would have failed before the trim"
    ).toBe("block");

    await admin.instanceFreezes.lift(key, { reason: "H: cleanup" }, OPERATOR_TOKEN);

    // AN ALL-WHITESPACE VALUE IS A 400 NAMING THE ADDRESSING RULE, not a row that matches nothing:
    // `.trim()` runs BEFORE `.min(1)`, so "   " is an absent environment, and an absent environment
    // is not deployment-wide (case B2).
    await expect(
      admin.instanceFreezes.put(
        uniq("h-blank"),
        { ...openWindow(), reason: "H: blank", match: { environment: "   " } },
        OPERATOR_TOKEN
      )
    ).rejects.toBeInstanceOf(ScpApiError);
  });

  // ============================================================================================
  // I — THE D7 ROLLBACK EXEMPTION STOPS AT THE TIER BOUNDARY. Both directions, one freeze apart.
  // ============================================================================================
  it("I: a rollback wave is exempt from an ORG freeze and is NOT exempt from a platform freeze", async () => {
    const env = uniq("i-env");
    const prod = await stage(env, "amer");
    const component = await componentAt("i-component", [prod]);
    const change = await propose("i-change", [component.id]);
    const targets = [component.at(prod)];

    // DIRECTION ONE — D7 UNCHANGED AT THE ORG TIER. Holding a rollback pins a broken release in
    // place for the whole window, and this is the arm that would go red if the fix had simply
    // deleted the exemption instead of bounding it.
    const orgFreeze = await orgFreezeAt(component.id, "i-org-freeze");
    expect(
      (await waveGate(targets, change.id)).verdict,
      "the control: the org freeze really does cover this wave"
    ).toBe("block");
    expect(
      (await rollbackWaveGate(targets, change.id)).verdict,
      "D7 stands at the org tier — the org owns both sides of the 'broken release vs change window' trade"
    ).toBe("allow");

    // DIRECTION TWO — A PLATFORM FREEZE IS NEVER STOOD ASIDE. `POST /v1/changes/{id}/rollback`
    // requires `object:write` at the org and nothing else: no `freeze:override`, no reason, no
    // operator token. A tier-blind D7 made that the CHEAPEST route past the freeze `checkFreeze`
    // tells the caller "no tenant role can override, however privileged" — cheaper than the
    // override it is contrasted with, which is the contradiction this arm pins.
    const key = uniq("i-platform");
    await platformFreeze(key, { environment: env });
    const underBoth = await rollbackWaveGate(targets, change.id);
    expect(
      underBoth.verdict,
      "a rollback does not walk past a platform freeze, and a covering org freeze beside it does not lend it the exemption"
    ).toBe("block");
    expect((underBoth.inputContext.freeze as { tier: string }).tier).toBe("platform");

    // AND NOT BECAUSE THE ORG FREEZE WAS THERE. Retract it and the platform freeze alone still
    // refuses the rollback — otherwise this case would pass against a rule that merely made a
    // MIXED covering set inexempt.
    await admin.freezes.lift(orgFreeze.id, { reason: "I: org lifts its own" });
    const platformOnly = await rollbackWaveGate(targets, change.id);
    expect(platformOnly.verdict).toBe("block");
    expect((platformOnly.inputContext.freeze as { tier: string }).tier).toBe("platform");

    // `overridable` IS DELIBERATELY NOT A ROLLBACK ADMISSION. The natural guess is that the
    // operator-set bit should also admit D7; it must not, because `overridable` admits a REASONED
    // override by an actor holding `freeze:override` at the org root, and the rollback path checks
    // none of that. One bit, one meaning.
    await platformFreeze(key, { environment: env }, { overridable: true });
    expect(
      (await rollbackWaveGate(targets, change.id)).verdict,
      "admitting a high-privilege audited override does not silently admit an unaudited one at object:write"
    ).toBe("block");

    await admin.instanceFreezes.lift(key, { reason: "I: cleanup" }, OPERATOR_TOKEN);
    expect(
      (await rollbackWaveGate(targets, change.id)).verdict,
      "and with the platform freeze retracted the rollback moves again — the refusal was the freeze, not the rollback"
    ).toBe("allow");
  });

  // ============================================================================================
  // G — RLS AND GRANTS UNDER A REAL LEAST-PRIVILEGED PRINCIPAL.
  // ============================================================================================
  describe("G: the two barriers, measured as `scp_app` and not as the Testcontainers superuser", () => {
    it("scp_app can SELECT instance_freezes and cannot INSERT, UPDATE or DELETE", async () => {
      const key = uniq("g-probe");
      const created = await platformFreeze(key, { environment: uniq("g-env") });

      const raw = await RawScpAppClient.connect();
      try {
        // Tenant READ is required by charter principle 6 and is the reason `tenant_read` exists.
        // It is also the CONTROL for every refusal below: without it they would pass just as well
        // against a role that had no access to the table at all.
        await raw.setOrgContext(org.orgId);
        const read = await raw.query("SELECT id, key FROM instance_freezes WHERE key = $1", [key]);
        expect(read.rows).toHaveLength(1);
        expect((read.rows[0] as { id: string }).id).toBe(created.id);

        // BARRIER 1 (grant) — INSERT/UPDATE/DELETE were explicitly REVOKEd from `scp_app`, so
        // these fail at the privilege level, before RLS is even consulted.
        await expect(
          raw.query(
            `INSERT INTO instance_freezes (id, key, starts_at, ends_at, reason, match_all_environments)
             VALUES ($1, $2, now(), now() + interval '1 day', 'tenant-authored', true)`,
            [randomUUID(), uniq("g-forged")]
          )
        ).rejects.toThrow(/permission denied/i);
        await expect(
          raw.query("UPDATE instance_freezes SET ends_at = now() WHERE key = $1", [key])
        ).rejects.toThrow(/permission denied/i);
        await expect(
          raw.query("DELETE FROM instance_freezes WHERE key = $1", [key])
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await raw.close();
      }

      // The freeze is still exactly as the operator wrote it — a refusal that had silently
      // affected zero rows would look identical from the client's side without this.
      const after = await admin.instanceFreezes.list();
      expect(after.find((f) => f.key === key)?.endsAt).toBe(created.endsAt);
      await admin.instanceFreezes.lift(key, { reason: "G: cleanup" }, OPERATOR_TOKEN);
    });

    it("scp_operator has BOTH halves — the write grant AND a FOR ALL policy with a WITH CHECK", async () => {
      // BARRIER 2's other side, and the reason it is asserted separately: under FORCE ROW LEVEL
      // SECURITY a grant with no applicable policy is denied every statement no matter what it was
      // granted, and a policy with no grant is denied too. 0029/0035/0036/0074 shipped the read
      // half only and NOTHING in the database could write them; 0083 §2 repeated it. The suite
      // could not see either, because every operator write in it runs as a superuser.
      //
      // Probed by INTROSPECTION rather than by connecting as `scp_operator`, deliberately: the
      // role is NOLOGIN by design (drizzle/0076 — a role that cannot authenticate fails closed if
      // provisioning is skipped), so there is no password to connect with and `has_table_privilege`
      // + `pg_policies` are the honest instruments.
      const client = new pg.Client({ connectionString: testDatabaseUrl() });
      await client.connect();
      try {
        const grants = await client.query<{
          ins: boolean;
          upd: boolean;
          del: boolean;
          sel: boolean;
        }>(
          `SELECT has_table_privilege('scp_operator', 'instance_freezes', 'INSERT') AS ins,
                  has_table_privilege('scp_operator', 'instance_freezes', 'UPDATE') AS upd,
                  has_table_privilege('scp_operator', 'instance_freezes', 'DELETE') AS del,
                  has_table_privilege('scp_operator', 'instance_freezes', 'SELECT') AS sel`
        );
        expect(grants.rows[0]).toEqual({ ins: true, upd: true, del: true, sel: true });

        const policy = await client.query<{ cmd: string; qual: string; withcheck: string | null }>(
          `SELECT cmd, qual, with_check AS withcheck
             FROM pg_policies
            WHERE tablename = 'instance_freezes' AND policyname = 'operator_write'`
        );
        expect(policy.rows).toHaveLength(1);
        expect(policy.rows[0]!.cmd).toBe("ALL");
        // An omitted WITH CHECK on a FOR ALL policy is SILENT — reads and matching pass, the write
        // is refused. Asserting it is present is the only way to see that from a test.
        expect(policy.rows[0]!.withcheck).not.toBeNull();

        // And `scp_app`'s posture is UNCHANGED by any of it: SELECT only, still.
        const app = await client.query<{ sel: boolean; ins: boolean }>(
          `SELECT has_table_privilege('scp_app', 'instance_freezes', 'SELECT') AS sel,
                  has_table_privilege('scp_app', 'instance_freezes', 'INSERT') AS ins`
        );
        expect(app.rows[0]).toEqual({ sel: true, ins: false });

        // FORCE RLS, not merely ENABLE: without FORCE the table OWNER bypasses every policy above.
        const forced = await client.query<{
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'instance_freezes'`
        );
        expect(forced.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      } finally {
        await client.end();
      }
    });
  });
});
