import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { computeObjectContentHash } from "../graph/content-hash.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import {
  ensureFederationSelf,
  initFederationSelf,
  type FederationSelf
} from "../federation/self-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { pairPeer } from "../federation/peers-repo.js";
import { exportSyncBundle } from "../federation/export-repo.js";
import { importSyncBundle } from "../federation/import-repo.js";
import {
  createIsolatedDomain,
  type IsolatedDomain
} from "../federation/test-support/isolated-domain.js";

/**
 * ADR-0032 §6a AT THE CHOKE POINT — EVERY LOCAL WRITE DOOR, AND THE ONE EXEMPTION.
 *
 * ================================================================================================
 * THE HOLE
 * ================================================================================================
 * M21.3 installed the group-scoped-opt-out refusal in ONE place: the composed `validateWrite` of the
 * typed `/policies` routes. Its SIBLING in that same composition, `assertPolicyScopeWithinAuthority`,
 * was installed in THREE (that config plus `iac/plans-repo.ts`'s create and update branches) — the
 * tell that the typed route was never the boundary. Censusing the sibling turned up three doors that
 * reach `createObject` with a free-form `typeId` and free-form `properties` and never pass through
 * `typed-registries.ts` at all. Each was REPRODUCED with the exact document the typed route answers
 * 400 to, before the fix:
 *
 *   1. IaC — `POST /plans` + `POST /plans/{id}/apply` applied a manifest declaring
 *      `{typeId:"policy", properties:{scope:{group:"team-platform"}, effects:[{dependencySubscription:
 *      {enabled:false, coordinate:"acme-lib"}}]}}`, and the object read back. `routes/plans.ts`
 *      claims IaC enforces "the exact same governance gates the typed /policies routes enforce";
 *      M21.3 made that comment false.
 *   2. HAND-FILL — `POST /api/v1/federation/hand-fill`, free-form `typeId` + `properties`, any
 *      `federation:write` holder.
 *   3. OVERLAY — `POST /api/v1/federation/overlays` with `typeId: "policy"`, authorized with plain
 *      `object:write`.
 *
 * The fix is NOT three more calls — that is the same rake, and the fourth door would miss it again
 * (BUILD_AND_TEST.md §4.4). It moved to `graph/objects-repo.ts`'s `createObject`/`updateObject`, the
 * one choke point every local write door funnels through, following the M16.2 clause-(4) precedent
 * that already lives there.
 *
 * ================================================================================================
 * WHAT THIS FILE ASSERTS, AND WHY THE LAST CASE IS THE IMPORTANT ONE
 * ================================================================================================
 * Each door refuses AND writes nothing — a refusal that still stored the row would satisfy a status
 * assertion. Then the negative control: a policy carrying the IDENTICAL document, arriving over a
 * genuinely signed federation bundle, is ACCEPTED and does not abort its bundle.
 *
 * That exemption is narrow and deliberate. `federation/import-repo.ts`'s `object_upsert` branch has
 * NO try/catch, so a throw there aborts the WHOLE bundle and wedges the channel (proposal §10 Q6);
 * the authoring instance is where an authoring-time refusal belongs. But `federationImport` is set by
 * TWO modules, not one — `import-repo.ts` and `federation/handfill-repo.ts` (census re-run filterless
 * for this change; there is no third) — and hand-fill is a local operator action with no channel to
 * wedge. So hand-fill calls the guard for itself, and case 2 below is what proves the exemption did
 * not swallow it.
 *
 * ================================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ================================================================================================
 * See the PR body. Every case here was watched fail against the pre-fix tree.
 */
