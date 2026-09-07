import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient, type ExplainChangeResponse } from "@scp/sdk";
import { v7 as uuidv7 } from "uuid";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer
} from "../test-support/harness.js";

/** Truncated and never reported are different facts. See docs/coordination.md §588. */

/** 400 refs of the shape Argo CD reports. Over the whole-value budget on their own. */
const IMAGE_REF_COUNT = 400;
const imageRefs = Array.from(
  { length: IMAGE_REF_COUNT },
  (_, i) => `ghcr.io/acme/platform/service-${i}:1.2.3@sha256:${"a".repeat(64)}`
);

/** A multi-source Application's joined revision — 100 sources, 4 099 characters. */
const MULTI_SOURCE_REVISION = Array.from({ length: 100 }, (_, i) =>
  (i.toString(16).padStart(8, "0") + "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f7").slice(0, 40)
).join("+");

const HONEST_IMAGES = ["ghcr.io/org/app:1.2.3", `ghcr.io/org/sidecar@sha256:${"a".repeat(64)}`];
const HONEST_REVISION = "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982";
const ROLLOUT = { phase: "Progressing", step: 3, weight: 60, message: "canary at 60%" };

/** THE COLUMN POLICY, HAND-COPIED ON PURPOSE. See docs/coordination.md §589. */
const COLUMN_POLICY_CHARS = 8_000;

// Typed against the generated response, not the schemas. See docs/coordination.md §590.
type GeneratedWaveTarget = NonNullable<
  ExplainChangeResponse["plan"]
>["waves"][number]["targets"][number];
type GeneratedObserved = NonNullable<GeneratedWaveTarget["observed"]>;
type GeneratedTruncation = NonNullable<GeneratedObserved["truncation"]>;
type GeneratedTruncationEntry = GeneratedTruncation[string];

/** A consumer's read path, written the way `apps/web` would have to write it. */
function observedOf(explain: ExplainChangeResponse, targetObjectId: string): GeneratedObserved {
  const target = explain.plan?.waves
    .flatMap((wave) => wave.targets)
    .find((candidate) => candidate.targetObjectId === targetObjectId);
  if (!target) throw new Error(`no wave target for ${targetObjectId} in the explain response`);
  if (!target.observed) throw new Error(`the wave target for ${targetObjectId} has no observed`);
  return target.observed;
}

