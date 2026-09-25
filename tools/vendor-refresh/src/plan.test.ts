import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  planVendorRefresh,
  BUNDLE_IMAGES_TS_PATH,
  IMAGES_LIST_PATH,
  VALUES_YAML_PATH
} from "./plan.js";
import type { ReadRepoFile } from "./plan.js";
import type { VendorRefreshIO } from "./types.js";

const ARGOCD_MANIFEST = (tag: string) =>
  [
    "apiVersion: v1",
    "kind: Namespace",
    "metadata:",
    "  name: argocd",
    "---",
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: argocd-server",
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    "      - name: argocd-server",
    `        image: quay.io/argoproj/argocd:${tag}`,
    ""
  ].join("\n");

const FIXTURE_FILES: Record<string, string> = {
  [VALUES_YAML_PATH]:
    "image: quay.io/argoproj/argocd:v3.4.5 # Argo CD (Apache-2.0)\nvalkeyImage: valkey/valkey:8-alpine\n",
  [BUNDLE_IMAGES_TS_PATH]: '{ name: "argocd", defaultRef: "quay.io/argoproj/argocd:v3.4.5" }\n',
  [IMAGES_LIST_PATH]:
    "# no argocd line today\ndocker.io/library/postgres@sha256:aaaa   postgres:16\n"
};

let server: Server;
let baseUrl: string;
let fixtureBody = "";

beforeEach(async () => {
  server = createServer((req, res) => {
    if (req.url === "/argoproj/argo-cd/v3.5.0/manifests/install.yaml") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(fixtureBody);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ioAgainstFixtureServer(digest: string): VendorRefreshIO {
  return {
    fetchText: async (url: string) => {
      const res = await fetch(url.replace("https://raw.githubusercontent.com", baseUrl));
      if (!res.ok) throw new Error(`fixture server: ${url} -> HTTP ${res.status}`);
      return res.text();
    },
    resolveImageDigest: async () => digest,
    runHelmTemplate: async () => {
      throw new Error("not used");
    }
  };
}

function readFixtureFile(files: Record<string, string> = FIXTURE_FILES): ReadRepoFile {
  return async (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`fixture: no such file '${path}'`);
    return content;
  };
}

describe("planVendorRefresh (argocd, end to end against fixtures)", () => {
  it("produces the vendored manifest AND the three patched downstream files", async () => {
    fixtureBody = ARGOCD_MANIFEST("v3.5.0");
    const io = ioAgainstFixtureServer(`sha256:${"9".repeat(64)}`);
    const plan = await planVendorRefresh("argocd", "v3.5.0", io, readFixtureFile());

    const byPath = new Map(plan.files.map((f) => [f.path, f.content]));
    expect(byPath.get("deploy/helm-bundled/vendor/argocd/install.yaml")).toBe(fixtureBody);
    expect(byPath.get(VALUES_YAML_PATH)).toBe(
      "image: quay.io/argoproj/argocd:v3.5.0 # Argo CD (Apache-2.0)\nvalkeyImage: valkey/valkey:8-alpine\n"
    );
    expect(byPath.get(BUNDLE_IMAGES_TS_PATH)).toBe(
      '{ name: "argocd", defaultRef: "quay.io/argoproj/argocd:v3.5.0" }\n'
    );
    // images.list has no argocd line today — left untouched, and NOT included in the file set at all
    // (nothing changed, so nothing to write).
    expect(byPath.has(IMAGES_LIST_PATH)).toBe(false);
  });

  it("IS DETERMINISTIC: planning the same tag twice against the same fixtures produces an identical file set", async () => {
    fixtureBody = ARGOCD_MANIFEST("v3.5.0");
    const io = ioAgainstFixtureServer(`sha256:${"9".repeat(64)}`);
    const first = await planVendorRefresh("argocd", "v3.5.0", io, readFixtureFile());
    const second = await planVendorRefresh("argocd", "v3.5.0", io, readFixtureFile());
    expect(second.files).toEqual(first.files);
  });

  it("DOES patch images.list when the backend's image is already listed there", async () => {
    fixtureBody = ARGOCD_MANIFEST("v3.5.0");
    const io = ioAgainstFixtureServer(`sha256:${"9".repeat(64)}`);
    const files = {
      ...FIXTURE_FILES,
      [IMAGES_LIST_PATH]:
        "quay.io/argoproj/argocd@sha256:" + "0".repeat(64) + "   quay.io/argoproj/argocd:v3.4.5\n"
    };
    const plan = await planVendorRefresh("argocd", "v3.5.0", io, readFixtureFile(files));
    const byPath = new Map(plan.files.map((f) => [f.path, f.content]));
    expect(byPath.get(IMAGES_LIST_PATH)).toBe(
      `quay.io/argoproj/argocd@sha256:${"9".repeat(64)}   quay.io/argoproj/argocd:v3.5.0\n`
    );
  });

  it("rejects an unknown backend name", async () => {
    const io = ioAgainstFixtureServer(`sha256:${"9".repeat(64)}`);
    await expect(
      planVendorRefresh("not-a-backend", "v1.0.0", io, readFixtureFile())
    ).rejects.toThrow(/unknown backend/);
  });

  it("throws when values.yaml no longer declares the tracked image (a stale coordinate)", async () => {
    fixtureBody = ARGOCD_MANIFEST("v3.5.0");
    const io = ioAgainstFixtureServer(`sha256:${"9".repeat(64)}`);
    const files = { ...FIXTURE_FILES, [VALUES_YAML_PATH]: "nothing about argocd here\n" };
    await expect(planVendorRefresh("argocd", "v3.5.0", io, readFixtureFile(files))).rejects.toThrow(
      /values\.yaml declares no reference/
    );
  });

  it("never writes the same path twice", async () => {
    fixtureBody = ARGOCD_MANIFEST("v3.5.0");
    const io = ioAgainstFixtureServer(`sha256:${"9".repeat(64)}`);
    const plan = await planVendorRefresh("argocd", "v3.5.0", io, readFixtureFile());
    const paths = plan.files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
