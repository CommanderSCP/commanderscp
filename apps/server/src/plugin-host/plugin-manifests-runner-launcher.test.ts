import { describe, expect, it } from "vitest";
import { validatePluginConfig } from "./plugin-manifests.js";

/**
 * M23.2 — LAYER 2 OF THE THREE THE ADAPTER-SELECTION FIELD HAS TO MOVE THROUGH.
 *
 * `@scp/runner-launcher`'s own header has said since M23.1 that `dockerBinary` and anything added
 * beside it live in a class enforced in three layers that must move together — each plugin's
 * manifest `configSchema` (`additionalProperties: false`), `validatePluginConfig` at the four write
 * doors, and the LAST-wins injection sites — and that "WHEN M23.2 ADDS ADAPTER SELECTION it becomes a
 * config field, and all three layers must be updated in that same change". This file is the second
 * layer, pinned BY NAME.
 *
 * WHY IT NEEDS ITS OWN TEST WHEN THE SCHEMAS ALREADY SAY `additionalProperties: false`. Because that
 * is exactly the argument that was false for `managed-scan`, and the failure was arbitrary code
 * execution on the SCP host: it authored a schema refusing `dockerBinary`, and the schema was never
 * consulted because the module had no entry in `MANIFEST_BY_MODULE` and `validatePluginConfig`
 * returned early for a module it had no manifest for. The protection existed in a doc comment. A key
 * that decides WHICH SUBSTRATE runs a tenant's managed executor — and, through
 * `kubernetes.workspaceVolume`, WHICH HOST PATH a pod mounts — is at least that class of key, so its
 * refusal is asserted rather than argued.
 *
 * `kubernetes.io` DESERVES ITS OWN SENTENCE. It is a FUNCTION-CARRYING object and therefore cannot
 * survive a JSON round trip at all — but a binding config is stored as JSON and read back, so an
 * attacker cannot smuggle a callable through it in any case. What a tenant COULD smuggle, absent
 * this refusal, is `kubernetes.workspaceVolume: { kind: "hostPath", path: "/" }`, which mounts the
 * node's root filesystem into a runner container. That is the reason the whole `kubernetes` block is
 * refused as one key rather than field by field.
 */

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
