import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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

/**
 * M21.4 — INTERNAL DETECTION: "an internal dependency was released to production" (ADR-0032 §7).
 *
 * ============================================================================================
 * THERE IS NO EVENT FOR THIS. IT IS DERIVED. (measured at HEAD)
 * ============================================================================================
 * ADR-0032 §7 calls internal detection "derived, because no event carries it", and that is literal:
 *
 *   - the ONLY change event is `scp.change.transitioned`, whose payload is `{fromState, toState,
 *     trigger}` over a subject that is the change object id (`coordination/transition.ts:361-368`).
 *     No component, no target, no environment, no version.
 *   - per-place success is `change_wave_targets.status = 'succeeded'` — a plain UPDATE. No event,
 *     no audit row, nothing to subscribe to.
 *   - "prod" is not a table. It is `deployment-target.properties.environment`, the same convention
 *     `coordination/regional-executors.ts:94,196-214` reads.
 *
 * So this module reconstructs the fact from the coordination record, in the order §7 states:
 *
 *     accepted change
 *       -> its wave targets that SUCCEEDED
 *       -> each target's deployment-target
 *       -> environment === 'prod'
 *       -> the component placed there
 *       -> the dependency_lines that component is the DECLARED producer of
 *       -> the version that release published        (internal-release-version.ts)
 *       -> recordDependencyLineHead                  (M21.2)
 *
 * ============================================================================================
 * A ROLLBACK IS NOT A RELEASE, AND EXCLUDING IT IS LOAD-BEARING
 * ============================================================================================
 * `validating -> accepted` is a HUMAN gate for a forward change, but a ROLLBACK change auto-accepts
 * itself (`coordination/reconcile.ts:1893-1948`: "rollback changes need no human acceptance
 * gate"). So `toState === 'accepted'` alone does NOT mean "this was released" — roughly the
 * opposite for the auto-accepting half.
 *
 * Treating a rollback as a release would publish, to every subscriber of that line, the version the
 * org has just decided to WITHDRAW. That is not a missed detection, it is an active fan-out of a
 * known-bad release, which is why the exclusion is a first-class branch with its own Decision
 * rather than a predicate tucked into a WHERE clause. `changes.rollback_of_object_id` is the
 * structural test — DESIGN §9.4's "a rollback is its own Change, linked to the original" — never
 * the free-text `rollback_trigger_reason`, which is an English sentence a refactor can change.
 *
 * ============================================================================================
 * DOMAIN-LOCAL CHANGES ARE OUT OF SCOPE. STATED, NOT WORKED AROUND.
 * ============================================================================================
 * A domain-local change does not journal (`transition.ts:337-360`, ADR-0031): its `change_status`
 * entry is deliberately withheld, because "the commander doesn't need to know when these deploy
 * out" is exactly what domain-locality means. Until 2026-08-17 this module ran on every federation
 * role, so the head it recorded for such a release was a fact in THAT domain's `dependency_lines`
 * that travelled nowhere — "domain-visible only", the consequence ADR-0032 §7 records.
 *
 * SINCE ADR-0032 §7d (owner decision, 2026-08-17) THIS MODULE RUNS ON THE COMMANDER ONLY, so the
 * statement is now stronger: a domain-local release at an outpost reaches no detection at all, and
 * its head is recorded NOWHERE. That is the same class as §7d clause 1's outpost-only repositories
 * and is accepted on the same terms — an outpost never ORIGINATES a bump, it receives the resulting
 * change down the global pipeline the commander manages. Nothing here tries to route around it: a
 * feature that federated what locality withheld would defeat the locality decision, not extend it.
 *
 * ============================================================================================
 * WHAT KEEPS THIS FROM WRITING 1.44 GB/DAY
 * ============================================================================================
 * Two independent things, because the amplification ADR-0024 measured came from a writer that had
 * neither:
 *
 *  1. EVERY VERDICT GOES THROUGH `insertDecisionIfChanged`. This path is event-driven, but the
 *     outbox -> pg-boss delivery is AT-LEAST-ONCE, so a redelivered accept must not append a second
 *     byte-identical Decision. `inputContext`/`reasonTree` are therefore built from stable facts
 *     only — never a timestamp, never a wall clock — and are sorted, so a redelivery collapses.
 *  2. ONE DECISION PER DETECTION RUN, not one per line, and NONE AT ALL when the released component
 *     declares no produced line. Most accepted changes in an org produce nothing; a Decision per
 *     accept saying "this released no declared line" would be a row per change forever, learnable
 *     from exactly once. A per-line Decision would be worse still under redelivery: each write
 *     would differ from the previous line's, so `insertDecisionIfChanged` would suppress nothing.
 *
 * ============================================================================================
 * THE SUBSCRIBER GATE COMES FROM M21.3'S RESOLUTION, NOT FROM A SECOND FILTER
 * ============================================================================================
 * ADR-0032 §6: "the ingestion work-list is derived from this resolution", so a disabled component
 * is never fetched and an opted-out line is never polled. Determining a LANGUAGE version means
 * fetching the producer's manifest out of a user repo, which is exactly the fetch that rule
 * governs — so a produced line that no enabled component subscribes to is skipped BEFORE any read
 * happens, and the subscriber set is read from `listSubscribedComponentLines` (M21.3), narrowed by
 * `listComponentsDeclaringLine` (M21.2's reverse lookup). The AND is not re-expressed here; this
 * module cannot disagree with a UI verdict because it does not compute one.
 *
 * THAT IS ALSO WHY THE GROUP-SCOPE GUARD CHANGED — though NOT for the reason this comment used to
 * give. It said a group-scoped ENABLE is INERT here because this job resolves as
 * {@link SYSTEM_ACTOR_ID}, a sentinel with NO `objects` row (`coordination/system-actor.ts:9`) and
 * therefore a member of no group. The membership fact is still true; the conclusion is FALSE
 * (ADR-0032 §6a-ii). `matchPoliciesForTargets` also matches a group-scoped policy through its
 * OWNING half, which never reads the actor (`governance/policy-resolve.ts:313`, `:150-173`), so such
 * a policy DOES contribute here wherever the group owns something on the component's chain. What the
 * guard actually refuses is a reach nobody declared: membership plus mutable `owns` edges, in place
 * of what the author wrote. See `subscription-authoring-guard.ts` and ADR-0032 §6a-ii.
 */

