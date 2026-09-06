import type { ManifestRole, ManifestRoleBinding } from "@scp/schemas";
import { Stack } from "./construct.js";
import type { IResourceRef } from "./construct.js";

/**
 * TYPED RBAC CONSTRUCTS (L2) — `RoleBinding` and `OrgRole`, thin sugar over the manifest contract.
 *
 * ================================================================================================
 * WHY THESE EMIT THROUGH THE L1 DOORS
 * ================================================================================================
 * Every construct here ends in `stack.addRoleBinding(...)` / `addRole(...)` — the same hatches a
 * hand-authoring caller uses. D16(1)'s "an L1-authored entry and its L2 equivalent synthesize
 * identically" is then true BY CONSTRUCTION rather than by two code paths agreeing, which matters
 * because generated files and standards packages author through L1 and would otherwise drift
 * invisibly until somebody diffed two manifests.
 *
 * ================================================================================================
 * WHAT THIS DELIBERATELY CANNOT EXPRESS: A BINDING TO A GROUP OR TEAM
 * ================================================================================================
 * {@link RoleBinding} REFUSES a `group` or `team` subject at synth. That is the one substantive
 * design decision in this module and it narrows the surface rather than guarding it.
 *
 * D7 requires the granter to acknowledge every principal a group binding empowers, compared by SET
 * EQUALITY at the door. In a manifest that value is a MEMBERSHIP SNAPSHOT, and it goes stale the
 * moment anyone joins or leaves. The failure that produces is not "the snapshot is wrong" — it is
 * that a stale-snapshot refusal TRAINS THE AUTHOR TO STOP READING IT. They paste whatever the last
 * error named, and a control whose entire purpose is that a human looks at the current membership
 * becomes a checksum updated mechanically. Refusing here sends them to
 * `scp role-binding grant-preview` + `create`, where the set is read at the moment of granting.
 *
 * The refusal lives in this L2 layer rather than in `Stack.addRoleBinding` because the L1 door
 * takes URNs it cannot resolve to a type at synth time. A construct knows what it was handed.
 *
 * ================================================================================================
 * WHO APPLIES IS WHO IS JUDGED
 * ================================================================================================
 * `authz/role-binding-door.ts`'s no-escalation subset rule is evaluated against the APPLYING
 * principal, which for a config-source sync is the TEAM object (ADR-0046 §1 / D9) and for the
 * reconciler is a system actor. So a declared binding is refused unless the applier already holds
 * every permission that role carries at that scope — meaning **a team's own repo cannot bootstrap
 * that team's permissions**. That is the rule working rather than a gap, and it is stated here
 * because the symptom (an apply that refuses a line the author believes is correct) is otherwise
 * hard to attribute.
 *
 * Note also that `prepareApplyChecks` runs every authorization check to completion BEFORE any
 * mutation, in one transaction. A binding whose legality depends on a role created in the SAME
 * manifest is therefore judged against the graph as it stood BEFORE the apply, and is refused.
 * Split such a manifest in two; failing closed is deliberate.
 */

/** Subject types a manifest may bind a role to — see the module doc for why groups are excluded. */
const BINDABLE_SUBJECT_TYPES = ["user", "service-account"] as const;

export interface RoleBindingProps {
  /** The principal receiving the authority. A construct ref, or a URN string. */
  subject: IResourceRef | string;
  /** Built-in name (`Owner`, `OrgAdmin`, …) or an org role's name. */
  role: string;
  scope: IResourceRef | string;
  /** Mandatory — the operator's own words, which the Decision cannot reconstruct. */
  reason: string;
}

/**
 * Grants a role to a `user` or `service-account` at a scope.
 *
 * ```ts
 * new RoleBinding(stack, "ci-deployer", {
 *   subject: ciAccount,
 *   role: "ComponentAdmin",
 *   scope: checkoutComponent,
 *   reason: "CI deploys checkout"
 * });
 * ```
 */
export class RoleBinding {
  constructor(stack: Stack, id: string, props: RoleBindingProps) {
    assertBindableSubject(props.subject, id);
    stack.addRoleBinding(
      {
        subjectUrn: urnOf(props.subject),
        roleName: props.role,
        scopeUrn: urnOf(props.scope),
        reason: props.reason
      } satisfies ManifestRoleBinding,
      `${stack.stackName}/${id}`
    );
  }
}

export interface OrgRoleProps {
  /** Unique within the org, and refused if it collides with a built-in name. */
  name: string;
  /** Must all be permissions this system defines AND ones the APPLYING principal holds at the org
   *  root. A role that advertises authority its author cannot confer is refused at the door. */
  permissions: string[];
  /** Object type ids this role may be bound at. Omit for any scope. */
  bindableAt?: string[];
  reason: string;
}

/**
 * Declares an organization-defined role.
 *
 * ```ts
 * new OrgRole(stack, "release-captain", {
 *   name: "Release Captain",
 *   permissions: ["object:read", "change:accept"],
 *   reason: "seat the release team"
 * });
 * ```
 */
export class OrgRole {
  constructor(stack: Stack, id: string, props: OrgRoleProps) {
    stack.addRole(
      {
        name: props.name,
        permissions: props.permissions,
        ...(props.bindableAt ? { bindableAt: props.bindableAt } : {}),
        reason: props.reason
      } satisfies ManifestRole,
      `${stack.stackName}/${id}`
    );
  }
}

/**
 * Refuses a group/team subject with the reason and the alternative, not just a rejection.
 *
 * A construct ref carries its type; a bare URN string is checked on the `:group:`/`:team:` segment
 * that `urn:scp:<org>:<type>:<name>` always has. A URN whose type cannot be read is ALLOWED — this
 * is a helpfulness guard at the authoring layer, and the API refuses a genuinely bad subject
 * regardless. Failing closed on an unparseable URN would reject legitimate external references for
 * a shape this layer has no business policing.
 */
function assertBindableSubject(subject: IResourceRef | string, constructId: string): void {
  const typeId = typeof subject === "string" ? typeFromUrn(subject) : subject.typeId;
  if (typeId === undefined) return;
  if ((BINDABLE_SUBJECT_TYPES as readonly string[]).includes(typeId)) return;

  throw new Error(
    `RoleBinding "${constructId}" names a '${typeId}' subject, which a manifest cannot bind.\n` +
      `Only ${BINDABLE_SUBJECT_TYPES.join(" and ")} subjects are declarable in IaC.\n\n` +
      `Binding a role to a group or team requires acknowledging every principal it empowers ` +
      `(D7), compared by set equality at the door. In a manifest that is a membership SNAPSHOT: ` +
      `it goes stale the moment anyone joins, and re-pasting whatever the refusal named turns a ` +
      `control that exists to make a human look into a checksum nobody reads.\n\n` +
      `Use:  scp role-binding grant-preview <subjectId>\n` +
      `then: scp role-binding create --subject … --role … --scope … --acknowledge …`
  );
}

/** `urn:scp:<org>:<type>:<name>` — the type is the fourth colon-separated segment. */
function typeFromUrn(urn: string): string | undefined {
  const parts = urn.split(":");
  return parts.length >= 5 && parts[0] === "urn" && parts[1] === "scp" ? parts[3] : undefined;
}

function urnOf(ref: IResourceRef | string): string {
  return typeof ref === "string" ? ref : ref.urn;
}
