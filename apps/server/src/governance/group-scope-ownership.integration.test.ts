import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { CelSandbox } from "./cel-sandbox.js";
import { resolveFiredPolicies } from "./evaluate.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";
import { resolvePolicies, type MatchedPolicy } from "./policy-model.js";
import { resolveEffectiveScanThreshold } from "./scan-requirements.js";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * GROUP SCOPE'S **OWNING**-SUBJECT HALF — ADR-0016 §2a (2026-08-15).
 *
 * DESIGN §10.1 has always said a group-scoped policy "applies when the change's **acting or owning
 * subject** is a `member_of` that group". Only the ACTING half was ever built. For a policy that
 * CONSTRAINS — and every enforcing consumer of `matchPoliciesForTargets` is a constraint — a scope
 * that fails to match is a constraint that does not apply, so the missing half was a FAIL-OPEN:
 * a non-member could evade a group's own gate by being the one to push the button, and the whole
 * mechanism was structurally inert wherever the actor is `SYSTEM_ACTOR_ID` (every wave boundary).
 *
 * The shipped, live exposure is the M17.5 scan-requirement gate: `resolveEffectiveScanThreshold`
 * merges a per-severity MIN over what matched, so a group-scoped scan CEILING that failed to match
 * left the effective threshold LOOSER than the operator authored — no error, no log, the gate just
 * permits more. Test (f) below is that exposure, closed.
 *
 * WHAT THIS FILE PINS, in both directions:
 *  - (a)(b)(c) the fail-open is CLOSED: a group-scoped constraint now applies to a NON-MEMBER, and
 *    to `SYSTEM_ACTOR_ID`, when the work belongs to the group;
 *  - (d) the negative control — it still applies to a MEMBER (the acting half is untouched);
 *  - (e) THE MIGRATION PIN — the acting half is preserved EXACTLY where no ownership exists: a
 *    non-member acting on an unowned target still gets no match, before and after. This is the
 *    test that says the change is additive rather than "group scope now matches everything";
 *  - (f) the live scan-threshold exposure, end to end through the real resolver;
 *  - (g) the tier LABEL: an ownership match anchors at the OWNED object, so ADR-0016 §5's promise
 *    that a block can show WHICH tier set the floor survives;
 *  - (h) ownership is graph data, so revoking it revokes the governance.
 *
 * Everything asserts against real Postgres through the real matcher — never a hand-built match set.
 */
