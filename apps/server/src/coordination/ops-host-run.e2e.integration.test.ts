import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { enrolDomain, reconcileSerials } from "./ssh-ca-repo.js";
import { replaceMembership } from "./infrastructure-members-repo.js";
import { deriveOpsRunMaterial } from "./ops-run-material.js";
import { getSecretValue } from "../secrets/secrets-repo.js";

/**
 * M27.9 item (d) — THE WHOLE PATH, against a real `sshd` and a real host.
 *
 * Everything M27 proved before this stopped short of the one question that matters: does a
 * certificate this server mints actually let this runner change that host? Signing was proved
 * against frozen `ssh-keygen` vectors, which settles the wire format and says nothing about whether
 * OpenSSH will ACCEPT the result — a certificate can be byte-correct under our own parser and be
 * refused for a principal mismatch, a validity interval, or a signature over the wrong region.
 *
 * Running it found FOUR defects that every prior M27 test had passed over, each the same shape
 * (a part built, verified in isolation, and connected to nothing):
 *
 *   1. `run.sh` never read the credential the orchestrator staged, so `ansible-playbook` ran with
 *      no key and could not have authenticated to anything.
 *   2. `run.sh` never put the verified catalog on `ANSIBLE_ROLES_PATH`, so the role it had just
 *      signature-checked, digest-checked and charter-class-checked was then "not found".
 *   3. Ansible's default `-tt` failed at "PTY allocation request failed" AFTER authenticating —
 *      and a tty was never needed, because the catalog has no `become`.
 *   4. The host must be apt/dnf: the lockdown allowlist admits `apt` and `dnf` and correctly not
 *      `apk`, so an Alpine test host was testing a platform the product does not claim.
 *
 * None of those is exotic. All four were invisible to a suite where every test called one function.
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
/** The docker network the sshd fixture landed on, and the one the runner must JOIN.
 *
 *  Not assumed to be the default bridge. Testcontainers is free to place a container on its own
 *  network, and the runner is started with a plain `docker run` — so on a host where those differ,
 *  the runner would be given an address it cannot route to and the failure would look like a
 *  refused connection rather than a misconfigured test. Read from the container, never guessed. */
let sshdNetwork = "";
let server: ListeningTestServer;
let org: TestOrg;
let workDir: string;
const domainId = randomUUID() as TrustDomainId;
let productId: string;
let caPublicKey: string;

/** A skip that is VISIBLE. A silent `return` in a docker-gated test is how a suite reports green
 *  for a proof that never ran — and `it.runIf` is worse, because it evaluates at COLLECTION time
 *  and reports "skipped" with exit 0 before `beforeAll` has decided anything. */
