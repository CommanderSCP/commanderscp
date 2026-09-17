import type { DependencyManagement } from "@scp/schemas";
import type { ServerConfig } from "../config.js";

/** The one predicate for may this deployment automate. See docs/dependencies.md §143. */

export type CommanderOnlyConfig = Pick<
  ServerConfig,
  "role" | "federationRole" | "federationRoleDeclared"
>;

export interface CommanderOnlyVerdict {
  readonly allowed: boolean;
  /** Why — carried so a refusal is LOGGED (a job) or RETURNED (a route) rather than being a silent
   *  no-op. A capability that runs nowhere and says nothing is this codebase's worst failure mode. */
  readonly reason: string;
}

/** Why a capability is commander-only — the half of a refusal that differs per capability. The
 *  CHECK is not parameterized: every caller shares the one predicate below, including its
 *  fail-closed undeclared branch. */
export interface CommanderOnlyRationale {
  /** Closes the UNDECLARED refusal: the rule, with its authority. */
  readonly rule: string;
  /** Closes the NOT-COMMANDER refusal: why the capability does not belong on this deployment. */
  readonly why: string;
}

/** The dependency-automation rationale (ADR-0032 §7d) — the default, as it was the first caller. */
export const DEPENDENCY_AUTOMATION_RATIONALE: CommanderOnlyRationale = {
  rule: "all dependency automation runs on the commander only (ADR-0032 §7d)",
  why:
    `Dependency automation exists to ` +
    `pull from PUBLIC repositories (python library versions, CDK versions, base-image ` +
    `versions), which an outpost has no need to do: the resulting change is pushed down the ` +
    `global pipeline the commander manages, so an outpost RECEIVES a dependency bump through ` +
    `the ordinary promotion path and never originates one. Dependencies declared in ` +
    `domain-specific repositories the commander never sees are out of scope (ADR-0032 §7d)`
};

/** The deployment's install-time federation role, as every role verdict here reads it. */
export type FederationRoleConfig = Pick<ServerConfig, "federationRole" | "federationRoleDeclared">;

const COMMANDER_ONLY: ReadonlySet<string> = new Set(["commander"]);

/** THE RULE, ONCE: a role passes only when it was DECLARED and is one of `permitted`. An undeclared
 *  role is its own answer and is checked first — whatever value it reads. Every verdict below (this
 *  deployment; a paired peer; cosign key custody) asks this and only words the refusal. */
function federationRoleRefusal(
  role: string | null | undefined,
  declared: boolean,
  permitted: ReadonlySet<string>
): "undeclared" | "not_permitted" | null {
  if (!declared) return "undeclared";
  if (typeof role !== "string" || !permitted.has(role)) return "not_permitted";
  return null;
}

function commanderOnlyRefusal(
  role: string | null | undefined,
  declared: boolean
): "undeclared" | "not_commander" | null {
  const refusal = federationRoleRefusal(role, declared, COMMANDER_ONLY);
  return refusal === "not_permitted" ? "not_commander" : refusal;
}

/** WHO MAY HOLD THE INSTANCE COSIGN SIGNING KEY (owner, 2026-09-16; component-journey-view.md §8.9):
 *  the commander, which signs promotion manifests, and a retrans, which signs the transport
 *  integrity of bytes it has validated and relays (ADR-0019). An outpost only validates. */
const COSIGN_KEY_CUSTODIANS: ReadonlySet<string> = new Set(["commander", "retrans"]);

/** May this deployment mint, read, or serve its instance cosign key? Refused on an outpost and,
 *  FAIL-CLOSED, on an undeclared role. See {@link COSIGN_KEY_CUSTODIANS}. */
export function cosignKeyCustodyVerdict(config: FederationRoleConfig): CommanderOnlyVerdict {
  const refusal = federationRoleRefusal(
    config.federationRole,
    config.federationRoleDeclared,
    COSIGN_KEY_CUSTODIANS
  );
  if (refusal === "undeclared") {
    return {
      allowed: false,
      reason:
        `SCP_FEDERATION_ROLE is not declared on this deployment, so it holds no cosign signing key ` +
        `(refused FAIL-CLOSED — the setting defaults to 'commander', which cannot be told apart from ` +
        `an outpost that omits it). Declare it explicitly (Helm: 'federationRole'); only a commander ` +
        `or a retrans holds one (component-journey-view.md §8.9)`
    };
  }
  if (refusal === "not_permitted") {
    return {
      allowed: false,
      reason:
        `SCP_FEDERATION_ROLE is '${config.federationRole}' — an outpost holds no cosign signing key. ` +
        `Only the commander signs a promotion manifest, and only a retrans signs the transport ` +
        `integrity of the bytes it relays; an outpost validates both (owner, 2026-09-16; ` +
        `component-journey-view.md §8.9)`
    };
  }
  return {
    allowed: true,
    reason: `SCP_FEDERATION_ROLE is explicitly '${config.federationRole}', a cosign key custodian`
  };
}