describe("group scope: the OWNING-subject half (ADR-0016 §2a)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  /** The scoped group, and a chain it OWNS: service `owned-svc` -> component `owned-comp`. */
  let groupId: string;
  let ownedServiceId: string;
  let ownedComponentId: string;

  /** A structurally identical chain that the group does NOT own — the control for every
   *  ownership assertion, and the fixture the migration pin (e) runs against. */
  let unownedComponentId: string;

  /** A member of the group, and someone who is not — real users, so `isMemberOf`'s real
   *  `member_of` expansion decides, not a stand-in. */
  let memberObjectId: string;
  let nonMemberObjectId: string;

  const celSandboxes: CelSandbox[] = [];

  /** A group-scoped policy carrying a CONSTRAINT effect — the shape the fail-open bit. */
  const groupScopedPolicy = (name: string, effects: Record<string, unknown>[]) =>
    admin.policies.create({
      name,
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      properties: {
        scope: { group: groupId },
        enforcement: "required",
        effects
      }
    });

  const matchFor = (targetId: string, actorObjectId: string): Promise<MatchedPolicy[]> =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [targetId],
        actorObjectId
      })
    );

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "group-own");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const group = await admin.groups.create({ name: "payments-owners" });
    groupId = group.id;

    const ownedService = await admin.object("service").create({ name: "payments-api" });
    const ownedComponent = await createOrphanComponent(admin, "payments-api-worker");
    await admin.relationships.create({
      typeId: "contains",
      fromId: ownedService.id,
      toId: ownedComponent.id
    });
    // The ownership edge is recorded at the SERVICE, not the component — the normal shape
    // (`routes/ownership.ts`), and the one that makes inheritance load-bearing.
    await admin.relationships.create({
      typeId: "owns",
      fromId: group.id,
      toId: ownedService.id
    });
    ownedServiceId = ownedService.id;
    ownedComponentId = ownedComponent.id;

    const otherService = await admin.object("service").create({ name: "reporting-api" });
    const otherComponent = await createOrphanComponent(admin, "reporting-api-worker");
    await admin.relationships.create({
      typeId: "contains",
      fromId: otherService.id,
      toId: otherComponent.id
    });
    unownedComponentId = otherComponent.id;

    const member = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    const nonMember = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    await admin.relationships.create({
      typeId: "member_of",
      fromId: member.objectId,
      toId: group.id
    });
    memberObjectId = member.objectId;
    nonMemberObjectId = nonMember.objectId;
  });

  afterAll(async () => {
    await Promise.all(celSandboxes.splice(0).map((s) => s.stop()));
    await server?.close();
  });

  // -----------------------------------------------------------------------------------------
  // (a)-(c) THE FAIL-OPEN, CLOSED.
  // -----------------------------------------------------------------------------------------

  it("(a) a group-scoped CONSTRAINT applies to a NON-MEMBER when the target's service is owned by the group", async () => {
    const policy = await groupScopedPolicy("owner-half-non-member", [
      { requireApprovals: { count: 2, fromRole: "Approver", scope: "service" } }
    ]);

    const matched = await matchFor(ownedComponentId, nonMemberObjectId);
    const hit = matched.find((m) => m.policyObjectId === policy.id);

    expect(
      hit,
      "a constraint the group authored must not be evadable by having a non-member push the button"
    ).toBeDefined();
    // It matched via OWNERSHIP, not via the acting subject — the non-member is in no group at all.
    expect(hit!.matchedAt.via).toBe("ownerGroup");
    // And it anchored at the OWNED service, inheriting down to the component (not at the org root).
    expect(hit!.matchedAt.objectId).toBe(ownedServiceId);
    expect(hit!.matchedAt.depth).toBeGreaterThan(0);
    // The constraint actually survives the merge — a match that resolved to no requirement would
    // be a match in name only.
    const effective = resolvePolicies(matched).find((p) => p.name === "owner-half-non-member");
    expect(effective?.requireApprovals.map((a) => a.count)).toEqual([2]);
  });

  it("(b) ownership INHERITS down the containment chain — the edge is on the service, the target is its component", async () => {
    // (a) already proves the inherited case; this states the property directly and pins the
    // anchor, because restricting the match to a direct `owns` edge ON THE TARGET would make
    // ownership the only scope kind that does not inherit — and would fail open on every component
    // whose ownership is recorded at its service, which is the normal shape.
    await groupScopedPolicy("owner-half-inherits", [{ requireControls: ["security-scan"] }]);

    const atComponent = await matchFor(ownedComponentId, nonMemberObjectId);
    const atService = await matchFor(ownedServiceId, nonMemberObjectId);

    for (const [label, matched] of [
      ["the component inside the owned service", atComponent],
      ["the owned service itself", atService]
    ] as const) {
      const hit = matched.find((m) => m.name === "owner-half-inherits");
      expect(hit, `must govern ${label}`).toBeDefined();
      expect(hit!.matchedAt.objectId).toBe(ownedServiceId);
      expect(hit!.matchedAt.via).toBe("ownerGroup");
    }
  });

  it("(c) it applies to SYSTEM_ACTOR_ID too — the wave boundary, where the acting half is structurally inert", async () => {
    // `coordination/reconcile.ts`, `campaign-reconcile.ts`, `shouldAutoRollback` and
    // `prewarmGovernanceForChange` all pass the nil UUID, which is `member_of` nothing. Before the
    // owning half, the SAME document governed `validating -> accepted` and NOT the wave boundaries
    // of the very same change.
    await groupScopedPolicy("owner-half-system-actor", [
      { requireControls: ["integration-tests"] }
    ]);

    const matched = await matchFor(ownedComponentId, SYSTEM_ACTOR_ID);
    const hit = matched.find((m) => m.name === "owner-half-system-actor");
    expect(hit, "a group-scoped policy must not be inert at the wave boundary").toBeDefined();
    expect(hit!.matchedAt.via).toBe("ownerGroup");

    // The acting half genuinely contributes nothing here — proving the match above came from
    // ownership and not from some accidental widening of `isMemberOf`.
    expect(matched.some((m) => m.matchedAt.via === "group")).toBe(false);
  });

  it("ownership counts THROUGH membership: a user who owns the service and is member_of the group", async () => {
    // `owns` is registered from team/group/user/service-account, so the owner is very often a
    // person or a team rather than the group named by the policy. The same `member_of` closure
    // that expands a subject upward must expand the group downward, or this case silently misses.
    const service = await admin.object("service").create({ name: "ledger-api" });
    const component = await createOrphanComponent(admin, "ledger-api-worker");
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: component.id
    });
    const team = await admin.object("team").create({ name: "ledger-team" });
    await admin.relationships.create({ typeId: "owns", fromId: team.id, toId: service.id });
    await admin.relationships.create({ typeId: "member_of", fromId: team.id, toId: groupId });

    await groupScopedPolicy("owner-half-transitive", [{ requireControls: ["security-scan"] }]);

    const matched = await matchFor(component.id, nonMemberObjectId);
    const hit = matched.find((m) => m.name === "owner-half-transitive");
    expect(hit, "a team member_of the scoped group owning the service must count").toBeDefined();
    expect(hit!.matchedAt.objectId).toBe(service.id);
    expect(hit!.matchedAt.via).toBe("ownerGroup");
  });

  // -----------------------------------------------------------------------------------------
  // (d)-(e) THE NEGATIVE CONTROLS — the acting half is untouched, in both directions.
  // -----------------------------------------------------------------------------------------

  it("(d) NEGATIVE CONTROL: it still applies to a MEMBER — the acting half is untouched", async () => {
    await groupScopedPolicy("acting-half-member", [{ requireControls: ["security-scan"] }]);

    const matched = await matchFor(ownedComponentId, memberObjectId);
    const viaValues = matched
      .filter((m) => m.name === "acting-half-member")
      .map((m) => m.matchedAt.via)
      .sort();

    // BOTH halves fire for a member of the owning group, and they are labelled apart: the acting
    // half at the org root, the owning half at the service. Collapsing them onto one label is how a
    // provenance label goes quietly false.
    expect(viaValues).toEqual(["group", "ownerGroup"]);
    const acting = matched.find(
      (m) => m.name === "acting-half-member" && m.matchedAt.via === "group"
    );
    expect(acting!.matchedAt.objectId).toBe(org.orgId);
    expect(acting!.matchedAt.depth).toBe(0);
  });

  it("(e) MIGRATION PIN: where NOTHING is owned, behaviour is byte-for-byte what it was — member matches, non-member does not", async () => {
    // This is the whole migration-safety claim in one test. The change is ADDITIVE: it adds the
    // ownership half and touches nothing else, so on an estate with no `owns` edge into the target's
    // chain, a group-scoped policy behaves exactly as it did before 2026-08-15. If this ever fails,
    // group scope has been widened into "matches everything", which is a different (and wrong)
    // design than the one ADR-0016 §2a records.
    await groupScopedPolicy("acting-half-unowned", [{ requireControls: ["security-scan"] }]);

    const asMember = await matchFor(unownedComponentId, memberObjectId);
    const asNonMember = await matchFor(unownedComponentId, nonMemberObjectId);

    const memberHit = asMember.find((m) => m.name === "acting-half-unowned");
    expect(memberHit, "BEFORE and AFTER: a member still matches").toBeDefined();
    expect(memberHit!.matchedAt.via).toBe("group");

    expect(
      asNonMember.find((m) => m.name === "acting-half-unowned"),
      "BEFORE and AFTER: a non-member acting on a target the group does not own still does not match"
    ).toBeUndefined();
  });

  // -----------------------------------------------------------------------------------------
  // (f)-(g) THE LIVE EXPOSURE — the shipped M17.5 scan-requirement gate (ADR-0016).
  // -----------------------------------------------------------------------------------------

  /** The real firing set for a match set, through the real condition evaluator. */
  async function firedFor(matched: MatchedPolicy[]) {
    const sandbox = new CelSandbox();
    celSandboxes.push(sandbox);
    return resolveFiredPolicies(sandbox, resolvePolicies(matched), {
      change: { id: "c", emergency: false, targets: [], sourceKind: null, correlationKey: null },
      subject: null,
      graph: { ownerIds: [], dependentIds: [], domainIds: [] },
      controlOutcomes: {},
      approvals: {},
      time: new Date().toISOString(),
      actor: { id: SYSTEM_ACTOR_ID }
    });
  }

  it("(f) THE SHIPPED EXPOSURE: a group-scoped scan CEILING now contributes to the effective threshold for a NON-MEMBER", async () => {
    // Before the owning half this ceiling silently dropped out of the per-severity MIN for anyone
    // outside the group, leaving the M17.5 gate LOOSER than the operator authored — no error, no
    // log, the gate simply permitted more.
    await groupScopedPolicy("owner-half-scan-ceiling", [{ scanThreshold: { maxHigh: 0 } }]);

    const resolved = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const matched = await matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [ownedComponentId],
        actorObjectId: nonMemberObjectId
      });
      return resolveEffectiveScanThreshold(tx, {
        orgId: org.orgId,
        targetObjectIds: [ownedComponentId],
        actorObjectId: nonMemberObjectId,
        matches: matched,
        firedPolicies: await firedFor(matched)
      });
    });

    expect(resolved?.threshold.maxHigh, "the group's ceiling must bind for a non-member").toBe(0);
    expect(
      resolved?.contributors.some((c) => c.source.includes("owner-half-scan-ceiling")),
      "and it must be NAMED in the contributor list, so a block can cite it"
    ).toBe(true);
  });

  it("(g) ADR-0016 §5: an ownership match reports the tier of the OWNED object, not the org root", async () => {
    // The tier label is derived from `matchedAt.objectId`'s type. Anchoring an ownership match at
    // the org root (as the acting half does, having no anchor of its own) would report an ORG-tier
    // ceiling for a SERVICE-tier requirement, breaking ADR-0016 §5's promise that a blocked
    // promotion can show which tier set the binding severity floor.
    await groupScopedPolicy("owner-half-tier-label", [{ scanThreshold: { maxMedium: 3 } }]);

    const resolved = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const matched = await matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [ownedComponentId],
        actorObjectId: nonMemberObjectId
      });
      return resolveEffectiveScanThreshold(tx, {
        orgId: org.orgId,
        targetObjectIds: [ownedComponentId],
        actorObjectId: nonMemberObjectId,
        matches: matched,
        firedPolicies: await firedFor(matched)
      });
    });

    const contribution = resolved?.contributors.find((c) =>
      c.source.includes("owner-half-tier-label")
    );
    expect(contribution?.tier).toBe("service");
    expect(contribution?.objectTypeId).toBe("service");
  });

  // -----------------------------------------------------------------------------------------
  // (h) Ownership is graph data — revoking it revokes the governance.
  // -----------------------------------------------------------------------------------------

  it("(h) a soft-deleted `owns` edge stops conferring the group's governance", async () => {
    const service = await admin.object("service").create({ name: "temp-owned-svc" });
    const component = await createOrphanComponent(admin, "temp-owned-comp");
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: component.id
    });
    const edge = await admin.relationships.create({
      typeId: "owns",
      fromId: groupId,
      toId: service.id
    });
    await groupScopedPolicy("owner-half-revocable", [{ requireControls: ["security-scan"] }]);

    const before = await matchFor(component.id, nonMemberObjectId);
    expect(before.find((m) => m.name === "owner-half-revocable")).toBeDefined();

    await admin.relationships.delete(edge.id);

    const after = await matchFor(component.id, nonMemberObjectId);
    expect(
      after.find((m) => m.name === "owner-half-revocable"),
      "the expansion filters deleted_at IS NULL — a revoked ownership must stop governing"
    ).toBeUndefined();
  });
});
