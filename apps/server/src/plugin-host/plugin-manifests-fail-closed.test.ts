import { describe, expect, it } from "vitest";
import { ProblemError } from "../errors.js";
import { KNOWN_EXECUTOR_MODULES } from "../coordination/executor-bindings-repo.js";
import { KNOWN_NOTIFICATION_MODULES } from "../notify/notification-bindings-repo.js";
import { MANIFEST_BY_MODULE, hasPluginManifest, validatePluginConfig } from "./plugin-manifests.js";

/** A module a binding may name must have a config schema. See docs/plugin-host.md §79. */
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

/** The escalation itself, per module. See docs/plugin-host.md §80. */
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

  /** THE SAME PROPERTY, CENSUSED RATHER THAN LISTED. See docs/plugin-host.md §81. */
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
