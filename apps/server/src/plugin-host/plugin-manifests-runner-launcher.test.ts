import { describe, expect, it } from "vitest";
import { validatePluginConfig } from "./plugin-manifests.js";

/** Layer two of the three the adapter selection rests on. See docs/plugin-host.md §83. */

const MANAGED_MODULES = ["managed-iac", "managed-scan", "managed-dep"] as const;

/** A config each module accepts today, so a rejection below is caused by the ADDED key and not by
 *  the base config being wrong — the non-vacuity half. */
const VALID_TENANT_CONFIG: Record<string, Record<string, unknown>> = {
  "managed-iac": { timeoutMs: 60_000 },
  "managed-scan": { timeoutMs: 60_000 },
  "managed-dep": {
    provider: "github",
    appId: "12345",
    installationId: "67890",
    privateKeySecretKey: "dep-key"
  }
};

describe("M23.2: the launcher-selection keys are refused at the write door, for every managed module", () => {
  for (const module of MANAGED_MODULES) {
    it(`${module}: a valid tenant config is ACCEPTED — the non-vacuity control`, () => {
      expect(() => validatePluginConfig(module, VALID_TENANT_CONFIG[module])).not.toThrow();
    });

    it(`${module}: a binding may NOT set 'runnerLauncher'`, () => {
      expect(() =>
        validatePluginConfig(module, {
          ...VALID_TENANT_CONFIG[module],
          runnerLauncher: "kubernetes"
        })
      ).toThrow();
    });

    it(`${module}: a binding may NOT set 'kubernetes' — the block that names a host path`, () => {
      expect(() =>
        validatePluginConfig(module, {
          ...VALID_TENANT_CONFIG[module],
          kubernetes: {
            namespace: "kube-system",
            workspaceRoot: "/",
            workspaceVolume: { kind: "hostPath", path: "/" }
          }
        })
      ).toThrow();
    });

    it(`${module}: a binding may NOT set 'dockerBinary' either — the key this class is named after`, () => {
      // Already pinned elsewhere for managed-dep; restated here so the three keys of one class are
      // gated by one file. If this ever stops throwing, the whole class has regressed, not one key.
      expect(() =>
        validatePluginConfig(module, {
          ...VALID_TENANT_CONFIG[module],
          dockerBinary: "/tmp/evil"
        })
      ).toThrow();
    });
  }
});
