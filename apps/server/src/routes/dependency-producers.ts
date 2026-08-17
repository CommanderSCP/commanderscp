import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  DeclareDependencyLineProducerRequestSchema,
  DependencyLineProducerVerbResponseSchema,
  ListDependencyLineProducersQuerySchema,
  ListDependencyLineProducersResponseSchema,
  ProblemSchema,
  RetractDependencyLineProducerRequestSchema,
  type DependencyLineProducer,
  type DependencyLineProducerKey,
  type DependencyProducerLineImpact,
  type DependencyProducerOpenBump
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, conflict } from "../errors.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { insertDecisionIfChanged } from "../coordination/decisions-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import {
  declareDependencyLineProducer,
  getDependencyLineProducer,
  listComponentsDeclaringLine,
  listDependencyLineProducers,
  listDependencyLinesForCoordinate,
  resetLineHead,
  retractDependencyLineProducer
} from "../dependencies/dependency-inventory-repo.js";
import { listSubscribedComponentLines } from "../dependencies/subscription-resolution.js";
import { listOpenBumpAuthorshipsForCoordinate } from "../dependencies/bump-authorship-repo.js";
import {
  commanderOnlyFederationVerdict,
  dependencyManagementOf
} from "../dependencies/commander-only.js";

/**
 * THE PRODUCER DECLARATION'S AUTHORING SURFACE (ADR-0032 §7e, proposal §12) — API-first per charter
 * principle 3 (API -> SDK -> CLI).
 *
 * ============================================================================================
 * THE DEFECT THIS CLOSES
 * ============================================================================================
 * `dependency_lines.produced_by_object_id` decided whether a line was INTERNAL, and its only writer
 * — `declareDependencyLineProducer` — had NO NON-TEST CALLER: no route, no CLI verb, no job, no IaC
 * construct. So in production the column was never set, `isInternalDependencyLine` was always false,
 * and THE INTERNAL HALF OF DEPENDENCY SUBSCRIPTIONS COULD NOT FIRE AT ALL — half of what was asked
 * for ("internal dependencies refresh the database once released to production"). Third-party
 * polling worked; internal release detection derived lines for the empty set of declared producers.
 * That is the built-never-installed shape, one layer down from where M21.5 already met it.
 *
 * SO THIS FILE'S OWN WIRING IS THE FIRST THING TO PIN, because shipping a second uncalled function
 * would be absurd. `dependency-producers.integration.test.ts`'s
 * "WIRING: the declare route is REGISTERED" fails if `registerDependencyProducerRoutes` is removed
 * from `app.ts` — deleting the registration was measured to turn it red.
 *
 * ============================================================================================
 * WHAT MUST NOT BE THE FIX
 * ============================================================================================
 * Wiring the producer link into INGESTION. `UpsertDependencyLineInputSchema` has no producer field
 * and `upsertDependencyLine`'s ON CONFLICT set list cannot reach one; the capability is ABSENT from
 * the ingestion verb rather than guarded on it, and since drizzle/0068 the declaration is not even
 * in the same table. Wiring it in would delete "declared, never inferred" and call it a completion.
 * The missing piece was an authoring surface for a deliberately MANUAL declaration, and that is all
 * this file is.
 *
 * ============================================================================================
 * A VERB, NOT A FIELD WRITE — ON TWO OF ADR-0031 §6'S THREE GROUNDS
 * ============================================================================================
 *  1. WORK BEYOND THE FIELD WRITE — TRANSFERS, more strongly than for `publish`. A declaration
 *     removes EVERY major of the coordinate from the poll's work-list and MOVES THE HEAD-DERIVATION
 *     INGRESS for those lines from a public index to the org's own production releases. It also
 *     clears observation state. None of that is visible in a field edit.
 *  2. ONE-WAY — DOES NOT TRANSFER, and the verb does not borrow the rhetoric. Retraction is part of
 *     the concept, and it is a peer verb below.
 *  3. A LEGIBLE REPORT — TRANSFERS, and is where the verb earns its keep. The response enumerates
 *     the lines the declaration covers, each line's head, and the subscribed components per line.
 *     THAT LIST IS THE BLAST RADIUS AND IT IS UNGUESSABLE FROM THE REQUEST: the declarer names one
 *     coordinate and affects a set of repositories they cannot see. `dryRun` returns the same report
 *     and writes nothing, which is the only way to look before you leap.
 *
 * ============================================================================================
 * AUTHORITY: `policy:write` AT THE ORG ROOT (owner decision, 2026-08-17)
 * ============================================================================================
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
 * ============================================================================================
 * THE FK CONSTRAINT THE MIGRATIONS COULD NOT EXPRESS
 * ============================================================================================
 * `producer_object_id` is `REFERENCES objects(id)` and ORG-UNBOUND (drizzle/0061's header states
 * why: `objects` carries no `(org_id, id)` unique constraint to hang a composite key on, and RI
 * triggers are not subject to RLS). So the raw table would accept a deployment-target, a user, or
 * ANOTHER TENANT'S OBJECT. 0061's header names the mitigation an eventual route owes — "resolve
 * every caller-supplied object id under the CALLER'S OWN org before it reaches this table" — and
 * {@link assertDeclarableProducer} is it. Do not read RLS as having done that.
 *
 * A `service` IS REFUSED, with a message that says so (ADR-0032 §7e, owner decision). Not pedantry:
 * `listProducedLines` derives a head only from the COMPONENT a prod placement names, so today a
 * service-valued declaration derives no head at all while still removing the coordinate from
 * third-party polling — the harmful half, silently, and not the useful half.
 *
 * ============================================================================================
 * COMMANDER-ONLY ON THE FEDERATION AXIS ONLY
 * ============================================================================================
 * The WRITES answer 409 off `commanderOnlyFederationVerdict` for the reason
 * `dependency-subscriptions.ts` already gives at length — "right request, wrong place", and a route
 * must not carry the PROCESS axis (every HTTP request lands on an `SCP_ROLE=api` process in the
 * split topology by design). The READ stays tenant-facing: a team must be able to see why their
 * coordinate is not being polled.
 */

