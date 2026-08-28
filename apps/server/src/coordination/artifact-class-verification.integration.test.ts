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

/**
 * D13 (increment 8) — THE ARTIFACT-CLASS VERIFICATION, END TO END: a pipeline declares the class it
 * produces, a build reports what it actually produced, and a DISAGREEMENT refuses the release with a
 * Decision that carries both sides.
 *
 * ============================================================================================
 * WHAT WAS BROKEN, AND WHY A COMMENT WOULD NOT HAVE CLOSED IT
 * ============================================================================================
 * `ArtifactClassVerificationSchema` shipped with the increment 8 contract and then sat with ZERO
 * consumers repo-wide — no server module, not even a test — while the `buildReport` evidence source
 * it named DID NOT EXIST ON THE WIRE: `ChangeReportRequestSchema` carried `artifactDigest` but no
 * artifact class, so no build had any way to say it produced an RPM. The schema's own doc described,
 * in detail, a check that nothing performed. That is this repo's dominant defect class, and the
 * standing rule it violates is the sharper one: a well-written comment naming a hazard is a signal
 * to SWEEP, not evidence the hazard was handled.
 *
 * So the property under test is not "the verdict function returns the right string" — that is the
 * unit file next door. It is "a disagreement between the two declarations STOPS A RELEASE", proved
 * through the real typed ingress and the real processor.
 *
 * ============================================================================================
 * WHAT EACH CASE IS PROVED **WITH**
 * ============================================================================================
 *   - Every case goes through the GENERATED SDK's `changeSources.report(...)` — a real PAT-authed
 *     HTTP call, the real route, the real `strictObject` body. This is not incidental: case 4 exists
 *     because that strictness is exactly why `artifactClass` had to be DECLARED on the schema rather
 *     than merely read by the processor's generic hint extractor. A processor-level unit test would
 *     pass on a build where every real reporter received a 400.
 *
 *   - The REFUSAL (case 2) asserts three things together, because each alone is satisfiable by a
 *     broken build: NO change object was produced, the event was still marked PROCESSED (a permanent
 *     defect must not retry forever on a persist-then-process ingress), and a Decision exists whose
 *     `inputContext` carries the verification RECORD with both sides. Asserting only "no change"
 *     would also pass if the processor had simply crashed.
 *
 *   - The UNCHANGED BEHAVIOUR (cases 3a/3b) is the additive property, and it is the case most worth
 *     protecting: every reporter in the estate predates this field. A report that omits the class
 *     must produce a byte-identical outcome to before, which is asserted as "the change is created
 *     AND `sourceRef` carries no artifact-class key at all" rather than merely "it did not refuse".
 *
 * ============================================================================================
 * MUTATIONS RUN (2026-08-27) — four, each applied ALONE against a passing suite and reverted by an
 * exact inverse edit. One of them (M-a) SURVIVED every case in this file; the table at the bottom
 * records that and says why, rather than quietly claiming the coverage. Measured, not predicted.
 * ============================================================================================
 */
describe("D13 artifact-class verification (integration)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    // BOTH flags are required and neither is optional decoration: the reconcile loop is what runs
    // `processChangeSourceEvents`, and it schedules its tick on the RELAY's pg-boss. With only the
    // relay, every report below persists an event nothing ever processes and each assertion becomes
    // a 15s timeout that reads like a slow processor rather than an absent one — measured, not
    // guessed; that is exactly how this file first failed.
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

/*
 * ============================================================================================
 * MUTATION TABLE — measured 2026-08-27. Each applied ALONE against a passing suite and reverted by
 * an exact inverse edit; baseline restored to 17/17 afterwards and re-run to confirm. Baseline:
 * 6 (this file) + 11 (`artifact-class-verification.test.ts`) = 17. Nothing below is a prediction.
 * ============================================================================================
 *
 *  M-a  `artifact-class-verification.ts`: return `verdict: "match"` instead of `"unverified"` when
 *       no class was reported — the inversion that would silently turn "we never checked" into
 *       "we checked and it was fine"
 *         -> 3 unit failed. THE 6 INTEGRATION CASES ALL SURVIVED, and this file says so rather than
 *            claiming a coverage it does not have: `unverified` and `match` BOTH proceed to a
 *            created change with no artifact-class key written, so the two are INDISTINGUISHABLE at
 *            this layer by construction. The distinction is only observable in the verdict record,
 *            which integration sees only on the refusal path. The unit file carries this property
 *            alone, deliberately — not by oversight.
 *
 *  M-b  `webhook-processor.ts`: delete the `verdict === "mismatch"` refusal block entirely, leaving
 *       the verification computed and never acted on — the EXACT "built, tested, installed nowhere"
 *       shape this whole increment exists to close
 *         -> 2 failed here (cases 2 and 5); all 11 unit passed, correctly — the pure function is
 *            untouched by this mutation, which is precisely why a unit test could never have caught
 *            it and why the integration file exists.
 *
 *  M-c  `webhook-processor.ts`: drop `artifactClassVerification` from the refusal Decision's
 *       `inputContext`, keeping the refusal itself intact
 *         -> 2 failed here (cases 2 and 5). Confirms the cases assert the RECORD and not merely that
 *            something was blocked — a refusal without its inputs is not Decision-backed.
 *
 *  M-d  `executors.ts`: remove `artifactClass` from `ChangeReportRequestSchema`, WITH a
 *       `@scp/schemas` rebuild (without the rebuild the server keeps resolving the old `dist/` and
 *       the mutation is not applied at all — the false-green trap D23 measured and recorded)
 *         -> 3 failed here (cases 1, 2 and 5), each a 400 at the strict door rather than a wrong
 *            verdict. That is the trap case 4 pins from the other side: the field must be DECLARED,
 *            not merely read, or every real reporter is refused before the processor ever runs.
 */
