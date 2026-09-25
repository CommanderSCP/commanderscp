import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StackBackendSchema, type StackView } from "@scp/schemas";
import {
  apiServiceName,
  bootstrapAdminSecretName,
  chartFullname,
  declareHqOutpost,
  defaultBackendsForRole,
  deploymentModeForProfile,
  helmSetArgs,
  readBootstrapAdminPassword,
  resolveDesiredBackends,
  runInstall,
  waitForStackReport,
  wantsStackController,
  type ExecResult,
  type Shell
} from "./install-cli.js";

/** `scp install` — M29.1 (the front door). Pure decision logic first, then the orchestration
 *  against a FAKE shell + a mocked SDK (never a real kubectl/helm/docker/network call). */

// ---------------------------------------------------------------------------------------------
// Pure functions.
// ---------------------------------------------------------------------------------------------

describe("defaultBackendsForRole / wantsStackController", () => {
  it("commander gets the full Standard Stack", () => {
    expect(defaultBackendsForRole("commander").sort()).toEqual(
      ["argocd", "argo-workflows", "argo-events", "argo-rollouts", "gitea"].sort()
    );
  });

  it("outpost is deploy-side only by default (ADR: proposal §5)", () => {
    expect(defaultBackendsForRole("outpost").sort()).toEqual(
      ["argocd", "argo-rollouts", "gitea"].sort()
    );
  });

  it("retrans gets nothing, and the controller is not even turned on", () => {
    expect(defaultBackendsForRole("retrans")).toEqual([]);
    expect(wantsStackController("retrans")).toBe(false);
    expect(wantsStackController("commander")).toBe(true);
    expect(wantsStackController("outpost")).toBe(true);
  });
});

describe("resolveDesiredBackends", () => {
  it("role default with no flags", () => {
    expect(resolveDesiredBackends("outpost", [], []).sort()).toEqual(
      ["argocd", "argo-rollouts", "gitea"].sort()
    );
  });

  it("--with adds beyond the default", () => {
    expect(resolveDesiredBackends("outpost", ["argo-workflows"], [])).toContain("argo-workflows");
  });

  it("--without removes a default", () => {
    expect(resolveDesiredBackends("commander", [], ["gitea"])).not.toContain("gitea");
  });

  it("--without wins over --with for the same backend (last-writer in this function's own order)", () => {
    // Not a real conflict a caller should hit, but the function must be total: verifying it
    // resolves deterministically either way rather than throwing.
    const result = resolveDesiredBackends("commander", ["gitea"], ["gitea"]);
    expect(result).not.toContain("gitea");
  });

  it("rejects an unknown backend name — parsed against the schema, never a copied list", () => {
    expect(() => resolveDesiredBackends("commander", ["harbor"], [])).toThrow(
      /backend must be one of/
    );
  });

  it("is stable-ordered (schema order), not flag-insertion order", () => {
    const a = resolveDesiredBackends("commander", [], []);
    const b = resolveDesiredBackends("commander", ["gitea", "argocd"], []);
    expect(a).toEqual(b);
  });
});

describe("deploymentModeForProfile", () => {
  it("eval -> evaluation, everything else -> production (D6 fail-closed default)", () => {
    expect(deploymentModeForProfile("eval")).toBe("evaluation");
    expect(deploymentModeForProfile("production")).toBe("production");
  });
});

describe("chartFullname / secret / service names", () => {
  it("appends -commanderscp when the release name doesn't already carry it", () => {
    expect(chartFullname("scp")).toBe("scp-commanderscp");
  });

  it("leaves a release name that already contains it alone (mirrors _helpers.tpl)", () => {
    expect(chartFullname("my-commanderscp-install")).toBe("my-commanderscp-install");
  });

  it("secret and service names derive from fullname, matching the chart's own templates", () => {
    expect(bootstrapAdminSecretName("scp")).toBe("scp-commanderscp-bootstrap-admin");
    expect(apiServiceName("scp")).toBe("scp-commanderscp-api");
  });
});

