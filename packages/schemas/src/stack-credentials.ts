import { z } from "zod";
import { InstanceActorSchema, Sha256HexSchema } from "./stack-primitives.js";

/**
 * CREDENTIALS THROUGH SCP (M29.5, ADR-0062; charter "Managed Standard Stack": "CommanderSCP
 * brokers them in, it does not hold them").
 *
 * A credential a bundled backend needs — a registry push token, cloud credentials for an infra
 * plan/apply, a git token — is entered through SCP's API and written by the STACK CONTROLLER
 * straight into the backend namespace's Secret. scpd never persists the value and has no route
 * that returns it: it seals the value to a public key only the controller holds, keeps the sealed
 * envelope until the controller confirms the write, then drops it.
 *
 * WHERE A VALUE MAY GO IS THIS FILE, AND NOTHING ELSE. Every Secret name and every key is an
 * entry below — never free-form — so no writer of the API (and no writer of the sealed-envelope
 * table) can name a different Secret, a different namespace (the controller derives it from the
 * backend), or a key that would become something else once mounted: every key of the infra Secrets
 * becomes an ENVIRONMENT VARIABLE of a pod that runs a repository's own code, so a free key could
 * set `LD_PRELOAD`, `TF_CLI_CONFIG_FILE` or `PATH`. Widening this catalog is a reviewed schema
 * change.
 */

const INFRA_ENV_KEYS = {
  AWS_ACCESS_KEY_ID: "AWS access key id",
  AWS_SECRET_ACCESS_KEY: "AWS secret access key",
  AWS_SESSION_TOKEN: "AWS session token (temporary credentials)",
  AWS_REGION: "AWS region",
  ARM_CLIENT_ID: "Azure service principal client id",
  ARM_CLIENT_SECRET: "Azure service principal client secret",
  ARM_TENANT_ID: "Azure tenant id",
  ARM_SUBSCRIPTION_ID: "Azure subscription id",
  GOOGLE_CREDENTIALS: "Google Cloud service account key (the JSON document)",
  GOOGLE_PROJECT: "Google Cloud project id",
  PG_CONN_STR: "PostgreSQL state backend connection string (the `pg` backend)",
  TF_HTTP_USERNAME: "HTTP state backend username (the `http` backend)",
  TF_HTTP_PASSWORD: "HTTP state backend password (the `http` backend)",
  VAULT_TOKEN: "HashiCorp Vault token",
  CLOUDFLARE_API_TOKEN: "Cloudflare API token",
  GITHUB_TOKEN: "GitHub token (the github provider)"
} as const;

/** backend -> Secret name -> { purpose, keys: key -> description }. The Secret names are the
 *  bundled chart's own defaults (deploy/helm-bundled values.yaml), which the controller renders
 *  with — `stack-credentials.test.ts` in apps/stackd holds the two together. */
export const STACK_CREDENTIAL_CATALOG = {
  "argo-workflows": {
    "scp-build-registry": {
      purpose:
        "Image and RPM builds (scp-build-image-v1, scp-build-rpm-v1): the source checkout and the registry push.",
      keys: {
        gitToken: "Read access to the source repository (leave unset for a public repository).",
        registryUsername: "The registry push identity.",
        registryPassword:
          "The registry push token (GHCR: a token with packages:write; Gitea: a token with write:package).",
        registryHost:
          "The registry host (host[:port]) this push credential may be presented to. A build whose destination is any other host is refused before the credential is used."
      }
    },
    "scp-infra-plan-credentials": {
      purpose:
        "Infrastructure PLAN (scp-infra-plan-v1). A plan runs the repository's own code before anyone approves it, so these must be READ-ONLY credentials. Each key becomes an environment variable of the plan pod.",
      keys: INFRA_ENV_KEYS
    },
    "scp-infra-apply-credentials": {
      purpose:
        "Infrastructure APPLY (scp-infra-apply-v1), reached only through SCP's apply gate. Each key becomes an environment variable of the apply pod.",
      keys: INFRA_ENV_KEYS
    }
  }
} as const;

type Catalog = typeof STACK_CREDENTIAL_CATALOG;
export type StackCredentialBackend = keyof Catalog;

