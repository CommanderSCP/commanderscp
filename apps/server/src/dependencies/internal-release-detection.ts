import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DependencyEcosystem } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { changePlans, changeWaveTargets, changeWaves, changes, objects } from "../db/schema.js";
import { dependencyLines } from "../db/schema.js";
import { insertDecisionIfChanged } from "../coordination/decisions-repo.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import {
  listComponentDependencies,
  listComponentsDeclaringLine,
  listDependencyLineProducersForComponents,
  recordDependencyLineHead
} from "./dependency-inventory-repo.js";
import type { HeadRefusalReason } from "./line-head.js";
import { listSubscribedComponentLines } from "./subscription-resolution.js";
import {
  resolveReleasedVersion,
  type ManifestReader,
  type ReleasedVersion,
  type ReleaseVersionSignal,
  type ReleaseVersionUnknownReason
} from "./internal-release-version.js";

/** M21.4 — INTERNAL DETECTION. See docs/dependencies.md §228. */

/** The Decision `kind` this module writes. One kind, one subject (the change), one row per run. */
export const INTERNAL_RELEASE_DECISION_KIND = "dependency_internal_release";

/** The `deployment-target.properties.environment` value that means production. The same convention
 *  `regional-executors.ts` reads; there is no `environments` table to look it up in. */
export const PROD_ENVIRONMENT = "prod";

export interface RecordedInternalRelease {
  readonly lineId: string;
  readonly ecosystem: DependencyEcosystem;
  readonly coordinate: string;
  readonly major: string;
  readonly producerComponentObjectId: string;
  /** WHERE this was released — every prod deployment-target that agreed on this version, sorted.
   *  A version is a claim about a release, and a release happens at places. */
  readonly deploymentTargetObjectIds: readonly string[];
  readonly version: string;
  readonly digest: string | null;
  readonly signal: ReleaseVersionSignal;
  readonly why: string;
}

/** One produced line this run deliberately did NOT record, and why. Every one of these is a fact
 *  about the release, not an error — `latest_version` staying null means "not yet observed", which
 *  ADR-0032's schema defines as explicitly NOT "no newer version exists". */
export interface SkippedInternalRelease {
  readonly lineId: string;
  readonly ecosystem: DependencyEcosystem;
  readonly coordinate: string;
  readonly major: string;
  readonly producerComponentObjectId: string;
  /** The prod deployment-target(s) this refusal is about, sorted — one for a place that said
   *  nothing, all of them for a disagreement between places. */
  readonly deploymentTargetObjectIds: readonly string[];
  readonly reason:
    | ReleaseVersionUnknownReason
    | "rollback_is_not_a_release"
    | "no_subscriber"
    /**
     * The component is placed in MORE THAN ONE prod deployment-target and the versions observed
     * there DISAGREE. Nothing is recorded and the disagreement is named.
     *
     * Refusing is the whole point: the previous behaviour picked a winner by wave-target UUID order,
     * which is arbitrary and could be the OLDER of the two, and then reported "0 not recorded" while
     * the Decision asserted two contradictory versions for one line. A line has ONE head; two places
     * running different versions means the org does not have a single answer to "what is on this
     * line", and inventing one is the wrong-version failure ADR-0032 §7 exists to prevent.
     */
    | "ambiguous_prod_releases"
    /** The write door refused to move the head — see `line-head.ts`'s `HeadRefusalReason`. These
     *  are the SAME names the third-party poll reports, because it is the same door. */
    | HeadRefusalReason;
  readonly detail: string;
}

export type InternalReleaseVerdict =
  /** The change was not in a state this derivation applies to at all — nothing was examined and no
   *  Decision was written. */
  | "not_applicable"
  /** The derivation ran and found no produced line to say anything about. No Decision. */
  | "no_declared_producer"
  /** The derivation ran over at least one produced line. A Decision exists. */
  | "evaluated";

export interface InternalReleaseOutcome {
  readonly changeObjectId: string;
  readonly verdict: InternalReleaseVerdict;
  readonly detail: string;
  readonly recorded: readonly RecordedInternalRelease[];
  readonly skipped: readonly SkippedInternalRelease[];
  /** Present exactly when `verdict === "evaluated"`. `created` is false when this run restated a
   *  verdict already on the record — an at-least-once redelivery of the same accept. */
  readonly decision?: { readonly id: string; readonly created: boolean };
}

