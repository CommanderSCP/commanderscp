import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { ExecutorType } from "@scp/schemas";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { BuildDestinationRefused, buildLaneTriggerParameters } from "./build-trigger-parameters.js";

/** WHAT A BUILD-LANE TRIGGER TELLS ITS EXECUTOR.
 *
 *  Before this, `parameters` on a build trigger came only from a campaign recipe — operator-authored
 *  values — so an ordinary promotion reached the executor with `targetRef` and nothing else: no
 *  repo, no commit, no destination. A shipped, parameterised build template had nothing to read,
 *  which left one template per component with all three hardcoded: a catalog in name only. */

describe("buildLaneTriggerParameters (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "build-params");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  const SOURCE_REF = {
    repo: "AgentKitProject/agentkit",
    ref: "refs/heads/main",
    commit: "a".repeat(40)
  };

  async function resolve(componentId: string, sourceRef: unknown, type: ExecutorType = "image") {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      buildLaneTriggerParameters(tx, {
        orgId: org.orgId,
        targetObjectId: componentId,
        type,
        sourceRef,
        changeObjectId: "01a0c000-0000-7000-8000-000000000000"
      })
    );
  }

  async function componentPublishingTo(
    repository: string | null,
    serverUrl = "https://ghcr.io",
    /** Extra registry properties — `kind` and `packageFormats` are what M28.1 routes on. */
    registryProperties: Record<string, unknown> = {},
    componentProperties?: Record<string, unknown>
  ): Promise<string> {
    const component = await createTestComponent(admin, { name: `c-${randomUUID().slice(0, 8)}` });
    if (componentProperties) {
      await admin.components.update(component.id, { properties: componentProperties });
    }
    if (repository === null) return component.id;
    const registry = await admin.object("execution-system").create({
      name: `reg-${randomUUID().slice(0, 8)}`,
      domainLocal: true,
      properties: { kind: "ghcr", serverUrl, ...registryProperties }
    });
    await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: registry.id,
      properties: { repository }
    });
    return component.id;
  }

  it("carries the source identity AND the destination the pipeline view shows", async () => {
    const id = await componentPublishingTo("agentkitproject/agentkitprofile-app");
    expect(await resolve(id, SOURCE_REF)).toMatchObject({
      sourceRepo: "AgentKitProject/agentkit",
      sourceRef: "refs/heads/main",
      sourceCommit: "a".repeat(40),
      imageRepository: "agentkitproject/agentkitprofile-app",
      // ASSEMBLED, not passed through: the catalog template requires `host/repository` and must
      // not have to strip a scheme in a templating language, where getting it wrong pushes to the
      // wrong registry rather than erroring.
      imageDestination: "ghcr.io/agentkitproject/agentkitprofile-app"
    });
  });

  it("names no destination when the registry's serverUrl is not a usable http(s) url", async () => {
    // `serverUrl` is operator-supplied. It reaches here only through executionSystemConsoleBase,
    // which yields null unless the value parses AND is http(s) — so a malformed one produces no
    // registryUrl and therefore no destination, and the catalog template (which REQUIRES
    // imageDestination) refuses the run rather than pushing somewhere guessed. Both the
    // unparseable and the wrong-scheme case are checked, because only the second is a string a
    // URL parser accepts — and that is the one a naive `new URL()` guard would let through.
    for (const serverUrl of ["not a url", "ftp://ghcr.io"]) {
      const id = await componentPublishingTo("agentkitproject/agentkitprofile-app", serverUrl);
      const params = await resolve(id, SOURCE_REF);
      expect(params).toMatchObject({ imageRepository: "agentkitproject/agentkitprofile-app" });
      expect(params).not.toHaveProperty("registryUrl");
      expect(params).not.toHaveProperty("imageDestination");
    }
  });

  it("carries the component's OWN dockerfile path when it declares one", async () => {
    // A monorepo puts each component's Dockerfile under its own directory
    // (`apps/profile-web/Dockerfile` in AgentKitProject/agentkit), so this is a fact about the
    // COMPONENT. Chart-wide configuration would force every component in an organization onto one
    // path — which is how the catalog template first shipped, and it was wrong for the very first
    // real build attempted against it.
    const component = await createTestComponent(admin, { name: `df-${randomUUID().slice(0, 8)}` });
    // The TYPED route. The generic /objects/component door refuses a component outright ("must
    // belong to a service"), which is what this test hit on its first run.
    await admin.components.update(component.id, {
      properties: { dockerfile: "apps/profile-web/Dockerfile" }
    });
    expect(await resolve(component.id, SOURCE_REF)).toMatchObject({
      dockerfile: "apps/profile-web/Dockerfile"
    });
  });

  it("and omits it when the component says nothing, leaving the template default to apply", async () => {
    const id = await componentPublishingTo("acme/one-service");
    expect(await resolve(id, SOURCE_REF)).not.toHaveProperty("dockerfile");
  });

  it("NEGATIVE CONTROL — a configuration Type gets none of it", async () => {
    // Without this, the assertion above is equally satisfied by a resolver that returns these
    // parameters for EVERY trigger, which would put build inputs on every deploy.
    const id = await componentPublishingTo("agentkitproject/agentkitprofile-app");
    expect(await resolve(id, SOURCE_REF, "configuration")).toBeUndefined();
  });

  it("OMITS an absent key rather than sending it empty", async () => {
    // A template that needs `sourceCommit` must fail because the parameter is MISSING — loudly —
    // rather than receive "" and build whatever HEAD happens to be. That is the difference between
    // a refused run and a wrong artifact.
    const id = await componentPublishingTo("agentkitproject/agentkitprofile-app");
    const params = await resolve(id, { repo: "AgentKitProject/agentkit" });
    expect(params).toMatchObject({ sourceRepo: "AgentKitProject/agentkit" });
    expect(params).not.toHaveProperty("sourceCommit");
    expect(params).not.toHaveProperty("sourceRef");
  });

  it("names no destination when the component declares no registry", async () => {
    const id = await componentPublishingTo(null);
    const params = await resolve(id, SOURCE_REF);
    expect(params).toMatchObject({ sourceCommit: "a".repeat(40) });
    expect(params).not.toHaveProperty("imageRepository");
    expect(params).not.toHaveProperty("imageDestination");
  });

  it("M28.1 — an `rpm` component whose registry is a CONTAINER registry is REFUSED, not handed an image destination", async () => {
    // The defect M28.1 exists to correct: the destination was derived for the whole `build`
    // Category, so an RPM build was told to push to a container registry. Written before the fix
    // and observed red against it: `expected { handed: { …(8) } } to not have property
    // "handed.imageDestination"`, received `"ghcr.io/acme/widget"`.
    const id = await componentPublishingTo("acme/widget");
    const outcome = await resolve(id, SOURCE_REF, "rpm").then(
      (handed) => ({ handed }),
      (refused: unknown) => ({ refused })
    );
    expect(outcome).not.toHaveProperty("handed.imageDestination");
    expect(outcome).not.toHaveProperty("handed.imageRepository");
    // The REFUSAL, by class and by its sentence — not any throw. A TypeError from a wrong call
    // shape would satisfy `toHaveProperty("refused")`, which is why the class is asserted.
    const refused = (outcome as { refused?: unknown }).refused;
    expect(refused).toBeInstanceOf(BuildDestinationRefused);
    expect((refused as Error).message).toContain("publishes 'rpm' packages");
    expect((refused as Error).message).toContain("a container registry");
    expect((refused as BuildDestinationRefused).inputContext).toMatchObject({
      type: "rpm",
      requiredFormat: "rpm",
      declaredPackageFormats: null,
      effectivePackageFormats: ["oci"]
    });
  });

  it("M28.1 — an `rpm` component publishing to a gitea that serves rpm gets the PACKAGE-REPO destination", async () => {
    const id = await componentPublishingTo(
      "acme/el9",
      "https://gitea.example.test",
      { kind: "gitea", packageFormats: ["oci", "rpm"] },
      { rpmSpec: "packaging/widget.spec", dockerfile: "Dockerfile" }
    );
    const params = await resolve(id, SOURCE_REF, "rpm");
    expect(params).toMatchObject({
      sourceRepo: "AgentKitProject/agentkit",
      sourceCommit: "a".repeat(40),
      packageRepository: "acme/el9",
      // Gitea's RPM registry is per OWNER with an optional GROUP: `acme/el9` is owner acme, group el9.
      rpmUploadUrl: "https://gitea.example.test/api/packages/acme/rpm/el9/upload",
      rpmRepositoryUrl: "https://gitea.example.test/api/packages/acme/rpm/el9",
      rpmSpec: "packaging/widget.spec"
    });
    // None of the container shape, and not the image Type's build definition either.
    for (const key of ["imageDestination", "imageRepository", "dockerfile"]) {
      expect(params).not.toHaveProperty(key);
    }
  });

  it("M28.1 — an owner-only repository addresses the owner's ungrouped RPM registry", async () => {
    const id = await componentPublishingTo("acme", "https://gitea.example.test/", {
      kind: "gitea",
      packageFormats: ["rpm"]
    });
    expect(await resolve(id, SOURCE_REF, "rpm")).toMatchObject({
      rpmUploadUrl: "https://gitea.example.test/api/packages/acme/rpm/upload"
    });
  });

  it("M28.1 — an `rpm` registry of a kind SCP cannot address is refused rather than guessed", async () => {
    const id = await componentPublishingTo("acme/el9", "https://nexus.example.test", {
      kind: "nexus",
      packageFormats: ["rpm"]
    });
    const err = await resolve(id, SOURCE_REF, "rpm").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildDestinationRefused);
    expect((err as Error).message).toContain("SCP derives an RPM upload address only for 'gitea'");
  });

  it("M28.1 — an `image` component publishing to an rpm-only registry is refused the other way round", async () => {
    const id = await componentPublishingTo("acme/widget", "https://gitea.example.test", {
      kind: "gitea",
      packageFormats: ["rpm"]
    });
    const err = await resolve(id, SOURCE_REF, "image").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildDestinationRefused);
    expect((err as Error).message).toContain("declares packageFormats [rpm]");
  });

  it("M28.1 — a malformed packageFormats serves nothing (a bare string is not repaired into a list)", async () => {
    const id = await componentPublishingTo("acme/widget", "https://ghcr.io", {
      packageFormats: "oci"
    });
    const err = await resolve(id, SOURCE_REF, "image").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildDestinationRefused);
    expect((err as Error).message).toContain("not a list of strings");
  });

  it("M28.1 — a registry that declares nothing is still a container registry, so `image` is unchanged", async () => {
    // The no-operator-action guarantee: every registry that existed before M28.1 has no
    // packageFormats, and an image build against it gets exactly what it got before.
    const id = await componentPublishingTo("acme/widget");
    expect(await resolve(id, SOURCE_REF, "image")).toMatchObject({
      imageDestination: "ghcr.io/acme/widget",
      imageRepository: "acme/widget",
      registryUrl: "https://ghcr.io"
    });
  });

  it.each(["npm", "deb", "maven", "python", "go", "chart", "vm-image"] as const)(
    "M28.1 — `%s` has no destination class: no destination parameters, and the registry is not consulted",
    async (type) => {
      // Neither handed a container registry (the defect) nor refused over one (a guess the other
      // way): SCP models no destination for this Type, so it derives none. Source identity only.
      const id = await componentPublishingTo("acme/widget", "https://ghcr.io", {}, {
        dockerfile: "Dockerfile"
      });
      const params = await resolve(id, SOURCE_REF, type);
      expect(params).toMatchObject({ sourceCommit: "a".repeat(40) });
      for (const key of [
        "imageDestination",
        "imageRepository",
        "registryUrl",
        "registryName",
        "rpmUploadUrl",
        "dockerfile"
      ]) {
        expect(params).not.toHaveProperty(key);
      }
    }
  );

  it("tolerates a sourceRef that is not an object at all", async () => {
    // Replicated rows from an older peer, and changes proposed with a hand-supplied `sourceRef`,
    // were never checked against a shape — so this reads defensively rather than casting.
    const id = await componentPublishingTo("agentkitproject/agentkitprofile-app");
    for (const bad of [null, undefined, "refs/heads/main", 42]) {
      const params = await resolve(id, bad);
      expect(params).not.toHaveProperty("sourceRepo");
      expect(params).toMatchObject({ imageRepository: "agentkitproject/agentkitprofile-app" });
    }
  });
});
