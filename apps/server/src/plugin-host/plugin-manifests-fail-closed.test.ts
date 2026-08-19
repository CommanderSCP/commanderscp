import { describe, expect, it } from "vitest";
import { ProblemError } from "../errors.js";
import { KNOWN_EXECUTOR_MODULES } from "../coordination/executor-bindings-repo.js";
import { KNOWN_NOTIFICATION_MODULES } from "../notify/notification-bindings-repo.js";
import { MANIFEST_BY_MODULE, hasPluginManifest, validatePluginConfig } from "./plugin-manifests.js";

/**
 * THE PROPERTY: a plugin module a binding may name must have a config schema, and a module with no
 * schema must be REFUSED rather than skipped.
 *
 * `validatePluginConfig` used to open `if (!manifest) return;`, justified by a comment saying an
 * unknown module is "caught separately (the module allowlist)". True of an UNKNOWN module; silent
 * about the case that existed — a module ON the allowlist with NO manifest. Three were in that
 * state on shipped main (`fake-executor`, `pipeline-generic`, `managed-scan`), so their bindings'
 * configs were stored with no validation at all. `@scp/plugin-managed-scan` runs
 * `execFile(config.dockerBinary ?? "docker", …)`, and `dockerBinary` was not among the keys the
 * server injected either — so that was a tenant principal reaching arbitrary code execution on the
 * SCP host. (It IS injected now, as independent defence in depth; the schema refusal below is the
 * primary gate and this file is what proves the gate runs.)
 *
 * A COMMENT IS NOT THE GUARD — the comment above `MANIFEST_BY_MODULE` already reasoned about this
 * exact property for the dependency-index plugins, and `managed-scan` slipped past it anyway. Hence
 * this file, plus the module-load `assertEveryModuleHasManifest` calls beside each allowlist.
 *
 * MUTATION LOG (each applied ALONE against a green suite, then reverted):
 *  | mutation                                                    | result                          |
 *  |-------------------------------------------------------------|---------------------------------|
 *  | restore `if (!manifest) return;` in `validatePluginConfig`   | 1 failed — the fail-CLOSED test |
 *  | drop `"managed-scan"` from `MANIFEST_BY_MODULE`              | file fails to LOAD: the boot     |
 *  |                                                              | assertion throws, naming it     |
 *  | drop `additionalProperties:false` from pipeline-generic      | 2 failed — pipeline-generic AND |
 *  |                                                              | its `terraform` preset          |
 *  | drop `additionalProperties:false` from fake-executor         | 1 failed — fake-executor        |
 *  | add manifest-less `webhook-control` to the NOTIFICATION list | file fails to LOAD: that        |
 *  |                                                              | allowlist's assertion throws    |
 *  | drop `stateRefByTarget` from fake-executor's `configSchema`  | 2 failed — the hand-typed       |
 *  |                                                              | negative control (`expected 400 |
 *  |                                                              | to be undefined`) AND the       |
 *  |                                                              | derived census (`expected […5]  |
 *  |                                                              | to include 'stateRefByTarget'`) |
 *
 * A MUTATION TO A `packages/plugins/*` MANIFEST NEEDS `turbo build --force` BEFORE THIS FILE RUNS
 * (pass 11): the manifests are imported through `main: dist/index.js`, so a `src/`-only edit leaves
 * this suite green for the most misleading possible reason.
 */
describe("every allowlisted plugin module has a config schema", () => {
  it("KNOWN_EXECUTOR_MODULES — all of them, no exemptions", () => {
    const missing = KNOWN_EXECUTOR_MODULES.filter((module) => !hasPluginManifest(module));
    expect(missing).toEqual([]);
    // NEGATIVE CONTROL: the assertion above is only meaningful if the list is non-trivial and the
    // predicate can actually say "no" — otherwise an empty list, or a `hasPluginManifest` stubbed to
    // true, would pass it just as happily.
    expect(KNOWN_EXECUTOR_MODULES.length).toBeGreaterThan(5);
    expect(hasPluginManifest("no-such-module")).toBe(false);
  });

  it("KNOWN_NOTIFICATION_MODULES — the same door, the same gate, censused not assumed", () => {
    const missing = KNOWN_NOTIFICATION_MODULES.filter((module) => !hasPluginManifest(module));
    expect(missing).toEqual([]);
    expect(KNOWN_NOTIFICATION_MODULES.length).toBeGreaterThan(0);
  });

  it("the three modules the fail-open covered are specifically in the map", () => {
    // Named individually as well as covered by the sweep above: the sweep goes green again the
    // moment someone deletes a module from the allowlist, which is not the same as fixing it.
    for (const module of ["fake-executor", "pipeline-generic", "managed-scan"]) {
      expect(MANIFEST_BY_MODULE[module], module).toBeDefined();
    }
  });
});

