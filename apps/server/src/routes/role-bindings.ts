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

/** `GET /roles` + `GET/POST/DELETE /role-bindings`. See docs/routes.md §380. */
export function registerRoleBindingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // The read-only role catalogue, and why it is read-only. See docs/routes.md §381.
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

  // POST / PATCH / DELETE /api/v1/roles. See docs/routes.md §382.

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
        // A BUILT-IN IS NOT EDITABLE THROUGH ANY ORG'S API. See docs/routes.md §383.
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
            // The blast radius, recorded because nothing re-checks it. See docs/routes.md §384.
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

        // REFUSES WITH BINDINGS, rather than cascading. See docs/routes.md §385.
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

  // Who holds what and where, gated on audit read. See docs/routes.md §386.
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

  // What the acknowledgement must say, previewed. See docs/routes.md §387.
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

        // §2d — THE PROJECTION FILTER. See docs/routes.md §388.
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

  // Grant: the order of the five refusals is deliberate. See docs/routes.md §389.
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
        // §0 — SERIALIZE THE CHECK WITH THE ACT, BEFORE THE FIRST READ. See docs/routes.md §390.
        await lockOrgRoleAuthority(tx, auth.orgId);

        // Idempotency-key parity, as every other post has. See docs/routes.md §391.
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKeyOf(request),
            route: "POST /role-bindings",
            requestBody: body,
            // Scoped to the actor, the one route that passes it. See docs/routes.md §392.
            actorObjectId: auth.subjectObjectId
          },
          async () => {
            // 1 + 2 — the role, and whether it accepts new bindings at all.
            const role = await getRoleById(tx, auth.orgId, body.roleId);
            assertRoleAcceptsNewBindings(role, await builtInRoleNames(tx));

            // 3 — the two objects. See docs/routes.md §393.
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

            // The same subject refusals, applied to the members. See docs/routes.md §394.
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

            // The acknowledgement, per the owner ruling. See docs/routes.md §395.
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
                // Whom the granter said they were empowering. See docs/routes.md §396.
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

  // Revoke: the same two authority bars as a grant. See docs/routes.md §397.
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
        // The last-administrator floor (`docs/authz/role-binding-door.md` §7).
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
        // Serialize the check with the act, before the read. See docs/routes.md §398.
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

        // THE ADMINISTRATOR FLOOR. See docs/routes.md §399.
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
