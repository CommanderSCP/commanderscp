import { createPublicKey, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { sshCaArgoOpsPins } from "../db/schema.js";
import { OpsMaterialRefusal } from "./trigger-parameter-refusal.js";

/**
 * THE ARGO HOST-OPS PIN (M28.2, ADR-0054 D9) — where a domain's CA may send a run token, and what
 * it is sealed to.
 *
 * Adversarial verification of #414 found the charter grant unenforced: `serverUrl`, the sealing key
 * and the template ref were ordinary binding config under `object:write`, so an Operator scoped to
 * one product repointed its binding at an Argo server and sealing key of their own, waited for a
 * legitimate change, unsealed the token and redeemed a `root` certificate. The owner's ruling
 * ("honest wording + pin"): SCP mints only for triggers it submits to a PINNED endpoint under a
 * PINNED sealing key for its own catalog template ref — and a binding editor cannot move the pin.
 * The pin is written with `secret:write` at the org root, the permission that already guards
 * minting the CA itself, and read here; nothing on the Argo path takes these from binding config.
 */

/** The SCP ops catalog templates (`scp-ops-v1` …). Duplicated in the argo-workflows plugin's own
 *  check, and asserted equal by `ops-argo-pin.test.ts`. */
export const OPS_ARGO_CATALOG_TEMPLATES = ["scp-ops-v1"] as const;

export class ArgoOpsPinInvalid extends Error {}

export interface ArgoOpsPin {
  domainId: TrustDomainId;
  serverUrl: string;
  namespace: string;
  templateRef: string;
  sealingPublicKey: string;
  sourceAddresses: string[];
  runnerImageDigest: string;
  redeemUrl: string;
  updatedAt: Date;
}

export interface ArgoOpsPinInput {
  serverUrl: string;
  namespace: string;
  templateRef: string;
  sealingPublicKey: string;
  sourceAddresses: string[];
  runnerImageDigest: string;
  redeemUrl: string;
}

/** One spelling of a server URL, so a pin comparison cannot be defeated by a trailing slash or
 *  host-name case. Scheme, host, port AND path: an Argo server (or SCP's API) served under a path
 *  prefix behind a reverse proxy IS a different endpoint from its sibling, so the path is kept.
 *  Duplicated as `normalizeOpsUrl` in the argo-workflows plugin and asserted equal by a test. */
export function normalizeServerUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** Validates a pin at WRITE time, so an unusable pin is a 400 at the door rather than a refused
 *  run later. The sealing-key rule is the same function the Argo lane refuses with. */
export function validateArgoOpsPin(input: ArgoOpsPinInput): ArgoOpsPinInput {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  if (!serverUrl) throw new ArgoOpsPinInvalid("serverUrl must be an http(s) URL");
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(input.namespace)) {
    throw new ArgoOpsPinInvalid("namespace must be a Kubernetes namespace name");
  }
  if (!(OPS_ARGO_CATALOG_TEMPLATES as readonly string[]).includes(input.templateRef)) {
    throw new ArgoOpsPinInvalid(
      `templateRef must be one of SCP's host-ops catalog templates: ${OPS_ARGO_CATALOG_TEMPLATES.join(", ")}`
    );
  }
  try {
    assertSealingKey(input.sealingPublicKey);
  } catch (err) {
    throw new ArgoOpsPinInvalid((err as Error).message);
  }
  let source: string | null;
  try {
    source = sourceAddressFrom(input.sourceAddresses);
  } catch (err) {
    throw new ArgoOpsPinInvalid((err as Error).message);
  }
  if (!source) throw new ArgoOpsPinInvalid("sourceAddresses is REQUIRED and must be non-empty");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.runnerImageDigest)) {
    throw new ArgoOpsPinInvalid("runnerImageDigest must be `sha256:<64 hex>`");
  }
  const redeemUrl = normalizeServerUrl(input.redeemUrl);
  if (!redeemUrl) throw new ArgoOpsPinInvalid("redeemUrl must be an http(s) URL");
  return { ...input, serverUrl, redeemUrl };
}

export async function putArgoOpsPin(
  tx: TenantTx,
  input: ArgoOpsPinInput & { orgId: string; domainId: TrustDomainId; recordedBySubjectId: string }
): Promise<void> {
  const v = validateArgoOpsPin(input);
  await tx
    .insert(sshCaArgoOpsPins)
    .values({
      id: randomUUID(),
      orgId: input.orgId,
      domainId: input.domainId,
      serverUrl: v.serverUrl,
      namespace: v.namespace,
      templateRef: v.templateRef,
      sealingPublicKey: v.sealingPublicKey,
      sourceAddresses: v.sourceAddresses,
      runnerImageDigest: v.runnerImageDigest,
      redeemUrl: v.redeemUrl,
      recordedBySubjectId: input.recordedBySubjectId
    })
    .onConflictDoUpdate({
      target: [sshCaArgoOpsPins.orgId, sshCaArgoOpsPins.domainId],
      set: {
        serverUrl: v.serverUrl,
        namespace: v.namespace,
        templateRef: v.templateRef,
        sealingPublicKey: v.sealingPublicKey,
        sourceAddresses: v.sourceAddresses,
        runnerImageDigest: v.runnerImageDigest,
        redeemUrl: v.redeemUrl,
        recordedBySubjectId: input.recordedBySubjectId,
        updatedAt: sql`now()`
      }
    });
}

