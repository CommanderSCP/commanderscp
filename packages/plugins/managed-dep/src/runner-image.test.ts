import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { atLineStart, stripHashComments } from "@scp/source-census";

/** The charter clauses that are properties of the image. See docs/plugins.md §356. */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const runnerDir = join(repoRoot, "apps", "runner-dep");
const dockerfile = readFileSync(join(runnerDir, "Dockerfile"), "utf8");
const runSh = readFileSync(join(runnerDir, "run.sh"), "utf8");
const pinEnv = readFileSync(join(repoRoot, "tools", "busybox", "pin.env"), "utf8");

describe("scp-runner-dep contains no toolchain — the charter clauses, as properties of the image", () => {
  /** Every token that would mean a package manager, a build tool or a language runtime is IN the
   *  image. Matched as whole words so a mention inside a prose comment about NOT having them does
   *  not trip it — the strings below are searched only in INSTRUCTION lines. */
  const FORBIDDEN = [
    "npm",
    "yarn",
    "pnpm",
    "pip",
    "pip3",
    "mvn",
    "maven",
    "gradle",
    "go",
    "cargo",
    "bundler",
    "nuget",
    "gcc",
    "make",
    "node"
  ];

  /** The Dockerfile with comments stripped — what the build actually executes. Via
   *  `@scp/source-census` rather than a local filter: this file had the right idea and three
   *  hand-rolled copies of it, and two OTHER assertions below still read `runSh` raw. */
  const instructions = stripHashComments(dockerfile);

  it("installs nothing at all — there is no RUN that reaches a package repository", () => {
    // The stronger statement, and the one that makes the list below almost redundant: this image has
    // no install step, so there is no repository, module proxy or registry index in its build. That
    // is also why it is the most air-gap-friendly of the three runners (charter principle 5).
    expect(instructions).not.toMatch(
      /\b(apk|apt-get|apt|dnf|yum|microdnf|pip|npm|go)\s+(add|install|get|download)\b/
    );
  });

  it.each(FORBIDDEN)("does not put '%s' in the image", (tool) => {
    const pattern = new RegExp(`(^|[\\s/"'=])${tool}([\\s/"'=]|$)`, "m");
    expect(pattern.test(instructions), `'${tool}' appears in a Dockerfile instruction`).toBe(false);
  });

  it("the run shim invokes no toolchain either — awk is the whole of it", () => {
    // Commands are scanned, so three things are stripped first. See docs/plugins.md §357.
    const commands = stripHashComments(runSh)
      .split("\n")
      .map((line) => line.replace(/"[^"]*"/g, '""'))
      .map((line) => line.replace(/^\s*[A-Za-z0-9|*]+\)/, ""))
      .join("\n");
    for (const tool of FORBIDDEN) {
      const pattern = new RegExp(`(^|[\\s;|&(])${tool}([\\s;|&)]|$)`, "m");
      expect(pattern.test(commands), `the shim invokes '${tool}'`).toBe(false);
    }
    // …and the one thing it DOES invoke, so this assertion cannot pass by the shim being empty.
    expect(commands).toMatch(/^awk '$/m);
  });

  /** Every `FROM` line's image reference, in order. Two stages: the pinned assemble base, then
   *  `scratch`, which is what makes the runtime image an assembled tree rather than an inherited one. */
  const fromRefs = [...instructions.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);

  it("builds FROM the digest tools/busybox/pin.env names, byte for byte", () => {
    // THE DRIFT GATE, mirroring `@scp/plugin-managed-scan`'s `pin.test.ts` against
    // tools/trivy/pin.env: one pin, one file, and a copy that cannot silently diverge from it.
    const pinned = /^BUSYBOX_PINNED_IMAGE=(.+)$/m.exec(pinEnv)?.[1]?.trim();
    expect(pinned, "tools/busybox/pin.env must declare BUSYBOX_PINNED_IMAGE").toBeTruthy();
    expect(pinned).toMatch(/^busybox@sha256:[0-9a-f]{64}$/);
    expect(fromRefs[0], "the assemble stage must FROM the pinned image").toBe(pinned);
    // …and the pin.env's own recorded provenance is a digest too, so a hand edit that swaps either
    // for a tag fails here rather than at a build six weeks later.
    expect(/^BUSYBOX_PINNED_AMD64_DIGEST=sha256:[0-9a-f]{64}$/m.test(pinEnv)).toBe(true);
    expect(/^BUSYBOX_UPSTREAM_REPO=busybox$/m.test(pinEnv)).toBe(true);
  });

  it("takes the base from NOTHING a builder can override — no ARG, and every FROM is fixed", () => {
    // The defect this replaces: the base was `ARG RUNNER_DEP_BASE_IMAGE=busybox:1.36.1-musl` and the
    // pin assertion read that ARG's DEFAULT. `--build-arg RUNNER_DEP_BASE_IMAGE=node:22` therefore
    // produced an image tagged as the vetted runner carrying a full Node toolchain, with this file
    // unchanged and green. A clause that cannot be traded away is not expressible as a parameter.
    expect(instructions).not.toMatch(/^\s*ARG\b/m);
    expect(instructions).not.toMatch(/FROM\s+\$\{/);
    for (const ref of fromRefs) {
      // Every stage is either `scratch` or a digest. Never a tag — mutable by definition, including
      // a version tag Docker Hub republishes maintenance rebuilds under, not just `:latest`.
      expect(ref === "scratch" || /@sha256:[0-9a-f]{64}$/.test(ref), `FROM ${ref}`).toBe(true);
    }
  });

  it("INHERITS nothing into the runtime image — the last stage is `scratch`", () => {
    // A stock BusyBox ships `dpkg` and `rpm` applets (plus wget/nc/telnet and some four hundred
    // more), so `FROM busybox` + a shim made "the runner contains no package manager" FALSE — which
    // the built-artifact test caught on its first run and this file, by construction, never could.
    // The runtime filesystem is therefore assembled: one binary, seven applet names, two directories.
    expect(fromRefs.at(-1)).toBe("scratch");
    // The assemble stage's own guard is a COUNT of /bin, not a denylist of names: a denylist can
    // only refuse what somebody thought of, and the two applets that were actually there were ones
    // nobody had.
    expect(instructions).toMatch(/entries=\$\(ls -1 \/rootfs\/bin \| wc -l\)/);
    expect(instructions).toMatch(/-eq 8/);
  });

  it("mounts nothing and exposes no docker socket — bytes arrive by `docker cp`", () => {
    // A host-path escape is structurally impossible when nothing is mounted. The orchestrator's own
    // launch is asserted separately (`runner-containment.test.ts`); this is the image's half.
    expect(instructions).not.toMatch(/VOLUME/);
    expect(instructions).not.toMatch(/docker\.sock/);
    expect(instructions).toMatch(/ENTRYPOINT \["\/run\.sh"\]/);
  });

  it("the shim never opens the manifestPath it is told — the subject is always /work/in/manifest", () => {
    // `manifestPath` names a path in somebody's REPOSITORY. See docs/plugins.md §358.
    expect(runSh).toMatch(atLineStart("IN=in/manifest"));
    expect(runSh).toMatch(atLineStart("OUT=out/manifest"));
    // …resolved against the image's own WORKDIR, which is what makes those /work/in and /work/out.
    expect(dockerfile).toMatch(/^WORKDIR \/work$/m);
    const shimBody = stripHashComments(runSh);
    // The variable is read for messages only; it must never be the operand of a redirect or a read.
    expect(shimBody).not.toMatch(/[<>]\s*"\$MANIFEST_PATH"/);
    expect(shimBody).not.toMatch(/\bcat\s+"\$MANIFEST_PATH"/);
  });
});