export const StackCredentialBackendSchema = z.enum(
  Object.keys(STACK_CREDENTIAL_CATALOG) as [StackCredentialBackend, ...StackCredentialBackend[]]
);

type SecretNameOf<B extends keyof Catalog> = keyof Catalog[B] & string;
type KeyOf<B extends keyof Catalog> = {
  [S in SecretNameOf<B>]: keyof (Catalog[B][S] extends { keys: infer K } ? K : never) & string;
}[SecretNameOf<B>];
export type StackCredentialSecretName = { [B in keyof Catalog]: SecretNameOf<B> }[keyof Catalog];
export type StackCredentialKey = { [B in keyof Catalog]: KeyOf<B> }[keyof Catalog];

const allSecretNames = [
  ...new Set(Object.values(STACK_CREDENTIAL_CATALOG).flatMap((s) => Object.keys(s)))
] as [StackCredentialSecretName, ...StackCredentialSecretName[]];
const allKeys = [
  ...new Set(
    Object.values(STACK_CREDENTIAL_CATALOG).flatMap((secrets) =>
      Object.values(secrets).flatMap((s) => Object.keys(s.keys))
    )
  )
] as [StackCredentialKey, ...StackCredentialKey[]];

export const StackCredentialSecretNameSchema = z.enum(allSecretNames);
export const StackCredentialKeySchema = z.enum(allKeys);

/** Whether (backend, secretName, key) is an entry of the catalog — the ONLY targets a value may
 *  be written to. Both scpd (before sealing) and the controller (after opening) ask. */
export function isCatalogTarget(backend: string, secretName: string, key: string): boolean {
  const secrets = (STACK_CREDENTIAL_CATALOG as Record<string, Record<string, { keys: object }>>)[
    backend
  ];
  const secret = secrets && Object.hasOwn(secrets, secretName) ? secrets[secretName] : undefined;
  return Boolean(secret && Object.hasOwn(secret.keys, key));
}

/** Every catalog target, in catalog order. */
export function catalogTargets(): { backend: string; secretName: string; key: string }[] {
  return Object.entries(STACK_CREDENTIAL_CATALOG).flatMap(([backend, secrets]) =>
    Object.entries(secrets).flatMap(([secretName, s]) =>
      Object.keys(s.keys).map((key) => ({ backend, secretName, key }))
    )
  );
}

/** The largest value accepted: a Google service-account key is ~2.3 KB, a kubeconfig-sized blob
 *  is the practical ceiling for anything a Secret key should hold. */
export const STACK_CREDENTIAL_MAX_BYTES = 32_768;

export const StackCredentialParamSchema = z.object({
  backend: StackCredentialBackendSchema,
  secretName: StackCredentialSecretNameSchema,
  key: StackCredentialKeySchema
});
export type StackCredentialTarget = z.infer<typeof StackCredentialParamSchema>;

/** `PUT /instance/stack/credentials/{backend}/{secretName}/{key}` — the value, once. */
export const PutStackCredentialRequestSchema = z.strictObject({
  value: z
    .string()
    .min(1)
    .max(STACK_CREDENTIAL_MAX_BYTES)
    .refine((v) => !v.includes("\u0000"), "a credential value may not contain a NUL byte")
});
export type PutStackCredentialRequest = z.infer<typeof PutStackCredentialRequestSchema>;

// ---- WORKLOAD IDENTITY (preferred wherever the substrate provides it) --------------------------

/**
 * THE SUPPORTED WORKLOAD-IDENTITY PROVIDERS. Declaring one makes the controller set the provider's
 * annotation on the named ServiceAccount (and, for Azure, the label the mutating webhook keys on,
 * on every pod that runs as it), so nothing needs entering at all. The cloud side — the IAM
 * role's trust policy naming `system:serviceaccount:<namespace>:<serviceAccount>`, the GCP IAM
 * binding, the Azure federated credential — is the cloud account owner's, and is what actually
 * grants authority: the annotation alone grants nothing.
 *
 * EKS Pod Identity needs nothing in-cluster (the association is made in the AWS API), so there is
 * nothing to declare for it here.
 */
