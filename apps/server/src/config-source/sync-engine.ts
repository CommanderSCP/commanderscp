/** THE CONFIG-SOURCE SYNC ENGINE. See docs/config-source.md §28. */

import { createHash } from "node:crypto";
import { DesiredStateManifestSchema, type DesiredStateManifest } from "@scp/schemas";
import { hasPermission } from "../authz/resolve.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { freezesByTarget, unionFreezes } from "../governance/freeze-scope.js";
import { findObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import {
  computeDiffForManifest,
  executePlanDiff,
  prepareApplyChecks
} from "../coordination-as-code/plans-repo.js";
import type { TenantTx } from "../db/tenant-tx.js";
import type { ConfigSourceDocument } from "./config-source-document.js";
import { selectChangedManifestPaths } from "./manifest-path-selection.js";
import { resolveConfigSourceForSync, type ConfigSourceRegistration } from "./registration-match.js";
import { recordStackDelivery } from "./stack-delivery-repo.js";
import {
  computeConfigSourceSyncStatus,
  type ConfigSourceSyncStatus,
  type SyncAuthzRefusal
} from "./sync-status.js";

/** The decision `kind` every config-source sync writes. One string, one place. */
export const CONFIG_SOURCE_SYNC_DECISION_KIND = "config_source.sync";

export type ManifestRead = { ok: true; content: string } | { ok: false; detail: string };

export interface ConfigSourceSyncInput {
  /** The config source being synced, and every OTHER live registration — `registration-match.ts`'s
   *  two refusals are both statements about the whole set, so a partial set would make them
   *  false-negative-prone. */
  registrations: readonly ConfigSourceRegistration[];
  configSourceId: string;
  document: ConfigSourceDocument;
  /** The repo the commit landed in, as the trigger identified it. */
  repoIdentity: string;
  commitSha: string;
  changedPaths: readonly string[];
  /** Snapshotted by the caller and used for the whole run — the same rule `freezesByTarget`
   *  states for its own `now`: two manifests of one commit must not be evaluated against two
   *  clocks. */
  now: Date;
  requestId: string;
  readManifest: (path: string) => Promise<ManifestRead>;
}

export interface ManifestSyncOutcome {
  path: string;
  /** Present once the manifest parsed far enough to name a stack. */
  stackName?: string;
  /** Present once a registration governed the attempt and resolved a team. */
  teamObjectId?: string;
  /** Attempt status and registration refusal stay distinct. See docs/config-source.md §29. */
  status:
    | ConfigSourceSyncStatus
    | { status: "registration_ambiguous"; matchedConfigSourceIds: string[] }
    | { status: "stack_owned_elsewhere"; ownerConfigSourceId: string };
  decisionId: string;
}

function manifestContentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** The scope fallback is the point: a create has no id yet. See docs/config-source.md §30. */
function affectedObjectIds(
  objectResolutions: Map<string, { id?: string; scopeObjectId: string }>
): string[] {
  const ids: string[] = [];
  for (const resolution of objectResolutions.values()) {
    ids.push(resolution.id ?? resolution.scopeObjectId);
  }
  return [...new Set(ids)];
}

/** Sync one commit of one config source. See docs/config-source.md §31. */
export async function syncConfigSourceCommit(
  tx: TenantTx,
  orgId: string,
  input: ConfigSourceSyncInput
): Promise<ManifestSyncOutcome[]> {
  const selected = selectChangedManifestPaths(input.document.paths, input.changedPaths);
  const outcomes: ManifestSyncOutcome[] = [];

  for (const match of selected) {
    outcomes.push(await syncOneManifest(tx, orgId, input, match.path));
  }
  return outcomes;
}

async function syncOneManifest(
  tx: TenantTx,
  orgId: string,
  input: ConfigSourceSyncInput,
  path: string
): Promise<ManifestSyncOutcome> {
  const record = async (
    status: ManifestSyncOutcome["status"],
    extra: Record<string, unknown>
  ): Promise<ManifestSyncOutcome> => {
    const decision = await insertDecision(tx, {
      orgId,
      kind: CONFIG_SOURCE_SYNC_DECISION_KIND,
      // The CONFIG SOURCE is the subject, not the stack: the stack may not exist, may not be
      // nameable (an unreadable manifest has no stack), and is not a graph object. "What has this
      // registration been doing" is the question an operator asks.
      subjectId: input.configSourceId,
      verdict: status.status,
      inputContext: {
        // D3: the boundary goes in the Decision, never `now` — the commit SHA and content hash are
        // what make this verdict reproducible.
        repo: input.repoIdentity,
        ref: input.document.ref,
        commitSha: input.commitSha,
        manifestPath: path,
        ...extra
      },
      reasonTree: status as unknown as Record<string, unknown>
    });
    return {
      path,
      status,
      decisionId: decision.id,
      ...(typeof extra.stackName === "string" ? { stackName: extra.stackName } : {}),
      ...(typeof extra.teamObjectId === "string" ? { teamObjectId: extra.teamObjectId } : {})
    };
  };

  const read = await input.readManifest(path);
  if (!read.ok) {
    return record(computeConfigSourceSyncStatus({ stage: "read_failed", detail: read.detail }), {});
  }
  const contentHash = manifestContentHash(read.content);

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch (error) {
    return record(
      computeConfigSourceSyncStatus({
        stage: "validation_failed",
        errors: [error instanceof Error ? error.message : String(error)]
      }),
      { manifestContentHash: contentHash }
    );
  }

  const validated = DesiredStateManifestSchema.safeParse(parsed);
  if (!validated.success) {
    return record(
      computeConfigSourceSyncStatus({
        stage: "validation_failed",
        errors: validated.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      }),
      { manifestContentHash: contentHash }
    );
  }
  const manifest: DesiredStateManifest = validated.data;

  // WHICH REGISTRATION GOVERNS, and D9's two loud refusals. Evaluated against the WHOLE set, not
  // just this config source, because "another registration already claims this stack" is by
  // definition a fact about the others.
  const resolution = resolveConfigSourceForSync(
    input.registrations,
    input.repoIdentity,
    manifest.stackName
  );
  if (resolution.outcome === "ambiguous_repo") {
    return record(
      {
        status: "registration_ambiguous",
        matchedConfigSourceIds: resolution.matches.map((m) => m.id)
      },
      { manifestContentHash: contentHash, stackName: manifest.stackName }
    );
  }
  if (resolution.outcome === "stack_owned_elsewhere") {
    return record(
      { status: "stack_owned_elsewhere", ownerConfigSourceId: resolution.owner.id },
      { manifestContentHash: contentHash, stackName: manifest.stackName }
    );
  }
  if (resolution.outcome === "no_match") {
    // The trigger resolved this repo to this config source and the matcher disagrees — a
    // registration edited between trigger and sync, or a trigger bug. Either way it is not
    // permission to apply as anybody, so it is reported rather than defaulted.
    return record(
      {
        status: "registration_ambiguous",
        matchedConfigSourceIds: []
      },
      { manifestContentHash: contentHash, stackName: manifest.stackName }
    );
  }

  // THE ACTING SUBJECT (D9 as corrected 2026-08-27): the team object itself.
  const team = await findObjectByIdOrUrnAnyType(tx, orgId, resolution.team);
  if (!team || team.typeId !== "team") {
    // The authoring door refuses a document naming a non-team or an unresolvable team, so reaching
    // here means the team was DELETED or retyped after registration. Reported as an authz refusal
    // because that is what it is — there is no subject to run as — rather than as a validation
    // failure, which would blame the manifest for a graph change.
    return record(
      computeConfigSourceSyncStatus({
        stage: "authz_refused",
        refusals: [
          {
            action: "resolve-acting-team",
            typeId: "config-source",
            reason: !team
              ? `config source names team '${resolution.team}', which no longer resolves to an object — nothing can apply as it`
              : `config source names '${resolution.team}', which is now a '${team.typeId}' and not a 'team'`
          }
        ]
      }),
      { manifestContentHash: contentHash, stackName: manifest.stackName }
    );
  }

  const diff = await computeDiffForManifest(tx, orgId, manifest);
  const { checks, objectResolutions } = await prepareApplyChecks(
    tx,
    orgId,
    team.id,
    diff,
    manifest.stackName
  );

  // EVERY check evaluated, not the first denial (module doc).
  const refusals: SyncAuthzRefusal[] = [];
  for (const check of checks) {
    const allowed = await hasPermission(tx, {
      orgId,
      subjectObjectId: team.id,
      permission: check.permission,
      scopeObjectId: check.scopeObjectId
    });
    if (!allowed) {
      refusals.push({
        action: check.permission,
        typeId: "scope",
        reason: `team '${team.name}' lacks '${check.permission}' at scope '${check.scopeObjectId}'`
      });
    }
  }
  if (refusals.length > 0) {
    return record(computeConfigSourceSyncStatus({ stage: "authz_refused", refusals }), {
      manifestContentHash: contentHash,
      stackName: manifest.stackName,
      teamObjectId: team.id
    });
  }

  // FREEZES HOLD, THEY DO NOT BLOCK (ADR-0046 §2). Re-evaluated on the next sync/tick; nothing is
  // written and no error is raised, so the manifest applies by itself once the window lifts.
  const covering = unionFreezes(
    await freezesByTarget(tx, orgId, affectedObjectIds(objectResolutions), input.now)
  );
  if (covering.length > 0) {
    return record(
      computeConfigSourceSyncStatus({
        stage: "freeze_held",
        freezeIds: [...new Set(covering.map((f) => f.id))].sort()
      }),
      { manifestContentHash: contentHash, stackName: manifest.stackName, teamObjectId: team.id }
    );
  }

  // D26 — ownership follows delivery, recorded BEFORE the apply. Deliberately before: if another
  // config source already owns this stack, the apply must not happen at all, and doing it the other
  // way round would mean writing the graph and then discovering we were not allowed to.
  const delivery = await recordStackDelivery(tx, orgId, {
    stackName: manifest.stackName,
    configSourceId: input.configSourceId,
    teamObjectId: team.id,
    lastCommitSha: input.commitSha,
    lastManifestPath: path
  });
  if (delivery.outcome === "owned_by_other_source") {
    return record(
      { status: "stack_owned_elsewhere", ownerConfigSourceId: delivery.ownerConfigSourceId },
      { manifestContentHash: contentHash, stackName: manifest.stackName, teamObjectId: team.id }
    );
  }

  await executePlanDiff(tx, {
    orgId,
    actorObjectId: team.id,
    requestId: input.requestId,
    stackName: manifest.stackName,
    diff,
    objectResolutions
  });

  const { summary } = diff;
  const changedEntryCount = summary.creates + summary.updates + summary.deletes;
  return record(computeConfigSourceSyncStatus({ stage: "plan_computed", changedEntryCount }), {
    manifestContentHash: contentHash,
    stackName: manifest.stackName,
    teamObjectId: team.id,
    summary
  });
}
