/**
 * THE AUTHORING DOOR FOR `config-source` — a row of that type is an IDENTITY DELEGATION, so
 * writing one demands authority over the identity being delegated (ADR-0046 §1; migration 0100's
 * header; team-pipeline-iac §4, D9).
 *
 * ================================================================================================
 * WHAT THE ROW GRANTS, AND WHY PLAIN `object:write` IS NOT THE RIGHT BAR
 * ================================================================================================
 * A config source says "manifests matching these globs, in this repo, at this ref, apply AS THIS
 * TEAM." The sync loop passes that team's object id in as `actorObjectId`, and `authz/resolve.ts`
 * seeds its CTE AT THE SUBJECT — so the team's own role bindings resolve at depth 0 and everything
 * the team may write, the repo may now write.
 *
 * That is the same escalation shape a `member_of` edge has, and this codebase already refuses that
 * one at both endpoints for exactly this reason (`routes/relationships.ts`'s module doc: "a
 * from-side-only check would let any subject with `relationship:write` somewhere add themselves
 * `member_of` an arbitrary team and inherit its role bindings"). Without the check below, an actor
 * holding `object:write` at any scope they own could mint a `config-source` naming ANOTHER team,
 * pointed at a repo they control, and the sync loop would faithfully apply their manifest with that
 * team's authority. The per-diff-entry `authorize()` ADR-0046 leans on would not save it: the
 * checks would run as the delegated team, and pass.
 *
 * THE BAR IS `role_binding:write` AT THE NAMED TEAM'S OWN OBJECT — not `object:write`. Delegating
 * an identity is a GRANT, not an edit: `object:write` at a team is the permission to rename it or
 * fix its description, which a team's own members plausibly hold, whereas `role_binding:write` is
 * already this codebase's spelling of "may decide what authority this subject carries" (seeded on
 * `Administrator` and `Owner` only, `drizzle/0002_rls_rbac_seed.sql:216-223`). Registering a repo
 * as a team is nearer the second.
 *
 * ================================================================================================
 * WHY IT IS INSTALLED IN `graph/objects-repo.ts` AND NOT ON A ROUTE
 * ================================================================================================
 * The same reason the five authoring refusals already there are (`objects-repo.ts`'s own comments,
 * and `governance-managed-types.ts`'s header): `POST /objects/{type}`, `POST /plans` + apply,
 * `POST /federation/hand-fill` and `POST /federation/overlays` all reach `createObject` /
 * `updateObject` with a free-form `typeId` and free-form `properties`. A per-route install is four
 * lists that must agree; a choke-point install is one rule that cannot be forgotten at a door that
 * did not exist when it was written.
 *
 * `federationImport` is exempt, on the identical ground stated at every other guard there and in
 * ADR-0033 §8: that branch has no try/catch, so a throw aborts the peer's whole signed bundle and
 * wedges the channel. The refusal belongs at the AUTHORING instance — and a config source that
 * arrives over the journal was authored at one, where this door ran.
 */

import { authorize } from "../authz/resolve.js";
import { badRequest } from "../errors.js";
import { findObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  CONFIG_SOURCE_TYPE_ID,
  delegatedTeamRefs,
  parseConfigSourceDocument
} from "./config-source-document.js";

export interface ConfigSourceAuthoringInput {
  orgId: string;
  actorObjectId: string;
  typeId: string;
  properties: Record<string, unknown>;
  /** How the refusal names the row — e.g. `config-source 'payments-fleet'`. */
  subject: string;
}

/**
 * Refuse a malformed or over-reaching `config-source` write. A no-op for every other type, so the
 * choke point pays one string comparison.
 *
 * Ordering inside is deliberate and matches the convention at the call site: the SYNCHRONOUS shape
 * refusal runs first, so a document that could never be valid is rejected before anything pays for
 * a database round trip.
 */
export async function assertConfigSourceAuthoring(
  tx: TenantTx,
  input: ConfigSourceAuthoringInput
): Promise<void> {
  if (input.typeId !== CONFIG_SOURCE_TYPE_ID) return;

  const document = parseConfigSourceDocument(input.properties, input.subject);

  for (const teamRef of delegatedTeamRefs(document)) {
    const team = await findObjectByIdOrUrnAnyType(tx, input.orgId, teamRef);
    // AN UNRESOLVABLE REFERENCE IS A REFUSAL, NEVER A SKIPPED CHECK. The tempting alternative —
    // "no such object, so there is nothing to authorize against, carry on" — is the exact shape
    // that turns an authority check into a formality: name a team that does not exist yet, get the
    // row written, create the team afterwards. It is also useless in the honest case: a config
    // source naming a team nobody can resolve can never apply anything.
    if (!team) {
      throw badRequest(
        `${input.subject}: names team '${teamRef}', which does not resolve to any object in this ` +
          `org — a config source applies AS the team it names, so the team must exist before the ` +
          `registration that delegates to it`
      );
    }
    if (team.typeId !== "team") {
      throw badRequest(
        `${input.subject}: names '${teamRef}', which is a '${team.typeId}' and not a 'team' — a ` +
          `config source delegates a team identity; delegating a user's or a group's would let a ` +
          `repository act as that subject, which no part of this design intends`
      );
    }
    // THROWS 403 (`authorize`), which is the right code even though the surrounding shape refusals
    // are 400s: the document is well-formed and the answer is "not by you".
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission: "role_binding:write",
      scopeObjectId: team.id
    });
  }
}
