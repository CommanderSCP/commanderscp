import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { ScpClient } from "@scp/sdk";
import type { TrustDomainId } from "@scp/schemas";
import type { TriggerIntent } from "@scp/plugin-api";
import { resolveRunnerImage } from "@scp/plugin-testkit";
import { mkdtempTrackedForFile } from "@scp/test-tmpdir";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, opsRunRedemptions } from "../db/schema.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { reconcileOrgTick } from "./reconcile.js";
import { enrolDomain, reconcileSerials } from "./ssh-ca-repo.js";
import { replaceMembership } from "./infrastructure-members-repo.js";

/**
 * M28.2 — THE ARGO PATH, against a real `sshd` and a real host (the M27.9 e2e is the precedent).
 *
 * The producer is the REAL reconcile loop: a change is proposed against a product bound to
 * `argo-workflows` on `scp-ops-v1` whose endpoint matches the domain's Argo ops PIN, and the
 * parameters reconcile hands the executor are captured. The consumer is the REAL `scp-runner-ops`
 * image, started the way `scp-ops-v1` starts it — the sealed token in `SCP_OPS_RUN_TOKEN_SEALED`,
 * the sealing key and a SIGNED catalog mounted read-only, a read-only root filesystem, every
 * capability dropped — and it unseals, generates its own key, redeems over HTTP, and a real `sshd`
 * decides whether the certificate is good.
 *
 * WHAT THIS DOES NOT RUN: Argo itself. The executor is a capturing stub (the real argo-workflows
 * plugin, its template read-back and its submit are proved in ops-argo-lane.integration.test.ts),
 * and the container is launched with `docker run` carrying the env and mounts the template renders.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const RUNNER_OPS_CONTEXT = resolve(REPO_ROOT, "apps/runner-ops");
const SSHD_FIXTURE_CONTEXT = resolve(REPO_ROOT, "tools/sshd-fixture");
const ARGO_URL = "https://argo.e2e.example.test";
const NAMESPACE = "scp-argo-workflows";
const RUNNER_DIGEST = `sha256:${"c".repeat(64)}`;

let dockerReady = false;
let runnerImage = "";
let sshdImage = "";
let sshd: StartedTestContainer | undefined;
let server: ListeningTestServer;
let org: TestOrg;
let admin: ScpClient;
let productId: string;
let domainId: TrustDomainId;
let sealDir: string;
/** A signed copy of the catalog + the cosign public key: verification is mandatory on this path. */
let signedDir: string;
let hostAddress = "";
/** The address a `--network host` container presents to the fixture: the bridge gateway. */
let gatewayAddress = "";
const captured: TriggerIntent[] = [];

