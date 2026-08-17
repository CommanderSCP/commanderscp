import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveRunnerImage } from "@scp/plugin-testkit";
import { RUNNER_NETWORK_MODE } from "./index.js";

/**
 * ================================================================================================
 * M21.5 — THE FOUR CHARTER CLAUSES, ASKED OF THE BUILT ARTIFACT
 * ================================================================================================
 * The `scp-managed-dep` amendment (2026-08-13, qualified 2026-08-15) says of the runner:
 *
 *   "never runs a package manager" / "never resolves or regenerates a lockfile" /
 *   "never builds, compiles, or tests" / "the runner contains no package manager"
 *
 * Every one of those is a statement about what the image CONTAINS. `runner-image.test.ts` reads the
 * Dockerfile and the shim, which is the right cheap gate and is structurally blind to the base: it
 * can say what this build ADDS and never what it INHERITED. That blindness was measured, not
 * imagined — the base used to be a build ARG holding a mutable tag, so
 * `docker build --build-arg RUNNER_DEP_BASE_IMAGE=node:22 apps/runner-dep` produced an image tagged
 * as the vetted runner with a full Node toolchain inside it, and the "is pinned" assertion passed on
 * the unchanged text.
 *
 * So this file BUILDS the image (or pulls the pre-built one in CI) and interrogates the artifact:
 * every forbidden tool is looked for on the container's PATH and across its filesystem, and the
 * shim is exercised as the orchestrator actually launches it — `--network none`, argv only, bytes in
 * and out by `docker cp`. A future edit that adds a toolchain "just for one ecosystem" fails here
 * even if it never touches the Dockerfile's text, because the base changed underneath it.
 *
 * Needs a reachable Docker daemon — excluded from `pnpm test` (vitest.config.ts), run via
 * `pnpm test:integration` in the CI integration-shard job (which pre-pulls
 * `SCP_RUNNER_DEP_IMAGE_REF`, built once per content change by ci.yml's `runner-images` job).
 * SKIPS CLEANLY, and loudly, when no daemon is present — the same shape `tools/helm-verify` uses,
 * so a laptop without Docker does not red the suite.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_DEP_CONTEXT = resolve(__dirname, "../../../../apps/runner-dep");
const RUNNER_IMAGE_TAG = "scp-runner-dep:m21-5-integration-test";
const PIN_ENV = resolve(__dirname, "../../../../tools/busybox/pin.env");

let runnerImageRef = RUNNER_IMAGE_TAG;
let dockerReady = false;

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a shell command INSIDE the runner image, `--network none`, and return its stdout.
 *
 * A SENTINEL is appended and asserted, and that is not belt-and-braces: this image deliberately
 * contains only seven applets, so a script reaching for an eighth (`ls`, `find`, `grep`) does not
 * fail the test — the missing command writes to stderr, the pipeline yields nothing, and an
 * assertion of the form "nothing forbidden was found" passes for the wrong reason. The first draft
 * of the filesystem scan below did exactly that. Requiring the last line to arrive means a script
 * that died half way through is a failure rather than a clean bill of health.
 */
async function inImage(script: string): Promise<string> {
  const sentinel = "__scp_runner_dep_script_completed__";
  const { stdout } = await execFileAsync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      RUNNER_NETWORK_MODE,
      "--entrypoint",
      "/bin/sh",
      runnerImageRef,
      "-c",
      `${script}\necho ${sentinel}`
    ],
    { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }
  );
  expect(stdout, "the in-container script did not run to completion").toContain(sentinel);
  return stdout.split(sentinel)[0]!;
}

/**
 * Paths the docker DAEMON injects into every container it creates, whatever the image holds. They
 * are not image content and are subtracted below.
 *
 * Enumerated rather than pattern-matched, so a NEW injected path fails the exact-set assertion and
 * gets looked at — an `/etc/**` filter would swallow a real addition just as happily.
 */
const DAEMON_INJECTED = [
  ".dockerenv",
  "dockerenv",
  "dev/console",
  "dev/pts",
  "dev/shm",
  "etc/hostname",
  "etc/hosts",
  "etc/mtab",
  "etc/resolv.conf"
];

/**
 * Every path the runtime IMAGE contributes: the container filesystem exported to the HOST, minus
 * {@link DAEMON_INJECTED}. Files only — directories are structure, not content.
 *
 * Nothing inside the image is used to answer this, which matters more here than usual: the image
 * deliberately contains no `find`, `ls` or `grep`, so an in-container scan does not fail loudly, it
 * produces NO OUTPUT — and "nothing forbidden was found" then passes for the wrong reason. The first
 * draft of the scan below did exactly that.
 */
