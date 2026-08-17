import { and, eq, inArray, isNull } from "drizzle-orm";
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { DomainEventJob, DomainEventRouter } from "../events/pgboss.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, objects } from "../db/schema.js";
import { targetObjectIdsOf } from "../coordination/changes-repo.js";
import { createGitProviderManifestReader } from "./manifest-reader.js";
import { isAcceptedChangeEvent } from "./internal-release-loop.js";
import { ingestComponentManifests, type ComponentIngestionOutcome } from "./inventory-ingestion.js";

/**
 * M21.2 — THE PRODUCTION CALLER FOR DEPENDENCY-INVENTORY INGESTION (ADR-0032 §4, §6, §7c).
 *
 * ============================================================================================
 * WITHOUT THIS FILE, THE INVENTORY IS EMPTY FOREVER
 * ============================================================================================
 * `upsertComponentDependency` / `pruneComponentDependencies` had no non-test caller, so
 * `component_dependencies` was never written on a real deployment and every capability above it —
 * the enablement work-list, the third-party poll, internal detection's manifest-path lookup — was
 * inert against an empty table. That is the fifth "built and never installed" component in M21, so
 * this file is not an afterthought to the ingestion; it is half of it.
 *
 * ============================================================================================
 * THE SHAPE: ROUTE ON THE SHARED STREAM, WORK ON THIS CAPABILITY'S OWN QUEUE
 * ============================================================================================
 * `boss.work()` is a COMPETING CONSUMER — a second worker on `domain-events` does not add a
 * listener, it splits the jobs (`events/pgboss.ts`). So this registers a ROUTER on that queue and
 * its own worker on its own queue, exactly as M21.4's internal detection does:
 *
 *   outbox → domain-events → {@link inventoryIngestionRouter} (one predicate, one enqueue)
 *          → {@link INVENTORY_INGESTION_QUEUE} → this file's worker → ingestComponentManifests
 *
 * IT SHARES M21.4'S PREDICATE RATHER THAN COPYING IT. `isAcceptedChangeEvent` is imported from
 * `internal-release-loop.ts`; two capabilities reacting to the same event with two hand-written
 * copies of "is this an accepted change?" is two places for that test to drift. The two routers are
 * separate objects with separate queues, which is what keeps them from stealing each other's work.
 *
 * ============================================================================================
 * WHY AN ACCEPTED CHANGE IS THE TRIGGER
 * ============================================================================================
 * A push is what changes a manifest, and the correlated push is already in the tree as a Change —
 * `webhook-processor.ts` matches the delivery to exactly one component through `source_mappings`
 * and records the repo, ref and commit on `changes.source_ref`. Reacting to the ACCEPT rather than
 * to the proposal is deliberate:
 *
 *  - the accepted state is the one this domain has decided is real, and it is the same point M21.4
 *    derives an internal release from, so the inventory and the released version are read at the
 *    SAME commit rather than at two different ones;
 *  - `scp.change.transitioned` is the only change event that exists at all
 *    (`coordination/transition.ts`), and a proposal emits nothing to route on;
 *  - a proposed-but-never-accepted change is a release this domain did not take, and recording its
 *    manifests as the component's inventory would describe a state the domain never ran.
 *
 * The cost, stated rather than discovered: a component whose manifests change without a correlated,
 * accepted change is not re-ingested. That is exactly what the operator BACKFILL exists for
 * (`POST /api/v1/dependencies/inventory/backfill`), which is also the only way a component that has
 * never pushed since enablement gets a first inventory at all.
 *
 * ============================================================================================
 * THE ROLE GUARD, DERIVED — NOT COPIED FROM EITHER NEIGHBOUR
 * ============================================================================================
 * M21.4's two jobs reached OPPOSITE verdicts on the federation axis, for reasons that are about
 * what each job does rather than about what it is called. Asked of ingestion:
 *
 *  - THE PROCESS AXIS APPLIES, unchanged. This is background work driven by a queue; an `api`
 *    process must stay a request server. `main.ts` additionally only reaches this inside its
 *    `runsBackgroundWork` branch, and the guard is what makes that a property of the job rather
 *    than of where it happens to be called.
 *
 *  - THE FEDERATION AXIS DOES NOT APPLY, and a commander-only guard would break the feature. The
 *    version poll is commander-only because it DIALS PUBLIC PACKAGE REGISTRIES ON A TIMER, which an
 *    air-gapped outpost must never do, and it is fail-closed on an undeclared role for exactly that
 *    reason. Ingestion initiates no timed egress and reaches no public index: it reacts to THIS
 *    domain's own accepted change and reads a file from the git provider this domain's executors
 *    are already bound to and already coordinate through, over the same bindings and the same
 *    egress guard — an air-gapped outpost running a local Gitea (M15) reads from that Gitea.
 *    And the evidence is local: `changes` and `source_mappings` are this domain's own records,
 *    while a commander receives only `change_status` journal entries. ADR-0032 §3 says the
 *    inventory "does not federate, and each domain derives its own"; restricting ingestion to a
 *    commander would leave every outpost domain's `component_dependencies` permanently empty —
 *    which is the same silent-inertness failure this whole milestone is about, pointed at the
 *    deployments §3 says derive their own.
 *
 * So: same answer as internal detection, reached from ingestion's own facts. Where it differs from
 * the poll is named above rather than assumed.
 */

