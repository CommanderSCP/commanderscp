import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { DependencyLineKey } from "@scp/schemas";
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { createDb } from "../db/client.js";
import { changeWaveTargets, changes, decisions, objects } from "../db/schema.js";
import { compileAndPersistPlan } from "../coordination/plan-service.js";
import { listDecisionsForSubject } from "../coordination/decisions-repo.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { DOMAIN_EVENTS_QUEUE, startPgBoss } from "../events/pgboss.js";
import { upsertExecutorBinding } from "../coordination/executor-bindings-repo.js";
import type { GitFileReadPluginClient, PluginHost } from "../plugin-host/contract.js";
import {
  acceptedChangeRouter,
  startInternalReleaseLoop,
  type InternalReleaseLoopHandle
} from "./internal-release-loop.js";
import {
  declareDependencyLineProducer,
  getDependencyLineById,
  getDependencyLineProducer,
  upsertComponentDependency,
  upsertDependencyLine
} from "./dependency-inventory-repo.js";
import {
  detectInternalReleases,
  INTERNAL_RELEASE_DECISION_KIND
} from "./internal-release-detection.js";
import type { ManifestReader } from "./internal-release-version.js";

/**
 * M21.4 — INTERNAL DETECTION AGAINST REAL POSTGRES (ADR-0032 §7).
 *
 * The version STRATEGY is proven without a database in `internal-release-version.test.ts`. What only
 * a real database and the real coordination tables can prove is the DERIVATION itself — that the
 * chain from an accepted change to a dependency line's head is wired to the columns it claims to
 * read, and that each of its exclusions actually excludes:
 *
 *   1. A ROLLBACK IS NOT A RELEASE, with the positive control that an otherwise identical forward
 *      accept IS. Without the control, the rollback assertion is satisfied by a derivation that
 *      never records anything at all — which is exactly what a wrong join, a wrong status filter or
 *      a missing fixture produces.
 *   2. A NON-PROD TARGET DOES NOT TRIGGER — again against the prod control, since "prod" is a
 *      deployment-target PROPERTY and not a table.
 *   3. A COMPONENT THAT DECLARES NO PRODUCED LINE IS A NO-OP — and writes no Decision, which is what
 *      keeps a per-accept Decision off every change in the org.
 *   4. THE `oci` VERSION COMES FROM `observed.images`, tag AND digest.
 *   5. A LANGUAGE VERSION COMES FROM THE PRODUCER'S MANIFEST, read at the released commit.
 *   6. AN UNDETERMINABLE VERSION RECORDS NOTHING AND SAYS WHY — the line's `latest_*` stays null and
 *      the Decision names the reason.
 *
 * FIXTURE DISCIPLINE. Every fixture that a test's conclusion depends on is READ BACK before it is
 * relied on (the change really is `accepted`, the wave target really is `succeeded`, the producer
 * link really landed). A silently-inapplicable fixture makes an absence assertion pass for the wrong
 * reason, which is this repo's second-most-common recurring test defect.
 *
 * ============================================================================================
 * MUTATION LOG — each row applied, watched fail, reverted, watched pass
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | drop the `rollbackOfObjectId` check (treat every accept as a release) | "a rollback is NOT a release" FAILS — the withdrawn version is recorded as the line's head |
 * | drop the `environment === 'prod'` filter | "a non-prod release does not move the head" FAILS |
 * | accept every wave-target status, not just `succeeded` | "a failed wave target is not a release" FAILS |
 * | fall back to the digest when the image ref carries no tag | "records NOTHING for a digest-only ref" FAILS — `latest_version` reads `sha256:…` |
 * | drop `lineAcceptsVersion` (record any determined version on any produced line) | "a release on a DIFFERENT major line" FAILS — the 2.x line's head reads 1.9.9 |
 * | `insertDecision` instead of `insertDecisionIfChanged` | "a redelivered accept appends no second Decision" FAILS with 2 rows |
 * | OMIT `latestDigest` when none was observed instead of writing an explicit null | "CLEARS a stale digest" FAILS. **This mutant SURVIVED the first version of this suite** — every other case builds a fresh line, which has no stale digest to leave behind, so the test was added for the mutant rather than the mutant found by the test |
 * | drop the subscriber gate (record for every produced line) | "no subscriber ⇒ nothing is fetched" FAILS |
 * | drop the VARIANT half of `lineAcceptsVersion` (the pre-M21.4 internal reading, which compared only the numeric core) | "does NOT take a PLAIN tag as the head of an `-alpine` VARIANT line" FAILS — the alpine line's head reads a glibc tag |
 * | make `evaluateHeadMovement` never return `behind_head` | "a HOTFIX on an older minor does not walk the head backwards" FAILS — the head reads 1.9.10 |
 * | drop the `distinctClaims.length > 1` refusal (take the first place's answer) | "REFUSES to pick when two prod places disagree" FAILS — a winner is picked by wave-target UUID order |
 */
