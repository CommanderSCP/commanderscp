import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { ScpClient, ScpApiError } from "@scp/sdk";
import {
  StackBackendSchema,
  type StackBackend,
  type StackBackendView,
  type StackView
} from "@scp/schemas";
import { saveCredentials } from "./config-store.js";
import { promptLine } from "./prompt.js";
import { stackBackendRow, stackControllerLine } from "./stack-cli.js";
import { printResult } from "./output.js";

/**
 * `scp install` — M29.1, "the front door" (docs/BUILD_AND_TEST.md §M29, docs/adr/0060-front-door.md).
 *
 * Wraps the THREE install paths that already exist and does not re-implement any of them:
 *   - `deploy/helm` via `helm`, for a Kubernetes context (connected).
 *   - `deploy/airgap/assets/install.sh`, for a signed air-gap bundle.
 *   - `deploy/compose`, for a VM (`docker compose`).
 *
 * On top of "run the installer", it does the four things nothing before it did in one place
 * (docs/proposals/zero-to-running.md §2's measured gap, §4 the customer journey):
 *   1. turns the stack controller on and pre-selects the role's default backends;
 *   2. surfaces the bootstrap admin's one-time password FROM the installer's own terminal — never
 *      only a pod log (see readBootstrapAdminPassword below, and local-auth.ts);
 *   3. logs in with it, so the install ends at a verified, logged-in admin session, not a printed
 *      password the operator still has to use by hand;
 *   4. declares the HQ outpost for a commander, idempotently, through the existing
 *      `federation outpost declare` API path (M16.2's `createOutpost`).
 */

// ---------------------------------------------------------------------------------------------
// Pure decision logic — unit-tested without touching a shell, a cluster, or the network.
// ---------------------------------------------------------------------------------------------

export type FederationRole = "commander" | "outpost" | "retrans";
export type InstallProfile = "eval" | "production";
export type SubstrateMode = "kube" | "compose";

/** The role's default stack (proposal §5). Retrans gets none — "a relay validates and forwards;
 *  it runs nothing", so this installer never even turns the controller on for one (see
 *  `wantsStackController`). Outpost's Argo Workflows (M18 dev pipelines) is opt-in via `--with`,
 *  not a role default — most outposts deploy only, per the table. */
export function defaultBackendsForRole(role: FederationRole): StackBackend[] {
  switch (role) {
    case "commander":
      return ["argocd", "argo-workflows", "argo-events", "argo-rollouts", "gitea"];
    case "outpost":
      return ["argocd", "argo-rollouts", "gitea"];
    case "retrans":
      return [];
  }
}

/** Does this role's install run the stack controller at all? Retrans is deliberately "or not at
 *  all" (proposal §3a "Per role") — near-cluster-admin rights (ADR-0058) with nothing to install
 *  is a grant to refuse, not a default to accept. */
export function wantsStackController(role: FederationRole): boolean {
  return role !== "retrans";
}

/** role defaults, minus `--without`, plus `--with` — the non-interactive form of the checklist.
 *  Invalid backend names throw (parsed against the SCHEMA, never a copied list — the CLI
 *  convention `stack-cli.ts`'s `backendOf` already established). */
export function resolveDesiredBackends(
  role: FederationRole,
  withFlags: readonly string[],
  withoutFlags: readonly string[]
): StackBackend[] {
  const parse = (raw: string): StackBackend => {
    const parsed = StackBackendSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `--with/--without backend must be one of ${StackBackendSchema.options.join("|")} (got '${raw}')`
      );
    }
    return parsed.data;
  };
  const withSet = new Set(withFlags.map(parse));
  const withoutSet = new Set(withoutFlags.map(parse));
  const base = new Set(defaultBackendsForRole(role));
  for (const b of withSet) base.add(b);
  for (const b of withoutSet) base.delete(b);
  // Stable, schema order — not insertion order, so two runs with the same flags print identically.
  return StackBackendSchema.options.filter((b) => base.has(b));
}

/** `deploymentMode` chart value for a profile — D6 (§7.3): production is the fail-closed default
 *  everywhere else in this codebase, so `eval` is the one value this installer ever asks for by
 *  name; anything else stays `production`. */
export function deploymentModeForProfile(profile: InstallProfile): "evaluation" | "production" {
  return profile === "eval" ? "evaluation" : "production";
}

