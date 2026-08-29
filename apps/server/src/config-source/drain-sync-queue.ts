/**
 * THE CONFIG-SOURCE TRIGGER'S DRAIN — the step that finally gives `syncConfigSourceCommit` a
 * production caller (ADR-0046 section 2; proposal section 4).
 *
 * ================================================================================================
 * THE THREE-PHASE SHAPE, AND WHY IT IS NOT ONE TRANSACTION
 * ================================================================================================
 * Reading a manifest is an out-of-process RPC into the git-provider plugin subprocess. Applying one
 * writes the graph. Those cannot share a transaction: holding a DB connection open across an
 * external call is the hazard already tracked against `triggerWaveTarget`, and a failed write in a
 * shared tx aborts everything else in it — a try/catch does not help, because a caught Postgres
 * error leaves the tx aborted and the next statement dies somewhere unrelated.
 *
 *   1. READ-ONLY tx — what is pending, and which registrations cover it.
 *   2. NO tx — fetch every selected manifest over the plugin RPC.
 *   3. WRITE tx — CLAIM the entries (`FOR UPDATE SKIP LOCKED`), run the sync against the already-
 *      fetched bytes, mark them drained.
 *
 * The claim lives in phase 3, which is where correctness lives: two concurrent ticks may both
 * prefetch the same manifest (wasted bytes, no harm), and exactly one will claim the row and apply.
 *
 * ================================================================================================
 * THE ENGINE'S `readManifest` SEAM IS WHY THIS COMPOSES AT ALL
 * ================================================================================================
 * `syncConfigSourceCommit` takes the read as a parameter rather than doing it. So phase 3 hands it a
 * closure over the phase-2 results and the engine runs entirely inside the write transaction with no
 * I/O of its own — which is exactly what that seam was for.
 */

import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { createGitProviderManifestReader } from "../dependencies/manifest-reader.js";
import { listConfigSourceRegistrations } from "./config-sources-repo.js";
import { selectChangedManifestPaths } from "./manifest-path-selection.js";
import { claimPendingSyncs, markSyncProcessed, type SyncQueueEntry } from "./sync-queue-repo.js";
import { syncConfigSourceCommit, type ManifestRead } from "./sync-engine.js";
import type { ConfigSourceDocument } from "./config-source-document.js";
import type { ConfigSourceRegistration } from "./registration-match.js";

/** Bounded per tick for the reason every other batch here is: one org's backlog must not starve the
 *  rest of the tick's work. */
const DRAIN_LIMIT = 5;

interface PlannedSync {
  entry: SyncQueueEntry;
  document: ConfigSourceDocument;
  registrations: ConfigSourceRegistration[];
  /** path -> what reading it produced. Populated in phase 2, consumed by the engine in phase 3. */
  reads: Map<string, ManifestRead>;
}

export async function drainConfigSourceSyncQueue(
  db: Db,
  orgId: string,
  host: PluginHost,
  masterKey: Buffer,
  requestId: string
): Promise<{ drained: number }> {
  // ---- PHASE 1: what is pending, and what governs it. Read-only. ----------------------------
  const planned = await withTenantTx(db, orgId, async (tx) => {
    const pending = await claimPendingSyncs(tx, orgId, DRAIN_LIMIT);
    if (pending.length === 0) return [];
    const registry = await listConfigSourceRegistrations(tx, orgId);
    const out: PlannedSync[] = [];
    for (const entry of pending) {
      const document = registry.documents.get(entry.configSourceId);
      // A registration deleted or made malformed between enqueue and drain. Not an error: the work
      // item is stale, and phase 3 marks it drained with that as the reason rather than retrying a
      // document that no longer exists.
      if (!document) continue;
      out.push({ entry, document, registrations: registry.registrations, reads: new Map() });
    }
    return out;
  });
  if (planned.length === 0) return { drained: 0 };

  // ---- PHASE 2: fetch the manifests. NO transaction is open here. ---------------------------
  //
  // The path selection is computed with the SAME pure function the engine will use, over the same
  // inputs, so the two agree by construction rather than by two similar loops happening to match.
  const read = createGitProviderManifestReader({ db, host, orgId, masterKey });
  for (const plan of planned) {
    for (const match of selectChangedManifestPaths(plan.document.paths, plan.entry.paths)) {
      try {
        const result = await read({
          repo: plan.entry.repo,
          ref: plan.entry.commitSha,
          path: match.path
        });
        // THE THREE OUTCOMES ARE KEPT APART. `not_found` and `refused` are different facts — the
        // file is absent versus the file exists and was deliberately not decoded (too large, binary)
        // — and collapsing them would report a size refusal as a missing manifest, sending an
        // operator to look for a file that is right there.
        plan.reads.set(
          match.path,
          result.outcome === "found"
            ? { ok: true, content: result.content }
            : result.outcome === "not_found"
              ? {
                  ok: false,
                  detail: `not found at ${plan.entry.commitSha} (${result.missing})${result.detail ? `: ${result.detail}` : ""}`
                }
              : { ok: false, detail: `refused: ${result.reason} — ${result.detail}` }
        );
      } catch (error) {
        // A read failure is DATA for the sync status, not a reason to abandon the entry: section 4's
        // failure honesty makes "the manifest could not be read" a displayed state with its cause.
        plan.reads.set(match.path, {
          ok: false,
          detail: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  // ---- PHASE 3: claim, apply, mark. One transaction per entry. -------------------------------
  //
  // PER ENTRY, deliberately: one manifest whose apply is refused must not roll back the sync of an
  // unrelated config source that happened to be in the same batch.
  let drained = 0;
  for (const plan of planned) {
    try {
      await withTenantTx(db, orgId, async (tx) => {
        const stillPending = await claimPendingSyncs(tx, orgId, DRAIN_LIMIT);
        // Another tick took it between phase 1 and here. Doing nothing is right: that tick owns it.
        if (!stillPending.some((e) => e.id === plan.entry.id)) return;

        await syncConfigSourceCommit(tx, orgId, {
          registrations: plan.registrations,
          configSourceId: plan.entry.configSourceId,
          document: plan.document,
          repoIdentity: plan.entry.repo,
          commitSha: plan.entry.commitSha,
          changedPaths: plan.entry.paths,
          now: new Date(),
          requestId,
          readManifest: async (path) =>
            plan.reads.get(path) ?? {
              ok: false,
              detail: "manifest was not fetched for this sync — the path selection disagreed"
            }
        });
        await markSyncProcessed(tx, orgId, plan.entry.id);
      });
      drained += 1;
    } catch (error) {
      // The sync engine does not throw for an ordinary stopping point — it returns a status. So a
      // throw here is a genuine fault, and the entry is marked drained WITH it rather than retried:
      // the repo stays ahead of the graph as a displayed state, and the next push enqueues fresh
      // work. Its own transaction, so the failed one is already rolled back and this write is on a
      // clean connection.
      await withTenantTx(db, orgId, (tx) =>
        markSyncProcessed(
          tx,
          orgId,
          plan.entry.id,
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }
  return { drained };
}