export const INVENTORY_INGESTION_QUEUE = "dependency-inventory-ingestion";

export interface InventoryIngestionRoleVerdict {
  allowed: boolean;
  reason: string;
}

/** MAY THIS PROCESS INGEST DEPENDENCY INVENTORY? See the module doc for the derivation. */
export function inventoryIngestionRoleGuard(
  config: Pick<ServerConfig, "role" | "federationRole">
): InventoryIngestionRoleVerdict {
  if (config.role !== "all" && config.role !== "worker") {
    return {
      allowed: false,
      reason: `SCP_ROLE is '${config.role}' — background work belongs to an 'all' or 'worker' process`
    };
  }
  return {
    allowed: true,
    reason:
      `background-work process; runs on every federation role ('${config.federationRole}' here) ` +
      `because each domain derives its OWN dependency inventory (ADR-0032 §3), the evidence is ` +
      `this domain's own correlated change, and the read goes to the git provider this domain is ` +
      `already bound to — never to a public index on a timer`
  };
}

/** What {@link inventoryIngestionRouter} puts on {@link INVENTORY_INGESTION_QUEUE}. */
export interface InventoryIngestionJob {
  orgId: string;
  changeObjectId: string;
}

/**
 * The fan-out point on the shared domain-event stream: one predicate, one enqueue, no work.
 *
 * Doing the read inline here would put a git provider's latency and its retry budget on the shared
 * event stream, where one slow provider would hold up every other capability's events.
 */
export function inventoryIngestionRouter(): DomainEventRouter {
  return {
    name: "dependency-inventory-ingestion",
    queue: INVENTORY_INGESTION_QUEUE,
    async route(boss: PgBoss, event: DomainEventJob): Promise<void> {
      if (!isAcceptedChangeEvent(event)) return;
      const changeObjectId = event.subject;
      if (typeof changeObjectId !== "string" || changeObjectId === "") return;
      const job: InventoryIngestionJob = { orgId: event.orgId, changeObjectId };
      // Collapses a redelivery that arrives while an earlier job for the same accept is still
      // queued. A cheap optimisation, never the correctness argument — the ingestion is idempotent,
      // which is what makes at-least-once safe (see `inventory-ingestion.ts`).
      await boss.send(INVENTORY_INGESTION_QUEUE, job, { singletonKey: changeObjectId });
    }
  };
}

export interface InventoryIngestionLoopDeps {
  db: Db;
  host: PluginHost;
  config: Pick<ServerConfig, "role" | "federationRole" | "secretsMasterKey">;
}