/** Mirrors `deploy/helm/templates/_helpers.tpl`'s `commanderscp.fullname` for the DEFAULT chart
 *  (`nameOverride`/`fullnameOverride` unset — this installer never sets either): `<release>` when
 *  the release name already contains "commanderscp", else `<release>-commanderscp`. Needed to name
 *  the bootstrap-admin Secret and the api Service/Deployment without a second `helm template` just
 *  to ask the chart what it called itself. */
export function chartFullname(releaseName: string): string {
  return releaseName.includes("commanderscp") ? releaseName : `${releaseName}-commanderscp`;
}

export function bootstrapAdminSecretName(releaseName: string): string {
  return `${chartFullname(releaseName)}-bootstrap-admin`;
}

export function apiServiceName(releaseName: string): string {
  return `${chartFullname(releaseName)}-api`;
}

/** The `helm upgrade --install` values this installer sets for every kube-mode install, connected
 *  or air-gapped — the values a plain `helm install` would otherwise need typed by hand (the
 *  measured gap, proposal §2: "no role choice, no profile choice, no guidance"). Does NOT include
 *  `stackd.enabled` (the chart's OWN default is now `true` — ADR-0058 "the default flip", flipped
 *  by this milestone) so a bare `helm install` with no `scp install` involved gets it too; explicit
 *  here only for `retrans`, which turns it back OFF (`wantsStackController`). */
export function helmSetArgs(opts: {
  role: FederationRole;
  profile: InstallProfile;
  orgName: string;
  adminUsername: string;
}): string[] {
  const args = [
    `federationRole=${opts.role}`,
    `deploymentMode=${deploymentModeForProfile(opts.profile)}`,
    `instanceOperator.grantBootstrapAdmin=true`,
    `bootstrap.orgName=${opts.orgName}`,
    `bootstrap.adminUsername=${opts.adminUsername}`
  ];
  if (opts.profile === "eval") {
    // The eval stack owns its own Postgres rather than asking a fresh kind/VM install for an
    // external one it cannot have — the same choice docker-compose.yml's eval stack and
    // kind-drill.sh's install both make.
    args.push("postgres.evalInCluster.enabled=true");
  }
  if (!wantsStackController(opts.role)) {
    args.push("stackd.enabled=false");
  }
  return args.flatMap((kv) => ["--set", kv]);
}

// ---------------------------------------------------------------------------------------------
// Shell — the one seam between the pure logic above and an actual cluster/process/network. Real
// implementation below (`nodeShell`); a fake stands in for it in unit tests (install-cli.test.ts).
// ---------------------------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Shell {
  exec(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<ExecResult>;
  log(line: string): void;
  /** Reads a Kubernetes Secret's single key, base64-decoded. Its own method (not a raw `exec`)
   *  because it is the ONE call in this file that ever reads a plaintext credential — the
   *  install-cli.test.ts census greps for this name, and a second call site would be the sweep
   *  this repo's CLAUDE.md asks for. */
  readSecretKey(opts: {
    context?: string;
    namespace: string;
    name: string;
    key: string;
  }): Promise<string | null>;
  /**
   * Blanks a Secret's key — NEVER deletes the Secret object itself. Measured against a real kind
   * cluster while building this command: the api Deployment's default `replicaCount: 2` means a
   * pod can be (re)scheduled onto this Secret AFTER the installer has already logged in and moved
   * on — a node drain, `kubectl rollout restart`, a later `helm upgrade`'s rolling update, anything
   * that creates a new pod for this Deployment. `secretKeyRef` resolution is a kubelet-level,
   * CONTAINER-START-TIME check: if the SECRET OBJECT is gone, the new pod never starts at all
   * (`CreateContainerConfigError: secret "…-bootstrap-admin" not found`) — observed directly this
   * way the first time this command deleted the whole Secret post-login. An emptied VALUE under an
   * still-existing KEY has none of that failure mode (Kubernetes only refuses a missing Secret or a
   * missing key, never an empty value), and it is enough: the plaintext is gone from the cluster,
   * and the app-side property this exists for (ensureBootstrapAdmin's `existingAdmin` check) means
   * no code path ever reads this env var again once the admin row exists, whatever it now contains.
   */
  redactSecretKey(opts: {
    context?: string;
    namespace: string;
    name: string;
    key: string;
  }): Promise<void>;
}