export interface DetectInternalReleasesInput {
  readonly changeObjectId: string;
  /** Absent when no `readFileAtRef` route is wired — see {@link ManifestReader}. Language
   *  ecosystems then record nothing, with `manifest_reader_unavailable` as the stated reason. */
  readonly readManifest?: ManifestReader | undefined;
}

/** A prod placement this change actually rolled: which component, at which place, with whatever the
 *  executor observed there. */
interface ProdRelease {
  readonly componentObjectId: string;
  readonly deploymentTargetObjectId: string;
  readonly observedImages: string[];
}

/** One produced line, with every place it was released. See docs/dependencies.md §229. */
interface ProducedLineGroup {
  readonly line: {
    readonly id: string;
    readonly ecosystem: DependencyEcosystem;
    readonly coordinate: string;
    readonly major: string;
  };
  /** Sorted by deployment-target id — a stable order is what keeps the Decision comparable across
   *  an at-least-once redelivery. */
  readonly releases: readonly ProdRelease[];
}

/** One line the derivation still has a question to ask about, carried between the phases below. */
interface PendingLine {
  readonly group: ProducedLineGroup;
  readonly identity: Omit<SkippedInternalRelease, "reason" | "detail">;
  /** The producing component's already-recorded manifest paths (M21.2 inventory). Read in phase 1
   *  so phase 2 needs no database at all. */
  readonly manifestPaths: readonly string[];
  /** Everything this line did NOT record, in the order it was decided. Kept per line so the
   *  assembled result stays in line order even though the phases interleave. */
  readonly skipped: SkippedInternalRelease[];
  /** Set by phase 2 when exactly one claim survived. */
  agreed?: Extract<ReleasedVersion, { determined: true }>;
}

