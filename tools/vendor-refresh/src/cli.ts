#!/usr/bin/env node
/** The real CLI. Needs the internet (to fetch upstream manifests / the gitea chart) and a real
 *  `helm` + the repo's pinned `skopeo` on PATH or at `SCP_SKOPEO_BIN` — see `tools/skopeo/README.md`.
 *  Its own tests never run this file; they call `planVendorRefresh`/`planArgoprojBackend`/`planGitea`
 *  directly with a fixture `VendorRefreshIO`. Usage:
 *
 *    pnpm --filter @scp/vendor-refresh refresh <backend> <tag> [--gitea-chart-ref <ref>]
 *
 *  `<tag>` is the upstream release tag for the four argoproj-family backends (e.g. `v3.5.0`) and the
 *  Helm CHART version for gitea (e.g. `12.7.0`) — gitea's APP version and image tag are read back out
 *  of what the chart itself renders, never asked for separately.
 *
 *  Prints the plan's summary and writes every file the plan describes, leaving the diff for `git
 *  diff` / review — this tool never commits or pushes anything itself.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realVendorRefreshIO } from "./io.js";
import { planVendorRefresh } from "./plan.js";
import { BACKEND_NAMES } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

async function main(argv: readonly string[]): Promise<void> {
  const [backend, tag, ...rest] = argv;
  if (!backend || !tag) {
    process.stderr.write(
      `usage: vendor-refresh <backend> <tag> [--gitea-chart-ref <ref>]\n` +
        `  backend: ${BACKEND_NAMES.join(" | ")}\n`
    );
    process.exitCode = 2;
    return;
  }
  let giteaChartRef: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--gitea-chart-ref") giteaChartRef = rest[i + 1];
  }

  const plan = await planVendorRefresh(
    backend,
    tag,
    realVendorRefreshIO,
    (path) => readFile(resolve(REPO_ROOT, path), "utf8"),
    { giteaChartRef }
  );

  for (const file of plan.files) {
    const abs = resolve(REPO_ROOT, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
  }

  process.stdout.write(`${plan.summary}\n\n${plan.files.length} file(s) written. Review with:\n\n`);
  process.stdout.write(`  git diff -- ${plan.files.map((f) => f.path).join(" ")}\n`);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`vendor-refresh: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