/** The Decision `kind` this module writes. One kind, one subject (the change), one row per run. */
export const INTERNAL_RELEASE_DECISION_KIND = "dependency_internal_release";

/** The `deployment-target.properties.environment` value that means production. The same convention
 *  `regional-executors.ts` reads; there is no `environments` table to look it up in. */
export const PROD_ENVIRONMENT = "prod";

/** One line whose head this run moved. */
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

/**
 * ONE produced line, with EVERY prod place this change released it at.
 *
 * The grouping is load-bearing rather than tidy. A line has ONE head, so the question "what version
 * did this change put on line L?" must be answered once, over all the evidence, and not once per
 * place — which is what a flat (line, place) list produced: two places running different images each
 * wrote the head in turn and the last writer won, ordered by wave-target UUID. Each place keeps the
 * images observed AT THAT PLACE rather than a union, so a disagreement can be reported with the
 * places that disagreed rather than as one incoherent set.
 */
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

/**
 * Run the derivation for ONE accepted change.
 *
 * ============================================================================================
 * THREE PHASES, AND THE MIDDLE ONE HOLDS NO DATABASE CONNECTION
 * ============================================================================================
 * This takes a `Db` and opens its own transactions rather than borrowing a caller's `tx`, and the
 * reason is not symmetry with the poll — it is that phase 2 REACHES A USER'S GIT PROVIDER. Three of
 * the five ecosystems resolve their released version by reading the producer's own manifest at the
 * released commit (ADR-0032 §7a), which is a network round trip through the plugin host with a
 * host-enforced timeout measured in seconds. Doing that inside the caller's transaction pinned an
 * RLS-scoped pooled connection open for the whole fetch, against a production `statement_timeout` of
 * 5s and a bounded pool — one slow provider would hold a connection per accepted change. The
 * third-party poll deliberately does the opposite ("the network call happens OUTSIDE any
 * transaction"), and there is no reason for the two ingresses to differ.
 *
 *   phase 1 (tx)  — read the change, derive the prod releases and produced lines, apply the
 *                   rollback and subscriber gates, read the producers' manifest paths.
 *   phase 2 (NO tx) — ask, per line and per place, what version this release published.
 *   phase 3 (tx)  — move the heads through the write door and persist ONE Decision.
 *
 * Phase 1 and phase 3 are separate transactions, so this is not atomic across the fetch — and it
 * does not need to be. Both writes are idempotent restatements of an observation: the head goes
 * through `recordDependencyLineHead`, which re-reads `FOR UPDATE` and decides for itself, and the
 * Decision goes through `insertDecisionIfChanged`. A crash between the phases re-derives the same
 * answer on redelivery and appends nothing.
 *
 * Idempotent by construction, therefore: a redelivered `scp.change.transitioned` writes no new row.
 */
