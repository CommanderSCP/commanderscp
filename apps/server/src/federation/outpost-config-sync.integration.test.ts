import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../db/tenant-tx.js";
import { ProblemError } from "../errors.js";
import { getObjectByIdOrUrnAnyType, updateObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, initFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import {
  createOutpostConfig,
  findOutpostConfigByPeer,
  updateOutpostConfig
} from "./outposts-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * M16.2 phase A (E2) — PROVE THE OWNER'S GRAPH-OBJECT DECISION ACTUALLY DELIVERS THE M16.2 DoD
 * CLAUSE "editing an outpost's config writes commander-origin data the federation journal/bundle
 * carries down".
 *
 * The decision rests on a fact the journal makes unavoidable (`JournalEntryKindSchema` admits 9 entry
 * kinds, none peer-shaped, and `peers-repo.ts` never appends one): a `federation_peers` ROW cannot
 * travel, so commander-authored outpost config had to become a GRAPH OBJECT to ride `object_upsert`.
 * That argument is only worth anything if the object genuinely arrives at the outpost AND is genuinely
 * read-only there. This file proves exactly that, on the real two-domain harness (two SEPARATE
 * Postgres databases — see `test-support/isolated-domain.ts` for why orgs-in-one-database would be
 * the wrong model), through the real export → verify → import path:
 *
 *   1. a commander-authored `outpost` object ARRIVES at the outpost carrying the COMMANDER's trust
 *      domain as `originDomainId`;
 *   2. the outpost's own write to it is REFUSED by the EXISTING read-only-replica guard
 *      (`graph/objects-repo.ts`) — no second mechanism was built for this;
 *   3. the commander remains the SINGLE WRITER: its edits keep flowing down and the outpost's
 *      replica converges, while the outpost never authors a revision of its own.
 *
 * Test-only increment: it adds no production code, it verifies that the production code already
 * composed for this works.
 */
describe("M16.2 E2: commander-origin outpost config syncs down as a read-only replica (Testcontainers)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let commanderSelf: FederationSelf;
  let outpostSelf: FederationSelf;

  /**
   * Asserts a repo call fails with a specific HTTP status AND a `detail` matching `detail`.
   * `ProblemError.message` is only the TITLE ("Conflict"), so `rejects.toThrow(/read-only replica/)`
   * would never match the text that actually names the guard — it lives in `.detail`.
   */
  async function expectProblem(
    call: Promise<unknown>,
    status: number,
    detail: RegExp
  ): Promise<void> {
    await call.then(
      () => {
        throw new Error(`expected the call to fail with HTTP ${status}, but it succeeded`);
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ProblemError);
        const problem = err as ProblemError;
        expect(problem.status).toBe(status);
        expect(problem.detail ?? "").toMatch(detail);
      }
    );
  }

  /** Registers `b` as a peer of `a` with `b`'s REAL exchanged public key (DESIGN §13 pairing). */
  async function pair(
    a: IsolatedDomain,
    b: IsolatedDomain,
    role: "commander" | "outpost"
  ): Promise<void> {
    const key = await withTenantTx(b.db, b.orgId, (tx) => ensureInstanceKey(tx, b.orgId));
    const self = await withTenantTx(b.db, b.orgId, (tx) => ensureFederationSelf(tx, b.orgId));
    await withTenantTx(a.db, a.orgId, (tx) =>
      pairPeer(tx, {
        orgId: a.orgId,
        domainId: self.domainId,
        name: b.orgName,
        role,
        publicKey: key.publicKey
      })
    );
  }

  /** Exports the commander's own journal tail and imports it at the outpost, as production does. */
  async function syncDown(): Promise<void> {
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, bundle)
    );
  }

  beforeAll(async () => {
    commander = await createIsolatedDomain("cmdrCfg");
    outpost = await createIsolatedDomain("outpCfg");

    // Real roles, not defaults: only a commander may author this config, and the receiving side must
    // be an outpost for the scenario to be the one M16.2 is about.
    commanderSelf = await withTenantTx(commander.db, commander.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: commander.orgId,
        name: commander.orgName,
        role: "commander"
      })
    );
    outpostSelf = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      initFederationSelf(tx, { orgId: outpost.orgId, name: outpost.orgName, role: "outpost" })
    );

    await pair(commander, outpost, "outpost");
    await pair(outpost, commander, "commander");
  }, 120_000);

  afterAll(async () => {
    await commander?.close();
    await outpost?.close();
  });

  it("a commander-authored `outpost` object arrives at the outpost with the COMMANDER's domain as originDomainId", async () => {
    const declared = await withTenantTx(commander.db, commander.orgId, (tx) =>
      createOutpostConfig(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "e2-declare",
        peerDomainId: outpostSelf.domainId,
        trustTier: "fedramp-high"
      })
    );
    expect(declared.originDomainId).toBe(commanderSelf.domainId);

    await syncDown();

    const replica = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, outpost.orgId, declared.objectId)
    );
    // SAME id and urn (single-writer authority replicates verbatim), the commander's declared tier,
    // and — the load-bearing part — the COMMANDER's trust domain as the authoritative origin.
    expect(replica.id).toBe(declared.objectId);
    expect(replica.urn).toBe(declared.urn);
    expect(replica.typeId).toBe("outpost");
    expect(replica.properties.trustTier).toBe("fedramp-high");
    expect(replica.originDomainId).toBe(commanderSelf.domainId);
    expect(replica.originDomainId).not.toBe(outpostSelf.domainId);

    // The binding travels too, and at the outpost it names the outpost's OWN domain — which is
    // exactly why the peer-binding guard must never run on an import: an instance is never its own
    // peer, so applying it here would refuse every legitimate sync.
    expect(replica.properties.peerDomainId).toBe(outpostSelf.domainId);
    const localView = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      findOutpostConfigByPeer(tx, outpost.orgId, outpostSelf.domainId)
    );
    expect(localView?.trustTier).toBe("fedramp-high");
    expect(localView?.originDomainId).toBe(commanderSelf.domainId);
  });

  it("the OUTPOST's own write to that object is REFUSED by the existing read-only-replica guard", async () => {
    const replica = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      findOutpostConfigByPeer(tx, outpost.orgId, outpostSelf.domainId)
    );
    expect(replica).not.toBeNull();

    // (a) Through the module the outpost's OWN route would use — the realistic shape of "an operator
    //     edits the trust tier on the outpost's UI".
    await expectProblem(
      withTenantTx(outpost.db, outpost.orgId, (tx) =>
        updateOutpostConfig(tx, {
          orgId: outpost.orgId,
          actorObjectId: outpost.orgId,
          requestId: "e2-outpost-write",
          peerDomainId: outpostSelf.domainId,
          trustTier: "commercial"
        })
      ),
      409,
      /read-only replica/i
    );

    // (b) And through the RAW graph write path, so the refusal is provably the EXISTING single-writer
    //     guard in `graph/objects-repo.ts` rather than anything `outposts-repo.ts` added on top. If
    //     someone later "helpfully" makes the outpost path writable, both halves go red.
    await expectProblem(
      withTenantTx(outpost.db, outpost.orgId, (tx) =>
        updateObject(tx, {
          orgId: outpost.orgId,
          typeId: "outpost",
          actorObjectId: outpost.orgId,
          requestId: "e2-outpost-raw-write",
          idOrUrn: replica!.objectId,
          properties: { peerDomainId: outpostSelf.domainId, trustTier: "commercial" }
        })
      ),
      409,
      /read-only replica/i
    );

    // Nothing changed: the tier is still the commander's, at the commander's revision.
    const after = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      findOutpostConfigByPeer(tx, outpost.orgId, outpostSelf.domainId)
    );
    expect(after?.trustTier).toBe("fedramp-high");
    expect(after?.revision).toBe(replica?.revision);
    expect(after?.version).toBe(replica?.version);
  });

  it("the COMMANDER remains the single writer: its next edit flows down and the replica converges", async () => {
    const before = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      findOutpostConfigByPeer(tx, outpost.orgId, outpostSelf.domainId)
    );

    const edited = await withTenantTx(commander.db, commander.orgId, (tx) =>
      updateOutpostConfig(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "e2-commander-edit",
        peerDomainId: outpostSelf.domainId,
        trustTier: "il5"
      })
    );
    expect(edited.trustTier).toBe("il5");
    expect(edited.revision).toBeGreaterThan(before!.revision);

    await syncDown();

    const after = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      findOutpostConfigByPeer(tx, outpost.orgId, outpostSelf.domainId)
    );
    // The edit arrived — this is the DoD clause: editing at the commander writes commander-origin
    // data the journal/bundle carries down.
    expect(after?.trustTier).toBe("il5");
    expect(after?.revision).toBe(edited.revision);
    // …and authority never moved. The replica is still authored by the commander, and the outpost's
    // own revision counter never advanced on its own (every advance came from an import).
    expect(after?.originDomainId).toBe(commanderSelf.domainId);

    // A second import of the same bundle is a no-op (idempotent replay) — so "it converged" is not an
    // artifact of re-applying content, and the outpost cannot drift by re-importing.
    await syncDown();
    const again = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      findOutpostConfigByPeer(tx, outpost.orgId, outpostSelf.domainId)
    );
    expect(again?.revision).toBe(edited.revision);
    expect(again?.version).toBe(after?.version);
  });

  it("the outpost cannot author its OWN outpost object for the commander peer either", async () => {
    // The other half of "the commander is the single writer": an outpost holds the commander as a
    // peer with role `commander`, and the peer-binding guard refuses a config object about it. So the
    // outpost cannot manufacture local config that would later collide with what syncs down.
    await expectProblem(
      withTenantTx(outpost.db, outpost.orgId, (tx) =>
        createOutpostConfig(tx, {
          orgId: outpost.orgId,
          actorObjectId: outpost.orgId,
          requestId: "e2-outpost-authors",
          peerDomainId: commanderSelf.domainId,
          trustTier: "commercial"
        })
      ),
      400,
      /role 'commander', not 'outpost'/i
    );
  });

  /**
   * REVIEW ROUND 4 (H7) — FORWARD-TOLERANCE OF THE JOURNALED TYPE, decided before the second property
   * lands rather than after.
   *
   * `outpost` is validated with Ajv against the REGISTERED type on the RECEIVING side, and the
   * `object_upsert` import branch has no try/catch — so a rejected entry aborts THE WHOLE SYNC BUNDLE,
   * not just that entry. With the first cut's `additionalProperties: false` (and a closed `trustTier`
   * enum) that made every future addition a fail-closed version-skew hazard: the moment phase B added a
   * second declared-config property, every outpost still on the older migration set would have wedged
   * federation for that peer until upgraded.
   *
   * This test IS the decision, in executable form. The commander writes an `outpost` object carrying
   * BOTH an unknown property and a tier this build has never heard of — exactly what a newer commander
   * produces — and the outpost imports the bundle WHOLE. The property-level strictness that matters is
   * unaffected: the API request bodies still admit only the known fields and known tiers (proved in
   * `outpost-object.integration.test.ts`), so no operator can write either of these through a route.
   */
  it("H7: an outpost entry carrying an UNKNOWN property and an UNKNOWN tier imports WITHOUT aborting the bundle", async () => {
    const replica = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      findOutpostConfigByPeer(tx, outpost.orgId, outpostSelf.domainId)
    );
    expect(replica).not.toBeNull();

    // A NEWER commander's write: a second declared-config property plus a tier from a later vocabulary.
    // Written through the repo because this build's request schema deliberately cannot express it —
    // which is the whole point of the scenario.
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      updateObject(tx, {
        orgId: commander.orgId,
        typeId: "outpost",
        actorObjectId: commander.orgId,
        requestId: "h7-newer-commander",
        idOrUrn: replica!.objectId,
        properties: {
          peerDomainId: outpostSelf.domainId,
          trustTier: "a-tier-this-build-has-never-heard-of",
          somePhaseBProperty: { nested: true }
        }
      })
    );
    // A SECOND, ordinary entry rides the same bundle. If the outpost entry aborted the import, this
    // one would never land — which is what makes "the bundle survived" a claim about the BUNDLE and
    // not just about one row.
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      updateOutpostConfig(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "h7-companion-edit",
        peerDomainId: outpostSelf.domainId,
        name: "renamed-in-the-same-bundle"
      })
    );

    await syncDown();

    const after = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, outpost.orgId, replica!.objectId)
    );
    // The unknown property was STORED, not rejected — an older receiver keeps a newer authority's data
    // verbatim rather than dropping or refusing it.
    expect(after.properties.somePhaseBProperty).toEqual({ nested: true });
    expect(after.name).toBe("renamed-in-the-same-bundle");

    // …and the unrecognised tier is read as NO tier and DECLARED unknown, never guessed at or coerced
    // to `commercial`. An invented posture is precisely what this milestone exists to prevent.
    const view = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      findOutpostConfigByPeer(tx, outpost.orgId, outpostSelf.domainId)
    );
    expect(view?.trustTier).toBeNull();
    expect(view?.unknownFields).toContain("trustTier");
  });
});
