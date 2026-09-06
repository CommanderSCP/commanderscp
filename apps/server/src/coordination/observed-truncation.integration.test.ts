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

/**
 * ================================================================================================
 * M23.1g — "TRUNCATED" AND "NEVER REPORTED" ARE DIFFERENT FACTS, AND THE API HAS TO SAY WHICH
 * ================================================================================================
 * M23.1f bounded every plugin-supplied value that becomes a row and told nobody outside the server.
 * From an API consumer's seat the two sentences below produced IDENTICAL bytes:
 *
 *     the executor deployed no rollout / reported fewer images
 *     we removed the rollout / the tail of the image list on the way to the column
 *
 * `PipelineWaveCard` renders the first one. That is an operator handed a WRONG CAUSE — the same
 * class as ADR-0028's `no_weight`, which is documented as "a non-ArgoCD executor, or a blue/green
 * Rollout" and was being reported for a field the persistence bound had dropped (charter
 * principle 6).
 *
 * ================================================================================================
 * WHAT THIS FILE PROVES THAT THE UNIT ARMS CANNOT
 * ================================================================================================
 * `packages/runner-launcher/src/persisted-json-truncation.test.ts` proves the BOUND reports what it
 * removed. That is a fact about a function. This file asks the only question a consumer actually
 * has: is the report READABLE FROM THE API, through the generated SDK, with no server-internal
 * import? Three ways it could be true in the unit file and false here, each of which has happened
 * to some field of this row before:
 *
 *   * the store computes it and never writes it (M23.1f's own `observedAt` lives in the column and
 *     is deliberately NOT surfaced — the response serializer key-strips whatever the schema does
 *     not name, so "it is in the row" says nothing about "it is on the wire");
 *   * `plan-service.ts`'s cast does not name it, so the serializer drops it;
 *   * the schema names it but `pnpm gen` was not run, so no consumer has the type.
 *
 * THE IMPORT LIST IS PART OF THE ASSERTION. This file imports `@scp/sdk` and the harness. It does
 * NOT import `@scp/runner-launcher` — not for `PERSISTED_JSON_MAX_CHARS`, not for
 * `isPersistedJsonEntriesElision`, not for the marker text. `apps/web` cannot import them either,
 * and a test that reached for them would be proving something no consumer can do. The 8 000 below
 * is therefore written as a literal with its name in the comment rather than imported, which is the
 * one place this file accepts a hand-copied constant.
 *
 * ================================================================================================
 * WHAT IS REACHABLE END TO END, AND WHAT IS NOT — MEASURED, NOT ASSUMED
 * ================================================================================================
 * The M23.1g entry describes the defect as "an elided `rollout` is `undefined`, so the card reads
 * 'no rollout'". That WAS reachable — at 73 image refs, before M23.1f's water-filling landed. It is
 * NOT reachable today and this file says so rather than pretending: `observedStateFrom` composes
 * exactly three root fields, phase 1 prices a seat at `admissionCost` (at most 96), and three seats
 * cost at most ~288 of the 7 584 the walk is given. A root field of `observed_state` cannot be
 * refused at the production budget until an executor contributes something like SEVENTY-EIGHT
 * observed fields.
 *
 * So `dropped: true` is covered by the unit file, at a budget where it is reachable, and what this
 * file drives is what a real Argo CD can actually produce today:
 *
 *   droppedEntries    an umbrella Application's `status.summary.images` is uncapped; 400 refs is
 *                     over the column on its own. The tail is cut, and a reader looking for a
 *                     specific ref past the cut used to be told `no_matching_image_ref` — the
 *                     executor's fault, for something we did.
 *   droppedCharacters a MULTI-SOURCE Application reports one revision per source and the executor
 *                     joins them (`observe.ts`: `stateRef: "7d34ef12+ff3fd8a3"`). 100 sources is
 *                     4 099 characters and the stored `revision` is not that string.
 *
 * The `dropped` case remaining latent is recorded in BUILD_AND_TEST.md's M23.1g entry, WITH the
 * arithmetic above, so that a future retune of the budget — or the seventy-eighth observed field —
 * is not the first time anyone notices it can fire again.
 *
 * ================================================================================================
 * DELETE-THE-WIRING GATE — applied, watched fail, reverted
 * ================================================================================================
 * | Mutation | Result |
 * |---|---|
 * | `...(bounded.truncation ? { truncation: … } : {})` deleted from `updateWaveTargetObserved` — the store computes the report and never writes it | RED, 3 of 6, named |
 * | `truncation` deleted from `ChangeWaveTargetSchema.observed` (with `@scp/schemas` rebuilt) — the row has it and the response serializer key-strips it | RED, the same 3 of 6 |
 *
 * The two arms that stay GREEN under both are the negative controls (`AN HONEST READING…`,
 * `ABSENT: …`), which is correct and is the point of having them: they assert an ABSENCE, and
 * deleting the wiring produces absences everywhere. A file made only of those two would be a file
 * that passes with the feature deleted.
 *
 * `plan-service.ts`'s cast is NOT in this table, deliberately. It is a `as` on a `jsonb` column, so
 * removing `truncation` from it is a compile error and never a runtime strip — the SCHEMA is the
 * gate at runtime, which the last arm proves from the other side by showing `observedAt` (in the
 * column, absent from the schema) does not reach the wire.
 */

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

/**
 * THE COLUMN POLICY, HAND-COPIED ON PURPOSE. `PERSISTED_JSON_MAX_CHARS` lives in
 * `@scp/runner-launcher`, which this file refuses to import for the reason in the header. If the
 * policy ever moves, the non-vacuity assertions below get WEAKER (a fixture that no longer
 * overflows), never wrong — and `observed-state-row-size.test.ts` is the file that holds the real
 * number against the real constant.
 */
const COLUMN_POLICY_CHARS = 8_000;

// ------------------------------------------------------------------------------------------------
// EVERYTHING BELOW IS TYPED AGAINST THE GENERATED RESPONSE, NOT AGAINST `@scp/schemas`.
// `ExplainChangeResponse` comes out of `packages/sdk/src/generated` — emitted from
// `tools/openapi/openapi.v1.json` by `pnpm gen`. If `observed.truncation` were missing from the
// OpenAPI document, or the codegen had not been re-run and committed, these type aliases would not
// compile. That is the "through the generated SDK types ALONE" half of the done criterion, and it
// is checked by `tsc`, not by an assertion.
// ------------------------------------------------------------------------------------------------
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
