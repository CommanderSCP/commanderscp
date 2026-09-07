import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, changes, decisions } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** Artifact-class verification, end to end. See docs/coordination.md §3. */
describe("D13 artifact-class verification (integration)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    // BOTH flags are required and neither is optional decoration. See docs/coordination.md §4.
    server = await listenTestServer({ withEventRelay: true, withReconcileLoop: true });
    org = await createTestOrg(server, "artifact-class");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  const label = () => randomUUID().slice(0, 8);

  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);

  /** Declares a mapping of `declaredType` and reports a build against it, returning the event id.
   *  The mapping's `type` IS the declaration D13 verifies against — the same value `@scp/iac`'s
   *  pipeline constructs write (`addSourceMapping({..., type: kind})`). */
  async function declareAndReport(
    declaredType: string,
    body: Record<string, unknown>
  ): Promise<string> {
    const component = await createTestComponent(admin, { name: `ac-comp-${label()}` });
    const repo = `acme/${label()}`;
    await admin.changeSources.createMapping("terraform", {
      repoPattern: repo,
      component: component.id,
      type: declaredType
    } as Parameters<typeof admin.changeSources.createMapping>[1]);
    const { eventId } = await admin.changeSources.report("terraform", {
      status: "applied",
      repo,
      ...body
    } as Parameters<typeof admin.changeSources.report>[1]);
    return eventId;
  }

  /** Waits for the processor to finish with an event, whichever way it went: a resulting change, or
   *  a refusal (processed with none). Returns the row so a case can assert which happened. */
  async function settled(eventId: string) {
    return await waitUntil(
      async () => {
        const rows = await inOrg((tx) =>
          tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
        );
        const row = rows[0];
        return row?.processedAt ? row : undefined;
      },
      { describe: `the processor to settle event ${eventId}` }
    );
  }

  async function sourceRefOf(changeObjectId: string): Promise<Record<string, unknown>> {
    const rows = await inOrg((tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeObjectId))
    );
    return (rows[0]!.sourceRef ?? {}) as Record<string, unknown>;
  }

  it("1. AGREEMENT: a build reporting the class its pipeline declared is released, and the observation is kept", async () => {
    const eventId = await declareAndReport("image", { artifactClass: "image" });
    const row = await settled(eventId);

    expect(row.resultingChangeObjectId).toBeTruthy();
    const sourceRef = await sourceRefOf(row.resultingChangeObjectId!);
    // Kept on the change so a satisfied verification stays re-derivable from stored data. A `match`
    // deliberately writes NO Decision — one per successful release is the unbounded-growth shape
    // this codebase has already paid for once — so without this key it would leave no trace at all.
    expect(sourceRef.artifact_class).toBe("image");
    expect(sourceRef.artifact_class_invalid).toBeUndefined();
  });

  it("2. THE REFUSAL: a disagreeing class stops the release, marks the event processed, and records BOTH sides", async () => {
    const eventId = await declareAndReport("image", { artifactClass: "rpm" });
    const row = await settled(eventId);

    // (a) No release. This is the point of the whole increment: the declared class selects the
    //     journey template, so a disagreeing release would run a journey shaped for bytes it does
    //     not have, in which every individual step still "succeeds".
    expect(row.resultingChangeObjectId).toBeNull();

    // (b) Still PROCESSED. A permanent, caller-shaped defect must not retry forever and wedge every
    //     event queued behind it on this persist-then-process ingress.
    expect(row.processedAt).not.toBeNull();

    // (c) Decision-backed, carrying the RECORD and not just a sentence — charter principle 6. An
    //     operator has to be able to tell WHICH of the two declarations to correct, and "artifact
    //     class mismatch" alone does not say.
    const [decision] = await inOrg((tx) =>
      tx.select().from(decisions).where(eq(decisions.subjectId, eventId))
    );
    expect(decision).toBeTruthy();
    expect(decision!.verdict).toBe("block");
    const ctx = decision!.inputContext as Record<string, unknown>;
    expect(ctx.artifactClassVerification).toEqual({
      declared: "image",
      observed: "rpm",
      evidenceSource: "buildReport",
      verdict: "mismatch"
    });
  });

  it("3a. UNCHANGED: a report carrying NO class is released exactly as before, with no artifact-class key", async () => {
    // THE ADDITIVE PROPERTY. Every reporter in the estate predates this field and lands here.
    const eventId = await declareAndReport("image", {});
    const row = await settled(eventId);

    expect(row.resultingChangeObjectId).toBeTruthy();
    const sourceRef = await sourceRefOf(row.resultingChangeObjectId!);
    // Asserted as ABSENT rather than "not a mismatch": `unverified` must not leave a trace that a
    // later reader could mistake for an observation.
    expect("artifact_class" in sourceRef).toBe(false);
    expect("artifact_class_invalid" in sourceRef).toBe(false);
  });

  it("3b. UNCHANGED: an infrastructure pipeline reporting no class is untouched (the default mapping type)", async () => {
    // `source_mappings.type` defaults to `configuration`, so the overwhelming majority of live
    // mappings are non-build. None of them may be disturbed by this increment.
    const eventId = await declareAndReport("configuration", {});
    const row = await settled(eventId);
    expect(row.resultingChangeObjectId).toBeTruthy();
  });

  it("4. THE STRICT DOOR: an undeclared key is still refused 400 — which is WHY the field had to be declared", async () => {
    // The control for case 1. If `ChangeReportRequestSchema` ever stopped being a `strictObject`,
    // case 1 would keep passing while the real reason this field needed declaring evaporated.
    const component = await createTestComponent(admin, { name: `ac-strict-${label()}` });
    const repo = `acme/${label()}`;
    await admin.changeSources.createMapping("terraform", {
      repoPattern: repo,
      component: component.id,
      type: "image"
    } as Parameters<typeof admin.changeSources.createMapping>[1]);

    await expect(
      admin.changeSources.report("terraform", {
        status: "applied",
        repo,
        artifactKlass: "image"
      } as unknown as Parameters<typeof admin.changeSources.report>[1])
    ).rejects.toMatchObject({ status: 400 });
  });

  it("5. A NON-BUILD pipeline claiming an artifact class is refused, through the same one path", async () => {
    // Not a hypothetical: `configuration` is the column default, so this is what a misconfigured
    // pipeline actually looks like. It falls out of the SAME equality check — no second branch,
    // which is why `declared` is the full `ExecutorType` rather than the narrow `ArtifactClass`.
    const eventId = await declareAndReport("configuration", { artifactClass: "image" });
    const row = await settled(eventId);

    expect(row.resultingChangeObjectId).toBeNull();
    const [decision] = await inOrg((tx) =>
      tx.select().from(decisions).where(eq(decisions.subjectId, eventId))
    );
    const ctx = decision!.inputContext as Record<string, unknown>;
    expect(ctx.artifactClassVerification).toMatchObject({
      declared: "configuration",
      observed: "image",
      verdict: "mismatch"
    });
  });
});

// MUTATION TABLE — measured 2026-08-27. See docs/coordination.md §5.