/** Run the derivation for ONE accepted change. See docs/dependencies.md §230. */
export async function detectInternalReleases(
  db: Db,
  orgId: string,
  input: DetectInternalReleasesInput
): Promise<InternalReleaseOutcome> {
  // PHASE 1 — everything the derivation can learn from this domain's own records.
  const prepared = await withTenantTx(db, orgId, async (tx) => {
    const [change] = await tx
      .select({
        objectId: changes.objectId,
        state: changes.state,
        rollbackOfObjectId: changes.rollbackOfObjectId,
        sourceRef: changes.sourceRef
      })
      .from(changes)
      .where(and(eq(changes.orgId, orgId), eq(changes.objectId, input.changeObjectId)))
      .limit(1);

    if (!change) {
      return {
        phase: "halt",
        outcome: notApplicable(
          input.changeObjectId,
          "no change row for this id in this org — nothing to derive from"
        )
      } as const;
    }
    if (change.state !== "accepted") {
      // Re-read rather than trusted from the event. `scp.change.transitioned` is delivered
      // at-least-once and out of band, so by the time a handler runs the change may have moved on;
      // acting on the event's `toState` alone would derive a release from a state that no longer
      // holds.
      return {
        phase: "halt",
        outcome: notApplicable(
          input.changeObjectId,
          `change is in state '${change.state}', not 'accepted' — this derivation applies to an accepted change only`
        )
      } as const;
    }

    const isRollback = change.rollbackOfObjectId !== null;
    const prodReleases = await resolveProdReleases(tx, orgId, input.changeObjectId);
    const producedLines = await listProducedLines(tx, orgId, prodReleases);

    if (producedLines.length === 0) {
      // NO DECISION. This is the overwhelmingly common case — a change that releases a component
      // nobody has declared to be the producer of any dependency line — and a row per accept saying
      // so is write amplification with nothing to learn from row 2 onward.
      const outcome: InternalReleaseOutcome = {
        changeObjectId: input.changeObjectId,
        verdict: "no_declared_producer",
        detail:
          prodReleases.length === 0
            ? "no succeeded wave target of this change resolved to a component placed in a 'prod' deployment-target"
            : "the components this change released to prod are the declared producer of no dependency line",
        recorded: [],
        skipped: []
      };
      return { phase: "halt", outcome } as const;
    }

    const pending: PendingLine[] = [];
    /** Manifest paths per component, fetched at most once each. */
    const manifestPathsByComponent = new Map<string, readonly string[]>();

    for (const group of producedLines) {
      const { line, releases } = group;
      // The producer is the component named by the placements this line came from — one component
      // per group, because the group is keyed on the line and a line has ONE declared producer.
      const producerComponentObjectId = releases[0]?.componentObjectId as string;
      const identity = {
        lineId: line.id,
        ecosystem: line.ecosystem,
        coordinate: line.coordinate,
        major: line.major,
        producerComponentObjectId,
        deploymentTargetObjectIds: releases.map((r) => r.deploymentTargetObjectId)
      } as const;

      if (isRollback) {
        // THE LOAD-BEARING EXCLUSION. Reached only because this change DOES produce a line — which
        // is exactly the case where recording it would publish a withdrawn version to real
        // subscribers.
        pending.push({
          group,
          identity,
          manifestPaths: [],
          skipped: [
            {
              ...identity,
              reason: "rollback_is_not_a_release",
              detail: `change ${input.changeObjectId} is a rollback of ${change.rollbackOfObjectId} (changes.rollback_of_object_id) and auto-accepted — restoring known-good state publishes nothing`
            }
          ]
        });
        continue;
      }

      const subscribed = await lineHasSubscriber(tx, orgId, line.id);
      if (!subscribed) {
        pending.push({
          group,
          identity,
          manifestPaths: [],
          skipped: [
            {
              ...identity,
              reason: "no_subscriber",
              detail:
                "no enabled component subscribes to this line (derived from M21.3's " +
                "listSubscribedComponentLines), so nothing is fetched and no head is recorded"
            }
          ]
        });
        continue;
      }

      let manifestPaths = manifestPathsByComponent.get(producerComponentObjectId);
      if (manifestPaths === undefined) {
        manifestPaths = (await listComponentDependencies(tx, orgId, producerComponentObjectId)).map(
          (row) => row.manifestPath
        );
        manifestPathsByComponent.set(producerComponentObjectId, manifestPaths);
      }
      pending.push({ group, identity, manifestPaths, skipped: [] });
    }

    return {
      phase: "run",
      change,
      isRollback,
      prodReleases,
      producedLines,
      pending,
      sourceRef: canonicalSourceRef(change.sourceRef)
    } as const;
  });

  if (prepared.phase === "halt") return prepared.outcome;
  const { change, isRollback, prodReleases, producedLines, pending, sourceRef } = prepared;

  // PHASE 2 — NO TRANSACTION IS OPEN HERE. See docs/dependencies.md §231.
  for (const item of pending) {
    if (item.skipped.length > 0) continue; // already refused in phase 1 (rollback / no subscriber)
    const { line, releases } = item.group;

    // EVERY PLACE IS ASKED, and each answer is kept with the place it came from. A component in two
    // prod regions was released twice and both targets' observed images are evidence about the same
    // release — but they are two statements, and whether they AGREE is the question below.
    const answers: { place: string; resolved: ReleasedVersion }[] = [];
    for (const release of releases) {
      answers.push({
        place: release.deploymentTargetObjectId,
        resolved: await resolveReleasedVersion({
          line: { ecosystem: line.ecosystem, coordinate: line.coordinate },
          sourceRef,
          observedImages: release.observedImages,
          manifestPaths: [...item.manifestPaths],
          ...(input.readManifest !== undefined ? { readManifest: input.readManifest } : {})
        })
      });
    }

    // A place that determined nothing is reported as its own refusal, naming that place. It does not
    // veto a version another place DID state — "this region's executor reported no images" and
    // "the regions disagree" are different facts and must not collapse into one.
    for (const answer of answers) {
      if (!answer.resolved.determined) {
        item.skipped.push({
          ...item.identity,
          deploymentTargetObjectIds: [answer.place],
          reason: answer.resolved.reason,
          detail: answer.resolved.detail
        });
      }
    }

    const determined = answers.filter(
      (a): a is { place: string; resolved: Extract<ReleasedVersion, { determined: true }> } =>
        a.resolved.determined
    );
    if (determined.length === 0) continue;

    // THE AMBIGUITY REFUSAL. The claim is the PAIR (version, digest) — a mutable tag is not an
    // identity (ADR-0032 §7) — so two places on the same tag pointing at different bytes disagree
    // just as loudly as two different tags do, and neither is this line's head.
    const distinctClaims = [
      ...new Set(determined.map((d) => `${d.resolved.version}@${d.resolved.digest ?? ""}`))
    ];
    if (distinctClaims.length > 1) {
      item.skipped.push({
        ...item.identity,
        deploymentTargetObjectIds: [...determined.map((d) => d.place)].sort(),
        reason: "ambiguous_prod_releases",
        detail:
          `this component is placed in ${determined.length} prod deployment-targets and they do ` +
          `not agree on what was released (` +
          determined
            .map(
              (d) =>
                `${d.place}=${d.resolved.version}${d.resolved.digest ? `@${d.resolved.digest}` : ""}`
            )
            .sort()
            .join(", ") +
          `) — a line has ONE head, so picking one of them would be a guess about which place is ` +
          `the org's answer`
      });
      continue;
    }

    item.agreed = (
      determined[0] as { place: string; resolved: Extract<ReleasedVersion, { determined: true }> }
    ).resolved;
  }

  // PHASE 3 — the writes, back inside a transaction.
  return withTenantTx(db, orgId, async (tx) => {
    const recorded: RecordedInternalRelease[] = [];
    for (const item of pending) {
      if (!item.agreed) continue;
      // THE WRITE DOOR DECIDES whether this becomes the head. See docs/dependencies.md §232.
      const head = await recordDependencyLineHead(
        tx,
        orgId,
        {
          lineId: item.group.line.id,
          latestVersion: item.agreed.version,
          latestDigest: item.agreed.digest
        },
        { kind: "internal", producerObjectId: item.identity.producerComponentObjectId }
      );
      if (!head.recorded) {
        item.skipped.push({ ...item.identity, reason: head.reason, detail: head.detail });
        continue;
      }
      recorded.push({
        ...item.identity,
        version: item.agreed.version,
        digest: item.agreed.digest,
        signal: item.agreed.signal,
        why: item.agreed.why
      });
    }
    // Assembled in LINE order, each line's own refusals in the order they were decided — the same
    // sequence the single-pass version produced, so the phase split is invisible to a caller.
    const skipped = pending.flatMap((item) => item.skipped);

    const decision = await insertDecisionIfChanged(tx, {
      orgId,
      kind: INTERNAL_RELEASE_DECISION_KIND,
      subjectId: input.changeObjectId,
      // This path never blocks anything — it observes. `allow` is the neutral verdict of the
      // vocabulary already in `decisions.verdict`; what happened is in the reason tree.
      verdict: "allow",
      // STABLE FACTS ONLY, SORTED. Anything that varies between two derivations of the SAME accept —
      // a timestamp, a map iteration order — would defeat `insertDecisionIfChanged` and restore the
      // per-delivery write it exists to prevent.
      inputContext: {
        changeObjectId: input.changeObjectId,
        isRollback,
        rollbackOfObjectId: change.rollbackOfObjectId,
        sourceRef,
        prodPlacements: prodReleases
          .map((r) => ({
            componentObjectId: r.componentObjectId,
            deploymentTargetObjectId: r.deploymentTargetObjectId,
            observedImages: [...r.observedImages].sort()
          }))
          .sort((a, b) =>
            `${a.componentObjectId}${a.deploymentTargetObjectId}` <
            `${b.componentObjectId}${b.deploymentTargetObjectId}`
              ? -1
              : 1
          ),
        producedLineIds: producedLines.map((p) => p.line.id).sort()
      },
      reasonTree: {
        rule: "ADR-0032 §7 internal detection — an accepted, non-rollback change whose component is placed in a 'prod' deployment-target releases the lines it is DECLARED to produce",
        recorded: [...recorded].sort((a, b) => (a.lineId < b.lineId ? -1 : 1)),
        skipped: [...skipped].sort((a, b) => (a.lineId < b.lineId ? -1 : 1))
      }
    });

    return {
      changeObjectId: input.changeObjectId,
      verdict: "evaluated" as const,
      detail: `${recorded.length} line head(s) recorded, ${skipped.length} not recorded`,
      recorded,
      skipped,
      decision: { id: decision.decision.id, created: decision.created }
    };
  });
}

