import type { DependencyManagement } from "@scp/schemas";
import type { ServerConfig } from "../config.js";

/**
 * THE ONE PREDICATE FOR "MAY THIS DEPLOYMENT RUN DEPENDENCY AUTOMATION?" (ADR-0032 §7d).
 *
 * ============================================================================================
 * THE RULE, AND THE REASON IT IS THE RULE
 * ============================================================================================
 * ALL dependency automation is COMMANDER-ONLY (owner decision, 2026-08-17). Outposts run no
 * dependency job and hold no dependency inventory. The reasoning is what belongs here, because it
 * is what tells the next reader whether a NEW job falls on this side of the line:
 *
 *   the point of dependency automation is to PULL FROM PUBLIC REPOSITORIES — python library
 *   versions, CDK versions, base-image versions. That is not needed from an outpost standpoint,
 *   because the resulting change GETS PUSHED DOWN THE GLOBAL PIPELINE THE COMMANDER MANAGES.
 *
 * So an outpost never ORIGINATES a bump; it RECEIVES the resulting change through the ordinary
 * promotion path. The accepted cost — dependencies declared in DOMAIN-SPECIFIC repositories the
 * commander never sees are OUT OF SCOPE — and the two clauses this reverses (§4a clause 7, §7c
 * clause 3) are in ADR-0032 §7d, preserved verbatim beside what overturned them. Each caller's
 * module doc restates it locally; this file is the machinery.
 *
 * ============================================================================================
 * WHY ONE FUNCTION AND NOT A THREE-BRANCH `if` PER CALLER
 * ============================================================================================
 * Five callers now ask this question, and one of the three refusals — the UNDECLARED case — is
 * FAIL-CLOSED, which makes it the branch that regresses invisibly: it is false on every developer
 * machine, on every declared commander, and in every test that does not deliberately construct it.
 * A predicate applied per caller regresses per caller (CLAUDE.md's census rule), so the callers
 * share ONE implementation and differ only in the noun they interpolate.
 *
 * `version-poll.ts` and `bump-dispatch.ts` keep their own bodies deliberately: their refusal TEXT
 * carries capability-specific facts a shared string cannot ("dials package registries from an
 * air-gapped site", "writes to a source repository with a credential"). The DECISION must still be
 * identical across all five, and that is asserted directly rather than assumed —
 * `commander-only.test.ts` runs every guard over the full 3x3x2 config matrix and requires the same
 * verdict from each. A divergence introduced anywhere fails there.
 *
 * ============================================================================================
 * TWO AXES — AND A ROUTE DOES NOT GET BOTH
 * ============================================================================================
 *  - THE FEDERATION AXIS (`SCP_FEDERATION_ROLE`) is the operator's INSTALL-TIME declaration of what
 *    this deployment IS. It applies to every caller. Deliberately NOT `self_domain.role`, which is
 *    per-org, set lazily post-install, and advisory (config.ts says so at length).
 *  - THE PROCESS AXIS (`SCP_ROLE`) applies to BACKGROUND WORK ONLY. A queue worker belongs to an
 *    `all`/`worker` process. It must NOT be applied to a ROUTE: in the split topology
 *    (`SCP_ROLE=api` serving HTTP, `SCP_ROLE=worker` draining queues) EVERY request arrives at an
 *    api process, so a route carrying the process axis would refuse every caller on a perfectly
 *    correct commander. {@link commanderOnlyFederationVerdict} is the half a route asks;
 *    {@link commanderOnlyJobVerdict} is the whole question a job asks.
 *
 * THE FAIL-CLOSED BRANCH IS THE POINT. `config.federationRole` DEFAULTS to `commander` when
 * `SCP_FEDERATION_ROLE` is unset, because that is right for "may I serve the SPA?" and preserves
 * every pre-M16.3 deployment. It is wrong for "am I the commander?": an outpost predating the
 * setting, or a chart omitting it, is indistinguishable from a declared commander here — and that
 * is exactly the population most likely to be air-gapped. An undeclared deployment is REFUSED,
 * never assumed; the remedy is one env var an operator can set truthfully either way.
 */

/** Every axis a dependency-automation guard reads. */
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

/**
 * THE FEDERATION AXIS ALONE — the question a ROUTE asks.
 *
 * `what` names the capability in the operator's own words and is interpolated into every reason, so
 * a refusal says which capability refused instead of repeating one generic sentence five times.
 */
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

/**
 * BOTH AXES — the question a BACKGROUND JOB asks. The process split is checked FIRST so an `api`
 * process is told it is the wrong PROCESS rather than being told something about federation, which
 * would send an operator to change the wrong setting.
 */
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

/**
 * THE SAME QUESTION, SHAPED FOR AN API RESPONSE — "does dependency management HAPPEN on this
 * deployment, and why?" (`DependencyManagementSchema`, ADR-0032 §7d).
 *
 * ============================================================================================
 * WHY THIS EXISTS AT ALL — A CORRECT ANSWER NOBODY WILL ACT ON IS NOT AN EXPLAINED ANSWER
 * ============================================================================================
 * The guards above answer a question a JOB or a ROUTE asks about ITSELF, and their product is a
 * refusal. But the tenant-facing resolve route does not refuse: it answers `enabled` on an outpost,
 * computed from policies that federated down correctly, for a subscription that NOTHING ON THAT
 * DEPLOYMENT WILL EVER ACT ON. That is charter principle 6 failing rather than being satisfied — an
 * answer whose REASON is unavailable — and it is the same shape as an unattributed ingestion stamp
 * one layer down. This function is what lets every such answer carry the missing qualifier.
 *
 * ============================================================================================
 * ONE PREDICATE, NOT A SECOND OPINION
 * ============================================================================================
 * `managedHere` IS {@link commanderOnlyFederationVerdict}'s verdict — called, not re-derived. A
 * parallel `federationRole === "commander" && federationRoleDeclared` written here would be the
 * fifth copy of a rule whose fail-closed branch is invisible on every developer machine, which is
 * precisely the property CLAUDE.md's census rule names. `reason` adds nothing to the DECISION: it is
 * a pure LABEL of what the operator declared, so the two cannot disagree about the verdict, and
 * `managedHere === (reason === "commander")` is a property a test can pin rather than an invariant a
 * reader has to trust. (`commander-only.test.ts` pins it over the full config matrix.)
 *
 * THE FEDERATION AXIS ONLY. This is a fact about the DEPLOYMENT, not about the process serving the
 * request — an `SCP_ROLE=api` process on a correct commander must not report that dependencies are
 * unmanaged there just because the jobs drain on its `worker` sibling. Same reason a route asks
 * `commanderOnlyFederationVerdict` and a job asks `commanderOnlyJobVerdict`.
 */
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
