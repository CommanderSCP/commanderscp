import type { TenantTx } from "../db/tenant-tx.js";
import type { DependencySubscriptionDelivery } from "@scp/schemas";
import { conflict } from "../errors.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { deriveUrn } from "../graph/urn.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { listControlRunsForChange } from "../governance/controls-repo.js";
import { recordBumpAuthorship } from "./bump-authorship-repo.js";
import { delegationRefusalMessage, readStandingDelegationVerdict } from "./delegation-detection.js";

/**
 * M21.5 — THE ACTUATOR SEAM: what the server decides BEFORE `scp-managed-dep` is dispatched, and
 * what it records so the commit that comes back is recognised as its own.
 *
 * Three things live here, and nothing else does. The plugin performs the edit and the write; the
 * subscription resolution (M21.3) decides who is subscribed; this is only the narrow band between
 * them where the SERVER has to make a decision the plugin structurally cannot.
 *
 *   1. THE DELEGATION RE-CHECK ({@link assertComponentNotDelegated}) — the other half of the
 *      authoring-time refusal, for the components the authoring-time refusal cannot see.
 *   2. THE DELIVERY RESOLUTION ({@link resolveEffectiveDelivery}) — auto-merge is downgraded to a
 *      pull request unless a governed control already evidenced the component's own checks passed.
 *   3. THE BUMP CHANGE ({@link recordBumpChange}) — recorded so that the push webhook this bump
 *      eventually produces CORRELATES TO IT rather than minting a second, unrelated change.
 */

/** The branch prefix `@scp/plugin-managed-dep` authors under. Restated here rather than imported so
 *  the server does not take a build-time dependency on a plugin package for a string the CORRELATION
 *  path needs; `delegation-detection.test.ts`'s "the authored-branch contract" block pins the two
 *  against each other — along with the descriptor {@link buildBumpIntentParameters} emits — which is
 *  the seam where a drift would actually hurt. */
export const BUMP_BRANCH_PREFIX = "scp/dep-bump/";

/** The fully-qualified ref a bump for `changeObjectId` is authored on. */
export function bumpRefFor(changeObjectId: string): string {
  return `refs/heads/${BUMP_BRANCH_PREFIX}${changeObjectId}`;
}

/** `changes.source_kind` for a bump SCP authored. Distinct from `github` deliberately: the ORIGIN of
 *  this change is CommanderSCP's own subscription resolution, not an observed provider event, and a
 *  reader that cannot tell those apart cannot answer "did we author this?". */
export const BUMP_SOURCE_KIND = "dependency-bump";

/**
 * CAN THIS BUILD'S RUNNER EDIT A MANIFEST AT THIS PATH FOR THIS ECOSYSTEM?
 *
 * `@scp/plugin-managed-dep`'s `MANIFEST_MATCHERS` is the charter-enforcement allowlist — "SCP never
 * edits a file that declares no dependency", made structural and fail-closed inside the plugin. This
 * is a RESTATEMENT of the same closed set on the dispatch side, following the convention
 * {@link BUMP_BRANCH_PREFIX} already sets: the server does not take a build-time dependency on a
 * plugin package, and `bump-dispatch.test.ts`'s "the write allowlist, pinned across the two modules
 * that restate it" block proves the two agree — including on what each one REFUSES, which is the
 * half a subset check would miss.
 *
 * WHY THE SERVER ASKS AT ALL, when the plugin refuses anyway (M21.7). `values.yaml` is now
 * INVENTORIED, so an image pinned in a chart is subscribable and polled and an operator learns a
 * newer `alpine` exists. It is NOT writable: the runner's verifier requires the single changed line
 * to name the coordinate, and in `image: {repository, tag}` the coordinate is on the other line —
 * in `{registry, repository, tag}` it appears nowhere contiguously at all. Without this check the
 * dispatcher would start a container, hand it a file the allowlist refuses, and surface
 * `not_a_known_manifest`, which reads to an operator as "the runner is broken" rather than as "this
 * build cannot author into that file". The allowlist stays CLOSED and fail-closed; this only decides
 * WHERE the refusal is said, and it says it before a container exists.
 */
export function manifestIsEditableInThisBuild(ecosystem: string, manifestPath: string): boolean {
  const cut = manifestPath.lastIndexOf("/");
  const basename = cut === -1 ? manifestPath : manifestPath.slice(cut + 1);
  switch (ecosystem) {
    case "npm":
      return basename === "package.json";
    case "go":
      return basename === "go.mod";
    case "maven":
      return basename === "pom.xml";
    case "python":
      return basename === "pyproject.toml" || /^requirements[A-Za-z0-9._-]*\.txt$/.test(basename);
    case "oci":
      // The four Dockerfile spellings in ordinary use. `values.yaml` is deliberately NOT here.
      return (
        basename === "Dockerfile" ||
        basename === "Containerfile" ||
        basename.startsWith("Dockerfile.") ||
        basename.endsWith(".Dockerfile")
      );
    default:
      return false;
  }
}

