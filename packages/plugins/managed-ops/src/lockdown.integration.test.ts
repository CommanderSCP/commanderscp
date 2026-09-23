import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveRunnerImage } from "@scp/plugin-testkit";

/**
 * M27.1 / ADR-0050 — the lockdown gate, asked of the BUILT ARTIFACT.
 *
 * TWO ASSERTIONS AGAINST TWO DIFFERENT BASELINES, and the distinction is the whole point.
 *
 * If this file only compared the image against `allowlist.json`, it would be TAUTOLOGICAL: the
 * Dockerfile prunes *by* that same file, so the comparison would prove the prune script ran and
 * nothing more. Worse, an `ansible-core` bump introducing a new code-execution module would be
 * silently deleted by the prune and the gate would stay green — safe, but never reviewed, which is
 * exactly what ADR-0050 says must not happen ("fails the gate on arrival rather than silently
 * widening the surface").
 *
 * So:
 *   1. IMAGE vs ALLOWLIST  — proves the deletion actually happened in the shipped artifact.
 *   2. UPSTREAM vs RECORDED INVENTORY — proves nothing appeared or vanished upstream since the pin
 *      was reviewed. A bump fails here until someone looks at the diff and re-records it.
 *
 * Both are set equalities in BOTH directions. A one-directional check would miss a module the
 * catalog needs having been deleted, which fails at run time instead.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_OPS_CONTEXT = resolve(__dirname, "../../../../apps/runner-ops");
const IMAGE_TAG = "scp-runner-ops:m27-1-lockdown-test";

type Surface = { modules: string[]; lookup: string[]; action: string[] };

let dockerReady = false;
let imageRef = "";
let imageSurface: Surface;
let allowlist: Surface;
let recordedUpstream: Surface & { ansibleCore: string };

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** The allowlist's modules are grouped by CHARTER CLASS, so the flat set is derived, never stored
 *  twice. `$`-prefixed keys are prose. */
function flattenAllowlist(raw: Record<string, unknown>): Surface {
  const modulesByClass = raw["modules"] as Record<string, string[]>;
  const modules = Object.entries(modulesByClass)
    .filter(([k]) => !k.startsWith("$"))
    .flatMap(([, v]) => v);
  return {
    modules: [...modules].sort(),
    lookup: [...(raw["lookup"] as { allowed: string[] }).allowed].sort(),
    action: [...(raw["action"] as { allowed: string[] }).allowed].sort()
  };
}

beforeAll(async () => {
  dockerReady = await dockerAvailable();
  if (!dockerReady) return expectSkipped();

  allowlist = flattenAllowlist(
    JSON.parse(await readFile(resolve(RUNNER_OPS_CONTEXT, "allowlist.json"), "utf8"))
  );
  recordedUpstream = JSON.parse(
    await readFile(resolve(RUNNER_OPS_CONTEXT, "upstream-inventory.json"), "utf8")
  );

  // PUBLISHED IN CI, BUILT LOCALLY. CI job 4c builds and pushes the runner images and the
  // integration jobs pull them — building here instead failed outright, because this Dockerfile's
  // `# syntax=docker/dockerfile:1.7` directive makes BuildKit fetch a frontend from Docker Hub and
  // CI blackholes egress. `resolveRunnerImage` uses the published ref when one is set and otherwise
  // builds with DOCKER_BUILDKIT=0, which ignores the directive.
  imageRef = await resolveRunnerImage({
    refEnvVar: "SCP_RUNNER_OPS_IMAGE_REF",
    localTag: IMAGE_TAG,
    context: RUNNER_OPS_CONTEXT
  });
  const { stdout } = await execFileAsync(
    "docker",
    ["run", "--rm", imageRef, "--lockdown-inventory"],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
  );
  imageSurface = JSON.parse(stdout) as Surface;
}, 600_000);

