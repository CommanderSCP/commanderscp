import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { ListObjectsQuery, ListQuery } from "@scp/sdk";
import type {
  ApprovalRequest,
  ApprovalVote,
  Campaign,
  CampaignExplainResponse,
  CampaignStatus,
  Change,
  ChangeExplainResponse,
  ChangeState,
  ChangeWaitStatus,
  CreateObjectRequest,
  Decision,
  DesiredStateManifest,
  ExecutorType,
  Freeze,
  GraphObject,
  Initiative,
  InitiativeRollupResponse,
  NamedGraphQuery,
  ObjectListResponse,
  Pat,
  Plan,
  PlanDiffSummary,
  PlanObjectDiffEntry,
  PlanRelationshipDiffEntry,
  PolicyEvaluateResponse,
  Relationship,
  RelationshipListResponse,
  UpdateObjectRequest,
  UpsertObjectRequest,
  // M6: Federation Basics (BUILD_AND_TEST.md §8 M6, DESIGN §13).
  DeliveryTarget,
  FederationPeer,
  FederationStatusResponse,
  ImportBundleRequest,
  SyncScope
} from "@scp/schemas";
import { DesiredStateManifestSchema } from "@scp/schemas";
// Node-only hashing (`node:crypto`) — deliberately a separate subpath from `@scp/schemas`'
// default entry, which `apps/web` also imports (browser build) — see audit-chain.ts's module doc.
import { verifyAuditChain } from "@scp/schemas/audit-chain";
import { saveCredentials } from "./config-store.js";
import { clientFromStoredCredentials, resolveLoginBaseUrl } from "./client-factory.js";
import { promptLine } from "./prompt.js";
import { printResult, type OutputFormat } from "./output.js";

function parseJsonOption(
  value: string | undefined,
  flag: string
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${flag} must be a JSON object: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** M12 P4B — parse a `--requires` flag value: comma-separated `key@objectIdOrUrn` entries (the
 *  SAME format on `scp change propose` and `scp change-source report`). Split on the LAST '@' so a
 *  URN (which contains ':' but not '@') survives; a missing/empty half is a clear error, not a
 *  silent drop. */
function parseRequiresFlag(
  value: string | undefined
): { key: string; at: string }[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((entry) => {
    const at = entry.slice(entry.lastIndexOf("@") + 1).trim();
    const key = entry.slice(0, entry.lastIndexOf("@")).trim();
    if (entry.lastIndexOf("@") < 0 || !key || !at) {
      throw new Error(`--requires entry '${entry}' must be 'key@objectIdOrUrn'`);
    }
    return { key, at };
  });
}

function objectRow(o: GraphObject): Record<string, string> {
  return {
    id: o.id,
    type: o.typeId,
    name: o.name,
    urn: o.urn,
    version: String(o.version),
    deleted: o.deletedAt ? "yes" : "no"
  };
}

function relationshipRow(r: Relationship): Record<string, string> {
  return { id: r.id, type: r.typeId, from: r.fromId, to: r.toId };
}

function patRow(p: Pat): Record<string, string> {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt ?? "(none)",
    revoked: p.revokedAt ? "yes" : "no",
    lastUsedAt: p.lastUsedAt ?? "(never)"
  };
}

/** Compact row for `scp change list` — mirrors `objectRow`'s style. */
function changeRow(c: Change): Record<string, string> {
  return {
    id: c.id,
    name: c.name,
    state: c.state,
    sourceKind: c.sourceKind ?? "",
    correlationKey: c.correlationKey ?? "",
    createdAt: c.createdAt
  };
}

/** Fuller row for single-Change commands (propose/get/cancel/promote/rollback). */
function changeDetailRow(c: Change): Record<string, string> {
  return {
    id: c.id,
    name: c.name,
    urn: c.urn,
    state: c.state,
    sourceKind: c.sourceKind ?? "",
    correlationKey: c.correlationKey ?? "",
    rollbackOfObjectId: c.rollbackOfObjectId ?? "",
    emergency: c.emergency ? "yes" : "no",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  };
}

function decisionRow(d: Decision): Record<string, string> {
  return {
    id: d.id,
    kind: d.kind,
    subjectId: d.subjectId,
    verdict: d.verdict,
    createdAt: d.createdAt
  };
}

// -------------------------------------------------------------------------------------
// M5 Campaigns & Initiatives (BUILD_AND_TEST.md §8 M5, DESIGN.md §9.5) — row formatters.
// Campaign `status` is a pure derived field (no promote/cancel verbs), so it's surfaced
// prominently in both the compact and detail rows.
// -------------------------------------------------------------------------------------

function campaignRow(c: Campaign): Record<string, string> {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    targets: String(c.targets.length),
    createdAt: c.createdAt
  };
}

function campaignDetailRow(c: Campaign): Record<string, string> {
  return {
    id: c.id,
    name: c.name,
    urn: c.urn,
    status: c.status,
    description: c.description ?? "",
    targets: c.targets.join(", "),
    topologyObjectId: c.topologyObjectId ?? "",
    topologyVersion: c.topologyVersion !== null ? String(c.topologyVersion) : "",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  };
}

function initiativeRow(i: Initiative): Record<string, string> {
  return {
    id: i.id,
    name: i.name,
    urn: i.urn,
    description: i.description ?? "",
    createdAt: i.createdAt
  };
}

// -------------------------------------------------------------------------------------
// M6 Federation Basics (BUILD_AND_TEST.md §8 M6, DESIGN.md §13) — row formatters.
// -------------------------------------------------------------------------------------

function peerRow(p: FederationPeer): Record<string, string> {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    baseUrl: p.baseUrl ?? "",
    syncScope: p.syncScope.mode,
    // M17.3 (E5) — whether this peer's cosign VERIFICATION key is registered (from pairing). Presence
    // only in the table; the full PEM is in `--output json`. A peer paired before E5 shows "none".
    cosign: p.cosignPublicKey ? "registered" : "none",
    // M13.2a (§13.2) — the peer's DeliveryTarget provider, or "env" when none is configured (the
    // instance `SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` fallback). Full dirs are in `--output json`.
    delivery: p.deliveryTarget?.provider ?? "env",
    pairedAt: p.pairedAt
  };
}

function printFederationStatus(status: FederationStatusResponse, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(
    status.self
      ? `Self: ${status.self.name} (${status.self.domainId}) role=${status.self.role}`
      : "Self: not initialized — run `scp federation init`"
  );
  // M17.3 (E5) — the LOCAL cosign verification public key an operator copies into a peer's
  // `scp federation pair --cosign-public-key ...` for out-of-band distribution (works file-only for
  // air-gapped peers). Full value in `--output json`; here we note presence to keep the line compact.
  if (status.self) {
    console.log(
      status.self.cosignPublicKey
        ? `Cosign verification key: present (copy from \`scp federation self\` / --output json)`
        : "Cosign verification key: not yet provisioned"
    );
  }
  if (status.peers.length === 0) {
    console.log("No paired peers.");
    return;
  }
  printResult(status.peers, "table", (item) => {
    const p = item as FederationStatusResponse["peers"][number];
    return {
      peer: `${p.peer.name} (${p.peer.id})`,
      role: p.peer.role,
      // DESIGN §13: air-gapped peers are explicitly "as of <bundle/date>", never presented as live.
      syncedThrough:
        p.lastAppliedSequence !== null ? `seq ${p.lastAppliedSequence}` : "never synced",
      asOf: p.lastSyncedAt ?? "never",
      recentTransfers: String(p.recentTransfers.length)
    };
  });
}

// -------------------------------------------------------------------------------------
// M4 Governance Engine (BUILD_AND_TEST.md §8 M4, DESIGN.md §10) — row formatters for
// approvals/freezes; policies/controls reuse `objectRow` (they're typed-registry resources).
// -------------------------------------------------------------------------------------

function approvalRow(a: ApprovalRequest): Record<string, string> {
  return {
    id: a.id,
    changeObjectId: a.changeObjectId,
    fromRole: a.fromRole,
    votes: `${a.voteCount}/${a.requiredCount}`,
    status: a.status,
    createdAt: a.createdAt
  };
}

function approvalVoteRow(v: ApprovalVote): Record<string, string> {
  return {
    id: v.id,
    voterObjectId: v.voterObjectId,
    votedAt: v.votedAt,
    signature: `${v.attestation.signature.slice(0, 16)}...`
  };
}

function freezeRow(f: Freeze): Record<string, string> {
  return {
    id: f.id,
    scopeObjectId: f.scopeObjectId,
    name: f.name ?? "",
    startsAt: f.startsAt,
    endsAt: f.endsAt,
    reason: f.reason
  };
}