describe("helmSetArgs", () => {
  it("always turns on the bootstrap instance-operator grant seam (ADR-0058 §7)", () => {
    const args = helmSetArgs({
      role: "commander",
      profile: "eval",
      orgName: "default",
      adminUsername: "admin"
    });
    expect(args).toContain("instanceOperator.grantBootstrapAdmin=true");
  });

  it("does NOT set stackd.enabled for commander/outpost — the chart's own default (true) covers it", () => {
    const args = helmSetArgs({
      role: "commander",
      profile: "eval",
      orgName: "default",
      adminUsername: "admin"
    });
    expect(args.some((a) => a.startsWith("stackd.enabled"))).toBe(false);
  });

  it("turns stackd OFF for retrans — nothing to install, so the near-cluster-admin controller stays off", () => {
    const args = helmSetArgs({
      role: "retrans",
      profile: "eval",
      orgName: "default",
      adminUsername: "admin"
    });
    expect(args).toContain("stackd.enabled=false");
  });

  it("eval profile brings its own in-cluster postgres", () => {
    const args = helmSetArgs({
      role: "commander",
      profile: "eval",
      orgName: "default",
      adminUsername: "admin"
    });
    expect(args).toContain("postgres.evalInCluster.enabled=true");
  });

  it("production profile does not touch postgres.evalInCluster", () => {
    const args = helmSetArgs({
      role: "commander",
      profile: "production",
      orgName: "default",
      adminUsername: "admin"
    });
    expect(args.some((a) => a.startsWith("postgres.evalInCluster"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The credential-surfacing step — mutation-proved directly (BUILD_AND_TEST.md §M29.1 DoD:
// "deleting the installer's credential-surfacing step turns a test red").
// ---------------------------------------------------------------------------------------------

function fakeShell(overrides: Partial<Shell> = {}): Shell {
  const calls: { method: string; args: unknown[] }[] = [];
  const base: Shell = {
    async exec(cmd, args) {
      calls.push({ method: "exec", args: [cmd, args] });
      return { code: 0, stdout: "", stderr: "" } satisfies ExecResult;
    },
    log(line) {
      calls.push({ method: "log", args: [line] });
    },
    async readSecretKey() {
      calls.push({ method: "readSecretKey", args: [] });
      return "correct-horse-battery-staple";
    },
    async redactSecretKey() {
      calls.push({ method: "redactSecretKey", args: [] });
    }
  };
  const shell = { ...base, ...overrides };
  (shell as Shell & { __calls: typeof calls }).__calls = calls;
  return shell;
}

describe("readBootstrapAdminPassword — the credential-surfacing step", () => {
  it("returns the Secret's plaintext when it is there", async () => {
    const shell = fakeShell();
    const pw = await readBootstrapAdminPassword(
      shell,
      { namespace: "scp", releaseName: "scp" },
      { attempts: 3, delayMs: 1 }
    );
    expect(pw).toBe("correct-horse-battery-staple");
  });

  it(
    "MUTATION: if the Secret is never readable (the surfacing step deleted/broken), this throws " +
      "rather than silently falling back to a pod log — proving the step is load-bearing",
    async () => {
      const shell = fakeShell({ readSecretKey: async () => null });
      await expect(
        readBootstrapAdminPassword(
          shell,
          { namespace: "scp", releaseName: "scp" },
          { attempts: 2, delayMs: 1 }
        )
      ).rejects.toThrow(/could not read the bootstrap admin password/);
    }
  );

  it("reads the exact Secret name the chart generates (secrets-generated.yaml)", async () => {
    const seen: unknown[] = [];
    const shell = fakeShell({
      readSecretKey: async (opts) => {
        seen.push(opts);
        return "pw";
      }
    });
    await readBootstrapAdminPassword(
      shell,
      { namespace: "ns1", releaseName: "myrel" },
      { attempts: 1, delayMs: 1 }
    );
    expect(seen).toEqual([
      {
        context: undefined,
        namespace: "ns1",
        name: "myrel-commanderscp-bootstrap-admin",
        key: "password"
      }
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// waitForStackReport — "ready (or its needs shown)".
// ---------------------------------------------------------------------------------------------

function stackView(
  statuses: Partial<Record<(typeof StackBackendSchema.options)[number], "ready" | "needs" | null>>
): StackView {
  // Cast at the boundary: this is a test fixture builder, not production code, and the schema's
  // `needs[].code` enum is irrelevant to what `waitForStackReport` actually branches on (whether
  // `status` is null at all).
  return {
    settings: { updatePolicy: "automatic", upgradeGeneration: 1 },
    controller: {
      release: "1.0.0",
      lastSeenAt: "2026-09-25T00:00:00Z",
      reporting: true,
      observedUpgradeGeneration: 1
    },
    backends: StackBackendSchema.options.map((backend) => {
      const s = statuses[backend];
      return {
        backend,
        enabled: s !== undefined,
        sizeTier: "small" as const,
        purgeGeneration: 0,
        status:
          s === undefined || s === null
            ? null
            : {
                phase: s === "ready" ? ("ready" as const) : ("installing" as const),
                runningVersion: s === "ready" ? "1.0.0" : null,
                targetVersion: "1.0.0",
                lastError: null,
                needs:
                  s === "needs"
                    ? [{ code: "state-backend", message: "needs a state backend" }]
                    : [],
                observedAt: "2026-09-25T00:00:00Z"
              }
      };
    })
  } as unknown as StackView;
}

describe("waitForStackReport", () => {
  it("returns as soon as every desired backend has SOME status (ready)", async () => {
    const client = { stack: { get: async () => stackView({ gitea: "ready" }) } };
    const result = await waitForStackReport(client, ["gitea"], 5, 1);
    expect(result.backends.find((b) => b.backend === "gitea")?.status?.phase).toBe("ready");
  });

  it("also accepts 'needs' as a report — the DoD's explicit escape hatch", async () => {
    const client = { stack: { get: async () => stackView({ gitea: "needs" }) } };
    const result = await waitForStackReport(client, ["gitea"], 5, 1);
    expect(
      result.backends.find((b) => b.backend === "gitea")?.status?.needs.length
    ).toBeGreaterThan(0);
  });

  it("polls until every desired backend reports, not just the first one", async () => {
    let call = 0;
    const client = {
      stack: {
        get: async () => {
          call += 1;
          return call < 3
            ? stackView({ gitea: "ready" })
            : stackView({ gitea: "ready", argocd: "needs" });
        }
      }
    };
    const result = await waitForStackReport(client, ["gitea", "argocd"], 5, 1);
    expect(result.backends.find((b) => b.backend === "argocd")?.status).not.toBeNull();
    expect(call).toBeGreaterThanOrEqual(3);
  });

  it("times out and returns the last snapshot rather than hanging forever", async () => {
    const client = { stack: { get: async () => stackView({}) } };
    const result = await waitForStackReport(client, ["gitea"], 0.05, 10);
    expect(result.backends.every((b) => b.status === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// declareHqOutpost — idempotent through the EXISTING federation outpost declare API path.
// ---------------------------------------------------------------------------------------------

// ONE consolidated `vi.mock("@scp/sdk")` for the whole file — a second call would silently
// overwrite the first (module mocks are per-module-id, not additive) instead of erroring, which
// is exactly the kind of silent-shadow bug this repo's CLAUDE.md asks a census to catch, so the
// SDK mock lives in a single `vi.hoisted` block every describe() below shares.
const { FakeScpApiError, sdkCalls, hoistedStackView } = vi.hoisted(() => {
  class FakeScpApiError extends Error {
    status?: number;
    constructor(status: number) {
      super("conflict");
      this.status = status;
    }
  }
  const sdkCalls: { method: string; args: unknown[] }[] = [];
  function hoistedStackView(argocdPhase: "ready" | null) {
    return {
      settings: { updatePolicy: "automatic", upgradeGeneration: 1 },
      controller: {
        release: "1.0.0",
        lastSeenAt: "2026-09-25T00:00:00Z",
        reporting: true,
        observedUpgradeGeneration: 1
      },
      backends: [
        {
          backend: "argocd",
          enabled: true,
          sizeTier: "small",
          purgeGeneration: 0,
          status:
            argocdPhase === "ready"
              ? {
                  phase: "ready",
                  runningVersion: "1.0.0",
                  targetVersion: "1.0.0",
                  lastError: null,
                  needs: [],
                  observedAt: "2026-09-25T00:00:00Z"
                }
              : null
        },
        ...(["argo-workflows", "argo-events", "argo-rollouts", "gitea"] as const).map(
          (backend) => ({
            backend,
            enabled: false,
            sizeTier: "small",
            purgeGeneration: 0,
            status: null
          })
        )
      ]
    };
  }
  return { FakeScpApiError, sdkCalls, hoistedStackView };
});

vi.mock("@scp/sdk", async () => {
  const actual = await vi.importActual<typeof import("@scp/sdk")>("@scp/sdk");
  class ScpClient {
    async login(username: string, password: string) {
      sdkCalls.push({ method: "login", args: [username, password] });
      return { token: "tok-1", expiresAt: "2030-01-01T00:00:00Z", org: "default" };
    }
    federation = {
      init: async (req: unknown) => {
        sdkCalls.push({ method: "federation.init", args: [req] });
        return { domainId: "dom-1", name: "hq", role: "commander" };
      },
      self: async () => {
        sdkCalls.push({ method: "federation.self", args: [] });
        return { domainId: "dom-1", name: "hq", role: "commander" as const, publicKey: "pk" };
      },
      createOutpost: async (req: unknown) => {
        sdkCalls.push({ method: "federation.createOutpost", args: [req] });
        return {};
      }
    };
    stack = {
      get: async () => {
        sdkCalls.push({ method: "stack.get", args: [] });
        return hoistedStackView("ready");
      },
      putBackend: async (backend: unknown, req: unknown) => {
        sdkCalls.push({ method: "stack.putBackend", args: [backend, req] });
        return hoistedStackView("ready");
      }
    };
  }
  return { ...actual, ScpClient, ScpApiError: FakeScpApiError };
});

let configDir: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  sdkCalls.length = 0;
  configDir = await mkdtemp(path.join(tmpdir(), "scp-install-cli-test-"));
  process.env.SCP_CONFIG_DIR = configDir;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("declareHqOutpost", () => {
  it("declares the HQ outpost as this instance's own domain id (peer = self)", async () => {
    const calls: unknown[] = [];
    const client = {
      federation: {
        self: async () => ({
          domainId: "dom-1",
          name: "hq",
          role: "commander" as const,
          publicKey: "pk"
        }),
        createOutpost: async (req: unknown) => {
          calls.push(req);
          return {};
        }
      }
    };
    await declareHqOutpost(client);
    expect(calls).toEqual([{ peerDomainId: "dom-1" }]);
  });

  it("a 409 (already declared) is treated as success — idempotent re-run", async () => {
    const client = {
      federation: {
        self: async () => ({
          domainId: "dom-1",
          name: "hq",
          role: "commander" as const,
          publicKey: "pk"
        }),
        createOutpost: async () => {
          throw new FakeScpApiError(409);
        }
      }
    };
    await expect(declareHqOutpost(client)).resolves.toBeUndefined();
  });

  it("any other failure propagates — 409 is the only status swallowed", async () => {
    const client = {
      federation: {
        self: async () => ({
          domainId: "dom-1",
          name: "hq",
          role: "commander" as const,
          publicKey: "pk"
        }),
        createOutpost: async () => {
          throw new FakeScpApiError(500);
        }
      }
    };
    await expect(declareHqOutpost(client)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// runInstall — kube mode, end to end against a fake shell + the same mocked SDK client above.
// ---------------------------------------------------------------------------------------------

describe("runInstall — kube mode", () => {
  it(
    "helm installs with the role/profile values, reads+deletes the credential, logs in, enables " +
      "the role's backends, and declares the HQ outpost — all through the given --base-url (no port-forward)",
    async () => {
      const shell = fakeShell();
      const summary = await runInstall(
        {
          role: "commander",
          profile: "eval",
          mode: "kube",
          namespace: "scp",
          releaseName: "scp",
          with: [],
          without: ["argo-workflows", "argo-events", "argo-rollouts", "gitea"], // keep the test to one backend
          yes: true,
          orgName: "default",
          adminUsername: "admin",
          baseUrl: "http://127.0.0.1:9-fake/api/v1",
          portForwardPort: 18080,
          helmTimeoutSeconds: 60,
          stackTimeoutSeconds: 1,
          dryRun: false,
          bootstrapK3s: false,
          set: []
        },
        shell
      );

      const execCalls = (
        shell as Shell & { __calls: { method: string; args: unknown[] }[] }
      ).__calls.filter((c) => c.method === "exec");
      const helmCall = execCalls.find((c) => (c.args[0] as string) === "helm");
      expect(helmCall).toBeDefined();
      const helmArgs = helmCall!.args[1] as string[];
      expect(helmArgs).toContain("--set");
      expect(helmArgs).toContain("federationRole=commander");
      expect(helmArgs).toContain("bootstrap.orgName=default");

      const redactCalls = (
        shell as Shell & { __calls: { method: string; args: unknown[] }[] }
      ).__calls.filter((c) => c.method === "redactSecretKey");
      expect(redactCalls).toHaveLength(1);

      expect(sdkCalls.find((c) => c.method === "login")).toEqual({
        method: "login",
        args: ["admin", "correct-horse-battery-staple"]
      });
      expect(sdkCalls.find((c) => c.method === "stack.putBackend")?.args).toEqual([
        "argocd",
        { enabled: true }
      ]);
      expect(sdkCalls.find((c) => c.method === "federation.createOutpost")).toBeDefined();
      // Measured against a real kind cluster: without this, HQ-outpost declare 400s — the chart's
      // federationRole=commander value alone never reaches the org's federation identity row.
      expect(sdkCalls.find((c) => c.method === "federation.init")?.args).toEqual([
        { name: "default", role: "commander" }
      ]);

      expect(summary.hqOutpostDeclared).toBe(true);
      expect(summary.loggedInAs).toBe("admin");

      // Credentials were actually saved (config-store.ts), so a following `scp whoami` would work —
      // the DoD's "reaches a logged-in admin session", not just a printed token.
      const saved = JSON.parse(await readFile(path.join(configDir, "credentials.json"), "utf8"));
      expect(saved.token).toBe("tok-1");
    }
  );

  it("retrans never touches the stack API and never declares an HQ outpost", async () => {
    const shell = fakeShell();
    const summary = await runInstall(
      {
        role: "retrans",
        profile: "eval",
        mode: "kube",
        namespace: "scp",
        releaseName: "scp",
        with: [],
        without: [],
        yes: true,
        orgName: "default",
        adminUsername: "admin",
        baseUrl: "http://127.0.0.1:9-fake/api/v1",
        portForwardPort: 18080,
        helmTimeoutSeconds: 60,
        stackTimeoutSeconds: 1,
        dryRun: false,
        bootstrapK3s: false,
        set: []
      },
      shell
    );
    expect(sdkCalls.find((c) => c.method === "stack.putBackend")).toBeUndefined();
    expect(sdkCalls.find((c) => c.method === "federation.createOutpost")).toBeUndefined();
    expect(summary.hqOutpostDeclared).toBe(false);
  });

  it("--dry-run executes nothing (no exec, no login)", async () => {
    const shell = fakeShell();
    await runInstall(
      {
        role: "commander",
        profile: "eval",
        mode: "kube",
        namespace: "scp",
        releaseName: "scp",
        with: [],
        without: [],
        yes: true,
        orgName: "default",
        adminUsername: "admin",
        portForwardPort: 18080,
        helmTimeoutSeconds: 60,
        stackTimeoutSeconds: 1,
        dryRun: true,
        bootstrapK3s: false,
        set: []
      },
      shell
    );
    const calls = (shell as Shell & { __calls: { method: string; args: unknown[] }[] }).__calls;
    expect(calls.filter((c) => c.method === "exec")).toHaveLength(0);
    expect(sdkCalls).toHaveLength(0);
  });
});
