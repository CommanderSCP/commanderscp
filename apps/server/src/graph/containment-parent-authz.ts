import type { ContainmentDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { hasPermission, type Permission } from "../authz/resolve.js";
import { badRequest, forbidden } from "../errors.js";
import { resolveContainmentParent } from "./objects-repo.js";

/**
 * THE ONE PLACE A CALLER-SUPPLIED `domainId` BECOMES A CONTAINMENT PARENT.
 *
 * `objects.domain_id` is not an ordinary column, and the two things that make it special are both
 * invisible at the call site that writes it:
 *
 *  1. **It is authorization-bearing.** RBAC scope expansion runs strictly UPWARD
 *     (`authz/resolve.ts`'s `scopeExpandCte`), so an object's containment parent decides *who else*
 *     holds authority over it. Re-parenting X under V hands every holder of a binding at-or-above V
 *     custody of X. A door that authorizes a move only at X therefore lets an actor whose entire
 *     authority is "write this one object" plant it inside a stranger's subtree — a privilege
 *     ESCALATION dressed as a field edit. A move is a write at two places and must be authorized at
 *     both ends.
 *  2. **`null` is not a containment parent.** The column has no FK and no CHECK
 *     (`drizzle/0001_graph_core.sql:32`), so `NULL` is writable — and a row with `domain_id IS NULL`
 *     is DETACHED: its scope expansion terminates at itself, so no ancestor binding, *not even the
 *     org root Owner's*, can ever reach it again. It cannot be read, edited, moved back or deleted
 *     through the API by anyone. Governance does not stop, either: policy matching reads only
 *     `properties.scope` and never the policy row's own placement (`governance/policy-scope-authz.ts`
 *     documents that at length), so a detached row keeps being governed while becoming ungovernable.
 *     `NULL` therefore means exactly one thing in this system — "I AM the org root" — and is written
 *     by exactly one caller, org bootstrap (`auth/local-auth.ts`).
 *
 * ## What a wire `null` means, and why
 *
 * **`null` on a request body means "the default containment parent" — the org root — never
 * "detach".** Two doors already coerced it that way by hand (`routes/typed-registries.ts` and
 * `routes/objects-generic.ts`, both POST: `containmentDomainIdFromWire(...) ?? undefined`) and four
 * did not (both PUT create branches, `POST /components`, and `PUT /components/{urn}`'s create
 * branch), while every update door wrote the `null` straight through. That asymmetry — not either
 * meaning on its own — was the defect: the same body produced an org-root child through one door and
 * an unreachable orphan through another.
 *
 * Of the two candidate meanings, "default parent" is the only one that is expressible. "Detach" has
 * no representation in a model whose authority, containment and audit chains all terminate at the
 * org root, and a verb that produces a row nobody can subsequently touch is not a feature. Note the
 * meaning is *not* "unspecified": on an UPDATE, an omitted `domainId` leaves the parent alone, while
 * an explicit `null` moves the row to the org root — and, being a move, is authorized there.
 *
 * ## Why a helper called by every door rather than a check inside the repo
 *
 * The same split `federation/domain-local.ts` argues for, and for the same reason:
 * **authorization at the door, invariant at the repo.** `updateObject`/`upsertObjectByUrn` are also
 * the path the federation importer, IaC apply and internal machinery take, and their
 * `actorObjectId` is a synthetic subject that holds no bindings — running an `authorize()` down
 * there would abort every import rather than protect anything. What the repo owns is the invariant
 * half: `resolveContainmentParent` (called from here) is what rejects a `domainId` naming an object
 * outside the org, and `createObject` still resolves the default parent for itself.
 *
 * The risk that a NEW door forgets to call this is handled the way this codebase already handles it
 * for ADR-0022 and ADR-0031's route sets — by a census test that enumerates every door whose body
 * schema admits `domainId` and asserts each one refuses a move it must refuse
 * (`routes/containment-move-authz.integration.test.ts`).
 */
export interface DeclaredContainmentParent {
  orgId: string;
  subjectObjectId: string;
  /** The permission the door itself gates writes on — 'object:write', or 'policy:write' for the
   *  governance registries. The destination is held to the SAME bar as the object, never a weaker
   *  one. */
  permission: Permission;
  /** The request body's `domainId`, verbatim (after `containmentDomainIdFromWire`). */
  declared: ContainmentDomainId | null | undefined;
  /**
   * The row as it stands, or `undefined` when this write CREATES it.
   *
   * A create needs no destination check *here*: every create door already authorizes at the
   * resolved parent, because for a new object that parent is the only scope there is. Passing the
   * row rather than a boolean keeps the two questions this function asks — "is this a move?" and
   * "would it make the row its own parent?" — answerable without a second lookup.
   */
  current: { id: string; domainId: string | null } | undefined;
}

/**
 * Resolves a caller-supplied `domainId` into the value to write, authorizing it as a MOVE when it
 * is one. Returns `undefined` when the caller named no parent — which `createObject` reads as
 * "default to the org root" and `updateObject` reads as "leave the parent alone".
 *
 * @throws 400 when the id names nothing in this org, or would make the row its own parent.
 * @throws 403 when the caller lacks `permission` at-or-above the DESTINATION.
 */
export async function resolveDeclaredContainmentParent(
  tx: TenantTx,
  input: DeclaredContainmentParent
): Promise<ContainmentDomainId | undefined> {
  if (input.declared === undefined) return undefined;

  // `?? undefined` is where a wire `null` becomes "the default parent". `resolveContainmentParent`
  // reads a bare `null` as "this object IS the org root", which is a bootstrap-only claim no request
  // body may make — see the module doc.
  const destination = (await resolveContainmentParent(tx, input.orgId, input.declared ?? undefined))
    .id;
  if (destination === null) {
    // Unreachable: `resolveContainmentParent` returns a null id only for a literal `null` argument,
    // which the coercion above rules out. Thrown rather than returned so a future change to that
    // contract surfaces here instead of writing a detached row.
    throw new Error("internal: a declared containment parent resolved to NULL");
  }

  const current = input.current;
  if (current === undefined) return destination;

  // Re-stating the CURRENT parent is not a move, so it demands no authority at it. Load-bearing:
  // `PUT` is defined as idempotent here and `scp apply` re-sends unchanged rows routinely, so
  // treating a restatement as a privilege demand would make an unchanged re-apply start failing for
  // every author who does not also hold authority over their own object's container.
  if (destination === current.domainId) return destination;

  if (destination === current.id) {
    throw badRequest(
      `object '${current.id}' cannot be its own containment parent — a containment cycle has no ` +
        `org-root ancestor, so nothing could authorize, govern or audit the objects beneath it`
    );
  }

  const allowed = await hasPermission(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    permission: input.permission,
    scopeObjectId: destination
  });
  if (!allowed) {
    // Names the DESTINATION, not the object. An operator who reads this must be able to tell "you
    // may not edit this object" from "you may not put it there" — they have different remedies.
    throw forbidden(
      `cannot move object '${current.id}' into container '${destination}': you lack ` +
        `'${input.permission}' at-or-above that destination. A containment parent decides who else ` +
        `holds authority over the object (authz scope expands upward), so a move is authorized at ` +
        `both ends, not only at the object being moved.`
    );
  }
  return destination;
}
