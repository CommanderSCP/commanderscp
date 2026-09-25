import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHelmPin, resolveHelm } from "./helm.js";

/** ONE helm pin, and every consumer of it agrees (the cosign/skopeo pin discipline). */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const PIN_FILE = path.join(REPO, "tools/helm/pin.env");

function pinEnv(text: string, key: string): string {
  const m = new RegExp(`^${key}=(.+)$`, "m").exec(text);
  if (!m) throw new Error(`${key} not found`);
  return m[1]!.trim();
}

function dockerfileArg(text: string, name: string): string {
  const m = new RegExp(`^ARG ${name}=(.+)$`, "m").exec(text);
  if (!m) throw new Error(`ARG ${name} has no default in apps/stackd/Dockerfile`);
  return m[1]!.trim();
}

describe("the helm pin", () => {
  it("apps/stackd/Dockerfile's defaults are tools/helm/pin.env's values", async () => {
    const pin = parseHelmPin(await readFile(PIN_FILE, "utf8"));
    const dockerfile = await readFile(path.join(REPO, "apps/stackd/Dockerfile"), "utf8");
    expect(dockerfileArg(dockerfile, "HELM_PINNED_VERSION")).toBe(pin.version);
    expect(dockerfileArg(dockerfile, "HELM_TARBALL_SHA256")).toBe(pin.tarballSha256);
    // The image puts the binary exactly where the pin says, and ships the pin beside it.
    expect(dockerfile).toContain(`COPY --from=helm /tmp/linux-amd64/helm ${pin.vendoredPath}`);
    expect(dockerfile).toContain("COPY tools/helm/pin.env /opt/scp/stack/helm.pin.env");
    // The checksum is checked BEFORE extraction.
    const check = dockerfile.indexOf("sha256sum -c -");
    const extract = dockerfile.indexOf("tar -xzf /tmp/helm.tgz");
    expect(check).toBeGreaterThan(0);
    expect(extract).toBeGreaterThan(check);
  });

  it("the image's Node base is the one tools/node/pin.env pins", async () => {
    const node = await readFile(path.join(REPO, "tools/node/pin.env"), "utf8");
    const dockerfile = await readFile(path.join(REPO, "apps/stackd/Dockerfile"), "utf8");
    expect(dockerfileArg(dockerfile, "NODE_IMAGE")).toBe(pinEnv(node, "NODE_PINNED_IMAGE"));
  });

  it("CI's installer reads the pin file, checks the sha256, and asserts the version", async () => {
    const script = await readFile(path.join(REPO, "scripts/install-pinned-helm.sh"), "utf8");
    expect(script).toContain('. "${repo_root}/tools/helm/pin.env"');
    expect(script).toContain('echo "${HELM_TARBALL_SHA256}  ${work}/helm.tgz" | sha256sum -c -');
    expect(script).toContain('if [ "$got" != "$HELM_PINNED_VERSION" ]; then');
  });

  it("the sha256 is a sha256", async () => {
    const pin = parseHelmPin(await readFile(PIN_FILE, "utf8"));
    expect(pin.tarballSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.version).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});

describe("resolveHelm refuses any binary that is not the pin", () => {
  let dir: string;
  const fakeHelm = async (name: string, version: string): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(
      file,
      `#!/bin/sh\nif [ "$1" = version ]; then printf '%s' '${version}'; exit 0; fi\n` +
        `if [ "$1" = template ]; then printf 'apiVersion: v1\\nkind: ConfigMap\\nmetadata:\\n  name: from-%s\\n' "$3"; exit 0; fi\nexit 1\n`
    );
    await chmod(file, 0o755);
    return file;
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "stackd-helm-pin-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts the pinned version and renders through a values FILE", async () => {
    const pin = parseHelmPin(await readFile(PIN_FILE, "utf8"));
    const helm = await resolveHelm({
      pinFile: PIN_FILE,
      binary: await fakeHelm("good", pin.version)
    });
    expect(helm.version).toBe(pin.version);
    expect(await helm.template("/chart", { a: 1 })).toContain("name: from-/chart");
  });

  it("refuses a different version, naming both", async () => {
    await expect(
      resolveHelm({ pinFile: PIN_FILE, binary: await fakeHelm("other", "v3.99.0") })
    ).rejects.toThrow(/refusing to render the Standard Stack with helm v3\.99\.0.*the pin is v/);
  });

  it("refuses a binary that is not there", async () => {
    await expect(
      resolveHelm({ pinFile: PIN_FILE, binary: path.join(dir, "absent") })
    ).rejects.toThrow(/could not be run/);
  });
});