/** The Decision kind both verbs write. One kind, so `latestDecisionForSubjectKind`'s
 *  persist-on-change comparison sees a declare and a later retract as two different verdicts about
 *  the same subject rather than as unrelated streams. */
const PRODUCER_DECISION_KIND = "dependency_line_producer";

/**
 * Resolve the caller-supplied producer to a LIVE, NON-DELETED, IN-ORG `component`.
 *
 * Three refusals, each with its own remedy, because collapsing them would send an operator hunting
 * for the wrong thing:
 *   - not resolvable in this org -> 404 from `getObjectByIdOrUrnAnyType` (which excludes deleted
 *     rows and scopes by `orgId`, so the cross-tenant and tombstone cases land here);
 *   - a `service` -> 400 naming the first-cut refusal and what it would silently do;
 *   - any other type (a deployment-target, a user) -> 400 naming what was found.
 */
async function assertDeclarableProducer(
  tx: TenantTx,
  orgId: string,
  producerIdOrUrn: string
): Promise<{ id: string; name: string }> {
  const object = await getObjectByIdOrUrnAnyType(tx, orgId, producerIdOrUrn);
  if (object.typeId === "service") {
    throw badRequest(
      `'${producerIdOrUrn}' is a service, and a SERVICE-valued producer declaration is refused in ` +
        `the first cut (ADR-0032 §7e): internal head derivation reads the COMPONENT a production ` +
        `placement names, so a service declaration would remove this coordinate from third-party ` +
        `polling and derive no head at all — the harmful half without the useful one. Declare the ` +
        `component that publishes the artifact.`
    );
  }
  if (object.typeId !== "component") {
    throw badRequest(
      `a producer must be a component; '${producerIdOrUrn}' is a ${object.typeId}. The declaration ` +
        `says "this component's production releases are where this coordinate's versions come from", ` +
        `which only a component can be.`
    );
  }
  return { id: object.id, name: object.name };
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
async function readBlastRadius(
  tx: TenantTx,
  orgId: string,
  key: DependencyLineProducerKey,
  actorObjectId: string
): Promise<
  {
    lineId: string;
    major: string;
    tagPattern: string | null;
    latestVersion: string | null;
    latestDigest: string | null;
    latestObservedAt: string | null;
    subscribedComponentObjectIds: string[];
  }[]
> {
  const lines = await listDependencyLinesForCoordinate(tx, orgId, key);
  const out = [];
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

export function registerDependencyProducerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------------------------------
  // POST /dependencies/producers — DECLARE.
  //
  // The coordinate travels in the BODY, never a path segment: coordinates contain `/`, `@` and `:`
  // (`github.com/acme/lib`, `@acme/lib`, `docker.io/library/alpine`), and path-segmenting one is a
  // trap `GET /components/:idOrUrn/dependency-subscription` already avoided by using a query.
  // -------------------------------------------------------------------------------------------
  typed.route({
    method: "POST",
    url: "/api/v1/dependencies/producers",
    schema: {
      body: DeclareDependencyLineProducerRequestSchema,
      response: {
        200: DependencyLineProducerVerbResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "declareDependencyLineProducer",
        summary:
          "Declare that a component produces one dependency coordinate — the ONE way a coordinate becomes internal, so its versions are derived from the org's own production releases instead of a public index (ADR-0032 §7e). Requires 'policy:write' at the ORG ROOT: the declaration changes behaviour for every component in the org that depends on the coordinate. Returns the blast radius; `dryRun` returns it without writing. COMMANDER-ONLY: a deployment whose SCP_FEDERATION_ROLE is not an explicitly declared 'commander' answers 409",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      // Before the work and after authentication, so an outpost is told the true answer ("run it on
      // the commander") and the route is not an unauthenticated oracle for this deployment's role.
      const commander = commanderOnlyFederationVerdict(
        deps.config,
        "declaring a dependency-line producer"
      );
      if (!commander.allowed) throw conflict(commander.reason);

      const body = request.body;
      const key: DependencyLineProducerKey = {
        ecosystem: body.ecosystem,
        coordinate: body.coordinate
      };
      const dryRun = body.dryRun === true;

      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // ORG-WIDE BLAST RADIUS -> ORG-ROOT AUTHORITY. See the module doc; the org root object id is
        // the org id (bootstrap invariant), the same scope `assertPolicyScopeWithinAuthority` uses.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "policy:write",
          scopeObjectId: auth.orgId
        });
        const producer = await assertDeclarableProducer(tx, auth.orgId, body.producerIdOrUrn);
        const before = await readBlastRadius(tx, auth.orgId, key, auth.subjectObjectId);

        if (dryRun) {
          const previous = await getDependencyLineProducer(tx, auth.orgId, key);
          return {
            declaration:
              // What the caller ASKED FOR, projected — a dry run reports the state it would create,
              // and stamping a real `declaredAt` would put a timestamp on the wire for a write that
              // never happened. `previous?.declaredAt` is reused when re-declaring so the shape is
              // still a valid `DependencyLineProducer`.
              {
                orgId: auth.orgId,
                ecosystem: key.ecosystem,
                coordinate: key.coordinate,
                producerObjectId: producer.id,
                declaredAt: previous?.declaredAt ?? "",
                declaredByObjectId: auth.subjectObjectId
              } satisfies DependencyLineProducer,
            lines: before.map((l): DependencyProducerLineImpact => ({
              lineId: l.lineId,
              major: l.major,
              tagPattern: l.tagPattern,
              headBefore: {
                latestVersion: l.latestVersion,
                latestDigest: l.latestDigest,
                latestObservedAt: l.latestObservedAt
              },
              // What WOULD be cleared. A dry run that reported `false` everywhere would hide the
              // single most consequential thing the verb does.
              headCleared:
                l.latestVersion !== null || l.latestDigest !== null || l.latestObservedAt !== null,
              subscribedComponentObjectIds: l.subscribedComponentObjectIds
            })),
            decisionId: null
          };
        }

        const declaration = await declareDependencyLineProducer(tx, auth.orgId, {
          ecosystem: key.ecosystem,
          coordinate: key.coordinate,
          producerObjectId: producer.id,
          // PRINCIPLE 6, AND NOT FROM THE BODY. `declaredByObjectId` used to be a field of
          // `DeclareLineProducerInput` that the caller supplied, which makes the provenance label
          // forgeable — an answer the asserter typed is not an answer to "who asserted this".
          declaredByObjectId: auth.subjectObjectId
        });

        // CLEARING THE HEAD IS PART OF DECLARING, and the reason is in `resetLineHead`'s own header:
        // a poisoned public head (the stranger's `9.9.9`) would otherwise survive the declaration
        // that exists to undo it, and internal detection could never move the head back down to the
        // org's real `2.1.0` because that is backward movement and the write door refuses it.
        const lines: DependencyProducerLineImpact[] = [];
        for (const l of before) {
          const reset = await resetLineHead(tx, auth.orgId, l.lineId);
          lines.push({
            lineId: l.lineId,
            major: l.major,
            tagPattern: l.tagPattern,
            headBefore: reset.before,
            headCleared: reset.cleared,
            subscribedComponentObjectIds: l.subscribedComponentObjectIds
          });
        }

        const decision = await insertDecisionIfChanged(tx, {
          orgId: auth.orgId,
          kind: PRODUCER_DECISION_KIND,
          // The PRODUCER is the subject: it is the object whose releases now author other teams'
          // commits, and it is a real `objects.id`, which the column requires.
          subjectId: producer.id,
          verdict: "declared",
          inputContext: {
            ecosystem: key.ecosystem,
            coordinate: key.coordinate,
            producerObjectId: producer.id,
            declaredByObjectId: auth.subjectObjectId
          },
          reasonTree: {
            // Sorted and free of wall-clock values so a redelivery or a byte-identical re-declare
            // collapses under persist-on-change (ADR-0024). The heads that were CLEARED are facts
            // about this act and stay.
            linesCovered: lines.map((l) => l.lineId).sort(),
            headsCleared: lines
              .filter((l) => l.headCleared)
              .map((l) => ({ lineId: l.lineId, wasVersion: l.headBefore.latestVersion }))
              .sort((a, b) => (a.lineId < b.lineId ? -1 : 1)),
            subscribedComponentObjectIds: [
              ...new Set(lines.flatMap((l) => l.subscribedComponentObjectIds))
            ].sort()
          }
        });

        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "dependency.producer.declare",
          subjectId: producer.id,
          reason: `${key.ecosystem} ${key.coordinate}`,
          decisionId: decision.decision.id,
          requestId: request.id
        });

        return { declaration, lines, decisionId: decision.decision.id };
      });

      reply.status(200).send({
        ecosystem: key.ecosystem,
        coordinate: key.coordinate,
        action: "declare" as const,
        dryRun,
        declaration: result.declaration,
        lines: result.lines,
        // Declaring stops nothing that is already in flight; the list belongs to retraction.
        openBumpAuthorships: [],
        decisionId: result.decisionId,
        dependencyManagement: dependencyManagementOf(deps.config)
      });
    }
  });

  // -------------------------------------------------------------------------------------------
  // POST /dependencies/producers/retract — the peer verb.
  //
  // A SEPARATE PATH RATHER THAN A `producerIdOrUrn: null`. The two acts have different bodies (a
  // retraction names no producer), different reports (only a retraction can have bumps in flight)
  // and different Decisions, and a nullable field that switches a verb between two meanings is how
  // an omitted key becomes a destructive default.
  // -------------------------------------------------------------------------------------------
  typed.route({
    method: "POST",
    url: "/api/v1/dependencies/producers/retract",
    schema: {
      body: RetractDependencyLineProducerRequestSchema,
      response: {
        200: DependencyLineProducerVerbResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "retractDependencyLineProducer",
        summary:
          "Retract a producer declaration and return the coordinate to third-party polling (ADR-0032 §7e). Clears every covered line's observed head — a head the org's own releases put there would otherwise wedge the line, and is a security-gate input. Reports the bumps still in flight, which SCP does NOT close. Requires 'policy:write' at the ORG ROOT. COMMANDER-ONLY (409 elsewhere)",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const commander = commanderOnlyFederationVerdict(
        deps.config,
        "retracting a dependency-line producer"
      );
      if (!commander.allowed) throw conflict(commander.reason);

      const body = request.body;
      const key: DependencyLineProducerKey = {
        ecosystem: body.ecosystem,
        coordinate: body.coordinate
      };
      const dryRun = body.dryRun === true;

      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "policy:write",
          scopeObjectId: auth.orgId
        });
        const existing = await getDependencyLineProducer(tx, auth.orgId, key);
        if (existing === null) {
          // 400, not 404: the ROUTE exists and the request is addressed at this org's inventory —
          // what is wrong is that the caller believes a declaration exists that does not. A 404
          // would read as "no such endpoint" to a CLI user.
          throw badRequest(
            `no producer is declared for ${key.ecosystem} '${key.coordinate}' in this org, so there ` +
              `is nothing to retract. The coordinate is already polled as third-party.`
          );
        }
        const before = await readBlastRadius(tx, auth.orgId, key, auth.subjectObjectId);

        if (dryRun) {
          return {
            declaration: null,
            lines: before.map((l): DependencyProducerLineImpact => ({
              lineId: l.lineId,
              major: l.major,
              tagPattern: l.tagPattern,
              headBefore: {
                latestVersion: l.latestVersion,
                latestDigest: l.latestDigest,
                latestObservedAt: l.latestObservedAt
              },
              headCleared:
                l.latestVersion !== null || l.latestDigest !== null || l.latestObservedAt !== null,
              subscribedComponentObjectIds: l.subscribedComponentObjectIds
            })),
            openBumps: [] as DependencyProducerOpenBump[],
            decisionId: null
          };
        }

        await retractDependencyLineProducer(tx, auth.orgId, key);

        // CLEARING THE HEAD IS PART OF RETRACTING, and this is the direction that is a security fix
        // rather than a wedge fix — see `resetLineHead`'s header. `latest_version` is an input to
        // the M22 vendor scan rule, so a head left over from the internal era, on a coordinate that
        // is third-party again, can grant a vendor-pass against a version no registry published.
        const lines: DependencyProducerLineImpact[] = [];
        for (const l of before) {
          const reset = await resetLineHead(tx, auth.orgId, l.lineId);
          lines.push({
            lineId: l.lineId,
            major: l.major,
            tagPattern: l.tagPattern,
            headBefore: reset.before,
            headCleared: reset.cleared,
            subscribedComponentObjectIds: l.subscribedComponentObjectIds
          });
        }

        // REPORTED, NEVER TOUCHED. A dispatched bump has left SCP — it is a pull request in another
        // team's repository, or under `auto_merge` a commit on their branch. Closing or rewriting
        // these rows would assert SCP closed a PR it did not close. Retraction stops FUTURE
        // triggers only; this list is what an operator takes away to go and close them.
        const openBumps = await listOpenBumpAuthorshipsForCoordinate(tx, auth.orgId, key);

        const decision = await insertDecisionIfChanged(tx, {
          orgId: auth.orgId,
          kind: PRODUCER_DECISION_KIND,
          subjectId: existing.producerObjectId,
          verdict: "retracted",
          inputContext: {
            ecosystem: key.ecosystem,
            coordinate: key.coordinate,
            producerObjectId: existing.producerObjectId,
            retractedByObjectId: auth.subjectObjectId
          },
          reasonTree: {
            linesCovered: lines.map((l) => l.lineId).sort(),
            headsCleared: lines
              .filter((l) => l.headCleared)
              .map((l) => ({ lineId: l.lineId, wasVersion: l.headBefore.latestVersion }))
              .sort((a, b) => (a.lineId < b.lineId ? -1 : 1)),
            // THE ONES SCP CANNOT RECALL, on the record at the moment of retraction, because an
            // operator's only route to them is this list.
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
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "dependency.producer.retract",
          subjectId: existing.producerObjectId,
          reason: `${key.ecosystem} ${key.coordinate}`,
          decisionId: decision.decision.id,
          requestId: request.id
        });

        return { declaration: null, lines, openBumps, decisionId: decision.decision.id };
      });

      reply.status(200).send({
        ecosystem: key.ecosystem,
        coordinate: key.coordinate,
        action: "retract" as const,
        dryRun,
        declaration: null,
        lines: result.lines,
        openBumpAuthorships: result.openBumps.map((b) => ({
          changeObjectId: b.changeObjectId,
          componentObjectId: b.componentObjectId,
          repo: b.repo,
          manifestPath: b.manifestPath,
          fromVersion: b.fromVersion,
          toVersion: b.toVersion,
          ...(b.pullRequestUrl !== undefined ? { pullRequestUrl: b.pullRequestUrl } : {})
        })),
        decisionId: result.decisionId,
        dependencyManagement: dependencyManagementOf(deps.config)
      });
    }
  });

  // -------------------------------------------------------------------------------------------
  // GET /dependencies/producers — the read. TENANT-FACING and NOT commander-only.
  //
  // "Why is my coordinate not being polled?" is a question a team on any deployment may legitimately
  // ask, and refusing it there would leave them with a verdict whose reason is unavailable — charter
  // principle 6 failing rather than being satisfied. The answer is QUALIFIED by
  // `dependencyManagement` for the same reason the resolution read is: on a field outpost this table
  // is empty by design (ADR-0032 §7d), and an unqualified empty list reads as "nothing is declared"
  // when the truth is "declarations live at the commander".
  // -------------------------------------------------------------------------------------------
  typed.route({
    method: "GET",
    url: "/api/v1/dependencies/producers",
    schema: {
      querystring: ListDependencyLineProducersQuerySchema,
      response: {
        200: ListDependencyLineProducersResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listDependencyLineProducers",
        summary:
          "List this org's declared dependency-line producers — which components the org declares it publishes which coordinates from (ADR-0032 §7e). Narrowable by ecosystem, or to one exact coordinate (compared VERBATIM). Read the `dependencyManagement` envelope: on a field outpost this list is empty BY DESIGN, because declarations live at the commander",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const producers = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Reading the org's declarations is reading org-scoped configuration — `object:read` at the
        // org root, the ordinary tenant read. It is deliberately NOT the org-root `policy:write`
        // the writes require: seeing which coordinates the org claims is not authority to change
        // which ones it claims.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return listDependencyLineProducers(tx, auth.orgId, {
          ...(request.query.ecosystem !== undefined ? { ecosystem: request.query.ecosystem } : {}),
          ...(request.query.coordinate !== undefined
            ? { coordinate: request.query.coordinate }
            : {})
        });
      });
      reply.status(200).send({
        producers,
        dependencyManagement: dependencyManagementOf(deps.config)
      });
    }
  });
}
