import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLE_IMAGE_SPECS } from "./bundle-images.js";
import { REPO_ROOT } from "./repo-paths.js";

/**
 * EVERY IMAGE `build-bundle` COPIES FROM THE LOCAL DAEMON IS ONE THE DRILLS PREPARE. A
 * `docker-daemon`-sourced image defaults to a `:dev` tag nothing pulls; if no drill builds (or
 * stands in for) it and passes its `--<stem>-ref`, the bundle build fails looking for it — which is
 * how scp-runner-ops and scp-builder-rpm went missing from both drills (review of #421). The drills'
 * own flags (scpd, postgres) are passed by each drill; every other one comes from
 * scripts/drill-runner-images.sh's BUNDLE_RUNNER_ARGS.
 */

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const shared = read("scripts/drill-runner-images.sh");
const drills = ["scripts/airgap-drill.sh", "scripts/ansible-drill.sh"].map((f) => ({
  f,
  text: read(f)
}));

const argsBlock = (() => {
  const m = /BUNDLE_RUNNER_ARGS=\(([\s\S]*?)\n\s*\)/.exec(shared);
  return m?.[1] ?? "";
})();

describe("the drills prepare every daemon-sourced bundle image", () => {
  it("finds the shared argument list (known-positive control)", () => {
    expect(argsBlock).toContain("--runner-iac-ref");
  });

  const daemon = BUNDLE_IMAGE_SPECS.filter((s) => s.defaultSource === "docker-daemon");

  it("there are daemon-sourced images to check", () => {
    expect(daemon.map((s) => s.name)).toEqual(expect.arrayContaining(["scpd", "scp-runner-ops"]));
  });

  for (const spec of daemon) {
    it(`${spec.name}: --${spec.optionStem}-ref reaches every drill's build-bundle call`, () => {
      const flag = `--${spec.optionStem}-ref`;
      const viaShared = argsBlock.includes(`${flag} `);
      for (const d of drills) {
        const invocation = d.text.slice(d.text.indexOf("node deploy/airgap/dist/build-bundle.js"));
        expect(
          viaShared || invocation.slice(0, invocation.indexOf("TARBALL=")).includes(`${flag} `),
          `${d.f} never passes ${flag}`
        ).toBe(true);
        expect(invocation, `${d.f} does not splat BUNDLE_RUNNER_ARGS`).toContain(
          '"${BUNDLE_RUNNER_ARGS[@]}"'
        );
      }
    });
  }
});