export async function detectInternalReleases(
  db: Db,
  orgId: string,
  input: DetectInternalReleasesInput
): Promise<InternalReleaseOutcome> {
  // ---------------------------------------------------------------------------------------
  // PHASE 1 — everything the derivation can learn from this domain's own records.
  // ---------------------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------------------
  // PHASE 2 — NO TRANSACTION IS OPEN HERE. Three of the five ecosystems fetch a manifest out of a
  // user repo through the plugin host; a registry/provider that takes 15s must not be doing so
  // behind a held, RLS-scoped pooled connection.
  // ---------------------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------------------
  // PHASE 3 — the writes, back inside a transaction.
  // ---------------------------------------------------------------------------------------
  return withTenantTx(db, orgId, async (tx) => {
    const recorded: RecordedInternalRelease[] = [];
    for (const item of pending) {
      if (!item.agreed) continue;
      // THE WRITE DOOR DECIDES whether this becomes the head: it applies line membership (major AND
      // image variant), the never-regress rule, and the version/digest pairing — the same rules, in
      // the same function, that the third-party poll is subject to. This module deliberately holds
      // no second copy of any of them, which is why a `1.9.9` hotfix landing after `1.10.0` is
      // refused here rather than silently walking the head backwards.
      const head = await recordDependencyLineHead(tx, orgId, {
        lineId: item.group.line.id,
        latestVersion: item.agreed.version,
        latestDigest: item.agreed.digest
      });
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

/**
 * `changes.source_ref`'s canonical keys, defensively. The column is `jsonb` holding the raw
 * delivery payload PLUS the keys `webhook-processor.ts`'s `canonicalizeSourceRef` lifted out of it
 * (`db/schema.ts:423-437`), so every field is optional in practice and a hand-created or imported
 * change may carry none of them. Only the three this derivation reads are lifted, and a non-string
 * is dropped rather than coerced.
 */
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

/**
 * The change's SUCCEEDED wave targets, resolved to the (component, prod deployment-target) pairs
 * they represent.
 *
 * SUCCEEDED, not merely planned. `change_wave_targets.status = 'succeeded'` is the only per-place
 * record that a place actually took the release — there is no event and no audit row for it — so a
 * failed, aborted or `no_executor` target must not contribute a release. (`no_executor` in
 * particular is ADR-0006's fail-closed terminal: the target had bindings but none for this Type, so
 * reconcile refused to fake-succeed the gap. Counting it would resurrect exactly the masking
 * failure that terminal state exists to prevent.)
 *
 * A WAVE TARGET IS NOT ALWAYS A PLACEMENT, and the non-placement case yields NOTHING rather than a
 * guess. Under stage-shaped compilation `target_object_id` IS a `placement` object
 * (`coordination/plan-service.ts:110`, `component-pipeline.ts:189-190`) and carries both halves of
 * the pair in its properties. Under LEGACY compilation the same column holds the change's own
 * target — a component or service — and there is no deployment-target on it at all, so its
 * environment is unknowable and it cannot be shown to be prod. Inferring one (from a name, from the
 * component's single placement, from a binding) would be the provenance-label mistake again: a
 * label named after what happened to match.
 */
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

/** `change_wave_targets.observed_state`'s `images` array (ADR-0008 / P4C), read defensively: the
 *  column is raw `jsonb`, is null until the first successful observe, and a status() that carried
 *  no images leaves it absent. Non-string entries are dropped rather than stringified. */
function observedImagesOf(observed: unknown): string[] {
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) return [];
  const images = (observed as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  return images
    .filter((i): i is string => typeof i === "string" && i.trim() !== "")
    .map((i) => i.trim());
}

/**
 * The lines each released component is the DECLARED producer of — one indexed read over
 * `dependency_lines.produced_by_object_id`.
 *
 * DECLARED, NEVER INFERRED (ADR-0032 §7, ADR-0030 §2). Nothing here looks at the component's name,
 * its repo, or the registry a coordinate points at. `produced_by_object_id` is written only by
 * `declareDependencyLineProducer`, which is a separate verb from ingestion precisely so that this
 * link cannot arrive as a side effect of observing a manifest.
 *
 * SINGLE HOP, AND ONLY THE COMPONENT. The producer link may name a component OR a service, and this
 * derivation asks only about the component the placement names — it does not walk up to that
 * component's service or down to a service's components. ADR-0032 §3's "nothing in the dependency
 * path may expose a transitive traversal" is what justifies the whole projection-table
 * representation; a containment walk here would spend it.
 */
async function listProducedLines(
  tx: TenantTx,
  orgId: string,
  releases: readonly ProdRelease[]
): Promise<ProducedLineGroup[]> {
  const componentObjectIds = [...new Set(releases.map((r) => r.componentObjectId))];
  if (componentObjectIds.length === 0) return [];

  const rows = await tx
    .select({
      id: dependencyLines.id,
      ecosystem: dependencyLines.ecosystem,
      coordinate: dependencyLines.coordinate,
      major: dependencyLines.major,
      producedByObjectId: dependencyLines.producedByObjectId
    })
    .from(dependencyLines)
    .where(
      and(
        eq(dependencyLines.orgId, orgId),
        inArray(dependencyLines.producedByObjectId, componentObjectIds)
      )
    )
    .orderBy(dependencyLines.id);

  const out: ProducedLineGroup[] = [];
  for (const row of rows) {
    // ONE GROUP PER LINE, carrying every place that released it — never one entry per (line, place).
    // A line has one head, so the places are evidence to be weighed together; a flat pair list made
    // each place write the head in turn and let the last one, ordered by UUID, win.
    const forThisLine = releases
      .filter((release) => release.componentObjectId === row.producedByObjectId)
      .sort((a, b) => (a.deploymentTargetObjectId < b.deploymentTargetObjectId ? -1 : 1));
    if (forThisLine.length === 0) continue;
    out.push({
      line: {
        id: row.id,
        // The column is plain `text` with no CHECK (0061's header: packages/schemas is the only
        // enforcement point), so a row written before an ecosystem left the enum must still be
        // resolvable. Cast rather than re-validate — the same reading
        // `subscription-resolution.ts:640` makes — and note that an unrecognised value falls into
        // `resolveReleasedVersion`'s explicit refusal arm, never into a version.
        ecosystem: row.ecosystem as DependencyEcosystem,
        coordinate: row.coordinate,
        major: row.major
      },
      releases: forThisLine
    });
  }
  return out;
}

/**
 * Is ANY enabled component subscribed to this line?
 *
 * Derived from M21.3, in two shipped single-hop lookups and no new predicate: the components that
 * DECLARE the line (`listComponentsDeclaringLine`, M21.2's reverse lookup — the subscribers of L
 * are the components that declare L, never the components that transitively reach it), narrowed
 * into `listSubscribedComponentLines`, which applies `mergeDependencySubscription` itself. The AND
 * is not restated here, so this gate cannot disagree with what a UI or a Decision reports.
 *
 * THE ACTOR IS THE SYSTEM SENTINEL, and the consequence worth naming at the call site is NOT the one
 * that used to be written here ("it is a member of no group, so a `group`-scoped effect NEVER
 * contributes for this job"). That is false — group scope's owning half ignores the actor, so such an
 * effect contributes wherever the group owns something on the chain (ADR-0032 §6a-ii). The real
 * consequence: whether it contributes is decided by ownership data this job never looks at and the
 * author never wrote, which is why the authoring guard refuses group scope in both directions.
 */
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