function printPolicyEvaluateResult(result: PolicyEvaluateResponse, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Verdict: ${result.verdict}`);
  const summary =
    typeof result.reasonTree["summary"] === "string"
      ? (result.reasonTree["summary"] as string)
      : JSON.stringify(result.reasonTree);
  console.log(summary);
}

// -------------------------------------------------------------------------------------
// `@scp/iac` plan/apply (BUILD_AND_TEST.md §8 M2 item 4) — `scp plan` computes a diff
// (dry run); `scp apply` does plan + apply in one shot, since that's the natural CLI UX and
// what "`scp apply` twice = no-op the second time" means end to end, not two manual steps.
// -------------------------------------------------------------------------------------

async function readManifestFile(manifestPath: string): Promise<DesiredStateManifest> {
  const raw = await readFile(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--manifest '${manifestPath}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return DesiredStateManifestSchema.parse(parsed);
}

function diffEntryRow(
  entry: PlanObjectDiffEntry | PlanRelationshipDiffEntry
): Record<string, string> {
  if (entry.kind === "object") {
    return { kind: "object", action: entry.action, ref: entry.urn, reason: entry.reason };
  }
  return {
    kind: "relationship",
    action: entry.action,
    ref: `${entry.fromUrn} --${entry.typeId}--> ${entry.toUrn}`,
    reason: entry.reason
  };
}

function summaryLine(summary: PlanDiffSummary): string {
  return `creates=${summary.creates} updates=${summary.updates} deletes=${summary.deletes} noops=${summary.noops}`;
}

/** Prints a plan (full diff with per-entry reasons) — `scp plan` and `scp plan-status`. */
function printPlanResult(plan: Plan, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const entries = [...plan.diff.objects, ...plan.diff.relationships];
  printResult(entries, "table", (item) =>
    diffEntryRow(item as PlanObjectDiffEntry | PlanRelationshipDiffEntry)
  );
  console.log(
    `\nPlan ${plan.id} (${plan.stackName}, status: ${plan.status}): ${summaryLine(plan.diff.summary)}`
  );
}

/**
 * Prints an apply summary — `--output json` gives a flat, machine-parseable
 * `{creates,updates,deletes,noops}` shape (not just prose), which is what makes DoD (b)'s
 * "`scp apply` twice = no-op" assertable from a test (plans.cli.integration.test.ts).
 */
function printApplyResult(plan: Plan, summary: PlanDiffSummary, output: OutputFormat): void {
  if (output === "json") {
    console.log(
      JSON.stringify(
        {
          planId: plan.id,
          stackName: plan.stackName,
          status: plan.status,
          creates: summary.creates,
          updates: summary.updates,
          deletes: summary.deletes,
          noops: summary.noops
        },
        null,
        2
      )
    );
    return;
  }
  console.log(`Applied plan ${plan.id} (${plan.stackName}): ${summaryLine(summary)}`);
}

/**
 * Renders a Change's coupled-pipeline wait status (M12 P4B) — the shared body of `scp change
 * explain` (embedded, alongside plan/Decisions) and `scp change wait-status` (standalone). `null`
 * means the change declared no `requires`; a `wait-status` caller wants an explicit line for that
 * case (there is nothing else on the screen to say so), `explain` silently omits the section
 * instead (unchanged since Phase 4's `explain` support landed) — hence the `standalone` flag.
 */
function printWaitStatusBody(waitStatus: ChangeWaitStatus | null, standalone: boolean): void {
  if (!waitStatus) {
    if (standalone) console.log("(no coupled-pipeline prerequisites — this change declared no `requires`)");
    return;
  }
  const outstanding = waitStatus.requirements.filter((r) => !r.satisfied).length;
  // Derived from `outstanding`, not `waitStatus.waiting` alone: `waiting` reflects the change's
  // STATE (`state === "waiting"`), which is false for a change read before it ever parked (still
  // `coordinated`/`proposed`) or after it released (`executing`/`validating`/`promoted`) — either
  // of which can still have an outstanding row (a not-yet-evaluated requirement, or a provider
  // that was cancelled after release). Heading off `waiting` alone would print "all satisfied"
  // over a row printing OUTSTANDING.
  const header =
    outstanding > 0
      ? `Waiting on ${outstanding} of ${waitStatus.requirements.length} prerequisite(s):`
      : `Coupled prerequisites (${waitStatus.requirements.length}, all satisfied):`;
  console.log(standalone ? header : `\n${header}`);
  for (const req of waitStatus.requirements) {
    const at = req.atName ? `${req.atName} (${req.at})` : req.at;
    const mark = req.satisfied ? `satisfied by change ${req.satisfiedByChangeId}` : "OUTSTANDING";
    console.log(`  - ${req.key} @ ${at}: ${mark}`);
    // "Did you mean?" (coupled-pipelines.md §3.7): only ever present on an outstanding requirement.
    if (req.didYouMean && req.didYouMean.length > 0) {
      console.log(`      did you mean one of: ${req.didYouMean.join(", ")}?`);
    }
  }
  if (waitStatus.malformed && waitStatus.malformed.length > 0) {
    console.log(`  malformed requires entries (unsatisfiable — fix and re-propose): ${JSON.stringify(waitStatus.malformed)}`);
  }
}

/**
 * Prints a Change's compiled plan (waves/targets) and every Decision made about it, in order —
 * the CLI's window into the coordination engine's reasoning (BUILD_AND_TEST.md §8 M3 DoD:
 * "`scp change explain` renders" the Decision record). Deviates from `printResult`/`printTable`
 * (which assume flat rows), same as `printPlanResult`/`printApplyResult` above and for the same
 * reason — this shape (a change, an optional plan tree, an ordered decision list) isn't a table.
 */
function printExplainResult(result: ChangeExplainResponse, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { change, plan, decisions, controlRuns, waitStatus } = result;
  console.log(`Change ${change.id} '${change.name}' — state: ${change.state}`);

  // M12 P4B: coupled-pipeline wait status. Present only for a change that declared `requires`.
  printWaitStatusBody(waitStatus, false);

  if (plan) {
    console.log(`\nPlan ${plan.id} (status: ${plan.status}):`);
    for (const wave of plan.waves) {
      const label = wave.name ? `${wave.waveIndex} (${wave.name})` : String(wave.waveIndex);
      console.log(`  Wave ${label} — ${wave.status}`);
      for (const target of wave.targets) {
        const ref = target.targetUrn ?? target.targetName ?? target.targetObjectId;
        console.log(`    - ${ref}: ${target.status}`);
      }
    }
  } else {
    console.log("\n(no plan compiled yet)");
  }

  console.log(`\nDecisions (${decisions.length}):`);
  for (const decision of decisions) {
    const summary =
      typeof decision.reasonTree["summary"] === "string"
        ? (decision.reasonTree["summary"] as string)
        : JSON.stringify(decision.reasonTree);
    console.log(`  [${decision.createdAt}] ${decision.kind} -> ${decision.verdict}: ${summary}`);
  }

  // DESIGN §10.4 / BUILD_AND_TEST M4 flagship E2E: "explain reconstructs policy version + control
  // outcome + evidence" — the Decisions above already carry policy version + outcome status
  // (reasonTree.policies[].contributingPolicyVersions / effects[].detail), but the actual evidence
  // payload only ever lives on the control_run row itself, joined by controlObjectId.
  if (controlRuns.length > 0) {
    console.log(`\nControl runs (${controlRuns.length}):`);
    for (const run of controlRuns) {
      console.log(
        `  [${run.createdAt}] control ${run.controlObjectId} -> ${run.status}${run.detail ? `: ${run.detail}` : ""}`
      );
      if (Object.keys(run.evidence).length > 0) {
        console.log(`    evidence: ${JSON.stringify(run.evidence)}`);
      }
    }
  }
}

/**
 * Prints a Campaign's compiled plan (waves/targets, each resolved to its member Change) and every
 * Decision made about it — the campaign-scoped analogue of `printExplainResult` above (M5,
 * DESIGN.md §9.5). Same shape deviation from `printResult`/`printTable` and for the same reason.
 */
function printCampaignExplainResult(result: CampaignExplainResponse, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { campaign, plan, decisions } = result;
  console.log(`Campaign ${campaign.id} '${campaign.name}' — status: ${campaign.status}`);

  if (plan) {
    console.log(`\nPlan ${plan.id} (status: ${plan.status}):`);
    for (const wave of plan.waves) {
      const label = wave.name ? `${wave.waveIndex} (${wave.name})` : String(wave.waveIndex);
      console.log(`  Wave ${label} — ${wave.status}`);
      for (const target of wave.targets) {
        const ref = target.targetUrn ?? target.targetName ?? target.targetObjectId;
        console.log(
          `    - ${ref}: ${target.status}${target.memberChangeObjectId ? ` (change ${target.memberChangeObjectId})` : ""}`
        );
      }
    }
  } else {
    console.log("\n(no plan compiled yet)");
  }

  console.log(`\nDecisions (${decisions.length}):`);
  for (const decision of decisions) {
    const summary =
      typeof decision.reasonTree["summary"] === "string"
        ? (decision.reasonTree["summary"] as string)
        : JSON.stringify(decision.reasonTree);
    console.log(`  [${decision.createdAt}] ${decision.kind} -> ${decision.verdict}: ${summary}`);
  }
}

/**
 * Prints an Initiative's roll-up (BUILD_AND_TEST.md §8 M5, DESIGN.md §9.5): the initiative, each
 * member campaign's name + derived status, then the traversal-derived overall `rollupStatus`.
 */
function printInitiativeRollupResult(result: InitiativeRollupResponse, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { initiative, campaigns, rollupStatus } = result;
  console.log(`Initiative ${initiative.id} '${initiative.name}'`);

  console.log(`\nCampaigns (${campaigns.length}):`);
  for (const member of campaigns) {
    console.log(`  - ${member.campaign.name} (${member.campaign.id}): ${member.status}`);
  }

  console.log(`\nRoll-up status: ${rollupStatus}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives the CLI side of the device authorization flow (BUILD_AND_TEST.md §8 M2 item 3): starts
 * the request, prints the code+URL for the human to open in a browser, then polls at the
 * server-suggested interval until a token, a denial, or expiry — capping total wait at the
 * request's own `expiresIn`. `authorization_pending` is expected/normal while the human hasn't
 * approved yet; every other device-flow error code is terminal.
 */
async function deviceLogin(
  client: ScpClient
): Promise<{ token: string; expiresAt: string; org: string }> {
  const started = await client.deviceFlow.start();
  console.log(`Open ${started.verificationUri} and enter code ${started.userCode}`);
  console.log("Waiting for approval...");

  const deadline = Date.now() + started.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(started.interval * 1000);
    try {
      return await client.deviceFlow.poll(started.deviceCode);
    } catch (err) {
      const code =
        err instanceof ScpApiError && err.problem && "error" in err.problem
          ? (err.problem as { error?: string }).error
          : undefined;
      if (code === "authorization_pending") continue;
      if (code === "expired_token") {
        throw new Error("device authorization request expired — run `scp login --device` again");
      }
      if (code === "access_denied") throw new Error("device authorization request was denied");
      throw err;
    }
  }
  throw new Error("device authorization timed out waiting for approval");
}

// -------------------------------------------------------------------------------------------
// M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1). All 8 resources — domain/service/
// component/deployment-target/team/group/user/service-account — expose the exact same
// create/list/get/update/delete/upsertByUrn shape (ScpClient.typedResource), and the 4
// `owns`-eligible + 2 `consumes`/`depends_on`-eligible resources add ownership/edge methods on
// top. These three factories build the `register`/`list`/`get`/`update`/`delete`/`upsert` and
// `add-owner`/`add-consumes`/`add-depends-on` command families once, instead of hand-copying
// them per resource — mirroring routes/typed-registries.ts and routes/ownership.ts server-side.
// -------------------------------------------------------------------------------------------

interface TypedResourceOps {
  create(req: CreateObjectRequest, opts?: { idempotencyKey?: string }): Promise<GraphObject>;
  list(query?: ListObjectsQuery): Promise<ObjectListResponse>;
  get(idOrUrn: string): Promise<GraphObject>;
  update(idOrUrn: string, req: UpdateObjectRequest): Promise<GraphObject>;
  delete(idOrUrn: string): Promise<GraphObject>;
  upsertByUrn(urn: string, req: UpsertObjectRequest): Promise<GraphObject>;
}

interface OwnerOps {
  addOwner(
    idOrUrn: string,
    ownerIdOrUrn: string,
    opts?: { idempotencyKey?: string }
  ): Promise<Relationship>;
  listOwners(idOrUrn: string, query?: ListQuery): Promise<RelationshipListResponse>;
  removeOwner(idOrUrn: string, ownerIdOrUrn: string): Promise<Relationship>;
}

interface EdgeOps {
  addConsumes(
    idOrUrn: string,
    targetIdOrUrn: string,
    opts?: { idempotencyKey?: string }
  ): Promise<Relationship>;
  listConsumes(idOrUrn: string, query?: ListQuery): Promise<RelationshipListResponse>;
  removeConsumes(idOrUrn: string, targetIdOrUrn: string): Promise<Relationship>;
  addDependsOn(
    idOrUrn: string,
    targetIdOrUrn: string,
    opts?: { idempotencyKey?: string }
  ): Promise<Relationship>;
  listDependsOn(idOrUrn: string, query?: ListQuery): Promise<RelationshipListResponse>;
  removeDependsOn(idOrUrn: string, targetIdOrUrn: string): Promise<Relationship>;
}

interface BaseCliOpts {
  baseUrl?: string;
  output: OutputFormat;
}

/**
 * Registers `scp <name> register|list|get|update|delete|upsert`, options mirroring `object
 * create`/`object list`/etc. exactly. Returns the resource's top-level `Command` so callers can
 * attach `add-owner`/`add-consumes`/`add-depends-on` families on top where applicable.
 */
function registerTypedResourceCrud(
  program: Command,
  name: string,
  resourceOf: (client: ScpClient) => TypedResourceOps,
  opts?: { serviceOption?: boolean }
): Command {
  const cmd = program.command(name).description(`Manage ${name} objects`);

  // `component` create is strict: it MUST name an owning service (M12 P5a). Only that resource sets
  // `serviceOption`, mirroring the server's bespoke `POST /components` (a component always belongs to
  // a service — the CLI carries `--service` through to `CreateComponentRequest.service`).
  const registerCmd = cmd
    .command("register")
    .description(`Create a ${name}`)
    .requiredOption("--name <name>", `${name} name`);
  if (opts?.serviceOption) {
    registerCmd.requiredOption("--service <idOrUrn>", `owning service id or URN (a ${name} belongs to a service)`);
  }
  registerCmd
    .option("--id <uuid>", "client-suppliable UUIDv7 id")
    .option("--urn <urn>", "explicit URN (defaults to a derived one)")
    .option("--domain-id <id>", "containing object id (defaults to the org root)")
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        cmdOpts: BaseCliOpts & {
          name: string;
          service?: string;
          id?: string;
          urn?: string;
          domainId?: string;
          properties?: string;
          labels?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(cmdOpts);
        // `service` is only present when `serviceOption` is set (component); it rides through the
        // request body to `CreateComponentRequest.service` (SDK sends the whole body). The cast is
        // needed because the shared `TypedResourceOps.create` is typed to the base request.
        const created = await resourceOf(client).create(
          {
            name: cmdOpts.name,
            id: cmdOpts.id,
            urn: cmdOpts.urn,
            domainId: cmdOpts.domainId,
            properties: parseJsonOption(cmdOpts.properties, "--properties"),
            labels: parseJsonOption(cmdOpts.labels, "--labels"),
            ...(opts?.serviceOption ? { service: cmdOpts.service } : {})
          } as CreateObjectRequest,
          { idempotencyKey: randomUUID() }
        );
        printResult(created, cmdOpts.output, (item) => objectRow(item as GraphObject));
      }
    );

  cmd
    .command("list")
    .description(`List ${name} objects`)
    .option("--domain-id <id>", "filter by containing object id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { domainId?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await resourceOf(client).list({ domainId: opts.domainId, limit: 100 });
      printResult(page.items, opts.output, (item) => objectRow(item as GraphObject));
    });

  cmd
    .command("get <idOrUrn>")
    .description(`Get a ${name} by id or URN`)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await resourceOf(client).get(idOrUrn);
      printResult(found, opts.output, (item) => objectRow(item as GraphObject));
    });

  cmd
    .command("update <idOrUrn>")
    .description(`Partially update a ${name}`)
    .option("--name <name>")
    .option("--properties <json>", "JSON object (full replace)")
    .option("--labels <json>", "JSON object (full replace)")
    .option("--version <n>", "expected version (optimistic concurrency)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        idOrUrn: string,
        opts: BaseCliOpts & {
          name?: string;
          properties?: string;
          labels?: string;
          version?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const updated = await resourceOf(client).update(idOrUrn, {
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties"),
          labels: parseJsonOption(opts.labels, "--labels"),
          version: opts.version ? Number(opts.version) : undefined
        });
        printResult(updated, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  cmd
    .command("delete <idOrUrn>")
    .description(`Soft-delete a ${name}`)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const deleted = await resourceOf(client).delete(idOrUrn);
      printResult(deleted, opts.output, (item) => objectRow(item as GraphObject));
    });

  const upsertCmd = cmd
    .command("upsert <urn>")
    .description("Idempotent upsert-by-URN")
    .requiredOption("--name <name>");
  if (opts?.serviceOption) {
    // Optional here (not required): the server needs `--service` only on the CREATE branch (a URN
    // that doesn't exist yet); updating an existing component ignores it (re-assignment is P5b's
    // move verb). Omitting it while creating gets a clear 400 from the server.
    upsertCmd.option("--service <idOrUrn>", "owning service id or URN (required when this URN is new)");
  }
  upsertCmd
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        urn: string,
        cmdOpts: BaseCliOpts & { name: string; service?: string; properties?: string; labels?: string }
      ) => {
        const client = await clientFromStoredCredentials(cmdOpts);
        const result = await resourceOf(client).upsertByUrn(urn, {
          name: cmdOpts.name,
          properties: parseJsonOption(cmdOpts.properties, "--properties"),
          labels: parseJsonOption(cmdOpts.labels, "--labels"),
          ...(opts?.serviceOption ? { service: cmdOpts.service } : {})
        } as UpsertObjectRequest);
        printResult(result, cmdOpts.output, (item) => objectRow(item as GraphObject));
      }
    );

  return cmd;
}

