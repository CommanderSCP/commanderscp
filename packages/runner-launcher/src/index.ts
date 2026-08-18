import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `@scp/runner-launcher` — THE ONE PLACE A MANAGED RUNNER IS LAUNCHED (BUILD_AND_TEST.md §8 M23.1).
 *
 * WHY THIS PACKAGE EXISTS. Three managed executors — `scp-managed-iac`, `scp-managed-scan` and
 * `scp-managed-dep` — each hand-rolled the identical five-step sequence against a Docker CLI:
 * `create` -> `cp` in -> `start -a` -> `cp` out -> `rm -f`. Three independent implementations of one
 * mechanism is exactly the incomplete-call-site-census property CLAUDE.md and BUILD_AND_TEST.md §4.4
 * name: a fix, a hardening or a new platform arm has to be applied three times, and the instance
 * that gets missed is invisible because the other two are green. A fourth managed class would make
 * it four. THE SEAM IS THE DELIVERABLE.
 *
 * WHAT THIS PACKAGE IS NOT. It is not a normalisation. The three call sites disagree about real
 * things — whether evidence is copied out after a failed run, whether a failed copy-out fails the
 * run, how big a stdout buffer to allow, whether the network mode is a config read or a charter
 * literal — and every one of those disagreements is load-bearing and pinned by a golden
 * (`launch-argv.golden.test.ts` in each plugin). They are therefore expressed as FIELDS OF THE SPEC
 * the caller supplies ({@link RunnerCopyOut.when}, {@link RunnerCopyOut.onFailure},
 * {@link RunnerSpec.maxBuffer}, {@link RunnerSpec.networkMode}), never as a shared default this
 * package chose. A port that made the three uniform would be a behaviour change wearing a
 * refactor's clothes.
 *
 * WHAT THIS PACKAGE DELIBERATELY PRESERVES, INCLUDING THE BUGS. M23.0 recorded three pre-existing
 * defects and deliberately did not fix them, because fixing them means knowingly breaking a golden
 * and "byte-identical" then becomes untestable:
 *   1. `docker create` failing ORPHANS nothing but also cleans nothing — the `finally { rm -f }`
 *      only begins after `create` RESOLVES, and no `--name`/`--label` is passed, so a container
 *      created by a call that then timed out carries no attribution. Reproduced exactly below: the
 *      `create` await sits OUTSIDE the `try`. Fixing it is now ONE edit here, not three.
 *   2. A managed-scan run whose copy-out fails ends stuck in `pending`. That is the plugin's outer
 *      error handling, not this port's — {@link RunnerCopyOut.onFailure} `"propagate"` reproduces
 *      the rejection that causes it.
 *   3. managed-iac puts resolved credentials on the `create` argv, readable from the host process
 *      table. Reproduced by {@link RunnerSpec.env}; the Kubernetes adapter (M23.2) is where
 *      Secret-backed env replaces it, which is why `env` is a list of `KEY=VALUE` strings rather
 *      than an argv fragment — an adapter that does NOT use `-e` can still honour it.
 *
 * NO NEW CONFIG SURFACE, ON PURPOSE. The server-injected/never-tenant-settable class
 * (`dockerBinary`, `runnerImage`, `networkMode`, `workspaceRoot`, `statePath`) is enforced in three
 * layers that must move together: each plugin's manifest `configSchema`
 * (`additionalProperties: false`), `validatePluginConfig` at the four write doors
 * (`routes/executors.ts` x3 and `iac/plans-repo.ts`), and the LAST-wins injection sites
 * (`coordination/executor-bindings-repo.ts`, `dependencies/managed-dep-instance.ts`,
 * `federation/promotion-scan-step.ts`). M23.1 adds NO field to that class: the adapter is chosen in
 * CODE (there is only one), and the seam a test drives is a factory parameter, not configuration.
 * WHEN M23.2 ADDS ADAPTER SELECTION it becomes a config field, and all three layers must be updated
 * in that same change — {@link RunnerLauncherConfig} is where the field will land.
 */

/** One `docker cp` of a host directory's CONTENTS into the container (the trailing `/.`). */
export interface RunnerCopyIn {
  /** HOST directory. Its contents are copied, not the directory itself. */
  hostDir: string;
  /** Absolute destination path INSIDE the container. */
  containerPath: string;
}

/**
 * Whether the evidence copy-out runs after a FAILED start.
 *  - `"always"` — managed-iac: a failed `apply` may still have produced a partial `plan.json`.
 *  - `"on-success"` — managed-scan (a failed scan must produce NO evidence, so E6 refuses) and
 *    managed-dep (a partial manifest must never reach the verifiers).
 */