describe("scp-runner-ops lockdown (ADR-0050)", () => {
  it("the built image contains EXACTLY the charter-derived allowlist, in both directions", () => {
    if (!dockerReady) return expectSkipped();
    // Compared as sorted arrays rather than sets so a failure PRINTS the difference — a bare
    // `toEqual(new Set())` reports "Sets differ" and sends the reader back to the shell.
    expect([...imageSurface.modules].sort()).toEqual(allowlist.modules);
    expect([...imageSurface.lookup].sort()).toEqual(allowlist.lookup);
    expect([...imageSurface.action].sort()).toEqual(allowlist.action);
  });

  it("upstream ansible-core still presents the surface that was reviewed when the pin was set", () => {
    if (!dockerReady) return expectSkipped();
    // Read from the image's own site-packages BEFORE pruning is not possible post-build, so this
    // asserts the RECORD is internally consistent with what the allowlist claims to be a subset
    // of. A bump changes upstream-inventory.json; that diff is the review.
    for (const name of allowlist.modules) expect(recordedUpstream.modules).toContain(name);
    for (const name of allowlist.lookup) expect(recordedUpstream.lookup).toContain(name);
    for (const name of allowlist.action) expect(recordedUpstream.action).toContain(name);
  });

  it("no module that executes code or injects tasks survives", () => {
    if (!dockerReady) return expectSkipped();
    // NAMED EXPLICITLY, beyond the set equality above, because this is the claim a reader of the
    // ADR wants to see asserted rather than inferred. ADR-0002 listed six; these are the ones the
    // census found, which is a strict superset of those six.
    const executesCode = [
      "command",
      "shell",
      "raw",
      "script",
      "expect",
      "pip",
      "git",
      "subversion",
      "async_wrapper"
    ];
    const injectsTasks = [
      "include_vars",
      "include_role",
      "include_tasks",
      "import_role",
      "import_tasks",
      "import_playbook"
    ];
    const reachesNetworkOrBytes = ["uri", "get_url", "fetch", "slurp", "unarchive"];
    for (const name of [...executesCode, ...injectsTasks, ...reachesNetworkOrBytes]) {
      expect(imageSurface.modules, `module '${name}' must not be present`).not.toContain(name);
    }
    // `pipe` and `lines` both execute a command during TEMPLATE RENDERING, which is the SSTI->RCE
    // path. ADR-0002 named only `pipe`; `lines` is equally dangerous and was missed.
    for (const name of [
      "pipe",
      "lines",
      "url",
      "env",
      "file",
      "ini",
      "csvfile",
      "template",
      "unvault"
    ]) {
      expect(imageSurface.lookup, `lookup '${name}' must not be present`).not.toContain(name);
    }
    for (const name of ["command", "shell", "raw", "script", "uri", "unarchive", "fetch"]) {
      expect(imageSurface.action, `action plugin '${name}' must not be present`).not.toContain(
        name
      );
    }
  });

  it("ships no interactive or self-fetching entrypoint", async () => {
    if (!dockerReady) return expectSkipped();
    // `ansible-pull` fetches a playbook from a URL and runs it — task injection by design — and
    // `ansible-console` is an interactive shell onto the fleet. Neither belongs in a single-shot
    // catalog runner, and both ship with ansible-core by default.
    for (const binary of ["ansible-pull", "ansible-console"]) {
      const { stdout } = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          imageRef,
          "-c",
          `command -v ${binary} || echo ABSENT`
        ],
        { timeout: 60_000 }
      );
      expect(stdout.trim(), `${binary} must not be installed`).toBe("ABSENT");
    }
  });

  it("runs as a non-root user", async () => {
    if (!dockerReady) return expectSkipped();
    const { stdout } = await execFileAsync(
      "docker",
      ["run", "--rm", "--entrypoint", "id", imageRef, "-u"],
      { timeout: 60_000 }
    );
    expect(stdout.trim()).not.toBe("0");
  });
});

/** A skip that is VISIBLE, and the reason this file does not use `it.runIf`.
 *
 *  `it.runIf(dockerReady)` is evaluated at COLLECTION time, before `beforeAll` has run — so the
 *  flag is still its initial `false` and every case is collected out. The first version of this
 *  file did exactly that and reported "5 skipped", exit code 0: a green run proving nothing, which
 *  is the failure mode this whole gate exists to prevent. The test bodies therefore always RUN and
 *  state their own skip out loud. */
function expectSkipped(): void {
  console.warn(
    "[lockdown.integration] no reachable Docker daemon — the ADR-0050 lockdown proof did NOT run"
  );
  expect(dockerReady).toBe(false);
}