export const STACK_WORKLOAD_IDENTITY_PROVIDERS = {
  "aws-irsa": {
    label: "AWS IAM Roles for Service Accounts (IRSA)",
    annotation: "eks.amazonaws.com/role-arn",
    podLabel: null,
    identifier: "IAM role ARN",
    pattern: "^arn:aws(-cn|-us-gov)?:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$"
  },
  "gke-workload-identity": {
    label: "GKE Workload Identity",
    annotation: "iam.gke.io/gcp-service-account",
    podLabel: null,
    identifier: "Google service account email",
    pattern:
      "^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$"
  },
  "azure-workload-identity": {
    label: "Azure Workload Identity",
    annotation: "azure.workload.identity/client-id",
    podLabel: "azure.workload.identity/use",
    identifier: "Managed identity / application client id (a GUID)",
    pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
  }
} as const;

export type StackWorkloadIdentityProvider = keyof typeof STACK_WORKLOAD_IDENTITY_PROVIDERS;

/**
 * The ServiceAccounts a workload identity may be declared for — the identities that hold
 * authority over something OUTSIDE the cluster. The build identity (`scp-build`) is deliberately
 * absent: a build pod runs the tenant's own Dockerfile and must never inherit cloud authority, and
 * BuildKit authenticates its push from the registry Secret regardless.
 */
export const STACK_WORKLOAD_IDENTITY_SLOTS = {
  "argo-workflows": {
    "scp-infra-plan": "Infrastructure PLAN pods — bind a READ-ONLY cloud role.",
    "scp-infra-apply": "Infrastructure APPLY pods — the role that may change infrastructure."
  },
  argocd: {
    "argocd-application-controller":
      "Argo CD's application controller — reaches managed clusters (EKS/GKE/AKS) as this identity.",
    "argocd-server": "Argo CD's API server — reaches managed clusters for resource actions."
  }
} as const;

export type StackWorkloadIdentityBackend = keyof typeof STACK_WORKLOAD_IDENTITY_SLOTS;
export const StackWorkloadIdentityBackendSchema = z.enum(
  Object.keys(STACK_WORKLOAD_IDENTITY_SLOTS) as [
    StackWorkloadIdentityBackend,
    ...StackWorkloadIdentityBackend[]
  ]
);
type Slots = typeof STACK_WORKLOAD_IDENTITY_SLOTS;
export type StackWorkloadIdentityServiceAccount = {
  [B in keyof Slots]: keyof Slots[B] & string;
}[keyof Slots];
export const StackWorkloadIdentityServiceAccountSchema = z.enum([
  ...new Set(Object.values(STACK_WORKLOAD_IDENTITY_SLOTS).flatMap((s) => Object.keys(s)))
] as [StackWorkloadIdentityServiceAccount, ...StackWorkloadIdentityServiceAccount[]]);

export function isWorkloadIdentitySlot(backend: string, serviceAccount: string): boolean {
  const slots = (STACK_WORKLOAD_IDENTITY_SLOTS as Record<string, Record<string, string>>)[backend];
  return Boolean(slots && Object.hasOwn(slots, serviceAccount));
}

const identifierFor = (p: StackWorkloadIdentityProvider) =>
  z.string().max(600).regex(new RegExp(STACK_WORKLOAD_IDENTITY_PROVIDERS[p].pattern));

/** A declaration: which provider, and its identifier, each pattern-bound (no free string). */
export const StackWorkloadIdentityBindingSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("aws-irsa"), identifier: identifierFor("aws-irsa") }),
  z.strictObject({
    provider: z.literal("gke-workload-identity"),
    identifier: identifierFor("gke-workload-identity")
  }),
  z.strictObject({
    provider: z.literal("azure-workload-identity"),
    identifier: identifierFor("azure-workload-identity")
  })
]);
export type StackWorkloadIdentityBinding = z.infer<typeof StackWorkloadIdentityBindingSchema>;

export const PutStackWorkloadIdentityRequestSchema = StackWorkloadIdentityBindingSchema;
export type PutStackWorkloadIdentityRequest = StackWorkloadIdentityBinding;

