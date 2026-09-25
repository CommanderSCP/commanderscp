import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planArgoprojBackend } from "./argoproj-plan.js";
import type { VendorRefreshIO } from "./types.js";

/** A tiny, well-formed argocd install.yaml fixture — small enough to keep the test fast, shaped
 *  enough (a CRD doc, a Namespace doc, and a Deployment carrying the tracked image) to exercise the
 *  real multi-document parse path `parseKubernetesImages` also runs against the real vendor file. */
function argocdFixture(tag: string): string {
  return [
    "apiVersion: apiextensions.k8s.io/v1",
    "kind: CustomResourceDefinition",
    "metadata:",
    "  name: applications.argoproj.io",
    "---",
    "apiVersion: v1",
    "kind: Namespace",
    "metadata:",
    "  name: argocd",
    "---",
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: argocd-server",
    "  namespace: argocd",
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    "      - name: argocd-server",
    `        image: quay.io/argoproj/argocd:${tag}`,
    "---",
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: dex-server",
    "  namespace: argocd",
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    "      - name: dex",
    "        image: ghcr.io/dexidp/dex:v2.45.0",
    ""
  ].join("\n");
}

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

function ioAgainstFixtureServer(digests: Record<string, string> = {}): VendorRefreshIO {
  return {
    fetchText: async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fixture server: ${url} -> HTTP ${res.status}`);
      return res.text();
    },
    resolveImageDigest: async (ref: string) => {
      const digest = digests[ref];
      if (digest === undefined) throw new Error(`no fixture digest configured for '${ref}'`);
      return digest;
    },
    runHelmTemplate: async () => {
      throw new Error("not used by the argocd plan");
    }
  };
}

/** The tool never calls a real registry — every URL it builds is pointed at the fixture server by
 *  overriding argoprojManifestUrl's HOST via a wrapper `fetchText` that rewrites the upstream host to
 *  the local one, keeping `planArgoprojBackend` itself unaware it is talking to a fixture. */
function ioWithHostRewrite(realHost: string, io: VendorRefreshIO): VendorRefreshIO {
  return {
    ...io,
    fetchText: (url: string) => io.fetchText(url.replace(`https://${realHost}`, baseUrl))
  };
}

describe("planArgoprojBackend (argocd)", () => {
  it("vendors the fetched manifest unmodified and resolves the one tracked image's digest", async () => {
    fixtureBody = argocdFixture("v3.5.0");
    const digest = `sha256:${"b".repeat(64)}`;
    const io = ioWithHostRewrite(
      "raw.githubusercontent.com",
      ioAgainstFixtureServer({ "quay.io/argoproj/argocd:v3.5.0": digest })
    );

    const plan = await planArgoprojBackend("argocd", "v3.5.0", io);

    expect(plan.files).toEqual([
      { path: "deploy/helm-bundled/vendor/argocd/install.yaml", content: fixtureBody }
    ]);
    expect(plan.trackedImages).toEqual([
      {
        bundleImageName: "argocd",
        tagRef: "quay.io/argoproj/argocd:v3.5.0",
        resolvedRef: `quay.io/argoproj/argocd:v3.5.0@${digest}`
      }
    ]);
    // The reader test's own subject (dex) surfaces here too — a real, useful cross-check, not a
    // coincidence: both consume the same `parseKubernetesImages`.
    expect(plan.summary).toContain("NOT tracked");
    expect(plan.summary).toContain("ghcr.io/dexidp/dex:v2.45.0");
  });

  it("is deterministic: planning the same tag twice against the same fixture produces identical files", async () => {
    fixtureBody = argocdFixture("v3.5.0");
    const digest = `sha256:${"c".repeat(64)}`;
    const io = ioWithHostRewrite(
      "raw.githubusercontent.com",
      ioAgainstFixtureServer({ "quay.io/argoproj/argocd:v3.5.0": digest })
    );
    const first = await planArgoprojBackend("argocd", "v3.5.0", io);
    const second = await planArgoprojBackend("argocd", "v3.5.0", io);
    expect(second.files).toEqual(first.files);
    expect(second.trackedImages).toEqual(first.trackedImages);
  });

  it("throws rather than silently vendoring nothing when the fetch is empty", async () => {
    fixtureBody = "";
    const io = ioWithHostRewrite("raw.githubusercontent.com", ioAgainstFixtureServer());
    await expect(planArgoprojBackend("argocd", "v3.5.0", io)).rejects.toThrow(/empty body/);
  });

  it("throws (rather than silently skipping) when the manifest no longer declares the tracked image", async () => {
    fixtureBody = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: argocd\n";
    const io = ioWithHostRewrite("raw.githubusercontent.com", ioAgainstFixtureServer());
    await expect(planArgoprojBackend("argocd", "v3.5.0", io)).rejects.toThrow(
      /expected to find 'quay.io\/argoproj\/argocd'/
    );
  });
});