function kubectlArgs(context: string | undefined, rest: string[]): string[] {
  return context ? ["--context", context, ...rest] : rest;
}

export function nodeShell(): Shell {
  return {
    async exec(cmd, args, opts) {
      return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
          env: { ...process.env, ...(opts?.env ?? {}) },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
    },
    log(line) {
      console.log(line);
    },
    async readSecretKey({ context, namespace, name, key }) {
      const result = await this.exec("kubectl", [
        ...kubectlArgs(context, ["get", "secret", name]),
        "-n",
        namespace,
        "-o",
        `jsonpath={.data.${key}}`
      ]);
      if (result.code !== 0 || result.stdout.trim() === "") return null;
      return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
    },
    async redactSecretKey({ context, namespace, name, key }) {
      await this.exec("kubectl", [
        ...kubectlArgs(context, ["patch", "secret", name]),
        "-n",
        namespace,
        "--type=merge",
        "-p",
        JSON.stringify({ stringData: { [key]: "" } })
      ]);
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------------------------

export interface InstallOpts {
  role: FederationRole;
  profile: InstallProfile;
  mode: SubstrateMode;
  bundle?: string;
  registry?: string;
  pubkey?: string;
  insecureRegistry?: boolean;
  kubeContext?: string;
  namespace: string;
  releaseName: string;
  with: string[];
  without: string[];
  yes: boolean;
  orgName: string;
  adminUsername: string;
  baseUrl?: string;
  portForwardPort: number;
  helmTimeoutSeconds: number;
  stackTimeoutSeconds: number;
  dryRun: boolean;
  bootstrapK3s: boolean;
  /** Escape hatch: additional raw `helm --set key=value` pairs (kube mode only — forwarded to
   *  install.sh's SCP_EXTRA_HELM_SET under --bundle), for a chart value this command has no
   *  dedicated flag for. Also what points a test run at a locally built/loaded image
   *  (`--set image.repository=... --set image.tag=... --set image.pullPolicy=Never`) instead of
   *  the published one — see the kind e2e script. */
  set: string[];
}

/** The repo root, resolved from this file's own location — `deploy/helm`, `deploy/compose` and
 *  `deploy/airgap/assets/install.sh` are all repo-relative, and `scp install` must find them
 *  wherever the CLI is invoked from (a checkout, a global install, a kind e2e script). Mirrors
 *  `deploy/airgap/assets/install.sh`'s own `SCRIPT_DIR` self-location. */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/cli/src (source) or packages/cli/dist (built) -> repo root is three levels up.
  return path.resolve(here, "..", "..", "..");
}

async function run(
  shell: Shell,
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; allowFailure?: boolean }
): Promise<ExecResult> {
  shell.log(`$ ${cmd} ${args.join(" ")}`);
  const result = await shell.exec(cmd, args, opts);
  if (result.stdout.trim()) shell.log(result.stdout.trim());
  if (result.code !== 0 && !opts?.allowFailure) {
    if (result.stderr.trim()) shell.log(result.stderr.trim());
    throw new Error(`${cmd} exited ${result.code}`);
  }
  return result;
}

/** Is a Kubernetes cluster reachable at all? Used for the "no cluster? offer k3s" branch
 *  (proposal §3a). A non-zero exit or a timeout both mean "no". */
async function clusterReachable(shell: Shell, context: string | undefined): Promise<boolean> {
  const result = await shell.exec(
    "kubectl",
    kubectlArgs(context, ["cluster-info", "--request-timeout=5s"])
  );
  return result.code === 0;
}

/** Single-node k3s bootstrap (proposal §3a option 1). Small and connected-only, deliberately: the
 *  official installer is `curl https://get.k3s.io | sh -`, a network fetch by design, so it has no
 *  air-gapped form here — `bootstrapK3sOrRefuse` below refuses with the exact reason and what to
 *  run instead rather than pretending offline support exists. */
async function bootstrapK3s(shell: Shell): Promise<void> {
  shell.log("no reachable Kubernetes cluster and --bootstrap-k3s was given: installing k3s.");
  await run(shell, "sh", ["-c", "curl -sfL https://get.k3s.io | sh -"]);
  // k3s writes its own kubeconfig readable only by root; copy it somewhere this process' user can
  // read, exactly what the official docs tell an operator to do by hand.
  await run(shell, "sh", [
    "-c",
    "mkdir -p ~/.kube && sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/scp-k3s-config && chmod 600 ~/.kube/scp-k3s-config"
  ]);
  shell.log(
    "k3s installed. Re-run with --kube-context default --kubeconfig ~/.kube/scp-k3s-config " +
      "(or merge it into your usual kubeconfig) if this shell's KUBECONFIG doesn't already see it."
  );
}

async function bootstrapK3sOrRefuse(
  shell: Shell,
  opts: { bootstrapK3s: boolean; airGapped: boolean }
): Promise<void> {
  if (opts.airGapped) {
    throw new Error(
      "no reachable Kubernetes cluster, and this is an air-gapped install (--bundle): the " +
        "single-node k3s bootstrap this installer can offer is a network fetch " +
        "(https://get.k3s.io) by design, so it has no air-gapped form in this milestone. " +
        "Install a Kubernetes cluster first — e.g. k3s from your own air-gapped mirror or " +
        "distribution media (see https://docs.k3s.io/installation/airgap) — then re-run " +
        "`scp install --bundle ... --kube-context <ctx>`. (M29.1 scope note: an air-gapped k3s " +
        "bootstrap was left undelivered rather than half-built; see the M29.1 PR.)"
    );
  }
  if (!opts.bootstrapK3s) {
    throw new Error(
      "no reachable Kubernetes cluster (`kubectl cluster-info` failed) and --mode kube was " +
        "requested. Point --kube-context at an existing cluster, pass --mode compose for a VM " +
        "install, or pass --bootstrap-k3s to install a single-node k3s here now " +
        "(runs `curl https://get.k3s.io | sh -`, a network fetch)."
    );
  }
  await bootstrapK3s(shell);
}

/** The interactive checklist (proposal §4 step 1: "presented as choices with the role's defaults
 *  pre-selected... The user can switch any backend off"). Skipped entirely under `--yes` or when
 *  stdin is not a TTY — the non-interactive form is `--with`/`--without` alone. */
async function chooseBackends(
  role: FederationRole,
  opts: { yes: boolean; withFlags: string[]; withoutFlags: string[] }
): Promise<StackBackend[]> {
  const resolved = resolveDesiredBackends(role, opts.withFlags, opts.withoutFlags);
  if (opts.yes || !process.stdin.isTTY || !wantsStackController(role)) {
    return wantsStackController(role) ? resolved : [];
  }
  console.log(`\nStandard Stack for role '${role}' (Enter keeps the default):`);
  const chosen: StackBackend[] = [];
  for (const backend of StackBackendSchema.options) {
    const isDefault = resolved.includes(backend);
    const answer = await promptLine(`  ${backend} [${isDefault ? "Y/n" : "y/N"}]: `);
    const on = answer === "" ? isDefault : /^y/i.test(answer);
    if (on) chosen.push(backend);
  }
  return chosen;
}

export interface InstallSummary {
  baseUrl: string;
  loggedInAs: string;
  org: string;
  stack: StackView | null;
  hqOutpostDeclared: boolean;
}

/** THE credential-surfacing step (docs/BUILD_AND_TEST.md §M29.1 DoD: "deleting the installer's
 *  credential-surfacing step turns a test red"). Reads the SAME Secret
 *  (`<fullname>-bootstrap-admin`, key `password`) the chart pre-generates and the api pod consumes
 *  (`deployment-api.yaml`'s `SCP_BOOTSTRAP_ADMIN_PASSWORD`, `local-auth.ts`'s `ensureBootstrapAdmin`)
 *  — this is the ONLY reader of it besides that one pod. Never a `kubectl logs` call; see the file
 *  header. Retries briefly because the pre-install hook Secret and the api pod's readiness can
 *  land in either order under `helm upgrade --install --wait`. */
export async function readBootstrapAdminPassword(
  shell: Shell,
  opts: { context?: string; namespace: string; releaseName: string },
  timing: { attempts?: number; delayMs?: number } = {}
): Promise<string> {
  const name = bootstrapAdminSecretName(opts.releaseName);
  const attempts = timing.attempts ?? 30;
  const delayMs = timing.delayMs ?? 1000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await shell.readSecretKey({
      context: opts.context,
      namespace: opts.namespace,
      name,
      key: "password"
    });
    if (value) return value;
    await sleep(delayMs);
  }
  throw new Error(
    `could not read the bootstrap admin password from Secret '${name}' in namespace ` +
      `'${opts.namespace}' — see deploy/helm/templates/secrets-generated.yaml`
  );
}

