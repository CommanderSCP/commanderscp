import { authorize } from "../authz/resolve.js";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * ADR-0031 — the rule for **declaring** that an object never federates.
 *
 * This module is the decision's home in code, the way `federation/outpost-binding.ts` is the home
 * of ADR-0022's authority-split rule. The filtering half lives in `federation/scope-filter.ts`; the
 * immutability half is structural in `graph/objects-repo.ts` (only the INSERT names the column).
 *
 * ## Why declaring locality is a `federation:write` act
 *
 * `object:write` is the permission for describing your estate. `domain_local` does something
 * categorically different: it determines whether a row's existence is ever visible outside its own
 * security domain. ADR-0022 already drew this line for the mirror-image case — commander-declared
 * outpost config is gated on `federation:write` specifically so the generic `/objects/{type}` door
 * and the IaC plan-apply path cannot write a boundary-governing property with the weaker
 * permission. The same argument applies here in the opposite direction, so it gets the same answer.
 *
 * ## Why this is a helper called by six doors rather than one choke point in the repo
 *
 * `createObject`/`upsertObjectByUrn` take a `TenantTx` and no subject, deliberately — they are also
 * the path the *federation importer* and internal machinery use, neither of which has an authorizing
 * actor. Pushing an authorization check down there would mean inventing a synthetic subject for
 * those callers, which is how an authorization check quietly becomes a no-op.
 *
 * The honest structure is therefore: **authorization at the door, invariant at the repo.** The repo
 * guarantees the property that actually matters and that no forgotten call site can break —
 * immutability — by never naming the column in an UPDATE. This helper guarantees the weaker,
 * per-request property, and the risk that a *new* door forgets to call it is handled the way this
 * codebase already handles it for ADR-0022's routes: by a census test that enumerates every route
 * whose body schema admits the field and asserts each one refuses an `object:write`-only actor
 * (`domain-local-rbac.integration.test.ts`, mirroring `outposts-rbac.integration.test.ts`).
 *
 * ## Asymmetric on purpose
 *
 * Only `true` is gated. Omitting the field, or sending `false`, is the overwhelmingly common case
 * and the status quo — requiring `federation:write` to create an ordinary object would be a
 * permission regression affecting every existing caller, to guard a value that changes nothing.
 */
export async function assertMayDeclareDomainLocal(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    scopeObjectId: string;
    /** The request body's `domainLocal`, verbatim — `undefined` and `false` both no-op. */
    requested: boolean | undefined;
  }
): Promise<void> {
  if (input.requested !== true) return;
  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    permission: "federation:write",
    scopeObjectId: input.scopeObjectId
  });
}
