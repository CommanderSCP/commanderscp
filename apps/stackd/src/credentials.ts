import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject
} from "node:crypto";
import {
  STACK_CREDENTIAL_CATALOG,
  STACK_CREDENTIAL_HKDF_INFO,
  StackCredentialDeliverySchema,
  credentialEnvelopeAad,
  isCatalogTarget,
  type AckStackCredentialDeliveryRequest,
  type PutStackCredentialSealingKeyRequest,
  type StackBackend,
  type StackCredentialDelivery,
  type StackCredentialDeliveryList,
  type StackCredentialRefusal,
  type StackNeed
} from "@scp/schemas";
import type { KubeClient } from "./kube.js";
import { backendNamespace, type StackRelease } from "./release.js";

/**
 * CREDENTIALS THROUGH SCP — the controller's half (M29.5, ADR-0063).
 *
 * The controller holds an X25519 key pair; the private half lives in a Secret in ITS OWN namespace
 * (ADR-0058 §6: no other identity the chart renders can read there) and never leaves this process
 * except to that Secret. It publishes the public half to scpd through its own door. Every tick it
 * reads the sealed envelopes scpd holds, and for each:
 *
 *   1. the target (backend, Secret, key) must be an entry of the catalog THIS IMAGE carries — the
 *      namespace is derived from the backend here, never read from anywhere;
 *   2. it must be sealed to the key this controller holds, and not past its `notAfter`;
 *   3. it must have been SEALED LATER than the last delivery this controller applied to that
 *      target (its `notAfter`, bound into the tag, is the sealing time plus a fixed TTL): a
 *      replayed envelope — even a byte-identical copy of one that was valid — is refused. Time,
 *      not scpd's sequence, orders them, because a sequence goes BACKWARDS when scpd's database is
 *      restored or rebuilt (measured on kind: a fresh scpd's first credential was refused as a
 *      replay of the previous scpd's), while scpd's clock does not;
 *   4. it must OPEN: the header is the GCM additional data, so a row whose target was rewritten
 *      in scpd's table fails the tag;
 *   5. only then is the value written into the backend namespace's Secret (or the key removed),
 *      that delivery recorded, and confirmed — scpd then drops the envelope.
 *
 * A refusal is confirmed with a reason CODE; nothing the controller opened ever travels back. The
 * value is never logged, never put in a status report, and the Buffer holding it is zeroed once
 * written.
 */

export interface CredentialApi {
  putSealingKey(req: PutStackCredentialSealingKeyRequest): Promise<void>;
  credentialDeliveries(): Promise<StackCredentialDeliveryList>;
  ackCredentialDelivery(deliveryId: string, req: AckStackCredentialDeliveryRequest): Promise<void>;
}

export interface CredentialDeps {
  api: CredentialApi;
  kube: KubeClient;
  release: StackRelease;
  /** The controller's own namespace: its key and its applied-sequence record live there. */
  stackdNamespace: string;
  log: (line: string) => void;
  now?: () => Date;
}

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const KEY_SECRET = "scp-stackd-sealing-key";
const APPLIED_SECRET = "scp-stackd-credentials";
/** The field manager that owns one credential key of a backend Secret. One per key, so applying
 *  one key never removes another (server-side apply drops what the SAME manager stops sending). */
export const credentialFieldManager = (key: string): string => `scp-stackd-credential.${key}`;
export const CREDENTIAL_ROLE_LABEL = "stack.commanderscp.io/role";

const rawToPublicKey = (raw: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });

export interface SealingKeyPair {
  privateKey: KeyObject;
  publicRaw: Buffer;
  keyId: string;
}

function keyPairFrom(privateDer: Buffer): SealingKeyPair {
  const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const publicRaw = (
    createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer
  ).subarray(X25519_SPKI_PREFIX.length);
  return {
    privateKey,
    publicRaw,
    keyId: createHash("sha256").update(publicRaw).digest("hex")
  };
}

/** The controller's key pair: read from its own namespace, or generated there once. */
export async function loadOrCreateSealingKey(
  kube: KubeClient,
  namespace: string
): Promise<SealingKeyPair> {
  const ref = { apiVersion: "v1", kind: "Secret", name: KEY_SECRET, namespace };
  const live = await kube.get(ref);
  const der = (live?.["data"] as Record<string, string> | undefined)?.["private.der"];
  if (der) return keyPairFrom(Buffer.from(der, "base64"));
  const { privateKey } = generateKeyPairSync("x25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  await kube.apply({
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: { name: KEY_SECRET, namespace, labels: { [CREDENTIAL_ROLE_LABEL]: "sealing-key" } },
    data: { "private.der": privateDer.toString("base64") }
  });
  return keyPairFrom(privateDer);
}

