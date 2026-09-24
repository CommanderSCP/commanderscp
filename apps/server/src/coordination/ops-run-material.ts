import { randomUUID } from "node:crypto";
import type { TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { getSecretValue, putSecret } from "../secrets/secrets-repo.js";
import { readMembers } from "./infrastructure-members-repo.js";
import { compileInventory, egressAllowlistFor } from "./ops-inventory.js";
import { ScpCaAuthority } from "./scp-ca-authority.js";
import { activeAuthorityForDomain, enrolmentForDomain, recordIssuance } from "./ssh-ca-repo.js";
import { OpsMaterialRefusal } from "./trigger-parameter-refusal.js";

/**
 * THE SEAM (M27.9): everything a host-reaching run needs, derived from resolved graph state.
 *
 * M27 built both sides of this boundary and never the boundary. The plugin refuses a trigger whose
 * material is incomplete, and that refusal is mutation-proved; the inventory compiler and the
 * egress allowlist are proved; the CA, the certificate signer and the issuance record are proved.
 * None of it required anything to PRODUCE the material, so every gate stayed green while no
 * host-reaching run could execute at all. This function is what was missing.
 *
 * EVERY VALUE HERE IS DERIVED, NEVER AUTHORED (ADR-0052). That is the whole reason it lives on the
 * server rather than in a recipe: the inventory comes from observed membership, the allowlist from
 * the same membership, the principals from the enrolment, and the credential is minted per run.
 *
 * TWO EXECUTORS, ONE DERIVATION (M28.2, ADR-0054). `deriveOpsBound` is the part both share — every
 * refusal and every value that bounds the run. `deriveOpsRunMaterial` adds Mode C's credential
 * (a keypair minted here, staged by `managed-ops` into a container SCP launches);
 * `ops-run-redemption.ts` adds the Argo path's (a certificate over a key the pod generates, issued
 * when the pod redeems a one-time token). Neither re-derives the bound.
 */

/** The per-run TTL. Minutes, not hours — this bounds a LEAKED CERTIFICATE. It does NOT bound CA
 *  compromise, which `sshd` cannot help with because the validity interval lives inside the
 *  certificate an attacker holding the key would mint (ADR-0051's blast-radius analysis). Shared by
 *  both executors, so the Argo path's certificate is never looser than Mode C's. */
export const RUN_CERTIFICATE_TTL_SECONDS = 600;

/**
 * The login the certificate authorizes. A literal: a configurable principal would be a second place
 * for "who may change this host" to be decided.
 *
 * `root`, and NOT a `scp-ops` account escalating through sudo (owner decision 2026-09-23, amending
 * ADR-0051 D4). The sudo design did not survive contact with the runner: Ansible's `become` does
 * not invoke the catalog's commands, it invokes
 *
 *     sudo -H -S -n -u root /bin/sh -c 'echo BECOME-SUCCESS-... ; /usr/bin/python3 .../AnsiballZ_*.py'
 *
 * so a sudoers fragment naming `apt-get`/`dnf`/`systemctl` grants nothing Ansible ever calls, and
 * the rule that WOULD work grants `/bin/sh` — with the module path under the connecting account's
 * own writable `~/.ansible/tmp`, which that account can therefore rewrite before root runs it.
 * Sudo-to-a-shell IS root; the restricted-sudoers design was a control in name only.
 *
 * So the privilege is named honestly instead of laundered. What actually bounds a run is unchanged
 * and is written down elsewhere: the signed, closed task catalog (M27.3), the modules DELETED from
 * the image so no escape hatch exists to reach (M27.1, ADR-0050), tenant parameters that can never
 * be evaluated as Jinja2 (M27.2), a minutes-TTL per-run certificate, and the positive egress
 * allowlist that bounds which hosts a run can reach at all (M27.6b).
 */
export const OPS_PRINCIPAL = "root";

export interface DeriveOpsRunMaterialInput {
  orgId: string;
  /** The trust domain whose CA mints this run's certificate — never fleet-wide (ADR-0051 D2). */
  domainId: TrustDomainId;
  /** The infrastructure product whose OBSERVED membership is the inventory (D25(a)). */
  productObjectId: string;
  /** The catalog role to invoke. Resolved from the lane, never from a recipe. */
  role: string;
  /** The CHANGE this run serves. It rides in the certificate's key id, which is the one field
   *  `sshd` writes to the host's own auth log on every authentication — so a login on the host can
   *  be attributed to a specific change without consulting SCP. ADR-0051 D5's reconciliation is
   *  otherwise comparing bare serials. */
  subjectObjectId: string;
  masterKey: Buffer;
}

/** TERMINAL, with a Decision and an audit event (M28.2 fix round). It used to be a bare Error, which
 *  reconcile's per-target catch logged and retried every tick with no Decision — a verdict visible
 *  only in a log line. None of its causes is transient: each needs a person (enrol the domain,
 *  restore the CA key, pin the endpoint), after which the change is re-proposed. */
export class OpsMaterialUnavailable extends OpsMaterialRefusal {}

/** The closed set of reasons, so the Decision carries a cause and never an address or a key. */
export function opsMaterialContext(reason: string): Record<string, unknown> {
  return { gate: "ops_material", reason };
}

/** The key id REQUESTED of the authority. `sshd` logs this string on every authentication, so it
 *  is the only place a host's own records can name the change that reached it. The authority appends
 *  the serial and reports the result, so this is a prefix rather than the final value — which is why
 *  the issuance row records `issued.keyId` and not a second call to this. */
export function opsKeyId(subjectObjectId: string): string {
  return `scp-ops:${OPS_PRINCIPAL}:${subjectObjectId}`;
}

/**
 * THE BOUND — the four keys that decide what a host-reaching run touches, and the only part of the
 * material that is identical whichever executor runs it.
 */
export interface OpsRunBound {
  opsRole: string;
  opsInventory: string;
  opsEgressAllowlist: string[];
  opsPrincipals: string[];
}

export interface DerivedOpsBound {
  bound: OpsRunBound;
  /** The ACTIVE CA the bound was derived against. */
  authorityId: string;
  /** Its signing key, resolved from the encrypted store. Never returned past the caller. */
  caPrivateKeyPem: string;
}

/**
 * Enrolment, the active CA, the CA key and the bound — what both executors share. Every refusal
 * lives here, so "an unenrolled domain is refused identically on both paths" holds by construction
 * rather than by two copies agreeing.
 */
export async function deriveOpsBound(
  tx: TenantTx,
  input: Omit<DeriveOpsRunMaterialInput, "subjectObjectId">
): Promise<DerivedOpsBound> {
  // 1. ENROLMENT FIRST. No enrolment means no recorded break-glass path, and ADR-0051 makes that a
  //    precondition of holding a CA at all. Deriving anyway would route around the refusal that
  //    enrolment exists to enforce — the check belongs here as well as at the enrolment door,
  //    because this is the other way a certificate could come to exist.
  const enrolment = await enrolmentForDomain(tx, input.orgId, input.domainId);
  if (!enrolment) {
    throw new OpsMaterialUnavailable(
      `domain ${input.domainId} is not enrolled for host-reaching execution. Enrol it first — ` +
        "which requires recording an independent access path, because an estate whose only route " +
        "in is SCP's CA cannot recover from SCP's CA being compromised (ADR-0051).",
      { inputContext: opsMaterialContext("domain_not_enrolled") }
    );
  }
  const authorityRow = await activeAuthorityForDomain(tx, input.orgId, input.domainId);
  if (!authorityRow) {
    // An enrolment without an active CA means the CA was retired without re-enrolment. Refusing is
    // the only safe reading: the alternative is minting from a `retiring` key nobody intended.
    throw new OpsMaterialUnavailable(
      `domain ${input.domainId} is enrolled but has no ACTIVE certificate authority`,
      { inputContext: opsMaterialContext("no_active_authority") }
    );
  }

  // 2. THE INVENTORY AND THE ALLOWLIST, from ONE read of membership. Two reads could disagree, and
  //    the dangerous direction is an allowlist wider than the hosts the run was given.
  const members = await readMembers(tx, input.orgId, input.productObjectId);
  const opsInventory = compileInventory(members);
  const opsEgressAllowlist = [...egressAllowlistFor(members)];

  // 3. THE CA KEY MUST RESOLVE — checked before EITHER path commits to a run, so the Argo path
  //    refuses at derivation exactly where Mode C does, rather than later, inside a pod.
  const caPrivateKeyPem = await getSecretValue(
    tx,
    input.orgId,
    authorityRow.privateKeySecretKey,
    input.masterKey
  );
  if (!caPrivateKeyPem) {
    throw new OpsMaterialUnavailable(
      `the CA for domain ${input.domainId} names secret '${authorityRow.privateKeySecretKey}', ` +
        "which does not resolve. Refusing rather than running a host-reaching class with no " +
        "credential.",
      { inputContext: opsMaterialContext("ca_key_unresolved") }
    );
  }

  return {
    bound: {
      opsRole: input.role,
      opsInventory,
      opsEgressAllowlist,
      opsPrincipals: [OPS_PRINCIPAL]
    },
    authorityId: authorityRow.id,
    caPrivateKeyPem
  };
}

/**
 * Derive one MODE C run's material, and record the issuance in the SAME transaction.
 *
 * Returned as a plain parameter bag because that is the channel `trigger()` has — but every key in
 * it is one `SERVER_DERIVED_OPS_KEYS` names, so a recipe carrying any of them is refused rather
 * than merged (ADR-0052). The bag holds a SECRET KEY, never credential material: trigger
 * parameters are persisted and surfaced in evidence.
 */
export async function deriveOpsRunMaterial(
  tx: TenantTx,
  input: DeriveOpsRunMaterialInput
): Promise<Record<string, unknown>> {
  const { bound, authorityId, caPrivateKeyPem } = await deriveOpsBound(tx, input);

  // A PER-RUN CERTIFICATE from the domain's own CA, over a keypair minted HERE: Mode C launches the
  // container itself, so the private half only ever reaches infrastructure SCP controls.
  const { generateEphemeralSshKeypair } = await import("./ssh-credentials.js");
  const keypair = generateEphemeralSshKeypair();
  const authority = new ScpCaAuthority({
    domainId: input.domainId,
    authorityId,
    caPrivateKeyPem
  });
  const issued = await authority.issue({
    openSshPublicKey: keypair.openSshPublicKey,
    principals: bound.opsPrincipals,
    keyId: opsKeyId(input.subjectObjectId),
    validForSeconds: RUN_CERTIFICATE_TTL_SECONDS,
    targetHosts: bound.opsEgressAllowlist
  });

  // THE CREDENTIAL GOES TO THE SECRET STORE; only its KEY travels onward.
  const opsCredentialSecretKey = `ops/run/${randomUUID()}`;
  await putSecret(tx, {
    orgId: input.orgId,
    key: opsCredentialSecretKey,
    // Private key and certificate together: the runner needs both, and splitting them across two
    // secrets would let a run start holding one half.
    value: JSON.stringify({
      privateKeyPem: keypair.privateKeyPem,
      certificate: issued.certificate
    }),
    masterKey: input.masterKey
  });

  // THE ISSUANCE RECORD, in this transaction. ADR-0051 D5: a certificate a host accepted with no row
  // here IS evidence of forgery, so the record must not be able to fail independently of the
  // certificate it describes.
  await recordIssuance(tx, {
    orgId: input.orgId,
    authorityId,
    authorityName: issued.authority,
    serial: issued.serial,
    // What was ACTUALLY signed, not a second formatting of it. `ScpCaAuthority` appends the serial
    // to the requested id, so re-deriving the string here is exactly the divergence `keyId` on the
    // response exists to prevent.
    keyId: issued.keyId ?? opsKeyId(input.subjectObjectId),
    principals: bound.opsPrincipals,
    targetHosts: bound.opsEgressAllowlist,
    expiresAt: issued.expiresAt
  });

  return { ...bound, opsCredentialSecretKey };
}