/**
 * ============================================================================================
 * THE DELEGATION RE-CHECK — the half the authoring-time refusal structurally cannot cover
 * ============================================================================================
 * `subscription-authoring-guard.ts`'s `assertNoDelegatedDependencyUpdates` refuses a policy whose
 * `scope.objectRef` names a component with a standing delegation verdict. It CANNOT refuse a
 * `selector`-scoped enable, because a selector names no component — by design, since a selector is
 * meant to match objects that do not exist yet.
 *
 * So the same stored verdict is read again here, immediately before SCP would write to the
 * repository. That is not belt-and-braces: it is the only point at which the component is known for
 * a selector-scoped enable, and it is also what makes a delegation ADDED AFTER the policy was
 * authored stop the writes rather than only the policy. One stored fact, two readers, neither of
 * them fail-open.
 */
export async function assertComponentNotDelegated(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string
): Promise<void> {
  const standing = await readStandingDelegationVerdict(tx, orgId, componentObjectId);
  if (!standing?.delegated) return;
  throw conflict(delegationRefusalMessage(standing.collisions), {
    decisionId: standing.decisionId
  });
}

export type DeliveryResolution = {
  delivery: DependencySubscriptionDelivery;
  /** Why. Carried into the bump change's `sourceRef` so "why was this not auto-merged?" is
   *  answerable from the change alone (charter principle 6). */
  reason: string;
  /** The control run that evidenced green, when one did. */
  controlObjectId?: string;
  controlRunId?: string;
};

/**
 * The control plugin modules whose verdict IS "the component's own checks passed", and the ONLY
 * ones a grant may be built on.
 *
 * There is exactly one, and naming it as a set rather than as an `=== "github-check"` is not
 * anticipation: it is so that adding a second (a GitLab pipeline control, a Gitea Actions control)
 * is an edit to one named list whose doc comment states the admission test, rather than a condition
 * somebody widens in passing.
 *
 * THE ADMISSION TEST, stated so a future addition is decidable: the module must answer "did THIS
 * CHANGE'S OWN commit pass the component's OWN CI?", bound to the change's commit rather than to an
 * operator-typed constant. `@scp/plugin-github-check` does exactly that — it reads the component's
 * repository's Check Runs for `req.context.commitSha`, "the change's OWN tracked source commit
 * (`governance/gate-orchestrator.ts`'s `resolveChangeCommitSha`), never an operator-typed value
 * alone" (that plugin's own module doc).
 *
 * WHO IS EXCLUDED, AND WHY EACH EXCLUSION IS THE CHARTER RATHER THAN TASTE:
 *   * `scan-result-control` — a scan verdict about an ARTIFACT. Real governed evidence, and not a
 *     statement about the component's checks: a clean CVE scan of last week's image says nothing
 *     about whether this bump compiles.
 *   * `webhook-control` — "POSTing to an operator-configured arbitrary URL" is that plugin's own
 *     description of itself. Whatever it evidences is whatever the operator pointed it at.
 *   * `null` (no binding) — the commander's promotion scan step deposits rows under a synthetic
 *     control id with no binding, and `ensureControlRun` deposits a `fail` row when a binding is
 *     missing. Neither is a component's CI.
 */
export const COMPONENT_OWN_CHECK_CONTROL_MODULES: readonly string[] = ["github-check"];

