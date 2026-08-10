import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { TrustDomainId } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { federationSelf, objects, orgs } from "../db/schema.js";

/**
 * ============================================================================================
 * "HAS THIS ORG BEEN ORPHANED FROM ITS OWN FEDERATION IDENTITY?" — a read-only operational check
 * ============================================================================================
 *
 * ## The hazard
 *
 * Every reconcile candidate query now filters on the org's own trust-domain id:
 * `eq(objects.originDomainId, selfDomainId)` in `coordination/changes-repo.ts`'s
 * `listChangeRowsInStates` and `coordination/campaign-repo.ts`'s `listActiveCampaignObjectIds`.
 * `selfDomainId` is resolved once per tick from `federation_self.domain_id` via
 * `self-repo.ts::ensureFederationSelf`, which MINTS a fresh `uuidv7()` whenever the row is absent.
 *
 * That filter is correct — driving a peer's replica is the S10 single-writer violation, and a
 * filter (rather than a loop-body `continue`) is the only starvation-free way to express it. But it
 * has a failure mode the loop-body skip did not have: if `federation_self.domain_id` ever diverges
 * from the `origin_domain_id` already stamped on this org's objects — a partial restore, an org
 * cloned into a new database, a rebuild that recreated the `federation_self` row — then EVERY
 * candidate query returns zero rows and all coordination for that org stops. Silently. No error, no
 * blocked change, no log line: an empty batch is exactly what "nothing to do" looks like.
 *
 * This codebase has already paid for that shape once — thirteen days of production coordination
 * lost behind green health checks (`coordination/candidate-loop-registry.test.ts`,
 * `coordination/executing-batch-starvation.integration.test.ts`). Hence a check that can SEE the
 * condition, rather than waiting for someone to notice nothing has deployed in a fortnight.
 *
 * ## The predicate, and why it is "none" rather than "some"
 *
 * `objects.origin_domain_id` records the domain that AUTHORED the row. Anything this instance
 * creates is stamped with `federation_self.domain_id` at creation (`graph/objects-repo.ts`:
 * `const originDomainId = input.federationImport?.originDomainId ?? self!.domainId`), and anything
 * imported from a peer keeps the exporter's id verbatim (single-writer authority: a replica carries
 * its author's identity, not ours). So, over an org's live objects:
 *
 *   | self-origin | foreign-origin | verdict                                                    |
 *   |-------------|----------------|------------------------------------------------------------|
 *   |   > 0       |      0         | healthy single-domain org.                                   |
 *   |   > 0       |    > 0         | healthy FEDERATED org — it authors its own rows and holds     |
 *   |             |                | replicas of its peers'. Entirely normal; MUST stay quiet.     |
 *   |     0       |    > 0         | ORPHANED FROM ITS OWN IDENTITY — warn.                        |
 *   |     0       |      0         | a brand-new org that has created nothing yet — nothing to     |
 *   |             |                | diverge from. Quiet.                                          |
 *
 * The distinguishing fact is that federation never REMOVES or REWRITES the rows the local domain
 * authored — importing a peer's journal only ever adds replicas alongside them. Every org this
 * instance serves was created through `auth/local-auth.ts::ensureBootstrapAdmin`, which authors an
 * `organization` root object (and the bootstrap admin's `user` object) locally, under whatever
 * `federation_self.domain_id` held at the time. So "not one single live object in this org was
 * authored under my current identity" is not reachable by any legitimate federation topology,
 * however replica-heavy: it can only mean the identity no longer matches the rows it owns.
 *
 * A PARTIAL mismatch is therefore deliberately NOT a finding. An outpost that syncs a large
 * commander catalogue can legitimately be 99% replicas; warning on that would be an alarm operators
 * learn to mute, which is worse than no alarm (`graph/integrity-repo.ts` makes the same argument
 * about inert findings).
 *
 * ## What this check is NOT
 *
 *  - NOT on the hot path. It runs once at boot (`main.ts`) and on demand (`GET /api/v1/doctor`,
 *    `scp doctor`). The owner rejected a per-tick empty-batch warning: it costs a query on a
 *    one-second loop and floods the log for any org that is legitimately idle.
 *  - NOT a repair. It never writes — in particular it reads `federation_self` with a plain SELECT
 *    rather than `ensureFederationSelf`, precisely because that helper MINTS a row on a miss and
 *    would turn a diagnosis into the very divergence it is diagnosing. Which side is wrong (the
 *    identity, or the objects) is an operator decision that depends on where the good backup is.
 */

/** One origin domain present on this org's live objects, with how many rows carry it. */
export interface OriginTally {
  domainId: TrustDomainId;
  objectCount: number;
}

