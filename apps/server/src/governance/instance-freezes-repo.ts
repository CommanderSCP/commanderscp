import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { instanceFreezes } from "../db/schema.js";
import { freezeWindowCovers } from "./freezes-repo.js";
import type { StageCoordinate } from "../coordination/regional-executors.js";

/** M25.3 — THE INSTANCE-SCOPED. See docs/governance.md §244. */

export interface InstanceFreezeRow {
  /** A real uuid (uuidv7), not `platform:<key>` — see the schema mirror. */
  id: string;
  key: string;
  name: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  /** The EXPLICIT deployment-wide form. When true, `matchEnvironment`/`matchRegion` are null. */
  matchAllEnvironments: boolean;
  matchEnvironment: string | null;
  matchRegion: string | null;
  /** Owner decision D5, identical semantics to `freezes.atomic`. */
  atomic: boolean;
  /** Proposal §2.2 — whether ANY tenant role may override this freeze. Default false. */
  overridable: boolean;
  note: string | null;
  liftedAt: Date | null;
  liftReason: string | null;
  updatedAt: Date;
}

/** EVERY LIVE INSTANCE FREEZE COVERING `at`. See docs/governance.md §245. */
export async function activeInstanceFreezesInWindow(
  tx: TenantTx,
  at: Date
): Promise<InstanceFreezeRow[]> {
  const rows = await tx
    .select()
    .from(instanceFreezes)
    .where(
      freezeWindowCovers(
        instanceFreezes.startsAt,
        instanceFreezes.endsAt,
        instanceFreezes.liftedAt,
        at
      )
    );
  return rows as InstanceFreezeRow[];
}

/** Does this platform freeze cover a target at that stage. See docs/governance.md §246. */
export function instanceFreezeCovers(
  freeze: Pick<InstanceFreezeRow, "matchAllEnvironments" | "matchEnvironment" | "matchRegion">,
  coordinate: StageCoordinate | null
): boolean {
  if (freeze.matchAllEnvironments) return true;
  if (coordinate === null) return false;
  if (freeze.matchEnvironment !== coordinate.environment) return false;
  if (freeze.matchRegion === null) return true;
  return freeze.matchRegion === coordinate.region;
}

/** The whole live table, newest window first. See docs/governance.md §247. */
export async function listInstanceFreezes(tx: TenantTx): Promise<InstanceFreezeRow[]> {
  const rows = await tx
    .select()
    .from(instanceFreezes)
    .orderBy(sql`${instanceFreezes.startsAt} DESC`, instanceFreezes.key);
  return rows as InstanceFreezeRow[];
}