/**
 * ============================================================================================
 * AUTO-MERGE IS EVIDENCED BY THE COMPONENT'S OWN CHECKS, ON THE BUMP'S OWN COMMIT
 * ============================================================================================
 * The charter: "automatic merge is permitted only where a governed control evidences that the
 * component's OWN checks passed". ADR-0032 §8: "Auto-merge's CI-green condition is expressed as a
 * governed control so the existing gate machinery decides, not new code."
 *
 * So this function INVENTS NOTHING and RUNS NOTHING. It reads the rows the existing machinery
 * already deposits (`governance/control-runner.ts`'s `ensureControlRun` for a wave-boundary gate,
 * `coordination/gates.ts` for a lifecycle edge) and decides which of them the charter's sentence is
 * actually about. Two independent narrowings, and each one closes a way of merging into somebody's
 * default branch on evidence that was never about this bump:
 *
 *  1. WHICH CONTROL. The first cut read `listControlRunsForChange` unfiltered, so ANY passing
 *     control granted auto-merge — a Trivy scan-result verdict, a webhook control pointed at an
 *     operator's own URL, a commander promotion-scan row. Every one of those is a governed control
 *     and none of them is "the component's own checks". `control_runs.plugin_module` is the only
 *     place the KIND of question is recorded, so the grant is restricted to
 *     {@link COMPONENT_OWN_CHECK_CONTROL_MODULES}.
 *
 *     THE MODULE IS READ OFF THE RUN, NEVER OFF THE CURRENT BINDING (migration 0063). It used to be
 *     a LEFT JOIN to `control_bindings`, which meant re-pointing one binding at `github-check`
 *     retroactively relabelled every historical pass of that control as an own-check pass — and this
 *     function grants an unattended merge by reading historical runs.
 *
 *  2. WHICH REPOSITORY. A module name is a string, and on its own it binds the evidence to NOTHING:
 *     a `github-check` control configured against an UNRELATED repository that happens to contain
 *     the same commit object (a fork, a mirror, a vendored copy — commit ids are content hashes and
 *     travel between repositories freely) satisfied narrowing 3 exactly as the component's own CI
 *     would. The comment here used to assert the opposite while nothing enforced it. So the run's
 *     evidence must ALSO name the repository the bump is being authored into, which
 *     `@scp/plugin-github-check` records as the API URL it queried
 *     (`{apiBaseUrl}/repos/{owner}/{repo}/commits/{ref}/check-runs`) — see
 *     {@link evidenceNamesRepo}. Evidence this cannot attribute to the component's own repository is
 *     NOT a grant.
 *
 *  3. WHICH COMMIT. Narrowing to `github-check` alone is NOT enough, and this is the sharper half.
 *     That plugin falls back to its operator-pinned `config.expectedRef` when the change tracks no
 *     commit — and a bump change tracks none until its push comes back. So a `github-check` control
 *     could have reported CI green FOR THE BASE BRANCH and the bump would have merged on it: green
 *     on `main` used as proof that the edit to `main` is safe. The grant therefore additionally
 *     requires the run's evidence to name the commit the bump's OWN branch is at, which
 *     `coordination/webhook-processor.ts` writes to `dependency_bump_authorships.head_commit` when
 *     the authored push returns. SERVER-OWNED, deliberately: the readable copy on the change
 *     (`source_ref.scp_authored.headCommit`) is writable by any authenticated principal through
 *     `POST /api/v1/changes` and is never the authority here. No recorded head commit ⇒ no grant.
 *
 * ============================================================================================
 * WHEN THIS FUNCTION IS ASKED, AND WHY IT IS ASKED TWICE (ADR-0032 §8c)
 * ============================================================================================
 * Both narrowings above are satisfiable only AFTER the bump's own commit exists and CI on it has
 * concluded. At the FIRST dispatch none of that is true — the branch does not exist, no push has
 * returned, no head commit is recorded and no control has run — so the first answer is always
 * `pull_request`, whatever the subscription asked for, and the downgrade is recorded with its reason
 * so the option is visibly declined rather than silently ignored.
 *
 * The second asking is `bump-gate.ts`'s job, and it exists because until M21.5's auto-merge link
 * NOTHING produced one: the only trigger was a line's head advancing, an advance to a different
 * version is a different change, and a restatement deliberately emits nothing — so `auto_merge`
 * resolved, recorded and downgraded forever. The link is three parts, none of which is a second
 * gate:
 *
 *   1. `coordination/webhook-processor.ts` emits `scp.dependency.bump_observed` in the ingress
 *      transaction whenever an observed provider event correlates to a bump change SCP authored —
 *      the authored push (which records the head commit) and, once CI concludes on it, the
 *      `workflow_run` that names that same commit;
 *   2. `bump-gate.ts` routes that event onto its own queue and runs
 *      `governance/gate-orchestrator.ts`'s EXISTING `prewarmGovernanceForChange` FOR the bump
 *      change, so the required controls a policy already names actually run against it and deposit
 *      real `control_runs` with real evidence. No lifecycle edge is crossed and the change is never
 *      advanced: a bump is not a deployment;
 *   3. that same job re-asks THIS function with the recorded head commit, and dispatches the merge
 *      only if it grants.
 *
 * So the two narrowings below are now REACHED rather than merely correct. Nothing about what they
 * require changed; what changed is that the evidence they require can now exist.
 *
 * WHY IT IS A DOWNGRADE RATHER THAN A REFUSAL. `pull_request` is the more restrictive member of the
 * pair and the resolver already treats it as such (`DependencySubscriptionDeliverySchema`:
 * "auto-merge is the privileged option and is acquired unanimously"). A bump whose checks have not
 * gone green is not a bump that must not happen — it is one that must be delivered the safe way.
 * Throwing here would withhold the pull request the checks need in order to run at all.
 *
 * FAIL-CLOSED IN EVERY DIRECTION THAT MATTERS:
 *   * no control run at all                       -> pull_request ("absent never means passed")
 *   * only `expired` runs (CI in flight)          -> pull_request
 *   * ANY `fail`/`timed_out`, from ANY control    -> pull_request, even if an own-check passed
 *   * a pass from a control that is not an own-check          -> pull_request
 *   * an own-check pass whose evidence names another repository -> pull_request
 *   * an own-check pass whose evidence names another commit   -> pull_request
 *   * an own-check pass on the bump's own repository AND head commit -> auto_merge, named in the
 *     reason
 *
 * The "any fail wins, from any control" rule is deliberately WIDER than the grant rule, and the
 * asymmetry is the point: a passing scan is not evidence the component's checks passed, but a
 * FAILING scan is a perfectly good reason not to merge unattended. It is the same asymmetry the
 * subscription merge itself uses — one objecting contribution defeats any number of permitting
 * ones, because the cost of the two mistakes is not symmetric.
 */