export const StackWorkloadIdentityParamSchema = z.object({
  backend: StackWorkloadIdentityBackendSchema,
  serviceAccount: StackWorkloadIdentityServiceAccountSchema
});
export type StackWorkloadIdentityTarget = z.infer<typeof StackWorkloadIdentityParamSchema>;

/** One declaration as the controller reads it in the spec (`StackSpecDocument.workloadIdentities`):
 *  the slot, the provider and its pattern-bound identifier. */
const specEntry = <P extends StackWorkloadIdentityProvider>(p: P) =>
  z.object({
    backend: StackWorkloadIdentityBackendSchema,
    serviceAccount: StackWorkloadIdentityServiceAccountSchema,
    provider: z.literal(p),
    identifier: identifierFor(p)
  });
export const StackWorkloadIdentitySpecSchema = z.discriminatedUnion("provider", [
  specEntry("aws-irsa"),
  specEntry("gke-workload-identity"),
  specEntry("azure-workload-identity")
]);
export type StackWorkloadIdentitySpec = z.infer<typeof StackWorkloadIdentitySpecSchema>;

// ---- THE SEALED HAND-OFF (scpd -> controller) --------------------------------------------------

/** base64 of exactly `n` bytes (standard alphabet, padded) — by length and padding, so this
 *  module needs no Buffer (the web bundle imports it too). */
const base64Of = (n: number) => {
  const pad = (3 - (n % 3)) % 3;
  const body = 4 * Math.ceil(n / 3) - pad;
  return z.string().regex(new RegExp(`^[A-Za-z0-9+/]{${body}}={${pad}}$`), `base64 of ${n} bytes`);
};

/** The controller's X25519 public key, published through its own door. */
export const PutStackCredentialSealingKeyRequestSchema = z.strictObject({
  /** 32 raw bytes, base64. */
  publicKey: base64Of(32),
  /** sha256 hex of the 32 raw bytes — what every envelope names as the key it is sealed to. */
  keyId: Sha256HexSchema
});
export type PutStackCredentialSealingKeyRequest = z.infer<
  typeof PutStackCredentialSealingKeyRequestSchema
>;

export const StackCredentialOpSchema = z.enum(["set", "delete"]);
export type StackCredentialOp = z.infer<typeof StackCredentialOpSchema>;

/** ECIES over X25519: an ephemeral key, HKDF-SHA256, AES-256-GCM. The header fields of the
 *  delivery are the GCM additional data, so editing any of them — the target above all — fails
 *  the tag. */
export const StackCredentialEnvelopeSchema = z.strictObject({
  v: z.literal(1),
  epk: base64Of(32),
  nonce: base64Of(12),
  ciphertext: z
    .string()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .max(65_536),
  tag: base64Of(16)
});
export type StackCredentialEnvelope = z.infer<typeof StackCredentialEnvelopeSchema>;

/** One pending delivery, as the controller reads it (its credential ONLY). */
export const StackCredentialDeliverySchema = z.object({
  deliveryId: z.string().uuid(),
  /** Monotonic across the instance: the controller refuses any delivery for a target at or below
   *  the highest sequence it has applied there (a replayed envelope). */
  seq: z.number().int().min(1),
  backend: StackCredentialBackendSchema,
  secretName: StackCredentialSecretNameSchema,
  key: StackCredentialKeySchema,
  op: StackCredentialOpSchema,
  /** The controller key this envelope is sealed to. */
  keyId: Sha256HexSchema,
  /** After this the controller refuses the envelope. */
  notAfter: z.string().datetime(),
  envelope: StackCredentialEnvelopeSchema
});
export type StackCredentialDelivery = z.infer<typeof StackCredentialDeliverySchema>;

export const StackCredentialDeliveryListSchema = z.object({
  items: z.array(StackCredentialDeliverySchema)
});
export type StackCredentialDeliveryList = z.infer<typeof StackCredentialDeliveryListSchema>;

