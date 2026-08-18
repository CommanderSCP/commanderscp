import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "@scp/source-census";

/**
 * SCANNER CONTAINMENT — the 13.3a DoD's "grep-level proof the scanners exist only in the runner
 * image" (proposal §13.3, ADR-0020 §1, DESIGN.md §3).
 *
 * THE INVARIANT. `trivy` and `oscap` live in EXACTLY ONE place: `apps/runner-scan`, the separate
 * image the `scp-managed-scan` orchestrator launches as an ephemeral, single-shot, `--network none`
 * container — exactly as `tofu` lives only in `scp-runner-iac`. The `scpd` runtime image carries no
 * scanner at all, and no SCP process ever executes one directly.
 *
 * WHY IT IS A TEST AND NOT A CONVENTION. The containment is what makes the Managed Execution
 * Exception's blast radius argument true: a scanner is a large, fast-moving, untrusted-input-parsing
 * binary, and the reason it may run at all is that it runs isolated, offline, and disposably. A
 * `RUN dnf install openscap-scanner` added to the root Dockerfile "to make a diagnostic easier", or
 * an `execFile("trivy", …)` added to a server route, would quietly move the scanner INTO the
 * long-lived, network-reachable, credential-holding process — the exact thing the design forbids —
 * and nothing else in the build would notice.
 *
 * WHY `git ls-files` AND NOT A DIRECTORY WALK. A walk would sweep in `node_modules`, build output,
 * and untracked scratch files. Some of those (a vendored Go module, a downloaded binary) contain
 * scanner tokens, so a walk-based gate would either be permanently red or — far worse — be "fixed"
 * with exclusions until it passed vacuously. Tracked files are exactly the set this repo is
 * accountable for.
 *
 * NON-VACUITY. Both detectors are exercised against synthetic POSITIVE samples below. If either is
 * ever weakened into a regex that matches nothing, the negative-control tests fail — so a green run
 * of this file always means "the detectors work AND found nothing", never "the detectors are dead".
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");

/** The one place a scanner may exist. */
const RUNNER_SCAN_PREFIX = "apps/runner-scan/";

/**
 * Directories whose files are checked for scanner INVOCATION. Deliberately the product surface —
 * the code that ships in an image or runs on a commander. `.github/` is out of scope on purpose:
 * CI is a build-time concern, not the runtime image, and a CI job legitimately may run a scanner
 * over this repo's own artifacts. That is a different question from "does the SCP runtime carry a
 * scanner", which is what this file is about.
 */
const PRODUCT_DIRS = ["apps/", "packages/", "deploy/", "scripts/", "tools/"];

/** File types that can actually EXECUTE something. */
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

/**
 * A file this gate SWEEPS, read tolerantly. `git ls-files` lists the INDEX, and the index and the
 * WORKTREE disagree routinely — a file `rm`'d but not yet `git rm`'d, a half-applied patch, an
 * interrupted rebase. Feeding that straight into {@link read} made this file die with a bare
 * `ENOENT ... launch-argv.golden.test.ts` at the "NO product code outside apps/runner-scan EXECUTES
 * a scanner binary" test — a repo-wide SECURITY gate going red with a message about a test file and
 * nothing about scanners. The cheap fix under time pressure is the one this file's header warns
 * against: narrowing the sweep until it passes. So the candidate set is UNCHANGED and unreadable
 * candidates are skipped instead — and every caller then asserts its non-vacuity floor over the
 * files ACTUALLY READ, so a worktree full of missing files cannot masquerade as a clean sweep
 * either.
 */
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

// -------------------------------------------------------------------------------------------------
// DETECTOR 1 — a Dockerfile that PROVISIONS a scanner (installs it, or copies one in).
// -------------------------------------------------------------------------------------------------

/** Scanner provisioning tokens: the binaries themselves and the packages that carry them. */
const SCANNER_PROVISION = /\b(trivy|oscap|openscap|openscap-scanner|scap-security-guide)\b/i;

/** The lines of a Dockerfile that name a scanner at all. An image either has one or it does not — a
 *  mention in a comment is still a signal worth failing on, because the only reason to mention a
 *  scanner in a Dockerfile is to put one in the image. */
export function dockerfileScannerHits(text: string): string[] {
  return text.split("\n").filter((line) => SCANNER_PROVISION.test(line));
}

// -------------------------------------------------------------------------------------------------
// DETECTOR 2 — code that EXECUTES a scanner. Command position only: `trivy` appearing as a method
// name, a string literal, a pin variable or a comment is not an invocation, and flagging those would
// make the gate unmaintainable (and therefore, eventually, disabled).
// -------------------------------------------------------------------------------------------------

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
  String.raw`\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync|exec|execSync)\s*\(\s*["'\`](?:${SCANNER_BINARIES})["'\`]`
);

export function invocationHits(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => SHELL_INVOCATION.test(line) || NODE_SPAWN_INVOCATION.test(line));
}

// -------------------------------------------------------------------------------------------------

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
    expect(joined).toMatch(/\btrivy vm\b/); // 13.3a — the machine-image arm
    expect(joined).toMatch(/\boscap xccdf eval\b/);
  });

  it("the orchestrator plugin launches `docker`, never a scanner", () => {
    // RAW for the ABSENCE half: `invocationHits` finding nothing is the assertion, and stripping
    // could only shrink what it searches. THE SWEEP NOW COVERS THE PORT TOO — M23.1 moved the
    // create/copy/start/remove sequence into `@scp/runner-launcher`, and a containment gate that
    // still looked only at the plugin would have stopped covering the file that actually spawns
    // processes.
    expect(invocationHits(read("packages/plugins/managed-scan/src/index.ts"))).toEqual([]);
    expect(invocationHits(read("packages/runner-launcher/src/index.ts"))).toEqual([]);

    // …and it really does launch containers (so the assertions above are about a live code path).
    // STRIPPED for the PRESENCE half: this is the non-vacuity guard, and a guard satisfiable by a
    // comment describing the launch would let the launch itself be deleted with the containment
    // assertion above passing trivially.
    //
    // IT TAKES BOTH HALVES NOW, and that is the point of asserting them separately: the plugin must
    // still hand a runner spec to the port (`.run({`, reached through the injected resolver), and
    // the port must still exec the container CLI. Either one going missing would leave "no scanner
    // is executed here" true for the uninteresting reason that nothing is executed at all.
    const pluginSource = readStripped(
      resolve(REPO_ROOT, "packages/plugins/managed-scan/src/index.ts")
    );
    expect(pluginSource).toMatch(/resolveLauncher\(\{[^}]*\}\)\.run\(\{/);
    expect(readStripped(resolve(REPO_ROOT, "packages/runner-launcher/src/index.ts"))).toMatch(
      /execFileAsync\(\s*\n?\s*dockerBinary,/
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
    // …and does not flag an unrelated image.
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
    expect(invocationHits("TRIVY_PINNED_VERSION=0.58.1")).toHaveLength(0);
    expect(invocationHits('if (method === "trivy-vm") { … }')).toHaveLength(0);
    expect(invocationHits('await execFileAsync(docker, ["create", image, "trivy"])')).toHaveLength(
      0
    );
  });
});
