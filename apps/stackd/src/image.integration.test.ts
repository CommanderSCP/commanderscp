import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * THE SHIPPED scp-stackd IMAGE, asked what it is (M29.4, ADR-0058). The unit suites prove the
 * controller's code; this proves the artifact carries what E3/E4 say it does — the vendored chart,
 * the pinned helm at its vendored path, one bundled file and no package manager — by running it.
 *
 * CI pulls the image `runner-images` (job 4c) built and published under a content-hash tag
 * (`SCP_STACKD_IMAGE_REF`, scripts/runner-image-tags.sh); a developer box without that variable
 * builds it here from the repo root.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
let image: string;

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DOCKER_BUILDKIT: "0" }
  });
  return stdout;
}

beforeAll(async () => {
  const ref = (process.env.SCP_STACKD_IMAGE_REF ?? "").trim();
  if (ref) {
    image = ref;
    return;
  }
  image = "scp-stackd:integration-test";
  await docker(["build", "-f", path.join(REPO, "apps/stackd/Dockerfile"), "-t", image, REPO]);
}, 900_000);

describe("the scp-stackd image", () => {
  it("renders every backend offline with the pinned helm it carries (--self-test)", async () => {
    const out = await docker(["run", "--rm", "--network", "none", image, "--self-test"]);
    const lines = out.trim().split("\n");
    expect(lines[0]).toMatch(/^helm v\d+\.\d+\.\d+ at \/opt\/scp\/bin\/helm; release /);
    for (const backend of ["argocd", "argo-workflows", "argo-rollouts", "argo-events", "gitea"]) {
      expect(
        lines.some((l) => l.startsWith(`${backend}: `) && / objects /.test(l)),
        backend
      ).toBe(true);
    }
  });

  it("ships one bundled file on a bare runtime: no npm, no npx, no corepack, no node_modules", async () => {
    const out = await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "sh",
      image,
      "-c",
      "for b in npm npx corepack pnpm yarn; do command -v $b; done; ls /opt/scp/stackd; " +
        "ls -d /opt/scp/stackd/node_modules /usr/local/lib/node_modules 2>/dev/null; true"
    ]);
    expect(out.trim().split("\n")).toEqual(["stackd.mjs"]);
  });

  it("runs as a non-root numeric user, as the chart's runAsNonRoot requires", async () => {
    const user = (await docker(["image", "inspect", image, "--format", "{{.Config.User}}"])).trim();
    expect(user).toBe("1000:1000");
  });
});