describe("M23.1g: an API consumer can tell a truncated field from an absent one", () => {
  let server: ListeningTestServer;
  const cutTargetId = uuidv7();
  const honestTargetId = uuidv7();
  const noRolloutTargetId = uuidv7();

  let cut: GeneratedObserved;
  let honest: GeneratedObserved;
  let noRollout: GeneratedObserved;

  beforeAll(async () => {
    // NON-VACUITY BEFORE THE SERVER BOOTS. If the oversized fixture stopped overflowing, every arm
    // below would pass because nothing was cut — the "green for the wrong reason" mode this
    // repository has shipped more than once.
    expect(
      JSON.stringify({
        revision: MULTI_SOURCE_REVISION,
        images: imageRefs,
        rollout: ROLLOUT
      }).length
    ).toBeGreaterThan(COLUMN_POLICY_CHARS);
    // …and the honest one really does fit, whole, with room to spare.
    expect(
      JSON.stringify({ revision: HONEST_REVISION, images: HONEST_IMAGES, rollout: ROLLOUT }).length
    ).toBeLessThan(COLUMN_POLICY_CHARS / 2);

    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      fakeExecutorConfig: {
        forcePhase: {
          [cutTargetId]: "running",
          [honestTargetId]: "running",
          [noRolloutTargetId]: "running"
        },
        imagesByTarget: {
          [cutTargetId]: imageRefs,
          [honestTargetId]: HONEST_IMAGES,
          [noRolloutTargetId]: HONEST_IMAGES
        },
        // `noRolloutTargetId` is DELIBERATELY absent from this map: its executor reports no rollout
        // at all, which is the "absent" half of the distinction this file exists for.
        rolloutByTarget: { [cutTargetId]: ROLLOUT, [honestTargetId]: ROLLOUT },
        stateRefByTarget: {
          [cutTargetId]: MULTI_SOURCE_REVISION,
          [honestTargetId]: HONEST_REVISION,
          [noRolloutTargetId]: HONEST_REVISION
        }
      }
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  beforeAll(async () => {
    const org = await createTestOrg(server, "observed-truncation");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    /** Propose a change against one target and read the API back until reconcile has observed it. */
    async function observeThrough(targetId: string, name: string): Promise<GeneratedObserved> {
      const component = await createTestComponent(admin, { id: targetId, name });
      expect(component.id).toBe(targetId);
      const change = await admin.changes.propose({ name, targets: [targetId] });
      return waitUntil(
        async () => {
          // THROUGH THE PUBLIC API, not through `withTenantTx` and a `select`. A row a consumer
          // cannot read is not a signal, and this is the read path `apps/web` has.
          const explain = await admin.changes.explain(change.id);
          const target = explain.plan?.waves
            .flatMap((wave) => wave.targets)
            .find((candidate) => candidate.targetObjectId === targetId);
          return target?.observed ? observedOf(explain, targetId) : undefined;
        },
        { describe: `an observed reading on the API for ${name}`, timeoutMs: 30_000 }
      );
    }

    cut = await observeThrough(cutTargetId, "observed-truncation-cut");
    honest = await observeThrough(honestTargetId, "observed-truncation-honest");
    noRollout = await observeThrough(noRolloutTargetId, "observed-truncation-no-rollout");
  });

  it("AN HONEST READING CARRIES NO `truncation` KEY ON THE WIRE", () => {
    // The negative control, and the one that makes every other arm mean something. A signal present
    // on readings that lost nothing is a signal a consumer stops reading.
    expect(honest.images).toEqual(HONEST_IMAGES);
    expect(honest.revision).toBe(HONEST_REVISION);
    expect(honest.rollout?.weight).toBe(60);
    expect(honest.truncation).toBeUndefined();
  });

  it("ABSENT: a rollout the executor never reported has no rollout AND no truncation entry", () => {
    // This is the sentence `PipelineWaveCard` is entitled to render as "no rollout": the field is
    // missing and nothing says we took it.
    expect(noRollout.rollout).toBeUndefined();
    expect(noRollout.truncation?.rollout).toBeUndefined();
    // …and the reading is otherwise whole, so "absent" is about the rollout and not about a
    // reading that was damaged in some other way.
    expect(noRollout.truncation).toBeUndefined();
  });

  it("TRUNCATED: a cut image list says so, with the count, through the generated SDK alone", () => {
    // The list really is shorter than what the executor reported…
    expect(cut.images!.length).toBeLessThan(IMAGE_REF_COUNT);
    // …and WITHOUT the signal, a consumer looking for `service-399` finds nothing and has no way
    // to tell that from "the executor never deployed it" — which is precisely the
    // `no_matching_image_ref` verdict that blamed the executor.
    expect(cut.images!.some((ref) => ref.includes("service-399"))).toBe(false);

    const entry: GeneratedTruncationEntry | undefined = cut.truncation?.images;
    expect(entry).toBeDefined();
    expect(entry!.dropped).toBe(false);
    expect(entry!.droppedEntries).toBeGreaterThan(0);
    // The arithmetic is honest against what arrived: kept + dropped is what the executor sent.
    // (`images` carries one elision entry of its own, which is why this is `>=` rather than `===`
    //  — the consumer is not being asked to know that, and the count above is what it acts on.)
    expect(entry!.droppedEntries! + cut.images!.length).toBeGreaterThanOrEqual(IMAGE_REF_COUNT);
  });

  it("TRUNCATED: a shortened revision says so, in characters", () => {
    expect(cut.revision!.length).toBeLessThan(MULTI_SOURCE_REVISION.length);
    const entry = cut.truncation?.revision;
    expect(entry).toBeDefined();
    expect(entry!.dropped).toBe(false);
    expect(entry!.droppedCharacters).toBeGreaterThan(0);
    expect(entry!.droppedCharacters!).toBeLessThan(MULTI_SOURCE_REVISION.length);
  });

  it("THE ROLLOUT THAT SURVIVED A TRUNCATED READING IS NOT REPORTED AS LOST", () => {
    // The other half of the same honesty. `rollout` is on the row of a reading that WAS cut
    // elsewhere, so a report keyed by "the reading" rather than by "the field" would smear the
    // wrong-cause defect across a leaf that is perfectly intact — and this one is the leaf
    // ADR-0028's `minWeight` gate reads.
    expect(cut.rollout?.weight).toBe(60);
    expect(cut.truncation?.rollout).toBeUndefined();
  });

  it("THE SIGNAL IS PART OF THE SAME READING, so a consumer never pairs it with a stale value", () => {
    // The report is written in the SAME statement as the value it describes. Asserted here because
    // the alternative designs considered — a second column, a read-time derivation — could each
    // have produced a report describing a different tick's reading.
    const keys = Object.keys(cut.truncation as GeneratedTruncation);
    expect(keys.sort()).toEqual(["images", "revision"]);
    // And `observedAt` — the internal stamp beside `truncation` in the column — is still NOT on the
    // wire, which is what proves the schema is the gate here and not the row.
    expect((cut as Record<string, unknown>).observedAt).toBeUndefined();
  });
});
