import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateRoleRequestSchema,
  DeleteRoleRequestSchema,
  RoleIdParamSchema,
  RoleSchema,
  UpdateRoleRequestSchema,
  CreateRoleBindingRequestSchema,
  DeleteRoleBindingRequestSchema,
  GrantPreviewQuerySchema,
  GrantPreviewResponseSchema,
  ProblemSchema,
  RoleBindingIdParamSchema,
  RoleBindingListQuerySchema,
  RoleBindingListResponseSchema,
  RoleBindingSchema,
  RoleListResponseSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { checkAtOrgRootOrScopes } from "../authz/org-root-arm.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { conflict, forbidden } from "../errors.js";
import { idempotencyKeyOf, withIdempotency } from "../idempotency.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { externalIdentityOf } from "../auth/identity-sync.js";
import {
  ROLE_BINDING_SUBJECT_TYPES,
  assertBindableSubject,
  assertMayAuthorRole,
  assertRoleNameNotBuiltIn,
  assertGrantAcknowledgesEmpoweredPrincipals,
  assertGrantReachesOnlyBindableMembers,
  assertMayWriteRoleBinding,
  assertOrgRetainsAdministrativeFloor,
  assertRoleAcceptsNewBindings,
  assertRoleBindableAtScope,
  lockOrgRoleAuthority,
  principalsReachedBy,
  readableSubsetOf,
  revokeAffectsAdministrativeFloor,
  roleDeprecationReason,
  subjectTypeNeedsMembershipReview
} from "../authz/role-binding-door.js";
import {
  builtInRoleNames,
  countBindingsOfRole,
  deleteRoleById,
  insertRole,
  updateRole,
  deleteRoleBindingById,
  getRoleBindingById,
  getRoleById,
  insertRoleBinding,
  listRoleBindings,
  listRoles
} from "../authz/roles-repo.js";

/**
 * ================================================================================================
 * `GET /roles` + `GET/POST/DELETE /role-bindings` — role-model.md §5 step 5
 * ================================================================================================
 *
 * The four operations that make `role_binding:write` real. It was seeded onto Administrator and
 * Owner by `drizzle/0002` and demanded at ZERO call sites for its entire life, because there was no
 * role-binding API at all — so a real deployment had exactly two authority levels (bootstrap admin
 * -> Owner at the org root, `auth/local-auth.ts`; JIT OIDC user -> Viewer at the org root,
 * `auth/oidc.ts`) and every finer scope was reachable only by hand-written SQL: outside RLS, outside
 * the audit chain, with no Decision record. Every purpose role `drizzle/0099` seeds is inert until
 * this file exists, which is why owner ruling D5 makes the seed and this door ONE shippable unit.
 *
 * ------------------------------------------------------------------------------------------------
 * WHERE THE REFUSALS LIVE
 * ------------------------------------------------------------------------------------------------
 * `authz/role-binding-door.ts` — all of them, with the reasoning. This file resolves inputs, orders
 * the checks, and writes. In particular the no-escalation SUBSET RULE (that module's §2) is what
 * stops an org-root `role_binding:write` holder minting themselves an Owner binding; the natural
 * "at-or-above the scope" rule alone does not, and shipping only the natural rule would have been an
 * escalation door with a permission check on it.
 *
 * ------------------------------------------------------------------------------------------------
 * ONE TRANSACTION, ALWAYS — AND ONE TRANSACTION IS NOT ENOUGH
 * ------------------------------------------------------------------------------------------------
 * Resolution, both authority bars, the write, the Decision and the audit event all run inside a
 * single `withTenantTx`. Charter principle 6 requires the audit event to be written in the same
 * transaction as the action.
 *
 * An earlier revision of this paragraph went on to say the same transaction "is also what makes the
 * CHECKS meaningful". **It is necessary and it is not sufficient**, and both handlers below now take
 * `authz/role-binding-door.ts`'s org advisory lock as the FIRST statement of their transaction.
 * PostgreSQL's default READ COMMITTED gives every statement a fresh snapshot, so two concurrent
 * revokes of the last two administrative bindings each read a survivor and both commit — measured
 * [200, 200] with the org left unadministrable. The lock, the measurement, why it is an advisory
 * lock rather than `SELECT ... FOR UPDATE`, and what it does not cover are that module's §0.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY A DECISION RECORD AND NOT JUST AN AUDIT ROW
 * ------------------------------------------------------------------------------------------------
 * `audit_events` has no payload column, and a REVOKE hard-deletes the row it is about (there is no
 * `deleted_at` on `role_bindings`) — so an audit event alone would record "somebody revoked
 * <a uuid that no longer resolves>" and the estate would lose what authority was removed from whom.
 * The `role_binding` Decision carries the structured before/after the way `freeze.lift` already
 * does, and the audit event carries its `decision_id` plus the operator's own words.
 *
 * NO DEDUP CONCERN (ADR-0024). These are one-per-API-call authoring records driven by a human
 * pressing a button, not a predicate a reconcile loop restates every tick — which is where the
 * unbounded-decision-growth incident came from. `insertDecision`, not `insertDecisionIfChanged`,
 * matching `routes/governance.ts`'s freeze authoring calls exactly.
 *
 * A FAILED BAR THROWS A RAW 403 rather than persisting a `blocked` Decision, matching the freeze
 * write doors: this is a direct authoring call with no change in hand and nothing to explain later,
 * so a refusal with no side effects is the honest answer. (`decision_id` on a blocked response is
 * charter principle 6's requirement for ENGINE verdicts — gate evaluations that a change carries
 * forward — not for `authorize()`, which throws bare 403s at all ~170 enforcement sites.)
 */
