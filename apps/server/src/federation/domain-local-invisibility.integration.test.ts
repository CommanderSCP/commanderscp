import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyncBundle } from "@scp/schemas";
import { changes, objects, relationships } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createObject,
  deleteObject,
  updateObject,
  upsertObjectByUrn
} from "../graph/objects-repo.js";
import { publishDomainLocalObject } from "./publish-domain-local.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { transitionChange } from "../coordination/transition.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { getSharedCelSandbox } from "../governance/cel-sandbox.js";
import { ProblemError } from "../errors.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * M20.2 (ADR-0031) — THE COMMANDER SEES NOTHING AT ALL.
 *
 * TWO GENUINELY SEPARATE POSTGRES DATABASES, because the entire claim is about what the commander's
 * database *cannot* contain. A single-database test with two orgs would prove something weaker and
 * would be satisfiable by RLS alone; this is the same faithful topology
 * `boundary-segment.integration.test.ts` established, for the same reason.
 *
 * ## The scope this runs at is the point
 *
 * `syncScope: { mode: 'full' }` on BOTH sides — the WIDEST scope there is. A narrow scope would make
 * this test pass for the wrong reason (the entries would be filtered as out-of-mode, and the
 * locality clause could be deleted without the test noticing). `full` is also the scope an operator
 * widens to when data is missing, which is exactly the moment the guarantee is relied on.
 *
 * ## What "nothing at all" is checked to mean
 *
 * Two independent assertions, because either alone is weak:
 *
 *   1. **Nothing lands.** No row in the commander's `objects` table for the domain-local component,
 *      after a real signed export→import.
 *   2. **Nothing is even shipped.** The component's id, urn and name do not appear ANYWHERE in the
 *      serialized bundle body. This is the assertion that distinguishes ADR-0031's guarantee from
 *      the weaker "the importer declines to store it" — a bundle is a file that gets written to
 *      disk, relayed across a CDS boundary and kept in transfer records, so an entry the receiver
 *      merely refuses to apply has still crossed.
 *
 * And a **negative control in the same bundle**: an ordinary component created alongside it arrives
 * normally. A test that proves nothing crossed is vacuous unless it also proves something did.
 *
 * ## Why the update and the tombstone are exercised too
 *
 * The create-path stamp alone protects nothing. Without the stamp on `updateObject`'s entry, a
 * domain-local object leaks on its SECOND write — the whole object, one revision late. Without it on
 * the tombstone, its deletion leaks both its existence and its NAME (a urn is
 * `urn:scp:<org>:<type>:<name>`). Each is asserted separately so a regression names which stamp
 * went missing.
 */
