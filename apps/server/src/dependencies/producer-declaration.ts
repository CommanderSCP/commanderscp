import type {
  DependencyLineProducer,
  DependencyLineProducerKey,
  DependencyProducerLineImpact,
  DependencyProducerOpenBump
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import type { Permission } from "../authz/resolve.js";
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import {
  declareDependencyLineProducer,
  getDependencyLineProducer,
  listComponentsDeclaringLine,
  listDependencyLinesForCoordinate,
  resetLineHead,
  retractDependencyLineProducer
} from "./dependency-inventory-repo.js";
import { listSubscribedComponentLines } from "./subscription-resolution.js";
import { listOpenBumpAuthorshipsForCoordinate } from "./bump-authorship-repo.js";

/**
 * THE PRODUCER DECLARATION'S EFFECTS, IN ONE PLACE — shared by every door that may write one.
 *
 * ============================================================================================
 * WHY THIS MODULE EXISTS RATHER THAN A SECOND COPY IN THE IaC APPLY PATH
 * ============================================================================================
 * `routes/dependency-producers.ts` was the only writer when it was built. Adding the IaC surface
 * (charter principle 3: API -> SDK -> CLI -> IaC) makes `iac/plans-repo.ts`'s apply a SECOND door
 * into `dependency_line_producers`, and a declaration is not a field write — three things happen
 * around it, and every one of them is a correctness or security obligation rather than a nicety:
 *
 *  1. THE HEADS OF EVERY COVERED LINE ARE CLEARED. `resetLineHead`'s own header is the argument, in
 *     both directions: on a DECLARE a poisoned public head would otherwise survive the very
 *     declaration that exists to undo it (and could never be walked back down, because the write
 *     door refuses backward movement); on a RETRACT a head the org's own releases put there is a
 *     M22 vendor-scan-rule INPUT, so it can grant a pass against a version no registry published.
 *     A door that writes the row and skips this is a door that arms the exact failures the verb
 *     exists to prevent.
 *  2. A DECISION IS RECORDED. `routes/dependency-producers.ts` documents
 *     `GET /decisions?kind=dependency_line_producer` as answering "every producer declaration ever
 *     made in this org". A second writer that skips the Decision makes that sentence FALSE — the
 *     class of self-contradiction this repo keeps finding in its own accepted documents — and
 *     breaks charter principle 6 for whichever declarations happened to arrive through IaC.
 *  3. AN AUDIT EVENT IS APPENDED, hash-chained in the same transaction as the write.
 *
 * The three are inseparable from the row, so they live WITH the row rather than beside each caller.
 * `iac/plans-repo.ts` and the route call the same two functions; neither reimplements any of it.
 *
 * ============================================================================================
 * WHAT IS *NOT* HERE, AND WHY
 * ============================================================================================
 * The RESOLUTION of a caller-supplied producer reference to a live in-org `component`. The route
 * does it with `assertDeclarableProducer` against an id-or-URN string; IaC does it against the plan
 * diff, where the object's `typeId` is already known and the answer must be re-derivable from the
 * STORED diff at apply time (`plan-diff.ts`'s `invalidProducerDeclarations`). Same rule, two
 * genuinely different inputs — folding them together would mean a DB read on the IaC path that the
 * fail-closed re-check is specifically designed not to need.
 */

/**
 * The Decision kind both verbs write. One kind, so `GET /decisions?kind=dependency_line_producer`
 * answers "every producer declaration ever made in this org" in one index descent — a claim that
 * only stays true while EVERY door writes this record, which is why the doors share this module.
 *
 * ============================================================================================
 * AND THESE ACTS DO NOT USE PERSIST-ON-CHANGE (corrected 2026-08-17)
 * ============================================================================================
 * They used to. `insertDecisionIfChanged` keys on `(subject_id, kind)` and the subject here is the
 * PRODUCER, so the comparison asked "is this the last thing this component was said to produce?" —
 * a question about the wrong noun, which SUPPRESSED THE RECORD OF A REAL CHANGE:
 *
 *   declare `@acme/lib` -> P     row written
 *   declare `@acme/lib` -> Q     row written (subject Q; P's declaration is gone — the producers
 *                                table is keyed on the COORDINATE, so Q displaced P)
 *   declare `@acme/lib` -> P     byte-identical to P's row above -> SUPPRESSED. The coordinate just
 *                                moved back to P and the Decision log says nothing happened.
 *
 * PUTTING THE COORDINATE IN THE IDENTITY DOES NOT FIX THAT, which is why it is not what was done.
 * The only identity columns are `subject_id` (a `uuid`, and a coordinate is not one) and `kind` —
 * and `kind` is documented in `decisions-repo.ts` as "the caller's own constant, never user input",
 * with an exact-match operator filter and a b-tree behind it; a coordinate string there is
 * unbounded, request-controlled cardinality in an operator's index. More decisively, an identity of
 * `(producer, coordinate)` STILL SUPPRESSES the sequence above: P's last row for this coordinate is
 * still byte-identical to the candidate.
 *
 * So the suppression is removed instead of re-keyed, and the reason it was never appropriate is in
 * `insertDecisionIfChanged`'s own header: it is "the write-side guard for every Decision writer that
 * re-evaluates on a TIMER rather than on an event". These are neither. Each call is one authorized
 * act by a principal at a wall-clock instant — there is no tick, no at-least-once redelivery, and
 * nothing here re-evaluates. The same header states the pairing rule that made the mismatch visible:
 * "a caller that pairs the Decision with a hash-chained audit event must suppress that event on the
 * same condition (`created === false`)". Both verbs append their audit event UNCONDITIONALLY, and
 * correctly so — the operator really did call the verb. It is the Decision that was wrong to go
 * missing. Growth is bounded by human action, not by a 2s loop.
 */
export const PRODUCER_DECISION_KIND = "dependency_line_producer";

/**
 * THE AUTHORITY EVERY PRODUCER WRITE TAKES — `policy:write` AT THE ORG ROOT (owner decision,
 * 2026-08-17), expressed ONCE so the route and the IaC apply path cannot drift apart.
 *
 * Declaring "X produces @acme/lib" changes behaviour for EVERY other component in the org that
 * depends on that coordinate, in two directions at once: their bumps start being triggered by X's
 * production releases, AND the coordinate stops being polled against its public index. The declarer
 * is affecting objects they may not own.
 *
 * `object:write` at X is INSUFFICIENT on this repo's own precedent — `governance/policy-scope-authz.ts`
 * is the authority: custody of a row is not jurisdiction over what it reaches, and an actor holding
 * authority at a single component "must still be refused an org-wide scope". The mechanics agree:
 * `scopeExpandCte` expands strictly UPWARD, so a component-bound principal reaches nothing sideways,
 * and the consumers of `@acme/lib` are siblings, not descendants.
 *
 * `policy:write` at the ORG ROOT is what that same file already requires for "anything broader …
 * which can match objects org-wide … has org-wide blast radius". The producer declaration has
 * org-wide blast radius in exactly that sense, so the established rule lands on the established
 * answer — with NO new `Permission` union member, no seed change and no new binding to provision.
 * A dedicated `dependency_producer:write` buys real least-privilege and is the named upgrade path;
 * until every estate's bindings are provisioned it would be open only to principals who already
 * hold this, so it is not the first cut.
 *
 * THE SHAPE IS A PAIR, NOT A CALL, because the two doors consume authority differently and must
 * still agree on it: the route authorizes inline, while `iac/plans-repo.ts` pushes every check into
 * one list its route drains to completion BEFORE any mutation runs. Both read this function, so the
 * permission AND the scope have exactly one definition. The org root object id IS the org id
 * (bootstrap invariant), the same scope `assertPolicyScopeWithinAuthority` uses.
 */
export function dependencyProducerScopeCheck(orgId: string): {
  permission: Permission;
  scopeObjectId: string;
} {
  return { permission: "policy:write", scopeObjectId: orgId };
}

/** The inline form, for a door that authorizes as it goes. Same pair, one definition. */
export async function authorizeDependencyProducerWrite(
  tx: TenantTx,
  input: { orgId: string; subjectObjectId: string }
): Promise<void> {
  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    ...dependencyProducerScopeCheck(input.orgId)
  });
}