export async function resolveEffectiveDelivery(
  tx: TenantTx,
  orgId: string,
  input: {
    changeObjectId: string;
    requested: DependencySubscriptionDelivery;
    /** The repository this bump is authored into, from `dependency_bump_authorships` — SERVER-OWNED,
     *  never a tenant-writable field. Evidence that cannot be attributed to it is not a grant (see
     *  narrowing 2). `undefined` only where no authorship exists, which cannot grant anything. */
    repo?: string | undefined;
    /** The commit the bump's authored branch is at, as `dependency_bump_authorships.head_commit`
     *  records it. `undefined` means the push has not been observed yet — a real state, not a
     *  missing input, and the reason a first dispatch can never auto-merge. */
    authoredHeadCommit?: string | undefined;
  }
): Promise<DeliveryResolution> {
  if (input.requested === "pull_request") {
    return { delivery: "pull_request", reason: "the subscription resolved to pull_request" };
  }

  const runs = await listControlRunsForChange(tx, orgId, input.changeObjectId);
  if (runs.length === 0) {
    return {
      delivery: "pull_request",
      reason:
        "auto_merge was asked for, but no governed control has evidenced this component's own checks — absent never means passed"
    };
  }
  // WIDER THAN THE GRANT, on purpose — see the header's closing paragraph.
  const objecting = runs.find((r) => r.status === "fail" || r.status === "timed_out");
  if (objecting) {
    return {
      delivery: "pull_request",
      reason: `auto_merge was asked for, but control ${objecting.controlObjectId} (${objecting.pluginModule ?? "no binding"}) reported '${objecting.status}'`,
      controlObjectId: objecting.controlObjectId,
      controlRunId: objecting.id
    };
  }

  const ownCheckRuns = runs.filter(
    (r) => r.pluginModule !== null && COMPONENT_OWN_CHECK_CONTROL_MODULES.includes(r.pluginModule)
  );
  if (ownCheckRuns.length === 0) {
    return {
      delivery: "pull_request",
      reason:
        `auto_merge was asked for, but none of the ${runs.length} control run(s) on this change came from a control ` +
        `that evidences the component's OWN checks (${COMPONENT_OWN_CHECK_CONTROL_MODULES.join(", ")}); ` +
        `present: ${[...new Set(runs.map((r) => r.pluginModule ?? "no binding"))].sort().join(", ")}`
    };
  }
  if (!input.authoredHeadCommit) {
    return {
      delivery: "pull_request",
      reason:
        "auto_merge was asked for, and this component's own checks have run — but the commit this bump authored " +
        "has not been observed back yet, so there is nothing to prove those checks were about THIS bump rather " +
        "than about the base branch"
    };
  }
  if (!input.repo) {
    return {
      delivery: "pull_request",
      reason:
        "auto_merge was asked for, but this instance has no server-recorded authorship for this " +
        "change naming the repository the bump is authored into — evidence that cannot be bound to " +
        "a repository is not evidence about this component's own checks"
    };
  }
  // BOUND TO THE COMPONENT'S OWN REPOSITORY *AND* TO THE BUMP'S OWN COMMIT. Neither alone is the
  // charter's sentence: a commit id is a content hash and travels between repositories, so a
  // `github-check` control aimed elsewhere can name it truthfully.
  const passing = ownCheckRuns.find(
    (r) =>
      r.status === "pass" &&
      evidenceNamesRepo(r.evidence, input.repo as string) &&
      evidenceNamesCommit(r.evidence, input.authoredHeadCommit as string)
  );
  if (!passing) {
    const onOtherCommit = ownCheckRuns.some(
      (r) => r.status === "pass" && evidenceNamesRepo(r.evidence, input.repo as string)
    );
    const onOtherRepo = ownCheckRuns.some(
      (r) => r.status === "pass" && !evidenceNamesRepo(r.evidence, input.repo as string)
    );
    return {
      delivery: "pull_request",
      reason: onOtherCommit
        ? `auto_merge was asked for, but this component's own checks passed for a commit other than the bump's own head ${input.authoredHeadCommit} — green somewhere else is not green here`
        : onOtherRepo
          ? `auto_merge was asked for, but the passing own-check evidence cannot be attributed to '${input.repo}', which is the repository this bump is authored into — a commit id travels between repositories, so green in one of them is not green here`
          : `auto_merge was asked for, but this component's own checks have not passed yet (latest: '${ownCheckRuns[0]?.status ?? "none"}')`
    };
  }
  return {
    delivery: "auto_merge",
    reason: `control ${passing.controlObjectId} (${passing.pluginModule}) evidenced this component's own checks passed in '${input.repo}' for the bump's own commit ${input.authoredHeadCommit}`,
    controlObjectId: passing.controlObjectId,
    controlRunId: passing.id
  };
}

