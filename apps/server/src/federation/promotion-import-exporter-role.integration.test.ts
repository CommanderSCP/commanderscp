import { randomUUID } from "node:crypto";
import { DECLARED_COMMANDER, requireCosignPublicKey } from "../test-support/federation-roles.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { PromotionBundle } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { ProblemError } from "../errors.js";
import { changes, federationPeers } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { getDecision } from "../coordination/decisions-repo.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { getCursor } from "./cursors-repo.js";
import { exportPromotionBundle, importPromotionBundle } from "./promotion-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/** THE IMPORTER'S HALF OF §8.9 (docs/proposals/component-journey-view.md): only a peer this domain
 *  paired as 'commander' may originate a promotion. The exporter here signs through the REPO
 *  function under a commander declaration, so the bundle is genuinely signed — standing in for an
 *  outpost that lies about its role, runs a modified binary, or signed before §8.9 — and the
 *  importer has its cosign key registered, so every other gate passes: the role check is the only
 *  thing between an outpost-signed manifest and acceptance. The relayed path (a commander bundle
 *  carried past a retrans) is pinned by retrans-relay / inbox-loop / auto-relay integration suites,
 *  which import through this same function with the commander paired as 'commander'. */

describe("importPromotionBundle refuses a promotion whose exporter peer is not a commander (§8.9)", () => {
  let exporter: IsolatedDomain;
  let importer: IsolatedDomain;
  let exporterSelf: FederationSelf;

  /** (Re-)pair the exporter at the importer with `role`, cosign key registered unless `cosign: false`. */
  async function pairExporterAs(role: "commander" | "outpost" | "retrans", cosign = true) {
    const key = await withTenantTx(exporter.db, exporter.orgId, (tx) =>
      ensureInstanceKey(tx, exporter.orgId)
    );
    const cosignPublicKey = cosign
      ? (await requireCosignPublicKey(exporter.db, exporter.orgId, DECLARED_COMMANDER)).publicKey
      : null;
    await withTenantTx(importer.db, importer.orgId, (tx) =>
      pairPeer(tx, {
        orgId: importer.orgId,
        domainId: exporterSelf.domainId,
        name: exporter.orgName,
        role,
        publicKey: key.publicKey,
        cosignPublicKey
      })
    );
  }

  /** A change in the exporter whose target is replicated to the importer, exported to it. */
  async function exportedBundle(): Promise<PromotionBundle> {
    const target = await withTenantTx(exporter.db, exporter.orgId, (tx) =>
      createObject(tx, {
        orgId: exporter.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: exporter.orgId,
        requestId: `role-target-${randomUUID()}`,
        name: `role-target-${randomUUID()}`
      })
    );
    const cursor = await withTenantTx(importer.db, importer.orgId, (tx) =>
      getCursor(tx, importer.orgId, exporterSelf.domainId, exporterSelf.domainId)
    );
    const sync = await withTenantTx(exporter.db, exporter.orgId, (tx) =>
      exportSyncBundle(tx, exporter.orgId, importer.orgName, cursor.sequence)
    );
    await withTenantTx(importer.db, importer.orgId, (tx) =>
      importSyncBundle(tx, importer.orgId, sync)
    );
    const { change } = await withTenantTx(exporter.db, exporter.orgId, (tx) =>
      proposeChange(tx, {
        orgId: exporter.orgId,
        actorObjectId: exporter.orgId,
        requestId: `role-change-${randomUUID()}`,
        name: `role-${randomUUID()}`,
        targets: [target.id]
      })
    );
    const outcome = await exportPromotionBundle(exporter.db, {
      federation: DECLARED_COMMANDER,
      orgId: exporter.orgId,
      peerIdOrName: importer.orgName,
      changeIdOrUrn: change.id
    });
    if (outcome.refused) throw new Error(`unexpected export refusal: ${outcome.reason}`);
    return outcome.bundle;
  }

  async function importedCount(sourceChangeObjectId: string): Promise<number> {
    const all = await withTenantTx(importer.db, importer.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.orgId, importer.orgId))
    );
    return all.filter(
      (c) =>
        (c.sourceRef as Record<string, unknown> | null)?.sourceChangeObjectId ===
        sourceChangeObjectId
    ).length;
  }

  /** Asserts a fail-closed 409 carrying a persisted `exporter-role` block Decision. */
  async function expectRoleRefusal(bundle: PromotionBundle, detail: RegExp) {
    const err = await importPromotionBundle(importer.db, importer.orgId, bundle).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ProblemError);
    const problem = err as ProblemError;
    expect(problem.status).toBe(409);
    expect(problem.detail).toMatch(detail);
    expect(problem.decisionId).toBeTruthy();
    const decision = await withTenantTx(importer.db, importer.orgId, (tx) =>
      getDecision(tx, importer.orgId, problem.decisionId!)
    );
    expect(decision.verdict).toBe("block");
    expect(decision.inputContext).toMatchObject({ check: "exporter-role" });
    expect(await importedCount(bundle.header.sourceChangeObjectId)).toBe(0);
  }

  beforeAll(async () => {
    exporter = await createIsolatedDomain("role-exporter");
    importer = await createIsolatedDomain("role-importer");
    exporterSelf = await withTenantTx(exporter.db, exporter.orgId, (tx) =>
      ensureFederationSelf(tx, exporter.orgId)
    );
    const importerSelf = await withTenantTx(importer.db, importer.orgId, (tx) =>
      ensureFederationSelf(tx, importer.orgId)
    );
    const importerKey = await withTenantTx(importer.db, importer.orgId, (tx) =>
      ensureInstanceKey(tx, importer.orgId)
    );
    await withTenantTx(exporter.db, exporter.orgId, (tx) =>
      pairPeer(tx, {
        orgId: exporter.orgId,
        domainId: importerSelf.domainId,
        name: importer.orgName,
        role: "outpost",
        publicKey: importerKey.publicKey
      })
    );
    await pairExporterAs("commander");
  }, 120_000);

  afterAll(async () => {
    await exporter?.close();
    await importer?.close();
  });

  it("CONTROL: paired as 'commander', the same kind of bundle imports", async () => {
    await pairExporterAs("commander");
    const bundle = await exportedBundle();
    expect(bundle.manifestSignature).toBeTruthy();
    const result = await importPromotionBundle(importer.db, importer.orgId, bundle);
    expect(result.localChangeObjectId).toBeTruthy();
    expect(await importedCount(bundle.header.sourceChangeObjectId)).toBe(1);
  }, 60_000);

  it("paired as 'outpost' WITH its cosign key registered: the validly signed manifest is REFUSED", async () => {
    await pairExporterAs("commander");
    const bundle = await exportedBundle();
    await pairExporterAs("outpost");
    await expectRoleRefusal(bundle, /paired as 'outpost'.*COMMANDER-ONLY/);
  }, 60_000);

  it("paired as 'retrans': REFUSED — a retrans relays bytes, it never originates a promotion", async () => {
    await pairExporterAs("commander");
    const bundle = await exportedBundle();
    await pairExporterAs("retrans");
    await expectRoleRefusal(bundle, /paired as 'retrans'/);
  }, 60_000);

  it("a manifest-STRIPPED bundle from an outpost with no cosign key is REFUSED, not accepted as pre-E5 back-compat", async () => {
    await pairExporterAs("commander");
    const signed = await exportedBundle();
    // The two fields are checksum-EXCLUDED, so stripping them leaves the Ed25519 envelope valid.
    const { promotionManifest: _m, manifestSignature: _s, ...stripped } = signed;
    await pairExporterAs("outpost", false);
    await expectRoleRefusal(stripped as PromotionBundle, /paired as 'outpost'/);
  }, 60_000);

  it("an UNRECOGNISED stored peer role is refused FAIL-CLOSED", async () => {
    await pairExporterAs("commander");
    const bundle = await exportedBundle();
    await withTenantTx(importer.db, importer.orgId, (tx) =>
      tx
        .update(federationPeers)
        .set({ role: "parent" })
        .where(
          and(
            eq(federationPeers.orgId, importer.orgId),
            eq(federationPeers.id, exporterSelf.domainId)
          )
        )
    );
    await expectRoleRefusal(bundle, /no recognised declared role.*FAIL-CLOSED/);
  }, 60_000);
});
