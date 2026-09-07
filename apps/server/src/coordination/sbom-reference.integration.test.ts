import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, changes } from "../db/schema.js";
import { processChangeSourceEvents } from "./webhook-processor.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** Build-time SBOM, stored as a reference on the promotion. See docs/coordination.md §847. */
describe("M17.2 SBOM reference: a typed report's SBOM reference round-trips onto the change's sourceRef", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "sbom-reference");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** Runs the reconcile-tick processor (this server isn't running the loop) and returns the Change
   *  the given event produced. */
  async function processAndResolveChange(eventId: string): Promise<string> {
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    expect(rows[0]!.processedAt).not.toBeNull();
    const changeObjectId = rows[0]!.resultingChangeObjectId;
    expect(changeObjectId).not.toBeNull();
    return changeObjectId!;
  }

  async function readSourceRef(changeObjectId: string): Promise<Record<string, unknown>> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeObjectId))
    );
    return (rows[0]!.sourceRef ?? {}) as Record<string, unknown>;
  }

  it("an executor's report carrying an SBOM REFERENCE (+ its artifact digest) persists both canonical keys on the change — reference only, never a document", async () => {
    const component = await createTestComponent(admin, {
      name: `sbom-comp-${randomUUID().slice(0, 8)}`
    });
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", {
      repoPattern: repo,
      component: component.id
    });

    const artifactDigest = "sha256:" + "a1".repeat(32);
    const sbomDigest = "sha256:" + "b2".repeat(32);

    const { eventId } = await admin.changeSources.report("terraform", {
      status: "applied",
      repo,
      correlationKey: "release-77",
      artifactDigest,
      sbom: {
        format: "cyclonedx",
        specVersion: "1.5",
        digest: sbomDigest,
        location: `registry.test/${repo}@${sbomDigest}`,
        mediaType: "application/vnd.cyclonedx+json",
        // The EXECUTOR's origin cosign signature. SCP records that it exists; SCP never signs.
        signatureRef: `registry.test/${repo}:sha256-${"b2".repeat(32)}.sig`,
        scanner: "trivy",
        scannerVersion: "0.74.0",
        generatedAt: "2026-07-20T09:00:00.000Z"
      }
    });

    const changeObjectId = await processAndResolveChange(eventId);
    const sourceRef = await readSourceRef(changeObjectId);

    // The SBOM REFERENCE round-tripped intact and is readable off the persisted change.
    expect(sourceRef.sbom).toEqual({
      format: "cyclonedx",
      specVersion: "1.5",
      digest: sbomDigest,
      location: `registry.test/${repo}@${sbomDigest}`,
      mediaType: "application/vnd.cyclonedx+json",
      signatureRef: `registry.test/${repo}:sha256-${"b2".repeat(32)}.sig`,
      scanner: "trivy",
      scannerVersion: "0.74.0",
      generatedAt: "2026-07-20T09:00:00.000Z"
    });

    // It is a REFERENCE: every persisted field is a short string. Nothing here is (or could be) an
    // SBOM document — the reference names WHERE the document lives and WHAT it hashes to.
    for (const [key, value] of Object.entries(sourceRef.sbom as Record<string, unknown>)) {
      expect(typeof value, `sbom.${key} must be a string reference field`).toBe("string");
      expect((value as string).length).toBeLessThan(512);
    }

    // And the M17.2 canonicalization fix: the report's flat `artifactDigest` is now lifted to the
    // documented canonical `sourceRef.artifact_digest` — what the M17.1 scan gate binds against.
    expect(sourceRef.artifact_digest).toBe(artifactDigest);
    // The raw delivery body is still preserved verbatim (DESIGN §8), so nothing that read the old
    // camelCase spelling regresses.
    expect(sourceRef.artifactDigest).toBe(artifactDigest);
    expect(sourceRef.status).toBe("applied");
  });

  it("a report WITHOUT an sbom still works unchanged — the field is optional, so every pre-M17.2 reporter keeps reporting", async () => {
    const component = await createTestComponent(admin, {
      name: `sbom-none-${randomUUID().slice(0, 8)}`
    });
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", {
      repoPattern: repo,
      component: component.id
    });

    const { eventId } = await admin.changeSources.report("terraform", {
      status: "planned",
      repo,
      workspace: "prod"
    });

    const changeObjectId = await processAndResolveChange(eventId);
    const sourceRef = await readSourceRef(changeObjectId);
    expect(sourceRef.sbom).toBeUndefined();
    expect(sourceRef.workspace).toBe("prod");
    expect(sourceRef.artifact_digest).toBeUndefined();
  });

  it("M10.6: SCP exposes NO way to STORE SBOM BYTES — an attempt to smuggle the document inside the reference is REFUSED (400), not silently stripped", async () => {
    const component = await createTestComponent(admin, {
      name: `sbom-bytes-${randomUUID().slice(0, 8)}`
    });
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", {
      repoPattern: repo,
      component: component.id
    });

    const before = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents)
    );
    const sbomDigest = "sha256:" + "c3".repeat(32);
    // A raw HTTP call (not the SDK) so we can send a field the typed contract does not define.
    const response = await fetch(`${server.baseUrl}/change-sources/terraform/report`, {
      method: "POST",
      headers: { authorization: `Bearer ${org.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        status: "applied",
        repo,
        sbom: {
          format: "cyclonedx",
          digest: sbomDigest,
          location: `registry.test/${repo}@${sbomDigest}`,
          // The thing M17.2 refuses to be: the document itself.
          document: { bomFormat: "CycloneDX", components: [{ name: "openssl", version: "3.0.0" }] }
        }
      })
    });

    // M10.6: `SbomRefSchema` is now `.strict()` — a REFERENCE has a small, closed field set, and an
    // SBOM DOCUMENT smuggled inside it is refused outright rather than silently stripped and
    // half-persisted. Reference-in, reference-out — SCP has no column, no codec, and no route that
    // would ever store SBOM bytes even if someone sent them.
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("bomFormat");

    // The whole report is refused — no event was ever created for it to leave a half-persisted trace.
    const after = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents)
    );
    expect(after.length).toBe(before.length);
  });

  it("M10.6: an unknown TOP-LEVEL field on the report body is REFUSED (400), not silently stripped", async () => {
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const response = await fetch(`${server.baseUrl}/change-sources/terraform/report`, {
      method: "POST",
      headers: { authorization: `Bearer ${org.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "applied", repo, notAFieldTheContractDefines: "smuggled" })
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain("notAFieldTheContractDefines");
  });
});
