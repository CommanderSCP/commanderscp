import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { resolveRunnerImage } from "@scp/plugin-testkit";
import { mkdtempTrackedForFile } from "@scp/test-tmpdir";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, changeWaveTargets, decisions } from "../db/schema.js";

/**
 * M28.1 — AN `rpm` COMPONENT PROMOTES END TO END THROUGH ARGO WORKFLOWS TO A PACKAGE REPO.
 *
 * The DoD is wiring, not a template existing. So this drives the whole seam the way production
 * does: a change is proposed, the REAL reconcile loop plans and triggers it, `buildLaneTriggerParameters`
 * derives the destination, and the REAL `argo-workflows` plugin, in the real subprocess plugin host,
 * submits `scp-build-rpm-v1` to an Argo Workflows API. That API is a loopback stand-in — it records
 * the submission and reports the workflow Succeeded — because what is under test is what SCP SENDS.
 *
 * And then what was sent is USED, against a real counterparty: the shipped builder image runs the
 * shipped script with exactly the parameters the plugin submitted, publishes to a real Gitea, and a
 * clean container installs the result with dnf from that Gitea. Argo itself is the one hop not run
 * here (it needs a cluster); `tools/helm-verify` holds the rendered template's argument wiring to
 * the script's positional contract instead.
 *
 * WIRING-DELETION MUTATIONS (recorded in the M28.1 PR): deleting the destination derivation, or the
 * Type→format routing, or the refusal, turns the first two tests red.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const BUILDER_RPM_CONTEXT = resolve(REPO_ROOT, "apps/builder-rpm");
const FIXTURE_DIR = resolve(BUILDER_RPM_CONTEXT, "test-fixture");
const CATALOG_TEMPLATE = resolve(
  REPO_ROOT,
  "deploy/helm-bundled/templates/argo-workflows-catalog.yaml"
);
const GITEA_IMAGE = "docker.gitea.com/gitea:1.26.1-rootless";
const NAMESPACE = "scp-argo-workflows";
const SPEC = "packaging/scp-widget.spec";
const COMMIT = "c".repeat(40);

interface Submission {
  resourceKind: string;
  resourceName: string;
  parameters: Record<string, string>;
}

/** The parameter NAMES `scp-build-rpm-v1` declares, read from the template SOURCE. Argo refuses a
 *  submission naming an undeclared parameter, so any key the derivation emits for `rpm` that is not
 *  here is a trigger that fails at submit in production — and passes every unit test. */
async function declaredTemplateParameters(): Promise<string[]> {
  const text = await readFile(CATALOG_TEMPLATE, "utf8");
  const start = text.indexOf("  name: scp-build-rpm-v1");
  expect(start, "scp-build-rpm-v1 is not in the catalog template").toBeGreaterThan(-1);
  const args = text.indexOf("  arguments:\n    parameters:\n", start);
  const end = text.indexOf("\n  templates:\n", args);
  const names = [...text.slice(args, end).matchAll(/^ {6}- name: (\S+)$/gm)].map((m) => m[1]!);
  expect(names.length, "parsed no parameters out of the template").toBeGreaterThan(3);
  return names;
}

let dockerReady = false;
async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
/** A VISIBLE skip — `it.runIf` reports skipped with exit 0 before `beforeAll` decides anything. */
function expectSkipped(): void {
  console.warn(
    "[rpm-build-lane] no reachable Docker daemon — the real-counterparty RPM build did NOT run"
  );
  expect(dockerReady).toBe(false);
}

