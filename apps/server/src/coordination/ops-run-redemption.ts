import {
  constants as cryptoConstants,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { TrustDomainId } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { opsRunRedemptions } from "../db/schema.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import {
  OpsMaterialUnavailable,
  RUN_CERTIFICATE_TTL_SECONDS,
  deriveOpsBound,
  opsKeyId,
  type OpsRunBound
} from "./ops-run-material.js";
import { ScpCaAuthority } from "./scp-ca-authority.js";
import { activeAuthorityForDomain, recordIssuance } from "./ssh-ca-repo.js";
import { getSecretValue } from "../secrets/secrets-repo.js";

/**
 * HOST OPS THROUGH AN ORG'S ARGO WORKFLOWS — the credential half (M28.2, ADR-0054, charter
 * amendment 2026-09-23).
 *
 * In Mode C `managed-ops` stages a credential into a container SCP launched. Here the runner pod is
 * in a cluster SCP does not control and reaches only through an Argo API token, so the credential
 * cannot be staged — it has to be FETCHED, by the pod, once. Three things make that safe enough to
 * have been approved, and each is a mechanism rather than a comment:
 *
 *   1. THE TOKEN IS SEALED. A Workflow's parameters are persisted in the Workflow object, shown in
 *      the Argo UI, stored in etcd and its backups and in the workflow archive. So the parameter
 *      carries the single-use secret ENCRYPTED to an RSA key the operator registered on the binding;
 *      the private half is a namespace Secret mounted only into the `scp-ops-v1` pod. Reading
 *      Workflows yields ciphertext.
 *   2. THE REDEMPTION IS NARROW. Single-use, a window no longer than the certificate's own TTL, bound
 *      to one wave target of one change, and it yields only the bound reconcile derived for that
 *      run — the request carries a secret and a public key, nothing that could name a host.
 *   3. THE PRIVATE KEY NEVER EXISTS IN SCP. The pod generates its own keypair and SCP certifies the
 *      public half, so there is no per-run private key in `scpd`, the database or the wire.
 *
 * What stays exposed is written down in ADR-0054 rather than here: the certificate is not
 * host-bound, and anyone who can read the sealing Secret — which includes anyone who can create a
 * pod in that namespace — can unseal a token in flight.
 */

/** The redemption window. Equal to the certificate's TTL, never longer: a token that outlived the
 *  certificate it buys would be a longer-lived secret than the credential, which inverts the point. */
export const OPS_REDEMPTION_WINDOW_SECONDS = RUN_CERTIFICATE_TTL_SECONDS;

/** Wrong-secret presentations a row tolerates before it is BURNED. Low on purpose: the legitimate
 *  pod presents the right secret first time, so any wrong one is either a bug or a guess. */
export const OPS_REDEMPTION_MAX_FAILED_ATTEMPTS = 3;

/** The smallest RSA modulus a sealing key may have. 3072 is NIST's 128-bit equivalent. */
export const OPS_SEALING_MIN_RSA_BITS = 3072;

const TOKEN_PREFIX = "scpops1";

export class OpsSealingKeyRefused extends Error {}

/** Refuse a sealing key that cannot carry the token safely, BEFORE a redemption row is written.
 *  Absent is refused too: without it the only way to deliver the token would be in the clear. */
export function assertSealingKey(pem: unknown): string {
  if (typeof pem !== "string" || pem.trim().length === 0) {
    throw new OpsSealingKeyRefused(
      "this argo-workflows binding runs the host-ops catalog template but declares no " +
        "`opsSealingPublicKey`. Without one the run token would sit in the Workflow's parameters in " +
        "the clear — readable by anyone who can read Workflows — so the run is refused. Register the " +
        "public half of the key whose private half is the `scp-ops-v1` sealing Secret."
    );
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new OpsSealingKeyRefused("`opsSealingPublicKey` is not a readable PEM public key");
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < OPS_SEALING_MIN_RSA_BITS) {
    throw new OpsSealingKeyRefused(
      `\`opsSealingPublicKey\` must be an RSA key of at least ${OPS_SEALING_MIN_RSA_BITS} bits ` +
        `(got ${key.asymmetricKeyType ?? "unknown"}${bits ? ` ${bits}` : ""}).`
    );
  }
  return pem;
}

