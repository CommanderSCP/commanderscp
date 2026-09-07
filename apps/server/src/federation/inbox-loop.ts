/** M13.1a — the staging-node INBOX INGEST LOOP. See docs/federation.md §281. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type PgBoss from "pg-boss";
import {
  ImportBundleRequestSchema,
  type ImportBundleRequest,
  type PromotionBundle
} from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { changes, federationInboxFiles, orgs } from "../db/schema.js";
import { describeError, ProblemError } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { listPeers, type FederationPeerRow } from "./peers-repo.js";
import { listInbox, resolveDeliveryTarget, resolveOnwardDeliveryDir } from "./delivery-target.js";
import { importSyncBundle, FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import { importPromotionBundle } from "./promotion-repo.js";
import {
  importRelayTarball,
  relayConfigFromEnv,
  resolveUnderDir,
  sha256File,
  validateAndForwardRelayTarball,
  type RelayConfig
} from "./retrans-relay.js";
import { parseJsonRejectingPrototypePoisoning } from "../util/safe-json.js";

export const INBOX_QUEUE = "federation-inbox-tick";

export const INBOX_TICK_INTERVAL_SECONDS = Math.max(
  5,
  Number(process.env.SCP_INBOX_TICK_INTERVAL_SECONDS ?? 60)
);

/** The explicit operator enable (opt-in choice documented in the module header). */
export function inboxLoopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCP_INBOX_LOOP === "1";
}

/** The loop's OWN block-verdict kind — written ONLY when a refusal's underlying verify path did
 *  not persist a Decision itself (see the module header's D4 section). */
export const INBOX_INGEST_DECISION_KIND = "federation-inbox-ingest";

/** Ledger sha256 sentinel for a file that could not be read at all (traversal-shaped name). */
const UNREADABLE_SHA = "-";

/** This branch reads the whole file before it can hash it. See docs/federation.md §282. */
const INBOX_MAX_BUNDLE_BYTES = (() => {
  const raw = process.env.SCP_INBOX_MAX_BUNDLE_BYTES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 64 * 1024 * 1024;
})();

const RELAY_TARBALL_RE = /^scp-relay-(.+)\.tar\.gz$/;

interface InboxSource {
  peer: FederationPeerRow | null;
  dir: string;
}

/** One file's terminal (or deferred) outcome — returned for tests/observability. */
export interface InboxFileOutcome {
  outcome: "imported" | "forwarded" | "refused" | "skipped" | "deferred" | "already-processed";
  detail: string;
  decisionId: string | null;
}

export interface InboxSweepOptions {
  /** Test seam / config override; production ticks read the live env (`relayConfigFromEnv`). */
  relayConfig?: RelayConfig;
}

// Ledger (federation_inbox_files) — content-identity dedupe, insert-only.