describe("M20.2 (ADR-0031): a domain-local object never reaches the commander (two databases)", () => {
  let outpost: IsolatedDomain;
  let commander: IsolatedDomain;
  let selfOutpost: FederationSelf;
  let selfCommander: FederationSelf;

  /** Everything about the domain-local component that must never appear anywhere downstream. */
  let localId: string;
  let localUrn: string;
  const LOCAL_NAME = "vpc-transit-gateway-attachments";

  let sharedId: string;
  let sharedUrn: string;
  const SHARED_NAME = "payments-api";

  /** The outpost exports its OWN journal to the commander — the upward direction this feature is
   *  about (an outpost authoring config that stays home). */
  const exportUpward = (): Promise<SyncBundle> =>
    withTenantTx(outpost.db, outpost.orgId, (tx) =>
      exportSyncBundle(tx, outpost.orgId, commander.orgName)
    );
  const importAtCommander = (bundle: SyncBundle) =>
    withTenantTx(commander.db, commander.orgId, (tx) =>
      importSyncBundle(tx, commander.orgId, bundle)
    );
  const commanderRowsFor = (urn: string) =>
    withTenantTx(commander.db, commander.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.urn, urn))
    );

  beforeAll(async () => {
    outpost = await createIsolatedDomain("domainLocalOutpost");
    commander = await createIsolatedDomain("domainLocalCommander");

    selfOutpost = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );
    selfCommander = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );
    const outpostKey = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureInstanceKey(tx, outpost.orgId)
    );
    const commanderKey = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );

    // BOTH sides `full` — see the file doc. `undefined` is peers-repo.ts's default of `full`; it is
    // passed explicitly here so a future change to that default cannot silently narrow this test.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        publicKey: commanderKey.publicKey,
        syncScope: { mode: "full" }
      })
    );
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: selfOutpost.domainId,
        name: outpost.orgName,
        role: "outpost",
        publicKey: outpostKey.publicKey,
        syncScope: { mode: "full" }
      })
    );

    await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const local = await createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "domain-local-create",
        name: LOCAL_NAME,
        properties: { cidr: "10.42.0.0/16" },
        domainLocal: true
      });
      localId = local.id;
      localUrn = local.urn;

      const shared = await createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "shared-create",
        name: SHARED_NAME
      });
      sharedId = shared.id;
      sharedUrn = shared.urn;
    });
  }, 180_000);

  afterAll(async () => {
    await outpost?.close();
    await commander?.close();
  });

  it("the object really IS domain-local at the outpost — the local side is unaffected", async () => {
    // The control that stops every later assertion from passing because the object was never
    // created, or was created somewhere the outpost cannot see either.
    const rows = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.urn, localUrn))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.domainLocal).toBe(true);
    expect(rows[0]!.name).toBe(LOCAL_NAME);
  });

  it("CREATE: at syncScope FULL, nothing about the domain-local object is shipped or landed — and the control arrives", async () => {
    const bundle = await exportUpward();
    const wire = JSON.stringify(bundle);

    // (2) nothing is even shipped — id, urn AND the bare name, since the urn embeds it.
    expect(wire).not.toContain(localId);
    expect(wire).not.toContain(localUrn);
    expect(wire).not.toContain(LOCAL_NAME);

    // THE NEGATIVE CONTROL, in the very same bundle: the ordinary component IS shipped. Without
    // this, an export that produced an empty bundle would pass every assertion above.
    expect(wire).toContain(sharedId);
    expect(wire).toContain(SHARED_NAME);

    const result = await importAtCommander(bundle);
    expect(result.appliedEntries).toBeGreaterThan(0);

    // (1) nothing lands.
    expect(await commanderRowsFor(localUrn)).toHaveLength(0);
    // ...and the control did land, so the pipe demonstrably works.
    const sharedRows = await commanderRowsFor(sharedUrn);
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0]!.id).toBe(sharedId);
    // A replica of a normally-federated object is NOT domain-local at the receiver: locality
    // describes an object that stays home, and this one demonstrably did not.
    expect(sharedRows[0]!.domainLocal).toBe(false);
  });

  it("UPDATE: the second write does not leak it either — the create-path stamp alone would be worthless", async () => {
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      updateObject(tx, {
        orgId: outpost.orgId,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "domain-local-update",
        idOrUrn: localId,
        properties: { cidr: "10.42.0.0/16", routeTables: 4 }
      })
    );

    const bundle = await exportUpward();
    const wire = JSON.stringify(bundle);
    expect(wire).not.toContain(localId);
    expect(wire).not.toContain(LOCAL_NAME);
    // The revised property must not travel either — this is the whole object, one revision later.
    expect(wire).not.toContain("routeTables");

    await importAtCommander(bundle);
    expect(await commanderRowsFor(localUrn)).toHaveLength(0);
  });

  it("TOMBSTONE: deleting it does not leak its existence or its NAME", async () => {
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      deleteObject(tx, {
        orgId: outpost.orgId,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "domain-local-delete",
        idOrUrn: localId
      })
    );

    const bundle = await exportUpward();
    const wire = JSON.stringify(bundle);
    // A tombstone payload is `{id, typeId, urn}` — and the urn is `urn:scp:<org>:<type>:<name>`, so
    // letting it cross would disclose both that the object existed and what it was called.
    expect(wire).not.toContain(localId);
    expect(wire).not.toContain(localUrn);
    expect(wire).not.toContain(LOCAL_NAME);

    await importAtCommander(bundle);
    expect(await commanderRowsFor(localUrn)).toHaveLength(0);
  });

  it("EDGE (M20.3): an edge from a domain-local object to a SHARED one does not cross either", async () => {
    // The mixed edge is the whole reason §4 inherits from EITHER endpoint. A domain-local networking
    // component `part_of` a service the commander knows is the natural modelling, and requiring BOTH
    // endpoints to be local would let exactly this case through — carrying the local object's id in
    // `fromId`.
    const local = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "edge-local",
        name: "vpc-route-tables",
        domainLocal: true
      })
    );
    const edge = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createRelationship(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "edge-create",
        typeId: "depends_on",
        fromId: local.id,
        toId: sharedId
      })
    );

    const bundle = await exportUpward();
    const wire = JSON.stringify(bundle);
    expect(wire).not.toContain(local.id);
    expect(wire).not.toContain("vpc-route-tables");
    // The EDGE's own id must not cross either — its presence would tell the commander that the
    // shared service gained a dependency it is not allowed to see.
    expect(wire).not.toContain(edge.id);

    await importAtCommander(bundle);
    const landed = await withTenantTx(commander.db, commander.orgId, (tx) =>
      tx.select().from(relationships).where(eq(relationships.id, edge.id))
    );
    expect(landed).toHaveLength(0);
  });

  it("CHANGE (M20.3): releasing a domain-local component reports nothing upward — not even status", async () => {
    // `change_status` is the entry kind a `status_only` commander receives, so this is the assertion
    // that carries the owner's "the Commander doesn't need to know when these deploy out".
    const target = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "change-target",
        name: "vpc-security-groups",
        domainLocal: true
      })
    );
    const { change } = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      proposeChange(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "change-propose",
        name: "tighten-sg-egress",
        targets: [target.id]
      })
    );

    // AND DRIVE A REAL STATE TRANSITION. `proposeChange` and `transitionChange` emit `change_status`
    // from two DIFFERENT call sites, and only the propose one is exercised by creating a change —
    // so without this the transition skip is untested. Mutation-proven: disabling
    // `transition.ts`'s `if (!row.domainLocal)` left this file entirely green until this step
    // existed, which is precisely the "green for the wrong reason" failure it now closes.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      transitionChange(
        tx,
        {
          orgId: outpost.orgId,
          changeObjectId: change.id,
          toState: "cancelled",
          actorObjectId: SYSTEM_ACTOR_ID,
          requestId: "change-transition",
          reason: "domain-local transition — must not be reported upward"
        },
        { sandbox: getSharedCelSandbox(), host: null }
      )
    );

    const bundle = await exportUpward();
    const wire = JSON.stringify(bundle);
    expect(wire).not.toContain(target.id);
    expect(wire).not.toContain(change.id);
    expect(wire).not.toContain("tighten-sg-egress");
    expect(wire).not.toContain("vpc-security-groups");
    // The transition's own reason must not travel either — `change_status` carries it verbatim.
    expect(wire).not.toContain("must not be reported upward");

    await importAtCommander(bundle);
    const landed = await withTenantTx(commander.db, commander.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.id, change.id))
    );
    expect(landed).toHaveLength(0);

    // The transition really happened locally — otherwise the assertions above would be satisfied by
    // a change that never moved, and the transition skip would still be untested.
    const localState = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, change.id))
    );
    expect(localState[0]!.state).toBe("cancelled");
  });

  it("CHANGE (M20.3): a change may not SPAN a locality boundary — refused at propose time", async () => {
    const local = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "mixed-local",
        name: "vpc-nat-gateways",
        domainLocal: true
      })
    );

    // Asserted on `.detail`, NOT via `.rejects.toThrow(/…/)`. A `ProblemError`'s `message` is the
    // bare RFC 9457 title — here "Bad Request" — so a regex matched against the message passes for
    // ANY 400 the function might throw, including the empty-targets one. This repo has already
    // shipped exactly that vacuous assertion once (a `/checksum mismatch/` that was really matching
    // `message === "Conflict"`), and it passed here too until the refusal's own text was checked.
    const refusal = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      proposeChange(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "mixed-propose",
        name: "spans-the-boundary",
        targets: [local.id, sharedId]
      })
    ).then(
      () => null,
      (err: unknown) => err as ProblemError
    );
    expect(refusal).toBeInstanceOf(ProblemError);
    expect(refusal!.status).toBe(400);
    expect(refusal!.detail).toMatch(/cannot span a locality boundary/i);
    // Both offending urns are named, so the operator can act without re-deriving which target was
    // which — the refusal has to be usable, not merely correct.
    expect(refusal!.detail).toContain(local.urn);
    expect(refusal!.detail).toContain(sharedUrn);

    // And the refusal is REAL — no change object was written on either side of the boundary.
    const orphans = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.name, "spans-the-boundary"))
    );
    expect(orphans).toEqual([]);
  });

  it("CHANGE (M20.3): an all-SHARED change still reports upward exactly as before — the control", async () => {
    // The regression control for the refusal above: locality inheritance must not have made ordinary
    // multi-target changes harder to propose.
    const { change } = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      proposeChange(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "shared-propose",
        name: "ordinary-release",
        targets: [sharedId]
      })
    );

    const bundle = await exportUpward();
    expect(JSON.stringify(bundle)).toContain(change.id);

    await importAtCommander(bundle);
    const landed = await withTenantTx(commander.db, commander.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.id, change.id))
    );
    expect(landed).toHaveLength(1);
  });

  it("PUBLISH (M20.4): a published object reaches the commander from that point on, with its shareable edges", async () => {
    // Owner decision Q2: local -> shared is a real, supported transition, exposed as an explicit
    // one-way VERB rather than a property write.
    const toPublish = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "publish-create",
        name: "vpc-flow-logs",
        domainLocal: true
      })
    );
    // Two edges: one to a SHARED object (publishable alongside it) and one to a still-local object
    // (must stay withheld — §4's either-endpoint rule still applies to that one).
    const stillLocal = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "publish-neighbour",
        name: "vpc-private-subnets",
        domainLocal: true
      })
    );
    const shareableEdge = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createRelationship(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "publish-edge-shared",
        typeId: "depends_on",
        fromId: toPublish.id,
        toId: sharedId
      })
    );
    const withheldEdge = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createRelationship(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "publish-edge-local",
        typeId: "depends_on",
        fromId: toPublish.id,
        toId: stillLocal.id
      })
    );

    // Pre-condition: none of it has crossed yet.
    await importAtCommander(await exportUpward());
    expect(await commanderRowsFor(toPublish.urn)).toHaveLength(0);

    const result = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      publishDomainLocalObject(tx, {
        orgId: outpost.orgId,
        typeId: "component",
        idOrUrn: toPublish.id,
        actorObjectId: outpost.orgId,
        requestId: "publish"
      })
    );
    expect(result.object.domainLocal).toBe(false);
    expect(result.publishedRelationshipIds).toEqual([shareableEdge.id]);
    // The partial sweep is reported, not silent — an edge to a still-local neighbour cannot travel.
    expect(result.withheldRelationshipIds).toEqual([withheldEdge.id]);

    // The DESCRIPTIVE view names the other endpoint, which is what makes a withheld edge actionable:
    // it identifies the object the operator must publish next. Asserted alongside the id arrays
    // because the two must never diverge — they are derived from one loop for exactly that reason.
    expect(result.withheldRelationships).toEqual([
      {
        id: withheldEdge.id,
        typeId: "depends_on",
        otherEndpointId: stillLocal.id,
        otherEndpointUrn: stillLocal.urn,
        otherEndpointName: "vpc-private-subnets"
      }
    ]);
    expect(result.publishedRelationships.map((r) => r.otherEndpointName)).toEqual([SHARED_NAME]);
    expect(result.publishedRelationships.map((r) => r.id)).toEqual(result.publishedRelationshipIds);

    await importAtCommander(await exportUpward());
    const landed = await commanderRowsFor(toPublish.urn);
    expect(landed).toHaveLength(1);
    expect(landed[0]!.name).toBe("vpc-flow-logs");
    // Full state, not an empty shell: re-journaling works because payloads are full-state upserts.
    expect(landed[0]!.domainLocal).toBe(false);

    const landedEdges = await withTenantTx(commander.db, commander.orgId, (tx) =>
      tx.select().from(relationships)
    );
    expect(landedEdges.map((e) => e.id)).toContain(shareableEdge.id);
    // AND the still-local neighbour did NOT come along for the ride.
    expect(landedEdges.map((e) => e.id)).not.toContain(withheldEdge.id);
    expect(await commanderRowsFor(stillLocal.urn)).toHaveLength(0);
  });

  it("PUBLISH (M20.4): publishing twice is refused, and the reverse direction has no door at all", async () => {
    const already = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "double-publish-create",
        name: "vpc-endpoints",
        domainLocal: true
      })
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      publishDomainLocalObject(tx, {
        orgId: outpost.orgId,
        typeId: "component",
        idOrUrn: already.id,
        actorObjectId: outpost.orgId,
        requestId: "double-publish-1"
      })
    );

    const second = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      publishDomainLocalObject(tx, {
        orgId: outpost.orgId,
        typeId: "component",
        idOrUrn: already.id,
        actorObjectId: outpost.orgId,
        requestId: "double-publish-2"
      })
    ).then(
      () => null,
      (err: unknown) => err as ProblemError
    );
    // Asserted on `.detail`, never `.toThrow(/…/)` — a ProblemError's message is the bare title.
    expect(second).toBeInstanceOf(ProblemError);
    expect(second!.status).toBe(409);
    expect(second!.detail).toMatch(/not domain-local/i);

    // THE ONE-WAY PROPERTY, asserted structurally rather than by trying an endpoint that should not
    // exist: shared -> domain-local is refused by the upsert precondition, and there is no verb for
    // it anywhere. Federation has no un-send, so this must never become expressible.
    const reverse = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      upsertObjectByUrn(tx, {
        orgId: outpost.orgId,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "un-publish-attempt",
        urn: already.urn,
        name: "vpc-endpoints",
        domainLocal: true
      })
    ).then(
      () => null,
      (err: unknown) => err as ProblemError
    );
    expect(reverse).toBeInstanceOf(ProblemError);
    expect(reverse!.status).toBe(409);
    expect(reverse!.detail).toMatch(/cannot become domain-local/i);
    // The remedy must be ACTIONABLE. "Create a new object instead" was measured as confusing by a
    // consumer, because a create is exactly what 409'd — the operator retries the same urn and loops.
    // The message now names the urn and says to use a different one.
    expect(reverse!.detail).toContain(already.urn);
    expect(reverse!.detail).toMatch(/different urn/i);
  });

  it("PUBLISH (M20.6): refused while a `contains` container is still domain-local, and NOTHING is written", async () => {
    // ADR-0031 §6b. Publishing a child out of a still-local container would land it at the commander
    // with no containment edge — the shape ADR-0026 measured silently stopping 11 `required` policies
    // and failing service-scoped freezes open.
    const container = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: outpost.orgId,
        requestId: "m206-container",
        name: "secure-networking",
        domainLocal: true
      })
    );
    // The state M20.5's inheritance produces, constructed directly: `createComponentInService`
    // authorizes `relationship:write`, and this file's isolated-domain harness has no RBAC subject —
    // which is why every other test here builds the object and its edge through the repos. The
    // inheritance that would normally produce this state is covered by
    // `domain-local-inheritance.integration.test.ts`; the subject HERE is the publish refusal.
    const child = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "m206-child",
        name: "vpc-peering",
        domainLocal: true
      })
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createRelationship(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "m206-child-edge",
        typeId: "contains",
        fromId: container.id,
        toId: child.id
      })
    );
    expect(child.domainLocal).toBe(true);

    const refusal = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      publishDomainLocalObject(tx, {
        orgId: outpost.orgId,
        typeId: "component",
        idOrUrn: child.id,
        actorObjectId: outpost.orgId,
        requestId: "m206-publish-child"
      })
    ).then(
      () => null,
      (err: unknown) => err as ProblemError
    );
    expect(refusal).toBeInstanceOf(ProblemError);
    expect(refusal!.status).toBe(409);
    // The refusal NAMES the offending container — the operator's next action is to publish it, and a
    // message that only says "some container" makes them go looking.
    expect(refusal!.detail).toContain("secure-networking");
    expect(refusal!.detail).toContain(container.urn);

    // And the refusal is REAL: the child is untouched, still domain-local.
    const after = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.id, child.id))
    );
    expect(after[0]!.domainLocal).toBe(true);
  });

  it("PUBLISH (M20.6): the container-then-child ORDER works, and publishing a container does NOT publish its children", async () => {
    const container = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: outpost.orgId,
        requestId: "m206-order-container",
        name: "orderable-networking",
        domainLocal: true
      })
    );
    const child = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "m206-order-child",
        name: "vpc-endpoints-ordered",
        domainLocal: true
      })
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createRelationship(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "m206-order-edge",
        typeId: "contains",
        fromId: container.id,
        toId: child.id
      })
    );

    // Publish the CONTAINER first.
    const containerResult = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      publishDomainLocalObject(tx, {
        orgId: outpost.orgId,
        typeId: "service",
        idOrUrn: container.id,
        actorObjectId: outpost.orgId,
        requestId: "m206-publish-container"
      })
    );
    expect(containerResult.object.domainLocal).toBe(false);

    // THE CONTROL THAT MAKES THE ORDER WORKABLE RATHER THAN COERCIVE: the child is NOT dragged along.
    // Publishing a container is one decision; publishing each child is another. The edge to the child
    // is withheld for exactly that reason — its other endpoint is still domain-local.
    const childAfterContainer = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.id, child.id))
    );
    expect(childAfterContainer[0]!.domainLocal).toBe(true);
    expect(containerResult.withheldRelationships.map((r) => r.otherEndpointId)).toContain(child.id);

    // NOW the child publishes cleanly — the previously-blocking container federates.
    const childResult = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      publishDomainLocalObject(tx, {
        orgId: outpost.orgId,
        typeId: "component",
        idOrUrn: child.id,
        actorObjectId: outpost.orgId,
        requestId: "m206-publish-child-2"
      })
    );
    expect(childResult.object.domainLocal).toBe(false);
    // ...and its edge to the now-shared container travels with it.
    expect(childResult.publishedRelationships.map((r) => r.otherEndpointId)).toContain(
      container.id
    );
  });

  it("PUBLISH (M20.7): publishing CLEARS the inheritance provenance — on an object that genuinely had one", async () => {
    // The child must have INHERITED provenance for this to mean anything. Bolting the assertion onto
    // the ordering test above would have been VACUOUS: that child is created with `domainLocal: true`
    // explicitly, so its provenance is null from the start and "cleared" would pass trivially.
    // `domainId` is OMITTED, not `null`. At the REPO layer (unlike on the wire, where the doors
    // coerce it) a literal `null` means "I AM the org root" and writes a DETACHED row — so this
    // container would have had no route to the org root, and the child created inside it below would
    // have been unreachable by every principal. `createObject`'s root-reachability invariant refuses
    // that child now, which is how this fixture was found. Omitting the field asks for the org root
    // as the parent, which is what "a top-level partition" was always meant to say.
    const container = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        typeId: "domain",
        actorObjectId: outpost.orgId,
        requestId: "m207-container",
        name: "prov-clearing-partition",
        domainLocal: true
      })
    );
    const child = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: container.id as never,
        typeId: "service",
        actorObjectId: outpost.orgId,
        requestId: "m207-child",
        name: "prov-clearing-child"
      })
    );
    // Precondition, asserted rather than assumed: it really did inherit.
    expect(child.domainLocal).toBe(true);
    expect(child.domainLocalInheritedFrom?.id).toBe(container.id);

    // §6b requires the container first.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      publishDomainLocalObject(tx, {
        orgId: outpost.orgId,
        typeId: "domain",
        idOrUrn: container.id,
        actorObjectId: outpost.orgId,
        requestId: "m207-publish-container"
      })
    );
    const published = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      publishDomainLocalObject(tx, {
        orgId: outpost.orgId,
        typeId: "service",
        idOrUrn: child.id,
        actorObjectId: outpost.orgId,
        requestId: "m207-publish-child"
      })
    );

    // The field answers "why is this domain-local"; on an object that no longer is, a surviving
    // value would assert a reason for a state that has ended.
    expect(published.object.domainLocal).toBe(false);
    expect(published.object.domainLocalInheritedFrom).toBeNull();
    // BOTH columns, not just the wire view — they are written together and must clear together.
    const rowAfter = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.id, child.id))
    );
    expect(rowAfter[0]!.domainLocalInheritedFrom).toBeNull();
    expect(rowAfter[0]!.domainLocalInheritedFromUrn).toBeNull();
  });

  it("PUBLISH (M20.6): the `domain_id` route blocks too — both containment routes, not just `contains`", async () => {
    // §6b mirrors §6a/§4's either-route rule. Testing only the `contains` route would leave an object
    // grouped under a domain-local containment DOMAIN publishable straight out of it.
    // `domainId` OMITTED rather than `null` — see the M20.7 case above: at the repo layer a literal
    // `null` writes a DETACHED container, and the child below would be unreachable by anyone.
    const containingDomain = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        typeId: "domain",
        actorObjectId: outpost.orgId,
        requestId: "m206-domain",
        name: "secure-partition-m206",
        domainLocal: true
      })
    );
    const child = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      createObject(tx, {
        orgId: outpost.orgId,
        domainId: containingDomain.id as never,
        typeId: "service",
        actorObjectId: outpost.orgId,
        requestId: "m206-domain-child",
        name: "service-in-secure-partition"
      })
    );
    expect(child.domainLocal).toBe(true); // M20.5 inheritance via domain_id

    const refusal = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      publishDomainLocalObject(tx, {
        orgId: outpost.orgId,
        typeId: "service",
        idOrUrn: child.id,
        actorObjectId: outpost.orgId,
        requestId: "m206-publish-domain-child"
      })
    ).then(
      () => null,
      (err: unknown) => err as ProblemError
    );
    expect(refusal).toBeInstanceOf(ProblemError);
    expect(refusal!.status).toBe(409);
    expect(refusal!.detail).toContain("secure-partition-m206");
  });

  it("the commander's database holds NO row anywhere naming the domain-local object, across the whole run", async () => {
    // The accumulated census: after create + update + delete have all been exported and imported,
    // the commander has never held it, under any urn, at any point. Asserted over the table rather
    // than over one lookup so a row landed under an unexpected urn would still be caught.
    const all = await withTenantTx(commander.db, commander.orgId, (tx) =>
      tx.select().from(objects)
    );
    expect(all.length).toBeGreaterThan(0); // non-emptiness guard: the file cannot pass vacuously
    expect(all.filter((row) => row.urn === localUrn || row.id === localId)).toEqual([]);
    expect(all.filter((row) => row.name === LOCAL_NAME)).toEqual([]);
    // ...while the control is still there, so "no rows match" is not because the table was emptied.
    expect(all.some((row) => row.urn === sharedUrn)).toBe(true);
  });
});