export type ChangeIngestionVerdict =
  /** The change is not in a state this ingestion applies to, or names no component target. */
  | "not_applicable"
  /** At least one component target was put through the gate. */
  | "evaluated";

export interface ChangeIngestionOutcome {
  readonly changeObjectId: string;
  readonly verdict: ChangeIngestionVerdict;
  readonly detail: string;
  readonly components: readonly ComponentIngestionOutcome[];
}

/**
 * Ingest the dependency inventory of every COMPONENT an accepted change targets, at the commit that
 * change came from.
 *
 * THE STATE IS RE-READ, never trusted from the event: `scp.change.transitioned` is delivered
 * at-least-once and out of band, so by the time this runs the change may have moved on.
 *
 * THE REF IS THE COMMIT WHERE THERE IS ONE. `changes.source_ref.commit` is the identity of what was
 * released; `ref` (a branch) is the fallback and is honestly weaker — a branch name is not an
 * identity, which is why `readFileAtRef` returns the commit it RESOLVED to and why that resolved
 * commit is what lands in `component_dependencies.observed_ref` rather than whatever was asked for.
 */
export async function ingestChangeInventory(
  deps: InventoryIngestionLoopDeps,
  job: InventoryIngestionJob
): Promise<ChangeIngestionOutcome> {
  const prepared = await withTenantTx(deps.db, job.orgId, async (tx) => {
    const [change] = await tx
      .select({
        objectId: changes.objectId,
        state: changes.state,
        sourceRef: changes.sourceRef,
        properties: objects.properties
      })
      .from(changes)
      .innerJoin(objects, and(eq(objects.orgId, changes.orgId), eq(objects.id, changes.objectId)))
      .where(and(eq(changes.orgId, job.orgId), eq(changes.objectId, job.changeObjectId)))
      .limit(1);
    if (!change)
      return { detail: "no change row for this id in this org", targets: [] as string[] };
    if (change.state !== "accepted") {
      return {
        detail: `change is in state '${change.state}', not 'accepted' — re-read rather than trusted from the event`,
        targets: [] as string[]
      };
    }
    const targetIds = targetObjectIdsOf(change.properties as Record<string, unknown> | null);
    if (targetIds.length === 0) return { detail: "the change names no targets", targets: [] };
    // COMPONENTS ONLY. A change may target a service, and a service's manifests are its components'
    // manifests — walking down to them would be a containment traversal this path does not take
    // (ADR-0032 §3). A service-targeted release re-ingests nothing here; its components are covered
    // by their own releases and by the backfill.
    const components = await tx
      .select({ id: objects.id })
      .from(objects)
      .where(
        and(
          eq(objects.orgId, job.orgId),
          inArray(objects.id, targetIds),
          eq(objects.typeId, "component"),
          isNull(objects.deletedAt)
        )
      )
      .orderBy(objects.id);
    return {
      detail: "",
      targets: components.map((c) => c.id),
      source: canonicalSourceRef(change.sourceRef)
    };
  });

  if (prepared.targets.length === 0) {
    return {
      changeObjectId: job.changeObjectId,
      verdict: "not_applicable",
      detail: prepared.detail || "the change targets no component",
      components: []
    };
  }

  const source = prepared.source ?? {};
  // ONE READER PER JOB, so its per-repo instance resolution is shared across the change's targets
  // and its decrypted instance config does not outlive the job (`manifest-reader.ts`).
  const readManifest = createGitProviderManifestReader({
    db: deps.db,
    host: deps.host,
    orgId: job.orgId,
    masterKey: deps.config.secretsMasterKey
  });

  const components: ComponentIngestionOutcome[] = [];
  for (const componentObjectId of prepared.targets) {
    components.push(
      await ingestComponentManifests(deps.db, job.orgId, {
        componentObjectId,
        repo: source.repo,
        ref: source.commit ?? source.ref ?? "HEAD",
        readManifest,
        // WHICH PRODUCER THIS IS, on the component's ingestion stamp (M21.7, drizzle/0065). The
        // distinction is operationally real rather than bookkeeping: `loop` means this component's
        // inventory is maintained by its OWN releases, `backfill` means it is only as fresh as
        // whoever last ran one — two very different readings of the same timestamp.
        source: "loop"
      })
    );
  }
  return {
    changeObjectId: job.changeObjectId,
    verdict: "evaluated",
    detail: `${components.length} component(s) evaluated; ${components.filter((c) => c.verdict === "ingested").length} ingested`,
    components
  };
}