/**
 * Does this control run's evidence name `repo`?
 *
 * `@scp/plugin-github-check` records the API URL it actually queried —
 * `{apiBaseUrl}/repos/{owner}/{repo}/commits/{ref}/check-runs` — which is the only field in the
 * evidence that says WHICH REPOSITORY the verdict is about. The `/repos/<owner>/<name>/` segment
 * pair is lifted out of it and compared case-insensitively, the same rule
 * `dependencies/manifest-reader.ts`'s `normalizeRepoIdentity` states for repository paths.
 *
 * A shape this cannot read is NOT a match — the fail-closed direction, and it costs a pull request
 * rather than an unattended merge on evidence nobody can attribute. That includes an evidence
 * payload with no `url` at all: a control that does not say what it looked at has not said it looked
 * at this component.
 */
export function evidenceNamesRepo(evidence: unknown, repo: string): boolean {
  if (evidence === null || typeof evidence !== "object") return false;
  const url = (evidence as { url?: unknown }).url;
  if (typeof url !== "string" || url === "") return false;
  // Anchored on the `/repos/` segment rather than on a substring search for the repo path: a
  // substring test would be satisfied by `…/repos/attacker/acme-widget/…` for `acme/widget`, and by
  // any query string an operator's base URL happens to carry.
  const match = /\/repos\/([^/?#]+)\/([^/?#]+)/.exec(url);
  if (!match) return false;
  const named = `${decodeURIComponent(match[1] as string)}/${decodeURIComponent(match[2] as string)}`;
  return named.trim().toLowerCase() === repo.trim().toLowerCase();
}

/**
 * Does this control run's evidence name `commit`?
 *
 * `@scp/plugin-github-check` records `{url, ref, checkRuns}` where `ref` is the commit it queried.
 * Read as `unknown` at this boundary because `control_runs.evidence` is jsonb written by a plugin:
 * a row from an older build, or from a module added to
 * {@link COMPONENT_OWN_CHECK_CONTROL_MODULES} later, can carry anything. A shape this cannot read
 * is NOT a match — the fail-closed direction, which costs a pull request rather than an unattended
 * merge on evidence nobody can attribute.
 *
 * Compared case-insensitively: git object ids are hex, and providers spell them in either case.
 * Never a prefix comparison — an abbreviated sha is a different string and matching on a prefix is
 * how a 7-character `evidence.ref` would satisfy any commit that happens to start the same way.
 */
function evidenceNamesCommit(evidence: unknown, commit: string): boolean {
  if (evidence === null || typeof evidence !== "object") return false;
  const ref = (evidence as { ref?: unknown }).ref;
  if (typeof ref !== "string" || ref === "") return false;
  return ref.toLowerCase() === commit.toLowerCase();
}

export interface RecordBumpChangeInput {
  orgId: string;
  /**
   * THE ID, CHOSEN BY THE CALLER, because two things need it before the row exists.
   *
   * It used to be minted inside this function, which made the ordering impossible: the branch is
   * `scp/dep-bump/<changeObjectId>` and the DELIVERY is resolved against the change's control runs,
   * so both the ref written into `source_ref` and `resolveEffectiveDelivery`'s argument need the id
   * that `proposeChange` had not yet returned. Minting in the caller also lets a RE-DISPATCH pass
   * the id of the bump change that already exists, which is what makes a retry converge on one
   * branch and one pull request rather than opening a second.
   */
  changeObjectId: string;
  requestId: string;
  componentObjectId: string;
  /**
   * The dependency line this bump is for.
   *
   * Recorded because the SECOND asking of the delivery question (`bump-gate.ts`) has only the change
   * in hand and must re-derive the subscription's CURRENT resolution rather than trust the one
   * recorded here — which is the DOWNGRADED answer by construction. Re-deriving is what makes a
   * subscription narrowed to `pull_request`, or switched off entirely, after the bump was authored
   * stop the merge; and `listSubscribedComponentLines` is keyed on (component, line), so the line is
   * the field that has to be on the change. A `targets` join would give the component and nothing
   * would give the line.
   */
  lineId: string;
  /** The repository the bump is authored into, as `changes.source_ref.repo` spells it elsewhere. */
  repo: string;
  /** The branch the bump is based on and the pull request will target. */
  baseBranch: string;
  ecosystem: string;
  coordinate: string;
  manifestPath: string;
  /**
   * EVERY manifest path this component's inventory declares (ADR-0032 §3 projection rows), not just
   * the one being edited.
   *
   * It is here because the plugin's manifest-only verifier refuses a target the component does not
   * declare — "a manifest the component already contains", in the charter's words — and the only
   * place that fact exists is the server's inventory. Sending just `manifestPath` and letting the
   * plugin default the set to it would make that gate compare a value with itself and pass
   * vacuously; the plugin therefore REQUIRES this and refuses a descriptor without it.
   *
   * It is a descriptor, not content: a list of references to files that already exist, exactly the
   * category `manifestPath` itself is in (ADR-0032 §9's distinction).
   */
  declaredManifestPaths: string[];
  fromVersion: string;
  toVersion: string;
  delivery: DeliveryResolution;
}

/**
 * ============================================================================================
 * THE PROVENANCE LOOP — a commit SCP authors must come back as ITSELF
 * ============================================================================================
 * ADR-0032 §9's closing sentence: "A commit SCP authors is observed back in via the normal webhook
 * path, so the bump change must be recorded such that the returning event CORRELATES TO IT rather
 * than minting a second, unrelated change."
 *
 * That sentence describes a real hazard rather than a tidiness concern. Today EVERY change is minted
 * by `coordination/webhook-processor.ts` from an OBSERVED event: it extracts a hint, matches
 * `source_mappings`, and calls `proposeChange`. A bump SCP authors produces a perfectly ordinary push
 * to the component's repository, which matches that component's perfectly ordinary source mapping —
 * so without something to stop it, one bump becomes TWO changes: the one SCP recorded when it decided
 * to author, and the one the webhook minted when the commit arrived. They would gate independently,
 * appear as two releases of the same component, and neither would know about the other.
 *
 * THE JOIN IS THE BRANCH, AND IT IS DECLARED ON BOTH SIDES. The change is recorded FIRST, so its id
 * exists; the branch the plugin authors is `scp/dep-bump/<changeObjectId>`, so the id is carried in
 * the one field a git push always has. The change ALSO records the repo and ref it claims, under
 * `source_ref.scp_authored`. Correlation then requires BOTH: the incoming ref must name a change, and
 * that change must claim this repo and this ref.
 *
 * REQUIRING BOTH IS THE WHOLE POINT, not defensiveness. A branch name is attacker-typable — anyone
 * who can push to any repository this instance observes could create `scp/dep-bump/<some-uuid>` and,
 * with a one-sided check, attach their push to somebody else's change. Reading the change's own
 * declaration is what makes the correlation a fact SCP asserted rather than a claim the payload made.
 * It is the same "declared, never inferred" rule ADR-0030 §2 states for pipeline classification and
 * that this repository's own provenance-label lesson learned the hard way.
 *
 * WHY THE BRANCH AND NOT THE COMMIT SHA. The sha is only known after the push, so a webhook that
 * arrives before the actuator has finished recording it would find nothing — a race whose losing side
 * is exactly the double-change this exists to prevent. The branch is chosen BEFORE anything is
 * written and is therefore race-free.
 *
 * ============================================================================================
 * ...AND THE DECLARATION THAT DECIDES A WRITE LIVES SOMEWHERE ONLY THE SERVER CAN WRITE
 * ============================================================================================
 * `source_ref.scp_authored` is written here and is the human-readable half: it is what makes "why
 * was this not auto-merged?" answerable from the change alone (principle 6). It is NOT the authority
 * for anything, and it never can be — `source_ref` is the raw delivery payload plus a few lifted
 * keys, writable verbatim by any authenticated principal through `POST /api/v1/changes`. Reading the
 * repository, the base branch or the head commit out of it to decide a MERGE is a confused deputy:
 * the tenant names the repository, SCP supplies the credential.
 *
 * So the same facts are recorded a second time in `dependency_bump_authorships` (migration 0063), in
 * the SAME transaction as the change, and every decision that leads to a repository write reads THAT.
 * A change with no authorship row is not a bump change, whatever its `source_ref` claims.
 */
export async function recordBumpChange(
  tx: TenantTx,
  input: RecordBumpChangeInput
): Promise<{ changeObjectId: string; authoredRef: string }> {
  const name = `dependency bump: ${input.coordinate} ${input.fromVersion} -> ${input.toVersion}`;
  // The ref must be known to record ON the change, and the delivery had to be resolved against the
  // change before this call — so the id is the CALLER'S (see `RecordBumpChangeInput.changeObjectId`).
  // `proposeChange` accepts an explicit `id` for exactly this kind of caller.
  const changeObjectId = input.changeObjectId;
  const authoredRef = bumpRefFor(changeObjectId);

  await proposeChange(tx, {
    orgId: input.orgId,
    id: changeObjectId,
    // The system actor: nobody asked for this change, a new version was released. Identical
    // attribution to the webhook processor's own proposals, and for the identical reason.
    actorObjectId: SYSTEM_ACTOR_ID,
    requestId: input.requestId,
    name,
    urn: deriveUrn(input.orgId, "change", name, changeObjectId),
    sourceKind: BUMP_SOURCE_KIND,
    sourceRef: {
      repo: input.repo,
      // THE DECLARATION the correlation half verifies against. Nothing else in `source_ref` is
      // load-bearing for correlation, and nothing outside this key may be used for it.
      scp_authored: {
        // WHOSE BUMP THIS IS. Recorded because the change's own declaration is the ONLY place the
        // subject of a bump exists in a form `findOpenBumpChange` can read: `changes.targets` is a
        // join it would have to widen, and a name is not an identity. Without it that lookup
        // matched on (coordinate, toVersion) across the whole org, so a SECOND component declaring
        // the same dependency line re-used the FIRST one's change — no change of its own, no
        // branch, no pull request, and a returning push that minted an unrelated second change for
        // every component after the first, which is exactly what ADR-0032 §9 exists to prevent.
        componentObjectId: input.componentObjectId,
        // See `RecordBumpChangeInput.lineId` — the gate job's re-resolution key.
        lineId: input.lineId,
        repo: input.repo,
        ref: authoredRef,
        baseBranch: input.baseBranch,
        ecosystem: input.ecosystem,
        coordinate: input.coordinate,
        manifestPath: input.manifestPath,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        delivery: input.delivery.delivery,
        deliveryReason: input.delivery.reason,
        ...(input.delivery.controlRunId
          ? {
              evidencedByControlObjectId: input.delivery.controlObjectId,
              evidencedByControlRunId: input.delivery.controlRunId
            }
          : {})
      }
    },
    targets: [input.componentObjectId]
  });

  // THE SERVER-OWNED HALF, in the SAME transaction — so a change without an authorship (or an
  // authorship without a change) is not a state a crash can produce.
  await recordBumpAuthorship(tx, input.orgId, {
    changeObjectId,
    componentObjectId: input.componentObjectId,
    lineId: input.lineId,
    repo: input.repo,
    baseBranch: input.baseBranch,
    authoredRef,
    ecosystem: input.ecosystem,
    coordinate: input.coordinate,
    manifestPath: input.manifestPath,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion
  });

  return { changeObjectId, authoredRef };
}

/**
 * What the server hands `scp-managed-dep` as `intent.parameters` — a DESCRIPTOR, and every field of
 * it names something that already exists in the component's repository or is a version token.
 *
 * Deliberately built in ONE place: the plugin refuses any parameter that could hold authored file
 * content (`CONTENT_BEARING_KEYS`), and a caller assembling this object ad hoc is how such a key
 * eventually gets added by someone who finds it convenient. There is no `sourceFiles` here and there
 * is nowhere to put one.
 */
export function buildBumpIntentParameters(
  input: RecordBumpChangeInput,
  /** The commit the bump's branch is already at, when one is recorded. Required by the plugin
   *  whenever `delivery` is `auto_merge`: it becomes the provider's merge precondition, so a run
   *  whose own push moved the branch away from the evidenced commit refuses the merge instead of
   *  merging a tree no control ever saw. */
  authoredHeadCommit?: string | undefined
): Record<string, unknown> {
  return {
    action: "bump",
    ecosystem: input.ecosystem,
    coordinate: input.coordinate,
    manifestPath: input.manifestPath,
    declaredManifestPaths: input.declaredManifestPaths,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    repo: input.repo,
    baseBranch: input.baseBranch,
    changeObjectId: input.changeObjectId,
    delivery: input.delivery.delivery,
    ...(input.delivery.delivery === "auto_merge" && authoredHeadCommit
      ? { expectedHeadCommit: authoredHeadCommit }
      : {})
  };
}

/**
 * What the server hands `scp-managed-dep` to MERGE a bump it already authored.
 *
 * EVERY FIELD COMES FROM `dependency_bump_authorships` — the server-owned record of what SCP itself
 * did (migration 0063), never from `changes.source_ref`, which any authenticated principal can write
 * verbatim. `repo` and `baseBranch` are what SCP recorded when it decided to author;
 * `expectedHeadCommit` and `pullRequestNumber` are what SCP recorded when its own push came back and
 * when its own authoring run reported the pull request it opened.
 *
 * `pullRequestNumber` IS THE ADDRESS OF THE MERGE, and it is the field that closes the widest hole
 * this action ever had. Without it the plugin listed open pull requests filtered on `head=owner:<our
 * branch>` and merged `list[0]` — so WHICH pull request got merged was provider list ordering, and
 * its base was never compared to anything. Anyone with write or triage on the repository could
 * retarget SCP's pull request, or open a second one from SCP's branch to a protected branch, and SCP
 * would merge a tree the governed grant never authorised while recording a `merged` Decision naming
 * the base it thought it was merging into.
 *
 * There is still NO branch field: the plugin composes the head branch from `changeObjectId` with the
 * same function the authoring run used, so the only branch this intent can reach is the branch that
 * change's own bump authored.
 *
 * Built in ONE place for the same reason {@link buildBumpIntentParameters} is: the plugin refuses any
 * parameter that could carry authored content, and an ad-hoc caller is how such a key gets added.
 */
export function buildBumpMergeIntentParameters(input: {
  changeObjectId: string;
  repo: string;
  baseBranch: string;
  expectedHeadCommit: string;
  pullRequestNumber: number;
}): Record<string, unknown> {
  return {
    action: "merge",
    repo: input.repo,
    baseBranch: input.baseBranch,
    changeObjectId: input.changeObjectId,
    expectedHeadCommit: input.expectedHeadCommit,
    pullRequestNumber: input.pullRequestNumber,
    delivery: "auto_merge"
  };
}

/** The `source_ref.scp_authored` declaration a bump change carries — SCP's own statement of what it
 *  set out to author, plus what came back. */
export interface AuthoredBumpClaim {
  repo: string;
  ref: string;
  coordinate: string;
  toVersion: string;
  /** The commit the authored branch is at, written by `coordination/webhook-processor.ts` when the
   *  push returned. `undefined` until then — see `resolveEffectiveDelivery`'s "WHICH COMMIT". */
  headCommit?: string;
  /** The branch the pull request targets. `undefined` on a change recorded before this was declared;
   *  the merge path then has no honest base to name and refuses (`bump-gate.ts`). */
  baseBranch?: string;
  /** Which component. Present since the key `findOpenBumpChange` compares became per-component. */
  componentObjectId?: string;
  /** Which line — see `RecordBumpChangeInput.lineId`. `undefined` on a change recorded before it was
   *  declared, which the gate job treats as "no subscription can be re-derived" and refuses. */
  lineId?: string;
}

/**
 * Read a change's authored-bump declaration, or `undefined` when it has none.
 *
 * ============================================================================================
 * THIS IS THE READABLE EXPLANATION. IT IS NEVER THE AUTHORITY FOR A WRITE.
 * ============================================================================================
 * `source_ref` is the raw delivery payload plus a few lifted keys, and ANY authenticated principal
 * can write it verbatim through `POST /api/v1/changes`. Everything that leads to a repository write
 * — which repository, which base branch, which commit, which pull request — reads
 * `dependency_bump_authorships` instead (`bump-authorship-repo.ts`, migration 0063), because a merge
 * must act only on facts SCP itself recorded. What remains here is the human-readable half that makes
 * "why was this not auto-merged?" answerable from the change alone (principle 6), plus the
 * declaration `correlation.ts`'s branch route compares against.
 *
 * Every field is validated as a string before it is returned. `source_ref` is jsonb, so a row from
 * an older build or a hand-edited record can carry anything; a shape this cannot read is treated as
 * NO CLAIM rather than as a partially-trusted one.
 */
export async function readAuthoredBumpClaim(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<AuthoredBumpClaim | undefined> {
  const row = await tx.query.changes.findFirst({
    where: (t, { eq: eqOp, and: andOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.objectId, changeObjectId))
  });
  if (!row) return undefined;
  const authored = (row.sourceRef as { scp_authored?: unknown } | null)?.scp_authored;
  if (authored === null || typeof authored !== "object") return undefined;
  const a = authored as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof a[key] === "string" && (a[key] as string) !== "" ? (a[key] as string) : undefined;
  const repo = str("repo");
  const ref = str("ref");
  const coordinate = str("coordinate");
  const toVersion = str("toVersion");
  if (!repo || !ref || !coordinate || !toVersion) return undefined;
  const headCommit = str("headCommit");
  const baseBranch = str("baseBranch");
  const componentObjectId = str("componentObjectId");
  const lineId = str("lineId");
  return {
    repo,
    ref,
    coordinate,
    toVersion,
    ...(headCommit ? { headCommit } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(componentObjectId ? { componentObjectId } : {}),
    ...(lineId ? { lineId } : {})
  };
}
