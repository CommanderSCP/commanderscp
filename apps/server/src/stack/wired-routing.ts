import { sql } from "drizzle-orm";
import { StackWireableBackendSchema, type StackWireableBackend } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { conflict } from "../errors.js";
import { decryptSecretValue } from "../secrets/crypto.js";

/**
 * HOW A STANDARD STACK REGISTRATION IS ROUTED (M29.2, ADR-0060) — the read half of
 * `stack/wiring.ts`, kept free of route and operator-connection imports because the executor
 * resolver and the discovery door both call it from inside a tenant transaction.
 */

export type WireableBackend = StackWireableBackend;

export const WIREABLE_BACKENDS: readonly WireableBackend[] = StackWireableBackendSchema.options;

export function isWireableBackend(b: string): b is WireableBackend {
  return (WIREABLE_BACKENDS as readonly string[]).includes(b);
}

/** The backends SCP CALLS: each must hand over an endpoint, an account and a token. Argo Events
 *  is wired the other way round (its sensors would call SCP), so it registers with neither. */
export const CALLED_BACKENDS: readonly WireableBackend[] = ["argocd", "argo-workflows", "gitea"];

/** The plugin module (== `execution-system.properties.kind`) each backend registers as. */
export const REGISTRATION_KIND: Record<WireableBackend, string> = {
  argocd: "argocd",
  "argo-workflows": "argo-workflows",
  gitea: "gitea",
  "argo-events": "argo-events"
};

/** The key a stack-wired instance's token is handed to its plugin under — the plugin reads
 *  `ctx.secrets.get(config.tokenSecretKey)`. Scoped to the one instance's secrets map; it names no
 *  row in any secret store, so no tenant system can resolve it. */
export const STACK_TOKEN_SECRET_FIELD = "scp-stack-token";

export interface WiringRow extends Record<string, unknown> {
  backend: string;
  server_url: string | null;
  namespace: string | null;
  ca_pem: string | null;
  ca_sha256: string | null;
  account: string | null;
  facts_sha256: string;
  rotation_generation: number;
  wired_at: Date | string;
}

export interface Wiring {
  backend: WireableBackend;
  serverUrl: string | null;
  namespace: string | null;
  caPem: string | null;
  caSha256: string | null;
  account: string | null;
  factsSha256: string;
  rotationGeneration: number;
  wiredAt: string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

export function wiringOf(row: WiringRow): Wiring | null {
  if (!isWireableBackend(row.backend)) return null;
  return {
    backend: row.backend,
    serverUrl: row.server_url,
    namespace: row.namespace,
    caPem: row.ca_pem,
    caSha256: row.ca_sha256,
    account: row.account,
    factsSha256: row.facts_sha256,
    rotationGeneration: row.rotation_generation,
    wiredAt: iso(row.wired_at)
  };
}

export const SELECT_WIRINGS = `SELECT backend, server_url, namespace, ca_pem, ca_sha256, account, facts_sha256,
                               rotation_generation, wired_at FROM stack_backend_wirings`;

/** Every wiring, read inside a tenant transaction (`tenant_read` is `USING (true)`). */
export async function readWiringsAsTenant(tx: TenantTx): Promise<Wiring[]> {
  const rows = (await tx.execute(sql.raw(SELECT_WIRINGS))).rows as WiringRow[];
  return rows.flatMap((r) => wiringOf(r) ?? []);
}

/** Whether the stack serves this org — read inside that org's own tenant tx. */
export async function stackServesOrg(tx: TenantTx, orgId: string): Promise<boolean> {
  const res = await tx.execute(sql`SELECT 1 FROM stack_served_orgs WHERE org_id = ${orgId}`);
  return res.rows.length > 0;
}

/** The registration in this org for this system, if it is one — read in the org's tenant tx. */
export async function registrationOf(
  tx: TenantTx,
  orgId: string,
  objectId: string
): Promise<WireableBackend | null> {
  const res = await tx.execute(sql`
    SELECT backend FROM stack_backend_registrations
     WHERE org_id = ${orgId} AND object_id = ${objectId}`);
  const backend = (res.rows[0] as { backend?: string } | undefined)?.backend;
  return backend !== undefined && isWireableBackend(backend) ? backend : null;
}

// ---- routing a stack-registered system ----------------------------------------------------------

export interface StackWiredRouting {
  backend: WireableBackend;
  pluginModule: string;
  /** The wiring's facts, as plugin config: `serverUrl`, `namespace`, `tokenSecretKey`. */
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  allowedHosts: string[];
  allowInternalEgress: true;
  trustedCaPem?: string;
}

/**
 * THE ONE PLACE a stack-registered system's routing comes from. `null` when `objectId` is not a
 * registration (an ordinary, tenant-registered system: the caller routes it as before, ADR-0003's
 * two layers and all). For a registration, EVERYTHING that decides where work goes and with what
 * authority is the controller's hand-off: the endpoint, the token, the CA, and an internal-egress
 * allowance pinned to that endpoint's own host. The allowance needs no `SCP_INTERNAL_EGRESS_HOSTS`
 * entry — the controller's knowledge of the bundled endpoint IS the ceiling for it — and no other
 * system can obtain it, because only a registration row (operator-written, id allocated before the
 * object) makes a system one.
 */
export async function stackWiredRouting(
  tx: TenantTx,
  orgId: string,
  objectId: string,
  masterKey: Buffer
): Promise<StackWiredRouting | null> {
  const backend = await registrationOf(tx, orgId, objectId);
  if (!backend) return null;
  const unavailable = (why: string) => {
    const detail =
      `execution-system '${objectId}' is the Standard Stack's bundled ${backend}, and ${why}. ` +
      `An instance operator manages it on Admin › Stack (\`scp stack status\`).`;
    // A 409 at an HTTP door (discovery); the same sentence in the resolver's logs (observe,
    // reconcile), which print the message, not the problem's detail.
    const err = conflict(detail);
    err.message = detail;
    return err;
  };
  if (!(await stackServesOrg(tx, orgId))) {
    throw unavailable("the Standard Stack does not serve this organization");
  }
  const wiring = (await readWiringsAsTenant(tx)).find((w) => w.backend === backend);
  if (!wiring) throw unavailable("it is not wired (disabled, or not yet ready)");
  if (!wiring.serverUrl) throw unavailable("SCP does not call it — nothing can be bound to it");
  const tokenRes = await tx.execute(sql`
    SELECT ciphertext, nonce, key_version FROM stack_backend_tokens WHERE backend = ${backend}`);
  const tok = tokenRes.rows[0] as
    { ciphertext: string; nonce: string; key_version: number } | undefined;
  if (!tok) throw unavailable("its token has not been handed over");
  const token = decryptSecretValue(
    { ciphertext: tok.ciphertext, nonce: tok.nonce, keyVersion: tok.key_version },
    masterKey
  );
  return {
    backend,
    pluginModule: REGISTRATION_KIND[backend],
    config: {
      serverUrl: wiring.serverUrl,
      ...(wiring.namespace ? { namespace: wiring.namespace } : {}),
      tokenSecretKey: STACK_TOKEN_SECRET_FIELD
    },
    secrets: { [STACK_TOKEN_SECRET_FIELD]: token },
    allowedHosts: [new URL(wiring.serverUrl).hostname],
    allowInternalEgress: true,
    ...(wiring.caPem ? { trustedCaPem: wiring.caPem } : {})
  };
}