/** Opens one envelope, or says why not. Checks everything BUT the ordering (the caller's). */
export function openDelivery(
  key: SealingKeyPair,
  d: StackCredentialDelivery,
  now: Date
): { ok: true; plaintext: Buffer } | { ok: false; reason: StackCredentialRefusal } {
  if (!isCatalogTarget(d.backend, d.secretName, d.key))
    return { ok: false, reason: "not-in-catalog" };
  if (d.keyId !== key.keyId) return { ok: false, reason: "wrong-key" };
  if (!(Date.parse(d.notAfter) > now.getTime())) return { ok: false, reason: "expired" };
  try {
    const epk = Buffer.from(d.envelope.epk, "base64");
    const shared = diffieHellman({ privateKey: key.privateKey, publicKey: rawToPublicKey(epk) });
    const aesKey = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        Buffer.concat([epk, key.publicRaw]),
        STACK_CREDENTIAL_HKDF_INFO,
        32
      )
    );
    shared.fill(0);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      aesKey,
      Buffer.from(d.envelope.nonce, "base64")
    );
    decipher.setAAD(Buffer.from(credentialEnvelopeAad(d), "utf8"));
    decipher.setAuthTag(Buffer.from(d.envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(d.envelope.ciphertext, "base64")),
      decipher.final()
    ]);
    aesKey.fill(0);
    // A delete carries nothing; a set carries something. Either mismatch is not a real delivery.
    if ((d.op === "delete") !== (plaintext.length === 0)) {
      plaintext.fill(0);
      return { ok: false, reason: "tampered" };
    }
    return { ok: true, plaintext };
  } catch {
    return { ok: false, reason: "tampered" };
  }
}

// ---- the applied-sequence record (replay refusal) -----------------------------------------------

/** Per target: the last delivery applied, and when it was sealed (as its `notAfter`). */
type Applied = Record<string, { notAfter: string; seq: number; deliveryId: string }>;
const targetOf = (d: Pick<StackCredentialDelivery, "backend" | "secretName" | "key">) =>
  `${d.backend}/${d.secretName}/${d.key}`;

async function loadApplied(kube: KubeClient, namespace: string): Promise<Applied> {
  const live = await kube.get({
    apiVersion: "v1",
    kind: "Secret",
    name: APPLIED_SECRET,
    namespace
  });
  const raw = (live?.["data"] as Record<string, string> | undefined)?.["applied.json"];
  if (!raw) return {};
  const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  // Only entries that can order a delivery: one without a parseable sealing time orders nothing.
  return Object.fromEntries(
    Object.entries(parsed as Record<string, Partial<Applied[string]>>).filter(
      ([, v]) =>
        typeof v?.notAfter === "string" &&
        Number.isFinite(Date.parse(v.notAfter)) &&
        typeof v.seq === "number" &&
        typeof v.deliveryId === "string"
    )
  ) as Applied;
}

async function saveApplied(kube: KubeClient, namespace: string, applied: Applied): Promise<void> {
  await kube.apply({
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: APPLIED_SECRET,
      namespace,
      labels: { [CREDENTIAL_ROLE_LABEL]: "credential-sequence" }
    },
    data: { "applied.json": Buffer.from(JSON.stringify(applied)).toString("base64") }
  });
}

// ---- THE WRITE STEP ------------------------------------------------------------------------------

/**
 * Writes one key of a backend's credential Secret (or removes it). The namespace is the backend's
 * own, derived from the release this image carries; the Secret name and key have been held to the
 * catalog. Server-side apply under a per-key field manager, so a set creates the Secret if needed
 * and never drops another key; a delete is a merge patch removing just that key.
 */
export async function writeCredential(
  deps: Pick<CredentialDeps, "kube" | "release">,
  d: Pick<StackCredentialDelivery, "backend" | "secretName" | "key" | "op">,
  plaintext: Buffer
): Promise<void> {
  if (!isCatalogTarget(d.backend, d.secretName, d.key)) {
    throw new Error(`${targetOf(d)} is not a catalog target`);
  }
  const namespace = backendNamespace(deps.release, d.backend as StackBackend);
  const ref = { apiVersion: "v1", kind: "Secret", name: d.secretName, namespace };
  if (d.op === "set") {
    await deps.kube.apply(
      {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: {
          name: d.secretName,
          namespace,
          labels: { [CREDENTIAL_ROLE_LABEL]: "credential" }
        },
        data: { [d.key]: plaintext.toString("base64") }
      },
      credentialFieldManager(d.key)
    );
    return;
  }
  if (await deps.kube.get(ref)) {
    await deps.kube.mergePatch(
      ref,
      { data: { [d.key]: null } },
      { fieldManager: credentialFieldManager(d.key) }
    );
  }
}

