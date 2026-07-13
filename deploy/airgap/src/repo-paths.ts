/** Resolves paths relative to the monorepo root, from this package's own location (`deploy/airgap/src`), so build-bundle.ts/verify-bundle.ts work the same whether invoked via `pnpm --filter @scp/airgap bundle` (cwd = deploy/airgap) or `node dist/build-bundle.js` from anywhere. */
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** deploy/airgap/src -> deploy/airgap -> deploy -> <repo root>. Works from both src/ (tsx) and dist/ (compiled) since both are exactly one level under deploy/airgap. */
export const PACKAGE_ROOT = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
export const ASSETS_DIR = path.resolve(PACKAGE_ROOT, "assets");

export const HELM_CHART_DIR = path.resolve(REPO_ROOT, "deploy/helm");
export const BUNDLED_HELM_CHART_DIR = path.resolve(REPO_ROOT, "deploy/helm-bundled");
export const BUNDLED_WRAPPER = path.resolve(REPO_ROOT, "scripts/scp-bundled.sh");
export const COMPOSE_FILE = path.resolve(REPO_ROOT, "deploy/compose/docker-compose.yml");
export const BUILD_AND_TEST_DOC = path.resolve(REPO_ROOT, "docs/BUILD_AND_TEST.md");
export const DESIGN_DOC = path.resolve(REPO_ROOT, "docs/DESIGN.md");