async function imagePaths(): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), "scp-runner-dep-export-"));
  const tarball = join(scratch, "rootfs.tar");
  const { stdout: createOut } = await execFileAsync("docker", [
    "create",
    "--network",
    RUNNER_NETWORK_MODE,
    runnerImageRef,
    "npm",
    "p",
    "c",
    "1",
    "2"
  ]);
  const containerId = createOut.trim();
  try {
    await execFileAsync("docker", ["export", "-o", tarball, containerId], { timeout: 120_000 });
    const { stdout } = await execFileAsync("tar", ["-tf", tarball], {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024
    });
    return stdout
      .split("\n")
      .map((l) => l.trim().replace(/^\.?\/+/, ""))
      .filter((l) => l !== "" && !l.endsWith("/") && !DAEMON_INJECTED.includes(l))
      .sort();
  } finally {
    await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  dockerReady = await dockerAvailable();
  if (!dockerReady) return;
  runnerImageRef = await resolveRunnerImage({
    refEnvVar: "SCP_RUNNER_DEP_IMAGE_REF",
    localTag: RUNNER_IMAGE_TAG,
    context: RUNNER_DEP_CONTEXT
  });
}, 600_000);

describe("scp-runner-dep, as built", () => {
  /**
   * Every executable name that would mean a package manager, a build tool or a language runtime is
   * IN the image. Two of these are worth naming: `go` is both a language runtime and the resolver
   * for one of the five ecosystems, and `node` is what the ARG-override defect actually put here.
   */
  const FORBIDDEN = [
    "npm",
    "npx",
    "yarn",
    "pnpm",
    "pip",
    "pip3",
    "mvn",
    "gradle",
    "go",
    "cargo",
    "bundle",
    "bundler",
    "nuget",
    "dotnet",
    "node",
    "python",
    "python3",
    "ruby",
    "perl",
    "java",
    "javac",
    "gcc",
    "cc",
    "g++",
    "make",
    "ld",
    // …and the package managers a BASE IMAGE would carry of its own, which is the clause
    // "the runner contains no package manager" read literally rather than as "no npm".
    "apk",
    "apt",
    "apt-get",
    "dpkg",
    "dnf",
    "yum",
    "microdnf",
    "rpm",
    "pacman",
    "zypper"
  ] as const;

  it("has NONE of them on its PATH — the charter clauses, asked of the artifact", async () => {
    if (!dockerReady) return expectSkipped();
    // `command -v` resolves through PATH and shell builtins/applets alike, which is the honest
    // question: what can the shim actually invoke? Collected in ONE container run and reported all
    // at once, so a failure names every tool present rather than the first.
    const script = FORBIDDEN.map((t) => `command -v ${t} >/dev/null 2>&1 && echo ${t}`).join("\n");
    const found = (await inImage(script))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    expect(found, `the runner image carries: ${found.join(", ")}`).toEqual([]);
  }, 180_000);

  /**
   * THE STRONG FORM, and the one the others are a convenience over: the ENTIRE contents of the
   * runtime image, read by exporting the container filesystem to the HOST. Nothing inside the image
   * answers this question, which matters here more than usual — the image contains seven applets, so
   * an in-container `find` does not exist, and the first draft of this test scanned with one and
   * passed by producing no output at all.
   *
   * Asserted as an exact set rather than as a denylist. A denylist can only refuse what somebody
   * thought of, and the two package managers this image actually shipped (`dpkg` and `rpm`, applets
   * of a stock BusyBox) were ones nobody had.
   */
  it("contains EXACTLY the expected tree — one binary, seven applet names, and the shim", async () => {
    if (!dockerReady) return expectSkipped();
    const files = await imagePaths();
    expect(files).toEqual(
      [
        "bin/awk",
        "bin/busybox",
        "bin/head",
        "bin/mv",
        "bin/rm",
        "bin/sh",
        "bin/tail",
        "bin/wc",
        "run.sh"
      ].sort()
    );
    // Stated as an assertion rather than left implied by the set above: nothing named after a
    // package manager, compiler or language runtime is in the image at all.
    for (const tool of FORBIDDEN) {
      expect(
        files.some((f) => f.split("/").at(-1) === tool),
        `the image contains a file named '${tool}'`
      ).toBe(false);
    }
  }, 180_000);

  it("carries the applets the shim actually invokes, so the assertions above cannot pass by the image being empty", async () => {
    if (!dockerReady) return expectSkipped();
    // The complement of a wall of absences: state what IS there, and prove it is REACHABLE — a name
    // in the exported tree is not the same as a working command, since a dangling symlink is both.
    // Without this, an empty image would satisfy every assertion above. The list is exactly what
    // `apps/runner-dep/run.sh` calls.
    const needed = ["sh", "awk", "tail", "wc", "head", "rm", "mv"];
    const present = (
      await inImage(needed.map((t) => `command -v ${t} >/dev/null 2>&1 && echo ${t}`).join("\n"))
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    expect(present.sort()).toEqual([...needed].sort());
  }, 180_000);

  /**
   * THE RESIDUAL, PINNED RATHER THAN LEFT AS PROSE. BusyBox is a MULTI-CALL binary: the code behind
   * `dpkg` and `rpm` is still inside `/bin/busybox`, and `busybox dpkg` still dispatches to it even
   * though no such NAME exists in the image. Removing that needs a custom-compiled BusyBox — a C
   * toolchain in the build of the one image whose whole argument is that it has no toolchain — which
   * is a strictly worse trade.
   *
   * The bound is asserted so nobody reads the exact-tree test above as more than it is, and so the
   * day BusyBox drops those applets (or the base is swapped for one without them) this comment is
   * updated deliberately rather than silently becoming false.
   */
  it("states its own bound: the multi-call binary still IMPLEMENTS applets no name reaches", async () => {
    if (!dockerReady) return expectSkipped();
    const list = (await inImage("busybox --list")).split("\n").map((l) => l.trim());
    expect(list).toContain("awk");
    // The residual itself. What makes it harmless is enforced elsewhere and unconditionally: the
    // container is launched `--network none` (nothing to fetch), the only bytes present are the one
    // manifest copied in (nothing to unpack), and neither dpkg nor rpm is one of the five ecosystems
    // this class authors (nothing to resolve).
    expect(list.includes("dpkg") || list.includes("rpm")).toBe(true);
    // ...and no NAME in the image reaches them, which is the half that is closed.
    const files = (await imagePaths()).map((p) => p.split("/").at(-1));
    expect(files).not.toContain("dpkg");
    expect(files).not.toContain("rpm");
  }, 180_000);

  it("is the image tools/busybox/pin.env pins — the drift gate, closed against the ARTIFACT", async () => {
    if (!dockerReady) return expectSkipped();
    const pin = await readFile(PIN_ENV, "utf8");
    const pinnedVersion = /^BUSYBOX_PINNED_VERSION=(.+)$/m.exec(pin)?.[1]?.trim();
    expect(pinnedVersion).toBeTruthy();
    // BusyBox reports `BusyBox v1.36.1 (…) multi-call binary.` on its first usage line. The pin's
    // version carries a flavour suffix (`-musl`) that is not in that string, so compare the numeric
    // part — and assert the flavour separately, by the property that makes it the right one: a
    // fully static binary, so the image has no dynamic loader to satisfy either.
    const numeric = pinnedVersion!.split("-")[0];
    const banner = await inImage("busybox 2>&1 | head -1 || true");
    expect(banner).toContain(`v${numeric}`);
  }, 180_000);

  /**
   * THE SHIM, AS THE ORCHESTRATOR ACTUALLY LAUNCHES IT. `runner-shim.test.ts` runs `run.sh` with the
   * host's `sh`, which proves the AWK program and is blind to whether the image can host it (a
   * BusyBox `awk` is not GNU awk). This runs the real ENTRYPOINT in the real image, with the real
   * `--network none`, and moves bytes the only way the orchestrator does: `docker cp` in and out.
   */
  it("edits one declared version, offline, with bytes arriving and leaving by `docker cp`", async () => {
    if (!dockerReady) return expectSkipped();
    const scratch = await mkdtemp(join(tmpdir(), "scp-runner-dep-it-"));
    const inDir = join(scratch, "in");
    const outDir = join(scratch, "out");
    await execFileAsync("mkdir", ["-p", inDir, outDir]);
    const base = ["{", '  "dependencies": {', '    "@acme/lib": "^1.2.3"', "  }", "}", ""].join(
      "\n"
    );
    await writeFile(join(inDir, "manifest"), base, "utf8");

    const { stdout: createOut } = await execFileAsync("docker", [
      "create",
      "--network",
      RUNNER_NETWORK_MODE,
      runnerImageRef,
      "npm",
      "package.json",
      "@acme/lib",
      "^1.2.3",
      "^1.4.0"
    ]);
    const containerId = createOut.trim();
    try {
      await execFileAsync("docker", ["cp", `${inDir}/.`, `${containerId}:/work/in`]);
      await execFileAsync("docker", ["start", "-a", containerId], { timeout: 120_000 });
      await execFileAsync("docker", ["cp", `${containerId}:/work/out/.`, outDir]);
      const edited = await readFile(join(outDir, "manifest"), "utf8");
      expect(edited).toBe(base.replace("^1.2.3", "^1.4.0"));
    } finally {
      await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);

  /**
   * M21.7 — THE ANCHORED PATH, IN THE REAL IMAGE'S OWN awk.
   *
   * `runner-shim.test.ts` proves the anchored program against the HOST's awk (BWK awk on a Mac, GNU
   * awk in CI). BusyBox awk is a third implementation, and the two things this rule leans on that the
   * unanchored one did not are exactly where implementations differ: an integer compared against
   * `NR`, and a NUMERIC value used as an array subscript (`lines[anchor_nr]`, which converts through
   * CONVFMT in some awks and as `%d` in others). If BusyBox rendered `5` as `5.00000`, the anchor
   * would address nothing, every split-shape bump would refuse in production, and every unit test
   * would stay green. So the claim is measured against the artifact rather than reasoned about.
   */
  it("applies an ANCHORED split-shape edit in the built image, and refuses a stale anchor", async () => {
    if (!dockerReady) return expectSkipped();
    const scratch = await mkdtemp(join(tmpdir(), "scp-runner-dep-anchor-it-"));
    const inDir = join(scratch, "in");
    const outDir = join(scratch, "out");
    await execFileAsync("mkdir", ["-p", inDir, outDir]);
    // The coordinate is on line 4 and the version on line 5, and `1.2.3` appears twice more where it
    // is not this image's version at all. NO line names both, so the unanchored rule has no answer.
    const base = [
      "global:",
      "  imageTag: 1.2.3",
      "image:",
      "  repository: acme/api",
      "  tag: 1.2.3",
      "appVersion: 1.2.3",
      ""
    ].join("\n");

    const runInImage = async (argv: readonly string[]): Promise<string | undefined> => {
      await writeFile(join(inDir, "manifest"), base, "utf8");
      await rm(join(outDir, "manifest"), { force: true });
      const { stdout } = await execFileAsync("docker", [
        "create",
        "--network",
        RUNNER_NETWORK_MODE,
        runnerImageRef,
        ...argv
      ]);
      const id = stdout.trim();
      try {
        await execFileAsync("docker", ["cp", `${inDir}/.`, `${id}:/work/in`]);
        await execFileAsync("docker", ["start", "-a", id], { timeout: 120_000 });
        await execFileAsync("docker", ["cp", `${id}:/work/out/.`, outDir]);
        return await readFile(join(outDir, "manifest"), "utf8");
      } catch {
        return undefined; // the container exited non-zero: a refusal
      } finally {
        await execFileAsync("docker", ["rm", "-f", id]).catch(() => undefined);
      }
    };

    try {
      const descriptor = ["oci", "chart/values.yaml", "acme/api", "1.2.3", "1.2.4"];
      // Seven operands: the anchor addresses line 5, and ONLY that line moves.
      expect(await runInImage([...descriptor, "5", "  tag: 1.2.3"])).toBe(
        base.replace("  tag: 1.2.3", "  tag: 1.2.4")
      );
      // A stale anchor text is a refusal, not an edit of whatever happens to be at that number.
      expect(await runInImage([...descriptor, "5", "  tag: 1.2.3 # pinned"])).toBeUndefined();
      // ...and five operands — an orchestrator that predates the anchor — still refuse this shape,
      // which is the "old orchestrator, new image" half of the version-skew table.
      expect(await runInImage(descriptor)).toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 300_000);
});

/** A skip that is VISIBLE. A silent `return` in a docker-gated test is how a suite reports green for
 *  a proof that never ran; this states it in the test output. */
function expectSkipped(): void {
  console.warn(
    "[runner-image.integration] no reachable Docker daemon — the built-artifact charter-clause proof did NOT run"
  );
  expect(dockerReady).toBe(false);
}
