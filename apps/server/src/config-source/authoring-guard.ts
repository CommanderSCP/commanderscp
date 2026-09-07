/** THE AUTHORING DOOR FOR `config-source`. See docs/config-source.md §1. */

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

/** Refuse a malformed or over-reaching `config-source` write. See docs/config-source.md §2. */
export async function assertConfigSourceAuthoring(
  tx: TenantTx,
  input: ConfigSourceAuthoringInput
): Promise<void> {
  if (input.typeId !== CONFIG_SOURCE_TYPE_ID) return;

  const document = parseConfigSourceDocument(input.properties, input.subject);

  for (const teamRef of delegatedTeamRefs(document)) {
    const team = await findObjectByIdOrUrnAnyType(tx, input.orgId, teamRef);
    // An unresolvable reference is a refusal, not a skipped check. See docs/config-source.md §3.
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