function expectSkipped(): void {
  console.warn(
    "[ops-host-run.e2e] no reachable Docker daemon — the end-to-end host-reaching proof did NOT run"
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

/** Run the real runner image over the real inventory. Returns combined output either way — a
 *  refusal exits non-zero and its message IS the result. */
async function runRunner(role: string): Promise<{ output: string; ok: boolean }> {
  const args = [
    "run",
    "--rm",
    // JOIN THE FIXTURE'S NETWORK — see `sshdNetwork`.
    "--network",
    sshdNetwork,
    // `/work` and not `/work/in`: the runner writes its rendered vars and play into `/work`, and
    // bind-mounting only the subdirectory leaves `/work` root-owned for a non-root image.
    "-v",
    `${workDir}:/work`,
    "-e",
    `SCP_OPS_ROLE=${role}`,
    // The catalog signature is M27.3's gate and has its own suite; this test is about the host
    // path, and signing here would prove the signer twice and the connection once.
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

describe("host-reaching run, end to end against a real sshd (Testcontainers + Docker)", () => {
  beforeAll(async () => {
    dockerReady = await dockerAvailable();
    if (!dockerReady) return;

    server = await listenTestServer();
    org = await createTestOrg(server, "ops-e2e");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    productId = (await createTestComponent(admin, { name: `fleet-${randomUUID().slice(0, 8)}` }))
      .id;

    // PUBLISHED IN CI, BUILT LOCALLY — the runner's Dockerfile carries a `# syntax=` directive,
    // so BuildKit would fetch a frontend from Docker Hub and CI blackholes egress.
    // SEQUENTIAL, and each assignment written next to its own `refEnvVar`. A `Promise.all` with
    // destructuring is tidier and defeats `ci-offline-mirror`'s mirror gate: that gate resolves the
    // identifier handed to a Container constructor by reading the source, and with both calls in one
    // array it matched `sshdImage` against the FIRST ref it found — so a bogus env var on the second
    // call still passed. Adjacency is what makes the association checkable.
    runnerImage = await resolveRunnerImage({
      refEnvVar: "SCP_RUNNER_OPS_IMAGE_REF",
      localTag: "scp-runner-ops:m27-9-e2e",
      context: RUNNER_OPS_CONTEXT
    });
    sshdImage = await resolveRunnerImage({
      refEnvVar: "SCP_SSHD_FIXTURE_IMAGE_REF",
      localTag: "scp-sshd-fixture:m27-9-e2e",
      context: SSHD_FIXTURE_CONTEXT
    });

    // ENROL FIRST — and the CA public key comes from the enrolment, not from the test. If the test
    // minted its own CA the fixture would trust a key the product never issued from, and the run
    // would prove only that this file is self-consistent.
    const enrolment = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const result = await enrolDomain(tx, {
        orgId: org.orgId,
        domainId,
        breakGlass: "OOB console on the management VLAN",
        masterKey: server.deps.config.secretsMasterKey,
        recordedBySubjectId: randomUUID()
      });
      return result;
    });
    caPublicKey = enrolment.caPublicKey;

    sshd = await new GenericContainer(sshdImage)
      .withEnvironment({ SCP_TEST_CA_PUBKEY: caPublicKey })
      .withExposedPorts(22)
      .start();

    // The address the RUNNER will use. Both containers sit on the default bridge, so the container
    // IP is what the inventory must carry — the mapped host port is reachable from this process
    // and not from the runner.
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "-f",
      "{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{$net.IPAddress}}{{end}}",
      sshd.getId()
    ]);
    const [networkName, hostAddress] = stdout.trim().split(/\s+/);
    expect(hostAddress, "the sshd fixture must have an address on its network").toBeTruthy();
    sshdNetwork = networkName!;

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      replaceMembership(tx, {
        orgId: org.orgId,
        productObjectId: productId,
        reportedBySubjectId: randomUUID(),
        members: [{ memberId: "host1", address: hostAddress! }]
      })
    );

    // PER-FILE, swept in afterAll. A raw `mkdtemp` leaks and the leak sweep is a CI gate.
    workDir = await mkdtempTrackedForFile(join(tmpdir(), "scp-ops-e2e-"));
    await execFileAsync("mkdir", ["-p", join(workDir, "in")]);
  }, 600_000);

  afterAll(async () => {
    await sshd?.stop().catch(() => undefined);
    await server?.close();
  });

  /** Derive one run's material through the REAL producer and stage it exactly as the orchestrator
   *  does — inventory, params and credential as files under the copy-in directory. */
  async function stageRun(role: string, args: Record<string, unknown>): Promise<string> {
    const material = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deriveOpsRunMaterial(tx, {
        orgId: org.orgId,
        domainId,
        productObjectId: productId,
        role,
        subjectObjectId: randomUUID(),
        masterKey: server.deps.config.secretsMasterKey
      })
    );
    const credential = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getSecretValue(
        tx,
        org.orgId,
        material.opsCredentialSecretKey as string,
        server.deps.config.secretsMasterKey
      )
    );
    const inDir = join(workDir, "in");
    await writeFile(join(inDir, "inventory.ini"), material.opsInventory as string);
    await writeFile(join(inDir, "params.json"), JSON.stringify(args));
    await writeFile(join(inDir, "ssh-credential"), credential ?? "");
    // ONLY WHAT THIS TEST OWNS. The image runs as a non-root uid that is not this suite's, and on a
    // developer box the two frequently coincide — so a recursive chmod over the whole workspace
    // passes locally and fails in CI with "chmod: changing permissions of '.../id': Operation not
    // permitted", because `id`, `id-cert.pub`, `vars.yml`, `play.yml` and `known_hosts` are created
    // by the CONTAINER and owned by it. The first run passes (nothing container-owned exists yet)
    // and every run after it fails, which is how this presented.
    //
    // The workspace root is opened so the container can create its files there; the copy-in inputs
    // are opened so it can read them. Nothing else needs touching, and the container reclaims its
    // own files each run because `run.sh` unlinks before writing.
    await execFileAsync("chmod", ["a+rwX", workDir]);
    await execFileAsync("chmod", ["-R", "a+rwX", inDir]);
    return material.opsCredentialSecretKey as string;
  }

  it("a server-minted certificate is ACCEPTED by a real sshd, and changes the host", async () => {
    if (!dockerReady) return expectSkipped();
    await stageRun("os_package", { package_name: "cowsay", package_state: "present" });
    const { output, ok } = await runRunner("os_package");
    expect(output).toContain("changed=1");
    expect(ok, output).toBe(true);

    // THE HOST ITSELF, not the runner's report. A play can report `changed` and have changed
    // nothing that outlives the connection; the question is whether the package is there.
    const probe = await execFileAsync("docker", [
      "exec",
      sshd!.getId(),
      "bash",
      "-lc",
      "test -x /usr/games/cowsay && echo PRESENT"
    ]);
    expect(probe.stdout).toContain("PRESENT");
  }, 600_000);

  it("the run is IDEMPOTENT — a second identical run changes nothing", async () => {
    if (!dockerReady) return expectSkipped();
    await stageRun("os_package", { package_name: "cowsay", package_state: "present" });
    const { output, ok } = await runRunner("os_package");
    expect(ok, output).toBe(true);
    expect(output).toContain("changed=0");
  }, 600_000);

  it("the SERIAL the host logged is one SCP recorded issuing — D5 closes", async () => {
    if (!dockerReady) return expectSkipped();
    // The two halves of ADR-0051 D5 have never met: SCP records a serial at issuance, and hosts log
    // the serial they accepted. Until they are compared against each other, "reconciliation" is an
    // assertion about a table rather than a control.
    // `docker logs` and NOT Testcontainers' streaming `logs()`. The stream has no natural end while
    // the container runs, so reading it means racing a fixed timeout against output that has
    // already been written — a sleep standing in for a signal, which `integration-sleep-census`
    // exists to refuse. A one-shot read returns everything written so far, and everything this
    // asserts on was written by the runs above before this test started.
    const { stdout, stderr } = await execFileAsync("docker", ["logs", sshd!.getId()], {
      maxBuffer: 16 * 1024 * 1024
    });
    const text = stdout + stderr;
    const serials = [...text.matchAll(/serial (\d+)/g)].map((m) => m[1]!);
    expect(
      serials.length,
      `no certificate serial in the host's sshd log:\n${text}`
    ).toBeGreaterThan(0);

    const verdicts = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      reconcileSerials(tx, org.orgId, serials)
    );
    // EVERY serial the host accepted must be one SCP issued. A single unrecognised one on this
    // path would mean the certificate reaching the host is not the certificate we recorded.
    expect(verdicts.filter((v) => v.unrecognised)).toEqual([]);
    expect(verdicts.map((v) => v.keyId).every((k) => k?.startsWith("scp-ops:root:"))).toBe(true);
  }, 300_000);

  it("a FORGED serial the host never got is reported unrecognised", async () => {
    if (!dockerReady) return expectSkipped();
    // The negative control. Without it the assertion above passes for a reconciliation that
    // reports everything as recognised.
    const verdicts = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      reconcileSerials(tx, org.orgId, ["1"])
    );
    expect(verdicts[0]!.unrecognised).toBe(true);
  }, 300_000);

  it("pushes a config file, the second charter class, through the same credential path", async () => {
    if (!dockerReady) return expectSkipped();
    await stageRun("config_file", {
      dest_path: "/etc/scp-e2e.conf",
      // A LITERAL `{{ }}` payload: M27.2 marks tenant parameters !unsafe where they enter the run,
      // so this must land on the host verbatim rather than being evaluated.
      content: "rendered-by=scp {{ lookup('pipe', 'id') }}\n"
    });
    const { output, ok } = await runRunner("config_file");
    expect(ok, output).toBe(true);

    const probe = await execFileAsync("docker", [
      "exec",
      sshd!.getId(),
      "cat",
      "/etc/scp-e2e.conf"
    ]);
    expect(probe.stdout).toContain("{{ lookup('pipe', 'id') }}");
    expect(probe.stdout).not.toContain("uid=");
  }, 600_000);
});