/** One covered line, as the blast-radius read returns it before anything is written. */
export interface ProducerLineBefore {
  lineId: string;
  major: string;
  tagPattern: string | null;
  latestVersion: string | null;
  latestDigest: string | null;
  latestObservedAt: string | null;
  subscribedComponentObjectIds: string[];
}

/**
 * THE BLAST RADIUS: every major line of the coordinate, its current head, and WHICH COMPONENTS are
 * subscribed to it.
 *
 * The subscriber set is derived from M21.3's resolution and is NOT re-expressed here — the
 * components that DECLARE the line (`listComponentsDeclaringLine`, M21.2's reverse lookup) narrowed
 * through `listSubscribedComponentLines`, which applies `mergeDependencySubscription` itself. This
 * report therefore cannot disagree with what the resolve API or a UI says.
 *
 * THE ACTOR IS THE REQUESTING PRINCIPAL, not the system sentinel, for the same reason the inventory
 * backfill threads it: `matchPoliciesForTargets` resolves `scope.group` against the actor, so a
 * human running this sees the same enablement the resolution API reports to them.
 */
export async function readProducerBlastRadius(
  tx: TenantTx,
  orgId: string,
  key: DependencyLineProducerKey,
  actorObjectId: string
): Promise<ProducerLineBefore[]> {
  const lines = await listDependencyLinesForCoordinate(tx, orgId, key);
  const out: ProducerLineBefore[] = [];
  for (const line of lines) {
    const declaring = await listComponentsDeclaringLine(tx, orgId, line.id);
    const componentObjectIds = [...new Set(declaring.map((d) => d.componentObjectId))];
    const subscribed =
      componentObjectIds.length === 0
        ? []
        : await listSubscribedComponentLines(tx, orgId, { actorObjectId, componentObjectIds });
    out.push({
      lineId: line.id,
      major: line.major,
      tagPattern: line.tagPattern,
      latestVersion: line.latestVersion,
      latestDigest: line.latestDigest,
      latestObservedAt: line.latestObservedAt,
      subscribedComponentObjectIds: subscribed
        .filter((s) => s.lineId === line.id)
        .map((s) => s.componentObjectId)
        .sort()
    });
  }
  return out;
}