export function registerRoleBindingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ===========================================================================================
  // GET /api/v1/roles — the read-only catalogue
  // ===========================================================================================
  //
  // READ-ONLY, DELIBERATELY, AND NOT FOR THIS INCREMENT'S CONVENIENCE. There is no `POST /roles`
  // and no `role:write` permission, because `hasRoleAtScope` (`authz/resolve.ts`) resolves approval
  // quorum eligibility by joining `roles` and matching `rl.name` with NO `org_id` predicate on the
  // roles row, while the binding half IS org-filtered. An org able to author a zero-permission role
  // named 'Approver' would instantly make its holders eligible quorum voters everywhere a policy
  // names Approver — a self-service quorum bypass. Custom roles are role-model.md §5 step 10 and are
  // gated behind closing that first. (`assertRoleAcceptsNewBindings` closes the half this increment
  // does open: binding an EXISTING hand-written row whose name collides with a built-in.)
  //
  // GATED ON `type_registry:read` AT THE ORG ROOT — the same permission at the same scope as
  // `GET /api/v1/type-registry` (`routes/type-registry.ts`), which is the closest thing in the tree:
  // a read of the platform's registered definitions rather than of the org's estate. Every built-in
  // role, ladder and purpose alike, carries it, so nothing that can read the estate loses the role
  // catalogue.
  //
  // ⚠️ THE ORG-ROOT PIN IS A REAL LIMIT AND IS NOT A BUG THAT CAN BE FIXED HERE. `scopeExpandCte`
  // expands upward only, so a principal bound ONLY below the org root — a ComponentAdmin at a
  // component — is refused. That is role-model.md §4.2's shape, and the fix that worked there
  // (re-scope onto the object the door governs) has nothing to attach to: the roles catalogue is
  // shared-singleton platform metadata with no containment scope of its own, exactly like the 14
  // federation doors. Costing a scoped principal a role PICKER is a UI affordance; inventing a scope
  // for a scopeless resource would be an authority claim. Step 6's `GET /authz/effective` is where a
  // scoped principal learns what it holds.
  typed.route({
    method: "GET",
    url: "/api/v1/roles",
    schema: {
      response: { 200: RoleListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listRoles",
        summary: "List roles (built-in and org-defined) with their permissions and bindable scopes",
        tags: ["rbac"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const items = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "type_registry:read",
          scopeObjectId: auth.orgId
        });
        const rows = await listRoles(tx, auth.orgId);
        return rows.map((role) => {
          // D5's marker, read from the SAME table the write door's refusal reads, so a UI can never
          // grey a role the door still accepts (or vice versa).
          const deprecationReason = roleDeprecationReason(role);
          return {
            id: role.id,
            orgId: role.orgId,
            name: role.name,
            permissions: role.permissions,
            bindableAt: role.bindableAt,
            deprecated: deprecationReason !== null,
            deprecationReason
          };
        });
      });
      reply.status(200).send({ items });
    }
  });

  // ===========================================================================================
  // POST / PATCH / DELETE /api/v1/roles — CUSTOM ROLES (role-model.md §5 step 10)
  // ===========================================================================================
  //
  // UNBLOCKED, NOT UNGUARDED. The module doc above recorded these as gated behind a live quorum
  // bypass: `hasRoleAtScope` matched a role NAME with no `org_id` predicate, so an org authoring a
  // zero-permission 'Approver' would have made its holders eligible quorum voters everywhere a
  // policy named Approver. That is closed (`authz/resolve.ts`, owner decision 2026-08-27): quorum
  // eligibility resolves BUILT-IN names only. These three operations ship on top of that fix and
  // would be unsafe without it.
  //
  // Every refusal is in `authz/role-binding-door.ts` §9. This file resolves inputs, orders the
  // bars, and writes the audit chain.

  typed.route({
    method: "POST",
    url: "/api/v1/roles",
    schema: {
      body: CreateRoleRequestSchema,
      response: {
        201: RoleSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema,
        422: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createRole",
        summary: "Author an organization-defined role",
        tags: ["rbac"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = request.body;

      const role = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // The same org advisory lock the binding door takes as its FIRST statement. Authoring reads
        // the actor's own effective permissions to compute the subset rule, and a concurrent revoke
        // of the actor's binding would otherwise let a role be authored against authority that no
        // longer exists by the time the row lands.
        await lockOrgRoleAuthority(tx, auth.orgId);

        const builtIns = await builtInRoleNames(tx);
        assertRoleNameNotBuiltIn(body.name, builtIns);
        await assertMayAuthorRole(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          permissions: body.permissions
        });

        const created = await insertRole(tx, {
          orgId: auth.orgId,
          name: body.name,
          permissions: [...body.permissions],
          bindableAt: body.bindableAt ?? null
        });

        const decision = await insertDecision(tx, {
          orgId: auth.orgId,
          kind: "role_binding",
          subjectId: created.id,
          verdict: "allow",
          inputContext: {
            operation: "role.create",
            roleName: created.name,
            // The array AS AUTHORED, for the same reason a grant stores `grantedPermissions`: a
            // later PATCH can widen this role, and the blast radius of that widening is only
            // computable after the fact if the starting point was recorded.
            permissions: [...created.permissions].sort(),
            bindableAt: created.bindableAt,
            actorId: auth.subjectObjectId,
            reason: body.reason
          },
          reasonTree: {
            summary:
              `authored org role '${created.name}' — every permission it carries was already ` +
              `held by the author at the organization root`,
            subsetRuleSatisfied: true
          }
        });

        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "role.create",
          subjectId: created.id,
          reason: body.reason,
          decisionId: decision.id,
          requestId: request.id
        });

        return created;
      });

      reply.status(201).send({
        id: role.id,
        orgId: role.orgId,
        name: role.name,
        permissions: role.permissions,
        bindableAt: role.bindableAt,
        deprecated: false,
        deprecationReason: null
      });
    }
  });

  typed.route({
    method: "PATCH",
    url: "/api/v1/roles/:id",
    schema: {
      params: RoleIdParamSchema,
      body: UpdateRoleRequestSchema,
      response: {
        200: RoleSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema,
        422: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "updateRole",
        summary: "Edit an organization-defined role (built-ins are immutable)",
        tags: ["rbac"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = request.body;

      const role = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await lockOrgRoleAuthority(tx, auth.orgId);

        const existing = await getRoleById(tx, auth.orgId, request.params.id);
        // A BUILT-IN IS NOT EDITABLE THROUGH ANY ORG'S API. `roles`' RLS admits `org_id IS NULL`
        // for reads, so `getRoleById` legitimately returns a shared singleton — and editing one
        // would rewrite the permission set of every org on the deployment at once. `updateRole`'s
        // `org_id` predicate makes it unaddressable anyway; this refusal exists so the answer is a
        // stated 403 rather than a confusing 404.
        if (existing.orgId === null) {
          throw forbidden(
            `'${existing.name}' is a shared built-in role. Built-ins are the same rows for every ` +
              `organization on this deployment and cannot be edited by a tenant; author an org ` +
              `role instead.`
          );
        }

        if (body.name !== undefined) {
          assertRoleNameNotBuiltIn(body.name, await builtInRoleNames(tx));
        }
        // Checked against the RESULTING array, not the delta. A PATCH that omits `permissions`
        // leaves them unchanged and still re-runs the rule, so an editor whose own authority has
        // since narrowed cannot rename a role they could no longer author.
        const nextPermissions = body.permissions ?? existing.permissions;
        await assertMayAuthorRole(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          permissions: nextPermissions
        });

        const updated = await updateRole(tx, {
          orgId: auth.orgId,
          id: request.params.id,
          name: body.name,
          permissions: body.permissions ? [...body.permissions] : undefined,
          // `nullish` in the schema: absent leaves it alone, explicit null clears it to ANY scope.
          bindableAt: body.bindableAt === undefined ? undefined : (body.bindableAt ?? null)
        });

        const added = updated.permissions.filter((p) => !existing.permissions.includes(p)).sort();
        const removed = existing.permissions.filter((p) => !updated.permissions.includes(p)).sort();

        const decision = await insertDecision(tx, {
          orgId: auth.orgId,
          kind: "role_binding",
          subjectId: updated.id,
          verdict: "allow",
          inputContext: {
            operation: "role.update",
            roleName: updated.name,
            permissionsBefore: [...existing.permissions].sort(),
            permissionsAfter: [...updated.permissions].sort(),
            // THE BLAST RADIUS, recorded because it is not re-checked anywhere. Adding a permission
            // widens EVERY EXISTING BINDING of this role with no re-evaluation — the same property
            // `role-binding-door.ts` §8 records for built-ins, except reachable through the API
            // here. The subset rule bounds it to the editor's own authority and nothing bounds it
            // to the original author's.
            permissionsAdded: added,
            permissionsRemoved: removed,
            actorId: auth.subjectObjectId,
            reason: body.reason
          },
          reasonTree: {
            summary:
              added.length > 0
                ? `widened org role '${updated.name}' by ${added.join(", ")} — every existing ` +
                  `binding of this role now confers them`
                : `edited org role '${updated.name}' without widening it`,
            subsetRuleSatisfied: true
          }
        });

        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "role.update",
          subjectId: updated.id,
          reason: body.reason,
          decisionId: decision.id,
          requestId: request.id
        });

        return updated;
      });

      reply.status(200).send({
        id: role.id,
        orgId: role.orgId,
        name: role.name,
        permissions: role.permissions,
        bindableAt: role.bindableAt,
        deprecated: false,
        deprecationReason: null
      });
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/roles/:id",
    schema: {
      params: RoleIdParamSchema,
      body: DeleteRoleRequestSchema,
      response: {
        204: z.undefined(),
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "deleteRole",
        summary: "Delete an organization-defined role that no binding points at",
        tags: ["rbac"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);

      await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await lockOrgRoleAuthority(tx, auth.orgId);

        const existing = await getRoleById(tx, auth.orgId, request.params.id);
        if (existing.orgId === null) {
          throw forbidden(
            `'${existing.name}' is a shared built-in role and cannot be deleted by a tenant.`
          );
        }
        await assertMayAuthorRole(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          permissions: existing.permissions
        });

        // REFUSES WITH BINDINGS, rather than cascading. `role_bindings.role_id` is a plain FK, so a
        // cascade here would silently revoke authority from every holder in one request with one
        // audit event naming the ROLE and not the principals — an unreviewable mass revoke wearing
        // a tidy-up's name. The same shape as the containment rule that refuses to delete a
        // container with children: the caller revokes the bindings first, and each revoke is its own
        // audited, floor-checked decision.
        const holders = await countBindingsOfRole(tx, auth.orgId, existing.id);
        if (holders > 0) {
          throw conflict(
            `role '${existing.name}' still has ${holders} binding${holders === 1 ? "" : "s"}. ` +
              `Revoke them first — deleting the role here would revoke authority from every ` +
              `holder at once, under one audit event that names the role rather than the ` +
              `principals who lost it.`
          );
        }

        const decision = await insertDecision(tx, {
          orgId: auth.orgId,
          kind: "role_binding",
          subjectId: existing.id,
          verdict: "allow",
          inputContext: {
            operation: "role.delete",
            roleName: existing.name,
            permissions: [...existing.permissions].sort(),
            bindingCount: 0,
            actorId: auth.subjectObjectId,
            reason: request.body.reason
          },
          reasonTree: {
            summary: `deleted org role '${existing.name}', which no binding pointed at`
          }
        });

        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "role.delete",
          subjectId: existing.id,
          reason: request.body.reason,
          decisionId: decision.id,
          requestId: request.id
        });

        await deleteRoleById(tx, auth.orgId, existing.id);
      });

      reply.status(204).send(undefined);
    }
  });

  // ===========================================================================================
  // GET /api/v1/role-bindings — who holds what, where
  // ===========================================================================================
  //
  // GATED ON `audit:read`, matching `GET /api/v1/audit-events`: a binding listing is an
  // accountability record about principals, not estate data, and `audit:read` is the permission this
  // codebase already uses for "may you see who did what".
  //
  // THE ORG-ROOT ARM PLUS A SCOPED ARM, via `authz/org-root-arm.ts`. With no `scopeObjectId` filter
  // the request asks for the whole org's bindings and only an org-root `audit:read` holder is
  // admitted (the helper's empty-scope-set case falls back to the org-root arm alone — `every`/`any`
  // over an empty array is guarded there explicitly, because a vacuous `true` on a door is a total
  // bypass). WITH a filter, a principal holding `audit:read` at-or-above that object is admitted
  // too, so a ServiceAdmin can see who is bound at their own service. This is a NEW door, so there
  // is no pre-existing behaviour to widen from and no risk of the re-scope trap the helper's docblock
  // warns about; the org-root arm is here because an org-root reader must not lose a read they would
  // have had, not to rescue anything.
  typed.route({
    method: "GET",
    url: "/api/v1/role-bindings",
    schema: {
      querystring: RoleBindingListQuerySchema,
      response: { 200: RoleBindingListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listRoleBindings",
        summary: "List role bindings, optionally filtered by subject and/or scope object",
        tags: ["rbac"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const verdict = await checkAtOrgRootOrScopes(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          orgRootPermission: "audit:read",
          scopedPermission: "audit:read",
          quantifier: "any",
          scopeObjectIds: request.query.scopeObjectId ? [request.query.scopeObjectId] : []
        });
        if (!verdict.ok) {
          throw forbidden(
            `subject '${auth.subjectObjectId}' lacks 'audit:read' at the org root` +
              (request.query.scopeObjectId ? ` or at scope '${request.query.scopeObjectId}'` : "") +
              " — role bindings are an accountability record"
          );
        }
        return listRoleBindings(tx, auth.orgId, request.query);
      });
      reply.status(200).send(page);
    }
  });

  // ===========================================================================================
  // GET /api/v1/role-bindings/grant-preview — what `acknowledgedPrincipalIds` must say
  // ===========================================================================================
  //
  // WITHOUT THIS THE FIELD IS UNUSABLE FROM A CLI, and a required field nobody can compute is a
  // door that is closed rather than guarded. `GET /relationships?typeId=member_of&toId=<group>`
  // gives DIRECT members only; the binding reaches the whole transitive closure, so a client would
  // have to re-implement `memberExpandCte` — including its depth bound and its cycle termination —
  // and any drift between that copy and this server's walk shows up as a 409 the operator cannot
  // fix. One call, the server's own walk, and the value is returned pre-sorted ready to paste.
  //
  // ⚠️ GATED ON `audit:read` AT-OR-ABOVE **THE SUBJECT** — corrected 2026-08-27, and the first
  // gating was the §2b disclosure defect re-introduced one layer up, in the affordance built to make
  // D7 usable.
  //
  // IT SHIPPED as `checkAtOrgRootOrScopes(… scopeObjectIds: [request.query.scopeObjectId])`,
  // described as "gated exactly like `GET /role-bindings`". The two are not alike, and the
  // difference is which object the named scope BELONGS to. On the binding LISTING, `scopeObjectId`
  // filters the rows returned, so a holder scoped at their own service names their own service and
  // reads bindings at it — the scope and the data are the same object. On the PREVIEW the parameter
  // named a *different* object from the one whose data comes back: the caller chose the scope, the
  // response was the subject's membership, and nothing joined them. So a merely SCOPED `audit:read`
  // holder — a ServiceAdmin, a ComponentAdmin — could name their own service and read the full
  // transitive membership of ANY group in the org.
  //
  // THE RULE THIS DOOR MUST SATISFY: the preview must not tell a caller anything they could not
  // already read. The membership disclosed belongs to the SUBJECT, so the subject is what the
  // permission is measured at — `audit:read` at the org root (the pre-existing whole-org reader) or
  // at-or-above the subject itself, from the same `authz/org-root-arm.ts` helper the listing uses,
  // so the two doors still cannot disagree about the org-root arm or about the empty-scope-set
  // vacuous-`every` trap.
  //
  // ⚠️ AND THE GATE IS NECESSARY AND NOT SUFFICIENT — corrected again 2026-08-27, because the bar
  // above is measurably not met by anchoring alone. **THE PRINCIPALS DISCLOSED ARE NOT THE
  // SUBJECT.** A `member_of` member is a separate graph object on its own containment chain, and
  // `scopeExpandCte` expands UPWARD, so `audit:read` at-or-above a TEAM says nothing whatever about
  // that team's members. MEASURED: a team-scoped Viewer got a 200 carrying a member's id, typeId and
  // name while the same token's `GET /objects/user/{that id}` answered 403.
  //
  // SO THE PROJECTION IS FILTERED TOO (`authz/role-binding-door.ts` §2d). `readableSubsetOf` keeps
  // only principals inside this caller's readable scope, composed from `authz/readable-scope.ts`'s
  // one definition rather than re-derived — the same set the LIST doors return. That is NOT identical
  // to "what `GET /objects/{type}/{idOrUrn}` would admit": for an org-root reader carrying a lower
  // `deny` the two diverge, and §2d states which way. The remainder is reported as a bare COUNT. What that
  // count still leaks, why it is not nothing, why a digest is no better, and the measurement that D7
  // remains usable for the caller who needs it are all beside `GrantPreviewResponseSchema` in
  // `packages/schemas/src/rbac.ts`.
  //
  // `scopeObjectId` IS GONE FROM THE CONTRACT rather than kept and ignored. A parameter that no
  // longer decides anything is a parameter that reads as a control, and the next reader would wire
  // it back to something. The operation is new in this increment and is not in the committed
  // `tools/openapi/openapi.v1.json`, so removing it is not an oasdiff event.
  //
  // THE SUBJECT IS RESOLVED BEFORE THE CHECK, because it is what the check is measured at. That
  // orders a 404 ahead of a 403 and therefore tells an authenticated caller of this org whether a
  // uuid they already possessed names a live object — the same fact `GET /objects/{type}/{id}`
  // answers. It does NOT disclose membership, type or name, which is the class this door is about.
  // Stated as an accepted consequence rather than left to be found.
  //
  // STATIC SEGMENT vs `DELETE /role-bindings/:id`: different methods, and find-my-way prefers a
  // static segment over a parameter in any case. There is no `GET /role-bindings/{id}` to collide
  // with — a single binding is read from the list.
  typed.route({
    method: "GET",
    url: "/api/v1/role-bindings/grant-preview",
    schema: {
      querystring: GrantPreviewQuerySchema,
      response: {
        200: GrantPreviewResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "previewRoleBindingGrant",
        summary: "List the principals a role binding on this subject would empower",
        tags: ["rbac"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // 404 on a soft-deleted or absent subject, the same refusal the grant door gives it, so a
        // preview can never advertise a grant the write would reject on identity grounds. FIRST,
        // because the authorization below is measured AT this object — see the block comment.
        const subject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.query.subjectId);
        const verdict = await checkAtOrgRootOrScopes(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          orgRootPermission: "audit:read",
          scopedPermission: "audit:read",
          quantifier: "any",
          // THE SUBJECT, never a caller-chosen scope. This is the whole fix: the membership being
          // disclosed is the subject's, so the subject is what the permission is measured at.
          scopeObjectIds: [subject.id]
        });
        if (!verdict.ok) {
          throw forbidden(
            `subject '${auth.subjectObjectId}' lacks 'audit:read' at the org root or at ` +
              `'${subject.id}' — a group's membership is an accountability record, and this ` +
              `preview is readable only by a principal who could already read it`
          );
        }
        // THE SAME WALK THE DOOR MAKES. Not a similar one — the identical function, so a preview and
        // the 409 that judges its output cannot disagree about the closure.
        const empowered = (
          subjectTypeNeedsMembershipReview(subject.typeId)
            ? await principalsReachedBy(tx, auth.orgId, subject.id)
            : []
        ).filter((p) => p.depth > 0);

        // §2d — THE PROJECTION FILTER. Applied to the CLOSURE, not to the walk: the walk has to see
        // everything (it is the same set the 409 compares against, and a filtered walk would make
        // `withheldPrincipalCount` unknowable), and only the RESPONSE is narrowed. Costs one query
        // for the caller's readable roots and nothing more for an org-root reader, which is the
        // caller D7 is for.
        const readable = await readableSubsetOf(
          tx,
          auth.orgId,
          auth.subjectObjectId,
          empowered.map((p) => p.id)
        );
        const visible = empowered.filter((p) => readable.has(p.id));
        const withheldPrincipalCount = empowered.length - visible.length;

        const principals = visible
          .map((p) => ({
            id: p.id,
            typeId: p.typeId,
            name: p.name,
            depth: p.depth,
            deleted: p.deleted,
            bindable: (ROLE_BINDING_SUBJECT_TYPES as readonly string[]).includes(p.typeId)
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return {
          subjectId: subject.id,
          subjectTypeId: subject.typeId,
          // Read from the door's OWN rule rather than re-derived from `subjectTypeId` here, so a
          // client is never told an acknowledgement is optional on a subject the door will refuse.
          acknowledgementRequired: subjectTypeNeedsMembershipReview(subject.typeId),
          // STATED, not left to be inferred from the count: `acknowledgedPrincipalIds` below is the
          // value to send only when this is `true`. When it is `false` the grant WILL 409 — and that
          // 409 names every withheld id, which is how such a caller still completes the grant.
          acknowledgementComplete: withheldPrincipalCount === 0,
          withheldPrincipalCount,
          acknowledgedPrincipalIds: principals.map((p) => p.id),
          principals,
          // Read off the SUBJECT's own properties, which the caller has already been authorized to
          // ask about — this discloses a fact about the group being previewed, never about its
          // members, so it needs no filtering of its own.
          subjectExternallySynced: externalIdentityOf(subject.properties) !== null
        };
      });
      reply.status(200).send(body);
    }
  });

  // ===========================================================================================
  // POST /api/v1/role-bindings — GRANT
  // ===========================================================================================
  //
  // THE ORDER OF THE FIVE REFUSALS IS DELIBERATE, and it is an information-disclosure choice as much
  // as an ergonomic one:
  //
  //   1. resolve the ROLE (404 if it is not visible to this org);
  //   2. `assertRoleAcceptsNewBindings` — D5's Administrator deprecation, and the built-in-name
  //      collision that would otherwise make this door the second half of a quorum bypass;
  //   3. resolve the SCOPE object and the SUBJECT object (404 if either is not a live object in this
  //      org), then `assertRoleBindableAtScope` + `assertBindableSubject` — the shape refusals;
  //   4. `role_binding:write` at-or-above the scope;
  //   5. the no-escalation SUBSET RULE;
  //   6. `assertGrantReachesOnlyBindableMembers` — §2b, the members a group subject would empower.
  //
  // THE LINE IS "WHERE DOES THE REFUSAL'S BODY COME FROM", not "is it about shape or authority" —
  // corrected 2026-08-27, because the first ordering put step 6 with the shape refusals at step 3
  // and leaked. Steps 2 and 3 derive their message from the REQUEST and the row it names, and leak
  // nothing an authenticated principal of this org cannot already read: role rows come from
  // `GET /roles`, object existence from `GET /objects/{type}/{id}`. Putting them first means an
  // operator fixing a typo is told about the typo rather than being told they lack standing to make
  // it. Step 6's 422 names OTHER rows — the ids, names and types of the principals inside a group —
  // so ahead of step 4 it handed the membership of any group in the org to a caller who was about to
  // be 403'd. It now runs last. `authz/role-binding-door.ts` §7's 409 was already placed after the
  // bars for the same reason (it discloses how many administrators the org has left); the two are
  // now consistent, and that consistency is the rule rather than two independent judgement calls.
  typed.route({
    method: "POST",
    url: "/api/v1/role-bindings",
    schema: {
      body: CreateRoleBindingRequestSchema,
      response: {
        201: RoleBindingSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema,
        422: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createRoleBinding",
        summary: "Grant a role to a subject at a scope object",
        tags: ["rbac"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = request.body;
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // §0 — SERIALIZE THE CHECK WITH THE ACT, BEFORE THE FIRST READ. Everything below reads
        // authority state (`roles`, `role_bindings`, the `member_of` closure) and then writes on the
        // strength of what it read. Under READ COMMITTED a concurrent `POST /relationships`
        // {member_of} or a concurrent revoke commits into that gap. Taken here rather than inside
        // the door's assert functions because `getRoleById` below is already a read, and a lock
        // acquired after a read protects nothing the read depends on.
        await lockOrgRoleAuthority(tx, auth.orgId);

        // `Idempotency-Key` PARITY (DESIGN §6: "every POST accepts an Idempotency-Key header"). Every
        // sibling create route honours it and this one did not, which is not cosmetic HERE: a grant
        // that already landed is refused by `role_bindings_grant_key` with a 409, so a client whose
        // 201 was lost to a dropped connection cannot tell its own retry apart from somebody else
        // having made the grant already — on the one door in the system that hands out authority.
        // With a key the retry replays the original 201 and its binding id.
        //
        // INSIDE the same `withTenantTx` as the write, the audit event and the Decision, so the
        // stored key and the mutation it guards commit or roll back together. The five refusals below
        // run INSIDE the callback, so a replayed key never re-evaluates them — which is correct: a
        // replay returns the decision that was already made and audited, it does not make a new one.
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKeyOf(request),
            route: "POST /role-bindings",
            requestBody: body,
            // SCOPED TO THE ACTOR, and this is the one route in the tree that passes it. The stored
            // replay is an authority record — binding id, subject, role, scope — and the key table is
            // ORG-scoped, so without this a principal holding nothing replays an administrator's
            // grant and reads it back. See `idempotency.ts`'s `actorObjectId` doc for why this is a
            // hash-basis change rather than a wider primary key.
            actorObjectId: auth.subjectObjectId
          },
          async () => {
            // 1 + 2 — the role, and whether it accepts new bindings at all.
            const role = await getRoleById(tx, auth.orgId, body.roleId);
            assertRoleAcceptsNewBindings(role, await builtInRoleNames(tx));

            // 3 — the two objects. `getObjectByIdOrUrnAnyType` refuses a SOFT-DELETED row by default,
            // which matters on both sides: a binding at a tombstoned scope is unreachable authority
            // nobody can revoke (this module's §5), and a binding to a tombstoned subject is a grant to
            // a principal that has been removed. A uuid is required by the schema, so the id-or-URN
            // helper is only ever handed an id here.
            const scopeObject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, body.scopeObjectId);
            const subject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, body.subjectId);
            assertRoleBindableAtScope(role, scopeObject);
            assertBindableSubject(subject);

            // 4 + 5 — the authority bars. Both measured at the binding's own scope.
            await assertMayWriteRoleBinding(tx, {
              orgId: auth.orgId,
              actorObjectId: auth.subjectObjectId,
              role,
              scopeObjectId: scopeObject.id,
              verb: "grant"
            });

            // 6 — THE SAME SUBJECT REFUSALS, APPLIED TO THE MEMBERS THIS BINDING WOULD EMPOWER
            // (`authz/role-binding-door.ts` §2b). `assertBindableSubject` above judges the named
            // subject; when that subject is a `group` or `team` the binding also reaches everything
            // `member_of` leads to, and NOTHING looked at that set before 2026-08-27. A no-op for a
            // `user`/`service-account` subject and for an empty group.
            //
            // AFTER THE AUTHORITY BARS — moved 2026-08-27, and the move is the fix, not a tidy-up.
            // This is the only refusal on the grant path whose message is derived from rows OTHER
            // than the ones the request names: it lists the ids, names and types of the principals
            // inside the group. Ahead of bar §1 it answered "who is in this group?" for any caller
            // who could reach the route, including one about to be refused for having no standing at
            // all. §7's 409 is placed after the bars for the identical reason. §2b's own reasoning —
            // that a standing-based refusal HERE could never fire, because no bar on this door reads
            // the subject's identity — is about what this check can DECIDE, and says nothing about
            // when it may speak.
            //
            // ONE MEMBERSHIP WALK, TWO JUDGEMENTS. `principalsReachedBy` is called here rather than
            // inside each check so §2b and §2c cannot be handed different answers about the same
            // group — which, under the org lock, they could only be if something raced, and two
            // refusals disagreeing about a concurrent write is the defect §2b exists to close.
            const reached = subjectTypeNeedsMembershipReview(subject.typeId)
              ? await principalsReachedBy(tx, auth.orgId, subject.id)
              : [];
            await assertGrantReachesOnlyBindableMembers(tx, {
              orgId: auth.orgId,
              role,
              scopeObjectId: scopeObject.id,
              subject,
              reached
            });

            // 7 — D7's ACKNOWLEDGEMENT (`authz/role-binding-door.ts` §2c, owner ruling 2026-08-27).
            // AFTER §2b, deliberately: §2b names a defect in the ESTATE that no retry fixes (a
            // tombstoned member), this one names a value the caller can re-read and resend, and
            // reporting the unfixable one first costs a round trip fewer. Both are behind the
            // authority bars for §2b's disclosure reason — both name other rows' ids.
            assertGrantAcknowledgesEmpoweredPrincipals({
              role,
              subject,
              reached,
              acknowledgedPrincipalIds: body.acknowledgedPrincipalIds
            });

            const binding = await insertRoleBinding(tx, {
              orgId: auth.orgId,
              subjectId: subject.id,
              roleId: role.id,
              roleName: role.name,
              scopeObjectId: scopeObject.id
            });

            const decision = await insertDecision(tx, {
              orgId: auth.orgId,
              kind: "role_binding",
              subjectId: binding.id,
              verdict: "allow",
              inputContext: {
                action: "grant",
                binding: {
                  id: binding.id,
                  subjectId: binding.subjectId,
                  roleId: binding.roleId,
                  roleName: binding.roleName,
                  scopeObjectId: binding.scopeObjectId,
                  scopeObjectTypeId: scopeObject.typeId,
                  effect: binding.effect
                },
                // The permission set as it stood AT THE MOMENT OF THE GRANT. A role's array is mutable
                // by migration (five have appended to the built-ins so far), so without this the record
                // of what was handed over drifts with the role. This is the "Decision record with its
                // inputs" charter principle 6 asks for.
                grantedPermissions: [...role.permissions].sort(),
                // D7 — WHOM THE GRANTER SAID THEY WERE EMPOWERING, as they said it. `null` for a
                // `user`/`service-account` subject, where the field is not demanded. The set was
                // verified equal to the live closure under §0's lock immediately before the insert,
                // so this is the membership AT THE MOMENT OF THE GRANT and not a claim — the same
                // reason `grantedPermissions` is stored rather than re-read from the role later.
                // Without it the estate can say what authority was handed over and not to whom.
                acknowledgedPrincipalIds: body.acknowledgedPrincipalIds
                  ? [...body.acknowledgedPrincipalIds].sort()
                  : null,
                actorId: auth.subjectObjectId,
                reason: body.reason
              },
              reasonTree: {
                summary:
                  `granted '${role.name}' to subject '${binding.subjectId}' at ` +
                  `${scopeObject.typeId} '${binding.scopeObjectId}' — every permission the role ` +
                  `carries was already held by the granting subject at that scope`,
                subsetRuleSatisfied: true
              }
            });

            await appendAuditEvent(tx, {
              orgId: auth.orgId,
              actorId: auth.subjectObjectId,
              action: "role_binding.grant",
              // The BINDING's id, so the revoke event below points at the same subject and the two
              // halves of a binding's life are one chain to follow. The principal who received the
              // authority is in the Decision's `inputContext.binding.subjectId`.
              subjectId: binding.id,
              reason: body.reason,
              decisionId: decision.id,
              requestId: request.id
            });

            return { status: 201 as const, body: binding };
          }
        );
      });
      reply.status(result.status as 201).send(result.body);
    }
  });

  // ===========================================================================================
  // DELETE /api/v1/role-bindings/{id} — REVOKE
  // ===========================================================================================
  //
  // THE SAME TWO AUTHORITY BARS AS A GRANT, and that is the half that is easy to leave out. Without
  // the subset rule here, a subject revokes the binding that OUTRANKS them: an OrgAdmin deletes the
  // org's Owner binding and the org is left with nobody who can put it back, using a permission
  // OrgAdmin holds by design. The bar is measured against the role of the binding BEING REVOKED, at
  // that binding's own scope.
  //
  // AND DELIBERATELY NOT the two GRANT-only refusals. Re-checking D5 would make every existing
  // `Administrator` binding immortal the day the role was deprecated — the exact opposite of a
  // deprecation — and re-checking `bindable_at` would make every binding written at a nonsensical
  // scope permanent, when cleaning those up is half the reason the column exists. See
  // `authz/role-binding-door.ts` §4.
  //
  // PLUS ONE REFUSAL THAT IS NOT AN AUTHORITY BAR AT ALL — the last-administrator 409
  // (`authz/role-binding-door.ts` §7). Both bars above pass legitimately when the org's only Owner
  // revokes their own org-root Owner binding: they hold `role_binding:write`, and Owner's permissions
  // are trivially a subset of Owner's. Measured on a fresh org, that request returned 200 and left
  // ZERO bindings — after which every endpoint 403s, `GET /roles` and `GET /role-bindings` included,
  // and nothing can restore a binding because restoring one needs the `role_binding:write` nobody now
  // holds. This route is the first and only API path that can DELETE a `role_bindings` row, so the
  // guard ships with the verb that creates the hazard.
  typed.route({
    method: "DELETE",
    url: "/api/v1/role-bindings/:id",
    schema: {
      params: RoleBindingIdParamSchema,
      body: DeleteRoleBindingRequestSchema,
      response: {
        200: RoleBindingSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        // The last-administrator floor (`authz/role-binding-door.ts` §7).
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "deleteRoleBinding",
        summary: "Revoke a role binding",
        tags: ["rbac"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const revoked = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // §0 — SERIALIZE THE CHECK WITH THE ACT, BEFORE `getRoleBindingById` READS. This is the
        // handler the [200, 200] brick was measured on: two concurrent revokes of the last two
        // org-root administrative bindings, each reading a survivor the other was about to delete,
        // both admitted, zero administrative bindings left, every endpoint 403 afterwards. The
        // transaction the comment below correctly insists on does not serialize that on its own —
        // READ COMMITTED gives every statement a fresh snapshot. See
        // `authz/role-binding-door.ts` §0.
        await lockOrgRoleAuthority(tx, auth.orgId);

        const binding = await getRoleBindingById(tx, auth.orgId, request.params.id);
        const role = await getRoleById(tx, auth.orgId, binding.roleId);

        await assertMayWriteRoleBinding(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          role,
          scopeObjectId: binding.scopeObjectId,
          verb: "revoke"
        });

        // THE ADMINISTRATOR FLOOR (`authz/role-binding-door.ts` §7) — DELETE FIRST, THEN ASK.
        //
        // This used to be `assertNotLastAdministrativeBinding`, evaluated BEFORE the delete and
        // excluding this row from its own count. That shape is why the floor guarded exactly one of
        // the three doors that can empty an org's administrators: a rule phrased as "what would be
        // left if I removed THIS binding" has to be re-derived, correctly, by every other door — and
        // `DELETE /relationships/{id}` (remove the `member_of` edge under a group's binding) and
        // `DELETE /objects/team/{id}` (tombstone the group holding it) each bricked an org in four
        // plain sequential requests while this guard counted the surviving row and reported success.
        //
        // The predicate is now the ORG's invariant, evaluated after the mutation and blind to which
        // verb ran, and `graph/relationships-repo.ts` and `graph/objects-repo.ts` call the SAME
        // function. AFTER both authority bars still holds: an actor with no standing must get a 403
        // about their standing, not a 409 disclosing how many administrators this org has left.
        //
        // INSIDE this `withTenantTx`, so a refusal rolls the DELETE back with it — the row survives
        // and the org stays administrable. The relevance test below is the cost short-circuit §7
        // documents; it is a statement about the floor's four inputs, not a filter over callers.
        await deleteRoleBindingById(tx, auth.orgId, binding.id);
        if (revokeAffectsAdministrativeFloor(auth.orgId, binding, role)) {
          await assertOrgRetainsAdministrativeFloor(tx, {
            orgId: auth.orgId,
            act:
              `revoking role binding '${binding.id}' ('${binding.roleName}' at the org root, ` +
              `which carries 'role_binding:write')`
          });
        }

        const decision = await insertDecision(tx, {
          orgId: auth.orgId,
          kind: "role_binding",
          subjectId: binding.id,
          verdict: "allow",
          inputContext: {
            action: "revoke",
            // The whole row, because it is GONE after this transaction — `role_bindings` has no
            // `deleted_at` and `scp_app` was granted a real DELETE in drizzle/0097 §4 so that a
            // revoke could actually revoke. If this object is not complete, the estate cannot say
            // afterwards what authority was removed from whom.
            binding: {
              id: binding.id,
              subjectId: binding.subjectId,
              roleId: binding.roleId,
              roleName: binding.roleName,
              scopeObjectId: binding.scopeObjectId,
              effect: binding.effect,
              createdAt: binding.createdAt
            },
            revokedPermissions: [...role.permissions].sort(),
            actorId: auth.subjectObjectId,
            reason: request.body.reason
          },
          reasonTree: {
            summary:
              `revoked '${binding.roleName}' from subject '${binding.subjectId}' at scope ` +
              `'${binding.scopeObjectId}'`,
            loosening: binding.effect === "deny"
          }
        });

        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "role_binding.revoke",
          subjectId: binding.id,
          reason: request.body.reason,
          decisionId: decision.id,
          requestId: request.id
        });

        return binding;
      });
      reply.status(200).send(revoked);
    }
  });
}