interface PortForward {
  baseUrl: string;
  stop(): Promise<void>;
}

async function startPortForward(opts: {
  context?: string;
  namespace: string;
  releaseName: string;
  localPort: number;
}): Promise<PortForward> {
  const svc = apiServiceName(opts.releaseName);
  const args = kubectlArgs(opts.context, [
    "port-forward",
    `svc/${svc}`,
    `${opts.localPort}:80`,
    "-n",
    opts.namespace
  ]);
  const child: ChildProcess = spawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"] });
  const baseUrl = `http://127.0.0.1:${opts.localPort}/api/v1`;
  // Wait for the tunnel to actually accept connections (mirrors scripts/kind-drill.sh's
  // start_port_forward — a fresh port-forward is not instantly usable).
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${opts.localPort}/healthz`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return {
    baseUrl,
    async stop() {
      child.kill();
    }
  };
}

/** Deliberately narrower than `ScpClient` — just what this function calls, so a test fixture
 *  doesn't have to implement every other `stack.*` verb to satisfy the type. A real `ScpClient`
 *  satisfies this structurally (it has strictly more). */
export interface StackReader {
  stack: { get(): Promise<StackView> };
}

/** Bounded poll: every desired backend reaches SOME status (ready or "needs") before this returns
 *  — the DoD's "ready (or its needs shown)". Never waits for full readiness of every backend,
 *  deliberately: `readyTimeoutSeconds` (chart default 600s) is the CONTROLLER's own per-backend
 *  budget, and this installer's job is to prove the stack is being worked on, which "needs" already
 *  proves as honestly as "ready" does (ADR-0058's own Stack page draws the same distinction). */
export async function waitForStackReport(
  client: StackReader,
  desired: StackBackend[],
  timeoutSeconds: number,
  pollIntervalMs = 3000
): Promise<StackView> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last: StackView | null = null;
  while (Date.now() < deadline) {
    last = await client.stack.get();
    const pending = desired.filter((b) => {
      const view = last!.backends.find((row) => row.backend === b);
      return !view?.status; // no report at all yet — neither ready nor "needs"
    });
    if (pending.length === 0) return last;
    await sleep(pollIntervalMs);
  }
  if (!last) throw new Error("never reached the stack controller at all");
  return last;
}

/** Same narrowing as {@link StackReader} — a real `ScpClient` satisfies this structurally. */
export interface FederationSelfClient {
  federation: {
    self(): Promise<{ domainId: string }>;
    createOutpost(req: { peerDomainId: string }): Promise<unknown>;
  };
}

export async function declareHqOutpost(client: FederationSelfClient): Promise<void> {
  const self = await client.federation.self();
  try {
    await client.federation.createOutpost({ peerDomainId: self.domainId });
  } catch (err) {
    // Idempotent: a 409 means the HQ outpost config object already exists (a re-run of `scp
    // install`, or a prior `helm upgrade` that already fired this step) — not a failure.
    if (!(err instanceof ScpApiError) || err.status !== 409) throw err;
  }
}