const sealing = generateKeyPairSync("rsa", { modulusLength: 3072 });
const sealingPublicPem = sealing.publicKey.export({ type: "spki", format: "pem" }).toString();
const sealingPrivatePem = sealing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** A skip that is VISIBLE — see ops-host-run.e2e.integration.test.ts for why not `it.runIf`. */
function expectSkipped(): void {
  console.warn(
    "[ops-argo-run.e2e] no reachable Docker daemon — the Argo-path host-reaching proof did NOT run"
  );
  expect(dockerReady).toBe(false);
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** A host whose every executor CAPTURES the trigger and reports it running — so the wave target is
 *  genuinely in flight when the pod redeems, as it is while a real Workflow runs. */
const capturingHost: PluginHost = {
  async start() {},
  async stop() {},
  async stopInstances() {},
  executor() {
    return {
      observe: async () => [],
      trigger: async (intent: TriggerIntent) => {
        captured.push(intent);
        return { externalId: `wf-${randomUUID().slice(0, 8)}` };
      },
      status: async () => ({ phase: "running", detail: "running" }),
      abort: async () => ({ aborted: false, detail: "n/a" }),
      describeCapabilities: async () => ({
        supportsObserve: true,
        supportsTrigger: true,
        supportsAbort: true,
        triggerKinds: ["workflow_dispatch", "sync"]
      })
    };
  },
  control: () => {
    throw new Error("not wired");
  },
  discovery: () => {
    throw new Error("not wired");
  },
  notification: () => {
    throw new Error("not wired");
  },
  federationTransport: () => {
    throw new Error("not wired");
  },
  dependencyIndex: () => {
    throw new Error("not wired");
  },
  gitFileRead: () => {
    throw new Error("not wired");
  }
} as PluginHost;

/** Pin the domain, through the public door. `sourceAddresses` is what every certificate carries. */
async function pin(sourceAddresses: string[]): Promise<void> {
  await admin.sshCa.pinArgoOps(domainId, {
    serverUrl: ARGO_URL,
    namespace: NAMESPACE,
    templateRef: "scp-ops-v1",
    sealingPublicKey: sealingPublicPem,
    sourceAddresses,
    runnerImageDigest: RUNNER_DIGEST,
    redeemUrl: server.baseUrl.replace(/\/api\/v1\/?$/, "")
  });
}

/** Mint an Argo-path run through the REAL reconcile loop, for a fresh change. */
async function mintArgoRun(declaration: {
  role: string;
  arguments: Record<string, unknown>;
}): Promise<{ sealed: string; runId: string; changeId: string }> {
  const change = await admin.changes.propose({
    name: `ops-argo-e2e-${randomUUID().slice(0, 8)}`,
    targets: [productId],
    properties: { ops: declaration }
  });
  const before = captured.length;
  for (let i = 0; i < 4 && captured.length === before; i++) {
    await reconcileOrgTick(
      server.deps.db,
      org.orgId,
      capturingHost,
      server.deps.celSandbox!,
      server.deps.config.secretsMasterKey
    );
  }
  const intent = captured.slice(before).find((c) => c.parameters?.["opsRunTokenSealed"]);
  expect(intent, "reconcile must submit the Argo ops run with a sealed token").toBeDefined();
  return {
    sealed: intent!.parameters!["opsRunTokenSealed"] as string,
    runId: intent!.parameters!["opsRunId"] as string,
    changeId: change.id
  };
}

/** Start the runner EXACTLY as scp-ops-v1 does: sealed token in env, sealing key and signed catalog
 *  as read-only mounts, read-only root, /work and /tmp writable, no capabilities. */
async function runArgoRunner(
  sealed: string,
  extraEnv: string[] = []
): Promise<{ output: string; ok: boolean }> {
  const apiUrl = server.baseUrl.replace(/\/api\/v1\/?$/, "");
  const args = [
    "run",
    "--rm",
    // The server listens on 127.0.0.1, and the fixture sits on a docker bridge the host routes to:
    // host networking reaches both, as an in-cluster pod reaches SCP's Service and the hosts.
    "--network",
    "host",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    // /work is a TMPFS owned by the image's uid — the emptyDir it is in the pod, and NOT a bind
    // mount. Measured in CI (#414's first run): with a bind mount the runner creates
    // `/work/.ansible/cp` as ITS uid, which differs from the CI runner's, and the tracked-tmpdir
    // sweep then fails with EACCES on rmdir. This box's uid happens to equal the image's, so it
    // passed here — the cross-uid class M27.9 recorded, met again.
    "--tmpfs",
    "/work:rw,uid=1000,gid=1000,mode=0755",
    "-v",
    `${sealDir}:/var/run/scp-ops/sealing:ro`,
    // THE SIGNED CATALOG, verified in the runner — mandatory on the Argo path (run.sh refuses off).
    "-v",
    `${join(signedDir, "catalog")}:/catalog:ro`,
    "-v",
    `${signedDir}:/keys:ro`,
    "-e",
    "SCP_OPS_CATALOG_PUBKEY=/keys/cosign.pub",
    "-e",
    `SCP_OPS_API_URL=${apiUrl}`,
    "-e",
    `SCP_OPS_RUN_TOKEN_SEALED=${sealed}`,
    "-e",
    "SCP_OPS_SEALING_KEY_FILE=/var/run/scp-ops/sealing/sealing-key.pem",
    "-e",
    "HOME=/work",
    // A Workflow editor's role is IGNORED on this path — set to something the catalog lacks, so a
    // runner that honoured it would refuse and this test would see it.
    "-e",
    "SCP_OPS_ROLE=not_a_catalog_role",
    ...extraEnv.flatMap((e) => ["-e", e]),
    runnerImage
  ];
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024
    });
    return { output: stdout + stderr, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { output: (e.stdout ?? "") + (e.stderr ?? ""), ok: false };
  }
}