function notApplicable(changeObjectId: string, detail: string): InternalReleaseOutcome {
  return { changeObjectId, verdict: "not_applicable", detail, recorded: [], skipped: [] };
}

/** `changes.source_ref`'s canonical keys, defensively. See docs/dependencies.md §233. */
function canonicalSourceRef(raw: unknown): {
  repo?: string;
  ref?: string;
  commit?: string;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof src[key] === "string" && src[key].trim() !== ""
      ? (src[key] as string).trim()
      : undefined;
  const repo = pick("repo");
  const ref = pick("ref");
  const commit = pick("commit");
  return {
    ...(repo !== undefined ? { repo } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(commit !== undefined ? { commit } : {})
  };
}

/** The succeeded wave targets, resolved to their pairs. See docs/dependencies.md §234. */
async function resolveProdReleases(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<ProdRelease[]> {
  const targetRows = await tx
    .select({
      targetObjectId: changeWaveTargets.targetObjectId,
      observed: changeWaveTargets.observedState
    })
    .from(changeWaveTargets)
    .innerJoin(
      changeWaves,
      and(
        eq(changeWaves.id, changeWaveTargets.waveId),
        eq(changeWaves.orgId, changeWaveTargets.orgId)
      )
    )
    .innerJoin(
      changePlans,
      and(eq(changePlans.id, changeWaves.planId), eq(changePlans.orgId, changeWaves.orgId))
    )
    .where(
      and(
        eq(changeWaveTargets.orgId, orgId),
        eq(changePlans.changeObjectId, changeObjectId),
        eq(changeWaveTargets.status, "succeeded")
      )
    )
    .orderBy(changeWaveTargets.targetObjectId);
  if (targetRows.length === 0) return [];

  const targetObjectIds = [...new Set(targetRows.map((r) => r.targetObjectId))];
  const targetObjects = await tx
    .select({ id: objects.id, typeId: objects.typeId, properties: objects.properties })
    .from(objects)
    .where(
      and(eq(objects.orgId, orgId), inArray(objects.id, targetObjectIds), isNull(objects.deletedAt))
    );

  const placementById = new Map<string, { componentId: string; deploymentTargetId: string }>();
  for (const row of targetObjects) {
    if (row.typeId !== "placement") continue;
    const props = row.properties as { componentId?: unknown; deploymentTargetId?: unknown };
    if (typeof props.componentId !== "string" || typeof props.deploymentTargetId !== "string") {
      continue;
    }
    placementById.set(row.id, {
      componentId: props.componentId,
      deploymentTargetId: props.deploymentTargetId
    });
  }
  if (placementById.size === 0) return [];

  // 'prod' is a PROPERTY of a deployment-target, matched exactly, the same way
  // `regional-executors.ts:94` matches an environment. Trimmed because that module trims too (:196-214)
  // and a target labelled `"prod "` is the same place; NOT lowercased, because nothing else in the
  // estate case-folds this property and a fold here would silently widen what counts as production.
  const placeIds = [...new Set([...placementById.values()].map((p) => p.deploymentTargetId))];
  const prodPlaceRows = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        inArray(objects.id, placeIds),
        eq(objects.typeId, "deployment-target"),
        isNull(objects.deletedAt),
        sql`btrim(${objects.properties} ->> 'environment') = ${PROD_ENVIRONMENT}`
      )
    );
  const prodPlaceIds = new Set(prodPlaceRows.map((r) => r.id));

  // One entry per (component, place): a component placed in two prod regions was released twice and
  // both targets' observed images are evidence about the same release.
  const byPair = new Map<string, ProdRelease>();
  for (const row of targetRows) {
    const placement = placementById.get(row.targetObjectId);
    if (!placement || !prodPlaceIds.has(placement.deploymentTargetId)) continue;
    const key = `${placement.componentId}::${placement.deploymentTargetId}`;
    let entry = byPair.get(key);
    if (!entry) {
      entry = {
        componentObjectId: placement.componentId,
        deploymentTargetObjectId: placement.deploymentTargetId,
        observedImages: []
      };
      byPair.set(key, entry);
    }
    for (const image of observedImagesOf(row.observed)) {
      if (!entry.observedImages.includes(image)) entry.observedImages.push(image);
    }
  }
  return [...byPair.values()];
}