export interface FederationSelfOriginFinding {
  orgId: string;
  /** `orgs.name` — so an operator reading a boot log knows which tenant without a second query. */
  orgName: string;
  /** NULL when `federation_self` has no row for this org at all (see `diverged` below). */
  selfDomainId: TrustDomainId | null;
  /** Live (`deleted_at IS NULL`) objects in this org — the population the candidate queries draw from. */
  liveObjectCount: number;
  /** How many of those were authored under `selfDomainId`. Zero-with-a-non-empty-org is the finding. */
  selfOriginObjectCount: number;
  /** Every OTHER origin present, biggest first — the ids an operator needs to decide which side is wrong. */
  foreignOrigins: OriginTally[];
  /** The predicate: this org has objects, and NONE of them were authored under its current identity. */
  diverged: boolean;
}

/**
 * One org's finding, in one read-only pass (two small queries: the identity row, and a grouped
 * tally of origins). Tenant-scoped like every other repo function, so it can serve both the
 * instance-wide boot sweep and the per-tenant `GET /api/v1/doctor` without a second implementation.
 */
export async function inspectFederationSelfOrigin(
  tx: TenantTx,
  orgId: string,
  /** Supplied by the boot sweep, which already enumerated `orgs`; looked up here otherwise.
   *  `orgs` carries no RLS policy (drizzle/0004 §4), so this read is legal inside a tenant tx —
   *  and it only ever reads the CALLER'S OWN org row, never enumerates the table. */
  orgName?: string
): Promise<FederationSelfOriginFinding> {
  const resolvedOrgName =
    orgName ??
    (await tx.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1))[0]?.name ??
    orgId;

  // A plain SELECT, NOT `ensureFederationSelf` — see the module doc's "NOT a repair". A diagnostic
  // that lazily creates the identity it is checking would mint a fresh uuidv7 against an org full
  // of objects stamped with the old one, i.e. it would CAUSE the outage it exists to report.
  const [self] = await tx
    .select({ domainId: federationSelf.domainId })
    .from(federationSelf)
    .where(eq(federationSelf.orgId, orgId))
    .limit(1);
  const selfDomainId = self?.domainId ?? null;

  // `deleted_at IS NULL` matches what the candidate queries actually consider a candidate
  // (`listActiveCampaignObjectIds`), and a tombstone cannot be coordinated in any case. Grouped
  // rather than counted twice: the foreign ids are the operator's evidence for which side is wrong,
  // and the group is bounded by the number of peer domains (tens), not by row count.
  const tallies = await tx
    .select({
      domainId: objects.originDomainId,
      objectCount: sql<number>`count(*)::int`
    })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), isNull(objects.deletedAt)))
    .groupBy(objects.originDomainId);

  let liveObjectCount = 0;
  let selfOriginObjectCount = 0;
  const foreignOrigins: OriginTally[] = [];
  for (const row of tallies) {
    liveObjectCount += row.objectCount;
    if (selfDomainId !== null && row.domainId === selfDomainId) {
      selfOriginObjectCount += row.objectCount;
    } else {
      foreignOrigins.push({ domainId: row.domainId, objectCount: row.objectCount });
    }
  }
  foreignOrigins.sort((a, b) => b.objectCount - a.objectCount);

  return {
    orgId,
    orgName: resolvedOrgName,
    selfDomainId,
    liveObjectCount,
    selfOriginObjectCount,
    foreignOrigins,
    // THE PREDICATE. `liveObjectCount > 0` keeps a brand-new org quiet; `selfOriginObjectCount === 0`
    // is what no legitimate federation topology can produce (module doc). A partial mismatch —
    // some self, some foreign — is a replica-holding org and stays quiet by construction.
    diverged: liveObjectCount > 0 && selfOriginObjectCount === 0
  };
}

/**
 * The operator-facing text, authored ONCE and shared by the boot log, `GET /api/v1/doctor` and
 * `scp doctor`, so the three can never drift. Deliberately long: this is read at 2am by someone who
 * has just discovered that nothing has deployed for a fortnight, and every clause below is something
 * they would otherwise have to reverse-engineer — what is broken, why it is silent, how it happens,
 * and why the platform refuses to fix it for them.
 */