/** Why the controller refused an envelope. Codes only: nothing the controller read reaches scpd. */
export const StackCredentialRefusalSchema = z.enum([
  /** The GCM tag did not verify: the envelope or its header was altered (a redirect). */
  "tampered",
  /** Sealed to a key this controller does not hold. */
  "wrong-key",
  /** A sequence at or below the last applied for this target (a replay). */
  "replayed",
  /** Past its notAfter. */
  "expired",
  /** Not an entry of the catalog this controller carries. */
  "not-in-catalog"
]);
export type StackCredentialRefusal = z.infer<typeof StackCredentialRefusalSchema>;

export const AckStackCredentialDeliveryRequestSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("applied"), seq: z.number().int().min(1) }),
  z.strictObject({
    outcome: z.literal("refused"),
    seq: z.number().int().min(1),
    reason: StackCredentialRefusalSchema
  })
]);
export type AckStackCredentialDeliveryRequest = z.infer<
  typeof AckStackCredentialDeliveryRequestSchema
>;

export const StackCredentialDeliveryParamSchema = z.object({ deliveryId: z.string().uuid() });

// ---- THE READ MODEL (metadata only — there is no read of a value, anywhere) --------------------

export const StackCredentialStateSchema = z.enum(["unset", "pending", "set", "failed"]);
export type StackCredentialState = z.infer<typeof StackCredentialStateSchema>;

export const StackCredentialKeyViewSchema = z.object({
  backend: StackCredentialBackendSchema,
  secretName: StackCredentialSecretNameSchema,
  key: StackCredentialKeySchema,
  description: z.string(),
  state: StackCredentialStateSchema,
  /** While pending: whether the controller is to write or remove it. */
  pendingOp: StackCredentialOpSchema.nullable(),
  requestedBy: InstanceActorSchema.nullable(),
  requestedAt: z.string().nullable(),
  /** When the controller confirmed the last write (or removal) into the backend's Secret. */
  deliveredAt: z.string().nullable(),
  error: z.string().nullable()
});
export type StackCredentialKeyView = z.infer<typeof StackCredentialKeyViewSchema>;

export const StackCredentialSecretViewSchema = z.object({
  backend: StackCredentialBackendSchema,
  secretName: StackCredentialSecretNameSchema,
  purpose: z.string(),
  keys: z.array(StackCredentialKeyViewSchema)
});

export const StackWorkloadIdentityViewSchema = z.object({
  backend: StackWorkloadIdentityBackendSchema,
  serviceAccount: StackWorkloadIdentityServiceAccountSchema,
  description: z.string(),
  binding: StackWorkloadIdentityBindingSchema.nullable(),
  declaredBy: InstanceActorSchema.nullable(),
  declaredAt: z.string().nullable()
});
export type StackWorkloadIdentityView = z.infer<typeof StackWorkloadIdentityViewSchema>;

export const StackCredentialsViewSchema = z.object({
  secrets: z.array(StackCredentialSecretViewSchema),
  workloadIdentities: z.array(StackWorkloadIdentityViewSchema),
  /** Whether the controller has published the key values are sealed to; until it has, a value
   *  cannot be entered (there is nowhere safe to put it). */
  sealingKey: z.object({ published: z.boolean(), publishedAt: z.string().nullable() })
});
export type StackCredentialsView = z.infer<typeof StackCredentialsViewSchema>;

/** A sealed envelope is refused this long after it was sealed. The per-target sequence check
 *  refuses a replay regardless; this bounds one if the controller's own record is lost. */
export const STACK_CREDENTIAL_ENVELOPE_TTL_MS = 60 * 60 * 1000;

/** The GCM additional data for a delivery: every header field, in a fixed order. */
export function credentialEnvelopeAad(d: {
  deliveryId: string;
  seq: number;
  backend: string;
  secretName: string;
  key: string;
  op: StackCredentialOp;
  keyId: string;
  notAfter: string;
}): string {
  return JSON.stringify([
    "scp-stack-credential/v1",
    d.deliveryId,
    d.seq,
    d.backend,
    d.secretName,
    d.key,
    d.op,
    d.keyId,
    d.notAfter
  ]);
}

/** The HKDF `info` both sides use. */
export const STACK_CREDENTIAL_HKDF_INFO = "scp-stack-credential/v1";
