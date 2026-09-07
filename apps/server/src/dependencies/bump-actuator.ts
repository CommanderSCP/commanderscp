import type { TenantTx } from "../db/tenant-tx.js";
import type { DependencySubscriptionDelivery } from "@scp/schemas";
import { conflict } from "../errors.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { deriveUrn } from "../graph/urn.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { listControlRunsForChange } from "../governance/controls-repo.js";
import { recordBumpAuthorship } from "./bump-authorship-repo.js";
import { delegationRefusalMessage, readStandingDelegationVerdict } from "./delegation-detection.js";

/** M21.5 — THE ACTUATOR SEAM. See docs/dependencies.md §1. */

/** The branch prefix `@scp/plugin-managed-dep` authors under. See docs/dependencies.md §2. */
export const BUMP_BRANCH_PREFIX = "scp/dep-bump/";

/** The fully-qualified ref a bump for `changeObjectId` is authored on. */
export function bumpRefFor(changeObjectId: string): string {
  return `refs/heads/${BUMP_BRANCH_PREFIX}${changeObjectId}`;
}

/** `changes.source_kind` for a bump SCP authored. Distinct from `github` deliberately: the ORIGIN of
 *  this change is CommanderSCP's own subscription resolution, not an observed provider event, and a
 *  reader that cannot tell those apart cannot answer "did we author this?". */
export const BUMP_SOURCE_KIND = "dependency-bump";

/** Can this build's runner edit a manifest at this path. See docs/dependencies.md §3. */
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
      // The four Dockerfile spellings in ordinary use, plus `values.yaml` — EXACTLY the basename
      // `inventory-ingestion.ts`'s manifest-candidate map reads. Not `values.yml`, not
      // `*-values.yaml`: a path this admits and the inventory never parses is a file SCP would
      // write into without ever having read a dependency out of it.
      return (
        basename === "Dockerfile" ||
        basename === "Containerfile" ||
        basename.startsWith("Dockerfile.") ||
        basename.endsWith(".Dockerfile") ||
        basename === "values.yaml"
      );
    default:
      return false;
  }
}

/** THE DELEGATION RE-CHECK. See docs/dependencies.md §4. */
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

/** The controls whose verdict is the component's own checks. See docs/dependencies.md §5. */
export const COMPONENT_OWN_CHECK_CONTROL_MODULES: readonly string[] = ["github-check"];

/** Auto-merge is evidenced on the bump's own commit. See docs/dependencies.md §6. */
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

/** Does this control run's evidence name `repo`? See docs/dependencies.md §7. */
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

/** Does this control run's evidence name `commit`? See docs/dependencies.md §8. */
function evidenceNamesCommit(evidence: unknown, commit: string): boolean {
  if (evidence === null || typeof evidence !== "object") return false;
  const ref = (evidence as { ref?: unknown }).ref;
  if (typeof ref !== "string" || ref === "") return false;
  return ref.toLowerCase() === commit.toLowerCase();
}

export interface RecordBumpChangeInput {
  orgId: string;
  /** The id is chosen by the caller, and why. See docs/dependencies.md §9. */
  changeObjectId: string;
  requestId: string;
  componentObjectId: string;
  /** The dependency line this bump is for. See docs/dependencies.md §10. */
  lineId: string;
  /** The repository the bump is authored into, as `changes.source_ref.repo` spells it elsewhere. */
  repo: string;
  /** The branch the bump is based on and the pull request will target. */
  baseBranch: string;
  ecosystem: string;
  coordinate: string;
  manifestPath: string;
  /** EVERY manifest path this component's inventory declares. See docs/dependencies.md §11. */
  declaredManifestPaths: string[];
  fromVersion: string;
  toVersion: string;
  delivery: DeliveryResolution;
}

/** THE PROVENANCE LOOP. See docs/dependencies.md §12. */
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
        // WHOSE BUMP THIS IS. See docs/dependencies.md §13.
        componentObjectId: input.componentObjectId,
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

/** What the server hands the runner: a descriptor. See docs/dependencies.md §14. */
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

/** What the server hands the runner to merge its own bump. See docs/dependencies.md §15. */
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

/** Reads a change's authored-bump declaration, or nothing. See docs/dependencies.md §16. */
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
