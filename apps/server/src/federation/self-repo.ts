import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationSelf } from "../db/schema.js";

/**
 * This org's own federation domain identity (DESIGN.md §13: "every domain instance... a Domain
 * Control Plane"). SCOPING DECISION (db/schema.ts's module doc): kept org-scoped, not
 * instance-wide, so it rides the same RLS boundary as everything the journal carries.
 *
 * Created LAZILY with `role: 'unset'` the first time anything needs it — DESIGN §4.1 "every row is
 * born federation-ready" means `objects.originDomainId` needs a real domain id from the very first
 * object an org ever creates, well before an operator has necessarily run
 * `scp federation init --role parent|child`. `role` only changes via an explicit
 * `initFederationSelf` call (never inferred), so a domain silently defaults to neither parent nor
 * child — federation stays fully opt-in per DESIGN §13 ("federation enhances operation, it is
 * never required for it").
 */
export interface FederationSelf {
  orgId: string;
  domainId: string;
  name: string;
  role: "unset" | "parent" | "child";
}

function toFederationSelf(row: typeof federationSelf.$inferSelect): FederationSelf {
  return {
    orgId: row.orgId,
    domainId: row.domainId,
    name: row.name,
    role: row.role as FederationSelf["role"]
  };
}

/** Race-safe like `governance/attestation.ts`'s `ensureInstanceKey`: a duplicate-insert on
 *  concurrent first-use callers is resolved by re-reading rather than erroring. */
export async function ensureFederationSelf(tx: TenantTx, orgId: string): Promise<FederationSelf> {
  const existing = await tx
    .select()
    .from(federationSelf)
    .where(eq(federationSelf.orgId, orgId))
    .limit(1);
  if (existing[0]) return toFederationSelf(existing[0]);

  const domainId = uuidv7();
  try {
    const [row] = await tx
      .insert(federationSelf)
      .values({ orgId, domainId, name: orgId, role: "unset" })
      .returning();
    if (row) return toFederationSelf(row);
  } catch {
    // Lost a race with a concurrent first-use caller — fall through to re-read.
  }
  const afterRace = await tx
    .select()
    .from(federationSelf)
    .where(eq(federationSelf.orgId, orgId))
    .limit(1);
  if (!afterRace[0])
    throw new Error(`ensureFederationSelf: failed to create or read identity for org '${orgId}'`);
  return toFederationSelf(afterRace[0]);
}

export interface InitFederationInput {
  orgId: string;
  name: string;
  role: "parent" | "child";
}

/** `scp federation init` — explicitly designates this domain's role and (optionally) renames it.
 *  Idempotent: safe to call again to rename, but changing `role` after peers are already paired
 *  is allowed (the operator's responsibility) since role is advisory metadata for the CLI/UI, not
 *  itself an authority check — single-writer authority is enforced by `originDomainId` alone,
 *  independent of `role`. */
export async function initFederationSelf(
  tx: TenantTx,
  input: InitFederationInput
): Promise<FederationSelf> {
  await ensureFederationSelf(tx, input.orgId);
  const [row] = await tx
    .update(federationSelf)
    .set({ name: input.name, role: input.role })
    .where(eq(federationSelf.orgId, input.orgId))
    .returning();
  if (!row)
    throw new Error(`initFederationSelf: failed to update identity for org '${input.orgId}'`);
  return toFederationSelf(row);
}