/** The dry-run projection of what a verb WOULD do to each covered line — no writes. A dry run that
 *  reported `headCleared: false` everywhere would hide the single most consequential thing the verb
 *  does. */
export function projectLineImpacts(before: ProducerLineBefore[]): DependencyProducerLineImpact[] {
  return before.map((l) => ({
    lineId: l.lineId,
    major: l.major,
    tagPattern: l.tagPattern,
    headBefore: {
      latestVersion: l.latestVersion,
      latestDigest: l.latestDigest,
      latestObservedAt: l.latestObservedAt
    },
    headCleared: l.latestVersion !== null || l.latestDigest !== null || l.latestObservedAt !== null,
    subscribedComponentObjectIds: l.subscribedComponentObjectIds
  }));
}

/** Clears the observed head of every covered line and reports what was discarded — see
 *  `resetLineHead`'s header for why BOTH verbs must do this, and why it is a security fix rather
 *  than a tidiness one. */
async function clearHeads(
  tx: TenantTx,
  orgId: string,
  before: ProducerLineBefore[]
): Promise<DependencyProducerLineImpact[]> {
  const lines: DependencyProducerLineImpact[] = [];
  for (const l of before) {
    const reset = await resetLineHead(tx, orgId, l.lineId);
    lines.push({
      lineId: l.lineId,
      major: l.major,
      tagPattern: l.tagPattern,
      headBefore: reset.before,
      headCleared: reset.cleared,
      subscribedComponentObjectIds: l.subscribedComponentObjectIds
    });
  }
  return lines;
}