/**
 * `changes.source_ref`'s canonical keys, defensively — the same three
 * `internal-release-detection.ts` reads, and read the same way, because they are the same claim
 * about the same release. The column is `jsonb` holding the raw delivery payload plus the keys
 * `webhook-processor.ts` lifted out of it, so every field is optional in practice.
 */
function canonicalSourceRef(raw: unknown): { repo?: string; ref?: string; commit?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof src[key] === "string" && src[key].trim() !== ""
      ? (src[key] as string).trim()
      : undefined;
  const repo = pick("repo");
  const ref = pick("ref");
  const commit = pick("commit");
  return {
    ...(repo !== undefined ? { repo } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(commit !== undefined ? { commit } : {})
  };
}

/** Run ONE queued job. Exported so an integration test drives the exact function the worker runs
 *  rather than a copy of it. */
export async function runInventoryIngestionJob(
  deps: InventoryIngestionLoopDeps,
  job: InventoryIngestionJob
): Promise<ChangeIngestionOutcome> {
  return ingestChangeInventory(deps, job);
}

export interface InventoryIngestionLoopHandle {
  stop(): Promise<void>;
}

/**
 * Register the capability's worker. Returns nothing but the handle; the router half is registered
 * with `startPgBoss` by `main.ts`, so neither knows the other's internals.
 *
 * A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the same shape every other
 * loop uses, and for the same reason: a process that merely skipped the work inside the handler
 * would still hold a worker for a queue it will never act on.
 */
export async function startInventoryIngestionLoop(
  boss: PgBoss,
  deps: InventoryIngestionLoopDeps
): Promise<InventoryIngestionLoopHandle> {
  const guard = inventoryIngestionRoleGuard(deps.config);
  if (!guard.allowed) {
    console.info(`[dependency-inventory-ingestion] not started: ${guard.reason}`);
    return { async stop() {} };
  }
  console.info(`[dependency-inventory-ingestion] STARTING: ${guard.reason}`);

  let stopped = false;
  /** In-flight jobs, awaited by `stop()`. An ingestion run holds a transaction in its write phases
   *  and `main.ts`'s `onClose` closes the pool right after stopping the loops. */
  const inFlight = new Set<Promise<unknown>>();
  await boss.createQueue(INVENTORY_INGESTION_QUEUE);
  await boss.work<InventoryIngestionJob>(INVENTORY_INGESTION_QUEUE, async (jobs) => {
    for (const job of jobs) {
      if (stopped) return;
      try {
        const run = runInventoryIngestionJob(deps, job.data);
        inFlight.add(run);
        const outcome = await run.finally(() => inFlight.delete(run));
        if (outcome.verdict === "evaluated") {
          console.info(
            `[dependency-inventory-ingestion] change ${job.data.changeObjectId}: ${outcome.detail}`
          );
        }
      } catch (err) {
        // Per JOB, so one org's bad change cannot stop another's. Swallowed with a loud log because
        // the ingestion is re-runnable — the next accepted change, or a backfill, re-derives it —
        // whereas a rethrow would burn the queue's retries and wedge every org's ingestion.
        console.error(
          `[dependency-inventory-ingestion] change ${job.data.changeObjectId} (org ${job.data.orgId}) failed:`,
          err
        );
      }
    }
  });
  return {
    async stop() {
      stopped = true;
      await Promise.allSettled([...inFlight]);
    }
  };
}