/** `change_wave_targets.observed_state`'s `images` array. See docs/dependencies.md §235. */
export function observedImagesOf(observed: unknown): string[] {
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) return [];
  const images = (observed as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  return images
    .filter((i): i is string => typeof i === "string" && i.trim() !== "")
    .map((i) => i.trim());
}

/** The lines each released component is the producer of. See docs/dependencies.md §236. */
async function listProducedLines(
  tx: TenantTx,
  orgId: string,
  releases: readonly ProdRelease[]
): Promise<ProducedLineGroup[]> {
  const componentObjectIds = [...new Set(releases.map((r) => r.componentObjectId))];
  if (componentObjectIds.length === 0) return [];

  const declarations = await listDependencyLineProducersForComponents(
    tx,
    orgId,
    componentObjectIds
  );
  if (declarations.length === 0) return [];

  // MATCHED AS A PAIR, deliberately. The coordinate is compared VERBATIM and carries no ecosystem
  // in itself, so narrowing on `coordinate IN (...)` alone would let an `npm` declaration claim an
  // `oci` line that happens to spell the same string.
  const rows = await tx
    .select({
      id: dependencyLines.id,
      ecosystem: dependencyLines.ecosystem,
      coordinate: dependencyLines.coordinate,
      major: dependencyLines.major
    })
    .from(dependencyLines)
    .where(
      and(
        eq(dependencyLines.orgId, orgId),
        or(
          ...declarations.map((d) =>
            and(
              eq(dependencyLines.ecosystem, d.ecosystem),
              eq(dependencyLines.coordinate, d.coordinate)
            )
          )
        )
      )
    )
    .orderBy(dependencyLines.id);

  // ` ` as the joiner, not a space or a colon: an ecosystem is one of five literals and a
  // coordinate is arbitrary user bytes, so any separator that can appear IN a coordinate could make
  // two different pairs share a key.
  const keyOf = (ecosystem: string, coordinate: string) => `${ecosystem} ${coordinate}`;
  const producerOf = new Map(
    declarations.map((d) => [keyOf(d.ecosystem, d.coordinate), d.producerObjectId])
  );

  const out: ProducedLineGroup[] = [];
  for (const row of rows) {
    const producerObjectId = producerOf.get(keyOf(row.ecosystem, row.coordinate));
    if (producerObjectId === undefined) continue;
    // ONE GROUP PER LINE, carrying every place that released it — never one entry per (line, place).
    // A line has one head, so the places are evidence to be weighed together; a flat pair list made
    // each place write the head in turn and let the last one, ordered by UUID, win.
    const forThisLine = releases
      .filter((release) => release.componentObjectId === producerObjectId)
      .sort((a, b) => (a.deploymentTargetObjectId < b.deploymentTargetObjectId ? -1 : 1));
    if (forThisLine.length === 0) continue;
    out.push({
      line: {
        id: row.id,
        // The column is plain `text` with no CHECK. See docs/dependencies.md §237.
        ecosystem: row.ecosystem as DependencyEcosystem,
        coordinate: row.coordinate,
        major: row.major
      },
      releases: forThisLine
    });
  }
  return out;
}

/** Is ANY enabled component subscribed to this line? See docs/dependencies.md §238. */
async function lineHasSubscriber(tx: TenantTx, orgId: string, lineId: string): Promise<boolean> {
  const declaring = await listComponentsDeclaringLine(tx, orgId, lineId);
  const componentObjectIds = [...new Set(declaring.map((d) => d.componentObjectId))];
  if (componentObjectIds.length === 0) return false;
  const subscribed = await listSubscribedComponentLines(tx, orgId, {
    actorObjectId: SYSTEM_ACTOR_ID,
    componentObjectIds
  });
  return subscribed.some((s) => s.lineId === lineId);
}
