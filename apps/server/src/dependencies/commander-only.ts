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

/** THE FEDERATION AXIS ALONE. See docs/dependencies.md §144. */
export function commanderOnlyFederationVerdict(
  config: Pick<ServerConfig, "federationRole" | "federationRoleDeclared">,
  what: string
): CommanderOnlyVerdict {
  if (!config.federationRoleDeclared) {
    return {
      allowed: false,
      reason:
        `SCP_FEDERATION_ROLE is not declared on this deployment, so ${what} is refused FAIL-CLOSED. ` +
        `The setting DEFAULTS to 'commander' — right for "may I serve the SPA?", wrong for "am I ` +
        `the commander?" — so an outpost that predates the setting, or a chart that omits it, is ` +
        `indistinguishable from a commander here. Declare it explicitly (Helm: 'federationRole'); ` +
        `all dependency automation runs on the commander only (ADR-0032 §7d)`
    };
  }
  if (config.federationRole !== "commander") {
    return {
      allowed: false,
      reason:
        `SCP_FEDERATION_ROLE is '${config.federationRole}' — ${what} is COMMANDER-ONLY, and this ` +
        `deployment is not the commander. RUN IT ON THE COMMANDER. Dependency automation exists to ` +
        `pull from PUBLIC repositories (python library versions, CDK versions, base-image ` +
        `versions), which an outpost has no need to do: the resulting change is pushed down the ` +
        `global pipeline the commander manages, so an outpost RECEIVES a dependency bump through ` +
        `the ordinary promotion path and never originates one. Dependencies declared in ` +
        `domain-specific repositories the commander never sees are out of scope (ADR-0032 §7d)`
    };
  }
  return {
    allowed: true,
    reason: `SCP_FEDERATION_ROLE is explicitly 'commander', so ${what} runs here`
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