/** The `reasonTree` half both verbs share: sorted, free of wall-clock values, so two Decisions about
 *  one coordinate can be diffed against each other by an operator. The heads that were CLEARED are
 *  facts about the act and stay. Each verb adds the half only it can report — the subscribers a
 *  declaration reaches, the open bumps a retraction cannot recall. */
function producerReasonTree(lines: DependencyProducerLineImpact[]): Record<string, unknown> {
  return {
    linesCovered: lines.map((l) => l.lineId).sort(),
    headsCleared: lines
      .filter((l) => l.headCleared)
      .map((l) => ({ lineId: l.lineId, wasVersion: l.headBefore.latestVersion }))
      .sort((a, b) => (a.lineId < b.lineId ? -1 : 1))
  };
}

/**
 * DECLARE: write the row, clear every covered line's head, record the Decision, append the audit
 * event. The whole act, so no door can perform a fraction of it.
 *
 * `declaredByObjectId` is `actorObjectId` and is NEVER caller-supplied (principle 6 — a provenance
 * label the asserter typed is not an answer to "who asserted this"). Both doors take it from
 * authenticated state: the route from the bearer subject, IaC apply from the applying principal.
 */
export async function declareProducerWithEffects(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    key: DependencyLineProducerKey;
    producerObjectId: string;
  }
): Promise<{
  declaration: DependencyLineProducer;
  lines: DependencyProducerLineImpact[];
  decisionId: string;
}> {
  const { orgId, actorObjectId, requestId, key, producerObjectId } = input;
  const before = await readProducerBlastRadius(tx, orgId, key, actorObjectId);

  // READ BEFORE THE UPSERT, because `declareDependencyLineProducer` overwrites it. Whether this act
  // TRANSFERS the coordinate from another component is the single most consequential thing a declare
  // can do that the request does not say, and until it went on the record nothing distinguished "P
  // is declared" from "the coordinate was taken from Q and given to P" (charter principle 6). `null`
  // means the coordinate was third-party until now.
  const displaced = await getDependencyLineProducer(tx, orgId, key);

  const declaration = await declareDependencyLineProducer(tx, orgId, {
    ecosystem: key.ecosystem,
    coordinate: key.coordinate,
    producerObjectId,
    declaredByObjectId: actorObjectId
  });

  // CLEARING THE HEAD IS PART OF DECLARING: a poisoned public head (the stranger's `9.9.9`) would
  // otherwise survive the declaration that exists to undo it, and internal detection could never
  // move the head back down to the org's real `2.1.0` because that is backward movement and the
  // write door refuses it.
  //
  // IT CLEARS WHAT IS STANDING; IT DOES NOT KEEP THE LINE CLEAN. A poll that fetched its answer
  // BEFORE this transaction can commit it AFTER, which was measured to put a public `2.99.0` back on
  // the line permanently. What makes the remedy durable is rule 0 at the write door —
  // `recordDependencyLineHead` re-reads this declaration under the same `FOR UPDATE` — so an
  // in-flight poll is refused with `line_is_internal`. This clears the past; rule 0 refuses the
  // future; removing either re-opens the hole in its own direction.
  const lines = await clearHeads(tx, orgId, before);

  // ALWAYS PERSISTED — see {@link PRODUCER_DECISION_KIND} for why persist-on-change was the wrong
  // guard here and why re-keying its identity would not have fixed it.
  const decision = await insertDecision(tx, {
    orgId,
    kind: PRODUCER_DECISION_KIND,
    // The PRODUCER is the subject: it is the object whose releases now author other teams' commits,
    // and it is a real `objects.id`, which the column requires.
    subjectId: producerObjectId,
    verdict: "declared",
    inputContext: {
      ecosystem: key.ecosystem,
      coordinate: key.coordinate,
      producerObjectId,
      // WHAT THIS ACT DISPLACED. `null` when the coordinate had no producer; another component's id
      // when this declaration TOOK the coordinate from it. Two declarations of the same coordinate
      // to the same producer are only the same event if nothing happened in between, and this is the
      // field that says whether anything did.
      displacedProducerObjectId: displaced?.producerObjectId ?? null,
      declaredByObjectId: actorObjectId
    },
    reasonTree: {
      ...producerReasonTree(lines),
      subscribedComponentObjectIds: [
        ...new Set(lines.flatMap((l) => l.subscribedComponentObjectIds))
      ].sort()
    }
  });

  await appendAuditEvent(tx, {
    orgId,
    actorId: actorObjectId,
    action: "dependency.producer.declare",
    subjectId: producerObjectId,
    reason: `${key.ecosystem} ${key.coordinate}`,
    decisionId: decision.id,
    requestId
  });

  return { declaration, lines, decisionId: decision.id };
}