describe("validatePluginConfig fails CLOSED on a module with no manifest", () => {
  it("refuses with a 400, rather than returning as if the config had been checked", () => {
    let thrown: unknown;
    try {
      validatePluginConfig("module-with-no-manifest", { dockerBinary: "/bin/sh" });
    } catch (err) {
      thrown = err;
    }
    // Asserted on the STRUCTURED error, not on wording: a prose assertion goes green for a
    // rephrased message and red for a fixed one.
    expect(thrown).toBeInstanceOf(ProblemError);
    expect((thrown as ProblemError).status).toBe(400);
  });
});

/**
 * The escalation itself, per module: each server-governed key is refused, and — the control that
 * makes the refusals mean something — a legitimate config for the same module is still ACCEPTED. A
 * schema that refuses everything closes the hole and breaks the executor, and the refusal tests
 * alone cannot tell the two apart.
 */
describe("server-governed keys are refused; legitimate configs still work", () => {
  /** Every key `resolveExecutorPluginInstance` injects, plus the one it does NOT and the plugin
   *  `execFile`s — `dockerBinary`, the actual escalation. */
  const SERVER_GOVERNED = [
    "dockerBinary",
    "runnerImage",
    "networkMode",
    "workspaceRoot",
    "statePath"
  ] as const;

  function refusalStatus(module: string, config: unknown): number | undefined {
    try {
      validatePluginConfig(module, config);
      return undefined;
    } catch (err) {
      return err instanceof ProblemError ? err.status : -1;
    }
  }

  it("managed-scan: a binding may not choose the binary the plugin executes", () => {
    for (const key of SERVER_GOVERNED) {
      expect(refusalStatus("managed-scan", { [key]: "/tmp/pwn" }), key).toBe(400);
    }
    // NEGATIVE CONTROL — the one key managed-scan's tenant surface actually offers.
    expect(refusalStatus("managed-scan", { timeoutMs: 60_000 })).toBeUndefined();
    expect(refusalStatus("managed-scan", {})).toBeUndefined();
  });

  it("pipeline-generic: server-governed keys and typos refused, a real pipeline config accepted", () => {
    const valid = { triggerUrl: "https://ci.example.test/hooks/deploy" };
    for (const key of SERVER_GOVERNED) {
      expect(refusalStatus("pipeline-generic", { ...valid, [key]: "/tmp/pwn" }), key).toBe(400);
    }
    // A typo is the everyday form of the same property: an unlisted key used to be stored and then
    // silently ignored at dispatch.
    expect(refusalStatus("pipeline-generic", { ...valid, runIdFeild: "id" })).toBe(400);
    // NEGATIVE CONTROLS — the full documented tenant surface is accepted, and `triggerUrl` really is
    // required (so "accepted" above is not just an unenforced schema).
    expect(
      refusalStatus("pipeline-generic", {
        ...valid,
        tokenSecretKey: "ci-token",
        statusUrl: "https://ci.example.test/runs/{externalId}",
        abortUrl: "https://ci.example.test/runs/{externalId}/cancel",
        runIdField: "id",
        statusField: "status",
        succeededValues: ["applied"],
        failedValues: ["errored"]
      })
    ).toBeUndefined();
    expect(refusalStatus("pipeline-generic", {})).toBe(400);
  });

  it("terraform (a pipeline-generic preset) inherits the tightened schema — the preset is not a hole", () => {
    // `terraform` shares `pipelineGenericConfigSchema` verbatim. Fixing only the module named in the
    // report would have left the preset permissive, which is the same bug under another id.
    const valid = { triggerUrl: "https://app.terraform.io/api/v2/runs" };
    for (const key of SERVER_GOVERNED) {
      expect(refusalStatus("terraform", { ...valid, [key]: "/tmp/pwn" }), key).toBe(400);
    }
    expect(refusalStatus("terraform", valid)).toBeUndefined();
  });

  it("fake-executor: statePath refused, its deterministic test hooks accepted", () => {
    for (const key of SERVER_GOVERNED) {
      expect(refusalStatus("fake-executor", { [key]: "/tmp/pwn" }), key).toBe(400);
    }
    // NEGATIVE CONTROLS — everything the integration suites legitimately configure it with.
    expect(refusalStatus("fake-executor", {})).toBeUndefined();
    expect(
      refusalStatus("fake-executor", {
        autoSucceedAfterMs: 50,
        forcePhase: { "target-b": "failed" },
        imagesByTarget: { "target-a": ["ghcr.io/acme/api@sha256:abc"] },
        rolloutByTarget: { "target-a": { phase: "Healthy", step: 2 } },
        detailByTarget: { "target-a": "a third-party plugin's free-form detail" },
        stateRefByTarget: { "target-a": "7d34ef12+ff3fd8a3" },
        observeEvents: [{ type: "sync", targetRef: "target-a" }]
      })
    ).toBeUndefined();
  });

  /**
   * THE SAME PROPERTY, CENSUSED RATHER THAN LISTED — M23.0 verification pass 11.
   *
   * The literal above is a hand-typed restatement of "the tenant surface", and it was TWO KEYS
   * behind when this was written: `detailByTarget` (added by pass 8) and `stateRefByTarget` (pass
   * 10) had both reached `configSchema` without reaching this list. That is the same shape as the
   * defect pass 8 found one level down — `@scp/plugin-fake-executor`'s own
   * `config-schema-parity.test.ts` censuses the INTERFACE against the SCHEMA for exactly this
   * reason — and a hand-typed list here reintroduces it at the place where the schema is actually
   * ENFORCED.
   *
   * So: read the schema's own properties, build a value from each property's declared TYPE, and
   * require the enforcement point to accept it. A key that the schema declares but the validator
   * rejects is a tenant-facing 400 on a documented option; a key added to the schema later is
   * covered on the day it is added. The sample builder deliberately fills one entry of an
   * `additionalProperties` map rather than passing `{}`, so the VALUE type is exercised too — `{}`
   * satisfies every object schema and would make this arm vacuous.
   */
  it("fake-executor: EVERY key its schema declares is accepted at the enforcement point", () => {
    type Schema = {
      type?: string;
      properties?: Record<string, Schema>;
      items?: Schema;
      additionalProperties?: Schema | boolean;
    };
    function sampleFor(schema: Schema | undefined): unknown {
      switch (schema?.type) {
        case "integer":
        case "number":
          return 1;
        case "boolean":
          return true;
        case "array":
          return [sampleFor(schema.items)];
        case "object": {
          const extra = schema.additionalProperties;
          if (extra && typeof extra === "object") return { "target-a": sampleFor(extra) };
          const props = schema.properties ?? {};
          return Object.fromEntries(
            Object.entries(props).map(([k, v]) => [k, sampleFor(v)] as const)
          );
        }
        default:
          return "sample";
      }
    }
    const schema = MANIFEST_BY_MODULE["fake-executor"]!.configSchema as Schema;
    const keys = Object.keys(schema.properties ?? {});
    // NON-VACUITY: the parse really found the tenant surface, and it includes the two keys that
    // the hand-typed list above had missed.
    expect(keys.length).toBeGreaterThan(5);
    expect(keys).toContain("detailByTarget");
    expect(keys).toContain("stateRefByTarget");

    const rejected = keys.filter(
      (key) =>
        refusalStatus("fake-executor", { [key]: sampleFor(schema.properties![key]) }) !== undefined
    );
    expect(
      rejected,
      "the schema declares these keys as the tenant-facing surface but the validator refuses them"
    ).toEqual([]);
  });

  it("managed-iac (the module that was ALREADY gated) is unchanged — the reference shape", () => {
    for (const key of SERVER_GOVERNED) {
      expect(refusalStatus("managed-iac", { [key]: "/tmp/pwn" }), key).toBe(400);
    }
    expect(
      refusalStatus("managed-iac", {
        timeoutMs: 60_000,
        infraCredsSecretKeys: { AWS_ACCESS_KEY_ID: "aws-key" }
      })
    ).toBeUndefined();
  });
});
