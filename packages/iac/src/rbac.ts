import type { ManifestRole, ManifestRoleBinding } from "@scp/schemas";
import { Stack } from "./construct.js";
import type { IResourceRef } from "./construct.js";

/** TYPED RBAC CONSTRUCTS. See docs/iac/rbac.md §1. */

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

/** Grants a role to a `user` or `service-account` at a scope. See docs/iac/rbac.md §2. */
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

/** Declares an organization-defined role. See docs/iac/rbac.md §3. */
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
