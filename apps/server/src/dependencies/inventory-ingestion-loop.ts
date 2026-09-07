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
import {
  commanderOnlyJobVerdict,
  type CommanderOnlyConfig,
  type CommanderOnlyVerdict
} from "./commander-only.js";
import { isAcceptedChangeEvent } from "./internal-release-loop.js";
import { ingestComponentManifests, type ComponentIngestionOutcome } from "./inventory-ingestion.js";

/** The production caller for dependency-inventory ingestion. See docs/dependencies.md §262. */

export const INVENTORY_INGESTION_QUEUE = "dependency-inventory-ingestion";

export type InventoryIngestionRoleVerdict = CommanderOnlyVerdict;

/** MAY THIS PROCESS INGEST DEPENDENCY INVENTORY? See docs/dependencies.md §263. */
export function inventoryIngestionRoleGuard(
  config: CommanderOnlyConfig
): InventoryIngestionRoleVerdict {
  return commanderOnlyJobVerdict(config, "dependency-inventory ingestion");
}

/** What {@link inventoryIngestionRouter} puts on {@link INVENTORY_INGESTION_QUEUE}. */
export interface InventoryIngestionJob {
  orgId: string;
  changeObjectId: string;
}

/** The fan-out point on the shared domain-event stream. See docs/dependencies.md §264. */
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
  config: CommanderOnlyConfig & Pick<ServerConfig, "secretsMasterKey">;
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

/** Ingest the inventory of every component a change targets. See docs/dependencies.md §265. */
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

/** `changes.source_ref`'s canonical keys, defensively. See docs/dependencies.md §266. */
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

/** Register the capability's worker. See docs/dependencies.md §267. */
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