/** Adds `add-owner`/`list-owners`/`remove-owner` to an existing resource command. */
function registerOwnerCommands(cmd: Command, resourceOf: (client: ScpClient) => OwnerOps): void {
  cmd
    .command("add-owner <idOrUrn>")
    .description("Add an owner (owns) — owner may be a team, group, user, or service-account")
    .requiredOption("--owner <ownerIdOrUrn>", "owner id or URN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { owner: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const created = await resourceOf(client).addOwner(idOrUrn, opts.owner, {
        idempotencyKey: randomUUID()
      });
      printResult(created, opts.output, (item) => relationshipRow(item as Relationship));
    });

  cmd
    .command("list-owners <idOrUrn>")
    .description("List direct owners")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await resourceOf(client).listOwners(idOrUrn, { limit: 100 });
      printResult(page.items, opts.output, (item) => relationshipRow(item as Relationship));
    });

  cmd
    .command("remove-owner <idOrUrn> <ownerIdOrUrn>")
    .description("Remove an owner")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, ownerIdOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const deleted = await resourceOf(client).removeOwner(idOrUrn, ownerIdOrUrn);
      printResult(deleted, opts.output, (item) => relationshipRow(item as Relationship));
    });
}

/** Adds `add-consumes|add-depends-on` (+ list/remove) to an existing resource command. */
function registerEdgeCommands(
  cmd: Command,
  edge: "consumes" | "depends-on",
  resourceOf: (client: ScpClient) => EdgeOps
): void {
  const relTypeId = edge === "consumes" ? "consumes" : "depends_on";
  const add = (ops: EdgeOps) => (edge === "consumes" ? ops.addConsumes : ops.addDependsOn);
  const list = (ops: EdgeOps) => (edge === "consumes" ? ops.listConsumes : ops.listDependsOn);
  const remove = (ops: EdgeOps) => (edge === "consumes" ? ops.removeConsumes : ops.removeDependsOn);

  cmd
    .command(`add-${edge} <idOrUrn>`)
    .description(`Add a '${relTypeId}' edge`)
    .requiredOption("--target <targetIdOrUrn>", "target id or URN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { target: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const created = await add(resourceOf(client))(idOrUrn, opts.target, {
        idempotencyKey: randomUUID()
      });
      printResult(created, opts.output, (item) => relationshipRow(item as Relationship));
    });

  cmd
    .command(`list-${edge} <idOrUrn>`)
    .description(`List direct outgoing '${relTypeId}' edges`)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await list(resourceOf(client))(idOrUrn, { limit: 100 });
      printResult(page.items, opts.output, (item) => relationshipRow(item as Relationship));
    });

  cmd
    .command(`remove-${edge} <idOrUrn> <targetIdOrUrn>`)
    .description(`Remove a '${relTypeId}' edge`)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, targetIdOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const deleted = await remove(resourceOf(client))(idOrUrn, targetIdOrUrn);
      printResult(deleted, opts.output, (item) => relationshipRow(item as Relationship));
    });
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("scp").description("CommanderSCP CLI").version("0.0.0");

  // -------------------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------------------
  program
    .command("login")
    .description("Exchange credentials for a bearer token and store it")
    .option("-u, --username <username>", "username", process.env.SCP_USERNAME)
    .option("-p, --password <password>", "password", process.env.SCP_PASSWORD)
    .option(
      "--device",
      "use the device authorization flow instead of username+password (for headless hosts — DESIGN.md §7)"
    )
    .option(
      "--base-url <url>",
      "API base URL (defaults to $SCP_API_URL, then your saved login, then localhost)"
    )
    .action(
      async (opts: {
        username?: string;
        password?: string;
        device?: boolean;
        baseUrl?: string;
      }) => {
        // Precedence: --base-url flag > $SCP_API_URL > saved credentials.json baseUrl > localhost.
        const baseUrl = await resolveLoginBaseUrl(opts.baseUrl);
        const client = new ScpClient({ baseUrl });

        if (opts.device) {
          const result = await deviceLogin(client);
          await saveCredentials({
            baseUrl,
            token: result.token,
            org: result.org,
            expiresAt: result.expiresAt
          });
          console.log(`Logged in (org: ${result.org}) via device authorization. Token stored.`);
          return;
        }

        const username = opts.username ?? (await promptLine("Username: "));
        const password = opts.password ?? (await promptLine("Password: "));
        const result = await client.login(username, password);
        await saveCredentials({
          baseUrl,
          token: result.token,
          org: result.org,
          expiresAt: result.expiresAt
        });
        console.log(`Logged in as '${username}' (org: ${result.org}). Token stored.`);
      }
    );

  // -------------------------------------------------------------------------------------
  // pat (Personal Access Tokens — BUILD_AND_TEST.md §8 M2 item 3)
  // -------------------------------------------------------------------------------------
  const patCmd = program.command("pat").description("Manage Personal Access Tokens");

  patCmd
    .command("create")
    .description("Create a Personal Access Token — the token is printed ONCE, store it now")
    .requiredOption("--name <name>", "label for the token")
    .option("--expires-at <iso>", "ISO 8601 expiry datetime (no expiry if omitted)")
    .option("--base-url <url>", "API base URL override")
    .action(async (opts: { name: string; expiresAt?: string; baseUrl?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const created = await client.pats.create(opts.name, { expiresAt: opts.expiresAt });
      console.log(
        `Personal Access Token '${created.name}' created (id: ${created.id}).\n` +
          "This token is shown ONLY ONCE and cannot be retrieved again — store it now:\n" +
          created.token
      );
    });

  patCmd
    .command("list")
    .description("List your Personal Access Tokens")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.pats.list();
      printResult(page.items, opts.output, (item) => patRow(item as Pat));
    });

  patCmd
    .command("revoke <id>")
    .description("Revoke a Personal Access Token")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const revoked = await client.pats.revoke(id);
      printResult(revoked, opts.output, (item) => patRow(item as Pat));
    });

  // -------------------------------------------------------------------------------------
  // type-registry (DESIGN.md §4.1)
  // -------------------------------------------------------------------------------------
  const typeRegistryCmd = program
    .command("type-registry")
    .description("Manage the runtime type registry");

  typeRegistryCmd
    .command("object-type-create <id>")
    .description("Register a custom object type")
    .requiredOption("--display-name <name>", "human-readable display name")
    .option("--schema <json>", "JSON Schema validating instance properties")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        id: string,
        opts: { displayName: string; schema?: string; baseUrl?: string; output: OutputFormat }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.typeRegistry.objectTypes.create(
          {
            id,
            displayName: opts.displayName,
            propertySchema: parseJsonOption(opts.schema, "--schema")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => ({
          id: (item as { id: string }).id,
          displayName: (item as { displayName: string }).displayName
        }));
      }
    );

  typeRegistryCmd
    .command("object-type-list")
    .description("List object types (built-in + org-defined)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: { baseUrl?: string; output: OutputFormat }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.typeRegistry.objectTypes.list({ limit: 100 });
      printResult(page.items, opts.output, (item) => ({
        id: (item as { id: string }).id,
        displayName: (item as { displayName: string }).displayName,
        builtin: String((item as { isBuiltin: boolean }).isBuiltin)
      }));
    });

  typeRegistryCmd
    .command("relationship-type-create <id>")
    .description("Register a custom relationship type")
    .requiredOption("--display-name <name>", "human-readable display name")
    .option("--from-types <list>", "comma-separated allowed 'from' object types")
    .option("--to-types <list>", "comma-separated allowed 'to' object types")
    .option("--cardinality <cardinality>", "one_to_one|one_to_many|many_to_many", "many_to_many")
    .option("--schema <json>", "JSON Schema validating instance properties")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        id: string,
        opts: {
          displayName: string;
          fromTypes?: string;
          toTypes?: string;
          cardinality: "one_to_one" | "one_to_many" | "many_to_many";
          schema?: string;
          baseUrl?: string;
          output: OutputFormat;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.typeRegistry.relationshipTypes.create(
          {
            id,
            displayName: opts.displayName,
            fromTypes: parseList(opts.fromTypes),
            toTypes: parseList(opts.toTypes),
            cardinality: opts.cardinality,
            propertySchema: parseJsonOption(opts.schema, "--schema")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => ({
          id: (item as { id: string }).id,
          displayName: (item as { displayName: string }).displayName,
          cardinality: (item as { cardinality: string }).cardinality
        }));
      }
    );

  typeRegistryCmd
    .command("relationship-type-list")
    .description("List relationship types (built-in + org-defined)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: { baseUrl?: string; output: OutputFormat }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.typeRegistry.relationshipTypes.list({ limit: 100 });
      printResult(page.items, opts.output, (item) => ({
        id: (item as { id: string }).id,
        cardinality: (item as { cardinality: string }).cardinality,
        builtin: String((item as { isBuiltin: boolean }).isBuiltin)
      }));
    });

  // -------------------------------------------------------------------------------------
  // object (generic — works for ANY registered type, built-in or custom)
  // -------------------------------------------------------------------------------------
  const objectCmd = program
    .command("object")
    .description("Manage graph objects of any registered type");

  objectCmd
    .command("create <type>")
    .description("Create an object")
    .requiredOption("--name <name>", "object name")
    .option("--id <uuid>", "client-suppliable UUIDv7 id")
    .option("--urn <urn>", "explicit URN (defaults to a derived one)")
    .option("--domain-id <id>", "containing object id (defaults to the org root)")
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--org <org>", "explicit /orgs/{org} path override")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        type: string,
        opts: {
          name: string;
          id?: string;
          urn?: string;
          domainId?: string;
          properties?: string;
          labels?: string;
          baseUrl?: string;
          output: OutputFormat;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.object(type).create(
          {
            name: opts.name,
            id: opts.id,
            urn: opts.urn,
            domainId: opts.domainId,
            properties: parseJsonOption(opts.properties, "--properties"),
            labels: parseJsonOption(opts.labels, "--labels")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  objectCmd
    .command("list <type>")
    .description("List objects of a type")
    .option("--domain-id <id>", "filter by containing object id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (type: string, opts: { domainId?: string; baseUrl?: string; output: OutputFormat }) => {
        const client = await clientFromStoredCredentials(opts);
        const items: GraphObject[] = [];
        for await (const item of client.listAllObjects(type, { domainId: opts.domainId }))
          items.push(item);
        printResult(items, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  objectCmd
    .command("get <type> <idOrUrn>")
    .description("Get an object by id or URN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (type: string, idOrUrn: string, opts: { baseUrl?: string; output: OutputFormat }) => {
        const client = await clientFromStoredCredentials(opts);
        const found = await client.object(type).get(idOrUrn);
        printResult(found, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  objectCmd
    .command("update <type> <idOrUrn>")
    .description("Partially update an object")
    .option("--name <name>")
    .option("--properties <json>", "JSON object (full replace)")
    .option("--labels <json>", "JSON object (full replace)")
    .option("--version <n>", "expected version (optimistic concurrency)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        type: string,
        idOrUrn: string,
        opts: {
          name?: string;
          properties?: string;
          labels?: string;
          version?: string;
          baseUrl?: string;
          output: OutputFormat;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const updated = await client.object(type).update(idOrUrn, {
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties"),
          labels: parseJsonOption(opts.labels, "--labels"),
          version: opts.version ? Number(opts.version) : undefined
        });
        printResult(updated, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  objectCmd
    .command("delete <type> <idOrUrn>")
    .description("Soft-delete an object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (type: string, idOrUrn: string, opts: { baseUrl?: string; output: OutputFormat }) => {
        const client = await clientFromStoredCredentials(opts);
        const deleted = await client.object(type).delete(idOrUrn);
        printResult(deleted, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  objectCmd
    .command("upsert <type> <urn>")
    .description("Idempotent upsert-by-URN")
    .requiredOption("--name <name>")
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        type: string,
        urn: string,
        opts: {
          name: string;
          properties?: string;
          labels?: string;
          baseUrl?: string;
          output: OutputFormat;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.object(type).upsertByUrn(urn, {
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties"),
          labels: parseJsonOption(opts.labels, "--labels")
        });
        printResult(result, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  // -------------------------------------------------------------------------------------
  // rel (relationships)
  // -------------------------------------------------------------------------------------
  const relCmd = program.command("rel").description("Manage graph relationships");

  relCmd
    .command("create")
    .description("Create a relationship")
    .requiredOption("--type <typeId>", "relationship type id")
    .requiredOption("--from <id>", "'from' object id")
    .requiredOption("--to <id>", "'to' object id")
    .option("--properties <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (opts: {
        type: string;
        from: string;
        to: string;
        properties?: string;
        baseUrl?: string;
        output: OutputFormat;
      }) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.relationships.create(
          {
            typeId: opts.type,
            fromId: opts.from,
            toId: opts.to,
            properties: parseJsonOption(opts.properties, "--properties")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => relationshipRow(item as Relationship));
      }
    );

  relCmd
    .command("list")
    .description("List relationships")
    .option("--from <id>", "filter by 'from' object id")
    .option("--to <id>", "filter by 'to' object id")
    .option("--type <typeId>", "filter by relationship type id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (opts: {
        from?: string;
        to?: string;
        type?: string;
        baseUrl?: string;
        output: OutputFormat;
      }) => {
        const client = await clientFromStoredCredentials(opts);
        const page = await client.relationships.list({
          fromId: opts.from,
          toId: opts.to,
          typeId: opts.type,
          limit: 100
        });
        printResult(page.items, opts.output, (item) => relationshipRow(item as Relationship));
      }
    );

  relCmd
    .command("get <id>")
    .description("Get a relationship")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: { baseUrl?: string; output: OutputFormat }) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.relationships.get(id);
      printResult(found, opts.output, (item) => relationshipRow(item as Relationship));
    });

  relCmd
    .command("delete <id>")
    .description("Soft-delete a relationship")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: { baseUrl?: string; output: OutputFormat }) => {
      const client = await clientFromStoredCredentials(opts);
      const deleted = await client.relationships.delete(id);
      printResult(deleted, opts.output, (item) => relationshipRow(item as Relationship));
    });

  // -------------------------------------------------------------------------------------
  // M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1): one top-level command per resource,
  // same shape as `object`/`rel` above, built from the factories defined earlier in this file.
  // -------------------------------------------------------------------------------------
  const domainCmd = registerTypedResourceCrud(program, "domain", (c) => c.domains);
  registerOwnerCommands(domainCmd, (c) => c.domains);

  const serviceCmd = registerTypedResourceCrud(program, "service", (c) => c.services);
  registerOwnerCommands(serviceCmd, (c) => c.services);
  registerEdgeCommands(serviceCmd, "consumes", (c) => c.services);
  registerEdgeCommands(serviceCmd, "depends-on", (c) => c.services);

  const componentCmd = registerTypedResourceCrud(program, "component", (c) => c.components, {
    serviceOption: true
  });
  registerOwnerCommands(componentCmd, (c) => c.components);
  registerEdgeCommands(componentCmd, "consumes", (c) => c.components);
  registerEdgeCommands(componentCmd, "depends-on", (c) => c.components);
  // `scp component assign <idOrUrn> --service <s>` — idempotent atomic assign-or-move (M12 P5b).
  // Sets the component's owning service: assign (no current service), atomic move (different), or
  // no-op (same). Re-runnable, so it safely bulk-organizes imported orphans.
  componentCmd
    .command("assign <idOrUrn>")
    .description("Assign or move a component into a service (idempotent)")
    .requiredOption("--service <idOrUrn>", "the service the component should belong to (id or URN)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { service: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const updated = await client.components.setService(idOrUrn, opts.service);
      printResult(updated, opts.output, (item) => objectRow(item as GraphObject));
    });

  // `scp component merge <survivor> --loser <loser>` — driving-case merge (M12 P5d): fold a freshly-
  // imported, binding-only component into <survivor> (moves its bindings, soft-deletes it). 409 on a
  // binding-type collision (relabel one first via `scp executor repurpose`).
  componentCmd
    .command("merge <survivorIdOrUrn>")
    .description("Merge another component into this one (moves its executor bindings, soft-deletes it)")
    .requiredOption("--loser <idOrUrn>", "the component to merge in and soft-delete (id or URN)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (survivorIdOrUrn: string, opts: BaseCliOpts & { loser: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.components.merge(survivorIdOrUrn, opts.loser);
      printResult(result, opts.output, (r) => ({
        survivor: (r as { survivor: GraphObject }).survivor.id,
        movedBindings: (r as { movedBindingTypes: string[] }).movedBindingTypes.join(", ") || "none"
      }));
    });

  const deploymentTargetCmd = registerTypedResourceCrud(
    program,
    "deployment-target",
    (c) => c.deploymentTargets
  );
  registerOwnerCommands(deploymentTargetCmd, (c) => c.deploymentTargets);

  registerTypedResourceCrud(program, "team", (c) => c.teams);
  registerTypedResourceCrud(program, "group", (c) => c.groups);
  registerTypedResourceCrud(program, "user", (c) => c.users);
  registerTypedResourceCrud(program, "service-account", (c) => c.serviceAccounts);

  // -------------------------------------------------------------------------------------
  // graph (named queries + traverse — DESIGN.md §5)
  // -------------------------------------------------------------------------------------
  const graphCmd = program.command("graph").description("Run graph queries");

  graphCmd
    .command("query <name>")
    .description(
      "Run a named graph query (owners-of|dependents-of|consumers-of|impact-of|blast-radius|paths-between|domains-impacted)"
    )
    .requiredOption("--object-id <id>", "the object to query from")
    .option("--target-id <id>", "required by paths-between")
    .option("--rel-types <list>", "comma-separated relationship type override")
    .option("--max-depth <n>", "max traversal depth (<=10)", "10")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        name: string,
        opts: {
          objectId: string;
          targetId?: string;
          relTypes?: string;
          maxDepth: string;
          baseUrl?: string;
          output: OutputFormat;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.graph.query(name as NamedGraphQuery, {
          objectId: opts.objectId,
          targetId: opts.targetId,
          relTypes: parseList(opts.relTypes),
          maxDepth: Number(opts.maxDepth)
        });
        printResult(result.objects, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  graphCmd
    .command("traverse")
    .description("Bounded generic graph traversal")
    .requiredOption("--object-id <id>", "the object to traverse from")
    .option("--direction <direction>", "out|in|both", "out")
    .option("--rel-types <list>", "comma-separated relationship type filter")
    .option("--max-depth <n>", "max traversal depth (<=10)", "3")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (opts: {
        objectId: string;
        direction: "out" | "in" | "both";
        relTypes?: string;
        maxDepth: string;
        baseUrl?: string;
        output: OutputFormat;
      }) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.graph.traverse({
          objectId: opts.objectId,
          direction: opts.direction,
          relTypes: parseList(opts.relTypes),
          maxDepth: Number(opts.maxDepth)
        });
        printResult(result.objects, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  // -------------------------------------------------------------------------------------
  // plan / apply (`@scp/iac` server-side plan/apply — BUILD_AND_TEST.md §8 M2 item 4). A
  // manifest file is what `@scp/iac`'s `synthToFile` writes (or any hand-authored/CI-generated
  // JSON matching `DesiredStateManifestSchema`) — the CLI never imports/executes a user's IaC
  // TypeScript program directly, only the synthesized manifest (DESIGN.md §15).
  // -------------------------------------------------------------------------------------

  program
    .command("plan")
    .description("Compute a desired-state diff for an @scp/iac manifest (dry run — does not apply)")
    .requiredOption("--manifest <path>", "path to a synthesized DesiredStateManifest JSON file")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { manifest: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const manifest = await readManifestFile(opts.manifest);
      const plan = await client.plans.create(manifest);
      printPlanResult(plan, opts.output);
    });

  program
    .command("apply")
    .description(
      "Plan and apply an @scp/iac manifest in one shot (POST /plans then apply) — applying an unchanged manifest again is a no-op"
    )
    .requiredOption("--manifest <path>", "path to a synthesized DesiredStateManifest JSON file")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { manifest: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const manifest = await readManifestFile(opts.manifest);
      const plan = await client.plans.create(manifest);
      const { plan: applied, summary } = await client.plans.apply(plan.id);
      printApplyResult(applied, summary, opts.output);
    });

  program
    .command("plan-status <id>")
    .description("Get a previously computed plan by id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const plan = await client.plans.get(id);
      printPlanResult(plan, opts.output);
    });

  // -------------------------------------------------------------------------------------
  // change / decision (M3 Change Coordination Engine — DESIGN.md §9, §10.4, BUILD_AND_TEST.md
  // §8 M3). `scp change propose` submits a Change against >=1 target object (usually
  // components/services/deployment-targets); the engine compiles a wave plan from their
  // `depends_on` edges (or an explicit `--topology`), gates each state transition behind policy
  // Decisions, and executes waves via executor plugins. `scp change explain` is the CLI's window
  // into that reasoning — the compiled plan's waves/targets plus every Decision made about the
  // change, in order. `decision get/list` are read-only: Decisions are written by the
  // coordination engine itself (policy/guard verdicts), never created directly via the CLI.
  // -------------------------------------------------------------------------------------
  const changeCmd = program
    .command("change")
    .description("Manage Changes (DESIGN.md §9 lifecycle)");

  changeCmd
    .command("propose")
    .description("Propose a new Change")
    .requiredOption("--name <name>", "change name")
    .requiredOption("--targets <list>", "comma-separated object ids/URNs this change targets")
    .option("--topology <idOrUrn>", "release-topology object id or URN to compile the plan against")
    .option("--source-kind <kind>", "originating source kind (e.g. github, argocd)")
    .option("--correlation-key <key>", "correlation key for grouping related changes")
    .option("--emergency", "mark this change as an emergency (DESIGN.md §9)")
    .option(
      "--type <type>",
      "routing Type (ADR-0007): image|rpm|deb|npm (Category build) | infrastructure | configuration — " +
        "WHICH pipeline this change rolls, selecting each target's executor binding. Defaults to configuration"
    )
    .option(
      "--provides <keys>",
      "M12 P4B coupled pipelines: comma-separated keys this release makes true at its targets when it succeeds"
    )
    .option(
      "--requires <list>",
      "M12 P4B coupled pipelines: comma-separated prerequisites as key@objectIdOrUrn — this change " +
        "WAITS until another change provides each key at that object before it executes"
    )
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          name: string;
          targets: string;
          type?: ExecutorType;
          provides?: string;
          requires?: string;
          topology?: string;
          sourceKind?: string;
          correlationKey?: string;
          emergency?: boolean;
          properties?: string;
          labels?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const requires = parseRequiresFlag(opts.requires);
        const created = await client.changes.propose(
          {
            name: opts.name,
            targets: parseList(opts.targets) ?? [],
            topology: opts.topology,
            sourceKind: opts.sourceKind,
            correlationKey: opts.correlationKey,
            emergency: opts.emergency,
            type: opts.type,
            provides: parseList(opts.provides),
            requires,
            properties: parseJsonOption(opts.properties, "--properties"),
            labels: parseJsonOption(opts.labels, "--labels")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => changeDetailRow(item as Change));
      }
    );

  changeCmd
    .command("list")
    .description("List Changes")
    .option(
      "--state <state>",
      "filter by state (proposed|evaluated|coordinated|waiting|executing|validating|promoted|cancelled|rolled_back)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { state?: ChangeState }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.changes.list({ state: opts.state, limit: 100 });
      printResult(page.items, opts.output, (item) => changeRow(item as Change));
    });

  changeCmd
    .command("get <id>")
    .description("Get a Change by id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.changes.get(id);
      printResult(found, opts.output, (item) => changeDetailRow(item as Change));
    });

  changeCmd
    .command("explain <id>")
    .description(
      "Explain a Change — its compiled plan (waves/targets) and every Decision made about it"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.changes.explain(id);
      printExplainResult(result, opts.output);
    });

  changeCmd
    .command("wait-status <id>")
    .description(
      "M12 P4B: print ONLY a Change's coupled-pipeline wait status — which `requires` prerequisites " +
        "are satisfied/outstanding (and by which change), a thin renderer over `explain`'s waitStatus"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      // No dedicated route (coupled-pipelines.md §3.8/§7 Phase 4) — `explain` already computes and
      // returns `waitStatus`; this command is deliberately just that call, rendering only the one
      // section instead of the full plan/Decisions/control-runs picture `explain` prints.
      const result = await client.changes.explain(id);
      if (opts.output === "json") {
        console.log(JSON.stringify(result.waitStatus, null, 2));
        return;
      }
      printWaitStatusBody(result.waitStatus, true);
    });

  changeCmd
    .command("cancel <id>")
    .description("Cancel a Change")
    .option("--reason <text>", "reason for cancelling")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts & { reason?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const cancelled = await client.changes.cancel(id, opts.reason);
      printResult(cancelled, opts.output, (item) => changeDetailRow(item as Change));
    });

  changeCmd
    .command("promote <id>")
    .description("Promote a Change out of `validating` — the human approval gate before `promoted`")
    .option(
      "--reason <text>",
      "reason for promoting (also the mandatory reason for --override-freeze)"
    )
    .option(
      "--override-freeze",
      "override an active freeze blocking this transition (requires freeze:override + --reason — DESIGN §10.3)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (id: string, opts: BaseCliOpts & { reason?: string; overrideFreeze?: boolean }) => {
        const client = await clientFromStoredCredentials(opts);
        const promoted = await client.changes.promote(id, opts.reason, opts.overrideFreeze);
        printResult(promoted, opts.output, (item) => changeDetailRow(item as Change));
      }
    );

  changeCmd
    .command("rollback <id>")
    .description(
      "Roll back a Change — creates and returns a NEW rollback Change linked via rollbackOfObjectId"
    )
    .requiredOption("--reason <text>", "reason for the rollback (required — DESIGN.md §9.4)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts & { reason: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const rollback = await client.changes.rollback(id, opts.reason);
      if (opts.output === "table") {
        console.log(`Rollback change created (of ${id}):`);
      }
      printResult(rollback, opts.output, (item) => changeDetailRow(item as Change));
    });

  const decisionCmd = program.command("decision").description("Inspect Decision records");

  decisionCmd
    .command("get <id>")
    .description("Get a Decision by id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.decisions.get(id);
      printResult(found, opts.output, (item) => decisionRow(item as Decision));
    });

  decisionCmd
    .command("list")
    .description("List Decisions")
    .option("--subject-id <id>", "filter by subject (e.g. a Change) id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { subjectId?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.decisions.list({ subjectId: opts.subjectId, limit: 100 });
      printResult(page.items, opts.output, (item) => decisionRow(item as Decision));
    });

  // -------------------------------------------------------------------------------------
  // audit
  // -------------------------------------------------------------------------------------
  const auditCmd = program.command("audit").description("Audit log");

  auditCmd
    .command("verify")
    .description(
      "Re-walk the org's hash-chained audit log via the public API and verify it (DESIGN.md §4.3)"
    )
    .option("--base-url <url>", "API base URL override")
    .action(async (opts: { baseUrl?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const events = [];
      for await (const event of client.listAllAuditEvents()) events.push(event);
      const result = verifyAuditChain(events);
      if (result.valid) {
        console.log(`OK: audit chain verified (${result.eventCount} events).`);
        return;
      }
      console.error(
        `FAILED: audit chain broken at event ${result.brokenAt?.id} — ${result.brokenAt?.reason} (${result.eventCount} events checked).`
      );
      process.exitCode = 1;
    });

  // -------------------------------------------------------------------------------------
  // M4 Governance Engine (BUILD_AND_TEST.md §8 M4, DESIGN.md §10): policy/control documents
  // (typed-registry resources — same CRUD family as domains/services/etc.), approvals (N-of-M
  // quorum), freezes, and `scp policy evaluate`'s dry-run gate check.
  // -------------------------------------------------------------------------------------
  registerTypedResourceCrud(program, "policy", (c) => c.policies);
  const controlCmd = registerTypedResourceCrud(program, "control", (c) => c.controls);

  controlCmd
    .command("bind <idOrUrn>")
    .description("Bind a Control to a ControlPlugin instance (DESIGN §10.2)")
    .requiredOption("--plugin-module <module>", "webhook-control | scan-result-control")
    .requiredOption("--plugin-instance-id <id>", "stable plugin-host instance id")
    .option("--config <json>", "JSON object — plugin instance config (e.g. webhook url)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        idOrUrn: string,
        opts: BaseCliOpts & { pluginModule: string; pluginInstanceId: string; config?: string }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const binding = await client.controls.putBinding(idOrUrn, {
          pluginModule: opts.pluginModule,
          pluginInstanceId: opts.pluginInstanceId,
          config: parseJsonOption(opts.config, "--config")
        });
        printResult(binding, opts.output, (item) => {
          const b = item as { id: string; pluginModule: string; pluginInstanceId: string };
          return { id: b.id, pluginModule: b.pluginModule, pluginInstanceId: b.pluginInstanceId };
        });
      }
    );

  const approvalCmd = program
    .command("approval")
    .description("Manage approval requests (DESIGN §10.2 — N-of-M quorum)");

  approvalCmd
    .command("list")
    .description("List approval requests for a change")
    .requiredOption("--change-id <id>", "change id or URN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { changeId: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.approvals.list({ changeId: opts.changeId, limit: 100 });
      printResult(page.items, opts.output, (item) => approvalRow(item as ApprovalRequest));
    });

  approvalCmd
    .command("get <id>")
    .description("Get an approval request by id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.approvals.get(id);
      printResult(found, opts.output, (item) => approvalRow(item as ApprovalRequest));
    });

  approvalCmd
    .command("votes <id>")
    .description("List votes cast on an approval request")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const votes = await client.approvals.listVotes(id);
      printResult(votes, opts.output, (item) => approvalVoteRow(item as ApprovalVote));
    });

  approvalCmd
    .command("approve <id>")
    .description(
      "Cast your vote on an approval request — always self-attested, one vote per subject"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const vote = await client.approvals.vote(id);
      printResult(vote, opts.output, (item) => approvalVoteRow(item as ApprovalVote));
    });

  const freezeCmd = program.command("freeze").description("Manage freeze windows (DESIGN §10.3)");

  freezeCmd
    .command("create")
    .description("Declare a freeze window over a scope")
    .requiredOption("--scope <idOrUrn>", "the org/domain/service/component this freeze covers")
    .requiredOption("--starts-at <iso>", "ISO 8601 start")
    .requiredOption("--ends-at <iso>", "ISO 8601 end")
    .requiredOption("--reason <text>", "mandatory reason")
    .option("--name <name>", "human-readable label")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          scope: string;
          startsAt: string;
          endsAt: string;
          reason: string;
          name?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const freeze = await client.freezes.create({
          scopeObjectId: opts.scope,
          startsAt: opts.startsAt,
          endsAt: opts.endsAt,
          reason: opts.reason,
          name: opts.name
        });
        printResult(freeze, opts.output, (item) => freezeRow(item as Freeze));
      }
    );

  freezeCmd
    .command("list")
    .description("List freeze windows")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.freezes.list();
      printResult(page.items, opts.output, (item) => freezeRow(item as Freeze));
    });

  freezeCmd
    .command("get <id>")
    .description("Get a freeze by id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.freezes.get(id);
      printResult(found, opts.output, (item) => freezeRow(item as Freeze));
    });

  const policyCmd = program.commands.find((c) => c.name() === "policy")!;
  policyCmd
    .command("evaluate <changeId>")
    .description(
      "Dry-run governance evaluation for a change — verdict + reason tree, no transition attempted"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (changeId: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.policyEvaluate(changeId);
      printPolicyEvaluateResult(result, opts.output);
      if (result.verdict === "block") process.exitCode = 1;
    });

  // -------------------------------------------------------------------------------------
  // campaign / initiative (M5 Campaigns & Initiatives — DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5).
  // A Campaign coordinates many Changes across targets, wave by wave, over the SAME plan compiler
  // a Change uses; unlike Change, it has no promote/cancel verbs — `status` is always a pure
  // derived field, so `campaign status <id>` (its `get`) IS the CLI's window into that field. An
  // Initiative groups Campaigns and exposes a derived roll-up status over its members.
  // -------------------------------------------------------------------------------------
  const campaignCmd = program
    .command("campaign")
    .description(
      "Manage Campaigns (DESIGN.md §9.5 — coordinate many Changes across targets, wave by wave)"
    );

  campaignCmd
    .command("create")
    .description("Create a new Campaign")
    .requiredOption("--name <name>", "campaign name")
    .requiredOption("--targets <list>", "comma-separated object ids/URNs this campaign targets")
    .option("--topology <idOrUrn>", "release-topology object id or URN to compile the plan against")
    .option("--description <text>", "campaign description")
    .option(
      "--type <type>",
      "routing Type (ADR-0007): image|rpm|deb|npm | infrastructure | configuration — WHICH pipeline " +
        "every change this campaign fans out rolls (e.g. infrastructure for 'patch the base AMI " +
        "everywhere'). Defaults to configuration"
    )
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          name: string;
          targets: string;
          topology?: string;
          description?: string;
          type?: ExecutorType;
          labels?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.campaigns.propose(
          {
            name: opts.name,
            targets: parseList(opts.targets) ?? [],
            topology: opts.topology,
            description: opts.description,
            type: opts.type,
            labels: parseJsonOption(opts.labels, "--labels")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => campaignDetailRow(item as Campaign));
      }
    );

  campaignCmd
    .command("list")
    .description("List Campaigns")
    .option(
      "--status <status>",
      "filter by status (proposed|active|blocked|failed|completed|partially_rolled_back|rolled_back)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { status?: CampaignStatus }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.campaigns.list({ status: opts.status, limit: 100 });
      printResult(page.items, opts.output, (item) => campaignRow(item as Campaign));
    });

  campaignCmd
    .command("status <id>")
    .description("Get a Campaign's current (derived) status and details")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.campaigns.get(id);
      printResult(found, opts.output, (item) => campaignDetailRow(item as Campaign));
    });

  campaignCmd
    .command("explain <id>")
    .description(
      "Explain a Campaign — its compiled plan (waves/targets) and every Decision made about it"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.campaigns.explain(id);
      printCampaignExplainResult(result, opts.output);
    });

  campaignCmd
    .command("rollback <id>")
    .description(
      "Roll back a Campaign — rolls back every currently-eligible member Change, each becoming its own new rollback Change"
    )
    .requiredOption("--reason <text>", "reason for the rollback (required — DESIGN.md §9.4/§9.5)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts & { reason: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.campaigns.rollback(id, opts.reason);
      if (opts.output === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `Rolled back ${result.rolledBack.length} member change(s), ${result.skipped.length} skipped`
      );
      printResult(
        [
          ...result.rolledBack.map((r) => ({
            originalChangeObjectId: r.originalChangeObjectId,
            outcome: `rolled back -> ${r.rollbackChange.id}`
          })),
          ...result.skipped.map((s) => ({
            originalChangeObjectId: s.originalChangeObjectId,
            outcome: `skipped: ${s.reason}`
          }))
        ],
        opts.output,
        (item) => item as Record<string, string>
      );
    });

  const initiativeCmd = program
    .command("initiative")
    .description(
      "Manage Initiatives (DESIGN.md §9.5 — group Campaigns with a derived roll-up status)"
    );

  initiativeCmd
    .command("create")
    .description("Create a new Initiative")
    .requiredOption("--name <name>", "initiative name")
    .option("--campaigns <list>", "comma-separated campaign ids/URNs to include")
    .option("--description <text>", "initiative description")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          name: string;
          campaigns?: string;
          description?: string;
          labels?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.initiatives.propose({
          name: opts.name,
          campaigns: parseList(opts.campaigns) ?? [],
          description: opts.description,
          labels: parseJsonOption(opts.labels, "--labels")
        });
        printResult(created, opts.output, (item) => initiativeRow(item as Initiative));
      }
    );

  initiativeCmd
    .command("list")
    .description("List Initiatives")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.initiatives.list({ limit: 100 });
      printResult(page.items, opts.output, (item) => initiativeRow(item as Initiative));
    });

  initiativeCmd
    .command("status <id>")
    .description("Get an Initiative's member Campaigns and derived roll-up status")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.initiatives.get(id);
      printInitiativeRollupResult(result, opts.output);
    });

  initiativeCmd
    .command("add-campaign <id>")
    .description("Add a Campaign to an Initiative")
    .requiredOption("--campaign <idOrUrn>", "campaign id or URN to add")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts & { campaign: string }) => {
      const client = await clientFromStoredCredentials(opts);
      await client.initiatives.addCampaign(id, { campaign: opts.campaign });
      if (opts.output === "json") {
        console.log(JSON.stringify({ ok: true }, null, 2));
        return;
      }
      console.log(`Added campaign ${opts.campaign} to initiative ${id}`);
    });

  // -------------------------------------------------------------------------------------
  // -------------------------------------------------------------------------------------
  // instance scan-floors (M17.5 — ADR-0016). The two ABOVE-org tiers of the six-tier,
  // most-restrictive-wins scan-requirement chain:
  //   platform -> trust domain (partition) -> org -> containment domain -> service -> component
  // These are INSTANCE-scoped: they bind EVERY org on the deployment, so authoring one is an
  // OPERATOR action gated by the deployment's SCP_OPERATOR_TOKEN — never a tenant role, however
  // privileged inside its own org. Reading is an ordinary authenticated call, because a gate you
  // cannot inspect is not explainable.
  //
  // `trust-domain` is the AMBIENT FEDERATION boundary (a partition) above org — NOT the intra-org
  // containment `domain` object type below org (`scp domain ...`). Different concepts; the stored
  // tier literal is `trust_domain`, never bare `domain`.
  // -------------------------------------------------------------------------------------
  const scanFloorsCmd = program
    .command("scan-floors")
    .description(
      "Instance-scoped scan-requirement floors (ADR-0016) — the platform + trust-domain (partition) tiers that bind every org on this deployment"
    );

  scanFloorsCmd
    .command("list")
    .description("List the instance-scoped scan-requirement floors binding this deployment")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const floors = await client.instanceScanFloors.list();
      printResult(floors, opts.output, (raw) => {
        const item = raw as (typeof floors)[number];
        return {
          tier: item.tier,
          origin: item.origin,
          maxCritical: item.maxCritical === null ? "-" : String(item.maxCritical),
          maxHigh: item.maxHigh === null ? "-" : String(item.maxHigh),
          maxMedium: item.maxMedium === null ? "-" : String(item.maxMedium),
          maxLow: item.maxLow === null ? "-" : String(item.maxLow),
          note: item.note ?? ""
        };
      });
    });

  scanFloorsCmd
    .command("set")
    .description(
      "Author an instance-scoped scan-requirement floor (OPERATOR ONLY — requires SCP_OPERATOR_TOKEN; a floor may only ever TIGHTEN what orgs below it can pass)"
    )
    .requiredOption("--tier <tier>", "platform|trust-domain (the partition tier, not the intra-org containment domain)")
    .option("--origin <origin>", "local|federated", "local")
    .option("--max-critical <n>", "ceiling on CRITICAL findings (omit to leave unset — unset never means 0)")
    .option("--max-high <n>", "ceiling on HIGH findings")
    .option("--max-medium <n>", "ceiling on MEDIUM findings")
    .option("--max-low <n>", "ceiling on LOW findings")
    .option("--note <text>", "free-text note recorded with the floor")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          tier: string;
          origin: "local" | "federated";
          maxCritical?: string;
          maxHigh?: string;
          maxMedium?: string;
          maxLow?: string;
          note?: string;
        }
      ) => {
        const operatorToken = process.env.SCP_OPERATOR_TOKEN;
        if (!operatorToken) {
          throw new Error(
            "SCP_OPERATOR_TOKEN is not set — instance scan floors bind every org on the deployment, so authoring one requires the deployment operator token, not your tenant login."
          );
        }
        // Accept the friendlier `trust-domain` on the command line, but send the canonical
        // `trust_domain` literal — never bare `domain` (ADR-0016 terminology).
        const tier = opts.tier === "trust-domain" ? "trust_domain" : opts.tier;
        if (tier !== "platform" && tier !== "trust_domain") {
          throw new Error(`--tier must be 'platform' or 'trust-domain' (got '${opts.tier}')`);
        }
        const num = (v: string | undefined): number | undefined => {
          if (v === undefined) return undefined;
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0) throw new Error(`expected a non-negative integer, got '${v}'`);
          return n;
        };
        const client = await clientFromStoredCredentials(opts);
        const floor = await client.instanceScanFloors.put(
          tier,
          {
            origin: opts.origin,
            maxCritical: num(opts.maxCritical),
            maxHigh: num(opts.maxHigh),
            maxMedium: num(opts.maxMedium),
            maxLow: num(opts.maxLow),
            note: opts.note
          },
          operatorToken
        );
        printResult(floor, opts.output, (item) => item as unknown as Record<string, string>);
      }
    );

  // -------------------------------------------------------------------------------------
  // instance scanner-assignments (M13.3a — ADR-0020 §2). The executor Type -> managed scan
  // method(s) registry the commander's promotion scan step selects scanners from. Keyed on the
  // EXISTING ExecutorType taxonomy (image|rpm|deb|npm|infrastructure|configuration). Like scan
  // floors these are INSTANCE-scoped: they bind EVERY org on the deployment, so authoring one is an
  // OPERATOR action gated by SCP_OPERATOR_TOKEN — never a tenant role. Reading is an ordinary
  // authenticated call. An empty methods set CLEARS the assignment (that Type produces no managed
  // evidence — fail-closed: E6 refuses unless org-pipeline evidence covers the digest).
  // -------------------------------------------------------------------------------------
  const scannerAssignmentsCmd = program
    .command("scanner-assignments")
    .description(
      "Instance-scoped scanner assignments (ADR-0020) — the executor Type -> managed scan method(s) the commander's promotion scan step runs; bind every org on this deployment"
    );

  scannerAssignmentsCmd
    .command("list")
    .description("List the instance-scoped scanner assignments binding this deployment")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const assignments = await client.scannerAssignments.list();
      printResult(assignments, opts.output, (raw) => {
        const item = raw as (typeof assignments)[number];
        return {
          executorType: item.executorType,
          methods: item.methods.length ? item.methods.join(",") : "(none)"
        };
      });
    });

  scannerAssignmentsCmd
    .command("set")
    .description(
      "Assign managed scan methods to an executor Type (OPERATOR ONLY — requires SCP_OPERATOR_TOKEN; an empty --methods clears the assignment, leaving that Type with no managed scanner)"
    )
    .requiredOption("--type <executorType>", "image|rpm|deb|npm|infrastructure|configuration")
    .option(
      "--methods <list>",
      "comma-separated scan methods (trivy|openscap); empty/omitted clears the assignment",
      ""
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          type: string;
          methods: string;
        }
      ) => {
        const operatorToken = process.env.SCP_OPERATOR_TOKEN;
        if (!operatorToken) {
          throw new Error(
            "SCP_OPERATOR_TOKEN is not set — scanner assignments bind every org on the deployment, so authoring one requires the deployment operator token, not your tenant login."
          );
        }
        const validTypes = ["image", "rpm", "deb", "npm", "infrastructure", "configuration"] as const;
        if (!(validTypes as readonly string[]).includes(opts.type)) {
          throw new Error(`--type must be one of ${validTypes.join("|")} (got '${opts.type}')`);
        }
        const methods = opts.methods
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
        for (const m of methods) {
          if (m !== "trivy" && m !== "openscap") {
            throw new Error(`--methods entries must be 'trivy' or 'openscap' (got '${m}')`);
          }
        }
        const client = await clientFromStoredCredentials(opts);
        const assignment = await client.scannerAssignments.put(
          {
            executorType: opts.type as (typeof validTypes)[number],
            methods: methods as ("trivy" | "openscap")[]
          },
          operatorToken
        );
        printResult(assignment, opts.output, (item) => {
          const a = item as typeof assignment;
          return {
            executorType: a.executorType,
            methods: a.methods.length ? a.methods.join(",") : "(none)",
            updatedAt: a.updatedAt
          };
        });
      }
    );

  // federation (M6 Federation Basics — DESIGN.md §13, BUILD_AND_TEST.md §8 M6). `export`/`import`
  // work on `.scpbundle` files on disk (the built-in file transport — "the air gap is the design
  // center", §13) so they're the ones CI's two-domain E2E drives via a real file-copy across an
  // isolated compose network. `promote` is the Promotion Bundle's own export verb — kept distinct
  // from `export` (which only ever produces sync bundles) so the CLI surface mirrors the two
  // distinct bundle kinds `packages/schemas/src/federation.ts` defines.
  // -------------------------------------------------------------------------------------
  const federationCmd = program
    .command("federation")
    .description(
      "Manage federation (DESIGN.md §13 — signed sync journal, peer pairing, Promotion Bundles)"
    );

  federationCmd
    .command("init")
    .description("Designate this domain's federation role")
    .requiredOption("--name <name>", "this domain's display name")
    .requiredOption("--role <role>", "commander|outpost|retrans")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { name: string; role: "commander" | "outpost" | "retrans" }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.federation.init({ name: opts.name, role: opts.role });
      printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
    });

  federationCmd
    .command("self")
    .description(
      "Show this domain's own federation identity + public key (copy this to a peer for out-of-band pairing)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const self = await client.federation.self();
      printResult(self, opts.output, (item) => item as unknown as Record<string, string>);
    });

  federationCmd
    .command("pair")
    .description(
      "Pair a peer domain (outpost-initiated — dial the commander, or exchange identities out-of-band for air-gapped peers)"
    )
    .requiredOption(
      "--domain-id <id>",
      "the peer's federation domain id (from their `scp federation self`)"
    )
    .requiredOption("--name <name>", "a display name for the peer")
    .requiredOption(
      "--role <role>",
      "commander|outpost|retrans — the peer's role as seen from here"
    )
    .requiredOption(
      "--public-key <base64>",
      "the peer's Ed25519 public key (from their `scp federation self`)"
    )
    .option(
      "--cosign-public-key <pem>",
      "the peer's cosign verification public key (from their `scp federation self`) — registered for later manifest verification (M17.4)"
    )
    .option(
      "--base-url-of-peer <url>",
      "the peer's API base URL (outpost->commander mTLS transport only)"
    )
    .option(
      "--sync-scope <mode>",
      "full|policies_only|changes_only|status_only (custom/label-selector not exposed via CLI yet)",
      "full"
    )
    // M13.2a (§13.2) — the peer's DeliveryTarget (filesystem provider). Omitting BOTH dir flags
    // leaves any existing target untouched (re-pair-safe); --clear-delivery-target resets the peer
    // to the instance-env fallback (`SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR`).
    .option(
      "--delivery-out-dir <dir>",
      "SERVER-side absolute directory where channel artifacts addressed to this peer are dropped (filesystem DeliveryTarget)"
    )
    .option(
      "--delivery-in-dir <dir>",
      "SERVER-side absolute directory where channel artifacts FROM this peer arrive (the inbox)"
    )
    // M13.2b (§13.2) — the s3-compatible provider. Requires --delivery-s3-endpoint + --delivery-s3-bucket
    // together; the endpoint/bucket must be operator-allowlisted (SCP_DELIVERY_S3_ENDPOINTS) or the pair
    // is refused. Credentials are stored separately in the vault (`delivery/<peer>/out|in`), never here.
    .option(
      "--delivery-s3-endpoint <url>",
      "S3(-compatible) endpoint for the peer's DeliveryTarget (e.g. https://minio:9000) — operator-allowlisted"
    )
    .option("--delivery-s3-bucket <bucket>", "S3 bucket channel artifacts are put into / listed from")
    .option("--delivery-s3-out-prefix <prefix>", "S3 key prefix for outbound drops (default: bucket root)")
    .option("--delivery-s3-in-prefix <prefix>", "S3 key prefix for the inbound inbox (default: bucket root)")
    .option(
      "--clear-delivery-target",
      "clear the peer's DeliveryTarget (fall back to the instance env dirs)"
    )
    .option("--base-url <url>", "this domain's own API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          domainId: string;
          name: string;
          role: "commander" | "outpost" | "retrans";
          publicKey: string;
          cosignPublicKey?: string;
          baseUrlOfPeer?: string;
          syncScope: string;
          deliveryOutDir?: string;
          deliveryInDir?: string;
          deliveryS3Endpoint?: string;
          deliveryS3Bucket?: string;
          deliveryS3OutPrefix?: string;
          deliveryS3InPrefix?: string;
          clearDeliveryTarget?: boolean;
        }
      ) => {
        const hasFs = Boolean(opts.deliveryOutDir || opts.deliveryInDir);
        const hasS3 = Boolean(
          opts.deliveryS3Endpoint ||
            opts.deliveryS3Bucket ||
            opts.deliveryS3OutPrefix ||
            opts.deliveryS3InPrefix
        );
        if (opts.clearDeliveryTarget && (hasFs || hasS3)) {
          throw new Error(
            "--clear-delivery-target cannot be combined with any --delivery-* flag"
          );
        }
        if (hasFs && hasS3) {
          throw new Error(
            "a DeliveryTarget is one provider: use EITHER --delivery-out-dir/--delivery-in-dir (filesystem) OR the --delivery-s3-* flags"
          );
        }
        if (hasS3 && !(opts.deliveryS3Endpoint && opts.deliveryS3Bucket)) {
          throw new Error(
            "the s3-compatible DeliveryTarget requires BOTH --delivery-s3-endpoint and --delivery-s3-bucket"
          );
        }
        const client = await clientFromStoredCredentials(opts);
        const syncScope = { mode: opts.syncScope } as SyncScope;
        // Tri-state (mirrors the API's re-pair discipline): undefined preserves any existing
        // target, an object sets it, explicit null clears it.
        const deliveryTarget: DeliveryTarget | null | undefined = opts.clearDeliveryTarget
          ? null
          : hasS3
            ? {
                provider: "s3-compatible",
                endpoint: opts.deliveryS3Endpoint as string,
                bucket: opts.deliveryS3Bucket as string,
                ...(opts.deliveryS3OutPrefix ? { outPrefix: opts.deliveryS3OutPrefix } : {}),
                ...(opts.deliveryS3InPrefix ? { inPrefix: opts.deliveryS3InPrefix } : {})
              }
            : hasFs
              ? {
                  provider: "filesystem",
                  ...(opts.deliveryOutDir ? { outDir: opts.deliveryOutDir } : {}),
                  ...(opts.deliveryInDir ? { inDir: opts.deliveryInDir } : {})
                }
              : undefined;
        const peer = await client.federation.pair({
          domainId: opts.domainId,
          name: opts.name,
          role: opts.role,
          publicKey: opts.publicKey,
          cosignPublicKey: opts.cosignPublicKey,
          baseUrl: opts.baseUrlOfPeer,
          syncScope,
          deliveryTarget
        });
        printResult(peer, opts.output, (item) => peerRow(item as FederationPeer));
      }
    );

  federationCmd
    .command("peers")
    .description("List paired federation peers")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const peers = await client.federation.listPeers();
      printResult(peers, opts.output, (item) => peerRow(item as FederationPeer));
    });

  federationCmd
    .command("status")
    .description(
      "Cross-domain status: every peer, this side's sync freshness, recent bundle transfers"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const status = await client.federation.status();
      printFederationStatus(status, opts.output);
    });

  federationCmd
    .command("export")
    .description(
      "Export a signed .scpbundle of journal entries since a cursor (the built-in file transport)"
    )
    .requiredOption("--peer <idOrName>", "peer to export for")
    .option("--since <sequence>", "sequence to export since (default: from genesis)")
    .option("--out <file>", "output .scpbundle file path (local write — today's manual walk)")
    // M13.2a (§13.2) — the server-side drop through the peer's DeliveryTarget (per-peer config,
    // else the instance SCP_RELAY_OUT_DIR fallback; neither → fail-closed named problem).
    .option(
      "--deliver",
      "drop the bundle server-side into the peer's DeliveryTarget instead of (or as well as) --out"
    )
    .option("--base-url <url>", "API base URL override")
    .action(
      async (opts: BaseCliOpts & { peer: string; since?: string; out?: string; deliver?: boolean }) => {
        if (!opts.out && !opts.deliver) {
          throw new Error("provide --out <file>, --deliver, or both");
        }
        const client = await clientFromStoredCredentials(opts);
        const bundle = await client.federation.exportSync({
          peer: opts.peer,
          sinceSequence: opts.since !== undefined ? Number(opts.since) : undefined,
          deliver: opts.deliver || undefined
        });
        if (opts.out) await writeFile(opts.out, JSON.stringify(bundle, null, 2), "utf8");
        const where = [
          ...(opts.out ? [opts.out] : []),
          ...(opts.deliver ? [`the peer's DeliveryTarget (server-side)`] : [])
        ].join(" and ");
        console.log(
          `Exported ${bundle.entries.length} entries (sequence ${bundle.header.sinceSequence + 1}..${bundle.header.throughSequence}) to ${where}`
        );
      }
    );

  federationCmd
    .command("promote")
    .description(
      "Export a Promotion Bundle for a Change (change + control evidence + artifact digests + approval attestations)"
    )
    .requiredOption("--peer <idOrName>", "destination peer")
    .requiredOption("--change <idOrUrn>", "the Change to promote")
    .option("--out <file>", "output .scpbundle file path (local write — today's manual walk)")
    // M13.2a (§13.2) — the server-side drop through the peer's DeliveryTarget.
    .option(
      "--deliver",
      "drop the bundle server-side into the peer's DeliveryTarget instead of (or as well as) --out"
    )
    .option("--base-url <url>", "API base URL override")
    .action(
      async (opts: BaseCliOpts & { peer: string; change: string; out?: string; deliver?: boolean }) => {
        if (!opts.out && !opts.deliver) {
          throw new Error("provide --out <file>, --deliver, or both");
        }
        const client = await clientFromStoredCredentials(opts);
        const bundle = await client.federation.exportPromotion({
          peer: opts.peer,
          change: opts.change,
          deliver: opts.deliver || undefined
        });
        if (opts.out) await writeFile(opts.out, JSON.stringify(bundle, null, 2), "utf8");
        const where = [
          ...(opts.out ? [opts.out] : []),
          ...(opts.deliver ? [`the peer's DeliveryTarget (server-side)`] : [])
        ].join(" and ");
        console.log(`Exported promotion bundle for change ${opts.change} to ${where}`);
      }
    );

  federationCmd
    .command("import <file>")
    .description(
      "Verify + apply a .scpbundle (sync or promotion, auto-detected) — REJECTS on any signature/hash-chain failure, applies nothing"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (file: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      // Defensive byte-size ceiling BEFORE ever parsing the file — belt-and-braces alongside the
      // server's own bounded Fastify `bodyLimit` (routes/federation.ts). `.scpbundle` is a plain
      // JSON document (no archive/compression), so there is no zip-bomb class of attack to defend
      // against beyond "don't read an arbitrarily huge file into memory."
      const raw = await readFile(file, "utf8");
      const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
      if (Buffer.byteLength(raw, "utf8") > MAX_BUNDLE_BYTES) {
        throw new Error(
          `bundle file exceeds the ${MAX_BUNDLE_BYTES}-byte import ceiling — refusing to parse`
        );
      }
      const parsed: unknown = JSON.parse(raw);
      const result = await client.federation.import(parsed as ImportBundleRequest);
      printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
    });

  // M15.5(c) — the retrans validate-then-relay (ADR-0019 §2). `relay` runs on the RETRANS-role
  // instance: pull + validate the imported promotion's authorized artifact bytes and build the
  // signed byte tarball in the server's SCP_RELAY_OUT_DIR drop directory. The tarball crosses the
  // CDS out-of-band (a file walk, exactly like `.scpbundle`); `relay-import` runs on the
  // DESTINATION outpost to verify it and push the bytes into the local registry by digest.
  federationCmd
    .command("relay")
    .description(
      "Validate-then-relay an imported promotion's artifact bytes into a signed tarball (retrans role only; fail-closed)"
    )
    .requiredOption("--change <idOrUrn>", "the LOCAL imported change (from `scp federation import`)")
    // M13.2a (§13.2) — the outbound drop resolves through the named DESTINATION peer's
    // DeliveryTarget; omitted, it resolves through the instance env (SCP_RELAY_OUT_DIR) as before.
    .option(
      "--peer <idOrName>",
      "destination peer whose DeliveryTarget receives the tarball drop (default: instance env)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { change: string; peer?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.federation.relay({ change: opts.change, peer: opts.peer });
      if (opts.output === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Relay tarball built (server-side): ${result.tarballPath}`);
      for (const artifact of result.artifacts) {
        console.log(`  ${artifact.type}  ${artifact.digest}`);
      }
      console.log(`Decision: ${result.decisionId}`);
      console.log(
        "Carry the tarball across the CDS out-of-band, then run `scp federation relay-import` on the destination."
      );
    });

  federationCmd
    .command("relay-import")
    .description(
      "Destination side of the retrans relay: verify a signed byte tarball and push its artifacts into the local registry by digest (+ re-inspect)"
    )
    .requiredOption(
      "--file <name>",
      "tarball file name inside the destination server's SCP_RELAY_IN_DIR drop directory"
    )
    .requiredOption(
      "--change <idOrUrn>",
      "the LOCAL imported change this tarball belongs to (import its .scpbundle first)"
    )
    .requiredOption(
      "--pubkey <path>",
      "path to the RETRANS instance's cosign PUBLIC key (distributed out-of-band) — verifies the tarball signature"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { file: string; change: string; pubkey: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const relayCosignPublicKey = await readFile(opts.pubkey, "utf8");
      const result = await client.federation.relayImport({
        file: opts.file,
        change: opts.change,
        relayCosignPublicKey
      });
      if (opts.output === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Relayed bytes landed for change ${result.localChangeObjectId}:`);
      for (const artifact of result.pushed) {
        console.log(`  ${artifact.type}  ${artifact.digest}  ${artifact.location ?? ""}`);
      }
      console.log(`Decision: ${result.decisionId}`);
      console.log(
        "The receiving M17.4(a)+(b) gates still verify everything before any deploy (zero trust in the relay)."
      );
    });

  federationCmd
    .command("hand-fill")
    .description(
      "Manually enter a commander-origin object as an unverified shadow copy (air-gapped, no bundle transport at all)"
    )
    .requiredOption("--peer <idOrName>", "the commander peer this is claimed to originate from")
    .requiredOption("--type <typeId>", "object type id")
    .requiredOption("--urn <urn>", "the object's URN")
    .requiredOption("--name <name>", "the object's name")
    .option("--properties <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          peer: string;
          type: string;
          urn: string;
          name: string;
          properties?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const object = await client.federation.handFill({
          peer: opts.peer,
          typeId: opts.type,
          urn: opts.urn,
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties")
        });
        printResult(object, opts.output, (item) => item as unknown as Record<string, string>);
      }
    );

  const overlayCmd = federationCmd
    .command("overlay")
    .description(
      "Shared-authority overlays (DESIGN.md §13 — annotate a foreign-origin base object without mutating it)"
    );

  overlayCmd
    .command("create")
    .description("Create a local overlay annotating a base object")
    .requiredOption("--base <idOrUrn>", "the base object to annotate")
    .requiredOption("--type <typeId>", "the overlay object's type id")
    .requiredOption("--name <name>", "the overlay object's name")
    .option("--properties <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & { base: string; type: string; name: string; properties?: string }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const overlay = await client.federation.createOverlay({
          base: opts.base,
          typeId: opts.type,
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties")
        });
        printResult(overlay, opts.output, (item) => item as unknown as Record<string, string>);
      }
    );

  overlayCmd
    .command("view <baseIdOrUrn>")
    .description("Read-time merge of a base object with its local overlays (base is never mutated)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (baseIdOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const view = await client.federation.getMergedOverlayView(baseIdOrUrn);
      if (opts.output === "json") {
        console.log(JSON.stringify(view, null, 2));
        return;
      }
      console.log(`Base: ${view.base.urn} (${view.overlays.length} overlay(s))`);
      console.log(JSON.stringify(view.merged, null, 2));
    });

  // -----------------------------------------------------------------------------------------
  // M7: Real Executor Integrations (BUILD_AND_TEST.md §8 M7, DESIGN §11/§12) — secrets, executor/
  // notification bindings, plugin manifests, discovery run/accept, webhook signing secrets, and
  // `scp change report` (Terraform Mode 1's `--plan-json` CLI step).
  // -----------------------------------------------------------------------------------------

  const secretCmd = program
    .command("secret")
    .description("Manage encrypted org secrets (write-only — never readable back)");

  secretCmd
    .command("put <key>")
    .description("Store (or rotate) an encrypted secret value by key")
    .requiredOption("--value <value>", "the plaintext secret value (encrypted at rest immediately)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (key: string, opts: BaseCliOpts & { value: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.secrets.put(key, { value: opts.value });
      printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
    });

  secretCmd
    .command("list")
    .description("List configured secret KEYS for this org (never values)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.secrets.listKeys();
      if (opts.output === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const key of result.keys) console.log(key);
    });

  secretCmd
    .command("delete <key>")
    .description("Delete a secret by key")
    .option("--base-url <url>", "API base URL override")
    .action(async (key: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      await client.secrets.delete(key);
      console.log(`Deleted secret '${key}'`);
    });

  // -----------------------------------------------------------------------------------------
  // `scp connect` (M12 P4) — one command to register an execution system SCP will coordinate
  // (Mode A / BYO): stores the token, creates the `execution-system` object, and best-effort
  // validates connectivity. Wraps `secret put` + `object create` so an operator doesn't hand-craft
  // the properties JSON. After this, `scp discovery run --module argocd-discovery` imports the apps.
  // -----------------------------------------------------------------------------------------
  const connectCmd = program
    .command("connect")
    .description("Register an existing execution system for SCP to coordinate (Mode A)");

  connectCmd
    .command("argocd")
    .description("Register an existing Argo CD server (stores the token, creates an execution-system)")
    .requiredOption("--url <url>", "Argo CD API server base URL, e.g. https://argocd.example.com")
    .requiredOption("--token <token>", "an Argo CD API token (scoped per your Argo CD RBAC)")
    .option("--name <name>", "name for the execution-system object", "argocd")
    .option("--token-key <key>", "secrets-store key to hold the token (default: <name>-argocd-token)")
    .option("--no-validate", "skip the best-effort connectivity check")
    .option(
      "--allow-internal-egress",
      "declare that this system may be reached at a private/in-cluster address (e.g. an in-cluster " +
        "Argo CD ClusterIP). This is a DECLARATION, not a grant: the server also requires its host to " +
        "be in the operator's SCP_INTERNAL_EGRESS_HOSTS allowlist, or egress stays blocked (ADR-0003)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          url: string;
          token: string;
          name: string;
          tokenKey?: string;
          validate: boolean;
          allowInternalEgress?: boolean;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const serverUrl = opts.url.replace(/\/+$/, "");
        const tokenKey = opts.tokenKey ?? `${opts.name}-argocd-token`;

        if (opts.validate) {
          // Best-effort: hit Argo CD's version endpoint with the token. A failure warns but does not
          // block (air-gapped/proxied setups may not be reachable from the operator's shell).
          try {
            const res = await fetch(`${serverUrl}/api/version`, {
              headers: { authorization: `Bearer ${opts.token}` }
            });
            if (!res.ok) {
              console.warn(`WARN: Argo CD ${serverUrl}/api/version returned HTTP ${res.status} — registering anyway`);
            } else {
              console.log(`Connectivity to ${serverUrl}: OK`);
            }
          } catch (err) {
            console.warn(`WARN: could not reach ${serverUrl} (${String(err)}) — registering anyway`);
          }
        }

        await client.secrets.put(tokenKey, { value: opts.token });
        const created = await client.object("execution-system").create(
          {
            name: opts.name,
            properties: {
              kind: "argocd",
              serverUrl,
              tokenSecretKey: tokenKey,
              ...(opts.allowInternalEgress ? { allowInternalEgress: true } : {})
            }
          },
          { idempotencyKey: randomUUID() }
        );
        console.log(`Registered execution-system '${opts.name}' (${created.id}). Token stored as secret '${tokenKey}'.`);
        console.log(`Next: scp discovery run --module argocd-discovery --instance-id ${opts.name} \\`);
        console.log(`        --config '{"serverUrl":"${serverUrl}","tokenSecretKey":"${tokenKey}","executionSystemId":"${created.id}"}' \\`);
        console.log(`        --secret-refs '{"${tokenKey}":"${tokenKey}"}'   # then: scp discovery accept <proposalId>`);
        printResult(created, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  const executorCmd = program
    .command("executor")
    .description("Configure ExecutorPlugin instances (DESIGN §12)");

  executorCmd
    .command("bind <idOrUrn>")
    .description("Bind a Component/DeploymentTarget to an ExecutorPlugin instance or execution-system")
    .option(
      "--module <module>",
      "plugin module: github|gitea|gitlab|argocd|terraform|managed-iac (inline binding)"
    )
    .option("--instance-id <id>", "stable id for this plugin instance (inline binding)")
    .option(
      "--execution-system <idOrUrn>",
      "bind via a registered execution-system object (module/serverUrl/token resolved from it)"
    )
    .option(
      "--config <json>",
      "JSON object — the plugin's own config shape (see `scp plugin manifests`)"
    )
    .option(
      "--secret-refs <json>",
      "JSON object mapping configFieldName -> secret key (`scp secret put`)"
    )
    .option("--allowed-hosts <list>", "comma-separated egress allowlist (hostnames)")
    .option(
      "--target-ref <ref>",
      "executor-specific target id (e.g. an Argo CD Application name); defaults to the object id"
    )
    .option(
      "--type <type>",
      "routing Type (ADR-0007) this binding drives: image|rpm|deb|npm (Category build) | " +
        "infrastructure | configuration (default: configuration). A target may hold ONE binding per " +
        "Type, so this ADDS a pipeline of that Type alongside the others rather than replacing one"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        idOrUrn: string,
        opts: BaseCliOpts & {
          module?: string;
          instanceId?: string;
          executionSystem?: string;
          config?: string;
          secretRefs?: string;
          allowedHosts?: string;
          targetRef?: string;
          type?: ExecutorType;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.executors.putBinding(
          idOrUrn,
          opts.executionSystem
            ? {
                executionSystemId: opts.executionSystem,
                externalRef: opts.targetRef,
                type: opts.type
              }
            : {
                pluginModule: opts.module,
                pluginInstanceId: opts.instanceId,
                config: parseJsonOption(opts.config, "--config") as
                  | Record<string, unknown>
                  | undefined,
                secretRefs: parseJsonOption(opts.secretRefs, "--secret-refs") as
                  | Record<string, string>
                  | undefined,
                allowedHosts: parseList(opts.allowedHosts),
                externalRef: opts.targetRef,
                type: opts.type
              }
        );
        printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
      }
    );

  executorCmd
    .command("get <idOrUrn>")
    .description("Get a target's configured executor binding (one type; default: configuration)")
    .option("--type <type>", "which routing Type to read (default: configuration)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { type?: ExecutorType }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.executors.getBinding(idOrUrn, opts.type);
      printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
    });

  // M12 P5c binding primitives: list all / detach / relabel-type.
  executorCmd
    .command("bindings <idOrUrn>")
    .description("List every executor binding (all types) configured for a target")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const items = await client.executors.listBindings(idOrUrn);
      printResult(items, opts.output, (item) => item as unknown as Record<string, string>);
    });

  executorCmd
    .command("unbind <idOrUrn>")
    .description("Delete a target's executor binding for one type (default: configuration)")
    .option("--type <type>", "which routing Type to detach (default: configuration)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { type?: ExecutorType }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.executors.deleteBinding(idOrUrn, opts.type);
      printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
    });

  executorCmd
    .command("repurpose <idOrUrn>")
    .description("Relabel which pipeline (routing Type, ADR-0007) a target's binding drives")
    .requiredOption("--to <type>", "the new routing Type: image|rpm|deb|npm|infrastructure|configuration")
    .option("--from <type>", "the binding's current routing Type (default: configuration)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        idOrUrn: string,
        opts: BaseCliOpts & { to: ExecutorType; from?: ExecutorType }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.executors.repurposeBinding(idOrUrn, opts.to, opts.from);
        printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
      }
    );

  // M15.6 (ADR-0017 §3): read + validate a prod environment's per-region Argo CD set. A region is a
  // deployment-target with properties.environment=<env>/region=<label>; its Argo CD is an ordinary
  // per-region binding. Surfaces `prod env -> {region -> argocd binding}` and a validation verdict.
  executorCmd
    .command("regional <environment>")
    .description("Read + validate a prod environment's per-region Argo CD bindings (M15.6)")
    .option("--type <type>", "binding routing Type to resolve per region (default: configuration)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (environment: string, opts: BaseCliOpts & { type?: ExecutorType }) => {
      const client = await clientFromStoredCredentials(opts);
      const view = await client.executors.getRegionalExecutors(environment, opts.type);
      if (opts.output === "json") {
        printResult(view, opts.output, (item) => item as unknown as Record<string, string>);
        return;
      }
      // Table view: one row per region, then the verdict + any problems.
      printResult(view.regions, opts.output, (item) => {
        const r = item as (typeof view.regions)[number];
        return {
          region: r.region || "(unset)",
          target: r.targetName,
          bound: String(r.bound),
          module: r.pluginModule ?? "-",
          argocd: String(r.isExpectedModule),
          executionSystem: r.executionSystemId ?? "-"
        } as Record<string, string>;
      });
      process.stdout.write(
        `\nenvironment '${view.environment}' — valid: ${view.valid}\n` +
          (view.problems.length ? view.problems.map((p) => `  - ${p}`).join("\n") + "\n" : "")
      );
    });

  const notifyCmd = program
    .command("notify")
    .description("Configure NotificationPlugin channels (DESIGN §11)");

  notifyCmd
    .command("bind <instanceId>")
    .description(
      "Configure (or update) a notification channel — an org may configure more than one"
    )
    .requiredOption("--module <module>", "plugin module: webhook-notify|smtp-notify")
    .option(
      "--config <json>",
      "JSON object — the plugin's own config shape (see `scp plugin manifests`)"
    )
    .option("--secret-refs <json>", "JSON object mapping configFieldName -> secret key")
    .option("--allowed-hosts <list>", "comma-separated egress allowlist (hostnames)")
    .option(
      "--min-severity <severity>",
      "info|warning|critical — minimum severity this channel receives",
      "info"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        instanceId: string,
        opts: BaseCliOpts & {
          module: string;
          config?: string;
          secretRefs?: string;
          allowedHosts?: string;
          minSeverity: "info" | "warning" | "critical";
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.notifications.putBinding(instanceId, {
          pluginModule: opts.module,
          config: parseJsonOption(opts.config, "--config") as Record<string, unknown> | undefined,
          secretRefs: parseJsonOption(opts.secretRefs, "--secret-refs") as
            Record<string, string> | undefined,
          allowedHosts: parseList(opts.allowedHosts),
          minSeverity: opts.minSeverity
        });
        printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
      }
    );

  notifyCmd
    .command("list")
    .description("List this org's configured notification channels")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.notifications.listBindings();
      printResult(page.items, opts.output, (item) => item as unknown as Record<string, string>);
    });

  notifyCmd
    .command("delete <instanceId>")
    .description("Remove a notification channel")
    .option("--base-url <url>", "API base URL override")
    .action(async (instanceId: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      await client.notifications.deleteBinding(instanceId);
      console.log(`Deleted notification binding '${instanceId}'`);
    });

  const pluginCmd = program.command("plugin").description("Inspect bundled plugins (DESIGN §11)");

  pluginCmd
    .command("manifests")
    .description(
      "Every bundled plugin's {id, kind, version, configSchema} — the source a config form is generated from"
    )
    .option("--base-url <url>", "API base URL override")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.plugins.listManifests();
      console.log(JSON.stringify(result.items, null, 2));
    });

  const discoveryCmd = program
    .command("discovery")
    .description("DiscoveryPlugin run/accept — NEVER auto-commits (DESIGN §11)");

  discoveryCmd
    .command("run")
    .description(
      "Run a DiscoveryPlugin scan — prints a PROPOSAL only, nothing is written to the graph"
    )
    .requiredOption(
      "--module <module>",
      "plugin module: github-discovery | gitea-discovery | gitlab-discovery | argocd-discovery"
    )
    .requiredOption("--instance-id <id>", "stable id for this plugin instance")
    .option("--config <json>", "JSON object — the plugin's own config shape")
    .option("--secret-refs <json>", "JSON object mapping configFieldName -> secret key")
    .option("--allowed-hosts <list>", "comma-separated egress allowlist (hostnames)")
    .option("--base-url <url>", "API base URL override")
    .action(
      async (
        opts: BaseCliOpts & {
          module: string;
          instanceId: string;
          config?: string;
          secretRefs?: string;
          allowedHosts?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const proposal = await client.discovery.run({
          pluginModule: opts.module,
          pluginInstanceId: opts.instanceId,
          config: parseJsonOption(opts.config, "--config") as Record<string, unknown> | undefined,
          secretRefs: parseJsonOption(opts.secretRefs, "--secret-refs") as
            Record<string, string> | undefined,
          allowedHosts: parseList(opts.allowedHosts)
        });
        // Always JSON — a proposal is meant to be reviewed, edited, and re-submitted to
        // `discovery accept --proposal`, not rendered as a table.
        console.log(JSON.stringify(proposal, null, 2));
      }
    );

  discoveryCmd
    .command("accept")
    .description(
      "EXPLICITLY accept a discovery proposal — the only command that commits discovered objects/relationships"
    )
    .requiredOption(
      "--proposal <path-or-json>",
      "a file path to (or literal JSON of) a proposal from `discovery run`"
    )
    .option("--domain <idOrUrn>", "domain to create discovered objects under (default: org root)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { proposal: string; domain?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const raw = opts.proposal.trim().startsWith("{")
        ? opts.proposal
        : await readFile(opts.proposal, "utf8");
      const proposal = JSON.parse(raw) as { objects: unknown[]; relationships: unknown[] };
      const result = await client.discovery.accept({
        domainId: opts.domain,
        proposal: proposal as never
      });
      printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
    });

  // M12 P5 follow-up: automated backfill of source_mappings onto ALREADY-imported components (the 50
  // argocd orphans imported before discovery emitted mappings). Feed a fresh `discovery run` proposal;
  // creates NO objects — matches its sourceMappings to existing components by name. Idempotent.
  discoveryCmd
    .command("backfill-mappings")
    .description("Backfill source_mappings onto already-imported components from a discovery proposal")
    .requiredOption(
      "--proposal <path-or-json>",
      "a file path to (or literal JSON of) a proposal from `discovery run` (its sourceMappings are used)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { proposal: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const raw = opts.proposal.trim().startsWith("{")
        ? opts.proposal
        : await readFile(opts.proposal, "utf8");
      const proposal = JSON.parse(raw) as never;
      const result = await client.discovery.backfillSourceMappings(proposal);
      printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
    });

  const changeSourceCmd = program
    .command("change-source")
    .description("Change-source webhook config (DESIGN §8/§9.2/§12)");

  // M12 P5 (owner Q3): source_mapping CRUD — the CLI parity gap (SDK + route existed). This is the
  // manual/backfill path for existing imports; new argocd imports get a mapping auto-created at accept.
  changeSourceCmd
    .command("create-mapping <sourceKind>")
    .description("Map a source (repo/path globs) to a component so its releases correlate")
    .requiredOption("--component <idOrUrn>", "the component this source's events belong to")
    .option("--repo <pattern>", "repo glob (e.g. a GitHub repo URL/slug) — matched against the event's repo")
    .option("--path <pattern>", "path glob within the repo")
    .option("--type <type>", "routing Type (ADR-0007): image|rpm|deb|npm|infrastructure|configuration (default: configuration)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        sourceKind: string,
        opts: BaseCliOpts & {
          component: string;
          repo?: string;
          path?: string;
          type?: ExecutorType;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.changeSources.createMapping(sourceKind, {
          component: opts.component,
          repoPattern: opts.repo,
          pathPattern: opts.path,
          type: opts.type
        });
        printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
      }
    );

  changeSourceCmd
    .command("list-mappings <sourceKind>")
    .description("List source_mappings for one source kind")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (sourceKind: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.changeSources.listMappings(sourceKind);
      printResult(result.items, opts.output, (item) => item as unknown as Record<string, string>);
    });

  changeSourceCmd
    .command("webhook-secret <sourceKind>")
    .description("Configure (or rotate) this org+sourceKind's webhook HMAC signing secret")
    .requiredOption("--secret <value>", "the plaintext HMAC secret (encrypted at rest immediately)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (sourceKind: string, opts: BaseCliOpts & { secret: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.changeSources.putWebhookSecret(sourceKind, {
        secret: opts.secret
      });
      printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
    });

  changeSourceCmd
    .command("report <sourceKind>")
    .description(
      "Report a typed plan/apply result (DESIGN §12 Mode 1) — a one-line CI step; the typed, PAT-authenticated counterpart to raw webhook ingestion"
    )
    .requiredOption("--status <status>", "planned|applied|errored|discarded")
    .option("--repo <repo>", "correlation hint: repo (source_mappings matching)")
    .option("--path <path>", "correlation hint: path")
    .option("--correlation-key <key>", "correlation key for grouping related changes")
    .option("--workspace <workspace>", "Terraform/OpenTofu workspace name")
    .option("--artifact-digest <digest>", "artifact digest linking this to an app-side change")
    .option("--plan-json <path>", "path to a `tofu show -json`-shaped plan file, attached verbatim")
    // M12 P4B coupled pipelines — THE pipeline declaration channel (a raw provider push webhook
    // cannot carry a key; this CI step can). Same flag format as `scp change propose`.
    .option(
      "--provides <keys>",
      "M12 P4B coupled pipelines: comma-separated keys this release makes true at its targets when it succeeds"
    )
    .option(
      "--requires <list>",
      "M12 P4B coupled pipelines: comma-separated prerequisites as key@objectIdOrUrn — the resulting " +
        "change WAITS until another change provides each key at that object before it executes"
    )
    // M17.2 (ADR-0015 §5) — a REFERENCE to the build-time SBOM the pipeline's own Trivy step emitted
    // and cosign-signed. SCP stores the reference, NEVER the document: do not pipe the SBOM itself.
    .option("--sbom-format <format>", "SBOM reference: cyclonedx|spdx (required to record an SBOM)")
    .option("--sbom-digest <digest>", "SBOM reference: the SBOM DOCUMENT's own sha256 digest (not the artifact's)")
    .option("--sbom-location <uri>", "SBOM reference: where the document lives (OCI referrer ref / URI)")
    .option("--sbom-spec-version <version>", "SBOM reference: format spec version (e.g. 1.5, SPDX-2.3)")
    .option("--sbom-media-type <type>", "SBOM reference: media type (e.g. application/vnd.cyclonedx+json)")
    .option("--sbom-signature-ref <ref>", "SBOM reference: the ORIGIN cosign signature ref (SCP never signs)")
    .option("--sbom-scanner <name>", "SBOM reference: which external tool produced it (e.g. trivy)")
    .option("--sbom-scanner-version <version>", "SBOM reference: that tool's version")
    .option("--sbom-generated-at <iso8601>", "SBOM reference: when the producer emitted it")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        sourceKind: string,
        opts: BaseCliOpts & {
          status: string;
          repo?: string;
          path?: string;
          correlationKey?: string;
          workspace?: string;
          artifactDigest?: string;
          planJson?: string;
          provides?: string;
          requires?: string;
          sbomFormat?: string;
          sbomDigest?: string;
          sbomLocation?: string;
          sbomSpecVersion?: string;
          sbomMediaType?: string;
          sbomSignatureRef?: string;
          sbomScanner?: string;
          sbomScannerVersion?: string;
          sbomGeneratedAt?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const validStatuses = ["planned", "applied", "errored", "discarded"] as const;
        if (!(validStatuses as readonly string[]).includes(opts.status)) {
          throw new Error(`--status must be one of ${validStatuses.join("|")} (got '${opts.status}')`);
        }
        const planJson = opts.planJson
          ? JSON.parse(await readFile(opts.planJson, "utf8"))
          : undefined;
        // An SBOM REFERENCE is all-or-nothing on its three required parts. Fail loudly on a partial
        // one rather than silently dropping it — a supply-chain reference that quietly vanishes is
        // exactly the failure mode ADR-0015 exists to prevent.
        const sbomFlags = [opts.sbomFormat, opts.sbomDigest, opts.sbomLocation];
        if (sbomFlags.some(Boolean) && !sbomFlags.every(Boolean)) {
          throw new Error(
            "--sbom-format, --sbom-digest and --sbom-location must be given together (an SBOM reference needs all three)"
          );
        }
        const validSbomFormats = ["cyclonedx", "spdx"] as const;
        if (opts.sbomFormat && !(validSbomFormats as readonly string[]).includes(opts.sbomFormat)) {
          throw new Error(
            `--sbom-format must be one of ${validSbomFormats.join("|")} (got '${opts.sbomFormat}')`
          );
        }
        const sbom = opts.sbomFormat
          ? {
              format: opts.sbomFormat as (typeof validSbomFormats)[number],
              digest: opts.sbomDigest!,
              location: opts.sbomLocation!,
              specVersion: opts.sbomSpecVersion,
              mediaType: opts.sbomMediaType,
              signatureRef: opts.sbomSignatureRef,
              scanner: opts.sbomScanner,
              scannerVersion: opts.sbomScannerVersion,
              generatedAt: opts.sbomGeneratedAt
            }
          : undefined;
        const result = await client.changeSources.report(sourceKind, {
          status: opts.status as (typeof validStatuses)[number],
          repo: opts.repo,
          path: opts.path,
          correlationKey: opts.correlationKey,
          workspace: opts.workspace,
          artifactDigest: opts.artifactDigest,
          planJson,
          sbom,
          provides: parseList(opts.provides),
          requires: parseRequiresFlag(opts.requires)
        });
        printResult(result, opts.output, (item) => item as unknown as Record<string, string>);
      }
    );

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