export type RunnerCopyOutWhen = "always" | "on-success";

/**
 * Where a FAILED copy-out lands.
 *  - `"swallow"` — managed-iac: `.catch(() => undefined)`, the run stays `succeeded`.
 *  - `"propagate"` — managed-scan and managed-dep: the rejection escapes {@link RunnerLauncher.run}.
 *    The two plugins then answer it differently (scan lets it escape `trigger()`; dep's outer catch
 *    turns it into a `failed` outcome), which is the plugins' business, not this port's.
 */
export type RunnerCopyOutOnFailure = "swallow" | "propagate";

/** One `docker cp` of a container directory's CONTENTS back out to the host. */
export interface RunnerCopyOut {
  /** Absolute source path INSIDE the container. Its contents are copied (the trailing `/.`). */
  containerPath: string;
  /** HOST destination directory. */
  hostDir: string;
  when: RunnerCopyOutWhen;
  onFailure: RunnerCopyOutOnFailure;
}

/** One runner launch, described completely — nothing about it is defaulted by the adapter. */
export interface RunnerSpec {
  /** The vetted, pinned runner image. SERVER-GOVERNED at every caller; never tenant-suppliable. */
  image: string;
  /** The runner's own entrypoint operands, in order, AFTER the image on the command line. */
  operands: string[];
  /**
   * The network the runner gets. SERVER-GOVERNED where it is a config read (managed-iac,
   * managed-scan) and a CHARTER LITERAL where it is not (managed-dep's `RUNNER_NETWORK_MODE`, ADR-0032
   * §8d) — this port takes the resolved value and never decides it, precisely so the difference
   * between "an operator may change this" and "an operator may not" stays at the call site where the
   * charter clause is quoted.
   */
  networkMode: string;
  /**
   * Ordered `KEY=VALUE` environment entries. The Docker adapter emits each as its own `-e` pair
   * before the image; an adapter that mounts a Secret instead can honour the same list. Empty for
   * managed-dep, which passes no environment at all.
   */
  env: string[];
  /** Copy-INs, in the order they must be issued (managed-scan issues one to three). */
  copyIn: RunnerCopyIn[];
  /** The single evidence copy-OUT, if this runner produces one. */
  copyOut?: RunnerCopyOut;
  /** Per-call `timeout`. 10 min for managed-iac and managed-scan, 5 min for managed-dep. */
  timeoutMs: number;
  /** Per-call `maxBuffer`. 16 MiB / 32 MiB / 8 MiB respectively — NOT one shared default. */
  maxBuffer: number;
}

/** What a runner run produced. `succeeded` is the runner's own exit status, not the launch's. */
export interface RunnerResult {
  succeeded: boolean;
  stdout: string;
  stderr: string;
}

/**
 * THE PORT. One verb, because a managed runner has exactly one lifecycle: run it to completion and
 * hand back what it printed. Adapters: Docker (below, for compose/VM) and — M23.2, not before —
 * Kubernetes Jobs.
 */
export interface RunnerLauncher {
  run(spec: RunnerSpec): Promise<RunnerResult>;
}

/**
 * The adapter-selecting slice of a plugin's (server-injected) config.
 *
 * `dockerBinary` is the only field today, and it is already in the server-injected,
 * never-tenant-settable class: absent from all three manifests' `additionalProperties: false`
 * schemas, refused by `validatePluginConfig` at the four write doors, and injected LAST from
 * `SCP_MANAGED_RUNNER_DOCKER_BINARY`. `managed-scan` shipped a live RCE precisely because that chain
 * had a hole in it (it sat on `KNOWN_EXECUTOR_MODULES` with no manifest, so `validatePluginConfig`
 * returned early); `assertEveryModuleHasManifest` closes that at boot now. ANY FIELD ADDED HERE
 * JOINS THAT CLASS ON DAY ONE — all three layers, in the same change.
 */
export interface RunnerLauncherConfig {
  /** SERVER-INJECTED (never tenant): the container CLI to exec. Defaults to `"docker"`. */
  dockerBinary?: string;
}

/**
 * How a plugin obtains the launcher for one run. A FUNCTION rather than a launcher instance because
 * a plugin object is constructed once (`createManagedIacExecutorPlugin()`) while its config arrives
 * per `trigger()` on `ctx.config` — the adapter therefore has to be resolved per run.
 *
 * This is also the injection seam the wiring tests drive: passing a resolver that throws must make a
 * NAMED test fail, which is the only check that distinguishes "the port is wired" from "the port
 * exists and the plugin still does it the old way" (CLAUDE.md's component-built-never-installed).
 */