/**
 * RETRACT: delete the row, clear every covered line's head, report the bumps already in flight,
 * record the Decision, append the audit event.
 *
 * `existing` is passed in rather than re-read because both doors have already had to establish it:
 * the route 400s when nothing is declared, and IaC apply reaches here only from a `delete` diff
 * entry whose row it has just looked up.
 */
export async function retractProducerWithEffects(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    key: DependencyLineProducerKey;
    existing: DependencyLineProducer;
  }
): Promise<{
  lines: DependencyProducerLineImpact[];
  openBumps: DependencyProducerOpenBump[];
  decisionId: string;
}> {
  const { orgId, actorObjectId, requestId, key, existing } = input;
  const before = await readProducerBlastRadius(tx, orgId, key, actorObjectId);

  await retractDependencyLineProducer(tx, orgId, key);

  // CLEARING THE HEAD IS PART OF RETRACTING, and this is the direction that is a security fix rather
  // than a wedge fix — see `resetLineHead`'s header. `latest_version` is an input to the M22 vendor
  // scan rule, so a head left over from the internal era, on a coordinate that is third-party again,
  // can grant a vendor-pass against a version no registry published.
  //
  // AND THE SYMMETRIC RACE IS CLOSED AT THE WRITE DOOR, not here: an internal-release derivation
  // already past its phase-1 producer read can commit its phase-3 head write after this transaction
  // and re-poison the line. `recordDependencyLineHead`'s rule 0 refuses that with
  // `line_is_third_party`, because this loop and that write take the same `FOR UPDATE`.
  const lines = await clearHeads(tx, orgId, before);

  // REPORTED, NEVER TOUCHED. A dispatched bump has left SCP — it is a pull request in another team's
  // repository, or under `auto_merge` a commit on their branch. Closing or rewriting these rows
  // would assert SCP closed a PR it did not close. Retraction stops FUTURE triggers only; this list
  // is what an operator takes away to go and close them.
  const openBumps = await listOpenBumpAuthorshipsForCoordinate(tx, orgId, key);

  const decision = await insertDecision(tx, {
    orgId,
    kind: PRODUCER_DECISION_KIND,
    subjectId: existing.producerObjectId,
    verdict: "retracted",
    inputContext: {
      ecosystem: key.ecosystem,
      coordinate: key.coordinate,
      producerObjectId: existing.producerObjectId,
      retractedByObjectId: actorObjectId
    },
    reasonTree: {
      ...producerReasonTree(lines),
      // THE ONES SCP CANNOT RECALL, on the record at the moment of retraction, because an operator's
      // only route to them is this list.
      openBumpAuthorships: openBumps
        .map((b) => ({
          changeObjectId: b.changeObjectId,
          componentObjectId: b.componentObjectId,
          repo: b.repo,
          toVersion: b.toVersion
        }))
        .sort((a, b) => (a.changeObjectId < b.changeObjectId ? -1 : 1))
    }
  });

  await appendAuditEvent(tx, {
    orgId,
    actorId: actorObjectId,
    action: "dependency.producer.retract",
    subjectId: existing.producerObjectId,
    reason: `${key.ecosystem} ${key.coordinate}`,
    decisionId: decision.id,
    requestId
  });

  return { lines, openBumps, decisionId: decision.id };
}
