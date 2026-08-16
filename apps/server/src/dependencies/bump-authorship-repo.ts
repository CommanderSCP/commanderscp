import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { dependencyBumpAuthorships } from "../db/schema.js";

/**
 * ================================================================================================
 * THE ONE PLACE THAT ANSWERS "DID COMMANDERSCP AUTHOR THIS, AND WHAT DID IT AUTHOR?"
 * (migration 0063, ADR-0032 §8/§9, charter `scp-managed-dep` amendment)
 * ================================================================================================
 *
 * A MERGE IS THE ONE IRREVERSIBLE THING THIS FEATURE DOES, SO IT ACTS ONLY ON FACTS SCP ITSELF
 * RECORDED. That single rule is what this module exists to make structural, and it has two halves
 * that are easy to conflate:
 *
 *   * NEVER A FIELD A TENANT CAN WRITE. The merge path used to read the repository, the base branch,
 *     the component, the line and the branch's head commit out of `changes.source_ref.scp_authored`.
 *     `source_ref` is the raw delivery payload plus a few lifted keys and is writable verbatim by any
 *     authenticated principal through `POST /api/v1/changes`; the event that starts the gate is
 *     likewise producible through `POST /change-sources/{kind}/report`. So a tenant could fabricate a
 *     bump naming ANY repository and have SCP merge into it with SCP's credential. That is a confused
 *     deputy, not a validation gap — validating an attacker-writable field yields a well-formed
 *     attacker-supplied answer.
 *   * NEVER STATE READ BACK FROM THE PROVIDER. The pull request a merge targets is the one SCP
 *     OPENED, identified by the number SCP recorded when it opened it — not "the first open pull
 *     request whose head is our branch", which is provider list ordering deciding what gets merged.
 *
 * WHO MAY WRITE HERE, exhaustively: `bump-dispatch.ts` (through `bump-actuator.ts`'s
 * `recordBumpAuthorship`) when SCP decides to author and again when the authoring run reports the
 * pull request it opened; `coordination/webhook-processor.ts` when SCP's OWN branch is observed back
 * through the two-sided branch check; and `bump-gate.ts` when the provider confirms a merge. There is
 * no route, no IaC object type and no federation importer that reaches this table.
 *
 * `changes.source_ref.scp_authored` KEEPS BEING WRITTEN and is no longer READ by anything that
 * decides a write: it is the human-readable explanation on the change (principle 6, "why was this not
 * auto-merged?"). Deleting it would remove an explanation, not a control.
 */

/** What SCP recorded about a bump it authored. Every field is server-written. */
export interface BumpAuthorship {
  changeObjectId: string;
  componentObjectId: string;
  lineId: string;
  repo: string;
  baseBranch: string;
  authoredRef: string;
  ecosystem: string;
  coordinate: string;
  manifestPath: string;
  fromVersion: string;
  toVersion: string;
  /** The commit SCP's own branch is at. `undefined` until the authored push is observed back. */
  headCommit?: string;
  /** The pull request SCP opened. `undefined` until the authoring run reports one. */
  pullRequestNumber?: number;
  /** When the provider confirmed the merge. `undefined` while the bump is still open. */
  mergedAt?: Date;
}

export interface RecordBumpAuthorshipInput {
  changeObjectId: string;
  componentObjectId: string;
  lineId: string;
  repo: string;
  baseBranch: string;
  authoredRef: string;
  ecosystem: string;
  coordinate: string;
  manifestPath: string;
  fromVersion: string;
  toVersion: string;
}

type Row = typeof dependencyBumpAuthorships.$inferSelect;

function toAuthorship(row: Row): BumpAuthorship {
  return {
    changeObjectId: row.changeObjectId,
    componentObjectId: row.componentObjectId,
    lineId: row.lineId,
    repo: row.repo,
    baseBranch: row.baseBranch,
    authoredRef: row.authoredRef,
    ecosystem: row.ecosystem,
    coordinate: row.coordinate,
    manifestPath: row.manifestPath,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    ...(row.headCommit ? { headCommit: row.headCommit } : {}),
    ...(typeof row.pullRequestNumber === "number"
      ? { pullRequestNumber: row.pullRequestNumber }
      : {}),
    ...(row.mergedAt ? { mergedAt: row.mergedAt } : {})
  };
}

/**
 * Record that SCP is authoring this bump. Written in the SAME transaction as the bump change itself,
 * so a change without an authorship (or an authorship without a change) is not a state a crash can
 * produce.
 *
 * IDEMPOTENT AND NON-CLOBBERING under redelivery: a re-dispatch of the same bump re-states the same
 * facts, and `DO NOTHING` keeps the observed columns (`head_commit`, `pull_request_number`,
 * `merged_at`) that a later ingress wrote. Re-authoring must never un-record that SCP's branch has
 * already merged.
 */
export async function recordBumpAuthorship(
  tx: TenantTx,
  orgId: string,
  input: RecordBumpAuthorshipInput
): Promise<void> {
  await tx
    .insert(dependencyBumpAuthorships)
    .values({ orgId, ...input })
    .onConflictDoNothing({
      target: [dependencyBumpAuthorships.orgId, dependencyBumpAuthorships.changeObjectId]
    });
}

/** What SCP recorded for this change, or `undefined` — which means SCP did not author it. */
export async function readBumpAuthorship(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<BumpAuthorship | undefined> {
  const rows = await tx
    .select()
    .from(dependencyBumpAuthorships)
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.changeObjectId, changeObjectId)
      )
    )
    .limit(1);
  return rows[0] ? toAuthorship(rows[0]) : undefined;
}