/** RSA-OAEP(SHA-256) — chosen because both ends have it without a new dependency: node:crypto here
 *  and `cryptography` (already an ansible-core dependency) in the runner. */
export function sealToken(token: string, sealingPublicKeyPem: string): string {
  return publicEncrypt(
    {
      key: sealingPublicKeyPem,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    Buffer.from(token, "utf8")
  ).toString("base64");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

interface ParsedToken {
  orgId: string;
  redemptionId: string;
  secret: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `scpops1.<orgId>.<redemptionId>.<secret>`. The org and row ids are in the token so the redeem
 *  door can open a TENANT transaction and look the row up by primary key — never a cross-org search
 *  by secret. */
export function parseRunToken(token: string): ParsedToken | undefined {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return undefined;
  const [, orgId, redemptionId, secret] = parts as [string, string, string, string];
  if (!UUID_RE.test(orgId) || !UUID_RE.test(redemptionId)) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return undefined;
  return { orgId, redemptionId, secret };
}

/** A strict check of the pod's public key, so a malformed one is a 400 rather than a RangeError
 *  inside the certificate encoder. Exactly `string("ssh-ed25519") || string(32 bytes)`. */
export function isEd25519PublicKey(openSsh: string): boolean {
  const [alg, b64] = openSsh.trim().split(/\s+/);
  if (alg !== "ssh-ed25519" || !b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return false;
  const blob = Buffer.from(b64, "base64");
  if (blob.length !== 4 + 11 + 4 + 32) return false;
  return (
    blob.readUInt32BE(0) === 11 &&
    blob.subarray(4, 15).toString() === "ssh-ed25519" &&
    blob.readUInt32BE(15) === 32
  );
}

export interface CreateOpsRunRedemptionInput {
  orgId: string;
  domainId: TrustDomainId;
  productObjectId: string;
  role: string;
  roleArguments: Record<string, unknown>;
  changeObjectId: string;
  waveTargetId: string;
  sealingPublicKeyPem: unknown;
  /** The binding's declared egress CIDRs, as the OpenSSH `source-address` list. Optional. */
  sourceAddresses?: unknown;
  masterKey: Buffer;
}

/** The Workflow parameters the Argo path adds. Neither is a secret: one is ciphertext, the other is
 *  a row id that is useless without the secret. */
export const ARGO_OPS_DELIVERY_KEYS = ["opsRunTokenSealed", "opsRunId"] as const;

/** Validates the binding's `opsSourceAddresses`: an array of CIDRs/addresses, joined the way
 *  OpenSSH's `source-address` critical option expects. */
export function sourceAddressFrom(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new OpsSealingKeyRefused(
      "`opsSourceAddresses` must be a non-empty array of addresses/CIDRs when set"
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string" || !/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(entry)) {
      throw new OpsSealingKeyRefused(
        `\`opsSourceAddresses\` entry ${JSON.stringify(entry)} is not an address or CIDR`
      );
    }
  }
  return (value as string[]).join(",");
}

/**
 * RECONCILE-TIME, in the trigger's transaction: derive the bound (the SAME `deriveOpsBound` Mode C
 * uses), store it with the hash of a fresh single-use secret, and return the sealed token.
 *
 * Nothing is issued here. The certificate is minted at redemption, over the pod's key, which is why
 * `ssh_certificate_issuances` gets its row then and not now.
 */
export async function createOpsRunRedemption(
  tx: TenantTx,
  input: CreateOpsRunRedemptionInput
): Promise<{ opsRunTokenSealed: string; opsRunId: string; bound: OpsRunBound }> {
  // Refusals in the SAME order as Mode C, then the two only this path has.
  const { bound, authorityId } = await deriveOpsBound(tx, {
    orgId: input.orgId,
    domainId: input.domainId,
    productObjectId: input.productObjectId,
    role: input.role,
    masterKey: input.masterKey
  });
  const sealingPublicKeyPem = assertSealingKey(input.sealingPublicKeyPem);
  const sourceAddress = sourceAddressFrom(input.sourceAddresses);

  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await tx.insert(opsRunRedemptions).values({
    id,
    orgId: input.orgId,
    changeObjectId: input.changeObjectId,
    waveTargetId: input.waveTargetId,
    domainId: input.domainId,
    authorityId,
    role: bound.opsRole,
    inventory: bound.opsInventory,
    egressAllowlist: bound.opsEgressAllowlist,
    principals: bound.opsPrincipals,
    roleArguments: input.roleArguments,
    sourceAddress,
    secretHash: hashSecret(secret),
    expiresAt: new Date(Date.now() + OPS_REDEMPTION_WINDOW_SECONDS * 1000)
  });

  const token = `${TOKEN_PREFIX}.${input.orgId}.${id}.${secret}`;
  return { opsRunTokenSealed: sealToken(token, sealingPublicKeyPem), opsRunId: id, bound };
}

export type RedemptionRefusal =
  | "malformed"
  | "unknown"
  | "bad_secret"
  | "burned"
  | "replayed"
  | "expired"
  | "authority_changed";

export interface RedeemedMaterial extends OpsRunBound {
  runId: string;
  roleArguments: Record<string, unknown>;
  certificate: string;
  serial: string;
  keyId: string;
  expiresAt: Date;
  sourceAddress: string | null;
}

export type RedeemResult =
  | { ok: true; material: RedeemedMaterial }
  | { ok: false; refusal: RedemptionRefusal; detail: string };

export interface RedeemOpsRunInput {
  token: string;
  publicKey: string;
  masterKey: Buffer;
  requestId: string;
  /** The caller's address as the server saw it — recorded in the audit event, never trusted. */
  remoteAddress?: string;
}

/**
 * THE REDEEM DOOR. Returns a result rather than throwing, so a REFUSAL's side effects — the failed
 * attempt counter, a burn, the audit event — COMMIT. A thrown refusal would roll back the very
 * record that makes a stolen-token race visible.
 */
export async function redeemOpsRun(db: Db, input: RedeemOpsRunInput): Promise<RedeemResult> {
  const parsed = parseRunToken(input.token);
  // Unattributable attempts write no audit event: an org id in a forged token is attacker-chosen,
  // and letting it append to that org's chain would let anyone spam any org's audit log. They are
  // rate-limited at the route instead.
  if (!parsed) return { ok: false, refusal: "malformed", detail: "the run token is malformed" };

  return withTenantTx(db, parsed.orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(opsRunRedemptions)
      .where(
        and(
          eq(opsRunRedemptions.orgId, parsed.orgId),
          eq(opsRunRedemptions.id, parsed.redemptionId)
        )
      )
      .for("update")
      .limit(1);
    if (!row) return { ok: false, refusal: "unknown", detail: "no such run" } as RedeemResult;

    const refuse = async (refusal: RedemptionRefusal, detail: string): Promise<RedeemResult> => {
      await appendAuditEvent(tx, {
        orgId: parsed.orgId,
        actorId: SYSTEM_ACTOR_ID,
        action: "ops.run_redemption.refused",
        subjectId: row.changeObjectId,
        reason:
          `refused redemption of host-ops run ${row.id} (wave target ${row.waveTargetId}): ` +
          `${refusal} — ${detail}` +
          (input.remoteAddress ? ` [from ${input.remoteAddress}]` : ""),
        requestId: input.requestId
      });
      return { ok: false, refusal, detail };
    };

    // The secret FIRST, before any state is disclosed: a caller without it learns nothing about
    // whether the run was redeemed, expired or burned.
    const presented = Buffer.from(hashSecret(parsed.secret), "hex");
    const expected = Buffer.from(row.secretHash, "hex");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      const attempts = row.failedAttempts + 1;
      const burn = attempts >= OPS_REDEMPTION_MAX_FAILED_ATTEMPTS && !row.burnedAt;
      await tx
        .update(opsRunRedemptions)
        .set({
          failedAttempts: attempts,
          ...(burn ? { burnedAt: sql`now()` } : {})
        })
        .where(and(eq(opsRunRedemptions.orgId, row.orgId), eq(opsRunRedemptions.id, row.id)));
      return refuse(
        "bad_secret",
        `wrong secret (attempt ${attempts}/${OPS_REDEMPTION_MAX_FAILED_ATTEMPTS}${burn ? ", run BURNED" : ""})`
      );
    }
    if (row.burnedAt) return refuse("burned", "this run was burned after repeated wrong secrets");
    if (row.redeemedAt) {
      // THE STOLEN-TOKEN SIGNAL. The legitimate pod presents its token once; a second presentation
      // of the RIGHT secret means two parties held it. Refused, audited, and — because the first
      // redemption's serial is on the row — attributable to the certificate that was issued.
      return refuse(
        "replayed",
        `already redeemed at ${row.redeemedAt.toISOString()} (serial ${row.issuedSerial})`
      );
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return refuse("expired", `the redemption window closed at ${row.expiresAt.toISOString()}`);
    }
    const authorityRow = await activeAuthorityForDomain(tx, row.orgId, row.domainId);
    if (!authorityRow || authorityRow.id !== row.authorityId) {
      return refuse(
        "authority_changed",
        "the domain's active CA is not the one this run was derived against"
      );
    }
    if (!isEd25519PublicKey(input.publicKey)) {
      return refuse("malformed", "publicKey must be an `ssh-ed25519` OpenSSH public key");
    }
    const caPrivateKeyPem = await getSecretValue(
      tx,
      row.orgId,
      authorityRow.privateKeySecretKey,
      input.masterKey
    );
    if (!caPrivateKeyPem) {
      throw new OpsMaterialUnavailable(
        `the CA for domain ${row.domainId} names a secret that does not resolve`
      );
    }

    const authority = new ScpCaAuthority({
      domainId: row.domainId,
      authorityId: authorityRow.id,
      caPrivateKeyPem,
      ...(row.sourceAddress ? { sourceAddress: row.sourceAddress } : {})
    });
    const principals = row.principals as string[];
    const egressAllowlist = row.egressAllowlist as string[];
    const issued = await authority.issue({
      openSshPublicKey: input.publicKey.trim(),
      principals,
      // The run id rides in the key id too, so a host's own auth log names the redemption.
      keyId: `${opsKeyId(row.changeObjectId)}:run=${row.id}`,
      validForSeconds: RUN_CERTIFICATE_TTL_SECONDS,
      targetHosts: egressAllowlist
    });
    const keyId = issued.keyId ?? opsKeyId(row.changeObjectId);

    // ISSUANCE, REDEMPTION AND AUDIT IN ONE TRANSACTION (ADR-0051 D5): a certificate with no
    // issuance row would read as a forgery, and a redemption with no serial could not be joined.
    await recordIssuance(tx, {
      orgId: row.orgId,
      authorityId: authorityRow.id,
      authorityName: issued.authority,
      serial: issued.serial,
      keyId,
      principals,
      targetHosts: egressAllowlist,
      expiresAt: issued.expiresAt,
      sourceAddress: row.sourceAddress
    });
    await tx
      .update(opsRunRedemptions)
      .set({ redeemedAt: sql`now()`, issuedSerial: issued.serial })
      .where(and(eq(opsRunRedemptions.orgId, row.orgId), eq(opsRunRedemptions.id, row.id)));
    await appendAuditEvent(tx, {
      orgId: row.orgId,
      actorId: SYSTEM_ACTOR_ID,
      action: "ops.run_redemption.redeemed",
      subjectId: row.changeObjectId,
      reason:
        `host-ops run ${row.id} (wave target ${row.waveTargetId}) redeemed: certificate serial ` +
        `${issued.serial} for ${principals.join(",")} over ${egressAllowlist.length} host(s)` +
        (row.sourceAddress ? `, source-address ${row.sourceAddress}` : ", no source-address") +
        (input.remoteAddress ? ` [from ${input.remoteAddress}]` : ""),
      requestId: input.requestId
    });

    return {
      ok: true,
      material: {
        runId: row.id,
        opsRole: row.role,
        opsInventory: row.inventory,
        opsEgressAllowlist: egressAllowlist,
        opsPrincipals: principals,
        roleArguments: (row.roleArguments as Record<string, unknown>) ?? {},
        certificate: issued.certificate,
        serial: issued.serial,
        keyId,
        expiresAt: issued.expiresAt,
        sourceAddress: row.sourceAddress
      }
    } as RedeemResult;
  });
}