describe("ADR-0032 §6a: every local write door refuses a group-scoped opt-out (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const REFUSED_PROPERTIES = {
    scope: { group: "team-platform" },
    enforcement: "required",
    effects: [{ dependencySubscription: { enabled: false, coordinate: "acme-lib" } }]
  };

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "dep-sub-doors");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // Hand-fill needs a paired peer, and pairing needs this instance's own federation identity.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: org.orgId,
        name: `doors-${randomUUID().slice(0, 8)}`,
        role: "outpost"
      })
    );
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  /** Live `policy` rows in this org whose urn matches — the "nothing was written" assertion. */
  async function policyRowsByUrn(urn: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, properties: objects.properties })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "policy"),
            eq(objects.urn, urn),
            isNull(objects.deletedAt)
          )
        )
    );
  }

  async function pairCommanderPeer(): Promise<string> {
    const domainId = randomUUID();
    const { publicKey } = generateKeyPairSync("ed25519");
    await admin.federation.pair({
      domainId,
      name: `cmdr-${domainId.slice(0, 8)}`,
      role: "commander",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
    });
    return domainId;
  }

  async function expectApiError(call: Promise<unknown>, status: number, detail: RegExp) {
    await call.then(
      () => {
        throw new Error(`expected the call to fail with HTTP ${status}, but it succeeded`);
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ScpApiError);
        const apiError = err as ScpApiError;
        expect(apiError.status, `detail was: ${apiError.problem?.detail ?? "<none>"}`).toBe(status);
        expect(apiError.problem?.detail ?? "").toMatch(detail);
      }
    );
  }

  it("DOOR 1a: IaC apply refuses a manifest that CREATES the refused policy, and writes nothing", async () => {
    const stackName = `dep-sub-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${stackName}:policy:smuggled`;
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        { urn, typeId: "policy", name: "smuggled-opt-out", properties: REFUSED_PROPERTIES }
      ],
      relationships: []
    };

    const plan = await admin.plans.create(manifest);
    // The refusal may land at plan or at apply; either is fine so long as nothing is written. It
    // lands at apply, because plan computation is read-only and never reaches `createObject`.
    await expectApiError(admin.plans.apply(plan.id), 400, /objectRef/);

    expect(
      await policyRowsByUrn(urn),
      "apply calls createObject DIRECTLY — the typed route's refusal has to hold here too"
    ).toHaveLength(0);
  });

  it("DOOR 1b: IaC apply refuses a manifest that EDITS an existing policy into the refused shape", async () => {
    // `updateObject` replaces `properties` wholesale, so an author blocked at create could otherwise
    // land an ordinary policy and rewrite it one apply later. This is the `plans-repo.ts:758` half of
    // the sibling check's own three-site census, and it needed its own case for the same reason that
    // one does.
    const stackName = `dep-sub-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${stackName}:policy:edited`;
    const clean = {
      enforcement: "required",
      effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: "organization" } }]
    };

    const created = await admin.plans.create({
      stackName,
      objects: [{ urn, typeId: "policy", name: "edited-later", properties: clean }],
      relationships: []
    });
    await admin.plans.apply(created.id);
    expect(await policyRowsByUrn(urn)).toHaveLength(1);

    const edit = await admin.plans.create({
      stackName,
      objects: [{ urn, typeId: "policy", name: "edited-later", properties: REFUSED_PROPERTIES }],
      relationships: []
    });
    await expectApiError(admin.plans.apply(edit.id), 400, /objectRef/);

    const [row] = await policyRowsByUrn(urn);
    expect(
      (row?.properties as { effects?: unknown[] }).effects,
      "the stored document must be untouched — a refusal that half-applied is not a refusal"
    ).toEqual(clean.effects);
  });

  // DOOR 2 — hand-fill. The one that the `federationImport` exemption would otherwise swallow.

  it("DOOR 2: hand-fill refuses it — a local operator action does not get the import exemption", async () => {
    const peer = await pairCommanderPeer();
    const urn = `urn:scp:${org.orgId}:policy:hand-filled-opt-out`;

    await expectApiError(
      admin.federation.handFill({
        peer,
        typeId: "policy",
        urn,
        name: "hand-filled-opt-out",
        properties: REFUSED_PROPERTIES
      }),
      400,
      /objectRef/
    );

    expect(await policyRowsByUrn(urn)).toHaveLength(0);
  });

  it("DOOR 2 (control): hand-fill of an ordinary policy still works — the guard did not close the door", async () => {
    const peer = await pairCommanderPeer();
    const urn = `urn:scp:${org.orgId}:policy:hand-filled-ordinary`;

    const filled = await admin.federation.handFill({
      peer,
      typeId: "policy",
      urn,
      name: "hand-filled-ordinary",
      properties: {
        enforcement: "required",
        effects: [{ dependencySubscription: { enabled: true, granularity: "patch" } }]
      }
    });

    // Without this, DOOR 2 above is satisfied by a hand-fill route that refuses every `policy`, or
    // every dependencySubscription effect, or that broke outright.
    expect(filled.provenance).toBe("manual");
    expect(await policyRowsByUrn(urn)).toHaveLength(1);
  });

  it("DOOR 3: the overlay route refuses it, and creates neither the overlay nor its `annotates` edge", async () => {
    const base = await admin.services.create({ name: `svc-overlay-${randomUUID().slice(0, 8)}` });
    const urn = `urn:scp:${org.orgId}:policy:overlay-opt-out`;

    await expectApiError(
      admin.federation.createOverlay({
        base: base.id,
        typeId: "policy",
        name: "overlay-opt-out",
        urn,
        properties: REFUSED_PROPERTIES
      }),
      400,
      /objectRef/
    );

    expect(await policyRowsByUrn(urn)).toHaveLength(0);
    // `createOverlay` writes the object and then the edge; the whole handler runs in one tenant tx,
    // so a refusal at the object must leave no edge either.
    const merged = await admin.federation.getMergedOverlayView(base.id);
    expect(merged.overlays).toHaveLength(0);
  });

  // DOOR 4 — the generic `/objects/{type}` route. VERIFIED, not assumed.

  it("DOOR 4: the generic /objects/policy route still refuses the TYPE outright, before any document check", async () => {
    // `routes/objects-generic.ts`'s `assertNotGovernanceManagedObjectType` is the pre-existing
    // refusal, and the M21.3 census had it listed as "already closed". Listed is not measured — this
    // asserts it, and asserts the reason: a 403 about the TYPE, not a 400 about the document, so the
    // case still fails loudly if that refusal is ever relaxed into a document-level one.
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/policy",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "generic-route-opt-out", properties: REFUSED_PROPERTIES }
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toMatch(/policies/);
  });
});

