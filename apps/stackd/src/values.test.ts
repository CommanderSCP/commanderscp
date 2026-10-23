import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StackBackendSchema, StackSizeTierSchema, type StackBackend } from "@scp/schemas";
import {
  getPath,
  loadRelease,
  parseImageOverrides,
  RETARGETABLE_IMAGE_PATHS,
  type StackRelease
} from "./release.js";
import { backendNeeds, deriveBackendValues, scaleQuantity, type ValuesContext } from "./values.js";
import { stackWideOf } from "./reconcile.js";

/**
 * THE VALUES THE CONTROLLER RENDERS WITH, against the REAL deploy/helm-bundled values.yaml.
 *
 * The census half: every string leaf of the derived values must trace to a source that is not
 * the API — the chart's own defaults, the release's retarget map, the controller's deployment
 * facts, or the Gitea secrets it read back. The spec contributes only `enabled` (always `true`
 * here) and a TIER, which picks a multiplier. A string that appears from anywhere else fails.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHART_DIR = path.resolve(HERE, "../../../deploy/helm-bundled");

async function release(overrides: Record<string, string> = {}): Promise<StackRelease> {
  const r = await loadRelease({ chartDir: CHART_DIR, version: "1.0.0-test" });
  return { ...r, imageOverrides: overrides };
}

function ctx(r: StackRelease): ValuesContext {
  return {
    release: r,
    scpNamespace: "scp-ns-fact",
    federationRole: "outpost",
    gitea: { adminPassword: "pw-fact", secretKey: "key-fact", internalToken: "token-fact" }
  };
}

function strings(v: unknown, at = ""): { at: string; value: string }[] {
  if (typeof v === "string") return [{ at, value: v }];
  if (v === null || typeof v !== "object") return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
    strings(x, at ? `${at}.${k}` : k)
  );
}

describe("deriveBackendValues", () => {
  it("renders only the one backend, with the controller's own deployment facts", async () => {
    const r = await release();
    for (const backend of StackBackendSchema.options) {
      const values = deriveBackendValues(
        { backend, enabled: true, sizeTier: "small", purgeGeneration: 0, rotateGeneration: 0 },
        ctx(r)
      );
      const be = values["bundledExecutor"] as Record<string, unknown>;
      expect(Object.keys(be).sort()).toEqual(
        [
          "scpNamespace",
          {
            argocd: "argocd",
            "argo-workflows": "argoWorkflows",
            "argo-rollouts": "argoRollouts",
            "argo-events": "argoEvents",
            gitea: "gitea"
          }[backend]
        ].sort()
      );
      expect(be["scpNamespace"]).toBe("scp-ns-fact");
      expect(values["federationRole"]).toBe("outpost");
    }
  });

  it("CENSUS: every string it emits traces to the chart, the release, or the controller — never the API", async () => {
    const overrides = {
      "argoEvents.image": "registry.internal/argo-events@sha256:" + "a".repeat(64)
    };
    const r = await release(overrides);
    const allowed = new Set<string>([
      "scp-ns-fact",
      "outpost",
      "pw-fact",
      "key-fact",
      "token-fact",
      ...Object.values(overrides),
      // The chart's own default strings (quantities, after scaling, are checked separately below).
      ...strings(r.chartValues).map((s) => s.value)
    ]);
    for (const backend of StackBackendSchema.options) {
      for (const tier of StackSizeTierSchema.options) {
        const values = deriveBackendValues(
          { backend, enabled: true, sizeTier: tier, purgeGeneration: 0, rotateGeneration: 0 },
          ctx(r)
        );
        for (const { at, value } of strings(values)) {
          const isScaledQuantity = /\.resources\./.test(at) && /^\d+(\.\d+)?[A-Za-z]*$/.test(value);
          expect(
            allowed.has(value) || isScaledQuantity,
            `${backend}/${tier}: '${at}' = '${value}' has no permitted source`
          ).toBe(true);
        }
      }
    }
  });

  it("scales every request and limit by the tier (small = the chart's defaults)", async () => {
    const r = await release();
    const small = deriveBackendValues(
      {
        backend: "argocd",
        enabled: true,
        sizeTier: "small",
        purgeGeneration: 0,
        rotateGeneration: 0
      },
      ctx(r)
    );
    const large = deriveBackendValues(
      {
        backend: "argocd",
        enabled: true,
        sizeTier: "large",
        purgeGeneration: 0,
        rotateGeneration: 0
      },
      ctx(r)
    );
    const res = (v: Record<string, unknown>) =>
      ((v["bundledExecutor"] as Record<string, Record<string, unknown>>)["argocd"]!["resources"] ??
        {}) as Record<string, { requests: { cpu: string; memory: string } }>;
    expect(res(small)["argocd-server"]!.requests).toEqual({ cpu: "100m", memory: "128Mi" });
    expect(res(large)["argocd-server"]!.requests).toEqual({ cpu: "400m", memory: "512Mi" });
    expect(scaleQuantity("1", 2)).toBe("2");
    expect(scaleQuantity("1.5", 2)).toBe("3");
    expect(scaleQuantity("1Gi", 4)).toBe("4Gi");
    expect(scaleQuantity(1, 2)).toBe("2");
  });

  it("applies a retarget only to its own backend's key", async () => {
    const r = await release({
      "argoEvents.image": "reg/argo-events:1",
      "gitea.image": "reg/gitea:1"
    });
    const events = deriveBackendValues(
      {
        backend: "argo-events",
        enabled: true,
        sizeTier: "small",
        purgeGeneration: 0,
        rotateGeneration: 0
      },
      ctx(r)
    );
    const be = events["bundledExecutor"] as Record<string, Record<string, unknown>>;
    expect(be["argoEvents"]!["image"]).toBe("reg/argo-events:1");
    expect(be["gitea"]).toBeUndefined();
  });

  it("carries Gitea's read-back secrets, and refuses to render Gitea without them", async () => {
    const r = await release();
    const v = deriveBackendValues(
      {
        backend: "gitea",
        enabled: true,
        sizeTier: "small",
        purgeGeneration: 0,
        rotateGeneration: 0
      },
      ctx(r)
    );
    expect(
      (v["bundledExecutor"] as Record<string, Record<string, unknown>>)["gitea"]
    ).toMatchObject({
      adminPassword: "pw-fact",
      secretKey: "key-fact",
      internalToken: "token-fact"
    });
    const { gitea: _omit, ...without } = ctx(r);
    expect(() =>
      deriveBackendValues(
        {
          backend: "gitea",
          enabled: true,
          sizeTier: "small",
          purgeGeneration: 0,
          rotateGeneration: 0
        },
        without
      )
    ).toThrow(/secrets/);
  });

  it("names what Argo Workflows cannot do yet, and stops naming it once configured", async () => {
    const r = await release();
    const spec = {
      backend: "argo-workflows" as StackBackend,
      enabled: true,
      sizeTier: "small" as const,
      purgeGeneration: 0,
      rotateGeneration: 0
    };
    const bare = backendNeeds(spec, deriveBackendValues(spec, ctx(r)), ctx(r));
    expect(bare.map((n) => n.code).sort()).toEqual(["infra-state-backend", "rpm-builder-image"]);
    const withRpm = await release({ "argoWorkflows.catalog.buildRpm.builderImage": "reg/rpm:1" });
    const some = backendNeeds(spec, deriveBackendValues(spec, ctx(withRpm)), ctx(withRpm));
    expect(some.map((n) => n.code)).toEqual(["infra-state-backend"]);
    expect(backendNeeds({ ...spec, backend: "gitea" }, {}, ctx(r))).toEqual([]);
  });
});

describe("M29.3: the SCP account's grant on the authoring project", () => {
  const spec = (backend: StackBackend) => ({
    backend,
    enabled: true,
    sizeTier: "small" as const,
    purgeGeneration: 0,
    rotateGeneration: 0
  });
  it("rides Argo CD's render exactly while authoring is wanted — the release's project, grant only", async () => {
    const r = await release();
    const on = deriveBackendValues(spec("argocd"), { ...ctx(r), authoring: true });
    expect(getPath(on, "bundledExecutor.argocd.authoring")).toEqual({
      project: "scp-authored",
      grantOnly: true
    });
    const off = deriveBackendValues(spec("argocd"), { ...ctx(r), authoring: false });
    expect(getPath(off, "bundledExecutor.argocd.authoring")).toBeUndefined();
    // No other backend's render changes.
    const gitea = deriveBackendValues(spec("gitea"), { ...ctx(r), authoring: true });
    expect(getPath(gitea, "bundledExecutor.argocd")).toBeUndefined();
  });
  it("is wanted exactly while Argo CD, Gitea and Argo Rollouts are all enabled", () => {
    const all = StackBackendSchema.options.map((b) => ({ ...spec(b), enabled: false }));
    const on = (...bs: StackBackend[]) =>
      stackWideOf(all.map((s) => ({ ...s, enabled: bs.includes(s.backend) }))).authoring;
    expect(on("argocd", "gitea", "argo-rollouts")).toBe(true);
    expect(on("argocd", "gitea")).toBe(false);
    expect(on("argocd", "argo-rollouts")).toBe(false);
    expect(on("gitea", "argo-rollouts")).toBe(false);
  });
});

describe("parseImageOverrides — the only deploy-time input", () => {
  it("accepts exactly the retargetable image fields", () => {
    expect(parseImageOverrides({ "argocd.image": "reg/argocd:v1" })).toEqual({
      "argocd.image": "reg/argocd:v1"
    });
    expect(RETARGETABLE_IMAGE_PATHS.every((p) => p.endsWith("image") || p.endsWith("Image"))).toBe(
      true
    );
  });

  it("refuses any other field, and anything that is not an image reference", () => {
    expect(() => parseImageOverrides({ "argocd.authoring.carrierRepoURL": "x" })).toThrow(
      /not a retargetable image field/
    );
    expect(() => parseImageOverrides({ "argocd.scpAccount": "admin" })).toThrow(
      /not a retargetable/
    );
    expect(() => parseImageOverrides({ "argocd.image": "reg/a:1\nkind: ClusterRole" })).toThrow(
      /not an image reference/
    );
    expect(() => parseImageOverrides({ "argocd.image": "reg/a:1 --set x=y" })).toThrow(
      /not an image reference/
    );
    expect(() => parseImageOverrides({ "argocd.image": 7 })).toThrow(/not an image reference/);
    expect(() => parseImageOverrides(["argocd.image"])).toThrow(/JSON object/);
  });
});
