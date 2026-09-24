import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { ScpClient } from "@scp/sdk";
import type { TrustDomainId } from "@scp/schemas";
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
import { enrolDomain, reconcileSerials } from "./ssh-ca-repo.js";
import { replaceMembership } from "./infrastructure-members-repo.js";
import { opsLaneTriggerParameters } from "./ops-lane-trigger-parameters.js";

/**
 * M28.2 — THE ARGO PATH, against a real `sshd` and a real host (the M27.9 e2e is the precedent).
 *
 * `ops-argo-lane.integration.test.ts` proves reconcile submits a sealed token and the redeem door
 * behaves. It cannot prove the part that matters: that the REAL runner, started the way
 * `scp-ops-v1` starts it — the sealed token in `SCP_OPS_RUN_TOKEN_SEALED`, the sealing key mounted
 * as a file, a read-only root filesystem, every capability dropped — unseals the token, generates
 * its own key, redeems over HTTP, and that the certificate it gets back is one a real `sshd`
 * ACCEPTS. The producer here is `opsLaneTriggerParameters`, the call reconcile makes; the consumer
 * is the image's own `redeem.py` + `run.sh`, and it decides.
 *
 * WHAT THIS DOES NOT RUN: Argo itself. The container is launched with `docker run` carrying the
 * env and mounts the template renders (tools/helm-verify checks the template renders them). A real
 * Argo controller would add the emissary executor and nothing that changes what the runner sees.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const RUNNER_OPS_CONTEXT = resolve(REPO_ROOT, "apps/runner-ops");
const SSHD_FIXTURE_CONTEXT = resolve(REPO_ROOT, "tools/sshd-fixture");

let dockerReady = false;
let runnerImage = "";
let sshdImage = "";
let sshd: StartedTestContainer | undefined;
let server: ListeningTestServer;
let org: TestOrg;
let productId: string;
let domainId: TrustDomainId;
let sealDir: string;
let hostAddress = "";
/** The address a `--network host` container presents to the fixture: the bridge gateway. */
let gatewayAddress = "";

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

/** Mint an Argo-path run through the REAL reconcile-side call, for a fresh change. */
async function mintArgoRun(
  declaration: { role: string; arguments: Record<string, unknown> },
  sourceAddresses?: string[]
): Promise<{ sealed: string; runId: string; changeId: string }> {
  const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  const change = await admin.changes.propose({
    name: `ops-argo-e2e-${randomUUID().slice(0, 8)}`,
    targets: [productId],
    properties: { ops: declaration }
  });
  const params = await withTenantTx(server.deps.db, org.orgId, (tx) =>
    opsLaneTriggerParameters(tx, {
      orgId: org.orgId,
      targetObjectId: productId,
      changeObjectId: change.id,
      pluginModule: "argo-workflows",
      externalRef: "scp-ops-v1",
      waveTargetId: randomUUID(),
      executorConfig: {
        opsSealingPublicKey: sealingPublicPem,
        ...(sourceAddresses ? { opsSourceAddresses: sourceAddresses } : {})
      },
      masterKey: server.deps.config.secretsMasterKey
    })
  );
  return {
    sealed: params!["opsRunTokenSealed"] as string,
    runId: params!["opsRunId"] as string,
    changeId: change.id
  };
}

/** Start the runner EXACTLY as scp-ops-v1 does: sealed token in env, sealing key as a read-only
 *  file, read-only root, /work and /tmp writable, no capabilities. Fresh /work per run — an
 *  emptyDir in the real pod. */
async function runArgoRunner(sealed: string): Promise<{ output: string; ok: boolean }> {
  const workDir = await mkdtempTrackedForFile(join(tmpdir(), "scp-ops-argo-work-"));
  await execFileAsync("chmod", ["a+rwX", workDir]);
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
    "-v",
    `${workDir}:/work`,
    "-v",
    `${sealDir}:/var/run/scp-ops/sealing:ro`,
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
    // As in the M27.9 e2e: the catalog signature has its own suite; this one is the host path.
    "-e",
    "SCP_OPS_CATALOG_VERIFY=off",
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

    server = await listenTestServer();
    org = await createTestOrg(server, "ops-argo-e2e");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
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

    sealDir = await mkdtempTrackedForFile(join(tmpdir(), "scp-ops-argo-seal-"));
    await writeFile(join(sealDir, "sealing-key.pem"), sealingPrivatePem);
    await execFileAsync("chmod", ["a+rx", sealDir]);
    await execFileAsync("chmod", ["a+r", join(sealDir, "sealing-key.pem")]);
  }, 600_000);

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
    const allowed = await mintArgoRun(
      { role: "config_file", arguments: { dest_path: "/etc/scp-sa-ok.conf", content: "ok\n" } },
      [`${gatewayAddress}/32`]
    );
    const ok = await runArgoRunner(allowed.sealed);
    expect(ok.ok, ok.output).toBe(true);

    // TEST-NET-1: an address nothing on this machine uses, so the connection necessarily arrives
    // from somewhere the certificate does not permit.
    const denied = await mintArgoRun(
      { role: "config_file", arguments: { dest_path: "/etc/scp-sa-no.conf", content: "no\n" } },
      ["192.0.2.1/32"]
    );
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
});