/**
 * THE EXEMPTION, AND ITS EXACT WIDTH — a REAL federation import of the very same document.
 *
 * This is the negative control for everything above: if the choke-point guard had been installed
 * without the `federationImport` skip, this bundle would abort at `import-repo.ts`'s `object_upsert`
 * branch (which has no try/catch) and wedge the channel for every later entry too — proposal §10 Q6.
 * If the skip had instead been made blanket, DOOR 2 above would be green-by-accident.
 *
 * The exporter plants the entry with `appendJournalEntry` rather than through a route, because the
 * commander's OWN guard refuses to author this document — which is the point of the whole clause.
 * What arrives is therefore exactly what a peer running a build without the guard (or a future build
 * with a different rule) would ship: a properly chained, properly signed `policy_upsert` carrying a
 * group-only opt-out.
 */
describe("ADR-0032 §6a: a federation-IMPORTED policy carrying the same document is ACCEPTED", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let commanderSelf: FederationSelf;

  async function pair(a: IsolatedDomain, b: IsolatedDomain, role: "commander" | "outpost") {
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

  beforeAll(async () => {
    commander = await createIsolatedDomain("depSubCmdr");
    outpost = await createIsolatedDomain("depSubOutp");
    commanderSelf = await withTenantTx(commander.db, commander.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: commander.orgId,
        name: commander.orgName,
        role: "commander"
      })
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      initFederationSelf(tx, { orgId: outpost.orgId, name: outpost.orgName, role: "outpost" })
    );
    await pair(commander, outpost, "outpost");
    await pair(outpost, commander, "commander");
  }, 180_000);

  afterAll(async () => {
    await commander?.close();
    await outpost?.close();
  });

  it("imports the group-scoped opt-out AND the ordinary entry riding the same bundle", async () => {
    const refusedUrn = `urn:scp:${commander.orgId}:policy:imported-group-opt-out`;
    const companionUrn = `urn:scp:${commander.orgId}:policy:companion`;

    await withTenantTx(commander.db, commander.orgId, async (tx) => {
      for (const [urn, name, properties] of [
        [
          refusedUrn,
          "imported-group-opt-out",
          {
            scope: { group: "team-platform" },
            enforcement: "required",
            effects: [{ dependencySubscription: { enabled: false, coordinate: "acme-lib" } }]
          }
        ],
        [companionUrn, "companion", { enforcement: "advisory" }]
      ] as const) {
        const id = randomUUID();
        await appendJournalEntry(tx, {
          orgId: commander.orgId,
          entryKind: "policy_upsert",
          contentHash: computeObjectContentHash({
            id,
            orgId: commander.orgId,
            domainId: null,
            typeId: "policy",
            name,
            urn,
            properties: properties as Record<string, unknown>,
            labels: {},
            version: 1
          }),
          payload: {
            id,
            orgId: commander.orgId,
            domainId: null,
            typeId: "policy",
            name,
            urn,
            properties,
            labels: {},
            originDomainId: commanderSelf.domainId,
            revision: 1,
            version: 1
          }
        });
      }
    });

    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, bundle)
    );

    const imported = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, outpost.orgId, refusedUrn)
    );
    expect(
      (imported.properties as { scope?: { group?: string } }).scope?.group,
      "the receiving domain must not referee a document its authoring instance already owns"
    ).toBe("team-platform");

    // THE BUNDLE, not just the row. A throw in `object_upsert` aborts the whole import, so this
    // second entry landing is what makes "the channel is not wedged" a claim about the transport.
    const companion = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, outpost.orgId, companionUrn)
    );
    expect(companion.name).toBe("companion");
  });
});