async function ledgerHas(
  tx: TenantTx,
  orgId: string,
  dir: string,
  fileName: string,
  sha256: string
): Promise<boolean> {
  const rows = await tx
    .select({ id: federationInboxFiles.id })
    .from(federationInboxFiles)
    .where(
      and(
        eq(federationInboxFiles.orgId, orgId),
        eq(federationInboxFiles.inboxDir, dir),
        eq(federationInboxFiles.fileName, fileName),
        eq(federationInboxFiles.sha256, sha256)
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function insertLedgerRow(
  tx: TenantTx,
  args: {
    orgId: string;
    dir: string;
    fileName: string;
    sha256: string;
    outcome: "imported" | "forwarded" | "refused" | "skipped";
    detail: string;
    decisionId: string | null;
  }
): Promise<void> {
  await tx
    .insert(federationInboxFiles)
    .values({
      id: uuidv7(),
      orgId: args.orgId,
      inboxDir: args.dir,
      fileName: args.fileName,
      sha256: args.sha256,
      outcome: args.outcome,
      detail: args.detail,
      decisionId: args.decisionId
    })
    .onConflictDoNothing();
}

// Per-file terminal outcomes — each in ONE tx (ledger + audit + any loop-level Decision together).

/** Terminal refusal: the underlying path's Decision when it wrote one (identical to the CLI
 *  outcome), else the loop's own `federation-inbox-ingest` block Decision — an unattended refusal
 *  always leaves an explainable trail (principle 6). NEVER any transfer confirmation (D4). */
async function refuseFile(
  db: Db,
  args: {
    orgId: string;
    source: InboxSource;
    fileName: string;
    sha256: string;
    reason: string;
    underlyingDecisionId: string | null;
    subjectId?: string;
  }
): Promise<InboxFileOutcome> {
  const decisionId = await withTenantTx(db, args.orgId, async (tx) => {
    let id = args.underlyingDecisionId;
    if (!id) {
      const decision = await insertDecision(tx, {
        orgId: args.orgId,
        kind: INBOX_INGEST_DECISION_KIND,
        subjectId: args.subjectId ?? uuidv7(),
        verdict: "block",
        inputContext: {
          inboxDir: args.source.dir,
          fileName: args.fileName,
          sha256: args.sha256,
          peer: args.source.peer?.name ?? null
        },
        reasonTree: { summary: args.reason }
      });
      id = decision.id;
    }
    await appendAuditEvent(tx, {
      orgId: args.orgId,
      actorId: FEDERATION_IMPORT_ACTOR_ID,
      action: "federation.inbox.refused",
      subjectId: args.subjectId ?? null,
      reason: `inbox file '${args.fileName}' refused: ${args.reason}`,
      decisionId: id,
      requestId: `federation-inbox:${args.fileName}:${args.sha256.slice(0, 12)}`
    });
    await insertLedgerRow(tx, {
      orgId: args.orgId,
      dir: args.source.dir,
      fileName: args.fileName,
      sha256: args.sha256,
      outcome: "refused",
      detail: args.reason,
      decisionId: id
    });
    return id;
  });
  console.error(
    `[inbox] org ${args.orgId}: refused '${args.fileName}' (decision ${decisionId}): ${args.reason}`
  );
  return { outcome: "refused", detail: args.reason, decisionId };
}

/** Terminal success: ledger + audit. Confirmation already happened INSIDE the verify path
 *  (validate-gated, D4) — nothing is confirmed here. */
async function completeFile(
  db: Db,
  args: {
    orgId: string;
    source: InboxSource;
    fileName: string;
    sha256: string;
    outcome: "imported" | "forwarded";
    detail: string;
    decisionId: string | null;
    subjectId?: string;
  }
): Promise<InboxFileOutcome> {
  await withTenantTx(db, args.orgId, async (tx) => {
    await appendAuditEvent(tx, {
      orgId: args.orgId,
      actorId: FEDERATION_IMPORT_ACTOR_ID,
      action:
        args.outcome === "forwarded" ? "federation.inbox.forwarded" : "federation.inbox.imported",
      subjectId: args.subjectId ?? null,
      reason: `inbox file '${args.fileName}' ${args.outcome}: ${args.detail}`,
      decisionId: args.decisionId,
      requestId: `federation-inbox:${args.fileName}:${args.sha256.slice(0, 12)}`
    });
    await insertLedgerRow(tx, {
      orgId: args.orgId,
      dir: args.source.dir,
      fileName: args.fileName,
      sha256: args.sha256,
      outcome: args.outcome,
      detail: args.detail,
      decisionId: args.decisionId
    });
  });
  return { outcome: args.outcome, detail: args.detail, decisionId: args.decisionId };
}

/** Terminal skip (foreign/unknown file): ledger row so it is logged ONCE, never a crash. */
async function skipFile(
  db: Db,
  args: { orgId: string; source: InboxSource; fileName: string; sha256: string; reason: string }
): Promise<InboxFileOutcome> {
  await withTenantTx(db, args.orgId, (tx) =>
    insertLedgerRow(tx, {
      orgId: args.orgId,
      dir: args.source.dir,
      fileName: args.fileName,
      sha256: args.sha256,
      outcome: "skipped",
      detail: args.reason,
      decisionId: null
    })
  );
  console.warn(`[inbox] org ${args.orgId}: skipped '${args.fileName}': ${args.reason}`);
  return { outcome: "skipped", detail: args.reason, decisionId: null };
}

/** NON-terminal skip (not-for-this-org / prerequisite missing / config gap): NO ledger row —
 *  the file is retried on a later tick once the prerequisite lands. */
function deferFile(orgId: string, fileName: string, reason: string): InboxFileOutcome {
  console.warn(`[inbox] org ${orgId}: deferred '${fileName}': ${reason}`);
  return { outcome: "deferred", detail: reason, decisionId: null };
}

function isPromotionBundle(body: ImportBundleRequest): body is PromotionBundle {
  return body.header.kind === "promotion";
}

/** The local change a relay tarball binds to: the change IMPORTED from the named source change
 *  (its `.scpbundle` import recorded `sourceRef.sourceChangeObjectId`). The file name is only a
 *  LOOKUP HINT — every trust decision re-derives from the local change's own verified manifest
 *  inside the verify paths (inbox contents are untrusted data). */
async function findChangeBySourceChangeObjectId(
  tx: TenantTx,
  orgId: string,
  sourceChangeObjectId: string
): Promise<string | null> {
  const rows = await tx
    .select({ objectId: changes.objectId })
    .from(changes)
    .where(
      and(
        eq(changes.orgId, orgId),
        sql`${changes.sourceRef} ->> 'sourceChangeObjectId' = ${sourceChangeObjectId}`,
        sql`${changes.importedFromDomain} IS NOT NULL`
      )
    )
    .orderBy(changes.objectId)
    .limit(2);
  // Deterministic: the oldest (uuidv7-ordered) import wins if several exist.
  return rows[0]?.objectId ?? null;
}

/** The UPSTREAM relay's cosign verification key: the cosign public key registered (at pairing)
 *  for this org's single `role: retrans` peer. Zero/ambiguous → null (config gap, deferred). */
function upstreamRelayCosignKey(peers: FederationPeerRow[]): string | null {
  const candidates = peers.filter((p) => p.role === "retrans" && p.cosignPublicKey);
  if (candidates.length !== 1) return null;
  return candidates[0]!.cosignPublicKey;
}

/** Exported for the integration suite (the DoD's per-file semantics are asserted through it);
 *  production reaches it only via {@link inboxOrgTick}. */
export async function processInboxFile(
  db: Db,
  orgId: string,
  ctx: { self: FederationSelf; peers: FederationPeerRow[] },
  source: InboxSource,
  fileName: string,
  masterKey: Buffer,
  config: RelayConfig
): Promise<InboxFileOutcome> {
  // The PR #112 traversal guard survives automation: a name that resolves outside the inbox is
  // refused OUTRIGHT (block Decision; ledger sentinel sha — the file is never read).
  let filePath: string;
  try {
    filePath = resolveUnderDir(source.dir, fileName);
  } catch (err) {
    return refuseFile(db, {
      orgId,
      source,
      fileName,
      sha256: UNREADABLE_SHA,
      reason:
        err instanceof ProblemError
          ? `traversal-shaped file name (rejected, fail-closed): ${err.detail ?? err.message}`
          : String(err),
      underlyingDecisionId: null
    });
  }

  // Content identity for the dedupe ledger. See docs/federation.md §283.
  const isBundle = fileName.endsWith(".scpbundle");
  let bundleBytes: Buffer | null = null;
  let sha256: string;
  if (isBundle) {
    // Size gate BEFORE the read (fail-closed): refuse an oversized bundle without ever loading it
    // into memory, mirroring app.ts's HTTP bodyLimit. A stat failure also refuses, same as a read
    // failure — the file is never read, so the ledger identity is the UNREADABLE_SHA sentinel.
    try {
      const size = (await stat(filePath)).size;
      if (size > INBOX_MAX_BUNDLE_BYTES) {
        return refuseFile(db, {
          orgId,
          source,
          fileName,
          sha256: UNREADABLE_SHA,
          reason: `.scpbundle exceeds max size (rejected, fail-closed): ${size} > ${INBOX_MAX_BUNDLE_BYTES} bytes`,
          underlyingDecisionId: null
        });
      }
    } catch (err) {
      return refuseFile(db, {
        orgId,
        source,
        fileName,
        sha256: UNREADABLE_SHA,
        reason: `.scpbundle not statable (rejected, fail-closed): ${err instanceof Error ? err.message : String(err)}`,
        underlyingDecisionId: null
      });
    }
    try {
      bundleBytes = await readFile(filePath);
    } catch (err) {
      return refuseFile(db, {
        orgId,
        source,
        fileName,
        sha256: UNREADABLE_SHA,
        reason: `.scpbundle not readable (rejected, fail-closed): ${err instanceof Error ? err.message : String(err)}`,
        underlyingDecisionId: null
      });
    }
    sha256 = createHash("sha256").update(bundleBytes).digest("hex");
  } else {
    sha256 = await sha256File(filePath);
  }

  const processed = await withTenantTx(db, orgId, (tx) =>
    ledgerHas(tx, orgId, source.dir, fileName, sha256)
  );
  if (processed) {
    return {
      outcome: "already-processed",
      detail: "content already in the inbox ledger",
      decisionId: null
    };
  }

  if (isBundle) {
    return processBundleFile(db, orgId, ctx, source, fileName, bundleBytes!, sha256);
  }
  if (RELAY_TARBALL_RE.test(fileName)) {
    return processRelayTarballFile(
      db,
      orgId,
      ctx,
      source,
      fileName,
      filePath,
      sha256,
      masterKey,
      config
    );
  }
  return skipFile(db, {
    orgId,
    source,
    fileName,
    sha256,
    reason: "not a channel artifact (neither .scpbundle nor scp-relay-*.tar.gz) — ignored"
  });
}

async function processBundleFile(
  db: Db,
  orgId: string,
  ctx: { self: FederationSelf },
  source: InboxSource,
  fileName: string,
  /** The bytes already read ONCE by processInboxFile — the SAME buffer whose sha256 is the ledger
   *  identity, so what is parsed/imported here is exactly what the ledger records (no re-read). */
  rawBytes: Buffer,
  sha256: string
): Promise<InboxFileOutcome> {
  let parsed: ImportBundleRequest;
  try {
    // The poisoning-rejecting parse: this is an air-gap door. See docs/federation.md §284.
    const raw = parseJsonRejectingPrototypePoisoning(rawBytes.toString("utf8"));
    const result = ImportBundleRequestSchema.safeParse(raw);
    if (!result.success) {
      return refuseFile(db, {
        orgId,
        source,
        fileName,
        sha256,
        reason: `not a well-formed .scpbundle (schema validation failed): ${result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        underlyingDecisionId: null
      });
    }
    parsed = result.data;
  } catch (err) {
    return refuseFile(db, {
      orgId,
      source,
      fileName,
      sha256,
      reason: `not parseable as a .scpbundle: ${err instanceof Error ? err.message : String(err)}`,
      underlyingDecisionId: null
    });
  }

  // Multi-tenant addressing: a bundle for ANOTHER org's domain is not this org's to touch —
  // deferred without a ledger row so the addressed org's own tick can claim it.
  if (parsed.header.peerDomainId !== ctx.self.domainId) {
    return deferFile(
      orgId,
      fileName,
      `bundle is addressed to domain '${parsed.header.peerDomainId}', not this org's ` +
        `('${ctx.self.domainId}') — left for the addressed org`
    );
  }

  try {
    if (isPromotionBundle(parsed)) {
      const imported = await importPromotionBundle(db, orgId, parsed);
      return completeFile(db, {
        orgId,
        source,
        fileName,
        sha256,
        outcome: "imported",
        detail:
          `promotion bundle imported as change ${imported.localChangeObjectId} ` +
          `(approvals accepted ${imported.approvalsAccepted}, rejected ${imported.approvalsRejected})`,
        decisionId: null,
        subjectId: imported.localChangeObjectId
      });
    }
    const imported = await withTenantTx(db, orgId, (tx) => importSyncBundle(tx, orgId, parsed));
    return completeFile(db, {
      orgId,
      source,
      fileName,
      sha256,
      outcome: "imported",
      detail:
        `sync bundle imported: applied ${imported.appliedEntries}, skipped ` +
        `${imported.skippedEntries}, cursor at ${imported.lastAppliedSequence}`,
      decisionId: null
    });
  } catch (err) {
    // 409 = the verify path REFUSED. See docs/federation.md §285.
    if (err instanceof ProblemError && err.status === 409) {
      return refuseFile(db, {
        orgId,
        source,
        fileName,
        sha256,
        reason: err.detail ?? err.message,
        underlyingDecisionId: err.decisionId ?? null
      });
    }
    return deferFile(
      orgId,
      fileName,
      `import not currently possible (${err instanceof ProblemError ? (err.detail ?? err.message) : String(err)})`
    );
  }
}

async function processRelayTarballFile(
  db: Db,
  orgId: string,
  ctx: { self: FederationSelf; peers: FederationPeerRow[] },
  source: InboxSource,
  fileName: string,
  filePath: string,
  sha256: string,
  masterKey: Buffer,
  config: RelayConfig
): Promise<InboxFileOutcome> {
  const sourceChangeObjectId = RELAY_TARBALL_RE.exec(fileName)![1] as string;
  const localChangeObjectId = await withTenantTx(db, orgId, (tx) =>
    findChangeBySourceChangeObjectId(tx, orgId, sourceChangeObjectId)
  );
  if (!localChangeObjectId) {
    return deferFile(
      orgId,
      fileName,
      `no local change imported from source change '${sourceChangeObjectId}' yet — the ` +
        `promotion .scpbundle must land first (retried next tick)`
    );
  }
  const relayKey = upstreamRelayCosignKey(ctx.peers);
  if (!relayKey) {
    return deferFile(
      orgId,
      fileName,
      "no single 'retrans'-role peer with a registered cosign public key — pair the upstream " +
        "relay (scp federation pair --role retrans --cosign-public-key …) so arriving tarballs " +
        "can be verified (config gap, retried next tick)"
    );
  }

  try {
    if (ctx.self.role === "retrans") {
      const onward = resolveOnwardDeliveryDir(ctx.peers, config);
      if ("problem" in onward) {
        return deferFile(orgId, fileName, `onward drop unresolvable: ${onward.problem}`);
      }
      const result = await validateAndForwardRelayTarball(db, {
        orgId,
        changeIdOrUrn: localChangeObjectId,
        tarballPath: filePath,
        relayCosignPublicKeyPem: relayKey,
        outDir: onward.dir,
        onwardPeerDomainId: onward.peerDomainId,
        fileName,
        config
      });
      if (result.refused) {
        return refuseFile(db, {
          orgId,
          source,
          fileName,
          sha256,
          reason: result.reason,
          underlyingDecisionId: result.decisionId,
          subjectId: localChangeObjectId
        });
      }
      return completeFile(db, {
        orgId,
        source,
        fileName,
        sha256,
        outcome: "forwarded",
        detail: `validated and forwarded to ${result.forwardedPath} (no registry push — retrans profile)`,
        decisionId: result.decisionId,
        subjectId: localChangeObjectId
      });
    }

    const result = await importRelayTarball(db, {
      orgId,
      changeIdOrUrn: localChangeObjectId,
      tarballPath: filePath,
      relayCosignPublicKeyPem: relayKey,
      masterKey,
      config
    });
    if (result.refused) {
      return refuseFile(db, {
        orgId,
        source,
        fileName,
        sha256,
        reason: result.reason,
        underlyingDecisionId: result.decisionId,
        subjectId: localChangeObjectId
      });
    }
    return completeFile(db, {
      orgId,
      source,
      fileName,
      sha256,
      outcome: "imported",
      detail: `relay tarball imported: ${result.pushed
        .map((p) => `${p.type} ${p.digest}`)
        .join(", ")}`,
      decisionId: result.decisionId,
      subjectId: localChangeObjectId
    });
  } catch (err) {
    if (err instanceof ProblemError && err.status === 409) {
      return refuseFile(db, {
        orgId,
        source,
        fileName,
        sha256,
        reason: err.detail ?? err.message,
        underlyingDecisionId: err.decisionId ?? null,
        subjectId: localChangeObjectId
      });
    }
    return deferFile(
      orgId,
      fileName,
      `relay processing not currently possible (${err instanceof ProblemError ? (err.detail ?? err.message) : String(err)})`
    );
  }
}

// The tick — per org, then every org (mirrors observe.ts's sweep shape).

/** Bundles BEFORE tarballs (a tarball's change comes from its bundle — same-tick completion for
 *  the common both-dropped-together case), each group in stable name order, junk last. */
function orderInboxNames(names: string[]): string[] {
  const bundles = names.filter((n) => n.endsWith(".scpbundle")).sort();
  const tarballs = names.filter((n) => RELAY_TARBALL_RE.test(n)).sort();
  const rest = names.filter((n) => !n.endsWith(".scpbundle") && !RELAY_TARBALL_RE.test(n)).sort();
  return [...bundles, ...tarballs, ...rest];
}

export async function inboxOrgTick(
  db: Db,
  orgId: string,
  masterKey: Buffer,
  options?: InboxSweepOptions
): Promise<InboxFileOutcome[]> {
  const config = options?.relayConfig ?? relayConfigFromEnv();
  const { self, peers } = await withTenantTx(db, orgId, async (tx) => ({
    self: await ensureFederationSelf(tx, orgId),
    peers: await listPeers(tx, orgId)
  }));

  // Inbox sources: every peer-configured inbound dir + the instance env fallback, deduped by
  // resolved dir. Nothing resolvable → the tick is done (the "has an inbox to watch" half of the
  // opt-in, evaluated per org per tick).
  const sources: InboxSource[] = [];
  const seenDirs = new Set<string>();
  for (const peer of peers) {
    const resolved = resolveDeliveryTarget(peer, config);
    // M13.2b census note: this tick sweeps FILESYSTEM inboxes only. See docs/federation.md §286.
    if (resolved.inbound.source === "peer" && resolved.inbound.dir !== null) {
      if (!seenDirs.has(resolved.inbound.dir)) {
        seenDirs.add(resolved.inbound.dir);
        sources.push({ peer, dir: resolved.inbound.dir });
      }
    }
  }
  const envResolved = resolveDeliveryTarget(null, config);
  if (envResolved.inbound.dir !== null && !seenDirs.has(envResolved.inbound.dir)) {
    sources.push({ peer: null, dir: envResolved.inbound.dir });
  }

  const outcomes: InboxFileOutcome[] = [];
  for (const source of sources) {
    let names: string[];
    try {
      names = await listInbox(source.peer, config);
    } catch (err) {
      console.error(`[inbox] org ${orgId}: cannot list inbox '${source.dir}':`, err);
      continue;
    }
    for (const name of orderInboxNames(names)) {
      // ONE BAD FILE NEVER BRICKS THE TICK: every per-file outcome (including unexpected throws)
      // is contained here and the loop continues with the next file.
      try {
        outcomes.push(
          await processInboxFile(db, orgId, { self, peers }, source, name, masterKey, config)
        );
      } catch (err) {
        console.error(`[inbox] org ${orgId}: processing '${name}' failed (will retry):`, err);
        outcomes.push({
          outcome: "deferred",
          // `describeError` for the same reason the five explicit. See docs/federation.md §287.
          detail: describeError(err),
          decisionId: null
        });
      }
    }
  }
  return outcomes;
}

export async function runInboxSweep(
  db: Db,
  masterKey: Buffer,
  options?: InboxSweepOptions
): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await inboxOrgTick(db, org.id, masterKey, options);
    } catch (err) {
      console.error(`[inbox] org ${org.id} tick failed:`, err);
    }
  }
}

/** Enqueues one immediate inbox tick, the air-gap leg. See docs/federation.md §288. */
export const INBOX_POKE_REASON = "poke";

/** The payload an inbox tick carries. An interval tick sends `{}`, so `reason === undefined` is
 *  exactly "this is a scheduled tick". */
export interface InboxJobData {
  reason?: string;
}

export async function wakeInboxNow(boss: PgBoss): Promise<void> {
  await boss.send(INBOX_QUEUE, { reason: INBOX_POKE_REASON });
}

export interface InboxLoopHandle {
  stop(): Promise<void>;
}

/** Self-rescheduling pg-boss loop. See docs/federation.md §289. */
export async function startInboxLoop(
  boss: PgBoss,
  db: Db,
  masterKey: Buffer
): Promise<InboxLoopHandle> {
  if (!inboxLoopEnabled()) {
    return { async stop() {} };
  }
  let stopped = false;
  let inFlightTick: Promise<void> | undefined;
  await boss.createQueue(INBOX_QUEUE);
  await boss.work(INBOX_QUEUE, async (jobs: { data?: InboxJobData }[]) => {
    if (stopped) return;
    // A POKE WAKE DOES NOT RE-SCHEDULE. See docs/federation.md §290.
    const batch = jobs ?? [];
    const reschedule =
      batch.length === 0 || batch.some((job) => job.data?.reason !== INBOX_POKE_REASON);
    const tick = runInboxSweep(db, masterKey);
    inFlightTick = tick;
    try {
      await tick;
    } finally {
      inFlightTick = undefined;
    }
    if (stopped) return;
    if (!reschedule) return;
    await boss.send(
      INBOX_QUEUE,
      {},
      {
        startAfter: INBOX_TICK_INTERVAL_SECONDS,
        singletonKey: "tick",
        singletonSeconds: INBOX_TICK_INTERVAL_SECONDS
      }
    );
  });
  // Startup kick: UNKEYED, so it always inserts (LOOP_STARTUP_SEND_IS_UNKEYED, events/pgboss.ts).
  // Never give this send a singletonKey+window — not the chain's "tick" and not a private key
  // either: job_i4 counts COMPLETED jobs, so any window lets a previous boot swallow it silently.
  await boss.send(INBOX_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}