describe("M21.4 internal release detection (ADR-0032 §7)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let prodTarget: string;
  let prodTargetTwo: string;
  let gammaTarget: string;

  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  /** The instance unlock is operator-written over the ADMIN connection — `scp_app` holds no write
   *  grant (0062's two barriers). Instance-global, so it is removed at teardown. */
  async function setInstanceUnlock(unlocked: boolean | null): Promise<void> {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      if (unlocked === null) {
        await pool.query(`DELETE FROM dependency_subscription_unlock WHERE id = 'default'`);
        return;
      }
      await pool.query(
        `INSERT INTO dependency_subscription_unlock (id, unlocked, note, updated_at)
           VALUES ('default', $1, 'M21.4 integration fixture', now())
         ON CONFLICT (id) DO UPDATE SET unlocked = EXCLUDED.unlocked, updated_at = now()`,
        [unlocked]
      );
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "internal-release");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    prodTarget = (
      await admin.deploymentTargets.create({
        name: `prod-${uuidv7()}`,
        properties: { environment: "prod" }
      })
    ).id;
    // A SECOND prod place. `environment` is a deployment-target PROPERTY, so two of them are two
    // production regions — the shape that made "which one is the line's head?" a real question.
    prodTargetTwo = (
      await admin.deploymentTargets.create({
        name: `prod-two-${uuidv7()}`,
        properties: { environment: "prod" }
      })
    ).id;
    gammaTarget = (
      await admin.deploymentTargets.create({
        name: `gamma-${uuidv7()}`,
        properties: { environment: "gamma" }
      })
    ).id;
    await setInstanceUnlock(true);
  });

  afterAll(async () => {
    await setInstanceUnlock(null).catch(() => undefined);
    await server?.close();
  });

  // -----------------------------------------------------------------------------------------
  // Fixture builders
  // -----------------------------------------------------------------------------------------

  /** (component, deployment-target) pairs already placed — see `releaseTo`. */
  const placedPairs = new Set<string>();

  /**
   * A dependency line, its DECLARED producer, and a subscriber — the three facts the derivation
   * needs before it will record anything.
   *
   * The subscriber is a SECOND component that declares the line, plus a policy enabling it at
   * `objectRef` scope. It is not decoration: the derivation refuses to fetch or record for a line
   * nobody subscribes to (ADR-0032 §6, "the ingestion work-list is derived from this resolution"),
   * and `objectRef` rather than `group` because the authoring guard refuses a group-scoped
   * `dependencySubscription` effect outright, in both directions (§6a). NOT, as this used to say,
   * because the job runs as the system actor: group scope's owning half ignores the actor and would
   * match here if this fixture minted an `owns` edge — which is precisely the unstated, mutable
   * reach §6a-ii refuses to let a subscription rest on.
   */
  async function lineProducedBy(
    key: DependencyLineKey & { tagPattern?: string },
    producerComponentObjectId: string,
    options: { subscriber?: boolean } = {}
  ): Promise<string> {
    const lineId = await inOrg(async (tx) => {
      const line = await upsertDependencyLine(tx, org.orgId, key);
      // The declaration is per COORDINATE since drizzle/0068, so it names no line id — which is
      // also why it would still be true of a `3` line this fixture never mints.
      await declareDependencyLineProducer(tx, org.orgId, {
        ecosystem: key.ecosystem,
        coordinate: key.coordinate,
        producerObjectId: producerComponentObjectId,
        declaredByObjectId: producerComponentObjectId
      });
      return line.id;
    });

    // READ BACK: the producer declaration is what makes this coordinate internal at all, and a
    // silently-absent one would make every "nothing was recorded" assertion below pass for the
    // wrong reason.
    const stored = await inOrg((tx) =>
      getDependencyLineProducer(tx, org.orgId, {
        ecosystem: key.ecosystem,
        coordinate: key.coordinate
      })
    );
    expect(stored?.producerObjectId, "the DECLARED producer link must have landed").toBe(
      producerComponentObjectId
    );

    if (options.subscriber !== false) {
      const consumer = await createOrphanComponent(admin, `consumer-${uuidv7()}`);
      await inOrg((tx) =>
        upsertComponentDependency(tx, org.orgId, {
          componentObjectId: consumer.id,
          lineId,
          manifestPath: "package.json",
          declaredVersion: "^1.0.0"
        })
      );
      await admin.policies.create({
        name: `sub-${uuidv7()}`,
        urn: `urn:scp:${org.orgId}:policy:sub-${uuidv7()}`,
        properties: {
          scope: { objectRef: consumer.id },
          enforcement: "advisory",
          effects: [{ dependencySubscription: { enabled: true } }]
        }
      });
    }
    return lineId;
  }

  /**
   * A component placed at `target`, released there by a change that reached `succeeded`, and then
   * put into `accepted`.
   *
   * The plan is compiled directly rather than waited for from the reconcile loop — the same
   * shortcut `component-pipeline.integration.test.ts` takes, and for the same reason: compilation is
   * what writes the `change_wave_targets` rows this derivation reads, and the loop's own job
   * (locking, transitions) is covered elsewhere. The topology names the PLACE, so the wave target IS
   * the placement (`plan-service.ts:110`).
   */
  async function releaseTo(
    componentObjectId: string,
    target: string,
    options: {
      observedImages?: string[];
      sourceRef?: Record<string, unknown>;
      status?: string;
      rollbackOf?: string;
      accepted?: boolean;
    } = {}
  ): Promise<string> {
    return releaseToMany(componentObjectId, [{ target, ...options }], options);
  }

  /**
   * ONE change releasing a component to SEVERAL prod places at once, each with its own observed
   * images — the shape a component deployed to two regions actually has, and the one a single-target
   * helper cannot express.
   */
  async function releaseToMany(
    componentObjectId: string,
    places: { target: string; observedImages?: string[]; status?: string }[],
    options: {
      sourceRef?: Record<string, unknown>;
      rollbackOf?: string;
      accepted?: boolean;
    } = {}
  ): Promise<string> {
    // ONE placement per (component, target) — the pair is uniquely indexed (migration 0051), so a
    // second `create` is a 409 and several tests below release the same component twice.
    for (const place of places) {
      const pairKey = `${componentObjectId}::${place.target}`;
      if (!placedPairs.has(pairKey)) {
        await admin.placements.create({
          component: componentObjectId,
          deploymentTarget: place.target
        });
        placedPairs.add(pairKey);
      }
    }
    // The topology is passed to `compileAndPersistPlan` BY ID, so no `releases_via` edge is minted:
    // that edge is how the pipeline VIEW finds a component's topology, and creating one per release
    // would 409 on the second call for the same component while proving nothing here.
    const topo = await admin.object("release-topology").create({
      name: `topo-${uuidv7()}`,
      properties: {
        waves: [{ name: "wave", mode: "parallel", targets: places.map((p) => p.target) }]
      }
    });

    const change = await admin.changes.propose({
      name: `rel-${uuidv7()}`,
      targets: [componentObjectId]
    });
    const plan = await inOrg((tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds: [componentObjectId],
        topologyObjectId: topo.id,
        topologyVersion: null
      })
    );
    const targetRowIds = plan.waves.flatMap((w) => w.targets.map((t) => t.id));
    expect(targetRowIds.length, "the plan must have compiled one wave target per place").toBe(
      places.length
    );

    // WHICH compiled row is WHICH place: the wave target IS the placement object
    // (`plan-service.ts:110`), so the place is read off that object's properties rather than assumed
    // from the order the compiler emitted. Assuming the order would make a two-place test pass or
    // fail on something this file does not control.
    const placeOfRow = new Map<string, string>();
    await inOrg(async (tx) => {
      const rows = await tx
        .select({
          rowId: changeWaveTargets.id,
          targetObjectId: changeWaveTargets.targetObjectId
        })
        .from(changeWaveTargets)
        .where(
          and(
            eq(changeWaveTargets.orgId, org.orgId),
            inArray(changeWaveTargets.id, targetRowIds as string[])
          )
        );
      for (const row of rows) {
        const [placement] = await tx
          .select({ properties: objects.properties })
          .from(objects)
          .where(and(eq(objects.orgId, org.orgId), eq(objects.id, row.targetObjectId)));
        const props = placement?.properties as { deploymentTargetId?: string } | undefined;
        if (props?.deploymentTargetId) placeOfRow.set(row.rowId, props.deploymentTargetId);
      }
    });
    expect(placeOfRow.size, "every compiled row must resolve to a deployment-target").toBe(
      places.length
    );

    // Written through `withTenantTx`, because `deps.db` alone carries NO org context and every one
    // of these tables is under the `org_isolation` RLS policy — an update on the bare pool matches
    // zero rows and says so nowhere, which is precisely the silently-inapplicable fixture that makes
    // an absence assertion pass for the wrong reason.
    await inOrg(async (tx) => {
      for (const [rowId, deploymentTargetId] of placeOfRow) {
        const place = places.find((p) => p.target === deploymentTargetId);
        if (!place) throw new Error(`no fixture for deployment-target ${deploymentTargetId}`);
        await tx
          .update(changeWaveTargets)
          .set({
            status: place.status ?? "succeeded",
            ...(place.observedImages !== undefined
              ? { observedState: { images: place.observedImages } }
              : {})
          })
          .where(and(eq(changeWaveTargets.orgId, org.orgId), eq(changeWaveTargets.id, rowId)));
      }
      await tx
        .update(changes)
        .set({
          state: options.accepted === false ? "executing" : "accepted",
          ...(options.sourceRef !== undefined ? { sourceRef: options.sourceRef } : {}),
          ...(options.rollbackOf !== undefined ? { rollbackOfObjectId: options.rollbackOf } : {})
        })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)));
    });

    // READ BACK both halves. A fixture that did not apply turns every negative assertion in this
    // file into a tautology.
    const [row] = await inOrg((tx) =>
      tx
        .select({ state: changes.state, rollbackOfObjectId: changes.rollbackOfObjectId })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    expect(row?.state, "the change fixture must have taken").toBe(
      options.accepted === false ? "executing" : "accepted"
    );
    if (options.rollbackOf !== undefined) {
      expect(row?.rollbackOfObjectId, "the rollback link must have taken").toBe(options.rollbackOf);
    }
    const waveRows = await inOrg((tx) =>
      tx
        .select({ id: changeWaveTargets.id, status: changeWaveTargets.status })
        .from(changeWaveTargets)
        .where(
          and(
            eq(changeWaveTargets.orgId, org.orgId),
            inArray(changeWaveTargets.id, targetRowIds as string[])
          )
        )
    );
    for (const waveRow of waveRows) {
      const place = places.find((p) => p.target === placeOfRow.get(waveRow.id));
      expect(waveRow.status, "the wave-target status fixture must have taken").toBe(
        place?.status ?? "succeeded"
      );
    }
    return change.id;
  }

  // `detectInternalReleases` takes the `Db`, not a caller's `tx`, and opens its own transactions —
  // its manifest reads reach a user's git provider and must not happen inside one (MINOR C).
  const detect = (changeObjectId: string, readManifest?: ManifestReader) =>
    detectInternalReleases(server.deps.db, org.orgId, {
      changeObjectId,
      ...(readManifest ? { readManifest } : {})
    });

  const headOf = (lineId: string) => inOrg((tx) => getDependencyLineById(tx, org.orgId, lineId));

  /** A reader that answers every path with one body, and records what it was asked. */
  function manifestReader(body: string): { read: ManifestReader; calls: ReadFileAtRefRequest[] } {
    const calls: ReadFileAtRefRequest[] = [];
    return {
      read: async (request): Promise<ReadFileAtRefResult> => {
        calls.push(request);
        return {
          outcome: "found",
          path: request.path,
          requestedRef: request.ref,
          commitSha: request.ref,
          content: body,
          sizeBytes: Buffer.byteLength(body)
        };
      },
      calls
    };
  }

  // -----------------------------------------------------------------------------------------
  // (1) A rollback is not a release — with the forward control
  // -----------------------------------------------------------------------------------------

  it("records the head for a FORWARD accept, and records NOTHING for a rollback of it", async () => {
    const producer = await createOrphanComponent(admin, `producer-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/api", major: "1" },
      producer.id
    );

    // POSITIVE CONTROL FIRST. Without it, the rollback assertion below is satisfied by a derivation
    // that is simply broken — a wrong join, a wrong status filter, an unapplied fixture.
    const forward = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/api:1.2.3@sha256:aa11"]
    });
    const forwardOutcome = await detect(forward);
    expect(forwardOutcome.verdict).toBe("evaluated");
    expect(forwardOutcome.recorded.map((r) => r.version)).toEqual(["1.2.3"]);
    expect((await headOf(lineId))?.latestVersion).toBe("1.2.3");

    // THE ROLLBACK. Same component, same place, same shape — the ONLY difference is
    // `rollback_of_object_id`, which is the structural test DESIGN §9.4 defines. A rollback
    // auto-accepts (`reconcile.ts:1893-1948`), so `toState === 'accepted'` alone would let it
    // through, and it would publish to every subscriber the version the org just withdrew.
    const rollback = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/api:1.2.2@sha256:bb22"],
      rollbackOf: forward
    });
    const rollbackOutcome = await detect(rollback);

    expect(rollbackOutcome.verdict).toBe("evaluated");
    expect(rollbackOutcome.recorded).toEqual([]);
    expect(rollbackOutcome.skipped.map((s) => s.reason)).toEqual(["rollback_is_not_a_release"]);
    // …and the head still says what the FORWARD release put there.
    expect(
      (await headOf(lineId))?.latestVersion,
      "the withdrawn 1.2.2 must not have become the line's head"
    ).toBe("1.2.3");
  });

  // -----------------------------------------------------------------------------------------
  // (2) prod is a deployment-target property, and only prod counts
  // -----------------------------------------------------------------------------------------

  it("does NOT record a release to a non-prod deployment-target", async () => {
    const producer = await createOrphanComponent(admin, `gamma-producer-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/gamma-only", major: "1" },
      producer.id
    );

    const change = await releaseTo(producer.id, gammaTarget, {
      observedImages: ["ghcr.io/acme/gamma-only:1.5.0"]
    });
    const outcome = await detect(change);

    expect(
      outcome.verdict,
      "nothing reached prod, so there is no produced line to speak about"
    ).toBe("no_declared_producer");
    expect((await headOf(lineId))?.latestVersion).toBeNull();

    // NEGATIVE CONTROL: the identical release to a `prod`-labelled target DOES record. The refusal
    // above is therefore about the environment property and not about the fixture.
    const prodChange = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/gamma-only:1.5.0"]
    });
    expect((await detect(prodChange)).recorded.map((r) => r.version)).toEqual(["1.5.0"]);
    expect((await headOf(lineId))?.latestVersion).toBe("1.5.0");
  });

  it("does NOT record a wave target that did not SUCCEED", async () => {
    const producer = await createOrphanComponent(admin, `failed-producer-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/failed", major: "2" },
      producer.id
    );
    const change = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/failed:2.0.1"],
      status: "failed"
    });

    expect((await detect(change)).verdict).toBe("no_declared_producer");
    expect((await headOf(lineId))?.latestVersion).toBeNull();
  });

  // -----------------------------------------------------------------------------------------
  // (3) no produced line ⇒ a no-op, and no Decision at all
  // -----------------------------------------------------------------------------------------

  it("is a NO-OP, with no Decision written, for a component that produces no declared line", async () => {
    const producer = await createOrphanComponent(admin, `no-producer-${uuidv7()}`);
    const change = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/anonymous:1.0.0"]
    });

    const outcome = await detect(change);
    expect(outcome.verdict).toBe("no_declared_producer");
    expect(
      outcome.decision,
      "no Decision — a row per accept would be write amplification"
    ).toBeUndefined();

    const written = await inOrg((tx) => listDecisionsForSubject(tx, org.orgId, change));
    expect(written.filter((d) => d.kind === INTERNAL_RELEASE_DECISION_KIND)).toEqual([]);
  });

  it("does not fetch or record for a produced line NOBODY subscribes to", async () => {
    const producer = await createOrphanComponent(admin, `unsubscribed-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "npm", coordinate: "@acme/unsubscribed", major: "1" },
      producer.id,
      { subscriber: false }
    );
    // The producer's own inventory records a package.json, so the ONLY thing standing between this
    // release and a manifest fetch is the subscriber gate.
    await inOrg((tx) =>
      upsertComponentDependency(tx, org.orgId, {
        componentObjectId: producer.id,
        lineId,
        manifestPath: "package.json",
        declaredVersion: "^1.0.0"
      })
    );
    const reader = manifestReader(JSON.stringify({ version: "1.4.0" }));
    const change = await releaseTo(producer.id, prodTarget, {
      sourceRef: { repo: "acme/api", ref: "refs/heads/main", commit: "c0ffee" }
    });

    const outcome = await detect(change, reader.read);
    expect(outcome.skipped.map((s) => s.reason)).toEqual(["no_subscriber"]);
    expect(reader.calls, "a disabled/unsubscribed line is never fetched (ADR-0032 §6)").toEqual([]);
    expect((await headOf(lineId))?.latestVersion).toBeNull();
  });

  // -----------------------------------------------------------------------------------------
  // (4) the oci version comes from observed.images
  // -----------------------------------------------------------------------------------------

  it("takes the oci version from observed.images — tag AND digest", async () => {
    const producer = await createOrphanComponent(admin, `oci-producer-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/web", major: "3" },
      producer.id
    );
    const change = await releaseTo(producer.id, prodTarget, {
      // A second, unrelated image is observed alongside it: the match is by coordinate, not by
      // "the only one there".
      observedImages: ["ghcr.io/acme/sidecar:9.9.9", "ghcr.io/acme/web:3.4.5@sha256:deadbeef"]
    });

    const outcome = await detect(change);
    expect(outcome.recorded).toHaveLength(1);
    expect(outcome.recorded[0]).toMatchObject({
      version: "3.4.5",
      digest: "sha256:deadbeef",
      signal: "oci_observed_image"
    });

    const line = await headOf(lineId);
    expect(line?.latestVersion).toBe("3.4.5");
    // A MUTABLE TAG IS NOT AN IDENTITY (ADR-0032 §7): the bytes are stored beside the label.
    expect(line?.latestDigest).toBe("sha256:deadbeef");
    expect(line?.latestObservedAt).not.toBeNull();
  });

  it("CLEARS a stale digest when the next release is observed by tag alone", async () => {
    // The mutation this exists for survived the first version of this suite: writing
    // `latestDigest` only when one was observed leaves the PREVIOUS release's digest sitting beside
    // the NEW version, so the line reads "1.4.0 is these bytes" about 1.3.0's bytes — a false
    // statement in an audit record, and one no fresh-line test can see because there is nothing
    // stale to leave behind. `recordDependencyLineHead` distinguishes an omitted key from an
    // explicit null precisely so a caller can choose; this asserts which one this caller chooses.
    const producer = await createOrphanComponent(admin, `stale-digest-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/stale", major: "1" },
      producer.id
    );

    const first = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/stale:1.3.0@sha256:old1"]
    });
    await detect(first);
    expect(
      (await headOf(lineId))?.latestDigest,
      "the fixture must leave a digest to go stale"
    ).toBe("sha256:old1");

    const second = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/stale:1.4.0"]
    });
    await detect(second);

    const line = await headOf(lineId);
    expect(line?.latestVersion).toBe("1.4.0");
    expect(line?.latestDigest, "1.3.0's bytes must not be reported as 1.4.0's").toBeNull();
  });

  it("does NOT move a line's head onto a release from a DIFFERENT major line", async () => {
    const producer = await createOrphanComponent(admin, `two-line-producer-${uuidv7()}`);
    const two = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/dual", major: "2" },
      producer.id
    );
    const one = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/dual", major: "1" },
      producer.id
    );

    // A 1.x maintenance release. Both lines are produced by this component and both are subscribed,
    // so only the version's own major can tell them apart.
    const change = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/dual:1.9.9"]
    });
    const outcome = await detect(change);

    expect(outcome.recorded.map((r) => r.lineId)).toEqual([one]);
    expect((await headOf(one))?.latestVersion).toBe("1.9.9");
    expect(
      (await headOf(two))?.latestVersion,
      "the 2.x line's head must not read a 1.x hotfix — every 2.x subscriber would look ahead of it"
    ).toBeNull();
    expect(outcome.skipped.find((s) => s.lineId === two)?.reason).toBe("different_major_line");
  });

  it("does NOT take a PLAIN tag as the head of an `-alpine` VARIANT line", async () => {
    // `tag_pattern` is the line's literal variant suffix, and it used to mean that to the poll ONLY:
    // this derivation ignored the column entirely, so an alpine line took `4.1.0` — a glibc image —
    // as its head and every subscriber tracking the alpine flavour would have been bumped across
    // variants. One column, two readings; now one, in `line-head.ts`, used by both writers.
    const producer = await createOrphanComponent(admin, `variant-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/variant", major: "4", tagPattern: "-alpine" },
      producer.id
    );
    expect(
      (await headOf(lineId))?.tagPattern,
      "the variant fixture must have landed or this test is vacuous"
    ).toBe("-alpine");

    const plain = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/variant:4.1.0"]
    });
    const plainOutcome = await detect(plain);
    expect(plainOutcome.recorded).toEqual([]);
    expect(plainOutcome.skipped.map((s) => s.reason)).toEqual(["different_tag_variant"]);
    expect((await headOf(lineId))?.latestVersion).toBeNull();

    // NEGATIVE CONTROL: the alpine build of the very same release DOES land, so the refusal is about
    // the variant and not about the line, the fixture, or a derivation that records nothing.
    const alpine = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/variant:4.1.0-alpine"]
    });
    expect((await detect(alpine)).recorded.map((r) => r.version)).toEqual(["4.1.0-alpine"]);
    expect((await headOf(lineId))?.latestVersion).toBe("4.1.0-alpine");
  });

  it("a HOTFIX on an older minor does not walk the head backwards, and says why", async () => {
    // Both releases are genuine, accepted, prod releases of the SAME line: `1.10.0` ships, then a
    // hotfix `1.9.10` ships off the maintenance branch. With no ordering check the second one moved
    // `latest_version` back, and every subscriber already on 1.10.0 was left looking AHEAD of its own
    // line's head — a subscription that then never fires for them again, with nothing to read.
    const producer = await createOrphanComponent(admin, `hotfix-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/hotfix", major: "1" },
      producer.id
    );

    const forward = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/hotfix:1.10.0@sha256:new1"]
    });
    expect((await detect(forward)).recorded.map((r) => r.version)).toEqual(["1.10.0"]);

    const hotfix = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/hotfix:1.9.10@sha256:old1"]
    });
    const outcome = await detect(hotfix);

    expect(outcome.recorded).toEqual([]);
    expect(outcome.skipped.map((s) => s.reason)).toEqual(["behind_head"]);
    // THE RELEASE IS NOT LOST — the column holds the head, the Decision holds the history, and this
    // is where "it happened, at 1.9.10, and the head did not move" is recorded (principle 6).
    expect(outcome.skipped[0]?.detail).toMatch(/1\.9\.10/);
    expect(outcome.skipped[0]?.detail).toMatch(/1\.10\.0/);
    const written = await inOrg((tx) => listDecisionsForSubject(tx, org.orgId, hotfix));
    const decision = written.find((d) => d.kind === INTERNAL_RELEASE_DECISION_KIND);
    expect(JSON.stringify(decision?.reasonTree)).toMatch(/behind_head/);

    const line = await headOf(lineId);
    expect(line?.latestVersion, "the head stands where the newer release left it").toBe("1.10.0");
    // …and so does ITS digest. A refused write leaves the pair alone rather than half-updating it.
    expect(line?.latestDigest).toBe("sha256:new1");
  });

  it("REFUSES to pick when two prod places disagree about what was released", async () => {
    // A component placed in two prod regions, rolled by ONE change, whose executors report different
    // images. The previous behaviour recorded both in turn and the last writer won — ordered by
    // wave-target UUID, so the winner could equally be the OLDER release — while the run reported
    // "0 not recorded" and the Decision asserted two contradictory versions for one line. A line has
    // ONE head; two places disagreeing means the org has no single answer, and inventing one is the
    // wrong-version failure the whole module is arranged to avoid.
    const producer = await createOrphanComponent(admin, `two-regions-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/regional", major: "5" },
      producer.id
    );

    const split = await releaseToMany(producer.id, [
      { target: prodTarget, observedImages: ["ghcr.io/acme/regional:5.2.0@sha256:aa"] },
      { target: prodTargetTwo, observedImages: ["ghcr.io/acme/regional:5.1.0@sha256:bb"] }
    ]);
    const outcome = await detect(split);

    expect(outcome.recorded, "nothing may be recorded from a disagreement").toEqual([]);
    expect(outcome.skipped.map((s) => s.reason)).toEqual(["ambiguous_prod_releases"]);
    // The refusal NAMES both places and both versions — an operator has to be able to see which
    // region is behind without querying the executors themselves.
    const detail = outcome.skipped[0]?.detail ?? "";
    expect(detail).toMatch(/5\.2\.0/);
    expect(detail).toMatch(/5\.1\.0/);
    expect(outcome.skipped[0]?.deploymentTargetObjectIds).toEqual(
      [prodTarget, prodTargetTwo].sort()
    );
    // …and the count the run reports is now true, where it used to say "0 not recorded".
    expect(outcome.detail).toBe("0 line head(s) recorded, 1 not recorded");
    expect((await headOf(lineId))?.latestVersion).toBeNull();

    // NEGATIVE CONTROL: the SAME two places AGREEING record exactly once, so the refusal is about the
    // disagreement and not about a component being placed twice.
    const agreed = await releaseToMany(producer.id, [
      { target: prodTarget, observedImages: ["ghcr.io/acme/regional:5.3.0@sha256:cc"] },
      { target: prodTargetTwo, observedImages: ["ghcr.io/acme/regional:5.3.0@sha256:cc"] }
    ]);
    const agreedOutcome = await detect(agreed);
    expect(agreedOutcome.recorded.map((r) => r.version)).toEqual(["5.3.0"]);
    expect(agreedOutcome.recorded[0]?.deploymentTargetObjectIds).toEqual(
      [prodTarget, prodTargetTwo].sort()
    );
    expect((await headOf(lineId))?.latestVersion).toBe("5.3.0");
  });

  // -----------------------------------------------------------------------------------------
  // (5) a language version comes from the producer's own manifest
  // -----------------------------------------------------------------------------------------

  it("reads a language version out of the producer's manifest, at the released commit", async () => {
    const producer = await createOrphanComponent(admin, `npm-producer-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "npm", coordinate: "@acme/api", major: "2" },
      producer.id
    );
    // WHERE the manifest is comes from the producer's OWN inventory, not from a repo-root guess.
    await inOrg((tx) =>
      upsertComponentDependency(tx, org.orgId, {
        componentObjectId: producer.id,
        lineId,
        manifestPath: "services/api/package.json",
        declaredVersion: "^1.0.0"
      })
    );
    const reader = manifestReader(JSON.stringify({ name: "@acme/api", version: "2.7.0" }));
    const change = await releaseTo(producer.id, prodTarget, {
      sourceRef: { repo: "acme/api", ref: "refs/heads/main", commit: "abc123" }
    });

    const outcome = await detect(change, reader.read);

    expect(outcome.recorded[0]).toMatchObject({ version: "2.7.0", signal: "producer_manifest" });
    expect(reader.calls, "read at the released COMMIT, from the inventory's own path").toEqual([
      { repo: "acme/api", path: "services/api/package.json", ref: "abc123" }
    ]);
    const line = await headOf(lineId);
    expect(line?.latestVersion).toBe("2.7.0");
    expect(
      line?.latestDigest,
      "a language ecosystem has no digest, and must not keep a stale one"
    ).toBeNull();
  });

  // -----------------------------------------------------------------------------------------
  // (6) undeterminable ⇒ record NOTHING, and say why
  // -----------------------------------------------------------------------------------------

  it("records NOTHING and states the reason when the version cannot be determined", async () => {
    const producer = await createOrphanComponent(admin, `undeterminable-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/digest-only", major: "1" },
      producer.id
    );
    // A digest-only ref. The digest is right there and is unambiguous — and it is not a version.
    const change = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/digest-only@sha256:cafe"]
    });

    const outcome = await detect(change);

    expect(outcome.recorded).toEqual([]);
    expect(outcome.skipped[0]?.reason).toBe("image_ref_has_no_tag");
    const line = await headOf(lineId);
    expect(
      line?.latestVersion,
      "'not yet observed' — never a digest wearing a version's column"
    ).toBeNull();
    expect(line?.latestDigest).toBeNull();

    // THE REASON IS LEGIBLE IN THE DECISION, not only in the return value (charter principle 6).
    const written = await inOrg((tx) => listDecisionsForSubject(tx, org.orgId, change));
    const decision = written.find((d) => d.kind === INTERNAL_RELEASE_DECISION_KIND);
    expect(decision, "an evaluated derivation persists its verdict").toBeDefined();
    expect(JSON.stringify(decision?.reasonTree)).toMatch(/image_ref_has_no_tag/);
    expect(JSON.stringify(decision?.reasonTree)).toMatch(/digest identifies bytes, not a release/);
  });

  it("records NOTHING for a language line when no manifest reader is wired, and says so", async () => {
    const producer = await createOrphanComponent(admin, `no-reader-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "npm", coordinate: "@acme/no-reader", major: "1" },
      producer.id
    );
    await inOrg((tx) =>
      upsertComponentDependency(tx, org.orgId, {
        componentObjectId: producer.id,
        lineId,
        manifestPath: "package.json",
        declaredVersion: "^1.0.0"
      })
    );
    const change = await releaseTo(producer.id, prodTarget, {
      sourceRef: { repo: "acme/api", ref: "refs/heads/main", commit: "abc123" }
    });

    // No reader passed — the honest shape of the unbuilt plugin-host route, rather than a
    // never-detects-anything that reads like "no releases happened".
    const outcome = await detect(change);
    expect(outcome.skipped[0]?.reason).toBe("manifest_reader_unavailable");
    expect((await headOf(lineId))?.latestVersion).toBeNull();
  });

  // -----------------------------------------------------------------------------------------
  // Write amplification — the reason every verdict goes through insertDecisionIfChanged
  // -----------------------------------------------------------------------------------------

  it("appends NO second Decision when the same accept is delivered twice", async () => {
    const producer = await createOrphanComponent(admin, `redelivery-${uuidv7()}`);
    await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/redeliver", major: "1" },
      producer.id
    );
    const change = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/redeliver:1.0.0@sha256:aa"]
    });

    const first = await detect(change);
    const second = await detect(change);

    expect(first.decision?.created).toBe(true);
    // pg-boss delivery is AT-LEAST-ONCE, so this is the ordinary case, not an edge one.
    expect(second.decision?.created, "a byte-identical restatement is suppressed").toBe(false);
    expect(second.decision?.id).toBe(first.decision?.id);

    const rows = await inOrg((tx) =>
      tx
        .select({ id: decisions.id })
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, change),
            eq(decisions.kind, INTERNAL_RELEASE_DECISION_KIND)
          )
        )
    );
    expect(rows).toHaveLength(1);
  });

  it("is not applicable to a change that is not accepted", async () => {
    const producer = await createOrphanComponent(admin, `unaccepted-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "oci", coordinate: "ghcr.io/acme/unaccepted", major: "1" },
      producer.id
    );
    const change = await releaseTo(producer.id, prodTarget, {
      observedImages: ["ghcr.io/acme/unaccepted:1.0.0"],
      accepted: false
    });

    const outcome = await detect(change);
    expect(outcome.verdict).toBe("not_applicable");
    expect(outcome.detail).toMatch(/executing/);
    expect((await headOf(lineId))?.latestVersion).toBeNull();
  });

  // -----------------------------------------------------------------------------------------
  // THE MANIFEST FETCH HOLDS NO DATABASE CONNECTION (M21.4 MINOR C)
  // -----------------------------------------------------------------------------------------

  it("does its manifest reads OUTSIDE any transaction — a one-connection pool still serves the reader", async () => {
    const producer = await createOrphanComponent(admin, `outside-tx-${uuidv7()}`);
    const lineId = await lineProducedBy(
      { ecosystem: "npm", coordinate: "@acme/outside-tx", major: "4" },
      producer.id
    );
    await inOrg((tx) =>
      upsertComponentDependency(tx, org.orgId, {
        componentObjectId: producer.id,
        lineId,
        manifestPath: "package.json",
        declaredVersion: "^1.0.0"
      })
    );
    const change = await releaseTo(producer.id, prodTarget, {
      sourceRef: { repo: "acme/outside-tx", ref: "refs/heads/main", commit: "beef01" }
    });

    /**
     * A POOL OF EXACTLY ONE CONNECTION IS THE WHOLE EXPERIMENT.
     *
     * The reader below needs a connection of its own. If the derivation were still holding a
     * transaction open across the fetch — which is what it did, and is why a registry or a git
     * provider taking 15s pinned an RLS-scoped pooled connection for the whole call against a 5s
     * production `statement_timeout` — there would be none left, and `connectionTimeoutMillis`
     * turns that into a fast, legible failure instead of a hang. With the reads moved out, the one
     * connection is free and the read succeeds.
     *
     * This is the production hazard in miniature rather than an analogy for it: a bounded pool plus
     * a held connection is exactly the shape, and the third-party poll already does the opposite
     * ("the network call happens OUTSIDE any transaction").
     */
    const singleConnectionPool = new pg.Pool({
      connectionString: server.deps.config.runtimeDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: 3_000
    });
    try {
      const singleConnectionDb = createDb(singleConnectionPool);
      const readerSawConnection: boolean[] = [];
      const outcome = await detectInternalReleases(singleConnectionDb, org.orgId, {
        changeObjectId: change,
        readManifest: async (request): Promise<ReadFileAtRefResult> => {
          // The real reader's FIRST act is exactly this: `manifest-reader.ts` opens a tenant
          // transaction to find the git binding for the repo. So this is the production shape, not
          // a probe invented for the test.
          await withTenantTx(singleConnectionDb, org.orgId, (tx) =>
            tx.select({ id: objects.id }).from(objects).limit(1)
          );
          readerSawConnection.push(true);
          const body = JSON.stringify({ name: "@acme/outside-tx", version: "4.2.0" });
          return {
            outcome: "found",
            path: request.path,
            requestedRef: request.ref,
            commitSha: request.ref,
            content: body,
            sizeBytes: Buffer.byteLength(body)
          };
        }
      });

      expect(readerSawConnection, "the reader got a connection of its own").toEqual([true]);
      expect(outcome.recorded[0]).toMatchObject({ version: "4.2.0", signal: "producer_manifest" });
      // And the WRITE still landed, on the same one-connection pool — the phases are separate
      // transactions, not a transaction that was simply dropped.
      expect((await headOf(lineId))?.latestVersion).toBe("4.2.0");
    } finally {
      await singleConnectionPool.end();
    }
  }, 60_000);

  // -----------------------------------------------------------------------------------------
  // THE WIRING (M21.4 BLOCKER A + BLOCKER B)
  // -----------------------------------------------------------------------------------------

  /**
   * EVERY TEST ABOVE CALLS `detectInternalReleases` DIRECTLY, AND NOTHING IN PRODUCTION DID.
   *
   * That is the gap this block closes, and it is worth stating why the rest of the file could not
   * catch it: a suite that drives a function directly proves the function, and says nothing about
   * whether anything ever calls it. Measured filterlessly before this: the only references to
   * `detectInternalReleases` in the tree were its own definition and this file, and
   * `scp.change.transitioned` had ZERO server-side consumers — `DOMAIN_EVENTS_QUEUE`'s handler only
   * logged. The whole internal ingress was dead code behind a green suite.
   *
   * So this drives the REAL PATH, from the shape the outbox relay actually puts on the domain-event
   * queue:
   *
   *   domain-events job → acceptedChangeRouter → dependency-internal-release queue → the loop's
   *   worker → detectInternalReleases → the manifest read through `host.gitFileRead` → the head.
   *
   * It is also the only test that exercises M21.2's `readFileAtRef` through the plugin-host client
   * M21.4 added: the reader is no longer a parameter a test supplies, it is resolved from the
   * released repo's OWN git binding by `manifest-reader.ts`.
   */
  describe("the production path: a domain event reaches detection (BLOCKER A/B)", () => {
    let boss: Awaited<ReturnType<typeof startPgBoss>> | undefined;
    let loop: InternalReleaseLoopHandle | undefined;
    const fileReads: { instanceId: string; request: ReadFileAtRefRequest }[] = [];
    const packageJsonBody = JSON.stringify({ name: "@acme/wired", version: "3.1.0" });

    /** A host that answers the file read and records WHICH INSTANCE was asked — the instance id is
     *  the proof the binding, not a guess, chose the credential. */
    function recordingHost(): PluginHost {
      const notWired = (): never => {
        throw new Error("this fixture only wires gitFileRead()");
      };
      return {
        async start() {},
        async stop() {},
        async stopInstances() {},
        executor: notWired,
        control: notWired,
        discovery: notWired,
        notification: notWired,
        federationTransport: notWired,
        dependencyIndex: notWired,
        gitFileRead(instanceId: string): GitFileReadPluginClient {
          return {
            readFileAtRef: async (request): Promise<ReadFileAtRefResult> => {
              fileReads.push({ instanceId, request });
              return {
                outcome: "found",
                path: request.path,
                requestedRef: request.ref,
                commitSha: request.ref,
                content: packageJsonBody,
                sizeBytes: Buffer.byteLength(packageJsonBody)
              };
            }
          };
        }
      };
    }

    beforeAll(async () => {
      // The router is registered WITH pg-boss, because `boss.work()` is a competing consumer and a
      // second worker on `domain-events` would steal half the events rather than add a listener.
      boss = await startPgBoss(server.deps.config.pgBossDatabaseUrl, [acceptedChangeRouter()]);
      loop = await startInternalReleaseLoop(boss, {
        db: server.deps.db,
        host: recordingHost(),
        // THE POSTURE THE LOOP REQUIRES, STATED BY THE FIXTURE (ADR-0032 §7d). Internal detection is
        // commander-only and FAIL-CLOSED on an undeclared `SCP_FEDERATION_ROLE`; the harness leaves
        // that env var unset, so `server.deps.config` alone is a DEFAULTED (undeclared) commander
        // and this loop would hand back an inert handle without ever creating its queue.
        config: {
          ...server.deps.config,
          role: "all" as const,
          federationRole: "commander" as const,
          federationRoleDeclared: true
        }
      });
    }, 60_000);

    afterAll(async () => {
      await loop?.stop();
      await boss?.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
    });

    /** The exact payload `events/outbox-relay.ts` sends for a change transition. */
    async function deliverTransition(changeObjectId: string, toState: string): Promise<void> {
      await boss!.send(DOMAIN_EVENTS_QUEUE, {
        id: uuidv7(),
        orgId: org.orgId,
        type: "scp.change.transitioned",
        source: `/changes/${changeObjectId}`,
        subject: changeObjectId,
        data: { fromState: "validating", toState, trigger: null }
      });
    }

    it("an accepted change delivered on the domain-event queue records the head, reading the manifest through the plugin host", async () => {
      const producer = await createOrphanComponent(admin, `wired-producer-${uuidv7()}`);
      const lineId = await lineProducedBy(
        { ecosystem: "npm", coordinate: "@acme/wired", major: "3" },
        producer.id
      );
      await inOrg((tx) =>
        upsertComponentDependency(tx, org.orgId, {
          componentObjectId: producer.id,
          lineId,
          manifestPath: "package.json",
          declaredVersion: "^1.0.0"
        })
      );
      // THE BINDING IS WHAT CHOOSES THE CREDENTIAL. `manifest-reader.ts` matches the released repo
      // against each git-provider binding's own configured repo identity; without this row the read
      // is refused rather than attempted with some other binding's token.
      const instanceId = `gh-wired-${uuidv7()}`;
      await inOrg((tx) =>
        upsertExecutorBinding(tx, {
          orgId: org.orgId,
          targetObjectId: producer.id,
          pluginModule: "github",
          pluginInstanceId: instanceId,
          config: { appId: "1", installationId: "2", owner: "acme", repo: "wired" }
        })
      );
      const change = await releaseTo(producer.id, prodTarget, {
        sourceRef: { repo: "acme/wired", ref: "refs/heads/main", commit: "c0ffee" }
      });

      await deliverTransition(change, "accepted");

      const line = await waitUntil(
        async () => {
          const row = await headOf(lineId);
          return row?.latestVersion ? row : undefined;
        },
        {
          describe: "the internal-release loop to record this line's head from a domain event",
          timeoutMs: 30_000,
          intervalMs: 200
        }
      );
      expect(line?.latestVersion).toBe("3.1.0");

      // AND IT WENT THROUGH THE PLUGIN-HOST FILE-READ CLIENT, at the released commit, on the
      // instance the repo's own binding names.
      const read = fileReads.find((r) => r.request.repo === "acme/wired");
      expect(read, "the manifest was read through host.gitFileRead").toBeDefined();
      expect(read?.instanceId).toBe(instanceId);
      expect(read?.request).toEqual({ repo: "acme/wired", path: "package.json", ref: "c0ffee" });
    }, 60_000);

    it("REDELIVERY writes nothing new — the same accept delivered twice leaves ONE Decision", async () => {
      const producer = await createOrphanComponent(admin, `wired-redeliver-${uuidv7()}`);
      const lineId = await lineProducedBy(
        { ecosystem: "oci", coordinate: "ghcr.io/acme/wired-redeliver", major: "1" },
        producer.id
      );
      const change = await releaseTo(producer.id, prodTarget, {
        observedImages: ["ghcr.io/acme/wired-redeliver:1.4.0@sha256:beef"]
      });

      await deliverTransition(change, "accepted");
      await waitUntil(async () => (await headOf(lineId))?.latestVersion === "1.4.0", {
        describe: "the first delivery to record the head",
        timeoutMs: 30_000,
        intervalMs: 200
      });
      const countDecisions = () =>
        inOrg((tx) =>
          tx
            .select({ id: decisions.id })
            .from(decisions)
            .where(
              and(
                eq(decisions.orgId, org.orgId),
                eq(decisions.subjectId, change),
                eq(decisions.kind, INTERNAL_RELEASE_DECISION_KIND)
              )
            )
        );
      expect(await countDecisions()).toHaveLength(1);

      // The outbox → pg-boss path is AT-LEAST-ONCE and there are now two hops, so this is the
      // ordinary case rather than an edge one.
      await deliverTransition(change, "accepted");
      // Give the second delivery a real chance to append before asserting it did not: an assertion
      // taken immediately would pass against a job that simply had not run yet.
      await waitUntil(
        async () =>
          (await inOrg((tx) => getDependencyLineById(tx, org.orgId, lineId)))?.latestVersion ===
          "1.4.0",
        { describe: "the redelivery to be processed", timeoutMs: 5_000, intervalMs: 200 }
      ).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(
        await countDecisions(),
        "a byte-identical restatement is suppressed by insertDecisionIfChanged"
      ).toHaveLength(1);
    }, 60_000);

    it("a transition to any OTHER state is not routed at all", async () => {
      const producer = await createOrphanComponent(admin, `wired-unaccepted-${uuidv7()}`);
      const lineId = await lineProducedBy(
        { ecosystem: "oci", coordinate: "ghcr.io/acme/wired-executing", major: "1" },
        producer.id
      );
      const change = await releaseTo(producer.id, prodTarget, {
        observedImages: ["ghcr.io/acme/wired-executing:1.0.0"]
      });

      // The change IS accepted in the database — so if this were routed, the head WOULD be
      // recorded. What must stop it is the router's predicate, not the derivation's own re-read.
      await deliverTransition(change, "executing");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect((await headOf(lineId))?.latestVersion).toBeNull();
    }, 60_000);
  });
});