describe("M28.1: an rpm component promotes end to end through Argo Workflows to a package repo", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let argo: Server;
  let argoUrl: string;
  let argoSystemId: string;
  const submissions: Submission[] = [];
  const prevEgressHosts = process.env.SCP_INTERNAL_EGRESS_HOSTS;

  let builderImage = "";
  let network: StartedNetwork | undefined;
  let gitea: StartedTestContainer | undefined;
  let giteaToken = "";
  let workDir = "";
  /** What the plugin submitted for the promoting component — the real-counterparty run USES it. */
  let promoted: Submission | undefined;

  /** A loopback Argo Workflows API: submit records and names a workflow; get reports it Succeeded;
   *  anything else (observe's list) is an empty list. */
  function startArgo(): Promise<{ srv: Server; url: string }> {
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        const url = req.url ?? "";
        if (req.method === "POST" && url === `/api/v1/workflows/${NAMESPACE}/submit`) {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            resourceKind: string;
            resourceName: string;
            submitOptions?: { parameters?: string[] };
          };
          const parameters = Object.fromEntries(
            (body.submitOptions?.parameters ?? []).map((p) => {
              const i = p.indexOf("=");
              return [p.slice(0, i), p.slice(i + 1)];
            })
          );
          submissions.push({
            resourceKind: body.resourceKind,
            resourceName: body.resourceName,
            parameters
          });
          const name = `${body.resourceName}-${submissions.length}`;
          res.end(JSON.stringify({ metadata: { name, uid: randomUUID() } }));
          return;
        }
        const get = new RegExp(`^/api/v1/workflows/${NAMESPACE}/([^/?]+)$`).exec(url);
        if (req.method === "GET" && get) {
          res.end(
            JSON.stringify({
              metadata: { name: get[1], uid: randomUUID() },
              status: { phase: "Succeeded", progress: "2/2" }
            })
          );
          return;
        }
        res.end(JSON.stringify({ items: [] }));
      });
    });
    return new Promise((ok) => {
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        ok({ srv, url: `http://127.0.0.1:${port}` });
      });
    });
  }

  beforeAll(async () => {
    // ADR-0003's two layers: the operator allowlist (here) AND the system's declared intent
    // (`allowInternalEgress` below). Set before boot so the resolver reads it.
    process.env.SCP_INTERNAL_EGRESS_HOSTS = "127.0.0.1";
    ({ srv: argo, url: argoUrl } = await startArgo());
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    org = await createTestOrg(server, "m28-1-rpm");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const system = await admin.object("execution-system").create({
      name: `argo-workflows-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "argo-workflows",
        serverUrl: argoUrl,
        namespace: NAMESPACE,
        allowInternalEgress: true
      }
    });
    argoSystemId = system.id;

    dockerReady = await dockerAvailable();
    if (!dockerReady) return;
    // PUBLISHED IN CI (its build is a `dnf install`, and CI blackholes egress), BUILT LOCALLY.
    builderImage = await resolveRunnerImage({
      refEnvVar: "SCP_BUILDER_RPM_IMAGE_REF",
      localTag: "scp-builder-rpm:m28-1-integration",
      context: BUILDER_RPM_CONTEXT
    });
    network = await new Network().start();
    gitea = await new GenericContainer(GITEA_IMAGE)
      .withNetwork(network)
      .withNetworkAliases("gitea")
      .withExposedPorts(3000)
      .withEnvironment({
        GITEA__security__INSTALL_LOCK: "true",
        GITEA__database__DB_TYPE: "sqlite3",
        GITEA__server__HTTP_PORT: "3000",
        GITEA__server__ROOT_URL: "http://gitea:3000/"
      })
      .withWaitStrategy(Wait.forHttp("/api/healthz", 3000))
      .start();
    const created = await gitea.exec([
      "gitea",
      "admin",
      "user",
      "create",
      "--username",
      "acme",
      "--password",
      "acme-password-123",
      "--email",
      "acme@example.invalid",
      "--must-change-password=false"
    ]);
    expect(created.exitCode, created.output).toBe(0);
    const tokenRes = await fetch(`${giteaHostUrl()}/api/v1/users/acme/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from("acme:acme-password-123").toString("base64")}`
      },
      body: JSON.stringify({ name: "scp-build", scopes: ["write:package"] })
    });
    expect(tokenRes.status).toBe(201);
    giteaToken = ((await tokenRes.json()) as { sha1: string }).sha1;
    workDir = await mkdtempTrackedForFile(join(tmpdir(), "scp-rpm-build-"));
  }, 600_000);

  afterAll(async () => {
    // The build container wrote its tree as uid 1000, which is not CI's runner uid — so the
    // tracked-tmpdir sweep could not delete it. Reclaimed as root, by the image that wrote it.
    if (dockerReady && workDir && builderImage) {
      await execFileAsync("docker", [
        "run",
        "--rm",
        "--user",
        "0",
        "-v",
        `${workDir}:/work`,
        "--entrypoint",
        "sh",
        builderImage,
        "-c",
        "rm -rf /work/* /work/.[!.]*"
      ]).catch(() => undefined);
    }
    await server?.close();
    await new Promise<void>((ok) => argo?.close(() => ok()));
    await gitea?.stop().catch(() => undefined);
    await network?.stop().catch(() => undefined);
    if (prevEgressHosts === undefined) delete process.env.SCP_INTERNAL_EGRESS_HOSTS;
    else process.env.SCP_INTERNAL_EGRESS_HOSTS = prevEgressHosts;
  });

  function giteaHostUrl(): string {
    return `http://${gitea!.getHost()}:${gitea!.getMappedPort(3000)}`;
  }

  /** An `rpm` component bound to scp-build-rpm-v1 on the Argo system, publishing to `registry`. */
  async function rpmComponent(registryProperties: Record<string, unknown>, repository: string) {
    const component = await createTestComponent(admin, { name: `rpm-${randomUUID().slice(0, 8)}` });
    await admin.components.update(component.id, { properties: { rpmSpec: SPEC } });
    const registry = await admin.object("execution-system").create({
      name: `registry-${randomUUID().slice(0, 8)}`,
      domainLocal: true,
      properties: registryProperties
    });
    await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: registry.id,
      properties: { repository }
    });
    await admin.executors.putBinding(component.id, {
      executionSystemId: argoSystemId,
      type: "rpm",
      externalRef: "scp-build-rpm-v1"
    });
    return component;
  }

  async function proposeRpmChange(componentId: string) {
    return admin.changes.propose({
      name: `rpm release ${randomUUID().slice(0, 6)}`,
      targets: [componentId],
      type: "rpm",
      sourceRef: { repo: "acme/scp-widget", ref: "refs/heads/main", commit: COMMIT }
    });
  }

  const waveTargetOf = async (targetId: string) =>
    (
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .select()
          .from(changeWaveTargets)
          .where(
            and(
              eq(changeWaveTargets.orgId, org.orgId),
              eq(changeWaveTargets.targetObjectId, targetId)
            )
          )
          .limit(1)
      )
    )[0];

  it("submits scp-build-rpm-v1 with the rpm parameters and the PACKAGE-REPO destination, and the change completes", async () => {
    const component = await rpmComponent(
      { kind: "gitea", serverUrl: "http://gitea:3000", packageFormats: ["oci", "rpm"] },
      "acme/el9"
    );
    const change = await proposeRpmChange(component.id);

    promoted = await waitUntil(
      async () =>
        submissions.find((s) => s.parameters["changeObjectId"] === change.id) ?? undefined,
      { describe: "the argo-workflows plugin submits this change's workflow", timeoutMs: 30_000 }
    );
    expect(promoted.resourceKind).toBe("WorkflowTemplate");
    expect(promoted.resourceName).toBe("scp-build-rpm-v1");
    expect(promoted.parameters).toMatchObject({
      sourceRepo: "acme/scp-widget",
      sourceRef: "refs/heads/main",
      sourceCommit: COMMIT,
      rpmSpec: SPEC,
      packageRepository: "acme/el9",
      rpmUploadUrl: "http://gitea:3000/api/packages/acme/rpm/el9/upload",
      rpmRepositoryUrl: "http://gitea:3000/api/packages/acme/rpm/el9"
    });
    // Not one container-shaped key — the defect, asserted absent at the executor's door.
    for (const key of ["imageDestination", "imageRepository", "dockerfile"]) {
      expect(promoted.parameters).not.toHaveProperty(key);
    }
    // Every key SCP sent is one the shipped template declares, or Argo refuses the submit.
    const declared = await declaredTemplateParameters();
    for (const key of Object.keys(promoted.parameters)) {
      expect(declared, `SCP sent '${key}', which scp-build-rpm-v1 does not declare`).toContain(key);
    }

    // And the promotion actually proceeds past the executor: the wave target observes success.
    await waitUntil(
      async () => ((await waveTargetOf(component.id))?.status === "succeeded" ? true : undefined),
      { describe: "the rpm wave target reaches succeeded", timeoutMs: 30_000 }
    );
    await waitUntil(
      async () => ((await admin.changes.get(change.id)).state === "validating" ? true : undefined),
      { describe: "the rpm change reaches validating", timeoutMs: 30_000 }
    );
  });

  it("REFUSES an rpm binding whose destination is a container registry — Decision + audit, never submitted", async () => {
    // The present behaviour M28.1 corrects, asserted as a refusal at the level that matters: the
    // executor is never asked. A registry declaring no packageFormats is a container registry.
    const component = await rpmComponent(
      { kind: "ghcr", serverUrl: "https://ghcr.io" },
      "acme/el9"
    );
    const change = await proposeRpmChange(component.id);

    const target = await waitUntil(
      async () => {
        const row = await waveTargetOf(component.id);
        return row?.status === "destination_refused" ? row : undefined;
      },
      { describe: "the rpm wave target is refused (destination_refused)", timeoutMs: 30_000 }
    );
    expect(target.executorRef).toBeNull();
    expect(submissions.filter((s) => s.parameters["changeObjectId"] === change.id)).toEqual([]);

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.subjectId, change.id))
    );
    const refusal = rows.find(
      (d) => (d.inputContext as { gate?: string } | null)?.gate === "build_destination_format"
    );
    expect(refusal, "a Decision records the refusal with its inputs (principle 6)").toBeDefined();
    expect(refusal!.verdict).toBe("block");
    expect(refusal!.inputContext).toMatchObject({
      type: "rpm",
      requiredFormat: "rpm",
      effectivePackageFormats: ["oci"]
    });
    expect(JSON.stringify(refusal!.reasonTree)).toContain("publishes 'rpm' packages");

    const audit = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.subjectId, change.id))
    );
    expect(
      audit.find((a) => a.action === "change.wave_target.destination_refused")?.decisionId
    ).toBe(refusal!.id);
  });

  it("REAL COUNTERPARTY — the shipped builder runs the submitted parameters, publishes to a real Gitea, and dnf installs the result", async () => {
    if (!dockerReady) return expectSkipped();
    expect(promoted, "the first test captured the submitted parameters").toBeDefined();
    const p = promoted!.parameters;

    // The checkout the template's fetch-source init container would have made, at /work/src.
    await cp(FIXTURE_DIR, join(workDir, "src"), { recursive: true });
    await execFileAsync("chmod", ["-R", "a+rwX", workDir]);

    // The template's container, as the template runs it: the same image, the same positional
    // arguments in the same order, and the SAME security posture — non-root, read-only root,
    // every capability dropped, no_new_privs, the runtime's default seccomp/AppArmor. If the build
    // needed a relaxation, this is where it would fail.
    const build = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        network!.getName(),
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "1000:1000",
        "-v",
        `${workDir}:/work`,
        "-e",
        "SCP_SOURCE_DIR=/work/src",
        "-e",
        "SCP_WORK_DIR=/work",
        "-e",
        "REGISTRY_USERNAME=acme",
        "-e",
        `REGISTRY_PASSWORD=${giteaToken}`,
        builderImage,
        p["rpmSpec"]!,
        p["rpmUploadUrl"]!,
        p["sourceCommit"]!
      ],
      { timeout: 480_000, maxBuffer: 64 * 1024 * 1024 }
    ).catch((err: { stdout?: string; stderr?: string }) => {
      throw new Error(`the rpm build failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
    });
    expect(build.stdout).toContain("built scp-widget-1.0.0-1.el9.src.rpm");
    expect(build.stdout).toContain("published scp-widget-1.0.0-1.el9.x86_64.rpm");

    // THE REGISTRY'S OWN ACCOUNT, not the build's report of itself.
    const listed = (await (
      await fetch(`${giteaHostUrl()}/api/v1/packages/acme?type=rpm`, {
        headers: { authorization: `token ${giteaToken}` }
      })
    ).json()) as { name: string; version: string; type: string }[];
    expect(listed.map((pkg) => `${pkg.type}:${pkg.name}`)).toContain("rpm:scp-widget");

    // INSTALLABLE: a clean container with only this repository enabled installs it and runs it.
    // `gpgcheck=0` because the fixture is unsigned; the repository is what is being proved.
    const install = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        network!.getName(),
        "--user",
        "0",
        "--entrypoint",
        "sh",
        builderImage,
        "-c",
        `dnf -q -y --disablerepo='*' --repofrompath=scp,${p["rpmRepositoryUrl"]} ` +
          `--setopt=scp.gpgcheck=0 install scp-widget && scp-widget && rpm -q scp-widget`
      ],
      { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }
    ).catch((err: { stdout?: string; stderr?: string }) => {
      throw new Error(
        `dnf could not install from Gitea:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`
      );
    });
    expect(install.stdout).toContain("scp-widget 1.0.0");
    expect(install.stdout).toContain("scp-widget-1.0.0-1.el9.x86_64");
  }, 900_000);
});