describe("host-reaching run through the ARGO path, against a real sshd (Testcontainers + Docker)", () => {
  beforeAll(async () => {
    dockerReady = await dockerAvailable();
    if (!dockerReady) return;
    // The test server is plain http, so the pin's redeemUrl needs the named DEVELOPMENT flag; a real
    // pin door refuses http (ADR-0054 D9).
    process.env["SCP_OPS_ALLOW_INSECURE_REDEEM_URL"] = "true";

    server = await listenTestServer();
    org = await createTestOrg(server, "ops-argo-e2e");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    productId = (await createTestComponent(admin, { name: `fleet-${randomUUID().slice(0, 8)}` }))
      .id;
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ d: objects.originDomainId }).from(objects).where(eq(objects.id, productId))
    );
    domainId = row!.d as TrustDomainId;

    // SEQUENTIAL, each assignment next to its own `refEnvVar` — see the M27.9 e2e.
    runnerImage = await resolveRunnerImage({
      refEnvVar: "SCP_RUNNER_OPS_IMAGE_REF",
      localTag: "scp-runner-ops:m28-2-e2e",
      context: RUNNER_OPS_CONTEXT
    });
    sshdImage = await resolveRunnerImage({
      refEnvVar: "SCP_SSHD_FIXTURE_IMAGE_REF",
      localTag: "scp-sshd-fixture:m28-2-e2e",
      context: SSHD_FIXTURE_CONTEXT
    });

    const enrolment = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      enrolDomain(tx, {
        orgId: org.orgId,
        domainId,
        breakGlass: "OOB console on the management VLAN",
        masterKey: server.deps.config.secretsMasterKey,
        recordedBySubjectId: randomUUID()
      })
    );

    sshd = await new GenericContainer(sshdImage)
      .withEnvironment({ SCP_TEST_CA_PUBKEY: enrolment.caPublicKey })
      .withExposedPorts(22)
      .start();
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "-f",
      "{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{$net.IPAddress}} {{$net.Gateway}}{{end}}",
      sshd.getId()
    ]);
    const [, address, gateway] = stdout.trim().split(/\s+/);
    hostAddress = address!;
    gatewayAddress = gateway!;
    expect(hostAddress, "the sshd fixture must have an address").toBeTruthy();

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      replaceMembership(tx, {
        orgId: org.orgId,
        productObjectId: productId,
        reportedBySubjectId: randomUUID(),
        members: [{ memberId: "host1", address: hostAddress }]
      })
    );

    // The binding: argo-workflows on scp-ops-v1, endpoint matching the pin.
    await pin([`${gatewayAddress}/32`]);
    await admin.executors.putBinding(productId, {
      pluginModule: "argo-workflows",
      pluginInstanceId: `argo-ops-e2e-${randomUUID().slice(0, 8)}`,
      type: "configuration",
      externalRef: "scp-ops-v1",
      allowedHosts: ["argo.e2e.example.test"],
      config: { serverUrl: ARGO_URL, namespace: NAMESPACE }
    });

    sealDir = await mkdtempTrackedForFile(join(tmpdir(), "scp-ops-argo-seal-"));
    await writeFile(join(sealDir, "sealing-key.pem"), sealingPrivatePem);
    await execFileAsync("chmod", ["a+rx", sealDir]);
    await execFileAsync("chmod", ["a+r", join(sealDir, "sealing-key.pem")]);

    // SIGN THE CATALOG exactly as catalog-closure.integration.test.ts does — with the image's own
    // cosign, the same flag set as packages/cosign/src/cosign.ts, and the container opening its own
    // outputs (a different uid on CI cannot read cosign's 0600 files otherwise).
    signedDir = await mkdtempTrackedForFile(join(tmpdir(), "scp-ops-argo-catalog-"));
    await cp(join(RUNNER_OPS_CONTEXT, "catalog"), join(signedDir, "catalog"), { recursive: true });
    await execFileAsync("chmod", ["-R", "a+rwX", signedDir]);
    await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${signedDir}:/w`,
        "-w",
        "/w",
        "--entrypoint",
        "sh",
        runnerImage,
        "-c",
        'export COSIGN_PASSWORD=""; cosign generate-key-pair && ' +
          "cosign sign-blob --key cosign.key --tlog-upload=false --new-bundle-format=false " +
          "--use-signing-config=false --output-signature catalog/catalog.json.sig --yes " +
          "catalog/catalog.json && [ -s catalog/catalog.json.sig ] && " +
          "chmod a+r catalog/catalog.json.sig cosign.key cosign.pub"
      ],
      { timeout: 180_000 }
    );
  }, 900_000);

  afterAll(async () => {
    await sshd?.stop().catch(() => undefined);
    await server?.close();
  });

  it("the runner unseals, generates its key, redeems, and a real sshd ACCEPTS the certificate — the host changes", async () => {
    if (!dockerReady) return expectSkipped();
    const run = await mintArgoRun({
      role: "config_file",
      arguments: {
        dest_path: "/etc/scp-argo-e2e.conf",
        content: "via=argo {{ lookup('pipe', 'id') }}\n"
      }
    });
    const { output, ok } = await runArgoRunner(run.sealed);
    expect(output).toContain(`redeemed run ${run.runId}`);
    expect(ok, output).toBe(true);
    expect(output).toContain("changed=1");

    // THE HOST ITSELF — and the M27.2 closure holds on this path too: the payload lands literally.
    const probe = await execFileAsync("docker", [
      "exec",
      sshd!.getId(),
      "cat",
      "/etc/scp-argo-e2e.conf"
    ]);
    expect(probe.stdout).toContain("via=argo {{ lookup('pipe', 'id') }}");
    expect(probe.stdout).not.toContain("uid=");

    // D5 CLOSES ON THIS PATH: the serial the host logged is the one the redemption issued.
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(opsRunRedemptions)
        .where(and(eq(opsRunRedemptions.orgId, org.orgId), eq(opsRunRedemptions.id, run.runId)))
    );
    const { stdout, stderr } = await execFileAsync("docker", ["logs", sshd!.getId()], {
      maxBuffer: 16 * 1024 * 1024
    });
    expect(stdout + stderr).toContain(`serial ${row!.issuedSerial}`);
    const [verdict] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      reconcileSerials(tx, org.orgId, [row!.issuedSerial!])
    );
    expect(verdict!.unrecognised).toBe(false);
    expect(verdict!.keyId).toContain(`:run=${run.runId}`);
  }, 600_000);

  it("the SAME sealed token a second time is refused before Ansible starts — single-use against the real runner", async () => {
    if (!dockerReady) return expectSkipped();
    const run = await mintArgoRun({
      role: "os_package",
      arguments: { package_name: "cowsay", package_state: "present" }
    });
    const first = await runArgoRunner(run.sealed);
    expect(first.ok, first.output).toBe(true);
    const second = await runArgoRunner(run.sealed);
    expect(second.ok).toBe(false);
    expect(second.output).toContain("HTTP 409");
    expect(second.output).not.toContain("PLAY [all]");
  }, 600_000);

  it("`source-address`: sshd accepts the certificate from the declared address and REFUSES it from any other", async () => {
    if (!dockerReady) return expectSkipped();
    await pin([`${gatewayAddress}/32`]);
    const allowed = await mintArgoRun({
      role: "config_file",
      arguments: { dest_path: "/etc/scp-sa-ok.conf", content: "ok\n" }
    });
    const ok = await runArgoRunner(allowed.sealed);
    expect(ok.ok, ok.output).toBe(true);

    // TEST-NET-1: an address nothing on this machine uses, so the connection necessarily arrives
    // from somewhere the certificate does not permit.
    await pin(["192.0.2.1/32"]);
    const denied = await mintArgoRun({
      role: "config_file",
      arguments: { dest_path: "/etc/scp-sa-no.conf", content: "no\n" }
    });
    await pin([`${gatewayAddress}/32`]);
    const refused = await runArgoRunner(denied.sealed);
    expect(refused.ok).toBe(false);
    expect(refused.output).toMatch(/Permission denied|UNREACHABLE/);
    const probe = await execFileAsync("docker", [
      "exec",
      sshd!.getId(),
      "sh",
      "-c",
      "test -e /etc/scp-sa-no.conf && echo PRESENT || echo ABSENT"
    ]);
    expect(probe.stdout).toContain("ABSENT");
  }, 600_000);

  it("catalog verification CANNOT be switched off on the Argo path — refused before the token is spent", async () => {
    if (!dockerReady) return expectSkipped();
    const run = await mintArgoRun({
      role: "config_file",
      arguments: { dest_path: "/etc/scp-verify-off.conf", content: "x\n" }
    });
    const res = await runArgoRunner(run.sealed, ["SCP_OPS_CATALOG_VERIFY=off"]);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("catalog verification cannot be disabled on the Argo path");
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(opsRunRedemptions)
        .where(and(eq(opsRunRedemptions.orgId, org.orgId), eq(opsRunRedemptions.id, run.runId)))
    );
    expect(
      row!.redeemedAt,
      "the refusal came BEFORE redemption — no certificate was minted"
    ).toBeNull();
  }, 600_000);
});
