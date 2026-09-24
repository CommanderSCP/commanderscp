import {
  constants as cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempTrackedForFile } from "@scp/test-tmpdir";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient, ScpApiError } from "@scp/sdk";
import type { TrustDomainId } from "@scp/schemas";
import type { PluginContext, TriggerIntent, ExecutorPlugin } from "@scp/plugin-api";
import { argoWorkflowsExecutorPlugin } from "@scp/plugin-argo-workflows";
import { createManagedOpsExecutorPlugin, readServerDerivedMaterial } from "@scp/plugin-managed-ops";
import type { ResolveRunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import { createFakeExecutorPlugin } from "@scp/plugin-fake-executor";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, objects, opsRunRedemptions, sshCertificateIssuances } from "../db/schema.js";
import type { PluginHost, PluginHostInstanceConfig } from "../plugin-host/contract.js";
import { getSecretValue } from "../secrets/secrets-repo.js";
import { reconcileOrgTick } from "./reconcile.js";
import { enrolDomain, reconcileSerials } from "./ssh-ca-repo.js";
import { replaceMembership } from "./infrastructure-members-repo.js";
import { deriveOpsRunMaterial, OpsMaterialUnavailable } from "./ops-run-material.js";
import { OpsDeclarationRefused, opsLaneTriggerParameters } from "./ops-lane-trigger-parameters.js";
import { generateEphemeralSshKeypair } from "./ssh-credentials.js";
import { opsRedemptionRateLimiter } from "../routes/ops-run-redemptions.js";

/**
 * M28.2 — HOST OPS THROUGH AN ORG'S ARGO WORKFLOWS, through the REAL reconcile loop and the REAL
 * `argo-workflows` plugin (only its HTTP transport is a fake Argo server).
 *
 * The four DoD claims this file is the proof of, each written so deleting the thing it is about
 * turns it red:
 *
 *   - ONE DERIVATION FEEDS BOTH EXECUTORS. The bound the Argo pod redeems equals what Mode C's
 *     orchestrator stages into its container for the same declaration, and what
 *     `deriveOpsRunMaterial` returns — compared as values, not shapes.
 *   - `scpd` LAUNCHES NOTHING ON THE ARGO PATH. The launcher this host hands `managed-ops` THROWS
 *     while the Argo case runs, and `@scp/runner-launcher` is replaced by a module whose every
 *     function throws — so a launcher call added anywhere on the path fails the trigger.
 *   - THE WORKFLOW CARRIES NO SECRET. Its parameters are exactly a run id and ciphertext.
 *   - REFUSALS ARE IDENTICAL. The same declaration refused the same way on both paths, and a
 *     rollback derives nothing.
 */

// ---- the launcher double, installed at the module boundary --------------------------------------
const launcherTouches = vi.hoisted(() => [] as string[]);
/** The package's LAUNCH entry points. Its bounded-text helpers are used all over the server and
 *  stay real; everything that could construct or run a container throws. */
const LAUNCH_ENTRY_POINTS = vi.hoisted(() => [
  "resolveRunnerLauncher",
  "createDockerRunnerLauncher",
  "createKubernetesRunnerLauncher"
]);
vi.mock("@scp/runner-launcher", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const mocked: Record<string, unknown> = { ...real };
  for (const name of LAUNCH_ENTRY_POINTS) {
    mocked[name] = () => {
      launcherTouches.push(name);
      throw new Error(`@scp/runner-launcher.${name} was called (test double)`);
    };
  }
  return mocked;
});

const ARGO_URL = "https://argo.example.test";
const NAMESPACE = "scp-argo-workflows";

interface Submission {
  resourceName: string;
  parameters: Record<string, string>;
}

