/** The REAL `VendorRefreshIO` — network fetch, the pinned skopeo, and the real `helm` binary. This
 *  is the ONLY file in this package that touches the network or spawns `helm`; every test injects its
 *  own {@link VendorRefreshIO} instead (a fixture HTTP server, a fake digest resolver, `helm template`
 *  pointed at a local fixture chart) so the test suite itself never needs the internet. */
import { execFileSync } from "node:child_process";
import { createSkopeoDigestResolver } from "./digest.js";
import { GITEA_CHART_REPO_NAME, GITEA_CHART_REPO_URL } from "./gitea-backend.js";
import type { VendorRefreshIO } from "./types.js";

async function fetchTextOverHttp(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`vendor-refresh: GET ${url} -> HTTP ${res.status}`);
  }
  return res.text();
}

let giteaRepoAdded = false;

/** Idempotent: `helm repo add --force-update` is safe to run every time, but only paid once per
 *  process. Real usage only — never called by a test, which injects its own `runHelmTemplate`. */
function ensureGiteaRepo(): void {
  if (giteaRepoAdded) return;
  execFileSync(
    "helm",
    ["repo", "add", GITEA_CHART_REPO_NAME, GITEA_CHART_REPO_URL, "--force-update"],
    {
      stdio: "inherit"
    }
  );
  execFileSync("helm", ["repo", "update", GITEA_CHART_REPO_NAME], { stdio: "inherit" });
  giteaRepoAdded = true;
}

async function runHelmTemplateForReal(args: readonly string[]): Promise<string> {
  // Only gitea's plan calls this today, and its chart ref always starts with the repo name — a local
  // fixture chart path (what every test passes instead) never does, so this stays a no-op for tests
  // even if one were to call the real IO by mistake.
  if (args.some((a) => a === `${GITEA_CHART_REPO_NAME}/gitea`)) ensureGiteaRepo();
  return execFileSync("helm", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The real IO. Every field reaches outside the process — the network, the pinned skopeo, `helm`. */
export const realVendorRefreshIO: VendorRefreshIO = {
  fetchText: fetchTextOverHttp,
  resolveImageDigest: createSkopeoDigestResolver(),
  runHelmTemplate: runHelmTemplateForReal
};