/**
 * The open bump SCP already authored for this (component, manifest, coordinate, target version), or
 * `undefined`.
 *
 * EVERY COLUMN OF THE KEY IS COMPARED, and the first two are why: a dependency LINE exists to be
 * declared by many components, and one component legitimately declares one line from two manifests.
 * Keyed on (coordinate, toVersion) alone — which is what the jsonb predecessor effectively did — the
 * second component to reach this reused the first one's change, so it got no change, no branch and no
 * bump, and the returning push then correlated to a change that was not about it.
 *
 * A MERGED bump is excluded: it is not open, and reusing its change would author a second commit onto
 * a branch that has already landed.
 */
export async function findOpenBumpAuthorship(
  tx: TenantTx,
  orgId: string,
  key: {
    componentObjectId: string;
    manifestPath: string;
    coordinate: string;
    toVersion: string;
  }
): Promise<BumpAuthorship | undefined> {
  const rows = await tx
    .select()
    .from(dependencyBumpAuthorships)
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.componentObjectId, key.componentObjectId),
        eq(dependencyBumpAuthorships.manifestPath, key.manifestPath),
        eq(dependencyBumpAuthorships.coordinate, key.coordinate),
        eq(dependencyBumpAuthorships.toVersion, key.toVersion),
        sql`${dependencyBumpAuthorships.mergedAt} is null`
      )
    )
    .limit(1);
  return rows[0] ? toAuthorship(rows[0]) : undefined;
}

/**
 * The bump whose OWN branch head is `commit` in `repo`, or `undefined` — the CI-conclusion
 * correlation route (GitHub's `workflow_run` names a commit and no ref).
 *
 * BOUNDED AND INDEXED, which its predecessor was not: that one loaded EVERY dependency-bump change in
 * the org, unfiltered, inside the ingress transaction, on essentially every webhook, and compared
 * jsonb in TypeScript. Here the org, the head commit and the repository are all SQL predicates served
 * by `dependency_bump_authorships_org_head_commit`, and the columns are typed `text` rather than
 * `unknown`-out-of-jsonb, so there is nothing left to compare in the application.
 *
 * The comparisons are the ones the jsonb version documented and they are kept exactly: the commit
 * case-insensitively (git object ids are hex and providers spell them either way) and NEVER by
 * prefix — an abbreviated sha is a different string, and a prefix match is how a 7-character value
 * would attach to any commit that happens to start the same way. The repository case-insensitively,
 * because all three providers address repository paths that way.
 */
export async function findBumpAuthorshipByHeadCommit(
  tx: TenantTx,
  orgId: string,
  input: { repo: string; commit: string }
): Promise<BumpAuthorship | undefined> {
  const rows = await tx
    .select()
    .from(dependencyBumpAuthorships)
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        isNotNull(dependencyBumpAuthorships.headCommit),
        sql`lower(${dependencyBumpAuthorships.headCommit}) = lower(${input.commit.trim()})`,
        sql`lower(${dependencyBumpAuthorships.repo}) = lower(${input.repo.trim()})`
      )
    )
    .limit(1);
  return rows[0] ? toAuthorship(rows[0]) : undefined;
}

/**
 * Record which commit SCP's authored branch is now at.
 *
 * A LATER PUSH TO THE SAME BRANCH OVERWRITES IT, deliberately: the bump's head IS the newest commit
 * on its branch, and leaving the first one standing would let evidence about a superseded commit
 * authorise merging a different tree. Idempotent under redelivery — the same push writes the same
 * value.
 */
export async function recordBumpHeadCommit(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  headCommit: string
): Promise<void> {
  await tx
    .update(dependencyBumpAuthorships)
    .set({ headCommit, updatedAt: new Date() })
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.changeObjectId, changeObjectId)
      )
    );
}

/**
 * Record the pull request the authoring run reported opening.
 *
 * WRITE-ONCE, and the `is null` predicate is the control rather than a convenience: the number is
 * what the merge is addressed to, so a later run must not be able to re-point it at a different pull
 * request. A retry of the same bump converges on the same branch and therefore on the same pull
 * request, so re-stating it is redundant rather than necessary; a DIFFERENT number arriving later is
 * the case this refuses to honour.
 */
export async function recordBumpPullRequest(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  pullRequestNumber: number
): Promise<void> {
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) return;
  await tx
    .update(dependencyBumpAuthorships)
    .set({ pullRequestNumber, updatedAt: new Date() })
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.changeObjectId, changeObjectId),
        sql`${dependencyBumpAuthorships.pullRequestNumber} is null`
      )
    );
}

/**
 * Record that the provider confirmed the merge.
 *
 * This is what makes the audit trail stop lying. The merge produces its OWN provider events — the
 * merge commit's push, and whatever CI runs on the base branch afterwards — which correlate straight
 * back to this bump and re-run the gate. That second run finds no OPEN pull request, records
 * `withheld / merge_refused`, and the LATEST Decision for a bump that DID merge then says it did not:
 * charter principle 6 inverted, on the one irreversible action in the feature. With this stamped, the
 * gate returns before dispatching anything.
 */
export async function markBumpMerged(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  mergedAt: Date = new Date()
): Promise<void> {
  await tx
    .update(dependencyBumpAuthorships)
    .set({ mergedAt, updatedAt: new Date() })
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.changeObjectId, changeObjectId),
        sql`${dependencyBumpAuthorships.mergedAt} is null`
      )
    );
}
