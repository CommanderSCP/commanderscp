import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "@scp/source-census";

/** Scanner containment: they exist only in the runner image. See docs/plugins.md §501. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");

const RUNNER_SCAN_PREFIX = "apps/runner-scan/";

/** Directories whose files are checked for scanner INVOCATION. See docs/plugins.md §502. */
const PRODUCT_DIRS = ["apps/", "packages/", "deploy/", "scripts/", "tools/"];

const EXECUTABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".bash", ".py"];

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return out.split("\0").filter((p) => p.length > 0);
}

/** A file this gate NAMES. Missing means the repo lost something it must have — throw. */
function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

/** A file this gate SWEEPS, read tolerantly. See docs/plugins.md §503. */
function sweep(paths: string[]): { path: string; text: string }[] {
  const read: { path: string; text: string }[] = [];
  for (const path of paths) {
    try {
      read.push({ path, text: readFileSync(resolve(REPO_ROOT, path), "utf8") });
    } catch {
      // Tracked but not in the worktree right now. Skipped, and therefore not counted below.
    }
  }
  return read;
}

// DETECTOR 1 — a Dockerfile that PROVISIONS a scanner (installs it, or copies one in).

/** Scanner provisioning tokens: the binaries themselves and the packages that carry them. */
const SCANNER_PROVISION = /\b(trivy|oscap|openscap|openscap-scanner|scap-security-guide)\b/i;

/** The lines of a Dockerfile that name a scanner at all. An image either has one or it does not — a
 *  mention in a comment is still a signal worth failing on, because the only reason to mention a
 *  scanner in a Dockerfile is to put one in the image. */
export function dockerfileScannerHits(text: string): string[] {
  return text.split("\n").filter((line) => SCANNER_PROVISION.test(line));
}

// DETECTOR 2 — code that EXECUTES a scanner. Command position only. See docs/plugins.md §504.

const SCANNER_BINARIES = "trivy|oscap";

/** The SUBCOMMANDS/flags each scanner is actually driven with. Requiring one is what separates an
 *  invocation from a mention: `trivy image …` is a call, `trivy takes none` (prose in a comment) and
 *  `"trivy-vm"` (a method NAME) are not. Prose false positives are not a cosmetic problem — they are
 *  how a gate like this gets weakened until it passes vacuously. */
const TRIVY_SUBCOMMANDS =
  "image|vm|fs|filesystem|rootfs|repo|repository|config|sbom|kubernetes|k8s|aws|vex|plugin|module|convert|clean|server|registry|version|--\\S+";
const OSCAP_SUBCOMMANDS = "xccdf|oval|ds|cpe|cvss|info|--\\S+|-V";

/** A scanner in shell COMMAND POSITION: at line start (any indent), after `;`/`&&`/`||`/`|`, inside
 *  `$( … )`, after `sudo`, or after inline `VAR=value` env prefixes (how run.sh invokes `oscap` with
 *  `OSCAP_PROBE_ROOT=…`). */
const SHELL_INVOCATION = new RegExp(
  String.raw`(?:^|[;&|]|\$\()\s*(?:(?:sudo|env)\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*` +
    String.raw`(?:trivy\s+(?:${TRIVY_SUBCOMMANDS})|oscap\s+(?:${OSCAP_SUBCOMMANDS}))\b`,
  "m"
);

/** A scanner as the COMMAND argument of a Node process-spawning call. */
const NODE_SPAWN_INVOCATION = new RegExp(
  // `spawnRunnerProcess` is in this list because M23.6 clause 1 made it the package's ONLY spawner:
  // a scanner reached through it would otherwise be a scanner invocation this gate stopped seeing.
  String.raw`\b(?:execFile|execFileSync|execFileAsync|spawnRunnerProcess|spawn|spawnSync|exec|execSync)\s*\(\s*["'\`](?:${SCANNER_BINARIES})["'\`]`
);

export function invocationHits(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => SHELL_INVOCATION.test(line) || NODE_SPAWN_INVOCATION.test(line));
}