export async function runInstall(
  opts: InstallOpts,
  shell: Shell = nodeShell()
): Promise<InstallSummary> {
  const root = repoRoot();
  const desired = await chooseBackends(opts.role, {
    yes: opts.yes,
    withFlags: opts.with,
    withoutFlags: opts.without
  });
  shell.log(
    `role: ${opts.role}  profile: ${opts.profile}  mode: ${opts.mode}` +
      (opts.mode === "kube" ? `  stack: ${desired.length ? desired.join(", ") : "(none)"}` : "")
  );

  if (opts.dryRun) {
    shell.log("--dry-run: not executing. Plan above is what would run.");
    return {
      baseUrl: opts.baseUrl ?? "",
      loggedInAs: "",
      org: "",
      stack: null,
      hqOutpostDeclared: false
    };
  }

  if (opts.mode === "kube" && !opts.bundle) {
    if (!(await clusterReachable(shell, opts.kubeContext))) {
      await bootstrapK3sOrRefuse(shell, { bootstrapK3s: opts.bootstrapK3s, airGapped: false });
    }
    const args = [
      "upgrade",
      "--install",
      opts.releaseName,
      path.join(root, "deploy", "helm"),
      "--namespace",
      opts.namespace,
      "--create-namespace",
      "--wait",
      "--timeout",
      `${opts.helmTimeoutSeconds}s`,
      ...(opts.kubeContext ? ["--kube-context", opts.kubeContext] : []),
      ...helmSetArgs(opts),
      ...opts.set.flatMap((kv) => ["--set", kv])
    ];
    await run(shell, "helm", args);
  } else if (opts.mode === "kube" && opts.bundle) {
    if (!opts.registry || !opts.pubkey) {
      throw new Error("--bundle requires --registry and --pubkey (see install.sh --help)");
    }
    if (!(await clusterReachable(shell, opts.kubeContext))) {
      await bootstrapK3sOrRefuse(shell, { bootstrapK3s: opts.bootstrapK3s, airGapped: true });
    }
    const extraSet = [
      ...helmSetArgs(opts).filter((_, i) => i % 2 === 1), // drop the interleaved "--set" tokens
      ...opts.set
    ].join(" ");
    const args = [
      "--registry",
      opts.registry,
      "--pubkey",
      opts.pubkey,
      "--mode",
      "helm",
      "--namespace",
      opts.namespace,
      "--release-name",
      opts.releaseName,
      "--timeout",
      String(opts.helmTimeoutSeconds),
      "--skip-bundled-backends", // this installer drives backend-enable through the stack API instead
      ...(opts.kubeContext ? ["--kube-context", opts.kubeContext] : []),
      ...(opts.insecureRegistry ? ["--insecure-registry"] : [])
    ];
    await run(shell, path.join(opts.bundle, "install.sh"), args, {
      env: { SCP_EXTRA_HELM_SET: extraSet }
    });
  } else {
    // compose (VM) mode — deploy/compose, per proposal §3a "without Kubernetes": Gitea + SCP run,
    // the Argo family does not (there is nothing to run them on).
    const composeFile = opts.bundle
      ? path.join(opts.bundle, "compose", "docker-compose.retargeted.yml")
      : path.join(root, "deploy", "compose", "docker-compose.yml");
    if (opts.bundle) {
      const args = [
        "--registry",
        opts.registry ?? "",
        "--pubkey",
        opts.pubkey ?? "",
        "--mode",
        "compose",
        ...(opts.insecureRegistry ? ["--insecure-registry"] : [])
      ];
      if (!opts.registry || !opts.pubkey) {
        throw new Error("--bundle requires --registry and --pubkey (see install.sh --help)");
      }
      await run(shell, path.join(opts.bundle, "install.sh"), args);
    }
    const env: NodeJS.ProcessEnv = {
      SCP_FEDERATION_ROLE: opts.role,
      SCP_DEPLOYMENT_MODE: deploymentModeForProfile(opts.profile),
      SCP_BOOTSTRAP_ORG: opts.orgName,
      SCP_BOOTSTRAP_ADMIN_USERNAME: opts.adminUsername,
      // Compose has no Kubernetes Secret store, so there is nothing to read back: this installer
      // GENERATES the password itself and hands it to the container as a plain env var — the
      // installer is its own, only reader, with no read-back step needed at all.
      SCP_BOOTSTRAP_ADMIN_PASSWORD: randomOneTimePassword()
    };
    await run(shell, "docker", [
      "compose",
      "-f",
      composeFile,
      "-p",
      opts.releaseName,
      "up",
      "-d",
      "--build"
    ]);
    shell.log(
      "mode compose: the Standard Stack (Argo CD/Workflows/Rollouts/Events) needs a Kubernetes " +
        "substrate and is NOT installed here (proposal §3a) — re-run with --mode kube (or " +
        "--bootstrap-k3s) for it. Gitea and SCP itself are running."
    );
    return finishLogin(shell, {
      baseUrl: opts.baseUrl ?? `http://127.0.0.1:8080/api/v1`,
      adminUsername: opts.adminUsername,
      password: env.SCP_BOOTSTRAP_ADMIN_PASSWORD as string,
      role: opts.role,
      orgName: opts.orgName,
      desired: [],
      stackTimeoutSeconds: opts.stackTimeoutSeconds,
      afterLogin: null
    });
  }

  const password = await readBootstrapAdminPassword(shell, {
    context: opts.kubeContext,
    namespace: opts.namespace,
    releaseName: opts.releaseName
  });
  shell.log(
    `bootstrap admin one-time password (shown once — not stored in plaintext): ${password}`
  );

  let pf: PortForward | null = null;
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    shell.log("no --base-url given: port-forwarding to the api Service for this install run");
    pf = await startPortForward({
      context: opts.kubeContext,
      namespace: opts.namespace,
      releaseName: opts.releaseName,
      localPort: opts.portForwardPort
    });
    baseUrl = pf.baseUrl;
  }

  try {
    return await finishLogin(shell, {
      baseUrl,
      adminUsername: opts.adminUsername,
      password,
      role: opts.role,
      orgName: opts.orgName,
      desired,
      stackTimeoutSeconds: opts.stackTimeoutSeconds,
      afterLogin: async () => {
        // "shown once, not stored in plaintext" (docs/adr/0060-front-door.md): the Secret's only
        // job was getting the password from the chart to this process; once a real login has
        // proven it round-tripped, there is nothing left for it to do. Blanked HERE — after login,
        // not before — so a failed login leaves the password for a retry instead of stranding the
        // operator. The KEY stays (see redactSecretKey's doc): removing the whole Secret object
        // broke a later pod's startup on a real kind cluster (CreateContainerConfigError) the
        // first time this command tried that.
        await shell.redactSecretKey({
          context: opts.kubeContext,
          namespace: opts.namespace,
          name: bootstrapAdminSecretName(opts.releaseName),
          key: "password"
        });
      }
    });
  } finally {
    if (pf) await pf.stop();
  }
}