/** Every pin in the org, in a STABLE order — the argo-workflows plugin's own view of where it may
 *  submit an ops template. Org-wide rather than per-target, because a plugin instance is shared by
 *  every binding that names its id: a per-target value would make one instance's config depend on
 *  which target started it, and the host would restart it on every alternation. */
export async function argoOpsPinsForOrg(
  tx: TenantTx,
  orgId: string
): Promise<
  {
    serverUrl: string;
    namespace: string;
    templateRef: string;
    runnerImageDigest: string;
    redeemUrl: string;
  }[]
> {
  const rows = await tx
    .select({
      serverUrl: sshCaArgoOpsPins.serverUrl,
      namespace: sshCaArgoOpsPins.namespace,
      templateRef: sshCaArgoOpsPins.templateRef,
      runnerImageDigest: sshCaArgoOpsPins.runnerImageDigest,
      redeemUrl: sshCaArgoOpsPins.redeemUrl
    })
    .from(sshCaArgoOpsPins)
    .where(eq(sshCaArgoOpsPins.orgId, orgId))
    .orderBy(sshCaArgoOpsPins.domainId);
  return rows;
}

export async function argoOpsPinForDomain(
  tx: TenantTx,
  orgId: string,
  domainId: TrustDomainId
): Promise<ArgoOpsPin | undefined> {
  const [row] = await tx
    .select()
    .from(sshCaArgoOpsPins)
    .where(and(eq(sshCaArgoOpsPins.orgId, orgId), eq(sshCaArgoOpsPins.domainId, domainId)))
    .limit(1);
  if (!row) return undefined;
  return {
    domainId: row.domainId,
    serverUrl: row.serverUrl,
    namespace: row.namespace,
    templateRef: row.templateRef,
    sealingPublicKey: row.sealingPublicKey,
    sourceAddresses: (row.sourceAddresses as string[]) ?? [],
    runnerImageDigest: row.runnerImageDigest,
    redeemUrl: row.redeemUrl,
    updatedAt: row.updatedAt
  };
}

/** The smallest RSA modulus a sealing key may have. 3072 is NIST's 128-bit equivalent. */
export const OPS_SEALING_MIN_RSA_BITS = 3072;

/** Terminal with a Decision (a `TriggerParameterRefusal`), because the fix is a person re-pinning. */
export class OpsSealingKeyRefused extends OpsMaterialRefusal {}

/** Refuse a sealing key that cannot carry the token safely, BEFORE a redemption row is written.
 *  Absent is refused too: without it the only way to deliver the token would be in the clear. */
export function assertSealingKey(pem: unknown): string {
  if (typeof pem !== "string" || pem.trim().length === 0) {
    throw new OpsSealingKeyRefused(
      "no sealing public key. Without one the run token would sit in the Workflow's parameters " +
        "in the clear — readable by anyone who can read Workflows — so the run is refused. Pin the " +
        "public half of the key whose private half is the `scp-ops-v1` sealing Secret.",
      { inputContext: { gate: "ops_material", reason: "sealing_key_absent" } }
    );
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new OpsSealingKeyRefused("the sealing public key is not a readable PEM public key", {
      inputContext: { gate: "ops_material", reason: "sealing_key_unreadable" }
    });
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < OPS_SEALING_MIN_RSA_BITS) {
    throw new OpsSealingKeyRefused(
      `the sealing public key must be an RSA key of at least ${OPS_SEALING_MIN_RSA_BITS} bits ` +
        `(got ${key.asymmetricKeyType ?? "unknown"}${bits ? ` ${bits}` : ""}).`,
      { inputContext: { gate: "ops_material", reason: "sealing_key_weak" } }
    );
  }
  return pem;
}

/** Validates the pin's source addresses: an array of CIDRs/addresses, joined the way
 *  OpenSSH's `source-address` critical option expects. */
export function sourceAddressFrom(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new OpsSealingKeyRefused(
      "source addresses must be a non-empty array of addresses/CIDRs",
      { inputContext: { gate: "ops_material", reason: "source_addresses_invalid" } }
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string" || !/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(entry)) {
      throw new OpsSealingKeyRefused(
        `source address ${JSON.stringify(entry)} is not an address or CIDR`,
        { inputContext: { gate: "ops_material", reason: "source_addresses_invalid" } }
      );
    }
  }
  return (value as string[]).join(",");
}