describe("host ops through Argo Workflows (M28.2, Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let anonymous: ScpClient;
  let productId: string;
  let domainId: TrustDomainId;
  let host: PluginHost;
  const submissions: Submission[] = [];
  /** What the fake Argo reports for every Workflow. `Running` by default: a real Workflow cannot
   *  finish before its pod has redeemed, and the redeem door refuses a change that is no longer
   *  executing. */
  let argoPhase = "Running";
  /** When armed, the managed-ops launcher THROWS — the Argo path must never reach it. */
  let launcherArmed = true;
  const modeCStaged: {
    spec: RunnerSpec;
    inventory: string;
    params: Record<string, unknown>;
    credential: { privateKeyPem: string; certificate: string };
  }[] = [];

  const sealing = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const sealingPublicPem = sealing.publicKey.export({ type: "spki", format: "pem" }).toString();

  const DECLARATION = {
    role: "os_package",
    arguments: { name: "htop", state: "present", note: "{{ lookup('pipe', 'id') }}" }
  };

  const envBefore = {
    image: process.env.SCP_MANAGED_OPS_RUNNER_IMAGE,
    key: process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY
  };

  function unseal(sealed: string): string {
    return privateDecrypt(
      {
        key: sealing.privateKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(sealed, "base64")
    ).toString("utf8");
  }

  const recordingLauncher: ResolveRunnerLauncher = () =>
    ({
      run: async (spec: RunnerSpec) => {
        if (launcherArmed) {
          launcherTouches.push("managed-ops launcher.run");
          throw new Error("the managed-ops launcher was reached (test double, armed)");
        }
        const dir = spec.copyIn![0]!.hostDir;
        modeCStaged.push({
          spec,
          inventory: await readFile(join(dir, "inventory.ini"), "utf8"),
          params: JSON.parse(await readFile(join(dir, "params.json"), "utf8")),
          credential: JSON.parse(await readFile(join(dir, "ssh-credential"), "utf8"))
        });
        return { succeeded: true, stdout: "", stderr: "", exitCode: 0 } as never;
      },
      reap: async () => undefined
    }) as never;

  /** The fake Argo server — the only fake in the path. */
  async function argoHttp(req: { method: string; url: string; body?: unknown }) {
    if (req.method === "POST" && req.url === `${ARGO_URL}/api/v1/workflows/${NAMESPACE}/submit`) {
      const body = req.body as {
        resourceName: string;
        submitOptions?: { parameters?: string[] };
      };
      const parameters = Object.fromEntries(
        (body.submitOptions?.parameters ?? []).map((p) => {
          const i = p.indexOf("=");
          return [p.slice(0, i), p.slice(i + 1)];
        })
      );
      submissions.push({ resourceName: body.resourceName, parameters });
      return {
        status: 200,
        headers: {},
        body: {
          metadata: { name: `${body.resourceName}-${randomUUID().slice(0, 5)}`, uid: randomUUID() }
        }
      };
    }
    if (req.method === "GET") {
      return {
        status: 200,
        headers: {},
        body: { metadata: { name: "x" }, status: { phase: argoPhase } }
      };
    }
    return { status: 404, headers: {}, body: {} };
  }

  function buildHost(): PluginHost {
    const started = new Map<string, PluginHostInstanceConfig>();
    const fake = createFakeExecutorPlugin();
    const managedOps = createManagedOpsExecutorPlugin(recordingLauncher);
    const pluginFor = (module: string): ExecutorPlugin =>
      module === "argo-workflows"
        ? argoWorkflowsExecutorPlugin
        : module === "managed-ops"
          ? managedOps
          : fake;
    const ctxFor = (cfg: PluginHostInstanceConfig | undefined): PluginContext => ({
      orgId: cfg?.orgId ?? "test",
      scopeKey: cfg?.scopeKey ?? "test",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      secrets: {
        get: async (key: string) =>
          cfg?.secrets?.[key] ??
          (await withTenantTx(server.deps.db, org.orgId, (tx) =>
            getSecretValue(tx, org.orgId, key, server.deps.config.secretsMasterKey)
          )) ??
          undefined
      },
      http: { request: argoHttp as never },
      config: cfg?.config ?? {}
    });
    const refuse = () => {
      throw new Error("not wired in this fixture");
    };
    return {
      async start(configs) {
        for (const c of configs) started.set(c.id, c);
      },
      async stop() {},
      async stopInstances() {},
      executor(id) {
        const cfg = started.get(id);
        const plugin = pluginFor(cfg?.module ?? "fake-executor");
        const ctx = ctxFor(cfg);
        return {
          observe: (since) => plugin.observe(ctx, since),
          trigger: (intent: TriggerIntent) => plugin.trigger(ctx, intent),
          status: (ref) => plugin.status(ctx, ref),
          abort: (ref) => plugin.abort(ctx, ref),
          describeCapabilities: async () => plugin.describeCapabilities()
        };
      },
      control: refuse,
      discovery: refuse,
      notification: refuse,
      federationTransport: refuse,
      dependencyIndex: refuse,
      gitFileRead: refuse
    } as PluginHost;
  }

  const tick = async (times = 2) => {
    for (let i = 0; i < times; i++) {
      await reconcileOrgTick(
        server.deps.db,
        org.orgId,
        host,
        server.deps.celSandbox!,
        server.deps.config.secretsMasterKey
      );
    }
  };

  async function bindArgo(
    targetId: string,
    extra: { externalRef?: string; sealing?: string | null; sourceAddresses?: string[] } = {}
  ) {
    await admin.executors.putBinding(targetId, {
      pluginModule: "argo-workflows",
      pluginInstanceId: `argo-ops-${randomUUID().slice(0, 8)}`,
      type: "configuration",
      externalRef: extra.externalRef ?? "scp-ops-v1",
      allowedHosts: ["argo.example.test"],
      config: {
        serverUrl: ARGO_URL,
        namespace: NAMESPACE,
        ...(extra.sealing === null
          ? {}
          : { opsSealingPublicKey: extra.sealing ?? sealingPublicPem }),
        ...(extra.sourceAddresses ? { opsSourceAddresses: extra.sourceAddresses } : {})
      }
    });
  }

  const propose = (targetId: string, properties: Record<string, unknown> = { ops: DECLARATION }) =>
    admin.changes.propose({
      name: `ops-${randomUUID().slice(0, 8)}`,
      targets: [targetId],
      properties
    });

  const redemptionRows = () =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(opsRunRedemptions).where(eq(opsRunRedemptions.orgId, org.orgId))
    );

  const auditActions = async (subjectId: string) =>
    (
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .select({ action: auditEvents.action, reason: auditEvents.reason })
          .from(auditEvents)
          .where(and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.subjectId, subjectId)))
      )
    ).filter((e) => e.action.startsWith("ops.run_redemption."));

  /** One Argo run, end to end up to the Workflow submit. Returns the submission and the unsealed token. */
  async function argoRun(sourceAddresses?: string[]) {
    const product = await fleet();
    await bindArgo(product, sourceAddresses ? { sourceAddresses } : {});
    const change = await propose(product);
    const before = submissions.length;
    await tick();
    // THE LAUNCHER ABSENCE, checked FIRST: a launcher call on this path fails the trigger, and the
    // resulting "nothing was submitted" would otherwise be reported as the wrong reason.
    expect(launcherTouches, "scpd must launch NOTHING on the Argo path").toEqual([]);
    const mine = submissions.slice(before);
    expect(mine, "the Argo-bound ops target must be SUBMITTED as a Workflow").toHaveLength(1);
    const sub = mine[0]!;
    expect(
      sub.parameters,
      "the Argo ops lane must deliver a SEALED run token — without it the pod has no way to its material"
    ).toHaveProperty("opsRunTokenSealed");
    return { product, change, sub, token: unseal(sub.parameters["opsRunTokenSealed"]!) };
  }

  /** A product in the enrolled domain with two observed members. */
  async function fleet(): Promise<string> {
    const c = await createTestComponent(admin, { name: `fleet-${randomUUID().slice(0, 8)}` });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      replaceMembership(tx, {
        orgId: org.orgId,
        productObjectId: c.id,
        reportedBySubjectId: randomUUID(),
        members: [
          { memberId: "i-002", address: "10.0.0.2" },
          { memberId: "i-001", address: "10.0.0.1" }
        ]
      })
    );
    return c.id;
  }

  beforeAll(async () => {
    server = await listenTestServer({});
    org = await createTestOrg(server, "ops-argo");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    anonymous = new ScpClient({ baseUrl: server.baseUrl });
    host = buildHost();
    productId = await fleet();
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ d: objects.originDomainId }).from(objects).where(eq(objects.id, productId))
    );
    domainId = row!.d as TrustDomainId;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      enrolDomain(tx, {
        orgId: org.orgId,
        domainId,
        breakGlass: "OOB console on the management VLAN",
        masterKey: server.deps.config.secretsMasterKey,
        recordedBySubjectId: randomUUID()
      })
    );
  }, 180_000);

  beforeEach(() => {
    argoPhase = "Running";
    launcherArmed = true;
    launcherTouches.length = 0;
    opsRedemptionRateLimiter.reset();
  });

  afterEach(() => {
    delete process.env.SCP_MANAGED_OPS_RUNNER_IMAGE;
    delete process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY;
    delete process.env.SCP_MANAGED_OPS_WORKSPACE_ROOT;
  });

  afterAll(async () => {
    if (envBefore.image) process.env.SCP_MANAGED_OPS_RUNNER_IMAGE = envBefore.image;
    if (envBefore.key) process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY = envBefore.key;
    await server?.close();
  });

  it("submits scp-ops-v1 carrying ONLY a run id and ciphertext — and scpd launches nothing", async () => {
    const { sub, token } = await argoRun();
    expect(sub.resourceName).toBe("scp-ops-v1");
    // THE EXACT KEY SET. Anything else on a Workflow is persisted in etcd, the Argo UI and the
    // archive; a host, a role or a credential here would be readable by anyone who can list them.
    expect(Object.keys(sub.parameters).sort()).toEqual(["opsRunId", "opsRunTokenSealed"]);
    const all = JSON.stringify(sub.parameters);
    expect(all).not.toContain("scpops1.");
    expect(all).not.toContain("10.0.0.");
    expect(all).not.toContain("BEGIN");
    // It IS a token for this run once unsealed with the operator's key.
    expect(token.startsWith(`scpops1.${org.orgId}.${sub.parameters["opsRunId"]}.`)).toBe(true);
    // THE LAUNCHER ABSENCE — both doubles untouched.
    expect(launcherTouches).toEqual([]);
  });

  it("ONE DERIVATION: the bound the pod redeems equals what Mode C stages and what deriveOpsRunMaterial returns", async () => {
    const { product, change, token } = await argoRun();
    const pod = generateEphemeralSshKeypair();
    const redeemed = await anonymous.opsRuns.redeem(token, pod.openSshPublicKey);

    // (1) the Mode C derivation, for the same change against the same product.
    const modeC = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deriveOpsRunMaterial(tx, {
        orgId: org.orgId,
        domainId,
        productObjectId: product,
        role: DECLARATION.role,
        subjectObjectId: change.id,
        masterKey: server.deps.config.secretsMasterKey
      })
    );
    const bound = (m: Record<string, unknown>) => ({
      opsRole: m["opsRole"],
      opsInventory: m["opsInventory"],
      opsEgressAllowlist: m["opsEgressAllowlist"],
      opsPrincipals: m["opsPrincipals"]
    });
    expect(bound(redeemed)).toEqual(bound(modeC));
    // The Mode C CONSUMER accepts the Argo bound as complete — the reader decides, not this test.
    expect(() =>
      readServerDerivedMaterial({ ...bound(redeemed), opsCredentialSecretKey: "ops/run/x" })
    ).not.toThrow();
    expect(redeemed.roleArguments).toEqual(DECLARATION.arguments);

    // (2) the Mode C ORCHESTRATOR, for the same declaration: rebind to managed-ops, run reconcile,
    //     and read what it actually staged into the container it launched.
    process.env.SCP_MANAGED_OPS_RUNNER_IMAGE = "scp-runner-ops:test";
    process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY = "ops/catalog-pubkey";
    process.env.SCP_MANAGED_OPS_WORKSPACE_ROOT = await mkdtempTrackedForFile(
      join(tmpdir(), "scp-ops-argo-modec-")
    );
    launcherArmed = false;
    await admin.executors.putBinding(product, {
      pluginModule: "managed-ops",
      pluginInstanceId: `managed-ops-${randomUUID().slice(0, 8)}`,
      type: "configuration",
      config: {}
    });
    const stagedBefore = modeCStaged.length;
    await propose(product);
    await tick();
    const staged = modeCStaged.slice(stagedBefore);
    expect(staged, "Mode C must launch exactly one container for its change").toHaveLength(1);
    expect(staged[0]!.inventory).toBe(redeemed.opsInventory);
    expect([...(staged[0]!.spec.egressAllowlist ?? [])]).toEqual(redeemed.opsEgressAllowlist);
    expect(staged[0]!.params).toEqual(redeemed.roleArguments);
    expect(staged[0]!.spec.env).toContain(`SCP_OPS_ROLE=${redeemed.opsRole}`);
  });

  it("the certificate is issued over the POD's key, recorded as an issuance, and reconciles", async () => {
    const { token, sub } = await argoRun();
    const pod = generateEphemeralSshKeypair();
    const redeemed = await anonymous.opsRuns.redeem(token, pod.openSshPublicKey);
    expect(redeemed.certificate.startsWith("ssh-ed25519-cert-v01@openssh.com ")).toBe(true);
    // The cert embeds the pod's raw key: its 32 bytes appear in the certificate blob.
    const podRaw = Buffer.from(pod.openSshPublicKey.split(" ")[1]!, "base64").subarray(-32);
    expect(Buffer.from(redeemed.certificate.split(" ")[1]!, "base64").includes(podRaw)).toBe(true);
    expect(redeemed.keyId).toContain(`:run=${sub.parameters["opsRunId"]}`);
    // TTL no looser than Mode C's 600s.
    expect(new Date(redeemed.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(600_000);
    const [verdict] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      reconcileSerials(tx, org.orgId, [redeemed.serial])
    );
    expect(verdict!.unrecognised).toBe(false);
    const [row] = (await redemptionRows()).filter((r) => r.id === sub.parameters["opsRunId"]);
    expect(row!.issuedSerial).toBe(redeemed.serial);
    expect(redeemed.sourceAddress).toBeNull();
  });

  it("carries the binding's source addresses as the certificate's `source-address`, and records it", async () => {
    const { token } = await argoRun(["10.42.0.0/16", "192.168.5.7"]);
    const redeemed = await anonymous.opsRuns.redeem(
      token,
      generateEphemeralSshKeypair().openSshPublicKey
    );
    expect(redeemed.sourceAddress).toBe("10.42.0.0/16,192.168.5.7");
    const blob = Buffer.from(redeemed.certificate.split(" ")[1]!, "base64");
    expect(blob.includes(Buffer.from("source-address"))).toBe(true);
    expect(blob.includes(Buffer.from("10.42.0.0/16,192.168.5.7"))).toBe(true);
    const [issuance] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(sshCertificateIssuances)
        .where(
          and(
            eq(sshCertificateIssuances.orgId, org.orgId),
            eq(sshCertificateIssuances.serial, redeemed.serial)
          )
        )
    );
    expect(issuance!.sourceAddress).toBe("10.42.0.0/16,192.168.5.7");
  });

  it("SINGLE-USE: a second presentation of the right secret is refused (409) and audited as the stolen-token signal", async () => {
    const { token, change } = await argoRun();
    await anonymous.opsRuns.redeem(token, generateEphemeralSshKeypair().openSshPublicKey);
    const second = anonymous.opsRuns.redeem(token, generateEphemeralSshKeypair().openSshPublicKey);
    await expect(second).rejects.toBeInstanceOf(ScpApiError);
    await expect(second).rejects.toMatchObject({ status: 409 });
    const events = await auditActions(change.id);
    expect(events.map((e) => e.action)).toEqual([
      "ops.run_redemption.redeemed",
      "ops.run_redemption.refused"
    ]);
    expect(events[1]!.reason).toContain("replayed");
  });

  it("a WRONG secret is 401, counted, and BURNS the run at the limit — then even the right one is refused", async () => {
    const { token, change } = await argoRun();
    const forged = `${token.slice(0, token.lastIndexOf(".") + 1)}${"A".repeat(43)}`;
    for (let i = 0; i < 3; i++) {
      await expect(
        anonymous.opsRuns.redeem(forged, generateEphemeralSshKeypair().openSshPublicKey)
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      anonymous.opsRuns.redeem(token, generateEphemeralSshKeypair().openSshPublicKey)
    ).rejects.toMatchObject({ status: 409 });
    const events = await auditActions(change.id);
    expect(events.filter((e) => e.reason?.includes("bad_secret"))).toHaveLength(3);
    expect(events.at(-1)!.reason).toContain("burned");
  });

  it("a CANCELLED change's token buys nothing — 409, audited, no certificate", async () => {
    const { token, change, sub } = await argoRun();
    await admin.changes.cancel(change.id, "operator stopped the package change");
    await expect(
      anonymous.opsRuns.redeem(token, generateEphemeralSshKeypair().openSshPublicKey)
    ).rejects.toMatchObject({ status: 409 });
    expect((await auditActions(change.id)).at(-1)!.reason).toContain("change_not_executing");
    const [row] = (await redemptionRows()).filter((r) => r.id === sub.parameters["opsRunId"]);
    expect(row!.issuedSerial).toBeNull();
  });

  it("EXPIRED: a token past its window is 410 and audited", async () => {
    const { token, sub, change } = await argoRun();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(opsRunRedemptions)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(opsRunRedemptions.id, sub.parameters["opsRunId"]!))
    );
    await expect(
      anonymous.opsRuns.redeem(token, generateEphemeralSshKeypair().openSshPublicKey)
    ).rejects.toMatchObject({ status: 410 });
    expect((await auditActions(change.id)).at(-1)!.reason).toContain("expired");
  });

  it("an UNKNOWN run is 401 with no audit event (an attacker-chosen org id must not write to its chain)", async () => {
    const before = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.orgId, org.orgId))
    );
    await expect(
      anonymous.opsRuns.redeem(
        `scpops1.${org.orgId}.${randomUUID()}.${"B".repeat(43)}`,
        generateEphemeralSshKeypair().openSshPublicKey
      )
    ).rejects.toMatchObject({ status: 401 });
    const after = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.orgId, org.orgId))
    );
    expect(after.length).toBe(before.length);
  });

  it("RATE-LIMITED per caller address: the eleventh guess in a burst is 429", async () => {
    const guess = () =>
      anonymous.opsRuns
        .redeem(`scpops1.${org.orgId}.${randomUUID()}.${"C".repeat(43)}`, "ssh-ed25519 AAAA")
        .catch((e: { status?: number }) => e.status);
    const statuses: (number | undefined)[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await guess()) as number | undefined);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("NO SEALING KEY → refused: no Workflow is submitted and no redemption row exists", async () => {
    const product = await fleet();
    await bindArgo(product, { sealing: null });
    const rowsBefore = (await redemptionRows()).length;
    const before = submissions.length;
    await propose(product);
    await tick();
    expect(submissions.length).toBe(before);
    expect((await redemptionRows()).length).toBe(rowsBefore);
  });

  it("an Argo binding to a NON-catalog template derives nothing — SCP's CA never serves an org-authored template", async () => {
    const product = await fleet();
    await bindArgo(product, { externalRef: "org-own-template" });
    const rowsBefore = (await redemptionRows()).length;
    const before = submissions.length;
    await propose(product);
    await tick();
    const mine = submissions.slice(before);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.parameters).not.toHaveProperty("opsRunTokenSealed");
    expect((await redemptionRows()).length).toBe(rowsBefore);
  });

  it("a recipe naming a BOUND key is refused (ADR-0052) — nothing is submitted", async () => {
    const product = await fleet();
    await bindArgo(product);
    const before = submissions.length;
    await propose(product, {
      ops: DECLARATION,
      recipe: {
        version: 1,
        trigger: {
          kind: "workflow_dispatch",
          parameters: { opsInventory: "evil ansible_host=1.2.3.4" }
        }
      }
    });
    await tick();
    expect(submissions.length).toBe(before);
  });

  it("REFUSALS ARE IDENTICAL on both paths: no declared op, and an unenrolled domain", async () => {
    const product = await fleet();
    const noOps = await propose(product, {});
    const call = (pluginModule: string, orgId = org.orgId, target = product, changeId = noOps.id) =>
      withTenantTx(server.deps.db, orgId, (tx) =>
        opsLaneTriggerParameters(tx, {
          orgId,
          targetObjectId: target,
          changeObjectId: changeId,
          pluginModule,
          externalRef: pluginModule === "argo-workflows" ? "scp-ops-v1" : null,
          waveTargetId: randomUUID(),
          executorConfig: { opsSealingPublicKey: sealingPublicPem },
          masterKey: server.deps.config.secretsMasterKey
        })
      );
    const modeC = await call("managed-ops").catch((e: Error) => e);
    const argo = await call("argo-workflows").catch((e: Error) => e);
    expect(modeC).toBeInstanceOf(OpsDeclarationRefused);
    expect(argo).toBeInstanceOf(OpsDeclarationRefused);
    expect((argo as Error).message).toBe((modeC as Error).message);

    // A SECOND ORG, never enrolled — same product shape, same declaration.
    const other = await createTestOrg(server, "ops-argo-unenrolled");
    const otherAdmin = new ScpClient({ baseUrl: server.baseUrl, token: other.adminToken });
    const otherProduct = (
      await createTestComponent(otherAdmin, { name: `fleet-${randomUUID().slice(0, 8)}` })
    ).id;
    const otherChange = await otherAdmin.changes.propose({
      name: `ops-${randomUUID().slice(0, 8)}`,
      targets: [otherProduct],
      properties: { ops: DECLARATION }
    });
    const modeCU = await call("managed-ops", other.orgId, otherProduct, otherChange.id).catch(
      (e: Error) => e
    );
    const argoU = await call("argo-workflows", other.orgId, otherProduct, otherChange.id).catch(
      (e: Error) => e
    );
    expect(modeCU).toBeInstanceOf(OpsMaterialUnavailable);
    expect(argoU).toBeInstanceOf(OpsMaterialUnavailable);
    expect((argoU as Error).message).toBe((modeCU as Error).message);
    expect((modeCU as Error).message).toMatch(/not enrolled/);
  });

  it("a ROLLBACK derives nothing on the Argo path — no token, no redemption row", async () => {
    const product = await fleet();
    await bindArgo(product);
    argoPhase = "Succeeded";
    const original = await propose(product);
    await tick(8);
    await admin.changes.accept(original.id);
    const rowsBefore = (await redemptionRows()).length;
    const before = submissions.length;
    await admin.changes.rollback(original.id, "integration: undo the package change");
    await tick(6);
    const mine = submissions.slice(before);
    expect(mine.length, "the rollback must still reach its executor").toBeGreaterThan(0);
    for (const s of mine) expect(s.parameters).not.toHaveProperty("opsRunTokenSealed");
    expect((await redemptionRows()).length).toBe(rowsBefore);
    expect(launcherTouches).toEqual([]);
  });
});
