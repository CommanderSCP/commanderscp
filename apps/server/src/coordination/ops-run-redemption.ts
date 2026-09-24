import {
  constants as cryptoConstants,
  createHash,
  publicEncrypt,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { TrustDomainId } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets, changes, objects, opsRunRedemptions } from "../db/schema.js";
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
import {
  OpsSealingKeyRefused,
  argoOpsPinForDomain,
  assertSealingKey,
  normalizeServerUrl,
  sourceAddressFrom
} from "./ops-argo-pin.js";
// Re-exported for callers that reached them here before the pin existed.
export { OpsSealingKeyRefused, assertSealingKey, sourceAddressFrom } from "./ops-argo-pin.js";

/**
 * HOST OPS THROUGH AN ORG'S ARGO WORKFLOWS — the credential half (M28.2, ADR-0054, charter
 * amendment 2026-09-23).
 *
 * In Mode C `managed-ops` stages a credential into a container SCP launched. Here the runner pod is
 * in a cluster SCP does not control and reaches only through an Argo API token, so the credential
 * cannot be staged — it has to be FETCHED, by the pod, once. Three things make that safe enough to
 * have been approved, and each is a mechanism rather than a comment:
 *
 *   1. THE TOKEN IS SEALED, TO A PINNED KEY, AND GOES ONLY TO A PINNED ENDPOINT. A Workflow's
 *      parameters are persisted in the Workflow object, the Argo UI, etcd and the archive, so the
 *      parameter carries the secret ENCRYPTED to the RSA key in the domain's Argo ops pin
 *      (`ops-argo-pin.ts`) — written only with `secret:write` at the org root, never binding config.
 *      Reading Workflows yields ciphertext; editing a binding cannot change the key or the server.
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

const TOKEN_PREFIX = "scpops1";

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
  /** What the BINDING says it will submit to. It must MATCH the domain's Argo ops pin — the
   *  sealing key and source addresses are read from the pin, never from here. */
  binding: { serverUrl: unknown; namespace: unknown; templateRef: string | null | undefined };
  masterKey: Buffer;
}

/** The Workflow parameters the Argo path adds. Neither is a secret: one is ciphertext, the other is
 *  a row id that is useless without the secret. */
export const ARGO_OPS_DELIVERY_KEYS = ["opsRunTokenSealed", "opsRunId"] as const;
// (The lane spells these as OPS_RUN_TOKEN_SEALED_PARAMETER / OPS_RUN_ID_PARAMETER, which is what the
// reserved-trigger-parameters census reads; ops-argo-pin.test.ts asserts the two agree.)

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
  // THE PIN (ADR-0054 D9). Where this token may go and what it is sealed to are the domain's,
  // written with `secret:write` at the org root — never the binding's, which `object:write` edits.
  // A binding that disagrees with the pin is refused rather than corrected: an operator who pointed
  // it elsewhere has a belief about where this run's certificate goes that must not survive.
  const pin = await argoOpsPinForDomain(tx, input.orgId, input.domainId);
  if (!pin) {
    throw new OpsSealingKeyRefused(
      `domain ${input.domainId} has no Argo host-ops pin. An Argo-bound host-reaching run is issued ` +
        "a certificate only for a trigger SCP submits to a PINNED Argo endpoint under a PINNED " +
        "sealing key; pin them first (`scp ssh-ca pin-argo-ops`, which needs secret:write at the " +
        "org root).",
      { inputContext: { gate: "ops_material", reason: "no_argo_ops_pin" } }
    );
  }
  const mismatched = [
    normalizeServerUrl(input.binding.serverUrl) !== pin.serverUrl ? "serverUrl" : null,
    input.binding.namespace !== pin.namespace ? "namespace" : null,
    input.binding.templateRef !== pin.templateRef ? "templateRef" : null
  ].filter((f): f is string => f !== null);
  if (mismatched.length > 0) {
    throw new OpsSealingKeyRefused(
      `this binding's ${mismatched.join(", ")} does not match domain ${input.domainId}'s Argo ` +
        "host-ops pin. A run token goes only to the pinned endpoint; a binding editor cannot move it.",
      { inputContext: { gate: "ops_material", reason: "binding_off_pin", mismatched } }
    );
  }
  const sealingPublicKeyPem = assertSealingKey(pin.sealingPublicKey);
  // MANDATORY on this path (owner ruling, #414 fix round): a certificate for a pod in a cluster SCP
  // does not control is always bounded to where that cluster's egress comes from.
  const sourceAddress = sourceAddressFrom(pin.sourceAddresses);
  if (!sourceAddress) {
    throw new OpsSealingKeyRefused(
      "the domain's Argo ops pin declares no source addresses. They are MANDATORY on the Argo " +
        "path: every certificate issued to a pod in a cluster SCP does not control carries the " +
        "cluster's egress addresses as its OpenSSH `source-address`.",
      { inputContext: { gate: "ops_material", reason: "source_addresses_absent" } }
    );
  }

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