/** THE FEDERATION AXIS ALONE. See docs/dependencies.md §144. */
export function commanderOnlyFederationVerdict(
  config: Pick<ServerConfig, "federationRole" | "federationRoleDeclared">,
  what: string,
  rationale: CommanderOnlyRationale = DEPENDENCY_AUTOMATION_RATIONALE
): CommanderOnlyVerdict {
  const refusal = commanderOnlyRefusal(config.federationRole, config.federationRoleDeclared);
  if (refusal === "undeclared") {
    return {
      allowed: false,
      reason:
        `SCP_FEDERATION_ROLE is not declared on this deployment, so ${what} is refused FAIL-CLOSED. ` +
        `The setting DEFAULTS to 'commander' — right for "may I serve the SPA?", wrong for "am I ` +
        `the commander?" — so an outpost that predates the setting, or a chart that omits it, is ` +
        `indistinguishable from a commander here. Declare it explicitly (Helm: 'federationRole'); ` +
        rationale.rule
    };
  }
  if (refusal === "not_commander") {
    return {
      allowed: false,
      reason:
        `SCP_FEDERATION_ROLE is '${config.federationRole}' — ${what} is COMMANDER-ONLY, and this ` +
        `deployment is not the commander. RUN IT ON THE COMMANDER. ` +
        rationale.why
    };
  }
  return {
    allowed: true,
    reason: `SCP_FEDERATION_ROLE is explicitly 'commander', so ${what} runs here`
  };
}

/** The roles a peer can be DECLARED as at pairing (`PairPeerRequestSchema`). A stored value outside
 *  this set — a pre-0020 'parent'/'child' that escaped the rename, or anything hand-written — is
 *  not a declaration, so it takes the undeclared branch. */
const DECLARABLE_PEER_ROLES: ReadonlySet<string> = new Set(["commander", "outpost", "retrans"]);

/** THE SAME RULE, ASKED OF A PAIRED PEER — the importer's half of component-journey-view.md §8.9:
 *  only a peer this domain paired as 'commander' may originate a promotion. The peer's role is the
 *  operator's declaration at pairing (`federation_peers.role`, NOT NULL, one writer). */
export function commanderOnlyPeerVerdict(
  peer: { readonly name: string; readonly role: string | null | undefined },
  what: string,
  rationale: CommanderOnlyRationale
): CommanderOnlyVerdict {
  const declared = typeof peer.role === "string" && DECLARABLE_PEER_ROLES.has(peer.role);
  const refusal = commanderOnlyRefusal(peer.role, declared);
  if (refusal === "undeclared") {
    return {
      allowed: false,
      reason:
        `peer '${peer.name}' has no recognised declared role ('${String(peer.role)}'), so ${what} ` +
        `is refused FAIL-CLOSED. Re-pair it with an explicit --role; ${rationale.rule}`
    };
  }
  if (refusal === "not_commander") {
    return {
      allowed: false,
      reason:
        `peer '${peer.name}' is paired as '${peer.role}' — ${what} is COMMANDER-ONLY, and that peer ` +
        `is not the commander. ${rationale.why}`
    };
  }
  return {
    allowed: true,
    reason: `peer '${peer.name}' is paired as 'commander', so ${what} proceeds`
  };
}

/** BOTH AXES — the question a BACKGROUND JOB asks. See docs/dependencies.md §145. */
export function commanderOnlyJobVerdict(
  config: CommanderOnlyConfig,
  what: string
): CommanderOnlyVerdict {
  if (config.role !== "all" && config.role !== "worker") {
    return {
      allowed: false,
      reason: `SCP_ROLE is '${config.role}' — background work belongs to an 'all' or 'worker' process`
    };
  }
  const federation = commanderOnlyFederationVerdict(config, what);
  if (!federation.allowed) return federation;
  return {
    allowed: true,
    reason: `background-work process on an explicitly-declared commander — ${what} runs here`
  };
}

/** The capability name interpolated into the verdict {@link dependencyManagementOf} reads. It is the
 *  WHOLE feature rather than one job, because that is what the envelope answers about. */
const DEPENDENCY_MANAGEMENT_CAPABILITY = "dependency management";

/** THE SAME QUESTION, SHAPED FOR AN API RESPONSE. See docs/dependencies.md §146. */
export function dependencyManagementOf(
  config: Pick<ServerConfig, "federationRole" | "federationRoleDeclared">
): DependencyManagement {
  return {
    managedHere: commanderOnlyFederationVerdict(config, DEPENDENCY_MANAGEMENT_CAPABILITY).allowed,
    // UNDECLARED IS ITS OWN ANSWER, and it is checked FIRST — `config.federationRole` reads
    // 'commander' on an undeclared deployment, so labelling from the value alone would report the
    // exact opposite of what happens there (the fail-closed branch, ADR-0032 §7d).
    reason: config.federationRoleDeclared ? config.federationRole : "role_undeclared"
  };
}