describe("scanner containment: the scanners exist ONLY in the scp-runner-scan image", () => {
  const files = trackedFiles();

  it("finds a non-trivial tracked file set (the gate is reading the repo, not an empty list)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("apps/runner-scan/Dockerfile");
    expect(files).toContain("apps/runner-scan/run.sh");
  });

  it("NO Dockerfile outside apps/runner-scan provisions a scanner", () => {
    const dockerfiles = files.filter(
      (p) => basename(p).startsWith("Dockerfile") && !p.startsWith(RUNNER_SCAN_PREFIX)
    );
    // The root `Dockerfile` (the scpd runtime image) MUST be in this set — if it were not, the
    // assertion below would pass without ever having looked at the image that matters most.
    expect(dockerfiles, "the scpd runtime image must be covered by this check").toContain(
      "Dockerfile"
    );

    // READ tolerantly, then assert over what was READ — same property as the invocation sweep
    // below, and the same reason. The root image must be among the files actually read, not merely
    // among the paths listed: `toContain` on `dockerfiles` alone would still pass if every one of
    // them had vanished from the worktree.
    const swept = sweep(dockerfiles);
    expect(
      swept.map((f) => f.path),
      "the scpd runtime image must have been READ, not merely listed"
    ).toContain("Dockerfile");

    const offenders = swept
      .map((f) => ({ path: f.path, hits: dockerfileScannerHits(f.text) }))
      .filter((f) => f.hits.length > 0);
    expect(
      offenders.map((o) => `${o.path}: ${o.hits[0]!.trim()}`),
      "a scanner must exist ONLY in apps/runner-scan/Dockerfile (ADR-0020 §1)"
    ).toEqual([]);
  });

  it("apps/runner-scan/Dockerfile DOES provision both scanners (the containment is not vacuous)", () => {
    // The mirror image of the assertion above: containment only means something if the scanners are
    // genuinely somewhere. If this ever went empty, "no Dockerfile has a scanner" would be trivially
    // true and the gate would be guarding nothing.
    const hits = dockerfileScannerHits(read("apps/runner-scan/Dockerfile"));
    expect(hits.some((l) => /trivy/i.test(l))).toBe(true);
    expect(hits.some((l) => /oscap|openscap/i.test(l))).toBe(true);
  });

  it("NO product code outside apps/runner-scan EXECUTES a scanner binary", () => {
    const candidates = files.filter(
      (p) =>
        PRODUCT_DIRS.some((d) => p.startsWith(d)) &&
        !p.startsWith(RUNNER_SCAN_PREFIX) &&
        EXECUTABLE_EXTENSIONS.some((e) => p.endsWith(e)) &&
        // This file defines the detector patterns; matching itself proves nothing.
        !p.endsWith("scanner-containment.test.ts")
    );
    // THE FLOOR IS OVER THE FILES ACTUALLY READ, not over the candidate list. Those two numbers are
    // the same on a clean worktree and differ exactly when the index and the worktree do — which is
    // the case that used to kill this test with a bare ENOENT. Asserting the read count keeps the
    // tolerance from becoming a vacuous pass: skipping is allowed, skipping EVERYTHING is not.
    const swept = sweep(candidates);
    expect(
      swept.length,
      `the invocation sweep must actually have files to read (${candidates.length} tracked candidates, ${swept.length} readable)`
    ).toBeGreaterThan(50);

    const offenders = swept
      .map((f) => ({ path: f.path, hits: invocationHits(f.text) }))
      .filter((f) => f.hits.length > 0);
    expect(
      offenders.map((o) => `${o.path}: ${o.hits[0]!.trim()}`),
      "only apps/runner-scan/run.sh may execute a scanner; the orchestrator launches `docker`, never a scanner"
    ).toEqual([]);
    // 30 s, NOT the 5 s default, and NOT because the assertion is slow to decide — because this one
    // `it` READS ~1189 TRACKED FILES off disk (the sweep is repo-wide on purpose; see turbo.json).
    // Standalone it finishes in ~230 ms. Under a full-repo `turbo run test`, with every other
    // package's vitest workers competing for the same disk, it intermittently crossed 5000 ms and
    // failed — a flake with nothing wrong with it, which is the kind that gets "fixed" by narrowing
    // the sweep until the gate passes vacuously. The budget is widened; the sweep is not narrowed,
    // and NOTHING THIS TEST ASSERTS IS WEAKENED — same candidate set, same >50 floor, same
    // `toEqual([])`. If it ever takes 30 s the machine is the problem, not this file.
  }, 30_000);

  it("apps/runner-scan/run.sh DOES execute both scanners, including the machine-image arm", () => {
    const hits = invocationHits(read("apps/runner-scan/run.sh"));
    const joined = hits.join("\n");
    expect(joined).toMatch(/\btrivy image\b/);
    expect(joined).toMatch(/\btrivy vm\b/);
    expect(joined).toMatch(/\boscap xccdf eval\b/);
  });

  it("the orchestrator plugin launches `docker`, never a scanner", () => {
    // RAW for the ABSENCE half. See docs/plugins.md §505.
    expect(invocationHits(read("packages/plugins/managed-scan/src/index.ts"))).toEqual([]);
    expect(invocationHits(read("packages/runner-launcher/src/index.ts"))).toEqual([]);

    // …and it really does launch containers. See docs/plugins.md §506.
    const pluginSource = readStripped(
      resolve(REPO_ROOT, "packages/plugins/managed-scan/src/index.ts")
    );
    expect(pluginSource).toMatch(/resolveLauncher\(\{[^}]*\}\)\.run\(\{/);
    // `spawnRunnerProcess`, NOT `execFileAsync`, SINCE M23.6 CLAUSE 1. See docs/plugins.md §507.
    expect(readStripped(resolve(REPO_ROOT, "packages/runner-launcher/src/index.ts"))).toMatch(
      /spawnRunnerProcess\(\s*\n?\s*dockerBinary,/
    );
  });
});

/**
 * NEGATIVE CONTROLS. Everything above is an assertion that a detector found NOTHING — the classic
 * shape of a test that stays green after being quietly broken. These prove the detectors bite.
 */
describe("scanner-containment detectors actually detect (negative controls)", () => {
  it("dockerfileScannerHits flags real provisioning lines", () => {
    expect(
      dockerfileScannerHits("RUN dnf install -y openscap-scanner scap-security-guide")
    ).toHaveLength(1);
    expect(
      dockerfileScannerHits("COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy")
    ).toHaveLength(1);
    expect(dockerfileScannerHits("RUN apt-get install -y trivy")).toHaveLength(1);
    expect(dockerfileScannerHits("RUN apt-get install -y ca-certificates curl")).toHaveLength(0);
  });

  it("invocationHits flags shell command-position scanner calls", () => {
    expect(invocationHits("trivy image --input /work/image")).toHaveLength(1);
    expect(invocationHits("  oscap xccdf eval --profile x ds.xml")).toHaveLength(1);
    expect(invocationHits("mkdir -p /out && trivy vm /disk.raw")).toHaveLength(1);
    expect(invocationHits('VERSION="$(trivy version)"')).toHaveLength(1);
    expect(invocationHits("sudo trivy fs /")).toHaveLength(1);
  });

  it("invocationHits flags Node spawns of a scanner", () => {
    expect(invocationHits('await execFileAsync("trivy", ["image", dir]);')).toHaveLength(1);
    expect(invocationHits("spawnSync('oscap', args)")).toHaveLength(1);
  });

  it("invocationHits does NOT flag mentions, method names, or pins (the gate stays maintainable)", () => {
    expect(invocationHits('const SUPPORTED = new Set(["trivy", "trivy-vm"]);')).toHaveLength(0);
    expect(invocationHits("// the trivy DB is baked at build time")).toHaveLength(0);
    expect(invocationHits("TRIVY_PINNED_VERSION=0.74.0")).toHaveLength(0);
    expect(invocationHits('if (method === "trivy-vm") { … }')).toHaveLength(0);
    expect(invocationHits('await execFileAsync(docker, ["create", image, "trivy"])')).toHaveLength(
      0
    );
  });
});