/** The wave-target statuses during which a run's pod may legitimately be asking for its
 *  certificate: claimed, triggered, or being polled. Anything else — pending, a terminal outcome, a
 *  refusal — has no pod that should hold one. */
export const IN_FLIGHT_TARGET_STATUSES = ["triggering", "triggered", "observing"];

/** A fixed 32-byte comparand for the unknown-row path's equal-work compare. */
const UNKNOWN_ROW_HASH = Buffer.alloc(32);

/** `ssh-ed25519 <base64>` with any comment dropped — the identity of a key, for the reuse check. */
function canonicalPublicKey(openSsh: string): string {
  const [alg, b64] = openSsh.trim().split(/\s+/);
  return `${alg} ${b64}`;
}

export type RedemptionRefusal =
  | "malformed"
  | "unknown"
  | "bad_secret"
  | "burned"
  | "replayed"
  | "expired"
  | "change_not_executing"
  | "target_not_in_flight"
  | "superseded"
  | "key_reused"
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
    if (!row) {
      // EQUAL WORK to the wrong-secret path's compare, so the two 401s differ only by the row
      // update and audit append — and the route pads every 401 to a common floor over that.
      timingSafeEqual(Buffer.from(hashSecret(parsed.secret), "hex"), UNKNOWN_ROW_HASH);
      return { ok: false, refusal: "unknown", detail: "no such run" } as RedeemResult;
    }

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
      // A CEILING. Once burned, a wrong guess is neither counted nor audited: the run is already
      // dead, and auditing every further guess would let anyone who knows a run id (it is a
      // Workflow parameter) append without bound to the org's hash chain. The DoS that remains —
      // three guesses burn a run — is documented in ADR-0054: it kills one run, loudly, and the
      // change is re-proposed.
      if (row.burnedAt) {
        return { ok: false, refusal: "bad_secret", detail: "wrong secret" } as RedeemResult;
      }
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
    // THE WAVE TARGET MUST BE IN FLIGHT, AND THIS MUST BE ITS NEWEST TOKEN (probe B, #414). An
    // aborted, failed or already-finished target has no run that could legitimately need a
    // certificate; and a retried trigger mints a fresh row, which makes every older row for the same
    // target dead even inside its window.
    const [target] = await tx
      .select({ status: changeWaveTargets.status })
      .from(changeWaveTargets)
      .where(
        and(eq(changeWaveTargets.orgId, row.orgId), eq(changeWaveTargets.id, row.waveTargetId))
      )
      .limit(1);
    if (!target || !IN_FLIGHT_TARGET_STATUSES.includes(target.status)) {
      return refuse(
        "target_not_in_flight",
        `wave target ${row.waveTargetId} is ${target ? `'${target.status}'` : "gone"}, not in flight`
      );
    }
    const [newest] = await tx
      .select({ id: opsRunRedemptions.id })
      .from(opsRunRedemptions)
      .where(
        and(
          eq(opsRunRedemptions.orgId, row.orgId),
          eq(opsRunRedemptions.waveTargetId, row.waveTargetId)
        )
      )
      .orderBy(desc(opsRunRedemptions.createdAt), desc(opsRunRedemptions.id))
      .limit(1);
    if (newest?.id !== row.id) {
      return refuse("superseded", `a newer run token (${newest?.id}) exists for this wave target`);
    }
    // THE RUN MUST STILL BE WANTED. A change cancelled, rolled back or deleted after its Workflow
    // was submitted must not be able to buy a certificate in the minutes its token has left: the
    // operator who stopped it believes no host will be touched.
    const [change] = await tx
      .select({ state: changes.state, deletedAt: objects.deletedAt })
      .from(changes)
      .innerJoin(objects, and(eq(objects.orgId, changes.orgId), eq(objects.id, changes.objectId)))
      .where(and(eq(changes.orgId, row.orgId), eq(changes.objectId, row.changeObjectId)))
      .limit(1);
    if (!change || change.deletedAt || change.state !== "executing") {
      return refuse(
        "change_not_executing",
        `the change is ${change ? (change.deletedAt ? "deleted" : `'${change.state}'`) : "gone"}, not executing`
      );
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
    // ONE KEY, ONE RUN. A pod key already certified for another run is refused, so a single key
    // cannot accumulate certificates across runs; the unique index makes this true under a race.
    const podKey = canonicalPublicKey(input.publicKey);
    const [reused] = await tx
      .select({ id: opsRunRedemptions.id })
      .from(opsRunRedemptions)
      .where(
        and(
          eq(opsRunRedemptions.orgId, row.orgId),
          eq(opsRunRedemptions.certifiedPublicKey, podKey)
        )
      )
      .limit(1);
    if (reused) {
      return refuse("key_reused", `this public key was already certified for run ${reused.id}`);
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
      .set({ redeemedAt: sql`now()`, issuedSerial: issued.serial, certifiedPublicKey: podKey })
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