/** Refuses a delivery through scpd, with the reason code; a failed refusal is retried next tick. */
async function refuse(
  deps: CredentialDeps,
  d: StackCredentialDelivery,
  reason: StackCredentialRefusal
): Promise<void> {
  deps.log(`credential ${targetOf(d)} (delivery ${d.deliveryId}, seq ${d.seq}) refused: ${reason}`);
  await deps.api.ackCredentialDelivery(d.deliveryId, { outcome: "refused", seq: d.seq, reason });
}

/**
 * One pass: publish the key if scpd's record of it differs, then deliver every pending envelope.
 * Returns how many were written. Never throws for one delivery: each is its own attempt.
 */
export async function deliverCredentials(
  deps: CredentialDeps,
  recordedKeySha256: string | null
): Promise<{ applied: number; refused: number; keyId: string }> {
  const key = await loadOrCreateSealingKey(deps.kube, deps.stackdNamespace);
  if (recordedKeySha256 !== key.keyId) {
    await deps.api.putSealingKey({
      publicKey: key.publicRaw.toString("base64"),
      keyId: key.keyId
    });
    deps.log(`published the credential sealing key ${key.keyId.slice(0, 12)}…`);
  }
  const listed = await deps.api.credentialDeliveries();
  const out = { applied: 0, refused: 0, keyId: key.keyId };
  if (listed.items.length === 0) return out;
  const applied = await loadApplied(deps.kube, deps.stackdNamespace);
  const now = (deps.now ?? (() => new Date()))();
  for (const item of [...listed.items].sort((a, b) => a.seq - b.seq)) {
    const parsed = StackCredentialDeliverySchema.safeParse(item);
    if (!parsed.success) continue; // not a delivery: nothing to act on, nothing to confirm
    const d = parsed.data;
    const target = targetOf(d);
    try {
      const last = applied[target];
      if (last && !(Date.parse(d.notAfter) > Date.parse(last.notAfter))) {
        // The delivery this controller already applied, whose confirmation was lost: confirm it
        // again. Anything else sealed no later than the one applied is a replay.
        if (last.seq === d.seq && last.deliveryId === d.deliveryId) {
          await deps.api.ackCredentialDelivery(d.deliveryId, { outcome: "applied", seq: d.seq });
        } else {
          await refuse(deps, d, "replayed");
          out.refused++;
        }
        continue;
      }
      const opened = openDelivery(key, d, now);
      if (!opened.ok) {
        await refuse(deps, d, opened.reason);
        out.refused++;
        continue;
      }
      try {
        await writeCredential(deps, d, opened.plaintext);
      } finally {
        opened.plaintext.fill(0);
      }
      applied[target] = { notAfter: d.notAfter, seq: d.seq, deliveryId: d.deliveryId };
      await saveApplied(deps.kube, deps.stackdNamespace, applied);
      await deps.api.ackCredentialDelivery(d.deliveryId, { outcome: "applied", seq: d.seq });
      deps.log(
        `credential ${target}: ${d.op === "set" ? "written" : "removed"} (delivery ${d.deliveryId}, seq ${d.seq})`
      );
      out.applied++;
    } catch (err) {
      // Never the value: a Kubernetes or API error message names the request, not its body.
      deps.log(
        `credential ${target} (delivery ${d.deliveryId}) not delivered, retried next tick: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return out;
}

/**
 * What a ready backend still needs from the catalog, read from its OWN Secret (key names only —
 * the values are never looked at): today, a registry push credential for the build templates.
 */
export async function credentialNeeds(
  deps: Pick<CredentialDeps, "kube" | "release">,
  backend: StackBackend
): Promise<StackNeed[]> {
  if (backend !== "argo-workflows") return [];
  const namespace = backendNamespace(deps.release, backend);
  const secretName =
    "scp-build-registry" satisfies keyof (typeof STACK_CREDENTIAL_CATALOG)["argo-workflows"];
  const live = await deps.kube.get({
    apiVersion: "v1",
    kind: "Secret",
    name: secretName,
    namespace
  });
  const present = new Set(
    Object.keys((live?.["data"] as Record<string, string> | undefined) ?? {})
  );
  const missing = ["registryUsername", "registryPassword", "registryHost"].filter(
    (k) => !present.has(k)
  );
  return missing.length === 0
    ? []
    : [
        {
          code: "credentials",
          message: `Image and RPM builds cannot push yet: ${secretName} has no ${missing.join(", ")}. Enter ${missing.length === 1 ? "it" : "them"} under Admin › Stack › Credentials, or \`scp stack credential set argo-workflows ${secretName} <key>\`.`
        }
      ];
}