export function describeFederationSelfOriginFinding(f: FederationSelfOriginFinding): string {
  const org = `org '${f.orgName}' (${f.orgId})`;

  if (!f.diverged) {
    if (f.liveObjectCount === 0) {
      return `${org}: no live graph objects yet — nothing to diverge from (federation_self.domain_id = ${f.selfDomainId ?? "not yet created"}).`;
    }
    const replicas = f.foreignOrigins.reduce((n, o) => n + o.objectCount, 0);
    const federated =
      replicas > 0
        ? ` ${replicas} more are replicas of ${f.foreignOrigins.length} peer domain(s) — normal for a federated estate.`
        : "";
    return `${org}: federation_self.domain_id = ${f.selfDomainId} authored ${f.selfOriginObjectCount} of ${f.liveObjectCount} live objects, so reconcile candidate queries have rows to match.${federated}`;
  }

  const identity =
    f.selfDomainId === null
      ? "federation_self has NO row for this org at all, so the next reconcile tick will MINT a brand-new domain id " +
        "(federation/self-repo.ts::ensureFederationSelf) that matches none of them"
      : `federation_self.domain_id = ${f.selfDomainId}, and NOT ONE of them was authored under it`;

  const origins =
    f.foreignOrigins.length === 0
      ? "(none recorded)"
      : f.foreignOrigins.map((o) => `${o.domainId} (${o.objectCount} objects)`).join(", ");

  const remedyIfObjectsAreRight =
    f.foreignOrigins.length === 1
      ? `restore ${f.foreignOrigins[0]!.domainId} — the origin every object already carries — into federation_self.domain_id for this org`
      : "restore this org's ORIGINAL domain_id into federation_self.domain_id (the origins the objects carry are listed above)";

  return [
    `FEDERATION IDENTITY DIVERGENCE — ${org} is orphaned from its own domain identity.`,
    `This org has ${f.liveObjectCount} live graph objects; ${identity}.`,
    `Origins actually present on those objects: ${origins}.`,
    "",
    "WHY THIS MATTERS: every reconcile candidate query filters on " +
      "`objects.origin_domain_id = federation_self.domain_id` " +
      "(coordination/changes-repo.ts::listChangeRowsInStates, coordination/campaign-repo.ts::listActiveCampaignObjectIds). " +
      "With no row matching, every batch comes back EMPTY and ALL COORDINATION FOR THIS ORG STOPS — " +
      "no error, no blocked change, no failing health check. It is indistinguishable from 'nothing to do'. " +
      "This platform has already lost 13 days of production coordination to that exact silence.",
    "",
    "HOW THIS HAPPENS: a partial restore, an org cloned into a fresh database, or a rebuild/migration " +
      "that recreated the federation_self row (federation/self-repo.ts mints a fresh uuidv7 whenever the row is absent).",
    "",
    "WHAT TO DO: this check is READ-ONLY and will NOT repair it, because the remedy depends on which side " +
      "is wrong and that is an operator decision:",
    `  (a) if this instance's IDENTITY was lost or recreated, the objects are right — ${remedyIfObjectsAreRight}.`,
    "  (b) if the OBJECTS were copied in from another domain, they are replicas and this instance is not " +
      "their writer — re-import them under this domain's identity, or point this instance at the database " +
      "that owns them.",
    "Verify with `scp federation self` and `scp doctor` before and after."
  ].join("\n");
}

/**
 * Every org on this instance, one finding each — the instance-wide form used by the boot check.
 *
 * Enumerates orgs exactly the way every other instance-wide sweep does
 * (`coordination/reconcile.ts::runReconcileSweep`, `coordination/watchdog.ts`,
 * `federation/inbox-loop.ts`): a bare `select` off `orgs` (no RLS on that table), then one
 * `withTenantTx` per org so each org's read stays inside the same RLS boundary as production.
 */
export async function inspectFederationSelfOriginForAllOrgs(
  db: Db
): Promise<FederationSelfOriginFinding[]> {
  const orgRows = await db
    .select({ id: orgs.id, name: orgs.name })
    .from(orgs)
    .orderBy(asc(orgs.id));
  const findings: FederationSelfOriginFinding[] = [];
  for (const org of orgRows) {
    findings.push(
      await withTenantTx(db, org.id, (tx) => inspectFederationSelfOrigin(tx, org.id, org.name))
    );
  }
  return findings;
}

/**
 * THE STARTUP CHECK (called from `main.ts`). Logs one loud `warn` per orphaned org and returns how
 * many it found.
 *
 * NON-FATAL by design: an operator part-way through a restore must still be able to boot the
 * instance and finish the job — and a check that can take the platform down is a check that gets
 * deleted. Loud-and-running is the same call `main.ts` already makes for an ephemeral secrets master
 * key and for an expired federation CRL.
 */
export async function warnOnFederationSelfOriginDivergence(
  db: Db,
  log: { warn: (msg: string) => void; error: (msg: string) => void }
): Promise<number> {
  let diverged = 0;
  try {
    for (const finding of await inspectFederationSelfOriginForAllOrgs(db)) {
      if (!finding.diverged) continue;
      diverged += 1;
      log.warn(describeFederationSelfOriginFinding(finding));
    }
  } catch (err) {
    // A diagnostic must never be the reason a boot fails — report and continue.
    log.error(
      `[scpd] federation identity check could not run (continuing): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return diverged;
}