function randomOneTimePassword(): string {
  // Same shape as local-auth.ts's own fallback generator (18 random bytes, base64url) — this path
  // is compose-only, where SCP itself never generates one because it was handed one already.
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

async function finishLogin(
  shell: Shell,
  opts: {
    baseUrl: string;
    adminUsername: string;
    password: string;
    role: FederationRole;
    orgName: string;
    desired: StackBackend[];
    stackTimeoutSeconds: number;
    afterLogin: (() => Promise<void>) | null;
  }
): Promise<InstallSummary> {
  const client = new ScpClient({ baseUrl: opts.baseUrl });
  const login = await client.login(opts.adminUsername, opts.password);
  shell.log(`Logged in as '${opts.adminUsername}' (org: ${login.org}). Token stored.`);
  await saveCredentials({
    baseUrl: opts.baseUrl,
    token: login.token,
    org: login.org,
    expiresAt: login.expiresAt
  });
  if (opts.afterLogin) await opts.afterLogin();

  // The chart's SCP_FEDERATION_ROLE (helmSetArgs' federationRole=…) only controls
  // config.federationRole — promotion export / cosign minting / dependency automation's
  // fail-closed gate (component-journey-view.md §8.9). It does NOT set this ORG's federation
  // identity row, which `ensureFederationSelf` always creates as role 'unset' — only
  // `POST /federation/init` (`scp federation init`) does that, and `federation outpost declare`
  // for the HQ outpost below REFUSES with a 400 until it has (measured against a real kind
  // cluster while building this command: "this instance's federation role is 'unset', not
  // 'commander'"). Idempotent (a plain UPDATE; initFederationSelf), so safe on a re-run.
  shell.log(`declaring this instance's federation identity (role: ${opts.role})...`);
  await client.federation.init({ name: opts.orgName, role: opts.role });

  let stack: StackView | null = null;
  if (opts.desired.length > 0) {
    for (const backend of opts.desired) {
      shell.log(`enabling stack backend: ${backend}`);
      await client.stack.putBackend(backend, { enabled: true });
    }
    shell.log(`waiting up to ${opts.stackTimeoutSeconds}s for the stack controller to report...`);
    stack = await waitForStackReport(client, opts.desired, opts.stackTimeoutSeconds);
    shell.log(stackControllerLine(stack));
    printResult(stack.backends, "table", (item) => stackBackendRow(item as StackBackendView));
  }

  let hqOutpostDeclared = false;
  if (opts.role === "commander") {
    shell.log("declaring the HQ outpost (federation outpost declare --peer <self>)...");
    await declareHqOutpost(client);
    hqOutpostDeclared = true;
    shell.log("HQ outpost declared.");
  }

  shell.log(`\nInstall complete. API base URL: ${opts.baseUrl}`);
  shell.log(`  scp whoami        (confirm the session)`);
  shell.log(`  scp stack status  (backend health)`);
  return {
    baseUrl: opts.baseUrl,
    loggedInAs: opts.adminUsername,
    org: login.org,
    stack,
    hqOutpostDeclared
  };
}

// ---------------------------------------------------------------------------------------------
// Commander registration.
// ---------------------------------------------------------------------------------------------

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .description(
      "Install CommanderSCP end to end: the platform, the Standard Stack, a logged-in admin " +
        "session and the HQ outpost — one command, any substrate (docs/quickstart.md)"
    )
    .requiredOption("--role <role>", "commander|outpost|retrans")
    .option("--profile <profile>", "eval|production", "eval")
    .option("--mode <mode>", "kube|compose", "kube")
    .option(
      "--bundle <dir>",
      "an extracted air-gap bundle directory (implies signed, offline install)"
    )
    .option("--registry <ref>", "air-gap: target registry (see install.sh --help)")
    .option("--pubkey <path>", "air-gap: EXTERNAL cosign public key (see install.sh --help)")
    .option("--insecure-registry", "air-gap: allow plain-HTTP/self-signed registries")
    .option("--kube-context <ctx>", "kube context to install into (default: current context)")
    .option("--namespace <ns>", "Kubernetes namespace", "scp")
    .option("--release-name <name>", "Helm release name", "scp")
    .option(
      "--with <backend>",
      "enable a backend beyond the role default (repeatable)",
      collect,
      []
    )
    .option("--without <backend>", "disable a role-default backend (repeatable)", collect, [])
    .option("--yes", "skip the interactive stack checklist (use role defaults + --with/--without)")
    .option("--org-name <name>", "bootstrap org name", "default")
    .option("--admin-username <name>", "bootstrap admin username", "admin")
    .option("--base-url <url>", "reach the API here instead of this installer's own port-forward")
    .option("--port-forward-port <n>", "local port for the installer's port-forward", "18080")
    .option("--timeout <seconds>", "helm --wait timeout", "300")
    .option(
      "--stack-timeout <seconds>",
      "how long to wait for the stack controller to report",
      "300"
    )
    .option(
      "--bootstrap-k3s",
      "install a single-node k3s if no cluster is reachable (connected only)"
    )
    .option(
      "--set <key=value>",
      "an extra raw helm --set (repeatable) — escape hatch for a value this command has no flag for",
      collect,
      []
    )
    .option("--dry-run", "print the plan; execute nothing")
    .action(async (raw: Record<string, unknown>) => {
      const role = raw.role as string;
      if (role !== "commander" && role !== "outpost" && role !== "retrans") {
        throw new Error(`--role must be commander|outpost|retrans (got '${role}')`);
      }
      const profile = raw.profile as string;
      if (profile !== "eval" && profile !== "production") {
        throw new Error(`--profile must be eval|production (got '${profile}')`);
      }
      const mode = raw.mode as string;
      if (mode !== "kube" && mode !== "compose") {
        throw new Error(`--mode must be kube|compose (got '${mode}')`);
      }
      await runInstall({
        role,
        profile,
        mode,
        bundle: raw.bundle as string | undefined,
        registry: raw.registry as string | undefined,
        pubkey: raw.pubkey as string | undefined,
        insecureRegistry: Boolean(raw.insecureRegistry),
        kubeContext: raw.kubeContext as string | undefined,
        namespace: raw.namespace as string,
        releaseName: raw.releaseName as string,
        with: raw.with as string[],
        without: raw.without as string[],
        yes: Boolean(raw.yes),
        orgName: raw.orgName as string,
        adminUsername: raw.adminUsername as string,
        baseUrl: raw.baseUrl as string | undefined,
        portForwardPort: Number(raw.portForwardPort),
        helmTimeoutSeconds: Number(raw.timeout),
        stackTimeoutSeconds: Number(raw.stackTimeout),
        dryRun: Boolean(raw.dryRun),
        bootstrapK3s: Boolean(raw.bootstrapK3s),
        set: raw.set as string[]
      });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