export type ResolveRunnerLauncher = (config: RunnerLauncherConfig) => RunnerLauncher;

/**
 * The teardown call's own timeout, and it is NOT the run timeout — a tenant `timeoutMs` never
 * reaches `rm`. It also carries NO `maxBuffer`; both absences are pinned by all three goldens.
 */
export const RUNNER_REMOVE_TIMEOUT_MS = 30_000;

/** The Docker adapter's default CLI. Server-injected in production; this is the unit-test fallback. */
export const DEFAULT_DOCKER_BINARY = "docker";

/**
 * THE DOCKER ADAPTER — `create` / `cp` in / `start -a` / `cp` out / `rm -f`, reproducing what the
 * three plugins each did, byte for byte. Every argv string and every options object below is what
 * the three `launch-argv.golden.test.ts` files recorded BEFORE this package existed; those goldens
 * are the proof, and they were not edited to make this pass.
 *
 * Never a `-v` bind mount, never a docker socket, always the caller's resolved `--network`: a
 * host-path escape stays structurally impossible because nothing is mounted, only copied.
 */
export function createDockerRunnerLauncher(
  dockerBinary: string = DEFAULT_DOCKER_BINARY
): RunnerLauncher {
  return {
    async run(spec: RunnerSpec): Promise<RunnerResult> {
      const timeout = spec.timeoutMs;
      const maxBuffer = spec.maxBuffer;
      const envArgs = spec.env.flatMap((entry) => ["-e", entry]);

      // 1. CREATE (not run). The container exists but has not started; `docker cp` requires exactly
      //    that state.
      //
      //    THIS AWAIT IS OUTSIDE THE `try` ON PURPOSE, and it is the pre-existing defect M23.0
      //    recorded (a `create` that times out after the daemon made the container leaves it behind,
      //    unattributed). Preserved so the goldens stay honest; it is now ONE place to fix.
      const { stdout: createOut } = await execFileAsync(
        dockerBinary,
        ["create", "--network", spec.networkMode, ...envArgs, spec.image, ...spec.operands],
        { timeout, maxBuffer }
      );
      const containerId = createOut.trim();

      try {
        // 2. COPY IN — the caller's directories' CONTENTS, in the caller's order.
        for (const copy of spec.copyIn) {
          await execFileAsync(
            dockerBinary,
            ["cp", `${copy.hostDir}/.`, `${containerId}:${copy.containerPath}`],
            { timeout, maxBuffer }
          );
        }

        // 3. START attached — blocks until the container exits and propagates its exit code, so a
        //    non-zero runner rejects here and is captured as `succeeded: false` with its stderr.
        let succeeded: boolean;
        let stdout: string;
        let stderr: string;
        try {
          const r = await execFileAsync(dockerBinary, ["start", "-a", containerId], {
            timeout,
            maxBuffer
          });
          succeeded = true;
          stdout = r.stdout;
          stderr = r.stderr;
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message: string };
          succeeded = false;
          stdout = e.stdout ?? "";
          stderr = e.stderr ?? e.message;
        }

        // 4. COPY OUT — conditionally, and guarded or not, exactly as the caller asked. Both axes
        //    differ between the three callers and both are load-bearing.
        const copyOut = spec.copyOut;
        if (copyOut && (copyOut.when === "always" || succeeded)) {
          const pending = execFileAsync(
            dockerBinary,
            ["cp", `${containerId}:${copyOut.containerPath}/.`, copyOut.hostDir],
            { timeout, maxBuffer }
          );
          if (copyOut.onFailure === "swallow") {
            await pending.catch(() => undefined);
          } else {
            await pending;
          }
        }

        return { succeeded, stdout, stderr };
      } finally {
        // 5. Destroy the container (and therefore any credential-carrying env) unconditionally.
        await execFileAsync(dockerBinary, ["rm", "-f", containerId], {
          timeout: RUNNER_REMOVE_TIMEOUT_MS
        }).catch(() => undefined);
      }
    }
  };
}

/**
 * The default resolver every managed executor uses today: one adapter, Docker, built from the
 * server-injected `dockerBinary`. M23.2 replaces this with a switch on an explicit operator setting
 * — NEVER an auto-detection of the platform (M15.4 declined to create that runtime/install-time
 * fork, and guessing from the presence of a service-account token is exactly that guess).
 */
export const resolveDockerRunnerLauncher: ResolveRunnerLauncher = (config) =>
  createDockerRunnerLauncher(config.dockerBinary ?? DEFAULT_DOCKER_BINARY);
