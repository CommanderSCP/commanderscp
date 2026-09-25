import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID
} from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  STACK_CREDENTIAL_CATALOG,
  STACK_CREDENTIAL_HKDF_INFO,
  credentialEnvelopeAad,
  type AckStackCredentialDeliveryRequest,
  type PutStackCredentialSealingKeyRequest,
  type StackCredentialDelivery,
  type StackCredentialOp
} from "@scp/schemas";
import { installCredentialHooks } from "./controller.js";
import { KubeClient } from "./kube.js";
import type { ControllerDeps } from "./reconcile.js";
import type { StackRelease } from "./release.js";
import { credentialNeeds, loadOrCreateSealingKey } from "./credentials.js";
import { applyWorkloadIdentities, WORKLOAD_IDENTITY_ANNOTATION } from "./workload-identity.js";
import type { KubeObject } from "./manifests.js";
import { FakeKube } from "./test-support/fake-kube.js";

/**
 * M29.5 (ADR-0062): the controller's half of credentials through SCP, driven through the HOOK THE
 * CONTROLLER INSTALLS (`installCredentialHooks`) against an in-memory API server. The envelopes
 * are sealed here by an independent implementation of the same construction (X25519 + HKDF-SHA256
 * + AES-256-GCM with the header as additional data); apps/server's integration suite seals with
 * scpd's own code and opens with this package's.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STACKD_NS = "scp-stackd";
const WF_NS = "scp-argo-workflows";
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function release(): StackRelease {
  return {
    version: "1.0.0",
    chartDir: "chart",
    imageOverrides: {},
    chartValues: {
      bundledExecutor: {
        argocd: { namespace: "scp-argocd" },
        argoWorkflows: { namespace: WF_NS },
        argoEvents: { namespace: "scp-argo-events" },
        argoRollouts: { namespace: "scp-argo-rollouts" },
        gitea: { namespace: "scp-gitea" }
      }
    }
  };
}

function seal(
  publicKeyB64: string,
  d: Omit<StackCredentialDelivery, "envelope">,
  value: string
): StackCredentialDelivery {
  const recipientRaw = Buffer.from(publicKeyB64, "base64");
  const recipient = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, recipientRaw]),
    format: "der",
    type: "spki"
  });
  const eph = generateKeyPairSync("x25519");
  const epk = (eph.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([epk, recipientRaw]), STACK_CREDENTIAL_HKDF_INFO, 32)
  );
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(credentialEnvelopeAad(d)));
  const ct = Buffer.concat([c.update(Buffer.from(value)), c.final()]);
  return {
    ...d,
    envelope: {
      v: 1,
      epk: epk.toString("base64"),
      nonce: nonce.toString("base64"),
      ciphertext: ct.toString("base64"),
      tag: c.getAuthTag().toString("base64")
    }
  };
}

interface Rig {
  kube: FakeKube;
  deps: ControllerDeps;
  published: PutStackCredentialSealingKeyRequest[];
  pending: StackCredentialDelivery[];
  acks: { id: string; req: AckStackCredentialDeliveryRequest }[];
  logs: string[];
  sealed: (
    target: { secretName: string; key: string; op?: StackCredentialOp },
    value: string,
    over?: Partial<StackCredentialDelivery>
  ) => Promise<StackCredentialDelivery>;
  tick: () => Promise<unknown>;
  secret: () => Record<string, string>;
}

let seqCounter = 0;

function rig(): Rig {
  const kube = new FakeKube();
  const client = new KubeClient(kube);
  const published: PutStackCredentialSealingKeyRequest[] = [];
  const pending: StackCredentialDelivery[] = [];
  const acks: Rig["acks"] = [];
  const logs: string[] = [];
  let recorded: string | null = null;
  const deps = {
    api: {
      putSealingKey: async (req: PutStackCredentialSealingKeyRequest) => {
        published.push(req);
        recorded = req.keyId;
      },
      credentialDeliveries: async () => ({ items: structuredClone(pending) }),
      ackCredentialDelivery: async (id: string, req: AckStackCredentialDeliveryRequest) => {
        acks.push({ id, req });
        const i = pending.findIndex((p) => p.deliveryId === id && p.seq === req.seq);
        if (i >= 0) pending.splice(i, 1);
      }
    },
    kube: client,
    release: release(),
    log: (line: string) => logs.push(line)
  } as unknown as ControllerDeps;
  installCredentialHooks(deps, STACKD_NS);
  const r: Rig = {
    kube,
    deps,
    published,
    pending,
    acks,
    logs,
    sealed: async ({ secretName, key, op = "set" }, value, over = {}) => {
      const pair = await loadOrCreateSealingKey(client, STACKD_NS);
      const header = {
        deliveryId: randomUUID(),
        seq: ++seqCounter,
        backend: "argo-workflows" as const,
        secretName: secretName as StackCredentialDelivery["secretName"],
        key: key as StackCredentialDelivery["key"],
        op,
        keyId: pair.keyId,
        // Strictly increasing, as scpd's clock makes them: each seal is later than the last.
        notAfter: new Date(Date.now() + 60_000 + seqCounter).toISOString()
      };
      const d = seal(pair.publicRaw.toString("base64"), header, op === "set" ? value : "");
      return { ...d, ...over };
    },
    tick: () => deps.credentials!.deliver(recorded),
    secret: () => {
      const s = kube.find("Secret", "scp-build-registry", WF_NS);
      return Object.fromEntries(
        Object.entries((s?.["data"] as Record<string, string> | undefined) ?? {}).map(([k, v]) => [
          k,
          Buffer.from(v, "base64").toString()
        ])
      );
    }
  };
  return r;
}

describe("the controller delivers credentials entered through SCP into the backend's own Secret", () => {
  it("publishes its sealing key, then WRITES the opened value into the backend namespace's Secret and confirms", async () => {
    const r = rig();
    await r.tick();
    expect(r.published).toHaveLength(1);
    // The private half stays in the controller's own namespace.
    expect(r.kube.find("Secret", "scp-stackd-sealing-key", STACKD_NS)).toBeDefined();

    const d = await r.sealed(
      { secretName: "scp-build-registry", key: "registryPassword" },
      "tok-1"
    );
    r.pending.push(d);
    await r.tick();
    // THE WRITE STEP: delete `writeCredential`'s apply and this is the line that goes red.
    expect(r.secret()).toEqual({ registryPassword: "tok-1" });
    expect(r.acks).toEqual([{ id: d.deliveryId, req: { outcome: "applied", seq: d.seq } }]);
    // A second key keeps the first (a field manager per key), and a re-set replaces (rotation).
    r.pending.push(
      await r.sealed({ secretName: "scp-build-registry", key: "registryUsername" }, "scp")
    );
    await r.tick();
    r.pending.push(
      await r.sealed({ secretName: "scp-build-registry", key: "registryPassword" }, "tok-2")
    );
    await r.tick();
    expect(r.secret()).toEqual({ registryUsername: "scp", registryPassword: "tok-2" });
    expect(
      r.kube.managers.filter((m) => m.name === "scp-build-registry").map((m) => m.manager)
    ).toEqual([
      "scp-stackd-credential.registryPassword",
      "scp-stackd-credential.registryUsername",
      "scp-stackd-credential.registryPassword"
    ]);
    // Never the value, in any log line.
    expect(r.logs.join("\n")).not.toMatch(/tok-1|tok-2/);
  });

  it("a delete removes just that key", async () => {
    const r = rig();
    await r.tick();
    r.pending.push(await r.sealed({ secretName: "scp-build-registry", key: "gitToken" }, "g"));
    r.pending.push(
      await r.sealed({ secretName: "scp-build-registry", key: "registryHost" }, "h:1")
    );
    await r.tick();
    r.pending.push(
      await r.sealed({ secretName: "scp-build-registry", key: "gitToken", op: "delete" }, "")
    );
    await r.tick();
    expect(r.secret()).toEqual({ registryHost: "h:1" });
    expect(r.acks.at(-1)!.req.outcome).toBe("applied");
  });

  it("a REPLAYED envelope is refused; the controller's own applied delivery whose confirmation was lost is confirmed again, not re-written", async () => {
    const r = rig();
    await r.tick();
    const first = await r.sealed(
      { secretName: "scp-build-registry", key: "registryPassword" },
      "old"
    );
    const second = await r.sealed(
      { secretName: "scp-build-registry", key: "registryPassword" },
      "new"
    );
    r.pending.push(second);
    await r.tick();
    expect(r.secret()["registryPassword"]).toBe("new");
    // A byte-identical copy of an older, genuinely-sealed envelope — someone restoring a row.
    r.pending.push(first);
    await r.tick();
    expect(r.secret()["registryPassword"]).toBe("new");
    expect(r.acks.at(-1)).toEqual({
      id: first.deliveryId,
      req: { outcome: "refused", seq: first.seq, reason: "replayed" }
    });
    // The same delivery again (its ack was lost): confirmed applied, nothing written twice.
    const writes = r.kube.managers.length;
    r.pending.push(second);
    await r.tick();
    expect(r.acks.at(-1)).toEqual({
      id: second.deliveryId,
      req: { outcome: "applied", seq: second.seq }
    });
    expect(r.kube.managers.length).toBe(writes);
  });

  it("a REBUILT scpd (its sequence restarted, found on kind) is not mistaken for a replay: deliveries are ordered by when they were sealed", async () => {
    const r = rig();
    await r.tick();
    r.pending.push(
      await r.sealed({ secretName: "scp-build-registry", key: "registryPassword" }, "before")
    );
    await r.tick();
    // A restored or rebuilt database starts its sequence again; its clock does not go back.
    const pair = await loadOrCreateSealingKey(new KubeClient(r.kube), STACKD_NS);
    const d = seal(
      pair.publicRaw.toString("base64"),
      {
        deliveryId: randomUUID(),
        seq: 1,
        backend: "argo-workflows",
        secretName: "scp-build-registry",
        key: "registryPassword",
        op: "set",
        keyId: pair.keyId,
        notAfter: new Date(Date.now() + 120_000).toISOString()
      },
      "after"
    );
    r.pending.push(d);
    await r.tick();
    expect(r.secret()["registryPassword"]).toBe("after");
    expect(r.acks.at(-1)).toEqual({ id: d.deliveryId, req: { outcome: "applied", seq: 1 } });
  });

  it("a REDIRECTED envelope — its target, op or sequence rewritten — fails the tag and is refused; nothing is written anywhere", async () => {
    const r = rig();
    await r.tick();
    const base = await r.sealed({ secretName: "scp-build-registry", key: "registryPassword" }, "v");
    const redirects: Partial<StackCredentialDelivery>[] = [
      { secretName: "scp-infra-apply-credentials", key: "AWS_SECRET_ACCESS_KEY" },
      { key: "gitToken" },
      { op: "delete" },
      { seq: base.seq + 1000 },
      { deliveryId: randomUUID() }
    ];
    for (const over of redirects) {
      r.pending.push({ ...base, ...over });
      await r.tick();
      expect(r.acks.at(-1)!.req, JSON.stringify(over)).toMatchObject({
        outcome: "refused",
        reason: "tampered"
      });
    }
    expect(r.kube.find("Secret", "scp-build-registry", WF_NS)).toBeUndefined();
    expect(r.kube.find("Secret", "scp-infra-apply-credentials", WF_NS)).toBeUndefined();
  });

  it("refuses an envelope sealed to another key, one past its notAfter, and a target outside the catalog", async () => {
    const r = rig();
    await r.tick();
    const cases: [Partial<StackCredentialDelivery>, string, string][] = [
      [{ keyId: "0".repeat(64) }, "wrong-key", "registryPassword"],
      [{ notAfter: new Date(Date.now() - 1000).toISOString() }, "expired", "registryPassword"],
      // GENUINELY SEALED to a target the catalog does not have (enum-valid names, but AWS keys
      // belong to the infra Secrets) — what anyone holding the public key and the table could
      // make. The tag verifies; the catalog is what refuses it.
      [{}, "not-in-catalog", "AWS_REGION"]
    ];
    for (const [over, reason, key] of cases) {
      r.pending.push(await r.sealed({ secretName: "scp-build-registry", key }, "v", over));
      await r.tick();
      expect(r.acks.at(-1)!.req).toMatchObject({ outcome: "refused", reason });
    }
    expect(r.kube.find("Secret", "scp-build-registry", WF_NS)).toBeUndefined();
  });

  it("names what a ready Argo Workflows still needs entered — key names, from its own Secret", async () => {
    const r = rig();
    const needs = await credentialNeeds(r.deps, "argo-workflows");
    expect(needs).toHaveLength(1);
    expect(needs[0]!.message).toMatch(/registryUsername, registryPassword, registryHost/);
    await r.tick();
    for (const [key, v] of [
      ["registryUsername", "u"],
      ["registryPassword", "p"],
      ["registryHost", "h"]
    ] as const) {
      r.pending.push(await r.sealed({ secretName: "scp-build-registry", key }, v));
    }
    await r.tick();
    expect(await credentialNeeds(r.deps, "argo-workflows")).toEqual([]);
    expect(await credentialNeeds(r.deps, "gitea")).toEqual([]);
  });
});

describe("the catalog's Secret names are the ones the bundled chart mounts", () => {
  it("every catalog Secret is a credentialsSecret the chart's defaults render", () => {
    const values = parse(
      readFileSync(path.join(HERE, "../../../deploy/helm-bundled/values.yaml"), "utf8")
    ) as {
      bundledExecutor: {
        argoWorkflows: {
          catalog: {
            credentialsSecret: string;
            infra: { plan: { credentialsSecret: string }; apply: { credentialsSecret: string } };
          };
        };
      };
    };
    const c = values.bundledExecutor.argoWorkflows.catalog;
    expect(Object.keys(STACK_CREDENTIAL_CATALOG["argo-workflows"]).sort()).toEqual(
      [c.credentialsSecret, c.infra.plan.credentialsSecret, c.infra.apply.credentialsSecret].sort()
    );
  });
});

describe("workload identity: the provider's annotation on the declared ServiceAccount, in the render", () => {
  const objects = (): KubeObject[] => [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "scp-infra-plan", namespace: WF_NS }
    },
    {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "WorkflowTemplate",
      metadata: { name: "scp-infra-plan-v1", namespace: WF_NS },
      spec: { serviceAccountName: "scp-infra-plan" }
    },
    {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "WorkflowTemplate",
      metadata: { name: "scp-build-image-v1", namespace: WF_NS },
      spec: { serviceAccountName: "scp-build" }
    }
  ];

  it("IRSA: the role-arn annotation on the ServiceAccount, and a digest on its pods so they pick it up", () => {
    const objs = objects();
    const needs = applyWorkloadIdentities("argo-workflows", objs, [
      {
        backend: "argo-workflows",
        serviceAccount: "scp-infra-plan",
        provider: "aws-irsa",
        identifier: "arn:aws:iam::123456789012:role/scp-plan"
      }
    ]);
    expect(needs).toEqual([]);
    expect(objs[0]!.metadata["annotations"]).toEqual({
      "eks.amazonaws.com/role-arn": "arn:aws:iam::123456789012:role/scp-plan"
    });
    expect(JSON.stringify(objs[1]!["spec"])).toContain(WORKLOAD_IDENTITY_ANNOTATION);
    // The build identity is never touched.
    expect(JSON.stringify(objs[2])).not.toContain(WORKLOAD_IDENTITY_ANNOTATION);
  });

  it("Azure: the client-id annotation AND the webhook's pod label", () => {
    const objs = objects();
    applyWorkloadIdentities("argo-workflows", objs, [
      {
        backend: "argo-workflows",
        serviceAccount: "scp-infra-plan",
        provider: "azure-workload-identity",
        identifier: "0f8fad5b-d9cb-469f-a165-70867728950e"
      }
    ]);
    expect(objs[0]!.metadata["annotations"]).toEqual({
      "azure.workload.identity/client-id": "0f8fad5b-d9cb-469f-a165-70867728950e"
    });
    expect(
      (objs[1]!["spec"] as { podMetadata: { labels: Record<string, string> } }).podMetadata.labels
    ).toEqual({ "azure.workload.identity/use": "true" });
  });

  it("a declaration whose ServiceAccount this render does not contain is a need, not silence", () => {
    const needs = applyWorkloadIdentities(
      "argo-workflows",
      [],
      [
        {
          backend: "argo-workflows",
          serviceAccount: "scp-infra-apply",
          provider: "gke-workload-identity",
          identifier: "scp-apply@my-project.iam.gserviceaccount.com"
        }
      ]
    );
    expect(needs).toEqual([expect.objectContaining({ code: "credentials" })]);
  });
});
